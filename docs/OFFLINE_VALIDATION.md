# Offline scanning validation

The initial implementation supports local-database scanning and upgrade suggestions. Additional candidate rechecks and vulnerability explanations remain unavailable offline, as selected for this iteration. No experimental Gradle authority or memory-proof machinery is needed for this feature.

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

The harness first attempts a loopback connection and requires EPERM/EACCES; connection refusal or timeout is not accepted as evidence of a network restriction. It then makes Node fetch throw and counts attempts, uses the real scanner, and checks the positive and refusal cases below. It does not download databases. A platform-specific equivalent network restriction is needed to run this harness elsewhere; Windows/Linux native execution is not established by this macOS record.

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

Online runner/API/tool/server regressions were run alongside these cases: **588 passed across 33 files**, including **41 offline cases**. Type checking and the build passed. Produce the JSON test report supplied to the harness with:

```bash
npx vitest run src/test/osv src/test/tools src/test/server \
  src/test/utils/permissionCheck.test.ts --maxWorkers=1 \
  --reporter=json --outputFile=/absolute/product-regressions.json
```

`scan_java_project` and Java archive scans use the shared offline runner and have argument/cache regressions; a complete Maven database was not downloaded for this native Go validation. Cached timestamps establish time since download, not a guarantee that upstream records are exhaustive. The manifest is operator-trusted configuration and its digest is an integrity check, not an independent signature.

## Follow-up features

- Candidate-version rechecks and vulnerability explanations using local data.
- Commit-level matching, if supported by an independently selected native implementation.
- Additional native ecosystem/platform fixtures and cache storage administration.
