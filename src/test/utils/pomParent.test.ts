import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pomParentOutsideRoot } from "../../utils/pomParent.js";

const tempDirs: string[] = [];

/** base/ 配下にファイルを作る。base/root を許可ルート、base/outside を許可ルートの外として使う */
async function makeTree(files: Record<string, string>): Promise<string> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-mcp-pom-")));
  tempDirs.push(base);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(base, name)), { recursive: true });
    await writeFile(path.join(base, name), content);
  }
  return base;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function pom(parent = ""): string {
  return `<project><modelVersion>4.0.0</modelVersion>${parent}<artifactId>a</artifactId></project>`;
}
const parent = (relativePath?: string) =>
  `<parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version>${relativePath ?? ""}</parent>`;

describe("pomParentOutsideRoot", () => {
  it("許可ルート未設定なら検証しない", async () => {
    const base = await makeTree({ "outside/pom.xml": pom(), "root/proj/pom.xml": pom(parent("<relativePath>../../outside/pom.xml</relativePath>")) });
    expect(await pomParentOutsideRoot(path.join(base, "root/proj/pom.xml"), undefined)).toBeNull();
  });

  it.each([
    { label: "親なし", xml: pom() },
    { label: "空のrelativePath(ローカルを参照しない)", xml: pom(parent("<relativePath/>")) },
    { label: "空要素のrelativePath", xml: pom(parent("<relativePath></relativePath>")) },
    { label: "参照先が存在しない", xml: pom(parent("<relativePath>../../missing/pom.xml</relativePath>")) },
    { label: "コメント内のparentは無視", xml: `<project><!-- ${parent("<relativePath>../../outside/pom.xml</relativePath>")} --></project>` },
  ])("$label → 問題なし", async ({ xml }) => {
    const base = await makeTree({ "outside/pom.xml": pom(), "root/proj/pom.xml": xml });
    expect(await pomParentOutsideRoot(path.join(base, "root/proj/pom.xml"), path.join(base, "root"))).toBeNull();
  });

  it("既定のrelativePath(../pom.xml)が許可ルート内なら問題なし", async () => {
    const base = await makeTree({ "root/pom.xml": pom(), "root/proj/pom.xml": pom(parent()) });
    expect(await pomParentOutsideRoot(path.join(base, "root/proj/pom.xml"), path.join(base, "root"))).toBeNull();
  });

  it.each<{ label: string; files: Record<string, string>; target: string }>([
    { label: "明示したrelativePath", files: { "outside/pom.xml": pom(), "root/proj/pom.xml": pom(parent("<relativePath>../../outside/pom.xml</relativePath>")) }, target: "root/proj/pom.xml" },
    { label: "ディレクトリを指すrelativePath", files: { "outside/pom.xml": pom(), "root/proj/pom.xml": pom(parent("<relativePath>../../outside</relativePath>")) }, target: "root/proj/pom.xml" },
    { label: "既定のrelativePath(許可ルート直下のpom.xml)", files: { "pom.xml": pom(), "root/pom.xml": pom(parent()) }, target: "root/pom.xml" },
    { label: "連鎖の途中(親は内、祖父が外)", files: { "outside/pom.xml": pom(), "root/mid/pom.xml": pom(parent("<relativePath>../../outside/pom.xml</relativePath>")), "root/proj/pom.xml": pom(parent("<relativePath>../mid/pom.xml</relativePath>")) }, target: "root/proj/pom.xml" },
  ])("$label が許可ルートの外を指せば除外理由を返す", async ({ files, target }) => {
    const base = await makeTree(files);
    const reason = await pomParentOutsideRoot(path.join(base, target), path.join(base, "root"));
    expect(reason).toContain("許可ルート(OSV_MCP_ALLOWED_ROOT)の外");
  });

  it("シンボリックリンク経由で外を指す場合も除外する", async () => {
    const base = await makeTree({ "outside/pom.xml": pom(), "root/proj/pom.xml": pom(parent("<relativePath>../link/pom.xml</relativePath>")) });
    await symlink(path.join(base, "outside"), path.join(base, "root/link"));
    expect(await pomParentOutsideRoot(path.join(base, "root/proj/pom.xml"), path.join(base, "root"))).not.toBeNull();
  });

  it("評価できないrelativePath(プロパティ参照)は確認できないため除外する", async () => {
    const base = await makeTree({ "root/proj/pom.xml": pom(parent("<relativePath>${parent.dir}/pom.xml</relativePath>")) });
    expect(await pomParentOutsideRoot(path.join(base, "root/proj/pom.xml"), path.join(base, "root"))).toContain("評価できない");
  });

  it("循環する親の連鎖は上限で停止して除外する", async () => {
    const base = await makeTree({
      "root/a/pom.xml": pom(parent("<relativePath>../b/pom.xml</relativePath>")),
      "root/b/pom.xml": pom(parent("<relativePath>../a/pom.xml</relativePath>")),
    });
    expect(await pomParentOutsideRoot(path.join(base, "root/a/pom.xml"), path.join(base, "root"))).toContain("上限");
  });
});
