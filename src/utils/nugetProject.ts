/**
 * .NETのプロジェクトと情報源の対応付け(docs/DESIGN_TODO.md「.NET(NuGet)対応」「検出とプロジェクトごとの対応付け」)。
 *
 * 単位はプロジェクトのファイル(`*.csproj`・`*.fsproj`・`*.vbproj`)。同じディレクトリの複数のプロジェクトを
 * 1つのlockfileで完全とみなさない。プロジェクトごとに、そのプロジェクトのものと確認できた情報源を次の順で使う:
 * 1. lockfile(`packages.<名前>.lock.json`、またはプロジェクトが1つだけのディレクトリの`packages.lock.json`)。
 *    `packages.config`(`packages.<名前>.config`)も同じ規則
 * 2. `obj/project.assets.json`(`project.restore.projectPath`がそのプロジェクトのファイルと一致する場合だけ)
 * 3. プロジェクトのファイルの`PackageReference`(直接依存だけ。下限の指定は下限として照会する)
 * 対応付けを確認できないlockfileも、載っているパッケージは実在するためスキャンする(どのプロジェクトも確認済みにしない)。
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import { capitalizeReason, readRegularFile } from "./safeRead.js";
import { createNpmLockWorkBudget, type NpmLockWorkBudget } from "./npmLockCopy.js";
import {
  analyzeProjectFile,
  hasNonNugetOrgSource,
  packageReferenceNames,
  parseDepsJson,
  parsePackagesConfig,
  parsePackagesLock,
  parseProjectAssets,
  parseXml,
  nugetRelations,
  type NugetPackage,
  type NugetParseOutcome,
  type ProjectAssets,
  type UnresolvedReason,
} from "./nugetFiles.js";
import { createNugetGraphBudget, enrichNugetRelations, nugetGraphOrigins, type NugetGraph } from "./nugetDependencyGraph.js";
import type { RelationLookup } from "./dependencyRelations.js";

export const NUGET_LOCKFILE = /^packages(?:\.(.+))?\.lock\.json$/i;
export const NUGET_PACKAGES_CONFIG = /^packages(?:\.(.+))?\.config$/i;
export const NUGET_DEPS_JSON = /^.+\.deps\.json$/i;
export const NUGET_PROJECT_FILE = /^.+\.(?:cs|fs|vb)proj$/i;
export const NUGET_DIRECTORY_BUILD = /^directory\.build\.(?:props|targets)$/i;
export const NUGET_CONFIG = /^nuget\.config$/i;
export const NUGET_PROJECT_ASSETS = "project.assets.json";

/** 表示用の形式(osv-scannerには常に`packages.lock.json`形式のコピーを渡す) */
export type NugetSourceFormat = "packages.lock.json" | "packages.config" | "project.assets.json" | "deps.json" | "PackageReference";

export interface NugetFiles {
  /** いずれもprojectDirからの相対パス */
  projectFiles: string[];
  lockfiles: string[];
  packagesConfigs: string[];
  depsJson: string[];
  /** 直接指定された`project.assets.json` */
  projectAssets: string[];
  directoryBuildFiles: string[];
  nugetConfigs: string[];
}

export function emptyNugetFiles(): NugetFiles {
  return { projectFiles: [], lockfiles: [], packagesConfigs: [], depsJson: [], projectAssets: [], directoryBuildFiles: [], nugetConfigs: [] };
}

/** 走査で見つけたファイルを振り分ける。マニフェスト(スキャンの対象)として数えるものはtrue */
export function collectNugetFile(files: NugetFiles, relativePath: string, name: string): boolean | null {
  if (NUGET_LOCKFILE.test(name)) return files.lockfiles.push(relativePath), true;
  if (NUGET_PACKAGES_CONFIG.test(name)) return files.packagesConfigs.push(relativePath), true;
  if (NUGET_DEPS_JSON.test(name)) return files.depsJson.push(relativePath), true;
  if (NUGET_PROJECT_FILE.test(name)) return files.projectFiles.push(relativePath), false;
  if (NUGET_DIRECTORY_BUILD.test(name)) return files.directoryBuildFiles.push(relativePath), false;
  if (NUGET_CONFIG.test(name)) return files.nugetConfigs.push(relativePath), false;
  return null;
}

export interface NugetCopy {
  /** 元のファイルのprojectDirからの相対パス */
  path: string;
  format: NugetSourceFormat;
  packages: NugetPackage[];
  graphs?: NugetGraph[];
  relations?: RelationLookup;
}

export interface NugetAnalysis {
  manifests: { path: string; format: NugetSourceFormat }[];
  copies: NugetCopy[];
  localProjects: number;
  unscannable: { file: string; name: string; version: string; reason: string }[];
  unresolved: { file: string; name: string; specifier: string; reason: UnresolvedReason }[];
  lockfileMissing: { path: string; status: "direct_only" | "unconfirmed"; hint: string }[];
  skippedFiles: { path: string; reason: string }[];
  warnings: string[];
}

const MAX_JSON_FILE_BYTES = 16 * 1024 * 1024;
const MAX_XML_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_NUGET_FILES = 10_000;
const MAX_ASSOCIATION_WORK = 1_000_000;
/**
 * project.assets.jsonがプロジェクトのファイルよりこれ以上古い場合だけ「古い可能性」を示す。
 * git cloneやダウンロードはファイルを任意の順に書くため、わずかな差では古さを判断できない(実物の確認で判明)
 */
const STALE_ASSETS_TOLERANCE_MS = 60_000;
/** 照会するパッケージの数の上限(スキャン全体) */
export const MAX_NUGET_PACKAGES = 200_000;
/**
 * osv-scannerに渡す.NETのコピーの数の上限(走査のマニフェストの上限と同じ)。コピーごとに`--lockfile`の引数になり、
 * 9,000件で引数の長さの上限(macOSのARG_MAX 1MiB)を超えてスキャン全体がinternal_errorになっていた(脆弱性チェックで判明)
 */
export const MAX_NUGET_COPIES = 1_000;
/** 「古い可能性」の注意に名前を挙げるproject.assets.jsonの数(残りは件数だけ示す) */
const MAX_STALE_LISTED = 5;

const DIRECT_ONLY_HINT =
  "No packages.lock.json or obj/project.assets.json was found for this project, so only its direct PackageReference items were scanned " +
  "(transitive dependencies were not). Set <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile> in the project and run " +
  "`dotnet restore` in a trusted environment, then scan again";
const UNCONFIRMED_HINT =
  "A lockfile exists in this directory, but it cannot be confirmed to belong to this project (several projects share the directory, " +
  "or NuGetLockFilePath is set), so only the project's direct PackageReference items were scanned. " +
  "For several projects in one directory, NuGet uses packages.<project_name>.lock.json";

export const NUGET_LOWER_BOUND_WARNING =
  "Some packages were looked up at the lower bound of a PackageReference version (Version=\"x\" means x or higher); " +
  "the restored version may be higher. They are marked version_is_lower_bound";
export const NUGET_DIRECT_ONLY_WARNING =
  "For projects scanned from PackageReference items only, references added implicitly by the .NET SDK or by Directory.Build.props / " +
  "Directory.Build.targets outside the scanned directory are not checked";
export const NUGET_PRIVATE_FEED_WARNING =
  "A nuget.config lists package sources other than nuget.org. The names of packages from private feeds are also sent to api.osv.dev " +
  "(lockfiles do not record which feed a package came from, so they cannot be excluded)";

function projectBaseName(projectFile: string): string {
  return path.basename(projectFile).replace(/\.[^.]+$/, "").toLowerCase();
}

class Reader {
  private remaining = MAX_TOTAL_BYTES;
  readonly jsonBudget: NpmLockWorkBudget = createNpmLockWorkBudget();

  constructor(private readonly projectDir: string) {}

  /** null=存在しない。失敗はreasonで返す */
  async read(relative: string, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; reason: string } | null> {
    if (this.remaining <= 0) return { ok: false, reason: "Not read because the total size of the .NET files exceeded the limit" };
    const result = await readRegularFile(path.join(this.projectDir, relative), {
      maxBytes: Math.min(maxBytes, this.remaining),
      boundary: this.projectDir,
    });
    if (!result.ok) return result.failure === "not_found" ? null : { ok: false, reason: capitalizeReason(result.message) };
    this.remaining -= result.bytes.length;
    return { ok: true, text: result.bytes.toString("utf8") };
  }
}

/** 名前付きの情報源(`packages.<名前>.lock.json`等)の対象のプロジェクト。null=確認できない */
function ownerOf(
  file: string,
  pattern: RegExp,
  projectsByDir: ReadonlyMap<string, readonly string[]>,
  customLockPath: ReadonlySet<string>,
  chargeWork: () => void,
): string | null {
  const named = pattern.exec(path.basename(file))?.[1];
  const projects = projectsByDir.get(path.dirname(file)) ?? [];
  let owner: string | null;
  if (named !== undefined) {
    const key = named.toLowerCase();
    const matches = projects.filter((p) => {
      chargeWork();
      return projectBaseName(p) === key;
    });
    owner = matches.length === 1 ? matches[0]! : null;
  } else {
    owner = projects.length === 1 ? projects[0]! : null;
  }
  // NuGetLockFilePathは既定の名前(名前付きの`packages.<名前>.lock.json`も含む)のlockfileとの対応を変える。
  // 名前付きの分岐で先に返すと、別の保存先を指定したプロジェクトが古い名前付きlockfileで確認済みになっていた(レビュー指摘)。
  // packages.configには関係しない
  if (owner !== null && pattern === NUGET_LOCKFILE && customLockPath.has(owner)) return null;
  return owner;
}

export async function analyzeNuget(projectDir: string, files: NugetFiles): Promise<NugetAnalysis> {
  // Project/support files are not charged against the walker's manifest limit.
  if (Object.values(files).reduce((sum, list) => sum + list.length, 0) > MAX_NUGET_FILES) {
    throw new ScanToolError("scan_input_too_large", `The .NET file count exceeds the limit (${MAX_NUGET_FILES}). Narrow the target and try again`);
  }
  let associationWork = MAX_ASSOCIATION_WORK;
  const chargeAssociation = () => {
    if (--associationWork < 0) throw new ScanToolError("scan_input_too_large", "The .NET project association work limit was exceeded. Narrow the target and try again");
  };
  const result: NugetAnalysis = {
    manifests: [], copies: [], localProjects: 0, unscannable: [], unresolved: [], lockfileMissing: [], skippedFiles: [], warnings: [],
  };
  const reader = new Reader(projectDir);
  let packageBudget = MAX_NUGET_PACKAGES;
  let lowerBounds = false;
  let directOnly = false;
  const staleAssets: string[] = [];
  const sourceOwners = new Map<string, Set<string>>();
  const recordOwner = (file: string, owner: string) => {
    const owners = sourceOwners.get(file) ?? new Set<string>(); owners.add(owner); sourceOwners.set(file, owners);
  };

  const addCopy = (file: string, format: NugetSourceFormat, outcome: Extract<NugetParseOutcome, { ok: true }>) => {
    let packages = outcome.packages;
    if (packages.length > packageBudget) {
      result.skippedFiles.push({ path: file, reason: `Only the first ${packageBudget} packages were scanned (the per-scan limit of ${MAX_NUGET_PACKAGES} was reached)` });
      packages = packages.slice(0, packageBudget);
    }
    if (packages.length > 0 && result.copies.length >= MAX_NUGET_COPIES) {
      // スキャンしないファイルはマニフェストにも数えない(範囲の欠けとして示し、complete: falseになる)
      result.skippedFiles.push({ path: file, reason: `Not scanned because the per-scan limit of ${MAX_NUGET_COPIES} .NET files to scan was reached. Narrow the target` });
      return;
    }
    packageBudget -= packages.length;
    result.localProjects += outcome.localProjects;
    result.unscannable.push(...outcome.unscannable.map((u) => ({ file, ...u })));
    result.manifests.push({ path: file, format });
    if (packages.length > 0) result.copies.push({ path: file, format, packages, graphs: outcome.graphs });
  };

  const parseFile = async (
    file: string,
    maxBytes: number,
    parse: (text: string) => NugetParseOutcome,
  ): Promise<Extract<NugetParseOutcome, { ok: true }> | null> => {
    const read = await reader.read(file, maxBytes);
    if (read === null) return null;
    if (!read.ok) {
      result.skippedFiles.push({ path: file, reason: read.reason });
      return null;
    }
    const parsed = parse(read.text);
    if (!parsed.ok) {
      result.skippedFiles.push({ path: file, reason: parsed.reason });
      return null;
    }
    return parsed;
  };

  // プロジェクトのファイル(lockfileの対応付けにNuGetLockFilePathを使うため先に読む)
  const projectsByDir = new Map<string, string[]>();
  for (const project of files.projectFiles) {
    const dir = path.dirname(project);
    let projects = projectsByDir.get(dir);
    if (projects === undefined) projectsByDir.set(dir, projects = []);
    projects.push(project);
  }
  const directoryBuildNames = new Map<string, Set<string>>();
  for (const file of files.directoryBuildFiles) {
    const read = await reader.read(file, MAX_XML_FILE_BYTES);
    if (read === null) continue;
    const xml = read.ok ? parseXml(read.text) : null;
    const dir = path.dirname(file);
    let names = directoryBuildNames.get(dir);
    if (names === undefined) directoryBuildNames.set(dir, names = new Set());
    if (xml?.ok) {
      for (const name of packageReferenceNames(xml.root)) {
        chargeAssociation();
        names.add(name);
      }
    } else {
      // 読めない場合は、その下のプロジェクトの参照を全て「上書きされうる」とする
      names.add("*");
      result.skippedFiles.push({
        path: file,
        reason: `${read.ok ? `Could not be parsed: ${xml!.ok ? "" : xml!.reason}` : read.reason}; package references of the projects below it are not looked up`,
      });
    }
  }
  const projectAnalyses = new Map<string, Awaited<ReturnType<typeof analyzeProjectFile>> | { ok: false; reason: string }>();
  const customLockPath = new Set<string>();
  for (const project of files.projectFiles) {
    const read = await reader.read(project, MAX_XML_FILE_BYTES);
    if (read === null) continue;
    const external = new Set<string>();
    // Only ancestors can affect this project; unrelated Directory.Build files
    // must not produce a projects × support-files traversal.
    for (let dir = path.dirname(project); ; dir = path.dirname(dir)) {
      chargeAssociation();
      for (const name of directoryBuildNames.get(dir) ?? []) {
        chargeAssociation();
        external.add(name);
      }
      if (dir === "." || dir === "" || path.dirname(dir) === dir) break;
    }
    const analysis = read.ok ? analyzeProjectFile(read.text, external) : read;
    projectAnalyses.set(project, analysis);
    if (analysis.ok && analysis.customLockFilePath) customLockPath.add(project);
  }

  const covered = new Set<string>();
  const unownedLockDirs = new Set<string>();
  for (const [list, pattern, format, parse] of [
    [files.lockfiles, NUGET_LOCKFILE, "packages.lock.json", (t: string) => parsePackagesLock(t, reader.jsonBudget)],
    [files.packagesConfigs, NUGET_PACKAGES_CONFIG, "packages.config", parsePackagesConfig],
  ] as const) {
    for (const file of list) {
      const parsed = await parseFile(file, format === "packages.config" ? MAX_XML_FILE_BYTES : MAX_JSON_FILE_BYTES, parse);
      if (parsed === null) continue;
      addCopy(file, format, parsed);
      const owner = ownerOf(file, pattern, projectsByDir, customLockPath, chargeAssociation);
      if (owner !== null) { covered.add(owner); recordOwner(file, owner); }
      else if (format === "packages.lock.json") unownedLockDirs.add(path.dirname(file));
    }
  }
  for (const file of files.depsJson) {
    const parsed = await parseFile(file, MAX_JSON_FILE_BYTES, (t) => parseDepsJson(t, reader.jsonBudget));
    if (parsed !== null) addCopy(file, "deps.json", parsed);
  }
  const usedAssets = new Set<string>();
  const assetsAddCopy = (file: string, parsed: Extract<ReturnType<typeof parseProjectAssets>, { ok: true }>) => {
    if (usedAssets.has(file)) return;
    usedAssets.add(file);
    addCopy(file, "project.assets.json", parsed);
  };
  for (const file of files.projectAssets) {
    const parsed = await parseFile(file, MAX_JSON_FILE_BYTES, (t) => parseProjectAssets(t, reader.jsonBudget));
    if (parsed !== null) assetsAddCopy(file, parsed as Extract<ReturnType<typeof parseProjectAssets>, { ok: true }>);
  }

  for (const project of files.projectFiles) {
    if (covered.has(project)) continue;
    // obj/project.assets.json(同じディレクトリの複数のプロジェクトはobjを共有するため、projectPathで確かめる)
    const assetsFile = path.join(path.dirname(project), "obj", NUGET_PROJECT_ASSETS);
    const assets = await parseFile(assetsFile, MAX_JSON_FILE_BYTES, (t) => parseProjectAssets(t, reader.jsonBudget)) as
      (Extract<NugetParseOutcome, { ok: true }> & ProjectAssets) | null;
    if (assets !== null) {
      const fileName = path.basename(project).toLowerCase();
      const matches = assets.projectFileName !== null
        ? assets.projectFileName.toLowerCase() === fileName
        : assets.projectName !== null && assets.projectName.toLowerCase() === projectBaseName(project);
      if (matches) {
        assetsAddCopy(assetsFile, assets);
        recordOwner(assetsFile, project);
        covered.add(project);
        const [assetsStat, projectStat] = await Promise.all([
          stat(path.join(projectDir, assetsFile)).catch(() => null),
          stat(path.join(projectDir, project)).catch(() => null),
        ]);
        if (assetsStat !== null && projectStat !== null && projectStat.mtimeMs - assetsStat.mtimeMs > STALE_ASSETS_TOLERANCE_MS) {
          staleAssets.push(assetsFile);
        }
        continue;
      }
    }
    // プロジェクトのファイルの直接依存だけ
    const analysis = projectAnalyses.get(project);
    if (analysis === undefined) continue;
    if (!analysis.ok) {
      result.skippedFiles.push({ path: project, reason: analysis.reason });
      continue;
    }
    // 直接のPackageReferenceが無くても、復元の情報を確認できないプロジェクトは範囲の欠けとして残す
    // (Directory.Build.props・SDKが参照を加える場合がある。無視すると他のlockfileと合わせてcomplete: trueになっていた。レビュー指摘)
    directOnly = true;
    const unconfirmed = unownedLockDirs.has(path.dirname(project)) || analysis.customLockFilePath;
    result.lockfileMissing.push({ path: project, status: unconfirmed ? "unconfirmed" : "direct_only", hint: unconfirmed ? UNCONFIRMED_HINT : DIRECT_ONLY_HINT });
    result.unresolved.push(...analysis.unresolved.map((u) => ({ file: project, ...u })));
    if (analysis.references.some((r) => r.lowerBound)) lowerBounds = true;
    addCopy(project, "PackageReference", { ok: true, packages: analysis.references, localProjects: 0, unscannable: [] });
    recordOwner(project, project);
  }

  const graphBudget = createNugetGraphBudget();
  let limitedGraphs = 0;
  const declarationCache = new Map<string, Set<string>>();
  for (const copy of result.copies) {
    const declared = new Map<string, string>();
    const owners = sourceOwners.get(copy.path);
    if (owners?.size === 1 && graphBudget.remaining > 0) {
      const owner = [...owners][0]!;
      const analysis = projectAnalyses.get(owner);
      let names = declarationCache.get(owner);
      if (!names && analysis?.ok) {
        names = new Set<string>();
        for (const ref of analysis.references) {
          if (--graphBudget.remaining < 0) break;
          names.add(ref.name.toLowerCase());
        }
        for (const ref of analysis.unresolved) {
          if (--graphBudget.remaining < 0) break;
          if (["property", "range", "floating", "central_package_management"].includes(ref.reason) && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(ref.name)) names.add(ref.name.toLowerCase());
        }
        if (graphBudget.remaining < 0) names.clear();
        declarationCache.set(owner, names);
      }
      if (names) for (const pkg of copy.packages) {
        if (--graphBudget.remaining < 0) { declared.clear(); break; }
        if (pkg.relation === "direct" && names.has(pkg.name.toLowerCase())) declared.set(pkg.name.toLowerCase(), path.relative(path.dirname(copy.path), owner));
      }
    }
    const origins = nugetGraphOrigins(copy.graphs ?? [], graphBudget);
    if (origins === null || graphBudget.remaining < 0) limitedGraphs++;
    copy.relations = enrichNugetRelations(nugetRelations(copy.packages), origins, declared);
    delete copy.graphs;
  }
  if (limitedGraphs > 0) result.warnings.push(`NuGet relationship analysis reached its per-scan work limit for ${limitedGraphs} source(s); introduced_by/declared_in may be unavailable. Package vulnerability scanning still ran`);

  if (staleAssets.length > 0) {
    // プロジェクトごとに1件ずつ並べると応答が際限なく大きくなるため、1件にまとめる
    const listed = staleAssets.slice(0, MAX_STALE_LISTED).join(", ");
    const rest = staleAssets.length > MAX_STALE_LISTED ? ` and ${staleAssets.length - MAX_STALE_LISTED} more` : "";
    result.warnings.push(
      `${staleAssets.length} obj/project.assets.json file(s) are older than their project files (${listed}${rest}), so they may not reflect ` +
        "the current package references. Run `dotnet restore` and scan again",
    );
  }
  if (lowerBounds) result.warnings.push(NUGET_LOWER_BOUND_WARNING);
  if (directOnly) result.warnings.push(NUGET_DIRECT_ONLY_WARNING);
  if (result.manifests.length > 0 || files.projectFiles.length > 0) {
    for (const file of files.nugetConfigs) {
      const read = await reader.read(file, MAX_XML_FILE_BYTES);
      if (read !== null && (!read.ok || hasNonNugetOrgSource(read.text))) {
        result.warnings.push(NUGET_PRIVATE_FEED_WARNING);
        break;
      }
    }
  }
  return result;
}
