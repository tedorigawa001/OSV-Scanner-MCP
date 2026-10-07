import { describe, expect, it } from "vitest";
import { compareSemver, parseSemver } from "../../utils/semverVersion.js";

function expectStrictOrder(versions: string[]): void {
  for (let i = 0; i < versions.length; i++) {
    expect(compareSemver(versions[i]!, versions[i]!), `${versions[i]} == ${versions[i]}`).toBe(0);
    for (let j = i + 1; j < versions.length; j++) {
      expect(compareSemver(versions[i]!, versions[j]!), `${versions[i]} < ${versions[j]}`).toBeLessThan(0);
      expect(compareSemver(versions[j]!, versions[i]!), `${versions[j]} > ${versions[i]}`).toBeGreaterThan(0);
    }
  }
}

describe("compareSemver", () => {
  it("semver.org 11節の例の順序", () => {
    expectStrictOrder(["1.0.0", "2.0.0", "2.1.0", "2.1.1"]);
    expectStrictOrder([
      "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
      "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0",
    ]);
  });

  it("数値部・数値の識別子は数値として比較する", () => {
    expectStrictOrder(["0.3.8", "0.39.0", "4.17.21", "4.18.0", "10.0.0"]);
    expectStrictOrder(["1.0.0-2", "1.0.0-10", "1.0.0-a"]);
  });

  it("ビルドメタデータは比較で無視する(Goの+incompatible)", () => {
    expect(compareSemver("20.10.14+incompatible", "20.10.14")).toBe(0);
    expect(compareSemver("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  it("Goの疑似バージョンはプレリリースとして並ぶ", () => {
    expectStrictOrder([
      "0.0.0-20180925071336-cf3bd585ca2a",
      "0.0.0-20190813141303-74dc4d7220e7",
      "0.1.0",
      "1.3.1-0.20190301021747-ccb9e902956d",
      "1.3.1",
    ]);
  });

  it("先頭のvは1文字だけ受け付ける", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(parseSemver("vv1.2.3")).toBeNull();
  });

  it.each(["19.03.9", "13.0", "1", "17.06.0-ce", "1.2.3-01", "1.2.3-", "1.2.3+", "1.2.3-a..b", " 1.2.3", "1.2.3 ", ""])(
    "SemVerでない値 %j はnull", (value) => {
      // 17.06.0-ceは数値部の先頭ゼロで不正
      expect(parseSemver(value)).toBeNull();
      expect(compareSemver(value, "1.0.0")).toBeNull();
    });

  it("安全な整数を超える数値部はnull", () => {
    expect(parseSemver("99999999999999999999.0.0")).toBeNull();
  });

  it("プレリリース識別子を数値と文字列に分けて保持する", () => {
    expect(parseSemver("1.2.3-beta.11.x-y")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ["beta", 11, "x-y"] });
  });
});
