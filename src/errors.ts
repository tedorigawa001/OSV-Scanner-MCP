/**
 * スキャン処理全体で使う型付きエラー。
 * MCPツール層はこの`kind`を見てエラーレスポンスの形式に変換する想定。
 */

export type ScanToolErrorKind =
  /** OSV-Scannerバイナリが見つからない(方式C: インストール案内を返す) */
  | "binary_not_found"
  /** 指定パスが存在しない・ディレクトリ/pom.xmlでない */
  | "project_not_found"
  /** プロジェクト内に対応マニフェスト(pom.xml / gradle.lockfile)が見つからない */
  | "no_manifest_found"
  /** build.gradleはあるがgradle.lockfileが無い(lockfile方式のため生成が必要) */
  | "gradle_lockfile_missing"
  /** 許可されたルートディレクトリの外を指している(パストラバーサル対策) */
  | "path_outside_allowed_root"
  /** OSV-Scannerがスキャン対象パッケージを検出できなかった(exit 128) */
  | "no_packages_found"
  /** OSV-Scannerが異常終了した */
  | "scan_failed"
  /** スキャンがタイムアウトした */
  | "scan_timeout"
  /** 同時実行スキャン数が上限に達している(リソース枯渇対策) */
  | "too_many_concurrent_scans"
  /** OSV-Scannerの出力がサイズ上限を超えた(DoS対策) */
  | "output_too_large"
  /** OSV-Scannerの出力がJSONとして解釈できない */
  | "invalid_output"
  /** 脆弱性IDの形式が不正(URL組み立てに使うため厳格に検証する) */
  | "invalid_vulnerability_id"
  /** 指定されたIDの脆弱性がOSVデータベースに存在しない */
  | "vulnerability_not_found"
  /** OSV APIへのリクエストが失敗した(ネットワークエラー・タイムアウト・非2xx) */
  | "api_request_failed"
  /** OSV-Scannerバイナリのダウンロードに失敗した(未対応プラットフォーム含む) */
  | "binary_download_failed"
  /** ダウンロードしたバイナリのチェックサムが埋め込み値と一致しない */
  | "binary_checksum_mismatch";

export class ScanToolError extends Error {
  constructor(
    readonly kind: ScanToolErrorKind,
    message: string,
    /** stderr抜粋などの補足情報(外部由来テキストのため上限付きで格納すること) */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ScanToolError";
  }
}
