import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {expect, it} from 'vitest';

// The comparison's own CLI and output file are used. Only the network probe and handlers are fixtures.
const preload = `
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
const net = createRequire(import.meta.url)('node:net');
net.connect = () => {
  const socket = new EventEmitter();
  socket.setTimeout = socket.destroy = () => {};
  queueMicrotask(() => socket.emit('error', {code: 'EPERM'}));
  return socket;
};
syncBuiltinESMExports();
const setTimer = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => setTimer(fn, ms === 125000 ? 100 : ms, ...args);
`;

const handler = (arm: string) => `
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
let calls = 0;
const result = (output, isError = false) => ({isError, content: [{text: JSON.stringify(output)}]});
export async function handleExplainVulnerability({vulnerability_id: id}, options) {
  if ('${arm}' === 'after' && ++calls === 2) {
    writeFileSync(process.env.INDEX_COMPARISON_OBSERVED, readFileSync(process.env.INDEX_COMPARISON_OUTPUT));
    const fault = process.env.INDEX_COMPARISON_FAULT;
    if (fault === 'scan_timeout') return result({error: {kind: 'scan_timeout'}}, true);
    if (fault === 'SIGTERM' || fault === 'SIGINT') setTimeout(() => {
      if (process.platform === 'win32') process.emit(fault);
      else process.kill(process.pid, fault);
    }, 0);
    return new Promise(() => {});
  }
  const [{ecosystem, downloaded_at, sha256}] = JSON.parse(readFileSync(join(options.offlineDbDir, 'manifest.json'))).databases;
  return result({id, requested_id: id, matched_by: 'id', details: 'Fixture',
    offline_database: {network_requests: false, databases: [{ecosystem, downloaded_at, sha256}]}});
}
`;

it.each([
  ['watchdog', 1, 'watchdog_timeout'],
  ['SIGINT', 130, 'interrupted'],
  ['SIGTERM', 143, 'interrupted'],
  ['scan_timeout', 1, 'comparison_failed'],
] as const)('saves a failed trial over an old success when interrupted by %s', async (fault, exitCode, kind) => {
  const dir = await mkdtemp(join(tmpdir(), 'offline-index-comparison-test-'));
  try {
    const cache = join(dir, 'cache'), output = join(dir, 'report.json'), observed = join(dir, 'observed.json');
    const object = 'Fixture for the comparison harness', sha256 = createHash('sha256').update(object).digest('hex');
    await mkdir(join(cache, 'objects'), {recursive: true});
    await writeFile(join(cache, 'objects', sha256 + '.zip'), object);
    await writeFile(join(cache, 'manifest.json'), JSON.stringify({schema: 1, databases: [{ecosystem: 'npm', sha256,
      bytes: Buffer.byteLength(object), downloaded_at: new Date().toISOString(),
      url: 'https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip'}]}));
    await writeFile(output, JSON.stringify({schema: 2, run_id: 'old-success', status: 'passed', samples: ['old']}));
    const shim = join(dir, 'network.mjs');
    await writeFile(shim, preload);
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    for (const arm of ['before', 'after']) {
      const build = join(dir, arm);
      await mkdir(join(build, 'osv'), {recursive: true});
      await mkdir(join(build, 'tools'));
      await writeFile(join(build, 'osv', 'offlineRecord.js'), `// ${arm}`);
      await writeFile(join(build, 'osv', 'offlineCache.js'), '// cache fixture');
      await writeFile(join(build, 'tools', 'explainVulnerability.js'), handler(arm));
    }
    const child = spawnSync(process.execPath, ['--import', shim, resolve('scripts/compare-offline-explain-index.mjs'),
      '--before', join(dir, 'before'), '--after', join(dir, 'after'), '--cache', cache, '--output', output], {encoding: 'utf8', timeout: 4000,
      env: {...process.env, INDEX_COMPARISON_FAULT: fault, INDEX_COMPARISON_OUTPUT: output, INDEX_COMPARISON_OBSERVED: observed}});

    const running = JSON.parse(await readFile(observed, 'utf8'));
    const report = JSON.parse(await readFile(output, 'utf8'));
    const trial = {phase: 'repeat', round: 1, scenario: 'id', arm: 'after', requested_id: 'GHSA-35jh-r3h4-6jhm'};
    expect(running).toMatchObject({status: 'running', in_progress: {...trial, step: 'handler'}});
    expect(running.run_id).not.toBe('old-success');
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(exitCode);
    expect(report).toMatchObject({schema: 2, run_id: running.run_id, status: 'failed', failure: {...trial, kind,
      step: fault === 'scan_timeout' ? 'validate_response' : 'handler'}});
    expect(report).not.toHaveProperty('in_progress');
    expect(report.samples).toEqual(running.samples);
    expect(report.samples).toHaveLength(1);
    expect(report.samples[0].phase).toBe('first');
    expect(report.failure.elapsed_ms).toBeGreaterThanOrEqual(0);
    if (fault.startsWith('SIG')) expect(report.failure.signal).toBe(fault);
    if (fault === 'scan_timeout') expect(report.failure.tool_error_kind).toBe(fault);
  } finally {await rm(dir, {recursive: true, force: true});}
});
