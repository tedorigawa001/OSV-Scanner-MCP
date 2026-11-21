/**
 * Synthetic heap estimate for the explain_vulnerability ID/alias index (docs/OFFLINE_NPM_VALIDATION.md, "Index memory").
 * Copies RecordIndex/addLocation from src/osv/offlineRecord.ts (943d3fc) and fills it with synthetic IDs and aliases.
 * Usage: node --expose-gc scripts/measure-offline-index-memory.mjs <records> <aliasesPerRecord> <keyLength>
 */
const [records, aliasesPerRecord, keyLength] = process.argv.slice(2).map(Number);
const MAX = 1_000_000;
function addLocation(index, key, location) {
  const previous = index.locations.get(key);
  if (previous === location || (Array.isArray(previous) && previous.at(-1) === location)) return true;
  if (index.postings >= MAX) return false;
  index.postings++;
  if (Array.isArray(previous)) previous.push(location);
  else if (previous) index.locations.set(key, [previous, location]);
  else index.locations.set(Buffer.from(key, 'ascii').toString('ascii'), location);
  return true;
}
const pad = (s) => (s + "-".repeat(keyLength)).slice(0, Math.max(keyLength, s.length));
globalThis.gc(); globalThis.gc();
const before = process.memoryUsage();
const index = { generation: "g", locations: new Map(), conflicts: new Set(), postings: 0 };
let full = false;
for (let i = 0; i < records && !full; i++) {
  const id = pad(`GHSA-${i.toString(36)}`);
  const location = { database: 0, id: Buffer.from(id).toString(), start: i * 1000, compressedBytes: 900 + (i % 100), bytes: 3000 + (i % 1000), crc: (i * 2654435761) >>> 0, deflated: true };
  if (!addLocation(index, id, location)) { full = true; break; }
  for (let a = 0; a < aliasesPerRecord; a++) if (!addLocation(index, pad(`CVE-2026-${i}-${a}`), location)) { full = true; break; }
}
globalThis.gc(); globalThis.gc();
const after = process.memoryUsage();
console.log(JSON.stringify({ records, aliasesPerRecord, keyLength, postings: index.postings, keys: index.locations.size, capped: full,
  heapUsedMB: +((after.heapUsed - before.heapUsed) / 2 ** 20).toFixed(1), rssMB: +((after.rss - before.rss) / 2 ** 20).toFixed(1) }));
