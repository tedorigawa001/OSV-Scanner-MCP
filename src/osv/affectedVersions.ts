import { asArray, asRecord, asString } from "../utils/unknownJson.js";
import { versionRangeTypes, versionSchemeFor } from "./versionScheme.js";

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
      if (asString(pkg?.name) !== name || asString(pkg?.ecosystem) !== ecosystem) {
        if (!asString(pkg?.name) || !asString(pkg?.ecosystem)) evidence.complete = false;
        continue;
      }
      matched = true;
      if (affected?.versions !== undefined && !Array.isArray(affected.versions)) evidence.complete = false;
      for (const version of asArray(affected?.versions)) {
        const value = asString(version);
        if (!value || !valid(value)) evidence.complete = false;
        else evidence.versions.push(value);
      }
      const ranges = asArray(affected?.ranges);
      // A versions-only list does not establish that unlisted releases are unaffected.
      if (ranges.length === 0) evidence.complete = false;
      for (const rawRange of ranges) {
        const range = asRecord(rawRange);
        const type = asString(range?.type);
        if (range === null || type === null || !rangeTypes.has(type)) { evidence.complete = false; continue; }
        const events = asArray(range.events);
        let start: string | null = null;
        let previousEnd: string | null = null;
        let previousInclusive = false;
        /** この区間の境界に解釈できない版がある(区間を判定に使わない) */
        let startInvalid = false;
        if (events.length === 0) evidence.complete = false;
        for (const rawEvent of events) {
          const event = asRecord(rawEvent);
          const keys = event ? Object.keys(event) : [];
          const kind = keys[0];
          const value = kind ? asString(event?.[kind]) : null;
          if (keys.length !== 1 || !value || !["introduced", "fixed", "last_affected", "limit"].includes(kind!)) {
            evidence.complete = false; continue;
          }
          const invalid = !(kind === "introduced" && value === "0") && !valid(value);
          if (invalid) evidence.complete = false;
          if (kind === "introduced") {
            if (start !== null || (!invalid && previousEnd !== null && (value === "0" ||
              compare(value, previousEnd) < 0 ||
              (previousInclusive && compare(value, previousEnd) === 0)))) evidence.complete = false;
            start = value;
            startInvalid = invalid;
          } else {
            if (start === null) { evidence.complete = false; continue; }
            const inclusive = kind === "last_affected";
            if (!invalid && !startInvalid && start !== "0" && (compare(start, value) > 0 ||
              (!inclusive && compare(start, value) === 0))) evidence.complete = false;
            if (!invalid && !startInvalid) evidence.intervals.push({ introduced: start, end: value, inclusive });
            // limit bounds known affected versions, but is not evidence of a fix beyond it.
            if (kind === "limit") evidence.complete = false;
            previousEnd = invalid ? null : value;
            previousInclusive = inclusive;
            start = null;
          }
        }
        if (start !== null && !startInvalid) evidence.intervals.push({ introduced: start, end: null, inclusive: false });
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
