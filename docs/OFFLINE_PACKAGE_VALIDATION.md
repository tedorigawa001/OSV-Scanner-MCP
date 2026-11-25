# Offline package installation validation

The [runner](../scripts/validate-offline-package.mjs) separates connected preparation from disconnected installation. Its transferred kit includes the application tarball, an exact production dependency lock and npm cache, npm itself, Node executables, the native scanner and a prepared Maven DB. The disconnected side runs only those transferred files. No source checkout, development dependencies, package installation scripts, compiler, global application install or `npx` download is used.

## Observed package and runtimes (2026-11-18)

This validates a local `npm pack` artifact built from the checkout including `d9dfa9c`, not the older registry release with the same version string. Publishing is a separate operation. A subsequent release/version change produces a different artifact and should be validated separately.

- Package: `osv-scanner-mcp` 0.23.0, declared Node engine `>=22.13`.
- Tarball SHA-256: `9a7d4b023a02d9286be6e3d550405ef0e9d6216c80864cb3cb6bf2b6ea2e01ca`.
- All 144 application files match the packed bytes after installation, including the compiled entry point and all three distributed Gradle scripts. The archive excludes source, tests, development modules and validation scripts.
- Provisioned npm: 11.20.0. Dependencies use the repository lock's exact runtime versions/integrities, including nested and optional packages; dev-only entries are removed and the local application archive is added as a file dependency. The generated consumer lock is checked by real `npm ci`.
- Platform: macOS arm64, same user. The native Koffi optional package is supplied through the target-platform dependency cache. With install scripts disabled, the actual OS opened-file-path probe succeeds on every supported runtime.

| Node executable | Offline `npm ci` | MCP startup and six tool calls | Native opened-file path / CRC API |
|---|---|---|---|
| 22.13.0 | Pass | Pass | Pass |
| 24.22.1 | Pass | Pass | Pass |
| 26.12.1 | Pass | Pass | Pass |
| 20.19.6 | `EBADENGINE` | Not attempted | Not a supported-runtime result |

22.13.0 is the declared minimum. The 24/26 cases are representative installed patches of the other CI majors, not a claim to have executed every patch or the intervening odd-numbered majors. The engine declaration was not changed. Node 22.13.0's official `darwin-arm64` archive was downloaded separately and matched the [official SHA-256 list](https://nodejs.org/dist/v22.13.0/SHASUMS256.txt): `bc1e374e7393e2f4b20e5bbc157d02e9b1fb2c634b2f992136b38fb8ca2023b7`. The other runtimes were already locally provisioned; all copied executable digests are in the record. The [22.13.0 API documentation](https://nodejs.org/download/release/v22.13.0/docs/api/zlib.html#zlibcrc32data-value) also includes the CRC API exercised by the probe.

## Runtime results

The [machine record](validation/offline-package-2026-11-18.json) contains the packed file inventory, runtime image digests, prepared-kit manifest/content digests, DB manifest, MCP initialization/tool listings, results and regression-report digest. No executable, dependency cache or DB archive is committed to the repository.

The complete Maven DB is the same independently prepared generation used by the Maven validation: 10,541,344 bytes, SHA-256 `d4af0a671eccebbccc5d7f90e52000e50c9f396fa908278797d6cb69e7c0c3de`. Each installed server is started through its actual `node_modules/.bin/osv-scanner-mcp` link, whose target must be the installed package's `dist/index.js`. The launch environment selects the transferred Node binary and does not inherit `NODE_PATH`, `NODE_OPTIONS` or user/global npm settings. The working directory and application tree are outside the checkout. Only the explicit transferred scanner/DB are selected; automatic binary download is disabled.

For each of the three supported runtimes, the raw stdio MCP client performs initialization, `tools/list` and these six calls through the installed server:

| Tool call | Observed result on every runtime |
|---|---|
| `scan_project` | Log4j Core 2.14.1, 8 vulnerability groups, offline DB metadata |
| `scan_java_project` | Same package/advisory evidence, direct POM input |
| `suggest_fix` | 2.25.4, `verification: verified`, local candidate `clean`, all 8 targets `not_affected` |
| `scan_sbom` | The same Maven package/version in a private CycloneDX SBOM, 8 groups |
| `explain_vulnerability`, GHSA-jfh8-c2jp-5v3q | ID match, nonempty details |
| `explain_vulnerability`, CVE-2021-44228 | Alias match to the same GHSA, same details digest |

There are 18 successful tool calls in total. POM transitive resolution remains explicitly disabled; this is not a full resolved Maven graph or a safety guarantee. Candidate rechecks here execute via the installed product's real native local-DB path. Servers are stopped with SIGTERM and must return the product's cleanup exit code 143, not be killed by the controller's fallback timeout.

The OS profile denies network access to the runner, npm and all descendants. Each Node image separately attempts loopback TCP and must receive EPERM/EACCES; all four observed EPERM. Connection refusal/timeouts are not accepted as proof. No Node fetch counter/preload is used in these package runs: the evidence is the inherited OS denial plus successful quiet package execution.

The final run additionally denies reading seven original domains: checkout, host npm cache, original scanner cache, original Node installation root, original prepared kit, original Maven cache and original downloaded Node 22 tree. The transferred standalone runner opens a known path in each domain and requires EPERM/EACCES; all seven were EPERM. The current record was generated directly by the path-free runner from `158d740`, using domain labels (`checkout`, `npm-cache`, `scanner-cache`, `node-install`, `kit`, `maven-db`, `node22-download`). It was not edited to replace host paths after measurement. The recorded runner/source hashes match the current files, and a recursive check of the resulting JSON found no absolute path keys or values. Thus npm/server execution cannot silently borrow those original inputs. This is same-user OS policy verification, not separate-UID or hostile-controller isolation.

Negative runtime controls also establish:

- An initially empty installation with an empty npm cache fails `ENOTCACHED` under network denial (all three supported runtimes).
- Removing required `yauzl` from an otherwise successful installation causes startup `ERR_MODULE_NOT_FOUND` instead of a development/global dependency fallback (all three).
- Node 20.19.6 is refused by `--engine-strict` with `EBADENGINE` naming the application.

The source-side harness has 35 regression tests: the original 30 for production-lock preservation, packed-file change/missing/extra/symlink/size rejection, minimum/CI-major coverage, false scan evidence, invalid invocation and the exact SIGTERM cleanup convention, plus 5 for labeled denied-read arguments. The fresh combined run passed **795 tests in 37 files**, with type checking, build and syntax checks. The prepared executable artifacts match the current compiled output. Existing Go/Maven records remain evidence for their own recorded source versions and were not regenerated.

### Path-free runner revalidation (2026-11-18)

For this rerun, the existing kit was checked against its complete prepared-input inventory and copied to a fresh staging directory. Only the transferred runner was replaced, and its expected input digest plus current runner/test source bindings were refreshed; the remaining 2,687 prepared files were reused unchanged. The new kit manifest binds the previous manifest digest and records this offline refresh. This preparation itself ran under network denial, without new downloads. The application archive hash and all 144 packed files still match the rebuilt checkout, and Node/npm/scanner/dependency/DB bytes are unchanged. The DB acquisition timestamp was preserved rather than reset.

That refreshed kit was then copied again to an independent transfer location. The recorded run used only its own Node 26 executable and standalone runner, from an unrelated working directory. The OS profile denied network access, the seven probed original domains and the earlier kit locations. On Node 22.13.0, 24.22.1 and 26.12.1, empty-target offline installation, native opened-file-path checks, all 18 tool calls and the missing-dependency/empty-cache refusal controls passed again. Node 20.19.6 again returned `EBADENGINE`. All four TCP probes and seven original-read probes returned EPERM. The artifact/runtime outcome table above therefore applies to this current-runner measurement as well.

The current record directly contains the seven `{domain, error}` results and the current runner SHA-256 `6aa84682bdc70a60a27c274f48cc508905731707ca2b46e5d68c686b1a33b2f9`. Earlier measurements, including the initially path-redacted record, remain available in Git history; the current record replaces neither source hashes nor results through postprocessing.

## Linux arm64 package validation (2026-11-25)

Two separate kits were prepared on Debian 12 arm64 with npm 11.16.0. The first used the exact published `osv-scanner-mcp@0.25.0` tarball and an expected SHA-512 integrity value obtained separately from the npm registry. The second used `npm pack` on the current product source at `d2ab9d6`. The published tag and the current checkout have identical production lock entries. The runner checks the archive integrity before extraction and checks its package name, version, dependencies, bin, engines and license against the source used for the lock. It also compares every installed application file with the tarball. [Published package](https://www.npmjs.com/package/osv-scanner-mcp/v/0.25.0)

| Artifact | Verified files | SHA-256 and execution record |
|---|---:|---|
| npm registry tarball | 144 | [Registry run](validation/offline-package-linux-arm64-registry-2026-11-25.json) |
| Current checkout tarball | 145 | [Checkout run](validation/offline-package-linux-arm64-checkout-2026-11-25.json) |

Each kit includes official Node Linux arm64 executables from archives checked against their SHA-256 lists. Both use pinned OSV-Scanner 2.7.0 and the same complete Maven DB of 10,568,619 bytes, SHA-256 `ea7e02c8b9cef22362b54befc797a8fbf175d7bf615f0bc3edbfb82168a05130`, acquired at `2026-11-25T03:35:10.675Z`. The scanner hash matches the repository pin. The official Node 26.12.1 Linux arm64 binary requires `libatomic.so.1` on this base. Debian's `libatomic1:arm64` version `12.2.0-14+deb12u1` was provisioned on the target image before disconnecting. [Node archives](https://nodejs.org/dist/) · [OSV-Scanner 2.7.0](https://github.com/google/osv-scanner/releases/tag/v2.7.0)

| Node | Offline install and MCP on both tarballs | Negative controls |
|---|---|---|
| 22.13.0, 24.18.0, 26.12.1 | Empty-target `npm ci` and all six MCP calls per installation passed | Empty npm cache returned `ENOTCACHED`; removing `yauzl` returned `ERR_MODULE_NOT_FOUND` |
| 20.19.6 | Package validation stopped at dependency installation | `EBADENGINE` naming `osv-scanner-mcp` |

All 36 successful MCP calls used the copied Maven DB and the actual installed executable. On each installation, `scan_project`, `scan_java_project` and `scan_sbom` found the same eight advisories for Log4j Core 2.14.1. `suggest_fix` recommended 2.25.4 after the local candidate check returned `clean` and all eight reported targets were `not_affected`. The `explain_vulnerability` calls for the GHSA ID and CVE alias returned identical detail hashes. The runner also verified native opened-file paths, CRC API availability and SIGTERM cleanup for each installed runtime.

The disconnected container had a read-only system filesystem, a fresh writable `/tmp`, no global Node/npm and no network interface for external traffic. The Linux profile rejected creation of IPv4 and IPv6 sockets, and all eight runtime/artifact pairs got `EPERM` on both TCP controls. The application ran as UID 1000 with no capabilities. The original preparation volume was root-owned with mode `0700` and mounted read-only. The checkout, original npm cache, scanner, npm installation, original kit, Maven cache and original Node executable were confirmed to exist from the preparation side. All seven paths gave `EACCES` to the runner for each kit. Both records use domain labels and passed a recursive check for absolute paths. The execution records cover Debian 12 arm64 and the Maven fixture. [Docker network isolation](https://docs.docker.com/engine/network/drivers/none/) · [Docker seccomp profiles](https://docs.docker.com/engine/security/seccomp/)

Review added the independent integrity input and required it whenever a tarball is supplied. A Linux preparation run with the published tarball and an incorrect pin was rejected before creation of the consumer lock. The disconnected runner cross-checks the archive and scanner digests against the transferred bytes and probes the scanner version under network denial. Both kits were rebuilt and rerun with the same tarballs, runtimes, scanner and DB. The final source-side report passed 260 tests across seven files, including 49 package-validation cases. Type checking and a Linux build passed.

## Linux x64 package validation (2026-11-25)

The Linux x64 run used Debian 12 `linux/amd64` containers on an arm64 Docker Desktop host with x64 emulation. The connected and disconnected stages ran the official Linux x64 Node executables and the `linux_amd64` OSV-Scanner binary. The four Node archives matched their official SHA-256 lists. OSV-Scanner 2.7.0 matched the repository pin `160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b`. The target image had `libatomic1:amd64` version `12.2.0-14+deb12u1` for official Node 26.12.1. npm 11.16.0 was supplied through the transferred kit.

| Artifact | Verified files | Execution record |
|---|---:|---|
| npm registry tarball `osv-scanner-mcp@0.25.0` | 144 | [Registry run](validation/offline-package-linux-x64-registry-2026-11-25.json) |
| Current checkout `b645b2a` bundled with `npm pack` | 145 | [Checkout run](validation/offline-package-linux-x64-checkout-2026-11-25.json) |

Each tarball matched the corresponding arm64 record byte for byte. Both x64 runs used the original 10,568,619-byte Maven DB with SHA-256 `ea7e02c8b9cef22362b54befc797a8fbf175d7bf615f0bc3edbfb82168a05130` and preserved its acquisition time. Empty-target offline install and all six MCP calls passed on Node 22.13.0, 24.18.0 and 26.12.1. Across 36 successful MCP calls, `scan_project`, `scan_java_project` and `scan_sbom` agreed on all eight advisory IDs for Log4j Core 2.14.1, `suggest_fix` verified 2.25.4 against the local DB, and the GHSA ID and CVE alias returned the same details. The complete MCP evidence matches the arm64 runs. The empty cache and missing `yauzl` controls returned `ENOTCACHED` and `ERR_MODULE_NOT_FOUND`. Node 20.19.6 was rejected with `EBADENGINE`.

With networking disabled and the Linux seccomp profile loaded, IPv4 and IPv6 returned `EPERM` for all eight runtime/artifact combinations. The runner used UID 1000 with zero effective capabilities and `no_new_privs`. The original preparation files were confirmed to exist under the root-owned `0700` volume, and all seven original paths returned `EACCES` for each kit. Both JSON records were exported directly from the runner, checked for absolute paths, and matched to the checked-in harness and lockfile hashes. The source-side report passed 260 tests across seven files on macOS arm64, where type checking also passed. The checkout built successfully on Debian x64 under emulation. Windows full-package validation remains open.

The first transfer encountered host disk exhaustion and a Docker filesystem I/O error. After restarting Docker, a byte comparison detected a damaged transfer copy. The transfer volume was recreated from the prepared kits and both copies were checked before the recorded runs.

Review repeated both disconnected runs using the same transferred kits and isolation settings. Each new record matched its saved record after excluding only the run timestamp. All 49 package-validation regression tests passed during review.

## Reproduction

Use a fresh kit directory on a connected machine matching the disconnected target's OS/architecture, with the checkout's development dependencies already installed. Provision and verify the desired Node executables and native scanner, then prepare a complete Maven DB with the existing cache command. The preparation runner builds/packs this checkout and downloads only the locked runtime dependency archives; it never runs dependency installation scripts.

```bash
npm run build
node dist/index.js cache --ecosystems Maven --directory /absolute/maven-cache
node scripts/validate-offline-package.mjs prepare \
  --directory /absolute/kit \
  --database-cache /absolute/maven-cache \
  --scanner /absolute/osv-scanner \
  --npm-cli /absolute/npm/bin/npm-cli.js \
  --node /absolute/node22.13.0/bin/node \
  --node /absolute/node24/bin/node \
  --node /absolute/node26/bin/node \
  --rejected-node /absolute/node20/bin/node
```

The `prepare` mode requires 22.13.0 plus representative 24/26 executables and a Node 20 negative control. To test a published package archive, obtain it with `npm pack <package>@<version> --ignore-scripts` and obtain the expected SHA-512 value separately with `npm view <package>@<version> dist.integrity --registry https://registry.npmjs.org`. Add `--package-tarball /absolute/package.tgz --package-integrity "$registry_integrity"` to `prepare` using a checkout with the matching production lock. The runner stores relative paths for the copied executables, a local `file:../application.tgz` dependency, npm itself and all other inputs. `kit.json` records the source/config hashes, expected package files and transfer-input digests. Run mode verifies the transferred runner itself against the prepared source hash, verifies the inputs, and copies the cache into its disposable working directory so repeat runs do not mutate the kit.

Copy the entire kit to another location/machine. The standalone runner then needs only the kit; it can run from an unrelated working directory. A regression JSON report is optional and must be separately transferred if `--test-report` is used. The final recorded run supplied the passing source-side report.

```bash
cp -R /absolute/kit /absolute/transferred-kit
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  /absolute/transferred-kit/runtimes/v26.12.1/bin/node \
  /absolute/transferred-kit/validate-offline-package.mjs run \
  --kit /absolute/transferred-kit --output /absolute/package-record.json
```

On macOS, deny reads of original inputs by adding `(deny file-read* (subpath "/absolute/source"))` for each original root. Pass `--denied-path checkout=/absolute/source/package.json` (repeatable, `<domain>=<absolute path>`) for a known original path in each root. Include the original kit, Node, scanner, npm cache and DB roots as well as the checkout. Keep the output/report paths outside the denied roots. The record stores each domain label and its error.

On Linux, prepare separate original and transfer volumes. Give the root-owned original volume mode `0700` and confirm that all seven probe targets exist while running as the preparation UID. Copy each complete kit to the transfer volume, verify it against its original, and give the test UID ownership of the transferred files and report directory. Prepare a Debian 12 runtime image for the target architecture with the system libraries required by the copied binaries, including `libatomic1` for the recorded Node 26.12.1 builds. Omit global Node and npm. Use the supplied [network-test profile](../scripts/offline-package-linux-seccomp.json) in a disposable container with `--network none`, dropped capabilities and a read-only root filesystem.

The following example runs both x64 kits, with prepared directories named `registry-kit` and `checkout-kit`. Mount the original and transferred volumes under `/original` and `/transfer` with the layout shown. To repeat the arm64 run, use `linux/arm64` for `package_platform`, `linux-arm64` for `package_node_archive`, and an arm64 runtime image and scanner. To include the source-side test summary in each record, transfer its JSON report and pass `--test-report /transfer/regressions.json`.

```bash
package_platform=linux/amd64
package_node_archive=linux-x64
package_runtime_image=osv-package-runtime:amd64
for artifact in registry checkout; do
  docker run --rm --platform "$package_platform" --network none --read-only \
    --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
    --security-opt seccomp=scripts/offline-package-linux-seccomp.json \
    --tmpfs /tmp:rw,exec,nosuid,nodev,size=1g,mode=1777 \
    --mount type=volume,src=osv-package-prepared,dst=/original,readonly \
    --mount type=volume,src=osv-package-transferred,dst=/transfer -w /tmp \
    --entrypoint "/transfer/$artifact-kit/runtimes/v26.12.1/bin/node" "$package_runtime_image" \
    "/transfer/$artifact-kit/validate-offline-package.mjs" run \
    --kit "/transfer/$artifact-kit" --output "/transfer/out/$artifact.json" \
    --denied-path checkout=/original/repo/package.json \
    --denied-path npm-cache=/original/node-cache/_cacache/index-v5 \
    --denied-path scanner=/original/source-assets/osv-scanner \
    --denied-path npm-install=/original/source-npm/bin/npm-cli.js \
    --denied-path kit="/original/$artifact-kit/kit.json" \
    --denied-path maven-db=/original/maven-cache/manifest.json \
    --denied-path node-install="/original/source-assets/node-v22.13.0-$package_node_archive/bin/node" || exit 1
done
```

For actual deployment, use the kit's consumer manifest/lock and `application.tgz` in their relative layout, and invoke the supplied Node/npm with:

```bash
/absolute/kit/runtimes/v22.13.0/bin/node /absolute/kit/tooling/npm/bin/npm-cli.js \
  ci --offline --omit=dev --ignore-scripts --no-audit --no-fund --engine-strict \
  --cache /absolute/kit/npm-cache
```

Run this from `kit/consumer`, then launch its installed binary with the selected Node on PATH and explicit `OSV_SCANNER_PATH`, `OSV_MCP_OFFLINE=1`, `OSV_MCP_OFFLINE_DB_DIR` and `OSV_MCP_ALLOWED_ROOT`. The `run` mode demonstrates these settings and the empty-install procedure automatically. A package tarball alone is insufficient: retain the compatible native optional dependency, lock, complete npm cache, scanner and DB when transferring.
