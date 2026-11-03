"""Single-seal native storage primitive. No authority ack, grants or source issuer.

Only the service UID writes this fixed root. Recovery requires an outside anchor.
Faults are controlled by a root-owned test file, never by an IPC argument.
"""
import base64
import errno
import fcntl
import hashlib
import json
import os
import stat
import resource
import signal

MAXIMUM = 512
FILES = {'lock', 'intent.json', 'data.bin', 'seal.json', 'selected.json'}


def need(ok, reason):
    if not ok: raise ValueError('storage-' + reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(raw): return hashlib.sha256(raw).hexdigest()


class Store:
    def __init__(self, root, private, context, anchor, fault=lambda: 'none'):
        self.root = root; self.private = private; self.context = dict(context); self.fault = fault
        self.blocked = False; self.recovered = False; self.syncs = {'file': 0, 'directory': 0}
        self.root_identity = self.identity(root.lstat())
        need(stat.S_ISDIR(root.lstat().st_mode) and root.lstat().st_uid == os.geteuid() and stat.S_IMODE(root.lstat().st_mode) == 0o700, 'root-custody')
        self.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        self.lock = None
        try:
            need(self.identity(os.fstat(self.fd)) == self.root_identity, 'root-exchanged')
            self.lock = os.open('lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.fd)
            self._custody(os.fstat(self.lock)); fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.anchor = json.loads(canonical(anchor)); need(set(self.anchor) == {'sealDigest'} and (self.anchor['sealDigest'] is None or self.hex(self.anchor['sealDigest'])), 'anchor-schema')
            names = self.names()
            if names == {'lock'}:
                need(self.anchor['sealDigest'] is None, 'rollback'); self.head = None
            else:
                need(names == FILES, 'incomplete-inventory'); self.head = self.verify()
                need(self.anchor['sealDigest'] == self.head['sealDigest'], 'recovery-anchor'); self.recovered = True
        except BaseException:
            self.close(); raise

    @staticmethod
    def hex(value): return isinstance(value, str) and len(value) == 64 and all(x in '0123456789abcdef' for x in value)

    @staticmethod
    def identity(info): return {'device': str(info.st_dev), 'inode': str(info.st_ino)}

    def close(self):
        if self.lock is not None: os.close(self.lock); self.lock = None
        if getattr(self, 'fd', None) is not None: os.close(self.fd); self.fd = None

    def _custody(self, info):
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, 'file-custody')

    def gate(self):
        need(not self.blocked and self.fd is not None, 'unavailable')
        info = self.root.lstat()
        need(stat.S_ISDIR(info.st_mode) and self.identity(info) == self.root_identity and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700, 'root-exchanged')

    def names(self):
        # Stop enumeration at the first entry beyond this primitive's fixed closure.
        result = set()
        with os.scandir(self.fd) as entries:
            for entry in entries:
                need(len(result) < len(FILES), 'inventory-budget'); result.add(entry.name)
        need(result <= FILES, 'unknown-entry'); return result

    def read(self, name, maximum=4096):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.fd)
        try:
            info = os.fstat(fd); self._custody(info); need(info.st_size <= maximum, 'size')
            raw = os.read(fd, maximum + 1); need(len(raw) == info.st_size, 'size'); return raw
        finally: os.close(fd)

    def inject(self, phase):
        if self.fault() == phase: raise OSError(errno.EIO, 'injected-' + phase)

    def sync(self, fd, directory=False):
        self.inject('directory-sync' if directory else 'file-sync')
        os.fsync(fd); self.syncs['directory' if directory else 'file'] += 1

    def put(self, name, raw):
        self.gate(); need(name in FILES - {'lock'}, 'name')
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.fd)
        limits = None
        try:
            self._custody(os.fstat(fd)); self.inject('write')
            if self.fault() == 'file-limit':
                limits = resource.getrlimit(resource.RLIMIT_FSIZE); signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
                resource.setrlimit(resource.RLIMIT_FSIZE, (0, limits[1]))
            need(os.write(fd, raw) == len(raw), 'short-write'); self.sync(fd)
        finally:
            if limits is not None: resource.setrlimit(resource.RLIMIT_FSIZE, limits)
            os.close(fd)
        self.sync(self.fd, True); need(self.read(name) == raw, 'readback')

    def signed(self, body):
        unsigned = {'schema': 'osv-mcp.q2b.storage-seal.v1', 'body': body}
        return canonical({**unsigned, 'signature': base64.b64encode(self.private.sign(canonical(unsigned))).decode()})

    def opened(self, raw):
        value = json.loads(raw); need(set(value) == {'schema', 'body', 'signature'} and value['schema'] == 'osv-mcp.q2b.storage-seal.v1' and canonical(value) == raw, 'seal-schema')
        self.private.public_key().verify(base64.b64decode(value['signature'], validate=True), canonical({k: value[k] for k in ('schema', 'body')}))
        return value['body']

    def verify(self):
        self.gate(); need(self.names() == FILES, 'incomplete-inventory')
        intent = json.loads(self.read('intent.json')); need(set(intent) == {'payloadDigest', 'size', 'root', 'generation'} and intent['root'] == self.root_identity and intent['generation'] == 1, 'intent')
        data = self.read('data.bin', MAXIMUM); raw = self.read('seal.json'); body = self.opened(raw)
        need(set(body) == {'intentDigest', 'dataDigest', 'size', 'root', 'generation', 'originBoot', 'runId', 'manifestDigest'}, 'seal-body')
        need(body['root'] == self.root_identity and body['generation'] == 1 and body['runId'] == self.context['runId'] and body['manifestDigest'] == self.context['manifestDigest'], 'binding')
        need(body['intentDigest'] == sha(self.read('intent.json')) and body['dataDigest'] == intent['payloadDigest'] == sha(data) and body['size'] == intent['size'] == len(data), 'content')
        selected = self.opened(self.read('selected.json')); need(selected == {'sealDigest': sha(raw), 'root': self.root_identity, 'generation': 1}, 'selection')
        # Every boot/inspection resynchronizes all original evidence and the root.
        for name in sorted(FILES - {'lock'}):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.fd)
            try: self._custody(os.fstat(fd)); self.sync(fd)
            finally: os.close(fd)
        self.sync(self.fd, True); self.gate()
        return {'sealDigest': sha(raw), 'dataDigest': sha(data), 'size': len(data), 'generation': 1}

    def operate(self, role, operation, argument):
        self.gate()
        need((role, operation) in {('reader', 'read-state'), ('upload', 'stage'), ('publish', 'seal')}, 'role')
        need(isinstance(argument, dict), 'argument')
        if operation == 'stage':
            need(set(argument) == {'payload'} and isinstance(argument['payload'], str) and len(argument['payload']) <= 684, 'argument')
            data = base64.b64decode(argument['payload'], validate=True); need(0 < len(data) <= MAXIMUM and base64.b64encode(data).decode() == argument['payload'], 'payload')
        else: need(argument == {}, 'argument')
        try:
            if operation == 'stage':
                need(self.names() == {'lock'} and self.head is None, 'already-staged')
                self.put('intent.json', canonical({'payloadDigest': sha(data), 'size': len(data), 'root': self.root_identity, 'generation': 1}))
                self.put('data.bin', data); self.inject('after-data')
                return {'phase': 'staged', 'dataDigest': sha(data), 'size': len(data)}
            if operation == 'seal':
                need(self.names() == {'lock', 'intent.json', 'data.bin'} and self.head is None, 'not-staged')
                intent_raw = self.read('intent.json'); intent = json.loads(intent_raw); data = self.read('data.bin', MAXIMUM)
                need(intent['payloadDigest'] == sha(data) and intent['size'] == len(data) and intent['root'] == self.root_identity, 'content')
                body = {'intentDigest': sha(intent_raw), 'dataDigest': sha(data), 'size': len(data), 'root': self.root_identity, 'generation': 1,
                        'originBoot': self.context['providerBoot'], 'runId': self.context['runId'], 'manifestDigest': self.context['manifestDigest']}
                raw = self.signed(body); self.put('seal.json', raw); self.inject('after-seal')
                self.put('selected.json', self.signed({'sealDigest': sha(raw), 'root': self.root_identity, 'generation': 1})); self.inject('after-selection')
                self.head = self.verify(); self.inject('before-response')
                return {'phase': 'sealed', **self.head}
            if self.head is None:
                need(self.names() == {'lock'}, 'not-sealed'); return {'phase': 'empty', 'recovered': self.recovered}
            current = self.verify(); need(current == self.head, 'head-changed')
            return {'phase': 'sealed', **current, 'recovered': self.recovered, 'payload': base64.b64encode(self.read('data.bin', MAXIMUM)).decode()}
        except BaseException:
            self.blocked = True; raise
