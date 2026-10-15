/**
 * Cargo.lockの解析と、osv-scannerに渡すコピーの内容の生成(cargoは実行しない)。
 *
 * osv-scanner v2.4.0・v2.7.0はCargo.lockの`source`を見ずに全パッケージをcrates.ioとして照会する(2026-10-11 実機確認)。
 * workspaceのメンバー・pathの依存・gitの依存・別レジストリの依存も、同名・同版のcrates.ioのアドバイザリが付き(誤検知)、
 * 社内crateの名前がapi.osv.devへ送られる。そこで元のファイルは渡さず、ここで解析したcrates.io由来の
 * パッケージだけを書いたコピーをスキャンする(docs/DESIGN_TODO.md「Rust(crates.io)対応」)。
 *
 * 解析はcargoが生成する範囲のTOMLだけを受け付ける厳格な行解析。想定外の行が1つでもあれば
 * ファイル全体を失敗にする(部分的に読んで取りこぼしを隠さない)。
 */

/** crates.ioを指すsource(git索引・sparse索引) */
const CRATES_IO_SOURCES: ReadonlySet<string> = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "sparse+https://index.crates.io/",
]);

/** 1つのCargo.lockで受け付けるパッケージ数の上限 */
const MAX_PACKAGES = 50_000;

/** crateの名前(cargoの制約より緩め。英数字・`-`・`_`) */
const CRATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 版(SemVerの文字の範囲) */
const CRATE_VERSION = /^[0-9A-Za-z.+-]{1,256}$/;

export type CargoSourceKind = "crates_io" | "local" | "git" | "registry";

export interface CargoPackage {
  name: string;
  version: string;
  /** null = sourceなし(workspaceのメンバー・pathの依存) */
  source: string | null;
  /** `"名前"` / `"名前 版"` / `"名前 版 (source)"` の生の値 */
  dependencies: string[];
  /**
   * `[replace]`による置換先(`"名前 版 (source)"`。pathの置換先はsourceなし)。
   * 置換されたパッケージは使われず、置換先が別の`[[package]]`として記載される(2026-10-11 cargo 1.98で確認)
   */
  replace?: string;
}

export type CargoLockParseResult = { ok: true; packages: CargoPackage[] } | { ok: false; reason: string };

export function cargoSourceKind(source: string | null): CargoSourceKind {
  if (source === null) return "local";
  if (CRATES_IO_SOURCES.has(source)) return "crates_io";
  if (source.startsWith("git+")) return "git";
  return "registry";
}

const BARE_KEY = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

/**
 * TOMLの基本文字列(`"..."`)を先頭から1つ読む。読めなければnull。
 * cargoが書くエスケープ(`\"` `\\` `\n` `\t` `\uXXXX` `\UXXXXXXXX`等)だけを受け付ける
 */
function readBasicString(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== '"') return null;
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') return { value, end: i + 1 };
    if (ch === "\\") {
      const next = text[i + 1];
      const simple: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
      if (next !== undefined && next in simple) {
        value += simple[next];
        i++;
        continue;
      }
      const width = next === "u" ? 4 : next === "U" ? 8 : 0;
      const hex = text.slice(i + 2, i + 2 + width);
      if (width === 0 || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) return null;
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
      value += String.fromCodePoint(codePoint);
      i += 1 + width;
      continue;
    }
    if (ch.charCodeAt(0) < 0x20 && ch !== "\t") return null;
    value += ch;
  }
  return null;
}

/** 行の残り(値の後ろ)が空白かコメントだけか */
function restIsBlank(rest: string): boolean {
  return /^\s*(?:#.*)?$/.test(rest);
}

/** 1行全体が文字列1つ(と任意の末尾カンマ・コメント)の場合にその値を返す */
function lineString(text: string, allowComma: boolean): string | null {
  const parsed = readBasicString(text, 0);
  if (parsed === null) return null;
  let rest = text.slice(parsed.end);
  if (allowComma) rest = rest.replace(/^\s*,/, "");
  return restIsBlank(rest) ? parsed.value : null;
}

/** `["a", "b"]`形式(1行の配列)の要素。読めなければnull */
function inlineStringArray(text: string): string[] | null {
  if (!text.startsWith("[")) return null;
  const items: string[] = [];
  let i = 1;
  for (;;) {
    while (text[i] === " " || text[i] === "\t") i++;
    if (text[i] === "]") return restIsBlank(text.slice(i + 1)) ? items : null;
    const parsed = readBasicString(text, i);
    if (parsed === null) return null;
    items.push(parsed.value);
    i = parsed.end;
    while (text[i] === " " || text[i] === "\t") i++;
    if (text[i] === ",") i++;
    else if (text[i] !== "]") return null;
  }
}

type State = "top" | "package" | "skipped_table" | "metadata" | "dependencies";

/**
 * Cargo.lock(形式v1〜v4)を解析する。
 * 受け付ける行: 空行・コメント、先頭の`version = 整数`、`[[package]]`、`[[patch.unused]]`(読み飛ばす)、
 * `[metadata]`(v1のchecksum。読み飛ばす)、`キー = "文字列"`、`dependencies = [` 〜 `]`の各要素
 */
export function parseCargoLock(text: string): CargoLockParseResult {
  const packages: CargoPackage[] = [];
  let current: { name?: string; version?: string; source?: string; replace?: string; dependencies: string[] } | null = null;
  let state: State = "top";
  let sawTable = false;
  const fail = (line: number, what: string): CargoLockParseResult => ({
    ok: false,
    reason: `Cargo.lock could not be interpreted with certainty (${what} at line ${line}), so the file was excluded from the scan`,
  });
  const finish = (line: number): CargoLockParseResult | null => {
    if (current === null) return null;
    const { name, version, source, replace, dependencies } = current;
    current = null;
    if (name === undefined || version === undefined) return fail(line, "a package without a name or version");
    if (!CRATE_NAME.test(name)) return fail(line, "an unexpected crate name");
    if (!CRATE_VERSION.test(version)) return fail(line, "an unexpected version");
    if (packages.length >= MAX_PACKAGES) return fail(line, `more than ${MAX_PACKAGES} packages`);
    packages.push({ name, version, source: source ?? null, dependencies, ...(replace !== undefined ? { replace } : {}) });
    return null;
  };

  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const line = lines[index]!.trim();
    if (state === "dependencies") {
      if (line === "" || line.startsWith("#")) continue;
      if (/^\]\s*(?:#.*)?$/.test(line)) {
        state = "package";
        continue;
      }
      const item = lineString(line, true);
      if (item === null) return fail(lineNo, "an unexpected dependency entry");
      current!.dependencies.push(item);
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;

    if (/^\[\[package\]\]\s*(?:#.*)?$/.test(line)) {
      const failed = finish(lineNo);
      if (failed) return failed;
      current = { dependencies: [] };
      state = "package";
      sawTable = true;
      continue;
    }
    if (/^\[\[patch\.unused\]\]\s*(?:#.*)?$/.test(line)) {
      const failed = finish(lineNo);
      if (failed) return failed;
      state = "skipped_table";
      sawTable = true;
      continue;
    }
    if (/^\[metadata\]\s*(?:#.*)?$/.test(line)) {
      const failed = finish(lineNo);
      if (failed) return failed;
      state = "metadata";
      sawTable = true;
      continue;
    }
    if (line.startsWith("[")) return fail(lineNo, "an unexpected table");

    if (state === "metadata") {
      // v1: "checksum 名前 版 (source)" = "ハッシュ"
      const key = readBasicString(line, 0);
      const valueMatch = key === null ? null : /^\s*=\s*(.*)$/.exec(line.slice(key.end));
      if (valueMatch === null || lineString(valueMatch[1]!, false) === null) return fail(lineNo, "an unexpected metadata entry");
      continue;
    }

    const match = BARE_KEY.exec(line);
    if (match === null) return fail(lineNo, "an unexpected line");
    const [, key, valueText] = match as unknown as [string, string, string];

    if (state === "top") {
      if (key !== "version" || sawTable || !/^\d{1,3}\s*(?:#.*)?$/.test(valueText)) return fail(lineNo, "an unexpected top-level key");
      continue;
    }
    if (key === "dependencies" && (state === "package" || state === "skipped_table")) {
      if (/^\[\s*(?:#.*)?$/.test(valueText)) {
        if (state === "skipped_table") return fail(lineNo, "an unexpected array");
        state = "dependencies";
        continue;
      }
      const items = inlineStringArray(valueText);
      if (items === null) return fail(lineNo, "an unexpected dependencies value");
      if (state === "package") current!.dependencies.push(...items);
      continue;
    }
    const value = lineString(valueText, false);
    if (value === null) return fail(lineNo, `an unexpected value for ${key}`);
    if (state === "package") {
      if (key === "name" || key === "version" || key === "source" || key === "replace") {
        if (current![key] !== undefined) return fail(lineNo, `a duplicate ${key}`);
        current![key] = value;
      }
      // checksum等の他の文字列キーはスキャンに使わない
    }
  }
  if (state === "dependencies") return fail(lines.length, "an unterminated dependencies array");
  const failed = finish(lines.length);
  if (failed) return failed;
  // 置換先が解釈でき、別のパッケージとして記載されていることを確かめる(置換元は使われないためスキャンしない)
  for (const pkg of packages) {
    if (pkg.replace === undefined) continue;
    const target = parsePackageId(pkg.replace);
    const found = target !== null && packages.some(
      (other) => other !== pkg && other.name === target.name && other.version === target.version && other.source === target.source,
    );
    if (!found) {
      return {
        ok: false,
        reason: `Cargo.lock could not be interpreted with certainty (the replacement of ${pkg.name} ${pkg.version} by [replace] was not found), so the file was excluded from the scan`,
      };
    }
  }
  return { ok: true, packages };
}

/** Cargo.lockのパッケージID(`"名前 版"` / `"名前 版 (source)"`)。解釈できなければnull */
export function parsePackageId(id: string): { name: string; version: string; source: string | null } | null {
  const match = /^(\S+) (\S+)(?: \((.+)\))?$/.exec(id);
  if (match === null) return null;
  return { name: match[1]!, version: match[2]!, source: match[3] ?? null };
}

/** スキャンしないcrate(gitの依存・別レジストリの依存)。sourceのURLは応答に出さない */
export interface UnscannableCrate {
  name: string;
  version: string;
  kind: "git" | "registry";
}

export const UNSCANNABLE_CRATE_REASONS: Record<UnscannableCrate["kind"], string> = {
  git: "Git dependency: its version does not correspond to a crates.io release, so it was not checked against crates.io advisories",
  registry:
    "Dependency from a registry other than crates.io: a crate with the same name on crates.io may be a different crate, " +
    "so it was not checked (and its name was not sent to api.osv.dev)",
};

export interface CargoLockClassification {
  allPackages: CargoPackage[];
  /** スキャンするcrates.io由来のパッケージ(name・version・sourceの重複を除く) */
  cratesIo: CargoPackage[];
  /** sourceなし(workspaceのメンバー・pathの依存)のcrateの名前 */
  localCrates: string[];
  unscannable: UnscannableCrate[];
}

export function classifyCargoPackages(packages: readonly CargoPackage[]): CargoLockClassification {
  const result: CargoLockClassification = { allPackages: [...packages], cratesIo: [], localCrates: [], unscannable: [] };
  const seen = new Set<string>();
  for (const pkg of packages) {
    // [replace]で置換されたパッケージは使われない(置換先は別のパッケージとして分類する)
    if (pkg.replace !== undefined) continue;
    const kind = cargoSourceKind(pkg.source);
    const key = JSON.stringify([pkg.name, pkg.version, pkg.source]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === "crates_io") result.cratesIo.push(pkg);
    else if (kind === "local") result.localCrates.push(pkg.name);
    else result.unscannable.push({ name: pkg.name, version: pkg.version, kind });
  }
  return result;
}

/**
 * osv-scannerに渡すコピーの内容。crates.io由来のパッケージのname・version・sourceだけを書く
 * (名前・版は解析時に文字の範囲を検証済み、sourceは固定の値なので、エスケープは不要)
 */
export function cargoLockCopyContent(cratesIo: readonly CargoPackage[]): string {
  const blocks = cratesIo.map((pkg) => `[[package]]\nname = "${pkg.name}"\nversion = "${pkg.version}"\nsource = "${pkg.source}"\n`);
  return `version = 3\n\n${blocks.join("\n")}`;
}

/**
 * Cargo.tomlの行のうち、文字列・配列・インラインテーブルの外で始まる行(テーブルの見出し・キーの行)だけを返す。
 * 複数行文字列(`"""` / `\'\'\'`)の中の`[workspace]`等を見出しと誤認しないため(レビュー指摘、2026-10-11)。
 * 閉じない文字列・括弧の不整合など解釈できない場合はnull
 */
export function topLevelTomlLines(text: string): { line: string; offset: number }[] | null {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines: { line: string; offset: number }[] = [];
  let depth = 0;
  let lineStart: number | null = 0;
  let i = 0;
  const pushLine = (end: number) => {
    if (lineStart !== null) lines.push({ line: src.slice(lineStart, end), offset: lineStart });
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\n") {
      pushLine(i);
      i++;
      lineStart = depth === 0 ? i : null;
      continue;
    }
    if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
      const quote = src.slice(i, i + 3);
      let j = i + 3;
      for (;;) {
        if (j >= src.length) return null;
        if (quote === '"""' && src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src.startsWith(quote, j)) break;
        j++;
      }
      // 閉じの引用符の直前に引用符を最大2つ書ける(`"""a"""""`は`a""`)ため、続く引用符も文字列に含める
      let extra = 0;
      while (extra < 2 && src[j + 3] === quote[0]) {
        j++;
        extra++;
      }
      j += 3;
      const inner = src.slice(i, j);
      if (inner.includes("\n")) lineStart = null; // 複数行にまたがる文字列の後の続きは見出し・キーの行として扱わない
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= src.length || src[j] === "\n") return null;
        if (ch === '"' && src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === ch) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") {
      depth--;
      if (depth < 0) return null;
    }
    i++;
  }
  if (depth !== 0) return null;
  pushLine(src.length);
  return lines;
}

/** 見出しの行(`[名前]`)のテーブル名。配列のテーブル(`[[...]]`)・引用符付きの名前は`""`(どのテーブルにも一致させない) */
function tableHeader(line: string): string | null {
  if (!line.startsWith("[")) return null;
  const header = /^\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(?:#.*)?$/.exec(line);
  return header ? header[1]! : "";
}

/**
 * Cargo.tomlの`[package]`テーブルの`name`(workspaceのメンバーの確認用)。
 * `name = "..."`の単純な形だけを読み、読めなければnull
 */
export function cargoTomlPackageName(text: string): string | null {
  const lines = topLevelTomlLines(text);
  if (lines === null) return null;
  let table: string | null = null;
  for (const { line: raw } of lines) {
    const line = raw.trim();
    const header = tableHeader(line);
    if (header !== null) {
      table = header;
      continue;
    }
    if (table !== "package") continue;
    const match = /^name\s*=\s*(.*)$/.exec(line);
    if (match) {
      const value = lineString(match[1]!, false);
      return value !== null && CRATE_NAME.test(value) ? value : null;
    }
  }
  return null;
}

/** Cargo.tomlの`[workspace]`の`members`・`exclude`(workspaceの所属の確認用) */
export interface CargoWorkspace {
  members: string[];
  exclude: string[];
}

/**
 * `[`の位置から文字列の配列(複数行・コメント・末尾カンマ可)を読む。文字列以外を含めばnull
 */
function readStringArray(text: string, start: number): string[] | null {
  if (text[start] !== "[") return null;
  const items: string[] = [];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",") {
      i++;
    } else if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "]") {
      return items;
    } else {
      if (text.startsWith('"""', i)) return null; // 複数行文字列は扱わない
      const parsed = readBasicString(text, i);
      if (parsed === null) return null;
      items.push(parsed.value);
      i = parsed.end;
    }
  }
  return null;
}

/**
 * workspaceのルートのCargo.tomlから`[workspace]`の`members`・`exclude`を読む。
 * `[workspace]`が無い・値を解釈できない場合はnull(所属を確認できない)
 */
export function cargoWorkspace(text: string): CargoWorkspace | null {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = topLevelTomlLines(normalized);
  if (lines === null) return null;
  const result: CargoWorkspace = { members: [], exclude: [] };
  let inWorkspace = false;
  let sawWorkspace = false;
  for (const { line: raw, offset } of lines) {
    const line = raw.trim();
    const header = tableHeader(line);
    if (header !== null) {
      inWorkspace = header === "workspace";
      sawWorkspace ||= inWorkspace;
      continue;
    }
    // ルートのテーブルのドット付きのキー(workspace.members = ...)は扱わない(所属を確認できない)
    if (!inWorkspace && /^workspace\s*\./.test(line)) return null;
    if (!inWorkspace || line === "") continue;
    // 引用符付きのキー("exclude" = ...)は読み落としを避けるため解釈できないものとする
    if (line.startsWith('"') || line.startsWith("'")) return null;
    const match = /^(members|exclude)\s*=\s*/.exec(line);
    if (match === null) continue;
    const items = readStringArray(normalized, offset + raw.indexOf(line) + match[0].length);
    if (items === null) return null;
    result[match[1] as "members" | "exclude"] = items;
  }
  return sawWorkspace ? result : null;
}

/** workspaceのルートからの相対パス(`/`区切り)を、`./`・末尾の`/`を除いて正規化する */
function normalizeWorkspacePath(value: string): string | null {
  const parts = value.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  if (value.startsWith("/") || parts.some((part) => part === "..")) return null; // 絶対パス・ルートの外は扱わない
  return parts.join("/");
}

/** パスの区切り単位での前方一致 */
function isPathPrefix(prefix: string, target: string): boolean {
  return prefix === "" || target === prefix || target.startsWith(`${prefix}/`);
}

/** `*`・`?`だけのglobの一致。それ以外のglob(`**`・`[...]`・`{...}`)はnull(判定できない) */
function globMatches(pattern: string, target: string): boolean | null {
  const patternParts = pattern.split("/");
  const targetParts = target === "" ? [] : target.split("/");
  if (patternParts.some((part) => part.includes("**") || /[[\]{}]/.test(part))) return null;
  if (patternParts.length !== targetParts.length) return false;
  return patternParts.every((part, i) => {
    const regex = new RegExp(`^${part.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
    return regex.test(targetParts[i]!);
  });
}

/**
 * memberDir(workspaceのルートからの相対パス)が`members`に含まれ、`exclude`で除かれていないか。
 * Cargoの規則(2026-10-11 cargo 1.98で確認): `members`はglobで展開し、`exclude`はパスの前方一致で除く。
 * ただし`members`に(globでなく)文字どおり書かれたパスの配下は`exclude`より優先する。
 * true=所属 / false=所属しない / null=判定できない(解釈できないパス・glob)
 */
export function workspaceIncludes(workspace: CargoWorkspace, memberDir: string): boolean | null {
  const target = normalizeWorkspacePath(memberDir);
  if (target === null) return null;
  let undecided = false;
  let matched = false;
  for (const member of workspace.members) {
    const pattern = normalizeWorkspacePath(member);
    const result = pattern === null ? null : globMatches(pattern, target);
    if (result === null) undecided = true;
    else if (result) matched = true;
  }
  if (!matched) return undecided ? null : false;
  const explicit = workspace.members.some((member) => {
    const literal = normalizeWorkspacePath(member);
    return literal !== null && isPathPrefix(literal, target);
  });
  const excluded = workspace.exclude.some((ex) => {
    const prefix = normalizeWorkspacePath(ex);
    return prefix !== null && isPathPrefix(prefix, target);
  });
  if (workspace.exclude.some((ex) => normalizeWorkspacePath(ex) === null)) return null;
  return !(excluded && !explicit);
}
