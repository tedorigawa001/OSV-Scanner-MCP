"""Fixed B1ct launcher/auth composition for the separate native storage fixture."""
import argparse
import hashlib
import json
import runpy
from pathlib import Path

HERE = Path(__file__).resolve().parent


def once(text, old, new):
    if text.count(old) != 1: raise ValueError('storage parent anchor changed: ' + old[:100])
    return text.replace(old, new)


def build(destination, runtime=None, compile_binary=False):
    # Compile only after extending the pinned entrypoint. Prior fixture sources remain unchanged.
    base = runpy.run_path(str(HERE.parent / 'q2b_b1ct/build_fixture.py'))
    base['build'](destination, runtime, compile_binary)
    out = Path(destination); image = out / 'rootfs/opt/osv-q2b/b1ct'
    for name in ('storage.py', 'storage_client.py'):
        (image / name).write_bytes((HERE / name).read_bytes())
    auth = image / 'auth.py'
    auth.write_text(once(auth.read_text(), "envelope['schema'] == DOMAIN and envelope['keyId'] == key_id, 'signature-domain')",
                         "envelope['schema'] == DOMAIN and envelope['keyId'] == key_id and isinstance(envelope['body'], dict), 'signature-domain')"))
    provider = (image / 'provider.py').read_text()
    start = provider.index("                        record({'kind': 'operation'")
    end = provider.index("                        previous = reply", start) + len('                        previous = reply')
    provider = provider[:start] + '''                        try:
                            result = store.operate(role, value['operation'], value['argument'])
                            outcome, reason = 'accepted', None
                            record({'kind': 'storage-operation', 'role': role, 'operation': value['operation'], 'requestDigest': auth.digest(request_raw),
                                    'peer': list(peer), 'result': result, 'syncs': dict(store.syncs), 'launchDigest': context['launchDigest']})
                        except Exception as error:
                            outcome, reason, result = 'rejected', str(error)[:128], None
                            record({'kind': 'storage-rejected', 'role': role, 'operation': value['operation'], 'reason': reason,
                                    'peer': list(peer), 'launchDigest': context['launchDigest']})
                        reply = auth.sign({'kind': 'storage-response', 'sessionId': session, 'sequence': sequence,
                            'requestDigest': auth.digest(request_raw), 'operation': value['operation'], 'outcome': outcome,
                            'reason': reason, 'result': result, 'backendEligible': False, 'originalReadsSkipped': 0}, 'provider', private)
                        auth.send(channel, reply, deadline)
''' + provider[end:]
    provider = once(provider, "'operation', 'requestId'}", "'operation', 'requestId', 'argument'}")
    provider = once(provider, "value['operation'] == auth.ROLES[role][2]", "value['operation'] in ('stage', 'seal', 'read-state')")
    provider = once(provider, 'for sequence in (1, 2):', 'for sequence in (1,):')
    provider = once(provider, '    while True:\n        ready, _, _ = select.select', '''    from storage import Store
    def storage_fault():
        return protected(Path('/run/osv-q2b/b1ct/storage-fault'), 0, 0o644, 64).decode().strip()
    try:
        anchor = json.loads(protected(Path('/run/osv-q2b/b1ct/recovery-anchor.json'), 0, 0o644, 1024))
        store = Store(Path('/var/lib/osv-q2b/provider/b1ct/storage'), private, context, anchor, storage_fault)
        record({'kind': 'storage-ready', 'recovered': store.recovered, 'syncs': dict(store.syncs), 'launchDigest': context['launchDigest']})
    except Exception as error:
        record({'kind': 'recovery-rejected', 'reason': str(error)[:128], 'launchDigest': context['launchDigest']})
        raise
    while True:
        ready, _, _ = select.select''')
    (image / 'provider.py').write_text(provider)
    policy = image / 'policy.h'; lines = policy.read_text().splitlines()
    for macro, name in (('ENTRY_HASH', 'provider.py'), ('AUTH_HASH', 'auth.py')):
        lines = [('#define ' + macro + ' "' + hashlib.sha256((image / name).read_bytes()).hexdigest() + '"') if line.startswith('#define ' + macro) else line for line in lines]
    policy.write_text('\n'.join(lines) + '\n')
    if compile_binary:
        import subprocess
        compiled = subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-static', '-I', str(image), str(image / 'launcher.c'), '-o', str(image / 'launcher'), '-lcrypto', '-ldl', '-pthread'], capture_output=True)
        if compiled.returncode: raise ValueError(compiled.stderr.decode()[:4096])
    bundle = json.loads((out / 'bundle.json').read_text()); root = out / 'rootfs'
    bundle['scope'] = 'native-storage-diagnostic-only'
    bundle['files'] = [{'path': '/' + str(p.relative_to(root)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'size': p.stat().st_size, 'mode': p.stat().st_mode & 0o777} for p in sorted(root.rglob('*')) if p.is_file()]
    (out / 'bundle.json').write_text(json.dumps(bundle, sort_keys=True, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('destination'); parser.add_argument('--runtime'); parser.add_argument('--compile', action='store_true')
    args = parser.parse_args(); build(args.destination, args.runtime, args.compile)
