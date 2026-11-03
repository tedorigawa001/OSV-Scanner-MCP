"""Fixed B1b diagnostic endpoint. No connection accepts, key reads or grants."""
import fcntl
import hashlib
import json
import os
import socket
import stat
import struct
import sys

stdio_valid = False

def require(value, reason):
    if not value:
        raise ValueError(reason)


def inspect():
    global stdio_valid
    require(sys.platform == 'linux' and sys.byteorder == 'little', 'provider_unsupported')
    null, incoming = os.lstat('/dev/null'), os.fstat(0)
    require(stat.S_ISCHR(incoming.st_mode) and incoming.st_rdev == null.st_rdev and
            fcntl.fcntl(0, fcntl.F_GETFL) & (os.O_ACCMODE | os.O_PATH) == os.O_RDONLY, 'stdio_invalid')
    for fd in (1, 2):
        require(stat.S_ISSOCK(os.fstat(fd).st_mode) and fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDONLY, 'stdio_invalid')
        stream = socket.socket(fileno=fd)
        try:
            pid, uid, gid = struct.unpack('3i', stream.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            peer = stream.getpeername()
            require(stream.family == socket.AF_UNIX and stream.type == socket.SOCK_STREAM and uid == gid == 0 and pid > 0 and
                    (peer == '/run/systemd/journal/stdout' or peer in ('', b'') and pid == os.getppid()), 'stdio_invalid')
        finally:
            stream.detach()  # Keep the validated standard stream open.
    stdio_valid = True
    require(sys.argv == ['/opt/osv-q2b/b1b/provider.py'] and sys.flags.isolated == 1, 'arguments')
    require(set(os.environ) == {'LANG', 'LC_ALL', 'CREDENTIALS_DIRECTORY', 'LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES'}, 'environment')
    require(os.environ['CREDENTIALS_DIRECTORY'] == '/run/credentials/osv-q2b-b1b.service', 'credential_directory')
    require(os.environ['LISTEN_PID'] == str(os.getpid()) and os.environ['LISTEN_FDS'] == '3' and
            os.environ['LISTEN_FDNAMES'] == 'reader:upload:publish', 'activation_environment')
    require(os.getresuid() == (1101, 1101, 1101) and os.getresgid() == (1201, 1201, 1201) and not os.getgroups(), 'principal')
    status = dict(line.split(':', 1) for line in open('/proc/self/status').read().splitlines() if ':' in line)
    require(all(int(status[name].strip(), 16) == 0 for name in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')), 'capabilities')
    require(status['NoNewPrivs'].strip() == '1', 'no_new_privileges')
    actual = []
    for name in os.listdir('/proc/self/fd'):
        fd = int(name)
        try:
            os.fstat(fd)
        except OSError:
            continue  # The descriptor used internally by listdir has already closed.
        actual.append(fd)
    require(sorted(actual) == list(range(7)), 'fd_inventory')
    st = os.fstat(6)
    seals = fcntl.fcntl(6, fcntl.F_GET_SEALS)
    require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_size == 168 and
            fcntl.fcntl(6, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY and seals & 15 == 15, 'bootstrap_custody')
    record = struct.unpack('<13Q32s32s', os.pread(6, 168, 0))
    require(record[:4] == (0x514232424f4f5431, os.getpid(), 1101, 1201), 'bootstrap_binding')
    root = os.lstat('/var/lib/osv-q2b/provider/b1b')
    require((root.st_dev, root.st_ino) == record[11:13] and stat.S_ISDIR(root.st_mode) and
            root.st_uid == 1101 and root.st_gid == 1201 and stat.S_IMODE(root.st_mode) == 0o700, 'root_custody')
    listeners = []
    for index, role in enumerate(('reader', 'upload', 'publish')):
        fd = 3 + index
        # socket.socket(fileno=...) takes ownership; keep it alive until this diagnostic exits.
        s = socket.socket(fileno=fd)
        require(s.family == socket.AF_UNIX and s.type == socket.SOCK_STREAM and
                s.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 1 and
                s.getsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED) == 1, 'listener_options')
        path = '/run/osv-q2b/b1b/' + role + '.sock'
        require(s.getsockname() == path, 'listener_path')
        cookie = struct.unpack('=Q', s.getsockopt(socket.SOL_SOCKET, 57, 8))[0]  # Linux SO_COOKIE
        require(cookie == record[4 + index], 'listener_cookie')
        leaf = os.lstat(path)
        require(stat.S_ISSOCK(leaf.st_mode) and leaf.st_uid == 0 and leaf.st_gid == 1202 + index and
                stat.S_IMODE(leaf.st_mode) == 0o660 and leaf.st_nlink == 1, 'listener_owner')
        os.set_inheritable(fd, False)
        listeners.append((s, {'role': role, 'fd': fd, 'cookie': str(cookie), 'ownerUid': leaf.st_uid,
                              'ownerGid': leaf.st_gid, 'passCredentials': True}))
    os.set_inheritable(6, False)
    for path, expected in [('/opt/osv-q2b/b1b/runtime', record[13]), ('/opt/osv-q2b/b1b/provider.py', record[14])]:
        require(hashlib.sha256(open(path, 'rb').read()).digest() == expected, 'artifact_digest')
    return {'schema': 'osv-mcp.q2b.b1b.startup-observation.v1', 'scope': 'diagnostic-startup-only', 'pid': os.getpid(),
            'uid': list(os.getresuid()), 'gid': list(os.getresgid()), 'groups': os.getgroups(),
            'socketGeneration': ''.join(f'{v:016x}' for v in record[7:11]),
            'listeners': [item for _, item in listeners], 'bootstrapSeals': seals, 'bootstrapReadOnly': True,
            'noNewPrivileges': True, 'capabilitiesEmpty': True, 'accepts': 0, 'secretReads': 0,
            'nativeIsolationVerified': False, 'backendEligible': False, 'profileApproved': False, 'originalReadsSkipped': 0}


if __name__ == '__main__':
    try:
        print(json.dumps(inspect(), sort_keys=True))
    except (ValueError, OSError, KeyError) as error:
        if stdio_valid:
            print(json.dumps({'stage': 'provider', 'reason': str(error), 'nativeIsolationVerified': False}), file=sys.stderr)
        raise SystemExit(78)
