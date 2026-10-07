# セキュリティポリシー / Security Policy

## 脆弱性の報告 / Reporting a Vulnerability

本プロジェクト(OSV-Scanner-MCP)に脆弱性を発見した場合は、**公開Issueではなく**、GitHubのプライベート脆弱性報告(Security Advisories)から報告してください:

**https://github.com/tedorigawa001/OSV-Scanner-MCP/security/advisories/new**

If you discover a security vulnerability in this project, please report it privately via GitHub Security Advisories (link above) — **do not open a public issue**.

報告の際は、可能な範囲で以下を含めてください:

- 影響を受けるバージョン
- 再現手順(PoC)
- 想定される影響(何ができてしまうか)

## 対応方針

- 報告の受領確認: **7日以内**を目標
- 修正とリリース: 深刻度に応じて優先対応し、修正版公開まで詳細は非公開のままとします
- 報告者のクレジット掲載を希望される場合はその旨お知らせください

## サポート対象バージョン / Supported Versions

| バージョン | サポート |
|---|---|
| 最新リリース(latest) | ✅ |
| それ以前 | ❌(最新版への更新をお願いします) |

## スコープについて

本プロジェクトが対象とするのは**MCPサーバー自体**の脆弱性です(例: コマンドインジェクション、パストラバーサル、チェックサム検証の回避、プロンプトインジェクション耐性の欠陥など)。以下は本プロジェクトのスコープ外のため、各報告先へお願いします:

- **OSV-Scanner本体**の脆弱性 → [google/osv-scanner](https://github.com/google/osv-scanner/security)
- **脆弱性データの誤り**(誤検出・深刻度の疑義など)→ [OSVデータベース](https://github.com/google/osv.dev)または各アドバイザリの発行元

## 本プロジェクトのセキュリティ設計

実装済みの対策(詳細は[README](README.md#セキュリティ設計)参照):

- シェル非経由のプロセス実行と引数ホワイトリスト
- 入力パスの正規化・境界チェック(シンボリックリンク解決込み)。OSV-Scannerにはディレクトリを渡さず、検出したマニフェストだけを個別に渡す(v0.3.3以前は、同じディレクトリの `requirements.txt` の取り込み指定によりスキャン範囲の外のファイルが読まれた)。requirements.txtは元ファイルを渡さず、解釈できた依存の行だけを書いた専用コピーをスキャンする(取り込み指定はコピーに含めない)。pom.xmlの親POMの連鎖が `OSV_MCP_ALLOWED_ROOT` の外を参照する場合は、そのpom.xmlをスキャン対象から外す(v0.3.4以前は範囲外の親POMが読まれた)
- バイナリ自動ダウンロードのピン留め+埋め込みSHA256検証(`OSV_MCP_PREFER_DOWNLOAD=1` でPATH上の未検証バイナリを使わない運用も可能)
- タイムアウト・出力サイズ上限(DoS対策)、外部由来テキストの構造化とサイズ制限
- 外部由来テキストのサニタイズ(制御文字・ゼロ幅文字・双方向制御文字・Unicodeタグ文字の除去。プロンプトインジェクションの不可視化手口への対策)
- 通信先の固定と明示: `pom.xml` のスキャンでは推移的依存の解決のため deps.dev(`api.deps.dev`)に依存の名前とバージョンが送られます。`OSV_MCP_NO_REMOTE_RESOLUTION=1` で deps.dev への送信を止められます(推移的依存の検出と引き換え。応答の `dependency_resolution` に明示)。脆弱性照会のため、パッケージの名前とバージョンはどの設定でも `api.osv.dev` に送られます。スキャン対象が指定する任意のリポジトリへ接続するモードは使いません(詳細は[README](README.md#通信先とプライバシー))
