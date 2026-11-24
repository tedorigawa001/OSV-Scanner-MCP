/** Bounded ID/alias lookup over verified private OSV ZIP copies. */
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import type {Readable} from 'node:stream';
import {openPromise, type ZipFile, type Entry} from 'yauzl';
import {ScanToolError} from '../errors.js';
import {asRecord} from '../utils/unknownJson.js';
import {captureOfflineDatabases, type OfflineDatabaseMetadata} from './offlineCache.js';
import {offlineConfig} from './offline.js';
import {validateVulnerabilityId, type FetchOsvRecordOptions} from './osvApi.js';
import {buildVulnerabilityExplanation, type VulnerabilityExplanation} from './vulnerabilityExplanation.js';
import {withScanCapacity} from './runner.js';

export const OFFLINE_LOOKUP_LIMITS = Object.freeze({recordBytes: 4 * 1024 * 1024, expandedBytes: 2 * 1024 * 1024 * 1024,
  entries: 500000, matches: 20, matchingBytes: 16 * 1024 * 1024});
export interface OfflineRecordOptions extends FetchOsvRecordOptions {
  /** Internal/test overrides can only lower the hard limits; not part of the MCP input schema. */
  offlineLookupLimits?: Partial<Record<keyof typeof OFFLINE_LOOKUP_LIMITS, number>>;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const invalid = (reason: string) => new ScanToolError('scan_failed', `Offline database cache: ${reason}`);
const tooLarge = () => new ScanToolError('output_too_large', 'Offline record lookup exceeded its entry, record, expanded-byte or match limit; the search was not completed');
const timedOut = () => new ScanToolError('scan_timeout', 'Offline record lookup did not complete within its time limit; the search was not completed');
const ignoreLateZipError = () => {};

interface RecordLocation {
  database: number;
  id: string;
  start: number;
  compressedBytes: number;
  bytes: number;
  crc: number;
  deflated: boolean;
}

const LOCATION_PAGE_ROWS = 1024;
const LOCATION_WORDS = 5;

class RecordLocationTable {
  readonly ids: string[] = [];
  private readonly pages: Uint32Array[] = [];

  append(id: string, database: number, start: number, compressedBytes: number, bytes: number, crc: number, deflated: boolean) {
    // Current ZIPs are bounded to 512 MiB. Fall back to full reads if a position cannot be stored losslessly.
    if (start !== (start >>> 0) || compressedBytes !== (compressedBytes >>> 0)) return undefined;
    const row = this.ids.length, inPage = row % LOCATION_PAGE_ROWS;
    if (inPage === 0) this.pages.push(new Uint32Array(LOCATION_PAGE_ROWS * LOCATION_WORDS));
    const page = this.pages[this.pages.length - 1]!, offset = inPage * LOCATION_WORDS;
    page[offset] = start;
    page[offset + 1] = compressedBytes;
    page[offset + 2] = bytes;
    page[offset + 3] = crc;
    page[offset + 4] = (database << 1) | Number(deflated);
    this.ids.push(id);
    return row;
  }

  get(row: number | undefined): RecordLocation | undefined {
    if (row === undefined) return undefined;
    const page = this.pages[Math.floor(row / LOCATION_PAGE_ROWS)]!, offset = (row % LOCATION_PAGE_ROWS) * LOCATION_WORDS;
    const flags = page[offset + 4]!;
    return {id: this.ids[row]!, start: page[offset]!, compressedBytes: page[offset + 1]!, bytes: page[offset + 2]!,
      crc: page[offset + 3]!, database: flags >>> 1, deflated: (flags & 1) !== 0};
  }
}

interface RecordIndex {
  generation: string;
  records: RecordLocationTable;
  locations: Map<string, number | number[]>;
  conflicts: Set<string>;
  postings: number;
}
type OsvRecord = Record<string, unknown> & {id: string; aliases?: string[]};

// Bound retained locations and alias fanout. Oversized generations can still use the full validated scan.
const MAX_INDEX_POSTINGS = 1_000_000;
let cachedIndex: RecordIndex | undefined;
let buildingIndex = false;

function addLocation(index: RecordIndex, key: string, location: number) {
  const previous = index.locations.get(key);
  // Copies are appended in scan order. Deduplicate repeated aliases and an alias equal to the ID.
  if (previous === location || (Array.isArray(previous) && previous.at(-1) === location)) return true;
  if (index.postings >= MAX_INDEX_POSTINGS) return false;
  index.postings++;
  if (Array.isArray(previous)) previous.push(location);
  else if (previous !== undefined) index.locations.set(key, [previous, location]);
  // Own newly retained keys so a short parsed alias cannot retain the full decoded record string.
  else index.locations.set(Buffer.from(key, 'ascii').toString('ascii'), location);
  return true;
}

function checkFresh(metadata: OfflineDatabaseMetadata, maxAgeMs: number) {
  const now = Date.now();
  if (metadata.databases.some(d => now < Date.parse(d.downloaded_at) || now - Date.parse(d.downloaded_at) >= maxAgeMs)) {
    throw invalid('a database expired or has a future timestamp during record lookup');
  }
}

function bounded(value: number, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw invalid('invalid lookup limits');
  return value;
}
function validateRecordValue(value: unknown, depth: number, guard: () => void) {
  guard();
  if (depth > 64) throw invalid('OSV record nesting limit exceeded');
  if (typeof value === 'number' && !Number.isFinite(value)) throw invalid('non-finite OSV record number');
}

function validateRecord(value: unknown, guard: () => void, depth = 0) {
  validateRecordValue(value, depth, guard);
  if (Array.isArray(value)) {
    for (const item of value) validateRecord(item, guard, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) validateRecord(record[key], guard, depth + 1);
  }
}

function canonicalDigest(value: unknown, guard: () => void): string {
  const hash = createHash('sha256');
  const visit = (value: unknown, depth: number) => {
    validateRecordValue(value, depth, guard);
    if (Array.isArray(value)) {
      hash.update('['); for (const item of value) {visit(item, depth + 1); hash.update(',');} hash.update(']');
    } else if (value !== null && typeof value === 'object') {
      hash.update('{'); for (const key of Object.keys(value).sort()) {hash.update(JSON.stringify(key)); hash.update(':'); visit((value as Record<string, unknown>)[key], depth + 1); hash.update(',');} hash.update('}');
    } else hash.update(JSON.stringify(value));
  };
  visit(value, 0); return hash.digest('hex');
}

/** Yauzl stops at the declared count, not the directory end. Bind both before treating end as complete. */
async function directoryLayout(file: string, guard: () => void) {
  const handle = await open(file, 'r');
  try {
    const {size: fileSize} = await handle.stat();
    const read = async (size: number, position: number) => {
      guard();
      if (!Number.isSafeInteger(position) || position < 0 || size > fileSize - position) throw invalid('invalid ZIP directory bounds');
      const buffer = Buffer.alloc(size);
      for (let offset = 0; offset < size;) {
        guard(); const {bytesRead} = await handle.read(buffer, offset, size - offset, position + offset);
        if (!bytesRead) throw invalid('truncated ZIP directory metadata');
        offset += bytesRead;
      }
      guard(); return buffer;
    };
    // The maximum EOCD comment plus its header and the ZIP64 locator; never read the whole ZIP.
    const tail = await read(Math.min(fileSize, 22 + 0xffff + 20), Math.max(0, fileSize - 22 - 0xffff - 20));
    let end = tail.length - 22;
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || end + 22 + tail.readUInt16LE(end + 20) !== tail.length) throw invalid('invalid ZIP end record');
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw invalid('multi-disk ZIP database');
    const classicCount = tail.readUInt16LE(end + 10), classicSize = tail.readUInt32LE(end + 12), classicOffset = tail.readUInt32LE(end + 16);
    let count = classicCount, bytes = classicSize, offset = classicOffset, directoryEnd = fileSize - tail.length + end;
    if (tail.readUInt16LE(end + 8) !== classicCount) throw invalid('inconsistent ZIP entry counts');
    if (end >= 20 && tail.readUInt32LE(end - 20) === 0x07064b50) {
      const integer64 = (buffer: Buffer, position: number) => {
        const value = buffer.readBigUInt64LE(position);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('unsupported ZIP64 directory bounds');
        return Number(value);
      };
      if (tail.readUInt32LE(end - 16) || tail.readUInt32LE(end - 4) !== 1) throw invalid('multi-disk ZIP64 database');
      const extendedOffset = integer64(tail, end - 12), extended = await read(56, extendedOffset);
      if (extended.readUInt32LE(0) !== 0x06064b50 || integer64(extended, 4) < 44 ||
          integer64(extended, 4) !== directoryEnd - 20 - extendedOffset - 12 || extended.readUInt32LE(16) || extended.readUInt32LE(20)) throw invalid('invalid ZIP64 end record');
      count = integer64(extended, 32); bytes = integer64(extended, 40); offset = integer64(extended, 48);
      if (integer64(extended, 24) !== count || (classicCount !== 0xffff && classicCount !== count) ||
          (classicSize !== 0xffffffff && classicSize !== bytes) || (classicOffset !== 0xffffffff && classicOffset !== offset)) throw invalid('inconsistent ZIP64 directory metadata');
      directoryEnd = extendedOffset;
    }
    // OSV DBs contain a contiguous central directory immediately before the end record.
    // Checking adjacency also rejects a count+size edit that hides unvisited central entries.
    if (offset > directoryEnd || bytes !== directoryEnd - offset) throw invalid('inconsistent ZIP directory bounds');
    return {count, bytes, fileSize};
  } finally {await handle.close();}
}

export async function lookupOfflineVulnerability(requested: string, options: OfflineRecordOptions = {}) {
  const id = validateVulnerabilityId(requested);
  return withScanCapacity({}, () => readOfflineVulnerability(id, options));
}

async function readOfflineVulnerability(id: string, options: OfflineRecordOptions) {
  const limits = Object.fromEntries(Object.entries(OFFLINE_LOOKUP_LIMITS).map(([key, ceiling]) => [key,
    bounded(options.offlineLookupLimits?.[key as keyof typeof OFFLINE_LOOKUP_LIMITS] ?? ceiling, ceiling)])) as Record<keyof typeof OFFLINE_LOOKUP_LIMITS, number>;
  limits.recordBytes = bounded(options.maxResponseBytes ?? limits.recordBytes, limits.recordBytes);
  const timeout = bounded(options.timeoutMs ?? 120000, 120000), deadline = performance.now() + timeout;
  const config = offlineConfig({...options, offline: true});
  let expired = false, zip: ZipFile | undefined, active: Readable | undefined, failure: unknown;
  let rejectWait: ((error: unknown) => void) | undefined;
  const pastDeadline = () => expired || performance.now() >= deadline;
  const timer = setTimeout(() => {expired = true; const error = timedOut(); rejectWait?.(error); active?.destroy(error);}, timeout);
  const guard = () => {
    if (pastDeadline()) throw timedOut();
    if (failure) throw invalid('unreadable database archive');
  };
  const closeArchive = (archive: ZipFile) => new Promise<void>((resolve, reject) => {
    const clear = () => {archive.off('close', closed); rejectWait = undefined;};
    const closed = () => {clear(); resolve();};
    const failed = (error: unknown) => {clear(); reject(error);};
    rejectWait = failed;
    archive.once('close', closed);
    try {
      archive.close();
      if (pastDeadline()) failed(timedOut());
    } catch (error) {failed(error);}
  });
  let snapshot: Awaited<ReturnType<typeof captureOfflineDatabases>> | undefined;
  let result: {requested_id: string; matched_by: 'id' | 'alias'; records: VulnerabilityExplanation[];
    offline_database: OfflineDatabaseMetadata} | undefined;
  let draft: RecordIndex | undefined, ownsBuilder = false;
  let entries = 0, expanded = 0, matchingBytes = 0;
  const matches = new Map<string, VulnerabilityExplanation>();
  const addMatch = (record: OsvRecord, bytes: number) => {
    matchingBytes += bytes;
    if (matchingBytes > limits.matchingBytes) throw tooLarge();
    matches.set(record.id, buildVulnerabilityExplanation(record, id));
    if (matches.size > limits.matches) throw tooLarge();
  };
  const readRecord = async (stream: Promise<Readable>, expectedId: string, expectedBytes: number, expectedCRC: number) => {
    active = await stream;
    active.on('error', () => {}); // A timeout may destroy the stream before async iteration attaches its listener.
    let bytes = 0, checksum = 0;
    let buffer: Buffer;
    try {
      guard();
      // Both lookup paths supply a bounded ZIP entry size. Decode only after every byte has been filled.
      buffer = Buffer.allocUnsafe(expectedBytes);
      for await (const chunk of active as AsyncIterable<Uint8Array>) {
        guard();
        if (chunk.byteLength > expectedBytes - bytes) throw tooLarge();
        buffer.set(chunk, bytes);
        bytes += chunk.byteLength;
        checksum = crc32(chunk, checksum);
      }
    } finally {active.destroy(); active = undefined;}
    guard();
    if (bytes !== expectedBytes || checksum !== expectedCRC) throw invalid('database entry size or CRC mismatch');
    const record = asRecord(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer)));
    // Canonical IDs name entries. Non-OSV aliases from upstream are allowed strings, but cannot match a request.
    if (!record || record.id !== expectedId || (record.aliases !== undefined &&
        (!Array.isArray(record.aliases) || !record.aliases.every(a => typeof a === 'string')))) {
      throw invalid('invalid OSV record identity or aliases');
    }
    return record as OsvRecord;
  };
  try {
    snapshot = await captureOfflineDatabases({...options, offline: true});
    // Entry names are unique within each ZIP and must agree with record IDs. Only cross-ZIP
    // conflicts need retained digests, including records that do not match the requested alias.
    const identities = snapshot.metadata.databases.length > 1 ? new Map<string, {digest: string; conflicting: boolean}>() : undefined;
    const fresh = () => {
      guard(); checkFresh(snapshot!.metadata, config.maxAgeMs);
    };
    fresh();
    // Select the index only after re-capturing and hashing every selected object. Ordering is part of the generation.
    const generation = JSON.stringify([config.dir, snapshot.metadata.databases]);
    const defaultLimits = Object.entries(OFFLINE_LOOKUP_LIMITS).every(([key, ceiling]) => limits[key as keyof typeof limits] === ceiling);
    let indexed: readonly number[] | undefined;
    const current = cachedIndex;
    if (defaultLimits && current?.generation === generation) {
      const locations = current.locations.get(id);
      const candidates = Array.isArray(locations) ? locations : locations === undefined ? [] : [locations];
      // On a conflict, use the full reader to preserve the order of limit and conflict failures.
      if (!candidates.some(row => current.conflicts.has(current.records.ids[row]!))) indexed = candidates;
    } else if (defaultLimits && !buildingIndex) {
      buildingIndex = ownsBuilder = true;
      draft = {generation, records: new RecordLocationTable(), locations: new Map(), conflicts: new Set(), postings: 0};
    }

    let nextLocation = 0;
    let location = current?.records.get(indexed?.[0]);
    for (const [database, db] of snapshot.metadata.databases.entries()) {
      fresh();
      if (indexed && location?.database !== database) continue;
      const file = path.join(snapshot.dir, 'osv-scalibr', db.ecosystem, 'all.zip');
      const layout = indexed ? undefined : await directoryLayout(file, guard);
      zip = await openPromise(file,
        {autoClose: false, lazyEntries: true, validateEntrySizes: true, strictFileNames: true});
      const onArchiveError = (error: Error) => {failure = error; rejectWait?.(error); active?.destroy(error);};
      zip.on('error', onArchiveError);
      try {
        guard();
        if (indexed) {
          const archive = zip;
          for (; location?.database === database; location = current!.records.get(indexed[++nextLocation])) {
            guard();
            const {start, compressedBytes, bytes, crc, deflated} = location;
            const stream = new Promise<Readable>((resolve, reject) => {
              // yauzl 3.4.0's promise wrapper calls openReadStream with the wrong signature.
              archive.openReadStreamLowLevel(start, compressedBytes, 0, compressedBytes, deflated, bytes,
                (error, stream) => error ? reject(error) : resolve(stream));
            });
            const record = await readRecord(stream, location.id, bytes, crc);
            addMatch(record, bytes);
          }
          continue;
        }
        if (!layout) throw invalid('missing ZIP directory metadata');
        if (zip.entryCount !== layout.count || zip.fileSize !== layout.fileSize) throw invalid('inconsistent ZIP reader metadata');
        if (!zip.entryCount) throw invalid('empty database archive');
        if (zip.entryCount > limits.entries - entries) throw tooLarge();
        const names = new Set<string>();
        let directoryBytes = 0, directoryEntries = 0;
        while (true) {
          guard();
          const current = zip;
          const entry = await new Promise<Entry | null>((resolve, reject) => {
            const clear = () => {current.off('entry', found); current.off('end', ended); rejectWait = undefined;};
            const found = (entry: Entry) => {clear(); resolve(entry);};
            const ended = () => {clear(); resolve(null);};
            rejectWait = error => {clear(); reject(error);};
            current.once('entry', found); current.once('end', ended);
            try {current.readEntry();} catch (error) {rejectWait?.(error);}
          });
          if (!entry) break;
          guard();
          directoryEntries++;
          directoryBytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
          if (directoryBytes > layout.bytes) throw invalid('ZIP entries exceed the declared directory size');
          if (++entries > limits.entries) throw tooLarge();
          if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,63}\.json$/.test(entry.fileName) || names.has(entry.fileName) ||
              entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod) || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw invalid('unexpected or duplicate database entry');
          names.add(entry.fileName);
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 1 || entry.uncompressedSize > limits.recordBytes || entry.uncompressedSize > limits.expandedBytes - expanded) throw tooLarge();
          const local = await zip.readLocalFileHeaderPromise(entry);
          if (!local.fileName.equals(entry.fileNameRaw) || local.compressionMethod !== entry.compressionMethod || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag) throw invalid('inconsistent ZIP entry headers');
          guard();
          const bytes = entry.uncompressedSize, recordId = entry.fileName.slice(0, -5);
          const record = await readRecord(zip.openReadStreamPromise(entry), recordId, bytes, entry.crc32);
          expanded += bytes;
          let conflicting = false;
          if (identities) {
            const digest = canonicalDigest(record, guard);
            const previous = identities.get(recordId);
            conflicting = previous?.conflicting === true || (previous !== undefined && previous.digest !== digest);
            identities.set(recordId, {digest, conflicting});
          } else validateRecord(record, guard);
          const matching = recordId === id || record.aliases?.includes(id);
          if (conflicting && (matching || matches.has(recordId))) throw invalid('conflicting copies of the same record ID');
          if (matching) addMatch(record, bytes);
          if (draft) {
            if (conflicting) draft.conflicts.add(recordId);
            const row = draft.records.append(recordId, database, local.fileDataStart, entry.compressedSize, bytes,
              entry.crc32, entry.compressionMethod === 8);
            if (row === undefined || !addLocation(draft, recordId, row)) draft = undefined;
            else {
              for (const alias of record.aliases ?? []) {
                guard();
                if (ID.test(alias) && !addLocation(draft, alias, row)) {draft = undefined; break;}
              }
            }
          }
        }
        if (directoryEntries !== layout.count || directoryBytes !== layout.bytes) throw invalid('ZIP directory entry count or size mismatch');
      } finally {
        active?.destroy(); active = undefined;
        const archive = zip;
        zip = undefined;
        try {if (archive.isOpen) await closeArchive(archive);}
        finally {
          archive.off('error', onArchiveError);
          // A late close error cannot affect another archive or request.
          archive.on('error', ignoreLateZipError);
        }
      }
      fresh();
    }
    const records = [...matches.values()].sort((a, b) => Number(b.id === id) - Number(a.id === id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    fresh();
    result = {requested_id: id, matched_by: records[0]?.id === id ? 'id' : 'alias',
      records, offline_database: snapshot.metadata};
  } catch (error) {
    if (error instanceof ScanToolError) throw error;
    throw invalid('invalid, unreadable or unsupported ZIP/OSV data');
  } finally {
    try {
      active?.destroy(); zip?.close();
      const cleanup = snapshot?.cleanup();
      if (cleanup) await new Promise<void>((resolve, reject) => {
        // Request cleanup even on timeout, but do not hold either slot while waiting beyond the deadline.
        cleanup.then(resolve, reject);
        rejectWait = reject;
        if (pastDeadline()) reject(timedOut());
      });
    } finally {
      rejectWait = undefined;
      clearTimeout(timer);
      if (ownsBuilder) buildingIndex = false;
    }
  }
  guard();
  checkFresh(result.offline_database, config.maxAgeMs);
  if (draft) cachedIndex = draft;
  return result;
}
