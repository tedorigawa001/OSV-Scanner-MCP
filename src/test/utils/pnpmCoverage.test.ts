import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { detectProject } from "../../utils/manifestDetector.js";
import { PnpmLockCache } from "../../utils/pnpmLockCache.js";
import { buildCoverage } from "../../tools/scanProject.js";
import { pnpmImporterKeys } from "../../utils/pnpmRelations.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
async function fixture(lock: string, extra: Record<string, string> = {}) {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-pnpm-coverage-")));
  for (const [name, value] of Object.entries({ "package.json": "{}", "pnpm-lock.yaml": lock, ...extra })) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), value);
  }
}
const lock = (version: string, importers: object) => stringify({ lockfileVersion: version, importers, packages: {}, ...(version === "9.0" ? { snapshots: {} } : {}) });

it.each(["5.3", "5.4", "6.0", "9.0"])("confirms exact importer paths, including empty and Unicode/space workspaces (%s)", async version => {
  await fixture(lock(version, { ".": {}, "apps/日本語": {}, "apps/my app": {} }), { "apps/日本語/package.json": "{}", "apps/my app/package.json": "{}" });
  const project = await detectProject(dir);
  expect(project.lockfileMissing).toEqual([]);
  expect(buildCoverage(project).complete).toBe(true);
  expect(project.pnpmCopies).toHaveLength(1);
});
it("does not hide independent projects, descendants of an importer, or same-name packages", async () => {
  await fixture(lock("9.0", { ".": {}, "apps/web": {} }), { "apps/web/package.json": "{}", "apps/web/independent/package.json": "{}", "other/web/package.json": "{}" });
  const project = await detectProject(dir);
  expect(project.lockfileMissing.map(p => [p.path, p.status]).sort()).toEqual([["apps/web/independent/package.json", "missing"], ["other/web/package.json", "missing"]]);
  expect(buildCoverage(project).complete).toBe(false);
});
it.each([
  "lockfileVersion: '99.0'\nimporters: {apps/web: {}}",
  "lockfileVersion: '9.0'\nimporters: {apps/web: {}, apps/web: {}}",
  "lockfileVersion: '9.0'\nimporters: {apps/web: null}",
  "lockfileVersion: '9.0'\nimporters: {apps/web: {dependencies: []}}",
  "lockfileVersion: '9.0'\nimporters: {apps/web: {dependencies: {foo: {specifier: ^1}}}}",
  "lockfileVersion: '9.0'\nimporters: {apps/web: {}, apps/./web: {}}",
  "lockfileVersion: '9.0'\nimporters: {../outside: {}}",
  "lockfileVersion: '9.0'\npackages: {}\nsnapshots: {}",
  "[".repeat(129),
])("leaves unverifiable locks unconfirmed (%s)", async source => {
  await fixture(source, { "apps/web/package.json": "{}" });
  const project = await detectProject(dir);
  expect(project.lockfileMissing).toMatchObject([{ path: "apps/web/package.json", status: "unconfirmed" }]);
  expect(buildCoverage(project).complete).toBe(false);
});
it("treats legacy single-project locks as not including a child", async () => {
  await fixture("lockfileVersion: 5.4\npackages: {}", { "apps/web/package.json": "{}" });
  expect((await detectProject(dir)).lockfileMissing).toMatchObject([{ path: "apps/web/package.json", status: "missing" }]);
});
it("matches nested locks relative to their own directory and accepts any confirmed candidate", async () => {
  await fixture(lock("9.0", { ".": {}, "nested/apps/web": {} }), { "nested/pnpm-lock.yaml": lock("9.0", { ".": {} }), "nested/apps/web/package.json": "{}" });
  expect((await detectProject(dir)).lockfileMissing).toEqual([]);
});
it("does not search above the selected scan directory", async () => {
  await fixture(lock("9.0", { ".": {}, "apps/web": {} }), { "apps/web/package.json": "{}", "apps/web/yarn.lock": "" });
  const project = await detectProject(path.join(dir, "apps/web"));
  expect(project.pnpmCopies).toEqual([]);
});
it("caches captured bytes and importer keys, and respects the total input limit", async () => {
  const content = lock("9.0", { ".": {}, "apps/web": {} });
  await fixture(content, { "other/pnpm-lock.yaml": content });
  const file = path.join(dir, "pnpm-lock.yaml"), cache = new PnpmLockCache(Buffer.byteLength(content));
  const first = await cache.get(file, dir);
  await writeFile(file, "changed original");
  expect(await cache.get(file, dir)).toBe(first);
  expect(first).toMatchObject({ content, importers: new Set([".", "apps/web"]) });
  expect(await cache.get(path.join(dir, "other/pnpm-lock.yaml"), dir)).toHaveProperty("reason");
  expect(await new PnpmLockCache(1).get(file, dir)).toHaveProperty("reason");
});
it("does not retain a partial importer index when its shared work budget is exhausted", () => {
  const budget = { remaining: 1 };
  expect(pnpmImporterKeys({ lockfileVersion: "9.0", importers: { ".": {}, "apps/web": {} } }, budget)).toBeNull();
  expect(pnpmImporterKeys({ lockfileVersion: "9.0", importers: { "apps/web": {} } }, budget)).toBeNull();
});
