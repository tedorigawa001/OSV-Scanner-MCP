"""Fixed native client cases. Only diagnostic operations; no arbitrary path/command."""
import array
import base64
import json
import os
import socket
import stat
import struct
import sys
import time
from pathlib import Path

IMAGE = Path('/opt/osv-q2b/b1ct')
sys.path.insert(0, str(IMAGE))
import auth
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

CASES = {'honest-reader', 'honest-upload', 'honest-publish', 'wrong-role', 'server-proof', 'response-replay',
         'request-replay', 'proof-replay', 'session-replay', 'unknown-field', 'role-escalation', 'duplicate-key',
         'noncanonical', 'invalid-integer', 'oversized', 'truncated', 'slow-drip', 'ancillary-fd', 'ancillary-many-fds',
         'old-proof', 'old-response'}


def material(role):
    pins = json.loads((IMAGE / 'auth-pins.json').read_bytes())
    raw = (Path('/var/lib/osv-q2b-clients/b1ct') / role / (role + '.key')).read_bytes()
    auth.need(len(raw) == 32, 'client-key-size')
    private = Ed25519PrivateKey.from_private_bytes(raw)
    auth.need(private.public_key().public_bytes_raw() == base64.b64decode(pins['keys'][role]), 'client-key-binding')
    launch_raw = Path('/run/osv-q2b/b1ct/launch.json').read_bytes()
    envelope = json.loads(launch_raw)
    auth.need(auth.canonical(envelope) == launch_raw and envelope['role'] == 'manager' and envelope['keyId'] == 'manager-native' and
              envelope['schema'] == 'osv-mcp.q2b.evidence.v1', 'manager-envelope')
    Ed25519PublicKey.from_public_bytes((IMAGE / 'manager.pub').read_bytes()[-32:]).verify(base64.b64decode(envelope['signature'], validate=True),
        auth.canonical({key: envelope[key] for key in ('schema', 'role', 'keyId', 'body')}))
    body = envelope['body']; manifest_raw = (IMAGE / 'deployment.json').read_bytes(); manifest = json.loads(manifest_raw)
    auth.need(auth.digest(manifest_raw) == body['manifestDigest'] and body['runId'] == pins['runId'], 'manifest-binding')
    context = {'manifestDigest': body['manifestDigest'], 'launchDigest': auth.digest(launch_raw), 'providerBoot': body['providerBoot'],
               'providerPid': body['pid'], 'runId': body['runId'], 'caseId': body['caseId'], 'instanceId': 'b1ct',
               'profileDigest': manifest['policyDigest']}
    return private, Ed25519PublicKey.from_public_bytes(base64.b64decode(pins['keys']['provider'])), context


def channel(role):
    result = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    result.settimeout(auth.DEADLINE); result.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
    try:
        result.connect('/run/osv-q2b/b1ct/' + role + '.sock')
    except BaseException:
        result.close(); raise
    return result


def run(case):
    auth.need(case in CASES, 'unknown-case')
    role = 'upload' if case == 'honest-upload' else 'publish' if case == 'honest-publish' else 'reader'
    auth.need(os.getresuid() == (auth.ROLES[role][0],) * 3 and os.getresgid() == (auth.ROLES[role][1],) * 3 and not os.getgroups(), 'client-principal')
    private, public, context = material(role)
    observed, sent, samples = [], [], {}
    started = time.monotonic(); sock = None
    try:
        sock = channel('upload' if case == 'wrong-role' else role)
        custodian = list(auth.credentials(sock))
        if case == 'old-proof':
            old = auth.decode(Path('/run/osv-q2b/b1ct/old-proof').read_bytes())
            auth.client_auth(sock, context, role, private, public, observed, old, sent)
            raise RuntimeError('old proof accepted')
        session = auth.client_auth(sock, context, role, private, public, observed, sent=sent)
        samples['proof'] = session['proof']
        samples['challenge'] = session['challenge']
        if case in ('proof-replay', 'session-replay'):
            if case == 'session-replay':
                old_request = auth.request(session, 1, auth.ROLES[role][2], private, role)
            old_proof = session['proof']; sock.close(); sock = channel(role)
            session = auth.client_auth(sock, context, role, private, public, observed,
                                       old_proof if case == 'proof-replay' else None, sent)
            if case == 'proof-replay':
                raise RuntimeError('replayed proof accepted')
        signed = auth.request(session, 1, auth.ROLES[role][2], private, role)
        if case == 'session-replay': signed = old_request
        if case == 'unknown-field': signed = auth.sign({**signed['body'], 'path': '/etc/shadow'}, role, private)
        if case == 'role-escalation': signed = auth.sign({**signed['body'], 'operation': 'publish-probe'}, role, private)
        if case == 'invalid-integer': signed = auth.sign({**signed['body'], 'sequence': True}, role, private)
        raw = auth.canonical(signed)
        if case == 'duplicate-key': raw = raw.replace(b'"sequence":1', b'"sequence":1,"sequence":1')
        if case == 'noncanonical': raw += b' '
        frame = struct.pack('!I', len(raw)) + raw
        if case == 'oversized': frame = struct.pack('!I', auth.FRAME_BYTES + 1)
        if case == 'truncated':
            sock.sendall(frame[:8]); sock.shutdown(socket.SHUT_WR)
        elif case in ('ancillary-fd', 'ancillary-many-fds'):
            files = [os.open('/dev/null', os.O_RDONLY) for _ in range(1 if case == 'ancillary-fd' else 32)]
            try:
                sock.sendmsg([frame], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', files))])
            finally:
                for fd in files: os.close(fd)
        elif case == 'slow-drip':
            for byte in frame:
                sock.sendall(bytes([byte])); time.sleep(.25)
        else:
            sock.sendall(frame)
        response, _ = auth.receive(sock, session['deadline'], (context['providerPid'], 1101, 1201), observed)
        auth.response(response, signed, public, session)
        samples.update(request=signed, response=response)
        if case == 'request-replay':
            auth.send(sock, signed, session['deadline'])
        else:
            signed = auth.request(session, 2, auth.ROLES[role][2], private, role)
            auth.send(sock, signed, session['deadline'])
        response, _ = auth.receive(sock, session['deadline'], (context['providerPid'], 1101, 1201), observed)
        auth.response(response, signed, public, session)
        auth.need(case.startswith('honest-'), 'negative-case-accepted')
        return {'outcome': 'accepted', 'custodian': custodian, 'providerCredentials': observed,
                'clientProofFrames': len(sent), 'samples': samples, 'elapsedMs': int((time.monotonic() - started) * 1000)}
    except (ValueError, OSError) as error:
        return {'outcome': 'rejected', 'reason': str(error)[:128], 'providerCredentials': observed,
                'clientProofFrames': len(sent), 'samples': samples, 'elapsedMs': int((time.monotonic() - started) * 1000)}
    finally:
        if sock is not None: sock.close()


if __name__ == '__main__':
    print(json.dumps(run(sys.argv[1]), sort_keys=True))
