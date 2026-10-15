import { describe, expect, it } from "vitest";
import { fillMissingResolved } from "../../utils/npmLockCopy.js";

const lock = (packages: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "w", lockfileVersion: 3, requires: true, packages: { "": { name: "w" }, ...packages }, ...extra });

function filledPackages(text: string) {
  const result = fillMissingResolved(text);
  if (result === null) throw new Error("unparseable");
  return (JSON.parse(result.content) as { packages: Record<string, { resolved?: string }> }).packages;
}

describe("fillMissingResolved(osv-scanner 2.7.0はresolvedの無いエントリを照会しない)", () => {
  it("回帰: resolvedの無いレジストリのパッケージ・バンドルされた依存に公開レジストリの形のURLを補う", () => {
    const packages = filledPackages(lock({
      "node_modules/lodash": { version: "4.17.20" },
      "node_modules/a/node_modules/minimist": { version: "0.0.8", inBundle: true },
      "node_modules/@scope/pkg": { version: "1.0.0-beta.1" },
      "node_modules/alias": { name: "real-name", version: "2.0.0" },
    }));
    expect(packages["node_modules/lodash"]!.resolved).toBe("https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz");
    expect(packages["node_modules/a/node_modules/minimist"]!.resolved).toBe("https://registry.npmjs.org/minimist/-/minimist-0.0.8.tgz");
    expect(packages["node_modules/@scope/pkg"]!.resolved).toBe("https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0-beta.1.tgz");
    expect(packages["node_modules/alias"]!.resolved).toBe("https://registry.npmjs.org/real-name/-/real-name-2.0.0.tgz");
  });

  it("ローカルのパッケージ・既存のresolvedは変えない", () => {
    const entries = {
      "node_modules/linked": { resolved: "../local", link: true },
      "../local": { name: "local", version: "1.0.0" },
      "packages/ws-member": { name: "ws-member", version: "1.0.0" },
      "node_modules/tarball": { version: "1.0.0", resolved: "file:vendor/tarball-1.0.0.tgz" },
      "node_modules/git": { version: "1.2.3", resolved: "git+ssh://git@example.com/x.git#abc" },
      "node_modules/private": { version: "1.0.0", resolved: "https://artifactory.example.com/x-1.0.0.tgz" },
      "node_modules/noversion": {},
    };
    const text = lock(entries);
    expect(fillMissingResolved(text)).toEqual({ changed: false, content: text, filled: 0 });
  });

  it("lockfile v1: 入れ子の依存・bundledにも補い、版が参照(file:・git・user/repo)のものは補わない", () => {
    const text = JSON.stringify({ name: "w", lockfileVersion: 1, dependencies: {
      lodash: { version: "4.17.20" },
      "left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", dependencies: { minimist: { version: "0.0.8", bundled: true } } },
      local: { version: "file:../local" },
      gitdep: { version: "git+ssh://git@example.com/x.git#abc" },
      shorthand: { version: "user/repo#abc" },
    } });
    const result = fillMissingResolved(text)!;
    expect(result.filled).toBe(2);
    const deps = (JSON.parse(result.content) as { dependencies: Record<string, { resolved?: string; dependencies?: Record<string, { resolved?: string }> }> }).dependencies;
    expect(deps.lodash!.resolved).toBe("https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz");
    expect(deps["left-pad"]!.dependencies!.minimist!.resolved).toBe("https://registry.npmjs.org/minimist/-/minimist-0.0.8.tgz");
    expect([deps.local!.resolved, deps.gitdep!.resolved, deps.shorthand!.resolved]).toEqual([undefined, undefined, undefined]);
  });

  it("回帰(レビュー指摘): v1の別名(npm:<名前>@<版>)は、スコープ付きも含め実際の名前と版で補う", () => {
    const text = JSON.stringify({ name: "w", lockfileVersion: 1, dependencies: {
      "my-lodash": { version: "npm:lodash@4.17.20" },
      "my-scoped": { version: "npm:@babel/traverse@7.22.0" },
      "nested": { version: "1.0.0", resolved: "https://registry.npmjs.org/nested/-/nested-1.0.0.tgz", dependencies: { "inner-alias": { version: "npm:minimist@0.0.8", bundled: true } } },
      "has-resolved": { version: "npm:left-pad@1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz" },
      "alias-to-git": { version: "npm:x@git+ssh://git@example.com/x.git" },
      "alias-malformed": { version: "npm:@scope@1.0.0" },
    } });
    const result = fillMissingResolved(text)!;
    expect(result.filled).toBe(3);
    const deps = (JSON.parse(result.content) as { dependencies: Record<string, { resolved?: string; dependencies?: Record<string, { resolved?: string }> }> }).dependencies;
    expect(deps["my-lodash"]!.resolved).toBe("https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz");
    expect(deps["my-scoped"]!.resolved).toBe("https://registry.npmjs.org/@babel/traverse/-/traverse-7.22.0.tgz");
    expect(deps.nested!.dependencies!["inner-alias"]!.resolved).toBe("https://registry.npmjs.org/minimist/-/minimist-0.0.8.tgz");
    expect(deps["has-resolved"]!.resolved).toBe("https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz");
    expect([deps["alias-to-git"]!.resolved, deps["alias-malformed"]!.resolved]).toEqual([undefined, undefined]);
  });

  it("v2(packagesとdependenciesの両方)はどちらにも補う", () => {
    const text = lock({ "node_modules/lodash": { version: "4.17.20" } }, { lockfileVersion: 2, dependencies: { lodash: { version: "4.17.20" } } });
    expect(fillMissingResolved(text)!.filled).toBe(2);
  });

  it.each(["{", "[]", "null", "﻿{}"])("JSONのオブジェクトとして解析できなければnull(%s)", (text) => {
    expect(fillMissingResolved(text)).toBeNull();
  });
});
