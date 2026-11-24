/** Summarize stage-by-stage RSS observations from the offline index benchmark. */
import assert from 'node:assert/strict';
import {readFile, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {buildDigest, buildInventory, memoryBindings} from './compare-offline-index-memory.mjs';

const stages = ['copy', 'sha256', 'indexed_read', 'cleanup'];
const queries = ['cold', 'warm', 'replace', 'warm_replacement'];
const budget = 256 * 1024 * 1024;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = /^[a-f0-9]{64}$/;

function range(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1)};
}

function memory(snapshot) {
  for (const name of ['rss_bytes', 'heap_used_bytes', 'array_buffers_bytes', 'process_high_water_rss_bytes']) {
    assert.ok(Number.isSafeInteger(snapshot?.[name]) && snapshot[name] >= 0, `Invalid memory field: ${name}`);
  }
  assert.ok(snapshot.rss_bytes > 0 && snapshot.rss_bytes <= snapshot.process_high_water_rss_bytes + 1024);
}

export function verifyWarmStages(query, databaseBytes) {
  assert.deepEqual(query.stages?.map(stage => stage.name), stages, 'Missing or misordered warm stages');
  assert.equal(query.stages[0].count, databaseBytes, 'Copy byte count differs from database size');
  assert.equal(query.stages[1].count, databaseBytes, 'Hash byte count differs from database size');
  // The pinned alias in this benchmark has one indexed match in either npm generation.
  assert.equal(query.stages[2].count, 1, 'Unexpected indexed record count');
  assert.equal(query.stages[3].count, undefined);
  memory(query.before); memory(query.settled); memory(query.post_gc);
  assert.ok(Number.isFinite(query.elapsed_ms) && query.elapsed_ms > 0);
  assert.ok(Number.isSafeInteger(query.sampled_peak_rss_bytes) && query.sampled_peak_rss_bytes >=
    Math.max(query.before.rss_bytes, query.settled.rss_bytes) &&
    query.sampled_peak_rss_bytes <= query.settled.process_high_water_rss_bytes + 1024);
  assert.ok(Number.isSafeInteger(query.samples) && query.samples > 0, 'Invalid request sample count');
  let time = 0, samples = 0;
  for (const stage of query.stages) {
    memory(stage.before); memory(stage.settled);
    assert.ok(Number.isFinite(stage.elapsed_ms) && stage.elapsed_ms >= 0);
    time += stage.elapsed_ms;
    assert.ok(Number.isSafeInteger(stage.samples) && stage.samples >= 2, 'Missing stage boundary samples');
    samples += stage.samples;
    assert.ok(Number.isSafeInteger(stage.sampled_peak_rss_bytes) && stage.sampled_peak_rss_bytes >=
      Math.max(stage.before.rss_bytes, stage.settled.rss_bytes) && stage.sampled_peak_rss_bytes <=
      Math.min(query.sampled_peak_rss_bytes, stage.settled.process_high_water_rss_bytes + 1024), 'Inconsistent stage RSS peak');
  }
  assert.ok(time <= query.elapsed_ms, 'Stage time exceeds request time');
  assert.ok(samples <= query.samples, 'Stage samples exceed request samples');
}

function summarize(runs, name, i) {
  const samples = runs.map(run => run.measurements[i]);
  const summary = {};
  const retained = [];
  const first = [];
  const hits = [];
  for (const [j, query] of samples.entries()) {
    const heapAndBuffers = m => m.heap_used_bytes + m.array_buffers_bytes;
    retained.push({rss_after_response_bytes: query.settled.rss_bytes, rss_after_gc_bytes: query.post_gc.rss_bytes,
      rss_change_at_response_bytes: query.settled.rss_bytes - query.before.rss_bytes,
      rss_change_after_gc_bytes: query.post_gc.rss_bytes - query.before.rss_bytes,
      array_buffers_change_at_response_bytes: query.settled.array_buffers_bytes - query.before.array_buffers_bytes,
      array_buffers_change_after_gc_bytes: query.post_gc.array_buffers_bytes - query.before.array_buffers_bytes,
      heap_and_buffers_change_after_gc_bytes: heapAndBuffers(query.post_gc) - heapAndBuffers(query.before),
      heap_and_buffers_above_baseline_after_gc_bytes: heapAndBuffers(query.post_gc) - heapAndBuffers(runs[j].baseline)});
    first.push(query.before.rss_bytes > budget ? 'request_start' :
      query.stages.find(stage => stage.sampled_peak_rss_bytes > budget)?.name ??
      (query.sampled_peak_rss_bytes > budget ? 'outside_tracked_stages' : 'under_budget'));
    hits.push(query.stages.filter(stage => stage.sampled_peak_rss_bytes === query.sampled_peak_rss_bytes).map(stage => stage.name));
  }
  for (const [j, stage] of stages.entries()) {
    const evidence = samples.map(query => query.stages[j]);
    summary[stage] = {peak_rss_bytes: range(evidence.map(s => s.sampled_peak_rss_bytes)),
      peak_above_stage_start_bytes: range(evidence.map(s => s.sampled_peak_rss_bytes - s.before.rss_bytes)),
      rss_change_bytes: range(evidence.map(s => s.settled.rss_bytes - s.before.rss_bytes)),
      array_buffers_change_bytes: range(evidence.map(s => s.settled.array_buffers_bytes - s.before.array_buffers_bytes)),
      elapsed_ms: range(evidence.map(s => s.elapsed_ms))};
  }
  return {name, stages: summary, request_peak_rss_bytes: range(samples.map(q => q.sampled_peak_rss_bytes)),
    over_budget: samples.filter(q => q.sampled_peak_rss_bytes > budget).length,
    first_tracked_over_budget: first, stages_matching_request_peak: hits,
    retained: Object.fromEntries(Object.keys(retained[0]).map(key => [key, range(retained.map(row => row[key]))]))};
}

async function main() {
  const {values} = parseArgs({options: {tree: {type: 'string', default: '.'}, 'runs-dir': {type: 'string'}, output: {type: 'string'}}});
  assert.ok(values['runs-dir'] && values.output, 'Supply --runs-dir DIR --output FILE');
  const reference = await readJson(new URL('../docs/validation/offline-npm-early-index-release-2026-11-24.json', import.meta.url));
  const previous = reference.pairs[0].arms.after;
  const inventory = await buildInventory(values.tree), bindings = await memoryBindings(values.tree, inventory);
  const compiled = buildDigest(inventory), runs = [];
  for (let round = 1; round <= 3; round++) {
    const run = await readJson(join(values['runs-dir'], `run-${round}.json`));
    assert.equal(run.schema, 4);
    assert.equal(run.profile, 'baseline');
    assert.equal(run.identity_map, 'absent');
    assert.equal(run.compiled_sha256, compiled);
    assert.equal(run.compiled_sha256, previous.compiled_sha256, 'Different product build from the reference');
    assert.deepEqual(run.bindings, bindings);
    assert.match(run.instrumented_reader_sha256, hash);
    assert.match(run.instrumented_cache_sha256, hash);
    assert.match(run.run_id, /^[a-f0-9-]{36}$/);
    assert.ok(!runs.some(prior => prior.run_id === run.run_id));
    for (const key of ['runtime', 'instrumented_reader_sha256', 'instrumented_cache_sha256']) {
      if (runs.length) assert.deepEqual(run[key], runs[0][key]);
    }
    assert.equal(run.sample_interval_ms, 10);
    assert.ok(['EPERM', 'EACCES'].includes(run.network.loopback));
    assert.equal(run.network.fetch_attempts, 0);
    assert.deepEqual(run.databases, previous.databases);
    assert.deepEqual(run.measurements.map(query => query.name), queries);
    assert.deepEqual(run.events.filter(e => e.event === 'read_finished').map(e => e.reader),
      previous.events.filter(e => e.event === 'read_finished').map(e => e.reader));
    assert.deepEqual(run.events.filter(e => e.event === 'reused').map(e => [e.phase, e.current]),
      previous.events.filter(e => e.event === 'reused').map(e => [e.phase, e.current]));
    memory(run.baseline);
    for (const [i, query] of run.measurements.entries()) {
      const db = run.databases[i < 2 ? 0 : 1];
      assert.equal(query.database_sha256, db.sha256);
      assert.equal(query.response_sha256, reference.common_response_sha256[query.name]);
      if (i % 2) verifyWarmStages(query, db.bytes);
      else assert.equal(query.stages, undefined);
    }
    runs.push(run);
  }
  const report = {schema: 1, rss_budget_bytes: budget, reference_build_sha256: compiled,
    warm: summarize(runs, 'warm', 1), warm_replacement: summarize(runs, 'warm_replacement', 3), runs};
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log('Verified three processes and six indexed lookups');
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main();
