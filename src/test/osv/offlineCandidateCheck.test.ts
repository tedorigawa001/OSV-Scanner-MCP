import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, realpath, mkdir, writeFile, readFile, chmod, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {existsSync} from 'node:fs';
import {prepareOfflineDatabases, captureOfflineDatabases} from '../../osv/offlineCache.js';
import {queryOfflineCandidate, candidatePurl} from '../../osv/offlineCandidate.js';
import {handleSuggestFix} from '../../tools/suggestFix.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});
const record = (id: string, introduced: string, fixed?: string) => ({
  id, affected: [{package: {name: 'x', ecosystem: 'npm'}, ranges: [{type: 'SEMVER',
    events: [{introduced}, ...(fixed ? [{fixed}] : [])]}]}],
});
const original = record('GHSA-original', '0', '1.5.0');

async function fixture(config: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'offline-candidates-')));
  roots.push(root);
  const project = path.join(root, 'project'), cache = path.join(root, 'cache');
  await mkdir(project);
  await writeFile(path.join(project, 'package-lock.json'), JSON.stringify({name: 'test', lockfileVersion: 3,
    packages: {'node_modules/x': {version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz'}}}));
  await prepareOfflineDatabases({dir: cache, ecosystems: ['npm'], fetchFn: async () => new Response(
    Buffer.from('PK\x03\x04candidate transport fixture'))});
  const binary = path.join(root, 'scanner.cjs'), log = path.join(root, 'queries.jsonl');
  await writeFile(binary, '#!' + process.execPath + '\n' + `
const fs=require('node:fs'),args=process.argv.slice(2),config=${JSON.stringify(config)},original=${JSON.stringify(original)};
const sbom=args.find(a=>a.endsWith('.cdx.json'));
let info={name:'x',ecosystem:'npm',version:'1.0.0'},records=[original],source={path:args.at(-1).replace(/^package-lock.json:/,''),type:'lockfile'};
if(sbom){
 const component=JSON.parse(fs.readFileSync(sbom,'utf8')).components[0];
 info={name:component.name,ecosystem:'npm',version:component.version};source={path:sbom,type:'sbom'};
 if(config.ecosystem)info.ecosystem=config.ecosystem;
 records=config.responses?.[component.version]??[];
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({version:component.version,purl:component.purl,args,cache:process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY})+'\\n');
}
const item={package:info,groups:records.map(r=>({ids:[r.id]})),vulnerabilities:records};
if(!sbom&&config.mutateCache){
 const cache=${JSON.stringify(cache)},manifestFile=cache+'/manifest.json',m=JSON.parse(fs.readFileSync(manifestFile,'utf8')),d=m.databases[0],object=cache+'/objects/'+d.sha256+'.zip';
 if(config.mutateCache==='digest'){const b=fs.readFileSync(object);b[b.length-1]^=1;fs.writeFileSync(object,b);}
 if(config.mutateCache==='expired'){d.downloaded_at='2020-01-01T00:00:00.000Z';fs.writeFileSync(manifestFile,JSON.stringify(m));}
 if(config.mutateCache==='generation'){d.downloaded_at=new Date(Date.now()-1000).toISOString();fs.writeFileSync(manifestFile,JSON.stringify(m));}
}
let out={results:[{source,packages:[item]}]};
if(sbom){
 if(config.output==='empty')out={results:[]};
 if(config.output==='wrong-name')info.name='another-package';
 if(config.output==='wrong-version')info.version='99.0.0';
 if(config.output==='wrong-ecosystem')info.ecosystem='PyPI';
 if(config.output==='wrong-source')source.path='/elsewhere.cdx.json';
 if(config.output==='missing-details')item.vulnerabilities=[];
 if(config.output==='malformed-details')item.vulnerabilities=[{id:'GHSA-extra',affected:null}];
 if(config.output==='missing-results')out={};
 if(config.output==='exit-failure')process.exit(127);
}
console.log(JSON.stringify(out));
`);
  await chmod(binary, 0o755);
  const fetchFn = vi.fn(() => {throw Error('network must not be used');});
  const options = {offline: true, offlineDbDir: cache, binaryPath: binary, candidateCheck: {fetchFn}};
  return {root, project, cache, binary, log, fetchFn, options};
}

it('rechecks an offline recommendation using an identified candidate in the local DB, never the API', async () => {
  const f = await fixture();
  const result = await handleSuggestFix({project_path: f.project}, f.options);
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  const output = JSON.parse(result.content[0]!.text);
  expect(output.suggestions[0]).toMatchObject({recommended_upgrade: '1.5.0', candidate_check: 'clean', candidate_check_source: 'local_database'});
  expect(output.suggestions[0].upgrade_note).toContain('local database snapshot');
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  expect(calls.map(c => c.version)).toEqual(['1.5.0']);
  expect(calls[0].args).toContain('--offline');
  expect(calls[0].args).toContain('--no-resolve');
  expect(f.fetchFn).not.toHaveBeenCalled();
  for(const call of calls)await expect(readFile(path.join(call.cache,'osv-scalibr/npm/all.zip'))).rejects.toThrow();
});

it('reselects when a local candidate has a vulnerability absent from the current version', async () => {
  const f = await fixture({responses: {'1.5.0': [record('GHSA-extra', '1.4.0', '1.6.0')]}});
  const result = await handleSuggestFix({project_path: f.project}, f.options);
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  const suggestion = JSON.parse(result.content[0]!.text).suggestions[0];
  expect(suggestion).toMatchObject({recommended_upgrade: '1.6.0', candidate_check: 'clean', candidate_check_source: 'local_database'});
  expect(suggestion.upgrade_note).toContain('1.5.0 is affected by 1 known vulnerability');
  expect((await readFile(f.log, 'utf8')).trim().split('\n').map(s => JSON.parse(s).version)).toEqual(['1.5.0', '1.6.0']);
  expect(f.fetchFn).not.toHaveBeenCalled();
});

it('reports new unfixed candidate vulnerabilities and withholds conflicting candidates', async () => {
  const unfixed = await fixture({responses: {'1.5.0': [record('GHSA-extra', '1.4.0')]}});
  const result = await handleSuggestFix({project_path: unfixed.project}, unfixed.options);
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text).suggestions[0]).toMatchObject({candidate_check: 'has_known_vulnerabilities', recommended_known_vulnerabilities: ['GHSA-extra']});
  const conflict = await fixture({responses: {'1.5.0': [original]}});
  const second = await handleSuggestFix({project_path: conflict.project}, conflict.options);
  expect(second.isError, second.content[0]!.text).not.toBe(true);
  expect(JSON.parse(second.content[0]!.text).suggestions[0]).toMatchObject({candidate_check: 'conflict', recommended_upgrade: null});
});

it.each([false, true])('same-query GO/GHSA aliases keep an unfixed recommendation (reverse=%s)', async reverse => {
  const go = {...record('GO-2000-0002', '1.4.0'), aliases: ['GHSA-aaaa-bbbb-cccc']};
  const ghsa = {...record('GHSA-aaaa-bbbb-cccc', '1.4.0'), aliases: ['GO-2000-0002']};
  const records = reverse ? [ghsa, go] : [go, ghsa];
  const f = await fixture({responses: {'1.5.0': records}});
  const result = await handleSuggestFix({project_path: f.project}, f.options);
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  const suggestion = JSON.parse(result.content[0]!.text).suggestions[0];
  expect(suggestion).toMatchObject({recommended_upgrade: '1.5.0', candidate_check: 'has_known_vulnerabilities', verification: 'verified'});
  expect(suggestion.recommended_known_vulnerabilities.sort()).toEqual([go.id, ghsa.id].sort());
  expect(suggestion.upgrade_note).not.toContain('range data disagree');
  expect(f.fetchFn).not.toHaveBeenCalled();
});

it.each([false, true])('same-query aliases preserve every record range during reselection (reverse=%s)', async reverse => {
  const go = {...record('GO-2000-0002', '1.4.0', '1.6.0'), aliases: ['GHSA-aaaa-bbbb-cccc']};
  const ghsa = {...record('GHSA-aaaa-bbbb-cccc', '1.4.0', '1.7.0'), aliases: ['GO-2000-0002']};
  const f = await fixture({responses: {'1.5.0': reverse ? [ghsa, go] : [go, ghsa]}});
  const result = await handleSuggestFix({project_path: f.project}, f.options);
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text).suggestions[0]).toMatchObject({recommended_upgrade: '1.7.0', candidate_check: 'clean'});
  expect((await readFile(f.log, 'utf8')).trim().split('\n').map(s => JSON.parse(s).version)).toEqual(['1.5.0', '1.7.0']);
});

it('aliases of an initially known fix target still conflict', async () => {
  const f = await fixture({responses: {'1.5.0': [{...record('GO-2000-0001', '0', '1.5.0'), aliases: [original.id]}]}});
  const result = await handleSuggestFix({project_path: f.project}, f.options);
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text).suggestions[0]).toMatchObject({recommended_upgrade: null, candidate_check: 'conflict'});
});

it('an advisory learned in an earlier query still conflicts at a later candidate', async () => {
  const go = {...record('GO-2000-0002', '1.4.0', '1.6.0'), aliases: ['GHSA-aaaa-bbbb-cccc']};
  const ghsa = {...record('GHSA-aaaa-bbbb-cccc', '1.4.0', '1.6.0'), aliases: ['GO-2000-0002']};
  const f = await fixture({responses: {'1.5.0': [go], '1.6.0': [ghsa]}});
  const result = await handleSuggestFix({project_path: f.project}, f.options);
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text).suggestions[0]).toMatchObject({recommended_upgrade: null, candidate_check: 'conflict'});
});

it.each(['empty', 'wrong-name', 'wrong-version', 'wrong-ecosystem', 'wrong-source', 'missing-details', 'malformed-details', 'missing-results', 'exit-failure'])(
  'rejects %s candidate output rather than publishing clean', async output => {
    const f = await fixture({output, responses: {'1.5.0': [record('GHSA-extra', '1.4.0')]}});
    const result = await handleSuggestFix({project_path: f.project}, f.options);
    expect(result.isError, result.content[0]!.text).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error.kind).toBe(output === 'exit-failure' ? 'scan_failed' : 'invalid_output');
    expect(f.fetchFn).not.toHaveBeenCalled();
  },
);

it.each(['digest', 'expired', 'generation'])('rejects a %s DB change after the project scan', async mutateCache => {
  const f = await fixture({mutateCache});
  const result = await handleSuggestFix({project_path: f.project}, f.options);
  expect(result.isError, result.content[0]!.text).toBe(true);
  expect(JSON.parse(result.content[0]!.text).error).toMatchObject({kind: 'scan_failed'});
  expect(result.content[0]!.text).toContain('Offline database cache');
  expect(f.fetchFn).not.toHaveBeenCalled();
});

it.each(['option', 'environment'])('honors %s disabling without candidate or network queries', async mode => {
  const f = await fixture();
  if(mode === 'environment')vi.stubEnv('OSV_MCP_NO_CANDIDATE_CHECK', '1');
  const result = await handleSuggestFix({project_path: f.project}, mode === 'option' ? {...f.options, candidateCheck: 'disabled'} : {...f.options, candidateCheck: undefined});
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text).suggestions[0].candidate_check).toBe('disabled');
  await expect(readFile(f.log)).rejects.toThrow();
  expect(f.fetchFn).not.toHaveBeenCalled();
});

it.each([0, 1])('keeps query budget %s and never calls an unchecked candidate clean', async maxQueriesPerPackage => {
  const f = await fixture({responses: {'1.5.0': [record('GHSA-extra', '1.4.0', '1.6.0')]}});
  const result = await handleSuggestFix({project_path: f.project}, {...f.options, candidateCheck: {fetchFn: f.fetchFn, maxQueriesPerPackage}});
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text).suggestions[0]).toMatchObject({candidate_check: 'skipped', recommended_upgrade: maxQueriesPerPackage === 0 ? '1.5.0' : '1.6.0'});
  expect(f.fetchFn).not.toHaveBeenCalled();
});

it('honors the total query limit without invoking a candidate scanner', async () => {
  const f = await fixture();
  const result = await handleSuggestFix({project_path: f.project}, {...f.options, candidateCheck: {maxQueriesTotal: 0}});
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text).suggestions[0].candidate_check).toBe('skipped');
  await expect(readFile(f.log)).rejects.toThrow();
});

it('environment offline mode cannot be overridden by false or injected network options', async () => {
  const f = await fixture();
  vi.stubEnv('OSV_MCP_OFFLINE', '1');
  const result = await handleSuggestFix({project_path: f.project}, {...f.options, offline: false});
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text).suggestions[0]).toMatchObject({candidate_check: 'clean', candidate_check_source: 'local_database'});
  expect(f.fetchFn).not.toHaveBeenCalled();
});

it('does not load an unrelated expired ecosystem for a candidate', async () => {
  const f = await fixture();
  await prepareOfflineDatabases({dir: f.cache, ecosystems: ['PyPI'], now: Date.parse('2020-01-01T00:00:00.000Z'),
    fetchFn: async () => new Response(Buffer.from('PK\x03\x04old unrelated ecosystem'))});
  const result = await handleSuggestFix({project_path: f.project}, f.options);
  expect(result.isError, result.content[0]!.text).not.toBe(true);
  expect(JSON.parse(result.content[0]!.text).suggestions[0].candidate_check).toBe('clean');
});

it('rejects expiration during a native query before publishing clean', async () => {
  const f = await fixture(), snapshot = await captureOfflineDatabases(f.options, ['npm']), expected = snapshot.metadata;
  await snapshot.cleanup();
  const start = Date.now(), expired = Date.parse(expected.databases[0]!.downloaded_at) + 168 * 3600000;
  vi.spyOn(Date, 'now').mockImplementation(() => existsSync(f.log) ? expired : start);
  await expect(queryOfflineCandidate('npm', 'x', '1.5.0', f.options, expected)).rejects.toThrow('unexpired database snapshot');
});

it.each([
  ['unknown', 'x', '1.5.0'], ['Maven', 'not-a-coordinate', '1.5.0'], ['Go', '../x', '1.5.0'],
  ['npm', 'x\n', '1.5.0'], ['npm', 'x', '1.5.0\n'], ['npm', 'x'.repeat(4097), '1.5.0'], ['npm', 'x', '1'.repeat(513)],
])('refuses unsupported or unbounded candidate identity %s', (ecosystem, name, version) => {
  expect(() => candidatePurl(ecosystem, name, version)).toThrow();
});

it.each([
  ['Maven', 'org.example:lib', 'pkg:maven/org.example/lib@1.5.0'],
  ['npm', '@scope/lib', 'pkg:npm/%40scope/lib@1.5.0'],
  ['PyPI', 'some_lib', 'pkg:pypi/some_lib@1.5.0'],
  ['Go', 'example.com/lib', 'pkg:golang/example.com/lib@1.5.0'],
  ['crates.io', 'some-lib', 'pkg:cargo/some-lib@1.5.0'],
  ['Packagist', 'vendor/lib', 'pkg:composer/vendor/lib@1.5.0'],
  ['NuGet', 'Example.Lib', 'pkg:nuget/Example.Lib@1.5.0'],
])('identifies %s candidates with an ecosystem-specific PURL', async (ecosystem, name, purl) => {
  const f = await fixture({ecosystem});
  if(ecosystem !== 'npm')await prepareOfflineDatabases({dir: f.cache, ecosystems: [ecosystem], fetchFn: async () => new Response(Buffer.from('PK\x03\x04other ecosystem'))});
  const snapshot = await captureOfflineDatabases(f.options, [ecosystem]);
  const expected = snapshot.metadata;
  await snapshot.cleanup();
  expect(await queryOfflineCandidate(ecosystem, name, '1.5.0', f.options, expected)).toEqual([]);
  expect(JSON.parse((await readFile(f.log, 'utf8')).trim()).purl).toBe(purl);
});
