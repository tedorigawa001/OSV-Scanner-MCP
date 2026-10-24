/** Conservative subset of Composer's classical versions; branches and aliases are not releases.
 * https://github.com/composer/semver/blob/main/src/VersionParser.php
 * https://github.com/php/php-src/blob/master/ext/standard/versioning.c
 */
export interface ComposerVersion {
  parts: bigint[];
  stability: number;
  suffix: bigint[];
}

const STABILITY: Record<string, number> = { alpha: 0, a: 0, beta: 1, b: 1, rc: 2, stable: 3, patch: 4, pl: 4, p: 4 };

export function parseComposerVersion(version: string): ComposerVersion | null {
  if (version.length > 256) return null;
  const match = /^v?(\d{1,5}(?:\.\d+){0,3})(?:[._-]?(alpha|a|beta|b|RC|stable|patch|pl|p)((?:[.-]?\d+(?:[.-]\d+)*)?))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(version);
  if (!match) return null;
  const parts = match[1]!.split(".").map(BigInt);
  while (parts.length < 4) parts.push(0n);
  return {
    parts,
    stability: match[2] === undefined ? 3 : STABILITY[match[2].toLowerCase()]!,
    suffix: match[2]?.toLowerCase() === "stable" ? [] : (match[3] ?? "").replace(/^[.-]/, "").split(/[.-]/).filter(Boolean).map(BigInt),
  };
}

export function compareComposerVersions(a: string, b: string): number {
  const x = parseComposerVersion(a), y = parseComposerVersion(b);
  if (x === null || y === null) return 0;
  for (let i = 0; i < 4; i++) {
    if (x.parts[i] !== y.parts[i]) return x.parts[i]! < y.parts[i]! ? -1 : 1;
  }
  if (x.stability !== y.stability) return x.stability < y.stability ? -1 : 1;
  for (let i = 0; i < Math.max(x.suffix.length, y.suffix.length); i++) {
    // PHP version_compare treats even an extra zero component as greater.
    if (i >= x.suffix.length || i >= y.suffix.length) return i >= x.suffix.length ? -1 : 1;
    const left = x.suffix[i]!, right = y.suffix[i]!;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
