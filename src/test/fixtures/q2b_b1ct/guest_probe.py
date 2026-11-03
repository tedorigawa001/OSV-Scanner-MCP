"""Independent root controller in the dedicated VM. No adoption or storage authority."""
import array
import base64
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import runpy
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
from pathlib import Path

IMAGE = Path('/opt/osv-q2b/b1ct'); RUN = Path('/run/osv-q2b/b1ct')
sys.path.insert(0, str(IMAGE))
import auth

LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.ptrace.restype = ctypes.c_long
LIBC.ptrace.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
LIBC.syscall.restype = ctypes.c_long
ROLES = ('provider', 'reader', 'build', 'writer', 'checkpoint', 'registry')
CAPS = ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')
UNITS = ['osv-q2b-b1ct.service'] + ['osv-q2b-b1ct-' + role + '.socket' for role in ('reader', 'upload', 'publish')]
PLAN = [('honest-reader', 1, 'accepted', 2), ('honest-upload', 2, 'accepted', 2), ('honest-publish', 3, 'accepted', 2),
        ('wrong-role', 1, 'rejected', 0), ('server-proof', 1, 'rejected', 0), ('response-replay', 1, 'rejected', 2),
        ('request-replay', 1, 'rejected', 1), ('proof-replay', 1, 'rejected', 0), ('session-replay', 1, 'rejected', 0),
        *[(name, 1, 'rejected', 0) for name in ('unknown-field', 'role-escalation', 'duplicate-key', 'noncanonical',
          'invalid-integer', 'oversized', 'truncated', 'slow-drip', 'ancillary-fd', 'ancillary-many-fds')]]


def sha(raw): return hashlib.sha256(raw).hexdigest()


def status(pid):
    fields = dict(line.split(':', 1) for line in Path('/proc/' + str(pid) + '/status').read_text().splitlines() if ':' in line)
    return {'uid': [int(x) for x in fields['Uid'].split()][:3], 'gid': [int(x) for x in fields['Gid'].split()][:3],
            'groups': [int(x) for x in fields['Groups'].split()], 'capabilities': {name: fields[name].strip() for name in CAPS},
            'noNewPrivileges': fields['NoNewPrivs'].strip() == '1'}


def drop(index):
    for cap in range(64):
        result = LIBC.prctl(23, cap, 0, 0, 0)
        if result < 0: auth.need(ctypes.get_errno() == errno.EINVAL, 'capability-range')
        else: auth.need(LIBC.prctl(24, cap, 0, 0, 0) == 0, 'capability-drop')
    os.setgroups([]); os.setresgid(1201 + index, 1201 + index, 1201 + index); os.setresuid(1101 + index, 1101 + index, 1101 + index)
    auth.need(LIBC.prctl(38, 1, 0, 0, 0) == 0, 'nnp')


def wait(pid, timeout=40):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        found, state = os.waitpid(pid, os.WNOHANG | os.WUNTRACED)
        if found: return state
        time.sleep(.01)
    raise ValueError('process-deadline')


def ptrace(request, pid, data=0):
    auth.need(LIBC.ptrace(request, pid, None, ctypes.c_void_p(data)) == 0, 'ptrace-' + str(request) + '-' + str(ctypes.get_errno()))


def duplicate(pid, target):
    pfd = os.pidfd_open(pid)
    try:
        result = LIBC.syscall(438, pfd, target, 0)  # SYS_pidfd_getfd, pinned arm64 Linux profile.
        auth.need(result >= 0, 'pidfd-getfd-' + str(ctypes.get_errno()))
        return result
    finally: os.close(pfd)


def phase(pid, name):
    base = Path('/proc/' + str(pid))
    fields = status(pid); argv = [x.decode() for x in (base / 'cmdline').read_bytes().split(b'\0') if x]
    executable = os.readlink(base / 'exe')
    environment = {}
    allowed = {'LANG', 'LC_ALL', 'CREDENTIALS_DIRECTORY', 'LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES'}
    if name == 'manager': allowed |= {'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID'}
    for item in (base / 'environ').read_bytes().split(b'\0'):
        if item:
            key, value = item.decode().split('=', 1); auth.need(key in allowed and key not in environment, 'environment-allowlist'); environment[key] = value
    fds = []; listeners = []; boot = None
    auth.need(sorted(int(p.name) for p in (base / 'fd').iterdir()) == list(range(7)), 'phase-fd-closure')
    for number in range(7):
        fd = duplicate(pid, number)
        try:
            info = os.fstat(fd); flags = fcntl.fcntl(fd, fcntl.F_GETFL)
            entry = {'fd': number, 'device': str(info.st_dev), 'inode': str(info.st_ino), 'ownerUid': info.st_uid,
                     'ownerGid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode), 'flags': flags}
            if number == 0:
                auth.need(stat.S_ISCHR(info.st_mode) and info.st_rdev == os.stat('/dev/null').st_rdev and flags & os.O_ACCMODE == os.O_RDONLY, 'stdin')
                entry['kind'] = 'null'
            elif number in (1, 2):
                stream = socket.socket(fileno=fd)
                try:
                    auth.need(auth.credentials(stream)[1:] == (0, 0) and stream.getpeername() == '/run/systemd/journal/stdout', 'journal-custody')
                    entry['kind'] = 'journal'
                finally: stream.detach()
            elif number < 6:
                stream = socket.socket(fileno=fd)
                try:
                    role = ('reader', 'upload', 'publish')[number - 3]; path = RUN / (role + '.sock'); leaf = path.lstat()
                    auth.need(stream.getsockname() == str(path) and stream.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 1 and
                              stream.getsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED) == 1, 'listener-inventory')
                    listeners.append({'fd': number, 'role': role, 'path': str(path), 'cookie': str(struct.unpack('=Q', stream.getsockopt(socket.SOL_SOCKET, 57, 8))[0]),
                        'custodianUid': 0, 'custodianGid': 0, 'ownerUid': leaf.st_uid, 'ownerGid': leaf.st_gid, 'mode': stat.S_IMODE(leaf.st_mode),
                        'directoryWriters': [0], 'domain': 'AF_UNIX', 'type': 'SOCK_STREAM', 'listening': True, 'passCredentials': True,
                        'pathnameDevice': str(leaf.st_dev), 'pathnameInode': str(leaf.st_ino), 'descriptorInode': str(info.st_ino)})
                    entry['kind'] = 'listener'
                finally: stream.detach()
            else:
                entry.update(kind='bootstrap', seals=fcntl.fcntl(fd, fcntl.F_GET_SEALS))
                boot = os.pread(fd, 233, 0); auth.need(len(boot) == 232 and info.st_uid == 0 and entry['seals'] == 15 and flags & os.O_ACCMODE == 0, 'bootstrap-custody')
            fds.append(entry)
        finally: os.close(fd)
    return {'phase': name, 'pid': pid, **fields, 'executable': executable, 'exeSha256': sha((base / 'exe').read_bytes()),
            'argv': argv, 'cwd': os.readlink(base / 'cwd'), 'environment': environment, 'fds': fds,
            'listeners': listeners, 'bootstrapHex': boot.hex()}


def main_pid():
    return int(subprocess.check_output(['systemctl', 'show', 'osv-q2b-b1ct.service', '-p', 'MainPID', '--value'], text=True).strip())


def trace_boot():
    until = time.monotonic() + 30
    while time.monotonic() < until:
        pid = main_pid()
        if pid > 1 and '\nState:\tT' in Path('/proc/' + str(pid) + '/status').read_text(): break
        time.sleep(.05)
    else: raise ValueError('manager-stop-missing')
    print('native trace: manager gate observed pid=' + str(pid), file=sys.stderr, flush=True)
    launch_raw = (RUN / 'launch.json').read_bytes(); launch = json.loads(launch_raw)['body']
    ptrace(16, pid); state = wait(pid); auth.need(os.WIFSTOPPED(state), 'attach-stop')
    ptrace(0x4200, pid, 0x10 | 0x100000)
    phases = [phase(pid, 'manager')]; execs = []
    os.kill(pid, signal.SIGCONT); ptrace(7, pid)
    try:
        for _ in range(16):
            state = wait(pid); auth.need(os.WIFSTOPPED(state), 'unexpected-process-exit')
            if state >> 16 == 4:
                base = Path('/proc/' + str(pid)); name = 'launcher' if not execs else 'provider'
                execs.append({'sequence': len(execs) + 1, 'phase': name, 'pid': pid, 'path': os.readlink(base / 'exe'), 'sha256': sha((base / 'exe').read_bytes())})
                auth.need(len(execs) <= 2, 'extra-exec')
            elif os.WSTOPSIG(state) == signal.SIGSTOP and len(execs) == len(phases) and len(execs) in (1, 2):
                phases.append(phase(pid, 'launcher' if len(execs) == 1 else 'provider'))
                print('native trace: ' + phases[-1]['phase'] + ' gate observed', file=sys.stderr, flush=True)
                if len(phases) == 3:
                    ptrace(17, pid)
                    return {'caseId': launch['caseId'], 'launch': base64.b64encode(launch_raw).decode(), 'phases': phases, 'execs': execs}
            else:
                auth.need(os.WSTOPSIG(state) in (signal.SIGSTOP, signal.SIGCONT, signal.SIGTRAP), 'unexpected-signal')
            ptrace(7, pid)
        raise ValueError('phase-trace-incomplete')
    except BaseException:
        os.kill(pid, signal.SIGKILL); raise


def events():
    path = Path('/var/lib/osv-q2b/provider/b1ct/events.jsonl')
    if not path.exists(): return []
    raw = path.read_bytes(); auth.need(len(raw) <= 256 * 1024, 'event-budget')
    return [json.loads(line) for line in raw.splitlines()]


def operations(): return len([e for e in events() if e['kind'] == 'operation'])


def rejected_connection(channel):
    try:
        auth.need(channel.recv(1) == b'', 'unexpected-response')
        return 'eof'
    except ConnectionResetError as error:
        auth.need(error.errno == errno.ECONNRESET, 'unexpected-socket-error')
        return 'reset-unread-data'


def client(case, index):
    incoming, outgoing = os.pipe2(os.O_CLOEXEC); pid = os.fork()
    if pid == 0:
        try:
            os.close(incoming); os.dup2(outgoing, 1); os.closerange(3, 256); drop(index); os.kill(os.getpid(), signal.SIGSTOP)
            os.execv(str(IMAGE / 'runtime'), [str(IMAGE / 'runtime'), '-I', str(IMAGE / 'client_probe.py'), case])
        except BaseException: os._exit(79)
    os.close(outgoing)
    try:
        stopped = wait(pid); auth.need(os.WIFSTOPPED(stopped), 'client-not-started'); identity = status(pid)
        auth.need(identity['uid'] == [1101 + index] * 3 and identity['gid'] == [1201 + index] * 3 and not identity['groups'] and
                  all(int(v, 16) == 0 for v in identity['capabilities'].values()) and identity['noNewPrivileges'], 'client-identity')
        os.kill(pid, signal.SIGCONT)
        # Drain the pipe before waitpid; a diagnostic cannot block behind a full pipe.
        chunks = []; size = 0
        while True:
            data = os.read(incoming, 4096)
            if not data: break
            size += len(data); auth.need(size <= 32768, 'client-output-budget'); chunks.append(data)
        state = wait(pid); auth.need(os.WIFEXITED(state) and os.WEXITSTATUS(state) == 0, 'client-failed-' + case)
        return {'identity': identity, 'actorPid': pid, **json.loads(b''.join(chunks))}
    finally:
        os.close(incoming)
        try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError): pass


def run_case(case, index, outcome, accepted):
    (RUN / 'fault').write_text(case if case in ('server-proof', 'response-replay', 'old-response') else 'none')
    before = operations(); prior_events = len(events()); result = client(case, index)
    until = time.monotonic() + 1
    while operations() - before < accepted and time.monotonic() < until: time.sleep(.01)
    after = operations(); auth.need(result['outcome'] == outcome and after - before == accepted, 'case-expectation-' + case)
    authenticated = 'proof' in result['samples']
    auth.need(authenticated == (case not in ('wrong-role', 'server-proof', 'old-proof')), 'authentication-not-exercised-' + case)
    reasons = [e['reason'] for e in events()[prior_events:] if e['kind'] == 'rejected' and e['peer'][0] == result['actorPid']]
    expected_reason = {'request-replay': 'request-binding', 'session-replay': 'request-binding', 'proof-replay': 'proof-binding',
        'old-proof': 'proof-binding', 'unknown-field': 'request-binding', 'role-escalation': 'request-binding', 'invalid-integer': 'request-binding',
        'duplicate-key': 'duplicate-key', 'noncanonical': 'noncanonical', 'oversized': 'frame-budget', 'truncated': 'credential-missing',
        'ancillary-fd': 'ancillary-invalid', 'ancillary-many-fds': 'ancillary-invalid'}.get(case)
    if expected_reason: auth.need(expected_reason in reasons, 'rejection-not-exercised-' + case)
    if case == 'server-proof': auth.need(result.get('reason') == 'signature-invalid', 'server-signature-not-exercised')
    if case in ('response-replay', 'old-response'): auth.need(result.get('reason') == 'response-binding', 'response-binding-not-exercised')
    if case == 'slow-drip': auth.need(any(r in ('timed out', 'deadline') for r in reasons) and result['elapsedMs'] >= 1500, 'slow-drip-not-exercised')
    if case == 'server-proof': auth.need(result['clientProofFrames'] == 0, 'proof-sent-before-server-auth')
    if case == 'slow-drip': auth.need(result['elapsedMs'] <= 3500, 'slow-drip-deadline')
    pid = main_pid(); until = time.monotonic() + 3
    while time.monotonic() < until:
        actual = sorted(int(p.name) for p in Path('/proc/' + str(pid) + '/fd').iterdir())
        if actual == list(range(7)): break
        time.sleep(.01)
    auth.need(actual == list(range(7)), 'received-fd-leak-' + case)
    return {'case': case, 'outcome': outcome, 'acceptedOperations': after - before, 'verified': True,
            'providerFdCountAfter': len(actual), 'authenticated': authenticated, 'serverRejectionReasons': reasons,
            **{key: value for key, value in result.items() if key != 'samples'}}, result['samples']


def references(identities):
    found = []; total = 0; pids = [p for p in Path('/proc').iterdir() if p.name.isdigit()]
    auth.need(len(pids) <= 4096, 'process-inventory-budget')
    for process in pids:
        try: entries = list((process / 'fd').iterdir())
        except FileNotFoundError: continue
        auth.need(len(entries) <= 512, 'fd-inventory-budget')
        for entry in entries:
            total += 1; auth.need(total <= 16384, 'fd-inventory-budget')
            try: info = entry.stat()
            except FileNotFoundError: continue
            if (str(info.st_dev), str(info.st_ino)) in identities:
                found.append({'pid': int(process.name), 'fd': int(entry.name), 'device': str(info.st_dev), 'inode': str(info.st_ino)})
    return found


def held_reader(prefix=False):
    """Fault setup: pass one authenticated client FD and a pre-signed public request.
    No key bytes are sent to the controller or the receiving principal.
    """
    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
    pid = os.fork()
    if pid == 0:
        try:
            parent.close(); drop(1); os.kill(os.getpid(), signal.SIGSTOP)
            module = runpy.run_path(str(IMAGE / 'client_probe.py'))
            private, public, context = module['material']('reader')
            with module['channel']('reader') as connection:
                session = auth.client_auth(connection, context, 'reader', private, public)
                request = auth.request(session, 1, 'inspect', private, 'reader'); raw = auth.canonical(request)
                frame = struct.pack('!I', len(raw)) + raw
                if prefix: connection.sendall(frame[:8])
                payload = {'context': context, 'sessionId': session['sessionId'], 'request': request,
                           'remaining': base64.b64encode(frame[8:] if prefix else frame).decode()}
                child.sendmsg([auth.canonical(payload)], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [connection.fileno()]))])
            child.close(); os._exit(0)
        except BaseException: os._exit(79)
    child.close()
    try:
        stopped = wait(pid); auth.need(os.WIFSTOPPED(stopped), 'held-client-stop'); identity = status(pid); os.kill(pid, signal.SIGCONT)
        parent.settimeout(5); raw, control, flags, _ = parent.recvmsg(16384, socket.CMSG_SPACE(4), socket.MSG_CMSG_CLOEXEC)
        fds = []
        for level, kind, data in control:
            auth.need(level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS, 'controller-channel')
            values = array.array('i'); values.frombytes(data); fds.extend(values)
        auth.need(len(fds) == 1 and not flags & socket.MSG_CTRUNC, 'controller-fd-transfer')
        ended = wait(pid); auth.need(os.WIFEXITED(ended) and os.WEXITSTATUS(ended) == 0, 'held-client-failed')
        return socket.socket(fileno=fds[0]), json.loads(raw), identity
    finally:
        parent.close()
        try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError): pass


def forward_case(index, prefix):
    before = operations(); prior_events = len(events()); connection, material, initial = held_reader(prefix)
    incoming, outgoing = os.pipe2(os.O_CLOEXEC); pid = os.fork()
    if pid == 0:
        try:
            os.close(incoming); drop(index); os.kill(os.getpid(), signal.SIGSTOP)
            connection.sendall(base64.b64decode(material['remaining']))
            if index == 1:
                from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
                public = Ed25519PublicKey.from_public_bytes(base64.b64decode(json.loads((IMAGE / 'auth-pins.json').read_bytes())['keys']['provider']))
                envelope, _ = auth.receive(connection, time.monotonic() + 2, (material['context']['providerPid'], 1101, 1201))
                auth.response(envelope, material['request'], public, {'sessionId': material['sessionId']})
                result = {'outcome': 'accepted'}
            else:
                connection.settimeout(2); rejected_connection(connection)
                result = {'outcome': 'rejected'}
            os.write(outgoing, auth.canonical(result)); os._exit(0)
        except BaseException: os._exit(79)
    os.close(outgoing)
    try:
        state = wait(pid); auth.need(os.WIFSTOPPED(state), 'forward-stop'); identity = status(pid); os.kill(pid, signal.SIGCONT)
        raw = os.read(incoming, 4096); state = wait(pid); auth.need(os.WIFEXITED(state) and os.WEXITSTATUS(state) == 0, 'forward-failed')
        connection.close(); time.sleep(.05); accepted = operations() - before
        auth.need(accepted == (1 if index == 1 else 0), 'forward-operation-count')
        reasons = [e['reason'] for e in events()[prior_events:] if e['kind'] == 'rejected']
        if index != 1: auth.need('credential-mismatch' in reasons, 'fragment-credentials-not-exercised')
        return {'case': 'same-uid-forward' if index == 1 else 'cross-uid-fragment' if prefix else 'cross-uid-fd-forward',
                'verified': True, 'acceptedOperations': accepted, 'identity': identity, 'initialIdentity': initial,
                'serverRejectionReasons': reasons, **json.loads(raw)}
    finally:
        connection.close(); os.close(incoming)
        try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError): pass


def queued():
    incoming, outgoing = os.pipe2(os.O_CLOEXEC); pid = os.fork()
    if pid == 0:
        try:
            os.close(incoming); drop(1)
            channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); channel.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            channel.connect(str(RUN / 'reader.sock')); channel.sendall(b'X'); os.kill(os.getpid(), signal.SIGSTOP)
            channel.settimeout(2); rejected_connection(channel); channel.close()
            os.write(outgoing, b'{"outcome":"rejected"}'); os._exit(0)
        except BaseException: os._exit(79)
    os.close(outgoing); state = wait(pid); auth.need(os.WIFSTOPPED(state), 'queued-not-ready')
    return pid, incoming, status(pid)


def finish_queued(pending):
    pid, incoming, identity = pending
    try:
        os.kill(pid, signal.SIGCONT); raw = os.read(incoming, 4096); state = wait(pid)
        auth.need(os.WIFEXITED(state) and os.WEXITSTATUS(state) == 0, 'queued-failed')
        auth.need(any(e['kind'] == 'rejected' and e['peer'][0] == pid and e['reason'] == 'queued-data' for e in events()), 'queued-rejection-not-observed')
        return {'case': 'preflight-queued-data', 'identity': identity, 'verified': True, 'acceptedOperations': 0,
                'clientProofFrames': 0, **json.loads(raw)}
    finally: os.close(incoming)


def impostor(case, signed_challenge):
    wrong_custodian = case == 'wrong-custodian'
    path = Path('/var/lib/osv-q2b-clients/b1ct/reader/impostor.sock') if wrong_custodian else RUN / 'impostor.sock'
    auth.need(not path.exists() and not path.is_symlink(), 'impostor-path-existing')
    listener = None
    if not wrong_custodian:
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); listener.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        listener.bind(str(path)); listener.listen(1); os.chmod(path, 0o660); os.chown(path, 0, 1202)
    server = os.fork()
    if server == 0:
        try:
            drop(1 if wrong_custodian else 2)
            if wrong_custodian:
                listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); listener.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
                listener.bind(str(path)); listener.listen(1)
            os.kill(os.getpid(), signal.SIGSTOP); listener.settimeout(3)
            with listener.accept()[0] as peer:
                if not wrong_custodian: auth.send(peer, signed_challenge, time.monotonic() + 2)
                else: peer.settimeout(2); auth.need(peer.recv(1) == b'', 'client-proof-disclosed')
            os._exit(0)
        except BaseException: os._exit(79)
    state = wait(server); auth.need(os.WIFSTOPPED(state), 'impostor-not-ready'); server_identity = status(server)
    incoming, outgoing = os.pipe2(os.O_CLOEXEC); client_pid = os.fork()
    if client_pid == 0:
        try:
            os.close(incoming)
            if listener is not None: listener.close()
            drop(1); os.kill(os.getpid(), signal.SIGSTOP)
            module = runpy.run_path(str(IMAGE / 'client_probe.py')); private, public, context = module['material']('reader'); sent = []
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
                channel.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1); channel.settimeout(2); channel.connect(str(path))
                custodian = list(auth.credentials(channel))
                try: auth.client_auth(channel, context, 'reader', private, public, sent=sent)
                except ValueError as error: result = {'outcome': 'rejected', 'reason': str(error), 'clientProofFrames': len(sent), 'custodian': custodian}
                else: raise ValueError('impostor-authenticated')
            os.write(outgoing, auth.canonical(result)); os._exit(0)
        except BaseException: os._exit(79)
    os.close(outgoing)
    try:
        state = wait(client_pid); auth.need(os.WIFSTOPPED(state), 'impostor-client-not-ready'); identity = status(client_pid)
        os.kill(server, signal.SIGCONT); os.kill(client_pid, signal.SIGCONT)
        raw = os.read(incoming, 4096); state = wait(client_pid); auth.need(os.WIFEXITED(state) and os.WEXITSTATUS(state) == 0, 'impostor-client-failed')
        state = wait(server); auth.need(os.WIFEXITED(state) and os.WEXITSTATUS(state) == 0, 'impostor-server-failed')
        result = json.loads(raw); auth.need(result['reason'] == ('custodian-mismatch' if wrong_custodian else 'credential-mismatch') and result['clientProofFrames'] == 0, 'impostor-refusal-boundary')
        if not wrong_custodian: auth.need(result['custodian'][1:] == [0, 0], 'manager-custodian-not-preserved')
        return {'case': case, 'verified': True, 'acceptedOperations': 0, 'identity': identity, 'impostorIdentity': server_identity, **result}
    finally:
        os.close(incoming)
        if listener is not None: listener.close()
        for child in (server, client_pid):
            try: os.kill(child, signal.SIGKILL); os.waitpid(child, 0)
            except (ProcessLookupError, ChildProcessError): pass
        if path.exists(): path.unlink()


def lifecycle(boot):
    pid = boot['phases'][-1]['pid']; tracked = {(f['device'], f['inode']) for f in boot['phases'][-1]['fds'] if f['fd'] >= 3}
    old_launch = (RUN / 'launch.json').read_bytes(); leaves = {role: (RUN / (role + '.sock')).lstat() for role in ('reader', 'upload', 'publish')}
    old_connection, _, _ = held_reader()
    st = os.fstat(old_connection.fileno()); tracked.add((str(st.st_dev), str(st.st_ino)))
    for fd in Path('/proc/' + str(pid) + '/fd').iterdir():
        if int(fd.name) >= 7:
            st = fd.stat(); tracked.add((str(st.st_dev), str(st.st_ino)))
    held = duplicate(pid, 3); holder = os.fork()
    if holder == 0:
        for fd in range(3, 256):
            if fd != held:
                try: os.close(fd)
                except OSError: pass
        drop(1); os.kill(os.getpid(), signal.SIGSTOP); signal.pause(); os._exit(0)
    os.close(held); state = wait(holder); auth.need(os.WIFSTOPPED(state), 'holder-not-ready')
    holder_identity = status(holder); os.kill(holder, signal.SIGCONT)
    try:
        os.kill(pid, signal.SIGKILL)
        until = time.monotonic() + 5
        while Path('/proc/' + str(pid)).exists() and time.monotonic() < until: time.sleep(.02)
        auth.need(not Path('/proc/' + str(pid)).exists(), 'old-provider-alive')
        old_connection.settimeout(2); auth.need(old_connection.recv(1) == b'', 'old-connection-still-authorized')
        subprocess.run(['systemctl', 'start', 'osv-q2b-b1ct.service'], capture_output=True, timeout=20)
        until = time.monotonic() + 15
        while time.monotonic() < until:
            active = subprocess.check_output(['systemctl', 'show', 'osv-q2b-b1ct.service', '-p', 'ActiveState', '--value'], text=True).strip()
            if active == 'failed': break
            time.sleep(.05)
        exit_status = subprocess.check_output(['systemctl', 'show', 'osv-q2b-b1ct.service', '-p', 'ExecMainStatus', '--value'], text=True).strip()
        auth.need(active == 'failed' and exit_status == '78' and (RUN / 'launch.json').read_bytes() == old_launch, 'service-only-restart-accepted')
        subprocess.run(['systemctl', 'stop', 'osv-q2b-b1ct.target', *UNITS], check=True, timeout=30, capture_output=True)
        with_client = references(tracked); auth.need(any(r['pid'] == os.getpid() for r in with_client), 'old-connection-reference-missing')
        old_connection.close(); leaked = references(tracked); auth.need(any(r['pid'] == holder for r in leaked), 'leaked-fd-not-observed')
        # No reclamation while any old reference remains. Check every leaf unchanged.
        for role, old in leaves.items():
            current = (RUN / (role + '.sock')).lstat(); auth.need((current.st_dev, current.st_ino) == (old.st_dev, old.st_ino), 'premature-unlink')
        os.kill(holder, signal.SIGTERM); state = wait(holder); auth.need(os.WIFSIGNALED(state), 'holder-not-ended')
        remaining = references(tracked); auth.need(not remaining, 'old-fd-references-remain')
        for role, old in leaves.items():
            path = RUN / (role + '.sock'); current = path.lstat()
            auth.need((current.st_dev, current.st_ino, current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)) ==
                      (old.st_dev, old.st_ino, 0, 1202 + ('reader', 'upload', 'publish').index(role), 0o660), 'reclaim-identity')
            path.unlink()
        auth.need((RUN / 'launch.json').read_bytes() == old_launch, 'launch-replaced'); (RUN / 'launch.json').unlink()
        context_path = Path('/etc/osv-q2b-b1ct/context'); raw = context_path.read_bytes()
        context_path.write_bytes(raw[:96] + b'native-boot-2'.ljust(64, b'\0')); context_path.chmod(0o400)
        subprocess.run(['systemctl', 'reset-failed', 'osv-q2b-b1ct.service'], check=True, timeout=10)
        subprocess.run(['systemctl', 'start', 'osv-q2b-b1ct.target'], check=True, timeout=30)
        return {'serviceOnlyRestartRejected': True, 'oldProviderKilled': True, 'oldConnectionEof': True, 'oldConnectionReferenceObserved': True,
                'referencesWithOldClient': with_client, 'holderIdentity': holder_identity, 'holderPid': holder, 'controllerPid': os.getpid(),
                'referencesBeforeReclaim': leaked, 'referencesAfterHolderExit': remaining, 'reclaimedKnownLeaves': 3,
                'backendEligible': False}
    finally:
        old_connection.close()
        try: os.kill(holder, signal.SIGKILL); os.waitpid(holder, 0)
        except (ProcessLookupError, ChildProcessError): pass


def run(bundle_pin):
    auth.need(os.geteuid() == 0 and Path('/proc/1/comm').read_text().strip() == 'systemd', 'dedicated-root-controller')
    auth.need(sha((IMAGE / 'bundle.json').read_bytes()) == bundle_pin, 'bundle-pin')
    manifest_raw = (IMAGE / 'deployment.json').read_bytes(); manifest = json.loads(manifest_raw)
    artifacts = []
    for item in manifest['artifacts']:
        path = Path(item['path']); st = path.lstat(); raw = path.read_bytes()
        auth.need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022 and st.st_nlink == 1 and
                  len(raw) == item['byteLength'] and sha(raw) == item['sha256'], 'artifact-observation')
        artifacts.append({'path': str(path), 'sha256': sha(raw), 'byteLength': len(raw), 'ownerUid': st.st_uid,
                          'mode': stat.S_IMODE(st.st_mode), 'nlink': st.st_nlink})
    pending = queued(); first = trace_boot(); cases = [finish_queued(pending)]; sample = None
    for row in PLAN:
        result, samples = run_case(*row); cases.append(result)
        if row[0] == 'honest-reader': sample = samples
    cases += [forward_case(1, False), forward_case(2, False), forward_case(2, True)]
    cases += [impostor('wrong-custodian', sample['challenge']), impostor('wrong-provider', sample['challenge'])]
    (RUN / 'old-proof').write_bytes(auth.canonical(sample['proof'])); (RUN / 'old-proof').chmod(0o644)
    (RUN / 'old-response').write_bytes(auth.canonical(sample['response'])); (RUN / 'old-response').chmod(0o644)
    restart = lifecycle(first); second = trace_boot()
    auth.need(first['phases'][0]['bootstrapHex'] != second['phases'][0]['bootstrapHex'], 'bootstrap-reused')
    old = json.loads(base64.b64decode(first['launch']))['body']; new = json.loads(base64.b64decode(second['launch']))['body']
    auth.need(old['providerBoot'] != new['providerBoot'] and not set(l['cookie'] for l in old['listeners']) & set(l['cookie'] for l in new['listeners']), 'generation-reused')
    for row in [('old-proof', 1, 'rejected', 0), ('old-response', 1, 'rejected', 1), ('honest-reader', 1, 'accepted', 2)]:
        result, _ = run_case(*row); result['case'] = 'restart-' + row[0]; cases.append(result)
    (RUN / 'fault').write_text('none')
    return {'schema': 'osv-mcp.q2b.b1ct.native-observation.v1', 'runId': new['runId'], 'manifestDigest': sha(manifest_raw),
            'manifest': manifest, 'artifacts': artifacts, 'boots': [first, second], 'cases': cases, 'verifiedCases': len(cases), 'lifecycle': restart,
            'nativeIsolationVerified': False, 'backendEligible': False, 'profileApproved': False, 'originalReadsSkipped': 0}


if __name__ == '__main__':
    try:
        print(json.dumps(run(sys.argv[1]), sort_keys=True))
    except BaseException:
        subprocess.run(['journalctl', '-u', 'osv-q2b-b1ct.service', '-n', '15', '--no-pager', '--output=cat'], stdout=sys.stderr)
        raise
