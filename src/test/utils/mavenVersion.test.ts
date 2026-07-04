import { describe, expect, it } from "vitest";
import { compareMavenVersions, mavenVersionSeries } from "../../utils/mavenVersion.js";

function expectEqual(a: string, b: string): void {
  expect(compareMavenVersions(a, b), `${a} == ${b}`).toBe(0);
  expect(compareMavenVersions(b, a), `${b} == ${a}`).toBe(0);
}

function expectLess(a: string, b: string): void {
  expect(compareMavenVersions(a, b), `${a} < ${b}`).toBeLessThan(0);
  expect(compareMavenVersions(b, a), `${b} > ${a}`).toBeGreaterThan(0);
}

/** 配列内のすべてのペア(i < j)について versions[i] < versions[j] を検証する。 */
function expectStrictOrder(versions: string[]): void {
  for (let i = 0; i < versions.length; i++) {
    expectEqual(versions[i]!, versions[i]!);
    for (let j = i + 1; j < versions.length; j++) {
      expectLess(versions[i]!, versions[j]!);
    }
  }
}

// Maven本家 ComparableVersionTest のテストコーパス
describe("compareMavenVersions (Maven本家テストコーパス)", () => {
  it("修飾子付きバージョンの全順序", () => {
    expectStrictOrder([
      "1-alpha2snapshot",
      "1-alpha2",
      "1-alpha-123",
      "1-beta-2",
      "1-beta123",
      "1-m2",
      "1-m11",
      "1-rc",
      "1-cr2",
      "1-rc123",
      "1-SNAPSHOT",
      "1",
      "1-sp",
      "1-sp2",
      "1-sp123",
      "1-abc",
      "1-def",
      "1-pom-1",
      "1-1-snapshot",
      "1-1",
      "1-2",
      "1-123",
    ]);
  });

  it("数値バージョンの全順序", () => {
    expectStrictOrder([
      "2.0",
      "2-1",
      "2.0.a",
      "2.0.0.a",
      "2.0.2",
      "2.0.123",
      "2.1.0",
      "2.1-a",
      "2.1b",
      "2.1-c",
      "2.1-1",
      "2.1.0.1",
      "2.2",
      "2.123",
      "11.a2",
      "11.a11",
      "11.b2",
      "11.b11",
      "11.m2",
      "11.m11",
      "11",
      "11.a",
      "11b",
      "11c",
      "11m",
    ]);
  });

  it("末尾ゼロ・区切り表記ゆれの同値", () => {
    expectEqual("1", "1");
    expectEqual("1", "1.0");
    expectEqual("1", "1.0.0");
    expectEqual("1.0", "1.0.0");
    expectEqual("1", "1-0");
    expectEqual("1", "1.0-0");
    expectEqual("1.0", "1.0-0");
    // 数字と文字の境界は区切り扱い
    expectEqual("1a", "1-a");
    expectEqual("1a", "1.0-a");
    expectEqual("1a", "1.0.0-a");
    expectEqual("1.0a", "1.0-a");
    expectEqual("1.0.0a", "1.0.0-a");
    expectEqual("1x", "1-x");
    expectEqual("1x", "1.0-x");
    expectEqual("1x", "1.0.0-x");
    expectEqual("1.0x", "1.0-x");
    expectEqual("1.0.0x", "1.0.0-x");
    // 先頭・連続セパレータの空トークンはゼロとして補完される
    expectEqual(".1", "0.1");
    expectEqual("1..2", "1.0.2");
    expectEqual("-1", "0-1");
  });

  it("修飾子のエイリアスと略記の同値", () => {
    expectEqual("1ga", "1");
    expectEqual("1release", "1");
    expectEqual("1final", "1");
    expectEqual("1cr", "1rc");
    // 大文字小文字は区別しない
    expectEqual("1a1", "1-alpha-1");
    expectEqual("1b2", "1-beta-2");
    expectEqual("1m3", "1-milestone-3");
    expectEqual("1X", "1x");
    expectEqual("1A", "1a");
    expectEqual("1B", "1b");
    expectEqual("1M", "1m");
    expectEqual("1Ga", "1");
    expectEqual("1GA", "1");
    expectEqual("1RELEASE", "1");
    expectEqual("1release", "1");
    expectEqual("1RELeaSE", "1");
    expectEqual("1Final", "1");
    expectEqual("1FinaL", "1");
    expectEqual("1FINAL", "1");
    expectEqual("1Cr", "1Rc");
    expectEqual("1cR", "1rC");
    expectEqual("1m3", "1Milestone3");
    expectEqual("1m3", "1MileStone3");
    expectEqual("1m3", "1MILESTONE3");
  });

  it("基本的な大小関係", () => {
    expectLess("1", "2");
    expectLess("1.5", "2");
    expectLess("1", "2.5");
    expectLess("1.0", "1.1");
    expectLess("1.1", "1.2");
    expectLess("1.0.0", "1.1");
    expectLess("1.0.1", "1.1");
    expectLess("1.1", "1.2.0");
    expectLess("1.0-alpha-1", "1.0");
    expectLess("1.0-alpha-1", "1.0-alpha-2");
    expectLess("1.0-alpha-1", "1.0-beta-1");
    expectLess("1.0-beta-1", "1.0-SNAPSHOT");
    expectLess("1.0-SNAPSHOT", "1.0");
    expectLess("1.0-alpha-1-SNAPSHOT", "1.0-alpha-1");
    expectLess("1.0", "1.0-1");
    expectLess("1.0-1", "1.0-2");
    expectLess("1.0.0", "1.0-1");
    expectLess("2.0-1", "2.0.1");
    expectLess("2.0.1-klm", "2.0.1-lmn");
    expectLess("2.0.1", "2.0.1-xyz");
    expectLess("2.0.1", "2.0.1-123");
    expectLess("2.0.1-xyz", "2.0.1-123");
  });
});

// このプロジェクト固有の要件(docs/DESIGN_TODO.md 実機確認の実例)
describe("compareMavenVersions (OSV-Scanner-MCP要件)", () => {
  it("semverが扱えないMaven特有の接尾辞", () => {
    expectEqual("2.17.1-RELEASE", "2.17.1");
    expectEqual("2.17.1.RELEASE", "2.17.1");
    expectLess("2.17.0", "2.17.1-RELEASE");
    expectLess("2.17.1-RELEASE", "2.17.2");
  });

  it("log4j-coreの複数リリース系統(実スキャンで確認した実例)", () => {
    // 2.12系バックポート < 2.1x系メインライン < 2.25系
    expectStrictOrder(["2.12.2", "2.12.4", "2.14.1", "2.15.0", "2.16.0", "2.17.1", "2.25.3", "2.25.4"]);
  });

  it("タイムスタンプ形式の大きな数値", () => {
    expectLess("20040616", "20211215");
    expectLess("2.4.0", "20040616");
  });
});

describe("mavenVersionSeries", () => {
  it("major.minorを系統として抽出する", () => {
    expect(mavenVersionSeries("2.14.1")).toEqual({ major: 2, minor: 14 });
    expect(mavenVersionSeries("2.25.4")).toEqual({ major: 2, minor: 25 });
    expect(mavenVersionSeries("1.0-alpha-1")).toEqual({ major: 1, minor: 0 });
    expect(mavenVersionSeries("2.17.1-RELEASE")).toEqual({ major: 2, minor: 17 });
  });

  it("minor省略時は0とみなす", () => {
    expect(mavenVersionSeries("3")).toEqual({ major: 3, minor: 0 });
    expect(mavenVersionSeries("3-beta")).toEqual({ major: 3, minor: 0 });
  });

  it("数字で始まらないバージョンはnull(系統判定不能)", () => {
    expect(mavenVersionSeries("alpha")).toBeNull();
    expect(mavenVersionSeries("")).toBeNull();
  });
});
