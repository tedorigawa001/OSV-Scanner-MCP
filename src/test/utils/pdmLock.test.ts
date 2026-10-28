import { expect, it } from "vitest";
import { stringify } from "smol-toml";
import { analyzePdm, type PdmManifest } from "../../utils/pdmLock.js";
const lock = (packages: unknown[], metadata = {}) => stringify({ metadata: { lock_version: "4.5.1", groups: ["default"], ...metadata }, package: packages });
const root = (data: Record<string, unknown>): PdmManifest[] => [{ path: "pyproject.toml", data }];
const packages = [{ name: "Parent_Name", version: "1.0", dependencies: ["leaf>=1"] }, { name: "leaf", version: "1.0" }];
it.each(["dev-dependencies", "dependency-groups"])("supports PDM-generated editable declarations in %s", table => {
  const editable = "-e file:///${PROJECT_ROOT}/apps/%E6%97%A5%E6%9C%AC%E8%AA%9E%20app#egg=web";
  const manifests: PdmManifest[] = [
    { path: "pyproject.toml", data: {
      project: { dependencies: ["parent-name>=1"] },
      ...table === "dependency-groups" ? { "dependency-groups": { dev: [editable] } } : { tool: { pdm: { "dev-dependencies": { dev: [editable] } } } },
    } },
    { path: "apps/日本語 app/pyproject.toml", data: { project: { name: "web", version: "1", dependencies: ["child-leaf==1"] } } },
  ];
  const result = analyzePdm(lock([...packages,
    { name: "web", version: "1", editable: true, path: "./apps/日本語 app", dependencies: ["child-leaf==1"] }, { name: "child-leaf", version: "1" },
  ], { groups: ["default", "dev"] }), manifests);
  expect(result.workspaces?.get("apps/日本語 app")).toBe(true);
  expect(result.relations?.("parent-name", "1.0").relation).toBe("direct");
  expect(result.relations?.("leaf", "1.0")).toMatchObject({ relation: "transitive", introducedBy: new Set(["parent-name"]) });
  expect(result.relations?.("child-leaf", "1")).toMatchObject({ relation: "direct", declaredIn: new Set(["apps/日本語 app/pyproject.toml"]) });
  expect(result.relations?.("web", "1").relation).toBe("unknown");
});
it.each([
  "-e file:///${PROJECT_ROOT}/child", // No egg identity: do not guess from a basename.
  "-e file:///${PROJECT_ROOT}/child#egg=web&egg=other",
  "-e file:///${PROJECT_ROOT}/%ZZ#egg=web",
  "-e git+https://example.test/repo#egg=web",
  "-e file:///${PROJECT_ROOT}/../outside#egg=web",
])("retains known roots without guessing unsupported editable reference %s", editable => {
  const result = analyzePdm(lock([...packages, { name: "web", version: "1" }], { groups: ["default", "dev"] }), root({
    project: { dependencies: ["parent-name>=1"] }, "dependency-groups": { dev: [editable] },
  }));
  expect(result.relations?.("parent-name", "1.0").relation).toBe("direct");
  expect(result.relations?.("leaf", "1.0").relation).toBe("transitive");
  expect(result.relations?.("web", "1").relation).toBe("unknown");
});
it("retains known declarations without confirming a child with an unsupported runtime requirement", () => {
  const result = analyzePdm(lock([
    ...packages, { name: "web", version: "1", editable: true, path: "child", dependencies: ["parent-name>=1"] },
  ]), [
    ...root({ project: { dependencies: ["parent-name>=1"] }, tool: { pdm: { workspace: { members: ["child"] } } } }),
    { path: "child/pyproject.toml", data: { project: { name: "web", version: "1", dependencies: ["parent-name>=1", "-e ./unknown"] } } },
  ]);
  expect(result.workspaces?.get("child")).toBeNull();
  expect(result.relations?.("parent-name", "1.0")).toMatchObject({ relation: "direct", declaredIn: new Set(["pyproject.toml"]) });
});
it.each(["4.0", "4.3.0", "4.4.2", "4.5.0", "4.5.1"])("handles PDM %s and normalized names/versions", lock_version => {
  const result = analyzePdm(lock(packages, { lock_version }), root({ project: { dependencies: ["parent-name>=1"] } }));
  expect(result.relations?.("Parent.Name", "1.0.0")).toMatchObject({ relation: "direct", declaredIn: new Set(["pyproject.toml"]) });
  expect(result.relations?.("leaf", "1.0")).toMatchObject({ relation: "transitive", introducedBy: new Set(["parent-name"]) });
});
it("selects locked default, optional, PEP 735 and legacy development groups", () => {
  const nodes = ["main", "extra", "test", "lint", "old", "omitted"].map(name => ({ name, version: "1" }));
  const result = analyzePdm(lock(nodes, { groups: ["default", "docs", "dev", "legacy"] }), root({
    project: { dependencies: ["main"], "optional-dependencies": { docs: ["extra"], absent: ["omitted"] } },
    "dependency-groups": { dev: ["test", { "include-group": "lint" }], lint: ["lint"] },
    tool: { pdm: { "dev-dependencies": { legacy: ["old"] } } },
  }));
  for (const name of ["main", "extra", "test", "lint", "old"]) expect(result.relations?.(name, "1").relation).toBe("direct");
  expect(result.relations?.("omitted", "1").relation).toBe("unknown");
});
it("follows only explicitly selected extras identities and merges base/extra package origins", () => {
  const result = analyzePdm(lock([
    { name: "parent", version: "1", extras: ["docs"], dependencies: ["parent==1", "leaf>=1"] },
    { name: "parent", version: "1", dependencies: ["base"] },
    { name: "parent", version: "1", extras: ["unrequested"], dependencies: ["unrequested"] },
    ...["leaf", "base", "unrequested"].map(name => ({ name, version: "1" })),
  ]), root({ project: { dependencies: ["parent[docs]>=1"] } }));
  expect(result.relations?.("parent", "1").relation).toBe("direct");
  for (const name of ["leaf", "base"]) expect(result.relations?.(name, "1")).toMatchObject({ relation: "transitive", introducedBy: new Set(["parent"]) });
  expect(result.relations?.("unrequested", "1").relation).toBe("unknown");
});
it("does not join differing marker branches or guess duplicate identities", () => {
  const result = analyzePdm(lock([
    { name: "parent", version: "1", dependencies: ["leaf; sys_platform == 'win32'", "duplicate"] },
    { name: "leaf", version: "1" }, { name: "duplicate", version: "1" }, { name: "duplicate", version: "2" },
  ]), root({ project: { dependencies: ["parent; sys_platform == 'linux'"] } }));
  for (const name of ["leaf", "duplicate"]) expect(result.relations?.(name, "1").relation).toBe("unknown");
});
const childDir = "apps/日本語 app";
const childNode = { name: "web", version: "1", editable: true, path: `./${childDir}`, dependencies: ["leaf==1"] };
const childInput = { project: { name: "web", version: "1", dependencies: ["leaf==1"] } };
const workspace = (members: string[] = ["apps/*"]): PdmManifest[] => [...root({ project: { name: "root", version: "1" }, tool: { pdm: { workspace: { members } } } }), { path: `${childDir}/pyproject.toml`, data: childInput }];
it.each(["apps/*", "apps/**", "**/日本語 app", "./apps/日本語 app/"])("confirms exact locked local identity with workspace pattern %s", pattern => {
  const result = analyzePdm(lock([childNode, { name: "leaf", version: "1" }]), workspace([pattern]));
  expect(result.workspaces?.get(childDir)).toBe(true);
  expect(result.relations?.("leaf", "1")).toMatchObject({ relation: "direct", declaredIn: new Set([`${childDir}/pyproject.toml`]) });
});
it("distinguishes missing directories from locked but unconfirmed local packages", () => {
  expect(analyzePdm(lock([]), workspace()).workspaces?.get(childDir)).toBe(false);
  expect(analyzePdm(lock([childNode]), workspace(["other/*"])).workspaces?.get(childDir)).toBeNull();
  expect(analyzePdm(lock([childNode]), workspace(["apps/[a-z]*"])).workspaces?.get(childDir)).toBeNull();
  expect(analyzePdm(lock([childNode]), workspace()).workspaces?.get(childDir)).toBeNull(); // leaf not locked
});
it.each([
  { project: { name: "wrong", version: "1" } }, { project: { name: "web", version: "2" } },
  { project: { name: "web", version: "1", dependencies: ["leaf==2"] } },
  { project: { name: "web", version: "1", dynamic: ["dependencies"] } },
  { project: { name: "web", version: "1", dynamic: ["optional-dependencies"] } },
  { ...childInput, "dependency-groups": { dev: ["leaf==1"] } }, null,
])("leaves mismatched, dynamic, development and unreadable child declarations unconfirmed", data => {
  const manifests = workspace(); manifests[1] = { path: `${childDir}/pyproject.toml`, data };
  expect(analyzePdm(lock([childNode, { name: "leaf", version: "1" }]), manifests).workspaces?.get(childDir)).toBeNull();
});
it("supports explicit local path dependencies without following their source files", () => {
  const manifests = [...root({ project: { dependencies: ["web @ file:///${PROJECT_ROOT}/apps/%E6%97%A5%E6%9C%AC%E8%AA%9E%20app"] } }), workspace()[1]!];
  expect(analyzePdm(lock([childNode, { name: "leaf", version: "1" }]), manifests).workspaces?.get(childDir)).toBe(true);
});
it("covers workspace members that depend on sibling members by name", () => {
  const source = lock([
    { name: "web", version: "1", editable: true, path: "apps/web", dependencies: ["lib"] },
    { name: "lib", version: "1", editable: true, path: "apps/lib", dependencies: ["leaf==1"] },
    { name: "leaf", version: "1", dependencies: ["deep==1"] }, { name: "deep", version: "1" },
  ]);
  const result = analyzePdm(source, [workspace()[0]!,
    { path: "apps/web/pyproject.toml", data: { project: { name: "web", version: "1", dependencies: ["lib"] } } },
    { path: "apps/lib/pyproject.toml", data: { project: { name: "lib", version: "1", dependencies: ["leaf==1"] } } },
  ]);
  expect(result.workspaces?.get("apps/web")).toBe(true);
  expect(result.workspaces?.get("apps/lib")).toBe(true);
  expect(result.relations?.("leaf", "1")).toMatchObject({ relation: "direct", declaredIn: new Set(["apps/lib/pyproject.toml"]) });
  expect(result.relations?.("deep", "1")).toMatchObject({ relation: "transitive", introducedBy: new Set(["leaf"]) });
});
it("does not confirm a local child with an ambiguous locked package name", () => {
  const nodes = [childNode, { name: "web", version: "2" }, { name: "leaf", version: "1" }];
  expect(analyzePdm(lock(nodes), workspace()).workspaces?.get(childDir)).toBeNull();
});
it("keeps unsafe local/Git/URL identities and same-version source collisions unknown", () => {
  const result = analyzePdm(lock([
    { name: "local", version: "1", path: "../outside" }, { name: "vcs", version: "1", git: "https://example.test/private" },
    { name: "remote", version: "1", url: "https://example.test/p.whl" },
    { name: "collision", version: "1" }, { name: "collision", version: "1", path: "child" },
  ]), root({ project: { dependencies: ["local", "vcs", "remote", "collision"] } }));
  for (const name of ["local", "vcs", "remote", "collision"]) expect(result.relations?.(name, "1").relation).toBe("unknown");
});
it("keeps confirmed membership when the independent relationship budget is exhausted", () => {
  const result = analyzePdm(lock([childNode, { name: "leaf", version: "1" }]), workspace(), undefined, { remaining: 0 });
  expect(result.workspaces?.get(childDir)).toBe(true); expect(result.relations).toBeNull();
  expect(analyzePdm(lock([childNode]), workspace(), { remaining: 0 }).workspaces).toBeNull();
});
it.each(["", "[metadata]\nlock_version='99'", "[metadata]\nlock_version='4.5.2'", "x=" + "[".repeat(130) + "0" + "]".repeat(130), "__proto__.x=1"])("rejects malformed or unsupported metadata", source => {
  expect(analyzePdm(source, [])).toEqual({ workspaces: null, relations: null });
});
it("回帰: lockのpackaging形式(指定子の並べ替え・二重引用符のmarker)と子の宣言を一致とする(レビュー、2026-10-28)", () => {
  const source = (dependencies: string[]) => lock([
    { name: "api", version: "0.1.0", path: "./packages/api", dependencies }, { name: "urllib3", version: "1.26.4" }, { name: "pywin32", version: "306" },
  ]);
  const manifests = (dependencies: string[]): PdmManifest[] => [
    ...root({ project: { name: "root", version: "0", dependencies: ["api @ file:///${PROJECT_ROOT}/packages/api"] } }),
    { path: "packages/api/pyproject.toml", data: { project: { name: "api", version: "0.1.0", dependencies } } },
  ];
  const locked = ["urllib3<1.27,>=1.21.1", 'pywin32; sys_platform == "win32" and python_version < "3.13"'];
  const result = analyzePdm(source(locked), manifests(["urllib3 >= 1.21.1, < 1.27", "pywin32;sys_platform=='win32' and  python_version<'3.13'"]));
  expect(result.workspaces?.get("packages/api")).toBe(true);
  expect(result.relations?.("pywin32", "306")).toMatchObject({ relation: "direct", declaredIn: new Set(["packages/api/pyproject.toml"]) });
  // 指定子・markerの内容が違えば従来どおりunconfirmed
  for (const child of [["urllib3>=1.21.1,<1.28", locked[1]!], [locked[0]!, "pywin32; sys_platform == 'linux' and python_version < '3.13'"]]) {
    expect(analyzePdm(source(locked), manifests(child)).workspaces?.get("packages/api")).toBeNull();
  }
});
