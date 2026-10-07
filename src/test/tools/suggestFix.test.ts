import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSuggestFix } from "../../tools/suggestFix.js";
import type { ToolResult } from "../../tools/toolResult.js";

let binDir: string;
let projectDir: string;

async function makeFakeBinary(name: string, script: string): Promise<string> {
  const filePath = path.join(binDir, name);
  await writeFile(filePath, `#!/bin/sh\n${script}\n`);
  await chmod(filePath, 0o755);
  return filePath;
}

// 2.14.1に対し、same_minor修正なし・同一メジャー内の修正(2.15.0)あり、
// さらにunfixedなCVEを1件含むスキャン結果
const SCAN_JSON = JSON.stringify({
  results: [
    {
      source: { path: "/x/pom.xml" },
      packages: [
        {
          package: { name: "a:a", version: "2.14.1", ecosystem: "Maven" },
          groups: [
            { ids: ["GHSA-fix"], aliases: ["CVE-2021-1"], max_severity: "9.0" },
            { ids: ["GHSA-unfixed"], aliases: ["CVE-2021-2"], max_severity: "5.0" },
          ],
          vulnerabilities: [
            {
              id: "GHSA-fix",
              affected: [
                {
                  package: { name: "a:a", ecosystem: "Maven" },
                  ranges: [
                    { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.12.2" }] },
                    { type: "ECOSYSTEM", events: [{ introduced: "2.13.0" }, { fixed: "2.15.0" }] },
                  ],
                },
              ],
            },
            { id: "GHSA-unfixed", affected: [] },
          ],
        },
      ],
    },
  ],
});

function parsePayload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  binDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-fix-bin-"));
  projectDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-fix-proj-"));
  await writeFile(path.join(projectDir, "pom.xml"), "<project/>");
});

afterAll(async () => {
  await rm(binDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe("handleSuggestFix", () => {
  it("スキャン結果から3段階Tierの提案を組み立てて返す", async () => {
    const bin = await makeFakeBinary("ok", `echo '${SCAN_JSON}'; exit 1`);
    const result = await handleSuggestFix({ project_path: projectDir }, { binaryPath: bin });
    expect(result.isError).toBeUndefined();

    const payload = parsePayload(result) as {
      vulnerable_package_count: number;
      unfixed_vulnerability_count: number;
      suggestions: {
        package: string;
        recommended_upgrade: string | null;
        upgrade_tier: string | null;
        per_cve_detail: { id: string; fixed_in: string | null; tier: string }[];
      }[];
    };
    expect(payload.vulnerable_package_count).toBe(1);
    expect(payload.unfixed_vulnerability_count).toBe(1);

    const suggestion = payload.suggestions[0]!;
    expect(suggestion.recommended_upgrade).toBe("2.15.0");
    expect(suggestion.upgrade_tier).toBe("major_internal");
    const tiers = Object.fromEntries(suggestion.per_cve_detail.map((d) => [d.id, d.tier]));
    expect(tiers).toEqual({ "GHSA-fix": "major_internal", "GHSA-unfixed": "unfixed" });
  });

  it("エラーはscan_java_projectと同じ形式(kind付きJSON)で返す", async () => {
    const result = await handleSuggestFix(
      { project_path: "/no/such/path" },
      { binaryPath: "/unused" },
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result) as { error: { kind: string } };
    expect(payload.error.kind).toBe("project_not_found");
  });
});

describe("handleSuggestFix: 推移的依存の解決状態の伝播", () => {
  it("無効化時は応答に警告を含め、スキャナーに--no-resolveを渡す", async () => {
    const argsFile = path.join(binDir, "suggest-args.txt");
    const bin = await makeFakeBinary(
      "rec-suggest",
      `printf '%s\\n' "$@" > '${argsFile}'; echo '{"results":[]}'; exit 0`,
    );
    const result = await handleSuggestFix({ project_path: projectDir }, { binaryPath: bin, noRemoteResolution: true });
    const payload = parsePayload(result);
    const resolution = payload.dependency_resolution as { transitive_resolution: string; warning?: string };
    expect(resolution.transitive_resolution).toBe("disabled");
    expect(resolution.warning).toContain("推移的依存の脆弱性は含まれません");
    expect((await readFile(argsFile, "utf8")).split("\n")).toContain("--no-resolve");
    const keys = Object.keys(payload);
    expect(keys.indexOf("dependency_resolution")).toBeLessThan(keys.indexOf("suggestions"));
  });

  it("回帰: 直下のgradle.lockfileとa/b/c/pom.xmlの構成で、深いpom.xmlも一覧に含め、警告を付ける", async () => {
    const mixedDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-fix-deep-pom-"));
    try {
      await writeFile(path.join(mixedDir, "gradle.lockfile"), "a:a:1.0=runtimeClasspath\nempty=\n");
      await mkdir(path.join(mixedDir, "a", "b", "c"), { recursive: true });
      await writeFile(path.join(mixedDir, "a", "b", "c", "pom.xml"), "<project/>");
      const bin = await makeFakeBinary("ok-deep", `echo '{"results":[]}'; exit 0`);
      const payload = parsePayload(
        await handleSuggestFix({ project_path: mixedDir }, { binaryPath: bin, noRemoteResolution: true }),
      );
      expect([...(payload.manifests as string[])].sort()).toEqual(["a/b/c/pom.xml", "gradle.lockfile"]);
      const resolution = payload.dependency_resolution as { transitive_resolution: string; warning?: string };
      expect(resolution.transitive_resolution).toBe("disabled");
      expect(resolution.warning).toContain("推移的依存の脆弱性は含まれません");
    } finally {
      await rm(mixedDir, { recursive: true, force: true });
    }
  });

  it("既定では解決有効と表示する", async () => {
    const bin = await makeFakeBinary("ok-default", `echo '{"results":[]}'; exit 0`);
    const previous = process.env.OSV_MCP_NO_REMOTE_RESOLUTION;
    delete process.env.OSV_MCP_NO_REMOTE_RESOLUTION;
    try {
      const payload = parsePayload(await handleSuggestFix({ project_path: projectDir }, { binaryPath: bin }));
      expect(payload.dependency_resolution).toEqual({ transitive_resolution: "enabled" });
    } finally {
      if (previous !== undefined) process.env.OSV_MCP_NO_REMOTE_RESOLUTION = previous;
    }
  });
});

describe("handleSuggestFix: npm・Go対応(v0.5.0)", () => {
  // Maven・npm・Go・PyPIの脆弱なパッケージを1件ずつ含むスキャン結果
  const MIXED_JSON = JSON.stringify({
    results: [{
      source: { path: "/x/lock" },
      packages: [
        ["Maven", "a:a", "2.14.1", "ECOSYSTEM", "2.15.0"],
        ["npm", "lodash", "4.17.20", "SEMVER", "4.17.21"],
        ["Go", "golang.org/x/text", "0.3.0", "SEMVER", "0.3.8"],
        ["PyPI", "urllib3", "1.23", "ECOSYSTEM", "1.24.2"],
      ].map(([ecosystem, name, version, type, fixed]) => ({
        package: { name, version, ecosystem },
        groups: [{ ids: [`GHSA-${name}`], aliases: [], max_severity: "7.5" }],
        vulnerabilities: [{ id: `GHSA-${name}`, affected: [{ package: { name, ecosystem }, ranges: [{ type, events: [{ introduced: "0" }, { fixed }] }] }] }],
      })),
    }],
  });

  it("scan_projectと同じ検出でJava以外のlockfileも対象にし、npm・Go・PyPIの推奨を返す", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-fix-mixed-"));
    try {
      await writeFile(path.join(dir, "pom.xml"), "<project/>");
      await mkdir(path.join(dir, "web"));
      await writeFile(path.join(dir, "web", "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
      await mkdir(path.join(dir, "svc"));
      await writeFile(path.join(dir, "svc", "go.mod"), "module example.com/svc\n");
      await writeFile(path.join(dir, "svc", "package.json"), "{}"); // lockfileが無い → coverageに出る
      const argsFile = path.join(binDir, "mixed-args.txt");
      const bin = await makeFakeBinary("mixed", `printf '%s\\n' "$@" > '${argsFile}'; echo '${MIXED_JSON}'; exit 1`);
      const payload = parsePayload(await handleSuggestFix({ project_path: dir }, { binaryPath: bin }));

      expect([...(payload.manifests as string[])].sort()).toEqual(["pom.xml", "svc/go.mod", "web/package-lock.json"]);
      const lockfiles = (await readFile(argsFile, "utf8")).split("\n").filter((a) => a.includes(":/"));
      expect(lockfiles.map((a) => a.slice(0, a.indexOf(":"))).sort()).toEqual(["go.mod", "package-lock.json", "pom.xml"]);
      // coverageを件数より前に置く
      const coverage = payload.coverage as { complete: boolean; lockfile_missing: { path: string }[] };
      expect(coverage.complete).toBe(false);
      expect(coverage.lockfile_missing.map((m) => m.path)).toEqual(["svc/package.json"]);
      const keys = Object.keys(payload);
      expect(keys.indexOf("coverage")).toBeLessThan(keys.indexOf("vulnerable_package_count"));
      expect("skipped_manifests" in payload).toBe(false);

      const byEcosystem = Object.fromEntries(
        (payload.suggestions as { ecosystem: string; recommended_upgrade: string | null; upgrade_tier: string | null; verification: string }[])
          .map((s) => [s.ecosystem, [s.recommended_upgrade, s.upgrade_tier, s.verification]]),
      );
      expect(byEcosystem).toEqual({
        Maven: ["2.15.0", "major_internal", "verified"],
        npm: ["4.17.21", "same_minor", "verified"],
        Go: ["0.3.8", "same_minor", "verified"],
        PyPI: ["1.24.2", "major_internal", "verified"],
      });
      expect(payload.unfixed_vulnerability_count).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("handleSuggestFix: PyPI(v0.6.0)", () => {
  it("requirements.txtの下限(>=)でスキャンした依存は、version_is_lower_boundと注記を付ける", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-fix-lower-"));
    try {
      await writeFile(path.join(dir, "requirements.txt"), "Jinja2>=2.0\nrequests==2.19.0\n");
      const json = JSON.stringify({ results: [{ source: { path: "/x/requirements.txt" }, packages: [
        ["jinja2", "2.0", "2.11.3"], ["requests", "2.19.0", "2.20.0"],
      ].map(([name, version, fixed]) => ({
        package: { name, version, ecosystem: "PyPI" },
        groups: [{ ids: [`PYSEC-${name}`], aliases: [], max_severity: "7.5" }],
        vulnerabilities: [{ id: `PYSEC-${name}`, affected: [{ package: { name, ecosystem: "PyPI" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed }] }] }] }],
      })) }] });
      const bin = await makeFakeBinary("lower", `echo '${json}'; exit 1`);
      const payload = parsePayload(await handleSuggestFix({ project_path: dir }, { binaryPath: bin }));
      const byName = Object.fromEntries((payload.suggestions as { package: string; recommended_upgrade: string; version_is_lower_bound?: true; upgrade_note: string }[])
        .map((s) => [s.package, s]));
      expect(byName.jinja2!.recommended_upgrade).toBe("2.11.3");
      expect(byName.jinja2!.version_is_lower_bound).toBe(true);
      expect(byName.jinja2!.upgrade_note).toContain("下限");
      expect("version_is_lower_bound" in byName.requests!).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
