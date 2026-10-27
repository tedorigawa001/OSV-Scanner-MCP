import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { pnpmLockRelations } from "../../utils/pnpmRelations.js";

const fixture = (version = "9.0") => {
  const modern = version === "9.0", old = version.startsWith("5");
  const key = (name: string, v = "1.0.0") => old ? `/${name}/${v}` : `${modern ? "" : "/"}${name}@${v}`;
  const nodes = { [key("parent")]: { dependencies: { leaf: "1.0.0" } }, [key("leaf")]: {}, [key("unused")]: {} };
  return { lockfileVersion: version, importers: { ".": { dependencies: { parent: modern || !old ? { specifier: "^1", version: "1.0.0" } : "1.0.0" } }, "apps/web": { devDependencies: { leaf: modern || !old ? { version: "1.0.0" } : "1.0.0" } } },
    packages: modern ? Object.fromEntries(Object.keys(nodes).map(k => [k, {}])) : nodes, ...(modern ? { snapshots: nodes } : {}) };
};
describe("pnpm lockfile relations", () => {
  it.each(["5.3", "5.4", "6.0", "9.0"].flatMap(version => ["apps/日本語", "apps/my app"].map(root => ({ version, root }))))("recognizes direct dependencies in $root ($version), including transitive overlap", ({ version, root }) => {
    const data = fixture(version);
    const workspace = data.importers["apps/web"];
    const lookup = pnpmLockRelations(stringify({ ...data, importers: { ".": data.importers["."], [root]: workspace } }))!;
    expect(lookup("leaf", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set([`${root}/package.json`]), introducedBy: new Set(["parent"]) });
  });
  it.each(["/absolute", "../outside", "apps/../../outside", "C:/outside", "C:outside", "\\\\server\\share", "apps\\..\\outside", "apps/\u0000bad"])("does not use unsafe importer paths: %s", root => {
    const data = fixture();
    const lookup = pnpmLockRelations(stringify({ ...data, importers: { [root]: data.importers["."] } }))!;
    expect(lookup("parent", "1.0.0").relation).toBe("unknown");
    expect(lookup("parent", "1.0.0").declaredIn).toBeUndefined();
  });
  it.each(["5.3", "5.4", "6.0", "9.0"])("finds roots, workspace declarations and origins in %s", version => {
    const lookup = pnpmLockRelations(stringify(fixture(version)))!;
    expect(lookup("parent", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["package.json"]) });
    expect(lookup("leaf", "1.0.0")).toEqual({ relation: "direct", declaredIn: new Set(["apps/web/package.json"]), introducedBy: new Set(["parent"]) });
    expect(lookup("unused", "1.0.0")).toEqual({ relation: "unknown" });
    expect(lookup("leaf", "2.0.0")).toEqual({ relation: "unknown" });
  });
  it("reads legacy single-project root dependencies", () => {
    const data = fixture("5.4");
    const lookup = pnpmLockRelations(stringify({ lockfileVersion: "5.4", dependencies: { parent: "1.0.0" }, packages: data.packages }))!;
    expect(lookup("leaf", "1.0.0")).toEqual({ relation: "transitive", introducedBy: new Set(["parent"]) });
  });
  it("collects multiple introducing roots and excludes unresolved peer variants", () => {
    const lookup = pnpmLockRelations(stringify({ lockfileVersion: "9.0",
      importers: { ".": { dependencies: { a: { version: "1.0.0" }, b: { version: "1.0.0" }, missing: { version: "1.0.0" } } } },
      packages: { "a@1.0.0": {}, "b@1.0.0": {}, "leaf@1.0.0": {}, "missing@1.0.0": {} },
      snapshots: { "a@1.0.0": { dependencies: { leaf: "1.0.0" } }, "b@1.0.0": { dependencies: { leaf: "1.0.0" } },
        "leaf@1.0.0": {}, "missing@1.0.0(peer@1.0.0)": {} },
    }))!;
    expect(lookup("leaf", "1.0.0")).toEqual({ relation: "transitive", introducedBy: new Set(["a", "b"]) });
    expect(lookup("missing", "1.0.0").relation).toBe("unknown");
  });
  it("keeps peer contexts separate and supports scoped aliases, optional edges and cycles", () => {
    const data = { lockfileVersion: "9.0", importers: { ".": { optionalDependencies: { alias: { version: "@scope/parent@1.0.0(peer@1.0.0)" } } } },
      packages: { "@scope/parent@1.0.0": {}, "leaf@1.0.0": {}, "other@1.0.0": {} },
      snapshots: { "@scope/parent@1.0.0(peer@1.0.0)": { optionalDependencies: { leaf: "1.0.0" } },
        "@scope/parent@1.0.0(peer@2.0.0)": { dependencies: { other: "1.0.0" } },
        "leaf@1.0.0": { dependencies: { alias: "@scope/parent@1.0.0(peer@1.0.0)" } }, "other@1.0.0": {} } };
    const lookup = pnpmLockRelations(stringify(data))!;
    expect(lookup("@scope/parent", "1.0.0").relation).toBe("direct");
    expect(lookup("leaf", "1.0.0").introducedBy).toEqual(new Set(["@scope/parent"]));
    expect(lookup("other", "1.0.0").relation).toBe("unknown");
  });
  it("does not follow local links, external importers, or unresolved peer contexts", () => {
    const data = fixture();
    const source = stringify({ ...data, importers: { ".": { dependencies: { parent: { version: "link:../parent" } } }, "../external": { dependencies: { parent: { version: "1.0.0" } } } } });
    expect(pnpmLockRelations(source)!("parent", "1.0.0").relation).toBe("unknown");
  });
  it("omits all relationships when work or input limits are exceeded", () => {
    expect(pnpmLockRelations(stringify(fixture()), 1)).toBeNull();
    expect(pnpmLockRelations("[".repeat(129))).toBeNull();
    expect(pnpmLockRelations(" ".repeat(258) + "x: y")).toBeNull();
  });
  it.each(["lockfileVersion: '99.0'", "lockfileVersion: '9.0'\nlockfileVersion: '6.0'", "lockfileVersion: '9.0'\npackages: &x {}\nsnapshots: *x", "lockfileVersion: '9.0'\n---\nlockfileVersion: '9.0'"])("rejects unsupported, duplicate, aliased or multi-document YAML", source => {
    expect(pnpmLockRelations(source)).toBeNull();
  });
});

describe("pnpm lockfile parsing limits (vulnerability check, 2026-10-27)", () => {
  // yamlのparseDocumentは大きなマップで二次時間になり、5.5MiBで11秒同期的に止まった。構文木から線形時間で読む
  const large = (n: number) => {
    let packages = "", snapshots = "";
    for (let i = 0; i < n; i++) {
      packages += `  pkg${i}@1.0.0:\n    resolution: {integrity: sha512-${"A".repeat(86)}==}\n\n`;
      snapshots += `  pkg${i}@1.0.0:\n    dependencies:\n      pkg${(i + 1) % n}: 1.0.0\n\n`;
    }
    return `lockfileVersion: "9.0"\nimporters:\n  .:\n    dependencies:\n      pkg0:\n        specifier: ^1.0.0\n        version: 1.0.0\npackages:\n${packages}snapshots:\n${snapshots}`;
  };

  it("回帰: 大きなlockfile(28,000パッケージ)を有界な時間で読み、関係を返す", () => {
    const source = large(28_000);
    const started = performance.now();
    const lookup = pnpmLockRelations(source);
    // 二次時間の実装では10秒を超える。線形時間なら1秒前後(負荷に備えて余裕を取る)
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(lookup!("pkg0", "1.0.0").relation).toBe("direct");
    expect(lookup!("pkg27999", "1.0.0")).toMatchObject({ relation: "transitive", introducedBy: new Set(["pkg0"]) });
  });

  it.each([
    ["anchor and alias", `lockfileVersion: "9.0"\na: &x {b: c}\nd: *x\n`],
    ["tag", `lockfileVersion: !!str "9.0"\nimporters: {}\npackages: {}\nsnapshots: {}\n`],
    ["duplicate key", `lockfileVersion: "9.0"\nlockfileVersion: "9.0"\n`],
    ["several documents", `lockfileVersion: "9.0"\n---\nx: y\n`],
    ["invalid syntax", `lockfileVersion: "9.0"\nimporters: {a: [}\n`],
  ])("rejects %s without expanding or guessing", (_label, source) => {
    expect(pnpmLockRelations(source)).toBeNull();
  });

  it("does not pollute prototypes through __proto__ keys", () => {
    const lookup = pnpmLockRelations(`lockfileVersion: "9.0"\n__proto__:\n  polluted: yes\nimporters:\n  .:\n    dependencies: {}\npackages: {}\nsnapshots: {}\n`);
    expect(lookup).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("shares the work budget across lockfiles in a scan", () => {
    const budget = { remaining: 2_000_000 };
    expect(pnpmLockRelations(stringify(fixture()), budget)).not.toBeNull();
    budget.remaining = 0;
    expect(pnpmLockRelations(stringify(fixture()), budget)).toBeNull();
  });
});
