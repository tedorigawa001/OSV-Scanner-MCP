import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleScanJavaArtifact } from "../../tools/scanJavaArtifact.js";

let root: string;
let archive: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "artifact-tool-")));
  archive = path.join(root, "a ' ; $(echo injected).jar");
  await writeFile(archive, "fixture");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fake(script: string): Promise<string> {
  const file = path.join(root, "scanner.cjs");
  await writeFile(file, `#!${process.execPath}\n${script}\n`);
  await chmod(file, 0o755);
  return file;
}

describe("handleScanJavaArtifact", () => {
  it("passes exact files with fixed archive-only flags without a shell", async () => {
    const expected = ["scan", "source", "--format", "json", "--all-packages", "--no-ignore",
      "--experimental-no-default-plugins", "--experimental-plugins", "java/archive", archive];
    const raw = { results: [{ source: { path: archive, type: "artifact" }, packages: [
      { package: { name: "g:a", version: "1", ecosystem: "Maven" } },
    ] }] };
    const binaryPath = await fake(`require('node:assert/strict').deepEqual(process.argv.slice(2), ${JSON.stringify(expected)});
      console.log(${JSON.stringify(JSON.stringify(raw))});`);
    const response = await handleScanJavaArtifact({ artifact_path: root }, { binaryPath, allowedRoot: root });
    expect(response.isError).toBeUndefined();
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.coverage).toMatchObject({ jars_found: 1, jars_identified: 1, completeness: "incomplete" });
  });

  it.each(["", '{"results":[]}'])("maps exit 128 to unidentified coverage (stdout: %s)", async (output) => {
    const binaryPath = await fake(`process.stdout.write(${JSON.stringify(output)}); process.exit(128);`);
    const response = await handleScanJavaArtifact({ artifact_path: archive }, { binaryPath });
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0]!.text).coverage.jars_identified).toBe(0);
  });

  it.each([[127, '{"results":[]}', "scan_failed"], [0, "not json", "invalid_output"],
    [0, "{}", "invalid_output"], [128, "not json", "invalid_output"]])(
    "does not hide failed scans (%s)", async (code, output, kind) => {
      const binaryPath = await fake(`process.stdout.write(${JSON.stringify(output)}); process.exit(${code});`);
      const response = await handleScanJavaArtifact({ artifact_path: archive }, { binaryPath });
      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0]!.text).error.kind).toBe(kind);
    },
  );

  it("enforces output and timeout limits on artifact scans", async () => {
    let binaryPath = await fake("process.stdout.write('x'.repeat(2000));");
    let response = await handleScanJavaArtifact({ artifact_path: archive }, { binaryPath, maxOutputBytes: 100 });
    expect(JSON.parse(response.content[0]!.text).error.kind).toBe("output_too_large");
    binaryPath = await fake("setTimeout(() => {}, 30000);");
    response = await handleScanJavaArtifact({ artifact_path: archive }, { binaryPath, timeoutMs: 200 });
    expect(JSON.parse(response.content[0]!.text).error.kind).toBe("scan_timeout");
  });

  it("rejects out-of-scope paths before starting the scanner", async () => {
    await mkdir(path.join(root, "scanner-root"));
    const response = await handleScanJavaArtifact({ artifact_path: archive }, {
      binaryPath: "/not-executed", allowedRoot: path.join(root, "scanner-root"),
    });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text).error.kind).toBe("path_outside_allowed_root");
  });
});
