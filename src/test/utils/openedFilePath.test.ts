import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openedFilePath } from "../../utils/openedFilePath.js";
import { copyRegularFile, readRegularFile, verifyOpenedFile } from "../../utils/safeRead.js";
import { loadSbom } from "../../utils/sbomInput.js";

let base: string | undefined;
afterEach(async () => { if (base !== undefined) await rm(base, { recursive: true, force: true }); });
async function setup() {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-native-path-")));
  await mkdir(path.join(base, "root"));
  return { base, root: path.join(base, "root") };
}

describe("OSの開いたファイルの実体パス(Linux/macOS/Windows)", () => {
  it("通常の読み込み・コピー・SBOMとUnicode名を維持する", async () => {
    const { base, root } = await setup();
    const fileName = path.join(root, "依存.json");
    const content = JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", components: [] });
    await writeFile(fileName, content);
    const file = await open(fileName, "r");
    try {
      expect(await openedFilePath(file.fd)).toBe(fileName);
    } finally { await file.close(); }
    const read = await readRegularFile(fileName, { maxBytes: 1024, boundary: root });
    expect(read.ok && read.bytes.toString()).toBe(content);
    const dest = path.join(base, "copy.json");
    expect((await copyRegularFile(fileName, dest, { maxBytes: 1024, boundary: root })).ok).toBe(true);
    expect(await readFile(dest, "utf8")).toBe(content);
    expect((await loadSbom(fileName, { allowedRoot: root })).bytes.toString()).toBe(content);
  });

  it("パスが同じinodeでも、境界外の開いた実体を拒否する", async () => {
    const { base, root } = await setup();
    const outside = path.join(base, "outside.txt");
    await writeFile(outside, "outside");
    const file = await open(outside, "r");
    try {
      expect(await verifyOpenedFile(outside, await file.stat(), root, file)).toBe("outside");
    } finally { await file.close(); }
  });

  it("開いたディレクトリが境界外へ移動しても元の文字列パスを信じない", async () => {
    const { base, root } = await setup();
    const dir = path.join(root, "dir");
    await mkdir(dir);
    const original = path.join(dir, "a.txt");
    await writeFile(original, "a");
    const file = await open(original, "r");
    try {
      const info = await file.stat();
      const moved = path.join(base, "moved");
      if (process.platform === "win32") {
        // Windowsは開いたファイルを含むディレクトリの移動をOSが拒否する(差し替え自体が起きない。CIで確認)。
        // 移動できないことと、開いた実体が境界の内側のまま確認できることを確かめる
        await expect(rename(dir, moved)).rejects.toMatchObject({ code: "EPERM" });
        expect(await verifyOpenedFile(original, info, root, file)).toBeNull();
        return;
      }
      await rename(dir, moved);
      expect(await verifyOpenedFile(original, info, root, file)).toBe("outside");
    } finally { await file.close(); }
  });

  it("閉じたハンドル・欠けたハンドル・不正fdでは安全側に失敗する", async () => {
    const { root } = await setup();
    const name = path.join(root, "a.txt");
    await writeFile(name, "a");
    const file = await open(name, "r");
    const info = await file.stat();
    await file.close();
    expect(await verifyOpenedFile(name, info, root, file)).toBe("changed");
    expect(await verifyOpenedFile(name, info, root)).toBe("changed");
    await expect(openedFilePath(-1)).rejects.toThrow();
  });
});
