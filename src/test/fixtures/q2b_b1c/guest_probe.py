"""Root controller for a dedicated, externally provisioned systemd VM.

Unsigned raw observations only. Not a B1a evidence adapter or adoption gate.
No provider accept, application key, grant, checkpoint or registry operation.
"""
import ctypes
import errno
import hashlib
import json
import os
import pwd
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
from pathlib import Path

ROLES = ('provider', 'reader', 'build', 'writer', 'checkpoint', 'registry')
CAPS = ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')
IMAGE = Path('/opt/osv-q2b/b1c')
STATE = Path('/var/lib/osv-q2b')
ENDPOINTS = Path('/run/osv-q2b/b1c')
ROOT = STATE / 'evidence/b1c'


def require(value, reason):
    if not value:
        raise ValueError(reason)


def status(pid):
    fields = dict(line.split(':', 1) for line in Path('/proc/' + str(pid) + '/status').read_text().splitlines() if ':' in line)
    return {'pid': pid, 'uid': [int(x) for x in fields['Uid'].split()],
            'gid': [int(x) for x in fields['Gid'].split()], 'groups': [int(x) for x in fields['Groups'].split()],
            'capabilities': {name: fields[name].strip() for name in CAPS},
            'noNewPrivileges': fields['NoNewPrivs'].strip() == '1', 'tracerPid': int(fields['TracerPid'])}


def drop(index):
    libc = ctypes.CDLL(None, use_errno=True)
    for capability in range(64):
        present = libc.prctl(23, capability, 0, 0, 0)
        if present < 0:
            require(ctypes.get_errno() == errno.EINVAL, 'capability range')
        else:
            require(libc.prctl(24, capability, 0, 0, 0) == 0, 'capability drop')
    os.setgroups([])
    os.setresgid(1201 + index, 1201 + index, 1201 + index)
    os.setresuid(1101 + index, 1101 + index, 1101 + index)
    require(libc.prctl(38, 1, 0, 0, 0) == 0, 'no new privileges')
    identity = status(os.getpid())
    require(identity['uid'] == [1101 + index] * 4 and identity['gid'] == [1201 + index] * 4 and
            not identity['groups'] and all(int(v, 16) == 0 for v in identity['capabilities'].values()) and
            identity['noNewPrivileges'] and identity['tracerPid'] == 0, 'child principal')


def child_case(index, operation):
    reader, writer = os.pipe2(os.O_CLOEXEC)
    pid = os.fork()
    if pid == 0:
        os.close(reader)
        try:
            drop(index)
            # Parent reads real /proc identity while this actor is stopped.
            os.kill(os.getpid(), signal.SIGSTOP)
            try:
                operation()
                outcome = {'errno': 0}
            except OSError as error:
                outcome = {'errno': error.errno}
            os.write(writer, json.dumps(outcome).encode())
            os._exit(0)
        except BaseException:
            os._exit(79)
    os.close(writer)
    try:
        _, stopped = os.waitpid(pid, os.WUNTRACED)
        require(os.WIFSTOPPED(stopped) and os.WSTOPSIG(stopped) == signal.SIGSTOP, 'actor did not reach ready stop')
        identity = status(pid)
        require(identity['uid'] == [1101 + index] * 4 and identity['gid'] == [1201 + index] * 4 and
                not identity['groups'] and all(int(v, 16) == 0 for v in identity['capabilities'].values()) and
                identity['noNewPrivileges'] and identity['tracerPid'] == 0, 'external principal mismatch')
        os.kill(pid, signal.SIGCONT)
        _, exit_status = os.waitpid(pid, 0)
        require(os.WIFEXITED(exit_status) and os.WEXITSTATUS(exit_status) == 0, 'actor failed')
        raw = os.read(reader, 4097)
        require(0 < len(raw) <= 4096, 'actor report budget')
        return {'actor': ROLES[index], 'identity': identity, **json.loads(raw)}
    finally:
        os.close(reader)
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass


def opened(path, flags):
    descriptor = os.open(path, flags | os.O_CLOEXEC | os.O_NOFOLLOW)
    os.close(descriptor)


def guard_ancestors(path):
    for ancestor in reversed(path.parents):
        info = ancestor.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'unsafe ancestor: ' + str(ancestor))
        for attribute in ('system.posix_acl_access', 'system.posix_acl_default'):
            try:
                os.getxattr(ancestor, attribute, follow_symlinks=False)
            except OSError as error:
                require(error.errno in (errno.ENODATA, errno.EOPNOTSUPP), 'ancestor ACL query')
            else:
                raise ValueError('unknown ancestor ACL')


def connect(path):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(2)
        channel.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        channel.connect(str(path))


def run(expected_bundle):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'root Linux VM required')
    marker = Path('/run/q2b-b1c-dedicated-vm')
    require(marker.is_file() and not marker.is_symlink() and marker.stat().st_uid == 0 and
            marker.read_text() == 'disposable-q2b-b1c\n', 'dedicated guest marker required')
    require(Path('/proc/1/comm').read_text().strip() == 'systemd', 'real systemd PID1 required')
    container = subprocess.run(['systemd-detect-virt', '--container'], capture_output=True, text=True)
    require(container.returncode == 1 and container.stdout.strip() == 'none', 'container is not a VM proof')
    bundle_bytes = Path('/opt/osv-q2b/b1c/bundle.json').read_bytes()
    require(hashlib.sha256(bundle_bytes).hexdigest() == expected_bundle, 'independent bundle pin')
    bundle = json.loads(bundle_bytes)
    require(bundle['scope'] == 'b1c-vm-diagnostic-only' and bundle['compiled'], 'compiled VM diagnostic profile required')
    for artifact in bundle['files']:
        path = Path(artifact['path'])
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and info.st_nlink == 1,
                'artifact custody: ' + str(path))
        data = path.read_bytes()
        require(len(data) == artifact['size'] and hashlib.sha256(data).hexdigest() == artifact['sha256'], 'artifact bytes')
    for i, role in enumerate(ROLES):
        account = pwd.getpwnam('q2b-' + role)
        require(account.pw_uid == 1101 + i and account.pw_gid == 1201 + i, 'account overlap')
    require(not ROOT.exists() and not ROOT.is_symlink(), 'fresh controller evidence root required')
    # Read-only validation of all existing branches before any fixture mutation.
    for role in (*ROLES, 'evidence'):
        parent = STATE / role
        guard_ancestors(parent)
        if parent.exists() or parent.is_symlink():
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe role parent')
        directory = parent / 'b1c'
        if role != 'provider':
            require(not directory.exists() and not directory.is_symlink(), 'fresh role root required')
    ROOT.parent.mkdir(mode=0o755, exist_ok=True)
    ROOT.mkdir(mode=0o700)
    (ROOT / 'controller-canary').write_bytes(os.urandom(32))
    os.chmod(ROOT / 'controller-canary', 0o600)
    # Additional fixture canaries, not real authority material or keys.
    canaries = {}
    before = {}
    for i, role in enumerate(ROLES):
        directory = STATE / role / 'b1c'
        if role != 'provider':
            directory.parent.mkdir(mode=0o755, exist_ok=True)
            require(not directory.exists() and not directory.is_symlink(), 'fresh private fixture root required')
            directory.mkdir(mode=0o700)
            os.chown(directory, 1101 + i, 1201 + i)
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 1101 + i and info.st_gid == 1201 + i and
                stat.S_IMODE(info.st_mode) == 0o700, 'fixture root custody')
        file = directory / 'canary'
        with file.open('xb') as stream:
            stream.write(os.urandom(32))
        os.chmod(file, 0o600)
        os.chown(file, 1101 + i, 1201 + i)
        canaries[role] = file
        before[role] = hashlib.sha256(file.read_bytes()).hexdigest()
    service = subprocess.run(['systemctl', 'show', 'osv-q2b-b1c.service', '-p', 'MainPID', '--value'],
                             capture_output=True, text=True, check=True)
    pid = int(service.stdout.strip())
    require(pid > 1, 'live service PID required')
    provider = status(pid)
    require(provider['uid'] == [1101] * 4 and provider['gid'] == [1201] * 4 and not provider['groups'] and
            all(int(v, 16) == 0 for v in provider['capabilities'].values()) and provider['noNewPrivileges'] and
            provider['tracerPid'] == 0, 'live provider principal')
    require(Path('/proc/' + str(pid) + '/exe').resolve() == IMAGE / 'runtime', 'live runtime executable')
    require(Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\0') ==
            [str(IMAGE / 'runtime').encode(), b'-I', str(IMAGE / 'provider.py').encode(), b''], 'live fixed argv')
    require(sorted(int(x.name) for x in Path('/proc/' + str(pid) + '/fd').iterdir()) == list(range(7)), 'live FD closure')
    fd6 = Path('/proc/' + str(pid) + '/fd/6')
    boot = fd6.read_bytes()
    require(len(boot) == 168, 'bootstrap size')
    values = struct.unpack('<13Q32s32s', boot)
    require(values[:4] == (0x514232424f4f5431, pid, 1101, 1201), 'bootstrap identity')
    require(values[13] == hashlib.sha256((IMAGE / 'runtime').read_bytes()).digest() and
            values[14] == hashlib.sha256((IMAGE / 'provider.py').read_bytes()).digest(), 'bootstrap artifacts')
    import fcntl
    with fd6.open('rb') as descriptor:
        require(fcntl.fcntl(descriptor.fileno(), fcntl.F_GET_SEALS) == 15, 'bootstrap seals')
    cases = []
    def check_case(name, index, operation, allowed):
        result = child_case(index, operation)
        require(result['errno'] == 0 if allowed else result['errno'] in (errno.EACCES, errno.EPERM), name + ' unexpected result')
        cases.append({'case': name, 'allowed': allowed, 'verified': True, **result})
    for i, role in enumerate(ROLES):
        # Same actor and syscall for every protected root, with a successful own-root control.
        for target in ROLES:
            for operation, flags in [('read', os.O_RDONLY), ('write-open', os.O_WRONLY)]:
                check_case(role + '-' + operation + '-' + target, i,
                           lambda p=canaries[target], f=flags: opened(p, f), role == target)
        for operation, action in [
                ('new-sibling', lambda: opened(ENDPOINTS / 'unapproved', os.O_CREAT | os.O_EXCL | os.O_WRONLY)),
                ('unlink-listener', lambda: os.unlink(ENDPOINTS / 'reader.sock')),
                ('chmod-listener', lambda: os.chmod(ENDPOINTS / 'reader.sock', 0o666)),
                ('replace-entry', lambda: opened(IMAGE / 'provider.py', os.O_WRONLY)),
                ('replace-unit', lambda: opened('/etc/systemd/system/osv-q2b-b1c.service', os.O_WRONLY)),
                ('evidence-read', lambda: opened(ROOT / 'controller-canary', os.O_RDONLY)),
                ('provider-proc-fd', lambda: opened('/proc/' + str(pid) + '/fd/6', os.O_RDONLY)),
                ('provider-proc-mem', lambda: opened('/proc/' + str(pid) + '/mem', os.O_RDONLY)),
                ('provider-signal', lambda: os.kill(pid, 0))]:
            if role == 'provider' and operation in ('provider-proc-fd', 'provider-proc-mem'):
                continue  # dumpability can prohibit same-UID access: not an allow control.
            check_case(role + '-' + operation, i, action, role == 'provider' and operation == 'provider-signal')
        for target, owner in [('reader', 'reader'), ('upload', 'build'), ('publish', 'writer')]:
            check_case(role + '-connect-' + target, i, lambda t=target: connect(ENDPOINTS / (t + '.sock')), role == owner)
    unchanged = all(hashlib.sha256(p.read_bytes()).hexdigest() == before[role] for role, p in canaries.items())
    require(unchanged and not (ENDPOINTS / 'unapproved').exists(), 'canary mutation')
    require(status(pid) == provider, 'provider identity changed during controls')
    os.kill(pid, 0)
    journal = subprocess.run(['journalctl', '-u', 'osv-q2b-b1c.service', '-o', 'cat', '--no-pager'],
                             capture_output=True, text=True, check=True).stdout
    observations = [json.loads(line) for line in journal.splitlines() if line.startswith('{')]
    startups = [value for value in observations if value.get('pid') == pid and value.get('accepts') == 0]
    require(len(startups) == 1 and startups[0]['secretReads'] == 0 and startups[0]['bootstrapSeals'] == 15,
            'single startup diagnostic required')
    return {'schema': 'osv-mcp.q2b.b1c.vm-controls.v1', 'scope': 'vm-startup-and-dac-controls-only',
            'bundleDigest': expected_bundle, 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'kernel': os.uname().release, 'pid1': 'systemd',
            'systemd': subprocess.run(['systemctl', '--version'], capture_output=True, text=True, check=True).stdout.splitlines()[0],
            'provider': provider, 'startup': startups[0], 'bootstrapSha256': hashlib.sha256(boot).hexdigest(),
            'cases': cases, 'verifiedCases': len(cases), 'systemdBootVerified': True,
            'nativeIsolationVerified': False, 'backendEligible': False, 'profileApproved': False, 'originalReadsSkipped': 0,
            'notEstablished': ['authenticated transport', 'FD transfer protection', 'signed manager launch and bootstrap digest',
                               'external exec phase trace', 'B1a evidence bridge', 'complete QB01-QB19/QB30-QB32',
                               'coordinated restart and leak drain', 'B2/B3 persistence and pins', 'production adoption']}


if __name__ == '__main__':
    try:
        print(json.dumps(run(sys.argv[1]), sort_keys=True, indent=2))
    except BaseException as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        raise SystemExit(1)
