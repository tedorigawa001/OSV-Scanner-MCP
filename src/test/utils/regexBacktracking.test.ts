/**
 * 攻撃者が用意したロックファイル・マニフェストの値で、正規表現の後戻りが二乗・三乗に増えないこと(回帰)。
 *
 * 行を`\n`だけで分けた後に残る単独の`\r`やU+2028/U+2029に`.`が一致せず、`.*$`の照合が失敗するたびに
 * 空白や名前を1文字ずつ戻して照合し直していた。正規表現は途中で止められないため、スキャンのタイムアウトも
 * 効かずにサーバーのイベントループ全体が止まる(脆弱性チェックで判明、2026-11-20)。
 * 各入力は、修正前のコードでは数十秒以上かかる大きさにしている。上限時間は遅い環境向けに余裕を持たせた値
 */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "smol-toml";
import { afterAll, describe, expect, it } from "vitest";
import { parseCargoLock } from "../../utils/cargoLock.js";
import { goModRelations } from "../../utils/dependencyRelations.js";
import { analyzePdm } from "../../utils/pdmLock.js";
import { parentRelativePath } from "../../utils/pomParent.js";
import { analyzeRequirementsFile } from "../../utils/requirementsFile.js";
import { analyzeYarn } from "../../utils/yarnLock.js";

const LIMIT_MS = 2000;
const spaces = (n: number) => " ".repeat(n);

function timed<T>(run: () => T): T {
  const start = performance.now();
  const result = run();
  expect(performance.now() - start).toBeLessThan(LIMIT_MS);
  return result;
}

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pom.xml relativePath", () => {
  it("前後の空白の除去は空白の長い連続でも線形時間で終わる", () => {
    // 修正前は400 KBで約1分
    const inner = spaces(400_000);
    expect(timed(() => parentRelativePath(`<project><parent><relativePath>x${inner}x</relativePath></parent></project>`))).toBe(`x${inner}x`);
  });

  it("前後のスペース・タブ・改行だけを除く(修正前と同じ結果)", () => {
    const value = (text: string) => parentRelativePath(`<project><parent><relativePath>${text}</relativePath></parent></project>`);
    expect(value("\n \t ../a/pom.xml \t\n")).toBe("../a/pom.xml");
    expect(value(" \t\n ")).toBe("../pom.xml");
    expect(value("&#13;../a/pom.xml")).toBeUndefined(); // \rは除かず、制御文字として除外する
  });
});

describe("requirements.txt", () => {
  async function analyze(text: string) {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-req-redos-")));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "requirements.txt"), text);
    const start = performance.now();
    const result = await analyzeRequirementsFile(path.join(dir, "requirements.txt"), dir);
    expect(performance.now() - start).toBeLessThan(LIMIT_MS);
    if (!result.ok) throw new Error(result.reason);
    return result;
  }

  it.each([
    ["長い名前と単独の\\r(名前と版の分割)", `${"a".repeat(400_000)}=\rx`],
    ["空白と#の繰り返しと単独の\\r(コメントの除去)", `${" #".repeat(200_000)}\rx`],
    ["空白と-aの繰り返しと単独の\\r(行末のオプションの除去)", `a${" -a".repeat(130_000)}\rx`],
    ["U+2028を含む長い行", `${"a".repeat(400_000)}= x`],
  ])("%sでも線形時間で終わる", async (_label, line) => {
    await analyze(`${line}\nrequests==2.31.0\n`);
  });

  it("単独の\\rの後ろもコメントとして除き、コピーには検証済みの行だけを書く", async () => {
    const result = await analyze("requests==2.31.0 # note\rmore\nflask==3.0.0\rx\n");
    expect(result.entries).toEqual(["requests==2.31.0"]);
    expect(result.issues).toEqual([expect.objectContaining({ name: "flask", kind: "range" })]);
  });
});

describe("go.mod", () => {
  it("requireの後の空白の長い連続と単独の\\rでも線形時間で終わる", () => {
    const lookup = timed(() => goModRelations(`module m\nrequire${spaces(400_000)}x\ry v1.0.0\nrequire b v1.0.0\n`));
    expect(lookup!("b", "v1.0.0").relation).toBe("direct");
  });
});

describe("Cargo.lock", () => {
  it.each([
    ["キー", `version =${spaces(400_000)}4\rx\n`],
    ["metadataのchecksum", `version = 3\n[metadata]\n"checksum a 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)" =${spaces(400_000)}"x"\rx\n`],
  ])("%sの後の空白の長い連続と単独の\\rでも線形時間で終わり、解釈しない", (_label, text) => {
    expect(timed(() => parseCargoLock(text)).ok).toBe(false);
  });

  it("空白を挟む通常の値は修正前と同じく読む", () => {
    const result = parseCargoLock(`version =   4\n\n[[package]]\nname =  "a"\nversion = "1.0.0"\n`);
    expect(result).toMatchObject({ ok: true, packages: [{ name: "a", version: "1.0.0" }] });
  });
});

describe("yarn.lock", () => {
  it("値の前の空白の長い連続と単独の\\rでも線形時間で終わる", () => {
    const source = `# yarn lockfile v1\na@^1:\n  version${spaces(400_000)}"1.0.0"\rx\n`;
    timed(() => analyzeYarn(source, [{ path: "package.json", data: { name: "app", dependencies: { a: "^1" } } }]));
  });
});

describe("pdm.lock", () => {
  it("-eの要求に空白の長い連続と単独の\\rがあっても線形時間で終わる", () => {
    // 修正前は三乗で増え、4,000文字で約12秒(要求の上限16,384文字では十数分)
    const editable = `-e x;${spaces(16_000)}x\ry`;
    const lock = stringify({
      metadata: { lock_version: "4.5.1", groups: ["default"] },
      package: [{ name: "leaf", version: "1.0" }],
    });
    const result = timed(() => analyzePdm(lock, [{ path: "pyproject.toml", data: { project: { dependencies: ["leaf>=1", editable] } } }]));
    expect(result.relations?.("leaf", "1.0").relation).toBe("direct"); // 解釈できる宣言は保つ
  });
});
