/** Summarize offline lookup stages and compare the reusable hash buffer experiment. */
import assert from 'node:assert/strict';
import {readFile, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {buildDigest, buildInventory, memoryBindings} from './compare-offline-index-memory.mjs';

const stages = ['copy', 'sha256', 'indexed_read', 'cleanup'];
const replacementStages = ['copy', 'sha256', 'full_read_build', 'cleanup'];
const queries = ['cold', 'warm', 'replace', 'warm_replacement'];
const budget = 256 * 1024 * 1024;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = /^[a-f0-9]{64}$/;
const cacheFile = 'osv/offlineCache.js';
const hashBufferPins = {
  'src/osv/offlineCache.ts': ['b2f7be839a1495988f6b0e0de10df688badceecf1bb87c2ef496a99c7b79c11d',
    '4b05a1734613a0ea1797f83428f1bfaad86f36cd07569e522d93e886d4ea2ffe'],
  ['dist/' + cacheFile]: ['410931c21acd33fa9cc5058c9c91f66891b104e9f5438abffd734d73a35c2dac',
    '049d885474d295904971ecd25d491de0e5b8d9bed38fc367d182f3015c3b3769'],
};

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

function verifyStages(query, databaseBytes, names, entryCount, badEntryCount) {
  assert.deepEqual(query.stages?.map(stage => stage.name), names, 'Missing or misordered RSS stages');
  assert.equal(query.stages[0].count, databaseBytes, 'Copy byte count differs from database size');
  assert.equal(query.stages[1].count, databaseBytes, 'Hash byte count differs from database size');
  assert.equal(query.stages[2].count, entryCount, badEntryCount);
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

export function verifyWarmStages(query, databaseBytes) {
  // The pinned alias has one indexed match in either npm generation.
  verifyStages(query, databaseBytes, stages, 1, 'Unexpected indexed record count');
}

export function verifyReplacementStages(query, precedingWarm, db, events, fullReader) {
  verifyStages(query, db.bytes, replacementStages, db.entries, 'Full-read count differs from database entry count');
  memory(precedingWarm.settled); memory(precedingWarm.post_gc);
  const settledPeak = precedingWarm.settled.process_high_water_rss_bytes;
  const retainedPeak = precedingWarm.post_gc.process_high_water_rss_bytes;
  assert.ok(settledPeak <= retainedPeak && retainedPeak <= query.before.process_high_water_rss_bytes,
    'Process high-water RSS regressed before replacement');
  const [copy, hashStage, build, cleanup] = query.stages;
  const replacementEvents = events.filter(event => event.phase === 3);
  assert.deepEqual(replacementEvents.map(event => event.event),
    ['old_before_drop', 'old_dropped', 'draft_started', 'read_started', 'read_finished', 'before_publish', 'published']);
  const [oldIndex, dropped, draft, readStart, readEnd, beforePublish, published] = replacementEvents;
  const offsets = [copy.start_offset_ms, copy.end_offset_ms, hashStage.start_offset_ms, hashStage.end_offset_ms,
    oldIndex.offset_ms, dropped.offset_ms, build.start_offset_ms, draft.offset_ms, readStart.offset_ms, readEnd.offset_ms,
    build.end_offset_ms, cleanup.start_offset_ms, cleanup.end_offset_ms, beforePublish.offset_ms, published.offset_ms];
  assert.ok(offsets.every((offset, i) => Number.isFinite(offset) && offset >= (offsets[i - 1] ?? 0) && offset <= query.elapsed_ms),
    'Replacement boundary order or request time mismatch');
  for (const stage of query.stages) {
    assert.ok(Math.abs(stage.end_offset_ms - stage.start_offset_ms - stage.elapsed_ms) < 0.001, 'Stage duration differs from its offsets');
  }
  const reused = events.filter(event => event.phase === 2 && event.event === 'reused');
  assert.equal(reused.length, 1);
  assert.ok(reused[0].current);
  assert.deepEqual(oldIndex.current, reused[0].current, 'Released index differs from the preceding indexed lookup');
  assert.equal(oldIndex.draft, null);
  assert.equal(dropped.draft, null);
  for (const event of [dropped, draft, readStart, readEnd, beforePublish]) assert.equal(event.current, null);
  for (const event of replacementEvents) {
    memory(event.memory);
    assert.ok(event.memory.rss_bytes <= query.sampled_peak_rss_bytes);
  }
  for (const event of [draft, readStart, readEnd]) assert.ok(event.memory.rss_bytes <= build.sampled_peak_rss_bytes);
  assert.equal(readEnd.reader.entries, db.entries);
  assert.equal(beforePublish.draft.rows, db.entries);
  assert.deepEqual(published.current, beforePublish.draft);
  assert.ok(Number.isSafeInteger(fullReader.samples) && fullReader.samples >= 2 && fullReader.samples <= build.samples);
  assert.ok(Number.isSafeInteger(fullReader.sampled_peak_rss_bytes) && fullReader.sampled_peak_rss_bytes >=
    Math.max(readStart.memory.rss_bytes, readEnd.memory.rss_bytes) && fullReader.sampled_peak_rss_bytes <= build.sampled_peak_rss_bytes,
  'Reader loop peak exceeds the build window or misses a boundary');
}

function summarize(runs, name, i, names = stages) {
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
  for (const [j, stage] of names.entries()) {
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

async function buildEvidence(tree) {
  const inventory = await buildInventory(tree);
  return {inventory, compiled: buildDigest(inventory), bindings: await memoryBindings(tree, inventory)};
}

function verifyRun(run, reference, {compiled, bindings}, prior, mode) {
  const previous = reference.pairs[0].arms.after;
  assert.equal(run.schema, 4);
  assert.equal(run.profile, 'baseline');
  assert.equal(run.identity_map, 'absent');
  assert.equal(run.compiled_sha256, compiled);
  assert.deepEqual(run.bindings, bindings);
  assert.match(run.instrumented_reader_sha256, hash);
  assert.match(run.instrumented_cache_sha256, hash);
  assert.match(run.run_id, /^[a-f0-9-]{36}$/);
  for (const key of ['runtime', 'instrumented_reader_sha256', 'instrumented_cache_sha256']) {
    if (prior) assert.deepEqual(run[key], prior[key]);
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
    if (mode !== 'warm' && i === 2) verifyReplacementStages(query, run.measurements[1], db, run.events, run.full_reader.replace);
    else if (mode !== 'replacement' && i % 2) verifyWarmStages(query, db.bytes);
    else assert.equal(query.stages, undefined);
  }
}

async function compareHashBuffer(runsDir, beforeTree, reference, after) {
  const before = await buildEvidence(beforeTree);
  assert.equal(before.compiled, reference.pairs[0].arms.after.compiled_sha256, 'Different baseline build from the reference');
  assert.deepEqual(Object.keys(before.inventory), Object.keys(after.inventory));
  assert.deepEqual(Object.keys(before.inventory).filter(key => before.inventory[key] !== after.inventory[key]), [cacheFile]);
  assert.deepEqual(Object.keys(before.bindings).filter(key => before.bindings[key] !== after.bindings[key]), Object.keys(hashBufferPins));
  for (const [key, pins] of Object.entries(hashBufferPins)) {
    assert.deepEqual([before.bindings[key], after.bindings[key]], pins, `Unexpected hash-buffer source or build bytes (${key})`);
  }
  const pairs = [], ids = new Set();
  for (let round = 1; round <= 3; round++) {
    const pair = {round};
    for (const [arm, evidence] of [['before', before], ['after', after]]) {
      const run = await readJson(join(runsDir, `run-${round}-${arm}.json`));
      verifyRun(run, reference, evidence, pairs[0]?.[arm], 'all');
      assert.ok(!ids.has(run.run_id), 'Duplicate process measurement');
      ids.add(run.run_id);
      pair[arm] = run;
    }
    assert.deepEqual(pair.before.runtime, pair.after.runtime);
    assert.equal(pair.before.instrumented_reader_sha256, pair.after.instrumented_reader_sha256);
    assert.notEqual(pair.before.instrumented_cache_sha256, pair.after.instrumented_cache_sha256);
    pairs.push(pair);
  }
  const paired = select => {
    const baseline = pairs.map(pair => select(pair.before)), candidate = pairs.map(pair => select(pair.after));
    return {before: range(baseline), after: range(candidate), paired_before_minus_after: range(baseline.map((n, i) => n - candidate[i]))};
  };
  const indexed = i => {
    const stage = r => r.measurements[i].stages[1];
    return {request_peak_rss_bytes: paired(r => r.measurements[i].sampled_peak_rss_bytes),
      hash_peak_above_stage_start_bytes: paired(r => stage(r).sampled_peak_rss_bytes - stage(r).before.rss_bytes),
      hash_array_buffers_change_bytes: paired(r => stage(r).settled.array_buffers_bytes - stage(r).before.array_buffers_bytes),
      post_gc_rss_bytes: paired(r => r.measurements[i].post_gc.rss_bytes), hash_elapsed_ms: paired(r => stage(r).elapsed_ms)};
  };
  return {schema: 1, comparison: 'hash-buffer', rss_budget_bytes: budget, changed_compiled_files: [cacheFile],
    warm: indexed(1), warm_replacement: indexed(3), replacement_start_rss_bytes: paired(r => r.measurements[2].before.rss_bytes),
    replacement_peak_rss_bytes: paired(r => r.measurements[2].sampled_peak_rss_bytes), pairs};
}

async function main() {
  const {values} = parseArgs({options: {tree: {type: 'string', default: '.'}, 'runs-dir': {type: 'string'},
    output: {type: 'string'}, replacement: {type: 'boolean', default: false}, 'hash-buffer-before-tree': {type: 'string'}}});
  assert.ok(values['runs-dir'] && values.output, 'Supply --runs-dir DIR --output FILE');
  assert.ok(!values.replacement || !values['hash-buffer-before-tree'], 'Choose one report mode');
  const reference = await readJson(new URL('../docs/validation/offline-npm-early-index-release-2026-11-24.json', import.meta.url));
  const evidence = await buildEvidence(values.tree);
  if (values['hash-buffer-before-tree']) {
    const report = await compareHashBuffer(values['runs-dir'], values['hash-buffer-before-tree'], reference, evidence);
    await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
    console.log('Verified three hash-buffer pairs');
    return;
  }
  const {compiled} = evidence, runs = [];
  assert.equal(compiled, reference.pairs[0].arms.after.compiled_sha256, 'Different product build from the reference');
  for (let round = 1; round <= 3; round++) {
    const run = await readJson(join(values['runs-dir'], `run-${round}.json`));
    verifyRun(run, reference, evidence, runs[0], values.replacement ? 'replacement' : 'warm');
    assert.ok(!runs.some(prior => prior.run_id === run.run_id));
    runs.push(run);
  }
  const report = {schema: 1, rss_budget_bytes: budget, reference_build_sha256: compiled,
    ...(values.replacement ? {replacement: {
      ...summarize(runs, 'replace', 2, replacementStages),
      request_start_rss_bytes: range(runs.map(run => run.measurements[2].before.rss_bytes)),
      start_over_budget: runs.filter(run => run.measurements[2].before.rss_bytes > budget).length,
      request_peak_above_start_bytes: range(runs.map(run => run.measurements[2].sampled_peak_rss_bytes - run.measurements[2].before.rss_bytes)),
      build_peak_above_request_start_bytes: range(runs.map(run => run.measurements[2].stages[2].sampled_peak_rss_bytes - run.measurements[2].before.rss_bytes)),
      reader_loop_peak_rss_bytes: range(runs.map(run => run.full_reader.replace.sampled_peak_rss_bytes)),
      preceding_warm_post_gc_rss_bytes: range(runs.map(run => run.measurements[1].post_gc.rss_bytes)),
      rss_change_since_preceding_warm_post_gc_bytes: range(runs.map(run =>
        run.measurements[2].before.rss_bytes - run.measurements[1].post_gc.rss_bytes)),
    }} : {warm: summarize(runs, 'warm', 1), warm_replacement: summarize(runs, 'warm_replacement', 3)}), runs};
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(values.replacement ? 'Verified three processes and three generation replacements' : 'Verified three processes and six indexed lookups');
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main();
