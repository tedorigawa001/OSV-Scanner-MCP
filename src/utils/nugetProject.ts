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
  type NugetPackage,
  type NugetParseOutcome,
  type ProjectAssets,
  type UnresolvedReason,
} from "./nugetFiles.js";

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
/** 照会するパッケージの数の上限(スキャン全体) */
export const MAX_NUGET_PACKAGES = 200_000;

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

function isSameOrBelow(dir: string, ancestor: string): boolean {
  return ancestor === "." || ancestor === "" || dir === ancestor || dir.startsWith(`${ancestor}${path.sep}`);
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
): string | null {
  const named = pattern.exec(path.basename(file))?.[1];
  const projects = projectsByDir.get(path.dirname(file)) ?? [];
  if (named !== undefined) {
    const matches = projects.filter((p) => projectBaseName(p) === named.toLowerCase());
    return matches.length === 1 ? matches[0]! : null;
  }
  if (projects.length !== 1) return null;
  // NuGetLockFilePathは既定の名前のlockfileとの対応を変える(packages.configには関係しない)
  if (pattern === NUGET_LOCKFILE && customLockPath.has(projects[0]!)) return null;
  return projects[0]!;
}

export async function analyzeNuget(projectDir: string, files: NugetFiles): Promise<NugetAnalysis> {
  const result: NugetAnalysis = {
    manifests: [], copies: [], localProjects: 0, unscannable: [], unresolved: [], lockfileMissing: [], skippedFiles: [], warnings: [],
  };
  const reader = new Reader(projectDir);
  let packageBudget = MAX_NUGET_PACKAGES;
  let lowerBounds = false;
  let directOnly = false;

  const addCopy = (file: string, format: NugetSourceFormat, outcome: Extract<NugetParseOutcome, { ok: true }>) => {
    let packages = outcome.packages;
    if (packages.length > packageBudget) {
      result.skippedFiles.push({ path: file, reason: `Only the first ${packageBudget} packages were scanned (the per-scan limit of ${MAX_NUGET_PACKAGES} was reached)` });
      packages = packages.slice(0, packageBudget);
    }
    packageBudget -= packages.length;
    result.localProjects += outcome.localProjects;
    result.unscannable.push(...outcome.unscannable.map((u) => ({ file, ...u })));
    result.manifests.push({ path: file, format });
    if (packages.length > 0) result.copies.push({ path: file, format, packages });
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
    projectsByDir.set(dir, [...(projectsByDir.get(dir) ?? []), project]);
  }
  const directoryBuildNames: { dir: string; names: ReadonlySet<string> }[] = [];
  for (const file of files.directoryBuildFiles) {
    const read = await reader.read(file, MAX_XML_FILE_BYTES);
    if (read === null) continue;
    const xml = read.ok ? parseXml(read.text) : null;
    if (xml?.ok) {
      directoryBuildNames.push({ dir: path.dirname(file), names: packageReferenceNames(xml.root) });
    } else {
      // 読めない場合は、その下のプロジェクトの参照を全て「上書きされうる」とする
      directoryBuildNames.push({ dir: path.dirname(file), names: new Set(["*"]) });
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
    for (const { dir, names } of directoryBuildNames) {
      if (isSameOrBelow(path.dirname(project), dir)) for (const name of names) external.add(name);
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
      const owner = ownerOf(file, pattern, projectsByDir, customLockPath);
      if (owner !== null) covered.add(owner);
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
        covered.add(project);
        const [assetsStat, projectStat] = await Promise.all([
          stat(path.join(projectDir, assetsFile)).catch(() => null),
          stat(path.join(projectDir, project)).catch(() => null),
        ]);
        if (assetsStat !== null && projectStat !== null && assetsStat.mtimeMs < projectStat.mtimeMs) {
          result.warnings.push(`${assetsFile} is older than ${project}, so it may not reflect the current package references. Run \`dotnet restore\` and scan again`);
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
    // パッケージの参照を書いていないプロジェクト(参照するのはプロジェクトだけ等)は、範囲の欠けとして示さない
    if (analysis.references.length === 0 && analysis.unresolved.length === 0) continue;
    directOnly = true;
    const unconfirmed = unownedLockDirs.has(path.dirname(project)) || analysis.customLockFilePath;
    result.lockfileMissing.push({ path: project, status: unconfirmed ? "unconfirmed" : "direct_only", hint: unconfirmed ? UNCONFIRMED_HINT : DIRECT_ONLY_HINT });
    result.unresolved.push(...analysis.unresolved.map((u) => ({ file: project, ...u })));
    if (analysis.references.some((r) => r.lowerBound)) lowerBounds = true;
    addCopy(project, "PackageReference", { ok: true, packages: analysis.references, localProjects: 0, unscannable: [] });
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
