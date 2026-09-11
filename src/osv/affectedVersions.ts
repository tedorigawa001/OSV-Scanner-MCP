import { compareMavenVersions } from "../utils/mavenVersion.js";
import { asArray, asRecord, asString } from "../utils/unknownJson.js";

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

/** Preserve uncertainty: unsupported or malformed ranges cannot prove a candidate safe. */
export function extractAffectedVersions(
  details: Record<string, unknown>[], ids: string[], name: string, ecosystem: string,
): AffectedVersionEvidence {
  const evidence: AffectedVersionEvidence = { complete: ecosystem === "Maven", intervals: [], versions: [] };
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
        if (!value) evidence.complete = false;
        else evidence.versions.push(value);
      }
      const ranges = asArray(affected?.ranges);
      // A versions-only list does not establish that unlisted releases are unaffected.
      if (ranges.length === 0) evidence.complete = false;
      for (const rawRange of ranges) {
        const range = asRecord(rawRange);
        if (range?.type !== "ECOSYSTEM") { evidence.complete = false; continue; }
        const events = asArray(range.events);
        let start: string | null = null;
        let previousEnd: string | null = null;
        let previousInclusive = false;
        if (events.length === 0) evidence.complete = false;
        for (const rawEvent of events) {
          const event = asRecord(rawEvent);
          const keys = event ? Object.keys(event) : [];
          const kind = keys[0];
          const value = kind ? asString(event?.[kind]) : null;
          if (keys.length !== 1 || !value || !["introduced", "fixed", "last_affected", "limit"].includes(kind!)) {
            evidence.complete = false; continue;
          }
          if (kind === "introduced") {
            if (start !== null || (previousEnd !== null && (value === "0" ||
              compareMavenVersions(value, previousEnd) < 0 ||
              (previousInclusive && compareMavenVersions(value, previousEnd) === 0)))) evidence.complete = false;
            start = value;
          } else {
            if (start === null) { evidence.complete = false; continue; }
            const inclusive = kind === "last_affected";
            if (start !== "0" && (compareMavenVersions(start, value) > 0 ||
              (!inclusive && compareMavenVersions(start, value) === 0))) evidence.complete = false;
            evidence.intervals.push({ introduced: start, end: value, inclusive });
            // limit bounds known affected versions, but is not evidence of a fix beyond it.
            if (kind === "limit") evidence.complete = false;
            previousEnd = value;
            previousInclusive = inclusive;
            start = null;
          }
        }
        if (start !== null) evidence.intervals.push({ introduced: start, end: null, inclusive: false });
      }
    }
    if (!matched) evidence.complete = false;
  }
  if (details.length === 0) evidence.complete = false;
  return evidence;
}

export function candidateStatus(evidence: AffectedVersionEvidence | undefined, version: string): "affected" | "not_affected" | "unknown" {
  if (!evidence) return "unknown";
  if (evidence.versions.some(v => compareMavenVersions(v, version) === 0) || evidence.intervals.some(r =>
    (r.introduced === "0" || compareMavenVersions(version, r.introduced) >= 0) &&
    (r.end === null || compareMavenVersions(version, r.end) < 0 ||
      (r.inclusive && compareMavenVersions(version, r.end) === 0)))) return "affected";
  return evidence.complete ? "not_affected" : "unknown";
}
