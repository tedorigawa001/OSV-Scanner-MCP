import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleScanProject } from "../../tools/scanProject.js";
import { handleSuggestFix } from "../../tools/suggestFix.js";
import type { ToolResult } from "../../tools/toolResult.js";

let binDir: string;
const tempDirs: string[] = [];

beforeAll(async () => {
  binDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-nuget-bin-"));
});

afterAll(async () => {
  await rm(binDir, { recursive: true, force: true });
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-nuget-sp-")));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

/** 渡された引数とpackages.lock.json形式のコピーの中身(1行に1件)を記録し、指定のJSONを返す偽osv-scanner */
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
      `for a in "$@"; do case "$a" in packages.lock.json:*) cat "\${a#packages.lock.json:}" >> '${copiesFile}';; esac; done\n` +
      `cat '${outFile}'\nexit 1\n`,
  );
  await chmod(bin, 0o755);
  return { bin, argsFile, copiesFile };
}

function payload(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

const nugetResult = (copy: string, name: string, version: string) => ({
  source: { path: copy, type: "lockfile" },
  packages: [{ package: { name, version, ecosystem: "NuGet" }, groups: [{ ids: [`GHSA-${name}`], aliases: [], max_severity: "7.5" }] }],
});

/** コピーに書かれた(名前@版)の一覧 */
async function copiedPackages(copiesFile: string): Promise<string[]> {
  const lines = (await readFile(copiesFile, "utf8")).trim().split("\n").filter((l) => l !== "");
  return lines.flatMap((line) => {
    const deps = (JSON.parse(line) as { dependencies: Record<string, Record<string, { resolved: string }>> }).dependencies;
    return Object.values(deps).flatMap((group) => Object.entries(group).map(([name, e]) => `${name}@${e.resolved}`));
  }).sort();
}

const FILES = {
  "App/App.csproj": '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="12.0.1" /></ItemGroup></Project>',
  "App/packages.lock.json": JSON.stringify({ version: 1, dependencies: { "net8.0": {
    "Newtonsoft.Json": { type: "Direct", resolved: "12.0.1" }, "Sub": { type: "Transitive", resolved: "4.5.0" }, "MyCorp.Shared": { type: "Project" },
  } } }),
  "Direct/Direct.csproj": '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>' +
    '<PackageReference Include="Serilog" Version="2.10.0" /><PackageReference Include="Moq" Version="4.*" />' +
    '<PackageReference Include="Debug.Only" Version="1.0.0" Condition="false" /></ItemGroup></Project>',
  "deploy/app.deps.json": JSON.stringify({ libraries: { "app/1.0.0": { type: "project" }, "Newtonsoft.Json/9.0.1": { type: "project" }, "System.Net.Http/4.3.0": { type: "package" } } }),
};

describe("scan_project: .NET", () => {
  it("元のファイルは渡さず、照会してよいパッケージだけを書いたコピーを渡す", async () => {
    const dir = await makeProject(FILES);
    const { bin, argsFile, copiesFile } = await fakeScanner({ results: [] });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin }));
    expect(p.error).toBeUndefined();
    const lockArgs = (await readFile(argsFile, "utf8")).trim().split("\n").filter((a) => a.includes(":/"));
    expect(lockArgs.length).toBe(3);
    // 元のファイル(プロジェクトのディレクトリの中)は1つも渡さない
    for (const arg of lockArgs) {
      expect(arg.startsWith("packages.lock.json:")).toBe(true);
      expect(arg.slice("packages.lock.json:".length).startsWith(dir)).toBe(false);
    }
    // deps.jsonの自分のプロジェクト(公開パッケージと同名でも)、フローティング・条件つきの参照は照会しない
    expect(await copiedPackages(copiesFile)).toEqual(["Newtonsoft.Json@12.0.1", "Serilog@2.10.0", "Sub@4.5.0", "System.Net.Http@4.3.0"]);
  });

  it("coverageに.NETの項目を示す(対応付けの欠け・照会しなかった参照・自分のプロジェクトの数)", async () => {
    const dir = await makeProject(FILES);
    const { bin } = await fakeScanner({ results: [] });
    const { coverage } = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin }));
    expect(coverage).toMatchObject({
      complete: false,
      manifests: expect.arrayContaining([
        { path: path.join("App", "packages.lock.json"), ecosystem: "NuGet", format: "packages.lock.json" },
        { path: path.join("Direct", "Direct.csproj"), ecosystem: "NuGet", format: "PackageReference" },
        { path: path.join("deploy", "app.deps.json"), ecosystem: "NuGet", format: "deps.json" },
      ]),
      lockfile_missing: [{ path: path.join("Direct", "Direct.csproj"), ecosystem: "NuGet", status: "direct_only", hint: expect.stringContaining("RestorePackagesWithLockFile") }],
      local_projects: 3,
      unscannable_nuget_packages: [],
      unresolved_package_references: [
        { file: path.join("Direct", "Direct.csproj"), name: "Moq", specifier: "4.*", reason: "floating" },
        { file: path.join("Direct", "Direct.csproj"), name: "Debug.Only", specifier: "1.0.0", reason: "conditional" },
      ],
      nuget_warnings: expect.arrayContaining([expect.stringContaining("lower bound")]),
    });
    expect(coverage.warning).toContain("unresolved_package_references");
  });

  it("下限の指定から照会したパッケージにversion_is_lower_boundを付け、確定版でも照会したものには付けない", async () => {
    // Newtonsoft.Json 12.0.1はDirect.csprojでは下限、App/packages.lock.jsonでは確定版。Serilog 2.10.0は下限だけ
    const dir = await makeProject({
      ...FILES,
      "Direct/Direct.csproj": '<Project><ItemGroup><PackageReference Include="Serilog" Version="2.10.0" />' +
        '<PackageReference Include="Newtonsoft.Json" Version="12.0.1" /></ItemGroup></Project>',
    });
    const { bin } = await fakeScanner({ results: [nugetResult("/x/1.txt", "Newtonsoft.Json", "12.0.1"), nugetResult("/x/2.txt", "Serilog", "2.10.0")] });
    const p = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin }));
    const byName = Object.fromEntries(p.packages.map((pkg: { name: string }) => [pkg.name, pkg]));
    expect(byName["Serilog"].version_is_lower_bound).toBe(true);
    expect(byName["Newtonsoft.Json"].version_is_lower_bound).toBeUndefined();
    expect(p.ecosystem_breakdown.NuGet).toMatchObject({ vulnerable_package_count: 2 });
  });

  it("suggest_fixは.NETを未対応のエコシステムとして示す(v0.17.0まで)", async () => {
    const dir = await makeProject({ "App/App.csproj": "<Project />", "App/packages.lock.json": FILES["App/packages.lock.json"] });
    const { bin } = await fakeScanner({ results: [nugetResult("/x/packages.lock.json", "Newtonsoft.Json", "12.0.1")] });
    const p = payload(await handleSuggestFix({ project_path: dir }, { binaryPath: bin }));
    expect(p.suggestions).toEqual([expect.objectContaining({ package: "Newtonsoft.Json", ecosystem: "NuGet", verification: "unsupported_ecosystem" })]);
  });

  it(".NETのファイルが無いプロジェクトの応答に.NETの項目を付けない", async () => {
    const dir = await makeProject({ "go.mod": "module x\n" });
    const { bin } = await fakeScanner({ results: [] });
    const { coverage } = payload(await handleScanProject({ project_path: dir }, { binaryPath: bin }));
    expect(Object.keys(coverage)).not.toContain("local_projects");
    expect(Object.keys(coverage)).not.toContain("unresolved_package_references");
  });
});
