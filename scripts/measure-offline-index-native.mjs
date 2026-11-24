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
const ACTIVE_PHASE = 0, OVERLAP_ACTIVE = 1, FULL_READ_ACTIVE = 2, ACTIVE_STAGE = 3;
const phases = {cold: 1, warm: 2, replace: 3, warm_replacement: 4, overlap: 5, cold_read: 6, replace_read: 7};
const firstStage = Object.keys(phases).length + 1;
const countersAt = bucket => 4 + (bucket - 1) * 2;
const stageSymbol = Symbol.for('osv-offline-warm-stage');

function sample(state, knownRss) {
  const phase = Atomics.load(state, ACTIVE_PHASE);
  if (!phase) return;
  const overlap = Atomics.load(state, OVERLAP_ACTIVE);
  const fullRead = Atomics.load(state, FULL_READ_ACTIVE);
  const stage = Atomics.load(state, ACTIVE_STAGE);
  const kib = Math.ceil((knownRss ?? process.memoryUsage.rss()) / KIB);
  if (phase !== Atomics.load(state, ACTIVE_PHASE) || overlap !== Atomics.load(state, OVERLAP_ACTIVE) ||
      fullRead !== Atomics.load(state, FULL_READ_ACTIVE) || stage !== Atomics.load(state, ACTIVE_STAGE)) return;
  const buckets = [phase];
  if (overlap) buckets.push(phases.overlap);
  if (fullRead) buckets.push(fullRead);
  if (stage) buckets.push(stage);
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

function stageCall(stage, boundary, count = 'undefined') {
  return `globalThis[Symbol.for('${Symbol.keyFor(stageSymbol)}')]('${stage}', '${boundary}', ${count});`;
}

function instrumentCache(source) {
  source = replaceOnce(source, /(const dest = [^\n]+ copied = await copyRegularFile\([^\n]+;)/g,
    `${stageCall('copy', 'start')}\n$1\n${stageCall('copy', 'end', 'copied.bytes')}`);
  source = replaceOnce(source, /(const v = await hashFile\(dest\);)/g,
    `${stageCall('sha256', 'start')}\n$1\n${stageCall('sha256', 'end', 'v.bytes')}`);
  return replaceOnce(source, /(const cleanup = async \(\) => \{ )(await rm\(dir, \{ recursive: true, force: true \}\); untrack\(\);)( \};)/g,
    `$1${stageCall('cleanup', 'start')} $2 ${stageCall('cleanup', 'end')}$3`);
}

async function loadReader(tree, profile, probe, stageProbe, replacementStages) {
  const file = await realpath(join(tree, 'dist/osv/offlineRecord.js'));
  const original = await readFile(file, 'utf8');
  const symbol = 'osv-offline-index-memory-probe';
  const call = (event, detail = 'undefined') => `globalThis[Symbol.for('${symbol}')]('${event}', cachedIndex, draft, ${detail});`;
  // The baseline adds observation only. The other arms alter index retention in this isolated loader.
  const draftStart = replacementStages ? stageCall('full_read_build', 'start') : '';
  let instrumented = replaceOnce(original, /(draft = \{ generation, (?:records: new RecordLocationTable\(\), )?locations: new Map\(\), conflicts: new Set\(\), postings: 0 \};)/g,
    `${draftStart}$1\n${call('draft_started')}`);
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
  const modules = new Map([[url, {original, instrumented}]]);
  if (stageProbe) {
    const cacheFile = await realpath(join(tree, 'dist/osv/offlineCache.js'));
    const cacheSource = await readFile(cacheFile, 'utf8');
    modules.set(pathToFileURL(cacheFile).href, {original: cacheSource, instrumented: instrumentCache(cacheSource)});
    instrumented = replaceOnce(instrumented, /(let location = current\?\.records\.get\(indexed\?\.\[0\]\);)/g,
      `$1\nif (indexed) ${stageCall('indexed_read', 'start')}`);
    const fullEnd = replacementStages ? `else if (ownsBuilder) ${stageCall('full_read_build', 'end', 'entries')}` : '';
    instrumented = replaceOnce(instrumented, /(const records = \[\.\.\.matches\.values\(\)\]\.sort\([^\n]+;)/g,
      `if (indexed) ${stageCall('indexed_read', 'end', 'nextLocation')} ${fullEnd}\n$1`);
    modules.set(url, {original, instrumented});
    globalThis[stageSymbol] = stageProbe;
  }
  globalThis[Symbol.for(symbol)] = probe;
  const loaded = new Set();
  const hooks = registerHooks({load(target, context, nextLoad) {
    const result = nextLoad(target, context);
    const module = modules.get(target);
    if (!module) return result;
    assert.ok(!loaded.has(target), 'Measured module loaded more than once');
    loaded.add(target);
    assert.equal(Buffer.from(result.source).toString('utf8'), module.original);
    return {...result, source: module.instrumented};
  }});
  try {
    const {handleExplainVulnerability} = await import(pathToFileURL(join(tree, 'dist/tools/explainVulnerability.js')).href);
    assert.equal(loaded.size, modules.size, 'The measured handler did not load every instrumented module');
    return {handleExplainVulnerability, productionRelease, instrumented_reader_sha256: sha256(instrumented),
      ...(stageProbe && {instrumented_cache_sha256: sha256([...modules.values()][1].instrumented)})};
  } finally {hooks.deregister();}
}

async function buildEvidence(tree) {
  const inventory = await buildInventory(tree);
  return {compiled_sha256: buildDigest(inventory), bindings: await memoryBindings(tree, inventory)};
}

function stageObserver(state, tracked) {
  const observations = new Map();
  let requestStarted;
  return {
    begin(started) {requestStarted = started;},
    probe(name, boundary, count) {
      const phase = Atomics.load(state, ACTIVE_PHASE);
      const request = tracked.get(phase);
      if (!request) return;
      const list = observations.get(phase) ?? [];
      observations.set(phase, list);
      if (boundary === 'start') {
        assert.equal(name, request.names[list.length]);
        assert.equal(Atomics.load(state, ACTIVE_STAGE), 0);
        const bucket = request.firstBucket + list.length;
        list.push({name, bucket, before: memory(), started: performance.now()});
        Atomics.store(state, ACTIVE_STAGE, bucket);
        sample(state, list.at(-1).before.rss_bytes);
      } else {
        const stage = list.at(-1);
        assert.equal(stage?.name, name);
        assert.equal(Atomics.load(state, ACTIVE_STAGE), stage.bucket);
        const ended = performance.now();
        stage.elapsed_ms = ended - stage.started;
        if (phase === phases.replace) {
          stage.start_offset_ms = stage.started - requestStarted;
          stage.end_offset_ms = ended - requestStarted;
        }
        stage.settled = memory();
        if (count !== undefined) stage.count = count;
        sample(state, stage.settled.rss_bytes);
        Atomics.store(state, ACTIVE_STAGE, 0);
      }
    },
    report(phase) {
      const stages = observations.get(phase) ?? [];
      assert.equal(stages.length, tracked.get(phase).names.length);
      assert.equal(Atomics.load(state, ACTIVE_STAGE), 0);
      return stages.map(({started, bucket, ...stage}) => ({...stage, ...statistics(state, bucket)}));
    },
  };
}

async function run() {
  const {values} = parseArgs({options: {'old-cache': {type: 'string'}, 'new-cache': {type: 'string'}, output: {type: 'string'},
    profile: {type: 'string', default: 'baseline'}, tree: {type: 'string', default: '.'},
    'identity-map': {type: 'string', default: 'absent'}, 'warm-stages': {type: 'boolean', default: false},
    'replacement-stages': {type: 'boolean', default: false}}});
  assert.ok(values['old-cache'] && values['new-cache'] && values.output,
    'Supply --old-cache /old-npm-cache --new-cache /new-npm-cache --output /run.json');
  const {profile} = values;
  assert.ok(['baseline', 'reader-only', 'drop-old'].includes(profile), 'Use --profile baseline, reader-only or drop-old');
  assert.ok(['present', 'absent'].includes(values['identity-map']), 'Use --identity-map present or absent');
  assert.ok(!(values['warm-stages'] || values['replacement-stages']) || profile === 'baseline', 'Stage probes require the baseline profile');
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
  const tracked = new Map();
  let nextBucket = firstStage;
  for (const [enabled, phase, read] of [
    [values['warm-stages'], phases.warm, 'indexed_read'],
    [values['replacement-stages'], phases.replace, 'full_read_build'],
    [values['warm-stages'], phases.warm_replacement, 'indexed_read'],
  ]) {
    if (!enabled) continue;
    const names = ['copy', 'sha256', read, 'cleanup'];
    tracked.set(phase, {names, firstBucket: nextBucket});
    nextBucket += names.length;
  }
  const buckets = nextBucket - 1;
  const state = new Int32Array(new SharedArrayBuffer((4 + 2 * buckets) * Int32Array.BYTES_PER_ELEMENT));
  const observer = tracked.size ? stageObserver(state, tracked) : undefined;
  const events = [];
  let sampler, requestStarted;
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
    const {handleExplainVulnerability, productionRelease, instrumented_reader_sha256, instrumented_cache_sha256} = await loadReader(tree, profile, (event, current, draft, reader) => {
      const phase = Atomics.load(state, ACTIVE_PHASE);
      assert.ok(phase > 0);
      const offset = values['replacement-stages'] && phase === phases.replace ? performance.now() - requestStarted : undefined;
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
        distinct: !!current && !!draft && current !== draft, ...(reader && {reader}),
        ...(offset !== undefined && {offset_ms: offset}), memory: measurement});
    }, observer?.probe, values['replacement-stages']);
    sampler = new Worker(new URL(import.meta.url), {workerData: state.buffer});
    await once(sampler, 'message');
    const baseline = await retainedMemory();
    const id = 'GHSA-35jh-r3h4-6jhm', alias = 'CVE-2021-23337';
    const options = {offline: true, offlineDbDir: root, offlineMaxAgeHours: 168};

    async function query(name, requested, db, matchedBy) {
      const phase = phases[name], before = memory(), start = performance.now();
      requestStarted = start;
      observer?.begin(start);
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
      const stages = tracked.has(phase) ? observer.report(phase) : undefined;
      if (stages) {
        assert.equal(stages[0].count, db.bytes);
        assert.equal(stages[1].count, db.bytes);
        if (phase === phases.replace) assert.equal(stages[2].count, db.entries);
        else assert.ok(stages[2].count > 0);
      }
      return {name, requested_id: requested, database_sha256: db.sha256, elapsed_ms, before, settled, ...(stages && {stages}),
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
      ...(instrumented_cache_sha256 && {instrumented_cache_sha256}),
      ...evidence}, null, 2) + '\n');
    console.log(`Verified ${profile} profile`);
  } finally {
    await sampler?.terminate();
    globalThis.fetch = originalFetch;
    delete globalThis[stageSymbol];
    await rm(root, {recursive: true, force: true});
  }
}

if (isMainThread) await run();
else {
  const state = new Int32Array(workerData);
  setInterval(() => sample(state), INTERVAL_MS);
  parentPort.postMessage('ready');
}
