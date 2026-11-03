# B1ct: authenticated diagnostic transport, signed launch and controlled restart

This test-only extension leaves B1a synthetic diagnostics and the earlier B1b/B1c
records intact. It runs in a new arm64 QEMU systemd VM. Reader/upload/publish use
separate Ed25519 credentials, and the provider has a separate signing key. The
manager key is root-only; the controller key stays outside the guest. No shared
HMAC credential can impersonate the server. No grant or application data operation
is implemented: inspect/upload-probe/publish-probe return diagnostic-only results.

## Reproduce

Use the tools image and read-only `/src` fixture mount described in
`../q2b_b1c/README.md`. The tested rebuilt tools image digest is
`sha256:f8463f256a0b9c47c1c7564daf28b239937378a15ab045e56dd5cf6185971d45`.
The base image is independently pinned by the shared VM runner. Download it
separately; later bytes at the same URL are refused.

```sh
python3 -I /src/q2b_b1ct/vm_runner.py --image /work/base.img --work /work/new-auth-run
```

The work directory must be new. This reuses the existing fresh-VM boot/SSH/QEMU
lifecycle through fixed function composition. It adds a separately pinned private
credential archive, a fixed installer, and independent controller signatures.
The archive is not part of rootfs or any exported public evidence. The installer
checks both archive pins, exact path sets, private/public correspondence, artifact
bytes/modes, safe existing ancestors and fresh roots before installing anything.
It never accepts a project-specified command, UID, path or callback.

The guest data roots use a real nosuid/nodev/noexec tmpfs, verified with findmnt.
This is B1 diagnostic state, **not durable B2/B3 storage**. The provider UID cannot
write the root-owned endpoint directory or public launch/context/pin files. The
static manager receives only SETUID/SETGID/SETPCAP; non-root clients and provider
must have empty capability sets and supplementary groups, and NNP enabled.

## Manager and B1a binding

The root static C manager signs the actual listener inventory using OpenSSL
Ed25519 with configuration loading disabled. Its sealed read-only bootstrap at
FD 6 is 232 bytes: the original 168 bytes plus the deployment manifest digest and
exact signed launch-envelope digest. Private key bytes are never in the bootstrap,
argv, environment or diagnostics. The raw key buffer is cleansed; the key FD is
closed before the first non-root exec. Exec replaces the manager address space.

The independent root controller attaches at the manager's post-seal stop. It
reads kernel credentials, executable bytes, argv/environment, FD identities,
socket properties and the real sealed bootstrap using ptrace/pidfd_getfd. It
observes two actual exec transitions and the launcher/provider post-gate stops,
then detaches before service-key reads and accepts. The initial root manager exec
itself precedes this attachment; it is not counted among those two transitions.
The manager still carries systemd's input-order LISTEN_FDNAMES after normalizing
the actual FDs; this must be a closed permutation of the three roles. The next
launcher/runtime exec receives the fixed reader:upload:publish order.

`verifyB1cNativeLaunchBinding` in the B1a fixture uses a separate native-observed
schema and the existing manager envelope/launch checks. It compares independent
manager/controller keys, pinned manifest, actual artifact hash attestations,
three phase observations, two execs and both bootstrap digests. It never relabels
native observations as synthetic-static. B1a's original 4 MiB/16 MiB budgets stay
unchanged; the separate native metadata profile permits 16 MiB per artifact and
64 MiB total. Archived binaries are not stored: `artifactBytesLocallyReverified`
is false, while the pinned controller attests its actual file reads.

## Protocol and refusal controls

Both sides enable SO_PASSCRED before connection/listen. Client SO_PEERCRED pins
the root listener custodian; every received fragment separately pins the actual
provider UID/GID/PID. Server fragments pin the authenticated client UID/GID.
Same-UID forwarding remains the same principal and is an explicit allow control.
Changing UID midway through a fragmented frame or transferring a connected FD
to another principal is rejected even with a valid pre-signed request.

Server-first challenges bind the signed launch/manifest, instance/profile, role,
provider boot, peer and nonce. Client proofs add a fresh nonce. Requests/responses
bind session, sequence and exact request digest. Frames are canonical JSON with
duplicate keys/floats/nonfinite numbers/unknown fields rejected; the limit is
4096 bytes, two requests and an absolute two-second connection deadline.
Ancillary FDs are closed on every rejection path, including control truncation.
Normal IPC never sends FDs. Controller-only fault setup uses SCM_RIGHTS to model
a leaked authenticated connection; it does not transfer a key.

The 28 native cases include normal roles, cross-role rejection, bad server proof,
request/proof/session/response replay, malformed/oversized/truncated/slow frames,
FD injection and truncation, same-UID and cross-UID forwarding, wrong listener
custodian/sender, preflight queued data, and old proof/response after restart.
Refusals require the intended server reason, zero prohibited operations, completed
authentication where appropriate and client proof boundaries. Generic timeout,
missing process or an unrelated client failure is not a passing negative case.
Linux may reset a stream closed with unread data; EOF/ECONNRESET alone is never
enough without the matching protected server rejection record.

## Restart and evidence limits

The controller SIGKILLs the real provider and confirms old-connection EOF.
Service-only start is rejected with actual failed state/exit 78 and unchanged
old launch bytes. Type=simple start returning success is not readiness. After
stopping the fixed service/socket units, a controlled reader process holding an
old listener reference prevents reclamation. No leaf is unlinked while references
remain. The controller closes the old client, ends the holder, performs a bounded
/proc FD scan and reclaims only identity-matching leaves. Restart must produce a
new signed launch/bootstrap and disjoint cookies; old signed messages are refused.

This is a controlled-actor FD snapshot experiment, not an atomic global scan
against arbitrary concurrent FD transfer/mmap/mount aliases. It does not complete
all B1 isolation attacks, runtime dependency enrollment, independent registry,
distributed fencing, durable service storage or power-loss certification. The
trusted OS image supplies cryptography/OpenSSL dependencies; this is not a fully
approved runtime closure. All adoption/isolation flags remain false and skipped
original reads remain zero. Q2/B2/B3 local contracts are not silently connected.

Export only result.json and public pin files. The controller public pin is made
before boot; manager public pin before deployment; the actual manifest pin before
tracing/acceptance. The source receipt is checked for drift across the entire run.
Delete the dedicated tools container afterwards to destroy private keys, seed,
credential archives and guest disks. Normal tests do not start Docker or a VM.
