/**
 * Nodeの権限モデル(--permission)で起動された場合の、必要な許可の確認(docs/DESIGN_TODO.md「B3」)。
 *
 * 権限モデルは任意の多層防御として使える(既定の起動方法は変えない)。必要な許可が欠けると
 * スキャンの途中でERR_ACCESS_DENIEDになるため、起動時にstderrで知らせる(起動は拒否しない)。
 * 子プロセス(osv-scanner)は権限モデルの制限を受けない点に注意(READMEに明記)。
 */

import path from "node:path";

/** process.permissionの必要な部分(テストで差し替える) */
export interface PermissionApi {
  has(scope: string, reference?: string): boolean;
}

export interface PermissionCheckInput {
  /** OSV_MCP_ALLOWED_ROOT(未設定ならスキャン対象の確認はしない) */
  allowedRoot?: string;
  /** os.tmpdir()と、そのシンボリックリンクを解決したパス(macOSの/var → /private/var) */
  tmpDir: string;
  tmpDirReal: string;
  /** osv-scannerの自動ダウンロードのキャッシュ(OSV_SCANNER_PATHの指定時は確認しない) */
  cacheDir?: string;
  /** OSV_SCANNER_PATH(指定時はそのファイルの読み取りを確認する) */
  scannerPath?: string;
}

/** 権限モデルが有効なときに、欠けている許可を警告文の一覧で返す。無効なら空 */
export function permissionModelWarnings(
  input: PermissionCheckInput,
  permission: PermissionApi | undefined = (process as { permission?: PermissionApi }).permission,
): string[] {
  if (permission === undefined) return [];
  const inside = (dir: string) => path.join(dir, "x"); // ディレクトリ配下の読み書きの許可を確かめる
  const warnings: string[] = [];
  if (!permission.has("child")) {
    warnings.push("子プロセスの起動が許可されていません。osv-scannerを実行できません(--allow-child-process)");
  }
  const tmpDirs = [...new Set([input.tmpDir, input.tmpDirReal])];
  const unreadableTmp = tmpDirs.filter((dir) => !permission.has("fs.read", inside(dir)));
  if (unreadableTmp.length > 0) {
    warnings.push(
      `一時ディレクトリの読み取りが許可されていません: ${unreadableTmp.join(", ")}` +
        "(シンボリックリンクの解決前と解決後の両方のパスに--allow-fs-readが必要です)",
    );
  }
  if (!permission.has("fs.write", inside(input.tmpDirReal))) {
    warnings.push(`一時ディレクトリへの書き込みが許可されていません: ${input.tmpDirReal}(--allow-fs-write)`);
  }
  if (input.allowedRoot !== undefined && !permission.has("fs.read", inside(input.allowedRoot))) {
    warnings.push(`OSV_MCP_ALLOWED_ROOTの読み取りが許可されていません: ${input.allowedRoot}(--allow-fs-read)`);
  }
  if (input.scannerPath !== undefined && !permission.has("fs.read", input.scannerPath)) {
    warnings.push(`OSV_SCANNER_PATHの読み取りが許可されていません: ${input.scannerPath}(--allow-fs-read)`);
  }
  if (input.cacheDir !== undefined && !permission.has("fs.write", inside(input.cacheDir))) {
    warnings.push(
      `osv-scannerのキャッシュへの書き込みが許可されていません: ${input.cacheDir}` +
        "(自動ダウンロードを使う場合は--allow-fs-writeと--allow-fs-read、使わない場合はOSV_SCANNER_PATHを指定)",
    );
  }
  return warnings;
}
