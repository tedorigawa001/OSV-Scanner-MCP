import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DEPENDENCY_EDGES, PARSE_OPERATIONS_PER_KIB, createParseBudget } from "../../utils/dependencyRelations.js";
import { PnpmLockCache } from "../../utils/pnpmLockCache.js";
import { YarnLockCache } from "../../utils/yarnLockCache.js";
import { BunLockCache } from "../../utils/bunLockCache.js";
import { parseLockYaml, pnpmLockRelations } from "../../utils/pnpmRelations.js";

// 解析の予算をスキャン全体で共有していたため、pnpm/Yarnは合計約7.5MiB、Bunは約13.6MiBで尽き、
// 読み込み上限(1件16MiB・合計64MiB)の範囲の入力でも収録がunconfirmedになっていた(レビュー、2026-10-28)
const deps = (i: number, n: number, line: (name: string) => string) => Array.from({ length: 6 }, (_, k) => line(`p${(i + k + 1) % n}`)).join("");
const pnpm = (n: number) => {
  let packages = "", snapshots = "";
  for (let i = 0; i < n; i++) {
    packages += `  p${i}@1.0.0:\n    resolution: {integrity: sha512-${"A".repeat(86)}==}\n\n`;
    snapshots += `  p${i}@1.0.0:\n    dependencies:\n${deps(i, n, d => `      ${d}: 1.0.0\n`)}\n`;
  }
  return `lockfileVersion: "9.0"\nimporters:\n  .:\n    dependencies:\n      p0:\n        specifier: ^1.0.0\n        version: 1.0.0\n  apps/web:\n    dependencies: {}\npackages:\n${packages}snapshots:\n${snapshots}`;
};
const berry = (n: number) => {
  let source = "__metadata:\n  version: 8\n\n\"root@workspace:.\":\n  version: 0.0.0-use.local\n  resolution: \"root@workspace:.\"\n\n\"web@workspace:apps/web\":\n  version: 0.0.0-use.local\n  resolution: \"web@workspace:apps/web\"\n\n";
  for (let i = 0; i < n; i++) source += `"p${i}@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "p${i}@npm:1.0.0"\n  dependencies:\n${deps(i, n, d => `    ${d}: "npm:^1.0.0"\n`)}  checksum: 10c0/${"a".repeat(128)}\n\n`;
  return source;
};
const bun = (n: number) => `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "root" }, "apps/web": { "name": "web" } },\n  "packages": {\n${
  Array.from({ length: n }, (_, i) => `    "p${i}": ["p${i}@1.0.0", "", { "dependencies": { ${deps(i, n, d => `"${d}": "^1.0.0", `)} } }, "sha512-${"A".repeat(86)}=="],`).join("\n")}\n  }\n}\n`;

/** Operations one YAML parse uses; above MAX_DEPENDENCY_EDGES, the old shared budget could not parse the file at all. */
const parseOperations = (source: string) => {
  const budget = createParseBudget(source), start = budget.remaining;
  expect(parseLockYaml(source, budget)).not.toBeNull();
  return start - budget.remaining;
};

describe("createParseBudget", () => {
  it("scales with the input and keeps the shared minimum", () => {
    expect(createParseBudget("").remaining).toBe(MAX_DEPENDENCY_EDGES);
    expect(createParseBudget("x".repeat(16 * 1024 * 1024)).remaining).toBe(16 * 1024 * PARSE_OPERATIONS_PER_KIB);
    expect(createParseBudget("あ".repeat(4 * 1024 * 1024)).remaining).toBe(12 * 1024 * PARSE_OPERATIONS_PER_KIB);
  });
});

describe("lockfile parse budgets are per file (review, 2026-10-28)", () => {
  let dir: string;
  beforeEach(async () => { dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-parse-budget-"))); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const project = async (name: string, file: string, content: string) => {
    const root = path.join(dir, name);
    await mkdir(path.join(root, "apps/web"), { recursive: true });
    await writeFile(path.join(root, file), content);
    await writeFile(path.join(root, "package.json"), "{}");
    await writeFile(path.join(root, "apps/web/package.json"), '{"name":"web"}');
    return root;
  };

  it("回帰: 20万行・共有予算を超える1件のpnpm lockfile(約7MiB)でも収録と関係を確認する", async () => {
    const source = pnpm(22_000);
    expect(source.split("\n").length).toBeGreaterThan(200_000);
    // 解析の作業量は入力に比例する。1/10の入力で測り、元の共有予算を超えることを確かめる
    expect(parseOperations(pnpm(2_200)) * 10).toBeGreaterThan(MAX_DEPENDENCY_EDGES);
    const root = await project("pnpm", "pnpm-lock.yaml", source);
    const captured = await new PnpmLockCache().get(path.join(root, "pnpm-lock.yaml"), root);
    expect("importers" in captured && captured.importers).toEqual(new Set([".", "apps/web"]));
    expect(pnpmLockRelations(source)!("p0", "1.0.0").relation).toBe("direct");
  });

  it("回帰: 20万行・共有予算を超える1件のYarn Berry lockfileでも収録を確認する", async () => {
    const source = berry(22_000);
    expect(source.split("\n").length).toBeGreaterThan(200_000);
    expect(parseOperations(berry(2_200)) * 10).toBeGreaterThan(MAX_DEPENDENCY_EDGES);
    const root = await project("yarn", "yarn.lock", source);
    const captured = await new YarnLockCache().get(path.join(root, "yarn.lock"), root, ["package.json", "apps/web/package.json"]);
    expect("members" in captured && [...captured.members]).toEqual([["package.json", true], ["apps/web/package.json", true]]);
  });

  it("回帰: 同じスキャンの複数のBun lockfile(合計約16MiB)で、後のlockfileの収録も確認する", async () => {
    const source = bun(15_000), cache = new BunLockCache();
    for (let i = 0; i < 4; i++) {
      const root = await project(`bun${i}`, "bun.lock", source);
      const captured = await cache.get(path.join(root, "bun.lock"), root);
      expect("workspaces" in captured && captured.workspaces).toEqual(new Set(["", "apps/web"]));
    }
  });

  it("still rejects lockfiles over the per-file line limit", () => {
    expect(pnpmLockRelations(`lockfileVersion: "9.0"\n${"#\n".repeat(1_000_001)}`)).toBeNull();
  });
});
