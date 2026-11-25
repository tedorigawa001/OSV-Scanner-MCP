/** Prepare a transferable kit while connected, then install/run only its bytes under OS network denial. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile, writeFile, readdir, realpath, mkdir, mkdtemp, rm, cp, chmod, rename, lstat, open} from 'node:fs/promises';
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {join, resolve, dirname, relative, delimiter, isAbsolute} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function image(file, algorithm = 'sha256', encoding = 'hex') {const h = createHash(algorithm); for await (const b of createReadStream(file)) h.update(b); return h.digest(encoding);}
const archiveIntegrity = async file => 'sha512-' + await image(file, 'sha512', 'base64');
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;
export async function checkArchiveIntegrity(file, expected) {
  assert.match(expected ?? '', sha512Integrity, 'A SHA-512 package integrity pin is required');
  assert.equal(await archiveIntegrity(file), expected, 'Package tarball differs from the SHA-512 integrity pin');
}
function command(node, args, cwd, env, timeout = 120000) {
  const r = spawnSync(node, args, {cwd, env, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  assert.ifError(r.error); return {status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr};
}
function ok(r) {assert.equal(r.status, 0, r.stderr || r.stdout); assert.equal(r.signal, null); return r;}
async function tree(root) {
  const files = {};
  async function visit(dir) {
    for (const e of (await readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await visit(p);
      else if (e.isSymbolicLink()) {
        const {readlink} = await import('node:fs/promises'); files[relative(root, p)] = {symlink: await readlink(p)};
      } else {assert.ok(e.isFile(), 'Unexpected file kind'); files[relative(root, p)] = {sha256: await image(p), bytes: (await lstat(p)).size};}
    }
  }
  await visit(root); return files;
}
export function productionConsumerLock(source, pkg, integrity) {
  assert.equal(source.lockfileVersion, 3); assert.equal(pkg.name, 'osv-scanner-mcp');
  const dependencies = {[pkg.name]: 'file:../application.tgz'};
  const manifest = {name: 'offline-package-consumer', version: '1.0.0', private: true, dependencies};
  const packages = {'': {name: manifest.name, version: manifest.version, dependencies}};
  for (const [key, value] of Object.entries(source.packages)) if (key && value.dev !== true) packages[key] = structuredClone(value);
  packages['node_modules/' + pkg.name] = {version: pkg.version, resolved: dependencies[pkg.name], integrity,
    dependencies: pkg.dependencies, bin: pkg.bin, engines: pkg.engines, license: pkg.license};
  return {manifest, lock: {name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages}};
}
export function checkInstalledFiles(expected, actual) {assert.deepEqual(actual, expected, 'Installed application differs from packed files');}
export function checkPackedMetadata(expected, packed) {
  for (const field of ['name', 'version', 'dependencies', 'bin', 'engines', 'license']) {
    assert.deepEqual(packed[field], expected[field], 'Packed package does not match the dependency-lock checkout: ' + field);
  }
}
export function packageScope(platform, arch) {
  const os = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : undefined;
  assert.ok(os && ['arm64', 'x64'].includes(arch), 'Unsupported package validation platform or architecture');
  return `${os}-${arch}-transfer-kit-offline-npm-install-and-real-MCP-package-runtime`;
}
export function checkShutdown(outcome) {
  // The server deliberately exits with 128 + SIGTERM after synchronously cleaning its resources.
  assert.equal(outcome.code, 143, 'Unexpected SIGTERM shutdown: ' + JSON.stringify(outcome)); assert.equal(outcome.signal, null);
}
export function checkPackageScan(value, metadata) {
  assert.equal(value.offline_database?.mode, 'offline'); assert.equal(value.offline_database.network_requests, false);
  assert.deepEqual(value.offline_database.databases, metadata);
  assert.equal(value.dependency_resolution?.transitive_resolution, 'disabled');
  assert.match(value.dependency_resolution.warning, /transitive dependencies/);
  assert.equal(value.packages.length, 1);
  const pkg = value.packages[0]; assert.equal(pkg.name, 'org.apache.logging.log4j:log4j-core'); assert.equal(pkg.version, '2.14.1');
  assert.equal(pkg.ecosystem, 'Maven'); assert.equal(value.vulnerability_count, pkg.vulnerabilities.length);
  assert.ok(pkg.vulnerabilities.some(v => v.id === 'GHSA-jfh8-c2jp-5v3q' && v.cve === 'CVE-2021-44228'));
  return pkg;
}
export function checkMatrix(versions) {
  assert.equal(new Set(versions).size, versions.length);
  assert.ok(versions.includes('v22.13.0'), 'Minimum declared runtime must be tested');
  for (const major of [24, 26]) assert.ok(versions.some(v => v.startsWith('v' + major + '.')), 'Missing CI runtime major ' + major);
}
function runtimeInfo(node) {return JSON.parse(ok(command(node, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'])).stdout);}
function environment(node, root, kit) {
  // No inherited NODE_PATH/NODE_OPTIONS, npm configuration or scanner/cache fallback.
  return {PATH: dirname(node) + delimiter + '/usr/bin' + delimiter + '/bin', LANG: 'C', TMPDIR: join(root, 'tmp'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_STATE_HOME: join(root, 'xdg-state'),
    npm_config_userconfig: join(kit, 'empty.npmrc'), npm_config_globalconfig: join(kit, 'empty-global.npmrc'),
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false'};
}
const installArgs = (npm, cache) => [npm, 'ci', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict', '--cache', cache];
async function json(file, value) {await writeFile(file, JSON.stringify(value, null, 2) + '\n');}

async function prepare(values) {
  const kit = resolve(values.get('--directory')); await mkdir(kit, {mode: 0o700});
  const nodes = values.get('--node').map(n => resolve(n)), npmCli = await realpath(values.get('--npm-cli'));
  checkMatrix(nodes.map(n => runtimeInfo(n).version));
  const tarball = join(kit, 'application.tgz'), supplied = values.get('--package-tarball');
  let integrity;
  if (supplied) {
    await cp(await realpath(supplied), tarball);
    integrity = values.get('--package-integrity');
  } else {
    ok(command(process.execPath, [npmCli, 'run', 'build'], process.cwd(), process.env));
    const pack = JSON.parse(ok(command(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', kit], process.cwd(), process.env)).stdout)[0];
    await rename(join(kit, pack.filename), tarball);
    integrity = pack.integrity;
  }
  await checkArchiveIntegrity(tarball, integrity);
  const pkg = JSON.parse(await readFile('package.json', 'utf8')), lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const {manifest, lock: consumerLock} = productionConsumerLock(lock, pkg, integrity);
  await mkdir(join(kit, 'consumer')); await json(join(kit, 'consumer/package.json'), manifest); await json(join(kit, 'consumer/package-lock.json'), consumerLock);
  await writeFile(join(kit, 'empty.npmrc'), ''); await writeFile(join(kit, 'empty-global.npmrc'), '');
  await cp(dirname(dirname(npmCli)), join(kit, 'tooling/npm'), {recursive: true});
  const runtimes = [];
  for (const [index, original] of [...nodes, resolve(values.get('--rejected-node'))].entries()) {
    const info = runtimeInfo(original); assert.equal(info.platform, process.platform); assert.equal(info.arch, process.arch);
    const target = join('runtimes', info.version, 'bin/node'); await mkdir(dirname(join(kit, target)), {recursive: true});
    await cp(original, join(kit, target)); await chmod(join(kit, target), 0o755);
    runtimes.push({...info, node: target, sha256: await image(join(kit, target)), supported: index < nodes.length});
  }
  assert.match(runtimes.at(-1).version, /^v20\./, 'Use a Node 20 negative engine control');
  const scannerPath = join(kit, 'scanner/osv-scanner');
  await mkdir(dirname(scannerPath)); await cp(await realpath(values.get('--scanner')), scannerPath);
  await chmod(scannerPath, 0o755);
  const scanner = {sha256: await image(scannerPath), version: ok(command(scannerPath, ['--version'])).stdout.trim().split('\n')[0]};
  const cache = await realpath(values.get('--database-cache')), db = JSON.parse(await readFile(join(cache, 'manifest.json'), 'utf8'));
  assert.equal(db.databases.length, 1); assert.equal(db.databases[0].ecosystem, 'Maven');
  await mkdir(join(kit, 'database/objects'), {recursive: true}); await json(join(kit, 'database/manifest.json'), db);
  await cp(join(cache, 'objects', db.databases[0].sha256 + '.zip'), join(kit, 'database/objects', db.databases[0].sha256 + '.zip'));
  assert.equal(await image(join(kit, 'database/objects', db.databases[0].sha256 + '.zip')), db.databases[0].sha256);
  await cp('src/test/fixtures/offline-maven/pom.xml', join(kit, 'pom.xml'));
  const unpack = await mkdtemp(join(tmpdir(), 'offline-packed-files-'));
  let files;
  try {
    ok(command('/usr/bin/tar', ['-xzf', tarball, '-C', unpack]));
    checkPackedMetadata(pkg, JSON.parse(await readFile(join(unpack, 'package/package.json'), 'utf8')));
    files = await tree(join(unpack, 'package'));
  } finally {await rm(unpack, {recursive: true, force: true});}
  for (const file of ['dist/index.js', 'gradle/export-dependency-graph.init.gradle', 'gradle/register-declarations.init.gradle', 'gradle/plugin-provenance.init.gradle']) assert.ok(files[file], file);
  assert.ok(Object.keys(files).every(f => !/^(src|node_modules|scripts)\//.test(f)), 'Pack must not include the development tree');
  const env = environment(process.execPath, kit, kit); await mkdir(join(kit, 'tmp'));
  const npm = join(kit, 'tooling/npm/bin/npm-cli.js'), npmCache = join(kit, 'npm-cache');
  // Online preparation downloads only exact locked runtime dependencies; no package install scripts run.
  const prep = ok(command(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict', '--cache', npmCache], join(kit, 'consumer'), env));
  await rm(join(kit, 'consumer/node_modules'), {recursive: true, force: true});
  // The disconnected side needs only this kit, not the source checkout or its dependencies.
  await cp(fileURLToPath(import.meta.url), join(kit, 'validate-offline-package.mjs'));
  const sources = {};
  const sourceFiles = ['scripts/validate-offline-package.mjs', 'src/test/osv/offlinePackageValidation.test.ts', 'package.json', 'package-lock.json', '.github/workflows/ci.yml'];
  if (process.platform === 'linux') sourceFiles.push('scripts/offline-package-linux-seccomp.json');
  for (const file of sourceFiles) sources[file] = await image(file);
  const inputs = await tree(kit);
  const proof = {schema: 1, prepared_at: new Date().toISOString(), platform: process.platform, arch: process.arch,
    package: {name: pkg.name, version: pkg.version, engines: pkg.engines, artifact: supplied ? 'supplied_tarball' : 'checkout_pack',
      tarball_sha256: await image(tarball), integrity, files},
    runtimes, npm: {version: ok(command(process.execPath, [npm, '--version'])).stdout.trim()}, scanner, database_manifest: db,
    preparation: {install_scripts: false, exact_repository_dependency_lock: true, status: prep.status}, sources, inputs};
  await json(join(kit, 'kit.json'), proof);
  console.log(JSON.stringify({kit, runtimes: runtimes.map(r => ({version: r.version, supported: r.supported})), package_files: Object.keys(files).length, prepared_files: Object.keys(inputs).length}, null, 2));
}

function networkDenial(node, cwd, env, host) {
  const source = `const net=require('node:net');const s=net.connect({host:process.argv[1],port:9});s.setTimeout(2000);s.on('connect',()=>{s.destroy();console.log('connected')});s.on('timeout',()=>{s.destroy();console.log('timeout')});s.on('error',e=>console.log(e.code));`;
  const result = ok(command(node, ['-e', source, host], cwd, env)).stdout.trim();
  assert.ok(['EPERM', 'EACCES'].includes(result), 'OS network denial not demonstrated for ' + host + ': ' + result); return result;
}
async function mcp(bin, cwd, env, work) {
  const child = spawn(bin, [], {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
  let id = 0, stderr = '', outputBytes = 0; const pending = new Map();
  const lines = createInterface({input: child.stdout});
  const closed = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  const fail = error => {for (const p of pending.values()) {clearTimeout(p.timer); p.reject(error);} pending.clear();};
  child.once('error', fail); child.once('exit', () => fail(Error('Server exited before response: ' + stderr)));
  child.stderr.on('data', b => {stderr += b.toString(); if (stderr.length > 1024 * 1024) child.kill('SIGKILL');});
  child.stdout.on('data', b => {outputBytes += b.length; if (outputBytes > 8 * 1024 * 1024) child.kill('SIGKILL');});
  lines.on('line', line => {
    try {const value = JSON.parse(line), p = pending.get(value.id); if (!p) return;
      pending.delete(value.id); clearTimeout(p.timer); if (value.error) p.reject(Error(JSON.stringify(value.error))); else p.resolve(value.result);
    } catch (e) {fail(e); child.kill('SIGKILL');}
  });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const call = (method, params) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => {pending.delete(next); reject(Error('RPC timeout')); child.kill('SIGKILL');}, 125000);
    pending.set(next, {resolve, reject, timer}); send({jsonrpc: '2.0', id: next, method, ...(params ? {params} : {})});
  });
  try {
    const initialized = await call('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'offline-package-validator', version: '1'}});
    send({jsonrpc: '2.0', method: 'notifications/initialized'});
    const listing = await call('tools/list'), names = listing.tools.map(t => t.name).sort();
    for (const name of ['scan_project', 'scan_java_project', 'scan_sbom', 'suggest_fix', 'explain_vulnerability']) assert.ok(names.includes(name));
    const tool = async (name, args) => {
      const response = await call('tools/call', {name, arguments: args});
      return {isError: response.isError === true, value: JSON.parse(response.content[0].text)};
    };
    return {initialized, tools: names, ...(await work(tool))};
  } finally {
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const outcome = await closed; clearTimeout(timer); lines.close();
    checkShutdown(outcome);
  }
}

async function run(values) {
  const kit = await realpath(values.get('--kit')), proof = JSON.parse(await readFile(join(kit, 'kit.json'), 'utf8'));
  assert.equal(proof.schema, 1); assert.equal(proof.platform, process.platform); assert.equal(proof.arch, process.arch);
  assert.equal(await image(fileURLToPath(import.meta.url)), proof.sources['scripts/validate-offline-package.mjs'], 'Runner differs from prepared source');
  const current = await tree(kit); delete current['kit.json'];
  // npm logs may grow, but content, indexes, runtime images and all transfer inputs must match preparation.
  const stable = input => Object.fromEntries(Object.entries(input).filter(([k]) => !k.startsWith('npm-cache/_logs/') && k !== 'npm-cache/_update-notifier-last-checked'));
  assert.deepEqual(stable(current), stable(proof.inputs), 'Prepared kit changed');
  assert.equal(proof.package.tarball_sha256, current['application.tgz'].sha256, 'Package SHA-256 differs from the transferred archive');
  await checkArchiveIntegrity(join(kit, 'application.tgz'), proof.package.integrity);
  assert.equal(proof.scanner.sha256, current['scanner/osv-scanner'].sha256, 'Scanner SHA-256 differs from the transferred executable');
  const deniedReads = [];
  // The record names each denied domain, never the host path: records are public and must not carry machine paths.
  for (const {domain, file} of values.get('--denied-path')) {
    let handle, code;
    try {handle = await open(file, 'r');} catch (e) {code = e.code;} finally {await handle?.close();}
    assert.ok(['EPERM', 'EACCES'].includes(code), 'Original input must be unreadable: ' + domain);
    deniedReads.push({domain, error: code});
  }
  checkMatrix(proof.runtimes.filter(r => r.supported).map(r => r.version));
  const root = await realpath(await mkdtemp(join(tmpdir(), 'offline-package-run-'))), results = [];
  try {
    const npm = join(kit, 'tooling/npm/bin/npm-cli.js'), cache = join(root, 'npm-cache'), scanner = join(kit, 'scanner/osv-scanner');
    await cp(join(kit, 'npm-cache'), cache, {recursive: true});
    const metadata = proof.database_manifest.databases.map(({ecosystem, downloaded_at, sha256}) => ({ecosystem, downloaded_at, sha256}));
    for (const runtime of proof.runtimes) {
      const node = join(kit, runtime.node); assert.equal(await image(node), runtime.sha256);
      const dir = join(root, runtime.version); await mkdir(join(dir, 'tmp'), {recursive: true});
      await cp(join(kit, 'consumer'), join(dir, 'consumer'), {recursive: true}); await cp(join(kit, 'application.tgz'), join(dir, 'application.tgz'));
      const cwd = join(dir, 'consumer'), env = environment(node, dir, kit);
      const network = {network_control: networkDenial(node, cwd, env, '127.0.0.1'),
        ...(proof.platform === 'linux' && {network_control_ipv6: networkDenial(node, cwd, env, '::1')})};
      if (results.length === 0) {
        const version = ok(command(scanner, ['--version'], cwd, env)).stdout.trim().split('\n')[0];
        assert.equal(version, proof.scanner.version, 'Scanner version differs from the transferred executable');
      }
      assert.equal(await lstat(join(cwd, 'node_modules')).catch(() => null), null);
      const installed = command(node, installArgs(npm, cache), cwd, env);
      if (!runtime.supported) {
        assert.notEqual(installed.status, 0); assert.match(installed.stderr, /EBADENGINE/); assert.match(installed.stderr, /osv-scanner-mcp/);
        results.push({runtime: runtime.version, status: 'engine-rejected', ...network, exit_code: installed.status}); continue;
      }
      ok(installed);
      const app = join(cwd, 'node_modules/osv-scanner-mcp'), bin = join(cwd, 'node_modules/.bin/osv-scanner-mcp');
      assert.equal(await realpath(bin), join(app, 'dist/index.js')); checkInstalledFiles(proof.package.files, await tree(app));
      assert.ok(!relative(root, await realpath(app)).startsWith('..'));
      const probe = `const fs=await import('node:fs/promises');const {openedFilePath}=await import(${JSON.stringify(pathToFileURL(join(app, 'dist/utils/openedFilePath.js')).href)});const fd=await fs.open(${JSON.stringify(join(kit, 'pom.xml'))});try{console.log(JSON.stringify({version:process.version,path:await openedFilePath(fd.fd),crc32:typeof(await import('node:zlib')).crc32}));}finally{await fd.close()}`;
      const native = JSON.parse(ok(command(node, ['--input-type=module', '-e', probe], cwd, env)).stdout);
      assert.equal(native.version, runtime.version); assert.equal(native.path, join(kit, 'pom.xml')); assert.equal(native.crc32, 'function');
      const project = join(dir, 'project'); await mkdir(project); await cp(join(kit, 'pom.xml'), join(project, 'pom.xml'));
      const sbom = join(project, 'input.cdx.json');
      await json(sbom, {bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, components: [{type: 'library', name: 'org.apache.logging.log4j:log4j-core', version: '2.14.1', purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1'}]});
      const serverEnv = {...env, OSV_SCANNER_PATH: scanner, OSV_MCP_OFFLINE: '1', OSV_MCP_OFFLINE_DB_DIR: join(kit, 'database'),
        OSV_MCP_ALLOWED_ROOT: project, OSV_MCP_REQUIRE_ALLOWED_ROOT: '1', OSV_MCP_AUTO_DOWNLOAD: '0', OSV_MCP_NO_CANDIDATE_CHECK: '0'};
      const session = await mcp(bin, cwd, serverEnv, async tool => {
        const scan = await tool('scan_project', {project_path: project}); assert.equal(scan.isError, false);
        const pkg = checkPackageScan(scan.value, metadata);
        const advisoryIds = pkg.vulnerabilities.map(v => v.id).sort();
        const java = await tool('scan_java_project', {project_path: join(project, 'pom.xml')}); assert.equal(java.isError, false);
        assert.deepEqual(checkPackageScan(java.value, metadata), pkg);
        const fix = await tool('suggest_fix', {project_path: project}); assert.equal(fix.isError, false);
        assert.deepEqual(fix.value.offline_database.databases, metadata);
        const s = fix.value.suggestions.find(s => s.package === pkg.name); assert.equal(s.candidate_check, 'clean'); assert.equal(s.candidate_check_source, 'local_database');
        assert.equal(s.verification, 'verified'); assert.ok(s.recommended_upgrade && s.recommended_upgrade !== pkg.version);
        assert.deepEqual(s.per_cve_detail.map(v => v.id).sort(), advisoryIds);
        assert.ok(s.per_cve_detail.every(v => v.recommended_status === 'not_affected'));
        const bom = await tool('scan_sbom', {sbom_path: sbom}); assert.equal(bom.isError, false);
        assert.deepEqual(bom.value.offline_database.databases, metadata); assert.equal(bom.value.identified_vulnerability_count, pkg.vulnerabilities.length);
        assert.equal(bom.value.packages.length, 1);
        const sbomPackage = bom.value.packages[0];
        for (const field of ['name', 'version', 'ecosystem']) assert.equal(sbomPackage[field], pkg[field]);
        assert.deepEqual(sbomPackage.vulnerabilities.map(v => v.id).sort(), advisoryIds);
        const explanations = [];
        for (const id of ['GHSA-jfh8-c2jp-5v3q', 'CVE-2021-44228']) {
          const r = await tool('explain_vulnerability', {vulnerability_id: id}); assert.equal(r.isError, false);
          assert.equal(r.value.id, 'GHSA-jfh8-c2jp-5v3q'); assert.equal(r.value.requested_id, id); assert.ok(r.value.details.length > 0);
          assert.equal(r.value.matched_by, id.startsWith('GHSA') ? 'id' : 'alias'); assert.deepEqual(r.value.offline_database.databases, metadata);
          explanations.push({requested_id: id, matched_by: r.value.matched_by, id: r.value.id, details_sha256: hash(r.value.details)});
        }
        assert.equal(explanations[0].details_sha256, explanations[1].details_sha256);
        return {vulnerability_count: scan.value.vulnerability_count, java_vulnerability_count: java.value.vulnerability_count,
          sbom_vulnerability_count: bom.value.identified_vulnerability_count, advisory_ids: advisoryIds,
          candidate: s, explanations, offline_database: scan.value.offline_database};
      });
      assert.equal(session.initialized.serverInfo.version, proof.package.version);
      // Removing a required dependency must fail; there is no NODE_PATH/development-tree fallback.
      await rm(join(cwd, 'node_modules/yauzl'), {recursive: true});
      const missing = command(node, [bin], cwd, serverEnv, 10000); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/); assert.match(missing.stderr, /yauzl/);
      const empty = join(dir, 'empty-cache'), clean = join(dir, 'empty-consumer'); await cp(join(kit, 'consumer'), clean, {recursive: true});
      const noCache = command(node, installArgs(npm, empty), clean, env); assert.notEqual(noCache.status, 0); assert.match(noCache.stderr, /ENOTCACHED/);
      results.push({runtime: runtime.version, runtime_sha256: runtime.sha256, status: 'verified', ...network, install: {status: installed.status, offline: true, ignore_scripts: true, initially_empty: true},
        packed_files_verified: Object.keys(proof.package.files).length, native_opened_file_probe: {matched: true, crc32: native.crc32}, session,
        negative_controls: {missing_dependency: 'ERR_MODULE_NOT_FOUND', empty_npm_cache: 'ENOTCACHED'}});
    }
    let regressions = null;
    if (values.has('--test-report')) {
      const bytes = await readFile(values.get('--test-report')), r = JSON.parse(bytes); assert.equal(r.success, true); assert.equal(r.numFailedTests, 0);
      regressions = {passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests, files: r.testResults.length, report_sha256: hash(bytes)};
    }
    const record = {schema: 1, date: new Date().toISOString(), scope: packageScope(proof.platform, proof.arch),
      kit_manifest_sha256: await image(join(kit, 'kit.json')), package: proof.package, runtimes: proof.runtimes, npm: proof.npm, scanner: proof.scanner, database_manifest: proof.database_manifest,
      prepared_input_digest: hash(JSON.stringify(stable(proof.inputs))), prepared_file_count: Object.keys(stable(proof.inputs)).length,
      denied_original_reads: deniedReads, results, sources: proof.sources, regressions};
    if (values.has('--output')) await json(values.get('--output'), record);
    console.log(JSON.stringify({package: proof.package.version, results: results.map(r => ({runtime: r.runtime, status: r.status, vulnerabilities: r.session?.vulnerability_count,
      recommended: r.session?.candidate.recommended_upgrade, network_control: r.network_control}))}, null, 2));
  } finally {await rm(root, {recursive: true, force: true});}
}
export async function main(args) {
  const [mode, ...rest] = args, values = new Map([['--node', []], ['--denied-path', []]]);
  assert.ok(['prepare', 'run'].includes(mode), 'Use prepare or run');
  const required = ['--directory', '--database-cache', '--scanner', '--rejected-node', '--npm-cli'];
  const allowed = mode === 'prepare' ? [...required, '--node', '--package-tarball', '--package-integrity'] : ['--kit', '--output', '--test-report', '--denied-path'];
  for (let i = 0; i < rest.length; i += 2) {
    const [k, v] = [rest[i], rest[i + 1]];
    if (k === '--denied-path' && allowed.includes(k)) {
      // <domain>=<absolute path>; only the domain label is recorded.
      const at = v?.indexOf('=') ?? -1, domain = at > 0 ? v.slice(0, at) : '', file = v?.slice(at + 1) ?? '';
      assert.ok(/^[a-z0-9][a-z0-9-]{0,31}$/.test(domain) && isAbsolute(file), '--denied-path requires <domain>=<absolute path>');
      assert.ok(!values.get(k).some(d => d.domain === domain), 'Duplicate denied domain'); values.get(k).push({domain, file}); continue;
    }
    assert.ok(allowed.includes(k) && v && (k === '--package-integrity' ? sha512Integrity.test(v) : isAbsolute(v)),
      'Arguments require known flags and absolute paths or a SHA-512 package integrity pin');
    if (k === '--node') values.get(k).push(v); else {assert.ok(!values.has(k), 'Duplicate argument'); values.set(k, v);}
  }
  for (const k of mode === 'prepare' ? required : ['--kit']) assert.ok(values.has(k), 'Missing ' + k);
  assert.equal(values.has('--package-tarball'), values.has('--package-integrity'), 'Supply --package-tarball and --package-integrity together');
  packageScope(process.platform, process.arch);
  if (mode === 'prepare') await prepare(values); else await run(values);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
