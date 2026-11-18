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
