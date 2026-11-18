/** Small owned ZIP fixtures, independent of the production reader. Never accepts user input. */
import {crc32, deflateRawSync} from 'node:zlib';
export interface RecordEntry {name: string; body: string | Buffer; method?: number; crc?: number; size?: number; flags?: number}
export function recordZip(entries: readonly RecordEntry[], zip64 = false): Buffer<ArrayBuffer> {
  const locals: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.body), method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw, checksum = entry.crc ?? crc32(raw);
    const header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(entry.flags ?? 0, 6);
    header.writeUInt16LE(method, 8); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18); header.writeUInt32LE(entry.size ?? raw.length, 22); header.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(entry.size ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(header, name, body); directory.push(central, name); offset += header.length + name.length + body.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : central.length, 12); end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  if (!zip64) return Buffer.concat([...locals, central, end]);
  const extended = Buffer.alloc(56), locator = Buffer.alloc(20);
  extended.writeUInt32LE(0x06064b50); extended.writeBigUInt64LE(44n, 4); extended.writeUInt16LE(45, 12); extended.writeUInt16LE(45, 14);
  extended.writeBigUInt64LE(BigInt(entries.length), 24); extended.writeBigUInt64LE(BigInt(entries.length), 32);
  extended.writeBigUInt64LE(BigInt(central.length), 40); extended.writeBigUInt64LE(BigInt(offset), 48);
  locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + central.length), 8); locator.writeUInt32LE(1, 16);
  return Buffer.concat([...locals, central, extended, locator, end]);
}
