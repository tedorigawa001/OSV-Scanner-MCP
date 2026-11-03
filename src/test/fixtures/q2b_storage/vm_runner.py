"""Fresh systemd VM runner; public signed evidence only, no host service mutation."""
import argparse
import base64
import hashlib
import json
import runpy
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
def sha(raw): return hashlib.sha256(raw).hexdigest()


def sources():
    paths = [p for directory in ('q2b', 'q2b_b1c', 'q2b_b1ct', 'q2b_storage') for p in (HERE.parent / directory).iterdir() if p.is_file() and p.suffix in ('.py', '.c', '.h')]
    return [{'path': str(p.relative_to(HERE.parent)), 'sha256': sha(p.read_bytes())} for p in sorted(paths)]


def run(image, work):
    base = runpy.run_path(str(HERE.parent / 'q2b_b1c/vm_runner.py')); function = base['run']; original = base['command']; receipt = sources()
    def command(arguments, **options):
        args = [str(a) for a in arguments]
        if args[0] == 'scp' and any(a.endswith('/guest_probe.py') for a in args):
            for name in ('deploy', 'probe'):
                (work / ('storage-base-' + name + '.py')).write_bytes((HERE.parent / ('q2b_b1ct/guest_' + name + '.py')).read_bytes())
            args[-1:-1] = [str(work / 'bundle/credentials.tar'), str(work / 'storage-base-deploy.py'), str(work / 'storage-base-probe.py')]
        if '/tmp/guest_deploy.py' in args: args.append(sha((work / 'bundle/credentials.tar').read_bytes()))
        if '/tmp/guest_probe.py' in args: options['timeout'] = 1800
        try: result = original(args, **options)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            if '/tmp/guest_probe.py' not in args and '/tmp/guest_deploy.py' not in args: raise
            (work / 'guest-error.stderr').write_bytes((error.stderr or b'')[-32768:])
            raise ValueError('fixed VM step failed: ' + (error.stderr or b'')[-8192:].decode(errors='replace')) from error
        if '/tmp/guest_deploy.py' in args:
            (work / 'manifest-public.pin').write_text(json.loads(result.stdout)['manifestDigest'] + '\n')
        return result
    def envelope(body):
        unsigned = {'schema': 'osv-mcp.q2b.evidence.v1', 'role': 'controller', 'keyId': 'controller-native', 'body': body}
        (work / 'sign-input').write_bytes(canonical(unsigned)); original(['openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', work / 'controller-key', '-in', work / 'sign-input', '-out', work / 'sign-output'])
        return base64.b64encode(canonical({**unsigned, 'signature': base64.b64encode((work / 'sign-output').read_bytes()).decode()})).decode()
    def signed_record(_, observation, environment):
        if sources() != receipt: raise ValueError('source drift during native run')
        environment = {**environment, 'managerKeyProvisioned': True, 'profile': 'single-seal-native-storage-diagnostic-only'}
        public = original(['openssl', 'pkey', '-in', work / 'controller-key', '-pubout', '-outform', 'DER']).stdout
        manager = (work / 'bundle/rootfs/opt/osv-q2b/b1ct/manager.pub').read_bytes()
        pins = json.loads((work / 'bundle/rootfs/opt/osv-q2b/b1ct/auth-pins.json').read_bytes())
        launches = []
        for boot in observation['boots']:
            diagnostic = {'schema': 'osv-mcp.q2b.native-launch-diagnostic.v1', 'mode': 'native-observed', 'runId': observation['runId'], 'caseId': boot['caseId'],
                          'manifestDigest': observation['manifestDigest'], 'launchDigest': sha(base64.b64decode(boot['launch'])), 'phases': boot['phases'], 'execs': boot['execs'],
                          'artifacts': observation['artifacts'], 'scope': 'launch-binding-only'}
            launches.append({'launch': boot['launch'], 'diagnostic': envelope(diagnostic)})
        return {'schema': 'osv-mcp.q2b.storage.public-record.v1', 'managerPublicKeyDer': base64.b64encode(manager).decode(),
                'controllerPublicKeyDer': base64.b64encode(public).decode(), 'authPins': pins, 'launches': launches,
                'evidence': envelope({'schema': 'osv-mcp.q2b.storage.controller-run.v1', 'observation': observation, 'environment': environment, 'sources': receipt})}
    function.__globals__.update(HERE=HERE, command=command, signed_record=signed_record)
    result = function(image, work)
    (work / 'public-bindings.json').write_text(json.dumps({'managerKeyDigest': (work / 'bundle/manager-public.pin').read_text().strip(),
        'controllerKeyDigest': (work / 'controller-public.pin').read_text().strip(), 'manifestDigest': (work / 'manifest-public.pin').read_text().strip(),
        'runId': json.loads((work / 'bundle/bundle.json').read_text())['runId']}, sort_keys=True, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--image', required=True); parser.add_argument('--work', required=True)
    args = parser.parse_args(); print(run(Path(args.image), Path(args.work).resolve()))
