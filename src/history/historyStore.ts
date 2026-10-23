/**
 * スキャンの実行履歴の保存(docs/DESIGN_TODO.md「スキャンの実行履歴」)。
 *
 * - 既定は無効。OSV_MCP_HISTORY=1の場合だけ記録する(社内のパッケージ名・パスをディスクに残すため)
 * - 保存先: OSV_MCP_HISTORY_DIR(絶対パス) → $XDG_STATE_HOME/osv-scanner-mcp/history → ~/.local/state/osv-scanner-mcp/history
 * - 1回=1ファイル(`<UTC時刻>-<乱数>.json`)。一時ファイルに書いてからrenameする(複数のプロセスが同時に書いても混ざらない)
 * - ディレクトリは0700・ファイルは0600。シンボリックリンク・他人の所有するディレクトリには書かない
 * - 履歴のファイルは本サーバー以外も書き換えられる前提で、読むときはサイズの上限付きで安全に読み、形式を確かめる
 */

import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRegularFile } from "../utils/safeRead.js";

export const HISTORY_ENV = "OSV_MCP_HISTORY";
export const HISTORY_DIR_ENV = "OSV_MCP_HISTORY_DIR";
export const HISTORY_MAX_ENTRIES_ENV = "OSV_MCP_HISTORY_MAX_ENTRIES";

const DEFAULT_MAX_ENTRIES = 500;
const MAX_MAX_ENTRIES = 5_000;
/** 履歴全体の合計サイズの上限 */
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** 1件の上限。超える場合は差分用の識別子を省いて要約だけ記録する */
export const MAX_RECORD_BYTES = 1024 * 1024;
/** scan_historyで1回に読む量の合計の上限 */
const MAX_READ_TOTAL_BYTES = 64 * 1024 * 1024;
/** 書き込みに失敗して残った一時ファイルを消すまでの時間 */
const STALE_TMP_MS = 60 * 60 * 1000;

const RECORD_NAME = /^\d{8}T\d{9}Z-[0-9a-f]{12}\.json$/;
const TMP_NAME = /^\.\d{8}T\d{9}Z-[0-9a-f]{12}\.json\.tmp$/;

export interface HistoryConfig {
  enabled: boolean;
  dir: string;
  maxEntries: number;
  maxTotalBytes: number;
}

function truthy(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** 既定の保存先(XDG Base Directoryの状態の置き場所) */
export function defaultHistoryDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME?.trim();
  const base = state !== undefined && state !== "" && path.isAbsolute(state) ? state : path.join(os.homedir(), ".local", "state");
  return path.join(base, "osv-scanner-mcp", "history");
}

export function historyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HistoryConfig {
  const explicit = env[HISTORY_DIR_ENV]?.trim();
  const dir = explicit !== undefined && explicit !== "" && path.isAbsolute(explicit) ? path.resolve(explicit) : defaultHistoryDir(env);
  const requested = Number.parseInt(env[HISTORY_MAX_ENTRIES_ENV]?.trim() ?? "", 10);
  const maxEntries = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_MAX_ENTRIES) : DEFAULT_MAX_ENTRIES;
  return { enabled: truthy(env[HISTORY_ENV]), dir, maxEntries, maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES };
}

/** 設定が無効なまま読み書きしようとした場合や、保存先が安全でない場合の理由 */
export class HistoryUnavailableError extends Error {}

/**
 * 保存先を作成し、安全か確かめる: 実体のディレクトリ(シンボリックリンクでない)で、所有者が自分。
 * 権限が広ければ0700に絞る。読み書きには解決後の実パスを使う(読み込みの境界の確認が実パスで行われるため)
 */
export async function ensureHistoryDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new HistoryUnavailableError(`The history directory is not a regular directory: ${dir}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new HistoryUnavailableError(`The history directory is not owned by the current user: ${dir}`);
  }
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
  return realpath(dir);
}

/** ファイル名に使うUTC時刻(並べ替えで時刻順になる) */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

export function newRecordId(date = new Date()): string {
  return `${stamp(date)}-${randomBytes(6).toString("hex")}`;
}

/** 1件を書く。一時ファイルに書いてからrenameし、古いものを削除する */
export async function writeHistoryRecord(config: HistoryConfig, id: string, content: string): Promise<void> {
  const dir = await ensureHistoryDir(config.dir);
  const name = `${id}.json`;
  if (!RECORD_NAME.test(name)) throw new HistoryUnavailableError(`Invalid history record id: ${id}`);
  const tmp = path.join(dir, `.${name}.tmp`);
  await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
  try {
    await rename(tmp, path.join(dir, name));
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await pruneHistory({ ...config, dir });
}

/** 件数・合計サイズの上限を超えた古い記録と、残った一時ファイルを削除する(他のプロセスとの競合は無視する) */
export async function pruneHistory(config: HistoryConfig, now = Date.now()): Promise<void> {
  const names = await readdir(config.dir);
  for (const name of names.filter((n) => TMP_NAME.test(n))) {
    const file = path.join(config.dir, name);
    const info = await lstat(file).catch(() => null);
    if (info !== null && info.isFile() && now - info.mtimeMs > STALE_TMP_MS) await unlink(file).catch(() => undefined);
  }
  const records = names.filter((n) => RECORD_NAME.test(n)).sort(); // 古い順
  const remove = new Set(records.slice(0, Math.max(0, records.length - config.maxEntries)));
  let total = 0;
  // 新しい順に合計し、上限を超えた分より古いものを削除する
  for (const name of [...records].reverse()) {
    if (remove.has(name)) continue;
    const info = await stat(path.join(config.dir, name)).catch(() => null);
    if (info === null) continue;
    total += info.size;
    if (total > config.maxTotalBytes) remove.add(name);
  }
  for (const name of remove) await unlink(path.join(config.dir, name)).catch(() => undefined);
}

export interface StoredRecord {
  id: string;
  data: unknown;
}

/**
 * 記録を新しい順に読む。読めない・大きすぎる・JSONでないファイル、読み込みの合計の上限を超えた分はskippedに数える
 */
export async function readHistoryRecords(config: HistoryConfig): Promise<{ records: StoredRecord[]; skipped: number }> {
  const dir = await ensureHistoryDir(config.dir);
  const names = (await readdir(dir)).filter((n) => RECORD_NAME.test(n)).sort().reverse().slice(0, config.maxEntries);
  const records: StoredRecord[] = [];
  let skipped = 0;
  let remaining = MAX_READ_TOTAL_BYTES;
  for (const name of names) {
    if (remaining <= 0) {
      skipped++;
      continue;
    }
    const read = await readRegularFile(path.join(dir, name), { maxBytes: Math.min(MAX_RECORD_BYTES, remaining), boundary: dir });
    if (!read.ok) {
      if (read.failure !== "not_found") skipped++; // 読んでいる間に削除されたものは数えない
      continue;
    }
    remaining -= read.bytes.length;
    try {
      records.push({ id: name.slice(0, -".json".length), data: JSON.parse(read.bytes.toString("utf8")) as unknown });
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}
