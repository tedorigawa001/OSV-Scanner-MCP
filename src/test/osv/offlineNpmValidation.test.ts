import {expect, it} from 'vitest';
// @ts-ignore Executable validation artifact, separate from the shipped server.
import {NPM_CONTROL as c, checkNpmScan, checkNpmFix, checkNpmCandidates, checkNpmSbom, checkNpmExplanation} from '../../../scripts/validate-offline-npm.mjs';
const copy = <T>(v: T): T => structuredClone(v);
const metadata = {mode: 'offline', network_requests: false, max_age_hours: 168, warning: 'local snapshot', databases: [{ecosystem: 'npm', sha256: 'a'.repeat(64), downloaded_at: '2026-11-18T00:00:00Z'}]};
const pkg = {name: c.name, version: c.version, ecosystem: 'npm', dependency_relation: 'direct', declared_in: ['package.json'], vulnerabilities: [{id: c.id, cve: c.alias}]};
const scan = {offline_database: metadata, dependency_resolution: {transitive_resolution: 'disabled'}, coverage: {complete: true}, vulnerable_package_count: 1, vulnerability_count: 1, packages: [pkg]};
const before = {package: c.name, ecosystem: 'npm', current_version: c.version, recommended_upgrade: '4.18.0', verification: 'verified', candidate_check: 'disabled', per_cve_detail: [{id: c.id, recommended_status: 'not_affected'}]};
const after = {...before, recommended_upgrade: '4.18.1', candidate_check: 'clean', candidate_check_source: 'local_database', upgrade_note: 'local database snapshot'};
const fix = {offline_database: metadata, dependency_resolution: scan.dependency_resolution, suggestions: [after]};
const affected = [{id: c.id, affected: [{package: {ecosystem: 'npm', name: c.name}}]}];
const rejected = [{id: 'GHSA-aaaa-bbbb-cccc', affected: [{package: {ecosystem: 'npm', name: c.name}}]}];
const raw = {id: c.id, aliases: [c.alias], summary: 'summary', details: 'details'};
const explanation = {offline_database: metadata, ...raw, requested_id: c.alias, matched_by: 'alias', matching_record_ids: [c.id],
  affected: [{package: c.name, ecosystem: 'npm', ranges: [{introduced: '0', fixed: '4.17.21'}]}], references: [{url: 'https://example.com/advisory'}]};
const sbom = {offline_database: metadata, coverage: {identified_package_count: 1, unidentified_packages: []}, packages: [pkg], identified_vulnerability_count: 1};

it('accepts a complete npm scan, explicit disabled control, reselected clean candidate, SBOM and ID/alias explanations', () => {
  expect(checkNpmScan(scan, metadata)).toEqual(pkg);
  expect(checkNpmFix(fix, metadata, pkg)).toEqual(after);
  expect(checkNpmFix({...fix, suggestions: [before]}, metadata, pkg, true)).toEqual(before);
  expect(() => checkNpmCandidates(affected, rejected, [], pkg, before, after)).not.toThrow();
  expect(() => checkNpmSbom(sbom, metadata, pkg)).not.toThrow();
  expect(() => checkNpmExplanation(explanation, c.alias, raw, metadata)).not.toThrow();
  expect(() => checkNpmExplanation({...explanation, requested_id: c.id, matched_by: 'id'}, c.id, raw, metadata)).not.toThrow();
});
it.each(['package', 'version', 'relation', 'declaration', 'count', 'duplicate', 'coverage', 'known-advisory', 'database'])('rejects invalid npm project evidence (%s)', mode => {
  const p: any = copy(scan);
  if (mode === 'package') p.packages[0].name = 'other';
  if (mode === 'version') p.packages[0].version = '4.17.21';
  if (mode === 'relation') p.packages[0].dependency_relation = 'unknown';
  if (mode === 'declaration') p.packages[0].declared_in = [];
  if (mode === 'count') p.vulnerability_count++;
  if (mode === 'duplicate') {p.packages[0].vulnerabilities.push(p.packages[0].vulnerabilities[0]); p.vulnerability_count++;}
  if (mode === 'coverage') p.coverage.complete = false;
  if (mode === 'known-advisory') p.packages[0].vulnerabilities[0].cve = 'CVE-2000-0001';
  if (mode === 'database') p.offline_database.databases[0].sha256 = 'b'.repeat(64);
  expect(() => checkNpmScan(p, metadata)).toThrow();
});
it.each(['disabled', 'online', 'same-version', 'lower-version', 'invalid-version', 'missing-target', 'duplicate-target', 'affected', 'unverified'])('rejects incorrect fix evidence (%s)', mode => {
  const p: any = copy(fix), s = p.suggestions[0];
  if (mode === 'disabled') s.candidate_check = 'disabled';
  if (mode === 'online') s.candidate_check_source = 'osv_api';
  if (mode === 'same-version') s.recommended_upgrade = c.version;
  if (mode === 'lower-version') s.recommended_upgrade = '1.0.0';
  if (mode === 'invalid-version') s.recommended_upgrade = 'latest';
  if (mode === 'missing-target') s.per_cve_detail = [];
  if (mode === 'duplicate-target') s.per_cve_detail.push(s.per_cve_detail[0]);
  if (mode === 'affected') s.per_cve_detail[0].recommended_status = 'affected';
  if (mode === 'unverified') s.verification = 'no_verified_candidate';
  expect(() => checkNpmFix(p, metadata, pkg)).toThrow();
});
it.each(['missing-current', 'duplicate-current', 'wrong-package', 'empty-rejection', 'already-known-only', 'fixed-affected', 'same-reselection', 'lower-reselection'])('does not accept unsupported native candidate/reselection claims (%s)', mode => {
  const a: any = copy(affected), b: any = copy(rejected), f: any[] = [], selected = {...after};
  if (mode === 'missing-current') a.length = 0;
  if (mode === 'duplicate-current') a.push(a[0]);
  if (mode === 'wrong-package') b[0].affected[0].package.name = 'other';
  if (mode === 'empty-rejection') b.length = 0;
  if (mode === 'already-known-only') b[0].id = c.id;
  if (mode === 'fixed-affected') f.push(b[0]);
  if (mode === 'same-reselection') selected.recommended_upgrade = before.recommended_upgrade;
  if (mode === 'lower-reselection') selected.recommended_upgrade = '4.17.21';
  expect(() => checkNpmCandidates(a, b, f, pkg, before, selected)).toThrow();
});
it.each(['identity', 'unidentified', 'count', 'missing-record', 'duplicate-record'])('rejects partial/misidentified SBOM evidence (%s)', mode => {
  const v: any = copy(sbom);
  if (mode === 'identity') v.packages[0].version = '1.0.0';
  if (mode === 'unidentified') v.coverage.unidentified_packages.push({name: 'unknown'});
  if (mode === 'count') v.identified_vulnerability_count = 0;
  if (mode === 'missing-record') v.packages[0].vulnerabilities = [];
  if (mode === 'duplicate-record') v.packages[0].vulnerabilities.push(v.packages[0].vulnerabilities[0]);
  expect(() => checkNpmSbom(v, metadata, pkg)).toThrow();
});
it.each(['id', 'alias', 'details', 'summary', 'matched-by', 'match-list', 'related', 'package', 'references'])('rejects incorrect explanation details or matching (%s)', mode => {
  const v: any = copy(explanation);
  if (mode === 'id') v.id = 'GHSA-aaaa-bbbb-cccc';
  if (mode === 'alias') v.aliases = [];
  if (mode === 'details') v.details = 'different';
  if (mode === 'summary') v.summary = 'different';
  if (mode === 'matched-by') v.matched_by = 'id';
  if (mode === 'match-list') v.matching_record_ids.push(v.id);
  if (mode === 'related') v.related_records = [{id: 'GHSA-aaaa-bbbb-cccc'}];
  if (mode === 'package') v.affected[0].ecosystem = 'Go';
  if (mode === 'references') v.references = [];
  expect(() => checkNpmExplanation(v, c.alias, raw, metadata)).toThrow();
});
