import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compareHistoryRecords } from "../../history/historyDiff.js";
import { buildHistoryRecord, parseHistoryRecord, serializeHistoryRecord, type HistoryRecord, type RecordContext } from "../../history/historyRecord.js";
import { withHistory } from "../../history/historyRecorder.js";
import {
  defaultHistoryDir,
  ensureHistoryDir,
  historyConfigFromEnv,
  HistoryUnavailableError,
  newRecordId,
  pruneHistory,
  readHistoryRecords,
  writeHistoryRecord,
  type HistoryConfig,
} from "../../history/historyStore.js";
import { handleScanHistory } from "../../tools/scanHistory.js";
import { jsonResult } from "../../tools/toolResult.js";
import { permissionModelWarnings } from "../../utils/permissionCheck.js";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-hist-")));
  tempDirs.push(dir);
  return dir;
}

function config(dir: string, overrides: Partial<HistoryConfig> = {}): HistoryConfig {
  return { enabled: true, dir, maxEntries: 500, maxTotalBytes: 100 * 1024 * 1024, ...overrides };
}

function context(overrides: Partial<RecordContext> = {}): RecordContext {
  return {
    id: newRecordId(new Date("2026-10-23T01:00:00.000Z")),
    startedAt: new Date("2026-10-23T01:00:00.000Z"),
    durationMs: 1234.4,
    tool: "scan_project",
    serverVersion: "0.15.0",
    pinnedScannerVersion: "2.7.0",
    scannerSource: "pinned_download",
    inputPath: "/work/app",
    resolvedInput: "/work/app",
    allowedRootSet: true,
    ...overrides,
  };
}

const vuln = (id: string, aliases: string[] = [], informational?: string) => ({ id, aliases, ...(informational ? { informational } : {}) });
const pkg = (name: string, version: string, vulns: ReturnType<typeof vuln>[], ecosystem = "npm") => ({ ecosystem, name, version, vulnerabilities: vulns });

function scanPayload(packages: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    project_dir: "/work/app",
    coverage: { complete: true, manifests: [{ path: "package-lock.json", ecosystem: "npm", format: "package-lock.json" }], lockfile_missing: [], skipped_files: [] },
    vulnerable_package_count: packages.length,
    vulnerability_count: 3,
    severity_breakdown: { critical: 1, high: 2, medium: 0, low: 0, unknown: 0 },
    packages,
    ...extra,
  });
}

describe("historyConfigFromEnv", () => {
  it.each([
    [{}, false],
    [{ OSV_MCP_HISTORY: "1" }, true],
    [{ OSV_MCP_HISTORY: " TRUE " }, true],
    [{ OSV_MCP_HISTORY: "yes" }, true],
    [{ OSV_MCP_HISTORY: "0" }, false],
  ])("既定は無効で、明示した場合だけ有効(%o)", (env, enabled) => {
    expect(historyConfigFromEnv(env).enabled).toBe(enabled);
  });

  it("保存先: OSV_MCP_HISTORY_DIR(絶対パスのみ) → XDG_STATE_HOME → ~/.local/state", () => {
    expect(historyConfigFromEnv({ OSV_MCP_HISTORY_DIR: "/data/h" }).dir).toBe("/data/h");
    expect(historyConfigFromEnv({ OSV_MCP_HISTORY_DIR: "relative/h", XDG_STATE_HOME: "/state" }).dir).toBe("/state/osv-scanner-mcp/history");
    expect(defaultHistoryDir({ XDG_STATE_HOME: "relative" })).toBe(path.join(os.homedir(), ".local", "state", "osv-scanner-mcp", "history"));
  });

  it("保持件数は正の整数だけを受け付け、上限で頭打ちにする", () => {
    expect(historyConfigFromEnv({ OSV_MCP_HISTORY_MAX_ENTRIES: "20" }).maxEntries).toBe(20);
    expect(historyConfigFromEnv({ OSV_MCP_HISTORY_MAX_ENTRIES: "-1" }).maxEntries).toBe(500);
    expect(historyConfigFromEnv({ OSV_MCP_HISTORY_MAX_ENTRIES: "999999" }).maxEntries).toBe(5000);
  });
});

describe("historyStore", () => {
  it("1回=1ファイルで0600、ディレクトリは0700、一時ファイルを残さない", async () => {
    const dir = path.join(await tempDir(), "h");
    const id = newRecordId();
    await writeHistoryRecord(config(dir), id, "{}");
    expect(await readdir(dir)).toEqual([`${id}.json`]);
    expect((await stat(path.join(dir, `${id}.json`))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("権限の広い既存のディレクトリは0700に絞る", async () => {
    const dir = await tempDir();
    await chmod(dir, 0o755);
    await ensureHistoryDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("シンボリックリンクの保存先には書かない", async () => {
    const base = await tempDir();
    await mkdir(path.join(base, "real"));
    await symlink(path.join(base, "real"), path.join(base, "link"));
    await expect(ensureHistoryDir(path.join(base, "link"))).rejects.toBeInstanceOf(HistoryUnavailableError);
  });

  it("同時に書いても混ざらない(1件ずつ別のファイル)", async () => {
    const dir = await tempDir();
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeHistoryRecord(config(dir), newRecordId(), JSON.stringify({ n: i }))));
    const { records, skipped } = await readHistoryRecords(config(dir));
    expect([records.length, skipped]).toEqual([40, 0]);
  });

  it("件数・合計サイズの上限を超えた古いものと、古い一時ファイルを削除する", async () => {
    const dir = await tempDir();
    const ids = Array.from({ length: 5 }, (_, i) => newRecordId(new Date(Date.UTC(2026, 9, 23, 0, 0, i))));
    for (const id of ids) await writeFile(path.join(dir, `${id}.json`), "x".repeat(100));
    const staleTmp = path.join(dir, `.${ids[0]}.json.tmp`);
    await writeFile(staleTmp, "partial");
    await utimes(staleTmp, new Date(0), new Date(0));
    await pruneHistory(config(dir, { maxEntries: 4, maxTotalBytes: 250 }));
    // 件数で最古の1件、合計サイズ(250バイト)で残り4件のうち古い2件を削除
    expect((await readdir(dir)).sort()).toEqual([`${ids[3]}.json`, `${ids[4]}.json`]);
  });

  it("読み出し: 新しい順。名前の形式が違うもの・壊れたJSON・大きすぎるものは読まない・数える", async () => {
    const dir = await tempDir();
    const older = newRecordId(new Date(Date.UTC(2026, 9, 1)));
    const newer = newRecordId(new Date(Date.UTC(2026, 9, 2)));
    const broken = newRecordId(new Date(Date.UTC(2026, 9, 3)));
    const huge = newRecordId(new Date(Date.UTC(2026, 9, 4)));
    await writeFile(path.join(dir, `${older}.json`), '{"a":1}');
    await writeFile(path.join(dir, `${newer}.json`), '{"a":2}');
    await writeFile(path.join(dir, `${broken}.json`), "{");
    await writeFile(path.join(dir, `${huge}.json`), "x".repeat(1024 * 1024 + 1));
    await writeFile(path.join(dir, "notes.json"), "{}");
    const { records, skipped } = await readHistoryRecords(config(dir));
    expect(records.map((r) => r.id)).toEqual([newer, older]);
    expect(skipped).toBe(2);
  });
});

describe("buildHistoryRecord / parseHistoryRecord", () => {
  it("scan_projectの応答から要約と差分用の識別子だけを取り出す", () => {
    const record = buildHistoryRecord(context(), scanPayload([
      pkg("lodash", "4.17.20", [vuln("GHSA-a", ["CVE-1"]), vuln("GHSA-b")]),
      pkg("atty", "0.2.14", [vuln("RUSTSEC-1", [], "unmaintained")], "crates.io"),
    ], { informational_count: 1 }), false);
    expect(record).toMatchObject({
      schema: 1, status: "ok", kind: "project", coverage_complete: true, duration_ms: 1234,
      target: { input: "/work/app", resolved: "/work/app" },
      osv_scanner: { pinned_version: "2.7.0", source: "pinned_download" },
      manifests: [{ path: "package-lock.json", ecosystem: "npm", format: "package-lock.json" }],
      coverage_gaps: { lockfile_missing: 0, skipped_files: 0 },
      counts: { vulnerable_package_count: 2, vulnerability_count: 3, informational_count: 1, severity_breakdown: { critical: 1, high: 2 } },
    });
    expect(record.findings).toEqual([
      pkg("lodash", "4.17.20", [vuln("GHSA-a", ["CVE-1"]), vuln("GHSA-b")]),
      pkg("atty", "0.2.14", [vuln("RUSTSEC-1", [], "unmaintained")], "crates.io"),
    ]);
    expect(JSON.stringify(record)).not.toContain("summary");
  });

  it("suggest_fix: 推奨版も記録し、CVEを別名に含める", () => {
    const record = buildHistoryRecord(context({ tool: "suggest_fix" }), JSON.stringify({
      project_dir: "/work/app", coverage: { complete: false }, vulnerable_package_count: 1,
      suggestions: [{ package: "lodash", current_version: "4.17.20", ecosystem: "npm", recommended_upgrade: "4.18.0", upgrade_tier: "major_internal", verification: "verified",
        per_cve_detail: [{ id: "GHSA-a", cve: "CVE-1", tier: "major_internal" }, { id: "RUSTSEC-x", informational: "unmaintained" }] }],
    }), false);
    expect(record).toMatchObject({ kind: "project", coverage_complete: false, counts: { vulnerability_count: 1 } });
    expect(record.findings).toEqual([{ ecosystem: "npm", name: "lodash", version: "4.17.20", recommended_upgrade: "4.18.0", upgrade_tier: "major_internal", verification: "verified",
      vulnerabilities: [vuln("GHSA-a", ["CVE-1"]), vuln("RUSTSEC-x", [], "unmaintained")] }]);
  });

  it("エラーは種類だけを記録し、メッセージは残さない", () => {
    const record = buildHistoryRecord(context(), JSON.stringify({ error: { kind: "no_manifest_found", message: "secret /path" } }), true);
    expect(record).toMatchObject({ status: "error", error_kind: "no_manifest_found", coverage_complete: null });
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("scan_sbom・scan_java_artifactの件数のフィールド名も読む", () => {
    const record = buildHistoryRecord(context({ tool: "scan_sbom", inputPath: "/work/bom.json", resolvedInput: "/work/bom.json" }), JSON.stringify({
      coverage: { identified_package_count: 3, unidentified_packages: [{}, {}] }, identified_vulnerability_count: 2, identified_vulnerable_package_count: 1, packages: [],
    }), false);
    expect(record).toMatchObject({ kind: "sbom", target: { resolved: "/work/bom.json" }, coverage_gaps: { unidentified_packages: 2 }, counts: { vulnerability_count: 2, vulnerable_package_count: 1 } });
  });

  it("1件の上限を超える場合は差分用の識別子を省き、要約だけを保存する", () => {
    const many = Array.from({ length: 3000 }, (_, i) => pkg(`p${i}`, "1.0.0", [vuln(`GHSA-${"x".repeat(300)}-${i}`)]));
    const record = buildHistoryRecord(context(), scanPayload(many), false);
    const saved = JSON.parse(serializeHistoryRecord(record)) as HistoryRecord;
    expect(saved.findings).toBeUndefined();
    expect(saved.findings_omitted).toBe(true);
    expect(saved.counts).toBeDefined();
  });

  it("findingsを省いても超える場合はマニフェストの一覧を減らし、保存したものは必ず読み戻せる", async () => {
    // 長いパス(多バイト文字)のマニフェスト1,000件: findingsを省くだけでは1MiBを超える
    const manifests = Array.from({ length: 1000 }, (_, i) => ({ path: `${"あ".repeat(500)}/${i}/package-lock.json`, ecosystem: "npm", format: "package-lock.json" }));
    const record = buildHistoryRecord(context(), scanPayload([pkg("a", "1", [vuln("X")])], { coverage: { complete: true, manifests } }), false);
    const { findings: _f, ...summaryOnly } = record;
    expect(Buffer.byteLength(JSON.stringify(summaryOnly))).toBeGreaterThan(1024 * 1024);
    const text = serializeHistoryRecord(record);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024);
    const dir = await tempDir();
    await writeHistoryRecord(config(dir), record.id, text);
    const { records, skipped } = await readHistoryRecords(config(dir));
    expect(skipped).toBe(0);
    const saved = parseHistoryRecord(record.id, records[0]!.data)!;
    expect(saved).toMatchObject({ findings_omitted: true, manifests_truncated: true });
    expect(saved.manifests!.length).toBeGreaterThan(0);
    expect(saved.manifests!.length).toBeLessThan(1000);
  });

  it("非常に長い入力パスで失敗した回も上限に収め、読み戻せる(パスは切り詰めて印を付ける)", async () => {
    const huge = `/${"a".repeat(600_000)}`;
    const record = buildHistoryRecord(context({ inputPath: huge, resolvedInput: huge }), JSON.stringify({ error: { kind: "project_not_found", message: "x" } }), true);
    expect(record).toMatchObject({ status: "error", target_truncated: true });
    expect(record.target.input).toHaveLength(4096);
    const text = serializeHistoryRecord(record);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024);
    const dir = await tempDir();
    await writeHistoryRecord(config(dir), record.id, text);
    const { records, skipped } = await readHistoryRecords(config(dir));
    expect(skipped).toBe(0);
    expect(parseHistoryRecord(record.id, records[0]!.data)).toMatchObject({ target_truncated: true, target: { input: record.target.input } });
  });

  it("512文字を超える実在しうるパスは切り詰めずに保存し、読み戻しても一致する", () => {
    const long = `/work/${"d".repeat(1500)}/app`;
    const record = buildHistoryRecord(context({ inputPath: long, resolvedInput: long }), scanPayload([], { project_dir: long }), false);
    const saved = parseHistoryRecord(record.id, JSON.parse(serializeHistoryRecord(record)))!;
    expect(saved.target).toEqual({ input: long, resolved: long });
    expect(saved.target_truncated).toBeUndefined();
  });

  it("どうしても上限に収まらない記録は書かずに例外にする(記録側が警告する)", () => {
    const record = { ...buildHistoryRecord(context(), scanPayload([]), false), server_version: "x".repeat(2 * 1024 * 1024) };
    expect(() => serializeHistoryRecord(record)).toThrow("size limit");
  });

  it("記録する文字列は作成時に無害化し、長さを抑える", () => {
    const record = buildHistoryRecord(context(), scanPayload([pkg(`evil\u202e${"n".repeat(1000)}`, "1\u0007", [vuln("X\u200b")])]), false);
    const [f] = record.findings!;
    expect([f!.name.length, f!.name.includes("\u202e"), f!.version, f!.vulnerabilities[0]!.id]).toEqual([512, false, "1", "X"]);
  });

  it("深刻度別の件数のキーの数を抑える", () => {
    const severity = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
    const record = buildHistoryRecord(context(), scanPayload([], { severity_breakdown: severity }), false);
    expect(Object.keys(record.counts!.severity_breakdown!)).toHaveLength(16);
  });

  it("パッケージ数の上限を超えたら打ち切り、その旨を記録する", () => {
    const many = Array.from({ length: 5001 }, (_, i) => pkg(`p${i}`, "1.0.0", [vuln(`G-${i}`)]));
    const record = buildHistoryRecord(context(), scanPayload(many), false);
    expect([record.findings!.length, record.findings_truncated]).toEqual([5000, true]);
  });

  it.each([
    ["IDの不一致", (r: Record<string, unknown>) => ({ ...r, id: "other" })],
    ["未知のツール", (r: Record<string, unknown>) => ({ ...r, tool: "rm_rf" })],
    ["schemaが違う", (r: Record<string, unknown>) => ({ ...r, schema: 2 })],
    ["対象が無い", (r: Record<string, unknown>) => ({ ...r, target: null })],
  ])("読み出し時に形式を確かめる(%s)", (_label, mutate) => {
    const record = buildHistoryRecord(context(), scanPayload([]), false);
    expect(parseHistoryRecord(record.id, mutate(JSON.parse(JSON.stringify(record)) as Record<string, unknown>))).toBeNull();
    expect(parseHistoryRecord(record.id, JSON.parse(JSON.stringify(record)))).toMatchObject({ id: record.id, status: "ok" });
  });
});

describe("compareHistoryRecords", () => {
  const run = (packages: unknown[], overrides: Partial<RecordContext> = {}, extra: Record<string, unknown> = {}) =>
    buildHistoryRecord(context(overrides), scanPayload(packages, extra), false);

  it("新規・解消の理由・版の変化・版が変わっても残る脆弱性を分ける", () => {
    const older = run([
      pkg("lodash", "4.17.20", [vuln("GHSA-keep"), vuln("GHSA-fixed")]),
      pkg("minimist", "0.0.8", [vuln("GHSA-gone")]),
      pkg("qs", "6.7.0", [vuln("GHSA-qs"), vuln("GHSA-withdrawn")]),
    ]);
    const newer = run([
      pkg("lodash", "4.17.21", [vuln("GHSA-keep")]),
      pkg("qs", "6.7.0", [vuln("GHSA-qs")]),
      pkg("express", "4.17.1", [vuln("GHSA-new")]),
    ]);
    const changes = compareHistoryRecords(older, newer);
    expect(changes.new_vulnerabilities.map((v) => `${v.name}@${v.version} ${v.id}`)).toEqual(["express@4.17.1 GHSA-new"]);
    expect(changes.resolved_vulnerabilities.map((v) => [v.name, v.id, v.reason])).toEqual([
      ["lodash", "GHSA-fixed", "version_changed"],
      ["minimist", "GHSA-gone", "package_not_reported"],
      ["qs", "GHSA-withdrawn", "same_version_not_reported"],
    ]);
    expect(changes.resolved_vulnerabilities[0]!.current_versions).toEqual(["4.17.21"]);
    expect(changes.version_changes).toEqual([{ ecosystem: "npm", name: "lodash", from: ["4.17.20"], to: ["4.17.21"], still_affected: 1 }]);
    expect(changes.incomplete).toBeUndefined();
  });

  it("代表IDが入れ替わっても、別名が重なれば同じ脆弱性とみなす", () => {
    const changes = compareHistoryRecords(run([pkg("a", "1", [vuln("GHSA-x", ["CVE-1"])])]), run([pkg("a", "1", [vuln("CVE-1", ["GHSA-y"])])]));
    expect([changes.new_vulnerabilities, changes.resolved_vulnerabilities]).toEqual([[], []]);
  });

  it("同名でもエコシステムが違えば別のパッケージ", () => {
    const changes = compareHistoryRecords(run([pkg("a", "1", [vuln("X")], "npm")]), run([pkg("a", "1", [vuln("X")], "PyPI")]));
    expect([changes.new_vulnerabilities.length, changes.resolved_vulnerabilities[0]?.reason]).toEqual([1, "package_not_reported"]);
  });

  it("範囲の変化(completeとマニフェストの増減)を示す", () => {
    const older = run([]);
    const newer = run([], {}, { coverage: { complete: false, manifests: [{ path: "go.mod", ecosystem: "Go", format: "go.mod" }] } });
    expect(compareHistoryRecords(older, newer).coverage_changes).toEqual({
      complete: { from: true, to: false }, manifests_added: ["go.mod"], manifests_removed: ["package-lock.json"],
    });
  });

  it("識別子を省いた・打ち切った回を含む場合は不完全と示す", () => {
    const omitted = { ...run([]), findings: undefined, findings_omitted: true as const };
    expect(compareHistoryRecords(omitted, run([])).incomplete).toContain("no recorded findings");
    expect(compareHistoryRecords({ ...run([]), findings_truncated: true }, run([])).incomplete).toContain("findings limit");
  });

  it("マニフェストの一覧を省いた回を含む場合は、マニフェストの増減を示さず不完全と示す", () => {
    const changes = compareHistoryRecords({ ...run([]), manifests: [], manifests_truncated: true }, run([]));
    expect(changes.coverage_changes.manifests_removed).toBeUndefined();
    expect(changes.incomplete).toContain("manifest list");
  });

  it("件数が上限近くでも、照合は件数に比例する時間で終わる", () => {
    // 1パッケージに2万件ずつ(重なりなし・別名あり): 総当たりでは数秒かかる
    const many = (prefix: string) => [pkg("big", "1", Array.from({ length: 20_000 }, (_, i) => vuln(`${prefix}-${i}`, [`${prefix}-CVE-${i}`])))];
    const older = run(many("OLD"));
    const newer = run(many("NEW"));
    const started = performance.now();
    const changes = compareHistoryRecords(older, newer);
    expect(performance.now() - started).toBeLessThan(1000);
    expect([changes.new_vulnerabilities.length, changes.resolved_vulnerabilities.length]).toEqual([500, 500]);
    expect(changes.incomplete).toContain("first 500 entries");
  });
});

describe("withHistory", () => {
  it("無効なら何も書かない", async () => {
    const dir = path.join(await tempDir(), "h");
    const result = await withHistory("scan_project", "/work/app", async () => jsonResult({ ok: true }), { config: config(dir, { enabled: false }), serverVersion: "0", allowedRootSet: false });
    expect(result).toEqual(jsonResult({ ok: true }));
    await expect(stat(dir)).rejects.toThrow();
  });

  it("記録に失敗してもスキャンの結果は変えず、警告だけを出す", async () => {
    const base = await tempDir();
    await mkdir(path.join(base, "real"));
    await symlink(path.join(base, "real"), path.join(base, "link"));
    const warnings: string[] = [];
    const response = jsonResult({ project_dir: "/x", packages: [] });
    const result = await withHistory("scan_project", "/x", async () => response,
      { config: config(path.join(base, "link")), serverVersion: "0", allowedRootSet: false, warn: (m) => warnings.push(m) });
    expect(result).toBe(response);
    expect(warnings[0]).toContain("could not be recorded");
    expect(await readdir(path.join(base, "real"))).toEqual([]);
  });

  it("有効なら1件記録する(入力のパスの実パスを対象にする)", async () => {
    const base = await tempDir();
    const dir = path.join(base, "h");
    await withHistory("scan_sbom", path.join(base, ".", "bom.json"), async () => jsonResult({ error: { kind: "sbom_not_found", message: "x" } }, true),
      { config: config(dir), serverVersion: "0.15.0", allowedRootSet: true, env: { OSV_SCANNER_PATH: "/bin/osv" } });
    const [name] = await readdir(dir);
    const saved = JSON.parse(await readFile(path.join(dir, name!), "utf8")) as HistoryRecord;
    expect(saved).toMatchObject({ tool: "scan_sbom", status: "error", error_kind: "sbom_not_found", osv_scanner: { source: "OSV_SCANNER_PATH" }, target: { resolved: path.join(base, "bom.json") } });
  });
});

describe("handleScanHistory", () => {
  async function seed(dir: string, records: HistoryRecord[]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const r of records) await writeFile(path.join(dir, `${r.id}.json`), JSON.stringify(r));
  }
  const at = (minute: number, overrides: Partial<RecordContext> = {}, packages: unknown[] = []) => {
    const date = new Date(Date.UTC(2026, 9, 23, 1, minute));
    return buildHistoryRecord(context({ id: newRecordId(date), startedAt: date, ...overrides }), scanPayload(packages), false);
  };
  const payload = (result: Awaited<ReturnType<typeof handleScanHistory>>) => JSON.parse(result.content[0]!.text) as Record<string, any>;

  it("無効ならhistory_disabled(有効化の方法を示す)", async () => {
    const p = payload(await handleScanHistory({}, { config: config(await tempDir(), { enabled: false }) }));
    expect(p.error).toMatchObject({ kind: "history_disabled", message: expect.stringContaining("OSV_MCP_HISTORY=1") });
  });

  it("一覧は新しい順、project_pathで絞り込み、直近の成功した2回を比べる", async () => {
    const dir = await tempDir();
    await seed(dir, [
      at(1, {}, [pkg("a", "1", [vuln("X")])]),
      at(2, { tool: "suggest_fix" }, []),
      at(3, { inputPath: "/work/other", resolvedInput: "/work/other" }),
    ]);
    // 3件目のproject_dirは応答の"/work/app"ではなく別の対象にする
    const other = JSON.parse(await readFile(path.join(dir, (await readdir(dir)).sort()[2]!), "utf8")) as HistoryRecord;
    other.target.resolved = "/work/other";
    await writeFile(path.join(dir, `${other.id}.json`), JSON.stringify(other));
    const all = payload(await handleScanHistory({}, { config: config(dir) }));
    expect(all.runs.map((r: { target: string }) => r.target)).toEqual(["/work/other", "/work/app", "/work/app"]);
    expect(all.changes).toBeUndefined();
    const app = payload(await handleScanHistory({ project_path: "/work/app" }, { config: config(dir) }));
    expect(app.history.recorded_runs).toBe(2);
    expect(app.changes).toEqual([expect.objectContaining({ kind: "project", resolved_vulnerabilities: [expect.objectContaining({ id: "X", reason: "package_not_reported" })] })]);
  });

  it("成功した回が2回未満なら比較できない旨を示す", async () => {
    const dir = await tempDir();
    await seed(dir, [at(1)]);
    const p = payload(await handleScanHistory({ project_path: "/work/app" }, { config: config(dir) }));
    expect(p.changes).toEqual([{ kind: "project", note: expect.stringContaining("Fewer than two") }]);
  });

  it("比較には失敗した回を使わない(直近の成功した2回を比べる)", async () => {
    const dir = await tempDir();
    const failed = buildHistoryRecord(context({ id: newRecordId(new Date(Date.UTC(2026, 9, 23, 1, 2))), startedAt: new Date(Date.UTC(2026, 9, 23, 1, 2)) }),
      JSON.stringify({ error: { kind: "scanner_failed", message: "x" } }), true);
    failed.target.resolved = "/work/app";
    const first = at(1, {}, [pkg("a", "1", [vuln("X")])]);
    await seed(dir, [first, failed, at(3, {}, [pkg("a", "1", [vuln("X")])])]);
    const p = payload(await handleScanHistory({ project_path: "/work/app" }, { config: config(dir) }));
    expect(p.runs.map((r: { status: string }) => r.status)).toEqual(["ok", "error", "ok"]);
    expect(p.changes[0]).toMatchObject({ from: { id: first.id }, new_vulnerabilities: [], resolved_vulnerabilities: [] });
    expect(p.changes[0].incomplete).toBeUndefined();
  });

  it("許可ルート設定時は、対象が許可ルートの外の回を返さず、外のproject_pathは拒否する", async () => {
    const dir = await tempDir();
    const root = await tempDir();
    const inside = at(1, { inputPath: path.join(root, "app"), resolvedInput: path.join(root, "app") });
    inside.target.resolved = path.join(root, "app");
    await seed(dir, [inside, at(2)]);
    const p = payload(await handleScanHistory({}, { config: config(dir), allowedRoot: root }));
    expect(p.runs.map((r: { project: string }) => r.project)).toEqual([path.join(root, "app")]);
    expect(payload(await handleScanHistory({ project_path: "/work/app" }, { config: config(dir), allowedRoot: root })).error.kind).toBe("path_outside_allowed_root");
  });

  it("run_idで1回の詳細を返す。形式の不正・存在しないIDはhistory_run_not_found", async () => {
    const dir = await tempDir();
    const r = at(1, {}, [pkg("a", "1", [vuln("X")])]);
    await seed(dir, [r]);
    expect(payload(await handleScanHistory({ run_id: r.id }, { config: config(dir) })).run).toMatchObject({ id: r.id, findings: [pkg("a", "1", [vuln("X")])] });
    expect(payload(await handleScanHistory({ run_id: "../../etc" }, { config: config(dir) })).error.kind).toBe("history_run_not_found");
    expect(payload(await handleScanHistory({ run_id: newRecordId() }, { config: config(dir) })).error.kind).toBe("history_run_not_found");
  });

  it("書き換えられた記録の文字列も無害化し、解釈できない記録は数える", async () => {
    const dir = await tempDir();
    const r = at(1, {}, [pkg("name", "1", [vuln("X")])]);
    // 保存後に書き換えられた記録(本サーバーを通らずに不可視文字・制御文字が入った場合)
    const tampered = JSON.parse(JSON.stringify(r).replace('"name":"name"', '"name":"evil\\u202ename\\u0007"').replace('"id":"X"', '"id":"X\\u200b"')) as HistoryRecord;
    expect(JSON.stringify(tampered)).toMatch(/[\u202E\u0007\u200B]/);
    await seed(dir, [tampered]);
    await writeFile(path.join(dir, `${newRecordId()}.json`), JSON.stringify({ schema: 1, id: "mismatch" }));
    const p = payload(await handleScanHistory({ run_id: r.id }, { config: config(dir) }));
    expect(JSON.stringify(p)).not.toMatch(/[\u202E\u0007\u200B]/);
    expect(p.run.findings[0].name).toBe("evilname");
    expect(payload(await handleScanHistory({}, { config: config(dir) })).history.skipped_records).toBe(1);
  });
});

describe("permissionModelWarnings: 実行履歴の保存先", () => {
  it("履歴が有効で保存先に読み書きできなければ警告する", () => {
    const permission = { has: (scope: string, ref?: string) => !(scope.startsWith("fs.") && ref?.startsWith("/hist")) };
    const warnings = permissionModelWarnings({ tmpDir: "/tmp", tmpDirReal: "/tmp", historyDir: "/hist" }, permission);
    expect(warnings).toEqual([expect.stringContaining("scan history directory")]);
  });
});
