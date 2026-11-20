/**
 * 走査で読めないディレクトリを黙って飛ばさないこと、1つの巨大なディレクトリでも上限を読みながら
 * 確かめること(脆弱性チェックで判明、2026-11-20)。
 * 以前は、展開したアーカイブ等で権限が0のディレクトリにある脆弱なlockfileを黙って飛ばし、
 * `coverage.complete: true`・脆弱性0件と応答していた。
 */
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ScanToolError } from "../../errors.js";
import { buildCoverage } from "../../tools/scanProject.js";
import { detectProject } from "../../utils/manifestDetector.js";
import { detectJavaProject } from "../../utils/projectDetector.js";
import { UNREADABLE_DIRECTORY_REASON, walkProjectFiles } from "../../utils/projectWalk.js";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-walk-")));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

/** 権限を外したディレクトリで実行し、後片付けのため権限を戻す */
async function withLocked<T>(dir: string, run: () => Promise<T>): Promise<T> {
  await chmod(dir, 0o000);
  try {
    return await run();
  } finally {
    await chmod(dir, 0o755);
  }
}

// rootは権限0のディレクトリも読め、Windowsはchmodで読み取りを禁止できない
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

describe.runIf(canLock)("読めないディレクトリ", () => {
  it("scan_project: 読めないディレクトリを範囲の欠けとして報告し、completeにしない", async () => {
    const dir = await makeProject({
      "requirements.txt": "requests==2.31.0\n",
      "services/payments/package-lock.json": "{}",
    });
    const project = await withLocked(path.join(dir, "services/payments"), () => detectProject(dir));
    expect(project.manifests.map((m) => m.path)).toEqual(["requirements.txt"]);
    expect(project.skippedFiles).toEqual([{ path: path.join("services", "payments"), reason: UNREADABLE_DIRECTORY_REASON }]);
    const coverage = buildCoverage(project);
    expect(coverage.complete).toBe(false);
    expect(coverage).toHaveProperty("warning");
  });

  it("scan_project: マニフェストが無ければ、読めないディレクトリを理由に含めてエラーにする", async () => {
    const dir = await makeProject({ "locked/requirements.txt": "requests==2.31.0\n" });
    const error = await withLocked(path.join(dir, "locked"), () => detectProject(dir).then(() => null, (e: unknown) => e));
    expect(error).toBeInstanceOf(ScanToolError);
    expect((error as ScanToolError).kind).toBe("no_manifest_found");
    expect((error as ScanToolError).message).toContain(`locked: ${UNREADABLE_DIRECTORY_REASON}`);
  });

  it("scan_java_project: 読めないディレクトリを検出結果に残す", async () => {
    const dir = await makeProject({ "pom.xml": "<project/>", "module/pom.xml": "<project/>" });
    const project = await withLocked(path.join(dir, "module"), () => detectJavaProject(dir));
    expect(project.manifests).toEqual(["pom.xml"]);
    expect(project.unreadableDirs).toEqual([{ path: "module", reason: UNREADABLE_DIRECTORY_REASON }]);
  });

  it("scan_java_project: マニフェストが無ければ、読めないディレクトリを理由に含めてエラーにする", async () => {
    const dir = await makeProject({ "module/pom.xml": "<project/>" });
    const error = await withLocked(path.join(dir, "module"), () => detectJavaProject(dir).then(() => null, (e: unknown) => e));
    expect((error as ScanToolError).kind).toBe("no_manifest_found");
    expect((error as ScanToolError).message).toContain(`module: ${UNREADABLE_DIRECTORY_REASON}`);
  });
});

describe("walkProjectFiles", () => {
  it("1つのディレクトリの項目を読みながらエントリ数の上限を確かめる", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) files[`f${i}.txt`] = "";
    const dir = await makeProject(files);
    let seen = 0;
    const error = await walkProjectFiles(dir, { maxEntries: 10 }, new Set(), () => (seen++, false)).then(() => null, (e: unknown) => e);
    expect((error as ScanToolError).kind).toBe("manifest_search_limit_exceeded");
    expect(seen).toBe(0); // 上限を超えたディレクトリの項目は1件も使わない
  });

  it("上限ちょうどの項目数は走査できる", async () => {
    const dir = await makeProject({ "a.txt": "", "b.txt": "", "sub/c.txt": "" });
    const names: string[] = [];
    await walkProjectFiles(dir, { maxEntries: 4 }, new Set(), (_relative, name) => (names.push(name), false));
    expect(names.sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
});
