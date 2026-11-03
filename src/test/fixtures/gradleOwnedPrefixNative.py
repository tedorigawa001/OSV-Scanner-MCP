"""Q2/A test-only native diagnostic IPC. Never issues prefix grants or reads storage.
Same-UID children are explicitly unsupported for immutable-provider adoption.
"""
import ctypes
import hashlib
import hmac
import json
import os
import platform
import secrets
import select
import socket
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

DOMAIN = "osv-mcp.q2a.diagnostic-only.v1"
MAX_FRAME = 4096


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def mac(key, value):
    return hmac.new(key, canonical(value), hashlib.sha256).hexdigest()


def peer(sock):
    if sys.platform == "darwin":
        lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        fn = lib.getpeereid
        fn.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        fn.restype = ctypes.c_int
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        if fn(sock.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
            raise OSError(ctypes.get_errno(), "getpeereid")
        return [uid.value, gid.value]
    if sys.platform == "linux":
        _, uid, gid = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return [uid, gid]
    raise RuntimeError("unsupported platform")


def exact(sock, count):
    result = b""
    while len(result) < count:
        block = sock.recv(count - len(result))
        if not block:
            raise ValueError("truncated")
        result += block
    return result


def send(sock, value):
    data = canonical(value)
    if len(data) > MAX_FRAME:
        raise ValueError("oversized")
    sock.sendall(struct.pack("!I", len(data)) + data)


def receive(sock):
    length = struct.unpack("!I", exact(sock, 4))[0]
    if length > MAX_FRAME:
        raise ValueError("oversized")
    data = exact(sock, length)
    value = json.loads(data)
    if canonical(value) != data:
        raise ValueError("noncanonical")
    return value


def require(ok, reason):
    # Explicit checks keep verification active under python -O.
    if not ok:
        raise ValueError(reason)

def strict(value, fields):
    if type(value) is not dict or set(value) != set(fields):
        raise ValueError("schema")


def provider(path):
    # Fresh per-process key, delivered through an anonymous stdin pipe, never argv/env.
    bootstrap = json.loads(sys.stdin.buffer.readline(4096))
    key = bytes.fromhex(bootstrap["key"])
    boot = secrets.token_hex(32)
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(path)
        os.chmod(path, 0o600)
        listener.listen(1)
        listener.settimeout(5)
        print(json.dumps({"ready": True, "pid": os.getpid()}), flush=True)
        with listener.accept()[0] as conn:
            conn.settimeout(2)
            remote = peer(conn)
            if remote[0] != bootstrap["expectedUid"]:
                send(conn, {"error": "rejected"})
                return
            context = {"domain": DOMAIN, "boot": boot, "nonce": secrets.token_hex(32),
                       "server": [os.geteuid(), os.getegid()], "client": remote}
            send(conn, context)
            try:
                hello = receive(conn)
                strict(hello, ["role", "nonce", "proof"])
                if hello["role"] != "reader" or not isinstance(hello["nonce"], str) or len(hello["nonce"]) != 64:
                    raise ValueError("authentication")
                binding = {"context": context, "role": hello["role"], "nonce": hello["nonce"]}
                if not hmac.compare_digest(hello["proof"], mac(key, binding)):
                    raise ValueError("authentication")
                send(conn, {"proof": "0" * 64 if bootstrap["corruptServerProof"] else mac(key, {"server": binding})})
                sent = None
                for sequence in range(1, 3):
                    try:
                        request = receive(conn)
                    except ValueError as error:
                        if str(error) == "truncated" and sequence == 2:
                            return
                        raise
                    strict(request, ["body", "proof"])
                    body = request["body"]
                    strict(body, ["boot", "seq", "operation"])
                    if body != {"boot": boot, "seq": sequence, "operation": "inspect"} or type(body["seq"]) is not int:
                        raise ValueError("request")
                    if not hmac.compare_digest(request["proof"], mac(key, {"binding": binding, "body": body})):
                        raise ValueError("authentication")
                    # No storage/getter is reachable: diagnostic protocol has no grant operation.
                    result = {"adoption": "provider_unsupported", "storageReads": 0,
                              "originalReadsSkipped": 0, "peer": remote, "sequence": sequence}
                    response = {"body": result, "proof": mac(key, {"binding": binding, "result": result})}
                    # Fault injection: an authenticated earlier response returned for a later request.
                    send(conn, sent if bootstrap["replayResponse"] and sent else response)
                    sent = response
            except (ValueError, TypeError, KeyError, OSError):
                try:
                    send(conn, {"error": "rejected"})
                except OSError:
                    pass


def start(path, key, corrupt=False, expected_uid=None, replay_response=False):
    child = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "--provider", path],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             close_fds=True)
    child.stdin.write(canonical({"key": key.hex(), "corruptServerProof": corrupt, "replayResponse": replay_response,
                                "expectedUid": os.geteuid() if expected_uid is None else expected_uid}) + b"\n")
    child.stdin.close()
    if not select.select([child.stdout], [], [], 5)[0]:
        finish(child)
        raise RuntimeError("provider startup timeout")
    line = child.stdout.readline()
    if not line:
        finish(child)
        raise RuntimeError("provider startup failed: " + child.stderr.read().decode())
    ready = json.loads(line)
    require(ready["ready"] is True and ready["pid"] != os.getpid(), "provider startup")
    return child


def connect(path, key, expected_server_uid=None):
    expected = os.geteuid() if expected_server_uid is None else expected_server_uid
    conn = socket.socket(socket.AF_UNIX)
    try:
        conn.settimeout(3)
        conn.connect(path)
        kernel = peer(conn)
        context = receive(conn)
        # The provider principal is pinned by the bootstrap, not by the server's self-report.
        require(kernel[0] == expected, "server identity")
        strict(context, ["domain", "boot", "nonce", "server", "client"])
        require(context["domain"] == DOMAIN, "server context")
        require(context["server"] == kernel and context["client"] == [os.geteuid(), os.getegid()], "server context")
        binding = {"context": context, "role": "reader", "nonce": secrets.token_hex(32)}
        send(conn, {"role": "reader", "nonce": binding["nonce"], "proof": mac(key, binding)})
        proof = receive(conn)
        strict(proof, ["proof"])
        require(isinstance(proof["proof"], str) and hmac.compare_digest(proof["proof"], mac(key, {"server": binding})), "server authentication")
    except BaseException:
        conn.close()
        raise
    return conn, binding


def request(binding, key, sequence=1):
    body = {"boot": binding["context"]["boot"], "seq": sequence, "operation": "inspect"}
    return {"body": body, "proof": mac(key, {"binding": binding, "body": body})}


def checked_result(conn, binding, key, sequence):
    response = receive(conn)
    strict(response, ["body", "proof"])
    require(isinstance(response["proof"], str) and hmac.compare_digest(response["proof"], mac(key, {"binding": binding, "result": response["body"]})), "response authentication")
    expected = {"adoption": "provider_unsupported", "storageReads": 0, "originalReadsSkipped": 0,
                "peer": [os.geteuid(), os.getegid()], "sequence": sequence}
    require(response["body"] == expected and type(response["body"]["sequence"]) is int, "response")
    return response["body"]


def finish(child):
    if child.poll() is None:
        child.kill()
    child.wait(timeout=5)


def run(case):
    key = secrets.token_bytes(32)
    checks = []
    evidence = {}
    with tempfile.TemporaryDirectory(prefix="q2a-", dir="/tmp") as root:
        path = root + "/ipc"
        child = start(path, key, corrupt=case == "server-impostor",
                      expected_uid=os.geteuid() + 1 if case == "wrong-peer" else None,
                      replay_response=case == "response-replay")
        try:
            if case == "same-uid-write":
                # Fixture-only negative control: chmod 0700/0600 cannot isolate the owner UID.
                owner = Path(root, "owner")
                owner.mkdir(mode=0o700)
                secret = owner / "key"
                secret.write_bytes(key)
                secret.chmod(0o600)
                target = owner / "sealed"
                target.write_bytes(b"sealed")
                target.chmod(0o400)
                attack = subprocess.run([sys.executable, "-I", "-c",
                    "import os,sys,json; from pathlib import Path; p=Path(sys.argv[1]); "
                    "k=(p/'key').read_bytes(); t=p/'sealed'; t.chmod(0o600); "
                    "t.write_bytes(b'changed'); print(json.dumps([os.geteuid(),os.getpid(),len(k)]))", str(owner)],
                    capture_output=True, check=True, timeout=3, close_fds=True)
                attacker_uid, attacker_pid, key_bytes = json.loads(attack.stdout)
                require(attacker_uid == os.geteuid() and attacker_pid not in [os.getpid(), child.pid], "attacker process")
                require(key_bytes == 32 and target.read_bytes() == b"changed", "attacker write")
                checks = ["same-uid-secret-readable", "same-uid-sealed-file-writable"]
                evidence["attackerUid"] = attacker_uid
            elif case == "server-impostor":
                try:
                    conn, _ = connect(path, key)
                except ValueError as error:
                    require(str(error) == "server authentication", "server-impostor reason")
                else:
                    conn.close()
                    raise AssertionError("accepted forged provider proof")
                checks = ["untrusted-server-proof-rejected-before-request"]
            elif case == "wrong-provider":
                try:
                    conn, _ = connect(path, key, expected_server_uid=os.geteuid() + 1)
                except ValueError as error:
                    require(str(error) == "server identity", "wrong-provider reason")
                else:
                    conn.close()
                    raise AssertionError("accepted an unexpected provider principal")
                checks = ["unexpected-provider-uid-rejected-before-hello"]
            elif case == "wrong-peer":
                with socket.socket(socket.AF_UNIX) as conn:
                    conn.settimeout(3)
                    conn.connect(path)
                    require(receive(conn) == {"error": "rejected"}, "wrong-peer")
                checks = ["kernel-uid-mismatch-rejected-before-handshake"]
            elif case in ["wrong-key", "wrong-role", "oversized", "truncated", "noncanonical", "handshake-timeout"]:
                conn = socket.socket(socket.AF_UNIX)
                conn.settimeout(3)
                conn.connect(path)
                with conn:
                    context = receive(conn)
                    if case == "handshake-timeout":
                        pass  # Real socket deadline expires without an authentication message.
                    elif case == "oversized":
                        conn.sendall(struct.pack("!I", MAX_FRAME + 1))
                    elif case == "truncated":
                        conn.sendall(struct.pack("!I", 20) + b"{")
                        conn.shutdown(socket.SHUT_WR)
                    elif case == "noncanonical":
                        data = b'{"role":"reader","role":"reader"}'
                        conn.sendall(struct.pack("!I", len(data)) + data)
                    else:
                        role = "operator" if case == "wrong-role" else "reader"
                        binding = {"context": context, "role": role, "nonce": secrets.token_hex(32)}
                        proof_key = secrets.token_bytes(32) if case == "wrong-key" else key
                        send(conn, {"role": role, "nonce": binding["nonce"], "proof": mac(proof_key, binding)})
                    require(receive(conn) == {"error": "rejected"}, case)
                    checks = [case + "-rejected"]
            else:
                conn, binding = connect(path, key)
                with conn:
                    first = request(binding, key)
                    if case in ["stale-boot", "stale-handshake"]:
                        # Terminate the real provider, restart with the same credential/root endpoint.
                        old = first
                        conn.close()
                        finish(child)
                        os.unlink(path)
                        child = start(path, key)
                        if case == "stale-handshake":
                            with socket.socket(socket.AF_UNIX) as conn2:
                                conn2.settimeout(3)
                                conn2.connect(path)
                                new_context = receive(conn2)
                                require(new_context["boot"] != binding["context"]["boot"], "new boot")
                                send(conn2, {"role": "reader", "nonce": binding["nonce"], "proof": mac(key, binding)})
                                require(receive(conn2) == {"error": "rejected"}, case)
                            checks = ["new-process-boot", "old-handshake-rejected"]
                        else:
                            conn2, binding2 = connect(path, key)
                            with conn2:
                                require(binding2["context"]["boot"] != binding["context"]["boot"], "new boot")
                                send(conn2, old)
                                require(receive(conn2) == {"error": "rejected"}, case)
                            checks = ["new-process-boot", "old-boot-request-rejected"]
                    elif case in ["bad-mac", "wrong-operation"]:
                        if case == "bad-mac":
                            first["proof"] = "0" * 64
                        else:
                            first["body"]["operation"] = "grant"
                            first["proof"] = mac(key, {"binding": binding, "body": first["body"]})
                        send(conn, first)
                        require(receive(conn) == {"error": "rejected"}, case)
                        checks = [case + "-rejected"]
                    else:
                        send(conn, first)
                        checked_result(conn, binding, key, 1)
                        if case == "replay":
                            send(conn, first)
                            require(receive(conn) == {"error": "rejected"}, case)
                            checks = ["same-session-replay-rejected"]
                        elif case == "response-replay":
                            send(conn, request(binding, key, 2))
                            try:
                                checked_result(conn, binding, key, 2)
                            except ValueError as error:
                                require(str(error) == "response", "response-replay reason")
                            else:
                                raise AssertionError("accepted an earlier response for a later request")
                            checks = ["earlier-response-rejected"]
                        elif case == "honest":
                            send(conn, request(binding, key, 2))
                            checked_result(conn, binding, key, 2)
                            checks = ["separate-process", "kernel-peer-credentials", "mutual-authentication",
                                      "authenticated-response", "ordered-requests"]
                        else:
                            raise ValueError("unknown case")
                        evidence["providerUid"] = binding["context"]["server"][0]
                        evidence["readerUid"] = binding["context"]["client"][0]
            if case != "same-uid-write":
                require(child.wait(timeout=5) == 0, child.stderr.read().decode())
        finally:
            finish(child)
    return {"case": case, "checks": checks, "verified": True, "evidence": evidence,
            "adoption": "provider_unsupported", "storageReads": 0, "originalReadsSkipped": 0}


CASES = ["honest", "wrong-key", "wrong-role", "replay", "stale-boot", "wrong-operation",
         "bad-mac", "oversized", "truncated", "noncanonical", "server-impostor", "same-uid-write", "wrong-peer", "stale-handshake", "handshake-timeout",
         "wrong-provider", "response-replay"]

if __name__ == "__main__":
    if sys.argv[1] == "--provider":
        provider(sys.argv[2])
    elif sys.argv[1] == "--all":
        results = [run(case) for case in CASES]
        print(json.dumps({"scope": "Q2/A diagnostic IPC only", "platform": platform.platform(),
            "python": platform.python_version(), "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "cases": results, "verifiedCases": len(results), "isolationVerified": False,
            "backendEligible": False, "profileApproved": False}, indent=2, sort_keys=True))
    else:
        print(json.dumps(run(sys.argv[1]), sort_keys=True))
