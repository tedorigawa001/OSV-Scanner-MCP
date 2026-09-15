/**
 * OSV-Scannerの実行ラッパー。
 *
 * セキュリティ設計(docs/DESIGN_TODO.md):
 * - シェルを経由しない`spawn`+引数配列で実行(コマンドインジェクション対策)
 * - OSV-Scannerへ渡す引数は固定リストのみ。呼び出し側から任意フラグは注入できない
 *   (プロジェクトは検証済みディレクトリ1つ、実体スキャンは列挙済みのJAR/WAR絶対パスだけを渡す)
 * - タイムアウトと出力サイズ上限を設ける(ハング・巨大出力によるDoS対策)
 *
 * 終了コード(2.4.0で実機確認):
 *   0 = スキャン成功・脆弱性なし / 1 = スキャン成功・脆弱性あり / 128 = 対象パッケージなし
 */

import { spawn } from "node:child_process";
import { ScanToolError } from "../errors.js";
import { resolveOsvScannerBinary } from "./binaryManager.js";
import { parseOsvScanOutput, type ScanReport } from "./scanReport.js";

export interface RunOsvScanOptions {
  /** 使用するバイナリ。省略時はOSV_SCANNER_PATH→PATHの順で解決 */
  binaryPath?: string;
  /** デフォルト120秒 */
  timeoutMs?: number;
  /** stdoutの上限バイト数。デフォルト32MB(実測: 依存3件のpom.xmlで約195KB) */
  maxOutputBytes?: number;
  /** 同時実行スキャン数の上限。省略時はOSV_MCP_MAX_CONCURRENT_SCANS→デフォルト2 */
  maxConcurrentScans?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 同時実行スキャン数の上限(CPU・メモリ・ネットワーク枯渇対策)。
 * MCPクライアントは並列リクエストを送れるため、osv-scannerプロセスが
 * 無制限に増えないようプロセス全体でカウントし、超過は待たせず即時エラーにする。
 */
const DEFAULT_MAX_CONCURRENT_SCANS = 2;
const MAX_CONCURRENT_SCANS_ENV = "OSV_MCP_MAX_CONCURRENT_SCANS";
const MAX_CONCURRENT_SCANS_CEILING = 16;

let activeScans = 0;

function maxConcurrentScansFromEnv(): number {
  const raw = process.env[MAX_CONCURRENT_SCANS_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_CONCURRENT_SCANS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENT_SCANS;
  return Math.min(parsed, MAX_CONCURRENT_SCANS_CEILING);
}
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** エラー詳細に含めるstderrの上限(外部由来テキストをそのまま膨らませない) */
const MAX_STDERR_DETAIL_BYTES = 8 * 1024;

/** OSV-Scannerに渡す固定引数。ここに無いオプションは一切使わない(ホワイトリスト) */
const FIXED_SCAN_ARGS = ["scan", "source", "-r", "--format", "json"] as const;
const FIXED_ARTIFACT_ARGS = [
  "scan", "source", "--format", "json", "--all-packages", "--no-ignore",
  "--experimental-no-default-plugins", "--experimental-plugins", "java/archive",
] as const;

const EXIT_NO_VULNS = 0;
const EXIT_VULNS_FOUND = 1;
const EXIT_NO_PACKAGES = 128;

interface RawScanResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function execOsvScanner(
  binaryPath: string,
  targetPaths: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
  artifactMode: boolean,
): Promise<RawScanResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [
      ...(artifactMode ? FIXED_ARTIFACT_ARGS : FIXED_SCAN_ARGS), ...targetPaths,
    ], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error: ScanToolError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(
        new ScanToolError(
          "scan_timeout",
          `OSV-Scannerが${Math.round(timeoutMs / 1000)}秒以内に完了しませんでした`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(
          new ScanToolError(
            "output_too_large",
            `OSV-Scannerの出力がサイズ上限(${maxOutputBytes}バイト)を超えました`,
          ),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_DETAIL_BYTES) return;
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      fail(new ScanToolError("scan_failed", `OSV-Scannerを起動できませんでした: ${error.message}`));
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_DETAIL_BYTES),
      });
    });
  });
}

/**
 * projectDirをOSV-Scannerでスキャンし、整形済みレポートを返す。
 *
 * @param projectDir スキャン対象ディレクトリ。**必ず`detectJavaProject`で検証済みの
 *   絶対パスを渡すこと**(このレイヤーではパス検証を行わない)
 */
export async function runOsvScan(
  projectDir: string,
  options: RunOsvScanOptions = {},
): Promise<ScanReport> {
  return parseOsvScanOutput(await runScan([projectDir], options, false));
}

/** Accept only the exact absolute files enumerated by detectJavaArtifacts. */
export async function runOsvArtifactScan(
  artifactPaths: readonly string[],
  options: RunOsvScanOptions = {},
): Promise<unknown> {
  if (artifactPaths.length === 0) {
    throw new ScanToolError("no_scannable_artifacts", "No JAR/WAR archives selected");
  }
  return runScan(artifactPaths, options, true);
}

async function runScan(
  targetPaths: readonly string[],
  options: RunOsvScanOptions,
  artifactMode: boolean,
): Promise<unknown> {
  const limit = options.maxConcurrentScans ?? maxConcurrentScansFromEnv();
  if (activeScans >= limit) {
    throw new ScanToolError(
      "too_many_concurrent_scans",
      `同時実行できるスキャンは${limit}件までです(現在${activeScans}件実行中)。実行中のスキャン完了後に再試行してください`,
    );
  }
  activeScans++;
  try {
    return await runOsvScanUnguarded(targetPaths, options, artifactMode);
  } finally {
    activeScans--;
  }
}

async function runOsvScanUnguarded(
  targetPaths: readonly string[],
  options: RunOsvScanOptions,
  artifactMode: boolean,
): Promise<unknown> {
  const binaryPath = options.binaryPath ?? (await resolveOsvScannerBinary());
  const result = await execOsvScanner(
    binaryPath,
    targetPaths,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    artifactMode,
  );

  if (result.exitCode === EXIT_NO_PACKAGES && !artifactMode) {
    throw new ScanToolError(
      "no_packages_found",
      `OSV-Scannerがスキャン対象のパッケージを検出できませんでした: ${targetPaths[0]}(pom.xmlに依存関係が定義されているか確認してください)`,
      result.stderr,
    );
  }

  if (artifactMode && result.exitCode === EXIT_NO_PACKAGES && result.stdout.trim() === "") {
    return { results: [] };
  }
  if (result.exitCode !== EXIT_NO_VULNS && result.exitCode !== EXIT_VULNS_FOUND &&
      !(artifactMode && result.exitCode === EXIT_NO_PACKAGES)) {
    const status =
      result.exitCode !== null ? `exit code ${result.exitCode}` : `signal ${result.signal}`;
    throw new ScanToolError(
      "scan_failed",
      `OSV-Scannerが異常終了しました(${status})`,
      result.stderr,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ScanToolError(
      "invalid_output",
      "OSV-Scannerの出力をJSONとして解釈できませんでした",
      result.stdout.slice(0, 1000),
    );
  }
  return parsed;
}
