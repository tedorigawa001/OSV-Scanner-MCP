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
    expect(candidateStatus(e, "1.1")).toBe("not_affected");
    expect(candidateStatus(e, "2")).toBe("affected");
    expect(candidateStatus(e, "2.5")).toBe("not_affected");
  });
  it("last_affectedは含む・上限なしは将来の版も含む", () => {
    expect(candidateStatus(evidence([{ introduced: "1" }, { last_affected: "2" }]), "2")).toBe("affected");
    expect(candidateStatus(evidence([{ introduced: "1" }, { last_affected: "2" }]), "2.1")).toBe("not_affected");
    expect(candidateStatus(evidence([{ introduced: "1" }]), "99")).toBe("affected");
  });
  it.each([
    [{ fixed: "1" }],
    [{ introduced: "2" }, { fixed: "1" }],
    [{ introduced: "0" }, { limit: "1" }],
    [{ introduced: "0", fixed: "1" }],
    [{ introduced: "0" }, { fixed: "1" }, { introduced: "0.5" }, { fixed: "2" }],
  ])("不正・不完全な範囲から安全を推定しない: %j", (...events) => {
    expect(candidateStatus(evidence(events), "99")).toBe("unknown");
  });
  it("versionsの明示的な影響判定はrangesと和集合にする", () => {
    expect(candidateStatus(evidence([{ introduced: "0" }, { fixed: "1" }], { versions: ["2"] }), "2")).toBe("affected");
    expect(candidateStatus(evidence([], { ranges: [], versions: ["1"] }), "2")).toBe("unknown");
  });
  it("未対応範囲・欠落したgroup詳細を安全判定に使わない", () => {
    expect(candidateStatus(evidence([], { ranges: [{ type: "GIT", events: [{ introduced: "0" }, { fixed: "abc" }] }] }), "2")).toBe("unknown");
    expect(extractAffectedVersions([{ id: "A", affected: [] }], ["A", "B"], "a:a", "Maven").complete).toBe(false);
  });
  it("他パッケージ・他ecosystemの範囲を使わない", () => {
    expect(evidence([{ introduced: "0" }, { fixed: "1" }], { package: { name: "other", ecosystem: "Maven" } }).complete).toBe(false);
    expect(evidence([{ introduced: "0" }, { fixed: "1" }], { package: { name: "a:a", ecosystem: "npm" } }).complete).toBe(false);
  });
});
