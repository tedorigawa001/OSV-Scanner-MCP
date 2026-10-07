/**
 * requirements.txtの解析と、osv-scannerに渡す検証済みコピーの内容の生成(pipは使わない)。
 *
 * 元のファイルはosv-scannerに渡さない。osv-scannerは取り込み指定を独自に正規化してたどる
 * (`- r ../x.txt` のような空白入りも取り込みとして扱い、スキャン対象の外のファイルを読む)ため、
 * 事前解析との解釈のずれがそのまま境界の迂回になる。そこで、ここで解釈できた依存の行だけを
 * `名前==版` 等の単純な形に正規化して返し、呼び出し側がそれを専用コピーに書いてスキャンする。
 * コピーには取り込み・オプションを一切含めないため、osv-scannerがたどれる参照は存在しない。
 *
 * osv-scanner v2.4.0の実機確認(2026-10-07):
 * - `==` / `===` はその版をスキャンする。`>=X` / `~=X` は下限Xを使用中の版とみなす
 * - `>` `<` `!=` `==1.*` 範囲の組み合わせ・版なしは空の版になり、結果から消える
 * - `-r` はたどるが、`--requirement` / `-c` はたどらない
 *
 * 取り込み(`-r` / `--requirement`)は、プロジェクトディレクトリ内の取り込み先だけをここで展開する。
 * 外・存在しない・URL・上限超過の取り込み、制約ファイル(`-c`)、解釈できない行は、
 * スキャンされない参照として報告する(黙って無視しない)。
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { isInsideDir } from "./projectWalk.js";
import { readRegularFile, capitalizeReason } from "./safeRead.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_INCLUDE_DEPTH = 5;
const MAX_FILES = 50;

export type RequirementKind = "unpinned" | "range" | "lower_bound";

/** スキャンされない、または版が推測される依存の行 */
export interface RequirementIssue {
  /** 行を含むファイルの絶対パス */
  file: string;
  line: number;
  name: string;
  specifier: string;
  kind: RequirementKind;
}

/** スキャンされない行(-e・URL・パス指定・展開しなかった取り込み・解釈できない構文など) */
export interface RequirementReference {
  file: string;
  line: number;
  text: string;
  reason: string;
}

export interface LowerBound {
  /** PEP 503で正規化した名前 */
  name: string;
  version: string;
}

export type RequirementsAnalysis =
  | {
      ok: true;
      /** 専用コピーに書く正規化済みの行(`名前==版` / `名前>=版` / `名前~=版`) */
      entries: string[];
      issues: RequirementIssue[];
      references: RequirementReference[];
      lowerBounds: LowerBound[];
    }
  | { ok: false; reason: string };

/** PEP 503の名前正規化(小文字化し、`-_.`の連続を`-`にする) */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

// osv-scannerは`-`の後の空白も許して取り込みとみなすため、こちらも空白を許して認識する
const INCLUDE_REQUIREMENT = /^(?:-\s*r|--\s*requirement)(?:\s*=\s*|\s*)(\S.*)$/;
const INCLUDE_CONSTRAINT = /^(?:-\s*c|--\s*constraint)(?:\s*=\s*|\s*)(\S.*)$/;
const EDITABLE = /^(?:-\s*e|--\s*editable)(?:\s|=|$)/;
/** 依存の解決先や取得方法に関するオプション。スキャン対象には影響しない(deps.devモードでは接続しない) */
const HARMLESS_OPTION = /^(?:-i|--index-url|--extra-index-url|-f|--find-links|--trusted-host|--pre|--no-binary|--only-binary|--prefer-binary|--require-hashes|--no-index|--use-feature)(?:\s|=|$)/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const NAME_AND_SPEC = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/;
const SPEC = /^(===|==|~=|!=|>=|<=|>|<)\s*([^\s,]+)$/;
/** コピーに書く版。想定外の文字を含む版は書かない(解釈のずれを持ち込まない) */
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+!-]*$/;

/** 行継続を結合し、コメントを除いた論理行を返す(行番号は論理行の先頭) */
function logicalLines(text: string): { line: number; content: string }[] {
  const result: { line: number; content: string }[] = [];
  const physical = text.split(/\r?\n/);
  let buffer = "";
  let start = 0;
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i]!;
    if (buffer === "") start = i + 1;
    if (raw.endsWith("\\")) {
      buffer += raw.slice(0, -1) + " ";
      continue;
    }
    buffer += raw;
    flush();
  }
  flush(); // 行継続で終わるファイル
  return result;

  function flush(): void {
    // 行頭または空白の後の#以降はコメント(URL内の#egg=等は残る)
    const content = buffer.replace(/(^|\s)#.*$/, "").trim();
    if (content !== "") result.push({ line: start, content });
    buffer = "";
  }
}

interface Collected {
  entries: string[];
  issues: RequirementIssue[];
  references: RequirementReference[];
  lowerBounds: LowerBound[];
  visited: Set<string>;
}

function classifyRequirement(file: string, line: number, content: string, out: Collected): void {
  const reference = (reason: string): void => {
    out.references.push({ file, line, text: content, reason });
  };
  // 環境マーカーと行末のオプション(--hash等)を除く
  const withoutMarker = content.split(";")[0]!;
  const requirement = withoutMarker.replace(/\s--?[A-Za-z].*$/, "").trim();
  if (/\s@\s/.test(requirement) || URL_SCHEME.test(requirement) || /^[./~]/.test(requirement) || requirement.includes("/")) {
    reference("Dependencies given as URLs or paths are not scanned");
    return;
  }
  const match = NAME_AND_SPEC.exec(requirement);
  if (!match) {
    reference("The line cannot be interpreted");
    return;
  }
  const name = match[1]!;
  const specifier = match[2]!.replace(/[()]/g, "").trim();
  const specs = specifier === "" ? [] : specifier.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (specs.length === 0) {
    out.issues.push({ file, line, name, specifier, kind: "unpinned" });
    return;
  }
  const parsed = specs.length === 1 ? SPEC.exec(specs[0]!) : null;
  if (parsed) {
    const op = parsed[1]!;
    const version = parsed[2]!;
    if ((op === "==" || op === "===") && !version.includes("*")) {
      if (!SAFE_VERSION.test(version)) return reference("The version specifier cannot be interpreted");
      out.entries.push(`${name}==${version}`);
      return;
    }
    if (op === ">=" || op === "~=") {
      if (!SAFE_VERSION.test(version)) return reference("The version specifier cannot be interpreted");
      // osv-scannerは下限を使用中の版とみなしてスキャンする(実機確認)。その挙動を保ち、印を付けて報告する
      out.entries.push(`${name}${op}${version}`);
      out.issues.push({ file, line, name, specifier, kind: "lower_bound" });
      out.lowerBounds.push({ name: normalizePypiName(name), version });
      return;
    }
  }
  out.issues.push({ file, line, name, specifier, kind: "range" });
}

async function include(
  file: string,
  line: number,
  content: string,
  target: string,
  projectDir: string,
  depth: number,
  out: Collected,
  context: RequirementsReadContext,
): Promise<void> {
  const reference = (reason: string): void => {
    out.references.push({ file, line, text: content, reason });
  };
  const cleaned = target.trim().replace(/^["']|["']$/g, "");
  if (URL_SCHEME.test(cleaned)) return reference("Includes from URLs are not expanded");
  if (depth >= MAX_INCLUDE_DEPTH) return reference(`The include depth exceeds the limit (${MAX_INCLUDE_DEPTH})`);
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(path.dirname(file), cleaned));
  } catch {
    return reference("The included file does not exist");
  }
  if (!isInsideDir(projectDir, resolved)) return reference("The included file is outside the project directory and is not expanded");
  if (out.visited.has(resolved)) return; // 循環
  if (out.visited.size >= MAX_FILES) return reference(`The number of included files exceeds the limit (${MAX_FILES})`);
  let failure: string | null;
  try {
    failure = await analyze(resolved, projectDir, depth + 1, out, context);
  } catch {
    failure = "The included file cannot be read";
  }
  if (failure !== null) reference(failure);
}

/** 1回のスキャンで共有する読み込みの上限とキャッシュ(共通の取り込み先を何度も読まない) */
export interface RequirementsReadContext {
  remainingBytes: number;
  texts: Map<string, string>;
}

/** 1回のスキャンで読むrequirements.txt(取り込み先を含む)の合計の上限 */
const DEFAULT_TOTAL_BYTES = 64 * 1024 * 1024;

export function createRequirementsReadContext(maxTotalBytes = DEFAULT_TOTAL_BYTES): RequirementsReadContext {
  return { remainingBytes: maxTotalBytes, texts: new Map() };
}

/** 安全に読む(FIFOで止まらず、差し替え・範囲外を検出する)。同じファイルは1回だけ読む */
async function readText(
  file: string,
  projectDir: string,
  context: RequirementsReadContext,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const cached = context.texts.get(file);
  if (cached !== undefined) return { ok: true, text: cached };
  const budgetLimited = context.remainingBytes < MAX_FILE_BYTES;
  const result = await readRegularFile(file, {
    maxBytes: Math.min(MAX_FILE_BYTES, context.remainingBytes),
    boundary: projectDir,
  });
  if (!result.ok) {
    if (result.failure === "too_large") {
      return {
        ok: false,
        reason: budgetLimited
          ? "Not read because the total amount of requirements.txt analysis exceeded the limit"
          : `The file exceeds the size limit (${MAX_FILE_BYTES} bytes)`,
      };
    }
    return { ok: false, reason: capitalizeReason(result.message) };
  }
  context.remainingBytes -= result.bytes.length;
  const text = result.bytes.toString("utf8");
  context.texts.set(file, text);
  return { ok: true, text };
}

/** ファイルを解析してoutに追加する。読めない・大きすぎる場合は理由を返す */
async function analyze(
  file: string,
  projectDir: string,
  depth: number,
  out: Collected,
  context: RequirementsReadContext,
): Promise<string | null> {
  out.visited.add(file);
  const read = await readText(file, projectDir, context);
  if (!read.ok) return read.reason;

  for (const { line, content } of logicalLines(read.text)) {
    const requirementInclude = INCLUDE_REQUIREMENT.exec(content);
    if (requirementInclude) {
      await include(file, line, content, requirementInclude[1]!, projectDir, depth, out, context);
      continue;
    }
    if (INCLUDE_CONSTRAINT.test(content)) {
      out.references.push({ file, line, text: content, reason: "Constraint files are not applied" });
      continue;
    }
    if (EDITABLE.test(content)) {
      out.references.push({ file, line, text: content, reason: "Editable installs (-e) are not scanned" });
      continue;
    }
    if (content.startsWith("-")) {
      if (!HARMLESS_OPTION.test(content)) {
        out.references.push({ file, line, text: content, reason: "The option cannot be interpreted" });
      }
      continue;
    }
    classifyRequirement(file, line, content, out);
  }
  return null;
}

/**
 * requirements.txtを解析する。元ファイル自体が読めない・大きすぎる場合だけ`ok: false`。
 * @param file 検出済みの絶対パス
 * @param projectDir 取り込みを展開する範囲(解決済みの絶対パス)
 */
export async function analyzeRequirementsFile(
  file: string,
  projectDir: string,
  context: RequirementsReadContext = createRequirementsReadContext(),
): Promise<RequirementsAnalysis> {
  const out: Collected = { entries: [], issues: [], references: [], lowerBounds: [], visited: new Set() };
  let reason: string | null;
  try {
    reason = await analyze(await realpath(file), projectDir, 0, out, context);
  } catch {
    reason = "The file cannot be read";
  }
  if (reason !== null) return { ok: false, reason };
  return { ok: true, entries: out.entries, issues: out.issues, references: out.references, lowerBounds: out.lowerBounds };
}
