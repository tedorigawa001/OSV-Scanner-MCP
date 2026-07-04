# OSV-Scanner-MCP

Google製 [OSV-Scanner](https://github.com/google/osv-scanner) をラップするMCPサーバーです。Claude等のMCPクライアントから「このJavaプロジェクトの脆弱性をチェックして」と自然言語で依頼するだけで、依存ライブラリの既知の脆弱性(CVE / GHSA)を深刻度順のレポートで取得できます。

> **ステータス**: MVP開発中。現在はMaven(pom.xml)プロジェクトのみ対応しています。

## 特徴

- **ワンショットスキャン**: `scan_java_project` ツールにプロジェクトパスを渡すだけで、検出→スキャン→整形済みレポートまで一気に返します
- **深刻度順のレポート**: パッケージごとに脆弱性をCVSSスコア順に整理し、5段階の深刻度ラベル(critical / high / medium / low / unknown)とサマリ集計付きで返します
- **修正版の提示**: 各脆弱性の `fixed_versions` をMavenバージョン優先順位規則で正しくソートして含めます(`2.17.1-RELEASE` のようなsemver非対応の表記にも対応)
- **セキュリティ第一の設計**: シェル非経由の実行・引数ホワイトリスト・パス正規化と境界チェック・タイムアウト/出力サイズ上限を実装段階から組み込んでいます

## 動作要件

- Node.js >= 20.19
- [OSV-Scanner](https://google.github.io/osv-scanner/) バイナリ(v2系で動作確認)
  - `brew install osv-scanner`
  - または `go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest`
  - または[公式リリース](https://github.com/google/osv-scanner/releases)から取得
- スキャン時にOSV APIへのネットワークアクセスが発生します(照会先はOSVデータベースのみ)

## セットアップ

```bash
git clone https://github.com/tedorigawa001/OSV-Scanner-MCP.git
cd OSV-Scanner-MCP
npm install
npm run build
```

### Claude Code への登録

```bash
claude mcp add osv-scanner -- node /path/to/OSV-Scanner-MCP/dist/index.js
```

### Claude Desktop への登録

`claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "osv-scanner": {
      "command": "node",
      "args": ["/path/to/OSV-Scanner-MCP/dist/index.js"]
    }
  }
}
```

### 環境変数

| 変数 | 説明 |
|---|---|
| `OSV_SCANNER_PATH` | 使用するosv-scannerバイナリの明示指定。省略時はPATHから探索。**指定が無効な場合はPATHへフォールバックせずエラーになります**(意図しないバイナリの実行防止) |
| `OSV_MCP_ALLOWED_ROOT` | 指定時、このディレクトリ配下以外のスキャンを拒否します(パストラバーサル対策の境界) |

## 提供ツール

### `scan_java_project`

Java(Maven)プロジェクトをスキャンし、既知の脆弱性レポートを返します。

**入力**

| パラメータ | 型 | 説明 |
|---|---|---|
| `project_path` | string | スキャン対象のプロジェクトディレクトリまたはpom.xmlの絶対パス |

**出力(成功時)**

```json
{
  "project_dir": "/path/to/project",
  "manifests": ["pom.xml"],
  "source_files": ["/path/to/project/pom.xml"],
  "vulnerable_package_count": 4,
  "vulnerability_count": 14,
  "severity_breakdown": { "critical": 3, "high": 3, "medium": 7, "low": 0, "unknown": 1 },
  "packages": [
    {
      "name": "org.apache.logging.log4j:log4j-core",
      "version": "2.14.1",
      "ecosystem": "Maven",
      "vulnerabilities": [
        {
          "id": "GHSA-jfh8-c2jp-5v3q",
          "cve": "CVE-2021-44228",
          "aliases": ["CVE-2021-44228"],
          "severity_score": 10,
          "severity": "critical",
          "summary": "Remote code injection in Log4j",
          "fixed_versions": ["2.3.1", "2.12.2", "2.15.0"]
        }
      ]
    }
  ]
}
```

- `packages` は最も深刻な脆弱性を持つ順、各 `vulnerabilities` は深刻度順(unknownは末尾)
- `fixed_versions` はMaven優先順位で昇順。複数のリリース系統(例: 2.12系バックポートと2.15系)が混在することがあります。空配列は「修正版が存在しない」ことを意味します
- `severity_score` が取得できない脆弱性は `null` / `"unknown"` として扱います

### `suggest_fix`

スキャンを実行し、脆弱なパッケージごとに**推奨アップグレードバージョン**を提案します。単純な最大バージョンではなく、現在のバージョンに最も近いリリース系統の修正版を3段階フォールバックで選定します:

| Tier | 意味 |
|---|---|
| `same_minor` | 現在と同じ major.minor 系統内の修正版(最小の変更で済む) |
| `major_internal` | 同一メジャー内の修正版(マイナーバージョンアップが必要) |
| `cross_major` | メジャーアップグレードが必要(破壊的変更の可能性あり) |

**入力**: `scan_java_project` と同じ(`project_path`)

**出力(成功時)**

```json
{
  "project_dir": "/path/to/project",
  "manifests": ["pom.xml"],
  "vulnerable_package_count": 4,
  "unfixed_vulnerability_count": 1,
  "suggestions": [
    {
      "package": "org.apache.logging.log4j:log4j-core",
      "current_version": "2.14.1",
      "ecosystem": "Maven",
      "recommended_upgrade": "2.25.4",
      "upgrade_tier": "major_internal",
      "upgrade_note": "2.14系統向けの修正版は存在しない。同一メジャー(2.x)内では2.25.4が7件のCVEを解消する最小版",
      "per_cve_detail": [
        { "id": "GHSA-jfh8-c2jp-5v3q", "cve": "CVE-2021-44228", "severity": "critical", "fixed_in": "2.15.0", "tier": "major_internal" }
      ]
    }
  ]
}
```

- `recommended_upgrade` は「修正可能な全CVEを解消できる最小バージョン」(CVEごとのTier結果の最大値)
- 修正版が存在しない(または現在より新しい修正版がない)CVEは `tier: "unfixed"` として明示し、推奨計算から除外します。全CVEがunfixedの場合 `recommended_upgrade` は `null`

**出力(エラー時)** — 両ツール共通

`isError: true` とともに、機械判読可能な `kind` を含むJSONを返します:

```json
{
  "error": {
    "kind": "no_pom_found",
    "message": "pom.xmlが見つかりません(深さ3まで探索): /path/to/project。MVPではMavenプロジェクトのみ対応しています"
  }
}
```

| kind | 意味 |
|---|---|
| `binary_not_found` | OSV-Scannerが見つからない(インストール案内をmessageに含む) |
| `project_not_found` | 指定パスが存在しない・ディレクトリ/pom.xmlでない |
| `no_pom_found` | プロジェクト内にpom.xmlが見つからない |
| `path_outside_allowed_root` | `OSV_MCP_ALLOWED_ROOT` の外を指している |
| `no_packages_found` | スキャン対象パッケージなし(依存関係が未定義のpom.xml等) |
| `scan_failed` | OSV-Scannerが異常終了(stderr抜粋を`detail`に含む) |
| `scan_timeout` | タイムアウト(デフォルト120秒) |
| `output_too_large` | 出力がサイズ上限(デフォルト32MB)を超過 |
| `invalid_output` | 出力がJSONとして解釈できない |
| `internal_error` | 想定外のエラー(内部情報は返しません) |

## セキュリティ設計

脆弱性診断ツール自体が攻撃経路にならないよう、以下を実装しています。

- **コマンドインジェクション対策**: シェルを経由しない `spawn` + 引数配列で実行。OSV-Scannerへの引数は固定リストのみで、可変部は検証済み絶対パス1つだけ
- **パストラバーサル対策**: 入力パスは `realpath` でシンボリックリンク解決後に境界チェック。pom.xml探索ではシンボリックリンクを辿りません
- **DoS対策**: タイムアウト・stdout上限・stderr抜粋上限を設定。スキャン結果は防御的にパースし、形式不正でも例外を投げません
- **情報漏えい対策**: 想定外の例外はスタックトレース等を含めず `internal_error` に丸めます。外部由来のテキスト(脆弱性summary等)は長さ上限付きの「データ」として構造化して返します

## 開発

```bash
npm test                  # テスト実行(vitest)
npx vitest run --coverage # カバレッジ計測
npm run typecheck         # 型チェック
npm run build             # dist/ へビルド
```

設計メモ・残課題は [docs/DESIGN_TODO.md](docs/DESIGN_TODO.md) を参照してください。

## ロードマップ

- [x] `suggest_fix` ツール: 現在のバージョンに最も近い系統の修正版を提案(3段階Tierフォールバック)
- [ ] `explain_vulnerability` ツール: 脆弱性の詳細説明
- [ ] npmパッケージ化(`npx osv-scanner-mcp`)
- [ ] OSV-Scannerバイナリの自動ダウンロード(チェックサム検証付き)
- [ ] Gradle対応

## ライセンス

[Apache License 2.0](LICENSE)
