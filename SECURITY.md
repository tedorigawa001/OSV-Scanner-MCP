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
- 入力パスの正規化・境界チェック(シンボリックリンク解決込み)
- バイナリ自動ダウンロードのピン留め+埋め込みSHA256検証
- タイムアウト・出力サイズ上限(DoS対策)、外部由来テキストの構造化とサイズ制限
- 外部由来テキストのサニタイズ(制御文字・ゼロ幅文字・双方向制御文字・Unicodeタグ文字の除去。プロンプトインジェクションの不可視化手口への対策)
