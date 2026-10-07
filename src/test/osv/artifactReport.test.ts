import { describe, expect, it } from "vitest";
import { buildArtifactReport, isInferredCoordinate } from "../../osv/artifactReport.js";

const pkg = (vulnerable = false) => ({
  package: { name: "org.example:a", version: "1.0", ecosystem: "Maven" },
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
    { packages: [{ package: { name: "org.example:a", version: "unknown", ecosystem: "Maven" } }] },
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

describe("推測された座標(B3の実物の検証で判明)", () => {
  const coord = (name: string, version: string, vulnerable = false) => ({
    package: { name, version, ecosystem: "Maven" },
    ...(vulnerable ? { groups: [{ ids: [`GHSA-${name}`], max_severity: "7.5" }] } : {}),
  });

  it.each([
    ["spring-beans:spring-beans", true],
    ["jar:grpc-netty-shaded", true],
    ["all:opentelemetry-api", true],
    ["armeria:armeria-brave", true],
    ["commons-io:commons-io", true], // 古い形式の正しい座標も含む(安全側)
    ["org.springframework:spring-beans", false],
    ["io.netty:netty-codec", false],
  ])("groupIdに.がない座標を推測とみなす: %s → %s", (name, expected) => {
    expect(isInferredCoordinate(name)).toBe(expected);
  });

  it("推測の座標を一覧と警告で示し、パッケージに印を付ける(実物のzipkin-server 2.23.2の形)", () => {
    const report = buildArtifactReport({ results: [result("/zipkin.jar", [
      coord("org.apache.logging.log4j:log4j-core", "2.13.3", true),
      coord("spring-beans:spring-beans", "5.3.2"),
      coord("armeria:armeria", "1.3.0", true),
    ])] }, ["/zipkin.jar"]);
    const inferred = report.coverage.inferred_coordinates!;
    expect(inferred.count).toBe(2);
    expect(inferred.items).toEqual([{ name: "armeria:armeria", version: "1.3.0" }, { name: "spring-beans:spring-beans", version: "5.3.2" }]);
    expect(inferred.warning).toContain("spring-beans:spring-beans");
    const byName = Object.fromEntries(report.packages.map((p) => [p.name, "coordinates_inferred" in p]));
    expect(byName).toEqual({ "org.apache.logging.log4j:log4j-core": false, "armeria:armeria": true });
    expect(report.artifacts[0]!.status).toBe("identified_with_vulnerabilities");
  });

  it("回帰: 推測の座標だけで同定したアーカイブは「同定済み・既知の脆弱性なし」にせず、同定数に数えない(grpc-netty-shaded 1.84.1・avatica)", () => {
    const report = buildArtifactReport({ results: [
      result("/grpc-netty-shaded.jar", [coord("jar:grpc-netty-shaded", "1.84.1")]),
      result("/ok.jar", [coord("org.example:a", "1.0")]),
    ] }, ["/grpc-netty-shaded.jar", "/ok.jar"]);
    expect(report.artifacts.map((a) => a.status)).toEqual(["inferred_only", "identified_without_known_vulnerabilities"]);
    expect(report.coverage.jars_identified).toBe(1);
    expect(report.coverage.unidentified_jars).toEqual([{ path: "/grpc-netty-shaded.jar", hint: expect.stringContaining("inferred coordinates") }]);
  });

  it("回帰: 推測の座標だけのアーカイブは、脆弱性が見つかってもinferred_onlyのまま同定数に数えず、件数は示す", () => {
    const report = buildArtifactReport({ results: [
      result("/old-shaded.jar", [coord("jar:grpc-netty-shaded", "1.30.0", true)]),
    ] }, ["/old-shaded.jar"]);
    expect(report.artifacts[0]).toMatchObject({ status: "inferred_only", identified_vulnerability_count: 1 });
    expect(report.coverage.jars_identified).toBe(0);
    expect(report.coverage.unidentified_jars[0]!.hint).toContain("inferred coordinates");
    expect(report.identified_vulnerability_count).toBe(1);
  });

  it("推測の座標がなければ一覧を出さない(既存の応答を変えない)", () => {
    const report = buildArtifactReport({ results: [result("/ok.jar", [coord("org.example:a", "1.0")])] }, ["/ok.jar"]);
    expect("inferred_coordinates" in report.coverage).toBe(false);
  });
});
