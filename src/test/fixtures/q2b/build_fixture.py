"""Offline B1b bundle builder. Never installs units, creates accounts or starts services."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
IMAGE = '/opt/osv-q2b/b1b'
ROLES = ('reader', 'upload', 'publish')
DANGEROUS = 'NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG ENV BASH_ENV PATH HOME SHELL USER LOGNAME'


def build(destination, compile_binary=False):
    out = Path(destination)
    out.mkdir(parents=True, exist_ok=True)
    if out.is_symlink() or any(out.iterdir()):
        raise ValueError('output must be a new empty directory')
    if compile_binary and sys.platform != 'linux':
        raise ValueError('Linux is required for the static launcher build')
    root = out / 'rootfs'

    def put(name, text, mode=0o644):
        p = root / name.lstrip('/')
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        p.chmod(mode)

    runtime = Path(sys.executable).resolve()
    runtime_hash = hashlib.sha256(runtime.read_bytes()).hexdigest()
    entry_hash = hashlib.sha256((HERE / 'provider.py').read_bytes()).hexdigest()
    put(IMAGE + '/provider.py', (HERE / 'provider.py').read_text())
    put(IMAGE + '/launcher.c', (HERE / 'launcher.c').read_text())
    put(IMAGE + '/policy.h', '\n'.join([
        '#define IMAGE "' + IMAGE + '"',
        '#define RUNTIME_HASH "' + runtime_hash + '"',
        '#define ENTRY_HASH "' + entry_hash + '"',
        '#define PROVIDER_UID 1101', '#define PROVIDER_GID 1201',
    ]) + '\n')
    sockets = ' '.join('osv-q2b-' + r + '.socket' for r in ROLES)
    service = f'''[Unit]
Description=Q2B B1b diagnostic only (no grants)
PartOf=osv-q2b-b1b.target
Requires={sockets}
After={sockets}

[Service]
Type=oneshot
RemainAfterExit=yes
User=root
Group=root
SupplementaryGroups=
SetLoginEnvironment=no
ExecStart={IMAGE}/launcher --profile b1b --instance b1b
WorkingDirectory={IMAGE}
Environment=LANG=C LC_ALL=C CREDENTIALS_DIRECTORY=/run/credentials/osv-q2b-b1b.service
UnsetEnvironment={DANGEROUS}
StandardInput=null
StandardOutput=journal
StandardError=journal
NoNewPrivileges=yes
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP
AmbientCapabilities=
ProtectSystem=strict
ReadWritePaths=/var/lib/osv-q2b/provider/b1b
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX
RestrictSUIDSGID=yes
LimitCORE=0
UMask=0077
KillMode=control-group
Restart=no
FileDescriptorStoreMax=0
'''
    put('/etc/systemd/system/osv-q2b-b1b.service', service)
    for role, gid in zip(ROLES, (1202, 1203, 1204)):
        put('/etc/systemd/system/osv-q2b-' + role + '.socket', f'''[Unit]
Description=Q2B manager-owned {role} listener
PartOf=osv-q2b-b1b.target

[Socket]
ExecStartPre={IMAGE}/launcher --prepare {role}
StandardInput=null
StandardOutput=journal
StandardError=journal
Environment=LANG=C LC_ALL=C
UnsetEnvironment={DANGEROUS}
NoNewPrivileges=yes
CapabilityBoundingSet=
ListenStream=/run/osv-q2b/b1b/{role}.sock
Service=osv-q2b-b1b.service
FileDescriptorName={role}
Accept=no
PassCredentials=yes
SocketUser=root
SocketGroup={gid}
SocketMode=0660
DirectoryMode=0755
RemoveOnStop=no
''')
    put('/etc/systemd/system/osv-q2b-b1b.target', f'''[Unit]
Description=Q2B B1b diagnostic fixture
Requires={sockets} osv-q2b-b1b.service
After={sockets}
''')
    accounts = []
    for i, role in enumerate(('provider', 'reader', 'build', 'writer', 'checkpoint', 'registry')):
        accounts += [f'g q2b-{role} {1201+i}', f'u q2b-{role} {1101+i}:{1201+i} "Q2B fixture" /nonexistent /usr/sbin/nologin']
    put('/usr/lib/sysusers.d/osv-q2b-b1b.conf', '\n'.join(accounts) + '\n')
    put('/usr/lib/tmpfiles.d/osv-q2b-b1b.conf', '''d /run/osv-q2b 0755 root root -
d /run/osv-q2b/b1b 0755 root root -
d /var/lib/osv-q2b 0755 root root -
d /var/lib/osv-q2b/provider 0755 root root -
d /var/lib/osv-q2b/provider/b1b 0700 1101 1201 -
''')
    if compile_binary:
        image = root / IMAGE.lstrip('/')
        shutil.copyfile(runtime, image / 'runtime')
        (image / 'runtime').chmod(0o755)
        subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-static', '-I', str(image),
                        str(image / 'launcher.c'), '-o', str(image / 'launcher')], check=True)
        (image / 'launcher').chmod(0o755)
    files = [{'path':'/' + str(p.relative_to(root)), 'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),
              'size':p.stat().st_size, 'mode':p.stat().st_mode & 0o777} for p in sorted(root.rglob('*')) if p.is_file()]
    bundle = {'schema':'osv-mcp.q2b.b1b.bundle.v1','scope':'diagnostic-startup-only','compiled':compile_binary,
              'runtimeSource':str(runtime),'runtimeSha256':runtime_hash,'files':files,
              'nativeIsolationVerified':False,'backendEligible':False,'profileApproved':False,
              'requirements':['dedicated disposable systemd>=255 Linux VM','root-owned complete rootfs ancestors',
                              'matching trusted Python base image/stdlib/shared libraries','coordinated service/socket teardown before restart'],
              'unimplemented':['B1c authenticated reader transport and independent signed controller evidence','B2/B3 sealing, fencing and pins']}
    (out / 'bundle.json').write_text(json.dumps(bundle, indent=2, sort_keys=True)+'\n')
    return bundle


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('destination')
    parser.add_argument('--compile',action='store_true')
    args=parser.parse_args()
    build(args.destination,args.compile)
