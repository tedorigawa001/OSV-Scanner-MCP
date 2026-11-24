import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import * as nodeModule from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {expect, it} from 'vitest';
// @ts-ignore Repository validation artifact, separate from the shipped server.
import {buildDigest, buildInventory, compareRuns, memoryBindings, recordBufferEdits} from '../../../scripts/compare-offline-index-memory.mjs';
import {recordZip} from '../fixtures/offlineRecords.js';

const mib = 1024 * 1024;
const id = 'GHSA-35jh-r3h4-6jhm', alias = 'CVE-2021-23337';
const url = 'https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function put(file: string, body: string | Buffer) {
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, body);
}

it.skipIf(process.platform === 'win32' || !('registerHooks' in nodeModule))(
  'measures the real reader through a directory alias', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'index-memory-path-test-')));
    try {
      const tree = join(root, 'tree'), aliasedTree = join(root, 'alias'), output = join(root, 'run.json');
      await mkdir(tree);
      await symlink(tree, aliasedTree, 'dir');
      await symlink(resolve('src'), join(tree, 'src'), 'dir');
      await symlink(resolve('node_modules'), join(tree, 'node_modules'), 'dir');
      for (const name of ['package.json', 'package-lock.json']) await copyFile(name, join(tree, name));
      const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json',
        '--outDir', join(tree, 'dist')], {encoding: 'utf8', timeout: 15_000});
      expect(build.status, build.error?.message ?? build.stderr + build.stdout).toBe(0);
      expect(await realpath(aliasedTree)).toBe(tree);
      const caches = await Promise.all([0, 1].map(async generation => {
        const dir = join(root, 'cache-' + generation);
        const bytes = recordZip([
          {name: id + '.json', body: JSON.stringify({id, aliases: [alias], details: `Fixture generation ${generation}`})},
          ...Array.from({length: 512}, (_, i) => ({name: `TEST-${i}.json`, body: JSON.stringify({id: `TEST-${i}`})})),
        ]);
        const sha = sha256(bytes);
        await put(join(dir, 'objects', sha + '.zip'), bytes);
        await put(join(dir, 'manifest.json'), JSON.stringify({schema: 1, databases: [{ecosystem: 'npm', sha256: sha,
          bytes: bytes.length, downloaded_at: new Date(Date.now() - (1 - generation) * 60_000).toISOString(), url}]}));
        return dir;
      }));
      const preload = join(root, 'deny-probe.mjs');
      // The fixture controls the probe. The official-DB run separately exercises OS-enforced denial.
      await writeFile(preload, `
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
createRequire(import.meta.url)('node:net').connect = () => {
  const socket = new EventEmitter();
  socket.setTimeout = socket.destroy = () => {};
  queueMicrotask(() => socket.emit('error', {code: 'EPERM'}));
  return socket;
};
syncBuiltinESMExports();
`);
      const digest = buildDigest(await buildInventory(tree));
      for (const profile of ['baseline', 'drop-old']) {
        const run = spawnSync(process.execPath, ['--expose-gc', '--import', preload, 'scripts/measure-offline-index-native.mjs',
          '--old-cache', caches[0]!, '--new-cache', caches[1]!, '--tree', aliasedTree, '--identity-map', 'absent',
          '--profile', profile, '--output', output], {encoding: 'utf8', timeout: 15_000});
        expect(run.status, run.error?.message ?? run.stderr + run.stdout).toBe(0);
        const measured = JSON.parse(await readFile(output, 'utf8'));
        expect(measured.profile).toBe(profile);
        expect(measured.measurements.map((m: {name: string}) => m.name)).toEqual(['cold', 'warm', 'replace', 'warm_replacement']);
        expect(measured.events.filter((e: {event: string}) => e.event === 'read_finished')).toHaveLength(2);
        const published = measured.events.filter((e: {event: string}) => e.event === 'before_publish');
        expect(published).toHaveLength(2);
        for (const {draft} of published) expect(draft).toMatchObject({rows: 513, location_table_bytes: 1024 * 20});
        expect(measured.events.filter((e: {phase: number}) => e.phase === 3).slice(0, 3)).toMatchObject([
          {event: 'old_before_drop', current: published[0].draft, draft: null},
          {event: 'old_dropped', current: null, draft: null},
          {event: 'draft_started', current: null},
        ]);
        expect(measured.overlap).toEqual({sampled_peak_rss_bytes: 0, samples: 0});
        expect(measured.compiled_sha256).toBe(digest);
      }
    } finally {await rm(root, {recursive: true, force: true});}
  },
);

const readerPaths = ['src/osv/offlineRecord.ts', 'dist/osv/offlineRecord.js'] as const;

async function comparisonFixture(root: string, {keepOldDigestTable = true, recordBuffer = false,
  extraReaderPath}: {keepOldDigestTable?: boolean; recordBuffer?: boolean; extraReaderPath?: typeof readerPaths[number]} = {}) {
  const trees = {before: join(root, 'before'), after: join(root, 'after')};
  const runsDir = join(root, 'runs');
  const databases = [0, 1].map(i => ({ecosystem: 'npm', url, bytes: 300 + i, entries: 10 + i,
    downloaded_at: `2026-11-${21 + i}T00:00:00.000Z`, sha256: sha256('ZIP-' + i)}));
  for (const arm of ['before', 'after'] as const) {
    const tree = trees[arm];
    for (const name of ['package.json', 'package-lock.json', 'src/osv/offlineCache.ts', 'src/tools/explainVulnerability.ts',
      'dist/osv/offlineCache.js', 'dist/tools/explainVulnerability.js', 'dist/other.js']) await put(join(tree, name), name);
    for (const name of readerPaths) {
      const edits: readonly (readonly [string, string])[] = recordBufferEdits[name];
      const reader = recordBuffer ? edits.map(([before, after]) => arm === 'before' ? before : after).join('\n') : arm + name;
      const independent = arm === 'after' && extraReaderPath === name ? '\nconst indexLimit = 500;' : '';
      await put(join(tree, name), reader + independent);
    }
    const inventory = await buildInventory(tree), bindings = await memoryBindings(tree, inventory);
    const present = keepOldDigestTable && arm === 'before';
    for (const [i, coldMiB] of (arm === 'before' ? [400, 320, 330] : [300, 310, 250]).entries()) {
      const measurements = ['cold', 'warm', 'replace', 'warm_replacement'].map((name, stage) => ({name,
        database_sha256: databases[stage < 2 ? 0 : 1]!.sha256, requested_id: stage % 2 === 0 ? id : alias,
        response_sha256: sha256(name), samples: 100, sampled_peak_rss_bytes: (coldMiB + stage * 10) * mib,
        before: {rss_bytes: 190*mib}, settled: {rss_bytes: 200*mib, process_high_water_rss_bytes: (coldMiB + stage * 10) * mib},
        post_gc: {heap_used_bytes: 55*mib}}));
      const full = {samples: 80, sampled_peak_rss_bytes: 220*mib};
      const events = databases.map((d, j) => ({phase: 1 + j * 2, event: 'read_finished',
        reader: {entries: d.entries, names: d.entries, expanded_bytes: 200 + j, identity_map: present, identities: present ? d.entries : 0},
        memory: {rss_bytes: 210*mib, heap_used_bytes: 120*mib}}));
      await put(join(runsDir, `run-${i + 1}-${arm}.json`), JSON.stringify({schema: 4, run_id: randomUUID(), profile: 'baseline',
        identity_map: present ? 'present' : 'absent', compiled_sha256: buildDigest(inventory), bindings,
        instrumented_reader_sha256: sha256('instrumented-' + arm), network: {loopback: 'EPERM', fetch_attempts: 0}, sample_interval_ms: 10,
        runtime: {node: 'v26.12.1', platform: 'darwin', arch: 'arm64', release: 'fixture'}, databases, measurements,
        full_reader: {cold: full, replace: full}, overlap: full, baseline: {heap_used_bytes: 10*mib},
        events: [...events, {phase: 3, event: 'before_publish', distinct: true, memory: {rss_bytes: 210*mib}}]}));
    }
  }
  return {beforeTree: trees.before, afterTree: trees.after, runsDir};
}

it.each([
  ['complete', ''], ['db', 'Different DB generations'], ['artifact', 'Unexpected compiled-file differences'],
  ['build-digest', 'build inventory digest mismatch'], ['response', 'Different lookup responses'], ['count', 'Different full-reader counters'],
] as const)('validates and summarizes paired memory reports (%s)', async (mode, reason) => {
  const root = await mkdtemp(join(tmpdir(), 'index-memory-compare-test-'));
  try {
    const options = await comparisonFixture(root);
    if (mode === 'complete') {
      const result = await compareRuns(options);
      expect(result.pairs).toHaveLength(3);
      expect(result.summary_bytes.cold_request_peak_rss.paired_before_minus_after).toEqual({min: 10*mib, max: 100*mib, median: 80*mib});
      return;
    }
    if (mode === 'artifact') await writeFile(join(options.afterTree, 'dist/other.js'), 'changed separately');
    else {
      const file = join(options.runsDir, 'run-1-after.json'), run = JSON.parse(await readFile(file, 'utf8'));
      if (mode === 'db') {
        run.databases[0].sha256 = sha256('Different ZIP');
        for (const m of run.measurements.slice(0, 2)) m.database_sha256 = run.databases[0].sha256;
      }
      if (mode === 'build-digest') run.compiled_sha256 = sha256('Different build');
      if (mode === 'response') run.measurements[0].response_sha256 = sha256('Different reply');
      if (mode === 'count') run.events[0].reader.expanded_bytes++;
      await writeFile(file, JSON.stringify(run));
    }
    await expect(compareRuns(options)).rejects.toThrow(reason);
  } finally {await rm(root, {recursive: true, force: true});}
});

it.each([false, true])('requires both record-buffer arms to omit the digest table (keep old=%s)', async keepOldDigestTable => {
  const root = await mkdtemp(join(tmpdir(), 'record-buffer-compare-test-'));
  try {
    const options = await comparisonFixture(root, {keepOldDigestTable, recordBuffer: true});
    const report = compareRuns({...options, comparison: 'record-buffer'});
    if (keepOldDigestTable) await expect(report).rejects.toThrow('unexpected digest-table policy');
    else {
      const result = await report;
      expect(result.comparison).toBe('record-buffer');
      expect(result.summary_bytes.cold_request_peak_rss.paired_before_minus_after).toEqual({min: 10*mib, max: 100*mib, median: 80*mib});
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

it.each(readerPaths)('rejects an additional reader change with updated measurement hashes (%s)', async extraReaderPath => {
  const root = await mkdtemp(join(tmpdir(), 'record-buffer-diff-test-'));
  try {
    const options = await comparisonFixture(root, {keepOldDigestTable: false, recordBuffer: true, extraReaderPath});
    // The fixture binds the modified files to all runs before comparing their actual contents.
    await expect(compareRuns({...options, comparison: 'record-buffer'})).rejects
      .toThrow(`Unexpected change outside the approved record-buffer edits (${extraReaderPath})`);
  } finally {await rm(root, {recursive: true, force: true});}
});

it('rejects unapproved validation reader builds even with matching measurement hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'record-validation-diff-test-'));
  try {
    const options = await comparisonFixture(root, {keepOldDigestTable: false, recordBuffer: true});
    await expect(compareRuns({...options, comparison: 'record-validation'})).rejects
      .toThrow('Unexpected record-validation reader bytes');
  } finally {await rm(root, {recursive: true, force: true});}
});
