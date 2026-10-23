/**
 * 同じ対象・同じ種類の2回のスキャンの比較(docs/DESIGN_TODO.md「スキャンの実行履歴」)。
 *
 * - 脆弱性は、IDか別名が1つでも重なれば同じとみなす(OSVの代表IDが入れ替わっても新規・解消と誤らない)
 * - パッケージ(エコシステムと名前)単位で比べる。版が変わっても残っている脆弱性は、新規にも解消にも数えない
 * - スキャン結果には脆弱なパッケージしか載らないため、結果から消えたパッケージが「更新された」のか
 *   「削除された」のかは区別できない。解消の理由はその限界に合わせて分ける
 * - 差分はスキャンの時点のOSVのデータに依存する(コードを変えていなくてもデータの更新で増減する)
 */

import type { HistoryFinding, HistoryRecord, HistoryVulnerability } from "./historyRecord.js";

export interface VulnerabilityChange {
  ecosystem: string;
  name: string;
  version: string;
  id: string;
  aliases: string[];
  informational?: string;
}

export interface ResolvedVulnerability extends VulnerabilityChange {
  /**
   * version_changed: 同じパッケージが別の版で結果に残っている /
   * package_not_reported: パッケージが結果から消えた(既知の脆弱性のない版への更新・削除・スキャン範囲外のいずれか) /
   * same_version_not_reported: 同じ版のまま、この脆弱性が報告されなくなった(OSVのデータの更新等)
   */
  reason: "version_changed" | "package_not_reported" | "same_version_not_reported";
  current_versions?: string[];
}

export interface HistoryChanges {
  from: { id: string; started_at: string; tool: string };
  to: { id: string; started_at: string; tool: string };
  new_vulnerabilities: VulnerabilityChange[];
  resolved_vulnerabilities: ResolvedVulnerability[];
  /** still_affected: 版が変わっても残っている(前回もあった)脆弱性の数 */
  version_changes: { ecosystem: string; name: string; from: string[]; to: string[]; still_affected: number }[];
  coverage_changes: {
    complete?: { from: boolean | null; to: boolean | null };
    manifests_added?: string[];
    manifests_removed?: string[];
  };
  /** 比較に使えない・不完全な場合の理由 */
  incomplete?: string;
}

const MAX_LISTED = 500;

function packageKey(f: { ecosystem: string; name: string }): string {
  return JSON.stringify([f.ecosystem, f.name]);
}

function identities(v: HistoryVulnerability): string[] {
  return [v.id, ...v.aliases];
}

/** パッケージの全ての版の脆弱性のIDと別名の集合(照合を件数に比例する時間で行うため) */
function identitySet(findings: readonly HistoryFinding[]): Set<string> {
  const ids = new Set<string>();
  for (const f of findings) for (const v of f.vulnerabilities) for (const id of identities(v)) ids.add(id);
  return ids;
}

/** IDか別名のどれかが集合に含まれるか */
function overlaps(ids: ReadonlySet<string>, target: HistoryVulnerability): boolean {
  return identities(target).some((id) => ids.has(id));
}

function versionsOf(findings: readonly HistoryFinding[]): string[] {
  return [...new Set(findings.map((f) => f.version))].sort();
}

function byPackage(findings: readonly HistoryFinding[]): Map<string, HistoryFinding[]> {
  const map = new Map<string, HistoryFinding[]>();
  for (const f of findings) {
    const key = packageKey(f);
    const list = map.get(key) ?? [];
    list.push(f);
    map.set(key, list);
  }
  return map;
}

function change(f: HistoryFinding, v: HistoryVulnerability): VulnerabilityChange {
  return { ecosystem: f.ecosystem, name: f.name, version: f.version, id: v.id, aliases: v.aliases, ...(v.informational !== undefined ? { informational: v.informational } : {}) };
}

export function compareHistoryRecords(older: HistoryRecord, newer: HistoryRecord): HistoryChanges {
  const result: HistoryChanges = {
    from: { id: older.id, started_at: older.started_at, tool: older.tool },
    to: { id: newer.id, started_at: newer.started_at, tool: newer.tool },
    new_vulnerabilities: [],
    resolved_vulnerabilities: [],
    version_changes: [],
    coverage_changes: {},
  };
  if (older.coverage_complete !== newer.coverage_complete) {
    result.coverage_changes.complete = { from: older.coverage_complete, to: newer.coverage_complete };
  }
  const reasons: string[] = [];
  if (older.manifests_truncated || newer.manifests_truncated) {
    reasons.push("one of the runs recorded only part of its manifest list (the record size limit was reached), so manifest changes are not shown");
  } else if (older.manifests !== undefined && newer.manifests !== undefined) {
    const before = new Set(older.manifests.map((m) => m.path));
    const after = new Set(newer.manifests.map((m) => m.path));
    const added = [...after].filter((p) => !before.has(p)).sort();
    const removed = [...before].filter((p) => !after.has(p)).sort();
    if (added.length > 0) result.coverage_changes.manifests_added = added.slice(0, MAX_LISTED);
    if (removed.length > 0) result.coverage_changes.manifests_removed = removed.slice(0, MAX_LISTED);
  }
  if (older.findings === undefined || newer.findings === undefined) {
    reasons.unshift("One of the runs has no recorded findings (it exceeded the record size limit), so vulnerabilities cannot be compared");
    result.incomplete = reasons.join("; ");
    return result;
  }
  if (older.findings_truncated || newer.findings_truncated) reasons.push("one of the runs recorded only part of its findings (the findings limit was reached)");

  // パッケージ(エコシステムと名前)単位で比べる。版が変わっても残っている脆弱性は新規・解消のどちらにも数えない
  const before = byPackage(older.findings);
  const after = byPackage(newer.findings);
  const empty: HistoryFinding[] = [];
  for (const [key, newList] of after) {
    const oldList = before.get(key) ?? empty;
    const oldIds = identitySet(oldList);
    let stillAffected = 0;
    for (const f of newList) {
      for (const v of f.vulnerabilities) {
        if (overlaps(oldIds, v)) stillAffected++;
        else result.new_vulnerabilities.push(change(f, v));
      }
    }
    const fromVersions = versionsOf(oldList);
    const toVersions = versionsOf(newList);
    if (oldList.length > 0 && JSON.stringify(fromVersions) !== JSON.stringify(toVersions)) {
      result.version_changes.push({ ecosystem: newList[0]!.ecosystem, name: newList[0]!.name, from: fromVersions, to: toVersions, still_affected: stillAffected });
    }
  }
  for (const [key, oldList] of before) {
    const newList = after.get(key) ?? empty;
    const newIds = identitySet(newList);
    const currentVersions = versionsOf(newList);
    const reason: ResolvedVulnerability["reason"] = newList.length === 0 ? "package_not_reported"
      : JSON.stringify(versionsOf(oldList)) === JSON.stringify(currentVersions) ? "same_version_not_reported" : "version_changed";
    for (const f of oldList) {
      for (const v of f.vulnerabilities) {
        if (overlaps(newIds, v)) continue;
        result.resolved_vulnerabilities.push({ ...change(f, v), reason, ...(reason === "version_changed" ? { current_versions: currentVersions } : {}) });
      }
    }
  }
  for (const list of [result.new_vulnerabilities, result.resolved_vulnerabilities, result.version_changes] as unknown[][]) {
    if (list.length > MAX_LISTED) {
      reasons.push(`only the first ${MAX_LISTED} entries of a list are shown`);
      list.length = MAX_LISTED;
    }
  }
  if (reasons.length > 0) result.incomplete = [...new Set(reasons)].join("; ");
  return result;
}
