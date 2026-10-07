/**
 * pom.xmlの親POM(`<parent><relativePath>`)が、スキャン許可ルート(OSV_MCP_ALLOWED_ROOT)の外を
 * 参照していないかを検証する。
 *
 * osv-scanner v2.4.0の実機確認(2026-10-07):
 * - `<relativePath>`の指す親POMを読み、その依存を結果に含める(`--no-resolve`でも同じ)。親の親もたどる
 * - `<relativePath>`省略時はMavenの既定値`../pom.xml`を参照する。ディレクトリを指す場合はその中のpom.xml
 * - `<relativePath/>`(空)はローカルを参照しない。親のGAVが一致しない場合も読まない
 *
 * サブモジュールのスキャンで親POMを読むのは正当な動作のため、境界はプロジェクトディレクトリではなく
 * 許可ルートとする(未設定時は任意のパスをスキャンできる状態のため検証しない)。GAVの一致は判定が
 * 複雑(親から引き継がれる)なため確認せず、許可ルートの外に参照先のファイルがあれば安全側に除外する。
 */

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isInsideDir } from "./projectWalk.js";

const MAX_POM_BYTES = 10 * 1024 * 1024;
const MAX_PARENT_DEPTH = 10;
const DEFAULT_RELATIVE_PATH = "../pom.xml";

/** 親POMのrelativePath。null=親なし / ""=ローカルを参照しない / undefined=解釈できない */
function parentRelativePath(xml: string): string | null | undefined {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, "");
  const parent = /<parent(?:\s[^>]*)?>([\s\S]*?)<\/parent\s*>/.exec(withoutComments);
  if (!parent) return null;
  const body = parent[1]!;
  if (/<relativePath\s*\/>/.test(body)) return "";
  const relative = /<relativePath(?:\s[^>]*)?>([\s\S]*?)<\/relativePath\s*>/.exec(body);
  if (!relative) return DEFAULT_RELATIVE_PATH;
  const value = relative[1]!.trim();
  // プロパティ参照・CDATA・実体参照は評価できない
  if (/[$<&]/.test(value)) return undefined;
  return value;
}

/** 参照先を実ファイルに解決する。存在しなければnull(osv-scannerもローカルからは読まない) */
async function resolveParentFile(fromPom: string, relativePath: string): Promise<string | null> {
  let candidate = path.resolve(path.dirname(fromPom), relativePath);
  try {
    if ((await stat(candidate)).isDirectory()) candidate = path.join(candidate, "pom.xml");
    return await realpath(candidate);
  } catch {
    return null;
  }
}

/**
 * 親POMの連鎖が許可ルートの外を参照していれば、除外理由を返す。問題なければnull。
 * @param pomPath 検出済みのpom.xmlの絶対パス
 * @param allowedRootReal 解決済みの許可ルート。未設定なら検証しない
 */
export async function pomParentOutsideRoot(pomPath: string, allowedRootReal: string | undefined): Promise<string | null> {
  if (allowedRootReal === undefined) return null;
  let current = pomPath;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    let xml: string;
    try {
      if ((await stat(current)).size > MAX_POM_BYTES) return `親POMの確認でサイズ上限を超えるpom.xmlがあります(${path.basename(current)})`;
      xml = await readFile(current, "utf8");
    } catch {
      return null; // 読めないファイルはosv-scannerも読めない
    }
    const relativePath = parentRelativePath(xml);
    if (relativePath === null || relativePath === "") return null;
    if (relativePath === undefined) {
      return "親POMのrelativePathを評価できないため(プロパティ参照等)、許可ルート内か確認できません";
    }
    const parentFile = await resolveParentFile(current, relativePath);
    if (parentFile === null) return null;
    if (!isInsideDir(allowedRootReal, parentFile)) {
      return (
        `親POM(relativePath: ${relativePath})が許可ルート(OSV_MCP_ALLOWED_ROOT)の外を参照しているため、スキャン対象から外しました` +
        "(親のGAVが一致しなければosv-scannerは読みませんが、境界の外のため確認せず除外します)"
      );
    }
    current = parentFile;
  }
  return `親POMの連鎖が上限(${MAX_PARENT_DEPTH}段)を超えています`;
}
