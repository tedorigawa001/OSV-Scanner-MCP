import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { analyzeYarn, type YarnManifest } from "../../utils/yarnLock.js";

const manifests: YarnManifest[] = [
  { path: "package.json", data: { name: "app", private: true, workspaces: ["apps/**"], dependencies: { parent: "^1" } } },
  { path: "apps/日本語 app/package.json", data: { name: "web", version: "1.0.0", devDependencies: { dev: "1.0.0" } } },
  { path: "independent/package.json", data: { name: "other" } },
];
const classic = `# yarn lockfile v1
parent@^1, parent@~1:
  version "1.0.0"
  dependencies:
    leaf "^1"
leaf@^1:
  version "1.0.1"
  dependencies:
    parent "^1"
dev@1.0.0:
  version "1.0.0"
unused@1.0.0:
  version "1.0.0"
`;
const berry = (extra = {}) => stringify({
  __metadata: { version: "8", cacheKey: "10c0" },
  "app@workspace:.": { version: "0.0.0-use.local", resolution: "app@workspace:.", dependencies: { parent: "npm:^1" } },
  "web@workspace:apps/日本語 app": { version: "0.0.0-use.local", resolution: "web@workspace:apps/日本語 app", dependencies: { dev: "npm:1.0.0" } },
  "parent@npm:^1, parent@npm:~1": { version: "1.0.0", resolution: "parent@npm:1.0.0", dependencies: { leaf: "npm:^1" } },
  "leaf@npm:^1": { version: "1.0.1", resolution: "leaf@npm:1.0.1", dependencies: { parent: "npm:^1" } },
  "dev@npm:1.0.0": { version: "1.0.0", resolution: "dev@npm:1.0.0" },
  "unused@npm:1.0.0": { version: "1.0.0", resolution: "unused@npm:1.0.0" }, ...extra,
});
describe("Yarn lock relations and workspace membership", () => {
  it.each([{ version: "1.0.0" }, { name: "web" }, { name: "", version: "1.0.0" }, { name: "web", version: "" }])("excludes Classic children without a workspace identity (%j)", identity => {
    const input = { path: manifests[1]!.path, data: { ...identity, dependencies: { dev: "1.0.0" } } };
    const result = analyzeYarn(classic, [manifests[0]!, input]);
    expect(result.members.get(input.path)).toBe(false);
    expect(result.lookup!("dev", "1.0.0")).toEqual({ relation: "unknown" });
    expect(result.lookup!("parent", "1.0.0").declaredIn).toEqual(new Set(["package.json"]));
  });
  it.each([
    ["apps/*", "apps/.hidden", false],
    ["apps/?hidden", "apps/.hidden", false],
    ["apps/**", "apps/.hidden/deep", false],
    ["apps/**/web", "apps/.hidden/web", false],
    ["apps/.hidden", "apps/.hidden", true],
    ["apps/.*", "apps/.hidden", true],
    ["apps/**/.hidden", "apps/nested/.hidden", true],
    ["apps/.hidden/**", "apps/.hidden/deep", true],
    ["apps/*", "apps/web", true],
  ] as const)("matches Classic dot segments correctly: %s -> %s", (pattern, directory, expected) => {
    const root = { path: "package.json", data: { private: true, workspaces: [pattern] } };
    const child = { path: `${directory}/package.json`, data: { name: "web", version: "1.0.0", dependencies: { dev: "1.0.0" } } };
    const result = analyzeYarn(classic, [root, child]);
    expect(result.members.get(child.path)).toBe(expected);
    expect(result.lookup!("dev", "1.0.0").relation).toBe(expected ? "direct" : "unknown");
  });
  it.each([classic, berry()])("finds roots, transitive origins, cycles and exact workspace declarations", source => {
    const result = analyzeYarn(source, manifests), lookup = result.lookup!;
    expect(lookup("parent", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["package.json"]) });
    expect(lookup("leaf", "1.0.1")).toEqual({ relation: "transitive", introducedBy: new Set(["parent"]) });
    expect(lookup("dev", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["apps/日本語 app/package.json"]) });
    expect(lookup("unused", "1.0.0").relation).toBe("unknown");
    expect(result.members.get("apps/日本語 app/package.json")).toBe(true);
    expect(result.members.get("independent/package.json")).toBe(false);
  });
  it("marks changed or unresolved declarations unconfirmed", () => {
    const changed = manifests.map(m => m.data?.name === "web" ? { ...m, data: { ...m.data, dependencies: { missing: "^1" } } } : m);
    for (const source of [classic, berry()]) expect(analyzeYarn(source, changed).members.get("apps/日本語 app/package.json")).toBeNull();
  });
  it("does not infer workspace membership from a matching dependency name", () => {
    const inputs = [...manifests, { path: "independent/web/package.json", data: { name: "web", dependencies: { dev: "1.0.0" } } }];
    for (const source of [classic, berry()]) expect(analyzeYarn(source, inputs).members.get("independent/web/package.json")).toBe(false);
  });
  it("supports Classic object-form workspaces and exclusion patterns", () => {
    const root = { ...manifests[0]!, data: { ...manifests[0]!.data, workspaces: { packages: ["apps/*", "!apps/日本語 app"] } } };
    expect(analyzeYarn(classic, [root, manifests[1]!]).members.get(manifests[1]!.path)).toBe(false);
  });
  it("keeps unsupported workspace patterns and unreadable companions unconfirmed", () => {
    const root = { path: "package.json", data: { private: true, workspaces: ["apps/{one,two}"] } };
    expect(analyzeYarn(classic, [root, manifests[1]!]).members.get(manifests[1]!.path)).toBeNull();
    expect(analyzeYarn(classic, [{ path: "package.json", data: null }, manifests[1]!]).lookup!("dev", "1.0.0").relation).toBe("unknown");
  });
  it("uses only unique configured Classic workspaces to resolve local dependency ranges", () => {
    const inputs = [...manifests, { path: "apps/local/package.json", data: { name: "local", version: "1.2.0" } }];
    inputs[1] = { ...inputs[1]!, data: { ...inputs[1]!.data, dependencies: { local: "^1" } } };
    expect(analyzeYarn(classic, inputs).members.get(manifests[1]!.path)).toBe(true);
    inputs[1]!.data!.dependencies = { local: "^2" };
    expect(analyzeYarn(classic, inputs).members.get(manifests[1]!.path)).toBeNull();
  });
  it("prefers a matching Classic workspace over a same-named registry entry", () => {
    const source = classic + 'local@^1:\n  version "1.1.0"\n';
    const inputs: YarnManifest[] = [
      { path: "package.json", data: { private: true, workspaces: ["apps/*"], dependencies: { local: "^1" } } },
      { path: "apps/local/package.json", data: { name: "local", version: "1.2.0" } },
    ];
    expect(analyzeYarn(source, inputs).lookup!("local", "1.1.0").relation).toBe("unknown");
    expect(analyzeYarn(source, inputs).members.get("package.json")).toBe(true);
  });
  it("supports scoped npm aliases and optional edges without resolving other versions", () => {
    const source = `# yarn lockfile v1
"alias@npm:@scope/parent@^1":
  version "1.0.0"
  optionalDependencies:
    leaf "^1"
leaf@^1:
  version "1.0.1"
`;
    const result = analyzeYarn(source, [{ path: "package.json", data: { dependencies: { alias: "npm:@scope/parent@^1" } } }]);
    expect(result.lookup!("@scope/parent", "1.0.0").relation).toBe("direct");
    expect(result.lookup!("leaf", "1.0.1").introducedBy).toEqual(new Set(["@scope/parent"]));
    expect(result.lookup!("leaf", "2.0.0").relation).toBe("unknown");
  });
  it("keeps direct precedence and merges multiple introducing roots", () => {
    const inputs: YarnManifest[] = [{ path: "package.json", data: { dependencies: { parent: "^1", second: "1.0.0", leaf: "^1" } } }];
    const source = classic + 'second@1.0.0:\n  version "1.0.0"\n  dependencies:\n    leaf "^1"\n';
    expect(analyzeYarn(source, inputs).lookup!("leaf", "1.0.1")).toEqual({ relation: "direct", declaredIn: new Set(["package.json"]), introducedBy: new Set(["parent", "second"]) });
  });
  it("does not interpret local/Git identities as registry releases", () => {
    const source = '# yarn lockfile v1\n"local@file:../local":\n  version "1.0.0"\n"fork@https://example.test/fork.git":\n  version "1.0.0"\n';
    const inputs: YarnManifest[] = [{ path: "package.json", data: { dependencies: { local: "file:../local", fork: "https://example.test/fork.git" } } }];
    const analysis = analyzeYarn(source, inputs);
    expect(analysis.lookup!("local", "1.0.0").relation).toBe("unknown");
    expect(analysis.lookup!("fork", "1.0.0").relation).toBe("unknown");
  });
  it("leaves duplicate Berry workspace paths unconfirmed", () => {
    const source = berry({ [`other@workspace:apps/日本語 app`]: { version: "0.0.0-use.local", resolution: "other@workspace:apps/日本語 app" } });
    expect(analyzeYarn(source, manifests).members.get(manifests[1]!.path)).toBeNull();
  });
  it("rejects duplicate selectors, unsupported syntax and exhausted work budgets", () => {
    expect(analyzeYarn(classic + '\nparent@^1:\n  version "2.0.0"', manifests).lookup).toBeNull();
    expect(analyzeYarn(berry({ __metadata: { version: "99" } }), manifests).lookup).toBeNull();
    expect(analyzeYarn(classic, manifests, { remaining: 1 }).lookup).toBeNull();
    expect(analyzeYarn("[".repeat(129), manifests).lookup).toBeNull();
  });
});
