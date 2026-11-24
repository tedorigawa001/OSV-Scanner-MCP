/** Measure the real offline explanation reader with two official npm snapshots under OS network denial. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {connect} from 'node:net';
import {release, tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';
import {openPromise} from 'yauzl';
import {buildDigest, buildInventory, memoryBindings} from './compare-offline-index-memory.mjs';

const INTERVAL_MS = 10;
const KIB = 1024;
const ACTIVE_PHASE = 0, OVERLAP_ACTIVE = 1, FULL_READ_ACTIVE = 2;
const phases = {cold: 1, warm: 2, replace: 3, warm_replacement: 4, overlap: 5, cold_read: 6, replace_read: 7};
const countersAt = bucket => 3 + (bucket - 1) * 2;

function sample(state, knownRss) {
  const phase = Atomics.load(state, ACTIVE_PHASE);
  if (!phase) return;
  const overlap = Atomics.load(state, OVERLAP_ACTIVE);
  const fullRead = Atomics.load(state, FULL_READ_ACTIVE);
  const kib = Math.ceil((knownRss ?? process.memoryUsage.rss()) / KIB);
  if (phase !== Atomics.load(state, ACTIVE_PHASE) || overlap !== Atomics.load(state, OVERLAP_ACTIVE) ||
      fullRead !== Atomics.load(state, FULL_READ_ACTIVE)) return;
  const buckets = [phase];
  if (overlap) buckets.push(phases.overlap);
  if (fullRead) buckets.push(fullRead);
  for (const bucket of buckets) {
    const offset = countersAt(bucket);
    let previous = Atomics.load(state, offset);
    while (previous < kib) {
      const actual = Atomics.compareExchange(state, offset, previous, kib);
      if (actual === previous) break;
      previous = actual;
    }
    Atomics.add(state, offset + 1, 1);
  }
}

function statistics(state, bucket) {
  const offset = countersAt(bucket);
  return {sampled_peak_rss_bytes: Atomics.load(state, offset) * KIB, samples: Atomics.load(state, offset + 1)};
}

function memory() {
  const {rss, heapUsed, heapTotal, external, arrayBuffers} = process.memoryUsage();
  return {rss_bytes: rss, heap_used_bytes: heapUsed, heap_total_bytes: heapTotal, external_bytes: external,
    array_buffers_bytes: arrayBuffers, process_high_water_rss_bytes: process.resourceUsage().maxRSS * KIB};
}

async function retainedMemory() {
  await nextTurn();
  globalThis.gc();
  await nextTurn();
  globalThis.gc();
  return memory();
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function digestFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function readCache(dir, objects) {
  const manifestFile = join(dir, 'manifest.json');
  const manifest = await readFile(manifestFile);
  const {schema, databases} = JSON.parse(manifest);
  assert.equal(schema, 1);
  assert.equal(databases.length, 1, 'Use an npm-only cache for each generation');
  const [db] = databases;
  assert.equal(db.ecosystem, 'npm');
  assert.equal(db.url, 'https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip');
  assert.match(db.sha256, /^[a-f0-9]{64}$/);
  const name = db.sha256 + '.zip', input = join(dir, 'objects', name), archive = join(objects, name);
  await copyFile(input, archive);
  assert.equal((await stat(archive)).size, db.bytes);
  assert.equal(await digestFile(archive), db.sha256);
  const zip = await openPromise(archive, {autoClose: false, lazyEntries: true});
  const entries = zip.entryCount;
  const closed = once(zip, 'close');
  zip.close();
  await closed;
  return {manifest, evidence: {...db, entries}, input, manifestFile};
}

function replaceOnce(source, pattern, replacement) {
  assert.equal([...source.matchAll(pattern)].length, 1, `Expected one reader anchor for ${pattern.source}`);
  return source.replace(pattern, replacement);
}

async function loadReader(tree, profile, probe) {
  const file = await realpath(join(tree, 'dist/osv/offlineRecord.js'));
  const original = await readFile(file, 'utf8');
  const symbol = 'osv-offline-index-memory-probe';
  const call = (event, detail = 'undefined') => `globalThis[Symbol.for('${symbol}')]('${event}', cachedIndex, draft, ${detail});`;
  // The baseline adds observation only. The other arms alter index retention in this isolated loader.
  let instrumented = replaceOnce(original, /(draft = \{ generation, (?:records: new RecordLocationTable\(\), )?locations: new Map\(\), conflicts: new Set\(\), postings: 0 \};)/g,
    `$1\n${call('draft_started')}`);
  instrumented = replaceOnce(instrumented, /(if \(draft\)\s+cachedIndex = draft;)/g,
    `if (draft) { ${call('before_publish')} cachedIndex = draft; ${call('published')} }`);
  instrumented = replaceOnce(instrumented, /if \((!candidates\.some\((?:location => current\.conflicts\.has\(location\.id\)|row => current\.conflicts\.has\(current\.records\.ids\[row\]\))\))\)\s+indexed = candidates;/g,
    `if ($1) { indexed = candidates; ${call('reused')} }`);
  instrumented = replaceOnce(instrumented, /(const names = new Set\(\);)/g,
    `$1\n${call('read_started')}`);
  instrumented = replaceOnce(instrumented,
    /(if \(directoryEntries !== layout.count \|\| directoryBytes !== layout.bytes\)\s+throw invalid\('ZIP directory entry count or size mismatch'\);)/g,
    `$1\n${call('read_finished', '{entries, expanded_bytes: expanded, names: names.size, identity_map: identities !== undefined, identities: identities?.size ?? 0}')}`);
  const release = /if \(cachedIndex\)\s+cachedIndex = undefined;/g;
  const productionRelease = [...original.matchAll(release)].length !== 0;
  if (productionRelease) {
    instrumented = replaceOnce(instrumented, release,
      `if (cachedIndex) { ${call('old_before_drop')} cachedIndex = undefined; ${call('old_dropped')} }`);
  }
  if (profile === 'reader-only') {
    instrumented = replaceOnce(instrumented, /else if \(defaultLimits && !buildingIndex\)/g, 'else if (false)');
  } else if (profile === 'drop-old' && !productionRelease) {
    instrumented = replaceOnce(instrumented, /const current = cachedIndex;(?=\s*if \(defaultLimits)/g,
      `if (cachedIndex && cachedIndex.generation !== generation) {
        ${call('old_before_drop')} cachedIndex = undefined; ${call('old_dropped')}
      }\nconst current = cachedIndex;`);
  }
  const url = pathToFileURL(file).href;
  globalThis[Symbol.for(symbol)] = probe;
  let loaded = 0;
  const hooks = registerHooks({load(target, context, nextLoad) {
    const result = nextLoad(target, context);
    if (target !== url) return result;
    loaded++;
    assert.equal(Buffer.from(result.source).toString('utf8'), original);
    return {...result, source: instrumented};
  }});
  try {
    const {handleExplainVulnerability} = await import(pathToFileURL(join(tree, 'dist/tools/explainVulnerability.js')).href);
    assert.equal(loaded, 1, 'The measured handler must load the instrumented offline reader exactly once');
    return {handleExplainVulnerability, productionRelease, instrumented_reader_sha256: sha256(instrumented)};
  } finally {hooks.deregister();}
}

async function buildEvidence(tree) {
  const inventory = await buildInventory(tree);
  return {compiled_sha256: buildDigest(inventory), bindings: await memoryBindings(tree, inventory)};
}

async function run() {
  const {values} = parseArgs({options: {'old-cache': {type: 'string'}, 'new-cache': {type: 'string'}, output: {type: 'string'},
    profile: {type: 'string', default: 'baseline'}, tree: {type: 'string', default: '.'},
    'identity-map': {type: 'string', default: 'absent'}}});
  assert.ok(values['old-cache'] && values['new-cache'] && values.output,
    'Supply --old-cache /old-npm-cache --new-cache /new-npm-cache --output /run.json');
  const {profile} = values;
  assert.ok(['baseline', 'reader-only', 'drop-old'].includes(profile), 'Use --profile baseline, reader-only or drop-old');
  assert.ok(['present', 'absent'].includes(values['identity-map']), 'Use --identity-map present or absent');
  const tree = await realpath(values.tree), expectIdentityMap = values['identity-map'] === 'present';
  assert.equal(typeof globalThis.gc, 'function', 'Use node --expose-gc');
  const denied = await new Promise(resolve => {
    const socket = connect({host: '127.0.0.1', port: 9});
    socket.setTimeout(2000);
    socket.once('connect', () => {socket.destroy(); resolve('connected');});
    socket.once('timeout', () => {socket.destroy(); resolve('timeout');});
    socket.once('error', error => resolve(error.code));
  });
  assert.ok(['EPERM', 'EACCES'].includes(denied), `OS network denial not demonstrated (${denied})`);
  const originalFetch = globalThis.fetch;
  let fetchAttempts = 0;
  globalThis.fetch = async () => {fetchAttempts++; throw Error('Unexpected fetch');};

  const root = await mkdtemp(join(tmpdir(), 'offline-index-memory-'));
  const state = new Int32Array(new SharedArrayBuffer((3 + 2 * Object.keys(phases).length) * Int32Array.BYTES_PER_ELEMENT));
  const events = [];
  let sampler;
  try {
    const objects = join(root, 'objects');
    await mkdir(objects);
    const old = await readCache(values['old-cache'], objects), replacement = await readCache(values['new-cache'], objects);
    assert.notEqual(old.evidence.sha256, replacement.evidence.sha256, 'Use two differently hashed official npm ZIPs');
    assert.ok(Date.parse(old.evidence.downloaded_at) < Date.parse(replacement.evidence.downloaded_at));
    const manifest = join(root, 'manifest.json');
    await writeFile(manifest, old.manifest);
    const evidence = await buildEvidence(tree);

    const summary = index => index ? {keys: index.locations.size, postings: index.postings, conflicts: index.conflicts.size,
      ...(index.records && {rows: index.records.ids.length,
        location_table_bytes: index.records.pages.reduce((total, page) => total + page.byteLength, 0)})} : null;
    const {handleExplainVulnerability, productionRelease, instrumented_reader_sha256} = await loadReader(tree, profile, (event, current, draft, reader) => {
      const phase = Atomics.load(state, ACTIVE_PHASE);
      assert.ok(phase > 0);
      if (event === 'draft_started' && current) Atomics.store(state, OVERLAP_ACTIVE, 1);
      if (event === 'published') Atomics.store(state, OVERLAP_ACTIVE, 0);
      if (event === 'read_started') {
        assert.ok(phase === phases.cold || phase === phases.replace);
        Atomics.store(state, FULL_READ_ACTIVE, phase === phases.cold ? phases.cold_read : phases.replace_read);
      }
      const measurement = memory();
      sample(state, measurement.rss_bytes);
      if (event === 'read_finished') Atomics.store(state, FULL_READ_ACTIVE, 0);
      events.push({phase, event, current: summary(current), draft: summary(draft),
        distinct: !!current && !!draft && current !== draft, ...(reader && {reader}), memory: measurement});
    });
    sampler = new Worker(new URL(import.meta.url), {workerData: state.buffer});
    await once(sampler, 'message');
    const baseline = await retainedMemory();
    const id = 'GHSA-35jh-r3h4-6jhm', alias = 'CVE-2021-23337';
    const options = {offline: true, offlineDbDir: root, offlineMaxAgeHours: 168};

    async function query(name, requested, db, matchedBy) {
      const phase = phases[name], before = memory(), start = performance.now();
      Atomics.store(state, ACTIVE_PHASE, phase);
      sample(state, before.rss_bytes);
      let result, elapsed_ms, settled;
      try {
        result = await handleExplainVulnerability({vulnerability_id: requested}, options);
        elapsed_ms = performance.now() - start;
        settled = memory();
        sample(state, settled.rss_bytes);
      } finally {Atomics.store(state, ACTIVE_PHASE, 0);}
      assert.notEqual(result.isError, true, result.content[0]?.text);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.id, id);
      assert.equal(payload.requested_id, requested);
      assert.equal(payload.matched_by, matchedBy);
      assert.ok(payload.details.length > 0);
      assert.equal(payload.offline_database.network_requests, false);
      assert.deepEqual(payload.offline_database.databases, [{ecosystem: db.ecosystem, sha256: db.sha256, downloaded_at: db.downloaded_at}]);
      return {name, requested_id: requested, database_sha256: db.sha256, elapsed_ms, before, settled,
        response_sha256: sha256(JSON.stringify(payload)), ...statistics(state, phase)};
    }

    const measurements = [], cold = ['cold', id, old.evidence, 'id'];
    for (const [name, requested, db, matchedBy] of profile === 'reader-only' ? [cold] : [
      cold, ['warm', alias, old.evidence, 'alias'],
      ['replace', id, replacement.evidence, 'id'], ['warm_replacement', alias, replacement.evidence, 'alias'],
    ]) {
      console.error(`Measuring ${name}`);
      if (name === 'replace') {
        await writeFile(manifest + '.new', replacement.manifest);
        await rename(manifest + '.new', manifest);
      }
      const measurement = await query(name, requested, db, matchedBy);
      measurements.push({...measurement, post_gc: await retainedMemory()});
    }
    const at = (phase, event) => events.find(e => e.phase === phase && e.event === event);
    const readEvents = ['read_started', 'read_finished'];
    const buildEvents = ['draft_started', ...readEvents, 'before_publish', 'published'];
    const releasesOld = profile === 'drop-old' || productionRelease;
    const expected = profile === 'reader-only' ? [[1, readEvents]] : [[1, buildEvents], [2, ['reused']],
      [3, releasesOld ? ['old_before_drop', 'old_dropped', ...buildEvents] : buildEvents], [4, ['reused']]];
    assert.deepEqual(events.map(e => [e.phase, e.event]), expected.flatMap(([phase, names]) => names.map(name => [phase, name])));
    function verifyRead(phase, db) {
      const {reader} = at(phase, 'read_finished');
      assert.equal(reader.entries, db.entries);
      assert.equal(reader.names, db.entries);
      assert.equal(reader.identity_map, expectIdentityMap);
      assert.equal(reader.identities, expectIdentityMap ? db.entries : 0);
    }
    verifyRead(1, old.evidence);
    if (profile === 'reader-only') {
      assert.ok(events.every(e => e.current === null && e.draft === null));
    } else {
      const first = at(1, 'before_publish'), next = at(3, 'before_publish');
      assert.equal(first.current, null);
      assert.ok(first.draft.postings >= old.evidence.entries && next.draft.postings >= replacement.evidence.entries);
      assert.deepEqual(at(2, 'reused').current, first.draft);
      assert.deepEqual(at(4, 'reused').current, next.draft);
      verifyRead(3, replacement.evidence);
      if (!releasesOld) {
        assert.ok(next.distinct);
        assert.deepEqual(next.current, first.draft);
      } else {
        assert.deepEqual(at(3, 'old_before_drop').current, first.draft);
        assert.equal(at(3, 'old_dropped').current, null);
        assert.equal(next.current, null);
      }
    }
    const overlap = statistics(state, phases.overlap);
    if (profile === 'baseline' && !releasesOld) assert.ok(overlap.samples > 2 && overlap.sampled_peak_rss_bytes >= at(3, 'before_publish').memory.rss_bytes);
    else assert.equal(overlap.samples, 0);
    const full_reader = {cold: statistics(state, phases.cold_read),
      ...(profile !== 'reader-only' && {replace: statistics(state, phases.replace_read)})};
    assert.ok(full_reader.cold.samples > 2 && (full_reader.replace?.samples ?? 3) > 2);
    for (const db of [old, replacement]) {
      assert.deepEqual(await readFile(db.manifestFile), db.manifest);
      assert.equal(await digestFile(db.input), db.evidence.sha256);
    }
    assert.equal(fetchAttempts, 0);

    assert.deepEqual(await buildEvidence(tree), evidence, 'Build or source changed during measurement');
    await writeFile(values.output, JSON.stringify({schema: 4, run_id: randomUUID(), profile, identity_map: values['identity-map'],
      runtime: {node: process.version, platform: process.platform, arch: process.arch, release: release()},
      network: {loopback: denied, fetch_attempts: fetchAttempts}, databases: [old.evidence, replacement.evidence],
      sample_interval_ms: INTERVAL_MS, baseline, measurements, full_reader, overlap, events, instrumented_reader_sha256,
      ...evidence}, null, 2) + '\n');
    console.log(`Verified ${profile} profile`);
  } finally {
    await sampler?.terminate();
    globalThis.fetch = originalFetch;
    await rm(root, {recursive: true, force: true});
  }
}

if (isMainThread) await run();
else {
  const state = new Int32Array(workerData);
  setInterval(() => sample(state), INTERVAL_MS);
  parentPort.postMessage('ready');
}
