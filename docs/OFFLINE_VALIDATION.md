# Offline scanning validation

Offline mode supports local-database scanning, upgrade suggestions and candidate-version rechecks. Vulnerability explanations remain unavailable offline. No experimental Gradle authority or memory-proof machinery is needed for this feature. The earlier records below document the initial implementation, when candidate rechecks were disabled.

## Reproduction

Build the checkout and prepare a complete database on a connected machine:

```bash
npm ci
npm run build
node dist/index.js cache --ecosystems Go --directory /absolute/cache
```

The cache command downloads only the official public ecosystem ZIP. Transfer the full cache directory and provision OSV-Scanner 2.7.0 plus the server/dependencies separately. Database ZIPs are not bundled with the npm package or committed to this repository.

On macOS, the native harness requires an effective OS network-deny profile, inherited by the scanner:

```bash
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  node scripts/validate-offline.mjs \
  --cache /absolute/cache \
  --binary /absolute/osv-scanner \
  --test-report /absolute/product-regressions.json \
  --output /absolute/offline-validation.json
```

The harness first attempts a loopback connection and requires EPERM/EACCES; connection refusal or timeout is not accepted as evidence of a network restriction. It then makes Node fetch throw and counts attempts, uses the real scanner, and checks the positive and refusal cases below. It does not download databases. Before scanning, it exercises collection on a disposable cache by replaying the prepared official Go ZIP from a local stream through an injected updater transport. This is an explicit updater test, not automatic preparation during an offline scan; the original download timestamp is preserved. The input cache is not modified. A platform-specific equivalent network restriction is needed to run this harness elsewhere; Windows/Linux native execution is not established by this macOS record.

## Local candidate rechecks (2026-11-18)

`suggest_fix` now uses the same candidate-reselection algorithm for online queries and offline native scans. For each offline candidate, it creates a private, versioned single-component CycloneDX SBOM and scans it with `--offline --no-resolve --all-packages --no-ignore` and only that ecosystem's DB. The native result must identify exactly the requested package/version, refer to the private SBOM, and provide the vulnerability details for every reported group. An empty/unidentified result or incomplete details fail the request rather than producing `clean`.

The candidate DB is copied and verified independently for every query. Its digest and download timestamp must match the project scan; the original acquisition time must remain within the configured age limit before and after the native query. Invalid, expired or changed DBs fail the whole tool request, including changes between the project scan and candidate check. There is no online fallback. Each candidate query runs sequentially, uses the normal scanner timeout and temporary-space limits, and consumes the existing query budgets (default 4/package and 60/call). The local native scan/copy overhead is additional to the project scan. A budget limit yields `skipped`; an explicit opt-out yields `disabled`.

`candidate_check_source: "local_database"` identifies local results. `clean` retains the established meaning of no additional fix-target advisories, with a local snapshot warning; known unfixed/informational advisories can remain. Newly detected advisories can trigger reselection or `has_known_vulnerabilities`; conflicting evidence can withhold the candidate as `conflict`. None of these states establishes the absence of newer advisories.

The [candidate-check native record](validation/offline-candidates-2026-11-18.json) records the same prepared official Go ZIP as the preceding rerun (12,939,080 bytes, SHA-256 `362a3ad67c80a9bd9333fc60d6e300c178e00741a605cd79788974fa29230784`) under OS network denial. It preserves both earlier records as historical evidence. Run the reproduction above with `--output docs/validation/offline-candidates-2026-11-18.json` to produce the expanded record.

| Case | Observed result |
|---|---|
| OS network control / Node fetch calls | EPERM / 0 |
| `scan_project` / `scan_sbom`, `golang.org/x/text` 0.3.0 | 5 vulnerability groups each |
| `suggest_fix`, same project | 0.41.0 recommended; `candidate_check: clean`, `candidate_check_source: local_database` |
| Direct native candidate controls | 0.3.0 affected; 0.41.0 has no matching records |
| Missing manifest/object, expired/future DB, truncation, same-size digest modification, invalid origin | 7 cases rejected by each of 3 tools and the candidate query: 28 refusals |
| Object collection | Orphan/interrupted download removed; selected DB and active private copy preserved |
| `explain_vulnerability` | Still unavailable offline; no fallback |

The affected-version control returns both GO and GHSA records for some of the same advisories; its record ID list is not a count of unique vulnerabilities. Native matching is demonstrated for Go on macOS with the same user, not every ecosystem/platform. Regression fixtures cover PURL/identity handling for Maven, npm (including scopes), PyPI, Go, crates.io, Packagist and NuGet; those fixtures are not complete real databases.

`src/test/osv/offlineCandidateCheck.test.ts` initially added 37 regressions: local clean/reselection/unfixed/conflict results; strict native identification and complete details; DB changes after the project scan and expiry during a query; explicit/environment opt-out, query limits, forced offline routing, unrelated expired DB isolation, bounded identities, all seven PURL mappings and cleanup. The first local-clean test failed before implementation (`disabled` instead of `clean`). The alias review correction below adds another 6 local cases, bringing that file to 43. The existing 44 offline cases retain their cache/collection controls; the former automatic-disable assertion now verifies the explicit opt-out.

The combined runner/API/tool/server regression set passed **638 tests across 34 files**, including 43 local-candidate cases, 31 online-candidate cases and 44 existing offline cases. Type checking, build and harness syntax checks passed. The native record binds their JSON report digest and case lists alongside the source hashes.

### Alias review correction (2026-11-18)

The first implementation updated its known-ID set while walking each query response. If a new advisory appeared as both a GO and GHSA record, the second record incorrectly looked like a conflict with an already known target. It could also lose the second record's fixed-version/range evidence, making reselection depend on record order. The corrected common algorithm snapshots the known-ID set before processing each query's records. All new records contribute their complete fix/range evidence; their IDs become known for subsequent queries. Initial targets and targets learned in earlier queries still produce `conflict` when a supposedly fixed candidate is reported affected.

Six local regressions cover both orders of the unfixed alias pair, both orders with different fixed boundaries (1.6.0 and 1.7.0), an initially known alias and an advisory learned in an earlier query. Before the fix, 3 failed and 3 passed as controls; after the fix, all 6 passed. Four online regressions verify the same unfixed/range-preservation behavior in both orders through the shared algorithm. Alias records are not discarded: both IDs and all affected ranges are retained.

The native harness now also generates four small synthetic Go OSV ZIPs with [offline-alias-fixtures.mjs](../scripts/offline-alias-fixtures.mjs) and runs the real OSV-Scanner on `example.com/lib` 1.0.0 under the same OS network denial. These fixtures are independent of the complete official Go DB above and are explicitly marked `synthetic-Go-OSV-database-real-scanner` in the record. Each control records its generated ZIP SHA-256, actual first-candidate record IDs, expected/actual recommendation and status, and selected DB metadata. Fixture preparation uses injected local bytes, not a remote download.

| Synthetic native control | Observed result |
|---|---|
| Single new advisory without a fix | 1.5.0 retained, `has_known_vulnerabilities` |
| Same new advisory as GO/GHSA aliases | 1.5.0 retained, `has_known_vulnerabilities`; both record IDs preserved |
| GO/GHSA records with fixed boundaries 1.6.0 / 1.7.0 | 1.7.0 selected, `clean` |
| Alias already known from the initial scan, with conflicting range evidence | Recommendation withheld, `conflict` |

The complete official Go DB still detects the original vulnerable project and rechecks 0.41.0 as `clean`; all 28 invalid-DB refusals and collection controls still pass. The final expanded run records EPERM and 0 Node fetch calls. It establishes same-user native Go behavior on macOS with both official and synthetic databases; it does not establish native matching for every ecosystem or platform.

## Pre-candidate-check native observation (2026-11-18)

Rebuilt the current source based on `dc3d9bb`, including the object collector added in `67c405c`, and ran the expanded harness under macOS OS-level network denial. The official Go database was prepared separately with the real `cache` CLI before denying network access. It was **12,939,080 bytes**, SHA-256 `362a3ad67c80a9bd9333fc60d6e300c178e00741a605cd79788974fa29230784`, downloaded at `2026-11-18T04:00:02.348Z`.

| Case | Observed result |
|---|---|
| OS network control / Node fetch calls | EPERM / 0 |
| Object collection before local ZIP replay | Unreferenced object and interrupted `.download-*` removed; selected DB retained |
| Selected DB and pre-existing private snapshot after collection | Both SHA-256 digests unchanged |
| `scan_project`, `golang.org/x/text` 0.3.0 | 5 vulnerabilities |
| `suggest_fix`, same project | 0.41.0 recommended; candidate check disabled, with explicit offline note |
| `scan_sbom`, same Go package | 5 vulnerabilities |
| Missing manifest, missing object, expired, future-dated, truncated, same-length digest modification, invalid origin | All 7 rejected by each of the 3 tools: 21 refusals, all `scan_failed` cache errors |
| `explain_vulnerability` | Offline-unavailable error; no API fallback |

The [2026-11-18 native record](validation/offline-2026-11-18.json) binds the current source and harness hashes, Node/scanner images, database manifest, collection observations and regression summary. All three positive tool results include the same selected offline database metadata. The digest-modification case changes one byte of the full ZIP without changing its length, separately from the truncated-file case. Refusals must identify the cache failure rather than an unrelated tool error.

The collection control makes **one injected local replay request**, verifies that collection has already completed before serving that stream, and retains the original selected digest and acquisition timestamp. It confirms the collector's filesystem behavior using a real official ZIP, not a new remote generation or a concurrent cross-process refresh. Repeated generations, failed refreshes, unknown entries and update-lock contention remain covered by the unit regressions. Native execution is still limited to Go, macOS and the same user; this run does not establish Maven, other ecosystems or other platforms.

The relevant product regressions passed: **591 tests across 33 files**, including **44 offline cases** and all 3 collection regressions. Type checking, build and harness syntax checks passed. The older record below remains unchanged as historical evidence.

## Native observation (2026-11-16)

The official Go ZIP was 12,927,125 bytes, SHA-256 `ec23ddc864d60acd259bf9f0c6b7258206de5cfe6231e66256167b76a88eaaeb`. Its bytes were fetched on the connected preparation step, then read from verified private copies with network access denied. The application uses the native 2.7.0 `osv-scalibr/<ecosystem>/all.zip` layout inside those private snapshots; its managed persistent object layout is separate from the scanner's own cache.

| Case | Observed result |
|---|---|
| OS network control | EPERM |
| Node fetch calls during offline operations | 0 |
| `scan_project`, `golang.org/x/text` 0.3.0 | 5 vulnerabilities |
| `suggest_fix`, same project | 0.41.0 recommended; candidate check disabled with offline explanation |
| `scan_sbom`, same Go package | 5 vulnerabilities |
| `explain_vulnerability` | Offline-unavailable error; no API fallback |
| Missing, expired and corrupt DB caches | All rejected, never successful empty scans |

The machine-readable [native record](validation/offline-2026-11-16.json) binds the runtime, scanner image, downloaded DB, source hashes and observations. Public DB contents change over time: newly prepared DBs may yield different counts or recommendations, which should be evaluated against their recorded digests and download timestamps.

## Regression scope

`src/test/osv/offline.test.ts` covers strict mode/age settings; full offline flags in every scanner mode; API and automatic-download refusal; immutable object publication and private-copy verification; missing, changed, truncated, expired, future-dated, duplicate and invalid-origin evidence; symlink rejection; partial HTTP response refusal; updater serialization; manifest preservation on refresh failure; selected-ecosystem isolation; spoofed output metadata; VCS refusal; and explicit candidate-check suppression. These unit tests use small transport fixtures, not a full vulnerability database. Native ZIP parsing and matching are established separately with the complete official Go database.

Online runner/API/tool/server regressions were run alongside these cases: the initial run had **588 passed across 33 files**, including **41 offline cases**; the current 2026-11-18 run has **591 passed across 33 files**, including **44 offline cases** after adding collection regressions. Type checking and the build passed. Produce the JSON test report supplied to the harness with:

```bash
npx vitest run src/test/osv src/test/tools src/test/server \
  src/test/utils/permissionCheck.test.ts --maxWorkers=1 \
  --reporter=json --outputFile=/absolute/product-regressions.json
```

`scan_java_project` and Java archive scans use the shared offline runner and have argument/cache regressions; a complete Maven database was not downloaded for this native Go validation. Cached timestamps establish time since download, not a guarantee that upstream records are exhaustive. The manifest is operator-trusted configuration and its digest is an integrity check, not an independent signature.

## Object collection (2026-11-16)

Refreshes previously never removed DB objects, so the default 168-hour refresh cycle would eventually exhaust the 128-object/2 GiB cache limit and make every later refresh fail. A refresh now removes, under the update lock and before downloading, the objects that the selected manifest no longer references and interrupted `.download-*` files. The selected generation remains readable for running scans. Three regressions cover six consecutive refreshes (always the selected plus previous generation), collection of a failed partial run's object and an interrupted download, and preservation and rejection of unknown entries. The first two failed before the change and the third is a control. The product regression set above now has **591 passed across 33 files**, including **44 offline cases**.

The original native record predates collection and binds its own source hashes. The separate 2026-11-18 record above now covers the current collector and fresh complete Go database under network denial; the original record has not been overwritten or rebound to changed sources.

## Follow-up features

- Vulnerability explanations using local data (candidate-version rechecks are now implemented).
- Commit-level matching, if supported by an independently selected native implementation.
- Additional native ecosystem/platform fixtures and cache storage administration.
