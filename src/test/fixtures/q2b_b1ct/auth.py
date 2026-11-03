"""Bounded diagnostic-only Ed25519 protocol; Linux credentials on every fragment."""
import array
import base64
import hashlib
import json
import os
import socket
import struct
import time

DOMAIN = 'osv-mcp.q2b.auth-frame.v1'
FRAME_BYTES = 4096
DEADLINE = 2.0
ROLES = {'reader': (1102, 1202, 'inspect'), 'upload': (1103, 1203, 'upload-probe'),
         'publish': (1104, 1204, 'publish-probe')}


def need(value, reason):
    if not value:
        raise ValueError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def decode(raw):
    need(0 < len(raw) <= FRAME_BYTES, 'frame-budget')
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'duplicate-key')
            result[key] = value
        return result
    def invalid(_):
        raise ValueError('invalid-number')
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_float=invalid, parse_constant=invalid)
        nodes = 0
        def walk(item, depth=0):
            nonlocal nodes
            nodes += 1
            need(depth <= 12 and nodes <= 128, 'json-budget')
            if isinstance(item, bool) or item is None or isinstance(item, str):
                return
            if isinstance(item, int):
                need(abs(item) <= 9007199254740991, 'invalid-number')
            elif isinstance(item, (dict, list)):
                for child in item.values() if isinstance(item, dict) else item:
                    walk(child, depth + 1)
            else:
                raise ValueError('json-type')
        walk(value)
        need(isinstance(value, dict) and canonical(value) == raw, 'noncanonical')
        return value
    except (UnicodeError, RecursionError, TypeError) as error:
        raise ValueError('json-invalid') from error


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def nonce():
    return os.urandom(32).hex()


def hex32(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def sign(body, key_id, private):
    unsigned = {'schema': DOMAIN, 'keyId': key_id, 'body': body}
    return {**unsigned, 'signature': base64.b64encode(private.sign(canonical(unsigned))).decode()}


def verify(envelope, key_id, public):
    need(isinstance(envelope, dict) and set(envelope) == {'schema', 'keyId', 'body', 'signature'} and
         envelope['schema'] == DOMAIN and envelope['keyId'] == key_id, 'signature-domain')
    try:
        signature = base64.b64decode(envelope['signature'], validate=True)
        need(len(signature) == 64 and base64.b64encode(signature).decode() == envelope['signature'], 'signature-encoding')
        public.verify(signature, canonical({key: envelope[key] for key in ('schema', 'keyId', 'body')}))
    except Exception as error:
        raise ValueError('signature-invalid') from error
    return envelope['body']


def credentials(channel):
    return struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))


def receive(channel, deadline, expected, observed=None):
    need(channel.getsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED) == 1, 'passcred-disabled')
    def exact(count):
        output = bytearray()
        while len(output) < count:
            remaining = deadline - time.monotonic()
            need(remaining > 0, 'deadline')
            channel.settimeout(remaining)
            raw, ancillary, flags, _ = channel.recvmsg(count - len(output), socket.CMSG_SPACE(12) + socket.CMSG_SPACE(64), socket.MSG_CMSG_CLOEXEC)
            peers, unexpected, rights = [], False, []
            # Close every delivered descriptor even when flags/other ancillary data are invalid.
            for level, kind, data in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    values = array.array('i'); values.frombytes(data[:len(data) - len(data) % values.itemsize])
                    rights.extend(values)
                elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(data) == 12:
                    peers.append(struct.unpack('3i', data))
                else:
                    unexpected = True
            for fd in rights:
                os.close(fd)
            need(not rights and not unexpected and not flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC), 'ancillary-invalid')
            need(raw and len(peers) == 1 and peers[0][0] > 0 and peers[0][1] not in (65534, 4294967295) and
                 peers[0][2] not in (65534, 4294967295), 'credential-missing')
            need(peers[0][1:] == expected[1:] and (expected[0] is None or peers[0][0] == expected[0]), 'credential-mismatch')
            if observed is not None:
                observed.append(list(peers[0]))
                need(len(observed) <= 1024, 'fragment-budget')
            output.extend(raw)
        return bytes(output)
    length = struct.unpack('!I', exact(4))[0]
    need(0 < length <= FRAME_BYTES, 'frame-budget')
    raw = exact(length)
    return decode(raw), raw


def send(channel, value, deadline):
    raw = canonical(value)
    need(0 < len(raw) <= FRAME_BYTES, 'frame-budget')
    remaining = deadline - time.monotonic(); need(remaining > 0, 'deadline')
    channel.settimeout(remaining); channel.sendall(struct.pack('!I', len(raw)) + raw)
    return raw


def challenge(context, role, peer):
    return {'kind': 'server-challenge', **context, 'role': role, 'clientPid': peer[0], 'clientUid': peer[1],
            'clientGid': peer[2], 'serverNonce': nonce(), 'sequence': 0}


def client_auth(channel, context, role, private, provider_public, observed=None, replay_proof=None, sent=None):
    deadline = time.monotonic() + DEADLINE
    peer = credentials(channel)
    need(peer[0] > 0 and peer[1:] == (0, 0), 'custodian-mismatch')
    expected = (context['providerPid'], 1101, 1201)
    envelope, raw = receive(channel, deadline, expected, observed)
    body = verify(envelope, 'provider', provider_public)
    need(type(body.get('sequence')) is int, 'invalid-number')
    wanted = {'kind': 'server-challenge', **context, 'role': role, 'clientPid': os.getpid(),
              'clientUid': os.getuid(), 'clientGid': os.getgid(), 'sequence': 0}
    need(set(body) == set(wanted) | {'serverNonce'} and hex32(body['serverNonce']) and
         all(body[key] == value for key, value in wanted.items()), 'challenge-binding')
    proof = {'kind': 'client-proof', 'challengeDigest': digest(raw), 'serverNonce': body['serverNonce'],
             'clientNonce': nonce(), 'role': role, 'providerBoot': context['providerBoot'],
             'launchDigest': context['launchDigest'], 'sequence': 0}
    signed = sign(proof, role, private)
    if sent is not None:
        sent.append(digest(canonical(replay_proof or signed)))
    send(channel, replay_proof or signed, deadline)
    reply, _ = receive(channel, deadline, expected, observed)
    accepted = verify(reply, 'provider', provider_public)
    need(type(accepted.get('sequence')) is int, 'invalid-number')
    session = digest(canonical({'context': context, 'role': role, 'peer': [os.getpid(), os.getuid(), os.getgid()],
                                'serverNonce': proof['serverNonce'], 'clientNonce': proof['clientNonce']}))
    need(accepted == {'kind': 'auth-accepted', 'sessionId': session, 'challengeDigest': proof['challengeDigest'],
                      'serverNonce': proof['serverNonce'], 'clientNonce': proof['clientNonce'], 'sequence': 0}, 'accept-binding')
    return {'sessionId': session, 'deadline': deadline, 'proof': signed, 'challenge': envelope, 'context': context, 'observed': observed}


def request(session, sequence, operation, private, role):
    return sign({'kind': 'request', 'sessionId': session['sessionId'], 'sequence': sequence,
                 'operation': operation, 'requestId': nonce()}, role, private)


def response(envelope, sent, provider_public, session):
    body = verify(envelope, 'provider', provider_public)
    need(type(body.get('sequence')) is int, 'invalid-number')
    need(body == {'kind': 'response', 'sessionId': session['sessionId'], 'sequence': sent['body']['sequence'],
                  'requestDigest': digest(canonical(sent)), 'operation': sent['body']['operation'],
                  'outcome': 'diagnostic-only', 'backendEligible': False, 'originalReadsSkipped': 0}, 'response-binding')
    return body
