import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectProject } from "../../utils/manifestDetector.js";
import {
  analyzeProjectFile,
  classifyVersionSpec,
  hasNonNugetOrgSource,
  isNugetVersion,
  nugetLockCopyContent,
  nugetRelations,
  parseDepsJson,
  parsePackagesConfig,
  parsePackagesLock,
  parseProjectAssets,
  parseXml,
} from "../../utils/nugetFiles.js";
import { NUGET_LOWER_BOUND_WARNING, NUGET_PRIVATE_FEED_WARNING } from "../../utils/nugetProject.js";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-nuget-")));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

const csproj = (items: string, extra = "") => `<Project Sdk="Microsoft.NET.Sdk">${extra}<ItemGroup>${items}</ItemGroup></Project>`;
const ref = (name: string, version?: string, attrs = "") => `<PackageReference Include="${name}"${version !== undefined ? ` Version="${version}"` : ""}${attrs} />`;
const lock = (entries: Record<string, { type: string; resolved?: string }>) => JSON.stringify({ version: 1, dependencies: { "net8.0": entries } });
const names = (packages: { name: string; version: string }[]) => packages.map((p) => `${p.name}@${p.version}`);

describe("NuGetの版", () => {
  it.each(["1", "1.0", "12.0.1", "4.3.0.0", "1.0.0-beta.1", "1.0.0-Alpha", "1.0.7+r3456"])("確定版: %s", (v) => {
    expect(isNugetVersion(v)).toBe(true);
  });
  it.each(["", "$(NJ)", "[12.0.1,13.0.0)", "garbage", "1.*", "1.0.0.0.0", "v1.0"])("確定版でない: %s", (v) => {
    expect(isNugetVersion(v)).toBe(false);
  });

  it.each([
    ["[12.0.1]", { kind: "exact", version: "12.0.1" }],
    ["12.0.1", { kind: "lower_bound", version: "12.0.1" }],
    ["[12.0.1,)", { kind: "lower_bound", version: "12.0.1" }],
    ["[1.0, 2.0)", { kind: "lower_bound", version: "1.0" }],
    ["[1.0,2.0]", { kind: "lower_bound", version: "1.0" }],
    ["(1.0,)", { kind: "unresolved", reason: "range" }],
    ["(,1.0]", { kind: "unresolved", reason: "range" }],
    ["(1.0,2.0)", { kind: "unresolved", reason: "range" }],
    ["[1.0,garbage)", { kind: "unresolved", reason: "range" }],
    ["$(NJ)", { kind: "unresolved", reason: "property" }],
    ["4.*", { kind: "unresolved", reason: "floating" }],
    ["", { kind: "unresolved", reason: "central_package_management" }],
    [undefined, { kind: "unresolved", reason: "central_package_management" }],
  ])("PackageReferenceの版の指定 %s(x=x以上、[x]=完全一致)", (spec, expected) => {
    expect(classifyVersionSpec(spec)).toEqual(expected);
  });
});

describe("packages.lock.json", () => {
  it("Direct・Transitive・CentralTransitiveを照会し、Projectは数だけ数える。未知のtype・確定版でない版は照会しない", () => {
    const parsed = parsePackagesLock(lock({
      "Newtonsoft.Json": { type: "Direct", resolved: "12.0.1" },
      "System.Text.Encodings.Web": { type: "Transitive", resolved: "4.5.0" },
      "Central.Pinned": { type: "CentralTransitive", resolved: "1.0.0" },
      "MyCorp.Shared": { type: "Project" },
      "Newtonsoft.Json.Bson": { type: "Weird", resolved: "1.0.0" },
      "Broken": { type: "Direct", resolved: "$(X)" },
    }));
    expect(parsed.ok && parsed.packages).toEqual([
      { name: "Newtonsoft.Json", version: "12.0.1", relation: "direct" },
      { name: "System.Text.Encodings.Web", version: "4.5.0", relation: "transitive" },
      { name: "Central.Pinned", version: "1.0.0", relation: "transitive" },
    ]);
    expect(parsed.ok && parsed.localProjects).toBe(1);
    expect(parsed.ok && parsed.unscannable.map((u) => [u.name, u.reason])).toEqual([["Newtonsoft.Json.Bson", "unknown_type"], ["Broken", "unresolved_version"]]);
  });

  it("複数のターゲットフレームワークの版をそれぞれ照会し、同じ名前・版は1件にまとめる", () => {
    const parsed = parsePackagesLock(JSON.stringify({ version: 1, dependencies: {
      net48: { A: { type: "Transitive", resolved: "1.0.0" }, B: { type: "Direct", resolved: "2.0.0" } },
      "net8.0": { A: { type: "Direct", resolved: "1.0.0" }, b: { type: "Direct", resolved: "3.0.0" } },
    } }));
    expect(parsed.ok && parsed.packages).toEqual([
      { name: "A", version: "1.0.0", relation: "direct" },
      { name: "B", version: "2.0.0", relation: "direct" },
      { name: "b", version: "3.0.0", relation: "direct" },
    ]);
  });

  it("JSONでない・構造の上限を超えるものは解析しない(理由を返す)", () => {
    expect(parsePackagesLock("{")).toEqual({ ok: false, reason: "packages.lock.json is not valid JSON" });
    expect(parsePackagesLock(`{"dependencies":${"[".repeat(200)}${"]".repeat(200)}}`)).toMatchObject({ ok: false, reason: expect.stringContaining("parsing limits") });
  });
});

describe("project.assets.json / deps.json / packages.config", () => {
  it("project.assets.json: type packageを照会し、project.frameworksの依存を直接依存にする。projectPathも返す", () => {
    const parsed = parseProjectAssets(JSON.stringify({
      libraries: { "Newtonsoft.Json/12.0.1": { type: "package" }, "Sub/4.5.0": { type: "package" }, "Lib/1.0.0": { type: "project" } },
      project: { restore: { projectName: "App", projectPath: "C:\\src\\App\\App.csproj" }, frameworks: { "net8.0": { dependencies: { "newtonsoft.json": {} } } } },
    }));
    expect(parsed).toMatchObject({ ok: true, localProjects: 1, projectFileName: "App.csproj", projectName: "App" });
    expect(parsed.ok && parsed.packages).toEqual([
      { name: "Newtonsoft.Json", version: "12.0.1", relation: "direct" },
      { name: "Sub", version: "4.5.0", relation: "transitive" },
    ]);
  });

  it("deps.json: package・runtimepackを照会し、公開パッケージと同名でもproject・referenceは照会しない。runtimepack.の接頭辞は除く", () => {
    const parsed = parseDepsJson(JSON.stringify({
      targets: { t: { "app/1.0.0": { dependencies: { "System.Net.Http": "4.3.0" } } } },
      libraries: {
        "app/1.0.0": { type: "project" },
        "Newtonsoft.Json/12.0.1": { type: "project" },
        "System.Runtime.Ref/1.0.0": { type: "reference" },
        "System.Net.Http/4.3.0": { type: "package" },
        // SDKの実際の書き方(レビュー指摘): ライブラリ名に`runtimepack.`が付く。付けたままではOSVで一致しない
        "runtimepack.Microsoft.NETCore.App.Runtime.linux-x64/8.0.0": { type: "runtimepack" },
      },
    }));
    expect(parsed.ok && parsed.packages).toEqual([
      { name: "System.Net.Http", version: "4.3.0", relation: "direct" },
      { name: "Microsoft.NETCore.App.Runtime.linux-x64", version: "8.0.0", relation: "transitive" },
    ]);
    expect(parsed.ok && parsed.localProjects).toBe(3);
  });

  it("packages.config: 確定版の依存を照会する(直接/推移的は区別できない)", () => {
    const parsed = parsePackagesConfig('<?xml version="1.0"?><packages><package id="Newtonsoft.Json" version="12.0.1" /><package id="X" version="$(V)" /></packages>');
    expect(parsed.ok && parsed.packages).toEqual([{ name: "Newtonsoft.Json", version: "12.0.1", relation: "unknown" }]);
    expect(parsed.ok && parsed.unscannable.map((u) => u.reason)).toEqual(["unresolved_version"]);
  });
});

describe("XMLの走査", () => {
  it.each([
    ['<!DOCTYPE p [<!ENTITY a "aaaa">]><packages>&a;</packages>', "DOCTYPE"],
    ["<packages><![CDATA[x]]></packages>", "DOCTYPE"],
    ["<packages>&custom;</packages>", "entity"],
    ["<packages><package></packages>", "mismatched"],
    ["<packages>", "unclosed"],
    ['<packages a="1" a="2" />', "duplicate attribute"],
    ["<a/><b/>", "more than one root"],
  ])("解釈できない構文は解析しない: %s", (xml, reason) => {
    const parsed = parseXml(xml);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain(reason);
  });

  it("文字参照・名前空間の接頭辞・BOM・コメントを扱う", () => {
    const parsed = parseXml('\uFEFF<?xml version="1.0"?><!-- c --><m:Project xmlns:m="x"><m:Item Include="A&amp;B" /></m:Project>');
    expect(parsed.ok && parsed.root.lowerName).toBe("project");
    expect(parsed.ok && parsed.root.children[0]!.attributes.get("include")).toBe("A&B");
  });
});

describe(".csproj(直接依存だけの場合)", () => {
  const analyze = (xml: string, external?: Set<string>) => {
    const result = analyzeProjectFile(xml, external);
    if (!result.ok) throw new Error(result.reason);
    return result;
  };

  it("下限・完全一致を照会し、下限には印を付ける", () => {
    const result = analyze(csproj(ref("Newtonsoft.Json", "12.0.1") + ref("System.Text.Encodings.Web", "[4.5.0]") + '<PackageReference Include="Child"><Version>1.2.3</Version></PackageReference>'));
    expect(result.references).toEqual([
      { name: "Newtonsoft.Json", version: "12.0.1", relation: "direct", lowerBound: true },
      { name: "System.Text.Encodings.Web", version: "4.5.0", relation: "direct" },
      { name: "Child", version: "1.2.3", relation: "direct", lowerBound: true },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("Condition(参照・ItemGroup・子のVersion)、Choose・Targetの中は照会しない", () => {
    const result = analyze(`<Project>
      <ItemGroup>${ref("A", "1.0.0", " Condition=\"'$(TF)'=='net48'\"")}<PackageReference Include="B"><Version Condition="true">1.0.0</Version></PackageReference></ItemGroup>
      <ItemGroup Condition="'$(Configuration)'=='Debug'">${ref("C", "1.0.0")}</ItemGroup>
      <Choose><When Condition="true"><ItemGroup>${ref("D", "1.0.0")}</ItemGroup></When></Choose>
      <Target Name="T"><ItemGroup>${ref("E", "1.0.0")}</ItemGroup></Target>
    </Project>`);
    expect(result.references).toEqual([]);
    expect(result.unresolved.map((u) => [u.name, u.reason])).toEqual(["A", "B", "C", "D", "E"].map((n) => [n, "conditional"]));
  });

  it.each([
    ["Updateが後にある", ref("Old", "1.0.0") + '<PackageReference Update="Old" Version="2.0.0" />', "updated"],
    ["Updateが先にある", '<PackageReference Update="old" Version="2.0.0" />' + ref("Old", "1.0.0"), "updated"],
    ["Remove", ref("Old", "1.0.0") + '<PackageReference Remove="Old" />', "removed"],
    ["名前を確定できないUpdate", ref("Old", "1.0.0") + '<PackageReference Update="$(Pkgs)" Version="2.0.0" />', "updated"],
    ["重複したInclude", ref("Old", "1.0.0") + ref("old", "2.0.0"), "duplicate"],
    ["VersionOverride", ref("Old", "1.0.0", ' VersionOverride="2.0.0"'), "central_package_management"],
    ["版なし(中央パッケージ管理)", ref("Old"), "central_package_management"],
    ["プロパティの名前", ref("$(PkgName)", "1.0.0"), "property"],
  ])("先行するIncludeの古い版を照会しない: %s", (_label, items, reason) => {
    const result = analyze(csproj(items));
    expect(result.references).toEqual([]);
    expect(new Set(result.unresolved.map((u) => u.reason))).toEqual(new Set([reason]));
  });

  it("Includeの;区切り、Directory.Build.*で扱われる名前", () => {
    const result = analyze(csproj('<PackageReference Include="A;B" Version="1.0.0" />'), new Set(["b"]));
    expect(names(result.references)).toEqual(["A@1.0.0"]);
    expect(result.unresolved).toEqual([{ name: "B", specifier: "1.0.0", reason: "updated" }]);
    expect(analyze(csproj(ref("A", "1.0.0")), new Set(["*"])).unresolved[0]!.reason).toBe("updated");
  });

  it("NuGetLockFilePathの有無を返す", () => {
    expect(analyze(csproj(ref("A", "1.0.0"), "<PropertyGroup><NuGetLockFilePath>x.json</NuGetLockFilePath></PropertyGroup>")).customLockFilePath).toBe(true);
    expect(analyze(csproj(ref("A", "1.0.0"))).customLockFilePath).toBe(false);
  });
});

describe("コピーと関係", () => {
  it("同じ名前の別の版を別のグループに書き、2.4.0・2.7.0が読める形にする", () => {
    const content = JSON.parse(nugetLockCopyContent([
      { name: "A", version: "1.0.0", relation: "direct" },
      { name: "a", version: "2.0.0", relation: "transitive" },
      { name: "B", version: "1.0.0", relation: "unknown" },
    ]));
    expect(content).toEqual({ version: 1, dependencies: {
      group0: { A: { type: "Direct", resolved: "1.0.0" }, B: { type: "Transitive", resolved: "1.0.0" } },
      group1: { a: { type: "Transitive", resolved: "2.0.0" } },
    } });
  });

  it("関係は大文字小文字を区別せず、直接依存を優先する", () => {
    const lookup = nugetRelations([{ name: "A", version: "1", relation: "transitive" }, { name: "a", version: "1", relation: "direct" }])!;
    expect(lookup("A", "1").relation).toBe("direct");
    expect(lookup("A", "2").relation).toBe("unknown");
    const reversed = nugetRelations([{ name: "a", version: "1", relation: "direct" }, { name: "A", version: "1", relation: "transitive" }])!;
    expect(reversed("A", "1").relation).toBe("direct");
  });

  it("nuget.config: nuget.org以外のソース・解釈できないファイルを注意の対象にする", () => {
    const config = (value: string) => `<configuration><packageSources><add key="k" value="${value}" /></packageSources></configuration>`;
    expect(hasNonNugetOrgSource(config("https://api.nuget.org/v3/index.json"))).toBe(false);
    expect(hasNonNugetOrgSource(config("https://pkgs.corp.example/nuget/v3/index.json"))).toBe(true);
    expect(hasNonNugetOrgSource(config("C:\\local-feed"))).toBe(true);
    expect(hasNonNugetOrgSource("<configuration>")).toBe(true);
    expect(hasNonNugetOrgSource('<configuration><disabledPackageSources><add key="k" value="true" /></disabledPackageSources></configuration>')).toBe(false);
  });
});

describe("プロジェクトとの対応付け(detectProject)", () => {
  it("プロジェクトが1つのディレクトリのpackages.lock.jsonは、そのプロジェクトのものとする", async () => {
    const dir = await makeProject({ "App/App.csproj": csproj(ref("A", "1.0.0")), "App/packages.lock.json": lock({ A: { type: "Direct", resolved: "1.2.0" } }) });
    const project = await detectProject(dir);
    expect(project.lockfileMissing).toEqual([]);
    expect(project.nugetCopies.map((c) => [c.path, names(c.packages)])).toEqual([[path.join("App", "packages.lock.json"), ["A@1.2.0"]]]);
  });

  it("回帰(レビュー指摘): 複数のプロジェクトがあるディレクトリのpackages.lock.jsonは、どのプロジェクトのものとも確認しない(スキャンはする)", async () => {
    const dir = await makeProject({
      "Two/A.csproj": csproj(ref("A", "1.0.0")),
      "Two/B.csproj": csproj(ref("B", "1.0.0")),
      "Two/packages.lock.json": lock({ A: { type: "Direct", resolved: "1.0.0" } }),
      "Two/packages.B.lock.json": lock({ B: { type: "Direct", resolved: "1.5.0" } }),
    });
    const project = await detectProject(dir);
    expect(project.lockfileMissing.map((m) => [m.path, m.status])).toEqual([[path.join("Two", "A.csproj"), "unconfirmed"]]);
    expect(project.nugetCopies.map((c) => [c.path, names(c.packages)])).toEqual([
      [path.join("Two", "packages.B.lock.json"), ["B@1.5.0"]],
      [path.join("Two", "packages.lock.json"), ["A@1.0.0"]],
      [path.join("Two", "A.csproj"), ["A@1.0.0"]],
    ]);
  });

  it("NuGetLockFilePathのあるプロジェクトは、既定の名前のlockfileと対応付けない", async () => {
    const dir = await makeProject({
      "App.csproj": csproj(ref("A", "1.0.0"), "<PropertyGroup><NuGetLockFilePath>locks/app.json</NuGetLockFilePath></PropertyGroup>"),
      "packages.lock.json": lock({ A: { type: "Direct", resolved: "1.0.0" } }),
    });
    expect((await detectProject(dir)).lockfileMissing.map((m) => m.status)).toEqual(["unconfirmed"]);
  });

  it("project.assets.jsonはprojectPathが一致するプロジェクトだけに使い、古ければ警告する", async () => {
    const assets = (projectPath: string) => JSON.stringify({ libraries: { "A/1.0.0": { type: "package" } }, project: { restore: { projectPath } } });
    const dir = await makeProject({
      "One/One.csproj": csproj(ref("A", "$(V)")),
      "One/obj/project.assets.json": assets("/src/One/One.csproj"),
      "Other/Other.csproj": csproj(ref("A", "1.0.0")),
      "Other/obj/project.assets.json": assets("/src/Shared/Shared.csproj"),
    });
    await utimes(path.join(dir, "One/obj/project.assets.json"), new Date(0), new Date(0));
    const project = await detectProject(dir);
    expect(project.nugetCopies.map((c) => [c.path, c.format])).toEqual([
      [path.join("One", "obj", "project.assets.json"), "project.assets.json"],
      [path.join("Other", "Other.csproj"), "PackageReference"],
    ]);
    expect(project.unresolvedPackageReferences).toEqual([]);
    expect(project.lockfileMissing.map((m) => [m.path, m.status])).toEqual([[path.join("Other", "Other.csproj"), "direct_only"]]);
    expect(project.nugetWarnings.some((w) => w.includes("is older than"))).toBe(true);
    expect(project.nugetWarnings).toContain(NUGET_LOWER_BOUND_WARNING);
  });

  it("回帰(実物の確認): cloneやダウンロードの書き込み順によるわずかな差では、project.assets.jsonを古いとしない", async () => {
    const dir = await makeProject({
      "App.csproj": csproj(""),
      "obj/project.assets.json": JSON.stringify({ libraries: {}, project: { restore: { projectPath: "E:\\x\\App.csproj" } } }),
    });
    const now = Date.now();
    await utimes(path.join(dir, "obj/project.assets.json"), new Date(now - 30_000), new Date(now - 30_000));
    await utimes(path.join(dir, "App.csproj"), new Date(now), new Date(now));
    expect((await detectProject(dir)).nugetWarnings).toEqual([]);
  });

  it("プロジェクトのディレクトリのbin・objは走査せず、他のbinは走査する", async () => {
    const deps = (name: string) => JSON.stringify({ libraries: { [`${name}/1.0.0`]: { type: "package" } } });
    const dir = await makeProject({
      "App/App.csproj": csproj(""),
      "App/bin/Debug/App.deps.json": deps("InBin"),
      "App/obj/x.deps.json": deps("InObj"),
      "tools/bin/tool.deps.json": deps("ToolBin"),
      "tools/bin/package-lock.json": '{"lockfileVersion":3,"packages":{}}',
    });
    const project = await detectProject(dir);
    // 復元の情報の無いApp.csproj自体は直接依存だけの対象として残る
    expect(project.manifests.map((m) => m.path).sort()).toEqual([path.join("App", "App.csproj"), path.join("tools", "bin", "package-lock.json"), path.join("tools", "bin", "tool.deps.json")]);
  });

  it("Directory.Build.propsで扱われる名前はその下のプロジェクトで照会しない。読めなければ全て照会しない", async () => {
    const dir = await makeProject({
      "src/Directory.Build.props": '<Project><ItemGroup><PackageReference Update="A" Version="2.0.0" /></ItemGroup></Project>',
      "src/App/App.csproj": csproj(ref("A", "1.0.0") + ref("B", "1.0.0")),
      "other/Directory.Build.targets": "<Project><!DOCTYPE x></Project>",
      "other/Lib/Lib.csproj": csproj(ref("C", "1.0.0")),
    });
    const project = await detectProject(dir);
    expect(project.unresolvedPackageReferences.map((u) => [u.name, u.reason]).sort()).toEqual([["A", "updated"], ["C", "updated"]]);
    expect(project.skippedFiles.map((s) => s.path)).toEqual([path.join("other", "Directory.Build.targets")]);
  });

  it("回帰(レビュー指摘): 直接のPackageReferenceが無くても、復元の情報の無いプロジェクトは欠けとして残す", async () => {
    // Directory.Build.propsが依存を加える構成。別のエコシステムのlockfileが同居してもcomplete: trueにしない
    const dir = await makeProject({
      "Directory.Build.props": '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="12.0.1" /></ItemGroup></Project>',
      "Lib/Lib.csproj": "<Project />",
      "web/package-lock.json": '{"lockfileVersion":3,"packages":{}}',
    });
    const project = await detectProject(dir);
    expect(project.lockfileMissing.map((m) => [m.path, m.ecosystem, m.status])).toEqual([[path.join("Lib", "Lib.csproj"), "NuGet", "direct_only"]]);
  });

  it("回帰(レビュー指摘): NuGetLockFilePathのあるプロジェクトは、名前付きのpackages.<名前>.lock.jsonとも対応付けない", async () => {
    const dir = await makeProject({
      "App.csproj": csproj(ref("A", "1.0.0"), "<PropertyGroup><NuGetLockFilePath>locks/app.json</NuGetLockFilePath></PropertyGroup>"),
      "packages.App.lock.json": lock({ A: { type: "Direct", resolved: "1.0.0" } }),
    });
    const project = await detectProject(dir);
    expect(project.lockfileMissing.map((m) => m.status)).toEqual(["unconfirmed"]);
    // 古いlockfileでも、載っているパッケージはスキャンする
    expect(project.nugetCopies.map((c) => c.path)).toEqual(["packages.App.lock.json", "App.csproj"]);
  });

  it("確認済みのlockfileのあるプロジェクトは欠けにしない。nuget.configの非公開フィードを警告する", async () => {
    const dir = await makeProject({
      "nuget.config": '<configuration><packageSources><add key="corp" value="https://corp.example/v3/index.json" /></packageSources></configuration>',
      "App/App.csproj": csproj(""),
      "App/packages.lock.json": lock({ A: { type: "Direct", resolved: "1.0.0" } }),
    });
    const project = await detectProject(dir);
    expect(project.lockfileMissing).toEqual([]);
    expect(project.nugetWarnings).toEqual([NUGET_PRIVATE_FEED_WARNING]);
  });

  it("直接指定: packages.lock.json・project.assets.jsonはそのファイルだけ、.csprojはそのディレクトリを走査する", async () => {
    const dir = await makeProject({
      "packages.lock.json": lock({ A: { type: "Direct", resolved: "1.0.0" } }),
      "obj/project.assets.json": JSON.stringify({ libraries: { "B/1.0.0": { type: "package" } } }),
      "App.csproj": csproj(ref("C", "1.0.0")),
      "go.mod": "module x\n",
    });
    expect((await detectProject(path.join(dir, "packages.lock.json"))).manifests.map((m) => m.path)).toEqual(["packages.lock.json"]);
    expect((await detectProject(path.join(dir, "obj", "project.assets.json"))).manifests.map((m) => m.format)).toEqual(["project.assets.json"]);
    expect((await detectProject(path.join(dir, "App.csproj"))).manifests.map((m) => m.path).sort()).toEqual(["go.mod", "packages.lock.json"]);
  });

  it("照会できる参照が無いプロジェクトも対象として示す。解釈できるものが無ければno_manifest_found", async () => {
    const dir = await makeProject({ "App/App.csproj": csproj(ref("A", "$(V)")) });
    // 照会できる参照が無くても、直接依存だけの対象としてマニフェストに数える(未解決の参照を示すため)
    const project = await detectProject(dir);
    expect(project.unresolvedPackageReferences.map((u) => u.reason)).toEqual(["property"]);
    // 解釈できないプロジェクトのファイルだけならno_manifest_found(理由つき)
    await expect(detectProject(await makeProject({ "Lib/Lib.csproj": "<Project><!DOCTYPE x></Project>" }))).rejects.toMatchObject({ kind: "no_manifest_found" });
  });
});
