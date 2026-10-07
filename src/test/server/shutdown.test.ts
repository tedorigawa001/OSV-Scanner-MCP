/**
 * ビルドしたサーバーを起動し、スキャン中にシグナル・stdinの終了で止めても
 * スナップショット(元のファイルのコピー)とosv-scannerのプロセスが残らないことを確認する
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// node_modules配下に出力し、依存パッケージを通常どおり解決できるようにする
const distDir = path.join(repoRoot, "node_modules", ".cache", "osv-mcp-shutdown-test-dist");

let root: string;
let tmp: string;
let project: string;
let marker: string;
let server: ChildProcess | undefined;

beforeAll(() => {
  execFileSync(path.join(repoRoot, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", distDir], { cwd: repoRoot });
}, 60_000);
afterAll(async () => { await rm(distDir, { recursive: true, force: true }); });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "shutdown-test-")));
  tmp = path.join(root, "tmp");
  project = path.join(root, "project");
  marker = path.join(root, "scanner-pid");
  await mkdir(tmp);
  await mkdir(project);
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "app", dependencies: { a: "1.0.0" } }));
  await writeFile(path.join(project, "package-lock.json"), JSON.stringify({
    name: "app", lockfileVersion: 3,
    packages: { "": { name: "app", dependencies: { a: "1.0.0" } }, "node_modules/a": { version: "1.0.0" } },
  }));
});
afterEach(async () => {
  server?.kill("SIGKILL");
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

/** 起動したことをPIDで知らせ、終了されるまで応答しないスキャナー */
async function slowScanner(): Promise<string> {
  const binary = path.join(root, "scanner.cjs");
  await writeFile(binary, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
setTimeout(() => {}, 60000);
`);
  await chmod(binary, 0o755);
  return binary;
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** サーバーを起動し、scan_projectを呼んでスキャナーが動き出すまで待つ。スキャナーのPIDを返す */
async function startScan(): Promise<number> {
  const child = spawn(process.execPath, [path.join(distDir, "index.js")], {
    env: { ...process.env, TMPDIR: tmp, OSV_SCANNER_PATH: await slowScanner(), OSV_MCP_ALLOWED_ROOT: root, OSV_MCP_AUTO_DOWNLOAD: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  server = child;
  let stdout = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const send = (message: object) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shutdown-test", version: "0" },
  } });
  await waitFor(async () => (stdout.includes('"id":1') ? true : undefined));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "scan_project", arguments: { project_path: project } } });
  const pid = await waitFor(async () => Number(await readFile(marker, "utf8")) || undefined);
  // スキャナーの実行中はスナップショットが残っている(前提の確認)
  expect((await readdir(tmp)).some((name) => name.startsWith("osv-mcp-snap-"))).toBe(true);
  expect(stdout).not.toContain('"id":2');
  return pid;
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function expectCleanedUp(scannerPid: number): Promise<void> {
  expect(await readdir(tmp)).toEqual([]);
  await waitFor(async () => (isAlive(scannerPid) ? undefined : true));
}

describe("server shutdown during a scan", () => {
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const)("removes the snapshot and kills osv-scanner on %s", async (signal, expectedCode) => {
    const scannerPid = await startScan();
    server!.kill(signal);
    expect(await exited(server!)).toEqual({ code: expectedCode, signal: null });
    await expectCleanedUp(scannerPid);
  }, 30_000);

  it("removes the snapshot and kills osv-scanner when the client closes stdin", async () => {
    const scannerPid = await startScan();
    server!.stdin!.end();
    expect(await exited(server!)).toEqual({ code: 0, signal: null });
    await expectCleanedUp(scannerPid);
  }, 30_000);
});
