"""Outside-root controller: real principals, durable IPC, kill/recovery and faults."""
import base64
import ctypes
import errno
import hashlib
import json
import os
import runpy
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

IMAGE = Path('/opt/osv-q2b/b1ct'); RUN = Path('/run/osv-q2b/b1ct'); ROOT = Path('/var/lib/osv-q2b/provider/b1ct/storage')
sys.path.insert(0, str(IMAGE)); import auth
BASE = runpy.run_path('/tmp/storage-base-probe.py')
UNITS = BASE['UNITS']; LIBC = BASE['LIBC']; status = BASE['status']; wait = BASE['wait']; drop = BASE['drop']
PAYLOAD = b'owned-storage-native-payload-v1\n'
FAULTS = ('write', 'file-limit', 'file-sync', 'directory-sync', 'after-data', 'after-seal', 'after-selection', 'before-response')


def command(args): return subprocess.run(args, capture_output=True, text=True, timeout=30, check=True)
def sha(raw): return hashlib.sha256(raw).hexdigest()
def events(): return BASE['events']()


def child(work, index):
    incoming, outgoing = os.pipe2(os.O_CLOEXEC); pid = os.fork()
    if pid == 0:
        try:
            os.close(incoming); os.dup2(outgoing, 1); os.closerange(3, 256); drop(index); os.kill(os.getpid(), signal.SIGSTOP)
            result = work(); raw = auth.canonical(result); auth.need(len(raw) <= 16384, 'child-output-budget'); os.write(1, raw); os._exit(0)
        except BaseException as error:
            print(str(error), file=sys.stderr, flush=True); os._exit(79)
    os.close(outgoing)
    try:
        stopped = wait(pid); auth.need(os.WIFSTOPPED(stopped), 'child-stop'); identity = status(pid)
        auth.need(identity['uid'] == [1101 + index] * 3 and identity['gid'] == [1201 + index] * 3 and not identity['groups'] and
                  all(int(x, 16) == 0 for x in identity['capabilities'].values()) and identity['noNewPrivileges'], 'child-identity')
        os.kill(pid, signal.SIGCONT); chunks = []; total = 0
        while True:
            raw = os.read(incoming, 4096)
            if not raw: break
            total += len(raw); auth.need(total <= 16384, 'child-output-budget'); chunks.append(raw)
        state = wait(pid); auth.need(os.WIFEXITED(state) and os.WEXITSTATUS(state) == 0, 'child-failed')
        return {'identity': identity, 'actorPid': pid, **json.loads(b''.join(chunks))}
    finally:
        os.close(incoming)
        try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError): pass


def client(role, operation, argument=None):
    index = ('reader', 'upload', 'publish').index(role) + 1
    return child(lambda: runpy.run_path(str(IMAGE / 'storage_client.py'))['run'](role, operation, argument or {}), index)


def attempt(work):
    try:
        work(); raise ValueError('isolation-write-succeeded')
    except OSError as error:
        auth.need(error.errno in (errno.EACCES, errno.EPERM), 'unrelated-isolation-error-' + str(error.errno)); return error.errno


def isolation(index, pid):
    def work():
        def open_write():
            fd = os.open(ROOT / 'data.bin', os.O_WRONLY); os.close(fd)
        def open_read():
            fd = os.open(ROOT / 'data.bin', os.O_RDONLY); os.close(fd)
        def create():
            fd = os.open(ROOT / 'unknown', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.close(fd)
        def procfd():
            fd = os.open('/proc/' + str(pid) + '/fd/3', os.O_RDONLY); os.close(fd)
        def debug():
            result = LIBC.ptrace(16, pid, None, None)
            if result != 0: raise OSError(ctypes.get_errno(), 'ptrace')
        def getfd():
            pfd = os.pidfd_open(pid)
            try:
                result = LIBC.syscall(438, pfd, 3, 0)
                if result < 0: raise OSError(ctypes.get_errno(), 'pidfd_getfd')
                os.close(result)
            finally: os.close(pfd)
        def namespace():
            if LIBC.unshare(0x20000) != 0: raise OSError(ctypes.get_errno(), 'unshare')
        targets = [('read', open_read), ('write', open_write), ('create', create), ('unlink', lambda: os.unlink(ROOT / 'data.bin')),
                   ('rename', lambda: os.rename(ROOT / 'data.bin', ROOT / 'replaced')),
                   ('hardlink', lambda: os.link(ROOT / 'data.bin', '/tmp/storage-hardlink-' + str(os.getpid()))),
                   ('symlink', lambda: os.symlink('/tmp', ROOT / 'alias')), ('root-rename', lambda: os.rename(ROOT, ROOT.with_name('replaced'))),
                   ('proc-fd', procfd), ('ptrace', debug), ('pidfd-getfd', getfd), ('signal', lambda: os.kill(pid, signal.SIGSTOP)), ('mount-namespace', namespace)]
        denied = [{'operation': name, 'errno': attempt(action)} for name, action in targets]
        own = Path('/var/lib/osv-q2b-clients/b1ct') / ('reader', 'upload', 'publish')[index - 1] if index <= 3 else Path('/var/lib/osv-q2b') / ('checkpoint' if index == 4 else 'registry') / 'b1ct'
        path = own / 'allow-control'; fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try: auth.need(os.write(fd, b'allow-control') == 13, 'allow-write')
        finally: os.close(fd)
        auth.need(path.read_bytes() == b'allow-control', 'allow-read'); path.unlink()
        return {'denied': denied, 'allowControl': True}
    return child(work, index)


def durable_context(case, anchor):
    oldpid = BASE['main_pid'](); old_listener_ids = {(x['device'], x['inode']) for x in LAST_BOOT['phases'][0]['fds'] if 3 <= x['fd'] <= 5}
    command(['systemctl', 'stop', *UNITS])
    if oldpid > 1: auth.need(not Path('/proc/' + str(oldpid)).exists(), 'old-provider-still-live')
    # The fixed service is stopped before reclamation. No listener is passed to an actor.
    if old_listener_ids: auth.need(not BASE['references'](old_listener_ids), 'listener-references-remain')
    for role in ('reader', 'upload', 'publish'):
        path = RUN / (role + '.sock')
        if path.exists(): auth.need(stat.S_ISSOCK(path.lstat().st_mode) and path.lstat().st_uid == 0, 'socket-leaf'); path.unlink()
    (RUN / 'launch.json').unlink(missing_ok=True)
    (RUN / 'recovery-anchor.json').write_bytes(auth.canonical({'sealDigest': anchor})); (RUN / 'recovery-anchor.json').chmod(0o644)
    manifest = (IMAGE / 'deployment.json').read_bytes(); run = json.loads((IMAGE / 'auth-pins.json').read_bytes())['runId']
    path = Path('/etc/osv-q2b-b1ct/context'); path.write_bytes(bytes.fromhex(sha(manifest)) + run.encode().ljust(64, b'\0') + case.encode().ljust(64, b'\0')); path.chmod(0o400)
    # Cleanly stopped static units may already be unloaded; only reset a failed unit.
    if subprocess.run(['systemctl', 'is-failed', '--quiet', UNITS[0]], capture_output=True).returncode == 0:
        command(['systemctl', 'reset-failed', UNITS[0]])


def start(case, anchor=None, reset=False):
    global LAST_BOOT
    if reset: durable_context(case, anchor)
    if reset: command(['systemctl', 'start', *UNITS[1:], UNITS[0]])
    boot = BASE['trace_boot'](); LAST_BOOT = boot; body = json.loads(base64.b64decode(boot['launch']))['body']
    until = time.monotonic() + 15
    while time.monotonic() < until:
        found = [e for e in events() if e.get('launchDigest') == sha(base64.b64decode(boot['launch'])) and e['kind'] in ('storage-ready', 'recovery-rejected')]
        if found:
            if found[-1]['kind'] == 'recovery-rejected':
                for _ in range(100):
                    if command(['systemctl', 'show', UNITS[0], '-p', 'ActiveState', '--value']).stdout.strip() == 'failed': break
                    time.sleep(.05)
                else: raise ValueError('failed-recovery-process-still-live')
            boot['storage'] = found[-1]; boot['recoveryAnchor'] = json.loads((RUN / 'recovery-anchor.json').read_bytes())
            boot['serviceState'] = command(['systemctl', 'show', UNITS[0], '-p', 'ActiveState', '-p', 'ExecMainStatus']).stdout.strip()
            print('storage boot ' + body['caseId'] + ': ' + found[-1]['kind'], file=sys.stderr, flush=True); return boot
        time.sleep(.05)
    raise ValueError('storage-readiness-missing')


def reset_root():
    command(['systemctl', 'stop', *UNITS])
    archive = Path('/var/lib/osv-q2b/evidence/b1ct') / ('round-' + auth.nonce()[:16]); ROOT.rename(archive)
    ROOT.mkdir(mode=0o700); os.chown(ROOT, 1101, 1201)
    return {'files': sorted(p.name for p in archive.iterdir()), 'archived': True}


def main(bundle_pin):
    auth.need(os.geteuid() == 0 and Path('/run/q2b-b1c-dedicated-vm').read_text() == 'disposable-q2b-b1c\n', 'dedicated-vm')
    bundle_raw = (IMAGE / 'bundle.json').read_bytes(); auth.need(sha(bundle_raw) == bundle_pin, 'bundle-pin')
    manifest_raw = (IMAGE / 'deployment.json').read_bytes(); manifest = json.loads(manifest_raw)
    mount = command(['findmnt', '-n', '-o', 'FSTYPE,OPTIONS', '--target', str(ROOT)]).stdout.split()
    auth.need(mount[0] == 'ext4' and {'rw', 'nosuid', 'nodev', 'noexec'} <= set(mount[1].split(',')), 'disk-mount')
    artifacts = [{'path': p['path'], 'sha256': sha(Path(p['path']).read_bytes()), 'byteLength': Path(p['path']).stat().st_size,
                  'ownerUid': Path(p['path']).stat().st_uid, 'nlink': Path(p['path']).stat().st_nlink,
                  'mode': stat.S_IMODE(Path(p['path']).stat().st_mode)} for p in manifest['artifacts']]
    boots = [start('native-boot-1')]; calls = []; rounds = []; isolation_cases = []; tampering = []; sealed_evidence = []
    def capture_seal():
        sealed_evidence.append({'seal': base64.b64encode((ROOT / 'seal.json').read_bytes()).decode(), 'selected': base64.b64encode((ROOT / 'selected.json').read_bytes()).decode(),
                               'intent': base64.b64encode((ROOT / 'intent.json').read_bytes()).decode(), 'payload': base64.b64encode((ROOT / 'data.bin').read_bytes()).decode(),
                               'root': {'device': str(ROOT.stat().st_dev), 'inode': str(ROOT.stat().st_ino)}})
    def call(name, role, operation, argument=None, accepted=True, reason=None):
        result = client(role, operation, argument); body = result['response']['body']
        auth.need(body['outcome'] == ('accepted' if accepted else 'rejected'), 'storage-case-' + name)
        if reason: auth.need(reason in (body['reason'] or ''), 'storage-reason-' + name)
        result['case'] = name; calls.append(result); return body['result']
    auth.need(call('empty', 'reader', 'read-state')['phase'] == 'empty', 'not-empty')
    call('stage', 'upload', 'stage', {'payload': base64.b64encode(PAYLOAD).decode()})
    seal = call('seal', 'publish', 'seal'); anchor = seal['sealDigest']
    capture_seal()
    auth.need(seal['dataDigest'] == sha(PAYLOAD) and ROOT.joinpath('data.bin').read_bytes() == PAYLOAD, 'disk-content')
    call('wrong-role', 'reader', 'stage', {'payload': base64.b64encode(PAYLOAD).decode()}, False, 'storage-role')
    read = call('read-sealed', 'reader', 'read-state'); auth.need(base64.b64decode(read['payload']) == PAYLOAD, 'ipc-content')
    pid = BASE['main_pid']()
    for index in range(1, 6):
        observation = isolation(index, pid); observation['principalIndex'] = index; isolation_cases.append(observation)
    auth.need(ROOT.joinpath('data.bin').read_bytes() == PAYLOAD and sha(ROOT.joinpath('seal.json').read_bytes()) == anchor, 'isolation-mutated-data')
    os.kill(pid, signal.SIGKILL)
    boots.append(start('storage-recovered', anchor, True)); auth.need(boots[-1]['storage']['kind'] == 'storage-ready' and boots[-1]['storage']['recovered'], 'recovery-not-ready')
    recovered = call('read-recovered', 'reader', 'read-state'); auth.need(recovered['recovered'] and recovered['sealDigest'] == anchor and base64.b64decode(recovered['payload']) == PAYLOAD, 'recovery-content')
    old_request = calls[1]['request']; replay_events = len(events())
    def replay():
        c = runpy.run_path(str(IMAGE / 'client_probe.py')); private, public, context = c['material']('upload'); observed = []; sent = []
        with c['channel']('upload') as connection:
            session = auth.client_auth(connection, context, 'upload', private, public, observed, sent=sent)
            auth.send(connection, old_request, session['deadline']); ended = BASE['rejected_connection'](connection)
            return {'replayRejected': True, 'connectionEnd': ended, 'requestDigest': sha(auth.canonical(old_request)), 'providerBoot': context['providerBoot'], 'providerCredentials': observed, 'clientProofFrames': len(sent)}
    stale = child(replay, 2)
    rejected = [e for e in events()[replay_events:] if e['kind'] == 'rejected' and e['peer'][0] == stale['actorPid']]
    auth.need(len(rejected) == 1 and rejected[0]['reason'] == 'request-binding', 'stale-request-not-rejected')
    stale['serverRejection'] = rejected[0]
    malformed_events = len(events())
    def malformed_request():
        c = runpy.run_path(str(IMAGE / 'client_probe.py')); private, public, context = c['material']('upload'); observed = []; sent = []
        with c['channel']('upload') as connection:
            session = auth.client_auth(connection, context, 'upload', private, public, observed, sent=sent)
            malformed = auth.sign([{}], 'upload', private); auth.send(connection, malformed, session['deadline']); ended = BASE['rejected_connection'](connection)
            return {'replayRejected': True, 'connectionEnd': ended, 'request': malformed, 'providerBoot': context['providerBoot'], 'providerCredentials': observed, 'clientProofFrames': len(sent)}
    malformed = child(malformed_request, 2)
    rejected = [e for e in events()[malformed_events:] if e['kind'] == 'rejected' and e['peer'][0] == malformed['actorPid']]
    auth.need(len(rejected) == 1 and rejected[0]['reason'] == 'signature-domain' and BASE['main_pid']() == json.loads((RUN / 'launch.json').read_bytes())['body']['pid'], 'malformed-body-not-rejected')
    malformed['serverRejection'] = rejected[0]
    for index, mutation in enumerate(('data', 'unknown-entry', 'symlink')):
        reset_root(); boot = start('tamper-' + str(index) + '-new', None, True); boots.append(boot)
        call(mutation + '-stage', 'upload', 'stage', {'payload': base64.b64encode(PAYLOAD).decode()})
        current = call(mutation + '-seal', 'publish', 'seal'); capture_seal(); command(['systemctl', 'stop', *UNITS])
        if mutation == 'data': (ROOT / 'data.bin').write_bytes(b'X' * len(PAYLOAD))
        elif mutation == 'unknown-entry': (ROOT / 'unknown').write_bytes(b'unknown')
        else: (ROOT / 'data.bin').unlink(); (ROOT / 'data.bin').symlink_to('/dev/null')
        boot = start('tamper-' + str(index) + '-recovery', current['sealDigest'], True); boots.append(boot)
        auth.need(boot['storage']['kind'] == 'recovery-rejected', 'tamper-recovery-adopted')
        tampering.append({'mutation': mutation, 'recoveryRejected': True, 'reason': boot['storage']['reason']})
    # Root controller injects faults; clients never select a fault or storage path.
    for index, fault in enumerate(FAULTS):
        reset_root(); (RUN / 'storage-fault').write_text('none')
        boot = start('fault-' + str(index) + '-new', None, True); boots.append(boot); auth.need(boot['storage']['kind'] == 'storage-ready', 'fresh-round')
        operation = 'stage' if fault in ('write', 'file-limit', 'file-sync', 'directory-sync', 'after-data') else 'seal'
        if operation == 'seal': call(fault + '-stage', 'upload', 'stage', {'payload': base64.b64encode(PAYLOAD).decode()})
        (RUN / 'storage-fault').write_text(fault)
        reason = 'File too large' if fault == 'file-limit' else 'injected-' + fault
        call(fault, 'upload' if operation == 'stage' else 'publish', operation, {'payload': base64.b64encode(PAYLOAD).decode()} if operation == 'stage' else {}, False, reason)
        (RUN / 'storage-fault').write_text('none'); call(fault + '-stopped', 'reader', 'read-state', accepted=False, reason='storage-unavailable')
        before = len([e for e in events() if e['kind'] == 'storage-operation' and e.get('result', {}).get('phase') == 'sealed'])
        boot = start('fault-' + str(index) + '-recovery', None, True); boots.append(boot)
        auth.need(boot['storage']['kind'] == 'recovery-rejected', 'unacknowledged-recovery-adopted')
        after = len([e for e in events() if e['kind'] == 'storage-operation' and e.get('result', {}).get('phase') == 'sealed'])
        auth.need(after == before, 'fault-success-recorded')
        rounds.append({'fault': fault, 'recoveryRejected': True, 'successRecordsAddedDuringRecovery': after - before,
                       'partialInventory': sorted(p.name for p in ROOT.iterdir()), 'reason': boot['storage']['reason']})
    return {'schema': 'osv-mcp.q2b.native-storage-observation.v1', 'runId': json.loads(bundle_raw)['runId'],
            'manifest': manifest, 'manifestDigest': sha(manifest_raw), 'artifacts': artifacts, 'boots': boots,
            'calls': calls, 'staleRequest': stale, 'malformedRequest': malformed, 'isolation': isolation_cases, 'faults': rounds, 'tampering': tampering, 'sealedEvidence': sealed_evidence,
            'events': events(), 'mount': {'filesystem': mount[0], 'options': mount[1].split(',')},
            'payloadDigest': sha(PAYLOAD), 'serviceRestartRecoveryObserved': True, 'vmPowerLossTested': False,
            'nativeIsolationVerified': False, 'independentRegistryVerified': False, 'profileApproved': False, 'backendEligible': False, 'originalReadsSkipped': 0}


if __name__ == '__main__': print(json.dumps(main(sys.argv[1]), sort_keys=True))
