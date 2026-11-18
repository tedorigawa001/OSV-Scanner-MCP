/** Synthetic, bounded OSV ZIPs for the real-scanner alias regression controls. Not public OSV data. */
const advisory = (id, introduced, fixed, aliases = []) => ({
  schema_version: '1.6.0', id, modified: '2026-11-18T00:00:00Z', aliases,
  affected: [{package: {ecosystem: 'Go', name: 'example.com/lib'}, ranges: [{type: 'SEMVER',
    events: [{introduced}, ...(fixed ? [{fixed}] : [])]}]}],
});
const go = 'GO-2000-0002', ghsa = 'GHSA-aaaa-bbbb-cccc';

// Only emits the few owned JSON literals below. No general ZIP parsing, external input or tool dependency.
function zip(records) {
  const locals = [], central = [];
  let offset = 0;
  for (const record of records) {
    const name = Buffer.from(record.id + '.json'), body = Buffer.from(JSON.stringify(record));
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(header, name, body); central.push(entry, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function offlineAliasFixtures() {
  const initial = advisory('GO-2000-0001', '0', '1.5.0');
  const cases = [
    {name: 'single-unfixed', records: [initial, advisory(go, '1.4.0', undefined, [ghsa])],
      expected: {recommended_upgrade: '1.5.0', candidate_check: 'has_known_vulnerabilities'}},
    {name: 'aliased-unfixed', records: [initial, advisory(go, '1.4.0', undefined, [ghsa]), advisory(ghsa, '1.4.0', undefined, [go])],
      expected: {recommended_upgrade: '1.5.0', candidate_check: 'has_known_vulnerabilities'}},
    {name: 'aliased-fixed', records: [initial, advisory(go, '1.4.0', '1.6.0', [ghsa]), advisory(ghsa, '1.4.0', '1.7.0', [go])],
      expected: {recommended_upgrade: '1.7.0', candidate_check: 'clean'}},
    {name: 'initially-known-conflict', records: [advisory('GO-2000-0001', '0', '1.5.0', [ghsa]), advisory(ghsa, '1.4.0', '1.7.0', ['GO-2000-0001'])],
      expected: {recommended_upgrade: null, candidate_check: 'conflict'}},
  ];
  return cases.map(fixture => ({...fixture, bytes: zip(fixture.records)}));
}

/** Same canonical ID, but only one copy retains the lookup alias. Reader controls, not public DBs. */
export function offlineExplanationConflictFixtures() {
  const matching = {...advisory('GO-2000-0001', '0', '1.5.0', ['CVE-2000-0001']), summary: 'Matching copy'};
  const other = {...matching, aliases: [], summary: 'Conflicting copy'};
  return [false, true].map(reverse => ({name: 'nonmatching-copy-' + (reverse ? 'first' : 'last'),
    requested_id: 'CVE-2000-0001', canonical_id: matching.id,
    databases: [{ecosystem: 'Go', bytes: zip([reverse ? other : matching])},
      {ecosystem: 'PyPI', bytes: zip([reverse ? matching : other])}]}));
}
