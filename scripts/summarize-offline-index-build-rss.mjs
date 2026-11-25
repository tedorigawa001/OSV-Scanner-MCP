/** Compare the current offline reader with its index draft suppressed at one request. */
import assert from 'node:assert/strict';
import {readFile, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {buildDigest, buildInventory, memoryBindings} from './compare-offline-index-memory.mjs';

const budget = 256 * 1024 * 1024;
const profiles = ['baseline', 'reader-only', 'replacement-reader-only'];
const order = [profiles, [profiles[1], profiles[2], profiles[0]], [profiles[2], profiles[0], profiles[1]]];
const readEvents = ['read_started', 'read_finished'];
const buildEvents = ['draft_started', ...readEvents, 'before_publish', 'published'];
const dropEvents = ['old_before_drop', 'old_dropped'];
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

function verifyMemory(snapshot) {
  for (const key of ['heap_used_bytes', 'array_buffers_bytes', 'rss_bytes', 'process_high_water_rss_bytes']) {
    assert.ok(Number.isSafeInteger(snapshot?.[key]) && snapshot[key] >= 0, `Invalid memory field: ${key}`);
  }
  assert.ok(snapshot.rss_bytes > 0 && snapshot.rss_bytes <= snapshot.process_high_water_rss_bytes + 1024);
}

export function verifyBuildControl(run, profile) {
  assert.equal(run.profile, profile);
  const coldOnly = profile === 'reader-only', replacementOnly = profile === 'replacement-reader-only';
  const expectedRequests = coldOnly ? ['cold'] : ['cold', 'warm', 'replace'];
  if (profile === 'baseline') expectedRequests.push('warm_replacement');
  assert.deepEqual(run.measurements.map(query => query.name), expectedRequests);
  const expectedEvents = [[1, coldOnly ? readEvents : buildEvents]];
  if (!coldOnly) expectedEvents.push([2, ['reused']],
    [3, [...dropEvents, ...(replacementOnly ? ['draft_suppressed', ...readEvents] : buildEvents)]]);
  if (profile === 'baseline') expectedEvents.push([4, ['reused']]);
  assert.deepEqual(run.events.map(e => [e.phase, e.event]), expectedEvents.flatMap(([phase, names]) =>
    names.map(name => [phase, name])), 'Unexpected index or reader events');
  assert.deepEqual(run.overlap, {sampled_peak_rss_bytes: 0, samples: 0});
  verifyMemory(run.baseline);
  let highWater = run.baseline.process_high_water_rss_bytes;
  for (const [i, query] of run.measurements.entries()) {
    const boundaries = run.events.filter(e => e.phase === i + 1).map(e => e.memory);
    for (const snapshot of [query.before, ...boundaries, query.settled, query.post_gc]) {
      verifyMemory(snapshot);
      assert.ok(snapshot.process_high_water_rss_bytes >= highWater, 'Process high-water RSS regressed');
      highWater = snapshot.process_high_water_rss_bytes;
    }
    assert.ok(Number.isFinite(query.elapsed_ms) && query.elapsed_ms > 0);
    assert.ok(Number.isSafeInteger(query.sampled_peak_rss_bytes) && query.sampled_peak_rss_bytes >=
      Math.max(query.before.rss_bytes, ...boundaries.map(m => m.rss_bytes), query.settled.rss_bytes) &&
      query.sampled_peak_rss_bytes <= query.settled.process_high_water_rss_bytes + 1024, 'Inconsistent request RSS peak');
    assert.ok(Number.isSafeInteger(query.samples) && query.samples >= 2);
  }
  const event = (phase, name) => run.events.find(e => e.phase === phase && e.event === name);
  const published = (phase, database) => {
    const draft = event(phase, 'before_publish').draft;
    assert.equal(draft.rows, database.entries);
    assert.ok(draft.postings >= database.entries);
    assert.deepEqual(event(phase, 'published').current, draft);
    return draft;
  };
  if (!coldOnly) {
    const old = published(1, run.databases[0]);
    assert.deepEqual(event(2, 'reused').current, old);
    assert.deepEqual(event(3, 'old_before_drop').current, old);
    assert.equal(event(3, 'old_before_drop').draft, null);
    assert.equal(event(3, 'old_dropped').current, null);
    assert.equal(event(3, 'old_dropped').draft, null);
    if (!replacementOnly) assert.deepEqual(event(4, 'reused').current, published(3, run.databases[1]));
  }
  for (const [name, phase, index] of coldOnly ? [['cold', 1, 0]] : [['cold', 1, 0], ['replace', 3, 2]]) {
    const query = run.measurements[index], loop = run.full_reader[name];
    const start = event(phase, 'read_started'), end = event(phase, 'read_finished');
    const db = run.databases[phase === 1 ? 0 : 1];
    assert.equal(end.reader.entries, db.entries);
    assert.equal(end.reader.names, db.entries);
    assert.ok(Number.isSafeInteger(end.reader.expanded_bytes) && end.reader.expanded_bytes > 0);
    assert.equal(end.reader.identity_map, false);
    assert.equal(end.reader.identities, 0);
    assert.ok(Number.isSafeInteger(loop.samples) && loop.samples >= 2 && loop.samples <= query.samples);
    assert.ok(Number.isSafeInteger(loop.sampled_peak_rss_bytes) &&
      loop.sampled_peak_rss_bytes <= Math.min(query.sampled_peak_rss_bytes, end.memory.process_high_water_rss_bytes + 1024) &&
      loop.sampled_peak_rss_bytes >= Math.max(start.memory.rss_bytes, end.memory.rss_bytes));
    for (const e of run.events.filter(e => e.phase === phase)) {
      if ((phase === 1 && coldOnly) || (phase === 3 && replacementOnly && e.event !== 'old_before_drop')) {
        assert.equal(e.current, null, 'Reader-only control retained a cached index');
        assert.equal(e.draft, null, 'Reader-only control allocated an index draft');
      }
    }
    if (phase === 3) {
      assert.equal(start.current, null);
      assert.equal(end.current, null);
    }
  }
}

function range(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {min: sorted[0], median: sorted[1], max: sorted[2]};
}

function summary(rounds, phase, control) {
  const index = phase === 'cold' ? 0 : 2;
  const retained = m => m.heap_used_bytes + m.array_buffers_bytes;
  const metrics = {
    request_start_rss_bytes: r => r.measurements[index].before.rss_bytes,
    request_peak_rss_bytes: r => r.measurements[index].sampled_peak_rss_bytes,
    request_peak_above_start_bytes: r => r.measurements[index].sampled_peak_rss_bytes - r.measurements[index].before.rss_bytes,
    reader_peak_rss_bytes: r => r.full_reader[phase].sampled_peak_rss_bytes,
    reader_peak_above_request_start_bytes: r => r.full_reader[phase].sampled_peak_rss_bytes - r.measurements[index].before.rss_bytes,
    post_gc_rss_bytes: r => r.measurements[index].post_gc.rss_bytes,
    post_gc_heap_buffers_above_baseline_bytes: r => retained(r.measurements[index].post_gc) - retained(r.baseline),
    elapsed_ms: r => r.measurements[index].elapsed_ms,
  };
  return Object.fromEntries(Object.entries(metrics).map(([key, select]) => {
    const withIndex = rounds.map(round => select(round.runs.baseline));
    const withoutIndex = rounds.map(round => select(round.runs[control]));
    return [key, {with_index: range(withIndex), without_index: range(withoutIndex),
      paired_with_minus_without: range(withIndex.map((n, i) => n - withoutIndex[i]))}];
  }));
}

async function main() {
  const {values} = parseArgs({options: {tree: {type: 'string', default: '.'}, 'runs-dir': {type: 'string'}, output: {type: 'string'}}});
  assert.ok(values['runs-dir'] && values.output, 'Supply --runs-dir DIR --output FILE');
  const ref = (await readJson(new URL('../docs/validation/offline-npm-hash-buffer-rss-2026-11-25.json', import.meta.url))).pairs[0].after;
  const inventory = await buildInventory(values.tree), compiled = buildDigest(inventory);
  const bindings = await memoryBindings(values.tree, inventory);
  assert.equal(compiled, ref.compiled_sha256, 'Unexpected product build');
  const rounds = [], ids = new Set();
  let runtime;
  for (const [i, sequence] of order.entries()) {
    const runs = {};
    for (const profile of sequence) {
      const run = await readJson(join(values['runs-dir'], `run-${i + 1}-${profile}.json`));
      verifyBuildControl(run, profile);
      assert.equal(run.schema, 4);
      assert.equal(run.identity_map, 'absent');
      assert.equal(run.sample_interval_ms, 10);
      assert.equal(run.compiled_sha256, compiled);
      assert.deepEqual(run.bindings, bindings);
      assert.equal(run.instrumented_cache_sha256, undefined);
      assert.match(run.run_id, /^[a-f0-9-]{36}$/);
      assert.ok(!ids.has(run.run_id));
      ids.add(run.run_id);
      runtime ??= run.runtime;
      assert.deepEqual(run.runtime, runtime);
      assert.match(run.instrumented_reader_sha256, /^[a-f0-9]{64}$/);
      if (rounds.length) assert.equal(run.instrumented_reader_sha256, rounds[0].runs[profile].instrumented_reader_sha256);
      assert.ok(['EPERM', 'EACCES'].includes(run.network.loopback));
      assert.equal(run.network.fetch_attempts, 0);
      assert.deepEqual(run.databases, ref.databases);
      for (const [j, query] of run.measurements.entries()) {
        assert.equal(query.database_sha256, ref.measurements[j].database_sha256);
        assert.equal(query.requested_id, ref.measurements[j].requested_id);
        assert.equal(query.response_sha256, ref.measurements[j].response_sha256);
      }
      for (const e of run.events.filter(e => ['read_finished', 'reused'].includes(e.event))) {
        const expected = ref.events.find(old => old.phase === e.phase && old.event === e.event);
        if (e.event === 'read_finished') assert.deepEqual(e.reader, expected.reader);
        else assert.deepEqual(e.current, expected.current);
      }
      runs[profile] = run;
    }
    assert.equal(new Set(Object.values(runs).map(run => run.instrumented_reader_sha256)).size, profiles.length);
    rounds.push({round: i + 1, order: sequence, runs});
  }
  await writeFile(values.output, JSON.stringify({schema: 1, rss_budget_bytes: budget, compiled_sha256: compiled,
    cold: summary(rounds, 'cold', 'reader-only'), replacement: summary(rounds, 'replace', 'replacement-reader-only'), rounds}, null, 2) + '\n');
  console.log('Verified nine processes and both index-build controls');
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main();
