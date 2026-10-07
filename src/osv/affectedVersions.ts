import { asArray, asRecord, asString } from "../utils/unknownJson.js";
import { samePackageName, versionRangeTypes, versionSchemeFor } from "./versionScheme.js";

export interface AffectedInterval {
  introduced: string;
  end: string | null;
  inclusive: boolean;
}

export interface AffectedVersionEvidence {
  complete: boolean;
  intervals: AffectedInterval[];
  versions: string[];
}

/**
 * Preserve uncertainty: unsupported or malformed ranges cannot prove a candidate safe.
 * 比較・範囲の型はエコシステム別(versionScheme.ts)。比較器のないエコシステムは常に情報不足。
 * 解釈できない版(SemVerでない値等)を含む範囲は判定に使わず、情報不足とする。
 * - `versions[]`の解釈できない値(Gitのタグ名等)は無視する。`versions[]`は等価判定にだけ使い、
 *   解釈できない文字列は解釈できる候補と等しくなりえないため、無視しても候補の判定は変わらない
 * - 同じaffectedエントリにECOSYSTEM等の版の範囲があれば、GIT範囲(コミット単位)は無視する。GIT範囲だけなら情報不足
 */
export function extractAffectedVersions(
  details: Record<string, unknown>[], ids: string[], name: string, ecosystem: string,
): AffectedVersionEvidence {
  const scheme = versionSchemeFor(ecosystem);
  const rangeTypes = versionRangeTypes(ecosystem);
  const evidence: AffectedVersionEvidence = { complete: scheme !== null, intervals: [], versions: [] };
  const valid = (value: string) => scheme?.isValid(value) ?? false;
  const compare = (a: string, b: string) => scheme?.compare(a, b) ?? 0;
  if (ids.length === 0 || ids.some(id => !details.some(d => d.id === id))) evidence.complete = false;
  for (const detail of details) {
    let matched = false;
    for (const raw of asArray(detail.affected)) {
      const affected = asRecord(raw);
      const pkg = asRecord(affected?.package);
      const affectedName = asString(pkg?.name);
      if (affectedName === null || !samePackageName(affectedName, name, ecosystem) || asString(pkg?.ecosystem) !== ecosystem) {
        if (!asString(pkg?.name) || !asString(pkg?.ecosystem)) evidence.complete = false;
        continue;
      }
      matched = true;
      if (affected?.versions !== undefined && !Array.isArray(affected.versions)) evidence.complete = false;
      for (const version of asArray(affected?.versions)) {
        const value = asString(version);
        if (!value) evidence.complete = false;
        else if (valid(value)) evidence.versions.push(value);
      }
      const ranges = asArray(affected?.ranges);
      // A versions-only list does not establish that unlisted releases are unaffected.
      if (ranges.length === 0) evidence.complete = false;
      const hasVersionRange = ranges.some((r) => rangeTypes.has(asString(asRecord(r)?.type) ?? ""));
      for (const rawRange of ranges) {
        const range = asRecord(rawRange);
        const type = asString(range?.type);
        if (type === "GIT" && hasVersionRange) continue;
        if (range === null || type === null || !rangeTypes.has(type)) { evidence.complete = false; continue; }
        const events = asArray(range.events);
        if (events.length === 0) evidence.complete = false;
        // OSVの仕様では範囲内のeventsの並び順は保証されず、評価時に版の順に並べる(実データ: PYSECの
        // `introduced 2.0.0 → fixed 2.0.6, introduced 0 → fixed 1.26.17`)。仕様どおり並べてから区間にする
        const parsed: { kind: string; value: string }[] = [];
        let usable = true;
        for (const rawEvent of events) {
          const event = asRecord(rawEvent);
          const keys = event ? Object.keys(event) : [];
          const kind = keys[0];
          const value = kind ? asString(event?.[kind]) : null;
          if (keys.length !== 1 || !value || !["introduced", "fixed", "last_affected", "limit"].includes(kind!)) {
            evidence.complete = false; continue;
          }
          // 解釈できない境界を含む範囲は判定に使わない
          if (!(kind === "introduced" && value === "0") && !valid(value)) { usable = false; continue; }
          // limit bounds known affected versions, but is not evidence of a fix beyond it.
          if (kind === "limit") evidence.complete = false;
          parsed.push({ kind: kind!, value });
        }
        if (!usable) { evidence.complete = false; continue; }
        // 同じ版では終点(fixed等)を始点(introduced)より前に置く(その版を影響ありとみなす安全側)
        const rank = (kind: string) => (kind === "introduced" ? 1 : 0);
        const isZero = (e: { kind: string; value: string }) => e.kind === "introduced" && e.value === "0";
        parsed.sort((a, b) => {
          // introduced: "0" はすべての版より前
          if (isZero(a) || isZero(b)) return isZero(a) === isZero(b) ? 0 : isZero(a) ? -1 : 1;
          return compare(a.value, b.value) || rank(a.kind) - rank(b.kind);
        });
        // 並べた結果が「始点 → 終点」の交互にならない(始点の重複、始点のない終点)場合は解釈が曖昧なため使わない
        const intervals: AffectedInterval[] = [];
        let start: string | null = null;
        for (const { kind, value } of parsed) {
          if (kind === "introduced") {
            if (start !== null) { usable = false; break; }
            start = value;
          } else {
            if (start === null) { usable = false; break; }
            intervals.push({ introduced: start, end: value, inclusive: kind === "last_affected" });
            start = null;
          }
        }
        if (!usable || parsed.every((e) => e.kind !== "introduced")) { evidence.complete = false; continue; }
        evidence.intervals.push(...intervals);
        if (start !== null) evidence.intervals.push({ introduced: start, end: null, inclusive: false });
      }
    }
    if (!matched) evidence.complete = false;
  }
  if (details.length === 0) evidence.complete = false;
  return evidence;
}

export function candidateStatus(
  evidence: AffectedVersionEvidence | undefined, version: string, ecosystem: string,
): "affected" | "not_affected" | "unknown" {
  const scheme = versionSchemeFor(ecosystem);
  if (!evidence || scheme === null || !scheme.isValid(version)) return "unknown";
  const compare = scheme.compare;
  if (evidence.versions.some(v => compare(v, version) === 0) || evidence.intervals.some(r =>
    (r.introduced === "0" || compare(version, r.introduced) >= 0) &&
    (r.end === null || compare(version, r.end) < 0 ||
      (r.inclusive && compare(version, r.end) === 0)))) return "affected";
  return evidence.complete ? "not_affected" : "unknown";
}
