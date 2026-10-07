import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ScanToolError } from "../../errors.js";
import { handleScanJavaProject } from "../../tools/scanJavaProject.js";
import { handleScanProject } from "../../tools/scanProject.js";
import { ScanSnapshot, snapshotManifests } from "../../utils/scanSnapshot.js";

const tempDirs: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-snaptest-")));
  tempDirs.push(base);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(base, name)), { recursive: true });
    await writeFile(path.join(base, name), content);
  }
  return base;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const gav = "<groupId>g</groupId><artifactId>p</artifactId><version>1</version>";
const childPom = (relativePath: string) =>
  `<project><parent>${gav}<relativePath>${relativePath}</relativePath></parent><artifactId>c</artifactId></project>`;

describe("ScanSnapshot", () => {
  it("pom.xmlと親POMを、元の配置を再現してコピーする(osv-scannerが相対パスでコピーの親を見つけられる)", async () => {
    const base = await makeTree({ "root/pom.xml": "<project/>", "root/mod/pom.xml": childPom("../pom.xml") });
    const snapshot = await ScanSnapshot.create();
    try {
      const { targets, skipped, incomplete } = await snapshotManifests(snapshot, [{ path: path.join(base, "root/mod/pom.xml"), format: "pom.xml" }], {
        projectDir: path.join(base, "root/mod"),
        allowedRootReal: path.join(base, "root"),
      });
      expect(skipped).toEqual([]);
      expect(incomplete).toEqual([]);
      expect(targets[0]!.path).toBe(snapshot.mirror(path.join(base, "root/mod/pom.xml")));
      // 子のコピーから見た ../pom.xml に、親のコピーがある
      expect(await readFile(path.join(path.dirname(targets[0]!.path), "../pom.xml"), "utf8")).toBe("<project/>");
      expect((await stat(snapshot.dir)).mode & 0o777).toBe(0o700);
    } finally {
      await snapshot.cleanup();
    }
    await expect(stat(snapshot.dir)).rejects.toThrow();
  });

  it("..を重ねてスナップショットの外(本物のファイルシステム)に届く参照は除外する", async () => {
    // 実際のファイルシステムでは..がルートで止まり許可ルート内を指すが、スナップショット内では外に出る
    const base = await makeTree({ "root/parent/pom.xml": "<project/>" });
    const escape = `${"../".repeat(64)}${path.join(base, "root/parent/pom.xml").slice(1)}`;
    await mkdir(path.join(base, "root/proj"), { recursive: true });
    await writeFile(path.join(base, "root/proj/pom.xml"), childPom(escape));
    const snapshot = await ScanSnapshot.create();
    try {
      const { skipped } = await snapshotManifests(snapshot, [{ path: path.join(base, "root/proj/pom.xml"), format: "pom.xml" }], {
        projectDir: path.join(base, "root/proj"),
        allowedRootReal: path.join(base, "root"),
      });
      expect(skipped[0]?.reason).toContain("スキャン範囲の外に出る");
    } finally {
      await snapshot.cleanup();
    }
  });

  it("回帰: 親POMが名前付きパイプを参照しても処理が止まらない(親はコピーされずスキャンは続く)", async () => {
    const base = await makeTree({ "root/proj/pom.xml": childPom("../pipe") });
    execFileSync("mkfifo", [path.join(base, "root/pipe")]);
    const snapshot = await ScanSnapshot.create();
    try {
      const result = await Promise.race([
        snapshotManifests(snapshot, [{ path: path.join(base, "root/proj/pom.xml"), format: "pom.xml" }], {
          projectDir: path.join(base, "root/proj"),
          allowedRootReal: path.join(base, "root"),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("処理が止まった")), 3000)),
      ]);
      expect(result.skipped).toEqual([]);
      expect(result.targets).toHaveLength(1);
      // 親を含めずにスキャンしたことを欠落として返す
      expect(result.incomplete).toEqual([
        { path: path.join(base, "root/proj/pom.xml"), reason: expect.stringContaining("通常のファイルではありません") },
      ]);
    } finally {
      await snapshot.cleanup();
    }
  });

  it.each([
    { label: "許可ルートあり", allowed: true },
    { label: "許可ルートなし", allowed: false },
  ])("存在する親POMをサイズ超過でコピーできない場合、子はスキャンするが欠落として返す($label)", async ({ allowed }) => {
    const base = await makeTree({ "root/pom.xml": `<project>${" ".repeat(10 * 1024 * 1024 + 1)}</project>`, "root/mod/pom.xml": childPom("../pom.xml") });
    const snapshot = await ScanSnapshot.create();
    try {
      const { targets, skipped, incomplete } = await snapshotManifests(snapshot, [{ path: path.join(base, "root/mod/pom.xml"), format: "pom.xml" }], {
        projectDir: path.join(base, "root/mod"),
        allowedRootReal: allowed ? path.join(base, "root") : undefined,
      });
      expect(targets).toHaveLength(1);
      expect(skipped).toEqual([]);
      expect(incomplete).toEqual([{ path: path.join(base, "root/mod/pom.xml"), reason: expect.stringContaining("サイズが上限を超えています") }]);
    } finally {
      await snapshot.cleanup();
    }
  });

  it("親POMが存在しない場合は欠落として扱わない(元の配置でもosv-scannerは親を読まない)", async () => {
    // relativePath省略時の既定値../pom.xmlが無い、ルートのpom.xmlによくある構成
    const base = await makeTree({ "root/mod/pom.xml": childPom("../pom.xml"), "root/solo/pom.xml": "<project/>" });
    const snapshot = await ScanSnapshot.create();
    try {
      const { targets, incomplete } = await snapshotManifests(snapshot, [
        { path: path.join(base, "root/mod/pom.xml"), format: "pom.xml" },
        { path: path.join(base, "root/solo/pom.xml"), format: "pom.xml" },
      ], { projectDir: path.join(base, "root"), allowedRootReal: path.join(base, "root") });
      expect(targets).toHaveLength(2);
      expect(incomplete).toEqual([]);
    } finally {
      await snapshot.cleanup();
    }
  });

  it("許可ルートなしで親の指定を解釈できない場合、子はスキャンするが欠落として返す", async () => {
    const base = await makeTree({ "root/pom.xml": "<project/>", "root/mod/pom.xml": `<project><parent>${gav}</parent><parent>${gav}</parent></project>` });
    const snapshot = await ScanSnapshot.create();
    try {
      const { targets, incomplete } = await snapshotManifests(snapshot, [{ path: path.join(base, "root/mod/pom.xml"), format: "pom.xml" }], {
        projectDir: path.join(base, "root/mod"),
        allowedRootReal: undefined,
      });
      expect(targets).toHaveLength(1);
      expect(incomplete[0]?.reason).toContain("解釈できない");
    } finally {
      await snapshot.cleanup();
    }
  });

  it("コピーの合計サイズが上限を超えたらscan_input_too_large", async () => {
    const base = await makeTree({ "root/a/package-lock.json": "x".repeat(60), "root/b/package-lock.json": "x".repeat(60) });
    const snapshot = await ScanSnapshot.create(100);
    try {
      const error = await snapshotManifests(snapshot, [
        { path: path.join(base, "root/a/package-lock.json"), format: "package-lock.json" },
        { path: path.join(base, "root/b/package-lock.json"), format: "package-lock.json" },
      ], { projectDir: path.join(base, "root"), allowedRootReal: undefined }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ScanToolError);
      expect((error as ScanToolError).kind).toBe("scan_input_too_large");
    } finally {
      await snapshot.cleanup();
    }
  });
});

describe("検査後の差し替え(回帰)", () => {
  /** 偽osv-scanner: 起動時に元のファイルを範囲外の内容に差し替え、渡されたファイルの内容を結果として返す */
  async function tamperingScanner(dir: string, original: string, tampered: string): Promise<string> {
    const bin = path.join(dir, "osv-tamper.cjs");
    await writeFile(
      bin,
      `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(original)}, ${JSON.stringify(tampered)});
const args = process.argv.slice(2);
const files = args.filter((a, i) => args[i - 1] === "--lockfile").map((a) => a.slice(a.indexOf(":") + 1));
const leaked = files.some((f) => fs.readFileSync(f, "utf8").includes("log4j-core"));
console.log(JSON.stringify({ results: [{ source: { path: files[0] }, packages: leaked
  ? [{ package: { name: "org.apache.logging.log4j:log4j-core", version: "2.14.1", ecosystem: "Maven" },
       groups: [{ ids: ["GHSA-jfh8-c2jp-5v3q"], aliases: [], max_severity: "10.0" }] }]
  : [] }] }));`,
    );
    await chmod(bin, 0o755);
    return bin;
  }

  it.each([
    { tool: "scan_java_project", file: "pom.xml" },
    { tool: "scan_project", file: "pom.xml" },
    { tool: "scan_project", file: "package-lock.json" },
  ])("$tool: 検査の後で元の$fileを差し替えても、スキャンされるのは検査済みのコピー", async ({ tool, file }) => {
    const base = await makeTree({ [`root/proj/${file}`]: file === "pom.xml" ? "<project/>" : "{}" });
    const original = path.join(base, "root/proj", file);
    const bin = await tamperingScanner(base, original, "<project><dependencies>log4j-core</dependencies></project>");
    const handler = tool === "scan_java_project" ? handleScanJavaProject : handleScanProject;
    const result = await handler(
      { project_path: path.join(base, "root/proj") },
      { binaryPath: bin, allowedRoot: path.join(base, "root"), noRemoteResolution: false },
    );
    const payload = JSON.parse(result.content[0]!.text) as { packages: { name: string }[] };
    expect(await readFile(original, "utf8")).toContain("log4j-core"); // 元のファイルは実際に差し替えられた
    expect(payload.packages.some((p) => p.name.includes("log4j"))).toBe(false); // しかし結果には影響しない
  });
});

describe("親POMの欠落の応答への反映(回帰)", () => {
  /** 偽osv-scanner: 渡されたファイルの数だけ空の結果を返す */
  async function emptyScanner(dir: string): Promise<string> {
    const bin = path.join(dir, "osv-empty.cjs");
    await writeFile(bin, `#!${process.execPath}\nconsole.log(JSON.stringify({ results: [] }));`);
    await chmod(bin, 0o755);
    return bin;
  }

  it("scan_project: 親POMを再現できなければcoverage.complete=falseにし、skipped_filesに理由を出す", async () => {
    const base = await makeTree({ "root/proj/pom.xml": childPom("../pipe") });
    execFileSync("mkfifo", [path.join(base, "root/pipe")]);
    const result = await handleScanProject(
      { project_path: path.join(base, "root/proj") },
      { binaryPath: await emptyScanner(base), allowedRoot: path.join(base, "root"), noRemoteResolution: false },
    );
    const payload = JSON.parse(result.content[0]!.text) as { coverage: { complete: boolean; manifests: unknown[]; skipped_files: { path: string; reason: string }[] } };
    expect(payload.coverage.complete).toBe(false);
    expect(payload.coverage.manifests).toHaveLength(1);
    expect(payload.coverage.skipped_files).toEqual([{ path: "pom.xml", reason: expect.stringContaining("親POMを含めずにスキャンしました") }]);
  });

  it.each(["scan_project", "scan_java_project"])("%s: 子に依存が無く「パッケージなし」になる場合も、エラーに親POMの欠落を含める", async (tool) => {
    const base = await makeTree({ "root/proj/pom.xml": childPom("../pipe") });
    execFileSync("mkfifo", [path.join(base, "root/pipe")]);
    // 偽osv-scanner: パッケージなし(exit 128)
    const bin = path.join(base, "osv-nopkg.cjs");
    await writeFile(bin, `#!${process.execPath}\nprocess.exit(128);`);
    await chmod(bin, 0o755);
    const handler = tool === "scan_project" ? handleScanProject : handleScanJavaProject;
    const result = await handler(
      { project_path: path.join(base, "root/proj") },
      { binaryPath: bin, allowedRoot: path.join(base, "root"), noRemoteResolution: false },
    );
    const payload = JSON.parse(result.content[0]!.text) as { error: { kind: string; message: string } };
    expect(payload.error.kind).toBe("no_packages_found");
    expect(payload.error.message).toContain("pom.xml: 親POM(relativePath: ../pipe)を読めないため");
  });

  it.each(["scan_project", "scan_java_project"])("%s: スキャナーのエラーの詳細に一時ディレクトリのパスを出さず、元のパスに戻す", async (tool) => {
    const base = await makeTree({ "root/proj/pom.xml": "<project/>" });
    // 偽osv-scanner: 渡されたパスをstderrに出して異常終了する
    const bin = path.join(base, "osv-fail.cjs");
    await writeFile(bin, `#!${process.execPath}
const args = process.argv.slice(2);
const files = args.filter((a, i) => args[i - 1] === "--lockfile").map((a) => a.slice(a.indexOf(":") + 1));
console.error("Scanned " + files.join(","));
process.exit(127);`);
    await chmod(bin, 0o755);
    const handler = tool === "scan_project" ? handleScanProject : handleScanJavaProject;
    const result = await handler(
      { project_path: path.join(base, "root/proj") },
      { binaryPath: bin, allowedRoot: path.join(base, "root"), noRemoteResolution: false },
    );
    const payload = JSON.parse(result.content[0]!.text) as { error: { kind: string; detail?: string } };
    expect(payload.error.detail).toContain(`Scanned ${path.join(base, "root/proj/pom.xml")}`);
    expect(payload.error.detail).not.toContain("osv-mcp-snap-");
  });

  it("scan_java_project: incomplete_manifestsとscope_warningを出す", async () => {
    const base = await makeTree({ "root/proj/pom.xml": childPom("../pipe") });
    execFileSync("mkfifo", [path.join(base, "root/pipe")]);
    const result = await handleScanJavaProject(
      { project_path: path.join(base, "root/proj") },
      { binaryPath: await emptyScanner(base), allowedRoot: path.join(base, "root"), noRemoteResolution: false },
    );
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload.manifests).toEqual(["pom.xml"]);
    expect("skipped_manifests" in payload).toBe(false);
    expect(payload.incomplete_manifests).toEqual([{ path: "pom.xml", reason: expect.stringContaining("親POMを含めずにスキャンしました") }]);
    expect(payload.scope_warning).toEqual(expect.stringContaining("incomplete_manifests"));
  });
});
