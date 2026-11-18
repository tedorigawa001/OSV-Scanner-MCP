import {expect, it} from 'vitest';
// @ts-ignore Executable validation artifact, separate from the shipped server.
import {productionConsumerLock, checkInstalledFiles, checkPackageScan, checkMatrix, checkShutdown, main} from '../../../scripts/validate-offline-package.mjs';

const copy = <T>(value: T): T => structuredClone(value);
const pkg = {name: 'osv-scanner-mcp', version: '0.23.0', dependencies: {runtime: '1.0.0'},
  engines: {node: '>=22.13'}, bin: {'osv-scanner-mcp': 'dist/index.js'}, license: 'Apache-2.0'};
const source = {lockfileVersion: 3, packages: {'': {name: pkg.name},
  'node_modules/runtime': {version: '1.0.0', resolved: 'https://example.invalid/runtime.tgz', integrity: 'sha512-runtime'},
  'node_modules/developer': {version: '2.0.0', dev: true},
  'node_modules/native': {version: '3.0.0', optional: true, os: ['darwin'], cpu: ['arm64'], integrity: 'sha512-native'},
  'node_modules/runtime/node_modules/nested': {version: '4.0.0'}}};

it('preserves exact production/nested/optional dependency pins and binds the packed application', () => {
  const result = productionConsumerLock(source, pkg, 'sha512-application');
  expect(result.manifest.dependencies).toEqual({'osv-scanner-mcp': 'file:../application.tgz'});
  expect(result.lock.packages).not.toHaveProperty('node_modules/developer');
  for (const key of ['node_modules/runtime', 'node_modules/native', 'node_modules/runtime/node_modules/nested']) {
    expect(result.lock.packages[key]).toEqual(source.packages[key as keyof typeof source.packages]);
  }
  expect(result.lock.packages['node_modules/osv-scanner-mcp']).toMatchObject({integrity: 'sha512-application', engines: pkg.engines, dependencies: pkg.dependencies, bin: pkg.bin});
  result.lock.packages['node_modules/runtime'].version = 'changed';
  expect(source.packages['node_modules/runtime'].version).toBe('1.0.0');
});
it.each(['format', 'package'])('rejects an unexpected source lock/package (%s)', mode => {
  expect(() => productionConsumerLock(mode === 'format' ? {...source, lockfileVersion: 2} : source,
    mode === 'package' ? {...pkg, name: 'other'} : pkg, 'sha512-application')).toThrow();
});

const files = {'dist/index.js': {sha256: 'a'.repeat(64), bytes: 10}, 'gradle/plugin-provenance.init.gradle': {sha256: 'b'.repeat(64), bytes: 20}};
it('accepts identical installed package bytes', () => {expect(() => checkInstalledFiles(files, copy(files))).not.toThrow();});
it('recognizes the server cleanup exit convention without accepting forced termination', () => {
  expect(() => checkShutdown({code: 143, signal: null})).not.toThrow();
  for (const result of [{code: 0, signal: null}, {code: null, signal: 'SIGTERM'}, {code: null, signal: 'SIGKILL'}, {code: 1, signal: null}]) expect(() => checkShutdown(result)).toThrow();
});
it.each(['changed', 'missing', 'extra', 'symlink', 'size'])('rejects incorrect installed application content (%s)', mode => {
  const value: any = copy(files);
  if (mode === 'changed') value['dist/index.js'].sha256 = 'c'.repeat(64);
  if (mode === 'missing') delete value['gradle/plugin-provenance.init.gradle'];
  if (mode === 'extra') value['src/index.ts'] = value['dist/index.js'];
  if (mode === 'symlink') value['dist/index.js'] = {symlink: '/outside/workspace/index.js'};
  if (mode === 'size') value['dist/index.js'].bytes++;
  expect(() => checkInstalledFiles(files, value)).toThrow();
});

it('requires minimum Node and both other CI majors', () => {
  expect(() => checkMatrix(['v22.13.0', 'v24.22.1', 'v26.12.1'])).not.toThrow();
});
it.each([
  ['v22.14.0', 'v24.22.1', 'v26.12.1'], ['v22.13.0', 'v26.12.1'],
  ['v22.13.0', 'v24.22.1'], ['v22.13.0', 'v24.22.1', 'v26.12.1', 'v26.12.1'],
].map(versions => ({versions})))('rejects incomplete or duplicate Node coverage ($versions)', ({versions}) => {expect(() => checkMatrix(versions)).toThrow();});

const metadata = [{ecosystem: 'Maven', sha256: 'a'.repeat(64), downloaded_at: '2026-11-18T00:00:00Z'}];
const scan = {offline_database: {mode: 'offline', network_requests: false, databases: metadata},
  dependency_resolution: {transitive_resolution: 'disabled', warning: 'transitive dependencies omitted'}, vulnerability_count: 1,
  packages: [{name: 'org.apache.logging.log4j:log4j-core', version: '2.14.1', ecosystem: 'Maven', vulnerabilities: [{id: 'GHSA-jfh8-c2jp-5v3q', cve: 'CVE-2021-44228'}]}]};
it('accepts a real-package offline scan with known advisory and disabled resolution', () => {expect(checkPackageScan(scan, metadata)).toEqual(scan.packages[0]);});
it.each(['network', 'generation', 'resolution', 'warning', 'package', 'version', 'count', 'advisory'])('rejects false package execution evidence (%s)', mode => {
  const value: any = copy(scan);
  if (mode === 'network') value.offline_database.network_requests = true;
  if (mode === 'generation') value.offline_database.databases[0].sha256 = 'b'.repeat(64);
  if (mode === 'resolution') value.dependency_resolution.transitive_resolution = 'enabled';
  if (mode === 'warning') value.dependency_resolution.warning = '';
  if (mode === 'package') value.packages[0].name = 'wrong:package';
  if (mode === 'version') value.packages[0].version = '2.25.4';
  if (mode === 'count') value.vulnerability_count = 0;
  if (mode === 'advisory') value.packages[0].vulnerabilities[0].cve = 'CVE-2000-0001';
  expect(() => checkPackageScan(value, metadata)).toThrow();
});
it.each([[], ['unknown'], ['run'], ['run', '--kit', 'relative'], ['run', '--kit', '/a', '--kit', '/b'], ['run', '--other', '/a']].map(args => ({args})))(
  'rejects incomplete/nonportable invocation before filesystem access ($args)', async ({args}) => {await expect(main(args)).rejects.toThrow();},
);
// Records are public: denied reads are recorded by domain label, so a bare host path is not accepted.
it.each([['/abs/package.json'], ['Checkout=/abs/package.json'], ['checkout=relative'], ['=/abs'], ['checkout=/a', 'checkout=/b']].map(paths => ({paths})))(
  'requires unique <domain>=<absolute path> denied reads ($paths)', async ({paths}) => {
    await expect(main(['run', '--kit', '/kit', ...paths.flatMap(p => ['--denied-path', p])])).rejects.toThrow(/--denied-path|Duplicate denied domain/);
  },
);
