/**
 * osv-scannerに`--lockfile <形式>:<絶対パス>`で個別に渡せる解析形式(2.4.0で実機確認)。
 * ここに無い形式はosv-scannerに渡さない。npm-shrinkwrap.jsonは"package-lock.json"形式で解析する。
 */
export const MANIFEST_FORMATS = [
  "pom.xml",
  "gradle.lockfile",
  "buildscript-gradle.lockfile",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "pdm.lock",
  "requirements.txt",
  "go.mod",
] as const;

export type ManifestFormat = (typeof MANIFEST_FORMATS)[number];

const FORMAT_SET: ReadonlySet<string> = new Set(MANIFEST_FORMATS);

export function isManifestFormat(value: string): value is ManifestFormat {
  return FORMAT_SET.has(value);
}

/** osv-scannerに渡す1件。pathは検出済みの絶対パス */
export interface ManifestTarget {
  path: string;
  format: ManifestFormat;
}
