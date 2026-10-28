import { expect, it } from "vitest";
import { stringify } from "smol-toml";
import { analyzePoetry, type PoetryManifest } from "../../utils/poetryLock.js";
const root = (data: Record<string, unknown>): PoetryManifest[] => [{ path: "pyproject.toml", data }];
const lock = (packages: unknown[], version = "2.1") => stringify({ metadata: { "lock-version": version }, package: packages });
const packages = [{ name: "Parent_Name", version: "1.0", dependencies: { leaf: ">=1" } }, { name: "leaf", version: "1.0" }];
it.each(["dependencies", "optional-dependencies"])("does not confirm child coverage with dynamic %s", field => {
  const result = analyzePoetry(lock([
    { name: "web", version: "1", source: { type: "directory", url: "child" } },
  ]), [
    ...root({ tool: { poetry: { dependencies: { web: { path: "child" } } } } }),
    { path: "child/pyproject.toml", data: { project: { name: "web", version: "1", dynamic: [field] } } },
  ]);
  expect(result.workspaces?.get("child")).toBeNull();
});
it("follows unconditional dependencies of optional roots but not conditional or optional edges", () => {
  const result = analyzePoetry(lock([
    { name: "parent", version: "1", optional: true, dependencies: { leaf: "1", conditional: { version: "1", markers: "sys_platform == 'win32'" }, extra: { version: "1", optional: true } } },
    { name: "leaf", version: "1", optional: true, dependencies: { deep: "1" } },
    ...["deep", "conditional", "extra"].map(name => ({ name, version: "1", optional: true })),
  ]), root({ project: { "optional-dependencies": { docs: ["parent==1"] } } }));
  expect(result.relations?.("parent", "1")).toMatchObject({ relation: "direct", declaredIn: new Set(["pyproject.toml"]) });
  for (const name of ["leaf", "deep"]) expect(result.relations?.(name, "1")).toMatchObject({ relation: "transitive", introducedBy: new Set(["parent"]) });
  for (const name of ["conditional", "extra"]) expect(result.relations?.(name, "1").relation).toBe("unknown");
});
it("retains known root declarations with dynamic dependencies and accepts unrelated dynamic child metadata", () => {
  const result = analyzePoetry(lock([...packages,
    { name: "web", version: "1", source: { type: "directory", url: "child" } },
  ]), [
    ...root({ project: { dynamic: ["dependencies"] }, tool: { poetry: { dependencies: { "parent-name": "^1", web: { path: "child" } } } } }),
    { path: "child/pyproject.toml", data: { project: { name: "web", version: "1", dynamic: ["description"] } } },
  ]);
  expect(result.workspaces?.get("child")).toBe(true);
  expect(result.relations?.("parent-name", "1.0").relation).toBe("direct");
  expect(result.relations?.("leaf", "1.0")).toMatchObject({ relation: "transitive", introducedBy: new Set(["parent-name"]) });
});
it.each(["1.1", "2.0", "2.1"])("handles Poetry lock %s and PEP 503/440 identities", version => {
  const result = analyzePoetry(lock(packages, version), root({ tool: { poetry: { dependencies: { "parent-name": "^1" } } } }));
  expect(result.relations?.("parent.name", "1.0.0")).toMatchObject({ relation: "direct", declaredIn: new Set(["pyproject.toml"]) });
  expect(result.relations?.("leaf", "1.0")).toMatchObject({ relation: "transitive", introducedBy: new Set(["parent-name"]) });
});
it("includes modern optional and dependency groups plus legacy development groups", () => {
  const names = ["runtime", "extra", "test", "lint", "old", "pep735"];
  const result = analyzePoetry(lock(names.map(name => ({ name, version: "1" }))), root({
    project: { dependencies: ["runtime[x]>=1; python_version >= '3.11'"], "optional-dependencies": { extra: ["extra==1"] } },
    tool: { poetry: { "dev-dependencies": { old: "*" }, group: { test: { dependencies: { test: "*" } }, lint: { dependencies: { lint: "*" } } } } },
    "dependency-groups": { dev: ["pep735", { "include-group": "test" }] },
  }));
  for (const name of names) expect(result.relations?.(name, "1").relation).toBe("direct");
});
it("keeps duplicate identities, conditional edges and nonregistry sources unresolved", () => {
  const result = analyzePoetry(lock([...packages, { name: "leaf", version: "2" },
    { name: "git-package", version: "1", source: { type: "git", url: "https://example.test/private" } },
    { name: "conditional", version: "1", dependencies: { target: { version: "*", markers: "sys_platform == 'win32'" } } }, { name: "target", version: "1" },
  ]), root({ project: { dependencies: ["parent-name", "git-package", "conditional"] } }));
  for (const [name, version] of [["leaf", "1.0"], ["git-package", "1"], ["target", "1"]]) expect(result.relations?.(name!, version!).relation).toBe("unknown");
});
it("requires exact local source path, identity and exported child dependencies", () => {
  const source = lock([{ name: "web", version: "1", source: { type: "directory", url: "apps/日本語 app" }, dependencies: { leaf: "1" } }, { name: "leaf", version: "1" }]);
  const manifests = [...root({ tool: { poetry: { dependencies: { web: { path: "apps/日本語 app" } } } } }), { path: "apps/日本語 app/pyproject.toml", data: { project: { name: "web", version: "1", dependencies: ["leaf==1"] } } }];
  expect(analyzePoetry(source, manifests).workspaces?.get("apps/日本語 app")).toBe(true);
  expect(analyzePoetry(source, [...manifests, { path: "other/pyproject.toml", data: manifests[1]!.data }]).workspaces?.get("other")).toBe(false);
  for (const data of [null, { project: { name: "wrong", version: "1" } }, { project: { name: "web", version: "2" } }, { project: { name: "web", version: "1", dependencies: ["unlocked"] } }, { project: { name: "web", version: "1", dependencies: ["leaf==2"] } }, { project: { name: "web", version: "1", dependencies: ["leaf @ https://example.test/fork.whl"] } }]) {
    expect(analyzePoetry(source, [manifests[0]!, { path: manifests[1]!.path, data }]).workspaces?.get("apps/日本語 app")).toBeNull();
  }
  expect(analyzePoetry(source, [...root({ tool: { poetry: { dependencies: { web: { path: "wrong" } } } } }), manifests[1]!]).workspaces?.get("apps/日本語 app")).toBeNull();
});
it("preserves coverage when relationship budget is exhausted", () => {
  const result = analyzePoetry(lock(packages), root({ project: { dependencies: ["parent-name"] } }), undefined, { remaining: 0 });
  expect(result.workspaces).toBeInstanceOf(Map); expect(result.relations).toBeNull();
});
it.each(["", "[metadata]\nlock-version='99'", "x=" + "[".repeat(130) + "0" + "]".repeat(130), "__proto__.x=1"])("fails closed on unsupported or malformed TOML", source => {
  expect(analyzePoetry(source, []).relations).toBeNull();
  expect(analyzePoetry(source, []).workspaces).toBeNull();
});
