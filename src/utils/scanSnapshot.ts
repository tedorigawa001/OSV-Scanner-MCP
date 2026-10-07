/**
 * スキャン対象のスナップショット: osv-scannerには元のファイルを渡さず、安全に1回だけ読んだ内容を
 * 専用の一時ディレクトリ(所有者のみアクセス可、終了時に削除)へコピーしてスキャンする。
 *
 * - 検査(境界・親POMの検証)はコピーの内容に対して行うため、検査とosv-scannerの読み込みの間に
 *   元のファイルを差し替えても結果に影響しない
 * - 親POMは元の配置をスナップショット内に再現してコピーする。osv-scannerが相対パスで親をたどっても、
 *   見つかるのは検証してコピーしたファイルだけになる(解析が多少ずれても範囲外は読まれず、
 *   最悪でも親が見つからないだけ)
 * - `..`を重ねた参照でスナップショットの外(本物のファイルシステム)に出る親POMは除外する
 * - コピーの合計サイズに上限を設ける
 */

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import type { ManifestTarget } from "./manifestFormats.js";
import { decodePomBytes, parentRelativePath } from "./pomParent.js";
import { isInsideDir } from "./projectWalk.js";
import { copyRegularFile, type SafeReadError } from "./safeRead.js";

const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_POM_BYTES = 10 * 1024 * 1024;
const MAX_PARENT_DEPTH = 10;

export interface SnapshotSkip {
  /** 元のファイルの絶対パス */
  path: string;
  reason: string;
  /** outside_allowed_root: 親POMの連鎖が許可ルートの外を参照 / unreadable: 安全に読めない・解釈できない */
  kind: "outside_allowed_root" | "unreadable";
}

export class ScanSnapshot {
  private readonly copied = new Map<string, string>();
  private readonly parentCache = new Map<string, string | null | undefined>();
  private used = 0;
  private generated = 0;

  private constructor(
    readonly dir: string,
    private readonly maxTotalBytes: number,
  ) {}

  static async create(maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES): Promise<ScanSnapshot> {
    const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), "osv-mcp-snap-"));
    return new ScanSnapshot(dir, maxTotalBytes);
  }

  /** 再現した配置のルート(実際のファイルシステムの"/"に相当) */
  get treeRoot(): string {
    return path.join(this.dir, "tree");
  }

  /** 元の絶対パスに対応する、スナップショット内のパス */
  mirror(absolute: string): string {
    const { root } = path.parse(absolute);
    return path.join(this.treeRoot, root.replace(/[^A-Za-z0-9]/g, "_"), path.relative(root, absolute));
  }

  /** 元のファイルを安全にコピーする。同じファイルは1回だけコピーする */
  async copy(absolute: string, boundary: string | undefined, maxBytes = Infinity): Promise<{ ok: true; path: string } | SafeReadError> {
    const existing = this.copied.get(absolute);
    if (existing !== undefined) return { ok: true, path: existing };
    const remaining = this.maxTotalBytes - this.used;
    const dest = this.mirror(absolute);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const result = await copyRegularFile(absolute, dest, { maxBytes: Math.min(maxBytes, remaining), boundary });
    if (!result.ok) {
      if (result.failure === "too_large" && remaining < maxBytes) {
        throw new ScanToolError(
          "scan_input_too_large",
          `スキャン対象ファイルの合計サイズが上限(${this.maxTotalBytes}バイト)を超えるため、スキャンを中止しました。対象を絞って再実行してください`,
        );
      }
      return result;
    }
    this.used += result.bytes;
    this.copied.set(absolute, dest);
    return { ok: true, path: dest };
  }

  /** 本サーバーが生成した内容(requirements.txtの正規化コピー等)を書く */
  async writeGenerated(content: string): Promise<string> {
    const dir = path.join(this.dir, "generated");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${this.generated++}.txt`);
    await writeFile(file, content, { mode: 0o600, flag: "wx" });
    return file;
  }

  /** コピー済みのpom.xmlの親参照(同じファイルは1回だけ解析する) */
  async parentOf(copyPath: string): Promise<string | null | undefined> {
    if (this.parentCache.has(copyPath)) return this.parentCache.get(copyPath);
    const xml = decodePomBytes(await readFile(copyPath));
    const relativePath = xml === null ? undefined : parentRelativePath(xml);
    this.parentCache.set(copyPath, relativePath);
    return relativePath;
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

const UNPARSEABLE =
  "親POMの指定を確実に解釈できないため(親要素の重複、CDATA・DOCTYPE、プロパティ参照、UTF-8以外の文字コード等)、" +
  "許可ルート内か確認できずスキャン対象から外しました";

interface PomContext {
  projectDir: string;
  allowedRootReal: string | undefined;
}

/**
 * pom.xmlと親POMの連鎖をスナップショットへコピーする。
 * 許可ルート設定時、連鎖が許可ルートの外・スナップショットの外を参照するか、解釈できない場合は除外理由を返す。
 */
async function snapshotPom(
  snapshot: ScanSnapshot,
  pomPath: string,
  context: PomContext,
): Promise<{ ok: true; path: string } | { ok: false; reason: string; kind: SnapshotSkip["kind"] }> {
  const first = await snapshot.copy(pomPath, context.projectDir, MAX_POM_BYTES);
  if (!first.ok) return { ok: false, reason: first.message, kind: "unreadable" };
  const restricted = context.allowedRootReal !== undefined;
  let current = pomPath;
  let currentCopy = first.path;

  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const relativePath = await snapshot.parentOf(currentCopy);
    if (relativePath === null || relativePath === "") return first;
    if (relativePath === undefined) return restricted ? { ok: false, reason: UNPARSEABLE, kind: "unreadable" } : first;

    // Goのfilepath.Joinと同じ規則で結合する(絶対パスも連結し、..はルートで止まる)
    const inCopy = path.join(path.dirname(currentCopy), relativePath);
    if (!isInsideDir(snapshot.treeRoot, inCopy)) {
      // ..を重ねるとスナップショットの外(本物のファイルシステム)に届くため、コピーではなく元のファイルが読まれる
      return restricted
        ? { ok: false, reason: `親POM(relativePath: ${relativePath})の参照がスキャン範囲の外に出るため、スキャン対象から外しました`, kind: "outside_allowed_root" }
        : first;
    }
    let candidate = path.join(path.dirname(current), relativePath);
    try {
      if ((await stat(candidate)).isDirectory()) candidate = path.join(candidate, "pom.xml");
    } catch {
      return first; // 参照先が無い: スナップショット内にも無いため、osv-scannerは親を読まない
    }
    const parent = await snapshot.copy(candidate, context.allowedRootReal, MAX_POM_BYTES);
    if (!parent.ok) {
      if (parent.failure === "outside") {
        return {
          ok: false,
          reason:
            `親POM(relativePath: ${relativePath})が許可ルート(OSV_MCP_ALLOWED_ROOT)の外を参照しているため、スキャン対象から外しました` +
            "(親のGAVが一致しなければosv-scannerは読みませんが、境界の外のため確認せず除外します)",
          kind: "outside_allowed_root",
        };
      }
      if (parent.failure === "changed") return { ok: false, reason: `親POMの${parent.message}`, kind: "unreadable" };
      return first; // 読めない・通常のファイルでない等: コピーしないため、osv-scannerも読まない
    }
    current = candidate;
    currentCopy = parent.path;
  }
  return restricted ? { ok: false, reason: `親POMの連鎖が上限(${MAX_PARENT_DEPTH}段)を超えています`, kind: "unreadable" } : first;
}

/**
 * 検出済みのマニフェストをスナップショットへコピーし、osv-scannerに渡す対象(コピー)を返す。
 * コピーできない・除外すべきものはskippedに理由付きで返す。
 */
export async function snapshotManifests(
  snapshot: ScanSnapshot,
  targets: readonly ManifestTarget[],
  context: PomContext,
): Promise<{ targets: ManifestTarget[]; skipped: SnapshotSkip[] }> {
  const copies: ManifestTarget[] = [];
  const skipped: SnapshotSkip[] = [];
  for (const target of targets) {
    if (target.format === "pom.xml") {
      const result = await snapshotPom(snapshot, target.path, context);
      if (result.ok) copies.push({ path: result.path, format: target.format });
      else skipped.push({ path: target.path, reason: result.reason, kind: result.kind });
      continue;
    }
    const result = await snapshot.copy(target.path, context.projectDir);
    if (result.ok) copies.push({ path: result.path, format: target.format });
    else skipped.push({ path: target.path, reason: result.message, kind: "unreadable" });
  }
  return { targets: copies, skipped };
}
