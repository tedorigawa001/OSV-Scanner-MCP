"""Independent native-transport diagnostic variant. Secrets stay outside rootfs."""
import argparse
import base64
import hashlib
import json
import os
import re
import runpy
import shutil
import subprocess
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
IMAGE = '/opt/osv-q2b/b1ct'


def replace(text, old, new):
    if text.count(old) != 1:
        raise ValueError('parent source anchor changed: ' + old)
    return text.replace(old, new)


def sha(bytes_):
    return hashlib.sha256(bytes_).hexdigest()


def keys(directory, name):
    pem = directory / (name + '.pem')
    subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(pem)], check=True, capture_output=True)
    pem.chmod(0o600)
    private = subprocess.check_output(['openssl', 'pkey', '-in', str(pem), '-outform', 'DER'])
    public = subprocess.check_output(['openssl', 'pkey', '-in', str(pem), '-pubout', '-outform', 'DER'])
    if private[:16].hex() != '302e020100300506032b657004220420' or len(private) != 48 or len(public) != 44:
        raise ValueError('unsupported Ed25519 encoding')
    raw = directory / (name + '.key'); raw.write_bytes(private[-32:]); raw.chmod(0o600)
    return public


def build(destination, runtime=None, compile_binary=False):
    base = runpy.run_path(str(HERE.parent / 'q2b_b1c/build_fixture.py'))
    base['build'](destination, runtime, False)
    out = Path(destination); root = out / 'rootfs'; old = root / 'opt/osv-q2b/b1c'; image = old.with_name('b1ct'); old.rename(image)
    for path in sorted(root.rglob('*')):
        if not path.is_file():
            continue
        path.write_text(re.sub(r'(?<![A-Za-z0-9])b1c(?![A-Za-z0-9])', 'b1ct', path.read_text()).replace('B1c', 'B1ct'))
        if 'b1c' in path.name and 'b1ct' not in path.name:
            path.rename(path.with_name(path.name.replace('b1c', 'b1ct')))
    for name in ('auth.py', 'manager.h', 'client_probe.py'):
        source = HERE / name
        if not source.is_file():
            raise ValueError('missing transport source: ' + name)
        (image / name).write_bytes(source.read_bytes())
    provider = (image / 'provider.py').read_text().split("if __name__ == '__main__':", 1)[0]
    provider = provider.replace('st.st_size == 168', 'st.st_size == 232').replace("'<13Q32s32s', os.pread(6, 168, 0)", "'<13Q32s32s32s32s', os.pread(6, 232, 0)")
    provider += '\n' + (HERE / 'provider_tail.py').read_text()
    (image / 'provider.py').write_text(provider)
    launcher = (image / 'launcher.c').read_text()
    launcher = replace(launcher, '#include "policy.h"', '#include "policy.h"\n#include <signal.h>')
    launcher = replace(launcher, 'unsigned char runtime[32],entry[32];};', 'unsigned char runtime[32],entry[32],manifest[32],launch[32];};')
    launcher = replace(launcher, '_Static_assert(sizeof(struct bootstrap)==168,"bootstrap layout");', '_Static_assert(sizeof(struct bootstrap)==232,"bootstrap layout");\n#include "manager.h"')
    launcher = replace(launcher, '  int memory=(int)syscall(', '  unsigned char extra[32];pinned_file(IMAGE "/auth.py",AUTH_HASH,extra);pinned_file(IMAGE "/auth-pins.json",PINS_HASH,extra);native_sign(&boot);\n  int memory=(int)syscall(')
    launcher = replace(launcher, '  for(int i=0;i<64;i++){int b=prctl(', '  raise(SIGSTOP);\n  for(int i=0;i<64;i++){int b=prctl(')
    launcher = replace(launcher, ' execve(fixed[0],fixed,environ);', ' raise(SIGSTOP);execve(fixed[0],fixed,environ);')
    (image / 'launcher.c').write_text(launcher)
    service = root / 'etc/systemd/system/osv-q2b-b1ct.service'
    service.write_text(replace(service.read_text(), 'ReadWritePaths=/var/lib/osv-q2b/provider/b1ct',
                               'ReadWritePaths=/var/lib/osv-q2b/provider/b1ct /run/osv-q2b/b1ct'))
    mirrors = image / 'units'; mirrors.mkdir()
    for unit in sorted((root / 'etc/systemd/system').iterdir()):
        shutil.copyfile(unit, mirrors / unit.name)
    run_id = os.urandom(24).hex()
    public = {name: bytes(44) for name in ('manager', 'provider', 'reader', 'upload', 'publish')}
    if compile_binary:
        secret = out / 'secrets'; secret.mkdir(mode=0o700)
        public = {name: keys(secret, name) for name in public}
        with tarfile.open(out / 'credentials.tar', 'w') as archive:
            for name in public:
                archive.add(secret / (name + '.key'), arcname=name + '.key')
        (out / 'credentials.tar').chmod(0o600)
    (image / 'manager.pub').write_bytes(public['manager'])
    (out / 'manager-public.pin').write_text(sha(public['manager']) + '\n')
    pins = {'schema': 'osv-mcp.q2b.auth-pins.v1', 'runId': run_id,
            'keys': {name: base64.b64encode(value[-32:]).decode() for name, value in public.items()}}
    (image / 'auth-pins.json').write_text(json.dumps(pins, sort_keys=True, separators=(',', ':')))
    policy = (image / 'policy.h').read_text()
    lines = [line for line in policy.splitlines() if not line.startswith('#define ENTRY_HASH')]
    lines += ['#define ENTRY_HASH "' + sha((image / 'provider.py').read_bytes()) + '"',
              '#define AUTH_HASH "' + sha((image / 'auth.py').read_bytes()) + '"',
              '#define PINS_HASH "' + sha((image / 'auth-pins.json').read_bytes()) + '"']
    (image / 'policy.h').write_text('\n'.join(lines) + '\n')
    if compile_binary:
        shutil.copyfile(runtime, image / 'runtime'); (image / 'runtime').chmod(0o755)
        compiled = subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-static', '-I', str(image),
                                   str(image / 'launcher.c'), '-o', str(image / 'launcher'), '-lcrypto', '-ldl', '-pthread'], capture_output=True)
        if compiled.returncode:
            raise ValueError('static build failed: ' + compiled.stderr.decode(errors='replace')[:4096])
        (image / 'launcher').chmod(0o755)
    (image / 'crypto-image.json').write_text(json.dumps({'baseImageSha256': '6e971c7935c62c8ea7796b085e4ea038e2301a067f8c853e154133f8df192c85',
                                                       'scope': 'trusted-base-image-not-approved-runtime-closure'}, sort_keys=True))
    inventory = {'schema': 'osv-mcp.q2b.b1ct.bundle.v1', 'scope': 'native-transport-diagnostic-only', 'compiled': compile_binary,
                 'runId': run_id, 'files': [{'path': '/' + str(p.relative_to(root)), 'sha256': sha(p.read_bytes()),
                                           'size': p.stat().st_size, 'mode': p.stat().st_mode & 0o777}
                                          for p in sorted(root.rglob('*')) if p.is_file()],
                 'nativeIsolationVerified': False, 'backendEligible': False, 'profileApproved': False}
    (out / 'bundle.json').write_text(json.dumps(inventory, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('destination'); parser.add_argument('--runtime'); parser.add_argument('--compile', action='store_true')
    args = parser.parse_args(); build(args.destination, args.runtime, args.compile)
