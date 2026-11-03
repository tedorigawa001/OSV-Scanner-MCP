# Q2/B1b diagnostic deployment fixture

This is a test-only startup implementation, excluded from the package. It does
not accept client connections, read service keys or canonical data, issue grants,
or enable backend/profile adoption. The Linux startup regression runs in a
disposable container; it does not establish independent VM isolation.

## Offline build

On Linux with a trusted Python base and a compiler supporting static libc:

```sh
python3 -I src/test/fixtures/q2b/build_fixture.py /tmp/q2b-bundle --compile
```

The destination must be empty. Without `--compile`, the builder generates unit
and source fixtures on other platforms but marks the bundle as not compiled.
The output includes `rootfs/` and a byte/size/mode inventory in `bundle.json`.
There is no automatic host installation or service start. The launcher is built
with `-static -Wall -Wextra -Werror`; its fixed runtime and entrypoint SHA-256
values are compiled into `policy.h`. The exact trusted Python base, interpreter
shared libraries, stdlib, compiler and image must be pinned separately. These
dependencies are not all discovered by the bundle inventory.

## Disposable systemd VM deployment contract

Use a fresh, dedicated Linux VM with systemd 255 or later, matching Python
runtime/base libraries, local filesystem, and no conflicting accounts or paths.
An operator must independently verify the complete bundle/source/image digest
before installing it. Refuse any existing `/opt/osv-q2b/b1b`, instance root,
unit override, default ACL, endpoint or overlapping UID/GID. Do not copy an
untrusted project-provided rootfs as root. This fixture deliberately has no
general privileged installer.

The root-owned files in `rootfs/` belong at their exact absolute paths. All
image ancestors must be root-owned and non-writable by other users, without
symlinks or unknown ACLs. Make the launcher/runtime executable. No account is
granted sudo, polkit control, Docker access or provider group membership.
The sysusers fixture allocates provider/reader/build/writer/checkpoint/registry
UIDs 1101–1106 and primary GIDs 1201–1206 with no supplementary groups. Inspect
the effective account configuration, not just the sysusers file.

After this independent operator deployment, the fixed VM-only commands are:

```sh
systemd-sysusers /usr/lib/sysusers.d/osv-q2b-b1b.conf
systemd-tmpfiles --create /usr/lib/tmpfiles.d/osv-q2b-b1b.conf
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/osv-q2b-b1b.service /etc/systemd/system/osv-q2b-reader.socket /etc/systemd/system/osv-q2b-upload.socket /etc/systemd/system/osv-q2b-publish.socket /etc/systemd/system/osv-q2b-b1b.target
systemctl start osv-q2b-b1b.target
journalctl -u osv-q2b-b1b.service --output=cat
```

The socket units create root-owned leaves with role-specific connect groups and
PassCredentials enabled. A static `--prepare <fixed-role>` guard rejects every
existing leaf before systemd can bind; it never unlinks. The provider has no
directory write permission. The service initially has only SETUID/SETGID/SETPCAP
to drop its own privileges. Before its fixed non-root exec, it empties capability
bounding/permitted/effective/inheritable sets, supplementary groups and ambient
capabilities, fixes all real/effective/saved IDs, and keeps NoNewPrivileges.

The root manager validates the initial five-variable activation environment plus
the fixed credential-directory reference (no key is provisioned there in B1b),
ignores no unknown variables, reorders listeners by actual path, and seals a
root-owned memfd with boot randomness, PID, cookies, root identity and artifact
hashes. It reopens the bootstrap read-only at FD 6, passes only FDs 0–6, then
execs the fixed launcher and isolated Python at the same PID. The runtime checks
FD custody, identities, cookies, hashes and capability state again and marks
inherited descriptors close-on-exec. Stdlib/import reads are not secret/canonical
reads and are not claimed to be zero. Its output is an unsigned startup
observation, not B1a controller evidence or an authenticated readiness receipt.

FD numbers alone are not an allowlist. Before any logging, the launcher requires
FD 0 to be the read-only `/dev/null` device, and FDs 1/2 to be connected AF_UNIX
stream sockets with kernel peer UID/GID 0. The approved peers are the named
`/run/systemd/journal/stdout` channel or an unnamed socket to the root parent
controller. Regular files, pipes, other addresses, read-only output streams and
non-root peers are rejected. The runtime independently checks the same policy.
If any standard stream is invalid, rejection is silent with exit 78: writing a
diagnostic to an unverified stderr would itself modify the substituted target.
The native controller uses root-parent socketpairs; the units explicitly select
null input and journal output for both service and pre-bind helpers.
The stdio negative controls use a separately pinned diagnostic entrypoint whose
first statement writes a private runtime-entry witness. Its positive control
must execute once; unsafe standard streams must leave the witness absent as well
as the root-only output canary unchanged. This test variant is never installed
as the ordinary VM provider and its artifact hashes are recorded separately.

## Stop and restart

```sh
systemctl stop osv-q2b-b1b.target osv-q2b-b1b.service osv-q2b-reader.socket osv-q2b-upload.socket osv-q2b-publish.socket
```

There is no automatic restart or unconditional socket cleanup. RemoveOnStop is
disabled. Before another start, the independent controller/operator must prove
old processes, accepted connections, manager listener references and any leaked
references have ended, verify fixed leaf identities against a prior trusted
inventory, and reclaim only those leaves. Unknown identities or missing evidence
require stopping for investigation; do not delete them merely to make restart
pass. The full lifecycle controller and independent signed observations belong
to B1c. A service-only restart is not an approved path.

## Native startup regression

`native_probe.py` refuses non-Linux/non-root, missing disposable markers, and
existing fixture deployment paths. It never runs on the host automatically.
It builds and mutates only the explicit disposable fixture. The controller needs
CHOWN/FOWNER for fault setup; it removes those capabilities in each child before
exec, matching the service's three initial capabilities. No privileged container,
mount operations, host writable source mount, network or Docker socket is used
inside the container. Run with an external execution deadline.

Before any deployment mutation, the runner validates all three path branches
read-only, including final dangling symlinks. Root ownership, directory modes,
ACLs and identities are checked using nofollow directory descriptors. Creation
uses anchored directory-relative operations and exclusive mkdir; only newly
created directories may have their mode adjusted. Existing parents are never
chmod'ed into compliance. A fresh-project-base requirement also protects the
controller's fault-injection cleanup. Regression canaries prove zero writes and
zero mode changes outside the deployment branches for symlink/dangling/file/
writable-parent faults, and that an accepted existing parent keeps its mode.

Results cover actual startup mechanics and pre-bind guards. B1c still needs a
systemd VM boot, full independent principal inventory, authenticated transport,
attack/allow controls, and signed controller evidence bound to the deployment.
B2/B3 persistence/fencing/pins and Q3/Q4 remain disabled.
