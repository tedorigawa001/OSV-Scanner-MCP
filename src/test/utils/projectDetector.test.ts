import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
    await expectScanError(detectJavaProject(dir), "no_pom_found");
  });

  it("pom.xmlファイルのパスを直接受け付ける", async () => {
    const dir = await makeTempDir();
    const pomPath = path.join(dir, "pom.xml");
    await writeFile(pomPath, POM);
    const project = await detectJavaProject(pomPath);
    expect(project.manifests).toEqual(["pom.xml"]);
  });

  it("pom.xml以外のファイル指定はエラー", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "build.gradle");
    await writeFile(filePath, "");
    await expectScanError(detectJavaProject(filePath), "project_not_found");
  });

  it("存在しないパス・空文字はエラー", async () => {
    await expectScanError(detectJavaProject("/no/such/path/xyz"), "project_not_found");
    await expectScanError(detectJavaProject("  "), "project_not_found");
  });

  it("pom.xmlが無いディレクトリはno_pom_found", async () => {
    const dir = await makeTempDir();
    await expectScanError(detectJavaProject(dir), "no_pom_found");
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

  it("pom.xml探索でシンボリックリンクのディレクトリは辿らない", async () => {
    const dir = await makeTempDir();
    const elsewhere = await makeTempDir();
    await writeFile(path.join(elsewhere, "pom.xml"), POM);
    await symlink(elsewhere, path.join(dir, "linked"));
    await expectScanError(detectJavaProject(dir), "no_pom_found");
  });
});
