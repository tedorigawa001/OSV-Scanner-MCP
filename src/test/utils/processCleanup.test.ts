import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupSync,
  removeStaleTempDirs,
  STALE_TEMP_DIR_AGE_MS,
  trackChildProcess,
  trackedCounts,
  trackTempDir,
} from "../../utils/processCleanup.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "process-cleanup-test-")));
});
afterEach(async () => {
  cleanupSync();
  await rm(root, { recursive: true, force: true });
});

describe("cleanupSync", () => {
  it("removes tracked temp dirs and kills tracked child processes", async () => {
    const dir = path.join(root, "snap");
    await mkdir(path.join(dir, "tree"), { recursive: true });
    await writeFile(path.join(dir, "tree", "package-lock.json"), "{}");
    trackTempDir(dir);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    trackChildProcess(child);
    const closed = new Promise<NodeJS.Signals | null>((resolve) => child.once("close", (_code, signal) => resolve(signal)));

    cleanupSync();

    expect(await readdir(root)).toEqual([]);
    expect(await closed).toBe("SIGKILL");
    expect(trackedCounts()).toEqual({ tempDirs: 0, children: 0 });
  });

  it("does not touch untracked dirs and forgets children that already exited", async () => {
    const dir = path.join(root, "snap");
    await mkdir(dir);
    trackTempDir(dir)();
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    trackChildProcess(child);
    await new Promise((resolve) => child.once("close", resolve));
    expect(trackedCounts()).toEqual({ tempDirs: 0, children: 0 });
    cleanupSync();
    expect(await readdir(root)).toEqual(["snap"]);
  });
});

describe("removeStaleTempDirs", () => {
  const now = Date.now();
  const old = new Date(now - STALE_TEMP_DIR_AGE_MS - 60_000);

  async function makeDir(name: string, mtime: Date): Promise<string> {
    const dir = path.join(root, name);
    await mkdir(dir);
    await writeFile(path.join(dir, "copy.json"), "{}");
    await utimes(dir, mtime, mtime);
    return dir;
  }

  it("removes only old, real directories with our exact prefixes", async () => {
    await makeDir("osv-mcp-snap-AbC123", old);
    await makeDir("osv-mcp-sbom-xyz789", old);
    await makeDir("osv-mcp-snap-fresh1", new Date(now));
    await makeDir("osv-mcp-snap-toolong1", old);
    await makeDir("osv-mcp-other-abc123", old);
    await makeDir("other-osv-mcp-snap-abc123", old);
    await writeFile(path.join(root, "osv-mcp-snap-file01"), "not a dir");

    expect(await removeStaleTempDirs({ tmpRoot: root, now })).toBe(2);
    expect((await readdir(root)).sort()).toEqual([
      "osv-mcp-other-abc123", "osv-mcp-snap-file01", "osv-mcp-snap-fresh1", "osv-mcp-snap-toolong1", "other-osv-mcp-snap-abc123",
    ]);
  });

  it("never follows symlinks, at the top level or inside", async () => {
    const outside = await makeDir("outside", old);
    await symlink(outside, path.join(root, "osv-mcp-snap-link01"));
    const stale = await makeDir("osv-mcp-snap-inner1", old);
    await symlink(outside, path.join(stale, "escape"));
    await utimes(stale, old, old);

    expect(await removeStaleTempDirs({ tmpRoot: root, now })).toBe(1);
    expect((await readdir(root)).sort()).toEqual(["osv-mcp-snap-link01", "outside"]);
    expect(await readdir(outside)).toEqual(["copy.json"]);
  });

  it.skipIf(typeof process.getuid !== "function" || process.getuid() === 0)("skips directories owned by another user", async () => {
    // 他ユーザー所有のディレクトリは作れないため、getuidを差し替えて所有者が一致しない場合を模擬する
    await makeDir("osv-mcp-snap-mine01", old);
    const realGetuid = process.getuid!;
    process.getuid = () => realGetuid() + 1;
    try {
      expect(await removeStaleTempDirs({ tmpRoot: root, now })).toBe(0);
    } finally {
      process.getuid = realGetuid;
    }
    expect(await readdir(root)).toEqual(["osv-mcp-snap-mine01"]);
  });
});
