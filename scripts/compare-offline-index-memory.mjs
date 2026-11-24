/** Verify and summarize paired offline index RSS measurements. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const readerFile = 'osv/offlineRecord.js';
const arms = ['before', 'after'];
const order = [arms, ['after', 'before'], arms];
const phases = ['cold', 'warm', 'replace', 'warm_replacement'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;

// Independently pin the reviewed validation-only change in the source and compiled reader.
const validationReaderPins = {
  'src/osv/offlineRecord.ts': [
    '71089bff22e04c83f269548b054466e70d8f87e3bce4f4f940e4020ab77408b7',
    'fc0d6d66c7bd4773efe2eaca90d4570a9c6f79916103c3a565a623f5c2178ced',
  ],
  ['dist/' + readerFile]: [
    'f40421c679f2881eb93ffec3df37a55f013c78de914454e17ddad9fb6171aad2',
    'd16ec49214ed267724bba2f56c73b3737a0e5722fa363561d00642b72d8aa347',
  ],
};

const compactReaderPins = {
  'src/osv/offlineRecord.ts': [validationReaderPins['src/osv/offlineRecord.ts'][1],
    '90b5ce9998c83642e10b1be3144ca36caba385709778a1caa2ac3f1021fe20c2'],
  ['dist/' + readerFile]: [validationReaderPins['dist/' + readerFile][1],
    'c82b81f4a78829ce1edb61552fa056202a292c2172c56ccebb09ce54b7125908'],
};

const releaseReaderPins = {
  'src/osv/offlineRecord.ts': [compactReaderPins['src/osv/offlineRecord.ts'][1],
    '1f1cc45b06484c36c6e281d73bc913b4e7511481c4cada86d80f41b38a1e2604'],
  ['dist/' + readerFile]: [compactReaderPins['dist/' + readerFile][1],
    '34a73b48b88e1e50f822be6711553080ad044a49f4cfb27d88623a59643bfe7a'],
};

// Approved edits for this experiment, in the source and in the locked compiler's output.
// Compare whole files after applying only these edits so another change in either reader is rejected.
const decodeEdit = Object.freeze(['.decode(Buffer.concat(chunks, bytes))));', '.decode(buffer)));']);
export const recordBufferEdits = Object.freeze({
  'src/osv/offlineRecord.ts': Object.freeze([Object.freeze([
    `    const chunks: Buffer[] = [];
    try {
      guard();
      for await (const value of active) {
        guard(); const chunk = Buffer.from(value); bytes += chunk.length;
        if (bytes > expectedBytes) throw tooLarge();
        checksum = crc32(chunk, checksum); chunks.push(chunk);`,
    `    let buffer: Buffer;
    try {
      guard();
      // Both lookup paths supply a bounded ZIP entry size. Decode only after every byte has been filled.
      buffer = Buffer.allocUnsafe(expectedBytes);
      for await (const chunk of active as AsyncIterable<Uint8Array>) {
        guard();
        if (chunk.byteLength > expectedBytes - bytes) throw tooLarge();
        buffer.set(chunk, bytes);
        bytes += chunk.byteLength;
        checksum = crc32(chunk, checksum);`,
  ]), decodeEdit]),
  ['dist/' + readerFile]: Object.freeze([Object.freeze([
    `        const chunks = [];
        try {
            guard();
            for await (const value of active) {
                guard();
                const chunk = Buffer.from(value);
                bytes += chunk.length;
                if (bytes > expectedBytes)
                    throw tooLarge();
                checksum = crc32(chunk, checksum);
                chunks.push(chunk);`,
    `        let buffer;
        try {
            guard();
            // Both lookup paths supply a bounded ZIP entry size. Decode only after every byte has been filled.
            buffer = Buffer.allocUnsafe(expectedBytes);
            for await (const chunk of active) {
                guard();
                if (chunk.byteLength > expectedBytes - bytes)
                    throw tooLarge();
                buffer.set(chunk, bytes);
                bytes += chunk.byteLength;
                checksum = crc32(chunk, checksum);`,
  ]), decodeEdit]),
});

async function verifyRecordBufferEdits(trees, bindings) {
  await Promise.all(Object.entries(recordBufferEdits).map(async ([path, edits]) => {
    const [before, after] = await Promise.all(arms.map(async arm => {
      const bytes = await readFile(join(trees[arm], path));
      assert.equal(sha256(bytes), bindings[arm][path], `${arm}: reader changed during comparison (${path})`);
      return bytes;
    }));
    let expected = before.toString('utf8');
    assert.ok(before.equals(Buffer.from(expected)), `Invalid UTF-8 in baseline reader (${path})`);
    for (const [from, to] of edits) {
      const start = expected.indexOf(from);
      assert.ok(start >= 0 && start === expected.lastIndexOf(from), `Expected one approved record-buffer edit (${path})`);
      expected = expected.replace(from, () => to);
    }
    assert.ok(after.equals(Buffer.from(expected)), `Unexpected change outside the approved record-buffer edits (${path})`);
  }));
}

export async function buildInventory(tree) {
  const paths = [];
  const dist = join(tree, 'dist');
  async function walk(prefix) {
    for (const item of await readdir(join(dist, prefix), {withFileTypes: true})) {
      const path = prefix + item.name;
      if (item.isDirectory()) await walk(path + '/');
      else {
        assert.ok(item.isFile(), `Unexpected artifact type: ${path}`);
        if (path.endsWith('.js')) paths.push(path);
      }
    }
  }
  await walk('');
  assert.ok(paths.includes(readerFile), 'Missing compiled reader');
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, sha256(await readFile(join(dist, path)))])));
}

export function buildDigest(inventory) {
  return sha256(JSON.stringify(inventory));
}

export async function memoryBindings(tree, inventory) {
  const sources = ['package.json', 'package-lock.json', 'src/osv/offlineRecord.ts', 'src/osv/offlineCache.ts',
    'src/tools/explainVulnerability.ts'];
  const harness = ['scripts/measure-offline-index-native.mjs', 'scripts/compare-offline-index-memory.mjs'];
  const files = await Promise.all([
    ...sources.map(async p => [p, sha256(await readFile(join(tree, p)))]),
    ...harness.map(async p => [p, sha256(await readFile(new URL('../' + p, import.meta.url)))]),
  ]);
  for (const p of [readerFile, 'osv/offlineCache.js', 'tools/explainVulnerability.js']) {
    assert.match(inventory[p], hashPattern, `Missing compiled artifact: ${p}`);
    files.push(['dist/' + p, inventory[p]]);
  }
  return Object.fromEntries(files);
}

function window(value, label) {
  assert.ok(Number.isSafeInteger(value?.samples) && value.samples > 0, `${label}: missing RSS samples`);
  assert.ok(Number.isSafeInteger(value.sampled_peak_rss_bytes) && value.sampled_peak_rss_bytes > 0, `${label}: invalid peak RSS`);
  return value.sampled_peak_rss_bytes;
}

function event(run, phase, name) {
  const found = run.events.filter(item => item.phase === phase && item.event === name);
  assert.equal(found.length, 1, `Expected one event ${phase}/${name}`);
  return found[0];
}

function verifyRun(run, arm, bindings, compiledHash, expectIdentityMap, expectRelease) {
  assert.equal(run.schema, 4);
  assert.equal(run.profile, 'baseline');
  assert.equal(run.identity_map, expectIdentityMap ? 'present' : 'absent', `${arm}: unexpected digest-table policy`);
  assert.equal(run.compiled_sha256, compiledHash, `${arm}: build inventory digest mismatch`);
  assert.deepEqual(run.bindings, bindings, `${arm}: build/source bindings mismatch`);
  assert.match(run.instrumented_reader_sha256, hashPattern);
  assert.match(run.run_id, /^[a-f0-9-]{36}$/);
  assert.ok(['EPERM', 'EACCES'].includes(run.network.loopback));
  assert.equal(run.network.fetch_attempts, 0);
  assert.equal(run.sample_interval_ms, 10);
  assert.equal(run.databases.length, 2);
  for (const db of run.databases) {
    assert.equal(db.ecosystem, 'npm');
    assert.equal(db.url, 'https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip');
    assert.match(db.sha256, hashPattern);
    assert.ok(Number.isSafeInteger(db.entries) && db.entries > 0);
    assert.ok(Number.isSafeInteger(db.bytes) && db.bytes > 0);
  }
  assert.notEqual(run.databases[0].sha256, run.databases[1].sha256);
  assert.ok(Date.parse(run.databases[0].downloaded_at) < Date.parse(run.databases[1].downloaded_at));
  assert.deepEqual(run.measurements.map(m => m.name), phases);
  const measured = Object.fromEntries(run.measurements.map(m => [m.name, m]));
  const peaks = {}, responses = {}, counters = {};
  for (const [i, m] of run.measurements.entries()) {
    assert.equal(m.database_sha256, run.databases[i < 2 ? 0 : 1].sha256);
    assert.equal(m.requested_id, i % 2 === 0 ? 'GHSA-35jh-r3h4-6jhm' : 'CVE-2021-23337');
    assert.match(m.response_sha256, hashPattern);
    responses[m.name] = m.response_sha256;
    const peak = window(m, m.name);
    assert.ok(peak >= Math.max(m.before.rss_bytes, m.settled.rss_bytes) && peak <= m.settled.process_high_water_rss_bytes + 1024);
    peaks[`${m.name}_request_peak_rss`] = peak;
  }
  for (const [i, name] of ['cold', 'replace'].entries()) {
    const finish = event(run, 1 + i * 2, 'read_finished');
    const {entries, names, expanded_bytes, identities, identity_map} = finish.reader;
    assert.equal(entries, run.databases[i].entries);
    assert.equal(names, entries);
    assert.ok(Number.isSafeInteger(expanded_bytes) && expanded_bytes > 0);
    assert.equal(identity_map, expectIdentityMap);
    assert.equal(identities, expectIdentityMap ? entries : 0);
    counters[name] = {entries, names, expanded_bytes};
    const peak = window(run.full_reader[name], name + ' full reader');
    assert.ok(peak <= measured[name].sampled_peak_rss_bytes && peak >= finish.memory.rss_bytes);
    peaks[`${name}_full_reader_peak_rss`] = peak;
    peaks[`${name}_reader_end_heap`] = finish.memory.heap_used_bytes;
  }
  const replace = event(run, 3, 'before_publish');
  if (expectRelease) {
    const prior = event(run, 3, 'old_before_drop'), drop = event(run, 3, 'old_dropped');
    const start = event(run, 3, 'draft_started');
    assert.deepEqual(prior.current, event(run, 1, 'before_publish').draft);
    assert.ok(prior.current);
    assert.equal(prior.draft, null);
    assert.equal(drop.draft, null);
    assert.equal(drop.current, null);
    assert.equal(start.current, null);
    assert.equal(replace.current, null);
    assert.equal(replace.distinct, false);
    assert.deepEqual(run.events.filter(e => e.phase === 3).map(e => e.event),
      ['old_before_drop', 'old_dropped', 'draft_started', 'read_started', 'read_finished', 'before_publish', 'published']);
    assert.deepEqual(run.overlap, {sampled_peak_rss_bytes: 0, samples: 0});
  } else {
    assert.equal(replace.distinct, true);
    const overlap = window(run.overlap, 'replacement overlap');
    assert.ok(overlap >= replace.memory.rss_bytes && overlap <= measured.replace.sampled_peak_rss_bytes);
    peaks.overlap_peak_rss = overlap;
  }
  peaks.cold_post_gc_heap_delta = measured.cold.post_gc.heap_used_bytes - run.baseline.heap_used_bytes;
  peaks.replace_start_rss = measured.replace.before.rss_bytes;
  assert.ok(Object.values(peaks).every(Number.isSafeInteger));
  return {databases: run.databases, responses, counters, peaks};
}

function range(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {min: sorted[0], max: sorted.at(-1), median};
}

function pairedSummary(before, after) {
  return {before: range(before), after: range(after), paired_before_minus_after: range(before.map((n, i) => n - after[i]))};
}

function verifyIndexLayout(run, packed, peaks) {
  const indexes = [];
  for (const [i, db] of run.databases.entries()) {
    const phase = 1 + i * 2;
    const published = event(run, phase, 'before_publish').draft;
    assert.deepEqual(event(run, phase + 1, 'reused').current, published);
    const {rows, location_table_bytes, ...logical} = published;
    assert.ok(Number.isSafeInteger(logical.keys) && logical.keys >= db.entries);
    assert.ok(Number.isSafeInteger(logical.postings) && logical.postings >= logical.keys && logical.postings <= 1_000_000);
    assert.equal(logical.conflicts, 0);
    if (packed) {
      assert.equal(rows, db.entries);
      assert.equal(location_table_bytes, Math.ceil(rows / 1024) * 1024 * 20);
    } else {
      assert.equal(rows, undefined);
      assert.equal(location_table_bytes, undefined);
    }
    peaks[`${phases[i * 2]}_location_table_bytes`] = location_table_bytes ?? 0;
    indexes.push(logical);
  }
  for (const {name, post_gc} of run.measurements) {
    for (const key of ['rss_bytes', 'heap_used_bytes', 'array_buffers_bytes']) {
      assert.ok(Number.isSafeInteger(post_gc[key]) && post_gc[key] >= 0);
      assert.ok(Number.isSafeInteger(run.baseline[key]) && run.baseline[key] >= 0);
    }
    peaks[`${name}_post_gc_rss`] = post_gc.rss_bytes;
    peaks[`${name}_post_gc_managed_delta`] = post_gc.heap_used_bytes - run.baseline.heap_used_bytes +
      post_gc.array_buffers_bytes - run.baseline.array_buffers_bytes;
  }
  return indexes;
}

export async function compareRuns({beforeTree, afterTree, runsDir, comparison = 'digest-table'}) {
  assert.ok(['digest-table', 'record-buffer', 'record-validation', 'compact-index', 'early-release'].includes(comparison), 'Unknown comparison mode');
  const release = comparison === 'early-release', compareIndex = release || comparison === 'compact-index';
  const trees = {before: beforeTree, after: afterTree};
  const [before, after] = await Promise.all(arms.map(arm => buildInventory(trees[arm])));
  assert.deepEqual(Object.keys(before), Object.keys(after), 'Different compiled file sets');
  const changed = Object.keys(before).filter(path => before[path] !== after[path]);
  assert.deepEqual(changed, [readerFile], 'Unexpected compiled-file differences');
  const [beforeBindings, afterBindings] = await Promise.all([
    memoryBindings(beforeTree, before), memoryBindings(afterTree, after),
  ]);
  assert.deepEqual(Object.keys(beforeBindings).filter(path => beforeBindings[path] !== afterBindings[path]),
    ['src/osv/offlineRecord.ts', 'dist/osv/offlineRecord.js'], 'Unexpected bound-file differences');
  const bindings = {before: beforeBindings, after: afterBindings};
  if (comparison === 'record-buffer') await verifyRecordBufferEdits(trees, bindings);
  const readerPins = {'early-release': releaseReaderPins, 'compact-index': compactReaderPins, 'record-validation': validationReaderPins}[comparison];
  if (readerPins) {
    for (const [path, pins] of Object.entries(readerPins)) {
      assert.deepEqual(arms.map(arm => bindings[arm][path]), pins, `Unexpected ${comparison} reader bytes (${path})`);
    }
  }
  const compiled = {before: buildDigest(before), after: buildDigest(after)};
  const runIds = new Set(), instrumented = new Map();
  const pairs = [], values = [];
  let reference;
  for (const [i, runOrder] of order.entries()) {
    const round = i + 1, raw = {}, pair = {};
    for (const arm of runOrder) {
      const run = JSON.parse(await readFile(join(runsDir, `run-${round}-${arm}.json`), 'utf8'));
      raw[arm] = run;
      assert.ok(!runIds.has(run.run_id), 'Duplicate process measurement');
      runIds.add(run.run_id);
      const checked = verifyRun(run, arm, bindings[arm], compiled[arm], comparison === 'digest-table' && arm === 'before',
        release && arm === 'after');
      if (!instrumented.has(arm)) instrumented.set(arm, run.instrumented_reader_sha256);
      assert.equal(run.instrumented_reader_sha256, instrumented.get(arm), `${arm}: instrumented reader changed`);
      const invariant = {databases: checked.databases, responses: checked.responses, counters: checked.counters,
        runtime: run.runtime, sample_interval_ms: run.sample_interval_ms,
        ...(compareIndex && {indexes: verifyIndexLayout(run, release || arm === 'after', checked.peaks)})};
      reference ??= invariant;
      assert.deepEqual(invariant.databases, reference.databases, 'Different DB generations');
      assert.deepEqual(invariant.responses, reference.responses, 'Different lookup responses');
      assert.deepEqual(invariant.counters, reference.counters, 'Different full-reader counters');
      assert.deepEqual(invariant.runtime, reference.runtime, 'Different runtimes');
      assert.deepEqual(invariant.indexes, reference.indexes, 'Different index key or posting counts');
      assert.equal(invariant.sample_interval_ms, reference.sample_interval_ms);
      pair[arm] = checked.peaks;
    }
    pairs.push({round, order: runOrder, arms: raw});
    values.push(pair);
  }
  // The early-release arm has no overlap window. Keep the raw observations without a paired RSS statistic.
  const metrics = Object.keys(values[0].before).filter(name => !release || name !== 'overlap_peak_rss');
  const summary_bytes = Object.fromEntries(metrics.map(name =>
    [name, pairedSummary(...arms.map(arm => values.map(pair => pair[arm][name])))]));
  const timing = readerPins ? {summary_elapsed_ms: Object.fromEntries(phases.map((phase, i) => {
    const elapsed = arms.map(arm => pairs.map(pair => pair.arms[arm].measurements[i].elapsed_ms));
    assert.ok(elapsed.flat().every(ms => Number.isFinite(ms) && ms > 0), `Invalid elapsed time (${phase})`);
    return [phase, pairedSummary(...elapsed)];
  }))} : {};
  return {schema: 2, ...(comparison !== 'digest-table' && {comparison}), build_comparison: {js_file_count: Object.keys(before).length, changed},
    pairs, common_response_sha256: reference.responses, summary_bytes, ...timing};
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const {values} = parseArgs({options: {'before-tree': {type: 'string'}, 'after-tree': {type: 'string'},
    'runs-dir': {type: 'string'}, output: {type: 'string'}, comparison: {type: 'string'}}});
  assert.ok(values['before-tree'] && values['after-tree'] && values['runs-dir'] && values.output,
    'Supply --before-tree DIR --after-tree DIR --runs-dir DIR --output FILE');
  const result = await compareRuns({beforeTree: values['before-tree'], afterTree: values['after-tree'], runsDir: values['runs-dir'],
    comparison: values.comparison});
  await writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Verified ${result.pairs.length} pairs and ${result.build_comparison.js_file_count} compiled files`);
}
