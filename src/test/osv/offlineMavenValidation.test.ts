import {expect, it} from 'vitest';
// @ts-ignore Executable validation artifact is JavaScript, separate from the shipped server.
import {MAVEN_CONTROL as c, checkMetadata, checkScan, checkFix, checkCandidates, checkExplanation, checkCapacity, checkRefusal} from '../../../scripts/validate-offline-maven.mjs';

const copy = <T>(x: T): T => structuredClone(x);
const metadata = {mode: 'offline', network_requests: false, max_age_hours: 168, warning: 'local snapshot',
  databases: [{ecosystem: 'Maven', sha256: 'a'.repeat(64), downloaded_at: '2026-11-18T00:00:00Z'}]};
const pkg = {name: c.name, version: c.version, ecosystem: 'Maven', vulnerabilities: [{id: c.id, cve: c.alias}]};
const scan = {offline_database: metadata, dependency_resolution: {transitive_resolution: 'disabled', warning: 'transitive dependencies omitted'},
  vulnerable_package_count: 1, vulnerability_count: 1, packages: [pkg]};
const suggestion = {package: c.name, current_version: c.version, ecosystem: 'Maven', verification: 'verified', candidate_check: 'clean',
  candidate_check_source: 'local_database', recommended_upgrade: '2.25.4', upgrade_note: 'local database snapshot',
  per_cve_detail: [{id: c.id, recommended_status: 'not_affected'}]};
const fix = {offline_database: metadata, dependency_resolution: scan.dependency_resolution, suggestions: [suggestion]};
const raw = {id: c.id, aliases: [c.alias], summary: 'summary', details: 'details'};
const explanation = {offline_database: metadata, requested_id: c.alias, matched_by: 'alias', ...raw, matching_record_ids: [c.id],
  affected: [{package: c.name, ecosystem: 'Maven', ranges: [{introduced: '0', fixed: '2.15.0'}]}], references: [{url: 'https://example.com/advisory'}]};
const affected = [{id: c.id, affected: [{package: {ecosystem: 'Maven', name: c.name}}]}];

it('accepts consistent scan, fix, native affected/clean and direct-alias explanation evidence', () => {
  expect(checkScan(scan, metadata)).toEqual(pkg); expect(checkFix(fix, metadata, pkg)).toEqual(suggestion);
  expect(() => checkCandidates(affected, [], pkg)).not.toThrow();
  expect(() => checkExplanation(explanation, c.alias, raw, metadata)).not.toThrow();
  expect(() => checkExplanation({...explanation, requested_id: c.id, matched_by: 'id'}, c.id, raw, metadata)).not.toThrow();
});

it.each(['digest', 'ecosystem', 'network', 'timestamp'])('rejects %s changes in DB metadata', mode => {
  const value: any = copy(metadata);
  if (mode === 'digest') value.databases[0].sha256 = 'b'.repeat(64);
  if (mode === 'ecosystem') value.databases[0].ecosystem = 'Go';
  if (mode === 'network') value.network_requests = true;
  if (mode === 'timestamp') value.databases[0].downloaded_at = '2026-11-19T00:00:00Z';
  expect(() => checkMetadata(value, metadata)).toThrow();
});

it.each(['name', 'version', 'count', 'duplicate', 'known-id', 'resolution', 'warning'])('rejects incomplete/misidentified scan evidence (%s)', mode => {
  const value: any = copy(scan);
  if (mode === 'name') value.packages[0].name = 'other:package';
  if (mode === 'version') value.packages[0].version = '1.0';
  if (mode === 'count') value.vulnerability_count++;
  if (mode === 'duplicate') {value.packages[0].vulnerabilities.push(value.packages[0].vulnerabilities[0]); value.vulnerability_count++;}
  if (mode === 'known-id') value.packages[0].vulnerabilities[0].cve = 'CVE-2000-0001';
  if (mode === 'resolution') value.dependency_resolution.transitive_resolution = 'enabled';
  if (mode === 'warning') delete value.dependency_resolution.warning;
  expect(() => checkScan(value, metadata)).toThrow();
});

it.each(['disabled', 'online', 'unverified', 'same-version', 'missing-target', 'duplicate-target', 'affected', 'no-warning'])('rejects unsupported fix claims (%s)', mode => {
  const value: any = copy(fix), s = value.suggestions[0];
  if (mode === 'disabled') s.candidate_check = 'disabled';
  if (mode === 'online') s.candidate_check_source = 'osv_api';
  if (mode === 'unverified') s.verification = 'no_verified_candidate';
  if (mode === 'same-version') s.recommended_upgrade = c.version;
  if (mode === 'missing-target') s.per_cve_detail = [];
  if (mode === 'duplicate-target') s.per_cve_detail.push(s.per_cve_detail[0]);
  if (mode === 'affected') s.per_cve_detail[0].recommended_status = 'affected';
  if (mode === 'no-warning') s.upgrade_note = 'safe';
  expect(() => checkFix(value, metadata, pkg)).toThrow();
});

it.each(['missing', 'duplicate', 'wrong-package', 'still-affected'])('requires exact initial records and an empty recommended-version native result (%s)', mode => {
  const initial: any = copy(affected), fixed: any[] = [];
  if (mode === 'missing') initial.length = 0;
  if (mode === 'duplicate') initial.push(initial[0]);
  if (mode === 'wrong-package') initial[0].affected[0].package.name = 'other:package';
  if (mode === 'still-affected') fixed.push(affected[0]);
  expect(() => checkCandidates(initial, fixed, pkg)).toThrow();
});

it.each(['id', 'alias', 'details', 'matched-by', 'missing-match', 'duplicate-match', 'related-record', 'package', 'references'])('rejects wrong explanation content or match evidence (%s)', mode => {
  const value: any = copy(explanation);
  if (mode === 'id') value.id = 'GHSA-aaaa-bbbb-cccc';
  if (mode === 'alias') value.aliases = [];
  if (mode === 'details') value.details += 'changed';
  if (mode === 'matched-by') value.matched_by = 'id';
  if (mode === 'missing-match') value.matching_record_ids = [];
  if (mode === 'duplicate-match') value.matching_record_ids.push(c.id);
  if (mode === 'related-record') value.related_records = [{id: 'GHSA-aaaa-bbbb-cccc'}];
  if (mode === 'package') value.affected[0].package = 'other:package';
  if (mode === 'references') value.references = [];
  expect(() => checkExplanation(value, c.alias, raw, metadata)).toThrow();
});

const storage = {databaseBytes: 100, totalBytes: 200, objects: 10};
const lookup = {entries: 10, expandedBytes: 1000, recordBytes: 500};
const observed = {zip_bytes: 100, cache_bytes: 100, cache_objects: 1, entries: 2, expanded_bytes: 1000, maximum_record_bytes: 500};
it('accepts capacity observations exactly at the real limits', () => {expect(() => checkCapacity(observed, storage, lookup)).not.toThrow();});
it.each(Object.keys(observed).flatMap(key => ['negative', 'over-limit', 'nonfinite'].map(mode => ({key, mode}))))('rejects invalid capacity observations ($key/$mode)', ({key, mode}) => {
  const value: any = copy(observed);
  value[key] = mode === 'negative' ? -1 : mode === 'nonfinite' ? Infinity : 10001;
  expect(() => checkCapacity(value, storage, lookup)).toThrow();
});
it.each(['success', 'wrong-kind', 'wrong-reason'])('does not count unrelated errors as cache refusal (%s)', mode => {
  const value: any = {isError: true, content: [{text: JSON.stringify({error: {kind: mode === 'wrong-kind' ? 'scan_timeout' : 'scan_failed', message: 'Offline database cache: digest mismatch'}})}]};
  if (mode === 'success') value.isError = false;
  expect(() => checkRefusal(value, mode === 'wrong-reason' ? 'manifest invalid' : 'digest mismatch')).toThrow();
});
