import { ScanToolError } from "../errors.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import { asArray, asRecord } from "../utils/unknownJson.js";
import { parseOsvScanOutput } from "./scanReport.js";

const WARNING = "Best-effort metadata identification only. Missing or removed metadata can hide dependencies, even in identified archives. Zero identified vulnerabilities does not establish safety.";
const HINT = "Metadata may be missing (shaded/minimized archive). Scan the build project's lockfile instead.";

function isIdentifiedPackage(raw: unknown): boolean {
  const info = asRecord(asRecord(raw)?.package);
  if (info?.ecosystem !== "Maven" || typeof info.name !== "string" || typeof info.version !== "string") return false;
  const parts = info.name.split(":");
  return parts.length === 2 && parts.every((part) => part.trim() !== "" && part.toLowerCase() !== "unknown") &&
    info.version.trim() !== "" && info.version.toLowerCase() !== "unknown";
}

export function buildArtifactReport(raw: unknown, artifactPaths: readonly string[]) {
  const results = asRecord(raw)?.results;
  if (!Array.isArray(results)) {
    throw new ScanToolError("invalid_output", "OSV-Scanner artifact output is missing its results array");
  }
  const byPath = new Map<string, unknown[]>();
  for (const result of results) {
    const record = asRecord(result);
    const source = asRecord(record?.source);
    // Identity comparison must precede display sanitization, which can collapse distinct names.
    const sourcePath = source?.path;
    if (source?.type !== "artifact" || typeof sourcePath !== "string" || !artifactPaths.includes(sourcePath)) continue;
    const packages = asArray(record?.packages).filter(isIdentifiedPackage);
    if (packages.length > 0) byPath.set(sourcePath, [...(byPath.get(sourcePath) ?? []), ...packages]);
  }
  const normalized = [...byPath].map(([file, packages]) => ({ source: { path: file }, packages }));
  const report = parseOsvScanOutput({ results: normalized });
  const artifacts = artifactPaths.map((file) => {
    const packages = byPath.get(file);
    const identified = packages !== undefined;
    const perFile = parseOsvScanOutput({ results: [{ packages: packages ?? [] }] });
    return {
      path: sanitizeExternalText(file),
      status: !identified ? "unidentified" : perFile.vulnerability_count > 0
        ? "identified_with_vulnerabilities" : "identified_without_known_vulnerabilities",
      identified_vulnerability_count: perFile.vulnerability_count,
    };
  });
  return {
    coverage: {
      jars_found: artifactPaths.length,
      jars_identified: byPath.size,
      unidentified_jars: artifacts.filter((item) => item.status === "unidentified")
        .map(({ path }) => ({ path, hint: HINT })),
      completeness: "incomplete" as const,
      warning: WARNING,
    },
    artifacts,
    identified_vulnerability_count: report.vulnerability_count,
    identified_vulnerable_package_count: report.vulnerable_package_count,
    severity_breakdown: report.severity_breakdown,
    packages: report.packages,
  };
}
