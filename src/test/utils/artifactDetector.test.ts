import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectJavaArtifacts } from "../../utils/artifactDetector.js";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), "artifact-detect-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("detectJavaArtifacts", () => {
  it("includes target/build outputs, excludes manifests and VCS files", async () => {
    for (const dir of ["target", "build/libs", ".git"]) await mkdir(path.join(root, dir), { recursive: true });
    for (const file of ["target/a.jar", "build/libs/b.war", "pom.xml", ".git/hidden.jar"]) {
      await writeFile(path.join(root, file), "fixture");
    }
    expect((await detectJavaArtifacts(root)).artifactPaths).toEqual([
      path.join(root, "build/libs/b.war"), path.join(root, "target/a.jar"),
    ]);
  });

  it("a single file does not scan its siblings", async () => {
    for (const file of ["a.jar", "b.war"]) await writeFile(path.join(root, file), "fixture");
    expect((await detectJavaArtifacts(path.join(root, "a.jar"))).artifactPaths).toEqual([path.join(root, "a.jar")]);
  });

  it("does not follow file or directory symlinks during enumeration", async () => {
    await mkdir(path.join(root, "scope"));
    await writeFile(path.join(root, "outside.jar"), "fixture");
    await symlink(path.join(root, "outside.jar"), path.join(root, "scope/link.jar"));
    await symlink(root, path.join(root, "scope/loop"));
    await expect(detectJavaArtifacts(path.join(root, "scope"))).rejects.toMatchObject({ kind: "no_scannable_artifacts" });
  });

  it("rejects a directly supplied symlink escaping allowedRoot", async () => {
    await mkdir(path.join(root, "scope"));
    await writeFile(path.join(root, "outside.jar"), "fixture");
    await symlink(path.join(root, "outside.jar"), path.join(root, "scope/link.jar"));
    await expect(detectJavaArtifacts(path.join(root, "scope/link.jar"), {
      allowedRoot: path.join(root, "scope"),
    })).rejects.toMatchObject({ kind: "path_outside_allowed_root" });
  });

  it("rejects prefix-sibling paths but accepts names beginning with two dots inside the root", async () => {
    await mkdir(path.join(root, "scope"));
    await mkdir(path.join(root, "scope-other"));
    await writeFile(path.join(root, "scope-other/a.jar"), "fixture");
    await expect(detectJavaArtifacts(path.join(root, "scope-other/a.jar"), {
      allowedRoot: path.join(root, "scope"),
    })).rejects.toMatchObject({ kind: "path_outside_allowed_root" });
    await writeFile(path.join(root, "scope/..safe.jar"), "fixture");
    await expect(detectJavaArtifacts(path.join(root, "scope/..safe.jar"), {
      allowedRoot: path.join(root, "scope"),
    })).resolves.toMatchObject({ artifactPaths: [path.join(root, "scope/..safe.jar")] });
  });

  it.each(["", "relative.jar"])("rejects invalid input %s", async (input) => {
    await expect(detectJavaArtifacts(input)).rejects.toMatchObject({ kind: "project_not_found" });
  });

  it("rejects non-archive files and empty directories", async () => {
    await expect(detectJavaArtifacts(root)).rejects.toMatchObject({ kind: "no_scannable_artifacts" });
    await writeFile(path.join(root, "pom.xml"), "fixture");
    await expect(detectJavaArtifacts(path.join(root, "pom.xml"))).rejects.toMatchObject({ kind: "no_scannable_artifacts" });
  });

  it("fails explicitly instead of silently truncating the file list", async () => {
    for (const file of ["a.jar", "b.jar"]) await writeFile(path.join(root, file), "fixture");
    await expect(detectJavaArtifacts(root, { maxArtifacts: 1 })).rejects.toMatchObject({ kind: "artifact_search_limit_exceeded" });
    await expect(detectJavaArtifacts(root, { maxEntries: 1 })).rejects.toMatchObject({ kind: "artifact_search_limit_exceeded" });
    await mkdir(path.join(root, "nested"));
    await expect(detectJavaArtifacts(root, { maxDepth: 1 })).rejects.toMatchObject({ kind: "artifact_search_limit_exceeded" });
  });
});
