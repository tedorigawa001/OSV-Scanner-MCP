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
  console.error(`osv-scanner-mcp: [警告] ${startupWarning}`);
}

// NOTE: リリース時はpackage.jsonのversionと同じ値に更新すること
const server = new McpServer({
  name: "osv-scanner-mcp",
  version: "0.5.0",
});

server.registerTool(
  "scan_project",
  {
    title: "プロジェクトの依存の脆弱性スキャン(Java / JavaScript / Python / Go)",
    description:
      "プロジェクト内のlockfile・マニフェストを検出し、依存ライブラリの既知の脆弱性(CVE/GHSA)をまとめてスキャンする。" +
      "対応: Java(pom.xml / gradle.lockfile)、JavaScript(package-lock.json / npm-shrinkwrap.json / yarn.lock / pnpm-lock.yaml / bun.lock)、" +
      "Python(poetry.lock / uv.lock / Pipfile.lock / pdm.lock / requirements.txt)、Go(go.mod)。" +
      "パッケージマネージャーやビルドは実行しない。" +
      "応答先頭のcoverageを必ず確認すること: lockfileが無いマニフェスト、バージョン未固定のrequirements行、スキャン対象から外したファイルを示す。" +
      "coverage.complete=falseの場合は、検出0件でも安全とは判断しないこと。修正版の推奨(suggest_fix)はJava・JavaScript・Goに対応(Pythonは未対応)。",
    inputSchema: {
      project_path: z
        .string()
        .min(1)
        .describe("スキャン対象のプロジェクトディレクトリ、または対応するlockfile・マニフェストの絶対パス"),
    },
  },
  async ({ project_path }) =>
    handleScanProject({ project_path }, { allowedRoot: allowedRootFromEnv() }),
);

server.registerTool(
  "scan_java_project",
  {
    title: "Javaプロジェクトの脆弱性スキャン",
    description:
      "Java(Maven)プロジェクトをGoogle OSV-Scannerでスキャンし、依存ライブラリの既知の脆弱性(CVE/GHSA)を深刻度順のJSONレポートで返す。" +
      "レポートにはパッケージごとの脆弱性一覧(CVSSスコア・5段階深刻度・修正版バージョン)とサマリ集計が含まれる。" +
      "Maven(pom.xml)とGradle(gradle.lockfile)に対応。" +
      "dependency_resolution.warningがある場合は推移的依存がスキャン対象外のため、検出0件でも安全とは判断しないこと。",
    inputSchema: {
      project_path: z
        .string()
        .min(1)
        .describe("スキャン対象のプロジェクトディレクトリ、またはpom.xml/gradle.lockfileの絶対パス"),
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
    title: "脆弱性を解消する推奨アップグレードの提案",
    description:
      "scan_projectと同じ検出でプロジェクトをスキャンし、脆弱な依存パッケージごとに推奨アップグレードバージョンを提案する。" +
      "推奨はJava(Maven / Gradle)・JavaScript(npm)・Goに対応し、Python(PyPI)はunsupported_ecosystemとして返す。" +
      "現在のバージョンに最も近いリリース系統の修正版を優先する3段階フォールバック" +
      "(same_minor: 同一系統内 → major_internal: 同一メジャー内 → cross_major: メジャーアップグレード)で選定し、" +
      "推奨バージョン・アップグレード距離(upgrade_tier)・CVEごとの修正版を返す。npm・Goでは0.x系のマイナー更新もcross_major(破壊的変更の可能性)。" +
      "候補を全修正対象CVEの影響範囲と照合し、情報不足の場合は推奨を保留する。プレリリース版は正式版で解消できない場合だけ推奨し、recommended_is_prereleaseを付ける。" +
      "現在より新しい修正版候補のないCVEはunfixedとして別表示し、推奨先での判定も返す。" +
      "応答のcoverageを必ず確認すること(complete=falseなら提案に含まれない依存がある)。" +
      "dependency_resolution.warningがある場合は推移的依存の脆弱性が提案に含まれない。",
    inputSchema: {
      project_path: z
        .string()
        .min(1)
        .describe("スキャン対象のプロジェクトディレクトリ、または対応するlockfile・マニフェストの絶対パス"),
    },
  },
  async ({ project_path }) =>
    handleSuggestFix({ project_path }, { allowedRoot: allowedRootFromEnv() }),
);

server.registerTool(
  "explain_vulnerability",
  {
    title: "脆弱性の詳細説明の取得",
    description:
      "指定したGHSA-IDまたはCVE-IDの脆弱性の詳細をOSVデータベース(api.osv.dev)から取得して返す。" +
      "説明(details)・CVSSベクトル・影響を受けるパッケージとバージョン範囲・参照リンク(アドバイザリや修正コミット)が含まれる。" +
      "scan_java_projectやsuggest_fixの結果に含まれるIDをそのまま渡せる。スキャンは実行しない。",
    inputSchema: {
      vulnerability_id: z
        .string()
        .min(3)
        .max(100)
        .describe("脆弱性のID(例: GHSA-jfh8-c2jp-5v3q、CVE-2021-44228)"),
    },
  },
  async ({ vulnerability_id }) => handleExplainVulnerability({ vulnerability_id }),
);

server.registerTool(
  "scan_java_artifact",
  {
    title: "JAR/WAR実体の脆弱性スキャン",
    description:
      "JAR/WARファイルまたはディレクトリ内の実体をスキャンする。ビルドやJavaコードの実行は行わない。" +
      "メタデータによるベストエフォート同定のため、coverageと同定不能ファイルを必ず確認すること。" +
      "completenessは常にincomplete。検出0件でも安全性や全依存の同定を保証しない。",
    inputSchema: {
      artifact_path: z.string().min(1).describe("JAR/WARファイル、または探索するディレクトリの絶対パス"),
    },
  },
  async ({ artifact_path }) => handleScanJavaArtifact(
    { artifact_path }, { allowedRoot: allowedRootFromEnv() },
  ),
);

server.registerTool(
  "scan_sbom",
  {
    title: "SBOMの脆弱性スキャン",
    description:
      "CycloneDX 1.4/1.5/1.6またはSPDX 2.2/2.3のJSON SBOMから識別できる依存をスキャンする。" +
      "ビルドやJARの実行は行わない。入力は16MiB以下のローカルファイル。" +
      "SBOMの網羅性・鮮度・実成果物との一致は未検証であり、検出0件でも安全性を保証しない。",
    inputSchema: {
      sbom_path: z.string().min(1).describe("CycloneDX/SPDX JSON SBOMファイルの絶対パス"),
    },
  },
  async ({ sbom_path }) => handleScanSbom(
    { sbom_path }, { allowedRoot: allowedRootFromEnv() },
  ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdoutはMCPプロトコル専用のため、起動ログはstderrへ
console.error("osv-scanner-mcp: MCP server running on stdio");
