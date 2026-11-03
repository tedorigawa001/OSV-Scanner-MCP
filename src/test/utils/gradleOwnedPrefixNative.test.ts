import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const harness = fileURLToPath(new URL('../fixtures/gradleOwnedPrefixNative.py', import.meta.url));
const supported = process.platform === 'darwin' || process.platform === 'linux';
function run(name: string) {
  return JSON.parse(execFileSync('python3', ['-I', harness, name], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  })) as Record<string, unknown>;
}

describe.skipIf(!supported)('Q2/A native authenticated diagnostic transport', () => {
  it('uses different processes and kernel peer credentials, but refuses same-UID adoption before storage reads', () => {
    const result = run('honest');
    expect(result.checks).toContain('separate-process');
    expect(result.checks).toContain('kernel-peer-credentials');
    expect(result.adoption).toBe('provider_unsupported');
    expect(result.storageReads).toBe(0);
    expect(result.originalReadsSkipped).toBe(0);
  });
  it.each(['wrong-key', 'wrong-role', 'replay', 'stale-boot', 'wrong-operation',
    'bad-mac', 'oversized', 'truncated', 'noncanonical', 'server-impostor', 'same-uid-write', 'wrong-peer', 'stale-handshake', 'handshake-timeout',
    'wrong-provider', 'response-replay'])
  ('rejects or exposes the native negative control: %s', (name) => {
    const result = run(name);
    expect(result.case).toBe(name);
    expect(result.verified).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(result.adoption).toBe('provider_unsupported');
    expect(result.originalReadsSkipped).toBe(0);
  });
});

it('records the exact executed fixture source and seventeen distinct native cases without adoption', () => {
  const record = JSON.parse(readFileSync(new URL('../../../docs/validation/gradle-prefix-native-ipc-2026-11-03.json', import.meta.url), 'utf8'));
  expect(record.sourceSha256).toBe(createHash('sha256').update(readFileSync(harness)).digest('hex'));
  expect(record.verifiedCases).toBe(17);
  expect(new Set(record.cases.map((entry: { case: string }) => entry.case)).size).toBe(17);
  expect(record.isolationVerified).toBe(false);
  expect(record.backendEligible).toBe(false);
  expect(record.profileApproved).toBe(false);
  for (const entry of record.cases) {
    expect(entry.verified).toBe(true);
    expect(entry.adoption).toBe('provider_unsupported');
    expect(entry.originalReadsSkipped).toBe(0);
  }
});
