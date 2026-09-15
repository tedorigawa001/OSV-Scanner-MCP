import { opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";

export interface DetectJavaArtifactsOptions {
  allowedRoot?: string;
  maxDepth?: number;
  maxArtifacts?: number;
  maxEntries?: number;
}

export interface DetectedJavaArtifacts {
  targetPath: string;
  artifactPaths: string[];
}

// Build output directories must be included for artifact scans.
const SKIPPED_DIRS = new Set([".git", "node_modules", ".idea", ".vscode"]);
const isArchive = (file: string) => /\.(jar|war)$/i.test(file);

export async function detectJavaArtifacts(
  inputPath: string,
  options: DetectJavaArtifactsOptions = {},
): Promise<DetectedJavaArtifacts> {
  if (typeof inputPath !== "string" || inputPath.trim() === "" || !path.isAbsolute(inputPath)) {
    throw new ScanToolError("project_not_found", "Specify an absolute JAR/WAR or directory path");
  }
  let targetPath: string;
  try {
    targetPath = await realpath(inputPath);
  } catch {
    throw new ScanToolError("project_not_found", `Path does not exist: ${inputPath}`);
  }
  if (options.allowedRoot !== undefined) {
    const root = await realpath(options.allowedRoot);
    const relative = path.relative(root, targetPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ScanToolError("path_outside_allowed_root", "Artifact path is outside the allowed root");
    }
  }
  const info = await stat(targetPath);
  if (info.isFile() && isArchive(targetPath)) return { targetPath, artifactPaths: [targetPath] };
  if (!info.isDirectory()) {
    throw new ScanToolError("no_scannable_artifacts", "The selected file is not a JAR/WAR archive");
  }

  const maxDepth = options.maxDepth ?? 8;
  const maxArtifacts = options.maxArtifacts ?? 100;
  const maxEntries = options.maxEntries ?? 10_000;
  const artifactPaths: string[] = [];
  let visited = 0;
  const limitError = () => new ScanToolError(
    "artifact_search_limit_exceeded",
    "Artifact discovery limit exceeded; select a smaller directory or an individual JAR/WAR",
  );
  async function walk(dir: string, depth: number): Promise<void> {
    const entries = await opendir(dir);
    for await (const entry of entries) {
      if (++visited > maxEntries) throw limitError();
      const child = path.join(dir, entry.name);
      if (entry.isFile() && isArchive(entry.name)) {
        if (artifactPaths.length >= maxArtifacts) throw limitError();
        artifactPaths.push(child);
      } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
        if (depth >= maxDepth) throw limitError();
        await walk(child, depth + 1);
      }
      // Dirent predicates do not follow symlinks. Never hand these to the scanner.
    }
  }
  await walk(targetPath, 1);
  if (artifactPaths.length === 0) {
    throw new ScanToolError("no_scannable_artifacts", "No JAR/WAR archives found in the selected directory");
  }
  return { targetPath, artifactPaths: artifactPaths.sort() };
}
