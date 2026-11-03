# Native authenticated single-seal storage diagnostic

This independent fixture composes the reviewed B1ct static manager, sealed
bootstrap, launcher and fragment-authenticated Ed25519 IPC. It leaves the old
fixture sources and their native records unchanged. The service runs as UID/GID
1101/1201; reader, upload, publish, checkpoint and registry controls run under
five distinct UIDs/GIDs with no capabilities, supplementary groups or privilege
escalation. It is test-only and excluded from the distribution.

The storage root is on the pinned guest's **ext4 disk**, bind-mounted with actual
`nosuid,nodev,noexec` flags. It is not the previous tmpfs diagnostic. Tests never
create host users, host systemd units, host sockets or privileged host mounts.

## Reproduce

Use the tools container image from `../q2b_b1ct/README.md` (digest
`sha256:f8463f256a0b9c47c1c7564daf28b239937378a15ab045e56dd5cf6185971d45`),
with these fixture directories mounted read-only at `/src`. Download the Ubuntu
arm64 image separately and verify SHA-256
`6e971c7935c62c8ea7796b085e4ea038e2301a067f8c853e154133f8df192c85`.

```sh
python3 -I -B /src/q2b_storage/vm_runner.py --image /work/base.img --work /work/new-storage-run
```

The work path must be new. The fixed runner reuses QEMU/systemd/cloud-init/SSH
lifecycle from B1c; manager credentials are provisioned before launch, while the
controller signing key stays outside the guest. A separately pinned credential
archive is never part of rootfs or public evidence. Checked source anchors fail
on parent drift; a complete 23-source receipt must remain unchanged across the
entire native run.

Export **only** `result.json` and `public-bindings.json`. Manifest pin comes from
the install return before tracing/acceptance, manager pin from before deployment,
controller pin from before VM boot, and run ID from the outside built bundle.
Private keys, credentials.tar, seed, disks and SSH keys remain private work files.
Destroy the dedicated tools container after exporting public results.

## Fixed operation and persistence contract

This first native storage unit is deliberately a **single immutable snapshot**:
generation 1, one nonempty payload up to 512 bytes, one upload then one seal.
It is not the TypeScript `SealedPrefixStore` wire format, journal replay, a full
multi-generation provider, authority state restoration or a read-skip backend.
That higher-level bridge remains separate work.

- upload `stage`: accepts only canonical base64 payload, reserves `intent.json`
  and stores `data.bin`; no client path, command, fault selector or callback.
- publish `seal`: validates exact inventory/content, writes a domain-separated
  Ed25519 `seal.json` and `selected.json`. The seal binds root device/inode,
  manifest/run/origin boot, generation, intent digest and exact payload size/hash.
- reader `read-state`: returns empty state or reverified payload and seal head.
  It never grants launch/authority rights.

The process holds an exclusive flock on the fixed `lock` file. All storage
opens use captured directory FDs, `O_NOFOLLOW`, file custody/mode/nlink checks;
new writes use `O_EXCL`. Root identity is rechecked before access. Unknown entries,
symlinks, external hardlinks, replacement roots and incomplete inventory fail.
Entry enumeration stops at the fixed closure plus one.

Every new file is written, file-fsynced, parent-fsynced and read back. Sealing
then authenticates and resynchronizes all four evidence files and the directory
before an accepted response is signed. Reader/recovery also reverify and
resynchronize originals; no prefix/checkpoint read or synchronization is skipped.
Invalid role/argument is rejected before mutation. Storage failures make the
owner unavailable for subsequent requests; an ordinary retry cannot clear it.

## Recovery, faults and isolation

The controller captures the signed successful seal response, kills the real
provider using SIGKILL and starts a new manager/launcher/provider boot. Root-owned
recovery anchor contains the exact externally captured seal digest. Before
acceptance, the service requires matching inventory, signatures, root identity,
payload and anchor, and synchronizes files/directory again. A fresh connection
that replays an old boot's authenticated storage request is rejected for the
specific session binding reason.

The anchor is a **controller-owned recovery fixture**, not a live independent
source checkpoint issuer, authority acknowledgement, rollback-protected registry
or distributed currentness proof. It does not upgrade the old TS B2/B3 contracts.

Five real principals each attempt 13 fixed denied operations: direct read/write,
create, unlink, rename, hardlink, symlink, root rename, `/proc` FD access, ptrace,
pidfd_getfd, signalling and mount namespace creation. Each refusal must be
EACCES/EPERM, with a same-principal own-directory write/read/delete allow control.
Disk bytes and the successful seal are checked unchanged afterwards. Authenticated
upload/publish/read provide service-mediated positive controls.

Root-controller-only faults cover injected EIO at write/file fsync/directory fsync,
after-data, after-seal, after-selection and before-response. `file-limit` instead
uses actual kernel RLIMIT_FSIZE to obtain EFBIG from the real write. Injected EIO
is labelled as such; it is not a disk-driver or power-loss result. Every failure
must yield a signed rejection, then unavailable; restart with no accepted anchor
must reject the partial or unacknowledged snapshot. Root archives the failed root
as evidence and creates a new private root for the next independent round; this
is explicit test quarantine, not automatic repair or quota reclamation.

Separate native controls modify same-size payload bytes, add an unknown entry,
or replace data with a symlink after successful seal. Restart with the previously
accepted anchor must still reject. Failure is joined with the actual service
failed state and exit status, not just a client timeout.

## Evidence and limitations

Public records include outside controller signatures; each boot has a separate
manager launch and B1a native binding diagnostic (three observed phases/two actual
execs). Native ext4 launch verification is explicitly selected; default B1ct
verification continues to require its original tmpfs profile. Provider/client
request, challenge, proof and response signatures are retained and matched against
manifest-pinned public role keys. The verifier checks operation results against
protected service events and synchronization counters; it never accepts an
unsupported claim just because the outside record was correctly re-signed.

Normal Vitest tests start neither Docker nor VMs. They verify archived records
and exact source hashes, mutate/re-sign controller reports, and run 22 local
filesystem regressions. Local storage tests use an explicitly labelled HMAC
signer test double; native guest operations use real cryptography Ed25519 keys.

This demonstrates controlled DAC/process isolation, guest process restart and
guest fsync boundaries. It does **not** demonstrate a VM reboot, forced power
loss, host-disk durability, exhaustive FD/mmap/mount alias attacks, independent
runtime closure approval, multi-generation inventory/fencing/pin drain, fresh
source checkpoint issuance, distributed registry/barrier, TS journal/authority
adoption or Q3 read reduction. All `nativeIsolationVerified`, independent registry,
profile/adoption flags remain false; original skipped reads remain zero.
