import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScanToolError } from "../../errors.js";
import {
  findOsvScannerBinary,
  installGuidance,
  OSV_SCANNER_PATH_ENV,
  resolveOsvScannerBinary,
} from "../../osv/binaryManager.js";
import { runOsvScan } from "../../osv/runner.js";

let binDir: string;
let projectDir: string;

/** 偽のosv-scannerスクリプトを作る。テストでは実バイナリの終了コード仕様を模倣する。 */
async function makeFakeBinary(name: string, script: string): Promise<string> {
  const filePath = path.join(binDir, name);
  await writeFile(filePath, `#!/bin/sh\n${script}\n`);
  await chmod(filePath, 0o755);
  return filePath;
}

const VULN_JSON = JSON.stringify({
  results: [
    {
      source: { path: "/x/pom.xml" },
      packages: [
        {
          package: { name: "a:a", version: "1.0", ecosystem: "Maven" },
          groups: [{ ids: ["GHSA-test"], aliases: ["CVE-2020-1"], max_severity: "7.5" }],
        },
      ],
    },
  ],
});

beforeAll(async () => {
  binDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-bin-"));
  projectDir = await mkdtemp(path.join(os.tmpdir(), "osv-mcp-proj-"));
});

afterAll(async () => {
  await rm(binDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

async function expectScanError(promise: Promise<unknown>, kind: string): Promise<ScanToolError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ScanToolError);
  expect((error as ScanToolError).kind).toBe(kind);
  return error as ScanToolError;
}

describe("runOsvScan", () => {
  it("exit 1(脆弱性あり)のJSONをレポートに変換する", async () => {
    const bin = await makeFakeBinary("fake-vulns", `echo '${VULN_JSON}'; exit 1`);
    const report = await runOsvScan(projectDir, { binaryPath: bin });
    expect(report.vulnerability_count).toBe(1);
    expect(report.packages[0]!.vulnerabilities[0]!.cve).toBe("CVE-2020-1");
  });

  it("exit 0(脆弱性なし)は空レポートを返す", async () => {
    const bin = await makeFakeBinary("fake-clean", `echo '{"results":[]}'; exit 0`);
    const report = await runOsvScan(projectDir, { binaryPath: bin });
    expect(report.vulnerability_count).toBe(0);
    expect(report.packages).toEqual([]);
  });

  it("exit 128はno_packages_found", async () => {
    const bin = await makeFakeBinary(
      "fake-nopkg",
      `echo 'No package sources found' >&2; exit 128`,
    );
    await expectScanError(runOsvScan(projectDir, { binaryPath: bin }), "no_packages_found");
  });

  it("その他の終了コードはscan_failed(stderr抜粋をdetailに含む)", async () => {
    const bin = await makeFakeBinary("fake-fail", `echo 'something broke' >&2; exit 127`);
    const error = await expectScanError(runOsvScan(projectDir, { binaryPath: bin }), "scan_failed");
    expect(error.detail).toContain("something broke");
  });

  it("JSONでない出力はinvalid_output", async () => {
    const bin = await makeFakeBinary("fake-notjson", `echo 'oops not json'; exit 0`);
    await expectScanError(runOsvScan(projectDir, { binaryPath: bin }), "invalid_output");
  });

  it("タイムアウトでプロセスを打ち切りscan_timeout", async () => {
    const bin = await makeFakeBinary("fake-slow", `sleep 30; echo '{"results":[]}'`);
    await expectScanError(
      runOsvScan(projectDir, { binaryPath: bin, timeoutMs: 300 }),
      "scan_timeout",
    );
  });

  it("出力サイズ上限を超えたらoutput_too_large", async () => {
    const bin = await makeFakeBinary(
      "fake-huge",
      `head -c 100000 /dev/zero | tr '\\0' 'a'; exit 0`,
    );
    await expectScanError(
      runOsvScan(projectDir, { binaryPath: bin, maxOutputBytes: 10_000 }),
      "output_too_large",
    );
  });

  it("バイナリが起動できなければscan_failed", async () => {
    await expectScanError(
      runOsvScan(projectDir, { binaryPath: path.join(binDir, "does-not-exist") }),
      "scan_failed",
    );
  });

  it("binaryPath省略時はOSV_SCANNER_PATH環境変数から解決する", async () => {
    const bin = await makeFakeBinary("env-resolved", `echo '{"results":[]}'; exit 0`);
    const previous = process.env[OSV_SCANNER_PATH_ENV];
    process.env[OSV_SCANNER_PATH_ENV] = bin;
    try {
      const report = await runOsvScan(projectDir);
      expect(report.vulnerability_count).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[OSV_SCANNER_PATH_ENV];
      else process.env[OSV_SCANNER_PATH_ENV] = previous;
    }
  });

  it("シグナルで強制終了された場合もscan_failed(signal情報付き)", async () => {
    const bin = await makeFakeBinary("fake-killed", `kill -KILL $$`);
    const error = await expectScanError(runOsvScan(projectDir, { binaryPath: bin }), "scan_failed");
    expect(error.message).toContain("SIGKILL");
  });

  it("同時実行数が上限に達したらtoo_many_concurrent_scansで即時エラー", async () => {
    const bin = await makeFakeBinary("fake-busy", `sleep 2; echo '{"results":[]}'; exit 0`);
    const first = runOsvScan(projectDir, { binaryPath: bin, maxConcurrentScans: 1 });
    // 1件目が走っている間の2件目は待たされず即時エラーになる
    const error = await expectScanError(
      runOsvScan(projectDir, { binaryPath: bin, maxConcurrentScans: 1 }),
      "too_many_concurrent_scans",
    );
    expect(error.message).toContain("1件まで");
    await expect(first).resolves.toMatchObject({ vulnerability_count: 0 });
  }, 10_000);

  it("スキャン完了後(エラー時含む)はスロットが解放され再実行できる", async () => {
    const failing = await makeFakeBinary("fake-slot-fail", `echo 'boom' >&2; exit 127`);
    await expectScanError(
      runOsvScan(projectDir, { binaryPath: failing, maxConcurrentScans: 1 }),
      "scan_failed",
    );
    const ok = await makeFakeBinary("fake-slot-ok", `echo '{"results":[]}'; exit 0`);
    const report = await runOsvScan(projectDir, { binaryPath: ok, maxConcurrentScans: 1 });
    expect(report.vulnerability_count).toBe(0);
  });
});

describe("binaryManager", () => {
  it("PATHからosv-scannerを見つける", async () => {
    await makeFakeBinary("osv-scanner", `exit 0`);
    const env = { PATH: binDir } as NodeJS.ProcessEnv;
    expect(await findOsvScannerBinary(env)).toBe(path.join(binDir, "osv-scanner"));
  });

  it("OSV_SCANNER_PATHの明示指定を優先し、無効ならPATHにフォールバックしない", async () => {
    const explicit = await makeFakeBinary("custom-scanner", `exit 0`);
    const env = {
      PATH: binDir,
      [OSV_SCANNER_PATH_ENV]: explicit,
    } as NodeJS.ProcessEnv;
    expect(await findOsvScannerBinary(env)).toBe(explicit);

    const badEnv = {
      PATH: binDir, // PATH上には有効なosv-scannerがあるが、明示指定が優先される
      [OSV_SCANNER_PATH_ENV]: "/no/such/binary",
    } as NodeJS.ProcessEnv;
    expect(await findOsvScannerBinary(badEnv)).toBeNull();
  });

  it("見つからず自動ダウンロードも無効なら案内メッセージ付きのbinary_not_found", async () => {
    const env = {
      PATH: "/nonexistent-dir-for-test",
      OSV_MCP_AUTO_DOWNLOAD: "0",
    } as NodeJS.ProcessEnv;
    const error = await resolveOsvScannerBinary(env).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ScanToolError);
    expect((error as ScanToolError).kind).toBe("binary_not_found");
    expect((error as ScanToolError).message).toContain("brew install osv-scanner");
    expect(installGuidance(env)).toContain(OSV_SCANNER_PATH_ENV);
  });

  it("見つからなければ自動ダウンロードにフォールバックする(デフォルト有効)", async () => {
    const env = { PATH: "/nonexistent-dir-for-test" } as NodeJS.ProcessEnv;
    let downloadCalled = false;
    const resolved = await resolveOsvScannerBinary(env, {
      downloadFn: async () => {
        downloadCalled = true;
        return "/cache/osv-scanner";
      },
    });
    expect(downloadCalled).toBe(true);
    expect(resolved).toBe("/cache/osv-scanner");
  });

  it("OSV_SCANNER_PATHが無効な場合は自動ダウンロードせずbinary_not_found", async () => {
    const env = {
      PATH: "/nonexistent-dir-for-test",
      [OSV_SCANNER_PATH_ENV]: "/no/such/binary",
    } as NodeJS.ProcessEnv;
    let downloadCalled = false;
    const error = await resolveOsvScannerBinary(env, {
      downloadFn: async () => {
        downloadCalled = true;
        return "/cache/osv-scanner";
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(downloadCalled).toBe(false);
    expect((error as ScanToolError).kind).toBe("binary_not_found");
  });

  it("resolveOsvScannerBinaryは見つかったバイナリのパスを返す", async () => {
    const bin = await makeFakeBinary("osv-scanner", `exit 0`);
    const env = { PATH: binDir } as NodeJS.ProcessEnv;
    expect(await resolveOsvScannerBinary(env)).toBe(bin);
  });

  it("環境変数が無効なパスを指す場合は案内メッセージでその旨を伝える", () => {
    const env = { [OSV_SCANNER_PATH_ENV]: "/no/such/binary" } as NodeJS.ProcessEnv;
    const guidance = installGuidance(env);
    expect(guidance).toContain("/no/such/binary");
    expect(guidance).toContain("実行可能ファイルを指していません");
  });
});
