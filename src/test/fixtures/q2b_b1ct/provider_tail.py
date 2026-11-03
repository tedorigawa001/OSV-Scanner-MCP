# Appended to the checked startup inspector. No application data or grants.
import base64
import select
import signal
import time
from pathlib import Path

IMAGE = Path('/opt/osv-q2b/b1ct')
sys.path.insert(0, str(IMAGE))
import auth
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


def protected(path, owner, mode, maximum):
    st = path.lstat()
    auth.need(stat.S_ISREG(st.st_mode) and st.st_uid == owner and st.st_nlink == 1 and
              stat.S_IMODE(st.st_mode) == mode and 0 < st.st_size <= maximum, 'file-custody')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        after = os.fstat(fd)
        auth.need((after.st_dev, after.st_ino, after.st_size) == (st.st_dev, st.st_ino, st.st_size), 'file-exchanged')
        raw = os.read(fd, maximum + 1)
        auth.need(len(raw) == st.st_size, 'file-size')
        return raw
    finally:
        os.close(fd)


def preflight():
    startup = inspect()
    boot = os.pread(6, 232, 0)
    manifest_raw = protected(IMAGE / 'deployment.json', 0, 0o644, 256 * 1024)
    auth.need(auth.digest(manifest_raw) == boot[168:200].hex(), 'manifest-binding')
    manifest = json.loads(manifest_raw)
    auth.need(auth.canonical(manifest) == manifest_raw, 'manifest-canonical')
    total = 0
    for artifact in manifest['artifacts']:
        name = artifact['path']
        auth.need(name.startswith(str(IMAGE) + '/') and '..' not in name.split('/'), 'artifact-path')
        path = Path(name)
        st = path.lstat()
        raw = protected(path, 0, stat.S_IMODE(st.st_mode), 16 * 1024 * 1024)
        auth.need(not st.st_mode & 0o022 and len(raw) == artifact['byteLength'] and auth.digest(raw) == artifact['sha256'], 'artifact-binding')
        total += len(raw); auth.need(total <= 64 * 1024 * 1024, 'artifact-budget')
    launch_raw = protected(Path('/run/osv-q2b/b1ct/launch.json'), 0, 0o644, 16 * 1024)
    auth.need(auth.digest(launch_raw) == boot[200:232].hex(), 'launch-binding')
    envelope = json.loads(launch_raw)
    auth.need(auth.canonical(envelope) == launch_raw and set(envelope) == {'schema', 'role', 'keyId', 'body', 'signature'} and
              envelope['schema'] == 'osv-mcp.q2b.evidence.v1' and envelope['role'] == 'manager' and envelope['keyId'] == 'manager-native', 'manager-envelope')
    manager = protected(IMAGE / 'manager.pub', 0, 0o644, 44)
    Ed25519PublicKey.from_public_bytes(manager[-32:]).verify(base64.b64decode(envelope['signature'], validate=True),
        auth.canonical({key: envelope[key] for key in ('schema', 'role', 'keyId', 'body')}))
    body = envelope['body']
    auth.need(body['manifestDigest'] == boot[168:200].hex() and body['pid'] == os.getpid() and
              body['providerBoot'] == boot[56:88].hex(), 'manager-binding')
    pins = json.loads(protected(IMAGE / 'auth-pins.json', 0, 0o644, 4096))
    auth.need(body['runId'] == pins['runId'], 'run-binding')
    context = {'manifestDigest': body['manifestDigest'], 'launchDigest': auth.digest(launch_raw),
               'providerBoot': body['providerBoot'], 'providerPid': body['pid'], 'runId': body['runId'],
               'caseId': body['caseId'], 'instanceId': 'b1ct', 'profileDigest': manifest['policyDigest']}
    return startup, pins, context


def serve(pins, context):
    private = Ed25519PrivateKey.from_private_bytes(protected(Path('/var/lib/osv-q2b/provider/b1ct/provider.key'), 1101, 0o400, 32))
    auth.need(private.public_key().public_bytes_raw() == base64.b64decode(pins['keys']['provider']), 'provider-key-binding')
    clients = {role: Ed25519PublicKey.from_public_bytes(base64.b64decode(pins['keys'][role])) for role in auth.ROLES}
    channels = {item.fileno(): (item, details['role']) for item, details in retained_listeners}
    events = Path('/var/lib/osv-q2b/provider/b1ct/events.jsonl')
    emitted = 0
    def record(body):
        nonlocal emitted
        emitted += 1; auth.need(emitted <= 256, 'event-budget')
        raw = auth.canonical(body) + b'\n'
        fd = os.open(events, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            st = os.fstat(fd)
            auth.need(st.st_uid == 1101 and stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_size + len(raw) <= 256 * 1024, 'event-custody')
            auth.need(os.write(fd, raw) == len(raw), 'event-write')
        finally:
            os.close(fd)
    while True:
        ready, _, _ = select.select([item for item, _ in channels.values()], [], [], 1)
        for listener in ready:
            role = channels[listener.fileno()][1]
            channel, _ = listener.accept()
            with channel:
                peer = auth.credentials(channel)
                deadline = time.monotonic() + auth.DEADLINE
                try:
                    auth.need(peer[0] > 0 and peer[1:] == auth.ROLES[role][:2], 'client-role')
                    auth.need(channel.getsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED) == 1, 'passcred-disabled')
                    auth.need(not select.select([channel], [], [], 0)[0], 'queued-data')
                    fault = protected(Path('/run/osv-q2b/b1ct/fault'), 0, 0o644, 64).decode().strip()
                    auth.need(fault in ('none', 'server-proof', 'response-replay', 'old-response'), 'fault-policy')
                    body = auth.challenge(context, role, peer)
                    signed = auth.sign(body, 'provider', Ed25519PrivateKey.generate() if fault == 'server-proof' else private)
                    raw = auth.send(channel, signed, deadline)
                    proof, _ = auth.receive(channel, deadline, (None, peer[1], peer[2]))
                    value = auth.verify(proof, role, clients[role])
                    auth.need(type(value.get('sequence')) is int and auth.hex32(value.get('clientNonce')), 'client-proof')
                    wanted = {'kind': 'client-proof', 'challengeDigest': auth.digest(raw), 'serverNonce': body['serverNonce'],
                              'clientNonce': value['clientNonce'], 'role': role, 'providerBoot': context['providerBoot'],
                              'launchDigest': context['launchDigest'], 'sequence': 0}
                    auth.need(value == wanted, 'proof-binding')
                    session = auth.digest(auth.canonical({'context': context, 'role': role, 'peer': list(peer),
                                                          'serverNonce': value['serverNonce'], 'clientNonce': value['clientNonce']}))
                    auth.send(channel, auth.sign({'kind': 'auth-accepted', 'sessionId': session, 'challengeDigest': value['challengeDigest'],
                        'serverNonce': value['serverNonce'], 'clientNonce': value['clientNonce'], 'sequence': 0}, 'provider', private), deadline)
                    previous = None
                    for sequence in (1, 2):
                        request, request_raw = auth.receive(channel, deadline, (None, peer[1], peer[2]))
                        value = auth.verify(request, role, clients[role])
                        auth.need(set(value) == {'kind', 'sessionId', 'sequence', 'operation', 'requestId'} and type(value['sequence']) is int and
                                  value['kind'] == 'request' and value['sessionId'] == session and value['sequence'] == sequence and
                                  auth.hex32(value['requestId']) and value['operation'] == auth.ROLES[role][2], 'request-binding')
                        record({'kind': 'operation', 'peer': list(peer), 'role': role, 'sequence': sequence,
                                'requestDigest': auth.digest(request_raw), 'launchDigest': context['launchDigest']})
                        reply = auth.sign({'kind': 'response', 'sessionId': session, 'sequence': sequence,
                            'requestDigest': auth.digest(request_raw), 'operation': value['operation'], 'outcome': 'diagnostic-only',
                            'backendEligible': False, 'originalReadsSkipped': 0}, 'provider', private)
                        if fault == 'old-response':
                            reply = auth.decode(protected(Path('/run/osv-q2b/b1ct/old-response'), 0, 0o644, 4096))
                        auth.send(channel, previous if fault == 'response-replay' and previous else reply, deadline)
                        previous = reply
                except (ValueError, OSError, KeyError) as error:
                    record({'kind': 'rejected', 'peer': list(peer), 'role': role, 'reason': str(error)[:128], 'launchDigest': context['launchDigest']})


if __name__ == '__main__':
    startup, pins, context = preflight()
    print(json.dumps(startup, sort_keys=True), flush=True)
    os.kill(os.getpid(), signal.SIGSTOP)  # External controller captures the final pre-key/accept gate.
    serve(pins, context)
