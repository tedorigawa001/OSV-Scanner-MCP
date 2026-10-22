import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ScanToolError } from "../../errors.js";
import { handleScanJavaProject } from "../../tools/scanJavaProject.js";
import { handleScanProject } from "../../tools/scanProject.js";
import { handleSuggestFix } from "../../tools/suggestFix.js";
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
  it.each([true, false])("copies ordinary parent POMs with allowedRoot configured: %s", async (restricted) => {
    const base = await makeTree({ "root/pom.xml": "<project/>", "root/mod/pom.xml": childPom("../pom.xml") });
    const snapshot = await ScanSnapshot.create();
    try {
      const { targets, skipped, incomplete } = await snapshotManifests(snapshot, [{ path: path.join(base, "root/mod/pom.xml"), format: "pom.xml" }], {
        projectDir: path.join(base, "root/mod"),
        allowedRootReal: restricted ? path.join(base, "root") : undefined,
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

  it.each(["<relativePath/>", "<relativePath></relativePath>", "<relativePath>  </relativePath>"])(
    "回帰: 空のrelativePath(%s)でも、osv-scannerと同じく既定の../pom.xmlの親をスナップショットへコピーする", async (relative) => {
    const base = await makeTree({ "root/pom.xml": "<project/>", "root/mod/pom.xml": `<project><parent>${gav}${relative}</parent><artifactId>c</artifactId></project>` });
    const snapshot = await ScanSnapshot.create();
    try {
      const { targets, skipped, incomplete } = await snapshotManifests(snapshot, [{ path: path.join(base, "root/mod/pom.xml"), format: "pom.xml" }], {
        projectDir: path.join(base, "root/mod"),
        allowedRootReal: path.join(base, "root"),
      });
      expect([skipped, incomplete]).toEqual([[], []]);
      // 以前は空を「親を参照しない」と解釈して親をコピーせず、osv-scannerが読む../pom.xmlがスナップショットに無かった
      expect(await readFile(path.join(path.dirname(targets[0]!.path), "../pom.xml"), "utf8")).toBe("<project/>");
    } finally {
      await snapshot.cleanup();
    }
  });

  it("回帰: 空のrelativePathの既定の親が許可ルートの外なら、そのpom.xmlを除外する", async () => {
    const base = await makeTree({ "pom.xml": "<project/>", "root/pom.xml": `<project><parent>${gav}<relativePath/></parent><artifactId>c</artifactId></project>` });
    const snapshot = await ScanSnapshot.create();
    try {
      const { targets, skipped } = await snapshotManifests(snapshot, [{ path: path.join(base, "root/pom.xml"), format: "pom.xml" }], {
        projectDir: path.join(base, "root"),
        allowedRootReal: path.join(base, "root"),
      });
      expect(targets).toEqual([]);
      expect(skipped[0]).toMatchObject({ kind: "outside_allowed_root", reason: expect.stringContaining("outside the allowed root") });
    } finally {
      await snapshot.cleanup();
    }
  });

  it.each([true, false])("rejects snapshot escapes with allowedRoot configured: %s", async (restricted) => {
    // 実際のファイルシステムでは..がルートで止まり許可ルート内を指すが、スナップショット内では外に出る
    const base = await makeTree({ "root/parent/pom.xml": "<project/>" });
    const escape = `${"../".repeat(64)}${path.join(base, "root/parent/pom.xml").slice(1)}`;
    await mkdir(path.join(base, "root/proj"), { recursive: true });
    await writeFile(path.join(base, "root/proj/pom.xml"), childPom(escape));
    const snapshot = await ScanSnapshot.create();
    try {
      const { targets, skipped } = await snapshotManifests(snapshot, [{ path: path.join(base, "root/proj/pom.xml"), format: "pom.xml" }], {
        projectDir: path.join(base, "root/proj"),
        allowedRootReal: restricted ? path.join(base, "root") : undefined,
      });
      expect(targets).toEqual([]);
      expect(skipped[0]?.reason).toContain("leads outside the scan scope");
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
        { path: path.join(base, "root/proj/pom.xml"), reason: expect.stringContaining("not a regular file") },
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
      expect(incomplete).toEqual([{ path: path.join(base, "root/mod/pom.xml"), reason: expect.stringContaining("the file exceeds the size limit") }]);
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

  it.each(["duplicate", "CDATA"])("rejects unverified parent references without allowedRoot (%s)", async (syntax) => {
    const base = await makeTree({ "root/pom.xml": "<project/>", "root/mod/pom.xml": `<project><parent>${gav}</parent><parent>${gav}</parent></project>` });
    if (syntax === "CDATA") await writeFile(path.join(base, "root/mod/pom.xml"), childPom("<![CDATA[../../../../outside/pom.xml]]>"));
    const snapshot = await ScanSnapshot.create();
    try {
      const { targets, skipped, incomplete } = await snapshotManifests(snapshot, [{ path: path.join(base, "root/mod/pom.xml"), format: "pom.xml" }], {
        projectDir: path.join(base, "root/mod"),
        allowedRootReal: undefined,
      });
      expect(targets).toEqual([]);
      expect(incomplete).toEqual([]);
      expect(skipped[0]?.reason).toContain("cannot be interpreted");
    } finally {
      await snapshot.cleanup();
    }
  });

  it.each([true, false])("rejects an unchecked ancestor beyond the depth limit (restricted: %s)", async (restricted) => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= 10; i++) files[`root/p${i}/pom.xml`] = childPom(i === 10 ? "../".repeat(64) + "outside/pom.xml" : `../p${i + 1}/pom.xml`);
    const base = await makeTree(files);
    const snapshot = await ScanSnapshot.create();
    try {
      const result = await snapshotManifests(snapshot, [{ path: path.join(base, "root/p0/pom.xml"), format: "pom.xml" }], {
        projectDir: path.join(base, "root"), allowedRootReal: restricted ? path.join(base, "root") : undefined,
      });
      expect(result.targets).toEqual([]);
      expect(result.incomplete).toEqual([]);
      expect(result.skipped[0]?.reason).toContain("limit");
    } finally {
      await snapshot.cleanup();
    }
  });

  it.each([true, false])("does not expose a rejected cached parent after its source disappears (restricted: %s)", async (restricted) => {
    const base = await makeTree({
      "root/bad/pom.xml": childPom("../".repeat(64) + "outside/pom.xml"),
      "root/child/pom.xml": childPom("../bad/pom.xml"),
    });
    const snapshot = await ScanSnapshot.create();
    const bad = path.join(base, "root/bad/pom.xml");
    const parentOf = snapshot.parentOf.bind(snapshot);
    const read = vi.spyOn(snapshot, "parentOf").mockImplementation(async (copy) => {
      const result = await parentOf(copy);
      if (copy === snapshot.mirror(bad)) await rm(bad, { force: true });
      return result;
    });
    try {
      const result = await snapshotManifests(snapshot, [bad, path.join(base, "root/child/pom.xml")].map((file) => ({ path: file, format: "pom.xml" })), {
        projectDir: path.join(base, "root"), allowedRootReal: restricted ? path.join(base, "root") : undefined,
      });
      expect(result.targets).toEqual([]);
      expect(result.skipped).toHaveLength(2);
    } finally {
      read.mockRestore();
      await snapshot.cleanup();
    }
  });

  it.each([true, false])("retains verified parent copies after their source disappears (restricted: %s)", async (restricted) => {
    const base = await makeTree({ "root/parent/pom.xml": "<project/>", "root/child/pom.xml": childPom("../parent/pom.xml") });
    const parent = path.join(base, "root/parent/pom.xml");
    const snapshot = await ScanSnapshot.create();
    const original = snapshot.parentOf.bind(snapshot);
    const read = vi.spyOn(snapshot, "parentOf").mockImplementation(async (copy) => {
      const result = await original(copy);
      if (copy === snapshot.mirror(parent)) await rm(parent, { force: true });
      return result;
    });
    try {
      const result = await snapshotManifests(snapshot, [parent, path.join(base, "root/child/pom.xml")].map((file) => ({ path: file, format: "pom.xml" })), {
        projectDir: path.join(base, "root"), allowedRootReal: restricted ? path.join(base, "root") : undefined,
      });
      expect(result.targets).toHaveLength(2);
      expect(result.skipped).toEqual([]);
      expect(result.incomplete).toEqual([]);
    } finally {
      read.mockRestore();
      await snapshot.cleanup();
    }
  });

  it.each([
    { restricted: true, directory: false }, { restricted: false, directory: false },
    { restricted: true, directory: true }, { restricted: false, directory: true },
  ])("checks parents populated by later targets (restricted: $restricted, directory: $directory)", async ({ restricted, directory }) => {
    const unsafe = childPom("../".repeat(64) + "outside/pom.xml");
    const base = await makeTree({
      "root/bad/pom.xml": unsafe,
      "root/child/pom.xml": childPom(directory ? "../bad" : "../bad/pom.xml"),
    });
    const bad = path.join(base, "root/bad/pom.xml");
    const child = path.join(base, "root/child/pom.xml");
    const snapshot = await ScanSnapshot.create();
    const originalCopy = snapshot.copy.bind(snapshot);
    let badReads = 0;
    const copy = vi.spyOn(snapshot, "copy").mockImplementation(async (file, boundary, maxBytes) => {
      if (file === bad && ++badReads >= (directory ? 2 : 1)) await writeFile(bad, unsafe);
      const result = await originalCopy(file, boundary, maxBytes);
      if (file === child) await rm(bad, { force: true });
      return result;
    });
    try {
      const result = await snapshotManifests(snapshot, [child, bad].map((file) => ({ path: file, format: "pom.xml" })), {
        projectDir: path.join(base, "root"), allowedRootReal: restricted ? path.join(base, "root") : undefined,
      });
      expect(result.targets).toEqual([]);
      expect(result.skipped).toHaveLength(2);
      expect(result.incomplete).toEqual([]);
    } finally {
      copy.mockRestore();
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
  it.each([
    { tool: "scan_project", handler: handleScanProject, cdata: false },
    { tool: "scan_java_project", handler: handleScanJavaProject, cdata: false },
    { tool: "suggest_fix", handler: handleSuggestFix, cdata: false },
    { tool: "scan_project", handler: handleScanProject, cdata: true },
    { tool: "scan_java_project", handler: handleScanJavaProject, cdata: true },
    { tool: "suggest_fix", handler: handleSuggestFix, cdata: true },
  ])("$tool excludes unsafe POMs before invoking the scanner (CDATA: $cdata)", async ({ tool, handler, cdata }) => {
    const escape = "../".repeat(64) + "outside/pom.xml";
    const base = await makeTree({
      "root/unsafe/pom.xml": childPom(cdata ? `<![CDATA[${escape}]]>` : escape),
      "root/safe/pom.xml": "<project/>",
    });
    const marker = path.join(base, "scanned.json");
    const bin = path.join(base, "scanner.cjs");
    await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const files = args.filter((a, i) => args[i - 1] === "--lockfile").map(a => a.slice(a.indexOf(":") + 1));
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(files.map(file => fs.readFileSync(file, "utf8"))));
console.log(JSON.stringify({results:[]}));`);
    await chmod(bin, 0o755);
    const options = { binaryPath: bin, noRemoteResolution: true };
    const result = await handler({ project_path: path.join(base, "root") }, options);
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    const skipped = tool === "scan_java_project" ? payload.skipped_manifests : payload.coverage.skipped_files;
    expect(skipped).toEqual([{ path: path.join("unsafe", "pom.xml"), reason: expect.stringContaining(cdata ? "cannot be interpreted" : "outside the scan scope") }]);
    if (tool !== "scan_java_project") expect(payload.coverage.complete).toBe(false);
    const scanned = await readFile(marker, "utf8");
    expect(JSON.parse(scanned)).toEqual(["<project/>"]);
    const rejected = await handler({ project_path: path.join(base, "root/unsafe") }, options);
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.content[0]!.text).error.kind).toBe(cdata ? "no_manifest_found" : "path_outside_allowed_root");
    expect(await readFile(marker, "utf8")).toBe(scanned);
  });

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
    expect(payload.coverage.skipped_files).toEqual([{ path: "pom.xml", reason: expect.stringContaining("scanned without") }]);
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
    expect(payload.error.message).toContain("pom.xml: The parent POM (relativePath: ../pipe) cannot be read");
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
    expect(payload.incomplete_manifests).toEqual([{ path: "pom.xml", reason: expect.stringContaining("scanned without") }]);
    expect(payload.scope_warning).toEqual(expect.stringContaining("incomplete_manifests"));
  });
});
