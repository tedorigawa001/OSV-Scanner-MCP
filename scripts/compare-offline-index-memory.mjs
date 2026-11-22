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

function verifyRun(run, arm, bindings, compiledHash, expectIdentityMap) {
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
  assert.equal(replace.distinct, true);
  const overlap = window(run.overlap, 'replacement overlap');
  assert.ok(overlap >= replace.memory.rss_bytes && overlap <= measured.replace.sampled_peak_rss_bytes);
  peaks.overlap_peak_rss = overlap;
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

export async function compareRuns({beforeTree, afterTree, runsDir, comparison = 'digest-table'}) {
  assert.ok(['digest-table', 'record-buffer'].includes(comparison), 'Use --comparison digest-table or record-buffer');
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
      const checked = verifyRun(run, arm, bindings[arm], compiled[arm], comparison === 'digest-table' && arm === 'before');
      if (!instrumented.has(arm)) instrumented.set(arm, run.instrumented_reader_sha256);
      assert.equal(run.instrumented_reader_sha256, instrumented.get(arm), `${arm}: instrumented reader changed`);
      const invariant = {databases: checked.databases, responses: checked.responses, counters: checked.counters,
        runtime: run.runtime, sample_interval_ms: run.sample_interval_ms};
      reference ??= invariant;
      assert.deepEqual(invariant.databases, reference.databases, 'Different DB generations');
      assert.deepEqual(invariant.responses, reference.responses, 'Different lookup responses');
      assert.deepEqual(invariant.counters, reference.counters, 'Different full-reader counters');
      assert.deepEqual(invariant.runtime, reference.runtime, 'Different runtimes');
      assert.equal(invariant.sample_interval_ms, reference.sample_interval_ms);
      pair[arm] = checked.peaks;
    }
    pairs.push({round, order: runOrder, arms: raw});
    values.push(pair);
  }
  const summary_bytes = Object.fromEntries(Object.keys(values[0].before).map(name => {
    const before = values.map(pair => pair.before[name]);
    const after = values.map(pair => pair.after[name]);
    return [name, {before: range(before), after: range(after), paired_before_minus_after: range(before.map((n, i) => n - after[i]))}];
  }));
  return {schema: 2, ...(comparison === 'record-buffer' && {comparison}), build_comparison: {js_file_count: Object.keys(before).length, changed},
    pairs, common_response_sha256: reference.responses, summary_bytes};
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
