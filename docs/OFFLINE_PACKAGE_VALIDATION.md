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

The `prepare` mode requires 22.13.0 plus representative 24/26 executables and a Node 20 negative control. It stores relative paths for the copied executables, a local `file:../application.tgz` dependency, npm itself and all other inputs. `kit.json` records the source/config hashes, expected package files and transfer-input digests. Run mode verifies the transferred runner itself against the prepared source hash, verifies the inputs, and copies the cache into its disposable working directory so repeat runs do not mutate the kit.

Copy the entire kit to another location/machine. The standalone runner then needs only the kit; it can run from an unrelated working directory. A regression JSON report is optional and must be separately transferred if `--test-report` is used. The final recorded run supplied the passing source-side report.

```bash
cp -R /absolute/kit /absolute/transferred-kit
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  /absolute/transferred-kit/runtimes/v26.12.1/bin/node \
  /absolute/transferred-kit/validate-offline-package.mjs run \
  --kit /absolute/transferred-kit --output /absolute/package-record.json
```

For the stronger original-input-denial reproduction, extend the profile with `(deny file-read* (subpath "/absolute/source"))` for each original root, and pass `--denied-path checkout=/absolute/source/package.json` (repeatable, `<domain>=<absolute path>`) for a known original path in each root. Include the original kit, Node, scanner, npm cache and DB roots as well as the checkout. Keep the output/report paths outside the denied roots. The record stores only each domain label and its error, not the host path. Run on macOS with an effective profile; an equivalent OS policy is needed elsewhere, and these results do not establish Linux/Windows installation or execution.

For actual deployment, use the kit's consumer manifest/lock and `application.tgz` in their relative layout, and invoke the supplied Node/npm with:

```bash
/absolute/kit/runtimes/v22.13.0/bin/node /absolute/kit/tooling/npm/bin/npm-cli.js \
  ci --offline --omit=dev --ignore-scripts --no-audit --no-fund --engine-strict \
  --cache /absolute/kit/npm-cache
```

Run this from `kit/consumer`, then launch its installed binary with the selected Node on PATH and explicit `OSV_SCANNER_PATH`, `OSV_MCP_OFFLINE=1`, `OSV_MCP_OFFLINE_DB_DIR` and `OSV_MCP_ALLOWED_ROOT`. The `run` mode demonstrates these settings and the empty-install procedure automatically. A package tarball alone is insufficient: retain the compatible native optional dependency, lock, complete npm cache, scanner and DB when transferring.
