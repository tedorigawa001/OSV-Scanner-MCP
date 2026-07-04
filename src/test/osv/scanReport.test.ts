import { describe, expect, it } from "vitest";
import { parseOsvScanOutput } from "../../osv/scanReport.js";

/**
 * docs/DESIGN_TODO.mdの実機確認(pom.xml: log4j-core 2.14.1 / commons-collections 3.2.1 /
 * jackson-databind 2.17.0)で観測した構造を縮約したフィクスチャ。
 * - log4j: 複数リリース系統のfixedが混在
 * - commons-collections: max_severityが空文字列
 * - jackson-core: 同一pom.xmlが別のresults[]エントリに分かれて出力される
 */
const fixture = {
  results: [
    {
      source: { path: "/work/demo/pom.xml", type: "lockfile" },
      packages: [
        {
          package: {
            name: "org.apache.logging.log4j:log4j-core",
            version: "2.14.1",
            ecosystem: "Maven",
          },
          groups: [
            {
              ids: ["GHSA-jfh8-c2jp-5v3q"],
              aliases: ["CVE-2021-44228", "GHSA-jfh8-c2jp-5v3q"],
              max_severity: "10.0",
            },
            {
              ids: ["GHSA-7rjr-3q55-vv33"],
              aliases: ["CVE-2021-45046", "GHSA-7rjr-3q55-vv33"],
              max_severity: "9.0",
            },
          ],
          vulnerabilities: [
            {
              id: "GHSA-jfh8-c2jp-5v3q",
              summary: "Remote code injection in Log4j",
              affected: [
                {
                  package: { name: "org.apache.logging.log4j:log4j-core", ecosystem: "Maven" },
                  ranges: [
                    {
                      type: "ECOSYSTEM",
                      events: [{ introduced: "2.13.0" }, { fixed: "2.15.0" }],
                    },
                    {
                      type: "ECOSYSTEM",
                      events: [{ introduced: "2.4" }, { fixed: "2.12.2" }],
                    },
                  ],
                },
                {
                  // 別パッケージのaffectedは無視されること
                  package: { name: "org.example:other-artifact", ecosystem: "Maven" },
                  ranges: [{ type: "ECOSYSTEM", events: [{ fixed: "99.9.9" }] }],
                },
              ],
            },
            {
              id: "GHSA-7rjr-3q55-vv33",
              summary: "Incomplete fix of CVE-2021-44228",
              affected: [
                {
                  package: { name: "org.apache.logging.log4j:log4j-core", ecosystem: "Maven" },
                  ranges: [
                    {
                      type: "ECOSYSTEM",
                      events: [{ introduced: "2.13.0" }, { fixed: "2.16.0" }],
                    },
                    {
                      type: "ECOSYSTEM",
                      events: [{ introduced: "2.0" }, { fixed: "2.12.2" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          package: {
            name: "commons-collections:commons-collections",
            version: "3.2.1",
            ecosystem: "Maven",
          },
          groups: [
            {
              ids: ["GHSA-6hgm-866r-3cjv"],
              aliases: ["CVE-2015-6420", "GHSA-6hgm-866r-3cjv"],
              max_severity: "",
            },
          ],
          vulnerabilities: [
            {
              id: "GHSA-6hgm-866r-3cjv",
              summary: "Deserialization of untrusted data",
              affected: [
                {
                  package: { name: "commons-collections:commons-collections", ecosystem: "Maven" },
                  ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "3.2.2" }] }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      // 同一pom.xmlが別のresults[]エントリに分かれるケース
      source: { path: "/work/demo/pom.xml", type: "lockfile" },
      packages: [
        {
          package: {
            name: "com.fasterxml.jackson.core:jackson-core",
            version: "2.17.0",
            ecosystem: "Maven",
          },
          groups: [
            {
              ids: ["GHSA-h46c-h94j-95f3"],
              aliases: ["CVE-2025-52999", "GHSA-h46c-h94j-95f3"],
              max_severity: "7.5",
            },
          ],
          vulnerabilities: [
            {
              id: "GHSA-h46c-h94j-95f3",
              summary: "jackson-core StackOverflowError",
              affected: [
                {
                  package: { name: "com.fasterxml.jackson.core:jackson-core", ecosystem: "Maven" },
                  ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.15.0-rc1" }] }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  experimental_config: {},
};

describe("parseOsvScanOutput", () => {
  const report = parseOsvScanOutput(fixture);

  it("複数のresults[]エントリをフラットに集約し、source_filesは重複しない", () => {
    expect(report.source_files).toEqual(["/work/demo/pom.xml"]);
    expect(report.packages.map((p) => p.name)).toContain(
      "com.fasterxml.jackson.core:jackson-core",
    );
    expect(report.vulnerable_package_count).toBe(3);
    expect(report.vulnerability_count).toBe(4);
  });

  it("groupsの1エントリを1脆弱性として扱い、代表ID/CVE/aliasesを整理する", () => {
    const log4j = report.packages.find((p) => p.name.endsWith("log4j-core"))!;
    const log4shell = log4j.vulnerabilities[0]!;
    expect(log4shell.id).toBe("GHSA-jfh8-c2jp-5v3q");
    expect(log4shell.cve).toBe("CVE-2021-44228");
    // 代表IDはaliasesから除外される
    expect(log4shell.aliases).toEqual(["CVE-2021-44228"]);
    expect(log4shell.summary).toBe("Remote code injection in Log4j");
  });

  it("max_severityをスコアと5段階ラベルに変換する", () => {
    const log4j = report.packages.find((p) => p.name.endsWith("log4j-core"))!;
    expect(log4j.vulnerabilities.map((v) => [v.severity_score, v.severity])).toEqual([
      [10.0, "critical"],
      [9.0, "critical"],
    ]);
    const jackson = report.packages.find((p) => p.name.endsWith("jackson-core"))!;
    expect(jackson.vulnerabilities[0]!.severity).toBe("high");
  });

  it("空文字のmax_severityは例外を投げずunknown扱いにする", () => {
    const commons = report.packages.find((p) => p.name.startsWith("commons-collections"))!;
    const vuln = commons.vulnerabilities[0]!;
    expect(vuln.severity_score).toBeNull();
    expect(vuln.severity).toBe("unknown");
  });

  it("fixed_versionsを対象パッケージのaffectedのみからMaven昇順で収集する", () => {
    const log4j = report.packages.find((p) => p.name.endsWith("log4j-core"))!;
    const log4shell = log4j.vulnerabilities[0]!;
    // 複数リリース系統(2.12系バックポートと2.15系)が混在し、99.9.9(別パッケージ)は含まれない
    expect(log4shell.fixed_versions).toEqual(["2.12.2", "2.15.0"]);
    // Maven優先順位規則でのソート: 2.15.0-rc1のような修飾子付きも正しく扱う
    const jackson = report.packages.find((p) => p.name.endsWith("jackson-core"))!;
    expect(jackson.vulnerabilities[0]!.fixed_versions).toEqual(["2.15.0-rc1"]);
  });

  it("パッケージは最も深刻な脆弱性を持つ順、unknownは末尾に並ぶ", () => {
    expect(report.packages.map((p) => p.name)).toEqual([
      "org.apache.logging.log4j:log4j-core", // 10.0
      "com.fasterxml.jackson.core:jackson-core", // 7.5
      "commons-collections:commons-collections", // unknown
    ]);
  });

  it("severity_breakdownが集計される", () => {
    expect(report.severity_breakdown).toEqual({
      critical: 2,
      high: 1,
      medium: 0,
      low: 0,
      unknown: 1,
    });
  });

  it("同一パッケージ・同一groupが重複して現れても二重計上しない", () => {
    const results = (fixture as { results: unknown[] }).results;
    const duplicated = parseOsvScanOutput({ results: [...results, ...results] });
    expect(duplicated.vulnerability_count).toBe(4);
    expect(duplicated.vulnerable_package_count).toBe(3);
  });
});

describe("parseOsvScanOutput (不正・欠損データへの耐性)", () => {
  it("空オブジェクトやnullでも例外を投げず空レポートを返す", () => {
    for (const input of [{}, null, undefined, [], "not json", 42, { results: "oops" }]) {
      const report = parseOsvScanOutput(input);
      expect(report.vulnerability_count).toBe(0);
      expect(report.packages).toEqual([]);
    }
  });

  it("脆弱性ゼロのパッケージはレポートに含めない", () => {
    const report = parseOsvScanOutput({
      results: [
        {
          source: { path: "/x/pom.xml" },
          packages: [
            { package: { name: "a:a", version: "1.0", ecosystem: "Maven" }, groups: [] },
          ],
        },
      ],
    });
    expect(report.vulnerable_package_count).toBe(0);
    expect(report.source_files).toEqual(["/x/pom.xml"]);
  });

  it("name/versionが欠けたパッケージや空のgroupはスキップする", () => {
    const report = parseOsvScanOutput({
      results: [
        {
          packages: [
            { package: { name: "a:a" }, groups: [{ ids: ["GHSA-x"] }] },
            { package: { version: "1.0" }, groups: [{ ids: ["GHSA-y"] }] },
            {
              package: { name: "b:b", version: "2.0", ecosystem: "Maven" },
              groups: [{ ids: [], aliases: [] }, { max_severity: "5.0" }],
            },
          ],
        },
      ],
    });
    expect(report.vulnerability_count).toBe(0);
  });

  it("巨大なsummaryは切り詰める", () => {
    const report = parseOsvScanOutput({
      results: [
        {
          packages: [
            {
              package: { name: "a:a", version: "1.0", ecosystem: "Maven" },
              groups: [{ ids: ["GHSA-x"], max_severity: "5.0" }],
              vulnerabilities: [{ id: "GHSA-x", summary: "x".repeat(2000) }],
            },
          ],
        },
      ],
    });
    const summary = report.packages[0]!.vulnerabilities[0]!.summary!;
    expect(summary.length).toBeLessThanOrEqual(501);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("非数値・範囲外のmax_severityはunknown扱いにする", () => {
    const report = parseOsvScanOutput({
      results: [
        {
          packages: [
            {
              package: { name: "a:a", version: "1.0", ecosystem: "Maven" },
              groups: [
                { ids: ["GHSA-1"], max_severity: "abc" },
                { ids: ["GHSA-2"], max_severity: "99" },
                { ids: ["GHSA-3"], max_severity: "3.1" },
                { ids: ["GHSA-4"], max_severity: "-1" },
              ],
            },
          ],
        },
      ],
    });
    const severities = report.packages[0]!.vulnerabilities.map((v) => v.severity);
    // low(3.1)が先、unknown3件は末尾
    expect(severities).toEqual(["low", "unknown", "unknown", "unknown"]);
  });

  it("オブジェクトでないgroupエントリはスキップする", () => {
    const report = parseOsvScanOutput({
      results: [
        {
          packages: [
            {
              package: { name: "a:a", version: "1.0", ecosystem: "Maven" },
              groups: ["junk", null, 42, { ids: ["GHSA-valid"], max_severity: "5.0" }],
            },
          ],
        },
      ],
    });
    expect(report.vulnerability_count).toBe(1);
    expect(report.packages[0]!.vulnerabilities[0]!.id).toBe("GHSA-valid");
  });

  it("スコア同点のパッケージは名前順、脆弱性はID順で安定ソートされる", () => {
    const report = parseOsvScanOutput({
      results: [
        {
          packages: [
            {
              package: { name: "z:z", version: "1.0", ecosystem: "Maven" },
              groups: [{ ids: ["GHSA-z"], max_severity: "5.0" }],
            },
            {
              package: { name: "a:a", version: "1.0", ecosystem: "Maven" },
              groups: [
                { ids: ["GHSA-b"], max_severity: "5.0" },
                { ids: ["GHSA-a"], max_severity: "5.0" },
              ],
            },
          ],
        },
      ],
    });
    expect(report.packages.map((p) => p.name)).toEqual(["a:a", "z:z"]);
    expect(report.packages[0]!.vulnerabilities.map((v) => v.id)).toEqual(["GHSA-a", "GHSA-b"]);
  });

  it("GHSAが無くCVEのみのグループは代表ID自体をcveとして扱う", () => {
    const report = parseOsvScanOutput({
      results: [
        {
          packages: [
            {
              package: { name: "a:a", version: "1.0", ecosystem: "Maven" },
              groups: [{ ids: ["CVE-2024-0001"], aliases: [], max_severity: "5.0" }],
            },
          ],
        },
      ],
    });
    const vuln = report.packages[0]!.vulnerabilities[0]!;
    expect(vuln.id).toBe("CVE-2024-0001");
    expect(vuln.cve).toBe("CVE-2024-0001");
    expect(vuln.aliases).toEqual([]);
  });
});
