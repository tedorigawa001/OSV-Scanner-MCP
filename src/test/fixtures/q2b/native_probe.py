"""Native B1b startup regression runner. Only inside an explicit disposable Linux fixture."""
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import shutil
import socket
import struct
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
IMAGE = Path('/opt/osv-q2b/b1b')
ENDPOINTS = Path('/run/osv-q2b/b1b')
ROOT = Path('/var/lib/osv-q2b/provider/b1b')
CASES = {
    'honest': None, 'permuted': None,
    'NODE_OPTIONS': 'environment', 'PYTHONPATH': 'environment', 'PYTHONHOME': 'environment',
    'LD_PRELOAD': 'environment', 'LD_LIBRARY_PATH': 'environment', 'PATH': 'environment',
    'wrong-argv': 'arguments', 'wrong-pid': 'activation_environment', 'wrong-count': 'activation_environment',
    'wrong-names': 'listener_names', 'missing-fd': 'missing_fd', 'extra-fd': 'unexpected_fd',
    'no-passcred': 'listener_options', 'wrong-group': 'listener_owner', 'nonlistener': 'listener_kind',
    'duplicate-listener': 'duplicate_listener', 'writable-entry': 'artifact_metadata',
    'symlink-entry': 'artifact_metadata', 'changed-entry': 'artifact_digest', 'changed-runtime': 'artifact_digest',
    'writable-ancestor': 'ancestor_custody', 'wrong-root-mode': 'root_custody', 'wrong-root-owner': 'root_custody',
    'image-acl': 'unexpected_acl', 'socket-acl': 'unexpected_acl',
    'stdin-file': 'stdio_invalid', 'stdout-file': 'stdio_invalid', 'stderr-file': 'stdio_invalid',
    'stdin-null-rw': 'stdio_invalid', 'stdin-pipe': 'stdio_invalid', 'stdout-pipe': 'stdio_invalid', 'stderr-pipe': 'stdio_invalid',
    'stdout-named-peer': 'stdio_invalid', 'stderr-named-peer': 'stdio_invalid',
    'stdout-untrusted-peer': 'stdio_invalid', 'stderr-untrusted-peer': 'stdio_invalid',
}


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def entry_witness(operation):
    # The controller intentionally has no DAC_OVERRIDE. Inspect this private canary as its owner.
    os.seteuid(1101)
    try:
        path = ROOT / 'runtime-entry-witness'
        if operation == 'exists':
            return path.exists()
        if operation == 'remove':
            return path.unlink(missing_ok=True)
        require(operation == 'read', 'unknown witness operation')
        return path.read_text()
    finally:
        os.seteuid(0)


def directory_signature(fd):
    st = os.fstat(fd)
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022 and
            st.st_mode & 0o111 == 0o111, 'untrusted deployment ancestor')
    for attr in ('system.posix_acl_access', 'system.posix_acl_default'):
        try:
            os.getxattr(fd, attr)
        except OSError as e:
            require(e.errno in (errno.ENODATA, errno.EOPNOTSUPP), 'ancestor ACL unavailable')
        else:
            raise RuntimeError('unexpected ancestor ACL')
    return st.st_dev, st.st_ino, st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode)


def root_plan():
    """Read-only validation of all branches before the first mkdir/chmod/chown."""
    targets = (IMAGE, ENDPOINTS, ROOT)
    anchors = {}
    for target in targets:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            prefix = Path('/')
            for index, name in enumerate(target.parts[1:]):
                anchors[prefix] = directory_signature(fd)
                prefix = prefix / name
                final = index == len(target.parts) - 2
                if final:
                    try:
                        os.stat(name, dir_fd=fd, follow_symlinks=False)
                    except FileNotFoundError:
                        pass
                    else:
                        raise RuntimeError('refuse existing deployment, including dangling symlink')
                else:
                    try:
                        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                    except FileNotFoundError:
                        break
                    try:
                        signature = directory_signature(child)
                        if prefix in anchors:
                            require(anchors[prefix] == signature, 'ancestor changed during planning')
                    except BaseException:
                        os.close(child)
                        raise
                    anchors[prefix] = signature
                    os.close(fd)
                    fd = child
        finally:
            os.close(fd)
    needed = set()
    for leaf in (IMAGE.parent, ENDPOINTS, ROOT):
        needed.update(p for p in (leaf, *leaf.parents) if p != Path('/'))
    return anchors, sorted(needed, key=lambda p: (len(p.parts), str(p)))


def prepare_roots():
    anchors, needed = root_plan()
    for target in needed:
        if target in anchors:
            continue  # Existing directories are validated, never chmod'ed into compliance.
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            prefix = Path('/')
            require(directory_signature(fd) == anchors[prefix], 'root changed')
            for name in target.parts[1:-1]:
                prefix = prefix / name
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                try:
                    require(directory_signature(child) == anchors[prefix], 'ancestor changed before creation')
                except BaseException:
                    os.close(child)
                    raise
                os.close(fd)
                fd = child
            os.mkdir(target.name, 0o755, dir_fd=fd)  # EEXIST is a race/failure, never permission to reuse.
            child = os.open(target.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                os.fchmod(child, 0o755)  # Only the directory exclusively created above is adjusted.
                anchors[target] = directory_signature(child)
            finally:
                os.close(child)
        finally:
            os.close(fd)


def path_controls():
    """Controller-injected faults; only operates on project bases proven absent in a fresh fixture."""
    bases = (IMAGE.parent, ENDPOINTS.parent, ROOT.parent.parent)
    require(all(not os.path.lexists(p) for p in bases), 'path controls require fresh project bases')
    require(shutil.rmtree.avoids_symlink_attacks, 'safe fixture cleanup unavailable')
    results = []

    def cleanup():
        for base in bases:
            if os.path.lexists(base):
                if base.is_symlink() or not base.is_dir():
                    base.unlink()
                else:
                    shutil.rmtree(base)  # Only controller-created project bases from this test.

    with tempfile.TemporaryDirectory(prefix='q2b-path-canary-', dir='/root') as temp:
        outside = Path(temp) / 'outside'
        outside.mkdir(mode=0o700)
        marker = outside / 'marker'
        marker.write_bytes(b'unchanged')
        for base in bases:
            for kind in ('symlink', 'dangling', 'regular', 'writable'):
                try:
                    if kind in ('symlink', 'dangling'):
                        base.symlink_to(outside if kind == 'symlink' else outside / 'absent', target_is_directory=True)
                    elif kind == 'regular':
                        base.write_bytes(b'existing-file')
                    else:
                        base.mkdir(mode=0o755)
                        base.chmod(0o777)
                    fd_count = len(os.listdir('/proc/self/fd'))
                    try:
                        prepare_roots()
                    except (RuntimeError, OSError):
                        pass
                    else:
                        raise RuntimeError('unsafe path accepted')
                    require(len(os.listdir('/proc/self/fd')) == fd_count, 'path rejection leaked a directory FD')
                    require(stat.S_IMODE(outside.stat().st_mode) == 0o700 and
                            sorted(p.name for p in outside.iterdir()) == ['marker'] and marker.read_bytes() == b'unchanged', 'outside mutation')
                    require(all(not os.path.lexists(other) for other in bases if other != base), 'another branch written before validation')
                    if kind == 'writable':
                        require(stat.S_IMODE(base.stat().st_mode) == 0o777 and not list(base.iterdir()), 'existing ancestor modified')
                    if kind == 'regular':
                        require(base.read_bytes() == b'existing-file', 'existing file modified')
                    results.append({'case': 'path-' + base.parts[1] + '-' + kind, 'verified': True,
                                    'outcome': 'path-rejected-without-mutation', 'outsideWrites': 0, 'outsideModeChanges': 0})
                finally:
                    cleanup()
        for target in (IMAGE, ENDPOINTS, ROOT):
            try:
                target.parent.mkdir(parents=True, mode=0o755)
                target.symlink_to(outside / 'absent', target_is_directory=True)
                try:
                    prepare_roots()
                except (RuntimeError, OSError):
                    pass
                else:
                    raise RuntimeError('dangling deployment target accepted')
                require(not (outside / 'absent').exists() and marker.read_bytes() == b'unchanged' and
                        stat.S_IMODE(outside.stat().st_mode) == 0o700, 'outside mutation')
                results.append({'case': 'path-final-' + target.parts[1], 'verified': True,
                                'outcome': 'path-rejected-without-mutation', 'outsideWrites': 0, 'outsideModeChanges': 0})
            finally:
                cleanup()
        try:
            IMAGE.parent.mkdir(mode=0o751)
            IMAGE.parent.chmod(0o751)
            prepare_roots()
            require(stat.S_IMODE(IMAGE.parent.stat().st_mode) == 0o751, 'existing ancestor mode was normalized')
            results.append({'case': 'path-existing-mode', 'verified': True, 'outcome': 'existing-parent-mode-preserved'})
        finally:
            cleanup()
    return results


def attempt(case):
    sockets = []
    for i, role in enumerate(('reader', 'upload', 'publish')):
        path = ENDPOINTS / (role + '.sock')
        path.unlink(missing_ok=True)  # Controller owns this disposable fixture; launcher never unlinks.
        s = socket.socket(socket.AF_UNIX)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 0 if case == 'no-passcred' and i == 0 else 1)
        s.bind(str(path))
        os.chmod(path, 0o660)
        os.chown(path, 0, 0 if case == 'wrong-group' and i == 0 else 1202 + i)
        s.listen(4)
        sockets.append(s)
    entry = IMAGE / 'provider.py'
    if case in ('image-acl', 'socket-acl'):
        entries = [(1, 7 if case == 'image-acl' else 6, 0xffffffff), (2, 6, 1103),
                   (4, 5 if case == 'image-acl' else 6, 0xffffffff),
                   (16, 5 if case == 'image-acl' else 6, 0xffffffff), (32, 5 if case == 'image-acl' else 0, 0xffffffff)]
        acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)
        os.setxattr(IMAGE if case == 'image-acl' else ENDPOINTS / 'reader.sock', 'system.posix_acl_access', acl)
    if case == 'writable-entry':
        entry.chmod(0o666)
    elif case == 'symlink-entry':
        entry.rename(IMAGE / 'real-provider.py')
        entry.symlink_to('real-provider.py')
    elif case == 'changed-entry':
        entry.write_text(entry.read_text() + '\n# modified\n')
    elif case == 'changed-runtime':
        with (IMAGE / 'runtime').open('ab') as f:
            f.write(b'changed')
    elif case == 'writable-ancestor':
        IMAGE.chmod(0o777)
    elif case == 'wrong-root-mode':
        ROOT.chmod(0o777)
    elif case == 'wrong-root-owner':
        os.chown(ROOT, 0, 0)
    out_r, out_w = socket.socketpair()
    err_r, err_w = socket.socketpair()
    canary_dir = tempfile.TemporaryDirectory(prefix='q2b-stdio-', dir='/root')
    canary = Path(canary_dir.name) / 'protected'
    canary.write_bytes(b'unchanged-root-only-canary')
    canary.chmod(0o600)
    named = []
    if case.endswith('-named-peer'):
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(Path(canary_dir.name) / 'unexpected.sock'))
        listener.listen(1)
        client = socket.socket(socket.AF_UNIX)
        client.connect(listener.getsockname())
        accepted, _ = listener.accept()
        named = [listener, client, accepted]
    if case.endswith('-untrusted-peer'):
        os.seteuid(1102)
        try:
            untrusted_r, untrusted_w = socket.socketpair()
        finally:
            os.seteuid(0)
        if case.startswith('stdout'):
            out_r.close()
            out_w.close()
            out_r, out_w = untrusted_r, untrusted_w
        else:
            err_r.close()
            err_w.close()
            err_r, err_w = untrusted_r, untrusted_w
    pid = os.fork()
    if pid == 0:
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            # Match the unit's three manager capabilities, not the controller's provisioning privileges.
            for capability in range(64):
                present = libc.prctl(23, capability, 0, 0, 0)  # PR_CAPBSET_READ
                if present >= 0 and capability not in (6, 7, 8):
                    require(libc.prctl(24, capability, 0, 0, 0) == 0, 'controller capability bound')
            class Header(ctypes.Structure):
                _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
            class Caps(ctypes.Structure):
                _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]
            header, caps = Header(0x20080522, 0), (Caps * 2)()
            caps[0].effective = caps[0].permitted = (1 << 6) | (1 << 7) | (1 << 8)
            require(libc.capset(ctypes.byref(header), caps) == 0, 'controller capability set')
            order = [2, 0, 1] if case == 'permuted' else [0, 1, 2]
            copies = [fcntl.fcntl(sockets[i].fileno(), fcntl.F_DUPFD_CLOEXEC, 20) for i in order]
            null = os.open('/dev/null', os.O_RDONLY)
            os.dup2(null, 0)
            os.dup2(out_w.fileno(), 1)
            os.dup2(err_w.fileno(), 2)
            if case in ('stdin-file', 'stdout-file', 'stderr-file'):
                substituted = os.open(canary, os.O_RDWR)
                os.dup2(substituted, ('stdin-file', 'stdout-file', 'stderr-file').index(case))
            elif case == 'stdin-null-rw':
                substituted = os.open('/dev/null', os.O_RDWR)
                os.dup2(substituted, 0)
            elif case.endswith('-pipe'):
                pipe_r, pipe_w = os.pipe()
                os.dup2(pipe_r if case.startswith('stdin') else pipe_w,
                        0 if case.startswith('stdin') else 1 if case.startswith('stdout') else 2)
            elif named:
                os.dup2(named[1].fileno(), 1 if case.startswith('stdout') else 2)
            for i, fd in enumerate(copies):
                os.dup2(fd, 3 + i)
            for name in os.listdir('/proc/self/fd'):
                fd = int(name)
                if fd > 5:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            if case == 'missing-fd':
                os.close(5)
            elif case == 'extra-fd':
                require(os.open('/dev/null', os.O_RDONLY) == 6, 'extra fd placement')
                os.set_inheritable(6, True)
            elif case == 'nonlistener':
                n = os.open('/dev/null', os.O_RDONLY)
                os.dup2(n, 3)
                os.close(n)
            elif case == 'duplicate-listener':
                os.dup2(3, 4)
            env = {'LANG': 'C', 'LC_ALL': 'C', 'CREDENTIALS_DIRECTORY': '/run/credentials/osv-q2b-b1b.service', 'LISTEN_PID': str(os.getpid()), 'LISTEN_FDS': '3',
                   'LISTEN_FDNAMES': ':'.join(('reader', 'upload', 'publish')[i] for i in order)}
            if case in ('NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH'):
                env[case] = '/untrusted/injection'
            if case == 'wrong-pid':
                env['LISTEN_PID'] = '1'
            if case == 'wrong-count':
                env['LISTEN_FDS'] = '4'
            if case == 'wrong-names':
                env['LISTEN_FDNAMES'] = 'publish:upload:reader'
            argv = [str(IMAGE / 'launcher'), '--profile', 'b1b', '--instance', 'b1b']
            if case == 'wrong-argv':
                argv.append('--require=untrusted')
            os.execve(argv[0], argv, env)
        except BaseException as e:
            os.write(2, ('runner-child-error:' + str(e)).encode())
            os._exit(99)
    out_w.close()
    err_w.close()
    # All child output is bounded by the fixed launcher/provider, with an external suite deadline as well.
    _, status = os.waitpid(pid, 0)
    stdout, stderr = out_r.recv(65537), err_r.recv(65537)
    out_r.close()
    err_r.close()
    canary_unchanged = canary.read_bytes() == b'unchanged-root-only-canary'
    canary_dir.cleanup()
    for s in sockets:
        s.close()
    for s in named:
        s.close()
    code = os.waitstatus_to_exitcode(status)
    if CASES[case] == 'stdio_invalid':
        entry_executed = entry_witness('exists')
        require(code == 78 and not stdout and not stderr and canary_unchanged and not entry_executed,
                (case, code, 'unsafe standard FD must be refused without writing any inherited stream'))
        return {'case': case, 'verified': True, 'outcome': 'stdio-rejected-silently', 'protectedCanaryUnchanged': True,
                'runtimeEntrypointExecutions': 0}
    if CASES[case] is None:
        require(code == 0, (case, code, stderr.decode()))
        result = json.loads(stdout)
        require(result['pid'] == pid and result['uid'] == [1101] * 3 and result['gid'] == [1201] * 3, 'actual same-PID exec/identity')
        require(result['bootstrapReadOnly'] and result['bootstrapSeals'] & 15 == 15 and result['capabilitiesEmpty'], 'bootstrap/capability')
        require([x['ownerGid'] for x in result['listeners']] == [1202, 1203, 1204], 'listener GIDs')
        require(not result['nativeIsolationVerified'] and not result['backendEligible'], 'no adoption')
        return {'case': case, 'verified': True, 'outcome': 'startup-observed', 'observation': result}
    require(code == 78 and not stdout, (case, code, stdout.decode(), stderr.decode()))
    result = json.loads(stderr)
    require(result['stage'] == 'manager' and result['reason'] == CASES[case], (case, result))
    return {'case': case, 'verified': True, 'outcome': 'manager-rejected', 'reason': result['reason']}


def main():
    require(sys.platform == 'linux' and os.geteuid() == 0 and os.environ.get('Q2B_DISPOSABLE') == '1', 'explicit disposable Linux root fixture required')
    require(Path('/.dockerenv').exists() or Path('/etc/osv-q2b-disposable-vm').is_file(), 'disposable fixture marker required')
    root_plan()  # Validate even before controller fault setup; no prefix repair or chmod on bad input.
    results = path_controls()
    # CHOWN/FOWNER are used by the controller for fault setup; no privileged container or daemon access.
    prepare_roots()
    with tempfile.TemporaryDirectory(prefix='q2b-build-') as temp:
        bundle = Path(temp) / 'bundle'
        subprocess.run([sys.executable, '-I', str(HERE / 'build_fixture.py'), str(bundle), '--compile'], check=True)
        baseline = bundle / 'rootfs/opt/osv-q2b/b1b'
        elf = subprocess.check_output(['/usr/bin/readelf', '-l', str(baseline / 'launcher')])
        require(b'INTERP' not in elf, 'launcher must be a static ELF before any environment filtering')
        launcher_hash = hashlib.sha256((baseline / 'launcher').read_bytes()).hexdigest()
        runtime_hash = hashlib.sha256((baseline / 'runtime').read_bytes()).hexdigest()
        witness_source = Path(temp) / 'witness-source'
        witness_source.mkdir()
        for source in ('build_fixture.py', 'launcher.c', 'provider.py'):
            shutil.copyfile(HERE / source, witness_source / source)
        prefix = "with open('/var/lib/osv-q2b/provider/b1b/runtime-entry-witness', 'x') as witness:\n    witness.write('entered')\n"
        witness_entry = witness_source / 'provider.py'
        witness_entry.write_text(prefix + witness_entry.read_text())
        witness_bundle = Path(temp) / 'witness-bundle'
        subprocess.run([sys.executable, '-I', str(witness_source / 'build_fixture.py'), str(witness_bundle), '--compile'], check=True)
        witness_baseline = witness_bundle / 'rootfs/opt/osv-q2b/b1b'
        witness_hashes = {name: hashlib.sha256((witness_baseline / name).read_bytes()).hexdigest() for name in ('launcher', 'provider.py')}
        for case in CASES:
            if IMAGE.exists():
                shutil.rmtree(IMAGE)
            shutil.copytree(witness_baseline if CASES[case] == 'stdio_invalid' else baseline, IMAGE)
            IMAGE.chmod(0o755)
            os.chown(ROOT, 1101, 1201)
            ROOT.chmod(0o700)
            entry_witness('remove')
            results.append(attempt(case))
        shutil.rmtree(IMAGE)
        shutil.copytree(witness_baseline, IMAGE)
        entry_witness('remove')
        attempt('honest')
        require(entry_witness('read') == 'entered', 'runtime witness positive control')
        results.append({'case': 'stdio-witness-control', 'verified': True, 'outcome': 'entrypoint-witness-observed',
                        'runtimeEntrypointExecutions': 1})
        for role in ('reader', 'upload', 'publish'):
            endpoint = ENDPOINTS / (role + '.sock')
            endpoint.unlink(missing_ok=True)
            args = [str(IMAGE / 'launcher'), '--prepare', role]
            env = {'LANG': 'C', 'LC_ALL': 'C'}
            def prepare():
                out_parent, out_child = socket.socketpair()
                err_parent, err_child = socket.socketpair()
                try:
                    with open('/dev/null', 'rb') as incoming:
                        result = subprocess.run(args, env=env, stdin=incoming,
                                                stdout=out_child, stderr=err_child, timeout=5)
                    out_child.close()
                    err_child.close()
                    return result.returncode, out_parent.recv(65537), err_parent.recv(65537)
                finally:
                    for stream in (out_parent, out_child, err_parent, err_child):
                        stream.close()
            code, _, error = prepare()
            require(code == 0, error.decode())
            endpoint.write_bytes(b'unknown-existing-leaf')
            code, _, error = prepare()
            require(code == 78 and json.loads(error)['reason'] == 'endpoint_exists' and
                    endpoint.read_bytes() == b'unknown-existing-leaf', 'prepare must not unlink or replace an existing leaf')
            results.append({'case': 'prepare-' + role, 'verified': True, 'outcome': 'absent-accepted-existing-rejected'})
    require(len(results) == len(CASES) + 3 + 16 + 1, 'complete case plan')
    sources = [{'path': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(HERE.glob('*')) if p.is_file()]
    print(json.dumps({'schema': 'osv-mcp.q2b.b1b.native-startup-validation.v1', 'scope': 'container startup mechanics, not VM isolation',
                      'kernel': os.uname().release, 'python': sys.version.split()[0], 'sources': sources, 'cases': results,
                      'launcherSha256': launcher_hash, 'runtimeSha256': runtime_hash, 'launcherStaticElf': True,
                      'stdioWitnessArtifacts': witness_hashes,
                      'verifiedCases': len(results), 'nativeIsolationVerified': False, 'systemdBootVerified': False,
                      'backendEligible': False, 'profileApproved': False, 'originalReadsSkipped': 0}, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
