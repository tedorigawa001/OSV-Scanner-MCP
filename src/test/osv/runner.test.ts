import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  buildOsvScanArgs,
  buildProjectTargetArgs,
  runOsvArtifactScan,
  runOsvScan,
  runOsvSbomScan,
  type ScanMode,
} from "../../osv/runner.js";
import type { ManifestTarget } from "../../utils/manifestFormats.js";

let binDir: string;
let projectDir: string;
/** runOsvScanには検出済みマニフェストの絶対パスを渡す */
let manifests: ManifestTarget[];

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
  manifests = [{ path: path.join(projectDir, "pom.xml"), format: "pom.xml" }];
  await writeFile(manifests[0]!.path, "<project/>");
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

describe("osv-scannerへの引数", () => {
  const modes: ScanMode[] = ["project", "artifact", "sbom"];

  it("どのモードでも --data-source native を使わない(pom.xmlの<repositories>の任意URLへ接続するため)", () => {
    for (const mode of modes) {
      for (const noRemoteResolution of [false, true]) {
        const args = buildOsvScanArgs(mode, noRemoteResolution);
        expect(args).not.toContain("native");
        const i = args.indexOf("--data-source");
        if (i !== -1) expect(args[i + 1]).toBe("deps.dev");
      }
    }
  });

  it("projectモードはdeps.devを明示し、指定時だけ --no-resolve を付ける", () => {
    expect(buildOsvScanArgs("project", false)).toEqual(
      ["scan", "source", "--format", "json", "--data-source", "deps.dev"],
    );
    expect(buildOsvScanArgs("project", true)).toContain("--no-resolve");
  });

  it("projectモードはディレクトリ(-r)を渡さない(requirements.txtの取り込みで範囲外を読むため)", () => {
    for (const noRemoteResolution of [false, true]) {
      expect(buildOsvScanArgs("project", noRemoteResolution)).not.toContain("-r");
    }
  });

  it("マニフェストは形式を明示して1件ずつ渡す", () => {
    expect(buildProjectTargetArgs([
      { path: "/p/pom.xml", format: "pom.xml" },
      { path: "/p/a/b/c/gradle.lockfile", format: "gradle.lockfile" },
      { path: "/p/odd:dir/buildscript-gradle.lockfile", format: "buildscript-gradle.lockfile" },
      { path: "/p/web/npm-shrinkwrap.json", format: "package-lock.json" },
      { path: "/p/py/requirements-dev.txt", format: "requirements.txt" },
    ])).toEqual([
      "--lockfile", "pom.xml:/p/pom.xml",
      "--lockfile", "gradle.lockfile:/p/a/b/c/gradle.lockfile",
      "--lockfile", "buildscript-gradle.lockfile:/p/odd:dir/buildscript-gradle.lockfile",
      "--lockfile", "package-lock.json:/p/web/npm-shrinkwrap.json",
      "--lockfile", "requirements.txt:/p/py/requirements-dev.txt",
    ]);
  });

  it.each([
    { path: "/p/package.json", format: "package.json" },
    { path: "/p/Cargo.lock", format: "Cargo.lock" },
    { path: "relative/pom.xml", format: "pom.xml" },
  ])("許可外の形式・相対パスは渡さない: $format:$path", (bad) => {
    expect(() => buildProjectTargetArgs([bad as ManifestTarget])).toThrow();
  });

  it("artifact/sbomモードには --no-resolve を付けない(外部解決を行わないため)", () => {
    for (const mode of ["artifact", "sbom"] as const) {
      expect(buildOsvScanArgs(mode, true)).toEqual(buildOsvScanArgs(mode, false));
    }
  });

  it.each([
    { env: undefined, option: undefined, expected: false },
    { env: "1", option: undefined, expected: true },
    { env: "TRUE", option: undefined, expected: true },
    { env: "0", option: undefined, expected: false },
    { env: "1", option: false, expected: false },
  ])("OSV_MCP_NO_REMOTE_RESOLUTION=$env, option=$option → --no-resolve: $expected", async ({ env, option, expected }) => {
    const argsFile = path.join(binDir, "recorded-args.txt");
    const bin = await makeFakeBinary("fake-args", `printf '%s\\n' "$@" > '${argsFile}'; echo '{"results":[]}'; exit 0`);
    const previous = process.env.OSV_MCP_NO_REMOTE_RESOLUTION;
    if (env === undefined) delete process.env.OSV_MCP_NO_REMOTE_RESOLUTION;
    else process.env.OSV_MCP_NO_REMOTE_RESOLUTION = env;
    try {
      await runOsvScan(manifests, { binaryPath: bin, noRemoteResolution: option });
    } finally {
      if (previous === undefined) delete process.env.OSV_MCP_NO_REMOTE_RESOLUTION;
      else process.env.OSV_MCP_NO_REMOTE_RESOLUTION = previous;
    }
    const recorded = (await readFile(argsFile, "utf8")).trim().split("\n");
    expect(recorded.includes("--no-resolve")).toBe(expected);
    expect(recorded.slice(-2)).toEqual(["--lockfile", `pom.xml:${manifests[0]!.path}`]);
    expect(recorded).not.toContain(projectDir);
  });
});

describe("runOsvScan", () => {
  it.each([false, true])("shares concurrency slots with SBOM scans (SBOM first: %s)", async (sbomFirst) => {
    const bin = await makeFakeBinary("fake-sbom-slot", `sleep 1; echo '{"results":[]}'; exit 0`);
    const opts = { binaryPath: bin, maxConcurrentScans: 1 };
    const sbomPath = path.join(projectDir, "input.cdx.json");
    const first = sbomFirst ? runOsvSbomScan(sbomPath, opts) : runOsvScan(manifests, opts);
    try {
      await expectScanError(sbomFirst ? runOsvScan(manifests, opts) : runOsvSbomScan(sbomPath, opts), "too_many_concurrent_scans");
    } finally {
      await first;
    }
  });

  it.each([false, true])("shares concurrency slots with artifact scans (artifact first: %s)", async (artifactFirst) => {
    const bin = await makeFakeBinary("fake-shared-slot", `sleep 1; echo '{"results":[]}'; exit 0`);
    const opts = { binaryPath: bin, maxConcurrentScans: 1 };
    const artifactPath = path.join(projectDir, "fixture.jar");
    const first = artifactFirst ? runOsvArtifactScan([artifactPath], opts) : runOsvScan(manifests, opts);
    try {
      await expectScanError(artifactFirst ? runOsvScan(manifests, opts) : runOsvArtifactScan([artifactPath], opts),
        "too_many_concurrent_scans");
    } finally {
      await first;
    }
  });

  it("exit 1(脆弱性あり)のJSONをレポートに変換する", async () => {
    const bin = await makeFakeBinary("fake-vulns", `echo '${VULN_JSON}'; exit 1`);
    const report = await runOsvScan(manifests, { binaryPath: bin });
    expect(report.vulnerability_count).toBe(1);
    expect(report.packages[0]!.vulnerabilities[0]!.cve).toBe("CVE-2020-1");
  });

  it("exit 0(脆弱性なし)は空レポートを返す", async () => {
    const bin = await makeFakeBinary("fake-clean", `echo '{"results":[]}'; exit 0`);
    const report = await runOsvScan(manifests, { binaryPath: bin });
    expect(report.vulnerability_count).toBe(0);
    expect(report.packages).toEqual([]);
  });

  it("exit 128はno_packages_found", async () => {
    const bin = await makeFakeBinary(
      "fake-nopkg",
      `echo 'No package sources found' >&2; exit 128`,
    );
    await expectScanError(runOsvScan(manifests, { binaryPath: bin }), "no_packages_found");
  });

  it("その他の終了コードはscan_failed(stderr抜粋をdetailに含む)", async () => {
    const bin = await makeFakeBinary("fake-fail", `echo 'something broke' >&2; exit 127`);
    const error = await expectScanError(runOsvScan(manifests, { binaryPath: bin }), "scan_failed");
    expect(error.detail).toContain("something broke");
  });

  it("JSONでない出力はinvalid_output", async () => {
    const bin = await makeFakeBinary("fake-notjson", `echo 'oops not json'; exit 0`);
    await expectScanError(runOsvScan(manifests, { binaryPath: bin }), "invalid_output");
  });

  it("タイムアウトでプロセスを打ち切りscan_timeout", async () => {
    const bin = await makeFakeBinary("fake-slow", `sleep 30; echo '{"results":[]}'`);
    await expectScanError(
      runOsvScan(manifests, { binaryPath: bin, timeoutMs: 300 }),
      "scan_timeout",
    );
  });

  it("出力サイズ上限を超えたらoutput_too_large", async () => {
    const bin = await makeFakeBinary(
      "fake-huge",
      `head -c 100000 /dev/zero | tr '\\0' 'a'; exit 0`,
    );
    await expectScanError(
      runOsvScan(manifests, { binaryPath: bin, maxOutputBytes: 10_000 }),
      "output_too_large",
    );
  });

  it("バイナリが起動できなければscan_failed", async () => {
    await expectScanError(
      runOsvScan(manifests, { binaryPath: path.join(binDir, "does-not-exist") }),
      "scan_failed",
    );
  });

  it("binaryPath省略時はOSV_SCANNER_PATH環境変数から解決する", async () => {
    const bin = await makeFakeBinary("env-resolved", `echo '{"results":[]}'; exit 0`);
    const previous = process.env[OSV_SCANNER_PATH_ENV];
    process.env[OSV_SCANNER_PATH_ENV] = bin;
    try {
      const report = await runOsvScan(manifests);
      expect(report.vulnerability_count).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[OSV_SCANNER_PATH_ENV];
      else process.env[OSV_SCANNER_PATH_ENV] = previous;
    }
  });

  it("シグナルで強制終了された場合もscan_failed(signal情報付き)", async () => {
    const bin = await makeFakeBinary("fake-killed", `kill -KILL $$`);
    const error = await expectScanError(runOsvScan(manifests, { binaryPath: bin }), "scan_failed");
    expect(error.message).toContain("SIGKILL");
  });

  it("同時実行数が上限に達したらtoo_many_concurrent_scansで即時エラー", async () => {
    const bin = await makeFakeBinary("fake-busy", `sleep 2; echo '{"results":[]}'; exit 0`);
    const first = runOsvScan(manifests, { binaryPath: bin, maxConcurrentScans: 1 });
    // 1件目が走っている間の2件目は待たされず即時エラーになる
    const error = await expectScanError(
      runOsvScan(manifests, { binaryPath: bin, maxConcurrentScans: 1 }),
      "too_many_concurrent_scans",
    );
    expect(error.message).toContain("limit (1)");
    await expect(first).resolves.toMatchObject({ vulnerability_count: 0 });
  }, 10_000);

  it("スキャン完了後(エラー時含む)はスロットが解放され再実行できる", async () => {
    const failing = await makeFakeBinary("fake-slot-fail", `echo 'boom' >&2; exit 127`);
    await expectScanError(
      runOsvScan(manifests, { binaryPath: failing, maxConcurrentScans: 1 }),
      "scan_failed",
    );
    const ok = await makeFakeBinary("fake-slot-ok", `echo '{"results":[]}'; exit 0`);
    const report = await runOsvScan(manifests, { binaryPath: ok, maxConcurrentScans: 1 });
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

  it("OSV_MCP_PREFER_DOWNLOAD=1ならPATH上のバイナリを使わず検証済みダウンロードを優先する", async () => {
    await makeFakeBinary("osv-scanner", `exit 0`);
    const env = {
      PATH: binDir, // PATH上に有効なバイナリがあってもスキップされる
      OSV_MCP_PREFER_DOWNLOAD: "1",
    } as NodeJS.ProcessEnv;
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

  it("PREFER_DOWNLOAD有効でもOSV_SCANNER_PATHの明示指定が最優先", async () => {
    const explicit = await makeFakeBinary("custom-scanner", `exit 0`);
    const env = {
      OSV_MCP_PREFER_DOWNLOAD: "1",
      [OSV_SCANNER_PATH_ENV]: explicit,
    } as NodeJS.ProcessEnv;
    let downloadCalled = false;
    const resolved = await resolveOsvScannerBinary(env, {
      downloadFn: async () => {
        downloadCalled = true;
        return "/cache/osv-scanner";
      },
    });
    expect(downloadCalled).toBe(false);
    expect(resolved).toBe(explicit);
  });

  it("PREFER_DOWNLOAD有効+AUTO_DOWNLOAD無効はPATHにフォールバックせずbinary_not_found", async () => {
    await makeFakeBinary("osv-scanner", `exit 0`);
    const env = {
      PATH: binDir,
      OSV_MCP_PREFER_DOWNLOAD: "1",
      OSV_MCP_AUTO_DOWNLOAD: "0",
    } as NodeJS.ProcessEnv;
    const error = await resolveOsvScannerBinary(env).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ScanToolError);
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
    expect(guidance).toContain("does not point to an executable file");
  });
});
