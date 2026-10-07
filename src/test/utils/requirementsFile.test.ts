import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  analyzeRequirementsFile,
  createRequirementsReadContext,
  normalizePypiName,
  type RequirementsAnalysis,
} from "../../utils/requirementsFile.js";

const tempDirs: string[] = [];

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-req-")));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function ok(result: RequirementsAnalysis) {
  if (!result.ok) throw new Error(result.reason);
  return result;
}

async function analyzeIn(projectDir: string, file = "requirements.txt") {
  return ok(await analyzeRequirementsFile(path.join(projectDir, file), projectDir));
}

describe("analyzeRequirementsFile: 行の分類(osv-scanner v2.4.0の実機確認に合わせる)", () => {
  it("固定済み・下限・範囲・未固定・参照を分類し、コピーには正規化した行だけを書く", async () => {
    const dir = await makeProject({
      "requirements.txt": [
        "requests==2.19.0",
        "Jinja2>=2.0",
        "urllib3~=1.23",
        "pyyaml>5.0",
        "flask<1.0",
        "django!=2.0",
        "idna==2.*",
        "certifi>=2017.1,<2018",
        "pillow[extra]==6.0.0",
        'lxml==4.0.0 ; python_version < "3.12"',
        "paramiko==2.0.0 --hash=sha256:00",
        "cryptography === 2.0",
        "-e git+https://example.invalid/proj.git#egg=gitpkg",
        "localpkg @ file:///tmp/localpkg",
        "urlpkg @ https://example.invalid/urlpkg-1.0.tar.gz",
        "Werkzeug==0.11 \\",
        "  --hash=sha256:11",
        "numpy  # trailing comment",
        "# full-line comment",
        "--index-url https://example.invalid/simple",
        "",
      ].join("\n"),
    });
    const result = await analyzeIn(dir);
    expect(result.entries).toEqual([
      "requests==2.19.0",
      "Jinja2>=2.0",
      "urllib3~=1.23",
      "pillow==6.0.0",
      "lxml==4.0.0",
      "paramiko==2.0.0",
      "cryptography==2.0",
      "Werkzeug==0.11",
    ]);
    const kinds = Object.fromEntries(result.issues.map((i) => [i.name, i.kind]));
    expect(kinds).toEqual({
      Jinja2: "lower_bound",
      urllib3: "lower_bound",
      pyyaml: "range",
      flask: "range",
      django: "range",
      idna: "range",
      certifi: "range",
      numpy: "unpinned",
    });
    expect(result.lowerBounds).toEqual([
      { name: "jinja2", version: "2.0" },
      { name: "urllib3", version: "1.23" },
    ]);
    expect(result.references.map((r) => r.text)).toEqual([
      "-e git+https://example.invalid/proj.git#egg=gitpkg",
      "localpkg @ file:///tmp/localpkg",
      "urlpkg @ https://example.invalid/urlpkg-1.0.tar.gz",
    ]);
    expect(result.issues.find((i) => i.name === "numpy")!.line).toBe(18);
  });

  it("解釈できないオプションや版は無視せず、スキャンされない行として報告する", async () => {
    const dir = await makeProject({ "requirements.txt": "--unknown-option x\nflask==1.0;rm\nbad==1.0$x\n" });
    const result = await analyzeIn(dir);
    expect(result.entries).toEqual(["flask==1.0"]);
    expect(result.references.map((r) => [r.text, r.reason])).toEqual([
      ["--unknown-option x", "解釈できないオプションです"],
      ["bad==1.0$x", "解釈できない版の指定です"],
    ]);
  });

  it("行継続で終わるファイルも最後の行を分類する", async () => {
    const dir = await makeProject({ "requirements.txt": "flask \\" });
    expect((await analyzeIn(dir)).issues.map((i) => i.name)).toEqual(["flask"]);
  });

  it("PEP 503で名前を正規化する", () => {
    expect(normalizePypiName("Typing_Extensions")).toBe("typing-extensions");
    expect(normalizePypiName("zope.interface")).toBe("zope-interface");
    expect(normalizePypiName("a--_.b")).toBe("a-b");
  });
});

describe("analyzeRequirementsFile: 取り込み", () => {
  it("回帰: --requirementはosv-scannerがたどらないため、ここで展開してコピーに含める", async () => {
    const dir = await makeProject({
      "requirements.txt": "--requirement child.txt\n--requirement=reqs/extra.txt\n",
      "child.txt": "requests==2.19.0\n",
      "reqs/extra.txt": "-r ../child.txt\nJinja2>=2.0\n",
    });
    const result = await analyzeIn(dir);
    expect(result.entries).toEqual(["requests==2.19.0", "Jinja2>=2.0"]);
    expect(result.issues.map((i) => [path.relative(dir, i.file), i.name])).toEqual([["reqs/extra.txt", "Jinja2"]]);
    expect(result.references).toEqual([]);
  });

  it.each([
    { label: "-r", content: "-r ../outside.txt\n" },
    { label: "-rに直結", content: "-r../outside.txt\n" },
    { label: "回帰: 空白入りの - r", content: "- r ../outside.txt\n" },
    { label: "空白と=入り", content: "-  r = ../outside.txt\n" },
    { label: "--requirement", content: "--requirement ../outside.txt\n" },
  ])("プロジェクト外を指す取り込み($label)は展開せず、内容をコピーに含めない", async ({ content }) => {
    const parent = await makeProject({ "outside.txt": "Jinja2==2.0\n", "proj/requirements.txt": `${content}flask==1.0\n` });
    const projectDir = path.join(parent, "proj");
    const result = await analyzeIn(projectDir);
    expect(result.entries).toEqual(["flask==1.0"]);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.reason).toContain("外");
  });

  it.each([
    { label: "URL", content: "-r https://example.invalid/reqs.txt\n", reason: "URL" },
    { label: "存在しない取り込み先", content: "-r missing.txt\n", reason: "存在しません" },
    { label: "制約ファイル", content: "-c constraints.txt\n", reason: "制約ファイル" },
  ])("$label は展開せず理由付きで報告する", async ({ content, reason }) => {
    const dir = await makeProject({ "requirements.txt": content, "constraints.txt": "flask==1.0\n" });
    const result = await analyzeIn(dir);
    expect(result.entries).toEqual([]);
    expect(result.references[0]!.reason).toContain(reason);
  });

  it("シンボリックリンク経由で外を指す取り込みも展開しない", async () => {
    const parent = await makeProject({ "outside.txt": "Jinja2==2.0\n", "proj/requirements.txt": "-r link.txt\n" });
    const projectDir = path.join(parent, "proj");
    await symlink(path.join(parent, "outside.txt"), path.join(projectDir, "link.txt"));
    const result = await analyzeIn(projectDir);
    expect(result.entries).toEqual([]);
    expect(result.references[0]!.reason).toContain("外");
  });

  it("プロジェクト内を指す絶対パスの取り込みは展開する", async () => {
    const dir = await makeProject({ "child.txt": "requests==2.19.0\n" });
    await writeFile(path.join(dir, "requirements.txt"), `-r ${path.join(dir, "child.txt")}\n`);
    expect((await analyzeIn(dir)).entries).toEqual(["requests==2.19.0"]);
  });

  it("循環する取り込みでも停止する", async () => {
    const dir = await makeProject({ "requirements.txt": "-r a.txt\n", "a.txt": "-r requirements.txt\nflask==1.0\n" });
    expect((await analyzeIn(dir)).entries).toEqual(["flask==1.0"]);
  });

  it("取り込みの深さが上限を超えた先は展開せず報告する", async () => {
    const files: Record<string, string> = { "requirements.txt": "-r r1.txt\n" };
    for (let i = 1; i <= 6; i++) files[`r${i}.txt`] = `-r r${i + 1}.txt\n`;
    files["r7.txt"] = "flask==1.0\n";
    const dir = await makeProject(files);
    const result = await analyzeIn(dir);
    expect(result.entries).toEqual([]);
    expect(result.references.some((r) => r.reason.includes("深さ"))).toBe(true);
  });

  it("元ファイルのサイズが上限を超える場合はファイルごと外す", async () => {
    const dir = await makeProject({ "requirements.txt": "flask==1.0\n".repeat(120_000) });
    expect((await analyzeRequirementsFile(path.join(dir, "requirements.txt"), dir)).ok).toBe(false);
  });
});

describe("analyzeRequirementsFile: 読み込みの共有と上限(回帰)", () => {
  it("複数のrequirements.txtが同じ取り込み先を参照しても1回だけ読む", async () => {
    const dir = await makeProject({ "a.txt": "-r shared.txt\n", "b.txt": "-r shared.txt\n", "shared.txt": "requests==2.19.0\n" });
    const context = createRequirementsReadContext();
    expect(ok(await analyzeRequirementsFile(path.join(dir, "a.txt"), dir, context)).entries).toEqual(["requests==2.19.0"]);
    await writeFile(path.join(dir, "shared.txt"), "flask==1.0\n"); // 読み直していれば変わる
    expect(ok(await analyzeRequirementsFile(path.join(dir, "b.txt"), dir, context)).entries).toEqual(["requests==2.19.0"]);
  });

  it("読む量の合計が上限を超えたら、それ以上は読まずに理由を報告する", async () => {
    const dir = await makeProject({ "a.txt": "requests==2.19.0\n", "b.txt": "flask==1.0\n" });
    const context = createRequirementsReadContext(20);
    expect((await analyzeRequirementsFile(path.join(dir, "a.txt"), dir, context)).ok).toBe(true);
    const second = await analyzeRequirementsFile(path.join(dir, "b.txt"), dir, context);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toContain("上限");
  });

  it("回帰: 取り込み先が名前付きパイプでも処理が止まらない", async () => {
    const dir = await makeProject({ "requirements.txt": "-r pipe.txt\nflask==1.0\n" });
    execFileSync("mkfifo", [path.join(dir, "pipe.txt")]);
    const result = await Promise.race([
      analyzeRequirementsFile(path.join(dir, "requirements.txt"), dir),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("処理が止まった")), 3000)),
    ]);
    expect(ok(result).entries).toEqual(["flask==1.0"]);
    expect(ok(result).references[0]!.reason).toContain("通常のファイルではありません");
  });
});
