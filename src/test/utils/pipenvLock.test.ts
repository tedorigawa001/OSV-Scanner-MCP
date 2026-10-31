import { expect, it } from "vitest";
import { analyzePipenv, parsePipenvLock, type PipenvManifest } from "../../utils/pipenvLock.js";
const lock = (normal: unknown, develop: unknown = {}, other = {}) => JSON.stringify({ _meta: { "pipfile-spec": 6 }, default: normal, develop, ...other });
const root = (data: Record<string, unknown>): PipenvManifest[] => [{ path: "Pipfile", data }];
const releases = { requests: { version: "==2.25.0" }, urllib3: { version: "==1.26.20" } };
it("uses captured Pipfile declarations and a unique category origin", () => {
  const result = analyzePipenv(lock(releases), root({ packages: { Requests: "==2.25.0" } }));
  expect(result.relations?.("requests", "2.25.0")).toMatchObject({ relation: "direct", declaredIn: new Set(["Pipfile"]) });
  expect(result.relations?.("urllib3", "1.26.20")).toMatchObject({ relation: "transitive", introducedBy: new Set(["requests"]) });
});
it("does not guess an origin when a category has multiple direct roots", () => {
  const result = analyzePipenv(lock({ ...releases, jinja2: { version: "==3.1.4" } }), root({ packages: { requests: "*", jinja2: "*" } }));
  expect(result.relations?.("urllib3", "1.26.20")).toEqual({ relation: "transitive" });
});
it("keeps development/custom categories separate and merges direct/transitive overlap", () => {
  const result = analyzePipenv(lock(releases, { urllib3: { version: "==1.26.20" } }, { docs: { jinja2: { version: "==3.1.4" }, markupsafe: { version: "==2.0.0" } } }), root({
    packages: { requests: "*" }, "dev-packages": { urllib3: "*" }, docs: { jinja2: "*" },
  }));
  expect(result.relations?.("urllib3", "1.26.20")).toMatchObject({ relation: "direct", introducedBy: new Set(["requests"]) });
  expect(result.relations?.("markupsafe", "2.0.0")).toMatchObject({ relation: "transitive", introducedBy: new Set(["jinja2"]) });
});
it("leaves residual packages unknown with missing or incomplete declaration evidence", () => {
  for (const manifests of [[], root({}), root({ packages: { requests: "*", absent: "*" } }), [{ path: "Pipfile", data: null }]]) {
    const result = analyzePipenv(lock(releases), manifests);
    expect(result.relations?.("urllib3", "1.26.20")?.relation ?? "unknown").toBe("unknown");
  }
});
const childDir = "apps/日本語 app";
const childRoot = (): PipenvManifest => ({ path: "Pipfile", data: { packages: { web: { path: `./${childDir}`, editable: true } } } });
const child = (data: Record<string, unknown> | null = { project: { name: "web", version: "1", dependencies: ["requests>=2,<3"] } }): PipenvManifest => ({ path: `${childDir}/pyproject.toml`, data });
const local = { web: { path: `./${childDir}`, editable: true }, ...releases };
it("confirms a child only through an exact declared and locked local path", () => {
  const result = analyzePipenv(lock(local), [childRoot(), child()]);
  expect(result.workspaces?.get(childDir)).toBe(true);
  expect(result.relations?.("requests", "2.25.0")).toMatchObject({ relation: "direct", declaredIn: new Set([`${childDir}/pyproject.toml`]) });
  expect(result.relations?.("urllib3", "1.26.20")).toMatchObject({ relation: "transitive", introducedBy: new Set(["requests"]) });
});
it("distinguishes absent children and locked but unverifiable children", () => {
  expect(analyzePipenv(lock(releases), [childRoot(), child()]).workspaces?.get(childDir)).toBe(false);
  expect(analyzePipenv(lock(local), [root({ packages: { requests: "*" } })[0]!, child()]).workspaces?.get(childDir)).toBeNull();
});
it("does not use simple ordering to confirm exclusions of a local version", () => {
  const data = { ...local, requests: { version: "==2.25.0+local" } };
  expect(analyzePipenv(lock(data), [childRoot(), child({ project: { name: "web", dependencies: ["requests!=2.25.0"] } })]).workspaces?.get(childDir)).toBeNull();
});
it.each([
  null, { project: { name: "other", dependencies: ["requests"] } },
  { project: { name: "web", dependencies: ["requests==3"] } },
  { project: { name: "web", dependencies: ["absent"] } },
  { project: { name: "web", dynamic: ["dependencies"] } },
  { project: { name: "web", dynamic: ["optional-dependencies"] } },
  { project: { name: "web", dependencies: ["requests; sys_platform == 'win32'"] } },
  { project: { name: "web", dependencies: ["requests[security]"] } },
  { project: { name: "web" }, "dependency-groups": { dev: ["requests"] } },
  { project: { name: "web", "optional-dependencies": { docs: ["requests"] } } },
])("keeps unreadable/dynamic/development/unresolved child declarations unconfirmed", data => {
  expect(analyzePipenv(lock(local), [childRoot(), child(data)]).workspaces?.get(childDir)).toBeNull();
});
it("does not use a same-name independent descendant or a source mismatch", () => {
  const result = analyzePipenv(lock(local), [childRoot(), { path: "other/pyproject.toml", data: child().data }]);
  expect(result.workspaces?.get("other")).toBe(false);
  const wrong = childRoot(); (wrong.data!.packages as Record<string, unknown>).web = { path: "other" };
  expect(analyzePipenv(lock(local), [wrong, child()]).workspaces?.get(childDir)).toBeNull();
});
it("does not enrich nonregistry references as public releases", () => {
  const result = analyzePipenv(lock({ web: { path: "../outside", version: "==1" }, vcs: { git: "https://example.test/private", version: "==1" } }), root({ packages: { web: { path: "../outside" }, vcs: { git: "https://example.test/private" } } }));
  for (const name of ["web", "vcs"]) expect(result.relations?.(name, "1").relation).toBe("unknown");
});
it("keeps confirmed coverage when the relationship budget is exhausted", () => {
  const result = analyzePipenv(lock(local), [childRoot(), child()], undefined, { remaining: 0 });
  expect(result.workspaces?.get(childDir)).toBe(true); expect(result.relations).toBeNull();
});
it.each([
  { group: { dev: { dependencies: { pytest: "==6.0.0" } } } },
  { "dev-dependencies": { pytest: "==6.0.0" } },
])("does not confirm a child with unexported Poetry development declarations", poetry => {
  const data = { project: { name: "web", dependencies: ["requests>=2,<3"] }, tool: { poetry } };
  expect(analyzePipenv(lock(local), [childRoot(), child(data)]).workspaces?.get(childDir)).toBeNull();
});
it("accepts empty Poetry development groups", () => {
  const data = { project: { name: "web", dependencies: ["requests>=2,<3"] }, tool: { poetry: { group: { dev: { dependencies: {} } }, "dev-dependencies": {} } } };
  expect(analyzePipenv(lock(local), [childRoot(), child(data)]).workspaces?.get(childDir)).toBe(true);
});
it.each([
  "{}", '{"_meta":{"pipfile-spec":99}}', '{"_meta":{"pipfile-spec":6},"default":{},"default":{}}',
  '{"_meta":{"pipfile-spec":6},}', '{"_meta":{"pipfile-spec":6},/*comment*/"default":{}}',
  '{"_meta":{"pipfile-spec":6},"default":{"Requests":{},"requests":{}}}',
  "[".repeat(130) + "0" + "]".repeat(130),
])("rejects unsupported, malformed or ambiguous lock metadata", source => {
  expect(analyzePipenv(source, root({})).relations).toBeNull();
});
it("does not assign prototype keys during JSON parsing", () => {
  const parsed = parsePipenvLock('{"_meta":{"pipfile-spec":6},"__proto__":{}}');
  expect(Object.getPrototypeOf(parsed)).toBeNull();
});
