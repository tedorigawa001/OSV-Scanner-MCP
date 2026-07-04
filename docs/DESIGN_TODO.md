# OSV-Scanner-MCP 設計メモ / 残課題

最終更新: 2026-07-04(OSV-Scanner実機確認結果を反映)

## 決定済み事項

- **プロジェクト名**: `OSV-Scanner-MCP`
- **役割**: MCPサーバーとして動作し、Claude等のMCPクライアントから「Javaプロジェクトの脆弱性チェック」を自然言語ワンショットで呼び出せるようにする
- **スキャンエンジン**: Google製 OSV-Scanner をラップして利用(自前でCVE照合ロジックは持たない)
- **開発方針**: スモールスタート。MVPはMaven(pom.xml)のみ対応、Gradleは後回し
- **実装場所**: ローカル(Claude Code等)で行う。このチャットは設計・方針決定用
- **開発環境**: Go 1.26.4(brewで更新済み)。本家OSV-Scannerを`go build ./cmd/osv-scanner`でビルド済み、動作確認完了(`osv-scanner version: 2.4.0`)
- **動作確認用ダミープロジェクト**: `pom.xml`(log4j-core 2.14.1 / commons-collections 3.2.1 / jackson-databind 2.17.0)で実スキャン済み。Log4Shell含む既知CVEの検出を確認済み

## ディレクトリ構成(たたき台)

```
OSV-Scanner-MCP/
├── src/
│   ├── index.ts
│   ├── tools/
│   │   ├── scanJavaProject.ts
│   │   ├── explainVulnerability.ts
│   │   └── suggestFix.ts
│   ├── osv/
│   │   ├── runner.ts
│   │   └── binaryManager.ts
│   └── utils/
│       └── projectDetector.ts
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
└── .gitignore
```

## OSV-Scanner JSON出力構造の調査結果(2026-07-04 実機確認済み)

`osv-scanner scan source -r . --format json` の実行結果を解析した知見。`runner.ts`のパース設計はこれを前提にする。

### 構造の概要

```
{
  "results": [
    {
      "source": { "path": ".../pom.xml", "type": "lockfile" },
      "packages": [
        {
          "package": { "name": "...", "version": "...", "ecosystem": "Maven" },
          "groups": [
            { "ids": ["GHSA-xxxx"], "aliases": ["CVE-xxxx", "GHSA-xxxx"], "max_severity": "5.3" }
          ],
          "vulnerabilities": [ /* affected範囲・fixed versionなどの詳細 */ ]
        }
      ]
    }
  ],
  "experimental_config": { ... }
}
```

### 重要な発見

1. **パッケージ単位のグルーピングは既にOSV-Scanner側でやってくれている**
   `packages[].groups[]`が「1エントリ=1脆弱性」の単位になっており、MCPサーバー側で独自にグルーピングロジックを組む必要はない。`group.ids`(GHSA-ID)、`group.aliases`(CVE-ID含む)、`group.max_severity`をそのまま使える

2. **`max_severity`が空文字列になるケースがある**
   実機確認で `commons-collections` の1件(`GHSA-6hgm-866r-3cjv`, CVE-2015-6420)が`max_severity=""`だった。深刻度でソート・フィルタする処理は空文字/null相当を安全に扱う必要がある(例外を投げない、Unknown扱いにする等)

3. **`fixed_version`は複数のリリース系統が混在する**
   log4j-coreの例では `2.12.2〜2.12.4`(2.12系バックポート)、`2.15.0〜2.17.1`(2.1x系)、`2.25.3〜2.25.4`(2.25系)のように**異なるメジャー系統への修正版が同時に列挙される**。単純に最大バージョンを取ると現在使用中の系統と無関係なジャンプになりうる
   - [x] **要設計判断**: `suggest_fix`では「単純な最大バージョン」を出すか、「現在のバージョンに最も近い系統内の修正版」を優先するか決める → 3段階Tier方式で確定(下記セクション参照)

4. **同一`source`(pom.xml)が複数の`results`エントリに分かれることがある**
   実機確認では`jackson-core`が別の`results[]`エントリとして出力された。パース時は「pathでグルーピングする」のではなく、**全`results[].packages[]`をフラットに集約してから整形する**方が安全

### 反映が必要な設計項目

- [x] `scan_java_project`の出力スキーマは、独自グルーピングを持たず`groups`をそのまま活用する形に修正
- [x] `max_severity`の空文字ハンドリングをパース処理に組み込む
- [x] `suggest_fix`のバージョン選定ロジック → 下記「fixed_versionの選定ロジック」で確定

## fixed_versionの選定ロジック(確定: 2026-07-04)

### 背景

同一パッケージに複数の`fixed_version`が並ぶのは、「表記ゆれ」ではなく**複数のサポートブランチ(major.minor系統)に個別のバックポート修正が存在するため**。log4jの実例では`2.12.x`系(Java 7向けLTS)、`2.3.x`系(さらに古いLTS)、`2.15.0〜2.25.4`(メインライン)に修正が分散しており、現在使用中の`2.14.1`系統向けの修正版は1つも存在しないケースが確認された。これは仕様として扱う。

### 粒度: major.minor単位で「系統」を定義

（例: `2.14.1` の系統は `2.14`）

### アルゴリズム: 3段階のTierフォールバック

CVEごとに以下の優先順で修正版を探索する。

1. **Tier 1(`same_minor`)**: `major.minor`が現在バージョンと一致し、かつ現在より大きい修正版があれば採用(最小の変更で済む)
2. **Tier 2(`major_internal`)**: Tier 1が無ければ、`major`のみ一致する修正版のうち最小のものを採用(マイナーバージョンアップが必要)
3. **Tier 3(`cross_major`)**: Tier 2も無ければ、全体最小の修正版を採用し「メジャーアップグレード(破壊的変更の可能性あり)」と明示

パッケージ全体の推奨バージョン(`recommended_upgrade`)は、**全CVEの各Tier結果のうち最大のもの**(=すべてのCVEを解消できる最小バージョン)とし、使用したTierを`upgrade_tier`として記録する。

### 出力イメージ

```json
{
  "package": "org.apache.logging.log4j:log4j-core",
  "current_version": "2.14.1",
  "recommended_upgrade": "2.25.4",
  "upgrade_tier": "major_internal",
  "upgrade_note": "2.14系統向けの修正版は存在しない。同一メジャー(2.x)内では2.25.4が全7件のCVEを解消する最小版",
  "per_cve_detail": [
    { "cve": "CVE-2021-44228", "fixed_in": "2.15.0", "tier": "major_internal" },
    { "cve": "CVE-2021-45046", "fixed_in": "2.16.0", "tier": "major_internal" }
  ]
}
```

### 実装上の技術的な壁(要着手優先度: 高)

- [x] **Maven形式に対応した独自バージョンコンパレータが必要** → `src/utils/mavenVersion.ts`に実装済み(2026-07-04)。Maven本家`ComparableVersion`のアルゴリズムを移植し、本家テストコーパス+log4j実例でテスト済み(`compareMavenVersions` / 系統抽出用`mavenVersionSeries`をエクスポート)
- [x] `fixed_version`が存在しないCVE(修正版が今後も出ない"unfixed"扱い)のハンドリングを設計する
  - スキャン出力側: `fixed_versions: []`として表現(実データで確認: jackson-databindのCVE-2026-54515がunfixed)
  - `suggest_fix`側: 推奨バージョン計算から除外し、`tier: "unfixed"`+upgrade_noteで「このアップグレードでは解消されない」と明示(2026-07-04実装)。「現在より新しい修正版が無い」(別ブランチ向けバックポートのみ)ケースも同様にunfixed扱い

## 残課題(未決定・要検討)

### 1. OSV-Scannerバイナリの扱い方 【最優先】
- [x] MVPでは「存在チェック→なければ案内メッセージ」方式(方式C)で開始 → `src/osv/binaryManager.ts`に実装済み(2026-07-04)。探索順: 環境変数`OSV_SCANNER_PATH`(無効時はPATHにフォールバックしない)→ PATH。未検出時はインストール案内付き`binary_not_found`エラー
- [ ] 将来的に自動ダウンロード(方式B)へ移行するか判断
- [ ] バイナリのハッシュ検証をどう組み込むか(下記セキュリティ項目と関連)

### 2. Tool定義の確定
- [x] `scan_java_project` の**出力**スキーマを最終化 → `src/osv/scanReport.ts`に実装済み(2026-07-04)。`groups`ベースの`ScanReport`型(パッケージ→脆弱性の2階層+severity_breakdown集計)。実機スキャン出力(14件/4パッケージ)でパース検証済み
- [x] `scan_java_project` の**入力**スキーマを確定 → `src/index.ts`で実装済み(2026-07-04)。パラメータは`project_path`(ディレクトリまたはpom.xmlの絶対パス)のみ。環境変数`OSV_MCP_ALLOWED_ROOT`でスキャン範囲を制限可能。MCPプロトコル経由(initialize→tools/list→tools/call)の実機スキャンで動作確認済み
- [x] `explain_vulnerability` の要否判断 → **実装する**で確定し実装済み(2026-07-04)。判断理由: 実スキャンで検出14件中5件が2026年採番CVEで、クライアントLLMの知識カットオフ以降の脆弱性説明に必須。`src/osv/osvApi.ts`(OSV APIクライアント: ID厳格検証・タイムアウト・サイズ上限)+`src/osv/vulnerabilityExplanation.ts`(整形)+`src/tools/explainVulnerability.ts`。CVE-IDはOSVで解決できない場合があるため404時にGHSA-IDでの照会を案内
- [x] `suggest_fix` ツールを実装 → `src/osv/suggestFix.ts`(3段階Tierロジック)+`src/tools/suggestFix.ts`(2026-07-04)。実機スキャンで設計メモの想定例(log4j 2.14.1→2.25.4/major_internal)と一致することを確認済み
- [x] `suggest_fix`のfixed_version選定ロジック → 3段階Tier方式で確定(詳細は上記セクション参照)
- [x] エラー時のレスポンス形式 → `src/tools/scanJavaProject.ts`で確定(2026-07-04)。`isError: true`+`{"error": {"kind", "message", "detail?"}}`のJSONテキスト。予期しない例外は内部情報を漏らさず`internal_error`に丸める
  - 内部エラー型: `src/errors.ts`の`ScanToolError`(kind: binary_not_found / project_not_found / no_pom_found / path_outside_allowed_root / no_packages_found / scan_failed / scan_timeout / output_too_large / invalid_output)
  - OSV-Scanner 2.4.0の終了コードを実機確認: 0=脆弱性なし / 1=脆弱性あり(どちらも正常) / 128=対象パッケージなし(依存ゼロのpom.xmlも128になる)

### 3. キャッシュ戦略
- [ ] MVPでは見送り、OSV-Scannerのデフォルト動作(オンラインAPI照会)に任せる
- [ ] 将来的にオフライン/事前キャッシュ対応を検討するか

### 4. 配布方法
- [ ] npmパッケージ化(`npx osv-scanner-mcp`)
- [x] Claude Desktop設定ファイルへの登録手順をREADMEに明記 → README.md作成時に記載(2026-07-04)。Claude Code(`claude mcp add`)の手順も併記

### 5. Gradle対応(MVP後)
- [ ] build.gradle / build.gradle.kts の検出ロジック
- [ ] lockfile方式 vs ビルド実行方式の比較

## セキュリティ考慮事項 【重要・継続確認】

MCPサーバーは「外部プロセス実行」「ファイルシステムアクセス」を伴うため、脆弱性診断ツール自体が攻撃経路にならないよう以下を設計・実装の各段階でチェックする。

### コマンドインジェクション対策
- [x] `project_path` などユーザー入力・LLM由来の値をシェル経由で結合しない → `src/osv/runner.ts`で`spawn(..., { shell: false })`+引数配列を使用(2026-07-04)
- [x] OSV-Scannerへの引数はホワイトリスト化されたオプションのみ許可 → 固定引数リスト`FIXED_SCAN_ARGS`のみ。可変部は検証済み絶対パス1つだけ

### パストラバーサル対策
- [x] `project_path` の正規化・境界チェック → `src/utils/projectDetector.ts`で`realpath`解決後、`allowedRoot`オプション指定時は配下チェック(2026-07-04)
- [x] シンボリックリンク経由での想定外アクセスも考慮 → 境界チェックはリンク解決後の実体パスで実施。pom.xml探索ではシンボリックリンクのディレクトリを辿らない

### 供給網(サプライチェーン)の信頼性
- [ ] 自動ダウンロードする場合、OSV-Scannerバイナリの取得元は公式GitHub Releasesに限定
- [ ] チェックサム/署名検証を行い、改ざんされたバイナリの実行を防ぐ
- [ ] npm依存パッケージ自体も定期的に(このMCPサーバー自身に対しても)脆弱性スキャンをかける(自己言及的だが重要)

### 出力・リソースの安全性
- [x] OSV-Scannerの出力(JSON)をパースする際、不正な形式や巨大出力に対するタイムアウト・サイズ上限を設定 → `runner.ts`でタイムアウト(デフォルト120秒)・stdout上限(32MB)・stderr抜粋上限(8KB)を実装。不正JSONは`invalid_output`エラー(2026-07-04)
- [ ] スキャン結果に含まれる外部由来の文字列(パッケージ名、説明文など)をLLMにそのまま渡す際のプロンプトインジェクション耐性も考慮(結果はあくまで「データ」として扱われるよう構造化する)

### 権限の最小化
- [ ] MCPサーバープロセスに必要以上のファイルシステム権限を与えない
- [ ] ネットワークアクセスはOSV-Scannerの照会先(OSV API等)に限定されることを明示し、README等でユーザーに透明性を提供

### 運用面
- [ ] 依存パッケージの自動更新(Dependabot等)をリポジトリに設定
- [ ] 脆弱性報告用の`SECURITY.md`を早期に用意(OSSとして公開する以上、報告窓口は必須)

## 次のアクション候補

1. **Maven形式バージョンコンパレータの実装**(3段階Tierアルゴリズムの前提部品、最優先)
2. `scan_java_project`の出力スキーマを、OSV-Scannerの`groups`構造をベースに確定
3. `package.json` / `tsconfig.json` の初期セットアップ(ローカル環境で実施)
4. セキュリティ項目のうち「コマンドインジェクション対策」は実装の最初期段階から組み込む(後付けが難しいため)
