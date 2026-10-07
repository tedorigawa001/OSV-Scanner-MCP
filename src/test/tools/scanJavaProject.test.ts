import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleScanJavaProject, type ToolResult } from "../../tools/scanJavaProject.js";

let binDir: string;
let projectDir: string;

async function makeFakeBinary(name: string, script: string): Promise<string> {
  const filePath = path.join(binDir, name);
  await writeFile(filePath, `#!/bin/sh\n${script}\n`);
  await chmod(filePath, 0o755);
  return filePath;
}

const VULN_JSON = JSON.stringify({
  results: [
    {
      source: { path: "/x/pom.xml" },
      packages: [
        {
          package: { name: "a:a", version: "1.0", ecosystem: "Maven" },
          groups: [{ ids: ["GHSA-test"], aliases: ["CVE-2020-1"], max_severity: "9.9" }],
        },
      ],
    },
  ],
});

function parsePayload(result: ToolResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe("text");
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  binDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-tool-bin-"));
  projectDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-tool-proj-"));
  await writeFile(path.join(projectDir, "pom.xml"), "<project/>");
});

afterAll(async () => {
  await rm(binDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe("handleScanJavaProject", () => {
  it("成功時はproject_dir/manifests付きのレポートJSONを返す", async () => {
    const bin = await makeFakeBinary("ok", `echo '${VULN_JSON}'; exit 1`);
    const result = await handleScanJavaProject(
      { project_path: projectDir },
      { binaryPath: bin },
    );
    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result);
    expect(payload.manifests).toEqual(["pom.xml"]);
    expect(payload.vulnerability_count).toBe(1);
    expect(typeof payload.project_dir).toBe("string");
  });

  it("ScanToolErrorはisError+kind付きのエラーJSONに変換される", async () => {
    const result = await handleScanJavaProject(
      { project_path: "/no/such/path" },
      { binaryPath: "/unused" },
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result) as { error: { kind: string; message: string } };
    expect(payload.error.kind).toBe("project_not_found");
    expect(payload.error.message).toBeTruthy();
  });

  it("スキャン失敗時はstderr抜粋がdetailに入る", async () => {
    const bin = await makeFakeBinary("broken", `echo 'kaboom' >&2; exit 127`);
    const result = await handleScanJavaProject(
      { project_path: projectDir },
      { binaryPath: bin },
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result) as { error: { kind: string; detail?: string } };
    expect(payload.error.kind).toBe("scan_failed");
    expect(payload.error.detail).toContain("kaboom");
  });

  it("ScanToolError以外の想定外例外はinternal_errorに丸め、内部情報を漏らさない", async () => {
    // 空文字のbinaryPathはspawnがTypeErrorを投げる(ScanToolErrorではない例外の代表例)
    const result = await handleScanJavaProject(
      { project_path: projectDir },
      { binaryPath: "" },
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result) as { error: { kind: string; message: string } };
    expect(payload.error.kind).toBe("internal_error");
    expect(payload.error.message).not.toContain("TypeError");
    expect(JSON.stringify(payload)).not.toContain("stack");
  });

  it("allowedRoot外のパスはpath_outside_allowed_rootで拒否される", async () => {
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-tool-root-"));
    try {
      const result = await handleScanJavaProject(
        { project_path: projectDir },
        { binaryPath: "/unused", allowedRoot: otherRoot },
      );
      expect(result.isError).toBe(true);
      const payload = parsePayload(result) as { error: { kind: string } };
      expect(payload.error.kind).toBe("path_outside_allowed_root");
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});

describe("handleScanJavaProject: 推移的依存の解決状態の伝播", () => {
  const ENV = "OSV_MCP_NO_REMOTE_RESOLUTION";

  async function scanWith(env: string | undefined, option: boolean | undefined, dir = projectDir) {
    const argsFile = path.join(binDir, `args-${Math.random().toString(36).slice(2)}.txt`);
    const bin = await makeFakeBinary(
      `rec-${path.basename(argsFile)}`,
      `printf '%s\\n' "$@" > '${argsFile}'; echo '{"results":[]}'; exit 0`,
    );
    const previous = process.env[ENV];
    if (env === undefined) delete process.env[ENV];
    else process.env[ENV] = env;
    try {
      const result = await handleScanJavaProject({ project_path: dir }, { binaryPath: bin, noRemoteResolution: option });
      const args = (await readFile(argsFile, "utf8")).trim().split("\n");
      return { payload: parsePayload(result), args };
    } finally {
      if (previous === undefined) delete process.env[ENV];
      else process.env[ENV] = previous;
    }
  }

  it("既定では解決有効と表示し、--no-resolveを付けない", async () => {
    const { payload, args } = await scanWith(undefined, undefined);
    expect(payload.dependency_resolution).toEqual({ transitive_resolution: "enabled" });
    expect(args).not.toContain("--no-resolve");
  });

  it.each([
    { label: "環境変数", env: "1", option: undefined },
    { label: "オプション", env: undefined, option: true },
  ])("$label で無効化すると、応答の警告と--no-resolveが一致する", async ({ env, option }) => {
    const { payload, args } = await scanWith(env, option);
    const resolution = payload.dependency_resolution as { transitive_resolution: string; warning?: string };
    expect(resolution.transitive_resolution).toBe("disabled");
    expect(resolution.warning).toContain("推移的依存の脆弱性は含まれません");
    expect(args).toContain("--no-resolve");
    // 検出0件を安全と誤読されないよう、件数より前に置く
    const keys = Object.keys(payload);
    expect(keys.indexOf("dependency_resolution")).toBeLessThan(keys.indexOf("vulnerability_count"));
  });

  it("回帰: 直下のgradle.lockfileと探索深さ外のa/b/c/pom.xmlの構成でも警告を付ける", async () => {
    const mixedDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-tool-deep-pom-"));
    try {
      await writeFile(path.join(mixedDir, "gradle.lockfile"), "a:a:1.0=runtimeClasspath\nempty=\n");
      await mkdir(path.join(mixedDir, "a", "b", "c"), { recursive: true });
      await writeFile(path.join(mixedDir, "a", "b", "c", "pom.xml"), "<project/>");
      const { payload, args } = await scanWith(undefined, true, mixedDir);
      // 前提: 深いpom.xmlはマニフェスト一覧に現れない(osv-scannerの-rはスキャンする)
      expect(payload.manifests).toEqual(["gradle.lockfile"]);
      const resolution = payload.dependency_resolution as { transitive_resolution: string; warning?: string };
      expect(resolution.transitive_resolution).toBe("disabled");
      expect(resolution.warning).toContain("推移的依存の脆弱性は含まれません");
      expect(resolution.warning).toContain("lockfile(gradle.lockfile)に記録された依存は対象");
      expect(args).toContain("--no-resolve");
    } finally {
      await rm(mixedDir, { recursive: true, force: true });
    }
  });
});
