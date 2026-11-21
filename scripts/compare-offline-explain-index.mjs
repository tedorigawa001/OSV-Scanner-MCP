/** Compare full response bodies on one official npm DB under OS-enforced network denial. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {connect} from 'node:net';
import {tmpdir, release} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {parseArgs} from 'node:util';
import {NPM_CONTROL} from './validate-offline-npm.mjs';

const {values} = parseArgs({options: {before: {type: 'string'}, after: {type: 'string'}, cache: {type: 'string'}, output: {type: 'string'}}});
assert.ok(values.before && values.after && values.cache && values.output,
  'Supply --before /built-baseline --after /built-candidate --cache /official-npm-cache --output /record.json');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function bind(files, root = '.') {
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await digest(join(root, file))])));
}

class ComparisonFailure extends Error {
  constructor(kind, signal) {
    super(signal ? `Comparison interrupted by ${signal}` : kind);
    this.kind = kind;
    this.signal = signal;
  }
}

const interrupted = new AbortController();
const signals = {SIGINT: () => stop('SIGINT'), SIGTERM: () => stop('SIGTERM')};
function stop(signal) {interrupted.abort(new ComparisonFailure('interrupted', signal));}

const arms = ['before', 'after'];
const builds = {};
const report = {schema: 2, run_id: randomUUID(), started_at: new Date().toISOString(), status: 'running',
  runtime: {node: process.version, platform: process.platform, arch: process.arch, release: release()},
  network: {loopback: null, fetch_attempts: 0}, samples: [], rejections: []};
const outputFile = resolve(values.output), tempReport = `${outputFile}.${report.run_id}.tmp`;
let progress = {phase: 'setup', step: 'network'}, startedQuery, root;
async function saveReport() {
  await writeFile(tempReport, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  await rename(tempReport, outputFile);
}
async function markProgress(value) {
  progress = value;
  report.in_progress = progress;
  await saveReport();
  interrupted.signal.throwIfAborted();
}
const previousFetch = globalThis.fetch;
for (const [signal, handler] of Object.entries(signals)) process.on(signal, handler);
try {
  // Replace any previous output before starting. Even a hard kill leaves this run marked as in progress.
  await markProgress(progress);
  const denied = await new Promise(resolve => {
    const socket = connect({host: '127.0.0.1', port: 9});
    socket.setTimeout(2000);
    socket.once('connect', () => {socket.destroy(); resolve('connected');});
    socket.once('timeout', () => {socket.destroy(); resolve('timeout');});
    socket.once('error', error => resolve(error.code));
  });
  report.network.loopback = denied;
  assert.ok(['EPERM', 'EACCES'].includes(denied), `OS network denial not demonstrated (${denied})`);
  globalThis.fetch = async () => {report.network.fetch_attempts++; throw Error('Unexpected fetch');};
  await markProgress({phase: 'setup', step: 'builds'});
  for (const arm of arms) {
    const dir = resolve(values[arm]);
    const {handleExplainVulnerability} = await import(pathToFileURL(join(dir, 'tools/explainVulnerability.js')).href);
    builds[arm] = {handleExplainVulnerability, sha256: await bind(['tools/explainVulnerability.js', 'osv/offlineRecord.js', 'osv/offlineCache.js'], dir)};
  }
  assert.notEqual(builds.before.sha256['osv/offlineRecord.js'], builds.after.sha256['osv/offlineRecord.js']);
  report.artifact_sha256 = Object.fromEntries(arms.map(arm => [arm, builds[arm].sha256]));
  report.source_sha256 = await bind(['package-lock.json', 'scripts/compare-offline-explain-index.mjs', 'scripts/validate-offline-npm.mjs',
    'src/osv/offlineRecord.ts', 'src/osv/offlineCache.ts', 'src/tools/explainVulnerability.ts']);

  await markProgress({phase: 'setup', step: 'cache'});
  const manifest = await readFile(join(values.cache, 'manifest.json'));
  const dbs = JSON.parse(manifest).databases;
  assert.equal(dbs.length, 1);
  const [db] = dbs;
  assert.equal(db.ecosystem, 'npm');
  assert.equal(db.url, 'https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip');
  assert.match(db.sha256, /^[0-9a-f]{64}$/);
  const object = `${db.sha256}.zip`, original = join(values.cache, 'objects', object);
  assert.equal(await digest(original), db.sha256);
  assert.equal((await stat(original)).size, db.bytes);
  report.database = db;
  root = await mkdtemp(join(tmpdir(), 'offline-explain-index-'));
  const manifestFile = join(root, 'manifest.json'), archive = join(root, 'objects', object);
  await mkdir(join(root, 'objects'));
  await writeFile(manifestFile, manifest);
  await copyFile(original, archive);
  const options = {offline: true, offlineDbDir: root, offlineMaxAgeHours: 168};
  async function query(context, id) {
    startedQuery = undefined;
    await markProgress({...context, requested_id: id, step: 'handler'});
    console.error(`${context.phase} ${context.round ?? context.fault} ${context.scenario} ${context.arm}`);
    let watchdog, onInterrupt;
    startedQuery = performance.now();
    try {
      const stopWaiting = new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new ComparisonFailure('watchdog_timeout')), 125_000);
        onInterrupt = () => reject(interrupted.signal.reason);
        interrupted.signal.addEventListener('abort', onInterrupt, {once: true});
        if (interrupted.signal.aborted) onInterrupt();
      });
      const result = await Promise.race([builds[context.arm].handleExplainVulnerability({vulnerability_id: id}, options), stopWaiting]);
      const elapsed_ms = performance.now() - startedQuery;
      interrupted.signal.throwIfAborted();
      progress.step = 'validate_response';
      const output = JSON.parse(result.content[0].text);
      if (typeof output.error?.kind === 'string' && /^[a-z_]+$/.test(output.error.kind)) progress.tool_error_kind = output.error.kind;
      return {elapsed_ms, output, is_error: result.isError === true};
    } finally {
      clearTimeout(watchdog);
      interrupted.signal.removeEventListener('abort', onInterrupt);
    }
  }
  const cases = [['id', NPM_CONTROL.id], ['alias', NPM_CONTROL.alias], ['miss', 'CVE-2999-999999']];
  async function measure(phase, round, scenario, id, order) {
    const elapsed_ms = {}, observed = {};
    for (const arm of order) {
      const {elapsed_ms: elapsed, output, is_error} = await query({phase, round, scenario, arm}, id);
      elapsed_ms[arm] = elapsed;
      observed[arm] = {output, is_error};
      assert.equal(is_error, scenario === 'miss');
      assert.equal(output.requested_id, id);
      assert.deepEqual(output.offline_database.databases, [{ecosystem: 'npm', downloaded_at: db.downloaded_at, sha256: db.sha256}]);
      assert.equal(output.offline_database.network_requests, false);
      if (scenario === 'miss') assert.equal(output.error.kind, 'vulnerability_not_found');
      else {
        assert.equal(output.matched_by, scenario);
        assert.equal(output.id, NPM_CONTROL.id);
        assert.ok(output.details.length > 0);
      }
    }
    startedQuery = undefined;
    progress = {phase, round, scenario, step: 'compare_responses'};
    assert.deepEqual(observed.before, observed.after);
    const response_sha256 = createHash('sha256').update(JSON.stringify(observed.before)).digest('hex');
    report.samples.push({phase, round, scenario, order, elapsed_ms, response_sha256});
  }
  await measure('first', 0, ...cases[0], arms);
  for (let round = 0; round < 3; round++) for (let i = 0; i < cases.length; i++) {
    const caseIndex = (round + i) % cases.length;
    const order = (round + caseIndex) % 2 === 0 ? ['after', 'before'] : arms;
    await measure('repeat', round + 1, ...cases[caseIndex], order);
  }
  async function verifyRefusal(fault, reason) {
    for (const [scenario, id] of [cases[0], cases[2]]) for (const arm of arms) {
      const {output, is_error} = await query({phase: 'refusal', fault, scenario, arm}, id);
      assert.equal(is_error, true);
      assert.equal(output.error.kind, 'scan_failed');
      assert.match(output.error.message, reason);
      assert.equal(output.id, undefined);
      report.rejections.push({fault, scenario, arm, kind: output.error.kind});
    }
  }
  startedQuery = undefined;
  await markProgress({phase: 'refusal', fault: 'expired', step: 'prepare'});
  await writeFile(manifestFile, JSON.stringify({schema: 1, databases: [{...db, downloaded_at: '2000-01-01T00:00:00.000Z'}]}));
  await verifyRefusal('expired', /expired/);
  startedQuery = undefined;
  await markProgress({phase: 'refusal', fault: 'same-size-corruption', step: 'prepare'});
  await writeFile(manifestFile, manifest);
  const handle = await open(archive, 'r+');
  try {
    const byte = Buffer.alloc(1);
    assert.equal((await handle.read(byte, 0, 1, db.bytes - 1)).bytesRead, 1);
    byte[0] ^= 1;
    assert.equal((await handle.write(byte, 0, 1, db.bytes - 1)).bytesWritten, 1);
  } finally {await handle.close();}
  await verifyRefusal('same-size-corruption', /digest mismatch/);
  startedQuery = undefined;
  await markProgress({phase: 'finish', step: 'verify_input'});
  assert.equal(await digest(original), db.sha256);
  assert.deepEqual(await readFile(join(values.cache, 'manifest.json')), manifest);
  assert.equal(report.network.fetch_attempts, 0);
  await markProgress({phase: 'finish', step: 'cleanup'});
  await rm(root, {recursive: true, force: true});
  root = undefined;
  interrupted.signal.throwIfAborted();
  report.status = 'passed';
  report.finished_at = new Date().toISOString();
  delete report.in_progress;
  await saveReport();
  interrupted.signal.throwIfAborted();
  console.log(`Verified ${report.samples.length} paired lookups and ${report.rejections.length} refusals (${denied}, ${report.network.fetch_attempts} fetches)`);
} catch (error) {
  report.status = 'failed';
  report.finished_at = new Date().toISOString();
  delete report.in_progress;
  const signal = error instanceof ComparisonFailure ? error.signal : undefined;
  report.failure = {...progress, kind: error instanceof ComparisonFailure ? error.kind : 'comparison_failed',
    ...(signal && {signal}),
    ...(startedQuery !== undefined && {elapsed_ms: performance.now() - startedQuery})};
  await saveReport();
  console.error(error);
  process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
} finally {
  globalThis.fetch = previousFetch;
  for (const [signal, handler] of Object.entries(signals)) process.off(signal, handler);
  if (root) await rm(root, {recursive: true, force: true});
  await rm(tempReport, {force: true});
}
