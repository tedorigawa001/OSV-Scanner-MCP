import { describe, expect, it } from "vitest";
import { cargoLockRelations } from "../../utils/dependencyRelations.js";
import type { CargoPackage } from "../../utils/cargoLock.js";

const registry = "registry+https://github.com/rust-lang/crates.io-index";
const git = "git+https://example.com/fork#abc";
const p = (name: string, dependencies: string[] = [], source: string | null = registry, version = "1.0.0"): CargoPackage =>
  ({ name, version, source, dependencies });

describe("cargoLockRelations", () => {
  it.each(["a", "a 1.0.0", `a 1.0.0 (${registry})`])("resolves %s and records direct/transitive dependencies", (ref) => {
    const lookup = cargoLockRelations([p("app", [ref], null), p("a", ["b"]), p("b")], new Map([["app", "Cargo.toml"]]))!;
    expect(lookup("a", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["Cargo.toml"]) });
    expect(lookup("b", "1.0.0")).toEqual({ relation: "transitive", introducedBy: new Set(["a"]) });
  });
  it("does not guess ambiguous names or sources, or normalize hyphens", () => {
    const lookup = cargoLockRelations([p("app", ["a", "b 1.0.0", "some_lib"], null),
      p("a"), p("a", [], registry, "2.0.0"), p("b"), p("b", [], git), p("some-lib")])!;
    for (const name of ["a", "b", "some-lib"]) expect(lookup(name, "1.0.0").relation).toBe("unknown");
  });
  it("traverses git origins without confusing a same-version fork", () => {
    const lookup = cargoLockRelations([p("app", [`a 1.0.0 (${git})`], null), p("a", ["b"], git), p("a"), p("b")])!;
    expect(lookup("a", "1.0.0").relation).toBe("unknown");
    expect(lookup("b", "1.0.0")).toEqual({ relation: "transitive", introducedBy: new Set(["a"]) });
  });
  it("follows replacement path packages and stops cycles", () => {
    const old = { ...p("a"), replace: "a 1.0.0" };
    old.replace = `a 1.0.0 (${git})`;
    const lookup = cargoLockRelations([p("app", [`a 1.0.0 (${registry})`], null), old,
      p("a", ["b"], git), p("b", ["c"]), p("c", ["b"]), p("local", ["c"], null)])!;
    expect(lookup("a", "1.0.0").relation).toBe("unknown");
    expect(lookup("b", "1.0.0").introducedBy).toEqual(new Set(["a", "c"]));
    expect(lookup("c", "1.0.0").relation).toBe("direct");
  });
  it("keeps direct priority when also transitive and omits partially mapped declarations", () => {
    const lookup = cargoLockRelations([p("app", ["a", "b"], null), p("other", ["b"], null),
      p("a", ["b"]), p("b")], new Map([["app", "Cargo.toml"]]))!;
    expect(lookup("b", "1.0.0")).toEqual({ relation: "direct", introducedBy: new Set(["a"]), declaringCrates: new Set(["app", "other"]) });
  });
  it("bounds dependency traversals, including replacement cycles", () => {
    expect(cargoLockRelations([p("app", ["a"], null), p("a", ["b"]), p("b")], new Map(), 1)).toBeNull();
    const lookup = cargoLockRelations([p("app", ["a"], null), { ...p("a"), replace: "b 1.0.0" },
      { ...p("b"), replace: "a 1.0.0" }])!;
    expect(lookup("a", "1.0.0").relation).toBe("unknown");
  });
});

describe("cargoLockRelations: ローカルのcrate(レビュー指摘)", () => {
  it("回帰: pathの依存のローカルcrateはintroduced_byに含めない(その依存は直接依存)", () => {
    const lookup = cargoLockRelations([p("app", ["mylib", "serde"], null), p("mylib", ["serde", "tokio"], null), p("serde"), p("tokio", ["mio"]), p("mio")],
      new Map([["app", "Cargo.toml"], ["mylib", "mylib/Cargo.toml"]]))!;
    expect(lookup("serde", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["Cargo.toml", "mylib/Cargo.toml"]) });
    expect(lookup("tokio", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["mylib/Cargo.toml"]) });
    expect(lookup("mio", "1.0.0")).toEqual({ relation: "transitive", introducedBy: new Set(["tokio"]) });
  });
});
