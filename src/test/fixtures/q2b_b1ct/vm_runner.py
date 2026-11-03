"""Reuse the pinned fresh-VM lifecycle, with separate credentials and native evidence."""
import argparse
import base64
import hashlib
import json
import runpy
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = HERE.parent / 'q2b_b1c/vm_runner.py'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def sources():
    paths = [p for directory in ('q2b', 'q2b_b1c', 'q2b_b1ct') for p in (HERE.parent / directory).iterdir()
             if p.is_file() and p.suffix in ('.py', '.c', '.h')]
    return [{'path': str(p.relative_to(HERE.parent)), 'sha256': sha(p.read_bytes())} for p in sorted(paths)]


def run(image, work):
    base = runpy.run_path(str(BASE)); function = base['run']; globals_ = function.__globals__
    original_command = base['command']; receipt = sources()
    def command(arguments, **options):
        args = [str(a) for a in arguments]
        if args[0] == 'scp' and any(a.endswith('/guest_probe.py') for a in args):
            bundle = next(Path(a) for a in args if a.endswith('/q2b-b1c-bundle.tar'))
            args.insert(len(args) - 1, str(bundle.parent / 'bundle/credentials.tar'))
        if '/tmp/guest_deploy.py' in args:
            args.append(sha((work / 'bundle/credentials.tar').read_bytes()))
        try:
            result = original_command(args, **options)
        except subprocess.CalledProcessError as error:
            if '/tmp/guest_probe.py' in args or '/tmp/guest_deploy.py' in args:
                (work / 'guest-error.stderr').write_bytes((error.stderr or b'')[-16384:])
                raise ValueError('fixed guest step failed: ' + (error.stderr or b'')[-8192:].decode(errors='replace')) from error
            raise
        if '/tmp/guest_deploy.py' in args:
            public = json.loads(result.stdout)
            (work / 'manifest-public.pin').write_text(public['manifestDigest'] + '\n')
        return result
    def envelope(body):
        unsigned = {'schema': 'osv-mcp.q2b.evidence.v1', 'role': 'controller', 'keyId': 'controller-native', 'body': body}
        (work / 'sign-input').write_bytes(canonical(unsigned))
        original_command(['openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', work / 'controller-key', '-in', work / 'sign-input', '-out', work / 'sign-output'])
        return base64.b64encode(canonical({**unsigned, 'signature': base64.b64encode((work / 'sign-output').read_bytes()).decode()})).decode()
    def signed_record(_, observation, environment):
        if sources() != receipt:
            raise ValueError('source changed during VM execution')
        environment = {**environment, 'managerKeyProvisioned': True, 'profile': 'b1ct-native-diagnostic-only'}
        public = original_command(['openssl', 'pkey', '-in', work / 'controller-key', '-pubout', '-outform', 'DER']).stdout
        manager = (work / 'bundle/rootfs/opt/osv-q2b/b1ct/manager.pub').read_bytes()
        diagnostics = []
        for boot in observation['boots']:
            body = {'schema': 'osv-mcp.q2b.native-launch-diagnostic.v1', 'mode': 'native-observed',
                    'runId': observation['runId'], 'caseId': boot['caseId'], 'manifestDigest': observation['manifestDigest'],
                    'launchDigest': sha(base64.b64decode(boot['launch'])), 'phases': boot['phases'], 'execs': boot['execs'],
                    'artifacts': observation['artifacts'], 'scope': 'launch-binding-only'}
            diagnostics.append({'launch': boot['launch'], 'diagnostic': envelope(body)})
        return {'schema': 'osv-mcp.q2b.b1ct.public-record.v1', 'manifest': base64.b64encode(canonical(observation['manifest'])).decode(),
                'managerPublicKeyDer': base64.b64encode(manager).decode(), 'controllerPublicKeyDer': base64.b64encode(public).decode(),
                'launches': diagnostics, 'transportEvidence': envelope({'schema': 'osv-mcp.q2b.native-transport-run.v1',
                    'observation': observation, 'environment': environment, 'sources': receipt})}
    globals_.update(HERE=HERE, command=command, signed_record=signed_record)
    return function(image, work)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--image', required=True); parser.add_argument('--work', required=True)
    arguments = parser.parse_args(); print(run(Path(arguments.image), Path(arguments.work).resolve()))
