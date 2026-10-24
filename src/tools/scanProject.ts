/**
 * `scan_project`ツールのハンドラ: Java / JavaScript / Python / Go / Rust / .NETのlockfileをまとめてスキャンする。
 *
 * 誤要約対策(JAR実体スキャンと同じ原則): スキャンできなかった依存を示すcoverageを件数より前に置き、
 * complete=falseの場合は「検出0件でも安全とは言えない」旨の警告を付ける。
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import { isRemoteResolutionDisabled, runOsvScan, type RunOsvScanOptions } from "../osv/runner.js";
import { hasVulnerability, packageSources, parseOsvScanOutput, type ScanReport, type ScanReportPackage } from "../osv/scanReport.js";
import {
  combineRelations,
  cargoLockRelations,
  goModRelations,
  npmLockRelations,
  pomRelations,
  requirementsRelations,
  type RelationInfo,
  type RelationLookup,
} from "../utils/dependencyRelations.js";
import { cargoLockCopyContent, type CargoPackage } from "../utils/cargoLock.js";
import { nugetKey, nugetLockCopyContent, nugetRelations, type NugetPackage } from "../utils/nugetFiles.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import { readRegularFile } from "../utils/safeRead.js";
import { detectProject, type DetectedProject } from "../utils/manifestDetector.js";
import { createNpmLockWorkBudget, fillMissingResolved, MAX_NPM_LOCK_BYTES, MAX_NPM_LOCK_TOTAL_BYTES, parseNpmLock, type NpmLockWorkBudget } from "../utils/npmLockCopy.js";
import { normalizePypiName } from "../utils/requirementsFile.js";
import { ScanSnapshot, snapshotManifests } from "../utils/scanSnapshot.js";
import { dependencyResolution, withScopeNotes, type ScanJavaProjectArgs, type ScanJavaProjectOptions } from "./scanJavaProject.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

export const TRANSITIVE_OMITTED_WARNING =
  "Because OSV_MCP_NO_REMOTE_RESOLUTION is set, transitive dependencies of manifests (pom.xml / requirements.txt) were not resolved. " +
  "Dependencies recorded in lockfiles (package-lock.json / poetry.lock / go.mod / gradle.lockfile and so on) are covered, " +
  "but vulnerabilities in the transitive dependencies of the dependencies listed directly in pom.xml or requirements.txt are not included. " +
  "Zero findings does not confirm that the transitive dependencies are safe";

const INCOMPLETE_WARNING =
  "Some dependencies were not scanned, or were scanned at an assumed version " +
  "(see lockfile_missing / unpinned_requirements / unscannable_requirements / unscannable_crates / " +
  "unscannable_nuget_packages / unresolved_package_references / skipped_files). " +
  "Zero findings does not confirm that those dependencies are safe";

/** coverageの各一覧の上限(巨大なrequirements.txtで応答を膨らませない) */
const MAX_COVERAGE_ITEMS = 200;

function capped<T>(items: readonly T[]): { items: T[]; omitted: number } {
  return { items: items.slice(0, MAX_COVERAGE_ITEMS), omitted: Math.max(0, items.length - MAX_COVERAGE_ITEMS) };
}

export function buildCoverage(project: DetectedProject) {
  const rel = (file: string) => sanitizeExternalText(path.relative(project.projectDir, file));
  const lockfileMissing = capped(project.lockfileMissing);
  const unpinned = capped(project.requirementIssues);
  const unscannable = capped(project.requirementReferences);
  const skipped = capped(project.skippedFiles);
  const crates = capped(project.unscannableCrates);
  const nugetUnscannable = capped(project.unscannableNugetPackages);
  const nugetUnresolved = capped(project.unresolvedPackageReferences);
  const complete =
    project.lockfileMissing.length === 0 &&
    project.requirementIssues.length === 0 &&
    project.requirementReferences.length === 0 &&
    project.unscannableCrates.length === 0 &&
    project.unscannableNugetPackages.length === 0 &&
    project.unresolvedPackageReferences.length === 0 &&
    project.skippedFiles.length === 0;
  const omitted = lockfileMissing.omitted + unpinned.omitted + unscannable.omitted + crates.omitted + skipped.omitted +
    nugetUnscannable.omitted + nugetUnresolved.omitted;
  const hasCargo = project.manifests.some((m) => m.format === "Cargo.lock");
  return {
    complete,
    ...(complete ? {} : { warning: INCOMPLETE_WARNING }),
    manifests: project.manifests.map((m) => ({ path: sanitizeExternalText(m.path), ecosystem: m.ecosystem, format: m.format })),
    lockfile_missing: lockfileMissing.items.map((m) => ({
      path: sanitizeExternalText(m.path),
      ecosystem: m.ecosystem,
      status: m.status,
      hint: sanitizeExternalText(m.hint),
    })),
    unpinned_requirements: unpinned.items.map((issue) => ({
      file: rel(issue.file),
      line: issue.line,
      name: sanitizeExternalText(issue.name),
      specifier: sanitizeExternalText(issue.specifier),
      kind: issue.kind,
    })),
    unscannable_requirements: unscannable.items.map((ref) => ({
      file: rel(ref.file),
      line: ref.line,
      text: sanitizeExternalText(ref.text),
      reason: ref.reason,
    })),
    // Rust: 従来のエコシステムの応答を変えないよう、Cargo.lockをスキャンした場合だけ付ける
    ...(hasCargo
      ? {
          local_crates: project.localCrateCount,
          unscannable_crates: crates.items.map((c) => ({
            file: sanitizeExternalText(c.file),
            name: sanitizeExternalText(c.name),
            version: sanitizeExternalText(c.version),
            reason: c.reason,
          })),
        }
      : {}),
    // .NET: 従来のエコシステムの応答を変えないよう、.NETのファイルを検出した場合だけ付ける
    ...(project.hasNuget
      ? {
          local_projects: project.localProjectCount,
          unscannable_nuget_packages: nugetUnscannable.items.map((p) => ({
            file: sanitizeExternalText(p.file),
            name: sanitizeExternalText(p.name),
            version: sanitizeExternalText(p.version),
            reason: p.reason,
          })),
          unresolved_package_references: nugetUnresolved.items.map((r) => ({
            file: sanitizeExternalText(r.file),
            name: sanitizeExternalText(r.name),
            specifier: sanitizeExternalText(r.specifier),
            reason: r.reason,
          })),
          ...(project.nugetWarnings.length > 0 ? { nuget_warnings: project.nugetWarnings.map(sanitizeExternalText) } : {}),
        }
      : {}),
    skipped_files: skipped.items.map((s) => ({ path: sanitizeExternalText(s.path), reason: sanitizeExternalText(s.reason) })),
    ...((project.composerWarnings?.length ?? 0) > 0 ? { composer_warnings: project.composerWarnings!.slice(0, MAX_COVERAGE_ITEMS).map(sanitizeExternalText) } : {}),
    ...(omitted > 0 ? { omitted_items: omitted } : {}),
  };
}

interface EcosystemCounts {
  manifests: number;
  vulnerable_package_count: number;
  vulnerability_count: number;
  /** 情報提供のアドバイザリ(RustSecのunmaintained等)の件数。1件以上ある場合だけ付ける */
  informational_count?: number;
}

function ecosystemBreakdown(project: DetectedProject, packages: readonly ScanReportPackage[]) {
  const breakdown: Record<string, EcosystemCounts> = {};
  for (const manifest of project.manifests) {
    breakdown[manifest.ecosystem] ??= { manifests: 0, vulnerable_package_count: 0, vulnerability_count: 0 };
    breakdown[manifest.ecosystem]!.manifests++;
  }
  for (const pkg of packages) {
    const counts = (breakdown[pkg.ecosystem] ??= { manifests: 0, vulnerable_package_count: 0, vulnerability_count: 0 });
    const informational = pkg.vulnerabilities.filter((v) => v.informational !== undefined).length;
    if (hasVulnerability(pkg)) counts.vulnerable_package_count++;
    counts.vulnerability_count += pkg.vulnerabilities.length - informational;
    if (informational > 0) counts.informational_count = (counts.informational_count ?? 0) + informational;
  }
  return breakdown;
}

/**
 * `>=X` / `~=X` の行(requirements.txt)と、`.csproj`の`Version="X"`(X以上)は、下限Xを使用中の版とみなしてスキャンしている。
 * .NETは同じ名前・版を確定版として照会したファイルもあれば、下限とは示さない
 */
export function markLowerBounds(project: DetectedProject, packages: readonly ScanReportPackage[]): ScanReportPackage[] {
  const nugetExact = new Set<string>();
  const nugetLower = new Set<string>();
  for (const copy of project.nugetCopies) {
    for (const pkg of copy.packages) (pkg.lowerBound ? nugetLower : nugetExact).add(JSON.stringify([nugetKey(pkg.name), pkg.version]));
  }
  return packages.map((pkg) => {
    const nugetId = JSON.stringify([nugetKey(pkg.name), pkg.version]);
    const lower = pkg.ecosystem === "PyPI"
      ? project.lowerBounds.some((lb) => lb.name === normalizePypiName(pkg.name) && lb.version === pkg.version)
      : pkg.ecosystem === "NuGet" && nugetLower.has(nugetId) && !nugetExact.has(nugetId);
    return lower ? { ...pkg, version_is_lower_bound: true as const } : pkg;
  });
}

/**
 * 元のファイルはosv-scannerに渡さず、スナップショット(scanSnapshot.ts)のコピーをスキャンする。
 * lockfile・pom.xml(親POMの連鎖を含む)は安全に読んだ内容のコピー、requirements.txtは
 * 検証済みの正規化行だけを書いたコピー。コピーできず外したファイルはskippedFilesに記録する。
 * スナップショットは成功・失敗とも削除する。suggest_fixも同じスキャンを使う。
 */
/** 直接/推移的依存の判定で読むpackage-lock.json・go.modの合計サイズの上限 */
const MAX_RELATION_LOCKFILE_BYTES = 256 * 1024 * 1024;
const MAX_INTRODUCED_BY = 10;

interface SourceRelations {
  lookup: RelationLookup;
  /** declared_inをプロジェクトからの相対パスにするための、lockfileのディレクトリ */
  lockDir: string;
}

interface RelationSource {
  copy: string;
  format: string;
  originalRelative: string | null;
  entries?: readonly string[];
  cargoPackages?: readonly CargoPackage[];
  declaringManifests?: ReadonlyMap<string, string>;
  nugetPackages?: readonly NugetPackage[];
}

/**
 * スキャンしたファイル(スナップショットのコピー)ごとに、直接/推移的依存の判定を用意する。
 * 解析するのは検証済みのコピーだけで、元のファイルは読まない。判定できない形式・上限超過はnull(unknown)。
 */
export async function buildRelationLookups(
  copies: readonly RelationSource[],
  maxTotalBytes = MAX_RELATION_LOCKFILE_BYTES,
): Promise<Map<string, SourceRelations>> {
  const lookups = new Map<string, SourceRelations>();
  const npmWorkBudget = createNpmLockWorkBudget();
  let remaining = maxTotalBytes;
  for (const { copy, format, originalRelative, entries, cargoPackages, declaringManifests, nugetPackages } of copies) {
    const lockDir = originalRelative === null ? "" : path.dirname(originalRelative);
    let lookup: RelationLookup = null;
    try {
      if (format === "package-lock.json" || format === "go.mod") {
        // 残りの予算を上限に、読み込みの途中で打ち切る(予算を超えるファイルは全体を読まずにunknownにする)
        const read = await readRegularFile(copy, { maxBytes: format === "package-lock.json" ? Math.min(MAX_NPM_LOCK_BYTES, remaining) : remaining });
        if (read.ok) {
          remaining -= read.bytes.length;
          const text = read.bytes.toString("utf8");
          lookup = format === "go.mod" ? goModRelations(text) : npmLockRelations(parseNpmLock(text, npmWorkBudget));
        }
      } else if (format === "pom.xml") {
        lookup = pomRelations(); // ファイルは読まず、osv-scannerのsource.typeで判定する
      } else if (format === "requirements.txt" && entries !== undefined) {
        lookup = requirementsRelations(entries);
      } else if (format === "Cargo.lock" && cargoPackages !== undefined) {
        lookup = cargoLockRelations(cargoPackages, declaringManifests);
      } else if (format === "packages.lock.json" && nugetPackages !== undefined) {
        lookup = nugetRelations(nugetPackages);
      }
    } catch {
      lookup = null; // 解析できないファイルはunknown(スキャン自体は続ける)
    }
    lookups.set(copy, { lookup, lockDir });
  }
  return lookups;
}

/** パッケージに直接/推移的依存の別を付ける。項目は脆弱性の一覧より前に置く */
function annotateRelations(packages: readonly ScanReportPackage[], lookups: ReadonlyMap<string, SourceRelations>): ScanReportPackage[] {
  return packages.map((pkg) => {
    // 同じファイルが複数の結果に分かれる(pom.xml・requirements.txtの宣言と推移的依存)ため、ファイルごとに1つにまとめる。
    // 同じファイルで直接依存と判定された結果があれば直接依存とする
    const byFile = new Map<string, RelationInfo>();
    const declaredIn = new Set<string>();
    const declaringCrates = new Set<string>();
    const rank = { direct: 2, transitive: 1, unknown: 0 } as const;
    for (const source of packageSources(pkg)) {
      const entry = lookups.get(source.path);
      const info = entry?.lookup ? entry.lookup(pkg.name, pkg.version, source.type) : { relation: "unknown" as const };
      const previous = byFile.get(source.path);
      if (previous === undefined || rank[info.relation] > rank[previous.relation]) byFile.set(source.path, info);
      for (const manifest of info.declaredIn ?? []) declaredIn.add(path.join(entry!.lockDir, manifest));
      for (const name of info.declaringCrates ?? []) declaringCrates.add(name);
    }
    const infos = [...byFile.values()];
    const { relation, introducedBy, replaced } = combineRelations(infos);
    const { vulnerabilities, ...rest } = pkg;
    return {
      ...rest,
      dependency_relation: relation,
      ...(introducedBy.length > 0 ? { introduced_by: introducedBy.slice(0, MAX_INTRODUCED_BY).map(sanitizeExternalText) } : {}),
      ...(introducedBy.length > MAX_INTRODUCED_BY ? { introduced_by_omitted: introducedBy.length - MAX_INTRODUCED_BY } : {}),
      ...(declaredIn.size > 0 ? { declared_in: [...declaredIn].sort().map(sanitizeExternalText) } : {}),
      ...(declaringCrates.size > 0 ? { declaring_crates: [...declaringCrates].sort().slice(0, MAX_INTRODUCED_BY).map(sanitizeExternalText) } : {}),
      ...(declaringCrates.size > MAX_INTRODUCED_BY ? { declaring_crates_omitted: declaringCrates.size - MAX_INTRODUCED_BY } : {}),
      ...(replaced ? { replaced_in_go_mod: true as const } : {}),
      vulnerabilities,
    };
  });
}

export const NPM_LOCK_NOT_NORMALIZED =
  "Scanned without filling in missing `resolved` fields, because the lockfile exceeds the normalization limits " +
  `(${MAX_NPM_LOCK_BYTES / 1024 / 1024} MiB per file; ${MAX_NPM_LOCK_TOTAL_BYTES / 1024 / 1024} MiB and a JSON structure budget per scan). ` +
  "Entries without `resolved` (such as bundled dependencies) may not have been looked up";

/**
 * コピーにresolvedを補う。構文エラーの場合はそのまま渡す。
 * 資源の上限を超えた場合もスキャン全体は止めず、コピーをそのまま渡して理由を返す
 * (osv-scannerは大きなlockfileも解析できる。上限は本サーバー自身の解析・再出力を抑えるためのもの)
 */
async function fillResolvedInCopy(copyPath: string, budget: { input: number; output: number; work: NpmLockWorkBudget }): Promise<string | null> {
  const read = await readRegularFile(copyPath, { maxBytes: Math.min(MAX_NPM_LOCK_BYTES, budget.input) });
  if (!read.ok) {
    if (read.failure === "too_large") return NPM_LOCK_NOT_NORMALIZED;
    throw new ScanToolError("scan_failed", "The npm lockfile copy cannot be read safely");
  }
  budget.input -= read.bytes.length;
  const text = read.bytes.toString("utf8");
  let filled: ReturnType<typeof fillMissingResolved>;
  try {
    filled = fillMissingResolved(text, Math.min(MAX_NPM_LOCK_BYTES, budget.output), budget.work);
  } catch (error) {
    if (error instanceof ScanToolError && error.kind === "scan_input_too_large") return NPM_LOCK_NOT_NORMALIZED;
    throw error;
  }
  if (!filled?.changed) return null; // 書き換えないコピーは出力の上限に数えない
  const outputBytes = Buffer.byteLength(filled.content, "utf8");
  if (outputBytes > budget.output) return NPM_LOCK_NOT_NORMALIZED;
  budget.output -= outputBytes;
  await writeFile(copyPath, filled.content, { mode: 0o600 });
  return null;
}

export async function scanFromSnapshot(project: DetectedProject, options: RunOsvScanOptions): Promise<ScanReport> {
  const snapshot = await ScanSnapshot.create();
  try {
    const { targets, skipped, incomplete } = await snapshotManifests(snapshot, project.targets, {
      projectDir: project.projectDir,
      allowedRootReal: project.allowedRootReal,
    });
    // コピーと元のファイルの対応(snapshotManifestsは外したもの以外を入力の順に返す)
    const skippedOriginals = new Set(skipped.map((s) => s.path));
    const scannedOriginals = project.targets.filter((t) => !skippedOriginals.has(t.path));
    // osv-scanner 2.7.0はresolvedの無いnpmのエントリを照会しないため、コピーで補う(npmLockCopy.ts)。
    // 上限を超えたlockfileはそのままスキャンし、補えなかったことをcoverageに出す(complete=falseになる)
    const npmBudget = { input: MAX_NPM_LOCK_TOTAL_BYTES, output: MAX_NPM_LOCK_TOTAL_BYTES, work: createNpmLockWorkBudget() };
    for (const [i, copy] of targets.entries()) {
      if (copy.format !== "package-lock.json") continue;
      const reason = await fillResolvedInCopy(copy.path, npmBudget);
      if (reason !== null) project.skippedFiles.push({ path: path.relative(project.projectDir, scannedOriginals[i]!.path), reason });
    }
    const relationSources: RelationSource[] =
      targets.map((copy, i) => ({ copy: copy.path, format: copy.format, originalRelative: path.relative(project.projectDir, scannedOriginals[i]!.path) }));
    // 親POMを再現できずにスキャンしたpom.xmlも、欠落の可能性としてcoverageに出す(complete=falseになる)
    project.skippedFiles.push(...incomplete.map((s) => ({ path: path.relative(project.projectDir, s.path), reason: s.reason })));
    if (skipped.length > 0) {
      const skippedPaths = new Set(skipped.map((s) => s.path));
      project.manifests = project.manifests.filter((m) => !skippedPaths.has(path.join(project.projectDir, m.path)));
      project.skippedFiles.push(...skipped.map((s) => ({ path: path.relative(project.projectDir, s.path), reason: s.reason })));
      if (project.manifests.length === 0) {
        throw new ScanToolError(
          skipped.every((s) => s.kind === "outside_allowed_root") ? "path_outside_allowed_root" : "no_manifest_found",
          `No lockfile or manifest can be scanned (${project.skippedFiles.map((s) => `${s.path}: ${s.reason}`).join(" / ")})`,
        );
      }
    }
    for (const copy of project.requirementsCopies) {
      if (copy.entries.length === 0) continue;
      const generated = await snapshot.writeGenerated(`${copy.entries.join("\n")}\n`);
      targets.push({ path: generated, format: "requirements.txt" });
      relationSources.push({ copy: generated, format: "requirements.txt", originalRelative: copy.path, entries: copy.entries });
    }
    for (const copy of project.cargoCopies) {
      if (copy.packages.length === 0) continue;
      const generated = await snapshot.writeGenerated(cargoLockCopyContent(copy.packages));
      targets.push({ path: generated, format: "Cargo.lock" });
      relationSources.push({ copy: generated, format: "Cargo.lock", originalRelative: copy.path,
        cargoPackages: copy.allPackages, declaringManifests: copy.declaringManifests });
    }
    for (const copy of project.nugetCopies) {
      const generated = await snapshot.writeGenerated(nugetLockCopyContent(copy.packages));
      targets.push({ path: generated, format: "packages.lock.json" });
      relationSources.push({ copy: generated, format: "packages.lock.json", originalRelative: copy.path, nugetPackages: copy.packages });
    }
    for (const copy of project.composerCopies ?? []) {
      const generated = await snapshot.writeGenerated(copy.content);
      targets.push({ path: generated, format: "composer.lock" });
      relationSources.push({ copy: generated, format: "composer.lock", originalRelative: copy.path });
    }
    if (targets.length === 0) return parseOsvScanOutput({ results: [] });
    const report = await withScopeNotes(project.skippedFiles, () => snapshot.guard(() => runOsvScan(targets, options)));
    // 判定はコピーを読むため、スナップショットを消す前に行う
    return { ...report, packages: annotateRelations(report.packages, await buildRelationLookups(relationSources)) };
  } finally {
    await snapshot.cleanup();
  }
}

export async function handleScanProject(
  args: ScanJavaProjectArgs,
  options: ScanJavaProjectOptions = {},
): Promise<ToolResult> {
  try {
    const project = await detectProject(args.project_path, { allowedRoot: options.allowedRoot });
    const noRemoteResolution = isRemoteResolutionDisabled(options);
    const report = await scanFromSnapshot(project, { ...options, noRemoteResolution });
    return jsonResult({
      project_dir: project.projectDir,
      dependency_resolution: dependencyResolution(noRemoteResolution, TRANSITIVE_OMITTED_WARNING),
      coverage: buildCoverage(project),
      ecosystem_breakdown: ecosystemBreakdown(project, report.packages),
      vulnerable_package_count: report.vulnerable_package_count,
      vulnerability_count: report.vulnerability_count,
      ...(report.informational_count !== undefined ? { informational_count: report.informational_count } : {}),
      severity_breakdown: report.severity_breakdown,
      packages: markLowerBounds(project, report.packages),
    });
  } catch (error) {
    return errorResult(error);
  }
}
