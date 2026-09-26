import { describe, expect, it } from "vitest";
import { buildSbomReport } from "../../osv/sbomReport.js";
import type { SbomInput } from "../../utils/sbomInput.js";

const input: SbomInput = {
  sourcePath: "/user/bom\u200b.json", format: "CycloneDX", specVersion: "1.5", sha256: "a".repeat(64), bytes: Buffer.alloc(0),
};
const snapshot = "/private/tmp/snapshot/input.cdx.json";
const pkg = (name: string, vulnerable = false) => ({
  package: { name, version: "1.0", ecosystem: "Maven" },
  ...(vulnerable ? { groups: [{ ids: ["GHSA-test"], max_severity: "9.8" }] } : {}),
});
const result = (packages: unknown[]) => ({ source: { path: snapshot, type: "sbom" }, packages });

describe("buildSbomReport", () => {
  it("counts all identified packages, deduplicates findings, and does not claim build correspondence", () => {
    const report = buildSbomReport({ results: [result([pkg("g:a", true), pkg("g:b"), pkg("g:a", true)])] }, input, snapshot);
    expect(Object.keys(report)[0]).toBe("coverage");
    expect(report.coverage).toMatchObject({ identified_package_count: 2, completeness: "not_verified", artifact_match: "not_verified" });
    expect(report.identified_vulnerability_count).toBe(1);
    expect(report.packages).toHaveLength(1);
    expect(report.sbom.path).toBe("/user/bom.json");
    expect(report.sbom.sha256).toBe(input.sha256);
    expect(JSON.stringify(report)).not.toContain(snapshot);
    expect(report).not.toHaveProperty("vulnerability_count");
  });

  it("distinguishes no identified packages from no known vulnerabilities", () => {
    const empty = buildSbomReport({ results: [] }, input, snapshot);
    expect(empty.coverage.status).toBe("no_packages_identified");
    expect(empty.coverage.warning).toBeTruthy();
    const known = buildSbomReport({ results: [result([pkg("g:a")])] }, input, snapshot);
    expect(known.coverage.status).toBe("packages_identified");
    expect(known.identified_vulnerability_count).toBe(0);
  });

  it.each(["", "unknown"])("reports an unscannable version (%s) without discarding other findings", (version) => {
    const raw = { results: [result([pkg("g:a", true), {
      package: { name: "org.apache.logging.log4j:log4j-core", version, ecosystem: "Maven" },
    }])] };
    const report = buildSbomReport(raw, input, snapshot);
    expect(report.coverage.identified_package_count).toBe(1);
    expect(report.coverage.unidentified_packages).toHaveLength(1);
    expect(report.identified_vulnerability_count).toBe(1);
  });

  it.each([
    { raw: {} },
    { raw: { results: [null] } },
    { raw: { results: [{ source: { path: "/other", type: "sbom" }, packages: [] }] } },
    { raw: { results: [{ source: { path: snapshot, type: "lockfile" }, packages: [] }] } },
    { raw: { results: [result([{}])] } },
  ])("rejects malformed or unrelated scanner output (%j)", ({ raw }) => {
    expect(() => buildSbomReport(raw, input, snapshot)).toThrowError(expect.objectContaining({ kind: "invalid_output" }));
  });
});
