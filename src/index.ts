#!/usr/bin/env node
/**
 * OSV-Scanner-MCP: Google OSV-ScannerをラップするMCPサーバー(stdioトランスポート)。
 *
 * 環境変数:
 * - OSV_SCANNER_PATH: 使用するosv-scannerバイナリの明示指定(省略時はPATHから探索)
 * - OSV_MCP_ALLOWED_ROOT: 指定時、このディレクトリ配下以外のスキャンを拒否する(設定を推奨)
 * - OSV_MCP_REQUIRE_ALLOWED_ROOT: 1/true指定時、OSV_MCP_ALLOWED_ROOT未設定なら起動を拒否する
 * - OSV_MCP_MAX_CONCURRENT_SCANS: 同時実行スキャン数の上限(デフォルト2)
 * - OSV_MCP_AUTO_DOWNLOAD: 0/false指定時、バイナリの自動ダウンロードを無効化
 * - OSV_MCP_PREFER_DOWNLOAD: 1/true指定時、PATH上のバイナリを使わず検証済み自動ダウンロードを優先
 * - OSV_MCP_NO_REMOTE_RESOLUTION: 1/true指定時、pom.xmlの推移的依存をdeps.devで解決しない
 * - OSV_MCP_NO_CANDIDATE_CHECK: 1/true指定時、suggest_fixの推奨先のOSV照会を行わない
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleExplainVulnerability } from "./tools/explainVulnerability.js";
import { handleScanJavaProject } from "./tools/scanJavaProject.js";
import { handleScanProject } from "./tools/scanProject.js";
import { handleScanJavaArtifact } from "./tools/scanJavaArtifact.js";
import { handleScanSbom } from "./tools/scanSbom.js";
import { handleSuggestFix } from "./tools/suggestFix.js";
import { realpathSync } from "node:fs";
import os from "node:os";
import { defaultCacheDir } from "./osv/binaryDownloader.js";
import { permissionModelWarnings } from "./utils/permissionCheck.js";
import { installShutdownHandlers, removeStaleTempDirs } from "./utils/processCleanup.js";
import {
  ALLOWED_ROOT_ENV,
  allowedRootFromEnv,
  allowedRootStartupError,
  allowedRootStartupWarning,
} from "./utils/startupConfig.js";

export { ALLOWED_ROOT_ENV };

// fail-closed: 運用モードで許可ルートが未設定なら、ツールを一切公開せず終了する
const startupError = allowedRootStartupError();
if (startupError !== null) {
  console.error(`osv-scanner-mcp: ${startupError}`);
  process.exit(1);
}
// 互換性のため未設定でも起動は続けるが、残余リスクをstderrで可視化する
const startupWarning = allowedRootStartupWarning();
if (startupWarning !== null) {
  console.error(`osv-scanner-mcp: [warning] ${startupWarning}`);
}
// Nodeの権限モデル(--permission)で起動された場合、必要な許可が欠けていればstderrで知らせる(起動は続ける)
{
  const tmpDir = os.tmpdir();
  let tmpDirReal = tmpDir;
  try {
    tmpDirReal = realpathSync(tmpDir);
  } catch { /* 解決前のパスの読み取りが拒否されている場合も、警告で示す */ }
  const scannerPath = process.env.OSV_SCANNER_PATH?.trim();
  for (const warning of permissionModelWarnings({
    allowedRoot: allowedRootFromEnv(),
    tmpDir,
    tmpDirReal,
    cacheDir: scannerPath ? undefined : defaultCacheDir(),
    scannerPath: scannerPath || undefined,
  })) {
    console.error(`osv-scanner-mcp: [warning] ${warning}`);
  }
}

// NOTE: リリース時はpackage.jsonのversionと同じ値に更新すること
const server = new McpServer({
  name: "osv-scanner-mcp",
  version: "0.11.0",
});

server.registerTool(
  "scan_project",
  {
    title: "Scan project dependencies for vulnerabilities (Java / JavaScript / Python / Go)",
    description:
      "Detects the lockfiles and manifests in a project and scans the dependencies for known vulnerabilities (CVE/GHSA). " +
      "Supported: Java (pom.xml / gradle.lockfile), JavaScript (package-lock.json / npm-shrinkwrap.json / yarn.lock / pnpm-lock.yaml / bun.lock), " +
      "Python (poetry.lock / uv.lock / Pipfile.lock / pdm.lock / requirements.txt), Go (go.mod). " +
      "Package managers and builds are never run. " +
      "Always check coverage at the top of the response: it lists manifests without a lockfile, requirements lines without a pinned version, and excluded files. " +
      "Each package's dependency_relation tells whether it is a direct or transitive dependency (determined for package-lock.json, go.mod, requirements.txt, and pom.xml; unknown otherwise). " +
      "If coverage.complete is false, do not conclude that the project is safe even with zero findings. Upgrade recommendations (suggest_fix) are available for Java, JavaScript, Python, and Go.",
    inputSchema: {
      project_path: z
        .string()
        .min(1)
        .describe("Absolute path to the project directory, or to a supported lockfile or manifest"),
    },
  },
  async ({ project_path }) =>
    handleScanProject({ project_path }, { allowedRoot: allowedRootFromEnv() }),
);

server.registerTool(
  "scan_java_project",
  {
    title: "Scan a Java project for vulnerabilities",
    description:
      "Scans a Java (Maven) project with Google OSV-Scanner and returns the known vulnerabilities (CVE/GHSA) in its dependencies as a JSON report sorted by severity. " +
      "The report lists the vulnerabilities per package (CVSS score, five severity levels, fixed versions) with summary counts. " +
      "Supports Maven (pom.xml) and Gradle (gradle.lockfile). " +
      "If dependency_resolution.warning is present, transitive dependencies were not scanned, so do not conclude that the project is safe even with zero findings.",
    inputSchema: {
      project_path: z
        .string()
        .min(1)
        .describe("Absolute path to the project directory, or to a pom.xml / gradle.lockfile"),
    },
  },
  async ({ project_path }) =>
    handleScanJavaProject(
      { project_path },
      { allowedRoot: allowedRootFromEnv() },
    ),
);

server.registerTool(
  "suggest_fix",
  {
    title: "Recommend upgrades that fix vulnerabilities",
    description:
      "Scans the project with the same detection as scan_project and recommends an upgrade version for each vulnerable package. " +
      "Recommendations are available for Java (Maven / Gradle), JavaScript (npm), Python (PyPI), and Go. " +
      "The fixed version closest to the current release line is chosen with a three-tier fallback " +
      "(same_minor: same release line -> major_internal: same major version -> cross_major: major upgrade), " +
      "and the response gives the recommended version, the upgrade distance (upgrade_tier), and the fixed version per CVE. For npm, Go, and PyPI, a minor update within 0.x is also cross_major (may include breaking changes). " +
      "Dependencies scanned at a requirements.txt lower bound (>=) are marked version_is_lower_bound, and the recommendation then means raising the lower bound. " +
      "update_hint explains how to upgrade, depending on whether the package is a direct or transitive dependency (dependency_relation; for npm also introduced_by and declared_in). " +
      "The recommended version is checked against api.osv.dev, and versions with known vulnerabilities that do not affect the current version are avoided (result in candidate_check; " +
      "with has_known_vulnerabilities, failed, or skipped, the recommended version has not been confirmed safe; conflict means the data disagreed and the recommendation is withheld). " +
      "Candidates are checked against the affected ranges of every vulnerability to fix, and the recommendation is withheld when the data are insufficient. Pre-releases are recommended only when no stable version fixes everything, and are marked recommended_is_prerelease. " +
      "CVEs with no fixed version newer than the current one are reported separately as unfixed, together with their status at the recommended version. " +
      "Always check coverage in the response (if complete is false, some dependencies are not included in the suggestions). " +
      "If dependency_resolution.warning is present, vulnerabilities in transitive dependencies are not included.",
    inputSchema: {
      project_path: z
        .string()
        .min(1)
        .describe("Absolute path to the project directory, or to a supported lockfile or manifest"),
    },
  },
  async ({ project_path }) =>
    handleSuggestFix({ project_path }, { allowedRoot: allowedRootFromEnv() }),
);

server.registerTool(
  "explain_vulnerability",
  {
    title: "Explain a vulnerability",
    description:
      "Fetches the details of a vulnerability by GHSA or CVE ID from the OSV database (api.osv.dev). " +
      "Includes the description (details), CVSS vectors, affected packages and version ranges, and reference links (advisories and fix commits). " +
      "IDs from the results of the scan tools and suggest_fix can be passed as they are. No scan is run.",
    inputSchema: {
      vulnerability_id: z
        .string()
        .min(3)
        .max(100)
        .describe("Vulnerability ID (for example GHSA-jfh8-c2jp-5v3q or CVE-2021-44228)"),
    },
  },
  async ({ vulnerability_id }) => handleExplainVulnerability({ vulnerability_id }),
);

server.registerTool(
  "scan_java_artifact",
  {
    title: "Scan JAR/WAR archives for vulnerabilities",
    description:
      "Scans JAR/WAR files, or the archives in a directory. No build is run and no Java code is executed. " +
      "Identification is best effort, based on metadata, so always check coverage and the unidentified files. " +
      "For JARs without pom.properties the coordinates are inferred, and a wrong groupId can hide known vulnerabilities (coverage.inferred_coordinates, status: inferred_only). " +
      "completeness is always incomplete. Zero findings guarantees neither safety nor that every dependency was identified.",
    inputSchema: {
      artifact_path: z.string().min(1).describe("Absolute path to a JAR/WAR file, or to a directory to search"),
    },
  },
  async ({ artifact_path }) => handleScanJavaArtifact(
    { artifact_path }, { allowedRoot: allowedRootFromEnv() },
  ),
);

server.registerTool(
  "scan_sbom",
  {
    title: "Scan an SBOM for vulnerabilities",
    description:
      "Scans the dependencies that can be identified in a CycloneDX 1.4/1.5/1.6 or SPDX 2.2/2.3 JSON SBOM. " +
      "No build is run and no JAR is executed. The input is a local file of 16 MiB or less. " +
      "The SBOM's completeness, freshness, and match with the actual artifacts are not verified, so zero findings does not guarantee safety.",
    inputSchema: {
      sbom_path: z.string().min(1).describe("Absolute path to a CycloneDX/SPDX JSON SBOM file"),
    },
  },
  async ({ sbom_path }) => handleScanSbom(
    { sbom_path }, { allowedRoot: allowedRootFromEnv() },
  ),
);

// シグナル・stdinの終了時に一時ディレクトリと実行中のosv-scannerを片付ける(接続前に登録する)
installShutdownHandlers();
// 前回の異常終了で残った一時ディレクトリの掃除。起動を遅らせないよう待たない
removeStaleTempDirs().then(
  (removed) => {
    if (removed > 0) console.error(`osv-scanner-mcp: removed ${removed} temporary director${removed === 1 ? "y" : "ies"} left from a previous run`);
  },
  () => { /* 掃除の失敗で起動を止めない */ },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdoutはMCPプロトコル専用のため、起動ログはstderrへ
console.error("osv-scanner-mcp: MCP server running on stdio");
