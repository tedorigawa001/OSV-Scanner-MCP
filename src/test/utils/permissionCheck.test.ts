import { describe, expect, it } from "vitest";
import { errorResult } from "../../tools/toolResult.js";
import { permissionModelWarnings, type PermissionApi } from "../../utils/permissionCheck.js";

/** 許可したパスの配下だけを許す権限APIの差し替え */
function api(allowed: { read?: string[]; write?: string[]; child?: boolean }): PermissionApi {
  const under = (dirs: string[] = [], ref = "") => dirs.some((dir) => ref === dir || ref.startsWith(`${dir}/`));
  return {
    has: (scope, ref) => scope === "child" ? allowed.child === true : scope === "fs.read" ? under(allowed.read, ref) : scope === "fs.write" ? under(allowed.write, ref) : false,
  };
}

const input = { allowedRoot: "/work", tmpDir: "/var/tmp-x", tmpDirReal: "/private/var/tmp-x", cacheDir: "/home/u/.cache/osv-scanner-mcp" };

describe("permissionModelWarnings", () => {
  it("権限モデルが無効なら何も警告しない", () => {
    expect(permissionModelWarnings(input, undefined)).toEqual([]);
  });

  it("必要な許可がそろっていれば警告しない", () => {
    expect(permissionModelWarnings(input, api({
      read: ["/work", "/var/tmp-x", "/private/var/tmp-x"], write: ["/private/var/tmp-x", "/home/u/.cache/osv-scanner-mcp"], child: true,
    }))).toEqual([]);
  });

  it("一時ディレクトリはシンボリックリンクの解決前・解決後の両方の読み取りが必要(macOSで確認した挙動)", () => {
    const warnings = permissionModelWarnings(input, api({
      read: ["/work", "/private/var/tmp-x"], write: ["/private/var/tmp-x", "/home/u/.cache/osv-scanner-mcp"], child: true,
    }));
    expect(warnings).toEqual([expect.stringContaining("一時ディレクトリの読み取りが許可されていません: /var/tmp-x")]);
  });

  it("子プロセス・許可ルート・キャッシュの欠けた許可を示し、キャッシュはOSV_SCANNER_PATH指定時(cacheDirなし)は確認しない", () => {
    const partial = api({ read: ["/var/tmp-x", "/private/var/tmp-x"], write: ["/private/var/tmp-x"] });
    const warnings = permissionModelWarnings(input, partial);
    expect(warnings.join("\n")).toContain("子プロセスの起動");
    expect(warnings.join("\n")).toContain("OSV_MCP_ALLOWED_ROOTの読み取り");
    expect(warnings.join("\n")).toContain("osv-scannerのキャッシュ");
    expect(permissionModelWarnings({ ...input, cacheDir: undefined }, partial).join("\n")).not.toContain("キャッシュ");
  });
});

describe("errorResult: 権限モデルの拒否", () => {
  it("ERR_ACCESS_DENIEDを内部エラーではなくpermission_deniedにし、許可の種類と対象を示す", () => {
    const denied = Object.assign(new Error("Access to this API has been restricted"), {
      code: "ERR_ACCESS_DENIED", permission: "FileSystemWrite", resource: "/private/var/tmp-x/osv-mcp-snap-abc",
    });
    const payload = JSON.parse(errorResult(denied).content[0]!.text) as { error: { kind: string; message: string } };
    expect(payload.error.kind).toBe("permission_denied");
    expect(payload.error.message).toContain("--allow-fs-write");
    expect(payload.error.message).toContain("/private/var/tmp-x/osv-mcp-snap-abc");
  });
});
