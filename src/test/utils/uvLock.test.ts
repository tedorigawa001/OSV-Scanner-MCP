import { describe, expect, it } from "vitest";
import { stringify } from "smol-toml";
import { parseUvLock, uvWorkspaceIndex, uvLockRelations } from "../../utils/uvLock.js";
const registry = (name: string, dependencies: object[] = [], version = "1.0.0", url = "https://pypi.org/simple") => ({ name, version, source: { registry: url }, dependencies });
const local = (name: string, location: string, dependencies: object[] = []) => ({ name, version: "0.1.0", source: { virtual: location }, dependencies });
const base = () => ({ version: 1, revision: 5, manifest: { members: ["app", "web"] }, package: [
  local("app", ".", [{ name: "parent" }]), local("web", "apps/日本語 app", [{ name: "leaf" }]),
  registry("parent", [{ name: "leaf" }]), registry("leaf"), registry("unused"),
] });
describe("uv lockfile origins and membership", () => {
  it("parses real TOML structures and preserves direct precedence with origins", () => {
    const data = parseUvLock(stringify(base()))!, membership = uvWorkspaceIndex(data)!;
    expect(membership).toEqual(new Map([[".", true], ["apps/日本語 app", true]]));
    const lookup = uvLockRelations(data, membership)!;
    expect(lookup("parent", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["pyproject.toml"]) });
    expect(lookup("Leaf", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["apps/日本語 app/pyproject.toml"]), introducedBy: new Set(["parent"]) });
    expect(lookup("unused", "1.0.0").relation).toBe("unknown");
  });
  it("requires manifest membership, not merely a local dependency path", () => {
    const data = { ...base(), package: [...base().package, local("independent", "other/project")] };
    // Locked but not a member (for example a path dependency): unconfirmed, not missing (review, 2026-10-28)
    expect(uvWorkspaceIndex(data)?.get("other/project")).toBeNull();
    expect(uvWorkspaceIndex(data)?.has("absent/project")).toBe(false);
    const { manifest, ...single } = data;
    expect(uvWorkspaceIndex(single)?.get("other/project")).toBeNull();
    expect(uvWorkspaceIndex(single)?.get(".")).toBe(true);
  });
  it("omits ambiguous local names/paths and rejects duplicate normalized member names", () => {
    const data = { ...base(), package: [...base().package, local("web", "other/path")] };
    expect(uvWorkspaceIndex(data)?.get("apps/日本語 app")).toBeNull();
    expect(uvWorkspaceIndex({ ...data, manifest: { members: ["Foo_Bar", "foo-bar"] } })).toBeNull();
  });
  it("handles dependency groups and all project optional declarations as direct roots", () => {
    const root = { ...local("app", "."), "optional-dependencies": { extra: [{ name: "one" }] }, "dev-dependencies": { test: [{ name: "two" }] } };
    const data = { version: 1, package: [root, registry("one"), registry("two")] };
    const lookup = uvLockRelations(data, uvWorkspaceIndex(data))!;
    for (const name of ["one", "two"]) expect(lookup(name, "1.0.0").declaredIn).toEqual(new Set(["pyproject.toml"]));
  });
  it("follows optional dependency edges only when their extra was requested", () => {
    const parent = { ...registry("parent"), "optional-dependencies": { socks: [{ name: "leaf" }] } };
    const data = { package: [local("app", ".", [{ name: "parent" }, { name: "other" }]), parent, registry("other", [{ name: "leaf" }]), registry("leaf")] };
    let lookup = uvLockRelations(data, uvWorkspaceIndex(data))!;
    expect(lookup("leaf", "1.0.0").introducedBy).toEqual(new Set(["other"]));
    data.package[0] = local("app", ".", [{ name: "parent", extra: ["socks"] }, { name: "other" }]);
    lookup = uvLockRelations(data, uvWorkspaceIndex(data))!;
    expect(lookup("leaf", "1.0.0").introducedBy).toEqual(new Set(["parent", "other"]));
  });
  it("selects only uniquely resolved version/source identities", () => {
    const root = local("app", ".", [{ name: "parent" }]);
    const data = { package: [root, registry("parent", [{ name: "leaf", version: "1.0", source: { registry: "https://pypi.org/simple" } }]), registry("leaf"), registry("leaf", [], "2.0.0"), registry("leaf", [], "1.0.0", "https://private.test/simple")] };
    const lookup = uvLockRelations(data, uvWorkspaceIndex(data))!;
    expect(lookup("leaf", "1.0.0").introducedBy).toEqual(new Set(["parent"]));
    expect(lookup("leaf", "2.0.0").relation).toBe("unknown");
    data.package[1] = registry("parent", [{ name: "leaf" }]);
    expect(uvLockRelations(data, uvWorkspaceIndex(data))!("leaf", "1.0.0").relation).toBe("unknown");
  });
  it("does not join different marker branches into an invented origin", () => {
    const data = { package: [local("app", ".", [{ name: "parent", marker: "sys_platform == 'linux'" }]),
      registry("parent", [{ name: "leaf", marker: "sys_platform == 'win32'" }]), registry("leaf")] };
    expect(uvLockRelations(data, uvWorkspaceIndex(data))!("leaf", "1.0.0").relation).toBe("unknown");
  });
  it("terminates cycles and does not introduce an origin through itself", () => {
    const data = { package: [local("app", ".", [{ name: "parent" }]), registry("parent", [{ name: "leaf" }]), registry("leaf", [{ name: "parent" }])] };
    const lookup = uvLockRelations(data, uvWorkspaceIndex(data))!;
    expect(lookup("parent", "1.0.0").introducedBy).toBeUndefined();
    expect(lookup("leaf", "1.0.0").introducedBy).toEqual(new Set(["parent"]));
  });
  it("traverses captured local nodes without treating their names as registry releases", () => {
    const dependency = { ...local("internal", "lib/internal", [{ name: "leaf" }]), source: { directory: "lib/internal" } };
    const data = { manifest: { members: ["app"] }, package: [local("app", ".", [{ name: "internal" }]), dependency, registry("leaf")] };
    const lookup = uvLockRelations(data, uvWorkspaceIndex(data))!;
    expect(lookup("internal", "0.1.0").relation).toBe("unknown");
    expect(lookup("leaf", "1.0.0").introducedBy).toEqual(new Set(["internal"]));
  });
  it("keeps relationship limits independent of membership", () => {
    const data = base(), members = uvWorkspaceIndex(data);
    expect(uvLockRelations(data, members, { remaining: 1 })).toBeNull();
    expect(members?.get("apps/日本語 app")).toBe(true);
  });
  it.each(['version=2', 'version=1\nrevision=99', 'version=1\nversion=1', 'version=1\nx=[1 # no closing array', 'version=1\nx=' + '['.repeat(129) + ']'.repeat(129)])("rejects invalid, duplicate, unknown or deep TOML: %s", source => {
    expect(parseUvLock(source)).toBeNull();
  });
  it("回帰: 構造記号の上限はファイルの大きさに比例し、16MiB未満の密なlockfileを拒否しない(レビュー、2026-10-28)", () => {
    expect(parseUvLock(`version=1\nx=[${"1,".repeat(1_000_001)}]\npackage=[]`)).not.toBeNull();
  });
  it("回帰: 複数のメンバーが宣言する同じ依存は1回だけたどり、関係の予算を使い切らない(レビュー、2026-10-28)", () => {
    const names = Array.from({ length: 5 }, (_, i) => `m${i}`), shared = Array.from({ length: 30 }, (_, k) => ({ name: `p${k}` }));
    const data = { version: 1, manifest: { members: names }, package: [
      ...names.map((name, i) => ({ ...local(name, i === 0 ? "." : `packages/${name}`, shared) })),
      ...Array.from({ length: 2_000 }, (_, i) => registry(`p${i}`, Array.from({ length: 5 }, (_, k) => ({ name: `p${(i + k + 1) % 2_000}` })))),
    ] };
    const lookup = uvLockRelations(data, uvWorkspaceIndex(data))!;
    expect(lookup("p0", "1.0.0").declaredIn).toEqual(new Set(["pyproject.toml", ...names.slice(1).map(n => `packages/${n}/pyproject.toml`)]));
    expect(lookup("p100", "1.0.0").relation).toBe("transitive");
  });
  it("does not mistake quoted/commented structure for nested TOML", () => {
    expect(parseUvLock('version=1\n# [ { comment\ntext="""[[[\n# not a comment inside a string\n"""\npackage=[]')).not.toBeNull();
  });
});
