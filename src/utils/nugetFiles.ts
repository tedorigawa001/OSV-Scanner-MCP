/**
 * .NET(NuGet)のファイルの解析と、osv-scannerに渡すコピーの生成(docs/DESIGN_TODO.md「.NET(NuGet)対応」)。
 *
 * - 元のファイルはosv-scannerに渡さない。照会してよいパッケージだけを書いた`packages.lock.json`形式のコピーを渡す
 *   (osv-scannerは`*.deps.json`の自分のプロジェクトもNuGetとして照会し、`.csproj`の`$(Prop)`・範囲を版として照会する。
 *   解釈できない版はOSVで全ての版より前とみなされ、全ての脆弱性に一致する。2026-10-23 実機確認)
 * - 照会するのは確定版(復元の結果)か、`.csproj`の下限の指定(下限として示す)だけ
 * - `.csproj`はMSBuildを評価しない。`Condition`・`Choose`・`Target`の中、`Update`・`Remove`のある名前、重複は照会しない
 * - XMLは小さな走査で読み、DOCTYPE・ENTITY・CDATAを扱わない(エンティティ展開による資源枯渇を避ける)
 */

import { ScanToolError } from "../errors.js";
import { createNpmLockWorkBudget, parseNpmLock, type NpmLockWorkBudget } from "./npmLockCopy.js";
import { decodeEntities } from "./pomParent.js";
import type { RelationLookup } from "./dependencyRelations.js";

/** NuGetの版の形式(4つ目の数・プレリリース・ビルドメタデータを含む)。これ以外は確定版とみなさない */
const NUGET_VERSION = /^\d{1,9}(?:\.\d{1,9}){0,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?(?:\+[0-9A-Za-z.-]{1,64})?$/;
/** NuGetのパッケージIDに使える文字 */
const NUGET_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

export function isNugetVersion(value: string): boolean {
  return NUGET_VERSION.test(value);
}

export function isNugetId(value: string): boolean {
  return NUGET_ID.test(value);
}

/** パッケージIDは大文字小文字を区別しない */
export function nugetKey(name: string): string {
  return name.toLowerCase();
}

export interface NugetPackage {
  name: string;
  version: string;
  relation: "direct" | "transitive" | "unknown";
  /** `.csproj`の下限の指定から照会する(実際に復元される版はこれ以上でありうる) */
  lowerBound?: true;
}

export interface UnscannableNugetPackage {
  name: string;
  version: string;
  reason: string;
}

export interface NugetParseResult {
  packages: NugetPackage[];
  /** 自分のプロジェクト(照会しない)の数 */
  localProjects: number;
  unscannable: UnscannableNugetPackage[];
}

export type NugetParseOutcome = ({ ok: true } & NugetParseResult) | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** 同じ名前・版は1件にまとめる。直接依存と判定されたものがあれば直接依存とする */
function dedupe(packages: NugetPackage[]): NugetPackage[] {
  const byKey = new Map<string, NugetPackage>();
  for (const pkg of packages) {
    const key = JSON.stringify([nugetKey(pkg.name), pkg.version]);
    const previous = byKey.get(key);
    if (previous === undefined) byKey.set(key, pkg);
    else if (pkg.relation === "direct" && previous.relation !== "direct") byKey.set(key, { ...previous, relation: "direct" });
  }
  return [...byKey.values()];
}

function parseJson(source: string, budget: NpmLockWorkBudget): unknown {
  // 入れ子の深さ・構造の数を数えてからJSON.parseする(npmLockCopy.tsと同じ事前検査・予算)
  return parseNpmLock(source.replace(/^﻿/, ""), budget);
}

function jsonFailure(error: unknown, label: string): { ok: false; reason: string } {
  if (error instanceof ScanToolError && error.kind === "scan_input_too_large") {
    return { ok: false, reason: `Not scanned because ${label} exceeds the JSON parsing limits (16 MiB, nesting, or the number of values per scan)` };
  }
  return { ok: false, reason: `${label} is not valid JSON` };
}

/** 確定版のパッケージとして受け入れるか。受け入れない場合は理由をunscannableに積む */
function acceptResolved(
  name: string,
  version: string,
  relation: NugetPackage["relation"],
  out: NugetParseResult,
): void {
  if (!isNugetId(name)) out.unscannable.push({ name: name.slice(0, 200), version: version.slice(0, 100), reason: "invalid_package_id" });
  else if (!isNugetVersion(version)) out.unscannable.push({ name, version: version.slice(0, 100), reason: "unresolved_version" });
  else out.packages.push({ name, version, relation });
}

/**
 * `packages.lock.json`。type: Direct / Transitive / CentralTransitive を照会し、Project は数だけ数える。
 * 複数のターゲットフレームワークの版はそれぞれ照会する
 */
export function parsePackagesLock(source: string, budget: NpmLockWorkBudget = createNpmLockWorkBudget()): NugetParseOutcome {
  let data: unknown;
  try {
    data = parseJson(source, budget);
  } catch (error) {
    return jsonFailure(error, "packages.lock.json");
  }
  if (!isRecord(data) || !isRecord(data.dependencies)) return { ok: false, reason: "packages.lock.json has no dependencies object" };
  const out: NugetParseResult = { packages: [], localProjects: 0, unscannable: [] };
  const localProjects = new Set<string>();
  for (const framework of Object.values(data.dependencies)) {
    if (!isRecord(framework)) continue;
    for (const [name, entry] of Object.entries(framework)) {
      if (!isRecord(entry)) continue;
      const type = text(entry.type);
      if (type === "Project") localProjects.add(nugetKey(name));
      else if (type === "Direct") acceptResolved(name, text(entry.resolved), "direct", out);
      else if (type === "Transitive" || type === "CentralTransitive") acceptResolved(name, text(entry.resolved), "transitive", out);
      else out.unscannable.push({ name: name.slice(0, 200), version: text(entry.resolved).slice(0, 100), reason: "unknown_type" });
    }
  }
  return { ok: true, ...out, packages: dedupe(out.packages), localProjects: localProjects.size };
}

const RUNTIME_PACK_PREFIX = "runtimepack.";

/** `Name/Version`形式のライブラリのキー */
function splitLibraryKey(key: string): { name: string; version: string } | null {
  const slash = key.lastIndexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { name: key.slice(0, slash), version: key.slice(slash + 1) };
}

export interface ProjectAssets extends NugetParseResult {
  /** `project.restore.projectPath`のファイル名(どのプロジェクトの復元結果か) */
  projectFileName: string | null;
  /** `project.restore.projectName` */
  projectName: string | null;
}

/**
 * `obj/project.assets.json`(`dotnet restore`の生成物)。`libraries`の type: package を照会し、project は数だけ数える。
 * `project.frameworks.*.dependencies`に載るものが直接依存
 */
export function parseProjectAssets(
  source: string,
  budget: NpmLockWorkBudget = createNpmLockWorkBudget(),
): ({ ok: true } & ProjectAssets) | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = parseJson(source, budget);
  } catch (error) {
    return jsonFailure(error, "project.assets.json");
  }
  if (!isRecord(data) || !isRecord(data.libraries)) return { ok: false, reason: "project.assets.json has no libraries object" };
  const project = isRecord(data.project) ? data.project : {};
  const restore = isRecord(project.restore) ? project.restore : {};
  const direct = new Set<string>();
  if (isRecord(project.frameworks)) {
    for (const framework of Object.values(project.frameworks)) {
      if (isRecord(framework) && isRecord(framework.dependencies)) {
        for (const name of Object.keys(framework.dependencies)) direct.add(nugetKey(name));
      }
    }
  }
  const out: NugetParseResult = { packages: [], localProjects: 0, unscannable: [] };
  for (const [key, library] of Object.entries(data.libraries)) {
    const id = splitLibraryKey(key);
    const type = isRecord(library) ? text(library.type) : "";
    if (id === null) {
      out.unscannable.push({ name: key.slice(0, 200), version: "", reason: "invalid_library_key" });
    } else if (type === "package") {
      acceptResolved(id.name, id.version, direct.has(nugetKey(id.name)) ? "direct" : "transitive", out);
    } else if (type === "project") {
      out.localProjects++;
    } else {
      out.unscannable.push({ name: id.name, version: id.version, reason: "unknown_type" });
    }
  }
  const projectPath = text(restore.projectPath);
  return {
    ok: true,
    ...out,
    packages: dedupe(out.packages),
    // Windowsのパスも区切る
    projectFileName: projectPath === "" ? null : projectPath.split(/[\\/]/).pop() || null,
    projectName: text(restore.projectName) || null,
  };
}

/**
 * `*.deps.json`(ビルド出力)。`libraries`の type: package / runtimepack を照会し、project / reference は数だけ数える
 * (osv-scannerはprojectもNuGetとして照会するため、コピーで除く)。type: project のライブラリの依存が直接依存
 */
export function parseDepsJson(source: string, budget: NpmLockWorkBudget = createNpmLockWorkBudget()): NugetParseOutcome {
  let data: unknown;
  try {
    data = parseJson(source, budget);
  } catch (error) {
    return jsonFailure(error, "deps.json");
  }
  if (!isRecord(data) || !isRecord(data.libraries)) return { ok: false, reason: "deps.json has no libraries object" };
  const projects = new Set<string>();
  for (const [key, library] of Object.entries(data.libraries)) {
    if (isRecord(library) && library.type === "project") projects.add(key);
  }
  const direct = new Set<string>();
  if (isRecord(data.targets)) {
    for (const target of Object.values(data.targets)) {
      if (!isRecord(target)) continue;
      for (const [key, entry] of Object.entries(target)) {
        if (!projects.has(key)) continue;
        if (isRecord(entry) && isRecord(entry.dependencies)) {
          for (const name of Object.keys(entry.dependencies)) direct.add(nugetKey(name));
        }
      }
    }
  }
  const out: NugetParseResult = { packages: [], localProjects: 0, unscannable: [] };
  for (const [key, library] of Object.entries(data.libraries)) {
    const id = splitLibraryKey(key);
    const type = isRecord(library) ? text(library.type) : "";
    if (id === null) {
      out.unscannable.push({ name: key.slice(0, 200), version: "", reason: "invalid_library_key" });
    } else if (type === "package" || type === "runtimepack") {
      // SDKはランタイムパックのライブラリ名に`runtimepack.`を付ける。付けたまま照会するとOSVで一致しない
      // (Microsoft.NETCore.App.Runtime.linux-x64 8.0.0: 正しい名前で12件、接頭辞付きで0件。レビュー指摘、2026-10-23)
      const name = type === "runtimepack" && id.name.toLowerCase().startsWith(RUNTIME_PACK_PREFIX) ? id.name.slice(RUNTIME_PACK_PREFIX.length) : id.name;
      const relation = projects.size === 0 ? "unknown" : direct.has(nugetKey(name)) ? "direct" : "transitive";
      acceptResolved(name, id.version, relation, out);
    } else if (type === "project" || type === "reference") {
      out.localProjects++;
    } else {
      out.unscannable.push({ name: id.name, version: id.version, reason: "unknown_type" });
    }
  }
  return { ok: true, ...out, packages: dedupe(out.packages) };
}

// ---- XML ----

export interface XmlElement {
  /** ローカル名(接頭辞を除く)。照合は大文字小文字を区別しない(lowerName) */
  name: string;
  lowerName: string;
  /** 属性名は小文字にする */
  attributes: Map<string, string>;
  children: XmlElement[];
  text: string;
}

const MAX_XML_ELEMENTS = 200_000;
const MAX_XML_DEPTH = 64;

/**
 * 小さなXMLの走査。DOCTYPE・ENTITY・CDATA、閉じていない・対応しないタグ、未知の実体参照は解釈できない(理由を返す)。
 * MSBuildの評価はしない(構造を読むだけ)
 */
export function parseXml(source: string): { ok: true; root: XmlElement } | { ok: false; reason: string } {
  const xml = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const fail = (reason: string) => ({ ok: false as const, reason });
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let count = 0;
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf("<", pos);
    const chunk = xml.slice(pos, lt === -1 ? xml.length : lt);
    if (stack.length > 0 && chunk !== "") {
      const decoded = decodeEntities(chunk);
      if (decoded === undefined) return fail("unknown entity reference");
      stack[stack.length - 1]!.text += decoded;
    } else if (stack.length === 0 && chunk.trim() !== "") {
      return fail("text outside the root element");
    }
    if (lt === -1) break;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) return fail("unterminated comment");
      pos = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt)) return fail("DOCTYPE, ENTITY, and CDATA are not supported");
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) return fail("unterminated processing instruction");
      pos = end + 2;
      continue;
    }
    let i = lt + 1;
    let quote: string | null = null;
    for (; i < xml.length; i++) {
      const c = xml[i];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (i >= xml.length) return fail("unterminated tag");
    const raw = xml.slice(lt + 1, i);
    pos = i + 1;
    if (raw.startsWith("/")) {
      const closing = raw.slice(1).trim();
      const open = stack.pop();
      if (open === undefined || localName(closing).toLowerCase() !== open.lowerName) return fail("mismatched end tag");
      continue;
    }
    if (root !== null && stack.length === 0) return fail("more than one root element");
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const qname = /^[^\s/]+/.exec(body)?.[0];
    if (qname === undefined) return fail("invalid tag");
    const attributes = new Map<string, string>();
    const rest = body.slice(qname.length);
    let consumed = 0;
    // Consume each character once. An unanchored attribute regex retries a failed
    // whitespace suffix from every offset (quadratic work even on valid XML).
    const whitespace = /\s/;
    while (consumed < rest.length) {
      const beforeSpace = consumed;
      while (consumed < rest.length && whitespace.test(rest[consumed]!)) consumed++;
      if (consumed === rest.length) break;
      if (consumed === beforeSpace) return fail("invalid attribute");
      const nameStart = consumed;
      while (consumed < rest.length && !whitespace.test(rest[consumed]!) && rest[consumed] !== "=") consumed++;
      if (consumed === nameStart) return fail("invalid attribute");
      const attributeName = rest.slice(nameStart, consumed);
      while (consumed < rest.length && whitespace.test(rest[consumed]!)) consumed++;
      if (rest[consumed++] !== "=") return fail("invalid attribute");
      while (consumed < rest.length && whitespace.test(rest[consumed]!)) consumed++;
      const delimiter = rest[consumed++];
      if (delimiter !== '"' && delimiter !== "'") return fail("invalid attribute");
      const valueStart = consumed;
      const valueEnd = rest.indexOf(delimiter, consumed);
      if (valueEnd === -1) return fail("invalid attribute");
      consumed = valueEnd + 1;
      const value = decodeEntities(rest.slice(valueStart, valueEnd));
      if (value === undefined) return fail("unknown entity reference");
      const key = localName(attributeName).toLowerCase();
      if (attributes.has(key)) return fail("duplicate attribute");
      attributes.set(key, value);
    }
    if (++count > MAX_XML_ELEMENTS) return fail(`more than ${MAX_XML_ELEMENTS} elements`);
    const name = localName(qname);
    const element: XmlElement = { name, lowerName: name.toLowerCase(), attributes, children: [], text: "" };
    if (stack.length === 0) root = element;
    else stack[stack.length - 1]!.children.push(element);
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > MAX_XML_DEPTH) return fail(`nesting deeper than ${MAX_XML_DEPTH}`);
    }
  }
  if (stack.length !== 0) return fail("unclosed element");
  if (root === null) return fail("no root element");
  return { ok: true, root };
}

function localName(qname: string): string {
  return qname.slice(qname.lastIndexOf(":") + 1);
}

/** `packages.config`(.NET Framework)。全ての依存が確定版で列挙される */
export function parsePackagesConfig(source: string): NugetParseOutcome {
  const xml = parseXml(source);
  if (!xml.ok) return { ok: false, reason: `packages.config could not be parsed: ${xml.reason}` };
  if (xml.root.lowerName !== "packages") return { ok: false, reason: "packages.config has no packages root element" };
  const out: NugetParseResult = { packages: [], localProjects: 0, unscannable: [] };
  for (const child of xml.root.children) {
    if (child.lowerName !== "package") continue;
    acceptResolved(child.attributes.get("id")?.trim() ?? "", child.attributes.get("version")?.trim() ?? "", "unknown", out);
  }
  return { ok: true, ...out, packages: dedupe(out.packages) };
}

// ---- .csproj ----

export type UnresolvedReason =
  | "property"
  | "range"
  | "floating"
  | "central_package_management"
  | "conditional"
  | "updated"
  | "removed"
  | "duplicate";

export interface UnresolvedReference {
  name: string;
  specifier: string;
  reason: UnresolvedReason;
}

/**
 * `PackageReference`の版の指定。NuGetの公式の説明: `x`は「x以上で最も低い版を優先」、`[x]`は完全一致。
 * 下限を含む指定は下限として照会し、それ以外は照会しない
 */
export function classifyVersionSpec(
  spec: string | undefined,
): { kind: "exact" | "lower_bound"; version: string } | { kind: "unresolved"; reason: UnresolvedReason } {
  const value = spec?.trim() ?? "";
  if (value === "") return { kind: "unresolved", reason: "central_package_management" };
  if (/[$@%]\(/.test(value)) return { kind: "unresolved", reason: "property" };
  if (value.includes("*")) return { kind: "unresolved", reason: "floating" };
  if (isNugetVersion(value)) return { kind: "lower_bound", version: value };
  const exact = /^\[\s*([^,\s\]]+)\s*\]$/.exec(value);
  if (exact !== null && isNugetVersion(exact[1]!)) return { kind: "exact", version: exact[1]! };
  const range = /^\[\s*([^,\s]+)\s*,\s*([^,\s\])]*)\s*[\])]$/.exec(value);
  if (range !== null && isNugetVersion(range[1]!) && (range[2] === "" || isNugetVersion(range[2]!))) {
    return { kind: "lower_bound", version: range[1]! };
  }
  return { kind: "unresolved", reason: "range" };
}

export interface ProjectFileAnalysis {
  references: NugetPackage[];
  unresolved: UnresolvedReference[];
  /** `NuGetLockFilePath`がある(既定の名前のlockfileとの対応を確認できない) */
  customLockFilePath: boolean;
}

/** Include等のアイテムの指定は`;`で複数の名前を書ける */
function itemNames(value: string | undefined): string[] {
  return (value ?? "").split(";").map((s) => s.trim()).filter((s) => s !== "");
}

/** 名前を確定できない(プロパティ・ワイルドカード等)か */
function isDynamicName(name: string): boolean {
  return /[$@%]\(|[*?]/.test(name);
}

/**
 * ファイル内の全ての`PackageReference`が扱う名前(Include・Update・Remove)。
 * `Directory.Build.props`/`.targets`の確認に使う。名前を確定できない参照がある場合は"*"を含める
 */
export function packageReferenceNames(root: XmlElement): Set<string> {
  const names = new Set<string>();
  const visit = (element: XmlElement) => {
    if (element.lowerName === "packagereference") {
      for (const attr of ["include", "update", "remove"]) {
        for (const name of itemNames(element.attributes.get(attr))) names.add(isDynamicName(name) ? "*" : nugetKey(name));
      }
    }
    for (const child of element.children) visit(child);
  };
  visit(root);
  return names;
}

/**
 * `.csproj`等の`PackageReference`から、照会してよい直接依存を取り出す(MSBuildは評価しない)。
 * 照会するのは`<Project>`直下の`<ItemGroup>`直下にある、Conditionの無い`Include`だけ。
 * `externalNames`は`Directory.Build.props`/`.targets`で扱われる名前("*"は全て)
 */
export function analyzeProjectFile(source: string, externalNames: ReadonlySet<string> = new Set()): ({ ok: true } & ProjectFileAnalysis) | { ok: false; reason: string } {
  const xml = parseXml(source);
  if (!xml.ok) return { ok: false, reason: `The project file could not be parsed: ${xml.reason}` };
  if (xml.root.lowerName !== "project") return { ok: false, reason: "The project file has no Project root element" };
  const includes: { name: string; spec: string; eligible: boolean; versionOverride: boolean }[] = [];
  const updated = new Set<string>();
  const removed = new Set<string>();
  let customLockFilePath = false;
  const visit = (element: XmlElement, ancestors: readonly XmlElement[]) => {
    if (element.lowerName === "nugetlockfilepath") customLockFilePath = true;
    if (element.lowerName === "packagereference") {
      for (const name of itemNames(element.attributes.get("update"))) updated.add(isDynamicName(name) ? "*" : nugetKey(name));
      for (const name of itemNames(element.attributes.get("remove"))) removed.add(isDynamicName(name) ? "*" : nugetKey(name));
      const parent = ancestors[ancestors.length - 1];
      const versionChildren = element.children.filter((c) => c.lowerName === "version");
      const conditional =
        element.attributes.has("condition") ||
        (parent !== undefined && parent.attributes.has("condition")) ||
        element.children.some((c) => c.attributes.has("condition"));
      const placed = ancestors.length === 2 && ancestors[0]!.lowerName === "project" && parent!.lowerName === "itemgroup";
      const attrVersion = element.attributes.get("version");
      const spec = versionChildren.length === 1 && attrVersion === undefined ? versionChildren[0]!.text
        : versionChildren.length === 0 ? attrVersion ?? "" : "\u0000duplicate";
      const versionOverride = element.attributes.has("versionoverride") || element.children.some((c) => c.lowerName === "versionoverride");
      for (const name of itemNames(element.attributes.get("include"))) {
        includes.push({ name, spec, eligible: placed && !conditional, versionOverride });
      }
    }
    for (const child of element.children) visit(child, [...ancestors, element]);
  };
  visit(xml.root, []);

  const includeCount = new Map<string, number>();
  for (const ref of includes) includeCount.set(nugetKey(ref.name), (includeCount.get(nugetKey(ref.name)) ?? 0) + 1);
  const references: NugetPackage[] = [];
  const unresolved: UnresolvedReference[] = [];
  for (const ref of includes) {
    const key = nugetKey(ref.name);
    const spec = ref.spec === "\u0000duplicate" ? "" : ref.spec.trim();
    const skip = (reason: UnresolvedReason) => unresolved.push({ name: ref.name.slice(0, 200), specifier: spec.slice(0, 200), reason });
    if (isDynamicName(ref.name) || !isNugetId(ref.name)) skip("property");
    else if (!ref.eligible) skip("conditional");
    else if (removed.has(key) || removed.has("*")) skip("removed");
    else if (updated.has(key) || updated.has("*") || externalNames.has(key) || externalNames.has("*")) skip("updated");
    else if (includeCount.get(key)! > 1 || ref.spec === "\u0000duplicate") skip("duplicate");
    else if (ref.versionOverride) skip("central_package_management");
    else {
      const classified = classifyVersionSpec(ref.spec);
      if (classified.kind === "unresolved") skip(classified.reason);
      else references.push({ name: ref.name, version: classified.version, relation: "direct", ...(classified.kind === "lower_bound" ? { lowerBound: true as const } : {}) });
    }
  }
  return { ok: true, references, unresolved, customLockFilePath };
}

/** `nuget.config`にnuget.org以外のパッケージソースがあるか。解釈できない場合もtrue(送信の注意を示す側に倒す) */
export function hasNonNugetOrgSource(source: string): boolean {
  const xml = parseXml(source);
  if (!xml.ok) return true;
  let found = false;
  const visit = (element: XmlElement, inSources: boolean) => {
    if (inSources && element.lowerName === "add") {
      const value = element.attributes.get("value")?.trim() ?? "";
      let host = "";
      try {
        host = new URL(value).hostname.toLowerCase();
      } catch {
        host = "";
      }
      if (host !== "api.nuget.org" && host !== "www.nuget.org" && host !== "nuget.org") found = true;
    }
    for (const child of element.children) visit(child, inSources || element.lowerName === "packagesources");
  };
  visit(xml.root, false);
  return found;
}

// ---- コピーと関係 ----

/**
 * osv-scannerに渡す`packages.lock.json`形式のコピー。同じ名前の別の版は別のフレームワークのグループに書く
 * (JSONのキーの重複を避ける。フレームワーク名は任意の文字列でよい: 2.4.0・2.7.0で実機確認)
 */
export function nugetLockCopyContent(packages: readonly NugetPackage[]): string {
  const groups: Record<string, { type: string; resolved: string }>[] = [];
  const seen = new Map<string, number>();
  for (const pkg of packages) {
    const key = nugetKey(pkg.name);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    groups[index] ??= {};
    groups[index]![pkg.name] = {
      type: pkg.relation === "direct" ? "Direct" : "Transitive",
      resolved: pkg.version,
    };
  }
  const dependencies = Object.fromEntries(groups.map((group, i) => [`group${i}`, group]));
  return `${JSON.stringify({ version: 1, dependencies })}\n`;
}

/** コピーに書いたパッケージの直接/推移的依存の判定 */
export function nugetRelations(packages: readonly NugetPackage[]): RelationLookup {
  const relations = new Map<string, NugetPackage["relation"]>();
  for (const pkg of packages) {
    const key = JSON.stringify([nugetKey(pkg.name), pkg.version]);
    const previous = relations.get(key);
    if (previous === undefined || pkg.relation === "direct") relations.set(key, pkg.relation);
  }
  return (name, version) => ({ relation: relations.get(JSON.stringify([nugetKey(name), version])) ?? "unknown" });
}
