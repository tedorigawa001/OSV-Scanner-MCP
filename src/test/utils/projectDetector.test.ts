import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

  it("サブモジュールのpom.xmlも深さ上限内で検出する", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "pom.xml"), POM);
    await mkdir(path.join(dir, "module-a"), { recursive: true });
    await writeFile(path.join(dir, "module-a", "pom.xml"), POM);
    await mkdir(path.join(dir, "a", "b", "c", "d"), { recursive: true });
    await writeFile(path.join(dir, "a", "b", "c", "d", "pom.xml"), POM); // 深さ5: 対象外
    const project = await detectJavaProject(dir);
    expect(project.manifests.sort()).toEqual(["module-a/pom.xml", "pom.xml"]);
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
