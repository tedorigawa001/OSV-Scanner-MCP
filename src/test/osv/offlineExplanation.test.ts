import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, realpath, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {Readable} from 'node:stream';
import * as yauzl from 'yauzl';
import * as fs from 'node:fs/promises';
import {prepareOfflineDatabases} from '../../osv/offlineCache.js';
import {handleExplainVulnerability} from '../../tools/explainVulnerability.js';
import {runOsvSbomScan} from '../../osv/runner.js';
import {recordZip} from '../fixtures/offlineRecords.js';

vi.mock('yauzl', async original => {
  const actual = await original<typeof import('yauzl')>();
  return {...actual, openPromise: vi.fn(actual.openPromise)};
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {...actual, rm: vi.fn(actual.rm)};
});
const actualZip = await vi.importActual<typeof import('yauzl')>('yauzl');
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  vi.mocked(yauzl.openPromise).mockImplementation(actualZip.openPromise); vi.mocked(fs.rm).mockImplementation(actualFs.rm);
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});
const record = (id = 'GO-2000-0001', aliases = ['CVE-2000-0001']) => ({
  id, aliases, modified: '2026-11-18T00:00:00Z', summary: 'Local summary', details: 'Local details',
  affected: [{package: {ecosystem: 'Go', name: 'example.com/lib'}, ranges: [{type: 'SEMVER', events: [{introduced: '0'}, {fixed: '1.5.0'}]}]}],
});
async function fixture(records: unknown[] = [record()]) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'offline-explanation-'))); roots.push(dir);
  await prepareOfflineDatabases({dir, ecosystems: ['Go'], fetchFn: async () => new Response(recordZip(records.map(r => ({name: (r as {id: string}).id + '.json', body: JSON.stringify(r)}))))});
  const fetchFn = vi.fn(() => {throw Error('No network allowed');});
  return {dir, fetchFn, options: {offline: true, offlineDbDir: dir, fetchFn}};
}
async function replaceArchive(dir: string, bytes: Buffer) {
  const file = path.join(dir, 'manifest.json'), m = JSON.parse(await readFile(file, 'utf8')), d = m.databases[0];
  d.sha256 = createHash('sha256').update(bytes).digest('hex'); d.bytes = bytes.length;
  await writeFile(path.join(dir, 'objects', d.sha256 + '.zip'), bytes); await writeFile(file, JSON.stringify(m));
}
const explain = async (f: Awaited<ReturnType<typeof fixture>>, id = 'GO-2000-0001', extra = {}) => {
  const result = await handleExplainVulnerability({vulnerability_id: id}, {...f.options, ...extra});
  expect(f.fetchFn).not.toHaveBeenCalled();
  return {result, output: JSON.parse(result.content[0]!.text)};
};

it('gets local details by canonical ID and alias without network requests', async () => {
  const f = await fixture();
  for (const id of ['GO-2000-0001', 'CVE-2000-0001']) {
    const result = await handleExplainVulnerability({vulnerability_id: id}, f.options);
    expect(result.isError, result.content[0]!.text).not.toBe(true);
    const output = JSON.parse(result.content[0]!.text);
    expect(output).toMatchObject({id: 'GO-2000-0001', summary: 'Local summary', details: 'Local details',
      requested_id: id, matched_by: id.startsWith('GO-') ? 'id' : 'alias', offline_database: {mode: 'offline', network_requests: false}});
  }
  expect(f.fetchFn).not.toHaveBeenCalled();
});

it('builds an index for a single ZIP without storing per-ID digests', async () => {
  const f = await fixture([record(), record('GO-2000-0002', [])]);
  const set = vi.spyOn(Map.prototype, 'set');
  let storedDigest: boolean;
  try {
    expect((await explain(f)).output.id).toBe('GO-2000-0001');
    storedDigest = set.mock.calls.some(([key, value]) => key === 'GO-2000-0002' &&
      value !== null && typeof value === 'object' && Object.hasOwn(value, 'digest'));
  } finally {set.mockRestore();}
  expect(storedDigest).toBe(false);
  expect((await explain(f, 'CVE-2000-0001')).output.matched_by).toBe('alias');
});

it('rejects a repeated filename within one ZIP even if its copies are identical and unrelated to the request', async () => {
  const f = await fixture();
  const entries = [record(), record('GO-2000-0002', []), record('GO-2000-0002', [])];
  await replaceArchive(f.dir, recordZip(entries.map(r => ({name: r.id + '.json', body: JSON.stringify(r)}))));
  const {result, output} = await explain(f);
  expect(result.isError).toBe(true);
  expect(output.error).toMatchObject({kind: 'scan_failed', message: expect.stringContaining('duplicate database entry')});
});

it('checks cross-ZIP conflicts after a single-ZIP index has been built', async () => {
  const f = await fixture();
  expect((await explain(f)).output.id).toBe('GO-2000-0001');
  await prepareOfflineDatabases({dir: f.dir, ecosystems: ['PyPI'], fetchFn: async () =>
    new Response(recordZip([{name: 'GO-2000-0001.json', body: JSON.stringify(record('GO-2000-0001', []))}]))});
  const rejected = await explain(f, 'CVE-2000-0001');
  expect(rejected.result.isError).toBe(true);
  expect(rejected.output.error).toMatchObject({kind: 'scan_failed', message: expect.stringContaining('conflicting copies')});
});

it.each([false, true])('prioritizes exact IDs and returns every direct alias match deterministically (reverse=%s)', async reverse => {
  const go = record(), ghsa = {...record('GHSA-aaaa-bbbb-cccc', ['CVE-2000-0001', go.id]), details: 'GHSA details'};
  const f = await fixture(reverse ? [ghsa, go] : [go, ghsa]);
  const exact = await explain(f);
  expect(exact.result.isError).not.toBe(true);
  expect(exact.output).toMatchObject({id: go.id, matched_by: 'id', matching_record_ids: [go.id, ghsa.id], related_records: [{id: ghsa.id, details: 'GHSA details'}]});
  const alias = await explain(f, 'CVE-2000-0001');
  expect(alias.result.isError).not.toBe(true);
  expect(alias.output).toMatchObject({id: ghsa.id, matched_by: 'alias', matching_record_ids: [ghsa.id, go.id], related_records: [{id: go.id}]});
});

it('reports a local miss with snapshot metadata and no online fallback', async () => {
  const f = await fixture(), {result, output} = await explain(f, 'GO-2999-0000');
  expect(result.isError).toBe(true);
  expect(output).toMatchObject({error: {kind: 'vulnerability_not_found'}, requested_id: 'GO-2999-0000', offline_database: {mode: 'offline'}});
  expect(output.error.message).toContain('prepared local database');
});

it('uses the verified generation index for an alias and a local miss after a cold lookup', async () => {
  const f = await fixture([record(), record('GO-2000-0002', [])]);
  expect((await explain(f)).output.id).toBe('GO-2000-0001');
  const readEntry = vi.spyOn(actualZip.ZipFile.prototype, 'readEntry');
  expect((await explain(f, 'CVE-2000-0001')).output.matched_by).toBe('alias');
  expect((await explain(f, 'GO-2999-0000')).output.error.kind).toBe('vulnerability_not_found');
  expect(readEntry).not.toHaveBeenCalled();
});

it('keeps an in-flight snapshot consistent and rebuilds the index for the refreshed digest', async () => {
  const f = await fixture();
  const revised = {...record('GO-2000-0001', ['CVE-2000-0002']), summary: 'Refreshed record'};
  vi.mocked(yauzl.openPromise).mockImplementationOnce(async (file, options) => {
    const archive = await actualZip.openPromise(file, options);
    await prepareOfflineDatabases({dir: f.dir, ecosystems: ['Go'], fetchFn: async () =>
      new Response(recordZip([{name: revised.id + '.json', body: JSON.stringify(revised)}]))});
    return archive;
  });
  const before = (await explain(f, 'CVE-2000-0001')).output;
  expect(before).toMatchObject({id: revised.id, summary: 'Local summary'});
  const after = (await explain(f, 'CVE-2000-0002')).output;
  expect(after).toMatchObject({id: revised.id, summary: revised.summary});
  expect(after.offline_database.databases[0].sha256).not.toBe(before.offline_database.databases[0].sha256);
  expect((await explain(f, 'CVE-2000-0001')).output.error.kind).toBe('vulnerability_not_found');
});

it('rebuilds for a new manifest generation even when the DB bytes are identical', async () => {
  const f = await fixture(), before = (await explain(f)).output.offline_database.databases[0];
  const manifestPath = path.join(f.dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.databases[0].downloaded_at = new Date(Date.parse(before.downloaded_at) - 60_000).toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest));
  const readEntry = vi.spyOn(actualZip.ZipFile.prototype, 'readEntry');
  expect((await explain(f)).output.offline_database.databases).toEqual([{...before, downloaded_at: manifest.databases[0].downloaded_at}]);
  expect(readEntry).toHaveBeenCalled();
});

it.each(['expired', 'same-size damage', 'missing object'])('refuses %s after indexing, even on a local miss', async mode => {
  const f = await fixture([record(), record('GO-2000-0002', [])]);
  expect((await explain(f)).result.isError).not.toBe(true);
  const manifestPath = path.join(f.dir, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const db = manifest.databases[0], object = path.join(f.dir, 'objects', db.sha256 + '.zip');
  if (mode === 'expired') {
    db.downloaded_at = new Date(Date.now() - 169 * 3600000).toISOString();
    await writeFile(manifestPath, JSON.stringify(manifest));
  } else if (mode === 'same-size damage') {
    const bytes = await readFile(object);
    bytes[bytes.length - 1] = bytes.at(-1)! ^ 1;
    await writeFile(object, bytes);
  } else await rm(object);
  for (const id of ['GO-2000-0001', 'GO-2999-0000']) {
    expect((await explain(f, id)).output.error.kind).toBe('scan_failed');
  }
});

it('honors environment offline mode even with false and injected online options', async () => {
  const f = await fixture(); vi.stubEnv('OSV_MCP_OFFLINE', '1'); vi.stubEnv('OSV_SCANNER_PATH', '/not/a/scanner');
  const {result, output} = await explain(f, 'GO-2000-0001', {offline: false, baseUrl: 'https://invalid.example'});
  expect(result.isError).not.toBe(true); expect(output.matched_by).toBe('id');
});

it.each(['../record', 'id?query=1', 'x'.repeat(65)])('rejects invalid ID %s before opening a DB', async id => {
  const f = await fixture(), {result, output} = await explain(f, id, {offlineDbDir: path.join(f.dir, 'missing')});
  expect(result.isError).toBe(true); expect(output.error.kind).toBe('invalid_vulnerability_id');
});

it.each(['missing', 'corrupt', 'expired', 'future'])('refuses %s databases instead of reporting a miss', async mode => {
  const f = await fixture(), file = path.join(f.dir, 'manifest.json'), m = JSON.parse(await readFile(file, 'utf8'));
  if(mode === 'missing')await rm(file);
  if(mode === 'corrupt')await writeFile(path.join(f.dir, 'objects', m.databases[0].sha256 + '.zip'), 'corrupt');
  if(mode === 'expired' || mode === 'future'){
    m.databases[0].downloaded_at = new Date(Date.now() + (mode === 'future' ? 1 : -169) * 3600000).toISOString();
    await writeFile(file, JSON.stringify(m));
  }
  const {result, output} = await explain(f, 'GO-2999-0000');
  expect(result.isError).toBe(true); expect(output.error.kind).toBe('scan_failed');
  expect(output.error.message).toContain('Offline database cache');
});

it.each(['identical', 'reordered', 'conflicting', 'hidden-difference', 'expired'])('handles %s copies across prepared ecosystems without hiding evidence', async mode => {
  const f = await fixture();
  const other = mode === 'conflicting' ? {...record(), summary: 'Conflicting summary'} : mode === 'hidden-difference'
    ? {...record(), database_specific: {reviewed: false}} : mode === 'reordered'
      ? Object.fromEntries(Object.entries(record()).reverse()) : record();
  await prepareOfflineDatabases({dir: f.dir, ecosystems: ['PyPI'], ...(mode === 'expired' ? {now: Date.parse('2020-01-01T00:00:00Z')} : {}),
    fetchFn: async () => new Response(recordZip([{name: 'GO-2000-0001.json', body: JSON.stringify(other)}]))});
  const {result, output} = await explain(f);
  if(mode === 'identical' || mode === 'reordered'){
    expect(result.isError).not.toBe(true); expect(output.matching_record_ids).toEqual(['GO-2000-0001']);
    expect(output.offline_database.databases).toHaveLength(2);
    const warm = await explain(f, 'CVE-2000-0001');
    expect(warm.result.isError).not.toBe(true);
    expect(warm.output).toEqual({...output, requested_id: 'CVE-2000-0001', matched_by: 'alias'});
  }else{
    expect(result.isError).toBe(true); expect(output.error.kind).toBe('scan_failed');
  }
});

it.each([
  [false, []], [true, []],
  [false, ['CVE-2000-0002']], [true, ['CVE-2000-0002']],
] as const)('rejects conflicting copies that do not match the requested alias (reverse=%s, aliases=%j)', async (reverse, aliases) => {
  const matching = record(), nonmatching = {...record('GO-2000-0001', [...aliases]), summary: 'Different copy'};
  const f = await fixture([reverse ? nonmatching : matching]);
  await prepareOfflineDatabases({dir: f.dir, ecosystems: ['PyPI'],
    fetchFn: async () => new Response(recordZip([{name: matching.id + '.json', body: JSON.stringify(reverse ? matching : nonmatching)}]))});
  // Prime the index with a miss so the conflict cannot be caught merely by checking matching aliases while building it.
  expect((await explain(f, 'GO-2999-0000')).output.error.kind).toBe('vulnerability_not_found');
  for (const id of [matching.id, matching.aliases[0]!]) {
    const {result, output} = await explain(f, id);
    expect(result.isError, JSON.stringify(output)).toBe(true);
    expect(output.error).toMatchObject({kind: 'scan_failed', message: expect.stringContaining('conflicting copies')});
    expect(output).not.toHaveProperty('id');
  }
});

it('does not confuse unrelated conflicting IDs with the requested record', async () => {
  const f = await fixture([record(), record('GO-2000-0002', [])]);
  await prepareOfflineDatabases({dir: f.dir, ecosystems: ['PyPI'],
    fetchFn: async () => new Response(recordZip([{name: 'GO-2000-0002.json', body: JSON.stringify({...record('GO-2000-0002', []), summary: 'Different copy'})}]))});
  expect((await explain(f)).result.isError).not.toBe(true);
  expect((await explain(f, 'GO-2999-0000')).output.error.kind).toBe('vulnerability_not_found');
});

it('uses the full alias list for matching before formatting truncates it', async () => {
  const aliases = Array.from({length: 30}, (_, i) => `CVE-2000-${String(i).padStart(4, '0')}`);
  const f = await fixture([{...record('GO-2000-0001', aliases), details: 'x'.repeat(10000)}]);
  const {result, output} = await explain(f, aliases[29]!);
  expect(result.isError).not.toBe(true); expect(output.matched_by).toBe('alias');
  expect(output.aliases).toHaveLength(20); expect(output.details).toHaveLength(4001);
});

// Shapes observed in the official npm DB (2026-11-18): a trailing comma and SNYK IDs longer than 64 characters.
const nonOsvAliases = ['SNYK-JS-YARN-537806,', 'SNYK-JS-' + 'A'.repeat(70) + '-10006712'];
it.each([false, true])('ignores non-OSV aliases of other records instead of failing every lookup (matching record first: %s)', async first => {
  const odd = record('GHSA-aaaa-bbbb-cccc', nonOsvAliases), records = first ? [record(), odd] : [odd, record()];
  const f = await fixture(records);
  for (const id of ['GO-2000-0001', 'CVE-2000-0001', 'GHSA-aaaa-bbbb-cccc']) {
    const {result, output} = await explain(f, id);
    expect(result.isError, JSON.stringify(output)).not.toBe(true);
    expect(output.matching_record_ids).toEqual([id === 'GHSA-aaaa-bbbb-cccc' ? id : 'GO-2000-0001']);
  }
  expect((await explain(f, 'GO-2999-0000')).output.error.kind).toBe('vulnerability_not_found');
});

it('never matches a malformed alias, even by its valid prefix', async () => {
  const f = await fixture([record('GHSA-aaaa-bbbb-cccc', nonOsvAliases)]);
  for (const id of ['SNYK-JS-YARN-537806', nonOsvAliases[1]!]) {
    const {result, output} = await explain(f, id);
    expect(result.isError).toBe(true); expect(['vulnerability_not_found', 'invalid_vulnerability_id']).toContain(output.error.kind);
  }
});

it.each([0, 8])('reads method %s archives including ZIP64', async method => {
  const f = await fixture();
  await replaceArchive(f.dir, recordZip([{name: 'GO-2000-0001.json', body: JSON.stringify(record()), method}], true));
  const {result, output} = await explain(f);
  expect(result.isError, JSON.stringify(output)).not.toBe(true); expect(output.id).toBe('GO-2000-0001');
  const warm = await explain(f, 'CVE-2000-0001');
  expect(warm.result.isError, JSON.stringify(warm.output)).not.toBe(true); expect(warm.output.matched_by).toBe('alias');
});

it.each([false, true].flatMap(warm => ['exact', 'short', 'overflow', 'crc'].map(mode => ({warm, mode}))))(
  'checks each chunk and final size/CRC for a split UTF-8 record ($warm/$mode)', async ({warm, mode}) => {
    const details = 'before あ after', advisory = {...record(), details};
    const raw = Buffer.from(JSON.stringify(advisory));
    const split = raw.indexOf('あ') + 1;
    const f = await fixture([advisory]);
    if (warm) expect((await explain(f)).output.details).toBe(details);
    const end = Buffer.from(raw.subarray(split, mode === 'short' ? raw.length - 1 : raw.length));
    if (mode === 'crc') end[end.indexOf('after')] = 'A'.charCodeAt(0);
    const stream = Readable.from((function* () {
      yield raw.subarray(0, split);
      yield end;
      if (mode === 'overflow') yield Buffer.from('!');
    })());
    vi.mocked(yauzl.openPromise).mockImplementationOnce(async (file, options) => {
      const archive = await actualZip.openPromise(file, options);
      if (warm) archive.openReadStreamLowLevel = (...args) => args[6](null, stream);
      else archive.openReadStreamPromise = async () => stream;
      return archive;
    });
    const {result, output} = await explain(f, warm ? 'CVE-2000-0001' : advisory.id);
    expect(stream.destroyed).toBe(true);
    if (mode === 'exact') {
      expect(result.isError, JSON.stringify(output)).not.toBe(true);
      expect(output.details).toBe(details);
    } else {
      expect(result.isError).toBe(true);
      expect(output.error.kind).toBe(mode === 'overflow' ? 'output_too_large' : 'scan_failed');
      if (mode === 'short' || mode === 'crc') expect(output.error.message).toContain('size or CRC mismatch');
      expect(output).not.toHaveProperty('id');
      expect((await explain(f)).output.details).toBe(details);
    }
  },
);

it.each([false, true])('stops copying and pulling chunks at the original deadline (warm=%s)', async warm => {
  const f = await fixture();
  if (warm) expect((await explain(f)).output.id).toBe('GO-2000-0001');

  const raw = Buffer.from(JSON.stringify(record()));
  const first = raw.subarray(0, 1), expired = raw.subarray(1, 2), remaining = raw.subarray(2);
  const clock = vi.spyOn(performance, 'now');
  const set = vi.spyOn(Uint8Array.prototype, 'set');
  const pulled: Buffer[] = [];
  const stream = new Readable({read() {}});
  // Pull one chunk per iterator request, so stream prefetch cannot count as reader progress.
  vi.spyOn(stream, Symbol.asyncIterator).mockImplementation(async function* () {
    pulled.push(first); yield first;
    clock.mockReturnValue(performance.now() + 120_001);
    pulled.push(expired); yield expired;
    pulled.push(remaining); yield remaining;
    return undefined;
  });
  vi.mocked(yauzl.openPromise).mockImplementationOnce(async (file, options) => {
    const archive = await actualZip.openPromise(file, options);
    if (warm) archive.openReadStreamLowLevel = (...args) => args[6](null, stream);
    else archive.openReadStreamPromise = async () => stream;
    return archive;
  });
  const {result, output} = await explain(f, warm ? 'CVE-2000-0001' : 'GO-2000-0001');
  const writes = set.mock.calls.map(([chunk]) => chunk).filter(chunk => chunk === first || chunk === expired || chunk === remaining);
  set.mockRestore(); clock.mockRestore();
  expect(result.isError).toBe(true);
  expect(output.error.kind).toBe('scan_timeout');
  expect(pulled).toEqual([first, expired]);
  expect(writes).toEqual([first]);
  expect(stream.destroyed).toBe(true);
  expect((await explain(f)).output.id).toBe('GO-2000-0001');
});

it.each([false, true].flatMap(zip64 => ['count', 'count-and-size'].flatMap(mode =>
  ['GO-2000-0001', 'GO-2000-0002', 'GO-2999-0000'].map(id => ({zip64, mode, id})))))(
  'rejects underreported ZIP directory metadata instead of an explanation or miss ($zip64/$mode/$id)', async ({zip64, mode, id}) => {
    const f = await fixture(), records = [record(), record('GO-2000-0002', [])];
    const bytes = recordZip(records.map(r => ({name: r.id + '.json', body: JSON.stringify(r)})), zip64);
    const end = bytes.length - 22, firstEntryBytes = 46 + Buffer.byteLength(records[0]!.id + '.json');
    if (zip64) {
      const extended = end - 20 - 56;
      bytes.writeBigUInt64LE(1n, extended + 24); bytes.writeBigUInt64LE(1n, extended + 32);
      if (mode === 'count-and-size')bytes.writeBigUInt64LE(BigInt(firstEntryBytes), extended + 40);
    } else {
      bytes.writeUInt16LE(1, end + 8); bytes.writeUInt16LE(1, end + 10);
      if (mode === 'count-and-size')bytes.writeUInt32LE(firstEntryBytes, end + 12);
    }
    // Keep the cache digest valid: this exercises ZIP structure, not the outer integrity check.
    await replaceArchive(f.dir, bytes);
    const {result, output} = await explain(f, id);
    expect(result.isError, JSON.stringify(output)).toBe(true);
    expect(output.error.kind).toBe('scan_failed');
    expect(output).not.toHaveProperty('id');
    expect(output).not.toHaveProperty('matching_record_ids');
  },
);

it.each(['json', 'null', 'identity', 'aliases', 'alias-type', 'utf8', 'crc', 'size', 'encrypted', 'method', 'path', 'duplicate', 'unexpected-file', 'truncated', 'empty'])(
  'rejects %s ZIP/OSV data even after a matching record', async mode => {
    const f = await fixture(), good = {name: 'GO-2000-0001.json', body: JSON.stringify(record())};
    let bad = {name: 'GO-2000-0002.json', body: JSON.stringify(record('GO-2000-0002'))} as Parameters<typeof recordZip>[0][number];
    if(mode === 'json')bad.body = 'not json';
    if(mode === 'null')bad.body = 'null';
    if(mode === 'identity')bad.body = JSON.stringify(record('GO-2000-0003'));
    if(mode === 'aliases')bad.body = JSON.stringify({...record('GO-2000-0002'), aliases: 'CVE-2000-0001'});
    if(mode === 'alias-type')bad.body = JSON.stringify({...record('GO-2000-0002'), aliases: [42]});
    if (mode === 'utf8') {
      // The record would parse successfully if the decoder silently replaced malformed UTF-8.
      const body = Buffer.from(bad.body); body[body.indexOf('Local details')] = 0xff; bad.body = body;
    }
    if(mode === 'crc')bad.crc = 0;
    if(mode === 'size')bad.size = 1;
    if(mode === 'encrypted')bad.flags = 1;
    if(mode === 'method')bad.method = 12;
    if(mode === 'path')bad.name = '../GO-2000-0002.json';
    if(mode === 'duplicate')bad = good;
    if(mode === 'unexpected-file')bad.name = 'README.txt';
    let bytes = recordZip(mode === 'empty' ? [] : [good, bad]);
    if(mode === 'truncated')bytes = Buffer.from(bytes.subarray(0, bytes.length - 12));
    await replaceArchive(f.dir, bytes);
    const {result, output} = await explain(f);
    expect(result.isError, JSON.stringify(output)).toBe(true);
    expect(['scan_failed', 'output_too_large']).toContain(output.error.kind);
  },
);

it.each(['recordBytes', 'expandedBytes', 'entries', 'matches', 'matchingBytes'] as const)('does not publish partial results when %s is exhausted', async limit => {
  const f = await fixture([record(), record('GO-2000-0002')]);
  expect((await explain(f)).result.isError).not.toBe(true);
  const {result, output} = await explain(f, 'CVE-2000-0001', {offlineLookupLimits: {[limit]: 1}});
  expect(result.isError).toBe(true); expect(output.error.kind).toBe('output_too_large');
  expect(output.error.message).toContain('not completed');
});

it('enforces the normal match limit on indexed lookups and deduplicates repeated aliases', async () => {
  const entries = Array.from({length: 21}, (_, i) => record(`GO-2000-${i + 1}`, ['CVE-2000-0001', 'CVE-2000-0001']));
  const f = await fixture(entries);
  expect((await explain(f, entries[0]!.id)).result.isError).not.toBe(true);
  const readEntry = vi.spyOn(actualZip.ZipFile.prototype, 'readEntry');
  const readRecord = vi.spyOn(actualZip.ZipFile.prototype, 'openReadStreamLowLevel');
  expect((await explain(f, 'CVE-2000-0001')).output.error.kind).toBe('output_too_large');
  expect(readRecord).toHaveBeenCalledTimes(entries.length);
  expect((await explain(f, entries[0]!.id)).output.matching_record_ids).toEqual([entries[0]!.id]);
  expect(readEntry).not.toHaveBeenCalled();
});

it('refuses a timed-out lookup without reporting a miss', async () => {
  const f = await fixture();
  vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(120001);
  const {result, output} = await explain(f);
  expect(result.isError).toBe(true); expect(output.error.kind).toBe('scan_timeout');
});

it.each(['entry', 'stream'])('cancels a pending %s operation and closes the archive on timeout', async phase => {
  const f = await fixture(), originalOpen = actualZip.openPromise;
  let notifyClosed!: () => void, pending: Readable | undefined;
  const closed = new Promise<void>(resolve => {notifyClosed = resolve;});
  vi.mocked(yauzl.openPromise).mockImplementation(async (file, options) => {
    const archive = await originalOpen(file, options); archive.once('close', notifyClosed);
    if(phase === 'entry')archive.readEntry = () => {};
    else archive.openReadStreamPromise = async () => {pending = new Readable({read() {}}); return pending;};
    return archive;
  });
  const {result, output} = await explain(f, 'GO-2000-0001', {timeoutMs: 100});
  expect(result.isError).toBe(true); expect(output.error.kind).toBe('scan_timeout');
  await closed;
  if(pending)expect(pending.destroyed).toBe(true);
});

it.each([false, true].flatMap(warm => [false, true].map(delayed => ({warm, delayed}))))(
  'returns at the original deadline with a delayed or missing close (warm=$warm, delayed=$delayed)', async ({warm, delayed}) => {
    const f = await fixture();
    vi.stubEnv('OSV_MCP_MAX_CONCURRENT_SCANS', '1');
    if (warm) expect((await explain(f)).result.isError).not.toBe(true);

    let notifyCloseReady!: () => void;
    const closeReady = new Promise<void>(resolve => {notifyCloseReady = resolve;});
    let deliverClose: (() => void) | undefined, returned = false;
    vi.mocked(yauzl.openPromise).mockImplementationOnce(async (file, options) => {
      const archive = await actualZip.openPromise(file, options), emit = archive.emit;
      archive.emit = function (event, ...args) {
        if (event !== 'close') return emit.call(this, event, ...args);
        deliverClose = () => {emit.call(this, event, ...args);};
        notifyCloseReady();
        return true;
      };
      return archive;
    });
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
    const pending = explain(f, 'GO-2000-0001', {timeoutMs: 100}).then(result => {returned = true; return result;});
    try {
      await closeReady;
      await vi.advanceTimersByTimeAsync(99);
      expect(returned).toBe(false);
      expect((await explain(f)).output.error.kind).toBe('too_many_concurrent_scans');
      await vi.advanceTimersByTimeAsync(1);
      const timed = await Promise.race([pending, new Promise<null>(resolve => setImmediate(() => resolve(null)))]);
      expect(timed?.output.error.kind).toBe('scan_timeout');

      const readEntry = vi.spyOn(actualZip.ZipFile.prototype, 'readEntry');
      expect((await explain(f)).output.id).toBe('GO-2000-0001');
      if (warm) expect(readEntry).not.toHaveBeenCalled();
      else expect(readEntry).toHaveBeenCalled(); // The timed-out draft was discarded and its builder slot is free.
      readEntry.mockClear();
      if (delayed) deliverClose?.();
      expect((await explain(f, 'CVE-2000-0001')).output.matched_by).toBe('alias');
      expect(readEntry).not.toHaveBeenCalled();
    } finally {
      if (!returned) deliverClose?.(); // Let the original implementation unwind when this regression fails.
      await pending;
      vi.useRealTimers();
    }
  },
);

it('returns at the original deadline while private-copy removal is still pending', async () => {
  const f = await fixture();
  vi.stubEnv('OSV_MCP_MAX_CONCURRENT_SCANS', '1');
  let notifyRemoval!: () => void, allowRemoval!: () => void, cleanup: Promise<void> | undefined;
  const removing = new Promise<void>(resolve => {notifyRemoval = resolve;});
  const release = new Promise<void>(resolve => {allowRemoval = resolve;});
  vi.mocked(fs.rm).mockImplementationOnce((file, options) => {
    notifyRemoval();
    cleanup = release.then(() => actualFs.rm(file, options));
    return cleanup;
  });
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
  const pending = explain(f, 'GO-2000-0001', {timeoutMs: 100});
  try {
    await removing;
    await vi.advanceTimersByTimeAsync(100);
    const timed = await Promise.race([pending, new Promise<null>(resolve => setImmediate(() => resolve(null)))]);
    expect(timed?.output.error.kind).toBe('scan_timeout');
    const readEntry = vi.spyOn(actualZip.ZipFile.prototype, 'readEntry');
    expect((await explain(f)).output.id).toBe('GO-2000-0001');
    expect(readEntry).toHaveBeenCalled();
  } finally {
    allowRemoval();
    await pending;
    await cleanup;
    vi.useRealTimers();
  }
});

it.each([false, true])('rechecks DB freshness after cleanup with a cold or warm index (warm=%s)', async warm => {
  const f = await fixture(), originalRemove = actualFs.rm, start = Date.now(); let expired = false;
  if (warm) expect((await explain(f)).result.isError).not.toBe(true);
  vi.spyOn(Date, 'now').mockImplementation(() => expired ? start + 169 * 3600000 : start);
  vi.mocked(fs.rm).mockImplementation(async (file, options) => {
    await originalRemove(file, options);
    if(path.basename(String(file)).startsWith('osv-mcp-snap-'))expired = true;
  });
  const {result, output} = await explain(f);
  expect(expired).toBe(true); expect(result.isError).toBe(true); expect(output.error.kind).toBe('scan_failed');
  if (!warm) {
    expired = false;
    vi.mocked(fs.rm).mockImplementation(originalRemove);
    const readEntry = vi.spyOn(actualZip.ZipFile.prototype, 'readEntry');
    expect((await explain(f)).result.isError).not.toBe(true);
    expect(readEntry).toHaveBeenCalled();
  }
});

it.each([true, false].flatMap(matching => ['depth', 'nonfinite'].map(mode => ({matching, mode}))))(
  'validates $mode in all records of a single ZIP (matching=$matching)', async ({matching, mode}) => {
    const f = await fixture();
    let nested: unknown = null;
    for (let i = 0; i < 70; i++) nested = {nested};
    const invalid = matching ? record() : record('GO-2000-0002', []);
    const body = mode === 'depth' ? JSON.stringify({...invalid, database_specific: nested})
      : JSON.stringify({...invalid, database_specific: {value: null}}).replace('"value":null', '"value":1e999');
    const entries = [{name: invalid.id + '.json', body}];
    if (!matching) entries.unshift({name: 'GO-2000-0001.json', body: JSON.stringify(record())});
    await replaceArchive(f.dir, recordZip(entries));
    const {result, output} = await explain(f);
    expect(result.isError).toBe(true);
    expect(output.error).toMatchObject({kind: 'scan_failed', message: expect.stringContaining(mode === 'depth' ? 'nesting limit' : 'non-finite')});
  },
);

it('reserves shared scan capacity before DB reads and releases it after rejection', async () => {
  const f = await fixture(); vi.stubEnv('OSV_MCP_MAX_CONCURRENT_SCANS', '1');
  let ready!: () => void, archive: yauzl.ZipFile | undefined;
  const entered = new Promise<void>(resolve => {ready = resolve;});
  vi.mocked(yauzl.openPromise).mockImplementation(async (file, options) => {
    archive = await actualZip.openPromise(file, options); archive.readEntry = ready; return archive;
  });
  const pending = explain(f, 'GO-2000-0001', {timeoutMs: 1000});
  await entered;
  try {
    const blocked = await explain(f, 'GO-2000-0001', {offlineDbDir: path.join(f.dir, 'missing')});
    expect(blocked.result.isError).toBe(true); expect(blocked.output.error.kind).toBe('too_many_concurrent_scans');
    await expect(runOsvSbomScan('/not/a/file', {binaryPath: '/not/a/scanner'})).rejects.toMatchObject({kind: 'too_many_concurrent_scans'});
  } finally {archive!.emit('error', new Error('controlled rejection'));}
  expect((await pending).result.isError).toBe(true);
  vi.mocked(yauzl.openPromise).mockImplementation(actualZip.openPromise);
  expect((await explain(f)).result.isError).not.toBe(true);
});
