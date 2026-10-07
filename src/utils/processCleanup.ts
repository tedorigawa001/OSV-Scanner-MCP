/**
 * サーバー終了時の後始末: スキャン用の一時ディレクトリ(元のファイルのコピーを含む)と
 * 実行中のosv-scannerプロセスを、サーバーより長く残さない。
 *
 * - 通常はスキャンごとの`finally`で削除するが、SIGTERM等で強制終了されると`finally`は実行されない
 *   (2026-10-07 実機確認: scan_project中にSIGTERMを送るとosv-mcp-snap-*が残った)
 * - そのため作成中の一時ディレクトリと子プロセスをここに登録し、シグナル・stdinの終了・
 *   process.exitの時点で同期的に(fs.rmSync・SIGKILL)片付ける
 * - 前回の異常終了(SIGKILL・電源断等)で残ったものは、起動時に条件を絞って削除する(removeStaleTempDirs)
 */

import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 本サーバーが作る一時ディレクトリの接頭辞(起動時の掃除はこれに完全一致するものだけを対象にする) */
export const SNAPSHOT_DIR_PREFIX = "osv-mcp-snap-";
export const SBOM_DIR_PREFIX = "osv-mcp-sbom-";
/** mkdtempは接頭辞の後ろに6文字の英数字を付ける */
const TEMP_DIR_NAME = /^osv-mcp-(?:snap|sbom)-[A-Za-z0-9]{6}$/;

/**
 * 起動時に削除する残骸の最終更新からの経過時間。別のサーバープロセス(複数のMCPクライアント等)が
 * 使用中のディレクトリを消さないよう、スキャンのタイムアウト(既定120秒)より十分長くとる
 */
export const STALE_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000;

const tempDirs = new Set<string>();
const children = new Set<ChildProcess>();

/** 一時ディレクトリを登録する。戻り値の関数で登録を外す(通常の削除後に呼ぶ) */
export function trackTempDir(dir: string): () => void {
  tempDirs.add(dir);
  return () => { tempDirs.delete(dir); };
}

/** 子プロセスを登録する。終了(close/error)時に自動で登録を外す */
export function trackChildProcess(child: ChildProcess): void {
  children.add(child);
  const untrack = () => { children.delete(child); };
  child.once("close", untrack);
  child.once("error", untrack);
}

/**
 * 登録済みの子プロセスを強制終了し、一時ディレクトリを同期的に削除する。
 * シグナルハンドラ・exitイベントから呼ぶため、非同期処理を使わず例外も外に出さない
 */
export function cleanupSync(): void {
  for (const child of children) {
    // 終了済みのプロセスにはNode側で送らない(PIDの再利用で別プロセスを止めることはない)
    try { child.kill("SIGKILL"); } catch { /* 後始末は続ける */ }
  }
  children.clear();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 他のディレクトリの削除は続ける */ }
  }
  tempDirs.clear();
}

/** テスト用: 登録状況 */
export function trackedCounts(): { tempDirs: number; children: number } {
  return { tempDirs: tempDirs.size, children: children.size };
}

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

let installed = false;

/**
 * 終了時の後始末を登録する(サーバー起動時に1回だけ呼ぶ)。
 * - SIGTERM/SIGINT/SIGHUP: 後始末して慣例の終了コード(128+シグナル番号)で終了
 * - stdinの終了(MCPクライアントがトランスポートを閉じた): 後始末して終了コード0で終了。
 *   応答の送り先が無いため、実行中のスキャンの完了は待たない
 * - process.exit・未捕捉例外による終了: exitイベントで後始末する
 */
export function installShutdownHandlers(stdin: NodeJS.ReadableStream = process.stdin): void {
  if (installed) return;
  installed = true;
  let shuttingDown = false;
  const shutdown = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanupSync();
    process.exit(code);
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => shutdown(128 + (os.constants.signals[signal] ?? 0)));
  }
  stdin.once("end", () => shutdown(0));
  stdin.once("close", () => shutdown(0));
  process.on("exit", cleanupSync);
}

/**
 * 前回の異常終了で残った一時ディレクトリを削除し、削除した数を返す。次の条件をすべて満たすものだけが対象:
 * - 名前が本サーバーの接頭辞+mkdtempの6文字に完全一致する
 * - シンボリックリンクではなく実体のディレクトリ(lstatで判定し、リンクはたどらない)
 * - 所有者が現在のユーザー
 * - 最終更新からSTALE_TEMP_DIR_AGE_MS以上経過している
 *
 * 一時ディレクトリは通常スティッキービット付きのため、自分が所有するエントリを他のユーザーが
 * 判定と削除の間に差し替えることはできない。中のシンボリックリンクはrmがリンク自体を消すだけでたどらない。
 * getuidの無い環境(Windows)では所有者を確認できないため何もしない
 */
export async function removeStaleTempDirs(
  options: { tmpRoot?: string; now?: number; maxAgeMs?: number } = {},
): Promise<number> {
  if (typeof process.getuid !== "function") return 0;
  const uid = process.getuid();
  const root = options.tmpRoot ?? (await realpath(os.tmpdir()));
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? STALE_TEMP_DIR_AGE_MS;
  let removed = 0;
  for (const name of await readdir(root)) {
    if (!TEMP_DIR_NAME.test(name)) continue;
    const dir = path.join(root, name);
    try {
      const stats = await lstat(dir);
      if (!stats.isDirectory() || stats.uid !== uid || now - stats.mtimeMs < maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // 消えた・読めないものは対象外(他のディレクトリの掃除は続ける)
    }
  }
  return removed;
}
