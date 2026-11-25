import {execFileSync, fork} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {afterAll, afterEach, beforeAll, expect, it} from 'vitest';
import {captureOfflineDatabases} from '../../osv/offlineCache.js';
import {recordZip} from '../fixtures/offlineRecords.js';

let dist: string;
const roots: string[] = [];
const oldZip = recordZip([{name: 'TEST-1.json', body: '{"id":"TEST-1"}'}]);
const newZip = recordZip([{name: 'TEST-2.json', body: '{"id":"TEST-2"}'}]);
const nextZip = recordZip([{name: 'TEST-3.json', body: '{"id":"TEST-3"}'}]);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  dist = await mkdtemp(path.resolve('node_modules/offline-recovery-dist-'));
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', dist]);
});
afterAll(async () => { if (dist) await rm(dist, {recursive: true, force: true}); });
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'offline-recovery-')));
  roots.push(root);
  const preload = path.join(root, 'transport.mjs');
  await writeFile(preload, `
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {basename} from 'node:path';
const mode = process.env.OFFLINE_TEST_PAUSE;
const zip = Buffer.from(process.env.OFFLINE_TEST_ZIP, 'base64');
// Keep the interrupted operation pending until the parent terminates this process.
async function pause() { await new Promise(() => { setInterval(() => {}, 1000); }); }
globalThis.fetch = async () => {
  process.send('fetch');
  if (mode !== 'download') return new Response(zip);
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(zip.subarray(0, 8)); },
    pull: pause,
  }));
};
const rename = fs.rename;
fs.rename = async (from, to) => {
  const publishesManifest = basename(to) === 'manifest.json';
  if (mode === 'before-publish' && publishesManifest) {
    process.send('before-publish');
    await pause();
  }
  await rename(from, to);
  if (mode === 'after-publish' && publishesManifest) {
    process.send('after-publish');
    await pause();
  }
};
syncBuiltinESMExports();
`);
  return {preload, dir: path.join(root, 'cache')};
}

function updater({preload, dir}: Awaited<ReturnType<typeof fixture>>, bytes: Buffer, pause = '') {
  const child = fork(path.join(dist, 'index.js'), ['cache', '--ecosystems', 'npm', '--directory', dir], {
    silent: true, execArgv: ['--import', pathToFileURL(preload).href],
    env: {...process.env, OSV_MCP_OFFLINE: '0', OFFLINE_TEST_ZIP: bytes.toString('base64'), OFFLINE_TEST_PAUSE: pause},
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdout!.resume();
  const messages: unknown[] = [];
  child.on('message', message => messages.push(message));
  const closed = once(child, 'close').then(([code, signal]) => ({code, signal, stderr, messages}));
  return {child, closed, messages};
}

async function waitFor(ready: () => Promise<boolean>, run: ReturnType<typeof updater>) {
  for (let i = 0; i < 500; i++) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(`Updater exited before reaching the interruption point: ${(await run.closed).stderr}`);
    }
    if (await ready()) return;
    await delay(20);
  }
  throw new Error('Updater did not reach the interruption point');
}

it.each(['download', 'before-publish', 'after-publish'])('recovers after terminating an updater at %s', async pause => {
  const input = await fixture();
  const manifest = path.join(input.dir, 'manifest.json');
  const objects = path.join(input.dir, 'objects');
  const initial = await updater(input, oldZip).closed;
  expect(initial.code, initial.stderr).toBe(0);
  const before = await readFile(manifest);
  const running = updater(input, newZip, pause);
  try {
    await waitFor(async () => {
      if (pause !== 'download') return running.messages.includes(pause);
      const partial = (await readdir(objects)).find(name => name.startsWith('.download-'));
      return partial !== undefined && (await stat(path.join(objects, partial))).size === 8;
    }, running);

    const blocked = await updater(input, newZip).closed;
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('update is active');
    expect(blocked.messages).toEqual([]);
    await expect(open(path.join(input.dir, 'update.lock'), 'wx')).rejects.toThrow();
    const published = pause === 'after-publish';
    const selectedZip = published ? newZip : oldZip;
    const manifestAtInterruption = await readFile(manifest);
    if (!published) expect(manifestAtInterruption).toEqual(before);
    expect(JSON.parse(manifestAtInterruption.toString('utf8')).databases[0].sha256).toBe(digest(selectedZip));
    expect(running.child.kill('SIGKILL')).toBe(true);
    expect((await running.closed).signal).toBe('SIGKILL');
    expect(await readFile(manifest)).toEqual(manifestAtInterruption);

    const selected = await captureOfflineDatabases({offline: true, offlineDbDir: input.dir}, ['npm']);
    try { expect(await readFile(path.join(selected.dir, 'osv-scalibr/npm/all.zip'))).toEqual(selectedZip); }
    finally { await selected.cleanup(); }

    const recoveredZip = published ? nextZip : newZip;
    const recovered = await updater(input, recoveredZip).closed;
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(recovered.messages).toEqual(['fetch']);
    expect(JSON.parse(await readFile(manifest, 'utf8')).databases[0].sha256).toBe(digest(recoveredZip));
    expect((await readdir(objects)).sort()).toEqual([digest(selectedZip) + '.zip', digest(recoveredZip) + '.zip'].sort());
    expect(await readdir(input.dir)).not.toContain('update.lock');
    expect((await readdir(input.dir)).filter(name => name.startsWith('.manifest-'))).toEqual([]);
  } finally {
    if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGKILL');
    await running.closed;
  }
});
