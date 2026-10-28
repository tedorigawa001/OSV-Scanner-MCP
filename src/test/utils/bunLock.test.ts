import { describe, expect, it } from "vitest";
import { parseBunLock, bunWorkspaceKeys, bunLockRelations } from "../../utils/bunLock.js";

const pkg = (name: string, version = "1.0.0", info = {}) => [`${name}@${version}`, "", info, "sha512-test"];
const data = (version = 2) => ({ lockfileVersion: version,
  workspaces: { "": { dependencies: { parent: "^1" } }, "apps/日本語 app": { devDependencies: { leaf: "^1" } } },
  packages: { parent: pkg("parent", "1.0.0", { dependencies: { leaf: "^1" } }), leaf: pkg("leaf"), web: ["web@workspace:apps/日本語 app"], unused: pkg("unused") },
});
describe("Bun text lockfiles", () => {
  it.each([0, 1, 2])("reads JSONC format %s, exact workspace membership and direct/transitive overlap", version => {
    const source = "// Bun lock\n" + JSON.stringify(data(version)).replace(/}$/, ",}");
    const parsed = parseBunLock(source)!;
    expect(parsed).not.toBeNull();
    expect(bunWorkspaceKeys(parsed)).toEqual(new Set(["", "apps/日本語 app"]));
    const lookup = bunLockRelations(parsed)!;
    expect(lookup("parent", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["package.json"]) });
    expect(lookup("leaf", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["apps/日本語 app/package.json"]), introducedBy: new Set(["parent"]) });
    expect(lookup("unused", "1.0.0").relation).toBe("unknown");
  });
  it("resolves nested versions and scoped aliases by package placement, not names alone", () => {
    const parsed = { lockfileVersion: 2, workspaces: { "": { dependencies: { a: "1", b: "1" } } }, packages: {
      a: pkg("a", "1.0.0", { dependencies: { leaf: "1", alias: "npm:@scope/real@1" } }),
      b: pkg("b", "1.0.0", { dependencies: { leaf: "2" } }), leaf: pkg("leaf"),
      "b/leaf": pkg("leaf", "2.0.0"), alias: pkg("@scope/real"),
    } };
    const lookup = bunLockRelations(parsed)!;
    expect(lookup("leaf", "1.0.0").introducedBy).toEqual(new Set(["a"]));
    expect(lookup("leaf", "2.0.0").introducedBy).toEqual(new Set(["b"]));
    expect(lookup("@scope/real", "1.0.0").introducedBy).toEqual(new Set(["a"]));
  });
  it("keeps scoped ancestors intact and terminates cycles", () => {
    const parsed = { workspaces: { "": { dependencies: { "@scope/parent": "1" } } }, packages: {
      "@scope/parent": pkg("@scope/parent", "1.0.0", { dependencies: { leaf: "1" } }),
      "@scope/parent/leaf": pkg("leaf", "1.0.0", { dependencies: { "@scope/parent": "1" } }),
      leaf: pkg("leaf", "2.0.0"),
    } };
    const lookup = bunLockRelations(parsed)!;
    expect(lookup("leaf", "1.0.0").introducedBy).toEqual(new Set(["@scope/parent"]));
    expect(lookup("leaf", "2.0.0").relation).toBe("unknown");
    expect(lookup("@scope/parent", "1.0.0").introducedBy).toBeUndefined();
  });
  it("uses workspace placement for conflicting versions", () => {
    const parsed = data();
    parsed.packages.leaf = pkg("leaf", "2.0.0");
    Object.assign(parsed.packages, { "web/leaf": pkg("leaf") });
    const lookup = bunLockRelations(parsed)!;
    expect(lookup("leaf", "1.0.0").declaredIn).toEqual(new Set(["apps/日本語 app/package.json"]));
    expect(lookup("leaf", "2.0.0")).toEqual({ relation: "transitive", introducedBy: new Set(["parent"]) });
  });
  it("does not cross local/Git barriers or treat workspace references as npm releases", () => {
    const parsed = { workspaces: { "": { dependencies: { parent: "1", fork: "github:org/fork", leaf: "workspace:*" } } }, packages: {
      parent: pkg("parent", "1.0.0", { dependencies: { leaf: "1" } }), "parent/leaf": ["leaf@file:../local", {}],
      leaf: pkg("leaf"), fork: ["fork@github:org/fork", {}, "tag"],
    } };
    const lookup = bunLockRelations(parsed)!;
    expect(lookup("leaf", "1.0.0").relation).toBe("unknown");
    expect(lookup("fork", "1.0.0").relation).toBe("unknown");
  });
  it("does not infer intentionally unresolved optional dependencies from another installed package", () => {
    const parsed = { workspaces: { "": { dependencies: { parent: "1" } } }, packages: {
      parent: pkg("parent", "1.0.0", { optionalDependencies: { leaf: "2" }, unresolved: ["leaf"] }), leaf: pkg("leaf"),
    } };
    expect(bunLockRelations(parsed)!("leaf", "1.0.0").relation).toBe("unknown");
  });
  it("lets optional declarations override the same regular dependency, and follows installed peers", () => {
    const parsed = { workspaces: { "": { dependencies: { parent: "1" } } }, packages: {
      parent: pkg("parent", "1.0.0", { dependencies: { leaf: "1" }, optionalDependencies: { leaf: "2" }, unresolved: ["leaf"], peerDependencies: { peer: "1" } }),
      leaf: pkg("leaf"), peer: pkg("peer"),
    } };
    const lookup = bunLockRelations(parsed)!;
    expect(lookup("leaf", "1.0.0").relation).toBe("unknown");
    expect(lookup("peer", "1.0.0").introducedBy).toEqual(new Set(["parent"]));
  });
  it.each([
    '{"lockfileVersion":2,"workspaces":{},"workspaces":{}}',
    '{"lockfileVersion":2,"workspaces":{',
    '{"lockfileVersion":99,"workspaces":{}}',
    '{"lockfileVersion":"2","workspaces":{}}',
    '{"lockfileVersion":2,"configVersion":99,"workspaces":{}}',
    "[".repeat(129) + "]".repeat(129),
  ])("rejects invalid/unsupported/duplicate/deep JSONC (%s)", source => expect(parseBunLock(source)).toBeNull());
  it("rejects ambiguous, unsafe and malformed workspace indexes", () => {
    for (const workspaces of [{ "../outside": {} }, { "apps/web": {}, "apps/./web": {} }, { "apps/web": { dependencies: [] } }]) {
      expect(bunWorkspaceKeys({ workspaces })).toBeNull();
    }
  });
  it("does not silently traverse malformed dependency metadata", () => {
    const parsed = data();
    parsed.packages.parent = pkg("parent", "1.0.0", { dependencies: [], unresolved: "leaf" });
    expect(bunLockRelations(parsed)).toBeNull();
  });
  it("never mutates the object prototype while parsing JSONC", () => {
    const parsed = parseBunLock('{"lockfileVersion":2,"__proto__":{"polluted":true},"workspaces":{},"packages":{}}')!;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("keeps relationship exhaustion separate from coverage and shares parse budgets", () => {
    const parsed = data();
    expect(bunLockRelations(parsed, { remaining: 1 })).toBeNull();
    expect(bunWorkspaceKeys(parsed)?.has("apps/日本語 app")).toBe(true);
    const budget = { remaining: 1 };
    expect(parseBunLock(JSON.stringify(parsed), budget)).toBeNull();
    expect(parseBunLock(JSON.stringify(parsed), budget)).toBeNull();
  });
});
