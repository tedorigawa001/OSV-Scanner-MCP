# B1c: actual systemd VM startup and DAC controls

This is the first bounded B1c slice, **not completed B1c isolation approval**.
It boots a separate arm64 kernel under QEMU TCG, starts real systemd socket/service
units, and checks six distinct real/effective/saved/filesystem UID/GID sets.
142 native controls cover private-root read/write-open permission, socket parent
creation/unlink/chmod, entrypoint/unit write-open, evidence access, cross-UID
`/proc/PID/fd/6` and `/proc/PID/mem`, signal **0** permission, and role-specific
socket connect. Successful own-root read/write-open and authorized connect are
controls using the same actor and syscall. No application data is read or written.
The canaries are disposable random bytes, not keys or canonical authority data.

The provider does not accept queued connections, load keys, authenticate peers,
or issue grants. Signal 0 does not prove delivery of a modifying signal. `/proc`
access controls are not an exhaustive ptrace/process_vm_readv attack test. A
successful socket connect proves filesystem connect permission, not authentication.
There is no FD-transfer defense, manager-signed launch/bootstrap digest, complete
external exec trace, B1a bridge, or coordinated restart/leaked-FD drain proof.
All adoption flags remain false; originalReadsSkipped remains 0. Do not substitute
these observations for `synthetic-static` B1a records or production approval.

## Reproduce in a disposable Linux tools container

The outer tools image must provide Python, a static C compiler/libc,
qemu-system-aarch64, qemu-utils, qemu-efi-aarch64, cloud-image-utils, OpenSSH client
and OpenSSL. The tested tools image was based on `python:3.14-bookworm`; the guest
is the exact Ubuntu image pinned by `vm_runner.py`. Download it separately and
verify the official SHA256SUMS. A later image at the same release URL is refused.
No packages are downloaded by the runner or installed in the guest.
`Dockerfile` supplies the tools with an immutable base-image pin. Its package
repository can change, so record the built image digest for each run; this is
not a bit-reproducible or complete approved runtime closure. The actual tested
tools image digest was
`sha256:fcb7aac1ebafc6e1e5d71b0987b48efca5218e6f69f695ea38dbe1d8cd6299c6`.

Run the tools container with no capabilities, no privileged mode, no host writable
source mount, no Docker socket, and no host ports. Mount the repository fixtures
read-only at `/src`; use a container-private `/work`. QEMU uses software emulation
and restricted user networking with only loopback SSH forwarding inside that
container. A separate existing VM, host service manager, host accounts and host
SSH configuration are never reused.

```sh
python3 -I /src/q2b_b1c/vm_runner.py --image /work/base.img --work /work/new-run
```

`--work` must not exist. The runner checks the image digest, creates a fresh disk,
new SSH client and guest host keys, and an outside-guest Ed25519 controller key.
The controller public pin is saved **before boot**. SSH requires the injected host
key. Cloud-init provisions only a guest operator and a dedicated-VM marker. Root
guest operations are limited to the fixed installer and probe; the installer
checks the independently supplied archive digest, exact path closure, artifact
bytes/modes, safe ancestors and absence of existing targets before any install.
There is no overwrite or recursive cleanup path. A failed run requires a new VM.

The VM-only profile composes checked source anchors from B1b, records the parent
source hashes, uses separate `b1c` image/state/unit paths, and leaves B1b unchanged.
It removes systemd's MEMORY_PRESSURE_WATCH/WRITE before launcher exec rather than
allowing arbitrary environment variables. Its runtime budget is explicitly 8 MiB
(Ubuntu's Python is 7,845,048 bytes), while B1a/B1b retain their original budgets.
The root manager explicitly receives only SETUID/SETGID/SETPCAP as permitted
startup capabilities; the provider must have **all five capability sets empty**.
This is a diagnostic variant, not an approved extension of the B1a manifest.

`Type=simple` start is not treated as readiness: the probe requires the final
runtime PID, exact argv, FDs 0–6, root-created bootstrap contents/seals and a unique
startup observation. Each child stops after dropping privileges; the independent
root controller reads `/proc/PID/status` before allowing the syscall. An unexpected
error (including ENOENT), missing allow control, unknown/duplicate case or partial
result fails the run. Canary digests and provider identity are checked afterwards.

The outer controller signs the collected report and environment/source hashes.
This attests collection by the operator, not a complete audited execution trace;
the manager has no signing key. Keep `controller-public.pin` separately from
`result.json`. The ordinary TypeScript verifier requires independent controller
and bundle pins and never returns an adoption-capable handle. It verifies exact
case expectations, identities, signatures and the explicit incomplete scope.

QEMU terminates in a `finally` block. After exporting **only** public result/pin
files, remove the dedicated tools container to destroy its disk and private keys.
Do not export seed.iso, user-data or private key files. Normal unit tests do not
boot VMs or invoke Docker.
