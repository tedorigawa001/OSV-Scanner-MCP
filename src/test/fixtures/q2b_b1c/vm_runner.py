"""Reproduce VM startup/DAC controls in a fresh QEMU guest, never on the host.

Run as an unprivileged user in the dedicated Linux tools container. Requires a
previously downloaded, independently pinned Ubuntu image; no downloads here.
SSH keys are new per run and never included in the exported public observation.
This is not an approval-profile issuer or a B1a evidence converter.
"""
import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE_SHA256 = '6e971c7935c62c8ea7796b085e4ea038e2301a067f8c853e154133f8df192c85'


def command(args, **options):
    return subprocess.run([str(x) for x in args], check=True, timeout=options.pop('timeout', 60),
                          capture_output=True, **options)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def signed_record(work, observation, environment):
    # Public pin is exported before signing; key stays outside guest. This signs
    # collection provenance only, not complete B1 evidence or manager approval.
    payload = {'schema': 'osv-mcp.q2b.b1c.controller-observation.v1', 'observation': observation,
               'environment': environment,
               'sources': [{'path': str(p.relative_to(HERE.parent)), 'sha256': digest(p)}
                           for p in sorted([*HERE.glob('*.py'), * (HERE.parent / 'q2b').glob('*.py'),
                                            HERE.parent / 'q2b/launcher.c'])]}
    raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
    (work / 'payload.json').write_bytes(raw)
    command(['openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', work / 'controller-key',
             '-in', work / 'payload.json', '-out', work / 'signature'])
    public = command(['openssl', 'pkey', '-in', work / 'controller-key', '-pubout', '-outform', 'DER']).stdout
    return {'payload': payload, 'publicKeyDer': base64.b64encode(public).decode(),
            'publicKeySha256': hashlib.sha256(public).hexdigest(),
            'signature': base64.b64encode((work / 'signature').read_bytes()).decode()}


def run(image, work):
    if sys.platform != 'linux' or digest(image) != BASE_SHA256:
        raise ValueError('exact independently pinned Linux guest image required')
    if work.exists():
        raise ValueError('work directory must not exist')
    work.mkdir(mode=0o700)
    for name in ('client', 'host'):
        command(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', work / name])
    command(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', work / 'controller-key'])
    os.chmod(work / 'controller-key', 0o600)
    pub = command(['openssl', 'pkey', '-in', work / 'controller-key', '-pubout', '-outform', 'DER']).stdout
    (work / 'controller-public.pin').write_text(hashlib.sha256(pub).hexdigest() + '\n')
    # Work is new, so no existing operator or host credentials are used.
    config = {'users': [{'name': 'q2b-controller', 'sudo': ['ALL=(ALL) NOPASSWD:ALL'],
                         'shell': '/bin/bash', 'ssh_authorized_keys': [(work / 'client.pub').read_text().strip()]}],
              'ssh_keys': {'ed25519_private': (work / 'host').read_text(),
                           'ed25519_public': (work / 'host.pub').read_text().strip()},
              'write_files': [{'path': '/run/q2b-b1c-dedicated-vm', 'owner': 'root:root',
                               'permissions': '0600', 'content': 'disposable-q2b-b1c\n'}],
              'ssh_pwauth': False, 'disable_root': True, 'package_update': False, 'package_upgrade': False}
    (work / 'user-data').write_text('#cloud-config\n' + json.dumps(config))
    (work / 'user-data').chmod(0o600)
    (work / 'meta-data').write_text('instance-id: q2b-b1c-dedicated\nlocal-hostname: q2b-b1c\n')
    (work / 'known_hosts').write_text('[127.0.0.1]:2222 ' + (work / 'host.pub').read_text())
    command(['cloud-localds', work / 'seed.iso', work / 'user-data', work / 'meta-data'])
    command(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', Path(image).resolve(), work / 'guest.qcow2'])
    command(['qemu-img', 'resize', work / 'guest.qcow2', '8G'])
    argv = ['qemu-system-aarch64', '-machine', 'virt,accel=tcg', '-cpu', 'max', '-smp', '2', '-m', '1536',
            '-nographic', '-bios', '/usr/share/qemu-efi-aarch64/QEMU_EFI.fd',
            '-drive', f'file={work}/guest.qcow2,if=virtio,format=qcow2',
            '-drive', f'file={work}/seed.iso,if=virtio,format=raw,readonly=on',
            '-netdev', 'user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22',
            '-device', 'virtio-net-pci,netdev=net0,romfile=']
    common = ['-i', str(work / 'client'), '-o', 'UserKnownHostsFile=' + str(work / 'known_hosts'),
              '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes']
    ssh = ['ssh', *common, '-p', '2222', 'q2b-controller@127.0.0.1']
    scp = ['scp', *common, '-P', '2222']
    with (work / 'serial.log').open('wb') as log:
        vm = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 600
            while True:
                if vm.poll() is not None:
                    raise ValueError('VM exited before readiness')
                try:
                    command([*ssh, 'test -f /run/q2b-b1c-dedicated-vm'], timeout=5)
                    break
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    if time.monotonic() > deadline:
                        raise ValueError('VM boot deadline')
                    time.sleep(2)
            command([*scp, 'q2b-controller@127.0.0.1:/usr/bin/python3.12', work / 'guest-python'])
            command([sys.executable, '-I', HERE / 'build_fixture.py', work / 'bundle',
                     '--runtime', work / 'guest-python', '--compile'])
            with tarfile.open(work / 'q2b-b1c-bundle.tar', 'w') as archive:
                root = work / 'bundle/rootfs'
                for path in sorted(root.rglob('*')):
                    if path.is_file():
                        archive.add(path, arcname=str(path.relative_to(root)))
                archive.add(work / 'bundle/bundle.json', arcname='bundle.json')
            command([*scp, work / 'q2b-b1c-bundle.tar', HERE / 'guest_deploy.py', HERE / 'guest_probe.py',
                     'q2b-controller@127.0.0.1:/tmp/'])
            command([*ssh, 'sudo', 'python3', '-I', '/tmp/guest_deploy.py', digest(work / 'q2b-b1c-bundle.tar')], timeout=120)
            # Wait for runtime preflight, rather than treating Type=simple start as ready.
            command([*ssh, 'sleep 8'], timeout=15)
            raw = command([*ssh, 'sudo', 'python3', '-I', '/tmp/guest_probe.py', digest(work / 'bundle/bundle.json')], timeout=180).stdout
            observation = json.loads(raw)
            environment = {'imageUrl': 'https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-arm64.img',
                           'imageSha256': BASE_SHA256, 'imageBytes': Path(image).stat().st_size,
                           'qemu': command(['qemu-system-aarch64', '--version']).stdout.decode().splitlines()[0],
                           'outerKernel': os.uname().release, 'guestNetwork': 'restricted-user-network-hostfwd-loopback-ssh-only',
                           'hostKeySha256': digest(work / 'host.pub'), 'acceleration': 'tcg', 'managerKeyProvisioned': False}
            record = signed_record(work, observation, environment)
            (work / 'result.json').write_text(json.dumps(record, sort_keys=True, indent=2) + '\n')
            return work / 'result.json'
        finally:
            # Only the QEMU process created here; never enumerate/kill other guests.
            vm.terminate()
            try:
                vm.wait(timeout=10)
            except subprocess.TimeoutExpired:
                vm.kill()
                vm.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--work', required=True)
    arguments = parser.parse_args()
    print(run(Path(arguments.image), Path(arguments.work).resolve()))
