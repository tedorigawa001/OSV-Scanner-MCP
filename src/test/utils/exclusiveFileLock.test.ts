/** 更新ロックの実OS動作。CIのNative file boundaryジョブでWindows・macOS・Linuxの実機でも実行する */
import { fork } from "node:child_process";
import { once } from "node:events";
import { link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { tryExclusiveFileLock } from "../../utils/exclusiveFileLock.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function makeRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-lock-")));
  roots.push(root);
  return root;
}

it("保持中は同じファイルを二重に取得できず、解放後は同じファイルのまま取り直せる", async () => {
  const guard = path.join(await makeRoot(), "guard");
  const release = await tryExclusiveFileLock(guard);
  expect(release).toBeDefined();
  expect(await tryExclusiveFileLock(guard)).toBeUndefined();
  const before = (await lstat(guard, { bigint: true })).ino;
  await release!();
  const again = await tryExclusiveFileLock(guard);
  expect(again).toBeDefined();
  expect((await lstat(guard, { bigint: true })).ino).toBe(before);
  await again!();
});

it("別のファイルのロックは互いに妨げない", async () => {
  const root = await makeRoot();
  const first = await tryExclusiveFileLock(path.join(root, "a"));
  const second = await tryExclusiveFileLock(path.join(root, "b"));
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  await first!();
  await second!();
});

it("別プロセスが保持している間は取得できず、そのプロセスの強制終了後に取得できる", async () => {
  const root = await makeRoot();
  const guard = path.join(root, "guard");
  // 子プロセスは製品と同じOSの呼び出しを使う(TypeScriptの変換はNodeの型の除去に頼らず、ここで完結させる)
  const script = path.join(root, "holder.mjs");
  await writeFile(script, `
import { createRequire } from "node:module";
import { open } from "node:fs/promises";
const koffi = createRequire(process.argv[3])("koffi");
const handle = await open(process.argv[2], "a+");
let locked;
if (process.platform === "win32") {
  const toHandle = koffi.load(null).func("intptr_t uv_get_osfhandle(int fd)");
  const kernel = koffi.load(process.env.SystemRoot + "\\\\System32\\\\kernel32.dll");
  const lock = kernel.func("int __stdcall LockFile(intptr_t h, uint32_t a, uint32_t b, uint32_t c, uint32_t d)");
  locked = lock(toHandle(handle.fd), 0, 0, 1, 0) !== 0;
} else {
  const libc = koffi.load(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null);
  locked = libc.func("int flock(int fd, int operation)")(handle.fd, 6) === 0;
}
process.send(locked);
setInterval(() => handle.fd, 1000);
`);
  const child = fork(script, [guard, path.resolve("package.json")], { silent: true });
  const closed = once(child, "close");
  try {
    expect((await once(child, "message"))[0]).toBe(true);
    expect(await tryExclusiveFileLock(guard)).toBeUndefined();
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  // 終了後の解放が遅れうるOSがあるため、短い間だけ取り直す
  let release = await tryExclusiveFileLock(guard);
  for (let i = 0; release === undefined && i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    release = await tryExclusiveFileLock(guard);
  }
  expect(release).toBeDefined();
  await release!();
});

it("ディレクトリとハードリンクされたファイルは拒否する", async () => {
  const root = await makeRoot();
  await mkdir(path.join(root, "dir"));
  await expect(tryExclusiveFileLock(path.join(root, "dir"))).rejects.toThrow("regular file");
  const guard = path.join(root, "guard");
  await writeFile(guard, "");
  await link(guard, path.join(root, "second-name"));
  await expect(tryExclusiveFileLock(guard)).rejects.toThrow("changed while opening");
});

// Windowsのシンボリックリンク作成には権限が要る
it.skipIf(process.platform === "win32")("シンボリックリンクは拒否する", async () => {
  const root = await makeRoot();
  await writeFile(path.join(root, "target"), "");
  await symlink(path.join(root, "target"), path.join(root, "guard"));
  await expect(tryExclusiveFileLock(path.join(root, "guard"))).rejects.toThrow("regular file");
});
