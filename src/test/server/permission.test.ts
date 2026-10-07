/**
 * Nodeの権限モデル(--permission)でビルドしたサーバーを起動し、許可した範囲のスキャンが動くこと、
 * 許可外のパスが「存在しない」ではなくpermission_deniedになること、欠けた許可を起動時に警告することを確認する
 * (docs/DESIGN_TODO.md「B3」)
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// node_modules配下に出力し、依存パッケージを通常どおり解決できるようにする
const distDir = path.join(repoRoot, "node_modules", ".cache", "osv-mcp-permission-test-dist");

let root: string;
let tmp: string;
let project: string;
let outside: string;
let server: ChildProcess | undefined;

beforeAll(() => {
  execFileSync(path.join(repoRoot, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", distDir], { cwd: repoRoot });
}, 60_000);
afterAll(async () => { await rm(distDir, { recursive: true, force: true }); });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "permission-test-")));
  tmp = path.join(root, "tmp");
  project = path.join(root, "project");
  outside = path.join(root, "outside");
  await mkdir(tmp);
  await mkdir(project);
  await mkdir(outside);
  const lock = JSON.stringify({ name: "app", lockfileVersion: 3, packages: { "": { name: "app", dependencies: { a: "1.0.0" } }, "node_modules/a": { version: "1.0.0" } } });
  await writeFile(path.join(project, "package-lock.json"), lock);
  await writeFile(path.join(outside, "package-lock.json"), lock);
  await writeFile(path.join(outside, "app.jar"), "PK");
  await writeFile(path.join(outside, "bom.cdx.json"), JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [] }));
});
afterEach(async () => {
  server?.kill("SIGKILL");
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

/** 渡されたlockfileの数だけ空の結果を返すスキャナー(子プロセスは権限モデルの制限を受けない) */
async function fakeScanner(): Promise<string> {
  const binary = path.join(root, "scanner.cjs");
  await writeFile(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({ results: [] }));\n`);
  await chmod(binary, 0o755);
  return binary;
}

/** 権限モデルで起動し、scan_projectを1回呼んで応答と標準エラー出力を返す */
async function scanUnderPermission(
  target: string, flags: string[], tool = "scan_project", argName = "project_path",
): Promise<{ payload: Record<string, any>; stderr: string }> {
  const child = spawn(process.execPath, ["--permission", ...flags, path.join(distDir, "index.js")], {
    env: { ...process.env, TMPDIR: tmp, OSV_SCANNER_PATH: await fakeScanner(), OSV_MCP_ALLOWED_ROOT: project, OSV_MCP_AUTO_DOWNLOAD: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  server = child;
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const send = (message: object) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "permission-test", version: "0" },
  } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: { [argName]: target } } });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const line = stdout.split("\n").find((l) => l.includes('"id":2'));
    if (line !== undefined) {
      const message = JSON.parse(line) as { result: { content: { text: string }[] } };
      return { payload: JSON.parse(message.result.content[0]!.text) as Record<string, any>, stderr };
    }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no response. stderr: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const allow = () => [
  `--allow-fs-read=${repoRoot}`,
  `--allow-fs-read=${path.join(root, "scanner.cjs")}`,
  `--allow-fs-read=${project}`,
  `--allow-fs-read=${tmp}`,
  `--allow-fs-write=${tmp}`,
  "--allow-child-process",
];

/**
 * `--permission`はNode 22.13・23.5以降のフラグ。Node 20は実験的な`--experimental-permission`で挙動も異なるため、
 * このE2Eは`--permission`を持つNodeでだけ行う(CIのNode 20で「bad option: --permission」により失敗した)
 */
const supportsPermission = process.allowedNodeEnvironmentFlags.has("--permission");

describe.skipIf(!supportsPermission)("Nodeの権限モデル(--permission)で起動したサーバー", () => {
  it("許可した範囲のスキャンはスナップショット方式のまま動き、一時ディレクトリを残さない", async () => {
    const { payload } = await scanUnderPermission(project, allow());
    expect(payload.error).toBeUndefined();
    expect(payload.coverage.manifests).toEqual([{ path: "package-lock.json", ecosystem: "npm", format: "package-lock.json" }]);
    expect(await readdir(tmp)).toEqual([]);
  }, 60_000);

  it("回帰: 読み取りを許可していないパスは「存在しない」ではなくpermission_deniedにする", async () => {
    const { payload } = await scanUnderPermission(outside, allow());
    expect(payload.error.kind).toBe("permission_denied");
    expect(payload.error.message).toContain("--allow-fs-read");
  }, 60_000);

  it.each([
    ["scan_java_artifact", "artifact_path", "app.jar"],
    ["scan_java_artifact", "artifact_path", ""],
    ["scan_sbom", "sbom_path", "bom.cdx.json"],
  ])("回帰: %s(%s=%s)でも、読み取りを許可していないパスはproject_not_found・sbom_not_foundではなくpermission_deniedにする", async (tool, argName, file) => {
    const { payload } = await scanUnderPermission(file === "" ? outside : path.join(outside, file), allow(), tool, argName);
    expect(payload.error.kind).toBe("permission_denied");
  }, 60_000);

  it("回帰: OSV_SCANNER_PATHの読み取りを許可していない場合も、binary_not_foundではなくpermission_deniedにする", async () => {
    const flags = allow().filter((flag) => !flag.includes("scanner.cjs"));
    const { payload, stderr } = await scanUnderPermission(project, flags);
    expect(payload.error.kind).toBe("permission_denied");
    expect(stderr).toContain("OSV_SCANNER_PATHの読み取りが許可されていません");
  }, 60_000);

  it("欠けている許可(一時ディレクトリへの書き込み・子プロセス)を起動時にstderrで警告する", async () => {
    const flags = allow().filter((flag) => !flag.startsWith("--allow-fs-write") && flag !== "--allow-child-process");
    const { payload, stderr } = await scanUnderPermission(project, flags);
    expect(stderr).toContain("一時ディレクトリへの書き込みが許可されていません");
    expect(stderr).toContain("子プロセスの起動が許可されていません");
    // スキャンは失敗するが、内部エラーではなく許可の付け方が分かるエラーになる
    expect(payload.error.kind).toBe("permission_denied");
  }, 60_000);
});
