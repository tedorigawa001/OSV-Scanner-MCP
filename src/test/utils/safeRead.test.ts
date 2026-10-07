import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { copyRegularFile, readRegularFile, verifyOpenedFile } from "../../utils/safeRead.js";

const tempDirs: string[] = [];

async function makeBase(): Promise<string> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-safe-")));
  tempDirs.push(base);
  await mkdir(path.join(base, "root"), { recursive: true });
  await mkdir(path.join(base, "outside"), { recursive: true });
  return base;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 処理が止まった場合にテストを永久に待たせない */
function withinTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("処理が止まった")), ms))]);
}

describe("readRegularFile", () => {
  it("通常のファイルを読む", async () => {
    const base = await makeBase();
    await writeFile(path.join(base, "root/a.txt"), "hello");
    const result = await readRegularFile(path.join(base, "root/a.txt"), { maxBytes: 100, boundary: path.join(base, "root") });
    expect(result.ok && result.bytes.toString()).toBe("hello");
  });

  it("回帰: 名前付きパイプ(FIFO)で処理が止まらず、通常のファイルでないとして失敗する", async () => {
    const base = await makeBase();
    const fifo = path.join(base, "root/pipe");
    execFileSync("mkfifo", [fifo]);
    const result = await withinTimeout(readRegularFile(fifo, { maxBytes: 100 }));
    expect(result).toMatchObject({ ok: false, failure: "not_regular" });
  });

  it("末尾がシンボリックリンクのファイルは読まない", async () => {
    const base = await makeBase();
    await writeFile(path.join(base, "outside/secret.txt"), "secret");
    await symlink(path.join(base, "outside/secret.txt"), path.join(base, "root/link.txt"));
    const result = await readRegularFile(path.join(base, "root/link.txt"), { maxBytes: 100 });
    expect(result.ok).toBe(false);
  });

  it("途中のディレクトリがシンボリックリンクで境界の外を指す場合はoutside", async () => {
    const base = await makeBase();
    await writeFile(path.join(base, "outside/secret.txt"), "secret");
    await symlink(path.join(base, "outside"), path.join(base, "root/dir"));
    const result = await readRegularFile(path.join(base, "root/dir/secret.txt"), { maxBytes: 100, boundary: path.join(base, "root") });
    expect(result).toMatchObject({ ok: false, failure: "outside" });
  });

  it("サイズの上限を超えるファイルは読まない", async () => {
    const base = await makeBase();
    await writeFile(path.join(base, "root/big.txt"), "x".repeat(101));
    const result = await readRegularFile(path.join(base, "root/big.txt"), { maxBytes: 100 });
    expect(result).toMatchObject({ ok: false, failure: "too_large" });
  });
});

describe("verifyOpenedFile", () => {
  it("回帰: 開いたファイルと読み終えた後のパスの実体が異なれば(差し替え)changed", async () => {
    const base = await makeBase();
    await writeFile(path.join(base, "root/a.txt"), "a");
    await writeFile(path.join(base, "root/b.txt"), "b");
    const opened = await stat(path.join(base, "root/a.txt"));
    // 読んだのはa.txtの実体だが、確認時にパスがb.txtの実体を指している(差し替えられた)状況
    expect(await verifyOpenedFile(path.join(base, "root/b.txt"), opened, undefined)).toBe("changed");
    expect(await verifyOpenedFile(path.join(base, "root/a.txt"), opened, path.join(base, "root"))).toBeNull();
  });
});

describe("copyRegularFile", () => {
  it("内容をコピーし、所有者のみ読み書きできるファイルを作る", async () => {
    const base = await makeBase();
    await writeFile(path.join(base, "root/a.jar"), "jar-bytes");
    const dest = path.join(base, "copy.jar");
    const result = await copyRegularFile(path.join(base, "root/a.jar"), dest, { maxBytes: 100 });
    expect(result).toEqual({ ok: true, bytes: 9 });
    expect(await readFile(dest, "utf8")).toBe("jar-bytes");
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
  });

  it("FIFOで処理が止まらず、コピー先を残さない", async () => {
    const base = await makeBase();
    const fifo = path.join(base, "root/pipe.jar");
    execFileSync("mkfifo", [fifo]);
    const dest = path.join(base, "copy.jar");
    const result = await withinTimeout(copyRegularFile(fifo, dest, { maxBytes: 100 }));
    expect(result).toMatchObject({ ok: false, failure: "not_regular" });
    await expect(stat(dest)).rejects.toThrow();
  });

  it("境界の外ならコピー先を削除して失敗する", async () => {
    const base = await makeBase();
    await writeFile(path.join(base, "outside/secret.jar"), "secret");
    await symlink(path.join(base, "outside"), path.join(base, "root/dir"));
    const dest = path.join(base, "copy.jar");
    const result = await copyRegularFile(path.join(base, "root/dir/secret.jar"), dest, { maxBytes: 100, boundary: path.join(base, "root") });
    expect(result).toMatchObject({ ok: false, failure: "outside" });
    await expect(stat(dest)).rejects.toThrow();
  });
});
