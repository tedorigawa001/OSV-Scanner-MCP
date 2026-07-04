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
import { handleScanJavaProject } from "./tools/scanJavaProject.js";

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
      "現在はMaven(pom.xml)のみ対応。",
    inputSchema: {
      project_path: z
        .string()
        .min(1)
        .describe("スキャン対象のプロジェクトディレクトリまたはpom.xmlの絶対パス"),
    },
  },
  async ({ project_path }) =>
    handleScanJavaProject(
      { project_path },
      { allowedRoot: process.env[ALLOWED_ROOT_ENV] },
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdoutはMCPプロトコル専用のため、起動ログはstderrへ
console.error("osv-scanner-mcp: MCP server running on stdio");
