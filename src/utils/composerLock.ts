import { parseNpmLock, type NpmLockWorkBudget } from "./npmLockCopy.js";
import { parseComposerVersion } from "./composerVersion.js";
import { composerLinkNames, composerPackageName, type ComposerRelationPackage } from "./composerRelations.js";
import type { RelationLookup } from "./dependencyRelations.js";

export interface ComposerCopy { path: string; content: string; relations?: RelationLookup }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Only names and release versions reach OSV; repository URLs, scripts, and commit IDs are never forwarded. */
export function composerLockCopy(text: string, budget?: NpmLockWorkBudget): { content: string; issues: string[]; warnings: string[]; packageCount: number; localPackages: number; relationPackages: ComposerRelationPackage[] } {
  const data = parseNpmLock(text, budget);
  if (!record(data) || !Array.isArray(data.packages) || (data["packages-dev"] !== undefined && !Array.isArray(data["packages-dev"]))) {
    throw new Error("composer.lock must contain a packages array and an optional packages-dev array");
  }
  const issues: string[] = [];
  const warnings: string[] = [];
  const relationPackages: ComposerRelationPackage[] = [];
  let uncertainOrigin = 0;
  // dist.type=pathは自分のコード(monorepoのパッケージ)。Rustのlocal_crates・.NETのlocal_projectsと同じく数だけ返し、範囲の欠けにしない
  let localPackages = 0;
  const output: Record<string, { name: string; version: string }[]> = {};
  for (const group of ["packages", "packages-dev"] as const) {
    const packages: { name: string; version: string }[] = [];
    let skipped = 0;
    for (const raw of (data[group] ?? []) as unknown[]) {
      if (record(raw) && composerPackageName(raw.name)) {
        const provides = composerLinkNames(raw.provide), replaces = composerLinkNames(raw.replace);
        relationPackages.push({ name: raw.name, version: typeof raw.version === "string" ? raw.version : "",
          requires: composerLinkNames(raw.require), aliases: provides === null || replaces === null ? null : [...provides, ...replaces] });
      }
      if (record(raw) && record(raw.dist) && raw.dist.type === "path") {
        localPackages++;
        continue;
      }
      if (!record(raw) || !composerPackageName(raw.name) ||
          typeof raw.version !== "string" || parseComposerVersion(raw.version) === null) {
        skipped++;
        continue;
      }
      packages.push({ name: raw.name, version: raw.version });
      if (raw["notification-url"] !== "https://packagist.org/downloads/") uncertainOrigin++;
    }
    output[group] = packages;
    if (skipped > 0) issues.push(`${skipped} entries in ${group} were not scanned: invalid package names or non-release versions (branches, aliases, and dev versions are not evaluated)`);
  }
  if (uncertainOrigin > 0) warnings.push(`${uncertainOrigin} Composer package entries lack the standard Packagist notification URL. Their names and versions are sent to api.osv.dev as Packagist packages; private or forked packages may produce false positives. The notification URL is only a heuristic and does not prove origin`);
  return { content: JSON.stringify(output), issues, warnings, packageCount: output.packages!.length + output["packages-dev"]!.length, localPackages, relationPackages };
}
