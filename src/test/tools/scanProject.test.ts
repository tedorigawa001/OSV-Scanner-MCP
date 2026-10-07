import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRelationLookups, handleScanProject } from "../../tools/scanProject.js";
import type { ToolResult } from "../../tools/toolResult.js";

let binDir: string;
const tempDirs: string[] = [];

beforeAll(async () => {
  binDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-sp-bin-"));
});

afterAll(async () => {
  await rm(binDir, { recursive: true, force: true });
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-sp-")));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

function pkg(ecosystem: string, name: string, version: string, extra: Record<string, unknown> = {}) {
  return {
    package: { name, version, ecosystem },
    groups: [{ ids: [`GHSA-${name}`], aliases: [], max_severity: "7.5" }],
    ...extra,
  };
}

/** 渡された引数とrequirements.txtのコピーの中身を記録し、指定のJSONを返す偽osv-scanner */
async function fakeScanner(output: unknown): Promise<{ bin: string; argsFile: string; copiesFile: string }> {
  const id = Math.random().toString(36).slice(2);
  const argsFile = path.join(binDir, `args-${id}.txt`);
  const copiesFile = path.join(binDir, `copies-${id}.txt`);
  const outFile = path.join(binDir, `out-${id}.json`);
  await writeFile(outFile, JSON.stringify(output));
  await writeFile(copiesFile, "");
  const bin = path.join(binDir, `osv-${id}`);
  await writeFile(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n` +
      `for a in "$@"; do case "$a" in requirements.txt:*) cat "\${a#requirements.txt:}" >> '${copiesFile}';; esac; done\n` +
      `cat '${outFile}'\nexit 1\n`,
  );
  await chmod(bin, 0o755);
  return { bin, argsFile, copiesFile };
}

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(() => true, () => false);
}

function payload(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

describe("handleScanProject", () => {
  it("検出した全ファイルを形式付きで個別に渡し、ディレクトリは渡さない", async () => {
    const dir = await makeProject({
      "pom.xml": "<project/>",
      "web/npm-shrinkwrap.json": "{}",
      "py/requirements.txt": "requests==2.19.0\n",
      "go/go.mod": "module x\n",
    });
    const { bin, argsFile, copiesFile } = await fakeScanner({ results: [] });
    const result = await handleScanProject({ project_path: dir }, { binaryPath: bin, noRemoteResolution: false });
    expect(result.isError).toBeUndefined();
    const args = (await readFile(argsFile, "utf8")).trim().split("\n");
    const lockfileArgs = args.filter((a, i) => args[i - 1] === "--lockfile");
    // lockfile・pom.xmlも元のファイルではなく、元の配置を再現したスナップショットのコピーを渡す
    const expected: [string, string][] = [
      ["go.mod", path.join(dir, "go/go.mod")],
      ["package-lock.json", path.join(dir, "web/npm-shrinkwrap.json")],
      ["pom.xml", path.join(dir, "pom.xml")],
    ];
    for (const [format, original] of expected) {
      const arg = lockfileArgs.find((a) => a.startsWith(`${format}:`) && a.endsWith(original));
      expect(arg).toBeDefined();
      const copy = arg!.slice(format.length + 1);
      expect(copy).not.toBe(original);
      expect(copy).toContain("osv-mcp-snap-");
      expect(await exists(copy)).toBe(false); // スキャン後に削除される
    }
    // requirements.txtは元ファイルではなく、プロジェクト外の専用コピーを渡し、スキャン後に削除する
    const copies = lockfileArgs.filter((a) => a.startsWith("requirements.txt:")).map((a) => a.slice("requirements.txt:".length));
    expect(copies).toHaveLength(1);
    expect(copies[0]!.startsWith(dir)).toBe(false);
    expect(await exists(copies[0]!)).toBe(false);
    expect(await readFile(copiesFile, "utf8")).toBe("requests==2.19.0\n");
    expect(args).not.toContain(dir);
    expect(args).not.toContain("-r");
  });

  it("回帰: 空白入りの取り込み(- r)でも範囲外の内容をスキャナーに渡さず、completeにしない", async () => {
    const parent = await makeProject({
      "outside.txt": "Jinja2==2.0\n",
      "proj/requirements.txt": "- r ../outside.txt\nrequests==2.19.0\n",
    });
    const { bin, copiesFile } = await fakeScanner({ results: [] });
    const p = payload(await handleScanProject({ project_path: path.join(parent, "proj") }, { binaryPath: bin, noRemoteResolution: false }));
    expect(await readFile(copiesFile, "utf8")).toBe("requests==2.19.0\n");
    expect(p.coverage.complete).toBe(false);
    expect(p.coverage.unscannable_requirements).toEqual([
      expect.objectContaining({ text: "- r ../outside.txt", reason: expect.stringContaining("外") }),
    ]);
  });

  it("回帰: --requirementの取り込み先はここで展開してスキャナーに渡す", async () => {
    const dir = await makeProject({ "requirements.txt": "--requirement child.txt\n", "child.txt": "requests==2.19.0\n" });
    const { bin, copiesFile } = await fakeScanner({ results: [] });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin, noRemoteResolution: false }));
    expect(await readFile(copiesFile, "utf8")).toBe("requests==2.19.0\n");
    expect(p.coverage.complete).toBe(true);
  });

  it("スキャンできる行が1つも無ければスキャナーを起動せず、欠けとして報告する", async () => {
    const dir = await makeProject({ "requirements.txt": "flask\n" });
    const { bin, argsFile } = await fakeScanner({ results: [] });
    const result = await handleScanProject({ project_path: dir }, { binaryPath: bin, noRemoteResolution: false });
    expect(result.isError).toBeUndefined();
    expect(await exists(argsFile)).toBe(false);
    const p = payload(result);
    expect(p.vulnerability_count).toBe(0);
    expect(p.coverage.complete).toBe(false);
  });

  it("範囲情報を件数より前に置き、欠けが無ければcomplete=true", async () => {
    const dir = await makeProject({ "package-lock.json": "{}", "go.mod": "module x\n" });
    const { bin } = await fakeScanner({
      results: [{ source: { path: path.join(dir, "package-lock.json") }, packages: [pkg("npm", "lodash", "4.17.20")] }],
    });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin, noRemoteResolution: false }));
    const keys = Object.keys(p);
    expect(keys.slice(0, 4)).toEqual(["project_dir", "dependency_resolution", "coverage", "ecosystem_breakdown"]);
    expect(keys.indexOf("coverage")).toBeLessThan(keys.indexOf("vulnerability_count"));
    expect(p.coverage.complete).toBe(true);
    expect(p.coverage.warning).toBeUndefined();
    // 脆弱性0件のエコシステムも「スキャンした」ことが分かるように含める
    expect(p.ecosystem_breakdown).toEqual({
      npm: { manifests: 1, vulnerable_package_count: 1, vulnerability_count: 1 },
      Go: { manifests: 1, vulnerable_package_count: 0, vulnerability_count: 0 },
    });
  });

  it("欠けがあればcomplete=falseと警告を返し、各一覧に記録する", async () => {
    const dir = await makeProject({
      // ルートにlockfileがあるとworkspacesとみなして配下のpackage.jsonを欠落扱いにしないため、別ディレクトリに置く
      "web/package-lock.json": "{}",
      "svc/package.json": "{}",
      "py/requirements.txt": "Jinja2>=2.0\nflask\n-e git+https://example.invalid/x.git#egg=x\n",
      "evil/requirements.txt": "-r ../../outside.txt\n",
    });
    const { bin } = await fakeScanner({ results: [] });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin, noRemoteResolution: false }));
    expect(p.coverage.complete).toBe(false);
    expect(p.coverage.warning).toContain("検出0件でも");
    expect(p.coverage.lockfile_missing.map((m: any) => m.path)).toEqual(["svc/package.json"]);
    expect(p.coverage.unpinned_requirements.map((i: any) => `${i.file}:${i.line}:${i.name}:${i.kind}`)).toEqual([
      "py/requirements.txt:1:Jinja2:lower_bound",
      "py/requirements.txt:2:flask:unpinned",
    ]);
    expect(p.coverage.lockfile_missing[0].status).toBe("missing");
    expect(p.coverage.unscannable_requirements.map((r: any) => r.file).sort()).toEqual([
      "evil/requirements.txt",
      "py/requirements.txt",
    ]);
    expect(p.coverage.skipped_files).toEqual([]);
  });

  it("下限を使用中の版とみなされたPyPIパッケージに印を付け、依存グループはそのまま返す", async () => {
    const dir = await makeProject({
      "requirements.txt": "Jinja2>=2.0\nrequests==2.19.0\n",
      "package-lock.json": "{}",
    });
    const { bin } = await fakeScanner({
      results: [
        { source: { path: "r" }, packages: [pkg("PyPI", "jinja2", "2.0"), pkg("PyPI", "requests", "2.19.0")] },
        { source: { path: "p" }, packages: [pkg("npm", "minimist", "1.2.5", { dependency_groups: ["dev"] })] },
      ],
    });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin, noRemoteResolution: false }));
    const byName = Object.fromEntries(p.packages.map((x: any) => [x.name, x]));
    expect(byName.jinja2.version_is_lower_bound).toBe(true);
    expect(byName.requests.version_is_lower_bound).toBeUndefined();
    expect(byName.minimist.dependency_groups).toEqual(["dev"]);
    expect(byName.requests.dependency_groups).toBeUndefined();
  });

  it("推移的依存の解決を無効にすると、requirements.txtも含む警告を返し--no-resolveを渡す", async () => {
    const dir = await makeProject({ "requirements.txt": "requests==2.19.0\n" });
    const { bin, argsFile } = await fakeScanner({ results: [] });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin, noRemoteResolution: true }));
    expect(p.dependency_resolution.transitive_resolution).toBe("disabled");
    expect(p.dependency_resolution.warning).toContain("requirements.txt");
    expect((await readFile(argsFile, "utf8")).split("\n")).toContain("--no-resolve");
  });

  it("スキャン対象由来の文字列は無害化する", async () => {
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    const dir = await makeProject({ "requirements.txt": `flask>=1.0,<${esc}[31m2${rlo}\n` });
    const { bin } = await fakeScanner({ results: [] });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin, noRemoteResolution: false }));
    const text = JSON.stringify(p.coverage);
    expect(text).not.toContain(esc);
    expect(text).not.toContain(rlo);
  });

  it("一覧は上限で切り詰め、省略した件数を返す", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `pkg${i}`).join("\n");
    const dir = await makeProject({ "requirements.txt": `${lines}\n` });
    const { bin } = await fakeScanner({ results: [] });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin, noRemoteResolution: false }));
    expect(p.coverage.unpinned_requirements).toHaveLength(200);
    expect(p.coverage.omitted_items).toBe(50);
  });

  it("スキャンできるファイルが無ければエラーを返す", async () => {
    const dir = await makeProject({ "package.json": "{}" });
    const { bin } = await fakeScanner({ results: [] });
    const result = await handleScanProject({ project_path: dir }, { binaryPath: bin });
    expect(result.isError).toBe(true);
    expect(payload(result).error.kind).toBe("no_manifest_found");
  });
});

describe("handleScanProject: 親POMが許可ルートの外を参照するpom.xml", () => {
  it("coverage.skipped_filesに理由付きで記録し、そのpom.xmlはスキャナーに渡さない", async () => {
    const base = await makeProject({
      "outside/pom.xml": "<project/>",
      "root/proj/package-lock.json": "{}",
      "root/proj/pom.xml":
        "<project><parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version>" +
        "<relativePath>../../outside/pom.xml</relativePath></parent></project>",
    });
    const { bin, argsFile } = await fakeScanner({ results: [] });
    const p = payload(await handleScanProject(
      { project_path: path.join(base, "root/proj") },
      { binaryPath: bin, allowedRoot: path.join(base, "root"), noRemoteResolution: false },
    ));
    expect(p.coverage.complete).toBe(false);
    expect(p.coverage.manifests.map((m: any) => m.path)).toEqual(["package-lock.json"]);
    expect(p.coverage.skipped_files).toEqual([{ path: "pom.xml", reason: expect.stringContaining("許可ルート") }]);
    expect((await readFile(argsFile, "utf8")).includes("pom.xml:")).toBe(false);
  });
});

describe("handleScanProject: 直接/推移的依存の区別(v0.7.0)", () => {
  /** 渡されたlockfile(コピー)ごとに、形式に応じたパッケージをsource.path付きで返す偽osv-scanner */
  async function perSourceScanner(byFormat: Record<string, unknown[]>): Promise<string> {
    const bin = path.join(binDir, `osv-per-source-${Math.random().toString(36).slice(2)}.cjs`);
    await writeFile(bin, `#!${process.execPath}
const args = process.argv.slice(2);
const byFormat = ${JSON.stringify(byFormat)};
const results = args.filter((a, i) => args[i - 1] === "--lockfile").map((a) => {
  const format = a.slice(0, a.indexOf(":"));
  const file = a.slice(a.indexOf(":") + 1);
  const dir = require("node:path").basename(require("node:path").dirname(file));
  return { source: { path: file }, packages: byFormat[format + ":" + dir] ?? byFormat[format] ?? [] };
});
console.log(JSON.stringify({ results }));
process.exit(1);`);
    await chmod(bin, 0o755);
    return bin;
  }

  it("lockfileごとに判定し、introduced_by・declared_in・replaced_in_go_modを脆弱性より前に付ける", async () => {
    const lock = (deps: Record<string, string>, extra: Record<string, unknown>) =>
      JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: deps }, ...extra } });
    const dir = await makeProject({
      "web/package-lock.json": lock({ express: "4.17.1" }, {
        "node_modules/express": { version: "4.17.1", dependencies: { qs: "6.7.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
      "web/package.json": "{}",
      "admin/package-lock.json": lock({ qs: "6.7.0" }, { "node_modules/qs": { version: "6.7.0" } }),
      "admin/package.json": "{}",
      "svc/go.mod": "module x\n\nrequire golang.org/x/net v0.1.0 // indirect\nreplace golang.org/x/net => golang.org/x/net v0.2.0\n",
      "py/requirements.txt": "requests==2.19.0\n",
      "pom.xml": "<project/>",
    });
    const bin = await perSourceScanner({
      "package-lock.json:web": [pkg("npm", "express", "4.17.1"), pkg("npm", "qs", "6.7.0")],
      "package-lock.json:admin": [pkg("npm", "qs", "6.7.0")],
      "go.mod": [pkg("Go", "golang.org/x/net", "0.2.0")],
      "requirements.txt": [pkg("PyPI", "requests", "2.19.0"), pkg("PyPI", "urllib3", "1.23.0")],
      "pom.xml": [pkg("Maven", "g:a", "1.0")],
    });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin }));
    const byName = Object.fromEntries((p.packages as Record<string, unknown>[]).map((x) => [`${x.name}@${x.version}`, x]));
    const pick = (x: Record<string, unknown>) => ({
      relation: x.dependency_relation, by: x.introduced_by, in: x.declared_in, rep: x.replaced_in_go_mod,
    });
    expect(pick(byName["express@4.17.1"]!)).toEqual({ relation: "direct", by: undefined, in: ["web/package.json"], rep: undefined });
    // webでは推移的、adminでは直接依存 → mixed。経由と宣言は合わせる
    expect(pick(byName["qs@6.7.0"]!)).toEqual({ relation: "mixed", by: ["express"], in: ["admin/package.json"], rep: undefined });
    expect(pick(byName["golang.org/x/net@0.2.0"]!)).toEqual({ relation: "transitive", by: undefined, in: undefined, rep: true });
    expect(pick(byName["requests@2.19.0"]!).relation).toBe("direct");
    expect(pick(byName["urllib3@1.23.0"]!).relation).toBe("transitive");
    expect(pick(byName["g:a@1.0"]!).relation).toBe("unknown");
    const keys = Object.keys(byName["qs@6.7.0"]!);
    expect(keys.indexOf("dependency_relation")).toBeLessThan(keys.indexOf("vulnerabilities"));
  });
});

describe("buildRelationLookups: 読み込みの上限", () => {
  it("回帰: 予算を超えるlockfileは全体を読まずにunknownにし、予算内のファイルは判定する", async () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { a: "1" } }, "node_modules/a": { version: "1.0.0" } } });
    const dir = await makeProject({ "small/package-lock.json": lock, "big/package-lock.json": lock + " ".repeat(10_000), "go.mod": "module x\nrequire example.com/a v1.0.0\n" });
    const copies = ["small/package-lock.json", "big/package-lock.json", "go.mod"].map((rel) => ({
      copy: path.join(dir, rel), format: rel.endsWith("go.mod") ? "go.mod" : "package-lock.json", originalRelative: rel,
    }));
    const lookups = await buildRelationLookups(copies, lock.length + 100);
    expect(lookups.get(path.join(dir, "small/package-lock.json"))!.lookup!("a", "1.0.0").relation).toBe("direct");
    expect(lookups.get(path.join(dir, "big/package-lock.json"))!.lookup).toBeNull();
    // 予算の残り(100バイト未満)に収まるgo.modは判定する
    expect(lookups.get(path.join(dir, "go.mod"))!.lookup!("example.com/a", "1.0.0").relation).toBe("direct");
  });
});

describe("handleScanProject: pom.xmlの直接/推移的依存の区別", () => {
  /** osv-scanner 2.4.0と同じく、pom.xmlを宣言(lockfile)と推移的依存(unknown)の2つの結果に分けて返す偽osv-scanner */
  async function pomScanner(declared: unknown[], transitive: unknown[], other: Record<string, unknown[]> = {}): Promise<string> {
    const bin = path.join(binDir, `osv-pom-${Math.random().toString(36).slice(2)}.cjs`);
    await writeFile(bin, `#!${process.execPath}
const args = process.argv.slice(2);
const results = args.filter((a, i) => args[i - 1] === "--lockfile").flatMap((a) => {
  const format = a.slice(0, a.indexOf(":"));
  const file = a.slice(a.indexOf(":") + 1);
  if (format !== "pom.xml") return [{ source: { path: file, type: "lockfile" }, packages: (${JSON.stringify(other)})[format] ?? [] }];
  return [
    { source: { path: file, type: "lockfile" }, packages: ${JSON.stringify(declared)} },
    { source: { path: file, type: "unknown" }, packages: ${JSON.stringify(transitive)} },
  ];
});
console.log(JSON.stringify({ results }));
process.exit(1);`);
    await chmod(bin, 0o755);
    return bin;
  }

  it("source.typeがlockfileの結果は直接依存、unknownの結果は推移的依存。脆弱性より前に付ける", async () => {
    const dir = await makeProject({ "pom.xml": "<project/>" });
    const bin = await pomScanner(
      [pkg("Maven", "com.fasterxml.jackson.core:jackson-databind", "2.9.8"), pkg("Maven", "org.apache.logging.log4j:log4j-core", "2.14.1")],
      [pkg("Maven", "org.apache.logging.log4j:log4j-api", "2.14.1")],
    );
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin }));
    const byName = Object.fromEntries((p.packages as Record<string, unknown>[]).map((x) => [String(x.name).split(":")[1], x]));
    expect(byName["jackson-databind"]!.dependency_relation).toBe("direct");
    expect(byName["log4j-core"]!.dependency_relation).toBe("direct");
    expect(byName["log4j-api"]!.dependency_relation).toBe("transitive");
    expect("introduced_by" in byName["log4j-api"]!).toBe(false);
    expect("declared_in" in byName["jackson-databind"]!).toBe(false);
    const keys = Object.keys(byName["log4j-api"]!);
    expect(keys.indexOf("dependency_relation")).toBeLessThan(keys.indexOf("vulnerabilities"));
  });

  it("同じpom.xmlの両方の結果に現れたら直接依存。gradle.lockfileと両方にあればmixed", async () => {
    const dir = await makeProject({ "pom.xml": "<project/>", "sub/gradle.lockfile": "g:b:1.0=runtimeClasspath\n" });
    const both = pkg("Maven", "g:a", "1.0");
    const bin = await pomScanner([both, pkg("Maven", "g:b", "1.0")], [both], { "gradle.lockfile": [pkg("Maven", "g:b", "1.0")] });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin }));
    const byName = Object.fromEntries((p.packages as Record<string, unknown>[]).map((x) => [x.name, x.dependency_relation]));
    expect(byName).toEqual({ "g:a": "direct", "g:b": "mixed" });
  });
});
