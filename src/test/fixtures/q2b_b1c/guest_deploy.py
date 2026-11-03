"""Fixed diagnostic fixture installer; refuses containers and existing deployments.

Run only inside the disposable guest made by vm_runner.py. The outside controller
pins the archive before this script receives root authority. No arbitrary paths,
commands, account IDs, unit names, overwrite or recursive cleanup are accepted.
"""
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

IMAGE = '/opt/osv-q2b/b1c'
UNITS = ['osv-q2b-b1c.' + suffix for suffix in ('service', 'target')] + [
    'osv-q2b-b1c-' + role + '.socket' for role in ('reader', 'upload', 'publish')]
EXPECTED = {IMAGE + '/' + name for name in ('launcher', 'launcher.c', 'runtime', 'provider.py', 'policy.h')}
EXPECTED |= {'/etc/systemd/system/' + name for name in UNITS}
EXPECTED |= {'/usr/lib/' + category + '/osv-q2b-b1c.conf' for category in ('sysusers.d', 'tmpfiles.d')}


def need(value, reason):
    if not value:
        raise ValueError(reason)


def main(pin):
    need(os.geteuid() == 0 and sys.platform == 'linux', 'root Linux required')
    marker = Path('/run/q2b-b1c-dedicated-vm')
    need(marker.is_file() and not marker.is_symlink() and marker.stat().st_uid == 0 and
         marker.read_text() == 'disposable-q2b-b1c\n', 'dedicated guest marker required')
    need(Path('/proc/1/comm').read_text().strip() == 'systemd', 'systemd PID1 required')
    detect = subprocess.run(['systemd-detect-virt', '--container'], capture_output=True, text=True)
    need(detect.returncode == 1 and detect.stdout.strip() == 'none', 'container refused')
    archive = Path('/tmp/q2b-b1c-bundle.tar')
    info = archive.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= 32 * 1024 * 1024, 'archive kind/budget')
    raw = archive.read_bytes()
    need(hashlib.sha256(raw).hexdigest() == pin, 'independent archive pin')
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        members = tar.getmembers()
        need(len(members) <= 32 and all(m.isfile() and m.size <= 8 * 1024 * 1024 for m in members), 'archive closure')
        names = [m.name for m in members]
        need(len(set(names)) == len(names) and set(names) == {p.lstrip('/') for p in EXPECTED} | {'bundle.json'}, 'fixed archive paths')
        files = {m.name: tar.extractfile(m).read() for m in members}
    bundle = json.loads(files['bundle.json'])
    need(bundle['scope'] == 'b1c-vm-diagnostic-only' and bundle['compiled'], 'diagnostic bundle scope')
    need(len(bundle['files']) == len(EXPECTED) and {f['path'] for f in bundle['files']} == EXPECTED, 'bundle closure')
    for artifact in bundle['files']:
        data = files[artifact['path'].lstrip('/')]
        need(len(data) == artifact['size'] and hashlib.sha256(data).hexdigest() == artifact['sha256'] and
             artifact['mode'] in (0o644, 0o755), 'artifact digest/mode')
    # Validate every existing ancestor before any mutation. Never repair its mode.
    targets = {Path(p) for p in EXPECTED} | {Path(IMAGE + '/bundle.json')}
    for target in targets:
        need(not target.exists() and not target.is_symlink(), 'existing target refused: ' + str(target))
        for parent in target.parents:
            if parent.exists() or parent.is_symlink():
                st = parent.lstat()
                need(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022 and
                     not any(x.startswith('system.posix_acl') for x in os.listxattr(parent, follow_symlinks=False)), 'unsafe ancestor')
    for artifact in bundle['files']:
        path = Path(artifact['path'])
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        with path.open('xb') as output:
            output.write(files[str(path).lstrip('/')])
        path.chmod(artifact['mode'])
    with Path(IMAGE + '/bundle.json').open('xb') as output:
        output.write(files['bundle.json'])
    for command in (
            ['systemd-sysusers', '/usr/lib/sysusers.d/osv-q2b-b1c.conf'],
            ['systemd-tmpfiles', '--create', '/usr/lib/tmpfiles.d/osv-q2b-b1c.conf'],
            ['systemctl', 'daemon-reload'],
            ['systemd-analyze', 'verify', *['/etc/systemd/system/' + name for name in UNITS]],
            ['systemctl', 'start', 'osv-q2b-b1c.target']):
        subprocess.run(command, check=True, timeout=60)
    print(json.dumps({'installedBundleDigest': hashlib.sha256(files['bundle.json']).hexdigest(), 'units': UNITS}))


if __name__ == '__main__':
    main(sys.argv[1])
