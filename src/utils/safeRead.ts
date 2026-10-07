/**
 * スキャン対象ファイルの安全な読み込み(検査と読み込みの不一致を起こさないための共通部品)。
 *
 * - `O_NOFOLLOW`で開き、末尾がシンボリックリンクに差し替えられたファイルを読まない
 * - `O_NONBLOCK`で開き、名前付きパイプ(FIFO)等で処理が止まらないようにする。開いた実体を
 *   `fstat`し、通常のファイル以外は読まない
 * - サイズの上限付きで読む
 * - 読み終えた後、パスを解決し直して境界の内側にあることと、開いた実体と同じファイル
 *   (デバイス番号・inodeが一致)であることを確認する。途中のディレクトリをシンボリックリンクに
 *   差し替えて範囲外を読ませ、確認前に戻す、といった差し替えを検出する
 *
 * 呼び出し側は読んだ内容(またはそのコピー)だけを使い、元のパスを他のプロセスに渡さない。
 * (ハードリンクはパスとしては境界の内側にあるため区別しない)
 */

import { constants, type Stats } from "node:fs";
import { open, realpath, rm, stat } from "node:fs/promises";
import { isInsideDir } from "./projectWalk.js";

export type SafeReadFailure = "not_found" | "not_regular" | "too_large" | "outside" | "changed";

export interface SafeReadError {
  ok: false;
  failure: SafeReadFailure;
  message: string;
}

export type SafeReadResult = { ok: true; bytes: Buffer } | SafeReadError;

export interface SafeReadOptions {
  maxBytes: number;
  /** 解決済みの絶対パス。指定時、読んだファイルがこの配下になければ失敗 */
  boundary?: string;
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

const MESSAGES: Record<SafeReadFailure, string> = {
  not_found: "ファイルを開けません",
  not_regular: "通常のファイルではありません(名前付きパイプ・デバイス等)",
  too_large: "サイズが上限を超えています",
  outside: "スキャン範囲の外のファイルです",
  changed: "検査中にファイルが差し替えられました",
};

function failure(kind: SafeReadFailure): SafeReadError {
  return { ok: false, failure: kind, message: MESSAGES[kind] };
}

/**
 * 読み終えた後の確認: パスを解決し直し、境界の内側で、開いた実体と同じファイルか。
 * 問題が無ければnull、あれば失敗の種類を返す。
 */
export async function verifyOpenedFile(
  filePath: string,
  opened: Pick<Stats, "dev" | "ino">,
  boundary: string | undefined,
): Promise<SafeReadFailure | null> {
  let resolved: string;
  let current: Stats;
  try {
    resolved = await realpath(filePath);
    current = await stat(resolved);
  } catch {
    return "changed";
  }
  if (current.dev !== opened.dev || current.ino !== opened.ino) return "changed";
  if (boundary !== undefined && !isInsideDir(boundary, resolved)) return "outside";
  return null;
}

/**
 * 通常のファイルを上限付きで安全にdestへコピーする(大きなJAR/WAR向けに全体をメモリに載せない)。
 * destは新規作成(既存なら失敗)・所有者のみ読み書き可。失敗時はdestを削除する。
 * 成功時はコピーしたバイト数を返す。
 */
export async function copyRegularFile(
  filePath: string,
  dest: string,
  options: SafeReadOptions,
): Promise<{ ok: true; bytes: number } | SafeReadError> {
  let source;
  try {
    source = await open(filePath, OPEN_FLAGS);
  } catch {
    return failure("not_found");
  }
  let total = 0;
  let result: SafeReadFailure | null = null;
  try {
    const info = await source.stat();
    if (!info.isFile()) result = "not_regular";
    else if (info.size > options.maxBytes) result = "too_large";
    else {
      const target = await open(dest, "wx", 0o600);
      try {
        const chunk = Buffer.alloc(1024 * 1024);
        while (true) {
          const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > options.maxBytes) {
            result = "too_large";
            break;
          }
          // writeは要求より少ないバイト数で戻りうるため、チャンクを書き切るまで繰り返す
          for (let written = 0; written < bytesRead; ) {
            const { bytesWritten } = await target.write(chunk, written, bytesRead - written);
            if (bytesWritten <= 0) throw new Error("short write");
            written += bytesWritten;
          }
        }
      } finally {
        await target.close();
      }
      if (result === null) result = await verifyOpenedFile(filePath, info, options.boundary);
    }
  } catch {
    result = "not_found";
  } finally {
    await source.close();
  }
  if (result !== null) {
    await rm(dest, { force: true });
    return failure(result);
  }
  return { ok: true, bytes: total };
}

/** 通常のファイルを上限付きで安全に読む */
export async function readRegularFile(filePath: string, options: SafeReadOptions): Promise<SafeReadResult> {
  let handle;
  try {
    handle = await open(filePath, OPEN_FLAGS);
  } catch {
    return failure("not_found");
  }
  let info: Stats;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    info = await handle.stat();
    if (!info.isFile()) return failure("not_regular");
    if (info.size > options.maxBytes) return failure("too_large");
    const chunk = Buffer.alloc(Math.min(1024 * 1024, options.maxBytes + 1));
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, options.maxBytes - total + 1), null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > options.maxBytes) return failure("too_large");
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
  } catch {
    return failure("not_found");
  } finally {
    await handle.close();
  }
  const problem = await verifyOpenedFile(filePath, info, options.boundary);
  if (problem !== null) return failure(problem);
  return { ok: true, bytes: Buffer.concat(chunks, total) };
}
