import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ScanToolError } from "../../errors.js";
import { detectJavaProject } from "../../utils/projectDetector.js";

const POM = "<project/>";
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-detector-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function expectScanError(promise: Promise<unknown>, kind: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ScanToolError);
  expect((error as ScanToolError).kind).toBe(kind);
}

describe("detectJavaProject", () => {
  it("ルート直下のpom.xmlを検出する", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "pom.xml"), POM);
    const project = await detectJavaProject(dir);
    expect(project.manifests).toEqual(["pom.xml"]);
  });

  it("深い階層のpom.xmlも検出し、絶対パスの一覧も返す(検出結果=スキャン範囲)", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "pom.xml"), POM);
    await mkdir(path.join(dir, "module-a"), { recursive: true });
    await writeFile(path.join(dir, "module-a", "pom.xml"), POM);
    await mkdir(path.join(dir, "a", "b", "c", "d", "e", "f", "g", "h"), { recursive: true });
    await writeFile(path.join(dir, "a", "b", "c", "d", "e", "f", "g", "h", "pom.xml"), POM); // 深さ9
    const project = await detectJavaProject(dir);
    expect([...project.manifests].sort()).toEqual(["a/b/c/d/e/f/g/h/pom.xml", "module-a/pom.xml", "pom.xml"]);
    expect(project.targets).toEqual(project.manifests.map((m) => ({ path: path.join(project.projectDir, m), format: "pom.xml" })));
  });

  it("requirements.txt等のJava以外のファイルは一覧に含めない", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "pom.xml"), POM);
    await writeFile(path.join(dir, "requirements.txt"), "-r ../outside.txt\n");
    await writeFile(path.join(dir, "package-lock.json"), "{}");
    const project = await detectJavaProject(dir);
    expect(project.manifests).toEqual(["pom.xml"]);
  });

  it.each([
    { label: "エントリ数", options: { maxEntries: 3 } },
    { label: "マニフェスト数", options: { maxManifests: 1 } },
    { label: "深さ", options: { maxDepth: 2 } },
  ])("探索上限($label)に達したら黙って打ち切らずエラーにする", async ({ options }) => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "pom.xml"), POM);
    await mkdir(path.join(dir, "m1", "deep"), { recursive: true });
    await writeFile(path.join(dir, "m1", "pom.xml"), POM);
    await writeFile(path.join(dir, "m1", "deep", "pom.xml"), POM);
    await expectScanError(detectJavaProject(dir, options), "manifest_search_limit_exceeded");
  });

  it("target等のビルド成果物ディレクトリは探索しない", async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, "target"), { recursive: true });
    await writeFile(path.join(dir, "target", "pom.xml"), POM);
    await expectScanError(detectJavaProject(dir), "no_manifest_found");
  });

  it("pom.xmlファイルのパスを直接受け付ける", async () => {
    const dir = await makeTempDir();
    const pomPath = path.join(dir, "pom.xml");
    await writeFile(pomPath, POM);
    const project = await detectJavaProject(pomPath);
    expect(project.manifests).toEqual(["pom.xml"]);
  });

  it("回帰: マニフェストの直接指定はそのファイル1件だけを返し、親ディレクトリを探索しない", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "pom.xml"), POM);
    await mkdir(path.join(dir, "child"), { recursive: true });
    await writeFile(path.join(dir, "child", "pom.xml"), POM);
    // 探索上限エラーの案内どおり直接指定すれば、上限に関係なくスキャンできる
    const project = await detectJavaProject(path.join(dir, "pom.xml"), { maxManifests: 1, maxEntries: 1 });
    expect(project.manifests).toEqual(["pom.xml"]);
    expect(project.targets).toEqual([{ path: path.join(await realpath(dir), "pom.xml"), format: "pom.xml" }]);
    // 同じ構成でディレクトリを指定した場合は上限エラーになる(対比)
    await expectScanError(detectJavaProject(dir, { maxManifests: 1 }), "manifest_search_limit_exceeded");
  });

  it("gradle.lockfileの直接指定も、そのファイル1件だけを返す", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "gradle.lockfile"), "a:a:1.0=runtimeClasspath\nempty=\n");
    await writeFile(path.join(dir, "pom.xml"), POM);
    const project = await detectJavaProject(path.join(dir, "gradle.lockfile"));
    expect(project.manifests).toEqual(["gradle.lockfile"]);
  });

  it("マニフェストの直接指定でもOSV_MCP_ALLOWED_ROOTの境界を検証する", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(path.join(outside, "pom.xml"), POM);
    await expectScanError(
      detectJavaProject(path.join(outside, "pom.xml"), { allowedRoot: root }),
      "path_outside_allowed_root",
    );
  });

  it("対応外のファイル指定はエラー", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "readme.txt");
    await writeFile(filePath, "");
    await expectScanError(detectJavaProject(filePath), "project_not_found");
  });

  it("存在しないパス・空文字はエラー", async () => {
    await expectScanError(detectJavaProject("/no/such/path/xyz"), "project_not_found");
    await expectScanError(detectJavaProject("  "), "project_not_found");
  });

  it("対応マニフェストが無いディレクトリはno_manifest_found", async () => {
    const dir = await makeTempDir();
    await expectScanError(detectJavaProject(dir), "no_manifest_found");
  });

  it("gradle.lockfileを検出する(buildscript-gradle.lockfileも)", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "gradle.lockfile"), "a:b:1.0=runtimeClasspath\n");
    await writeFile(path.join(dir, "buildscript-gradle.lockfile"), "empty=classpath\n");
    const project = await detectJavaProject(dir);
    expect(project.manifests.sort()).toEqual(["buildscript-gradle.lockfile", "gradle.lockfile"]);
  });

  it("MavenとGradleの混在プロジェクトは両方のマニフェストを返す", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "pom.xml"), POM);
    await mkdir(path.join(dir, "gradle-module"));
    await writeFile(path.join(dir, "gradle-module", "gradle.lockfile"), "a:b:1.0=runtimeClasspath\n");
    const project = await detectJavaProject(dir);
    expect(project.manifests.sort()).toEqual(["gradle-module/gradle.lockfile", "pom.xml"]);
  });

  it("build.gradleはあるがlockfileが無い場合は生成手順を案内する", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "build.gradle"), "plugins { id 'java' }\n");
    const error = await detectJavaProject(dir).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ScanToolError);
    expect((error as ScanToolError).kind).toBe("gradle_lockfile_missing");
    expect((error as ScanToolError).message).toContain("--write-locks");
  });

  it("build.gradle.kts / settings.gradle でもGradleプロジェクトとして認識する", async () => {
    for (const name of ["build.gradle.kts", "settings.gradle"]) {
      const dir = await makeTempDir();
      await writeFile(path.join(dir, name), "");
      await expectScanError(detectJavaProject(dir), "gradle_lockfile_missing");
    }
  });

  it("gradle.lockfileのパスを直接受け付ける", async () => {
    const dir = await makeTempDir();
    const lockPath = path.join(dir, "gradle.lockfile");
    await writeFile(lockPath, "a:b:1.0=runtimeClasspath\n");
    const project = await detectJavaProject(lockPath);
    expect(project.manifests).toEqual(["gradle.lockfile"]);
  });

  it("build.gradleのパス直接指定はディレクトリとして解決される(lockfile無しなら案内)", async () => {
    const dir = await makeTempDir();
    const buildPath = path.join(dir, "build.gradle");
    await writeFile(buildPath, "");
    await expectScanError(detectJavaProject(buildPath), "gradle_lockfile_missing");

    // lockfileがあれば正常に解決される
    await writeFile(path.join(dir, "gradle.lockfile"), "a:b:1.0=runtimeClasspath\n");
    const project = await detectJavaProject(buildPath);
    expect(project.manifests).toEqual(["gradle.lockfile"]);
  });

  it("allowedRoot配下なら許可、外ならエラー", async () => {
    const root = await makeTempDir();
    const inside = path.join(root, "sub");
    await mkdir(inside);
    await writeFile(path.join(inside, "pom.xml"), POM);
    const project = await detectJavaProject(inside, { allowedRoot: root });
    expect(project.manifests).toEqual(["pom.xml"]);

    const outside = await makeTempDir();
    await writeFile(path.join(outside, "pom.xml"), POM);
    await expectScanError(
      detectJavaProject(outside, { allowedRoot: root }),
      "path_outside_allowed_root",
    );
  });

  it("シンボリックリンクは実体パスに解決してから境界チェックする", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(path.join(outside, "pom.xml"), POM);
    // root配下のリンクがroot外を指すケース: ../../etc型の抜け道を塞ぐ
    const link = path.join(root, "sneaky-link");
    await symlink(outside, link);
    await expectScanError(
      detectJavaProject(link, { allowedRoot: root }),
      "path_outside_allowed_root",
    );
  });

  it("権限不足で読めないディレクトリはスキップして探索を続ける", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "pom.xml"), POM);
    const locked = path.join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const project = await detectJavaProject(dir);
      expect(project.manifests).toEqual(["pom.xml"]);
    } finally {
      await chmod(locked, 0o755); // クリーンアップできるよう権限を戻す
    }
  });

  it("pom.xml探索でシンボリックリンクのディレクトリは辿らない", async () => {
    const dir = await makeTempDir();
    const elsewhere = await makeTempDir();
    await writeFile(path.join(elsewhere, "pom.xml"), POM);
    await symlink(elsewhere, path.join(dir, "linked"));
    await expectScanError(detectJavaProject(dir), "no_manifest_found");
  });
});

describe("detectJavaProject: 親POMが許可ルートの外を参照するpom.xml", () => {
  const OUTSIDE_PARENT =
    "<project><parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version>" +
    "<relativePath>../../outside/pom.xml</relativePath></parent><artifactId>a</artifactId></project>";

  async function makeBase(): Promise<string> {
    const base = await realpath(await makeTempDir());
    await mkdir(path.join(base, "outside"), { recursive: true });
    await writeFile(path.join(base, "outside", "pom.xml"), POM);
    await mkdir(path.join(base, "root", "proj", "bad"), { recursive: true });
    return base;
  }

  it("該当するpom.xmlだけスキャン対象から外し、理由を返す", async () => {
    const base = await makeBase();
    await writeFile(path.join(base, "root/proj/pom.xml"), POM);
    await writeFile(path.join(base, "root/proj/bad/pom.xml"), OUTSIDE_PARENT.replace("../../outside", "../../../outside"));
    const project = await detectJavaProject(path.join(base, "root/proj"), { allowedRoot: path.join(base, "root") });
    expect(project.manifests).toEqual(["pom.xml"]);
    expect(project.skipped).toEqual([{ path: "bad/pom.xml", reason: expect.stringContaining("許可ルート") }]);
  });

  it("全件除外ならpath_outside_allowed_root(直接指定も)", async () => {
    const base = await makeBase();
    await writeFile(path.join(base, "root/proj/pom.xml"), OUTSIDE_PARENT.replace("../../outside", "../../outside"));
    const options = { allowedRoot: path.join(base, "root") };
    await expectScanError(detectJavaProject(path.join(base, "root/proj"), options), "path_outside_allowed_root");
    await expectScanError(detectJavaProject(path.join(base, "root/proj/pom.xml"), options), "path_outside_allowed_root");
  });

  it("許可ルート未設定なら除外しない", async () => {
    const base = await makeBase();
    await writeFile(path.join(base, "root/proj/pom.xml"), OUTSIDE_PARENT);
    const project = await detectJavaProject(path.join(base, "root/proj"));
    expect(project.manifests).toEqual(["pom.xml"]);
    expect(project.skipped).toEqual([]);
  });
});
