#!/usr/bin/env node
/**
 * OSV-Scanner-MCP: Google OSV-ScannerをラップするMCPサーバー(stdioトランスポート)。
 *
 * 環境変数:
 * - OSV_SCANNER_PATH: 使用するosv-scannerバイナリの明示指定(省略時はPATHから探索)
 * - OSV_MCP_ALLOWED_ROOT: 指定時、このディレクトリ配下以外のスキャンを拒否する
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleExplainVulnerability } from "./tools/explainVulnerability.js";
import { handleScanJavaProject } from "./tools/scanJavaProject.js";
import { handleSuggestFix } from "./tools/suggestFix.js";

export const ALLOWED_ROOT_ENV = "OSV_MCP_ALLOWED_ROOT";

const server = new McpServer({
  name: "osv-scanner-mcp",
  version: "0.1.0",
});

server.registerTool(
  "scan_java_project",
  {
    title: "Javaプロジェクトの脆弱性スキャン",
    description:
      "Java(Maven)プロジェクトをGoogle OSV-Scannerでスキャンし、依存ライブラリの既知の脆弱性(CVE/GHSA)を深刻度順のJSONレポートで返す。" +
      "レポートにはパッケージごとの脆弱性一覧(CVSSスコア・5段階深刻度・修正版バージョン)とサマリ集計が含まれる。" +
      "Maven(pom.xml)とGradle(gradle.lockfile)に対応。",
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
      { allowedRoot: process.env[ALLOWED_ROOT_ENV] },
    ),
);

server.registerTool(
  "suggest_fix",
  {
    title: "脆弱性を解消する推奨アップグレードの提案",
    description:
      "Java(Maven)プロジェクトをスキャンし、脆弱な依存パッケージごとに推奨アップグレードバージョンを提案する。" +
      "現在のバージョンに最も近いリリース系統の修正版を優先する3段階フォールバック" +
      "(same_minor: 同一major.minor系統内 → major_internal: 同一メジャー内 → cross_major: メジャーアップグレード)で選定し、" +
      "推奨バージョン・アップグレード距離(upgrade_tier)・CVEごとの修正版を返す。" +
      "修正版が存在しないCVEはunfixedとして明示する。Maven(pom.xml)とGradle(gradle.lockfile)に対応。",
    inputSchema: {
      project_path: z
        .string()
        .min(1)
        .describe("スキャン対象のプロジェクトディレクトリ、またはpom.xml/gradle.lockfileの絶対パス"),
    },
  },
  async ({ project_path }) =>
    handleSuggestFix({ project_path }, { allowedRoot: process.env[ALLOWED_ROOT_ENV] }),
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

const transport = new StdioServerTransport();
await server.connect(transport);
// stdoutはMCPプロトコル専用のため、起動ログはstderrへ
console.error("osv-scanner-mcp: MCP server running on stdio");
