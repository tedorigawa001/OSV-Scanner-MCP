/**
 * `scan_project`用の検出: Java / JavaScript / Python / Goのlockfileを列挙する。
 *
 * - 検出したファイルだけをosv-scannerに渡す(ディレクトリは渡さない)。解析形式も明示する
 * - パッケージマネージャー・ビルドは実行しない。lockfileが無いマニフェストはcoverageに記録する
 * - requirements.txtは取り込み先を検証し、プロジェクト外を読む場合はスキャン対象から外す
 *
 * 検出・除外の根拠はdocs/DESIGN_TODO.md「対象エコシステム拡大 詳細設計メモ」を参照。
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import type { ManifestFormat, ManifestTarget } from "./manifestFormats.js";
import { pomParentOutsideRoot } from "./pomParent.js";
import {
  assertInsideAllowedRoot,
  resolveExistingPath,
  walkProjectFiles,
  type SearchLimitOptions,
} from "./projectWalk.js";
import {
  analyzeRequirementsFile,
  type LowerBound,
  type RequirementIssue,
  type RequirementReference,
} from "./requirementsFile.js";

export type Ecosystem = "Maven" | "npm" | "PyPI" | "Go";

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
]);

/** requirements.txt / requirements-dev.txt / dev-requirements.txt 等 */
const REQUIREMENTS_NAME = /^(?:[\w.]+[-_])?requirements(?:[-_][\w.]+)?\.txt$/;

type LockGroup = "npm" | "pypi" | "gradle";

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
]);

const LOCK_GROUP_ECOSYSTEM: Record<LockGroup, Ecosystem> = { npm: "npm", pypi: "PyPI", gradle: "Maven" };

const LOCKFILE_HINTS: Record<LockGroup, string> = {
  npm:
    "lockfileがありません。信頼できる環境で `npm install --package-lock-only --ignore-scripts`" +
    "(yarn / pnpm / bunの場合は各ツールのlockfile生成)を実行してから再スキャンしてください",
  pypi:
    "lockfile(poetry.lock / uv.lock / Pipfile.lock / pdm.lock)またはバージョンを固定したrequirements.txtがありません。" +
    "信頼できる環境で生成してから再スキャンしてください(生成時にビルドスクリプトが実行される場合があります)",
  gradle:
    "gradle.lockfileがありません。信頼できる環境で `./gradlew dependencies --write-locks` を実行してから再スキャンしてください" +
    "(依存ロック未設定の場合は build.gradle に dependencyLocking { lockAllConfigurations() } の追加が必要です)",
};

const SKIPPED_DIRS = new Set([
  ".git", "node_modules", "target", "build", ".idea", ".vscode",
  ".venv", "venv", "site-packages", "__pycache__", ".tox", "vendor",
]);

export interface DetectedManifest {
  /** projectDirからの相対パス */
  path: string;
  ecosystem: Ecosystem;
  format: ManifestFormat;
}

export interface LockfileMissing {
  /** lockfileの無いマニフェストのprojectDirからの相対パス */
  path: string;
  ecosystem: Ecosystem;
  /** missing: 対応するlockfileが無い / unconfirmed: 上位のlockfileに収録されているか確認できない */
  status: "missing" | "unconfirmed";
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

export interface DetectedProject {
  projectDir: string;
  manifests: DetectedManifest[];
  /** そのままosv-scannerに渡すlockfile(requirements.txtは含まない) */
  targets: ManifestTarget[];
  requirementsCopies: RequirementsCopy[];
  lockfileMissing: LockfileMissing[];
  /** パスは絶対パス(表示時に相対化する) */
  requirementIssues: RequirementIssue[];
  requirementReferences: RequirementReference[];
  lowerBounds: LowerBound[];
  skippedFiles: SkippedFile[];
}

export interface DetectProjectOptions extends SearchLimitOptions {
  allowedRoot?: string;
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

/** workspaceの収録確認で読むlockfileの上限 */
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;

/**
 * package-lock.json(v2以降)の`packages`に、memberDirのエントリがあるか。
 * true=収録 / false=未収録 / null=確認できない(v1形式・読めない・大きすぎる)
 */
async function npmLockfileRecords(projectDir: string, lockfile: DetectedManifest, memberDir: string): Promise<boolean | null> {
  const lockAbs = path.join(projectDir, lockfile.path);
  try {
    if ((await stat(lockAbs)).size > MAX_LOCKFILE_BYTES) return null;
    const packages: unknown = (JSON.parse(await readFile(lockAbs, "utf8")) as { packages?: unknown }).packages;
    if (typeof packages !== "object" || packages === null) return null;
    const key = path.relative(path.dirname(lockAbs), path.join(projectDir, memberDir)).split(path.sep).join("/");
    return Object.hasOwn(packages, key);
  } catch {
    return null;
  }
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
): Promise<LockfileMissing[]> {
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
        ? await npmLockfileRecords(projectDir, candidate, markerDir)
        : null;
      if (result === true) recorded = true;
      if (result !== false) confirmedAbsent = false;
    }
    if (recorded) continue;
    const lockfiles = candidates.map((m) => m.path).join(", ");
    missing.push(
      confirmedAbsent
        ? { ...base, status: "missing", hint: `上位のlockfile(${lockfiles})には収録されていません。${LOCKFILE_HINTS[marker.group]}` }
        : {
            ...base,
            status: "unconfirmed",
            hint: `上位のlockfile(${lockfiles})に収録されているか確認できません。workspaceのメンバーでない場合は、${LOCKFILE_HINTS[marker.group]}`,
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
): Promise<DetectedProject> {
  const result: DetectedProject = {
    projectDir,
    manifests: [],
    targets: [],
    requirementsCopies: [],
    lockfileMissing: await findLockfileMissing(projectDir, markers, manifests),
    requirementIssues: [],
    requirementReferences: [],
    lowerBounds: [],
    skippedFiles: [],
  };
  for (const manifest of manifests) {
    const absolute = path.join(projectDir, manifest.path);
    if (manifest.format === "requirements.txt") {
      const analysis = await analyzeRequirementsFile(absolute, projectDir);
      if (!analysis.ok) {
        result.skippedFiles.push({ path: manifest.path, reason: analysis.reason });
        continue;
      }
      result.requirementIssues.push(...analysis.issues);
      result.requirementReferences.push(...analysis.references);
      result.lowerBounds.push(...analysis.lowerBounds);
      result.requirementsCopies.push({ path: manifest.path, entries: analysis.entries });
    } else {
      const outside = manifest.format === "pom.xml" ? await pomParentOutsideRoot(absolute, allowedRootReal) : null;
      if (outside !== null) {
        result.skippedFiles.push({ path: manifest.path, reason: outside });
        continue;
      }
      result.targets.push({ path: absolute, format: manifest.format });
    }
    result.manifests.push(manifest);
  }
  if (result.manifests.length === 0) {
    const details = [
      ...result.lockfileMissing.map((m) => `${m.path}: ${m.hint}`),
      ...result.skippedFiles.map((s) => `${s.path}: ${s.reason}`),
    ];
    throw new ScanToolError(
      "no_manifest_found",
      `スキャンできるlockfile・マニフェストが見つかりません: ${projectDir}` +
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
    throw new ScanToolError("project_not_found", "スキャン対象のパスが指定されていません");
  }
  const resolved = await resolveExistingPath(inputPath);
  const stats = await stat(resolved);
  const name = path.basename(resolved);
  const direct = stats.isFile() ? classifyFile(name) : null;

  let projectDir: string;
  if (stats.isDirectory()) {
    projectDir = resolved;
  } else if (stats.isFile() && (direct !== null || LOCK_MARKERS.has(name))) {
    projectDir = path.dirname(resolved);
  } else {
    throw new ScanToolError(
      "project_not_found",
      `指定されたパスはディレクトリでも対応するlockfile・マニフェストでもありません: ${inputPath}`,
    );
  }
  const allowedRootReal = options.allowedRoot !== undefined ? await resolveExistingPath(options.allowedRoot) : undefined;
  if (allowedRootReal !== undefined) assertInsideAllowedRoot(projectDir, allowedRootReal);

  if (direct !== null) {
    return finalize(projectDir, [{ path: name, ...direct }], [], allowedRootReal);
  }

  const manifests: DetectedManifest[] = [];
  const markers: { path: string; group: LockGroup }[] = [];
  await walkProjectFiles(projectDir, options, SKIPPED_DIRS, (relativePath, fileName) => {
    const found = classifyFile(fileName);
    if (found) {
      manifests.push({ path: relativePath, ...found });
      return true;
    }
    const group = LOCK_MARKERS.get(fileName);
    if (group) markers.push({ path: relativePath, group });
    return false;
  });
  return finalize(projectDir, manifests, markers, allowedRootReal);
}
