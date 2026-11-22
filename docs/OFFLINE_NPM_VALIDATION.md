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

This validation establishes same-user macOS arm64 / Node 26.12.1 behavior for an npm lockfile, local candidate queries, CycloneDX input and ID/direct-alias lookup. By itself it does not establish Linux/Windows, all npm package/version combinations, artifact/build completeness, multiple DB generations or concurrency, registry publication/availability of a suggested version, an index/performance improvement (see [Indexed explanation comparison](#indexed-explanation-comparison)), or a memory upper bound. `clean` and 0 records apply only to the selected local snapshot and do not establish application safety or absence of newer advisories. Earlier Go/Maven/package records are preserved at their recorded sources.

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

### Index memory (synthetic estimate, 2026-11-21)

The completed index stays in the server process until a new generation replaces it or the server exits. The official npm DB was not available for this measurement, so the heap was measured with `scripts/measure-offline-index-memory.mjs`, which copies the index structure and `addLocation` from `943d3fc` and fills it with synthetic IDs and aliases. Values are V8 heap growth after garbage collection on macOS arm64 with Node 26.12.1. They exclude the ZIP copies and the per-request buffers. Each row is one run of `node --expose-gc scripts/measure-offline-index-memory.mjs <records> <aliases per record> <key length>`.

| Shape | Retained keys | Heap |
| --- | ---: | ---: |
| 232,645 records (the npm DB size), no aliases, 19-character keys | 232,645 | 46 MiB |
| 232,645 records, 1 alias each | 465,290 | 62 MiB |
| 232,645 records, 2 aliases each | 697,935 | 85 MiB |
| 500,000 records (the entry limit) and 500,000 aliases, 64-character keys | 1,000,000 | 188 MiB |

The last row exercises the default limits with 500,000 entries and 1,000,000 retained index entries, using 64-character keys. A generation that would exceed the index limit discards its draft and keeps using full lookups. While a new generation is being indexed, the previous index is still held, so up to two indexes can exist briefly. See the next section for real DB measurements.

### Index memory with two official npm DB generations (2026-11-22)

Prepare two npm-only caches on a connected machine using the `cache` command above. Use complete official npm ZIPs from different upstream generations with different SHA-256 digests. The harness validates both ZIPs and stages them in a disposable cache. It begins with the older manifest, then atomically selects the newer manifest in the same cache directory. Both ZIPs and their original preparation timestamps are used as supplied. The harness checks the original archives and manifests again at the end.

```bash
npm run build
scratch=$(mktemp -d)
for run in 1 2 3; do
  sandbox-exec -p '(version 1)(allow default)(deny network*)' \
    node --expose-gc scripts/measure-offline-index-native.mjs \
    --old-cache /absolute/older-npm-cache --new-cache /absolute/newer-npm-cache \
    --output "$scratch/run-$run.json" || exit 1
done
```

The measurement requires Node 26 for the observation hooks, explicit GC and a denied TCP loopback connection. Each process runs the compiled `explain_vulnerability` handler for an exact ID, an indexed alias, the same exact ID on the new generation, and an indexed alias on the new generation. The harness observes draft creation, publication and reuse through a loader hook on the compiled reader. The hook samples scalars and retains no index objects. The supplied build files stay unchanged. The record binds the sources, built artifacts and instrumented reader by hash.

A separate worker samples process RSS every 10 ms while each call is active. The harness also samples at call and index checkpoints and records the cumulative process high-water mark reported by the OS. The overlap window runs from draft creation with an old index present to new-index publication. A checkpoint immediately before publication verifies that both complete indexes are distinct and records each index's size. The per-window RSS maxima are observations at the sampling resolution. After each call, the harness drops the response and runs explicit GC twice before sampling retained RSS and V8 heap usage. Deltas use the baseline after input staging and sampler startup. The RSS includes the sampler worker, native and runtime allocations, and buffers. The post-GC heap delta measures the main isolate's overall heap growth.

#### Results

Three fresh processes ran the same workload on macOS arm64, Node v26.12.1 and checkout `83d7ddf`. Every loopback probe returned `EPERM` and every fetch counter was zero. The older ZIP was prepared on November 21 and contains 232,850 entries. The newer ZIP was prepared on November 22 and contains 232,857 entries. Full DB digests and timestamps are in the [measurement record](validation/offline-npm-index-memory-2026-11-22.json).

| Phase | Sampled peak RSS, MiB | RSS after GC, MiB | Heap growth after GC, MiB |
| --- | ---: | ---: | ---: |
| First index build | 283.0–333.3 | 253.5–321.4 | 44.1–44.4 |
| Indexed alias lookup | 307.9–325.8 | 307.9–325.8 | 44.2–44.4 |
| DB generation replacement | 331.2–377.7 | 270.1–351.9 | 44.1 |
| Indexed alias lookup after replacement | 289.8–355.5 | 270.7–353.2 | 44.1 |

Ranges cover all three processes. Initial RSS after GC was 119.3–123.2 MiB. The peak of each replacement call occurred within the overlap window in all three runs. With both indexes complete just before publication, RSS was 302.8–377.7 MiB and the main isolate heap was 136.8–155.5 MiB above baseline before GC. That checkpoint also includes memory from the full-reader pass. The cumulative OS high-water mark for the measured calls was 331.2–377.7 MiB.

The older index has 274,172 mappings over 273,976 keys. The newer one has 274,177 mappings over 273,985 keys. The older generation contributes about 0.18 additional alias mappings per ZIP record, much closer to the low end of the synthetic zero-to-two-alias model. Post-GC heap growth of about 44 MiB is close to the 46 MiB estimate for zero aliases. It returns to about the same level after replacement even when RSS remains high. The 188 MiB synthetic row describes a larger index shape and gives no process RSS ceiling.

A 256 MiB RSS budget would be exceeded on the first build and at replacement on this workload. For deployments with that budget, prioritize measuring and reducing peak allocations during the full-reader pass and overlap. Focusing on the final index alone addresses only part of the observed growth. All three measured runs fit a 512 MiB budget, so these results do not justify immediate index compaction for this npm-only, sequential workload. The measurements cover one active call at a time with one ecosystem on macOS. Multi-ecosystem caches, concurrent calls and other platforms need separate capacity measurements.

### Reader, index build and generation overlap RSS (2026-11-22)

This experiment reuses the two official npm ZIPs above and the production reader at `4d3012f`. The original measurement and its harness hash are recorded at that commit. The now-extended [harness](../scripts/measure-offline-index-native.mjs) runs three profiles in separate Node processes. All profiles go through `explain_vulnerability`, validate the private ZIP and use the same record, entry, byte and deadline limits.

| Profile | First ID lookup | Generation replacement |
| --- | --- | --- |
| `reader-only` | Full validation and response generation with draft index creation suppressed | Outside this profile |
| `baseline` | Full validation and normal index build | Normal full validation with the old index reachable during the new build |
| `drop-old` | Normal build and indexed alias lookup, as on `baseline` | Discards the cached reference after verifying the new snapshot and detecting the generation change, before creating the draft |

The last two profiles include an indexed alias lookup after each build. `drop-old` is a diagnostic candidate and runs without forced GC within the measured request. It leaves the product source and built files intact. The baseline loader adds observation only. Both diagnostic profiles alter only index creation or retention in the loader. Only single-ecosystem caches and sequential calls are exercised.

The sampler tracks the entire request, the full-reader loop, and the overlap window separately. The loop starts after ZIP directory metadata validation and ends with the final count and size check. At that point the probe records names, identity digests and expanded bytes, with draft and old index counts. Each window includes checkpoint samples as well as 10 ms worker sampling. The full-reader and overlap windows can cover the same intervals. The differences below describe observed effects of the profiles, including GC timing, temporary objects, native buffers and allocator behavior.

```bash
npm run build
scratch=$(mktemp -d)
for round in 1 2 3; do
  case "$round" in
    1) profiles='baseline reader-only drop-old' ;;
    2) profiles='drop-old baseline reader-only' ;;
    3) profiles='reader-only drop-old baseline' ;;
  esac
  for profile in $profiles; do
    sandbox-exec -p '(version 1)(allow default)(deny network*)' \
      node --expose-gc scripts/measure-offline-index-native.mjs \
      --old-cache /absolute/older-npm-cache --new-cache /absolute/newer-npm-cache \
      --profile "$profile" --output "$scratch/run-$round-$profile.json" || exit 1
  done
done
```

#### Results and 256 MiB candidates

All nine processes completed on macOS arm64 and Node v26.12.1. The OS loopback probe returned `EPERM`, and fetch count was zero in every process. For each compared lookup, the returned response digest agreed across rounds and profiles. The first generation passed 232,850 records and 393,986,236 expanded bytes through the full reader. The second passed 232,857 records and 394,027,548 bytes. Each full pass held one name and one identity entry per record at the final directory check. The [measurement record](validation/offline-npm-index-rss-breakdown-2026-11-22.json) contains the raw observations, sampled and OS high-water values, receipt digests and source/build hashes.

| Operation | Peak RSS for full request, MiB | Peak RSS within reader loop, MiB |
| --- | ---: | ---: |
| Initial lookup, full reader with no index build | 236.4–264.3 | 236.4–264.2 |
| Initial lookup, normal index build | 269.6–327.5 | 269.4–327.3 |
| Generation replacement, normal overlap | 311.1–354.8 | 311.1–354.8 |
| Generation replacement, drop old cached reference | 308.4–325.7 | 285.2–320.3 |

With normal overlap, both complete indexes were present before publication in all three runs, and the overlap window included each replacement's peak RSS. The paired extra RSS on the initial request with index construction was 33.2–68.6 MiB (median 63.1 MiB). After GC, the initial V8 heap increase was 44.1–44.4 MiB with the index and approximately zero without it. Early removal of the old cached reference reduced replacement loop peaks by 24.0–43.9 MiB (median 26.0 MiB) and full-request peaks by 2.7–29.0 MiB (median 24.0 MiB). The early-release calls still started at 308.4–325.7 MiB after the prior indexed lookup. This retained RSS helps explain the smaller improvement across the whole request.

The normal initial and replacement peaks exceed 256 MiB in all repetitions. Even the full-reader-only control exceeds it in one of three. The measurements prioritize these candidates:

1. **Reduce temporary full-reader state.** Investigate removing the per-ID digest map when exactly one archive is selected. The entry name and record ID already must agree, and the names set rejects duplicate entries within the archive. Preserve complete record validation, including depth and finite-number checks. Keep cross-archive conflict detection when multiple archives are selected. Also compare the existing chunk-copy plus concatenation path with a size-bounded assembly buffer while preserving the size, CRC, UTF-8 and deadline checks.
2. **Reduce allocations during index construction.** Measure a compact location table and alias-to-location references. Keep canonical ID priority, all direct alias matches, conflict fallback and the existing limits. Evaluate RSS during construction and after queries as well as retained V8 heap.
3. **Evaluate early release as a supplementary change.** It reduced replacement peaks in this sequential test, and every whole replacement still exceeded 256 MiB. Before adoption, check old-snapshot readers, generation reversal during refresh, and recovery from a failed build. Those cases can retain an old reference or change whether an index needs rebuilding.

Use the same 256 MiB target across initial construction, intervening lookups and replacement when evaluating candidates. This study observed process RSS under the normal runtime budget. A deployment limit, parallel lookups and multi-ecosystem caches require separate verification.
