/**
 * OSV-Scannerの実行ラッパー。
 *
 * セキュリティ設計(docs/DESIGN_TODO.md):
 * - シェルを経由しない`spawn`+引数配列で実行(コマンドインジェクション対策)
 * - OSV-Scannerへ渡す引数は固定リストのみ。呼び出し側から任意フラグは注入できない
 *   (プロジェクトは検出済みマニフェストを`--lockfile <形式>:<絶対パス>`で個別に、
 *   実体スキャンは列挙済みのJAR/WAR絶対パスだけを渡す)
 * - プロジェクトにディレクトリ(`-r`)を渡さない。osv-scannerがディレクトリ内の
 *   requirements.txt等も読み、その`-r ../x.txt`の取り込みでスキャン範囲の外のファイルを読むため
 * - SBOMは検証・サイズ制限済みの専用一時コピー1つだけを渡す
 * - タイムアウトと出力サイズ上限を設ける(ハング・巨大出力によるDoS対策)
 * - サーバーの終了時に実行中のプロセスを残さない(processCleanup.tsに登録し、終了時にSIGKILL)
 *
 * 終了コード(2.4.0で実機確認):
 *   0 = スキャン成功・脆弱性なし / 1 = スキャン成功・脆弱性あり / 128 = 対象パッケージなし
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import { isManifestFormat, type ManifestTarget } from "../utils/manifestFormats.js";
import { trackChildProcess } from "../utils/processCleanup.js";
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
  /** trueでマニフェストの推移的依存の外部解決(deps.dev)を行わない。省略時はOSV_MCP_NO_REMOTE_RESOLUTION */
  noRemoteResolution?: boolean;
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

const NO_REMOTE_RESOLUTION_ENV = "OSV_MCP_NO_REMOTE_RESOLUTION";

function noRemoteResolutionFromEnv(): boolean {
  const value = process.env[NO_REMOTE_RESOLUTION_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** 外部解決を無効にするか。スキャン引数と応答の表示が食い違わないよう、呼び出し側で一度だけ決める */
export function isRemoteResolutionDisabled(options: RunOsvScanOptions = {}): boolean {
  return options.noRemoteResolution ?? noRemoteResolutionFromEnv();
}

/**
 * OSV-Scannerに渡す固定引数。ここに無いオプションは一切使わない(ホワイトリスト)
 *
 * pom.xml/requirements.txtの推移的依存はapi.deps.devで解決される(2.4.0で実機確認)。
 * `--data-source native` はスキャン対象pom.xmlの<repositories>に書かれた任意のURLへ
 * 接続するため使わない。既定値の変更に備えてdeps.devを明示する。
 */
const FIXED_SCAN_ARGS = ["scan", "source", "--format", "json", "--data-source", "deps.dev"] as const;
const NO_RESOLVE_ARG = "--no-resolve";

/** 検出済みマニフェストを`--lockfile <形式>:<絶対パス>`の組にする。許可外の形式・相対パスは渡さない */
export function buildProjectTargetArgs(targets: readonly ManifestTarget[]): string[] {
  return targets.flatMap((target) => {
    if (!isManifestFormat(target.format) || !path.isAbsolute(target.path)) {
      throw new Error(`Unsupported manifest target for project scan: ${target.format}:${target.path}`);
    }
    return ["--lockfile", `${target.format}:${target.path}`];
  });
}
const FIXED_ARTIFACT_ARGS = [
  "scan", "source", "--format", "json", "--all-packages", "--no-ignore",
  "--experimental-no-default-plugins", "--experimental-plugins", "java/archive",
] as const;
const FIXED_SBOM_ARGS = [
  "scan", "source", "--format", "json", "--all-packages", "--no-ignore",
  "--experimental-no-default-plugins", "--experimental-plugins", "sbom",
] as const;
export type ScanMode = "project" | "artifact" | "sbom";
const SCAN_ARGS = { project: FIXED_SCAN_ARGS, artifact: FIXED_ARTIFACT_ARGS, sbom: FIXED_SBOM_ARGS };

/** 外部解決を行うのはマニフェストを読むprojectモードだけ(artifact/sbomはOSV照会のみ) */
export function buildOsvScanArgs(mode: ScanMode, noRemoteResolution: boolean): string[] {
  const args: string[] = [...SCAN_ARGS[mode]];
  if (mode === "project" && noRemoteResolution) args.push(NO_RESOLVE_ARG);
  return args;
}

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
  scanArgs: readonly string[],
): Promise<RawScanResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [
      ...scanArgs, ...targetPaths,
    ], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackChildProcess(child);

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
 * 検出済みマニフェストだけをOSV-Scannerでスキャンし、整形済みレポートを返す。
 *
 * @param targets **検出器(detectJavaProject / detectProject)が検出したマニフェスト**
 *   (このレイヤーではスキャン範囲の検証を行わない。ディレクトリは渡さない)
 */
export async function runOsvScan(
  targets: readonly ManifestTarget[],
  options: RunOsvScanOptions = {},
): Promise<ScanReport> {
  if (targets.length === 0) {
    throw new ScanToolError("no_manifest_found", "スキャン対象のマニフェストがありません");
  }
  return parseOsvScanOutput(await runScan(buildProjectTargetArgs(targets), options, "project"));
}

/** Accept only the exact absolute files enumerated by detectJavaArtifacts. */
export async function runOsvArtifactScan(
  artifactPaths: readonly string[],
  options: RunOsvScanOptions = {},
): Promise<unknown> {
  if (artifactPaths.length === 0) {
    throw new ScanToolError("no_scannable_artifacts", "No JAR/WAR archives selected");
  }
  return runScan(artifactPaths, options, "artifact");
}

/** Scan only the private, validated snapshot prepared by handleScanSbom. */
export async function runOsvSbomScan(snapshotPath: string, options: RunOsvScanOptions = {}): Promise<unknown> {
  return runScan([snapshotPath], options, "sbom");
}

/** targetArgs: projectモードは`--lockfile`の組、artifact/sbomモードは検証済みの絶対パス */
async function runScan(
  targetArgs: readonly string[],
  options: RunOsvScanOptions,
  mode: ScanMode,
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
    return await runOsvScanUnguarded(targetArgs, options, mode);
  } finally {
    activeScans--;
  }
}

async function runOsvScanUnguarded(
  targetArgs: readonly string[],
  options: RunOsvScanOptions,
  mode: ScanMode,
): Promise<unknown> {
  const binaryPath = options.binaryPath ?? (await resolveOsvScannerBinary());
  const result = await execOsvScanner(
    binaryPath,
    targetArgs,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    buildOsvScanArgs(mode, isRemoteResolutionDisabled(options)),
  );

  if (result.exitCode === EXIT_NO_PACKAGES && mode === "project") {
    throw new ScanToolError(
      "no_packages_found",
      "OSV-Scannerがスキャン対象のパッケージを検出できませんでした(マニフェストに依存関係が定義されているか確認してください)",
      result.stderr,
    );
  }

  if (mode !== "project" && result.exitCode === EXIT_NO_PACKAGES && result.stdout.trim() === "") {
    return { results: [] };
  }
  if (result.exitCode !== EXIT_NO_VULNS && result.exitCode !== EXIT_VULNS_FOUND &&
      !(mode !== "project" && result.exitCode === EXIT_NO_PACKAGES)) {
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
