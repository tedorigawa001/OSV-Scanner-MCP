# npm database validation under network denial

The [npm harness](../scripts/validate-offline-npm.mjs) validates the complete official npm DB with the real scanner, local candidate reselection and ID/direct-alias explanations. Connected preparation is separate. The runner requires an OS network-deny profile, makes Node fetch throw/counts calls and checks the selected DB metadata throughout. It does not install or execute the fixture's vulnerable dependency.

## Reproduction

With development dependencies and OSV-Scanner 2.7.0 already provisioned, build the checkout and prepare an npm-only cache on a connected machine:

```bash
npm run build
node dist/index.js cache --ecosystems npm --directory /absolute/npm-database
npx vitest run src/test/osv src/test/tools src/test/server \
  src/test/utils/permissionCheck.test.ts --maxWorkers=1 \
  --reporter=json --outputFile=/absolute/npm-regressions.json
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  node scripts/validate-offline-npm.mjs \
  --cache /absolute/npm-database --binary /absolute/osv-scanner \
  --test-report /absolute/npm-regressions.json \
  --output /absolute/offline-npm-validation.json
```

The loopback TCP control must fail with EPERM/EACCES. Refusal or timeout from a reachable network does not qualify. The same OS restriction is inherited by the scanner. Neither the harness nor the product downloads anything during validation; the only download is the preceding explicit cache command. The source input cache is left unchanged and its manifest/object digest are checked again at the end.

## Recorded database and capacity

The [record](validation/offline-npm-2026-11-18.json) uses the complete `https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip`, acquired by the real CLI at `2026-11-18T09:10:19.742Z`. SHA-256 is `3c5b93576d37e8b6ffeda671cddb4861b088a41798dde5f692ad400efad421ac`, the same bytes used in the earlier direct explanation investigation. The acquisition timestamp belongs to this preparation; no later timestamp is substituted during scans or candidate checks.

| Capacity | Observed | Existing limit |
|---|---:|---:|
| ZIP bytes | 221,682,569 | 536,870,912 (512 MiB) |
| Prepared cache object bytes | 221,682,569 | 2,147,483,648 (2 GiB) |
| Cache objects | 1 | 128 |
| JSON entries | 232,645 | 500,000 |
| Expanded bytes | 393,280,543 | 2,147,483,648 (2 GiB) |
| Largest record bytes | 1,148,610 | 4,194,304 (4 MiB) |

The header inventory is collected from a verified private copy, including the raw target advisory and four named non-OSV-alias controls. Actual explanation requests subsequently read every entry body through the product's ZIP/ZIP64, directory, CRC, JSON, identity and digest checks. No DB subset or higher size/entry/time limit is used. Per-lookup time remains 120 seconds; `elapsed_ms` records handler/native-query spans, not a whole-harness performance comparison or a physical-memory bound.

## Vulnerable project and candidate reselection

The owned [package manifest](../src/test/fixtures/offline-npm/package.json) and [lockfile](../src/test/fixtures/offline-npm/package-lock.json) declare only `lodash` 4.17.20. They are copied into a disposable project. The scanner reads a private sanitized lockfile; no dependency tarball is downloaded and `npm install` is not run. The normal relationship metadata reports a direct dependency declared in `package.json`.

| Control | Observed result |
|---|---|
| `scan_project`, lodash 4.17.20 | 4 vulnerability groups, `dependency_relation: direct`, `declared_in: ["package.json"]` |
| `suggest_fix`, explicitly disabled candidate check | Initial range-based candidate 4.18.0, `candidate_check: disabled` |
| `suggest_fix`, normal local candidate checks | Reselects 4.18.1, `verification: verified`, `candidate_check: clean`, `candidate_check_source: local_database` |
| Direct native query, 4.17.20 | Same 4 advisory record IDs as the project scan |
| Direct native query, initial candidate 4.18.0 | `GHSA-f23m-r3pf-42rh`, not present in the initial scan |
| Direct native query, selected 4.18.1 | 0 records |
| `scan_sbom`, same package/version in CycloneDX | Same package and 4 advisory IDs |

The initial project findings include `GHSA-35jh-r3h4-6jhm` / `CVE-2021-23337`, plus the other advisories in this DB generation. The harness does not hardcode a finding count or recommended version: it binds package/version, known advisory, full ID sets and metadata, checks upgrade ordering and verifies that a newly discovered candidate advisory actually forces reselection. The observed counts/versions above describe this snapshot; a changed upstream DB can require reassessing the controls.

The explicitly disabled run is a control, not the default behavior. The enabled suggestion verifies all initial targets as `not_affected`, and direct real-scanner queries independently confirm the initial/current/reselected version outcomes against the same database digest and timestamp. The current product uses private, versioned single-component CycloneDX files for these queries. An API response or a formatter-only mock is not substituted.

## ID/alias explanations and refusal cases

`explain_vulnerability` retrieves `GHSA-35jh-r3h4-6jhm` by exact ID and retrieves the same canonical record via `CVE-2021-23337`. Matching IDs, displayed aliases, summary and details are checked against the actual canonical JSON read from the ZIP, including normal display truncation. Both explanations must agree on all fields apart from `requested_id` / `matched_by`, including DB metadata. The record saves details length/digest, affected ranges, references and handler-call elapsed time.

The archive includes the four named records from the non-OSV-alias investigation: `GHSA-5xf4-f2fq-f69j`, `GHSA-pg97-ww7h-5mjr`, `MAL-2025-3060`, `MAL-2025-3519`. Their malformed/overlong SNYK aliases are recorded as public upstream data. Full successful lookups demonstrate that these unrelated aliases do not poison the search. They are not used as accepted query IDs: requesting the malformed `SNYK-JS-YARN-537806,` is rejected as `invalid_vulnerability_id` even with a nonexistent cache, while `CVE-2999-999999` completes the full search and returns snapshot-scoped `vulnerability_not_found` with metadata.

| Refusal/control | Result |
|---|---|
| Missing manifest/object, expired/future DB, truncated object, same-size digest change, invalid origin, oversized manifest claim | 8 cases × 4 public tools plus direct candidate query = 40 cache-specific `scan_failed` refusals |
| Malformed alias request | `invalid_vulnerability_id` before cache access |
| Entry budget lowered to 1 | `output_too_large`, not a partial explanation or a local miss |
| OS network control / Node fetch calls | EPERM / 0 |
| Original prepared cache | Manifest and object digest unchanged |

The four public negative paths are `scan_project`, `suggest_fix`, `scan_sbom` and `explain_vulnerability`; `scan_java_project` is not an npm input path. Every refusal must identify the expected cache failure rather than an unrelated scanner error. The oversized control changes only manifest metadata to `512 MiB + 1` and is refused before object access; it does not claim to transfer an oversized file. Metadata/freshness/generation mismatch checks remain in the product's existing candidate logic.

## Evidence and scope

The record binds the reachable product source closure, fixture and assertion code, the shared Maven harness helpers, package/lock/config bytes, compiled JavaScript artifacts and runtime/scanner/ZIP-reader images. All saved file references are repository-relative; host paths are not included. Source-bound evidence is separate from the earlier npm direct measurement, which did not use OS network denial.

The 41 new harness regressions reject incorrect package/version/relation/declaration metadata, wrong DB generation or counts, missing/duplicate fix targets, online/disabled/unverified claims, absent candidate-rejection evidence, still-affected final versions, incorrect SBOM identities and mismatched explanation content. The combined relevant run passes **836 tests in 38 files**, with type checking, build and harness syntax checks. These fixtures test the assertions; the separate native record uses the real full DB and scanner.

This establishes same-user macOS arm64 / Node 26.12.1 behavior for an npm lockfile, local candidate queries, CycloneDX input and ID/direct-alias lookup. It does not establish Linux/Windows, all npm package/version combinations, artifact/build completeness, multiple DB generations or concurrency, registry publication/availability of a suggested version, an index/performance improvement, or a memory upper bound. `clean` and 0 records apply only to the selected local snapshot and do not establish application safety or absence of newer advisories. Earlier Go/Maven/package records are preserved at their recorded sources.

## Indexed explanation comparison

`explain_vulnerability` keeps one completed index per process. Its key includes the configured cache directory and the ordered list of ecosystem names, download timestamps and ZIP SHA-256 digests. The first lookup checks every archive and builds the index from validated record identities, direct aliases and ZIP entry locations. Publication follows the final deadline and freshness check after private-copy cleanup. The index retains at most one million record-to-ID or record-to-alias mappings and stores ZIP locations and conflict markers. Larger mappings use the full reader; matching IDs with conflicting copies and calls with reduced test limits also use the full reader.

Each indexed request still validates the manifest, timestamps and entire SHA-256 of each private copy. It reads and checks the length, CRC, UTF-8 and identity of matching records, and retains the same ordering, deduplication and result limits. The index is rebuilt after a restart or cache generation change. The benchmark calls the real explanation handler, which does not require an OSV-Scanner binary.

The original lookup deadline covers waiting for ZIP closure and private-copy cleanup. On expiry the reader requests closure and cleanup, returns `scan_timeout`, and releases the scan and index-build slots. A timed-out draft is discarded. A late ZIP notification cannot publish a result or affect a later lookup.

Prepare an official npm-only DB while connected with the command above. Build both versions with the same Node and installed dependencies. The baseline for this comparison is `3ec9042`.

```bash
repo=$(pwd -P)
scratch=$(mktemp -d)
mkdir "$scratch/baseline"
git archive 3ec9042 src package.json tsconfig.json tsconfig.build.json | tar -xf - -C "$scratch/baseline"
ln -s "$repo/node_modules" "$scratch/baseline/node_modules"
./node_modules/.bin/tsc -p "$scratch/baseline/tsconfig.build.json"
npm run build
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  node scripts/compare-offline-explain-index.mjs \
  --before "$scratch/baseline/dist" --after "$repo/dist" \
  --cache /absolute/npm-database --output "$scratch/comparison.json"
```

The harness requires a denied loopback TCP connection and zero fetch attempts. It measures the first ID lookup in each build, then three pairs for each of ID, direct alias and unlisted ID. It alternates the order of the builds and rotates the case order. Each sample includes the handler's manifest read, private ZIP copy and SHA-256, lookup, cleanup and response creation. The harness compares complete responses for every pair and checks expiry and same-size corruption for both a present ID and an unlisted ID in each build. Faults are applied only to a disposable private copy of the supplied cache. Duplicate-ID conflict cases use separate multi-ecosystem fixtures in the regression tests.

The output uses an atomic replacement and a fresh `run_id`. The harness writes `running` before preflight and records the pending trial before each call. If the watchdog fires, the handler fails verification, or the run receives `SIGINT` or `SIGTERM`, the report is saved as `failed` with the last step, failure reason, and completed pairs. After the initial checkpoint, a hard kill leaves the new run marked `running` with its last checkpoint. Completed comparisons have `status: "passed"`.

### Recorded result (2026-11-21)

The run used macOS arm64, Node 26.12.1 and one complete 222,033,893-byte official npm ZIP acquired at `2026-11-21T06:39:24.687Z`. The recorded SHA-256 was `85f24f6f0d7437e38a8361025a8c2a189f1d01b499bd11868bc82a0175cbae7b`.

| Lookup | Before | After |
| --- | ---: | ---: |
| First ID call, including index construction in the new build | 21.289 s | 20.658 s |
| Subsequent ID, median of 3 | 27.632 s | 0.701 s |
| Subsequent alias, median of 3 | 24.837 s | 0.378 s |
| Subsequent unlisted ID, median of 3 | 32.078 s | 0.540 s |

All ten paired responses were equal and all eight expiry and corruption checks returned `scan_failed`. The loopback probe returned `EPERM` and the fetch count was zero. The successful rerun uses the original baseline and the revised reader, with both build orders represented for each repeated case. It records the npm-only, same-process workload on this host. The [comparison record](validation/offline-npm-index-2026-11-21.json) contains the sample timings, response digests, refusal outcomes and source and build hashes.

An earlier exploratory comparison was stopped with a ZIP still open. Its precise stopping point was not captured. The regression tests withhold the ZIP close notification on a cold and an indexed call and either deliver it late or omit it. They verify `scan_timeout` at the original deadline, reuse of the scan slot, and that the next cold call can rebuild the discarded index. A separate test delays private-copy removal. The CLI regressions start with an older successful report, finish one pair, and then exercise the watchdog, SIGINT, SIGTERM, and a `scan_timeout` result from the handler. They check the new run ID, the interrupted trial, and preservation of the completed pair.
