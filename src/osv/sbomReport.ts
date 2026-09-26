import { ScanToolError } from "../errors.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import type { SbomInput } from "../utils/sbomInput.js";
import { asRecord, asString } from "../utils/unknownJson.js";
import { parseOsvScanOutput } from "./scanReport.js";

export function buildSbomReport(raw: unknown, input: SbomInput, snapshotPath: string) {
  const results = asRecord(raw)?.results;
  if (!Array.isArray(results)) throw new ScanToolError("invalid_output", "SBOM scan output is missing its results array");
  const identified = new Set<string>();
  const unidentified = new Map<string, { name: string | null; version: string | null; ecosystem: string | null }>();
  const scannable: unknown[] = [];
  for (const value of results) {
    const result = asRecord(value);
    const source = asRecord(result?.source);
    if (source?.path !== snapshotPath || source.type !== "sbom" || !Array.isArray(result?.packages)) {
      throw new ScanToolError("invalid_output", "SBOM scan output contains an unexpected source or package list");
    }
    for (const item of result.packages) {
      const pkg = asRecord(asRecord(item)?.package);
      if (pkg === null) throw new ScanToolError("invalid_output", "SBOM scanner returned a malformed package");
      const name = asString(pkg?.name);
      const version = asString(pkg?.version);
      const ecosystem = asString(pkg?.ecosystem);
      if (!name?.trim() || !version?.trim() || !ecosystem?.trim() ||
          [name, version, ecosystem].some((s) => s.trim().toLowerCase() === "unknown") || name === "unknown:unknown") {
        unidentified.set(JSON.stringify([ecosystem, name, version]), { name, version, ecosystem });
        continue;
      }
      identified.add(JSON.stringify([ecosystem, name, version]));
      scannable.push(item);
    }
  }
  const report = parseOsvScanOutput({ results: [{ packages: scannable }] });
  return {
    coverage: {
      identified_package_count: identified.size,
      unidentified_packages: [...unidentified.values()],
      status: identified.size === 0 ? "no_packages_identified" : "packages_identified",
      completeness: "not_verified",
      artifact_match: "not_verified",
      warning: "Only packages identified from this SBOM are checked. Missing, unsupported or unversioned identifiers can be skipped. SBOM completeness, freshness and correspondence to the actual build are not verified. Zero findings does not establish safety.",
    },
    sbom: {
      path: sanitizeExternalText(input.sourcePath),
      format: input.format,
      spec_version: input.specVersion,
      sha256: input.sha256,
    },
    identified_vulnerability_count: report.vulnerability_count,
    identified_vulnerable_package_count: report.vulnerable_package_count,
    severity_breakdown: report.severity_breakdown,
    packages: report.packages,
  };
}
