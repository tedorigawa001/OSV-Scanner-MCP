/**
 * 推奨先のOSV照会(docs/DESIGN_TODO.md「推奨先のOSV照会(v0.8.0候補)詳細設計メモ」)。
 *
 * suggest_fixの推奨は、スキャンで分かった脆弱性(現在の版に該当するもの)の影響範囲だけで検証している。
 * 推奨先に、現在の版には該当しない新しい脆弱性があっても分からない(実例: cryptography 3.2の推奨49.0.0は、
 * 44.0.0で混入し50.0.0で修正された2件に該当)。推奨先をapi.osv.devに照会し、該当する脆弱性があれば、
 * それも避けるよう候補を選び直す。
 *
 * - 送るのはスキャンで既に照会したパッケージの名前と、公開されている修正版の版だけ(送信先もスキャンと同じ)
 * - 照会に失敗しても推奨は出す(スキャンした脆弱性に対する検証は済んでいる)。ツール全体をエラーにしない
 * - 照会の回数・同時実行数に上限を設ける
 */

import { ScanToolError } from "../errors.js";
import { asString, asStrings } from "../utils/unknownJson.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import { extractAffectedVersions } from "./affectedVersions.js";
import { queryOsvPackageVersion, type FetchOsvRecordOptions } from "./osvApi.js";
import { extractFixedVersions, recordInformationalKind, type ScanReportPackage } from "./scanReport.js";
import { suggestUpgradeForPackage, type ExtraFixTarget, type PackageUpgradeSuggestion } from "./suggestFix.js";
import {queryOfflineCandidate} from './offlineCandidate.js';
import type {RunOsvScanOptions} from './runner.js';
import type {OfflineDatabaseMetadata} from './offlineCache.js';

export const NO_CANDIDATE_CHECK_ENV = "OSV_MCP_NO_CANDIDATE_CHECK";

/**
 * conflict: OSVが、スキャンで既に知っている脆弱性に候補が該当すると返した(手元の範囲情報との食い違い)うえ、
 *   他に候補がない。食い違いのある候補は推奨せず、推奨を保留する
 */
export type CandidateCheckStatus = "clean" | "has_known_vulnerabilities" | "conflict" | "failed" | "skipped" | "disabled";

export interface CandidateCheckOptions extends FetchOsvRecordOptions {
  /** 1パッケージあたりの照会回数の上限(既定4) */
  maxQueriesPerPackage?: number;
  /** 1回のツール呼び出しでの照会回数の合計の上限(既定60) */
  maxQueriesTotal?: number;
  /** 同時に照会するパッケージ数(既定4) */
  concurrency?: number;
}

/** 環境変数で無効化されているか(1/true/yes) */
export function candidateCheckDisabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[NO_CANDIDATE_CHECK_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** OSVレコードのIDと別名 */
function recordIds(record: Record<string, unknown>): string[] {
  const id = asString(record.id);
  return [...(id !== null ? [id] : []), ...asStrings(record.aliases)];
}

type CheckResult = {
  suggestion: PackageUpgradeSuggestion;
  status: Exclude<CandidateCheckStatus, "disabled">;
  /** 推奨先に該当する脆弱性のID(has_known_vulnerabilities・conflictの場合) */
  knownVulnerabilities?: string[];
  /** 照会で既知の脆弱性が見つかり、選び直す前に推奨しかけた版と件数 */
  rejected: { version: string; count: number }[];
};

/** 照会の合計回数の残り(パッケージをまたいで共有する) */
class QueryBudget {
  constructor(private remaining: number) {}
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }
}

async function checkPackage(
  pkg: ScanReportPackage,
  initial: PackageUpgradeSuggestion,
  budget: QueryBudget,
  options: CandidateCheckOptions,
  queryCandidate: (ecosystem: string, name: string, version: string) => Promise<unknown[]>,
  local = false,
): Promise<CheckResult> {
  const known = new Set(pkg.vulnerabilities.flatMap((v) => [v.id, ...v.aliases]));
  const unfixed = new Set(initial.per_cve_detail.filter((v) => v.tier === "unfixed" || v.tier === "informational").map((v) => v.id));
  const ignoredKnown = new Set(pkg.vulnerabilities.filter((v) => unfixed.has(v.id)).flatMap((v) => [v.id, ...v.aliases]));
  // 別名が修正対象とも重なる場合は、その対象の判定を優先する。
  for (const vuln of pkg.vulnerabilities) {
    if (!unfixed.has(vuln.id)) for (const id of [vuln.id, ...vuln.aliases]) ignoredKnown.delete(id);
  }
  const extraTargets: ExtraFixTarget[] = [];
  const excluded = new Set<string>();
  const rejected: CheckResult["rejected"] = [];
  let suggestion = initial;
  const maxQueries = options.maxQueriesPerPackage ?? 4;
  for (let query = 0; query < maxQueries; query++) {
    const candidate = suggestion.recommended_upgrade!;
    if (!budget.take()) return { suggestion, status: "skipped", rejected };
    let records: Record<string, unknown>[];
    try {
      // queryOsvPackageVersionが各レコードをオブジェクトと検証済み(不正な応答は失敗になる)
      records = (await queryCandidate(pkg.ecosystem, pkg.name, candidate)) as Record<string, unknown>[];
    } catch (error) {
      // Offline cache/identification failures invalidate the tool result; never hide them behind a recommendation.
      if (local) throw error;
      if (error instanceof ScanToolError) return { suggestion, status: "failed", rejected };
      throw error;
    }
    // 修正版なしの既知の脆弱性は修正対象ではなく、推奨先でもaffectedであることと矛盾しない。
    // 新しく照会で見つかった対象はknownへ追加されるが、ignoredKnownには入れない。
    records = records.filter((record) => {
      const matched = recordIds(record).filter((id) => known.has(id));
      if (matched.length > 0) return matched.some((id) => !ignoredKnown.has(id));
      const kind = pkg.ecosystem === "crates.io" ? recordInformationalKind(record, pkg.name, pkg.ecosystem) : null;
      return kind !== "unmaintained" && kind !== "notice";
    });
    if (records.length === 0) return { suggestion, status: "clean", rejected };

    // 新しい脆弱性は修正対象に加え、修正版を候補に加える。既知の修正対象の脆弱性に該当と返った場合は、
    // 手元の範囲情報とOSVの判定が食い違っているため、その候補を除外する(安全側)
    // 既知判定は照会開始時点で固定する。同じ応答内のGO/GHSA別名は新規対象の証拠としてすべて残し、
    // 1件目が追加した別名を2件目の「既知対象との矛盾」にしない。次の照会には既知集合を引き継ぐ。
    const knownBeforeQuery = new Set(known);
    let conflict = false;
    for (const record of records) {
      const ids = recordIds(record);
      if (ids.some((id) => knownBeforeQuery.has(id))) {
        excluded.add(candidate);
        conflict = true;
        continue;
      }
      for (const id of ids) known.add(id);
      extraTargets.push({
        fixed_versions: extractFixedVersions([record], pkg.name, pkg.ecosystem),
        affected_versions: extractAffectedVersions([record], ids.slice(0, 1), pkg.name, pkg.ecosystem),
      });
    }
    rejected.push({ version: candidate, count: records.length });
    const next = suggestUpgradeForPackage(pkg, { extraTargets, excluded });
    if (next.recommended_upgrade === null) {
      rejected.pop();
      const knownVulnerabilities = records.map((record) => asString(record.id)).filter((id): id is string => id !== null);
      // 判定の食い違い: その候補はスキャンした脆弱性の範囲外とは言えないため、推奨しない(保留する)
      if (conflict) return { suggestion: withheld(suggestion, candidate, local), status: "conflict", knownVulnerabilities, rejected };
      // 新しい脆弱性に修正版がない等で選び直せない: 最後に照会した推奨を、該当する脆弱性とともに返す
      return { suggestion, status: "has_known_vulnerabilities", knownVulnerabilities, rejected };
    }
    suggestion = next;
  }
  // 1パッケージの照会回数の上限: 最後に選び直した推奨は照会していない
  return { suggestion, status: "skipped", rejected };
}

/** 推奨を保留した提案(推奨先・Tier・推奨先での判定を外し、verificationをno_verified_candidateにする) */
function withheld(suggestion: PackageUpgradeSuggestion, candidate: string, local = false): PackageUpgradeSuggestion {
  const { recommended_is_prerelease: _prerelease, ...rest } = suggestion;
  return {
    ...rest,
    recommended_upgrade: null,
    upgrade_tier: null,
    upgrade_note:
      `Candidate ${candidate} was evaluated as outside the ranges of the scanned vulnerabilities, but ${local ? 'the local database snapshot' : 'OSV'} reports that it is affected by them (the range data disagree). ` +
      "No candidate could be confirmed safe, so the recommendation is withheld",
    per_cve_detail: suggestion.per_cve_detail.map((detail) => ({ ...detail, recommended_status: "not_evaluated" as const })),
    verification: "no_verified_candidate",
  };
}

/** 注記に並べる脆弱性IDの件数と、IDの長さの上限。OSV由来の値のため、応答の大きさを入力に比例させない */
const MAX_LISTED_VULNERABILITIES = 20;
const MAX_ID_LENGTH = 128;

/** 脆弱性IDの一覧を上限付きにする(超えた分は件数で示す。脆弱性チェックで判明、2026-11-20) */
function listedIds(ids: readonly string[]): string[] {
  const listed = ids.slice(0, MAX_LISTED_VULNERABILITIES).map((id) => {
    const clean = sanitizeExternalText(id);
    return clean.length > MAX_ID_LENGTH ? `${clean.slice(0, MAX_ID_LENGTH)}…` : clean;
  });
  if (ids.length > MAX_LISTED_VULNERABILITIES) listed.push(`(${ids.length - MAX_LISTED_VULNERABILITIES} more)`);
  return listed;
}

function applyResult(result: CheckResult, local = false): PackageUpgradeSuggestion {
  const { suggestion, status, knownVulnerabilities, rejected } = result;
  const source = local ? 'the local database snapshot' : 'OSV';
  const notes: string[] = [];
  if (rejected.length > 0) {
    const found = rejected.map((r) => `${r.version} is affected by ${r.count} known ${r.count === 1 ? "vulnerability" : "vulnerabilities"}`).join(", ");
    notes.push(
      suggestion.recommended_upgrade !== null
        ? `The recommended version was checked against ${source}: ${found}, so ${suggestion.recommended_upgrade} is recommended instead (including vulnerabilities that do not affect the current version)`
        : `The recommended version was checked against ${source}: ${found}, so it was dropped from the candidates`,
    );
  }
  if (status === "conflict") {
    // 理由はwithheldの注記に含めた。推奨しかけた版で該当と返った脆弱性はrecommended_known_vulnerabilitiesではなく注記に示す
    notes.push(`Vulnerabilities reported by ${source}: ${listedIds(knownVulnerabilities!).join(", ")}`);
  } else if (status === "has_known_vulnerabilities") {
    notes.push(
      `According to ${source}, the recommended version ${suggestion.recommended_upgrade} is affected by ${knownVulnerabilities!.length} known ${knownVulnerabilities!.length === 1 ? "vulnerability" : "vulnerabilities"} (recommended_known_vulnerabilities). ` +
        "No fixed version that avoids them was found",
    );
  } else if (status === "failed") {
    notes.push("The OSV check of the recommended version failed, so it is not confirmed that the recommended version is free of known vulnerabilities that do not affect the current version");
  } else if (status === "skipped") {
    notes.push(`The query limit was reached, so the recommended version was not checked against ${source} (its known vulnerabilities are unconfirmed)`);
  }
  if (local) notes.push(status === 'clean'
    ? 'Offline mode: no additional fix-target vulnerabilities were found in the local database snapshot. Newer advisories are not covered; this does not establish safety'
    : 'Offline mode: candidate checks use only the local database snapshot and do not cover newer advisories');
  const { per_cve_detail, verification, ...rest } = suggestion;
  return {
    ...rest,
    upgrade_note: [suggestion.upgrade_note, ...notes].map((note) => note.replace(/\.$/, "")).join(". "),
    candidate_check: status,
    ...(local ? {candidate_check_source: 'local_database' as const} : {}),
    ...(status === "has_known_vulnerabilities" ? { recommended_known_vulnerabilities: listedIds(knownVulnerabilities!) } : {}),
    per_cve_detail,
    verification,
  };
}

/**
 * 推奨を出したパッケージの推奨先をOSVに照会し、必要なら選び直す。
 * suggestionsはpackagesと同じ順(suggestUpgradesの結果)であること。推奨のないものはそのまま返す。
 */
export async function checkRecommendedCandidates(
  packages: readonly ScanReportPackage[],
  suggestions: readonly PackageUpgradeSuggestion[],
  options: CandidateCheckOptions | "disabled" = {},
): Promise<PackageUpgradeSuggestion[]> {
  if (options === "disabled") {
    return suggestions.map((s) => (s.recommended_upgrade === null ? s : { ...s, candidate_check: "disabled" as const }));
  }
  return checkCandidates(packages, suggestions, options, (ecosystem, name, version) => queryOsvPackageVersion(ecosystem, name, version, options));
}

/** Native checks are sequential to coexist with the scanner's process/memory limit. No API option can override this route. */
export async function checkOfflineRecommendedCandidates(
  packages: readonly ScanReportPackage[], suggestions: readonly PackageUpgradeSuggestion[],
  runner: RunOsvScanOptions, expected: OfflineDatabaseMetadata, options: CandidateCheckOptions | 'disabled' = {},
): Promise<PackageUpgradeSuggestion[]> {
  if (options === 'disabled') return suggestions.map(s => s.recommended_upgrade === null ? s : {...s, candidate_check: 'disabled' as const,
    upgrade_note: s.upgrade_note + '. Offline mode: local candidate checks are disabled; the recommended version may have other known vulnerabilities'});
  return checkCandidates(packages, suggestions, {...options, concurrency: 1},
    (ecosystem, name, version) => queryOfflineCandidate(ecosystem, name, version, runner, expected), true);
}

async function checkCandidates(
  packages: readonly ScanReportPackage[], suggestions: readonly PackageUpgradeSuggestion[], options: CandidateCheckOptions,
  query: (ecosystem: string, name: string, version: string) => Promise<unknown[]>, local = false,
): Promise<PackageUpgradeSuggestion[]> {
  const budget = new QueryBudget(options.maxQueriesTotal ?? 60);
  const results: PackageUpgradeSuggestion[] = [...suggestions];
  const pending = suggestions.flatMap((s, i) => (s.recommended_upgrade === null ? [] : [i]));
  // 同時実行数を制限して順に処理する(順番は結果に影響しない。予算はパッケージの順に消費されやすい)
  const workers = Array.from({ length: Math.max(1, options.concurrency ?? 4) }, async () => {
    for (let index = pending.shift(); index !== undefined; index = pending.shift()) {
      results[index] = applyResult(await checkPackage(packages[index]!, suggestions[index]!, budget, options, query, local), local);
    }
  });
  await Promise.all(workers);
  return results;
}
