import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSbom } from "../../utils/sbomInput.js";

let root: string;
let file: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sbom-input-test-")));
  file = path.join(root, "arbitrary name.json");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("loadSbom", () => {
  it.each(["1.4", "1.5", "1.6"])("recognizes CycloneDX %s by content and hashes exact input bytes", async (version) => {
    const bytes = Buffer.from(JSON.stringify({ bomFormat: "CycloneDX", specVersion: version, components: [] }));
    await writeFile(file, bytes);
    const input = await loadSbom(file, { allowedRoot: root, maxInputBytes: bytes.length });
    expect(input).toMatchObject({ sourcePath: file, format: "CycloneDX", specVersion: version });
    expect(input.bytes).toEqual(bytes);
    expect(input.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it.each(["SPDX-2.2", "SPDX-2.3"])("recognizes %s", async (version) => {
    await writeFile(file, JSON.stringify({ spdxVersion: version, packages: [] }));
    expect(await loadSbom(file)).toMatchObject({ format: "SPDX", specVersion: version });
  });

  it.each([
    ["not json", "invalid_sbom"],
    ["<bom/>", "invalid_sbom"],
    ["null", "unsupported_sbom_format"],
    ['{"bomFormat":"CycloneDX","specVersion":"9.0","components":[]}', "unsupported_sbom_format"],
    ['{"spdxVersion":"SPDX-3.0","packages":[]}', "unsupported_sbom_format"],
    ['{"bomFormat":"CycloneDX","specVersion":"1.5"}', "invalid_sbom"],
    ['{"spdxVersion":"SPDX-2.3","packages":[null]}', "invalid_sbom"],
    ['{"bomFormat":"CycloneDX","specVersion":"1.5","components":[42]}', "invalid_sbom"],
    ['{"bomFormat":"CycloneDX","specVersion":"1.5","spdxVersion":"SPDX-2.3","components":[]}', "unsupported_sbom_format"],
  ])("rejects invalid documents: %s", async (body, kind) => {
    await writeFile(file, body);
    await expect(loadSbom(file)).rejects.toMatchObject({ kind });
  });

  it("rejects invalid UTF-8 and enforces bytes rather than character count", async () => {
    await writeFile(file, Buffer.from([0xff, 0xfe]));
    await expect(loadSbom(file)).rejects.toMatchObject({ kind: "invalid_sbom" });
    const json = JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [], name: "\u8106" });
    await writeFile(file, json);
    await expect(loadSbom(file, { maxInputBytes: Buffer.byteLength(json) - 1 })).rejects.toMatchObject({ kind: "sbom_too_large" });
  });

  it("rejects missing files, directories and relative paths", async () => {
    for (const input of [file, root, "relative.json", ""]) {
      await expect(loadSbom(input)).rejects.toMatchObject({ kind: "sbom_not_found" });
    }
  });

  it("rejects symlinks to files outside the allowed root", async () => {
    await mkdir(path.join(root, "allowed"));
    await writeFile(file, '{"spdxVersion":"SPDX-2.3","packages":[]}');
    const link = path.join(root, "allowed/sbom.json");
    await symlink(file, link);
    await expect(loadSbom(link, { allowedRoot: path.join(root, "allowed") })).rejects.toMatchObject({ kind: "path_outside_allowed_root" });
    await expect(loadSbom(link, { allowedRoot: root })).resolves.toMatchObject({ sourcePath: file });
  });
});
