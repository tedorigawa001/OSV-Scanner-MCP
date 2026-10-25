import { describe, expect, it } from "vitest";
import { composerLockCopy } from "../../utils/composerLock.js";
import { composerRelations, composerRootRequirements, type ComposerRelationBudget } from "../../utils/composerRelations.js";

const pkg = (name: string, require: Record<string, string> = {}, extra = {}) => ({ name, version: "1.0.0", require, ...extra });
function lookup(packages: unknown[], roots = ["vendor/a"], budget?: ComposerRelationBudget) {
  const lock = composerLockCopy(JSON.stringify({ packages }));
  return composerRelations(lock.relationPackages, roots, budget);
}

describe("Composer dependency graph", () => {
  it("uses root require and require-dev, ignoring platform requirements and suggest", () => {
    expect(composerRootRequirements(JSON.stringify({ require: { php: "^8", "ext-json": "*", "vendor/a": "^1" },
      "require-dev": { "vendor/b": "^1", "vendor/a": "^1" }, suggest: { "vendor/c": "*" } }))).toEqual(["vendor/a", "vendor/b"]);
  });
  it.each(["null", "[]", '{"require":[]}', '{"require":{"vendor/a":42}}'])("does not guess roots from invalid data %s", text => expect(composerRootRequirements(text)).toBeNull());
  it("finds direct dependencies, nested transitive dependencies and orphans", () => {
    const relation = lookup([pkg("vendor/a", { "vendor/b": "^1" }), pkg("vendor/b", { "vendor/c": "^1" }), pkg("vendor/c"), pkg("vendor/orphan")])!;
    expect(relation("vendor/a", "1.0.0")).toMatchObject({ relation: "direct", declaredIn: new Set(["composer.json"]) });
    expect(relation("vendor/c", "1.0.0")).toMatchObject({ relation: "transitive", introducedBy: new Set(["vendor/a"]) });
    expect(relation("vendor/c", "1.0.0").declaredIn).toBeUndefined();
    expect(relation("vendor/orphan", "1.0.0").relation).toBe("unknown");
    expect(relation("vendor/a", "2.0.0").relation).toBe("unknown");
  });
  it("retains every direct origin and handles cycles without including the origin itself", () => {
    const relation = lookup([pkg("vendor/a", { "vendor/c": "*" }), pkg("vendor/b", { "vendor/c": "*" }),
      pkg("vendor/c", { "vendor/a": "*" })], ["vendor/a", "vendor/b"])!;
    expect(relation("vendor/c", "1.0.0").introducedBy).toEqual(new Set(["vendor/a", "vendor/b"]));
    expect(relation("vendor/a", "1.0.0")).toMatchObject({ relation: "direct", introducedBy: new Set(["vendor/b"]) });
  });
  it("ignores a dependency's require-dev, suggest, conflict and replace as graph edges", () => {
    const relation = lookup([pkg("vendor/a", {}, { "require-dev": { "vendor/b": "*" }, suggest: { "vendor/b": "*" }, conflict: { "vendor/b": "*" } }), pkg("vendor/b")])!;
    expect(relation("vendor/b", "1.0.0").relation).toBe("unknown");
  });
  it("traverses excluded local path and branch packages without forwarding their names", () => {
    const parsed = composerLockCopy(JSON.stringify({ packages: [pkg("acme/local", { "vendor/dev": "*" }, { dist: { type: "path" } }),
      pkg("vendor/dev", { "vendor/leaf": "*" }, { version: "dev-main" }), pkg("vendor/leaf")] }));
    expect(parsed.content).not.toContain("acme/local"); expect(parsed.content).not.toContain("vendor/dev");
    const relation = composerRelations(parsed.relationPackages, ["acme/local"])!;
    expect(relation("vendor/leaf", "1.0.0")).toMatchObject({ relation: "transitive", introducedBy: new Set(["acme/local"]) });
  });
  it.each(["provide", "replace"])("does not guess virtual or ambiguous %s references", field => {
    const relation = lookup([pkg("vendor/a", { "virtual/pkg": "*", "vendor/c": "*" }),
      pkg("vendor/b", {}, { [field]: { "virtual/pkg": "*", "vendor/c": "*" } }), pkg("vendor/c")])!;
    expect(relation("vendor/b", "1.0.0").relation).toBe("unknown");
    expect(relation("vendor/c", "1.0.0").relation).toBe("unknown");
  });
  it("does not choose between duplicate installed names", () => {
    const relation = lookup([pkg("vendor/a", { "vendor/b": "*" }), pkg("vendor/b"), pkg("vendor/b", {}, { version: "2.0.0" })])!;
    expect(relation("vendor/b", "1.0.0").relation).toBe("unknown");
  });
  it("invalid require metadata cannot invent descendants", () => {
    const relation = lookup([pkg("vendor/a", {}, { require: ["vendor/b"] }), pkg("vendor/b")])!;
    expect(relation("vendor/a", "1.0.0").relation).toBe("direct");
    expect(relation("vendor/b", "1.0.0").relation).toBe("unknown");
  });
  it("shares bounded work across files and returns unknown after exhaustion", () => {
    const budget = { remaining: 30 };
    const packages = [pkg("vendor/a", { "vendor/b": "*" }), pkg("vendor/b")];
    expect(lookup(packages, ["vendor/a"], budget)).not.toBeNull();
    budget.remaining = 0;
    expect(lookup(packages, ["vendor/a"], budget)).toBeNull();
  });
  it("aborts a graph with many roots sharing descendants within its bounded work budget", () => {
    const roots = Array.from({ length: 100 }, (_, i) => `vendor/root-${i}`);
    const packages = [...roots.map(name => pkg(name, { "vendor/leaf": "*" })), pkg("vendor/leaf")];
    expect(lookup(packages, roots, { remaining: 150 })).toBeNull();
    expect(lookup(packages, roots, { remaining: 2000 })!("vendor/leaf", "1.0.0").introducedBy?.size).toBe(100);
  });
});
