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
 * 終了コード(2.4.0・2.7.0で実機確認):
 *   0 = スキャン成功・脆弱性なし / 1 = スキャン成功・脆弱性あり / 128 = 対象パッケージなし
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import { isManifestFormat, type ManifestTarget,type ManifestFormat } from "../utils/manifestFormats.js";
import { trackChildProcess } from "../utils/processCleanup.js";
import { resolveOsvScannerBinary } from "./binaryManager.js";
import { parseOsvScanOutput, type ScanReport } from "./scanReport.js";
import {offlineEnabled,type OfflineOptions} from './offline.js';
import {captureOfflineDatabases,offlineMetadata} from './offlineCache.js';
import {readRegularFile} from '../utils/safeRead.js';

export interface RunOsvScanOptions extends OfflineOptions {
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
  if (offlineEnabled(options)) return true;
  return options.noRemoteResolution ?? noRemoteResolutionFromEnv();
}

/**
 * OSV-Scannerに渡す固定引数。ここに無いオプションは一切使わない(ホワイトリスト)
 *
 * requirements.txtの推移的依存はapi.deps.devで解決する。
 * Mavenのenricherはdeps.dev指定時もリモート親POMが宣言した取得先を登録する。
 * Mavenだけを無効にして、ローカルPOMのextractorと他形式の解決を保持する。
 */
const FIXED_SCAN_ARGS = ["scan", "source", "--format", "json", "--data-source", "deps.dev"] as const;
const NO_RESOLVE_ARG = "--no-resolve";
const FORMAT_ECOSYSTEM:Record<ManifestFormat,string>={
 'pom.xml':'Maven','gradle.lockfile':'Maven','buildscript-gradle.lockfile':'Maven',
 'package-lock.json':'npm','yarn.lock':'npm','pnpm-lock.yaml':'npm','bun.lock':'npm',
 'poetry.lock':'PyPI','uv.lock':'PyPI','Pipfile.lock':'PyPI','pdm.lock':'PyPI','requirements.txt':'PyPI',
 'go.mod':'Go','Cargo.lock':'crates.io','packages.lock.json':'NuGet','composer.lock':'Packagist',
};

/** 検出済みマニフェストを`--lockfile <形式>:<絶対パス>`の組にする。許可外の形式・相対パスは渡さない */
export function buildProjectTargetArgs(targets: readonly ManifestTarget[]): string[] {
  return targets.flatMap((target) => {
    if (!isManifestFormat(target.format) || !path.isAbsolute(target.path)) {
      throw new Error(`Unsupported manifest target for project scan: ${target.format}:${target.path}`);
    }
    return ["--lockfile", `${target.format}:${target.path}`];
  });
}
/**
 * `--experimental-`のフラグは2.7.0で非推奨(stderrに警告。新名は`--x-`)だが、新名は2.4.0では未定義でexit 127になる。
 * OSV_SCANNER_PATH・PATH上の古い版でも動くよう、両方の版で使える旧名を使う(2026-10-15 実機確認)
 */
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
export function buildOsvScanArgs(mode: ScanMode, noRemoteResolution: boolean, offline=false, scansPom=false): string[] {
  const args: string[] = [...SCAN_ARGS[mode]];
  if (mode === "project" && noRemoteResolution) args.push(NO_RESOLVE_ARG);
  // The legacy spelling also works with OSV-Scanner 2.4.0.
  if (mode === "project" && scansPom && !noRemoteResolution && !offline) {
    args.push("--experimental-disable-plugins", "transitivedependency/pomxml");
  }
  if (offline) {
    args.push('--offline');
    if (!args.includes(NO_RESOLVE_ARG)) args.push(NO_RESOLVE_ARG);
  }
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<RawScanResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [
      ...scanArgs, ...targetPaths,
    ], {
      shell: false,
      env,
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
          `OSV-Scanner did not complete within ${Math.round(timeoutMs / 1000)} seconds`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(
          new ScanToolError(
            "output_too_large",
            `The OSV-Scanner output exceeded the size limit (${maxOutputBytes} bytes)`,
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
      fail(new ScanToolError("scan_failed", `Could not start OSV-Scanner: ${error.message}`));
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
    throw new ScanToolError("no_manifest_found", "No manifest to scan");
  }
  if(offlineEnabled(options)){
    let remaining=64*1024*1024;
    for(const target of targets){
      const r=await readRegularFile(target.path,{maxBytes:Math.min(16*1024*1024,remaining)});
      if(!r.ok)throw new ScanToolError('scan_failed','Offline lockfile preflight failed: unreadable or oversized input');
      remaining-=r.bytes.length;
      // The native offline matcher does not query commits. Refuse VCS inputs rather than silently omit them.
      if(/git\+|git:\/\/|ssh:\/\/|git@|github:|gitlab:|bitbucket:|\.git#|\bgit["']?\s*[:=]|https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[^\s"']+#/i.test(r.bytes.toString('utf8'))){
        throw new ScanToolError('scan_failed','Offline mode cannot verify Git/commit dependencies in this lockfile. Use a registry-only lockfile or scan online');
      }
    }
  }
  return parseOsvScanOutput(await runScan(buildProjectTargetArgs(targets), options, "project",
    [...new Set(targets.map(t=>FORMAT_ECOSYSTEM[t.format]))], targets.some(target => target.format === "pom.xml")));
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
export async function runOsvSbomScan(snapshotPath: string, options: RunOsvScanOptions = {}, requiredEcosystems?: readonly string[]): Promise<unknown> {
  return runScan([snapshotPath], options, "sbom", requiredEcosystems);
}

/** targetArgs: projectモードは`--lockfile`の組、artifact/sbomモードは検証済みの絶対パス */
async function runScan(
  targetArgs: readonly string[],
  options: RunOsvScanOptions,
  mode: ScanMode,
  ecosystems?:readonly string[],
  scansPom=false,
): Promise<unknown> {
  return withScanCapacity(options, () => runOsvScanUnguarded(targetArgs, options, mode, ecosystems, scansPom));
}

/** Shared expensive-work capacity. Offline record searches reserve before copying/reading databases too. */
export async function withScanCapacity<T>(options: Pick<RunOsvScanOptions, 'maxConcurrentScans'>, work: () => Promise<T>): Promise<T> {
  const limit = options.maxConcurrentScans ?? maxConcurrentScansFromEnv();
  if (activeScans >= limit) {
    throw new ScanToolError(
      "too_many_concurrent_scans",
      `The concurrent scan limit (${limit}) has been reached (${activeScans} running). Try again after the running scans finish`,
    );
  }
  activeScans++;
  try {
    return await work();
  } finally {
    activeScans--;
  }
}

async function runOsvScanUnguarded(
  targetArgs: readonly string[],
  options: RunOsvScanOptions,
  mode: ScanMode,
  ecosystems?:readonly string[],
  scansPom=false,
): Promise<unknown> {
  const offline=offlineEnabled(options);
  const binaryPath = options.binaryPath ?? (await resolveOsvScannerBinary(offline?{...process.env,OSV_MCP_OFFLINE:'1'}:process.env));
  const cache=offline?await captureOfflineDatabases({...options,offline:true},ecosystems??(mode==='artifact'?['Maven']:undefined)):null;
  try {
  const result = await execOsvScanner(
    binaryPath,
    targetArgs,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    buildOsvScanArgs(mode, isRemoteResolutionDisabled(options),offline,scansPom),
    cache?{...process.env,OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY:cache.dir,OSV_SCALIBR_LOCAL_DB_CACHE_DIRECTORY:cache.dir}:process.env,
  );

  if (result.exitCode === EXIT_NO_PACKAGES && mode === "project") {
    throw new ScanToolError(
      "no_packages_found",
      "OSV-Scanner found no packages to scan (check that the manifests declare dependencies)",
      result.stderr,
    );
  }

  if (mode !== "project" && result.exitCode === EXIT_NO_PACKAGES && result.stdout.trim() === "") {
    const empty={results:[]};if(cache)offlineMetadata.set(empty,cache.metadata);return empty;
  }
  if (result.exitCode !== EXIT_NO_VULNS && result.exitCode !== EXIT_VULNS_FOUND &&
      !(mode !== "project" && result.exitCode === EXIT_NO_PACKAGES)) {
    const status =
      result.exitCode !== null ? `exit code ${result.exitCode}` : `signal ${result.signal}`;
    throw new ScanToolError(
      "scan_failed",
      `OSV-Scanner exited abnormally (${status})`,
      result.stderr,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ScanToolError(
      "invalid_output",
      "Could not parse the OSV-Scanner output as JSON",
      result.stdout.slice(0, 1000),
    );
  }
  if(cache){
    if(typeof parsed!=='object'||parsed===null||Array.isArray(parsed))throw new ScanToolError('invalid_output','Invalid offline scanner output');
    offlineMetadata.set(parsed,cache.metadata);
  }
  return parsed;
  }finally{await cache?.cleanup();}
}
