import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import { asRecord } from "./unknownJson.js";

export interface SbomInputOptions {
  allowedRoot?: string;
  maxInputBytes?: number;
}

export interface SbomInput {
  sourcePath: string;
  format: "CycloneDX" | "SPDX";
  specVersion: string;
  sha256: string;
  bytes: Buffer;
}

const DEFAULT_MAX_INPUT_BYTES = 16 * 1024 * 1024;
const CYCLONEDX_VERSIONS = new Set(["1.4", "1.5", "1.6"]);
const SPDX_VERSIONS = new Set(["SPDX-2.2", "SPDX-2.3"]);

export async function loadSbom(inputPath: string, options: SbomInputOptions = {}): Promise<SbomInput> {
  if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) {
    throw new ScanToolError("sbom_not_found", "Specify an absolute path to a JSON SBOM file");
  }
  let sourcePath: string;
  try {
    sourcePath = await realpath(inputPath);
  } catch {
    throw new ScanToolError("sbom_not_found", "The specified SBOM file does not exist");
  }
  if (options.allowedRoot !== undefined) {
    const root = await realpath(options.allowedRoot);
    const relative = path.relative(root, sourcePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ScanToolError("path_outside_allowed_root", "SBOM path is outside the allowed root");
    }
  }
  const maxBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Invalid SBOM size limit");
  const tooLarge = () => new ScanToolError("sbom_too_large", `SBOM input exceeds ${maxBytes} bytes`);
  let bytes: Buffer;
  try {
    // Nonblocking open avoids hanging on FIFOs. Refuse a leaf replaced by a symlink.
    const file = await open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new ScanToolError("sbom_not_found", "SBOM input must be a regular file");
      if (info.size > maxBytes) throw tooLarge();
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) throw tooLarge();
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }
      bytes = Buffer.concat(chunks, total);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ScanToolError) throw error;
    throw new ScanToolError("sbom_not_found", "The specified SBOM file could not be read");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ScanToolError("invalid_sbom", "SBOM input must be UTF-8 JSON; XML and tag-value formats are not supported");
  }
  const document = asRecord(raw);
  let format: SbomInput["format"];
  let specVersion: string;
  if (document?.bomFormat === "CycloneDX" && document.spdxVersion === undefined) {
    if (typeof document.specVersion !== "string" || !CYCLONEDX_VERSIONS.has(document.specVersion)) {
      throw new ScanToolError("unsupported_sbom_format", "Supported CycloneDX JSON versions: 1.4, 1.5, 1.6");
    }
    if (!Array.isArray(document.components) || document.components.some((item) => asRecord(item) === null)) {
      throw new ScanToolError("invalid_sbom", "CycloneDX input must contain a components array of objects");
    }
    format = "CycloneDX";
    specVersion = document.specVersion;
  } else if (typeof document?.spdxVersion === "string" && document.bomFormat === undefined) {
    if (!SPDX_VERSIONS.has(document.spdxVersion)) {
      throw new ScanToolError("unsupported_sbom_format", "Supported SPDX JSON versions: 2.2, 2.3");
    }
    if (!Array.isArray(document.packages) || document.packages.some((item) => asRecord(item) === null)) {
      throw new ScanToolError("invalid_sbom", "SPDX input must contain a packages array of objects");
    }
    format = "SPDX";
    specVersion = document.spdxVersion;
  } else {
    throw new ScanToolError("unsupported_sbom_format", "Expected a CycloneDX or SPDX JSON document");
  }
  return { sourcePath, format, specVersion, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
