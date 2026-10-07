import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ScanToolError } from "../../errors.js";
import { detectProject, LockfileKeyCache } from "../../utils/manifestDetector.js";

const tempDirs: string[] = [];

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-mdet-")));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function expectScanError(promise: Promise<unknown>, kind: string): Promise<ScanToolError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ScanToolError);
  expect((error as ScanToolError).kind).toBe(kind);
  return error as ScanToolError;
}

describe("detectProject: 検出", () => {
  it("全対応形式を検出し、エコシステムと解析形式を割り当てる", async () => {
    const dir = await makeProject({
      "pom.xml": "<project/>",
      "g/gradle.lockfile": "",
      "g/buildscript-gradle.lockfile": "",
      "n1/package-lock.json": "{}",
      "n2/npm-shrinkwrap.json": "{}",
      "n3/yarn.lock": "",
      "n4/pnpm-lock.yaml": "",
      "n5/bun.lock": "",
      "p1/poetry.lock": "",
      "p2/uv.lock": "",
      "p3/Pipfile.lock": "{}",
      "p4/pdm.lock": "",
      "p5/requirements.txt": "requests==2.19.0\n",
      "p5/requirements-dev.txt": "pytest==7.0.0\n",
      "p5/dev-requirements.txt": "black==22.0\n",
      "go/go.mod": "module x\n",
    });
    const project = await detectProject(dir);
    const byPath = Object.fromEntries(project.manifests.map((m) => [m.path, `${m.ecosystem}:${m.format}`]));
    expect(byPath).toEqual({
      "pom.xml": "Maven:pom.xml",
      "g/gradle.lockfile": "Maven:gradle.lockfile",
      "g/buildscript-gradle.lockfile": "Maven:buildscript-gradle.lockfile",
      "n1/package-lock.json": "npm:package-lock.json",
      "n2/npm-shrinkwrap.json": "npm:package-lock.json",
      "n3/yarn.lock": "npm:yarn.lock",
      "n4/pnpm-lock.yaml": "npm:pnpm-lock.yaml",
      "n5/bun.lock": "npm:bun.lock",
      "p1/poetry.lock": "PyPI:poetry.lock",
      "p2/uv.lock": "PyPI:uv.lock",
      "p3/Pipfile.lock": "PyPI:Pipfile.lock",
      "p4/pdm.lock": "PyPI:pdm.lock",
      "p5/requirements.txt": "PyPI:requirements.txt",
      "p5/requirements-dev.txt": "PyPI:requirements.txt",
      "p5/dev-requirements.txt": "PyPI:requirements.txt",
      "go/go.mod": "Go:go.mod",
    });
    // requirements.txtは元ファイルを渡さず、検証済みの内容を専用コピーでスキャンする
    expect(project.targets).toEqual(
      project.manifests
        .filter((m) => m.format !== "requirements.txt")
        .map((m) => ({ path: path.join(dir, m.path), format: m.format })),
    );
    expect(project.requirementsCopies.map((c) => [c.path, c.entries])).toEqual([
      ["p5/requirements.txt", ["requests==2.19.0"]],
      ["p5/requirements-dev.txt", ["pytest==7.0.0"]],
      ["p5/dev-requirements.txt", ["black==22.0"]],
    ].sort());
  });

  it("node_modules・.venv・vendor等の中は探索しない", async () => {
    const dir = await makeProject({
      "package-lock.json": "{}",
      "node_modules/x/package-lock.json": "{}",
      ".venv/lib/requirements.txt": "flask==1.0\n",
      "venv/requirements.txt": "flask==1.0\n",
      "lib/site-packages/requirements.txt": "flask==1.0\n",
      "vendor/x/go.mod": "module y\n",
      "target/pom.xml": "<project/>",
    });
    const project = await detectProject(dir);
    expect(project.manifests.map((m) => m.path)).toEqual(["package-lock.json"]);
  });

  it("対応ファイルの直接指定は、そのファイル1件だけを対象にする", async () => {
    const dir = await makeProject({ "go.mod": "module x\n", "web/package-lock.json": "{}" });
    const project = await detectProject(path.join(dir, "go.mod"));
    expect(project.manifests.map((m) => m.path)).toEqual(["go.mod"]);
  });

  it("package.json等のマーカーの直接指定はディレクトリとして探索する", async () => {
    const dir = await makeProject({ "package.json": "{}", "package-lock.json": "{}" });
    const project = await detectProject(path.join(dir, "package.json"));
    expect(project.manifests.map((m) => m.path)).toEqual(["package-lock.json"]);
  });
});

describe("detectProject: lockfileの無いマニフェスト", () => {
  it("同じディレクトリに同じエコシステムのlockfileがあれば欠落扱いにしない", async () => {
    const dir = await makeProject({
      "package.json": "{}",
      "package-lock.json": "{}",
      "py/pyproject.toml": "",
      "py/requirements.txt": "flask==1.0\n",
    });
    expect((await detectProject(dir)).lockfileMissing).toEqual([]);
  });

  it("上位のpackage-lock.jsonに収録が確認できるworkspaceメンバーは欠落扱いにしない", async () => {
    const dir = await makeProject({
      "package.json": '{"workspaces":["packages/*"]}',
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "packages/a": { name: "a" } } }),
      "packages/a/package.json": "{}",
    });
    expect((await detectProject(dir)).lockfileMissing).toEqual([]);
  });

  it("回帰: 上位のlockfileに収録されていない独立した子はmissingとして報告する", async () => {
    const dir = await makeProject({
      "package.json": "{}",
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
      "tools/cli/package.json": "{}",
    });
    const [entry] = (await detectProject(dir)).lockfileMissing;
    expect(entry).toMatchObject({ path: "tools/cli/package.json", ecosystem: "npm", status: "missing" });
    expect(entry!.hint).toContain("収録されていません");
  });

  it.each([
    { label: "収録情報の無いpackage-lock.json(v1形式等)", files: { "package-lock.json": "{}", "sub/package.json": "{}" } as Record<string, string>, ecosystem: "npm" },
    { label: "yarn.lock", files: { "yarn.lock": "", "sub/package.json": "{}" } as Record<string, string>, ecosystem: "npm" },
    { label: "上位のrequirements.txt", files: { "requirements.txt": "flask==1.0\n", "sub/pyproject.toml": "" } as Record<string, string>, ecosystem: "PyPI" },
  ])("上位の$labelでは収録を確認できないためunconfirmedとして報告する", async ({ files, ecosystem }) => {
    const dir = await makeProject(files);
    const [entry] = (await detectProject(dir)).lockfileMissing;
    expect(entry).toMatchObject({ ecosystem, status: "unconfirmed" });
    expect(entry!.hint).toContain("確認できません");
  });

  it("別のディレクトリのlockfileや別エコシステムのlockfileでは満たされない", async () => {
    const dir = await makeProject({
      "web/package-lock.json": "{}",
      "svc/package.json": "{}",
      "api/pyproject.toml": "",
      "api/package-lock.json": "{}",
      "pom.xml": "<project/>",
      "build.gradle": "",
    });
    const project = await detectProject(dir);
    expect(project.lockfileMissing.map((m) => `${m.path}:${m.ecosystem}`).sort()).toEqual([
      "api/pyproject.toml:PyPI",
      "build.gradle:Maven", // pom.xmlではgradle.lockfileの代わりにならない
      "svc/package.json:npm",
    ]);
    expect(project.lockfileMissing.every((m) => m.hint.length > 0)).toBe(true);
  });

  it("スキャンできるファイルが1つも無ければ、案内を含むno_manifest_found", async () => {
    const dir = await makeProject({ "package.json": "{}" });
    const error = await expectScanError(detectProject(dir), "no_manifest_found");
    expect(error.message).toContain("package.json");
    expect(error.message).toContain("--package-lock-only");
  });
});

describe("detectProject: requirements.txtの取り込み", () => {
  it("範囲外を指す取り込みは展開せず、範囲外の内容はコピーに含めない(元ファイルは渡さない)", async () => {
    const parent = await makeProject({
      "outside.txt": "urllib3==1.23\n",
      "proj/package-lock.json": "{}",
      "proj/evil/requirements.txt": "- r ../../outside.txt\nflask==1.0\n",
    });
    const project = await detectProject(path.join(parent, "proj"));
    expect(project.manifests.map((m) => m.path)).toEqual(["package-lock.json", "evil/requirements.txt"]);
    expect(project.targets.map((t) => path.basename(t.path))).toEqual(["package-lock.json"]);
    expect(project.requirementsCopies).toEqual([{ path: "evil/requirements.txt", entries: ["flask==1.0"] }]);
    expect(project.requirementReferences.map((r) => r.reason)).toEqual([
      expect.stringContaining("プロジェクトディレクトリの外"),
    ]);
  });

  it("直接指定したrequirements.txtに固定済みの行が無くても、マニフェストとして返す(スキャンは空)", async () => {
    const parent = await makeProject({ "outside.txt": "x==1\n", "proj/requirements.txt": "-r ../outside.txt\n" });
    const project = await detectProject(path.join(parent, "proj", "requirements.txt"));
    expect(project.manifests.map((m) => m.path)).toEqual(["requirements.txt"]);
    expect(project.requirementsCopies).toEqual([{ path: "requirements.txt", entries: [] }]);
  });
});

describe("detectProject: 入力の検証と上限", () => {
  it("OSV_MCP_ALLOWED_ROOTの外はエラー(直接指定も)", async () => {
    const root = await makeProject({});
    const outside = await makeProject({ "go.mod": "module x\n" });
    await expectScanError(detectProject(outside, { allowedRoot: root }), "path_outside_allowed_root");
    await expectScanError(detectProject(path.join(outside, "go.mod"), { allowedRoot: root }), "path_outside_allowed_root");
  });

  it("対応外のファイル指定はproject_not_found", async () => {
    const dir = await makeProject({ "README.md": "" });
    await expectScanError(detectProject(path.join(dir, "README.md")), "project_not_found");
  });

  it("探索上限に達したら黙って打ち切らずエラーにする", async () => {
    const dir = await makeProject({ "a/go.mod": "module a\n", "b/go.mod": "module b\n" });
    await expectScanError(detectProject(dir, { maxManifests: 1 }), "manifest_search_limit_exceeded");
  });
});

describe("LockfileKeyCache(回帰: lockfileを繰り返し解析する負荷増大)", () => {
  it("同じlockfileは1回だけ読んで解析し、結果を使い回す", async () => {
    const dir = await makeProject({ "package-lock.json": JSON.stringify({ packages: { "": {}, "packages/a": {} } }) });
    const cache = new LockfileKeyCache();
    const lock = path.join(dir, "package-lock.json");
    expect([...(await cache.get(lock, dir))!]).toEqual(["", "packages/a"]);
    // 読んだ後に書き換えても、2回目以降は最初の結果を使う(読み直していない)
    await writeFile(lock, JSON.stringify({ packages: { "": {} } }));
    expect([...(await cache.get(lock, dir))!]).toEqual(["", "packages/a"]);
  });

  it("読む量の合計が上限を超えたlockfileは確認できない(null)として扱う", async () => {
    const dir = await makeProject({
      "a/package-lock.json": JSON.stringify({ packages: { "": {} } }),
      "b/package-lock.json": JSON.stringify({ packages: { "": {} } }),
    });
    const cache = new LockfileKeyCache(30);
    expect(await cache.get(path.join(dir, "a/package-lock.json"), dir)).not.toBeNull();
    expect(await cache.get(path.join(dir, "b/package-lock.json"), dir)).toBeNull();
  });

  it("巨大なlockfileの配下に大量のpackage.jsonがあっても、lockfileの解析は1回で済む", async () => {
    const packages: Record<string, object> = { "": {} };
    for (let i = 0; i < 100_000; i++) packages[`node_modules/pkg-${i}`] = { version: "1.0.0", resolved: "x".repeat(40) };
    const files: Record<string, string> = { "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages }) };
    for (let i = 0; i < 1500; i++) files[`apps/app-${i}/package.json`] = "{}";
    const dir = await makeProject(files);
    const started = Date.now();
    const project = await detectProject(dir);
    // 修正前はpackage.jsonごとに約8MBのlockfileを解析し直していた(1500回)
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(project.lockfileMissing).toHaveLength(1500);
    expect(project.lockfileMissing.every((m) => m.status === "missing")).toBe(true);
  }, 60_000);
});
