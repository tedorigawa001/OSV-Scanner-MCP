/** Bounded ID/alias lookup over verified private OSV ZIP copies. No extraction, index cache or network fallback. */
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import type {Readable} from 'node:stream';
import {openPromise, type ZipFile, type Entry} from 'yauzl';
import {ScanToolError} from '../errors.js';
import {asRecord} from '../utils/unknownJson.js';
import {captureOfflineDatabases} from './offlineCache.js';
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
function bounded(value: number, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw invalid('invalid lookup limits');
  return value;
}
function canonicalDigest(value: unknown, guard: () => void): string {
  const hash = createHash('sha256');
  const visit = (value: unknown, depth: number) => {
    guard(); if (depth > 64) throw invalid('OSV record nesting limit exceeded');
    if (typeof value === 'number' && !Number.isFinite(value)) throw invalid('non-finite OSV record number');
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
  let rejectEntry: ((error: unknown) => void) | undefined;
  const timer = setTimeout(() => {expired = true; const error = timedOut(); rejectEntry?.(error); active?.destroy(error);}, timeout);
  const guard = () => {
    if (expired || performance.now() >= deadline) throw timedOut();
    if (failure) throw invalid('unreadable database archive');
  };
  let snapshot: Awaited<ReturnType<typeof captureOfflineDatabases>> | undefined;
  let result: {requested_id: string; matched_by: 'id' | 'alias'; records: VulnerabilityExplanation[];
    offline_database: Awaited<ReturnType<typeof captureOfflineDatabases>>['metadata']} | undefined;
  let entries = 0, expanded = 0, matchingBytes = 0;
  const matches = new Map<string, {explanation: VulnerabilityExplanation; digest: string}>();
  // Keep bounded digests, not record bodies, even before an alias match is discovered in a later DB.
  const identities = new Map<string, {digest: string; conflicting: boolean}>();
  try {
    snapshot = await captureOfflineDatabases({...options, offline: true});
    const fresh = () => {
      guard(); const now = Date.now();
      if (snapshot!.metadata.databases.some(d => now < Date.parse(d.downloaded_at) || now - Date.parse(d.downloaded_at) >= config.maxAgeMs)) throw invalid('a database expired or has a future timestamp during record lookup');
    };
    for (const db of snapshot.metadata.databases) {
      fresh();
      const file = path.join(snapshot.dir, 'osv-scalibr', db.ecosystem, 'all.zip'), layout = await directoryLayout(file, guard);
      zip = await openPromise(file,
        {autoClose: false, lazyEntries: true, validateEntrySizes: true, strictFileNames: true});
      zip.on('error', error => {failure = error; rejectEntry?.(error); active?.destroy(error);});
      try {
        guard();
        if (zip.entryCount !== layout.count || zip.fileSize !== layout.fileSize) throw invalid('inconsistent ZIP reader metadata');
        if (!zip.entryCount) throw invalid('empty database archive');
        if (zip.entryCount > limits.entries - entries) throw tooLarge();
        const names = new Set<string>();
        let directoryBytes = 0, directoryEntries = 0;
        while (true) {
          guard();
          const current = zip;
          const entry = await new Promise<Entry | null>((resolve, reject) => {
            const clear = () => {current.off('entry', found); current.off('end', ended); rejectEntry = undefined;};
            const found = (entry: Entry) => {clear(); resolve(entry);};
            const ended = () => {clear(); resolve(null);};
            rejectEntry = error => {clear(); reject(error);};
            current.once('entry', found); current.once('end', ended);
            try {current.readEntry();} catch (error) {rejectEntry?.(error);}
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
          active = await zip.openReadStreamPromise(entry);
          active.on('error', () => {}); // A timeout may destroy the stream before async iteration attaches its listener.
          let bytes = 0, checksum = 0; const chunks: Buffer[] = [];
          try {
            guard();
            for await (const value of active) {
              guard(); const chunk = Buffer.from(value); bytes += chunk.length; expanded += chunk.length;
              if (bytes > limits.recordBytes || bytes > entry.uncompressedSize || expanded > limits.expandedBytes) throw tooLarge();
              checksum = crc32(chunk, checksum); chunks.push(chunk);
            }
          } finally {active.destroy(); active = undefined;}
          guard();
          if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) throw invalid('database entry size or CRC mismatch');
          const data = Buffer.concat(chunks, bytes);
          const record = asRecord(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(data)));
          // Canonical IDs name the entry and must be strict. Aliases are upstream cross-references: the official npm DB
          // has some that are not OSV IDs (trailing commas, SNYK IDs over 64 characters). They only need to be strings;
          // the requested ID is already validated, so a malformed alias can never match it and is ignored for matching.
          if (!record || typeof record.id !== 'string' || !ID.test(record.id) || entry.fileName !== record.id + '.json' ||
              (record.aliases !== undefined && (!Array.isArray(record.aliases) || !record.aliases.every(a => typeof a === 'string')))) throw invalid('invalid OSV record identity or aliases');
          const digest = canonicalDigest(record, guard), previous = identities.get(record.id);
          const conflicting = previous?.conflicting === true || (previous !== undefined && previous.digest !== digest);
          identities.set(record.id, {digest, conflicting});
          const matching = record.id === id || (record.aliases as string[] | undefined)?.includes(id);
          if (conflicting && (matching || matches.has(record.id))) throw invalid('conflicting copies of the same record ID');
          if (matching) {
            matchingBytes += bytes;
            if (matchingBytes > limits.matchingBytes) throw tooLarge();
            const explanation = buildVulnerabilityExplanation(record, id);
            matches.set(explanation.id, {explanation, digest});
            if (matches.size > limits.matches) throw tooLarge();
          }
        }
        if (directoryEntries !== layout.count || directoryBytes !== layout.bytes) throw invalid('ZIP directory entry count or size mismatch');
      } finally {
        active?.destroy(); active = undefined; rejectEntry = undefined;
        if (zip.isOpen) await new Promise<void>((resolve, reject) => {zip!.once('close', resolve); zip!.once('error', reject); zip!.close();});
        zip = undefined;
      }
      fresh();
    }
    const records = [...matches.values()].map(m => m.explanation).sort((a, b) => Number(b.id === id) - Number(a.id === id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    fresh();
    result = {requested_id: id, matched_by: records[0]?.id === id ? 'id' : 'alias',
      records, offline_database: snapshot.metadata};
  } catch (error) {
    if (error instanceof ScanToolError) throw error;
    throw invalid('invalid, unreadable or unsupported ZIP/OSV data');
  } finally {
    active?.destroy(); zip?.close();
    try {await snapshot?.cleanup();} finally {clearTimeout(timer);}
  }
  guard();
  const now = Date.now();
  if (!result || result.offline_database.databases.some(d => now < Date.parse(d.downloaded_at) || now - Date.parse(d.downloaded_at) >= config.maxAgeMs)) throw invalid('a database expired or has a future timestamp during record lookup');
  return result;
}
