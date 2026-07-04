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

  it("見つからなければ案内メッセージ付きのbinary_not_found", async () => {
    const env = { PATH: "/nonexistent-dir-for-test" } as NodeJS.ProcessEnv;
    const error = await resolveOsvScannerBinary(env).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ScanToolError);
    expect((error as ScanToolError).kind).toBe("binary_not_found");
    expect((error as ScanToolError).message).toContain("brew install osv-scanner");
    expect(installGuidance(env)).toContain(OSV_SCANNER_PATH_ENV);
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
