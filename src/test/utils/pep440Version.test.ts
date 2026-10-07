import { describe, expect, it } from "vitest";
import { comparePep440, parsePep440 } from "../../utils/pep440Version.js";

function expectStrictOrder(versions: string[]): void {
  for (let i = 0; i < versions.length; i++) {
    expect(comparePep440(versions[i]!, versions[i]!), `${versions[i]} == ${versions[i]}`).toBe(0);
    for (let j = i + 1; j < versions.length; j++) {
      expect(comparePep440(versions[i]!, versions[j]!), `${versions[i]} < ${versions[j]}`).toBeLessThan(0);
      expect(comparePep440(versions[j]!, versions[i]!), `${versions[j]} > ${versions[i]}`).toBeGreaterThan(0);
    }
  }
}

describe("comparePep440", () => {
  // PyPA packaging tests/test_version.py の VERSIONS(昇順の一覧)より。
  // packaging は Apache-2.0 または BSD-2-Clause のデュアルライセンス(https://github.com/pypa/packaging)
  it("packagingのテストの順序(epochなし・epochあり)", () => {
    const versions = [
      "1.0.dev456", "1.0a1", "1.0a2.dev456", "1.0a12.dev456", "1.0a12",
      "1.0b1.dev456", "1.0b2", "1.0b2.post345.dev456", "1.0b2.post345",
      "1.0b2-346", "1.0c1.dev456", "1.0c1", "1.0rc2", "1.0c3", "1.0",
      "1.0.post456.dev34", "1.0.post456", "1.1.dev1", "1.2+123abc",
      "1.2+123abc456", "1.2+abc", "1.2+abc123", "1.2+abc123def", "1.2+1234.abc",
      "1.2+123456", "1.2.r32+123456", "1.2.rev33+123456",
    ];
    expectStrictOrder(versions);
    expectStrictOrder(versions.map((v) => `1!${v}`));
    expect(comparePep440("0!9.9", "1!1.0.dev456")).toBeLessThan(0);
  });

  it.each([
    ["1.0", "1.0.0"],
    ["1.0", "1"],
    ["v1.0", "1.0"],
    ["1.0-RC1", "1.0rc1"],
    ["1.0_alpha_1", "1.0a1"],
    ["1.0.beta.2", "1.0b2"],
    ["1.8c1", "1.8rc1"],
    ["2.8.0-rc0", "2.8.0rc0"],
    ["1.0pre", "1.0rc0"],
    ["1.0-1", "1.0.post1"],
    ["1.0.r", "1.0.post0"],
    ["1.0-dev", "1.0.dev0"],
    ["1.0+UBUNTU-1", "1.0+ubuntu.1"],
    [" 1.0 ", "1.0"],
  ])("正規化: %s == %s", (a, b) => {
    expect(comparePep440(a, b)).toBe(0);
  });

  it.each(["2.6.0-cu124", "2.6.0-NA", "0.9-doduo", "ciflow/periodic/317eeb8", "nightly-binary", "1.0+", "1.0+_x", "", "1.0.", "a1.0"])(
    "PEP 440でない値 %j はnull", (value) => {
      expect(parsePep440(value)).toBeNull();
      expect(comparePep440(value, "1.0")).toBeNull();
    });

  it("2^53を超える数値も丸めずに比較する", () => {
    expectStrictOrder(["1.0.post9007199254740992", "1.0.post9007199254740993"]);
  });
});
