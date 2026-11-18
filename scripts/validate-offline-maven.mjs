/** Real Maven DB validation. Preparation is separate; this runner requires OS network denial and never downloads. */
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

export const MAVEN_CONTROL = Object.freeze({name: 'org.apache.logging.log4j:log4j-core', version: '2.14.1',
  id: 'GHSA-jfh8-c2jp-5v3q', alias: 'CVE-2021-44228'});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function image(file) {const hash = createHash('sha256'); for await (const b of createReadStream(file)) hash.update(b); return hash.digest('hex');}
const payload = response => {assert.notEqual(response.isError, true, response.content[0]?.text); return JSON.parse(response.content[0].text);};
const ids = records => records.map(r => r.id).sort();
const same = (a, b) => assert.deepEqual(a, b);
export function checkMetadata(value, expected) {
  assert.equal(value?.mode, 'offline'); assert.equal(value.network_requests, false);
  assert.equal(typeof value.warning, 'string'); assert.ok(value.warning.length);
  assert.ok(Number.isFinite(value.max_age_hours) && value.max_age_hours > 0);
  same(value, expected);
}
export function checkScan(report, expected) {
  checkMetadata(report.offline_database, expected);
  assert.equal(report.dependency_resolution?.transitive_resolution, 'disabled');
  assert.match(report.dependency_resolution.warning, /transitive dependencies/);
  assert.equal(report.packages.length, 1);
  const pkg = report.packages[0];
  assert.equal(pkg.name, MAVEN_CONTROL.name); assert.equal(pkg.version, MAVEN_CONTROL.version); assert.equal(pkg.ecosystem, 'Maven');
  assert.equal(report.vulnerable_package_count, 1);
  assert.ok(pkg.vulnerabilities.length > 0); assert.equal(report.vulnerability_count, pkg.vulnerabilities.length);
  assert.equal(new Set(ids(pkg.vulnerabilities)).size, pkg.vulnerabilities.length);
  assert.ok(pkg.vulnerabilities.some(v => v.id === MAVEN_CONTROL.id && v.cve === MAVEN_CONTROL.alias));
  return pkg;
}
export function checkFix(report, expected, original) {
  checkMetadata(report.offline_database, expected);
  assert.equal(report.dependency_resolution?.transitive_resolution, 'disabled');
  assert.match(report.dependency_resolution.warning, /transitive dependencies/);
  assert.equal(report.suggestions.length, 1); const s = report.suggestions[0];
  assert.equal(s.package, MAVEN_CONTROL.name); assert.equal(s.current_version, MAVEN_CONTROL.version); assert.equal(s.ecosystem, 'Maven');
  assert.equal(s.verification, 'verified'); assert.equal(s.candidate_check, 'clean'); assert.equal(s.candidate_check_source, 'local_database');
  assert.equal(typeof s.recommended_upgrade, 'string'); assert.ok(s.recommended_upgrade.length && s.recommended_upgrade !== MAVEN_CONTROL.version);
  assert.match(s.upgrade_note, /local database snapshot/);
  same(ids(s.per_cve_detail), ids(original.vulnerabilities));
  assert.ok(s.per_cve_detail.every(v => v.recommended_status === 'not_affected'));
  return s;
}
export function checkCandidates(affected, fixed, original) {
  same(ids(affected), ids(original.vulnerabilities));
  assert.ok(affected.every(r => r.affected.some(a => a.package?.name === MAVEN_CONTROL.name && a.package.ecosystem === 'Maven')));
  same(fixed, []);
}
export function checkExplanation(value, requested, raw, expected) {
  checkMetadata(value.offline_database, expected);
  assert.equal(value.requested_id, requested); assert.equal(value.matched_by, requested === raw.id ? 'id' : 'alias');
  assert.equal(value.id, raw.id); same(value.aliases, raw.aliases.slice(0, 20));
  same(value.matching_record_ids, [raw.id]); assert.ok(!value.related_records?.length);
  assert.equal(value.summary, raw.summary.length > 500 ? raw.summary.slice(0, 500) + '…' : raw.summary);
  assert.equal(value.details, raw.details.length > 4000 ? raw.details.slice(0, 4000) + '…' : raw.details);
  assert.ok(value.details.length > 0);
  assert.ok(value.affected.some(a => a.package === MAVEN_CONTROL.name && a.ecosystem === 'Maven' && a.ranges.length > 0));
  assert.ok(value.references.length > 0 && value.references.every(r => /^https?:\/\//.test(r.url)));
}
export function checkCapacity(observed, storage, lookup) {
  const pairs = [['zip_bytes', storage.databaseBytes], ['cache_bytes', storage.totalBytes], ['cache_objects', storage.objects],
    ['entries', lookup.entries], ['expanded_bytes', lookup.expandedBytes], ['maximum_record_bytes', lookup.recordBytes]];
  for (const [key, limit] of pairs) {
    assert.ok(Number.isSafeInteger(observed[key]) && observed[key] > 0 && observed[key] <= limit, key + ' exceeds limit');
  }
  assert.ok(observed.cache_bytes >= observed.zip_bytes && observed.expanded_bytes >= observed.maximum_record_bytes);
}
export function checkRefusal(response, reason) {
  assert.equal(response.isError, true); const value = JSON.parse(response.content[0].text);
  assert.equal(value.error?.kind, 'scan_failed'); assert.match(value.error.message, /Offline database cache/);
  assert.ok(value.error.message.includes(reason), value.error.message); return value.error;
}

async function inventory(file) {
  const archive = await openPromise(file, {autoClose: false, lazyEntries: true, strictFileNames: true});
  let entries = 0, expanded_bytes = 0, maximum_record_bytes = 0, raw;
  try {
    for await (const entry of archive.eachEntry()) {
      entries++; expanded_bytes += entry.uncompressedSize; maximum_record_bytes = Math.max(maximum_record_bytes, entry.uncompressedSize);
      if (entry.fileName === MAVEN_CONTROL.id + '.json') {
        const chunks = []; for await (const b of await archive.openReadStreamPromise(entry)) chunks.push(b);
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
    }
    assert.equal(entries, archive.entryCount); assert.equal(raw?.id, MAVEN_CONTROL.id); assert.ok(raw.aliases.includes(MAVEN_CONTROL.alias));
    return {entries, expanded_bytes, maximum_record_bytes, raw};
  } finally {archive.close();}
}
async function bindings() {
  // Pin the reachable product source closure, including normalizers and snapshot/permission helpers.
  const sources = {};
  async function visit(file) {
    if (sources[file]) return;
    const bytes = await readFile(file); sources[file] = sha(bytes);
    if (!file.endsWith('.ts')) return;
    for (const match of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"\n]+)['"]/g)) {
      if (!match[1].startsWith('.')) continue;
      const target = resolve(dirname(file), match[1]).replace(/\.js$/, '.ts');
      await visit(target.slice(process.cwd().length + 1));
    }
  }
  await visit('src/index.ts');
  for (const p of ['scripts/validate-offline-maven.mjs', 'src/test/osv/offlineMavenValidation.test.ts', 'src/test/fixtures/offline-maven/pom.xml',
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) await visit(p);
  const artifacts = {};
  async function collect(dir) {
    for (const e of await readdir(dir, {withFileTypes: true})) {
      const p = join(dir, e.name); if (e.isDirectory()) await collect(p); else if (e.name.endsWith('.js')) artifacts[p] = await image(p);
    }
  }
  await collect('dist'); return {sources, artifacts};
}

export async function runMavenValidation(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const [k, v] = [args[i], args[i + 1]];
    assert.ok(['--cache', '--binary', '--output', '--test-report'].includes(k) && v && !values.has(k), 'Invalid arguments'); values.set(k, v);
  }
  assert.ok(values.has('--cache') && values.has('--binary'), 'Usage: node scripts/validate-offline-maven.mjs --cache /cache --binary /osv-scanner [--output /record.json] [--test-report /tests.json]');
  const cache = await realpath(values.get('--cache')), binary = await realpath(values.get('--binary'));
  const denied = await new Promise(resolve => {
    const socket = connect({host: '127.0.0.1', port: 9}); socket.setTimeout(2000);
    socket.once('connect', () => {socket.destroy(); resolve('connected');}); socket.once('timeout', () => {socket.destroy(); resolve('timeout');});
    socket.once('error', e => resolve(e.code));
  });
  assert.ok(['EPERM', 'EACCES'].includes(denied), 'OS network denial not demonstrated: ' + denied);
  let fetchCalls = 0; const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {fetchCalls++; throw Error('Unexpected network request');};
  const root = await realpath(await mkdtemp(join(tmpdir(), 'offline-maven-native-')));
  try {
    process.env.OSV_MCP_OFFLINE = '1'; process.env.OSV_MCP_OFFLINE_DB_DIR = cache; process.env.OSV_SCANNER_PATH = binary;
    const load = name => import(pathToFileURL(resolve('dist/tools/' + name + '.js')).href);
    const {handleScanProject} = await load('scanProject'), {handleScanJavaProject} = await load('scanJavaProject');
    const {handleSuggestFix} = await load('suggestFix'), {handleExplainVulnerability} = await load('explainVulnerability');
    const {captureOfflineDatabases, OFFLINE_LIMITS} = await import(pathToFileURL(resolve('dist/osv/offlineCache.js')).href);
    const {OFFLINE_LOOKUP_LIMITS} = await import(pathToFileURL(resolve('dist/osv/offlineRecord.js')).href);
    const {queryOfflineCandidate} = await import(pathToFileURL(resolve('dist/osv/offlineCandidate.js')).href);
    const manifest = JSON.parse(await readFile(join(cache, 'manifest.json'), 'utf8'));
    assert.equal(manifest.databases.length, 1, 'Use a Maven-only prepared cache'); const db = manifest.databases[0];
    assert.equal(db.ecosystem, 'Maven');
    const options = {offline: true, offlineDbDir: cache, binaryPath: binary};
    const snapshot = await captureOfflineDatabases(options, ['Maven']);
    let archive, expected, capacity;
    try {
      expected = snapshot.metadata;
      const file = join(snapshot.dir, 'osv-scalibr/Maven/all.zip'); assert.equal(await image(file), db.sha256);
      archive = await inventory(file);
      const objectFiles = await readdir(join(cache, 'objects'));
      let cacheBytes = 0; for (const name of objectFiles) cacheBytes += (await stat(join(cache, 'objects', name))).size;
      capacity = {zip_bytes: (await stat(file)).size, cache_bytes: cacheBytes, cache_objects: objectFiles.length,
        entries: archive.entries, expanded_bytes: archive.expanded_bytes, maximum_record_bytes: archive.maximum_record_bytes};
      assert.equal(capacity.zip_bytes, db.bytes); checkCapacity(capacity, OFFLINE_LIMITS, OFFLINE_LOOKUP_LIMITS);
    } finally {await snapshot.cleanup();}
    const fixture = await readFile('src/test/fixtures/offline-maven/pom.xml'); await writeFile(join(root, 'pom.xml'), fixture);
    const observations = [], timed = async (tool, run) => {
      const start = performance.now(), response = await run();
      const elapsed_ms = performance.now() - start; return {tool, elapsed_ms, response};
    };
    const scan = await timed('scan_project', () => handleScanProject({project_path: root}, options)), scanValue = payload(scan.response), pkg = checkScan(scanValue, expected);
    const java = await timed('scan_java_project', () => handleScanJavaProject({project_path: root}, options)), javaValue = payload(java.response), javaPkg = checkScan(javaValue, expected);
    same(pkg, javaPkg); same(javaValue.manifests, ['pom.xml']);
    for (const [call, value] of [[scan, scanValue], [java, javaValue]]) observations.push({tool: call.tool, elapsed_ms: call.elapsed_ms,
      vulnerability_count: value.vulnerability_count, packages: value.packages, dependency_resolution: value.dependency_resolution,
      ...(value.coverage ? {coverage: value.coverage} : {}), offline_database: value.offline_database});
    const fix = await timed('suggest_fix', () => handleSuggestFix({project_path: root}, {...options, candidateCheck: {}}));
    const fixValue = payload(fix.response), suggestion = checkFix(fixValue, expected, pkg);
    observations.push({tool: fix.tool, elapsed_ms: fix.elapsed_ms, suggestions: fixValue.suggestions, dependency_resolution: fixValue.dependency_resolution, offline_database: fixValue.offline_database});
    const queries = [];
    for (const version of [MAVEN_CONTROL.version, suggestion.recommended_upgrade]) {
      const start = performance.now(), records = await queryOfflineCandidate('Maven', MAVEN_CONTROL.name, version, options, expected);
      queries.push(records); observations.push({tool: 'offline_candidate_query', version, record_ids: ids(records), elapsed_ms: performance.now() - start});
    }
    checkCandidates(queries[0], queries[1], pkg);
    const explanations = [];
    for (const requested of [MAVEN_CONTROL.id, MAVEN_CONTROL.alias]) {
      const call = await timed('explain_vulnerability', () => handleExplainVulnerability({vulnerability_id: requested}, options)), value = payload(call.response);
      checkExplanation(value, requested, archive.raw, expected); explanations.push(value);
      observations.push({tool: call.tool, requested_id: requested, id: value.id, matched_by: value.matched_by, matching_record_ids: value.matching_record_ids,
        summary: value.summary, details_characters: value.details.length, details_sha256: sha(value.details), affected: value.affected, references: value.references,
        elapsed_ms: call.elapsed_ms, offline_database: value.offline_database});
    }
    const withoutQuery = ({requested_id, matched_by, ...rest}) => rest; same(withoutQuery(explanations[0]), withoutQuery(explanations[1]));
    const missing = await handleExplainVulnerability({vulnerability_id: 'CVE-2999-999999'}, options), miss = JSON.parse(missing.content[0].text);
    assert.equal(missing.isError, true); assert.equal(miss.error.kind, 'vulnerability_not_found'); checkMetadata(miss.offline_database, expected);
    observations.push({tool: 'explain_vulnerability', case: 'unlisted-id', status: 'not-found-in-local-snapshot', error: miss.error, offline_database: miss.offline_database});
    const negativeTools = [['scan_project', o => handleScanProject({project_path: root}, o)], ['scan_java_project', o => handleScanJavaProject({project_path: root}, o)],
      ['suggest_fix', o => handleSuggestFix({project_path: root}, o)], ['explain_vulnerability', o => handleExplainVulnerability({vulnerability_id: MAVEN_CONTROL.id}, o)]];
    const reasons = {missing: 'manifest missing or unreadable', 'missing-object': 'missing, replaced or truncated', expired: 'expired or has a future timestamp',
      future: 'expired or has a future timestamp', truncated: 'missing, replaced or truncated', digest: 'digest mismatch', 'invalid-origin': 'manifest invalid', 'oversized-manifest': 'manifest invalid'};
    for (const [kind, reason] of Object.entries(reasons)) {
      const dir = join(root, kind); await mkdir(join(dir, 'objects'), {recursive: true, mode: 0o700});
      if (kind !== 'missing') {
        const d = {...db};
        if (kind === 'expired') d.downloaded_at = '2020-01-01T00:00:00.000Z';
        if (kind === 'future') d.downloaded_at = new Date(Date.now() + 3600000).toISOString();
        if (kind === 'invalid-origin') d.url = 'https://invalid.example/all.zip';
        if (kind === 'oversized-manifest') d.bytes = OFFLINE_LIMITS.databaseBytes + 1;
        if (kind === 'truncated') await writeFile(join(dir, 'objects', d.sha256 + '.zip'), 'PK');
        if (kind === 'digest') {const bytes = await readFile(join(cache, 'objects', d.sha256 + '.zip')); bytes[bytes.length - 1] ^= 1; await writeFile(join(dir, 'objects', d.sha256 + '.zip'), bytes);}
        await writeFile(join(dir, 'manifest.json'), JSON.stringify({schema: 1, databases: [d]}));
      }
      const negativeOptions = {...options, offlineDbDir: dir};
      for (const [tool, run] of negativeTools) {
        const error = checkRefusal(await run(negativeOptions), reason);
        observations.push({tool, case: kind, status: 'rejected', error});
      }
      let error;
      try {await queryOfflineCandidate('Maven', MAVEN_CONTROL.name, suggestion.recommended_upgrade, negativeOptions, expected);} catch (e) {error = e;}
      assert.equal(error?.kind, 'scan_failed'); assert.ok(error.message.includes(reason));
      observations.push({tool: 'offline_candidate_query', case: kind, status: 'rejected', error: {kind: error.kind, message: error.message}});
    }
    assert.equal(fetchCalls, 0);
    const require = createRequire(import.meta.url), bound = await bindings();
    let regressions = null;
    if (values.has('--test-report')) {
      const bytes = await readFile(values.get('--test-report')), report = JSON.parse(bytes), cases = report.testResults.flatMap(t => t.assertionResults);
      assert.equal(report.success, true); assert.equal(report.numFailedTests, 0); assert.equal(report.numPendingTests, 0);
      assert.equal(cases.filter(c => c.status === 'passed').length, report.numPassedTests);
      const harnessCases = report.testResults.find(r => r.name.endsWith('/offlineMavenValidation.test.ts'))?.assertionResults;
      assert.ok(harnessCases?.length); regressions = {passed: report.numPassedTests, failed: 0, skipped: 0, files: report.testResults.length, report_sha256: sha(bytes), harness_cases: harnessCases.map(c => ({name: c.fullName, status: c.status}))};
    }
    const record = {schema: 1, date: new Date().toISOString(), scope: 'complete-Maven-DB-real-scanner-same-user-macOS-network-denied',
      runtime: {node: process.version, platform: process.platform, arch: process.arch, node_sha256: await image(process.execPath),
        zip_reader: {version: require('yauzl/package.json').version, index_sha256: await image(require.resolve('yauzl'))}},
      scanner: {version: execFileSync(binary, ['--version'], {encoding: 'utf8'}).trim(), sha256: await image(binary)},
      database_manifest: manifest, capacity: {observed: capacity, storage_limits: OFFLINE_LIMITS, lookup_limits: OFFLINE_LOOKUP_LIMITS},
      fixture: {path: 'src/test/fixtures/offline-maven/pom.xml', sha256: sha(fixture), ...MAVEN_CONTROL},
      raw_advisory: {id: archive.raw.id, aliases: archive.raw.aliases, details_sha256: sha(archive.raw.details)},
      network_control: denied, node_fetch_calls: fetchCalls, observations, ...bound, regressions};
    if (values.has('--output')) await writeFile(values.get('--output'), JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify({capacity, network_control: denied, node_fetch_calls: fetchCalls, recommendation: suggestion.recommended_upgrade,
      vulnerability_count: scanValue.vulnerability_count, refusals: observations.filter(o => o.status === 'rejected').length, source_bindings: Object.keys(bound.sources).length}, null, 2));
    return record;
  } finally {await rm(root, {recursive: true, force: true}); globalThis.fetch = previousFetch;}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runMavenValidation(process.argv.slice(2));
