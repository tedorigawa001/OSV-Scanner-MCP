import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScanToolError } from "../../errors.js";
import {
  assetNameForPlatform,
  ensureOsvScannerDownloaded,
  PINNED_OSV_SCANNER_VERSION,
} from "../../osv/binaryDownloader.js";

const FAKE_BINARY = Buffer.from("#!/bin/sh\necho fake-osv-scanner\n");
const FAKE_SHA256 = createHash("sha256").update(FAKE_BINARY).digest("hex");

let cacheDir: string;

beforeAll(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-dl-"));
});

afterAll(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

/** darwin/arm64固定でテストする(実行環境に依存させない) */
function options(overrides: Record<string, unknown> = {}) {
  return {
    cacheDir,
    platform: "darwin" as const,
    arch: "arm64",
    checksums: { "osv-scanner_darwin_arm64": FAKE_SHA256 },
    fetchFn: async () => new Response(new Uint8Array(FAKE_BINARY), { status: 200 }),
    ...overrides,
  };
}

async function expectScanError(promise: Promise<unknown>, kind: string): Promise<ScanToolError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ScanToolError);
  expect((error as ScanToolError).kind).toBe(kind);
  return error as ScanToolError;
}

describe("assetNameForPlatform", () => {
  it("対応プラットフォームの公式資産名を組み立てる", () => {
    expect(assetNameForPlatform("darwin", "arm64")).toBe("osv-scanner_darwin_arm64");
    expect(assetNameForPlatform("linux", "x64")).toBe("osv-scanner_linux_amd64");
    expect(assetNameForPlatform("win32", "x64")).toBe("osv-scanner_windows_amd64.exe");
  });

  it("未対応プラットフォームはnull", () => {
    expect(assetNameForPlatform("sunos" as NodeJS.Platform, "x64")).toBeNull();
    expect(assetNameForPlatform("linux", "ia32")).toBeNull();
  });
});

describe("ensureOsvScannerDownloaded", () => {
  it("ダウンロード→検証→実行権限付きで配置し、正しいURLを参照する", async () => {
    let requestedUrl = "";
    const binPath = await ensureOsvScannerDownloaded(
      options({
        fetchFn: async (url: string | URL | Request) => {
          requestedUrl = String(url);
          return new Response(new Uint8Array(FAKE_BINARY), { status: 200 });
        },
      }),
    );
    expect(requestedUrl).toBe(
      `https://github.com/google/osv-scanner/releases/download/v${PINNED_OSV_SCANNER_VERSION}/osv-scanner_darwin_arm64`,
    );
    expect(await readFile(binPath)).toEqual(FAKE_BINARY);
    const mode = (await stat(binPath)).mode;
    expect(mode & 0o111).not.toBe(0); // 実行権限あり
  });

  it("2回目以降はキャッシュを使いダウンロードしない", async () => {
    let fetchCount = 0;
    const opts = options({
      fetchFn: async () => {
        fetchCount++;
        return new Response(new Uint8Array(FAKE_BINARY), { status: 200 });
      },
    });
    await ensureOsvScannerDownloaded(opts); // キャッシュ済み(前テストで配置)
    expect(fetchCount).toBe(0);
  });

  it("キャッシュが改ざんされていたら再ダウンロードして修復する", async () => {
    const binPath = path.join(
      cacheDir,
      `v${PINNED_OSV_SCANNER_VERSION}`,
      "osv-scanner_darwin_arm64",
    );
    await writeFile(binPath, "tampered!");
    let fetchCount = 0;
    const restored = await ensureOsvScannerDownloaded(
      options({
        fetchFn: async () => {
          fetchCount++;
          return new Response(new Uint8Array(FAKE_BINARY), { status: 200 });
        },
      }),
    );
    expect(fetchCount).toBe(1);
    expect(await readFile(restored)).toEqual(FAKE_BINARY);
  });

  it("旧版が広い権限で作った既存キャッシュディレクトリも0700に締める", async () => {
    const isolated = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-dl-perm-"));
    try {
      // 旧版の挙動を再現: 0755でディレクトリを作成し、バイナリをキャッシュ済みにする
      const versionDir = path.join(isolated, `v${PINNED_OSV_SCANNER_VERSION}`);
      await mkdir(versionDir, { recursive: true, mode: 0o755 });
      await chmod(isolated, 0o755);
      await chmod(versionDir, 0o755);
      await writeFile(path.join(versionDir, "osv-scanner_darwin_arm64"), FAKE_BINARY);

      // キャッシュヒット経路でも権限が締まる
      await ensureOsvScannerDownloaded(options({ cacheDir: isolated }));
      expect((await stat(isolated)).mode & 0o777).toBe(0o700);
      expect((await stat(versionDir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it("チェックサム不一致はbinary_checksum_mismatchでバイナリを配置しない", async () => {
    const isolated = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-dl-bad-"));
    try {
      const error = await expectScanError(
        ensureOsvScannerDownloaded(
          options({
            cacheDir: isolated,
            checksums: { "osv-scanner_darwin_arm64": "0".repeat(64) },
          }),
        ),
        "binary_checksum_mismatch",
      );
      expect(error.message).toContain("改ざんまたは破損");
      // 検証に失敗したバイナリはキャッシュに残らない
      const target = path.join(
        isolated,
        `v${PINNED_OSV_SCANNER_VERSION}`,
        "osv-scanner_darwin_arm64",
      );
      await expect(stat(target)).rejects.toThrow();
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it("HTTPエラーはbinary_download_failed", async () => {
    await expectScanError(
      ensureOsvScannerDownloaded(
        options({
          cacheDir: await mkdtemp(path.join(os.tmpdir(), "osv-mcp-dl-404-")),
          fetchFn: async () => new Response("not found", { status: 404 }),
        }),
      ),
      "binary_download_failed",
    );
  });

  it("ネットワークエラー・タイムアウトはbinary_download_failed", async () => {
    await expectScanError(
      ensureOsvScannerDownloaded(
        options({
          cacheDir: await mkdtemp(path.join(os.tmpdir(), "osv-mcp-dl-net-")),
          fetchFn: async () => {
            throw new TypeError("fetch failed");
          },
        }),
      ),
      "binary_download_failed",
    );
  });

  it("未対応プラットフォームはbinary_download_failed(手動導入を案内)", async () => {
    const error = await expectScanError(
      ensureOsvScannerDownloaded(options({ platform: "sunos" as NodeJS.Platform })),
      "binary_download_failed",
    );
    expect(error.message).toContain("OSV_SCANNER_PATH");
  });
});
