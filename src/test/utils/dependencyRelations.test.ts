import { describe, expect, it } from "vitest";
import {
  combineRelations,
  goModRelations,
  npmLockRelations,
  pomRelations,
  requirementsRelations,
  type RelationLookup,
} from "../../utils/dependencyRelations.js";

function summary(lookup: RelationLookup, name: string, version: string) {
  const info = lookup!(name, version);
  return {
    relation: info.relation,
    introducedBy: [...(info.introducedBy ?? [])].sort(),
    declaredIn: [...(info.declaredIn ?? [])].sort(),
  };
}

/**
 * npm 11の`npm install --package-lock-only`で生成した実データ(express 4.17.1・lodash・別名・workspace)を縮約したもの。
 * qsは同じ名前の別の版が、ルート(express経由)とworkspaceの入れ子に置かれる
 */
const LOCK = {
  lockfileVersion: 3,
  packages: {
    "": {
      name: "relroot", workspaces: ["packages/*"],
      dependencies: { express: "4.17.1", lodash: "4.17.20", "old-lodash": "npm:lodash@4.17.15" },
      devDependencies: { minimist: "1.2.5" },
    },
    "packages/sub": { version: "1.0.0", dependencies: { qs: "6.5.2", "node-fetch": "2.6.0" } },
    "node_modules/sub": { resolved: "packages/sub", link: true },
    "packages/sub/node_modules/qs": { version: "6.5.2" },
    "node_modules/express": { version: "4.17.1", dependencies: { "body-parser": "1.19.0", qs: "6.7.0", send: "0.17.1" } },
    "node_modules/body-parser": { version: "1.19.0", dependencies: { qs: "6.7.0" } },
    "node_modules/qs": { version: "6.7.0" },
    "node_modules/send": { version: "0.17.1", dependencies: { "@scope/ms": "2.1.1" } },
    "node_modules/send/node_modules/@scope/ms": { version: "2.1.1", dependencies: { send: "0.17.1" } }, // 循環
    "node_modules/lodash": { version: "4.17.20" },
    "node_modules/old-lodash": { name: "lodash", version: "4.17.15" },
    "node_modules/minimist": { version: "1.2.5", dev: true },
    "node_modules/node-fetch": { version: "2.6.0" },
    "node_modules/orphan": { version: "1.0.0", extraneous: true },
  },
};

describe("npmLockRelations", () => {
  const lookup = npmLockRelations(LOCK);

  it("ルート・workspaceの依存をNodeの解決規則で解決したものが直接依存(宣言したpackage.json付き)", () => {
    expect(summary(lookup, "express", "4.17.1")).toEqual({ relation: "direct", introducedBy: [], declaredIn: ["package.json"] });
    expect(summary(lookup, "minimist", "1.2.5").relation).toBe("direct"); // devDependencies
    // workspaceの依存: 入れ子(packages/sub/node_modules/qs)と、上位へ探して見つかるルートのnode_modules
    expect(summary(lookup, "qs", "6.5.2")).toEqual({ relation: "direct", introducedBy: [], declaredIn: ["packages/sub/package.json"] });
    expect(summary(lookup, "node-fetch", "2.6.0").declaredIn).toEqual(["packages/sub/package.json"]);
  });

  it("別名(npm:lodash@4.17.15)は本来の名前で直接依存になる", () => {
    expect(summary(lookup, "lodash", "4.17.15").relation).toBe("direct");
    expect(summary(lookup, "lodash", "4.17.20").relation).toBe("direct");
  });

  it("直接依存からたどれるものは推移的依存で、経由した直接依存の名前を返す(scope付きの名前・循環も扱う)", () => {
    expect(summary(lookup, "qs", "6.7.0")).toEqual({ relation: "transitive", introducedBy: ["express"], declaredIn: [] });
    expect(summary(lookup, "body-parser", "1.19.0").introducedBy).toEqual(["express"]);
    expect(summary(lookup, "@scope/ms", "2.1.1")).toEqual({ relation: "transitive", introducedBy: ["express"], declaredIn: [] });
  });

  it("どこからも到達しないもの・収録されていないものはunknown", () => {
    expect(summary(lookup, "orphan", "1.0.0").relation).toBe("unknown");
    expect(summary(lookup, "nothing", "1.0.0").relation).toBe("unknown");
  });

  it("直接依存でもあり推移的にも到達する版は、directとし経由した直接依存も返す", () => {
    const both = npmLockRelations({ packages: {
      "": { dependencies: { a: "1", b: "1" } },
      "node_modules/a": { version: "1.0.0", dependencies: { b: "1" } },
      "node_modules/b": { version: "1.0.0" },
    } });
    expect(summary(both, "b", "1.0.0")).toEqual({ relation: "direct", introducedBy: ["a"], declaredIn: ["package.json"] });
  });

  it("lockfileVersion 1(packagesが無い)と、たどる辺の上限を超える場合はnull(unknown)", () => {
    expect(npmLockRelations({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0" } } })).toBeNull();
    expect(npmLockRelations("not an object")).toBeNull();
    expect(npmLockRelations(LOCK, 5)).toBeNull();
  });
});

describe("goModRelations", () => {
  const lookup = goModRelations([
    "module example.com/rel",
    "",
    "go 1.22",
    "",
    "require (",
    "\tgithub.com/gin-gonic/gin v1.7.0",
    "\tgolang.org/x/text v0.3.0 // indirect",
    "\tgolang.org/x/crypto v0.1.0 // indirect; required by gin",
    "\tgolang.org/x/sys v0.1.0 // pinned, not indirect",
    ")",
    "",
    "require golang.org/x/net v0.0.0-20210226172049-e18ecbb05110 // indirect",
    "",
    "replace golang.org/x/text => github.com/golang/text v0.3.2",
  ].join("\r\n"));

  it("// indirectの無いrequireが直接依存。単一行・括弧のブロック・CRLFを扱う", () => {
    expect(lookup!("github.com/gin-gonic/gin", "1.7.0")).toEqual({ relation: "direct" });
    expect(lookup!("golang.org/x/net", "x").relation).toBe("transitive");
    expect(lookup!("golang.org/x/crypto", "x").relation).toBe("transitive"); // "indirect;"で始まるコメント
    expect(lookup!("golang.org/x/sys", "x").relation).toBe("direct"); // indirectで始まらないコメント
    expect(lookup!("example.com/unknown", "x").relation).toBe("unknown");
  });

  it("replaceの置換先にも同じ関係を当て、置換していることを返す(osv-scannerは置換先のパスと版で報告する)", () => {
    expect(lookup!("github.com/golang/text", "0.3.2")).toEqual({ relation: "transitive", replaced: true });
  });

  it("回帰: 版を限定したreplaceは、requireの版が一致する場合だけ適用する(osv-scanner 2.4.0で確認した挙動)", () => {
    const mod = (replace: string) => goModRelations(`module x\nrequire example.com/a v1.2.0\nreplace ${replace}\n`)!;
    // 版が一致しない: 置換されず、元のモジュールが元の版で報告される
    const notApplied = mod("example.com/a v1.0.0 => example.com/b v1.0.1");
    expect(notApplied("example.com/a", "1.2.0")).toEqual({ relation: "direct" });
    expect(notApplied("example.com/b", "1.0.1").relation).toBe("unknown");
    // 版が一致する・版を限定しない: 置換先に関係とreplacedを付ける
    expect(mod("example.com/a v1.2.0 => example.com/b v1.0.1")("example.com/b", "1.0.1")).toEqual({ relation: "direct", replaced: true });
    expect(mod("example.com/a => example.com/a v1.3.0")("example.com/a", "1.3.0")).toEqual({ relation: "direct", replaced: true });
    // 同じモジュールでは版を限定したreplaceが優先される
    const both = goModRelations("module x\nrequire example.com/a v1.2.0\nreplace (\n\texample.com/a => example.com/a v9.0.0\n\texample.com/a v1.2.0 => example.com/a v1.2.5\n)\n")!;
    expect(both("example.com/a", "1.2.5")).toEqual({ relation: "direct", replaced: true });
    expect(both("example.com/a", "9.0.0")).toEqual({ relation: "direct" });
    // ローカルディレクトリへの置換は置換元の名前で示す
    expect(mod("example.com/a => ../a")("example.com/a", "1.2.0")).toEqual({ relation: "direct", replaced: true });
  });
});

describe("requirementsRelations", () => {
  it("コピーに書いた名前が直接依存(PEP 503で照合)、それ以外は推移的依存", () => {
    const lookup = requirementsRelations(["requests==2.19.0", "Jinja2>=2.0", "zope.interface==4.0.0"]);
    expect(lookup!("requests", "2.19.0").relation).toBe("direct");
    expect(lookup!("jinja2", "2.0").relation).toBe("direct");
    expect(lookup!("zope-interface", "4.0.0").relation).toBe("direct");
    expect(lookup!("urllib3", "1.23.0").relation).toBe("transitive");
  });
});

describe("combineRelations", () => {
  it("ファイルごとの関係が同じならその値、異なればmixed。経由と宣言は合わせる", () => {
    expect(combineRelations([{ relation: "direct" }, { relation: "direct" }]).relation).toBe("direct");
    expect(combineRelations([{ relation: "direct" }, { relation: "unknown" }]).relation).toBe("mixed");
    expect(combineRelations([]).relation).toBe("unknown");
    const merged = combineRelations([
      { relation: "transitive", introducedBy: new Set(["b", "a"]) },
      { relation: "transitive", introducedBy: new Set(["a", "c"]), replaced: true },
    ]);
    expect(merged).toEqual({ relation: "transitive", introducedBy: ["a", "b", "c"], declaredIn: [], replaced: true });
  });
});

describe("pomRelations", () => {
  it("osv-scannerのsource.typeで判定する(lockfile=宣言された依存、unknown=deps.devで解決された推移的依存)", () => {
    const lookup = pomRelations()!;
    expect(lookup("g:a", "1.0", "lockfile").relation).toBe("direct");
    expect(lookup("g:a", "1.0", "unknown").relation).toBe("transitive");
  });
  it("想定外のtype・typeなしはunknown(直接依存と誤って言わない)", () => {
    const lookup = pomRelations()!;
    expect(lookup("g:a", "1.0", "sbom").relation).toBe("unknown");
    expect(lookup("g:a", "1.0", null).relation).toBe("unknown");
    expect(lookup("g:a", "1.0").relation).toBe("unknown");
  });
});
