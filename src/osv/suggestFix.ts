/**
 * `suggest_fix`の3段階Tierフォールバック(docs/DESIGN_TODO.mdで確定したアルゴリズム)。
 *
 * 同一パッケージの`fixed_versions`には複数のサポートブランチ(major.minor系統)への
 * バックポート修正が混在する(例: log4jの2.3.x / 2.12.x / メインライン)。単純な
 * 最大バージョンではなく「現在のバージョンに最も近い系統の修正版」を優先して提案する。
 *
 * CVEごとの探索順:
 *   Tier 1 (same_minor):     現在と同じ系統内の修正版(最小の変更で済む)
 *   Tier 2 (major_internal): 同一メジャー内の最小の修正版(マイナーバージョンアップ)
 *   Tier 3 (cross_major):    全体最小の修正版(メジャーアップグレード、破壊的変更の可能性)
 * 系統の判定はエコシステム別(versionScheme.ts)。npm・Goは0.xのマイナー更新もcross_major。
 *
 * パッケージ全体の候補を全修正対象CVEの影響範囲と照合して推奨する。
 * 判定不能な候補は推奨しない。
 * 現在より新しい修正版が存在しないCVEはunfixedとして明示し、推奨計算から除外する。
 * プレリリース(canary版・Goの疑似バージョン等)は、正式版の候補で解消できない場合だけ推奨する。
 */

import type { InformationalKind, ScanReportPackage, SeverityLevel } from "./scanReport.js";
import { candidateStatus } from "./affectedVersions.js";
import { versionSchemeFor, type UpgradeTier, type VersionScheme } from "./versionScheme.js";

export type { UpgradeTier } from "./versionScheme.js";

export interface CveFixDetail {
  /** 脆弱性の代表ID(通常はGHSA-ID) */
  id: string;
  cve: string | null;
  severity: SeverityLevel;
  /** このCVEの修正版候補。最終推奨先での判定はrecommended_statusを参照 */
  fixed_in: string | null;
  /**
   * unfixed: 現在より新しい修正版の記載がない
   * unparseable_fix: 修正版の記載はあるが、バージョンとして解釈できない(例: SemVerでない`13.0`)。
   *   修正版が無いとは言えないため修正対象に残し、推奨を保留する
   * unsupported: 修正版推奨に未対応のエコシステム、または現在の版を解釈できない(修正版の有無は判定していない)
   */
  tier: UpgradeTier | "unfixed" | "unparseable_fix" | "unsupported" | "informational";
  informational?: InformationalKind;
  recommended_status?: "affected" | "not_affected" | "unknown" | "not_evaluated";
}

export interface PackageUpgradeSuggestion {
  package: string;
  current_version: string;
  ecosystem: string;
  /** 直接/推移的依存の別と関連情報(scan_projectのpackagesと同じ。scan_project・suggest_fixが付ける) */
  dependency_relation?: ScanReportPackage["dependency_relation"];
  dependency_groups?: string[];
  introduced_by?: string[];
  introduced_by_omitted?: number;
  declared_in?: string[];
  declaring_crates?: string[];
  declaring_crates_omitted?: number;
  replaced_in_go_mod?: true;
  /** 既知の修正版候補のうち影響範囲を検証できた版。null = 検証済み候補なし */
  recommended_upgrade: string | null;
  /** recommended_upgradeと現在バージョンの系統関係 */
  upgrade_tier: UpgradeTier | null;
  /** 推奨がプレリリース版の場合だけtrue(正式版の候補では全件を解消できない) */
  recommended_is_prerelease?: true;
  upgrade_note: string;
  /** npm・Go・PyPI: 推奨版への更新方法(推移的依存の場合を含む) */
  update_hint?: string;
  /** requirements.txtの下限(`>=X`等)を現在の版とみなしてスキャンした。推奨は「下限の引き上げ」の意味になる */
  version_is_lower_bound?: true;
  /** 推奨先のOSV照会の結果(candidateCheck.ts。推奨がある場合だけ) */
  candidate_check?: "clean" | "has_known_vulnerabilities" | "conflict" | "failed" | "skipped" | "disabled";
  /** 推奨先に該当する既知の脆弱性のID(candidate_checkがhas_known_vulnerabilitiesの場合) */
  recommended_known_vulnerabilities?: string[];
  per_cve_detail: CveFixDetail[];
  verification: "verified" | "no_verified_candidate" | "unsupported_ecosystem" | "unparseable_version" | "informational_only";
}

const TIER_ORDER: readonly UpgradeTier[] = ["same_minor", "major_internal", "cross_major"];

const UPDATE_HINTS: Record<string, string> = {
  Packagist: "Update the applicable constraints in composer.json, then regenerate composer.lock in a trusted environment with composer update vendor/package --with-all-dependencies --no-scripts --no-plugins. For a transitive dependency, update the package that requires it or adjust its constraints. Check PHP and extension requirements and application compatibility before updating; Composer is not executed by this server",
  npm:
    "For a direct dependency, update the version in package.json. For a transitive dependency, update the direct dependency that requires it, " +
    "or set the version with overrides in the root package.json (effective only in the root project)",
  Go:
    "Update with go get <module>@<version> (a transitive dependency is added to the require block of go.mod and updated as well). " +
    "In Go, major versions 2 and later use a different module path (/v2 and so on) and are separate packages, so fixes in a newer major line are not included here",
  PyPI:
    "Update the version in requirements.txt, pyproject.toml, or Pipfile, and regenerate the lockfile (poetry.lock, uv.lock, and so on). " +
    "For a transitive dependency, set the version with a pip constraints file (-c) or the override settings of uv, Poetry, and similar tools",
};

/** Goの疑似バージョン(タグのないコミット): 末尾がタイムスタンプ14桁-コミットハッシュ12桁 */
const GO_PSEUDO_VERSION = /(?:^|[.-])\d{14}-[0-9a-f]{12}(?:\+|$)/;

const GO_MAJOR_NOTE =
  "In Go, major versions 2 and later use a different module path (/v2 and so on) and are separate packages, so fixes in a newer major line are not included here";

/**
 * 推奨版への更新方法。直接/推移的依存の別が分かれば具体化し、分からなければ(unknown・mixed)両方を案内する
 */
function updateHint(pkg: ScanReportPackage): string | undefined {
  const relation = pkg.dependency_relation;
  const by = pkg.introduced_by?.join(", ");
  switch (pkg.ecosystem) {
    case "Packagist": {
      if (relation === "direct") return `Direct dependency. Update its constraint in ${pkg.declared_in?.join(", ") ?? "composer.json"}` +
        (by ? `. It is also required transitively by ${by}, whose constraints may need updating` : "") +
        ". Regenerate composer.lock in a trusted environment with Composer scripts and plugins disabled; check PHP, extension and dependency constraints. Composer is not executed by this server";
      if (relation === "transitive") return `Transitive dependency. Update ${by ? `the direct dependencies that require it (${by})` : "the direct dependency that requires it"} or adjust their constraints, then regenerate composer.lock with --with-all-dependencies --no-scripts --no-plugins in a trusted environment. Check PHP and extension requirements. Composer is not executed by this server`;
      return UPDATE_HINTS.Packagist;
    }
    case "NuGet": {
      if (/^Microsoft\.(?:NETCore|AspNetCore|WindowsDesktop)\.App\.Runtime\./i.test(pkg.name)) {
        return "Runtime pack. Update the .NET SDK/runtime or target framework that supplies this pack and regenerate restore/build outputs; do not add an explicit PackageReference merely to change the runtime pack. Check framework/RID compatibility and rescan. This server does not run dotnet restore or MSBuild";
      }
      const shared = "If centrally managed, change PackageVersion in Directory.Packages.props. Regenerate restore/lockfiles and rescan in a trusted environment; verify target-framework compatibility and dependency constraints. This server does not run dotnet restore or MSBuild";
      if (relation === "direct") return `Direct dependency. Update its PackageReference in ${pkg.declared_in?.join(", ") ?? "the project file"} (or packages.config for older projects). ` + shared;
      if (relation === "transitive") return `Transitive dependency. Update ${by ? `the direct dependencies that require it (${by})` : "the direct dependency that requires it"}, or explicitly reference a compatible fixed version when NuGet dependency resolution permits it. ` + shared;
      return "Update the dependency version in the project file or packages.config; for a transitive dependency, update its parent or explicitly reference a compatible fixed version. " + shared;
    }
    case "npm":
      if (relation === "direct") {
        return `Direct dependency. Update the version in ${pkg.declared_in?.join(", ") ?? "package.json"}` +
          (by ? `. It is also required transitively by ${by}, which may need to be updated as well` : "");
      }
      if (relation === "transitive") {
        return `Transitive dependency. Update ${by ? `the direct dependency that requires it (${by})` : "the direct dependency that requires it"} to a version that requires the recommended version or later. ` +
          "If updating the direct dependency does not fix it, use the package manager's root override configuration to select a compatible fixed version, regenerate the lockfile, and rescan";
      }
      return UPDATE_HINTS.npm;
    case "Go": {
      if (pkg.replaced_in_go_mod) {
        return `This module is replaced by a replace directive in go.mod, so update the version in replace instead of require. ${GO_MAJOR_NOTE}`;
      }
      if (relation === "direct") return `Direct dependency. Update with go get <module>@<version>. ${GO_MAJOR_NOTE}`;
      if (relation === "transitive") {
        return "Indirect dependency (// indirect in go.mod). go get <module>@<version> raises its version in go.mod " +
          `(updating the module that depends on it may also fix it). ${GO_MAJOR_NOTE}`;
      }
      return UPDATE_HINTS.Go;
    }
    case "Maven":
      if (pkg.build_systems?.includes("gradle")) {
        const gradle = (relation === "transitive" ? `Transitive dependency. Update ${by ? `the direct dependencies that require it (${by})` : "its direct parent dependencies"} or compatible Gradle constraints. ` :
          "Update the applicable dependency declarations, version catalog entries, or constraints in the Gradle build. ") +
          "Regenerate the lockfile in a trusted environment and rescan; check BOM, variant and Java compatibility. This server does not execute Gradle or the Wrapper";
        return gradle + (pkg.build_systems.includes("maven") ? ". Also update the applicable dependency or dependencyManagement in pom.xml for Maven sources" : "");
      }
      if (relation === "direct") {
        return "Direct dependency. Update the version in the <dependency> of pom.xml. If the version is managed by <dependencyManagement> in a parent POM, a property, or a BOM, update it there";
      }
      if (relation === "transitive") {
        return "Transitive dependency. Override the version with the recommended version in <dependencyManagement> of pom.xml (it takes precedence in Maven's dependency mediation), or update the direct dependency that requires it";
      }
      return undefined; // gradle.lockfile等: 判定できないため具体的な案内はしない(従来どおり)
    case "PyPI":
      if (relation === "direct") {
        return `Direct dependency. Update the version in ${pkg.declared_in?.join(", ") ?? "requirements.txt, pyproject.toml, or Pipfile"}, and regenerate the lockfile`;
      }
      if (relation === "transitive") {
        return `Transitive dependency. Update ${by ? `the direct dependencies that require it (${by})` : "the direct dependency that requires it"}, or set the version with a pip constraints file (-c) or the override settings of uv, Poetry, and similar tools`;
      }
      return UPDATE_HINTS.PyPI;
    default:
      return UPDATE_HINTS[pkg.ecosystem];
  }
}

/** OSV由来の版・crate名を案内のコマンドに埋め込めるか(外部データのため文字の範囲を限定する) */
const SAFE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const SAFE_CRATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * crates.ioの更新方法(docs/DESIGN_TODO.md「suggest_fixのRust対応」の表)。直接/推移的依存とTierで分ける。
 * 推奨がない場合はコマンドを示さず、方向だけを示す
 */
function cargoUpdateHint(pkg: ScanReportPackage, recommended: string | null, tier: UpgradeTier | null): string {
  const manifest = pkg.declared_in?.join(", ") ?? (pkg.declaring_crates?.length
    ? `the declaring Cargo.toml files (unmapped declaring crates include ${pkg.declaring_crates.join(", ")})` : "the declaring Cargo.toml");
  const parent = pkg.introduced_by?.join(", ") ?? "the direct dependency that requires this crate";
  if (recommended === null) {
    const direct = `No verified upgrade is recommended (see upgrade_note and per_cve_detail). Any fix requires a version allowed by the requirement in ${manifest}.`;
    const transitive = `No verified upgrade is recommended (see upgrade_note and per_cve_detail). Any fix must be allowed by the requirements of ${parent}.`;
    return pkg.dependency_relation === "direct" ? `Direct dependency. ${direct}`
      : pkg.dependency_relation === "transitive" ? `Transitive dependency. ${transitive}`
      : `For a direct dependency: ${direct} For a transitive dependency: ${transitive}`;
  }
  const embeddable = SAFE_VERSION.test(recommended) && SAFE_VERSION.test(pkg.version) && SAFE_CRATE_NAME.test(pkg.name);
  // OSVの修正版はビルドメタデータを含むことがある。cargoは`--precise`・`=`の要求でメタデータなしの版を受け付ける(cargo 1.98で確認)
  const precise = recommended.split("+")[0]!;
  const target = embeddable ? recommended : "the recommended version";
  const command = embeddable
    ? `cargo update -p ${pkg.name}@${pkg.version} --precise ${precise}`
    : "cargo update with an appropriate -p package specification and --precise version";
  const direct = tier === "cross_major"
    ? `Change the requirement in ${manifest} to allow ${target}; this may include breaking changes (in 0.x, even a minor update).`
    : `If the requirement in ${manifest} allows ${target} (the default caret requirement does), run ${command}; only Cargo.lock changes. ` +
      `If the requirement pins the version (= or ~), change it in ${manifest}.`;
  const transitive = tier === "cross_major"
    ? `Update ${parent} to a version whose requirements permit ${target}. ` +
      "[patch.crates-io] does not override version requirements: use it only for a fix (such as a backport) from another source that still satisfies the requirements of the crates that depend on it."
    : `If the requirements of ${parent} allow ${target}, run ${command}; only Cargo.lock changes. If cargo reports that the requirements cannot be satisfied, update ${parent}.`;
  let hint = pkg.dependency_relation === "direct" ? `Direct dependency. ${direct}`
    : pkg.dependency_relation === "transitive" ? `Transitive dependency. ${transitive}`
    : `For a direct dependency: ${direct} For a transitive dependency: ${transitive}`;
  if (pkg.dependency_relation === "direct" && pkg.introduced_by?.length) hint += ` It is also required by ${parent}, whose requirements must allow ${target} as well.`;
  if (versionSchemeFor("crates.io")!.isPrerelease(recommended)) {
    hint += ` ${target} is a pre-release: Cargo requirements match a pre-release only when they name one, so cargo update --precise alone may fail. ` +
      (embeddable ? `For a direct dependency, set the requirement to "=${precise}"` : "For a direct dependency, set the requirement to the exact pre-release version") +
      "; for a transitive dependency, the crate that requires it must allow it.";
  }
  hint += " Before updating, check that the version is not yanked and that it supports your Rust version (MSRV).";
  return hint;
}

function hintFields(pkg: ScanReportPackage, recommended: string | null = null, tier: UpgradeTier | null = null): { update_hint?: string } {
  const hint = pkg.ecosystem === "crates.io" ? cargoUpdateHint(pkg, recommended, tier) : updateHint(pkg);
  return hint === undefined ? {} : { update_hint: hint };
}

/** スキャン結果に付いた直接/推移的依存の項目を提案にも写す(無ければ何も出さない) */
function relationFields(pkg: ScanReportPackage) {
  return {
    ...(pkg.version_is_lower_bound ? { version_is_lower_bound: true as const } : {}),
    ...(pkg.dependency_relation !== undefined ? { dependency_relation: pkg.dependency_relation } : {}),
    ...(pkg.dependency_groups !== undefined ? { dependency_groups: pkg.dependency_groups } : {}),
    ...(pkg.introduced_by !== undefined ? { introduced_by: pkg.introduced_by } : {}),
    ...(pkg.introduced_by_omitted !== undefined ? { introduced_by_omitted: pkg.introduced_by_omitted } : {}),
    ...(pkg.declared_in !== undefined ? { declared_in: pkg.declared_in } : {}),
    ...(pkg.declaring_crates !== undefined ? { declaring_crates: pkg.declaring_crates } : {}),
    ...(pkg.declaring_crates_omitted !== undefined ? { declaring_crates_omitted: pkg.declaring_crates_omitted } : {}),
    ...(pkg.replaced_in_go_mod ? { replaced_in_go_mod: true as const } : {}),
  };
}

/**
 * 未対応エコシステム・解釈できない現在の版は推奨を出さず、CVEをunfixedにも数えない。
 * 修正版の抽出がMaven専用だった頃、そのまま処理すると修正版のある脆弱性を
 * 「修正版なし」と誤表示した(v0.3.3で確認した不具合)。
 */
function notEvaluatedSuggestion(
  pkg: ScanReportPackage,
  verification: "unsupported_ecosystem" | "unparseable_version",
): PackageUpgradeSuggestion {
  return {
    package: pkg.name,
    current_version: pkg.version,
    ecosystem: pkg.ecosystem,
    ...relationFields(pkg),
    recommended_upgrade: null,
    upgrade_tier: null,
    upgrade_note:
      (verification === "unsupported_ecosystem"
        ? `Upgrade recommendations are not supported for ${pkg.ecosystem} (whether fixed versions exist was not evaluated). `
        : `The current version (${pkg.version}) cannot be parsed as a version, so no upgrade was evaluated (it may be a git or local path dependency). `) +
      "Check the fixed versions of each vulnerability in fixed_versions (scan_project) or with explain_vulnerability",
    per_cve_detail: pkg.vulnerabilities.map((vuln) => ({
      id: vuln.id,
      cve: vuln.cve,
      severity: vuln.severity,
      fixed_in: null,
      tier: vuln.informational !== undefined ? "informational" as const : "unsupported" as const,
      ...(vuln.informational !== undefined ? { informational: vuln.informational, recommended_status: "not_evaluated" as const } : {}),
    })),
    verification,
  };
}

/**
 * 現在より新しい候補を推奨の優先順に並べる: 正式版 → Tier順 → 版の昇順。
 * (同じTierのプレリリースより、上のTierの正式版を優先する)
 * 優先順位が等しい版(Goの`23.0.3`と`23.0.3+incompatible`)は、ビルドメタデータの有無が現在の版と同じものを先にする。
 * `/vN`の無いモジュールパスでv2以上を使うには`+incompatible`付きの指定が必要なため。
 */
function rankCandidates(scheme: VersionScheme, current: string, versions: Iterable<string>): string[] {
  const rank = (v: string) => (scheme.isPrerelease(v) ? TIER_ORDER.length : 0) + TIER_ORDER.indexOf(scheme.classify(current, v));
  const buildMismatch = (v: string) => (v.includes("+") === current.includes("+") ? 0 : 1);
  return [...new Set(versions)]
    .filter((v) => scheme.isValid(v) && scheme.compare(v, current) > 0)
    .sort((a, b) => rank(a) - rank(b) || scheme.compare(a, b) || buildMismatch(a) - buildMismatch(b));
}

function buildNote(
  scheme: VersionScheme,
  pkg: ScanReportPackage,
  recommended: string | null,
  tier: UpgradeTier | null,
  fixableCount: number,
  unfixedCount: number,
): string {
  let note: string;
  if (recommended === null) {
    note = `None of the ${unfixedCount} CVEs has a fixed version newer than the current one (unfixed). The fix information may be incomplete`;
  } else {
    const label = scheme.seriesLabel(pkg.version);
    switch (tier) {
      case "same_minor":
        note = `Recommends ${recommended} within the current ${label} release line`;
        break;
      case "major_internal":
        note = `Recommends ${recommended} within the same major version (${label!.split(".")[0]}.x)`;
        break;
      default:
        if (label === null) note = `The release line of the current version cannot be determined, so the verified candidate ${recommended} is given`;
        else if (label.startsWith("0.") && scheme.seriesLabel(recommended)?.startsWith("0.")) {
          note = `Recommends upgrading to ${recommended} (in 0.x, even a minor update may include breaking changes)`;
        } else note = `Recommends a major upgrade to ${recommended} (may include breaking changes)`;
    }
    note += `. Based on the affected ranges retrieved, it is outside the ranges of all ${fixableCount} CVEs to fix. It is not guaranteed to be the smallest such published version or free of undetected vulnerabilities`;
    if (scheme.isPrerelease(recommended)) {
      note += ". No stable candidate fixes every vulnerability, so a pre-release is recommended. Check whether a stable release is available";
    }
    if (unfixedCount > 0) note += `. The remaining ${unfixedCount} CVEs have no fixed version newer than the current one and are excluded from the fix. Check recommended_status`;
  }
  note += lowerBoundNote(pkg);
  if (pkg.ecosystem === "Go" && GO_PSEUDO_VERSION.test(pkg.version)) {
    note += ". The current version is a pseudo-version (an untagged commit)";
  }
  return note;
}

function lowerBoundNote(pkg: ScanReportPackage): string {
  if (!pkg.version_is_lower_bound) return "";
  const source = pkg.ecosystem === "NuGet" ? "PackageReference (NuGet minimum/range)" : "requirements.txt (>= or ~=)";
  return `. The current version (${pkg.version}) is the lower bound in ${source} and may differ from the installed version. ` +
    "Any recommendation means raising the lower bound to at least that version";
}

/**
 * 推奨先のOSV照会(candidateCheck.ts)で見つかった、現在の版には該当しない脆弱性。
 * 候補の選定にだけ使い(この範囲外であることも推奨の条件にし、修正版を候補に加える)、per_cve_detailには含めない
 */
export interface ExtraFixTarget {
  fixed_versions: readonly string[];
  affected_versions?: ScanReportPackage["vulnerabilities"][number]["affected_versions"];
}

export interface SuggestContext {
  extraTargets?: readonly ExtraFixTarget[];
  /** OSVの判定と手元の範囲情報が食い違った候補(推奨しない) */
  excluded?: ReadonlySet<string>;
}

/**
 * 1パッケージ分のアップグレード提案を組み立てる(同期・純粋)。
 * contextを渡すと、照会で見つかった脆弱性も避けて候補を選び直す(contextなしの結果が従来の推奨)。
 */
/**
 * 修正対象にしない情報提供のアドバイザリ。unmaintained・noticeは版を上げても解消しない(版と無関係)。
 * unsoundは版ごとの欠陥のため、現在より新しい修正版があれば通常の脆弱性と同じく修正対象にする
 * (v0.13.0の実装中に判明: 修正版のあるunsoundを外すと、lru 0.6.0に0.7.1(RUSTSEC-2026-0253の0.18.2未満)を推奨した)
 */
function isExcludedInformational(vuln: ScanReportPackage["vulnerabilities"][number], scheme: VersionScheme, current: string): boolean {
  if (vuln.informational === undefined) return false;
  if (vuln.informational !== "unsound") return true;
  return rankCandidates(scheme, current, vuln.fixed_versions).length === 0 && vuln.fixed_versions.every((v) => scheme.isValid(v));
}

function informationalNote(pkg: ScanReportPackage, excluded: readonly boolean[]): string {
  const notes: string[] = [];
  const kinds = (pick: (excluded: boolean) => boolean) =>
    new Set(pkg.vulnerabilities.filter((v, i) => v.informational !== undefined && pick(excluded[i]!)).map((v) => v.informational));
  const out = kinds((e) => e);
  if (out.has("unmaintained")) notes.push("Unmaintained advisories are not resolved by upgrading; consider an alternative crate.");
  if (out.has("unsound")) notes.push("Unsound advisories without a fixed version remain; check recommended_status.");
  if (out.has("notice")) notes.push("For notices, use explain_vulnerability for details.");
  if (kinds((e) => !e).has("unsound")) notes.push("Unsound advisories with a fixed version are included in the fix.");
  return notes.join(" ");
}

/**
 * 1パッケージ分のアップグレード提案を組み立てる(同期・純粋)。
 * contextを渡すと、照会で見つかった脆弱性も避けて候補を選び直す(contextなしの結果が従来の推奨)。
 */
export function suggestUpgradeForPackage(pkg: ScanReportPackage, context: SuggestContext = {}): PackageUpgradeSuggestion {
  const scheme = versionSchemeFor(pkg.ecosystem);
  if (scheme === null) return notEvaluatedSuggestion(pkg, "unsupported_ecosystem");
  if (!scheme.isValid(pkg.version)) return { ...notEvaluatedSuggestion(pkg, "unparseable_version"), ...hintFields(pkg) };

  const excluded = pkg.vulnerabilities.map((vuln) => isExcludedInformational(vuln, scheme, pkg.version));
  const informationalNotes = informationalNote(pkg, excluded);
  if (pkg.vulnerabilities.length > 0 && excluded.every((e) => e)) {
    return {
      package: pkg.name, current_version: pkg.version, ecosystem: pkg.ecosystem, ...relationFields(pkg),
      recommended_upgrade: null, upgrade_tier: null, upgrade_note: informationalNotes,
      per_cve_detail: pkg.vulnerabilities.map((v) => ({ id: v.id, cve: v.cve, severity: v.severity,
        fixed_in: null, tier: "informational", informational: v.informational!, recommended_status: "not_evaluated" })),
      verification: "informational_only",
    };
  }

  const details: CveFixDetail[] = pkg.vulnerabilities.map((vuln, i) => {
    if (excluded[i]) return {
      id: vuln.id, cve: vuln.cve, severity: vuln.severity, fixed_in: null,
      tier: "informational", informational: vuln.informational!,
    };
    const fix = rankCandidates(scheme, pkg.version, vuln.fixed_versions)[0];
    return {
      id: vuln.id,
      cve: vuln.cve,
      severity: vuln.severity,
      fixed_in: fix ?? null,
      tier: fix !== undefined ? scheme.classify(pkg.version, fix)
        : vuln.fixed_versions.some((v) => !scheme.isValid(v)) ? "unparseable_fix" : "unfixed",
      // 修正対象にした情報提供(修正版のあるunsound)も種類を示す
      ...(vuln.informational !== undefined ? { informational: vuln.informational } : {}),
    };
  });
  const unfixedCount = details.filter((d) => d.tier === "unfixed").length;
  const unparseableCount = details.filter((d) => d.tier === "unparseable_fix").length;
  const fixableCount = details.filter((d) => d.tier !== "unfixed" && d.tier !== "informational").length;
  // 解釈できない修正版のCVEも修正対象に残す。その影響範囲は情報不足のため、どの候補も検証できず推奨を保留する
  const targets: readonly ExtraFixTarget[] = [
    ...pkg.vulnerabilities.filter((_, i) => details[i]!.tier !== "unfixed" && details[i]!.tier !== "informational"),
    ...(context.extraTargets ?? []),
  ];
  const candidates = rankCandidates(scheme, pkg.version, targets.flatMap((v) => v.fixed_versions));
  const recommended = candidates.find((v) => !context.excluded?.has(v) &&
    targets.every((target) => candidateStatus(target.affected_versions, v, pkg.ecosystem) === "not_affected")) ?? null;
  for (let i = 0; i < details.length; i++) {
    details[i]!.recommended_status = recommended === null ? "not_evaluated" :
      candidateStatus(pkg.vulnerabilities[i]!.affected_versions, recommended, pkg.ecosystem);
  }
  const upgradeTier = recommended !== null ? scheme.classify(pkg.version, recommended) : null;

  return {
    package: pkg.name,
    current_version: pkg.version,
    ecosystem: pkg.ecosystem,
    ...relationFields(pkg),
    recommended_upgrade: recommended,
    upgrade_tier: upgradeTier,
    ...(recommended !== null && scheme.isPrerelease(recommended) ? { recommended_is_prerelease: true as const } : {}),
    upgrade_note: (recommended === null && fixableCount > 0
      ? "No known fixed version could be confirmed to be outside the affected ranges of every CVE to fix. The recommendation is also withheld when the data are insufficient or use unsupported range types." +
        (unparseableCount > 0 ? ` ${unparseableCount} CVEs list fixed versions that cannot be parsed as versions (tier: unparseable_fix), so the recommendation is withheld.` : "")
      : buildNote(scheme, pkg, recommended, upgradeTier, fixableCount, unfixedCount)) +
      (recommended === null && fixableCount > 0 ? lowerBoundNote(pkg) : "") + (informationalNotes ? ` ${informationalNotes}` : ""),
    ...hintFields(pkg, recommended, upgradeTier),
    per_cve_detail: details,
    verification: recommended === null ? "no_verified_candidate" : "verified",
  };
}

/** スキャンレポート全体からパッケージごとの提案一覧を作る(深刻度順を維持)。 */
export function suggestUpgrades(packages: readonly ScanReportPackage[]): PackageUpgradeSuggestion[] {
  return packages.map((pkg) => suggestUpgradeForPackage(pkg));
}
