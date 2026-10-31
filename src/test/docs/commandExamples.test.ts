/**
 * 公開文書の実行例が、個人環境のコマンドプロキシ(bdo)を前提にしないことを確認する。
 * 文書を書いた環境のhookでコマンドに付いたプレフィックスが混入したことがあるため(2026-10-31、2回)
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(full));
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

it("public documentation does not start commands with the personal bdo proxy", async () => {
  const offending: string[] = [];
  for (const file of [path.join(repoRoot, "README.md"), ...await markdownFiles(path.join(repoRoot, "docs"))]) {
    (await readFile(file, "utf8")).split("\n").forEach((line, index) => {
      // A command line (optionally after a shell prompt) beginning with bdo; mentions in prose are allowed.
      if (/^\s*(?:\$\s*)?bdo\s/.test(line)) offending.push(`${path.relative(repoRoot, file)}:${index + 1}`);
    });
  }
  expect(offending).toEqual([]);
});
