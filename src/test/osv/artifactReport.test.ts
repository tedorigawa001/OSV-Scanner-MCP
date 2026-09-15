import { describe, expect, it } from "vitest";
import { buildArtifactReport } from "../../osv/artifactReport.js";

const pkg = (vulnerable = false) => ({
  package: { name: "g:a", version: "1.0", ecosystem: "Maven" },
  ...(vulnerable ? { groups: [{ ids: ["GHSA-test"], max_severity: "9.8" }] } : {}),
});
const result = (file: string, packages: unknown[]) => ({ source: { path: file, type: "artifact" }, packages });

describe("buildArtifactReport", () => {
  it("distinguishes all three states and places incomplete coverage first", () => {
    const report = buildArtifactReport({ results: [result("/a.jar", [pkg(true)]), result("/b.war", [pkg()])] },
      ["/a.jar", "/b.war", "/c.jar"]);
    expect(Object.keys(report)[0]).toBe("coverage");
    expect(report.coverage).toMatchObject({ jars_found: 3, jars_identified: 2, completeness: "incomplete" });
    expect(report.coverage.unidentified_jars[0]!.path).toBe("/c.jar");
    expect(report.artifacts.map((a) => a.status)).toEqual([
      "identified_with_vulnerabilities", "identified_without_known_vulnerabilities", "unidentified",
    ]);
    expect(report.identified_vulnerability_count).toBe(1);
    expect(report).not.toHaveProperty("vulnerability_count");
  });

  it.each([
    { packages: [] },
    { packages: [{ package: { name: "unknown:unknown", version: "unknown", ecosystem: "Maven" } }] },
    { packages: [{ package: { name: "g:a", version: "unknown", ecosystem: "Maven" } }] },
    { packages: [{}] },
  ])(
    "does not count missing or placeholder metadata as identified (%j)", ({ packages }) => {
      expect(buildArtifactReport({ results: [result("/a.jar", packages)] }, ["/a.jar"]).coverage.jars_identified).toBe(0);
    },
  );

  it("does not identify an unrelated source or a matching path with a different source type", () => {
    const raw = { results: [result("/other/a.jar", [pkg(true)]),
      { ...result("/a.jar", [pkg(true)]), source: { path: "/a.jar", type: "lockfile" } }] };
    const report = buildArtifactReport(raw, ["/a.jar"]);
    expect(report.coverage.jars_identified).toBe(0);
    expect(report.identified_vulnerability_count).toBe(0);
  });

  it("matches raw filenames before sanitizing display paths", () => {
    const report = buildArtifactReport({ results: [result("/a.jar", [pkg()])] }, ["/a.jar", "/a\u200b.jar"]);
    expect(report.coverage.jars_identified).toBe(1);
    expect(report.artifacts[1]!.status).toBe("unidentified");
    expect(JSON.stringify(report)).not.toContain("\u200b");
  });

  it("deduplicates shared vulnerabilities while retaining per-archive status", () => {
    const report = buildArtifactReport({ results: [result("/a.jar", [pkg(true)]), result("/b.war", [pkg(true)])] },
      ["/a.jar", "/b.war"]);
    expect(report.identified_vulnerability_count).toBe(1);
    expect(report.artifacts.every((a) => a.identified_vulnerability_count === 1)).toBe(true);
  });

  it("all unidentified is a report, malformed output is an error", () => {
    expect(buildArtifactReport({ results: [] }, ["/a.jar"]).coverage.jars_identified).toBe(0);
    expect(() => buildArtifactReport({}, ["/a.jar"])).toThrowError(expect.objectContaining({ kind: "invalid_output" }));
  });
});
