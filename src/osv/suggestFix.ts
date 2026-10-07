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

import type { ScanReportPackage, SeverityLevel } from "./scanReport.js";
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
  tier: UpgradeTier | "unfixed" | "unparseable_fix" | "unsupported";
  recommended_status?: "affected" | "not_affected" | "unknown" | "not_evaluated";
}

export interface PackageUpgradeSuggestion {
  package: string;
  current_version: string;
  ecosystem: string;
  /** 直接/推移的依存の別と関連情報(scan_projectのpackagesと同じ。scan_project・suggest_fixが付ける) */
  dependency_relation?: ScanReportPackage["dependency_relation"];
  introduced_by?: string[];
  introduced_by_omitted?: number;
  declared_in?: string[];
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
  verification: "verified" | "no_verified_candidate" | "unsupported_ecosystem" | "unparseable_version";
}

const TIER_ORDER: readonly UpgradeTier[] = ["same_minor", "major_internal", "cross_major"];

const UPDATE_HINTS: Record<string, string> = {
  npm:
    "直接依存ならpackage.jsonの指定を更新します。推移的依存の場合は、それを要求している直接依存の更新か、" +
    "ルートのpackage.jsonのoverrides(ルートのプロジェクトでのみ有効)で版を指定します",
  Go:
    "go get <module>@<version>で更新します(推移的依存もgo.modのrequireに追加されて更新されます)。" +
    "Goではv2以上のメジャーは別のモジュールパス(/v2等)として別パッケージ扱いのため、新しいメジャー系列の修正版はここに含まれません",
  PyPI:
    "requirements.txtの版の指定、またはpyproject.toml・Pipfileの指定を更新し、lockfile(poetry.lock・uv.lock等)を再生成します。" +
    "推移的依存の場合は、pipの制約ファイル(-c)や、uv・Poetry等の上書き設定で版を指定します",
};

/** Goの疑似バージョン(タグのないコミット): 末尾がタイムスタンプ14桁-コミットハッシュ12桁 */
const GO_PSEUDO_VERSION = /(?:^|[.-])\d{14}-[0-9a-f]{12}(?:\+|$)/;

const GO_MAJOR_NOTE =
  "Goではv2以上のメジャーは別のモジュールパス(/v2等)として別パッケージ扱いのため、新しいメジャー系列の修正版はここに含まれません";

/**
 * 推奨版への更新方法。直接/推移的依存の別が分かれば具体化し、分からなければ(unknown・mixed)両方を案内する
 */
function updateHint(pkg: ScanReportPackage): string | undefined {
  const relation = pkg.dependency_relation;
  const by = pkg.introduced_by?.join("、");
  switch (pkg.ecosystem) {
    case "npm":
      if (relation === "direct") {
        return `直接依存です。${pkg.declared_in?.join("、") ?? "package.json"}の指定を更新します` +
          (by ? `。${by}からも推移的に要求されているため、それらの更新が必要な場合もあります` : "");
      }
      if (relation === "transitive") {
        return `推移的依存です。${by ? `要求している直接依存(${by})` : "要求している直接依存"}を、推奨版以上を要求する版に更新します。` +
          "直接依存の更新で直らない場合は、ルートのpackage.jsonのoverrides(ルートのプロジェクトでのみ有効)で版を指定します";
      }
      return UPDATE_HINTS.npm;
    case "Go": {
      if (pkg.replaced_in_go_mod) {
        return `go.modのreplaceで置き換えているため、requireではなくreplaceの版を更新します。${GO_MAJOR_NOTE}`;
      }
      if (relation === "direct") return `直接依存です。go get <module>@<version>で更新します。${GO_MAJOR_NOTE}`;
      if (relation === "transitive") {
        return "間接依存(go.modの// indirect)です。go get <module>@<version>でgo.modの版を引き上げられます" +
          `(依存元のモジュールの更新で解消できる場合もあります)。${GO_MAJOR_NOTE}`;
      }
      return UPDATE_HINTS.Go;
    }
    case "PyPI":
      if (relation === "direct") {
        return "直接依存です。requirements.txtの版の指定、またはpyproject.toml・Pipfileの指定を更新し、lockfileを再生成します";
      }
      if (relation === "transitive") {
        return "推移的依存です。それを要求している直接依存の更新か、pipの制約ファイル(-c)、uv・Poetry等の上書き設定で版を指定します";
      }
      return UPDATE_HINTS.PyPI;
    default:
      return UPDATE_HINTS[pkg.ecosystem];
  }
}

function hintFields(pkg: ScanReportPackage): { update_hint?: string } {
  const hint = updateHint(pkg);
  return hint === undefined ? {} : { update_hint: hint };
}

/** スキャン結果に付いた直接/推移的依存の項目を提案にも写す(無ければ何も出さない) */
function relationFields(pkg: ScanReportPackage) {
  return {
    ...(pkg.dependency_relation !== undefined ? { dependency_relation: pkg.dependency_relation } : {}),
    ...(pkg.introduced_by !== undefined ? { introduced_by: pkg.introduced_by } : {}),
    ...(pkg.introduced_by_omitted !== undefined ? { introduced_by_omitted: pkg.introduced_by_omitted } : {}),
    ...(pkg.declared_in !== undefined ? { declared_in: pkg.declared_in } : {}),
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
        ? `${pkg.ecosystem}の修正版推奨には未対応です(修正版の有無は判定していません)。`
        : `現在の版(${pkg.version})をバージョンとして解釈できないため、修正版の推奨を判定していません(git・ローカルパス等の依存の可能性があります)。`) +
      "各脆弱性の修正版はfixed_versions(scan_project)またはexplain_vulnerabilityで確認してください",
    per_cve_detail: pkg.vulnerabilities.map((vuln) => ({
      id: vuln.id,
      cve: vuln.cve,
      severity: vuln.severity,
      fixed_in: null,
      tier: "unsupported" as const,
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
    note = `全${unfixedCount}件のCVEに現在より新しい修正版候補がない(unfixed)。修正版情報の欠落を含む可能性があります`;
  } else {
    const label = scheme.seriesLabel(pkg.version);
    switch (tier) {
      case "same_minor":
        note = `現在の${label}系統内の候補${recommended}を推奨`;
        break;
      case "major_internal":
        note = `同一メジャー(${label!.split(".")[0]}.x)内の候補${recommended}を推奨`;
        break;
      default:
        if (label === null) note = `現在バージョンの系統を判定できないため、検証済み候補${recommended}を提示`;
        else if (label.startsWith("0.") && scheme.seriesLabel(recommended)?.startsWith("0.")) {
          note = `候補${recommended}への更新を推奨(0.x系のため、マイナー更新でも破壊的変更の可能性あり)`;
        } else note = `候補${recommended}へのメジャーアップグレードを推奨(破壊的変更の可能性あり)`;
    }
    note += `。取得済みの影響範囲に基づき修正対象${fixableCount}件のCVEの範囲外と確認しました。全公開版の最小性や未検出の脆弱性がないことは保証しません`;
    if (scheme.isPrerelease(recommended)) {
      note += "。正式版の候補では全件を解消できないため、プレリリース版を推奨しています。正式版の公開を確認してください";
    }
    if (unfixedCount > 0) note += `。残り${unfixedCount}件は現在より新しい修正版候補がなく、修正対象から除外しています。recommended_statusを確認してください`;
  }
  if (pkg.version_is_lower_bound) {
    note += `。現在の版(${pkg.version})はrequirements.txtの下限(>=・~=)で、実際にインストールされる版とは異なる可能性があります。` +
      "推奨は下限をその版以上に引き上げる意味です";
  }
  if (pkg.ecosystem === "Go" && GO_PSEUDO_VERSION.test(pkg.version)) {
    note += "。現在の版は疑似バージョン(タグのないコミット)です";
  }
  return note;
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
export function suggestUpgradeForPackage(pkg: ScanReportPackage, context: SuggestContext = {}): PackageUpgradeSuggestion {
  const scheme = versionSchemeFor(pkg.ecosystem);
  if (scheme === null) return notEvaluatedSuggestion(pkg, "unsupported_ecosystem");
  if (!scheme.isValid(pkg.version)) return { ...notEvaluatedSuggestion(pkg, "unparseable_version"), ...hintFields(pkg) };

  const details: CveFixDetail[] = pkg.vulnerabilities.map((vuln) => {
    const fix = rankCandidates(scheme, pkg.version, vuln.fixed_versions)[0];
    return {
      id: vuln.id,
      cve: vuln.cve,
      severity: vuln.severity,
      fixed_in: fix ?? null,
      tier: fix !== undefined ? scheme.classify(pkg.version, fix)
        : vuln.fixed_versions.some((v) => !scheme.isValid(v)) ? "unparseable_fix" : "unfixed",
    };
  });
  const unfixedCount = details.filter((d) => d.tier === "unfixed").length;
  const unparseableCount = details.filter((d) => d.tier === "unparseable_fix").length;
  const fixableCount = details.length - unfixedCount;
  // 解釈できない修正版のCVEも修正対象に残す。その影響範囲は情報不足のため、どの候補も検証できず推奨を保留する
  const targets: readonly ExtraFixTarget[] = [
    ...pkg.vulnerabilities.filter((_, i) => details[i]!.tier !== "unfixed"),
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
    upgrade_note: recommended === null && fixableCount > 0
      ? "既知の修正版候補から、全修正対象CVEの影響範囲外と確認できる版が見つかりません。情報不足・未対応の範囲形式を含む場合も推奨を保留します。" +
        (unparseableCount > 0 ? `${unparseableCount}件のCVEは修正版の記載をバージョンとして解釈できないため(tier: unparseable_fix)、推奨を保留しています。` : "")
      : buildNote(scheme, pkg, recommended, upgradeTier, fixableCount, unfixedCount),
    ...hintFields(pkg),
    ...(pkg.version_is_lower_bound ? { version_is_lower_bound: true as const } : {}),
    per_cve_detail: details,
    verification: recommended === null ? "no_verified_candidate" : "verified",
  };
}

/** スキャンレポート全体からパッケージごとの提案一覧を作る(深刻度順を維持)。 */
export function suggestUpgrades(packages: readonly ScanReportPackage[]): PackageUpgradeSuggestion[] {
  return packages.map((pkg) => suggestUpgradeForPackage(pkg));
}
