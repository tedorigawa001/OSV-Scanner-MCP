import { describe, expect, it } from "vitest";
import { candidateStatus, extractAffectedVersions } from "../../osv/affectedVersions.js";

function evidence(events: unknown[], extra: Record<string, unknown> = {}) {
  return extractAffectedVersions([{ id: "A", affected: [{
    package: { name: "a:a", ecosystem: "Maven" },
    ranges: [{ type: "ECOSYSTEM", events }], ...extra,
  }] }], ["A"], "a:a", "Maven");
}

describe("OSV affected ranges", () => {
  it("introducedは含みfixedは含まない・再導入も判定する", () => {
    const e = evidence([{ introduced: "0" }, { fixed: "1.1" }, { introduced: "2" }, { fixed: "2.5" }]);
    expect(candidateStatus(e, "1.1", "Maven")).toBe("not_affected");
    expect(candidateStatus(e, "2", "Maven")).toBe("affected");
    expect(candidateStatus(e, "2.5", "Maven")).toBe("not_affected");
  });
  it("last_affectedは含む・上限なしは将来の版も含む", () => {
    expect(candidateStatus(evidence([{ introduced: "1" }, { last_affected: "2" }]), "2", "Maven")).toBe("affected");
    expect(candidateStatus(evidence([{ introduced: "1" }, { last_affected: "2" }]), "2.1", "Maven")).toBe("not_affected");
    expect(candidateStatus(evidence([{ introduced: "1" }]), "99", "Maven")).toBe("affected");
  });
  it.each([
    [{ fixed: "1" }],
    [{ introduced: "2" }, { fixed: "1" }],
    [{ introduced: "0" }, { limit: "1" }],
    [{ introduced: "0", fixed: "1" }],
    [{ introduced: "0" }, { fixed: "1" }, { introduced: "0.5" }, { fixed: "2" }],
  ])("不正・不完全な範囲から安全を推定しない: %j", (...events) => {
    expect(candidateStatus(evidence(events), "99", "Maven")).toBe("unknown");
  });
  it("versionsの明示的な影響判定はrangesと和集合にする", () => {
    expect(candidateStatus(evidence([{ introduced: "0" }, { fixed: "1" }], { versions: ["2"] }), "2", "Maven")).toBe("affected");
    expect(candidateStatus(evidence([], { ranges: [], versions: ["1"] }), "2", "Maven")).toBe("unknown");
  });
  it("未対応範囲・欠落したgroup詳細を安全判定に使わない", () => {
    expect(candidateStatus(evidence([], { ranges: [{ type: "GIT", events: [{ introduced: "0" }, { fixed: "abc" }] }] }), "2", "Maven")).toBe("unknown");
    expect(extractAffectedVersions([{ id: "A", affected: [] }], ["A", "B"], "a:a", "Maven").complete).toBe(false);
  });
  it("他パッケージ・他ecosystemの範囲を使わない", () => {
    expect(evidence([{ introduced: "0" }, { fixed: "1" }], { package: { name: "other", ecosystem: "Maven" } }).complete).toBe(false);
    expect(evidence([{ introduced: "0" }, { fixed: "1" }], { package: { name: "a:a", ecosystem: "npm" } }).complete).toBe(false);
  });
});

describe("OSV affected ranges: v0.6.0の規則", () => {
  function pypi(affected: Record<string, unknown>) {
    return extractAffectedVersions([{ id: "A", affected: [{ package: { name: "requests", ecosystem: "PyPI" }, ...affected }] }], ["A"], "requests", "PyPI");
  }
  it("PyPIの範囲をPEP 440で比較する(正規形でない値も正規化する)", () => {
    const e = pypi({ ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "1.7c1" }, { fixed: "1.8.0-rc0" }] }] });
    expect(e.complete).toBe(true);
    expect(candidateStatus(e, "1.7rc2", "PyPI")).toBe("affected");
    expect(candidateStatus(e, "1.8.0rc0", "PyPI")).toBe("not_affected");
    expect(candidateStatus(e, "1.6", "PyPI")).toBe("not_affected");
  });
  it("同じエントリにECOSYSTEM範囲があればGIT範囲は無視する。GIT範囲だけなら情報不足", () => {
    const both = pypi({ ranges: [
      { type: "GIT", repo: "https://github.com/psf/requests", events: [{ introduced: "0" }, { fixed: "abc123" }] },
      { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.20.0" }] },
    ] });
    expect(both.complete).toBe(true);
    expect(candidateStatus(both, "2.20.0", "PyPI")).toBe("not_affected");
    const gitOnly = pypi({ ranges: [{ type: "GIT", repo: "https://example.com/r", events: [{ introduced: "0" }, { fixed: "abc123" }] }] });
    expect(candidateStatus(gitOnly, "2.20.0", "PyPI")).toBe("unknown");
  });
  it("versions[]の解釈できない値(Gitのタグ名)は無視し、解釈できる値と先頭のvは使う", () => {
    const e = pypi({
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.20.0" }] }],
      versions: ["v2.5.2", "0.9-doduo", "ciflow/periodic/317eeb8", "nightly-binary", "2.21.0"],
    });
    expect(e.complete).toBe(true);
    expect(candidateStatus(e, "2.5.2", "PyPI")).toBe("affected");
    expect(candidateStatus(e, "2.21.0", "PyPI")).toBe("affected"); // versions[]の明示は範囲と和集合
    expect(candidateStatus(e, "2.22.0", "PyPI")).toBe("not_affected");
  });
  it("範囲の境界の解釈できない値は従来どおり情報不足(PyTorchの2.6.0-cu124)", () => {
    const e = pypi({ ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { last_affected: "2.6.0-cu124" }] }] });
    expect(e.complete).toBe(false);
    expect(candidateStatus(e, "2.7.0", "PyPI")).toBe("unknown");
  });
  it("eventsが版の順に並んでいなくても、OSVの仕様どおり並べて判定する(PYSEC-2023-192の実データ)", () => {
    const e = pypi({ ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.0.0" }, { fixed: "2.0.6" }, { introduced: "0" }, { fixed: "1.26.17" }] }] });
    expect(e.complete).toBe(true);
    expect(candidateStatus(e, "1.26.16", "PyPI")).toBe("affected");
    expect(candidateStatus(e, "1.26.17", "PyPI")).toBe("not_affected");
    expect(candidateStatus(e, "2.0.5", "PyPI")).toBe("affected");
    expect(candidateStatus(e, "2.0.6", "PyPI")).toBe("not_affected");
    // Mavenも同じ(v0.5.0以前は並び順の違いを情報不足として推奨を保留していた)
    expect(candidateStatus(evidence([{ introduced: "4.0" }, { fixed: "4.0.4" }, { introduced: "3.2" }, { fixed: "3.2.13" }]), "3.2.13", "Maven")).toBe("not_affected");
  });
  it("並べても始点と終点が交互にならない範囲は、曖昧なため情報不足", () => {
    // 始点の重複(重なった区間)と、始点より前の終点
    expect(candidateStatus(evidence([{ introduced: "0" }, { fixed: "1" }, { introduced: "0.5" }, { fixed: "2" }]), "1.5", "Maven")).toBe("unknown");
    expect(candidateStatus(evidence([{ introduced: "2" }, { fixed: "1" }]), "1.5", "Maven")).toBe("unknown");
  });
  it("同じ版の終点と始点(再導入)は、その版を影響ありとみなす", () => {
    const e = evidence([{ introduced: "0" }, { fixed: "2" }, { introduced: "2" }, { fixed: "3" }]);
    expect(candidateStatus(e, "2", "Maven")).toBe("affected");
    expect(candidateStatus(e, "3", "Maven")).toBe("not_affected");
  });
  it("npm・Goにも同じversions[]の規則を適用する", () => {
    const e = extractAffectedVersions([{ id: "A", affected: [{ package: { name: "x", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }], versions: ["v0.9.0-tag", "not-a-version"] }] }], ["A"], "x", "npm");
    expect(candidateStatus(e, "1.0.1", "npm")).toBe("not_affected");
  });
});
