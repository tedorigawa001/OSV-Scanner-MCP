/** Complete official npm DB, real scanner and local ID/alias lookup under mandatory OS network denial. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp, realpath, readFile, writeFile, mkdir, rm, readdir, stat} from 'node:fs/promises';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {openPromise} from 'yauzl';
import semver from 'semver';
import {checkMetadata, checkCapacity, checkRefusal} from './validate-offline-maven.mjs';

export const NPM_CONTROL = Object.freeze({name: 'lodash', version: '4.17.20', id: 'GHSA-35jh-r3h4-6jhm', alias: 'CVE-2021-23337'});
const ALIAS_CONTROLS = ['GHSA-5xf4-f2fq-f69j', 'GHSA-pg97-ww7h-5mjr', 'MAL-2025-3060', 'MAL-2025-3519'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function image(file) {const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex');}
const ids = records => records.map(r => r.id).sort();
const payload = r => {assert.notEqual(r.isError, true, r.content[0]?.text); return JSON.parse(r.content[0].text);};
export function checkNpmScan(report, metadata) {
  checkMetadata(report.offline_database, metadata); assert.equal(report.dependency_resolution?.transitive_resolution, 'disabled');
  assert.equal(report.coverage?.complete, true); assert.equal(report.vulnerable_package_count, 1); assert.equal(report.packages.length, 1);
  const pkg = report.packages[0];
  assert.equal(pkg.name, NPM_CONTROL.name); assert.equal(pkg.version, NPM_CONTROL.version); assert.equal(pkg.ecosystem, 'npm');
  assert.equal(pkg.dependency_relation, 'direct'); assert.deepEqual(pkg.declared_in, ['package.json']);
  assert.equal(pkg.vulnerabilities.length, report.vulnerability_count); assert.ok(report.vulnerability_count > 0);
  assert.equal(new Set(ids(pkg.vulnerabilities)).size, pkg.vulnerabilities.length);
  assert.ok(pkg.vulnerabilities.some(v => v.id === NPM_CONTROL.id && v.cve === NPM_CONTROL.alias));
  return pkg;
}
export function checkNpmFix(report, metadata, original, disabled = false) {
  checkMetadata(report.offline_database, metadata); assert.equal(report.dependency_resolution?.transitive_resolution, 'disabled');
  assert.equal(report.suggestions.length, 1); const s = report.suggestions[0];
  assert.equal(s.package, NPM_CONTROL.name); assert.equal(s.ecosystem, 'npm'); assert.equal(s.current_version, NPM_CONTROL.version);
  assert.equal(s.verification, 'verified'); assert.ok(semver.valid(s.recommended_upgrade) && semver.gt(s.recommended_upgrade, s.current_version));
  assert.equal(s.candidate_check, disabled ? 'disabled' : 'clean');
  if (!disabled) {assert.equal(s.candidate_check_source, 'local_database'); assert.match(s.upgrade_note, /local database snapshot/);}
  assert.deepEqual(ids(s.per_cve_detail), ids(original.vulnerabilities)); assert.ok(s.per_cve_detail.every(v => v.recommended_status === 'not_affected'));
  return s;
}
export function checkNpmCandidates(affected, rejected, fixed, pkg, before, after) {
  assert.deepEqual(ids(affected), ids(pkg.vulnerabilities));
  for (const records of [affected, rejected]) assert.ok(records.every(r => r.affected.some(a => a.package?.ecosystem === 'npm' && a.package.name === NPM_CONTROL.name)));
  assert.ok(rejected.length > 0); assert.ok(rejected.some(r => !ids(pkg.vulnerabilities).includes(r.id)));
  assert.deepEqual(fixed, []); assert.ok(semver.gt(after.recommended_upgrade, before.recommended_upgrade));
}
export function checkNpmSbom(value, metadata, pkg) {
  checkMetadata(value.offline_database, metadata); assert.equal(value.coverage?.identified_package_count, 1);
  assert.deepEqual(value.coverage.unidentified_packages, []); assert.equal(value.packages.length, 1);
  const p = value.packages[0]; assert.equal(p.name, pkg.name); assert.equal(p.version, pkg.version); assert.equal(p.ecosystem, 'npm');
  assert.deepEqual(ids(p.vulnerabilities), ids(pkg.vulnerabilities)); assert.equal(value.identified_vulnerability_count, pkg.vulnerabilities.length);
}
export function checkNpmExplanation(value, requested, raw, metadata) {
  checkMetadata(value.offline_database, metadata); assert.equal(value.requested_id, requested);
  assert.equal(value.matched_by, requested === raw.id ? 'id' : 'alias'); assert.equal(value.id, raw.id);
  assert.deepEqual(value.matching_record_ids, [raw.id]); assert.ok(!value.related_records?.length);
  assert.deepEqual(value.aliases, raw.aliases.slice(0, 20));
  assert.equal(value.details, raw.details.length > 4000 ? raw.details.slice(0, 4000) + '…' : raw.details); assert.ok(value.details.length);
  assert.equal(value.summary, raw.summary.length > 500 ? raw.summary.slice(0, 500) + '…' : raw.summary);
  assert.ok(value.affected.some(a => a.package === NPM_CONTROL.name && a.ecosystem === 'npm' && a.ranges.length));
  assert.ok(value.references.length && value.references.every(r => /^https?:\/\//.test(r.url)));
}

async function inventory(file) {
  const zip = await openPromise(file, {autoClose: false, lazyEntries: true, strictFileNames: true});
  let entries = 0, expanded_bytes = 0, maximum_record_bytes = 0, raw; const non_osv_alias_controls = [];
  try {
    for await (const entry of zip.eachEntry()) {
      entries++; expanded_bytes += entry.uncompressedSize; maximum_record_bytes = Math.max(maximum_record_bytes, entry.uncompressedSize);
      if ([NPM_CONTROL.id, ...ALIAS_CONTROLS].some(id => entry.fileName === id + '.json')) {
        const chunks = []; for await (const b of await zip.openReadStreamPromise(entry)) chunks.push(b);
        const r = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (r.id === NPM_CONTROL.id) raw = r;
        else non_osv_alias_controls.push({id: r.id, non_osv_aliases: (r.aliases ?? []).filter(a => typeof a === 'string' && !/^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/.test(a))});
      }
    }
    assert.equal(entries, zip.entryCount); assert.equal(raw?.id, NPM_CONTROL.id); assert.ok(raw.aliases.includes(NPM_CONTROL.alias));
    return {entries, expanded_bytes, maximum_record_bytes, raw, non_osv_alias_controls};
  } finally {zip.close();}
}
async function bindings() {
  const sources = {}, artifacts = {};
  async function visit(file) {
    if (sources[file]) return; const bytes = await readFile(file); sources[file] = sha(bytes);
    if (!file.endsWith('.ts')) return;
    for (const m of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"\n]+)['"]/g)) {
      if (m[1].startsWith('.')) await visit(resolve(dirname(file), m[1]).replace(/\.js$/, '.ts').slice(process.cwd().length + 1));
    }
  }
  await visit('src/index.ts');
  for (const file of ['scripts/validate-offline-npm.mjs', 'scripts/validate-offline-maven.mjs', 'src/test/osv/offlineNpmValidation.test.ts',
    'src/test/fixtures/offline-npm/package.json', 'src/test/fixtures/offline-npm/package-lock.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) await visit(file);
  async function compiled(dir) {
    for (const e of await readdir(dir, {withFileTypes: true})) {const p = join(dir, e.name); if (e.isDirectory()) await compiled(p); else if (e.name.endsWith('.js')) artifacts[p] = await image(p);}
  }
  await compiled('dist'); return {sources, artifacts};
}

export async function runNpmValidation(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const [k, v] = [args[i], args[i + 1]]; assert.ok(['--cache', '--binary', '--output', '--test-report'].includes(k) && v && !values.has(k), 'Invalid arguments'); values.set(k, v);
  }
  assert.ok(values.has('--cache') && values.has('--binary'), 'Usage: node scripts/validate-offline-npm.mjs --cache /npm-cache --binary /osv-scanner [--output /record.json] [--test-report /tests.json]');
  const cache = await realpath(values.get('--cache')), binary = await realpath(values.get('--binary'));
  const denied = await new Promise(resolve => {
    const s = connect({host: '127.0.0.1', port: 9}); s.setTimeout(2000); s.once('connect', () => {s.destroy(); resolve('connected');});
    s.once('timeout', () => {s.destroy(); resolve('timeout');}); s.once('error', e => resolve(e.code));
  });
  assert.ok(['EPERM', 'EACCES'].includes(denied), 'OS network denial not demonstrated: ' + denied);
  const previousFetch = globalThis.fetch; let fetchCalls = 0;
  globalThis.fetch = async () => {fetchCalls++; throw Error('Unexpected Node network request');};
  const root = await realpath(await mkdtemp(join(tmpdir(), 'offline-npm-native-')));
  try {
    process.env.OSV_MCP_OFFLINE = '1'; process.env.OSV_MCP_OFFLINE_DB_DIR = cache; process.env.OSV_SCANNER_PATH = binary;
    const load = name => import(pathToFileURL(resolve('dist/tools/' + name + '.js')).href);
    const {handleScanProject} = await load('scanProject'), {handleSuggestFix} = await load('suggestFix');
    const {handleScanSbom} = await load('scanSbom'), {handleExplainVulnerability} = await load('explainVulnerability');
    const {captureOfflineDatabases, OFFLINE_LIMITS} = await import(pathToFileURL(resolve('dist/osv/offlineCache.js')).href);
    const {OFFLINE_LOOKUP_LIMITS} = await import(pathToFileURL(resolve('dist/osv/offlineRecord.js')).href);
    const {queryOfflineCandidate} = await import(pathToFileURL(resolve('dist/osv/offlineCandidate.js')).href);
    const manifest = JSON.parse(await readFile(join(cache, 'manifest.json'), 'utf8'));
    assert.equal(manifest.databases.length, 1, 'Use an npm-only cache'); const db = manifest.databases[0]; assert.equal(db.ecosystem, 'npm');
    const options = {offline: true, offlineDbDir: cache, binaryPath: binary}, snapshot = await captureOfflineDatabases(options, ['npm']);
    let expected, archive, capacity;
    try {
      expected = snapshot.metadata; const file = join(snapshot.dir, 'osv-scalibr/npm/all.zip'); assert.equal(await image(file), db.sha256);
      archive = await inventory(file); const objects = await readdir(join(cache, 'objects')); let bytes = 0;
      for (const name of objects) bytes += (await stat(join(cache, 'objects', name))).size;
      capacity = {zip_bytes: (await stat(file)).size, cache_bytes: bytes, cache_objects: objects.length, entries: archive.entries, expanded_bytes: archive.expanded_bytes, maximum_record_bytes: archive.maximum_record_bytes};
      assert.equal(capacity.zip_bytes, db.bytes); checkCapacity(capacity, OFFLINE_LIMITS, OFFLINE_LOOKUP_LIMITS);
    } finally {await snapshot.cleanup();}
    const fixtures = {};
    for (const name of ['package.json', 'package-lock.json']) {
      const p = 'src/test/fixtures/offline-npm/' + name, bytes = await readFile(p); await writeFile(join(root, name), bytes); fixtures[p] = sha(bytes);
    }
    const observations = [], timed = async (tool, run) => {const start = performance.now(), result = await run(); return {tool, result, elapsed_ms: performance.now() - start};};
    const scan = await timed('scan_project', () => handleScanProject({project_path: root}, options)), scanValue = payload(scan.result), pkg = checkNpmScan(scanValue, expected);
    observations.push({tool: scan.tool, elapsed_ms: scan.elapsed_ms, packages: scanValue.packages, vulnerability_count: scanValue.vulnerability_count, coverage: scanValue.coverage, dependency_resolution: scanValue.dependency_resolution, offline_database: expected});
    const beforeCall = await timed('suggest_fix', () => handleSuggestFix({project_path: root}, {...options, candidateCheck: 'disabled'})), beforeValue = payload(beforeCall.result), before = checkNpmFix(beforeValue, expected, pkg, true);
    observations.push({tool: beforeCall.tool, case: 'explicit-recheck-disabled-control', elapsed_ms: beforeCall.elapsed_ms, suggestion: before, offline_database: beforeValue.offline_database});
    const fix = await timed('suggest_fix', () => handleSuggestFix({project_path: root}, {...options, candidateCheck: {}})), fixValue = payload(fix.result), after = checkNpmFix(fixValue, expected, pkg);
    observations.push({tool: fix.tool, elapsed_ms: fix.elapsed_ms, suggestion: after, offline_database: fixValue.offline_database});
    const queries = [];
    for (const version of [NPM_CONTROL.version, before.recommended_upgrade, after.recommended_upgrade]) {
      const start = performance.now(), records = await queryOfflineCandidate('npm', NPM_CONTROL.name, version, options, expected); queries.push(records);
      observations.push({tool: 'offline_candidate_query', version, record_ids: ids(records), elapsed_ms: performance.now() - start});
    }
    checkNpmCandidates(queries[0], queries[1], queries[2], pkg, before, after);
    const file = join(root, 'input.cdx.json'), bom = {bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, components: [{type: 'library', name: NPM_CONTROL.name, version: NPM_CONTROL.version, purl: `pkg:npm/${NPM_CONTROL.name}@${NPM_CONTROL.version}`}]};
    await writeFile(file, JSON.stringify(bom));
    const sbom = await timed('scan_sbom', () => handleScanSbom({sbom_path: file}, options)), sbomValue = payload(sbom.result); checkNpmSbom(sbomValue, expected, pkg);
    observations.push({tool: sbom.tool, elapsed_ms: sbom.elapsed_ms, identified_vulnerability_count: sbomValue.identified_vulnerability_count, packages: sbomValue.packages, coverage: sbomValue.coverage, input_sha256: sha(JSON.stringify(bom)), offline_database: sbomValue.offline_database});
    const explanations = [];
    for (const requested of [NPM_CONTROL.id, NPM_CONTROL.alias]) {
      const call = await timed('explain_vulnerability', () => handleExplainVulnerability({vulnerability_id: requested}, options)), v = payload(call.result);
      checkNpmExplanation(v, requested, archive.raw, expected); explanations.push(v);
      observations.push({tool: call.tool, requested_id: requested, matched_by: v.matched_by, id: v.id, matching_record_ids: v.matching_record_ids, details_characters: v.details.length, details_sha256: sha(v.details), summary: v.summary, affected: v.affected, references: v.references, elapsed_ms: call.elapsed_ms, offline_database: v.offline_database});
    }
    const content = ({requested_id, matched_by, ...rest}) => rest; assert.deepEqual(content(explanations[0]), content(explanations[1]));
    const absent = await timed('explain_vulnerability', () => handleExplainVulnerability({vulnerability_id: 'CVE-2999-999999'}, options)), absentValue = JSON.parse(absent.result.content[0].text);
    assert.equal(absent.result.isError, true); assert.equal(absentValue.error.kind, 'vulnerability_not_found'); checkMetadata(absentValue.offline_database, expected);
    observations.push({tool: absent.tool, case: 'unlisted-id', status: 'not-found-in-local-snapshot', elapsed_ms: absent.elapsed_ms, error: absentValue.error, offline_database: absentValue.offline_database});
    const invalid = await handleExplainVulnerability({vulnerability_id: 'SNYK-JS-YARN-537806,'}, {...options, offlineDbDir: join(root, 'no-cache')});
    assert.equal(invalid.isError, true); assert.equal(JSON.parse(invalid.content[0].text).error.kind, 'invalid_vulnerability_id');
    observations.push({tool: 'explain_vulnerability', case: 'malformed-alias-request-before-cache', status: 'rejected', error_kind: 'invalid_vulnerability_id'});
    const limited = await handleExplainVulnerability({vulnerability_id: NPM_CONTROL.id}, {...options, offlineLookupLimits: {entries: 1}}), limitedValue = JSON.parse(limited.content[0].text);
    assert.equal(limited.isError, true); assert.equal(limitedValue.error.kind, 'output_too_large');
    observations.push({tool: 'explain_vulnerability', case: 'entry-budget', status: 'rejected', error: limitedValue.error});
    const reasons = {missing: 'manifest missing or unreadable', 'missing-object': 'missing, replaced or truncated', expired: 'expired or has a future timestamp', future: 'expired or has a future timestamp', truncated: 'missing, replaced or truncated', digest: 'digest mismatch', 'invalid-origin': 'manifest invalid', 'oversized-manifest': 'manifest invalid'};
    const tools = [['scan_project', o => handleScanProject({project_path: root}, o)], ['suggest_fix', o => handleSuggestFix({project_path: root}, o)],
      ['scan_sbom', o => handleScanSbom({sbom_path: file}, o)], ['explain_vulnerability', o => handleExplainVulnerability({vulnerability_id: NPM_CONTROL.id}, o)]];
    for (const [kind, reason] of Object.entries(reasons)) {
      const dir = join(root, kind); await mkdir(join(dir, 'objects'), {recursive: true, mode: 0o700});
      if (kind !== 'missing') {
        const d = {...db}; if (kind === 'expired') d.downloaded_at = '2020-01-01T00:00:00.000Z';
        if (kind === 'future') d.downloaded_at = new Date(Date.now() + 3600000).toISOString();
        if (kind === 'invalid-origin') d.url = 'https://invalid.example/all.zip';
        if (kind === 'oversized-manifest') d.bytes = OFFLINE_LIMITS.databaseBytes + 1;
        if (kind === 'truncated') await writeFile(join(dir, 'objects', d.sha256 + '.zip'), 'PK');
        if (kind === 'digest') {const b = await readFile(join(cache, 'objects', d.sha256 + '.zip')); b[b.length - 1] ^= 1; await writeFile(join(dir, 'objects', d.sha256 + '.zip'), b);}
        await writeFile(join(dir, 'manifest.json'), JSON.stringify({schema: 1, databases: [d]}));
      }
      const opts = {...options, offlineDbDir: dir};
      for (const [tool, run] of tools) observations.push({tool, case: kind, status: 'rejected', error: checkRefusal(await run(opts), reason)});
      let error; try {await queryOfflineCandidate('npm', NPM_CONTROL.name, after.recommended_upgrade, opts, expected);} catch (e) {error = e;}
      assert.equal(error?.kind, 'scan_failed'); assert.ok(error.message.includes(reason));
      observations.push({tool: 'offline_candidate_query', case: kind, status: 'rejected', error: {kind: error.kind, message: error.message}});
    }
    assert.equal(fetchCalls, 0); assert.equal(await image(join(cache, 'objects', db.sha256 + '.zip')), db.sha256);
    assert.deepEqual(JSON.parse(await readFile(join(cache, 'manifest.json'), 'utf8')), manifest);
    const require = createRequire(import.meta.url), bound = await bindings(); let regressions = null;
    if (values.has('--test-report')) {
      const b = await readFile(values.get('--test-report')), r = JSON.parse(b), cases = r.testResults.flatMap(t => t.assertionResults);
      assert.equal(r.success, true); assert.equal(r.numFailedTests, 0); assert.equal(r.numPendingTests, 0); assert.equal(cases.filter(c => c.status === 'passed').length, r.numPassedTests);
      const harness = r.testResults.find(t => t.name.endsWith('/offlineNpmValidation.test.ts'))?.assertionResults; assert.ok(harness?.length);
      regressions = {passed: r.numPassedTests, failed: 0, skipped: 0, files: r.testResults.length, report_sha256: sha(b), harness_cases: harness.map(c => ({name: c.fullName, status: c.status}))};
    }
    const record = {schema: 1, date: new Date().toISOString(), scope: 'complete-npm-DB-real-scanner-ID-alias-lookup-same-user-macOS-network-denied',
      runtime: {node: process.version, platform: process.platform, arch: process.arch, node_sha256: await image(process.execPath), zip_reader: {version: require('yauzl/package.json').version, index_sha256: await image(require.resolve('yauzl'))}},
      scanner: {version: execFileSync(binary, ['--version'], {encoding: 'utf8'}).trim(), sha256: await image(binary)}, database_manifest: manifest,
      capacity: {observed: capacity, storage_limits: OFFLINE_LIMITS, lookup_limits: OFFLINE_LOOKUP_LIMITS}, fixtures, control: NPM_CONTROL,
      raw_advisory: {id: archive.raw.id, aliases: archive.raw.aliases, details_sha256: sha(archive.raw.details)}, non_osv_alias_controls: archive.non_osv_alias_controls,
      network_control: denied, node_fetch_calls: fetchCalls, input_cache_unchanged: true, observations, ...bound, regressions};
    if (values.has('--output')) await writeFile(values.get('--output'), JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify({capacity, network_control: denied, node_fetch_calls: fetchCalls, original_vulnerabilities: pkg.vulnerabilities.length,
      initial_candidate: before.recommended_upgrade, rejected_candidate_records: ids(queries[1]), recommended: after.recommended_upgrade,
      refusals: observations.filter(o => o.status === 'rejected').length, sources: Object.keys(bound.sources).length}, null, 2));
    return record;
  } finally {await rm(root, {recursive: true, force: true}); globalThis.fetch = previousFetch;}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runNpmValidation(process.argv.slice(2));
