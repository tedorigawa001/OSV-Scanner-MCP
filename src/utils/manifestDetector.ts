/**
 * `scan_project`用の検出: Java / JavaScript / Python / Go / Rust / .NETのlockfileを列挙する。
 *
 * - 検出したファイルだけをosv-scannerに渡す(ディレクトリは渡さない)。解析形式も明示する
 * - パッケージマネージャー・ビルドは実行しない。lockfileが無いマニフェストはcoverageに記録する
 * - requirements.txtは取り込み先を検証し、プロジェクト外を読む場合はスキャン対象から外す
 * - Cargo.lockはここで解析し、crates.io由来のパッケージだけをスキャンする(cargoLock.ts)
 * - .NETはプロジェクトのファイルごとに情報源を対応付け、照会してよいパッケージだけをスキャンする(nugetProject.ts)
 *
 * 検出・除外の根拠はdocs/DESIGN_TODO.md「対象エコシステム拡大 詳細設計メモ」を参照。
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import { isManifestFormat, type ManifestFormat, type ManifestTarget } from "./manifestFormats.js";
import {
  assertInsideAllowedRoot,
  resolveExistingPath,
  walkProjectFiles,
  type SearchLimitOptions,
} from "./projectWalk.js";
import { capitalizeReason, readRegularFile } from "./safeRead.js";
import { createNpmLockWorkBudget, MAX_NPM_LOCK_BYTES, MAX_NPM_LOCK_TOTAL_BYTES, parseNpmLock } from "./npmLockCopy.js";
import {
  analyzeRequirementsFile,
  createRequirementsReadContext,
  type LowerBound,
  type RequirementIssue,
  type RequirementReference,
} from "./requirementsFile.js";
import {
  cargoTomlPackageName,
  cargoWorkspace,
  workspaceIncludes,
  createGlobWorkBudget,
  type GlobWorkBudget,
  type CargoWorkspace,
  classifyCargoPackages,
  createCargoLockParseBudget,
  parseCargoLock,
  UNSCANNABLE_CRATE_REASONS,
  type CargoLockClassification,
  type CargoPackage,
} from "./cargoLock.js";
import {
  analyzeNuget,
  collectNugetFile,
  emptyNugetFiles,
  NUGET_DEPS_JSON,
  NUGET_LOCKFILE,
  NUGET_PACKAGES_CONFIG,
  NUGET_PROJECT_ASSETS,
  NUGET_PROJECT_FILE,
  type NugetCopy,
  type NugetFiles,
  type NugetSourceFormat,
} from "./nugetProject.js";
import type { UnresolvedReason } from "./nugetFiles.js";

import { composerLockCopy, type ComposerCopy } from "./composerLock.js";
import { composerRelations, composerRootRequirements, createComposerRelationBudget } from "./composerRelations.js";

export type Ecosystem = "Maven" | "npm" | "PyPI" | "Go" | "crates.io" | "NuGet" | "Packagist";

/** ファイル名→(エコシステム, 解析形式)。npm-shrinkwrap.jsonはpackage-lock.json形式で解析する */
const LOCKFILES = new Map<string, { ecosystem: Ecosystem; format: ManifestFormat }>([
  ["pom.xml", { ecosystem: "Maven", format: "pom.xml" }],
  ["gradle.lockfile", { ecosystem: "Maven", format: "gradle.lockfile" }],
  ["buildscript-gradle.lockfile", { ecosystem: "Maven", format: "buildscript-gradle.lockfile" }],
  ["package-lock.json", { ecosystem: "npm", format: "package-lock.json" }],
  ["npm-shrinkwrap.json", { ecosystem: "npm", format: "package-lock.json" }],
  ["yarn.lock", { ecosystem: "npm", format: "yarn.lock" }],
  ["pnpm-lock.yaml", { ecosystem: "npm", format: "pnpm-lock.yaml" }],
  ["bun.lock", { ecosystem: "npm", format: "bun.lock" }],
  ["poetry.lock", { ecosystem: "PyPI", format: "poetry.lock" }],
  ["uv.lock", { ecosystem: "PyPI", format: "uv.lock" }],
  ["Pipfile.lock", { ecosystem: "PyPI", format: "Pipfile.lock" }],
  ["pdm.lock", { ecosystem: "PyPI", format: "pdm.lock" }],
  ["go.mod", { ecosystem: "Go", format: "go.mod" }],
  ["Cargo.lock", { ecosystem: "crates.io", format: "Cargo.lock" }],
  ["composer.lock", { ecosystem: "Packagist", format: "composer.lock" }],
]);

/** requirements.txt / requirements-dev.txt / dev-requirements.txt 等 */
const REQUIREMENTS_NAME = /^(?:[\w.]+[-_])?requirements(?:[-_][\w.]+)?\.txt$/;

type LockGroup = "npm" | "pypi" | "gradle" | "cargo" | "composer";

/** lockfileが無ければスキャンできないマニフェスト */
const LOCK_MARKERS = new Map<string, LockGroup>([
  ["package.json", "npm"],
  ["pyproject.toml", "pypi"],
  ["Pipfile", "pypi"],
  ["setup.py", "pypi"],
  ["setup.cfg", "pypi"],
  ["build.gradle", "gradle"],
  ["build.gradle.kts", "gradle"],
  ["settings.gradle", "gradle"],
  ["settings.gradle.kts", "gradle"],
  ["Cargo.toml", "cargo"],
  ["composer.json", "composer"],
]);

const LOCK_GROUP_ECOSYSTEM: Record<LockGroup, Ecosystem> = { npm: "npm", pypi: "PyPI", gradle: "Maven", cargo: "crates.io", composer: "Packagist" };

const LOCKFILE_HINTS: Record<LockGroup, string> = {
  composer: "No composer.lock. Generate it in a trusted environment with `composer update --no-install --no-scripts --no-plugins`, then scan again. Composer and PHP code are never executed by this server",
  npm:
    "No lockfile. Run `npm install --package-lock-only --ignore-scripts` in a trusted environment " +
    "(for yarn / pnpm / bun, generate the lockfile with that tool), then scan again",
  pypi:
    "No lockfile (poetry.lock / uv.lock / Pipfile.lock / pdm.lock) or requirements.txt with pinned versions. " +
    "Generate one in a trusted environment, then scan again (generating it may run build scripts)",
  gradle:
    "No gradle.lockfile. Run `./gradlew dependencies --write-locks` in a trusted environment, then scan again " +
    "(if dependency locking is not configured, add dependencyLocking { lockAllConfigurations() } to build.gradle)",
  cargo:
    "No Cargo.lock. Run `cargo generate-lockfile` in a trusted environment (it fetches the registry index; " +
    "for a workspace member, run it at the workspace root), then scan again",
};

const SKIPPED_DIRS = new Set([
  ".git", "node_modules", "target", "build", ".idea", ".vscode",
  ".venv", "venv", "site-packages", "__pycache__", ".tox", "vendor", ".cargo",
]);

/** .NETのプロジェクトのディレクトリのビルド出力(同じプロジェクトの重複。obj/project.assets.jsonは直接読む) */
const DOTNET_OUTPUT_DIRS: ReadonlySet<string> = new Set(["bin", "obj"]);
const NONE: ReadonlySet<string> = new Set();

function dotnetOutputDirs(entryNames: readonly string[]): ReadonlySet<string> {
  return entryNames.some((name) => NUGET_PROJECT_FILE.test(name)) ? DOTNET_OUTPUT_DIRS : NONE;
}

export interface DetectedManifest {
  /** projectDirからの相対パス */
  path: string;
  ecosystem: Ecosystem;
  /** .NETは元の形式を示す(osv-scannerには常にpackages.lock.json形式のコピーを渡す) */
  format: ManifestFormat | NugetSourceFormat;
}

export interface LockfileMissing {
  /** lockfileの無いマニフェストのprojectDirからの相対パス */
  path: string;
  ecosystem: Ecosystem;
  /**
   * missing: 対応するlockfileが無い / unconfirmed: 上位のlockfileに収録されているか確認できない
   * (.NET: lockfileはあるが、このプロジェクトのものと確認できない) / direct_only: .NETのプロジェクトのファイルの直接依存だけをスキャンした
   */
  status: "missing" | "unconfirmed" | "direct_only";
  hint: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

/** requirements.txtはosv-scannerに直接渡さず、検証済みの内容を専用コピーに書いてスキャンする */
export interface RequirementsCopy {
  /** 元ファイルのprojectDirからの相対パス */
  path: string;
  /** コピーに書く正規化済みの行。空ならスキャンしない */
  entries: string[];
}

/** Cargo.lockはosv-scannerに直接渡さず、crates.io由来のパッケージだけをコピーに書いてスキャンする */
export interface CargoCopy {
  allPackages: CargoPackage[];
  declaringManifests: Map<string, string>;
  /** 元ファイルのprojectDirからの相対パス */
  path: string;
  /** コピーに書くパッケージ。空ならスキャンしない */
  packages: CargoPackage[];
}

/** スキャンしなかったcrate(gitの依存・別レジストリの依存) */
export interface UnscannableCrateEntry {
  /** Cargo.lockのprojectDirからの相対パス */
  file: string;
  name: string;
  version: string;
  reason: string;
}

export interface DetectedProject {
  projectDir: string;
  /** 解決済みの許可ルート(未設定ならundefined)。親POMの検証に使う */
  allowedRootReal: string | undefined;
  manifests: DetectedManifest[];
  /** スキャン対象の元のlockfile(requirements.txtは含まない)。osv-scannerにはスナップショットのコピーを渡す */
  targets: ManifestTarget[];
  requirementsCopies: RequirementsCopy[];
  cargoCopies: CargoCopy[];
  composerCopies?: ComposerCopy[];
  composerWarnings?: string[];
  /** composer.lockのdist.type=path(自分のコード)で、照会しなかったパッケージの数 */
  composerLocalPackages?: number;
  /** sourceなし(workspaceのメンバー・pathの依存)で、スキャンしなかったcrateの数(Cargo.lockごとに数えた合計) */
  localCrateCount: number;
  unscannableCrates: UnscannableCrateEntry[];
  lockfileMissing: LockfileMissing[];
  /** パスは絶対パス(表示時に相対化する) */
  requirementIssues: RequirementIssue[];
  requirementReferences: RequirementReference[];
  lowerBounds: LowerBound[];
  skippedFiles: SkippedFile[];
  /** .NET: osv-scannerにはpackages.lock.json形式のコピーを渡す */
  nugetCopies: NugetCopy[];
  /** .NETの自分のプロジェクト(type: project等)で、照会しなかったものの数 */
  localProjectCount: number;
  unscannableNugetPackages: { file: string; name: string; version: string; reason: string }[];
  unresolvedPackageReferences: { file: string; name: string; specifier: string; reason: UnresolvedReason }[];
  nugetWarnings: string[];
  /** .NETのファイルを1つでも検出した(応答の.NETの項目を付けるか) */
  hasNuget: boolean;
}

export interface DetectProjectOptions extends SearchLimitOptions {
  allowedRoot?: string;
}

/** 直接指定できる.NETのファイル(プロジェクトのファイルは、そのディレクトリを走査する) */
function isDirectNugetFile(name: string): boolean {
  return NUGET_LOCKFILE.test(name) || NUGET_PACKAGES_CONFIG.test(name) || NUGET_DEPS_JSON.test(name) || name === NUGET_PROJECT_ASSETS;
}

function classifyFile(name: string): { ecosystem: Ecosystem; format: ManifestFormat } | null {
  const lockfile = LOCKFILES.get(name);
  if (lockfile) return lockfile;
  if (REQUIREMENTS_NAME.test(name)) return { ecosystem: "PyPI", format: "requirements.txt" };
  return null;
}

function satisfiesGroup(manifest: DetectedManifest, group: LockGroup): boolean {
  if (group === "gradle") return manifest.format === "gradle.lockfile" || manifest.format === "buildscript-gradle.lockfile";
  return manifest.ecosystem === LOCK_GROUP_ECOSYSTEM[group];
}

/** dirがancestor自身またはその配下か(projectDirからの相対パス同士で判定) */
function isSameOrDescendant(dir: string, ancestor: string): boolean {
  return ancestor === "." || dir === ancestor || dir.startsWith(`${ancestor}${path.sep}`);
}

/** Cargo.lockの読み込み合計の上限(npm JSONにはnpmLockCopy.tsの上限を使う) */
const MAX_LOCKFILE_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * workspaceの収録確認用に、package-lock.jsonの`packages`のキー一覧を1回だけ読む。
 * package.jsonの数だけ同じlockfileを解析し直すと、巨大なlockfileで負荷が増大するため、
 * lockfileごとに結果を使い回し、読む量の合計にも上限を設ける。
 */
export class LockfileKeyCache {
  private readonly keys = new Map<string, Set<string> | null>();
  private readonly workBudget = createNpmLockWorkBudget();
  private remaining: number;

  constructor(maxTotalBytes = MAX_NPM_LOCK_TOTAL_BYTES) {
    this.remaining = maxTotalBytes;
  }

  /** 収録済みのキー。null=確認できない(v1形式・読めない・大きすぎる・上限超過) */
  async get(lockAbs: string, projectDir: string): Promise<Set<string> | null> {
    if (this.keys.has(lockAbs)) return this.keys.get(lockAbs)!;
    let keys: Set<string> | null = null;
    if (this.remaining > 0) {
      const read = await readRegularFile(lockAbs, { maxBytes: Math.min(MAX_NPM_LOCK_BYTES, this.remaining), boundary: projectDir });
      if (read.ok) {
        this.remaining -= read.bytes.length;
        try {
          const packages: unknown = (parseNpmLock(read.bytes.toString("utf8"), this.workBudget) as { packages?: unknown }).packages;
          if (typeof packages === "object" && packages !== null) keys = new Set(Object.keys(packages));
        } catch {
          keys = null;
        }
      }
    }
    this.keys.set(lockAbs, keys);
    return keys;
  }
}

/** Cargo.lock1件の上限(読み込み自体の上限。合計はLockfileKeyCacheと同じ上限) */
const MAX_CARGO_LOCK_BYTES = 64 * 1024 * 1024;
const MAX_CARGO_TOML_BYTES = 1024 * 1024;

/**
 * Cargo.lockの解析結果を1回だけ作る(workspaceの収録確認とスキャン対象の生成で共用)。
 * 元のファイルは安全に読み(safeRead)、osv-scannerには渡さない
 */
export class CargoLockCache {
  private readonly results = new Map<string, CargoLockClassification | { reason: string }>();
  private readonly parseBudget = createCargoLockParseBudget();
  private remaining: number;
  private readonly tomls = new Map<string, string | null>();
  private remainingToml = MAX_LOCKFILE_TOTAL_BYTES;

  async toml(file: string, projectDir: string): Promise<string | null> {
    if (this.tomls.has(file)) return this.tomls.get(file)!;
    const read = this.remainingToml > 0
      ? await readRegularFile(file, { maxBytes: Math.min(MAX_CARGO_TOML_BYTES, this.remainingToml), boundary: projectDir }) : null;
    const text = read?.ok ? read.bytes.toString("utf8") : null;
    if (read?.ok) this.remainingToml -= read.bytes.length;
    this.tomls.set(file, text);
    return text;
  }

  constructor(maxTotalBytes = MAX_LOCKFILE_TOTAL_BYTES) {
    this.remaining = maxTotalBytes;
  }

  async get(lockAbs: string, projectDir: string): Promise<CargoLockClassification | { reason: string }> {
    const cached = this.results.get(lockAbs);
    if (cached !== undefined) return cached;
    let result: CargoLockClassification | { reason: string };
    if (this.remaining <= 0) {
      result = { reason: "Not read because the total size of the Cargo.lock files exceeded the limit" };
    } else {
      const read = await readRegularFile(lockAbs, { maxBytes: Math.min(MAX_CARGO_LOCK_BYTES, this.remaining), boundary: projectDir });
      if (!read.ok) {
        result = { reason: capitalizeReason(read.message) };
      } else {
        this.remaining -= read.bytes.length;
        const parsed = parseCargoLock(read.bytes.toString("utf8"), this.parseBudget);
        result = parsed.ok ? classifyCargoPackages(parsed.packages) : { reason: parsed.reason };
      }
    }
    this.results.set(lockAbs, result);
    return result;
  }

  private readonly workspaces = new Map<string, CargoWorkspace | null>();
  /** workspaceの所属の判定のglobの照合の計算量(1回の検出全体で共有する) */
  readonly globBudget: GlobWorkBudget = createGlobWorkBudget();

  /** Cargo.lockと同じディレクトリのCargo.tomlの`[workspace]`(1回だけ読む)。無い・読めない場合はnull */
  async workspace(lockAbs: string, projectDir: string): Promise<CargoWorkspace | null> {
    if (this.workspaces.has(lockAbs)) return this.workspaces.get(lockAbs)!;
    const text = await this.toml(path.join(path.dirname(lockAbs), "Cargo.toml"), projectDir);
    const workspace = text === null ? null : cargoWorkspace(text);
    this.workspaces.set(lockAbs, workspace);
    return workspace;
  }
}

/**
 * 上位のCargo.lockに、メンバーのCargo.tomlのcrateが収録されているか。
 * - 同名のsourceなしパッケージが無ければ未収録(false)。workspaceのメンバーでもpathの依存でもない
 * - 同名があっても名前だけでは所属を確定しない(独立したサブプロジェクトが同名のこともある)。
 *   Cargo.lockと同じディレクトリのCargo.tomlの`[workspace]`の`members`・`exclude`で所属を確認できた場合だけ収録(true)
 * - それ以外は確認できない(null): `[package] name`を読めない、lockfileを解析できない、`[workspace]`が無い・解釈できない、
 *   `members`に含まれない(pathの依存として収録されている可能性がある)、解釈できないglob
 */
async function cargoLockfileRecords(
  cache: CargoLockCache,
  projectDir: string,
  lockfile: DetectedManifest,
  memberToml: string,
): Promise<boolean | null> {
  const lock = await cache.get(path.join(projectDir, lockfile.path), projectDir);
  if ("reason" in lock) return null;
  const text = await cache.toml(path.join(projectDir, memberToml), projectDir);
  const name = text === null ? null : cargoTomlPackageName(text);
  if (name === null) return null;
  if (!lock.localCrates.includes(name)) return false;
  const lockAbs = path.join(projectDir, lockfile.path);
  const workspace = await cache.workspace(lockAbs, projectDir);
  if (workspace === null) return null;
  const memberDir = path.relative(path.dirname(lockAbs), path.join(projectDir, path.dirname(memberToml))).split(path.sep).join("/");
  return workspaceIncludes(workspace, memberDir, cache.globBudget) === true ? true : null;
}

/**
 * package-lock.json(v2以降)の`packages`に、memberDirのエントリがあるか。
 * true=収録 / false=未収録 / null=確認できない
 */
async function npmLockfileRecords(
  cache: LockfileKeyCache,
  projectDir: string,
  lockfile: DetectedManifest,
  memberDir: string,
): Promise<boolean | null> {
  const lockAbs = path.join(projectDir, lockfile.path);
  const keys = await cache.get(lockAbs, projectDir);
  if (keys === null) return null;
  const key = path.relative(path.dirname(lockAbs), path.join(projectDir, memberDir)).split(path.sep).join("/");
  return keys.has(key);
}

/**
 * lockfileの無いマーカー(package.json等)を判定する。
 * - 同じディレクトリに同じエコシステムのlockfileがあれば充足
 * - 上位のlockfileだけの場合は、収録を確認できたときだけ充足(npm workspacesのpackage-lock.json)。
 *   workspace設定の無いルートのlockfileで、独立した子プロジェクトの欠落を隠さないため
 */
async function findLockfileMissing(
  projectDir: string,
  markers: readonly { path: string; group: LockGroup }[],
  manifests: readonly DetectedManifest[],
  cargoCache: CargoLockCache,
): Promise<LockfileMissing[]> {
  const cache = new LockfileKeyCache();
  const missing: LockfileMissing[] = [];
  for (const marker of markers) {
    const markerDir = path.dirname(marker.path);
    const candidates = manifests.filter(
      (m) => satisfiesGroup(m, marker.group) && isSameOrDescendant(markerDir, path.dirname(m.path)),
    );
    if (candidates.some((m) => path.dirname(m.path) === markerDir)) continue;
    const base = { path: marker.path, ecosystem: LOCK_GROUP_ECOSYSTEM[marker.group] };
    if (candidates.length === 0) {
      missing.push({ ...base, status: "missing", hint: LOCKFILE_HINTS[marker.group] });
      continue;
    }
    let confirmedAbsent = true;
    let recorded = false;
    for (const candidate of candidates) {
      const result = candidate.format === "package-lock.json"
        ? await npmLockfileRecords(cache, projectDir, candidate, markerDir)
        : candidate.format === "Cargo.lock"
          ? await cargoLockfileRecords(cargoCache, projectDir, candidate, marker.path)
          : null;
      if (result === true) recorded = true;
      if (result !== false) confirmedAbsent = false;
    }
    if (recorded) continue;
    const lockfiles = candidates.map((m) => m.path).join(", ");
    missing.push(
      confirmedAbsent
        ? { ...base, status: "missing", hint: `Not included in the lockfile in a parent directory (${lockfiles}). ${LOCKFILE_HINTS[marker.group]}` }
        : {
            ...base,
            status: "unconfirmed",
            hint: `Cannot confirm that it is included in the lockfile in a parent directory (${lockfiles}). If it is not a workspace member: ${LOCKFILE_HINTS[marker.group]}`,
          },
    );
  }
  return missing;
}

async function finalize(
  projectDir: string,
  manifests: DetectedManifest[],
  markers: { path: string; group: LockGroup }[],
  allowedRootReal: string | undefined,
  nugetFiles: NugetFiles = emptyNugetFiles(),
): Promise<DetectedProject> {
  const cargoCache = new CargoLockCache();
  const result: DetectedProject = {
    projectDir,
    allowedRootReal,
    manifests: [],
    targets: [],
    requirementsCopies: [],
    cargoCopies: [],
    composerCopies: [],
    composerWarnings: [],
    composerLocalPackages: 0,
    localCrateCount: 0,
    unscannableCrates: [],
    lockfileMissing: await findLockfileMissing(projectDir, markers, manifests, cargoCache),
    requirementIssues: [],
    requirementReferences: [],
    lowerBounds: [],
    skippedFiles: [],
    nugetCopies: [],
    localProjectCount: 0,
    unscannableNugetPackages: [],
    unresolvedPackageReferences: [],
    nugetWarnings: [],
    hasNuget: Object.values(nugetFiles).some((list) => list.length > 0),
  };
  const readContext = createRequirementsReadContext();
  const composerBudget = createNpmLockWorkBudget();
  const composerRelationBudget = createComposerRelationBudget();
  let composerBytes = MAX_NPM_LOCK_TOTAL_BYTES;
  // A null value permanently marks a crate name with multiple declaration paths.
  const cargoManifests = new Map<string, string | null>();
  const cargoMarkers = new Set([
    ...markers.filter((m) => m.path.endsWith("Cargo.toml")).map((m) => m.path),
    ...manifests.filter((m) => m.format === "Cargo.lock").map((m) => path.join(path.dirname(m.path), "Cargo.toml")),
  ]);
  for (const marker of cargoMarkers) {
    const text = await cargoCache.toml(path.join(projectDir, marker), projectDir);
    const name = text === null ? null : cargoTomlPackageName(text);
    if (name !== null) cargoManifests.set(name, cargoManifests.has(name) ? null : marker);
  }
  for (const manifest of manifests) {
    const absolute = path.join(projectDir, manifest.path);
    if (manifest.format === "composer.lock") {
      const read = await readRegularFile(absolute, { maxBytes: Math.min(MAX_NPM_LOCK_BYTES, composerBytes), boundary: projectDir });
      if (!read.ok) {
        result.skippedFiles.push({ path: manifest.path, reason: capitalizeReason(read.message) });
        continue;
      }
      composerBytes -= read.bytes.length;
      try {
        const parsed = composerLockCopy(read.bytes.toString("utf8"), composerBudget);
        if (parsed.packageCount > 0) {
          let relations = null;
          const companion = await readRegularFile(path.join(path.dirname(absolute), "composer.json"), {
            maxBytes: Math.min(4 * 1024 * 1024, composerBytes), boundary: projectDir,
          });
          if (companion.ok) {
            composerBytes -= companion.bytes.length;
            try {
              const roots = composerRootRequirements(companion.bytes.toString("utf8"), composerBudget);
              if (roots !== null) relations = composerRelations(parsed.relationPackages, roots, composerRelationBudget);
            } catch { /* A companion failure affects relationships, not the scanned lockfile. */ }
          }
          if (relations === null) result.composerWarnings!.push(`${manifest.path}: Dependency relationships are unknown because its companion composer.json is unavailable/uninterpretable or the dependency analysis limit was reached; locked release packages are still scanned`);
          result.composerCopies!.push({ path: manifest.path, content: parsed.content, relations });
        }
        result.skippedFiles.push(...parsed.issues.map((reason) => ({ path: manifest.path, reason })));
        result.composerWarnings!.push(...parsed.warnings.map((warning) => `${manifest.path}: ${warning}`));
        result.composerLocalPackages! += parsed.localPackages;
      } catch {
        result.skippedFiles.push({ path: manifest.path, reason: "composer.lock could not be parsed within the JSON size and work limits" });
        continue;
      }
    } else if (manifest.format === "requirements.txt") {
      const analysis = await analyzeRequirementsFile(absolute, projectDir, readContext);
      if (!analysis.ok) {
        result.skippedFiles.push({ path: manifest.path, reason: analysis.reason });
        continue;
      }
      result.requirementIssues.push(...analysis.issues);
      result.requirementReferences.push(...analysis.references);
      result.lowerBounds.push(...analysis.lowerBounds);
      result.requirementsCopies.push({ path: manifest.path, entries: analysis.entries });
    } else if (manifest.format === "Cargo.lock") {
      const lock = await cargoCache.get(absolute, projectDir);
      if ("reason" in lock) {
        result.skippedFiles.push({ path: manifest.path, reason: lock.reason });
        continue;
      }
      const declaringManifests = new Map<string, string>();
      // declared_inに使うのは、このCargo.lockのローカルのcrate(依存元)の名前だけ。プロジェクトの全crate名を
      // Cargo.lockごとにたどると、Cargo.lockの数×crate名の数の処理・メモリになる(900件×2万件で約24秒)
      for (const name of lock.localCrates) {
        const marker = cargoManifests.get(name);
        if (typeof marker === "string") declaringManifests.set(name, path.relative(path.dirname(manifest.path), marker));
      }
      result.cargoCopies.push({ path: manifest.path, packages: lock.cratesIo, allPackages: lock.allPackages, declaringManifests });
      result.localCrateCount += lock.localCrates.length;
      result.unscannableCrates.push(
        ...lock.unscannable.map((c) => ({ file: manifest.path, name: c.name, version: c.version, reason: UNSCANNABLE_CRATE_REASONS[c.kind] })),
      );
    } else if (isManifestFormat(manifest.format)) {
      result.targets.push({ path: absolute, format: manifest.format });
    }
    result.manifests.push(manifest);
  }
  if (result.hasNuget) {
    const nuget = await analyzeNuget(projectDir, nugetFiles);
    result.manifests.push(...nuget.manifests.map((m) => ({ path: m.path, ecosystem: "NuGet" as const, format: m.format })));
    result.nugetCopies = nuget.copies;
    result.localProjectCount = nuget.localProjects;
    result.unscannableNugetPackages = nuget.unscannable;
    result.unresolvedPackageReferences = nuget.unresolved;
    result.nugetWarnings = nuget.warnings;
    result.lockfileMissing.push(...nuget.lockfileMissing.map((m) => ({ ...m, ecosystem: "NuGet" as const })));
    result.skippedFiles.push(...nuget.skippedFiles);
  }
  if (result.manifests.length === 0) {
    const details = [
      ...result.lockfileMissing.map((m) => `${m.path}: ${m.hint}`),
      ...result.skippedFiles.map((s) => `${s.path}: ${s.reason}`),
    ];
    throw new ScanToolError(
      "no_manifest_found",
      `No lockfile or manifest that can be scanned was found: ${projectDir}` +
        (details.length > 0 ? `(${details.join(" / ")})` : ""),
    );
  }
  return result;
}

/**
 * 入力パスを検証し、プロジェクト内のlockfile・マニフェストを検出する。
 * 対応ファイルの直接指定は、そのファイル1件だけを対象にする(親ディレクトリを探索しない)。
 */
export async function detectProject(inputPath: string, options: DetectProjectOptions = {}): Promise<DetectedProject> {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new ScanToolError("project_not_found", "No path to scan was given");
  }
  const resolved = await resolveExistingPath(inputPath);
  const stats = await stat(resolved);
  const name = path.basename(resolved);
  const direct = stats.isFile() ? classifyFile(name) : null;
  const directNuget = stats.isFile() && isDirectNugetFile(name);

  let projectDir: string;
  if (stats.isDirectory()) {
    projectDir = resolved;
  } else if (stats.isFile() && (direct !== null || directNuget || LOCK_MARKERS.has(name) || NUGET_PROJECT_FILE.test(name))) {
    projectDir = path.dirname(resolved);
  } else {
    throw new ScanToolError(
      "project_not_found",
      `The path is neither a directory nor a supported lockfile or manifest: ${inputPath}`,
    );
  }
  const allowedRootReal = options.allowedRoot !== undefined ? await resolveExistingPath(options.allowedRoot) : undefined;
  if (allowedRootReal !== undefined) assertInsideAllowedRoot(projectDir, allowedRootReal);

  if (direct !== null) {
    return finalize(projectDir, [{ path: name, ...direct }], [], allowedRootReal);
  }
  if (directNuget) {
    const nugetFiles = emptyNugetFiles();
    if (name === NUGET_PROJECT_ASSETS) nugetFiles.projectAssets.push(name);
    else collectNugetFile(nugetFiles, name, name);
    return finalize(projectDir, [], [], allowedRootReal, nugetFiles);
  }

  const manifests: DetectedManifest[] = [];
  const markers: { path: string; group: LockGroup }[] = [];
  const nugetFiles = emptyNugetFiles();
  await walkProjectFiles(projectDir, options, SKIPPED_DIRS, (relativePath, fileName) => {
    const found = classifyFile(fileName);
    if (found) {
      manifests.push({ path: relativePath, ...found });
      return true;
    }
    const nuget = collectNugetFile(nugetFiles, relativePath, fileName);
    if (nuget !== null) return nuget;
    const group = LOCK_MARKERS.get(fileName);
    if (group) markers.push({ path: relativePath, group });
    return false;
  }, dotnetOutputDirs);
  return finalize(projectDir, manifests, markers, allowedRootReal, nugetFiles);
}
