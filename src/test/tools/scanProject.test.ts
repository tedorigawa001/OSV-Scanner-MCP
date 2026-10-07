import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleScanProject } from "../../tools/scanProject.js";
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
    expect(lockfileArgs.filter((a) => !a.startsWith("requirements.txt:")).sort()).toEqual([
      `go.mod:${path.join(dir, "go/go.mod")}`,
      `package-lock.json:${path.join(dir, "web/npm-shrinkwrap.json")}`,
      `pom.xml:${path.join(dir, "pom.xml")}`,
    ]);
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
