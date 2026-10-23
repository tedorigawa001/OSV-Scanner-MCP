/**
 * スキャン処理全体で使う型付きエラー。
 * MCPツール層はこの`kind`を見てエラーレスポンスの形式に変換する想定。
 */

export type ScanToolErrorKind =
  /** OSV-Scannerバイナリが見つからない(方式C: インストール案内を返す) */
  | "binary_not_found"
  /** 指定パスが存在しない・ディレクトリ/pom.xmlでない */
  | "project_not_found"
  /** Nodeの権限モデル(--permission)でファイルの読み書きが許可されていない */
  | "permission_denied"
  /** プロジェクト内に対応マニフェスト(pom.xml / gradle.lockfile)が見つからない */
  | "no_manifest_found"
  /** マニフェスト探索が上限(エントリ数・マニフェスト数・深さ)に達した。結果を黙って欠落させない */
  | "manifest_search_limit_exceeded"
  /** スキャン対象ファイル(スナップショットへのコピー)の合計サイズが上限を超えた(npm JSONの上限超過はスキャンを止めず、coverageに出す) */
  | "scan_input_too_large"
  /** No JAR/WAR files were found in the selected scope. */
  | "no_scannable_artifacts"
  /** Artifact discovery exceeded a bounded traversal limit. */
  | "artifact_search_limit_exceeded"
  /** SBOM input is missing, not a regular file, or unreadable. */
  | "sbom_not_found"
  /** SBOM input is malformed or has an invalid document structure. */
  | "invalid_sbom"
  /** SBOM format/version is not supported by this tool. */
  | "unsupported_sbom_format"
  /** SBOM input exceeds the byte limit. */
  | "sbom_too_large"
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
  | "binary_checksum_mismatch"
  /** スキャンの実行履歴が無効(OSV_MCP_HISTORY未設定) */
  | "history_disabled"
  /** 実行履歴の保存先が安全でない(シンボリックリンク・他人の所有等)ため読み書きしない */
  | "history_unavailable"
  /** 指定した実行履歴のIDが無い・形式が不正 */
  | "history_run_not_found";

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
