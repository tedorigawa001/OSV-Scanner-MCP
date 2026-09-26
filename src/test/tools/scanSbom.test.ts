import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleScanSbom } from "../../tools/scanSbom.js";

let root: string;
let file: string;
let receipt: string;
const CDX = JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [] });
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sbom-tool-test-")));
  file = path.join(root, "sbom ' ; $(echo injected).json");
  receipt = path.join(root, "snapshot-path");
  await writeFile(file, CDX);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fake(script: string): Promise<string> {
  const binary = path.join(root, "scanner.cjs");
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');
    const snapshot = process.argv.at(-1);
    fs.writeFileSync(${JSON.stringify(receipt)}, snapshot);
    ${script}\n`);
  await chmod(binary, 0o755);
  return binary;
}

async function expectRemoved() {
  const snapshot = await readFile(receipt, "utf8");
  await expect(stat(path.dirname(snapshot))).rejects.toThrow();
}

describe("handleScanSbom", () => {
  it.each(["CycloneDX", "SPDX"])("scans a private %s snapshot with fixed SBOM-only flags", async (format) => {
    const body = format === "CycloneDX" ? CDX : JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [] });
    await writeFile(file, body);
    const binaryPath = await fake(`const assert = require('node:assert/strict');
      assert.deepEqual(process.argv.slice(2, -1), ['scan','source','--format','json','--all-packages','--no-ignore',
        '--experimental-no-default-plugins','--experimental-plugins','sbom']);
      assert(snapshot.endsWith(${JSON.stringify(format === "CycloneDX" ? "input.cdx.json" : "input.spdx.json")}));
      assert.equal(fs.readFileSync(snapshot, 'utf8'), ${JSON.stringify(body)});
      assert.equal(fs.statSync(snapshot).mode & 0o777, 0o600);
      assert.equal(fs.statSync(require('node:path').dirname(snapshot)).mode & 0o777, 0o700);
      console.log(JSON.stringify({results:[{source:{path:snapshot,type:'sbom'},packages:[{
        package:{name:'g:a',version:'1',ecosystem:'Maven'},groups:[{ids:['GHSA-test'],max_severity:'7.0'}]
      }]}]})); process.exit(1);`);
    const response = await handleScanSbom({ sbom_path: file }, { binaryPath, allowedRoot: root });
    expect(response.isError).toBeUndefined();
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.sbom).toMatchObject({ path: file, format });
    expect(payload.identified_vulnerability_count).toBe(1);
    expect(await readFile(file, "utf8")).toBe(body);
    await expectRemoved();
  });

  it("does not reread the original file after validation", async () => {
    const binaryPath = await fake(`fs.writeFileSync(${JSON.stringify(file)}, 'changed');
      require('node:assert/strict').equal(fs.readFileSync(snapshot,'utf8'), ${JSON.stringify(CDX)});
      console.log('{"results":[]}');`);
    const response = await handleScanSbom({ sbom_path: file }, { binaryPath });
    expect(response.isError).toBeUndefined();
    await expectRemoved();
  });

  it.each(["", '{"results":[]}'])("returns explicit no-identification coverage on exit 128 (%s)", async (output) => {
    const binaryPath = await fake(`process.stdout.write(${JSON.stringify(output)}); process.exit(128);`);
    const response = await handleScanSbom({ sbom_path: file }, { binaryPath });
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0]!.text).coverage.status).toBe("no_packages_identified");
    await expectRemoved();
  });

  it.each([
    { script: "process.exit(127)", kind: "scan_failed", opts: {} },
    { script: "console.log('not json')", kind: "invalid_output", opts: {} },
    { script: "console.log('{}')", kind: "invalid_output", opts: {} },
    { script: "console.log('x'.repeat(10000))", kind: "output_too_large", opts: { maxOutputBytes: 100 } },
    { script: "setTimeout(() => {}, 30000)", kind: "scan_timeout", opts: { timeoutMs: 1000 } },
  ])("cleans snapshots on $kind", async ({ script, kind, opts }) => {
    const binaryPath = await fake(script);
    const response = await handleScanSbom({ sbom_path: file }, { binaryPath, ...opts });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text).error.kind).toBe(kind);
    await expectRemoved();
  });

  it("rejects invalid and oversized input before spawning", async () => {
    const binaryPath = await fake("console.log('{\"results\":[]}')");
    let response = await handleScanSbom({ sbom_path: file }, { binaryPath, maxInputBytes: 1 });
    expect(JSON.parse(response.content[0]!.text).error.kind).toBe("sbom_too_large");
    await writeFile(file, "not json");
    response = await handleScanSbom({ sbom_path: file }, { binaryPath });
    expect(JSON.parse(response.content[0]!.text).error.kind).toBe("invalid_sbom");
    await expect(stat(receipt)).rejects.toThrow();
  });
});
