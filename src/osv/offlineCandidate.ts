/** Query an exact release with the native offline matcher, using a private single-component SBOM. */
import {mkdtemp, realpath, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ScanToolError} from '../errors.js';
import {asRecord, asString} from '../utils/unknownJson.js';
import {SBOM_DIR_PREFIX, trackTempDir} from '../utils/processCleanup.js';
import {runOsvSbomScan, type RunOsvScanOptions} from './runner.js';
import {offlineMetadata, type OfflineDatabaseMetadata} from './offlineCache.js';
import {offlineConfig} from './offline.js';
import {samePackageName, versionSchemeFor} from './versionScheme.js';

const PURL_TYPES: Readonly<Record<string, string>> = Object.freeze({
  Maven: 'maven', npm: 'npm', PyPI: 'pypi', Go: 'golang', 'crates.io': 'cargo', Packagist: 'composer', NuGet: 'nuget',
});
const invalid = () => new ScanToolError('invalid_output', 'The local candidate scan did not identify and fully report the requested package version');
const changed = () => new ScanToolError('scan_failed', 'Offline database cache: candidate verification requires the same unexpired database snapshot as the project scan');

export function candidatePurl(ecosystem: string, name: string, version: string): string {
  const type = Object.hasOwn(PURL_TYPES, ecosystem) ? PURL_TYPES[ecosystem] : undefined;
  if (!type || !name || !version || name.length > 4096 || version.length > 512 || /[\x00-\x20\x7f]/.test(name + version)) throw invalid();
  const parts = ecosystem === 'Maven' ? name.split(':') : name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..') || (ecosystem === 'Maven' && parts.length !== 2)) throw invalid();
  return `pkg:${type}/${parts.map(p => encodeURIComponent(p)).join('/')}@${encodeURIComponent(version)}`;
}

/** Missing identification, mismatched sources or incomplete vulnerability details never mean clean. */
function recordsForCandidate(raw: unknown, file: string, ecosystem: string, name: string, version: string): Record<string, unknown>[] {
  const results = asRecord(raw)?.results;
  if (!Array.isArray(results)) throw invalid();
  let identified = 0;
  const records: Record<string, unknown>[] = [];
  for (const value of results) {
    const result = asRecord(value), source = asRecord(result?.source);
    if (source?.path !== file || source.type !== 'sbom' || !Array.isArray(result?.packages)) throw invalid();
    for (const item of result.packages) {
      const pkg = asRecord(item), info = asRecord(pkg?.package);
      const actualName = asString(info?.name), actualVersion = asString(info?.version), scheme = versionSchemeFor(ecosystem);
      if (info?.ecosystem !== ecosystem || actualName === null || !samePackageName(actualName, name, ecosystem) ||
          actualVersion === null || !scheme?.isValid(version) || !scheme.isValid(actualVersion) || scheme.compare(actualVersion, version) !== 0) throw invalid();
      identified++;
      const groups = pkg?.groups ?? [], vulns = pkg?.vulnerabilities ?? [];
      if (!Array.isArray(groups) || !Array.isArray(vulns)) throw invalid();
      const covered = new Set<string>();
      for (const value of vulns) {
        const record = asRecord(value), id = asString(record?.id);
        if (!record || !id || !Array.isArray(record.affected) || !record.affected.some(a => {
          const p = asRecord(asRecord(a)?.package);
          return p?.ecosystem === ecosystem && typeof p.name === 'string' && samePackageName(p.name, name, ecosystem);
        })) throw invalid();
        covered.add(id);
        if (record.aliases !== undefined && (!Array.isArray(record.aliases) || !record.aliases.every(a => typeof a === 'string'))) throw invalid();
        for (const alias of (record.aliases as string[] | undefined) ?? []) covered.add(alias);
        records.push(record);
      }
      for (const value of groups) {
        const ids = asRecord(value)?.ids;
        if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string' && covered.has(id))) throw invalid();
      }
    }
  }
  if (identified !== 1) throw invalid();
  return records;
}

export async function queryOfflineCandidate(
  ecosystem: string, name: string, version: string,
  options: RunOsvScanOptions, expected: OfflineDatabaseMetadata,
): Promise<Record<string, unknown>[]> {
  const selected = expected.databases.filter(d => d.ecosystem === ecosystem), config = offlineConfig({...options, offline: true});
  const assertFresh = () => {
    const now = Date.now();
    if (selected.length !== 1 || selected.some(d => now < Date.parse(d.downloaded_at) || now - Date.parse(d.downloaded_at) >= config.maxAgeMs)) throw changed();
  };
  assertFresh();
  const purl = candidatePurl(ecosystem, name, version);
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), SBOM_DIR_PREFIX)), untrack = trackTempDir(dir);
  try {
    const file = path.join(dir, 'candidate.cdx.json');
    await writeFile(file, JSON.stringify({bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
      components: [{type: 'library', name, version, purl}]}), {mode: 0o600, flag: 'wx'});
    const raw = await runOsvSbomScan(file, {...options, offline: true, noRemoteResolution: true}, [ecosystem]);
    const observed = typeof raw === 'object' && raw !== null ? offlineMetadata.get(raw) : undefined;
    if (!observed || JSON.stringify(observed.databases) !== JSON.stringify(selected)) throw changed();
    const records = recordsForCandidate(raw, file, ecosystem, name, version);
    assertFresh();
    return records;
  } finally {
    await rm(dir, {recursive: true, force: true});
    untrack();
  }
}
