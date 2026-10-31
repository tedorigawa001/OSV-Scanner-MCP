/**
 * ビルドしたサーバーを起動し、OSV_MCP_GRADLE_DECLARATION_TRUSTの未知値で終了せず、
 * 警告だけを出してツールを公開し続けることを確認する(宣言元だけを無効にする)
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// node_modules配下に出力し、依存パッケージを通常どおり解決できるようにする
const distDir = path.join(repoRoot, "node_modules", ".cache", "osv-mcp-declaration-trust-test-dist");
let server: ChildProcess | undefined;
let root: string | undefined;

beforeAll(() => {
  execFileSync(path.join(repoRoot, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", distDir], { cwd: repoRoot });
}, 60_000);
afterAll(async () => { await rm(distDir, { recursive: true, force: true }); });
afterEach(async () => {
  server?.kill("SIGKILL");
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it.each([
  ["an unknown value", "registered-helper-V1", true],
  ["the supported value", "registered-helper-v1", false],
])("keeps serving tools with %s of the trust setting", async (_label, value, warns) => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "declaration-trust-test-")));
  const child = spawn(process.execPath, [path.join(distDir, "index.js")], {
    env: { ...process.env, OSV_MCP_ALLOWED_ROOT: root, OSV_MCP_AUTO_DOWNLOAD: "0", OSV_MCP_GRADLE_DECLARATION_TRUST: value },
    stdio: ["pipe", "pipe", "pipe"],
  });
  server = child;
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const send = (message: object) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "declaration-trust-test", version: "0" },
  } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const deadline = Date.now() + 10_000;
  while (!stdout.includes('"id":2') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  expect(child.exitCode).toBeNull();
  expect(stdout).toContain('"scan_project"');
  expect(stderr.includes("OSV_MCP_GRADLE_DECLARATION_TRUST")).toBe(warns);
}, 30_000);
