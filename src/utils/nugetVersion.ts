/** NuGet VersionRelease ordering (not strict SemVer): four components,
 * case-insensitive prerelease labels, and ignored build metadata.
 * https://github.com/NuGet/NuGet.Client/blob/dev/src/NuGet.Core/NuGet.Versioning/VersionComparer.cs
 */
export interface NugetVersion { parts: number[]; prerelease: string[] }
const INT_MAX = 2_147_483_647;

export function parseNugetVersion(version: string): NugetVersion | null {
  if (version.length > 256) return null;
  const match = /^(\d{1,10}(?:\.\d{1,10}){0,3})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[0] !== version) return null;
  const parts = match[1]!.split(".").map(Number);
  if (parts.some(n => n > INT_MAX)) return null;
  while (parts.length < 4) parts.push(0);
  const prerelease = match[2]?.toLowerCase().split(".") ?? [];
  // NuGet rejects purely numeric release labels with leading zeroes.
  if (prerelease.some(label => /^0\d+$/.test(label))) return null;
  return { parts, prerelease };
}

export function compareNugetVersions(a: string, b: string): number {
  const x = parseNugetVersion(a), y = parseNugetVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 4; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i]! < y.parts[i]! ? -1 : 1;
  if (x.prerelease.length === 0 || y.prerelease.length === 0) {
    return x.prerelease.length === y.prerelease.length ? 0 : x.prerelease.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.min(x.prerelease.length, y.prerelease.length); i++) {
    const left = x.prerelease[i]!, right = y.prerelease[i]!;
    const numeric = (label: string) => /^-?\d+$/.test(label) && Number(label) >= -2_147_483_648 && Number(label) <= INT_MAX;
    const leftNumeric = numeric(left);
    const rightNumeric = numeric(right);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const l = leftNumeric ? Number(left) : left, r = rightNumeric ? Number(right) : right;
    if (l !== r) return l < r ? -1 : 1;
  }
  return Math.sign(x.prerelease.length - y.prerelease.length);
}
