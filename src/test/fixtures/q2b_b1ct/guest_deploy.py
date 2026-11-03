"""Dedicated-guest-only fixed transport deployment. Private material is never output."""
import base64
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

IMAGE = Path('/opt/osv-q2b/b1ct')
RUN = Path('/run/osv-q2b/b1ct')
STATE = Path('/var/lib/osv-q2b')
UNITS = ['osv-q2b-b1ct.service', 'osv-q2b-b1ct.target'] + ['osv-q2b-b1ct-' + role + '.socket' for role in ('reader', 'upload', 'publish')]


def need(value, reason):
    if not value: raise ValueError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def archive(name, pin, maximum, entries):
    path = Path('/tmp') / name; st = path.lstat()
    need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and 0 < st.st_size <= maximum, 'archive-custody')
    raw = path.read_bytes(); need(sha(raw) == pin, 'archive-pin')
    with tarfile.open(fileobj=io.BytesIO(raw)) as source:
        members = source.getmembers(); need(len(members) <= entries and len({m.name for m in members}) == len(members), 'archive-count')
        need(all(m.isfile() and m.size <= 16 * 1024 * 1024 for m in members), 'archive-kind')
        return {m.name: source.extractfile(m).read() for m in members}


def main(bundle_pin, credential_pin):
    need(sys.platform == 'linux' and os.geteuid() == 0 and Path('/proc/1/comm').read_text().strip() == 'systemd', 'systemd-guest-required')
    marker = Path('/run/q2b-b1c-dedicated-vm'); st = marker.lstat()
    need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and marker.read_text() == 'disposable-q2b-b1c\n', 'dedicated-guest-required')
    detected = subprocess.run(['systemd-detect-virt', '--container'], capture_output=True, text=True)
    need(detected.returncode == 1 and detected.stdout.strip() == 'none', 'container-refused')
    files = archive('q2b-b1c-bundle.tar', bundle_pin, 32 * 1024 * 1024, 32)
    credentials = archive('credentials.tar', credential_pin, 64 * 1024, 5)
    need(set(credentials) == {name + '.key' for name in ('manager', 'provider', 'reader', 'upload', 'publish')} and
         all(len(raw) == 32 for raw in credentials.values()), 'credential-closure')
    bundle = json.loads(files['bundle.json']); need(bundle['scope'] == 'native-transport-diagnostic-only' and bundle['compiled'], 'compiled-scope')
    expected_image = {str(IMAGE / name) for name in ('launcher', 'launcher.c', 'runtime', 'provider.py', 'policy.h', 'auth.py', 'manager.h', 'client_probe.py', 'manager.pub', 'auth-pins.json', 'crypto-image.json')}
    expected_image |= {str(IMAGE / 'units' / name) for name in UNITS}
    expected = expected_image | {'/etc/systemd/system/' + name for name in UNITS} | {'/usr/lib/' + kind + '/osv-q2b-b1ct.conf' for kind in ('sysusers.d', 'tmpfiles.d')}
    need(set(files) == {p.lstrip('/') for p in expected} | {'bundle.json'} and len(bundle['files']) == len(expected) and
         {f['path'] for f in bundle['files']} == expected, 'fixed-path-closure')
    pins = json.loads(files[str(IMAGE / 'auth-pins.json').lstrip('/')])
    for name, raw in credentials.items():
        public = Ed25519PrivateKey.from_private_bytes(raw).public_key().public_bytes_raw()
        need(public == base64.b64decode(pins['keys'][name[:-4]]), 'private-public-binding')
    for item in bundle['files']:
        raw = files[item['path'].lstrip('/')]
        need(len(raw) == item['size'] and sha(raw) == item['sha256'] and item['mode'] in (0o644, 0o755), 'artifact-binding')
        path = Path(item['path']); need(not path.exists() and not path.is_symlink(), 'existing-target')
        for parent in path.parents:
            if parent.exists() or parent.is_symlink():
                info = parent.lstat(); need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and
                    not any(x.startswith('system.posix_acl') for x in os.listxattr(parent, follow_symlinks=False)), 'ancestor-custody')
    need(not STATE.exists() and not Path('/etc/osv-q2b-b1ct').exists() and not Path('/var/lib/osv-q2b-clients').exists(), 'fresh-roots-required')
    for item in bundle['files']:
        path = Path(item['path']); path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        with path.open('xb') as stream: stream.write(files[item['path'].lstrip('/')])
        path.chmod(item['mode'])
    subprocess.run(['systemd-sysusers', '/usr/lib/sysusers.d/osv-q2b-b1ct.conf'], check=True, timeout=30)
    STATE.mkdir(mode=0o755)
    # This B1 diagnostic uses an actual nosuid/nodev/noexec private data mount, not durable storage.
    subprocess.run(['mount', '-t', 'tmpfs', '-o', 'nosuid,nodev,noexec,mode=0755,size=64M', 'tmpfs', str(STATE)], check=True, timeout=30)
    subprocess.run(['systemd-tmpfiles', '--create', '/usr/lib/tmpfiles.d/osv-q2b-b1ct.conf'], check=True, timeout=30)
    roots = []
    for role, uid, gid in [('provider', 1101, 1201), ('checkpoint', 1105, 1205), ('registry', 1106, 1206), ('evidence', 0, 0)]:
        directory = STATE / role / 'b1ct'
        if role != 'provider': directory.mkdir(mode=0o700, parents=True); directory.parent.chmod(0o755); os.chown(directory, uid, gid)
        info = directory.stat()
        roots.append({'role': role, 'path': str(directory), 'ownerUid': uid, 'kind': 'directory', 'mode': 0o700,
                      'ancestorWriters': [0], 'writers': [uid], 'device': str(info.st_dev), 'inode': str(info.st_ino), 'newPrivate': True})
    key_dir = Path('/etc/osv-q2b-b1ct'); key_dir.mkdir(mode=0o700)
    (key_dir / 'manager.key').write_bytes(credentials['manager.key']); (key_dir / 'manager.key').chmod(0o400)
    provider = STATE / 'provider/b1ct/provider.key'; provider.write_bytes(credentials['provider.key']); provider.chmod(0o400); os.chown(provider, 1101, 1201)
    for role, uid, gid in [('reader', 1102, 1202), ('upload', 1103, 1203), ('publish', 1104, 1204)]:
        directory = Path('/var/lib/osv-q2b-clients/b1ct') / role; directory.mkdir(mode=0o700, parents=True)
        directory.parent.chmod(0o755); directory.parent.parent.chmod(0o755); os.chown(directory, uid, gid)
        path = directory / (role + '.key'); path.write_bytes(credentials[role + '.key']); path.chmod(0o400); os.chown(path, uid, gid)
    (RUN / 'fault').write_text('none'); (RUN / 'fault').chmod(0o644)
    role_by_name = {'launcher': 'launcher', 'runtime': 'runtime', 'provider.py': 'entrypoint', 'auth.py': 'crypto',
                   **{str(Path('units') / name): role for name, role in zip(UNITS[:1] + UNITS[2:], ('service-unit', 'reader-unit', 'upload-unit', 'publish-unit'))}}
    artifacts = []
    for item in bundle['files']:
        if item['path'] in expected_image:
            relative = str(Path(item['path']).relative_to(IMAGE))
            artifacts.append({'role': role_by_name.get(relative, 'dependency'), 'path': item['path'], 'sha256': item['sha256'],
                              'byteLength': item['size'], 'ownerUid': 0, 'writers': [0], 'kind': 'regular', 'nlink': 1})
    principals = {role: {'uid': 1101 + i, 'gid': 1201 + i, 'supplementaryGroups': []}
                  for i, role in enumerate(('provider', 'reader', 'build', 'writer', 'checkpoint', 'registry'))}
    platform = {'os': 'linux', 'kernel': os.uname().release, 'distribution': 'Ubuntu 24.04 minimal pinned image',
                'systemd': subprocess.check_output(['systemctl', '--version'], text=True).splitlines()[0],
                'filesystem': 'tmpfs', 'mountOptions': ['rw', 'nosuid', 'nodev', 'noexec'], 'runtimeVersion': sys.version.split()[0]}
    mount = subprocess.check_output(['findmnt', '-n', '-o', 'FSTYPE,OPTIONS', '--target', str(STATE)], text=True).split()
    need(mount[0] == 'tmpfs' and set(platform['mountOptions']) <= set(mount[1].split(',')), 'actual-mount-options')
    endpoints = [{'role': role, 'path': str(RUN / (role + '.sock')), 'unitPath': str(IMAGE / 'units' / ('osv-q2b-b1ct-' + role + '.socket')),
                  'groupGid': 1202 + i, 'ownerUid': 0, 'mode': 0o660, 'directoryWriters': [0], 'accept': False,
                  'passCredentials': True, 'fileDescriptorName': role} for i, role in enumerate(('reader', 'upload', 'publish'))]
    execution = {'launcher': str(IMAGE / 'launcher'), 'runtime': str(IMAGE / 'runtime'), 'entrypoint': str(IMAGE / 'provider.py'),
                 'cwd': str(IMAGE), 'launcherArgv': [str(IMAGE / 'launcher'), '--profile', 'b1ct', '--instance', 'b1ct'],
                 'runtimeArgv': [str(IMAGE / 'runtime'), '-I', str(IMAGE / 'provider.py')],
                 'credentialDirectory': '/run/credentials/osv-q2b-b1ct.service', 'bootstrap': {'mechanism': 'manager-memfd', 'fd': 6, 'sealed': True, 'readOnly': True},
                 'shell': False, 'inheritEnvironment': False, 'dynamicFdStore': False}
    manifest = {'schema': 'osv-mcp.q2b.deployment.v1', 'scope': 'b1c-native-observed', 'profileId': 'b1ct', 'instanceId': 'b1ct', 'imageId': 'b1ct',
                'platform': platform, 'policyDigest': sha(canonical({'artifacts': artifacts, 'principals': principals, 'execution': execution})),
                'managerUid': 0, 'controllerUid': 0, 'principals': principals, 'artifacts': artifacts, 'execution': execution, 'roots': roots,
                'endpoints': endpoints, 'limits': {'frameBytes': 4096, 'connectionMs': 2000, 'pending': 3, 'requests': 2},
                'providerMayBind': False, 'coordinatedRestart': True}
    raw = canonical(manifest); (IMAGE / 'deployment.json').write_bytes(raw); (IMAGE / 'deployment.json').chmod(0o644)
    (IMAGE / 'bundle.json').write_bytes(files['bundle.json']); (IMAGE / 'bundle.json').chmod(0o644)
    context = bytes.fromhex(sha(raw)) + bundle['runId'].encode().ljust(64, b'\0') + b'native-boot-1'.ljust(64, b'\0')
    (key_dir / 'context').write_bytes(context); (key_dir / 'context').chmod(0o400)
    subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=30)
    subprocess.run(['systemd-analyze', 'verify', *['/etc/systemd/system/' + unit for unit in UNITS]], check=True, timeout=30)
    subprocess.run(['systemctl', 'start', 'osv-q2b-b1ct.target'], check=True, timeout=30)
    print(json.dumps({'manifestDigest': sha(raw), 'bundleDigest': sha(files['bundle.json'])}))


if __name__ == '__main__': main(sys.argv[1], sys.argv[2])
