# OSV-Scanner-MCP 設計メモ / 残課題

最終更新: 2026-10-07(対象エコシステム拡大の詳細設計メモを追加。現行版の不具合3件をPhase 0として記載)

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

パッケージ全体の推奨バージョン(`recommended_upgrade`)は、既知の修正版候補を全修正対象CVEの影響範囲と照合し、検証できた候補をTier順・バージョン昇順で選ぶ(2026-09-11改訂)。旧方式の「各CVEの修正版の最大値」では、別系統で再導入された脆弱性を見落とすため廃止。範囲情報が不十分なら推奨を保留する。修正版候補のないCVEは別表示し、推奨先での判定も返す。全公開版の最小性を保証するものではない。

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
- [x] 将来的に自動ダウンロード(方式B)へ移行するか判断 → 実装済み(2026-07-04)。`src/osv/binaryDownloader.ts`。解決順: OSV_SCANNER_PATH → PATH → キャッシュ(毎回再検証)→ 自動ダウンロード。`OSV_MCP_AUTO_DOWNLOAD=0`でオプトアウト(その場合は方式Cの案内)。実ダウンロード検証済み(52MB/約5秒、darwin_arm64)
- [x] バイナリのハッシュ検証をどう組み込むか → バージョンをv2.4.0にピン留めし、公式SHA256SUMSの値を**ソースコードに埋め込んで**照合(配布元改ざんにも耐性)。検証合格まで実行権限を付与せず、一時ファイル→検証→chmod→アトミックrenameの順で配置

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
- [x] npmパッケージ化(`npx osv-scanner-mcp`)→ 配布準備完了(2026-07-04)。パッケージ名の空きを確認済み。`files: ["dist"]`でテスト除外(tsconfig.build.json)、`prepack`で自動ビルド、`prepublishOnly`でtypecheck+test実行。tarballを隔離環境にインストールしてbin起動・3ツール・実スキャンまで検証済み。**v0.1.0として公開済み(2026-07-04)**: https://www.npmjs.com/package/osv-scanner-mcp
- [x] Claude Desktop設定ファイルへの登録手順をREADMEに明記 → README.md作成時に記載(2026-07-04)。Claude Code(`claude mcp add`)の手順も併記

### 5. Gradle対応(MVP後)
- [x] build.gradle / build.gradle.kts の検出ロジック → `projectDetector.ts`で対応(2026-07-04)。gradle.lockfile / buildscript-gradle.lockfileをマニフェストとして検出。build.gradle系はあるがlockfileが無い場合は`gradle_lockfile_missing`エラーで生成手順(`./gradlew dependencies --write-locks`)を案内
- [x] lockfile方式 vs ビルド実行方式の比較 → **lockfile方式で確定**。ビルド実行方式はbuild.gradle自体が任意コードとして実行されるため、信頼できない入力パスを扱うMCPサーバーのセキュリティ設計と相容れない。OSV-Scanner 2.4.0がgradle.lockfileをネイティブ解釈し、ecosystemも同じ「Maven」のためレポート整形・suggest_fixは無変更で動作(実機確認済み)。エラーkindは`no_pom_found`→`no_manifest_found`にリネーム(npm公開前のため互換性影響なし)

## セキュリティ考慮事項 【重要・継続確認】

MCPサーバーは「外部プロセス実行」「ファイルシステムアクセス」を伴うため、脆弱性診断ツール自体が攻撃経路にならないよう以下を設計・実装の各段階でチェックする。

### コマンドインジェクション対策
- [x] `project_path` などユーザー入力・LLM由来の値をシェル経由で結合しない → `src/osv/runner.ts`で`spawn(..., { shell: false })`+引数配列を使用(2026-07-04)
- [x] OSV-Scannerへの引数はホワイトリスト化されたオプションのみ許可 → 固定引数リスト`FIXED_SCAN_ARGS`のみ。可変部は検証済み絶対パス1つだけ

### パストラバーサル対策
- [x] `project_path` の正規化・境界チェック → `src/utils/projectDetector.ts`で`realpath`解決後、`allowedRoot`オプション指定時は配下チェック(2026-07-04)
- [x] シンボリックリンク経由での想定外アクセスも考慮 → 境界チェックはリンク解決後の実体パスで実施。pom.xml探索ではシンボリックリンクのディレクトリを辿らない

### 供給網(サプライチェーン)の信頼性
- [x] 自動ダウンロードする場合、OSV-Scannerバイナリの取得元は公式GitHub Releasesに限定 → URLは`github.com/google/osv-scanner/releases/download/`固定(2026-07-04)
- [x] チェックサム/署名検証を行い、改ざんされたバイナリの実行を防ぐ → ピン留めバージョンのSHA256をソースに埋め込み。キャッシュも使用のたびに再検証
- [x] npm依存パッケージ自体も定期的に(このMCPサーバー自身に対しても)脆弱性スキャンをかける(自己言及的だが重要) → GitHub Actions等でのCI/CD定期スキャン設定完了

### 出力・リソースの安全性
- [x] OSV-Scannerの出力(JSON)をパースする際、不正な形式や巨大出力に対するタイムアウト・サイズ上限を設定 → `runner.ts`でタイムアウト(デフォルト120秒)・stdout上限(32MB)・stderr抜粋上限(8KB)を実装。不正JSONは`invalid_output`エラー(2026-07-04)
- [x] スキャン結果に含まれる外部由来の文字列(パッケージ名、説明文など)をLLMにそのまま渡す際のプロンプトインジェクション耐性も考慮(結果はあくまで「データ」として扱われるよう構造化する) → `utils/externalText.ts`のサニタイザで制御文字(ANSI含む)・ゼロ幅文字・双方向制御文字・Unicodeタグ文字・行区切りを除去+NFC正規化。`unknownJson.ts`のアクセサ(全外部JSON文字列の読み取り経路)と`toolResult.ts`のエラー出力(stderr経路)を単一境界として組み込み(2026-07-05)

### 権限の最小化
- [x] MCPサーバープロセスに必要以上のファイルシステム権限を与えない → v0.10.0でNodeの権限モデル(`--permission`)での動作に対応(任意の多層防御。下記「B3 詳細設計メモ」)
- [x] ネットワークアクセスはOSV-Scannerの照会先(OSV API等)に限定されることを明示し、README等でユーザーに透明性を提供 → v0.3.3でREADMEに通信先の一覧を追加(現在は「Network destinations and privacy」節)。2026-10-07の実機確認でpom.xml/requirements.txtのスキャンはdeps.devにも接続すると判明。バックログB1で対応

### 運用面
- [x] 依存パッケージの自動更新(Dependabot等)をリポジトリに設定 → `.github/dependabot.yml`(npm週次、devDependenciesはグループ化)(2026-07-04)。OSV-Scannerのピン留めバージョンは対象外のため手動更新(binaryDownloader.tsのコメントに手順記載)
- [x] 脆弱性報告用の`SECURITY.md`を早期に用意 → 作成済み(2026-07-04)。GitHubプライベート脆弱性報告(Security Advisories)を窓口とする。(設定有効化済み)

## JAR実体スキャン(v0.2.0候補)設計メモ(2026-07-15)

lockfileが無い・shaded JARしか手元に無いプロジェクトへの対応。Trivy的な「アーティファクト実体スキャン」を既存のピン留めバイナリだけで実現する。

### 実機確認結果(2026-07-15、osv-scanner v2.4.0)

- `osv-scanner scan source --experimental-plugins java/archive <path>` で **JAR内の `META-INF/maven/<g>/<a>/pom.properties` からGAVを復元してスキャンできる**ことを確認(合成JAR: log4j-core 2.14.1 → Log4Shell含む7件検出)
- 中身はOSV-SCALIBRの `java/archive` 抽出器。Spring Boot fat JAR(`BOOT-INF/lib`)・WARのネストJARも再帰展開する
- **重要な発見: 同定不能JARは出力から無言で消える**。メタデータなしJAR単体では `"results": []`(エラーでも警告でもない)。混在ディレクトリでは同定できたJARだけが `results[]` に載り、不能JARは存在の痕跡すらない。**カバレッジ追跡はMCP側の責務**
- 検出限界: pom.properties が手がかりのすべて。maven-shade-plugin はデフォルトで依存のpom.propertiesを同梱したままにするので通常のshaded JARは拾えるが、`minimizeJar`/フィルタでメタデータ除去済みのJARは同定不能(偽陰性)。Trivyはここを SHA1→GAV の事前構築DB(trivy-java-db、数百MB級)で埋めるが、同梱は非現実的。Maven Central Search APIへのハッシュ照会は「照会先はapi.osv.devのみ」という現行のプライバシー特性を崩すため採用しない(注: 2026-10-07の実機確認で、pom.xmlのスキャンは既にdeps.devにも接続していると判明。バックログB1参照)

### ツール設計方針

- **`scan_java_project` とは別ツール(`scan_java_artifact`)として新設する**。lockfile方式=依存グラフが完全、実体スキャン=ベストエフォート同定で精度の意味論が違うため、既存ツールのスキーマは変更しない
- 実装コスト: 固定引数リストに `--experimental-plugins java/archive` を追加+入力パス許可拡張(`.jar`/`.war`)が本体。zip展開はosv-scanner(Go)側で行われるため、Node側にzipパースの攻撃面は増えない
- experimentalフラグのため、ピン留めバージョン更新時にフラグ名の変更有無を確認する(binaryDownloader.tsの更新手順に追記すること)

### 同定不能の扱い(論点3、2026-07-15議論で確定)

脅威モデル: 下流のLLMが `vulnerability_count: 0` を見て「安全です」と誤要約すること。

- **JARごとの状態は3値**: 同定済み・脆弱性あり / 同定済み・既知脆弱性なし / 同定不能。同定不能の検知は、Node側で `*.jar`/`*.war` を列挙(pom.xml探索と同じシンボリックリンク非追従の走査を再利用)し、`results[].source.path` との差分を取る
- **「同定済み」も完全ではない**(40依存中25個分しかメタデータが無いshaded JARでは15個が静かに欠落)。部分欠落はヒューリスティックでも確実に検知できないため、per-JARの推定はせず**レポート全体に completeness を明示**する(CycloneDX SBOMのcomposition completenessが先例)
- **出力スキーマの誤要約対策3点**:
  1. `coverage` オブジェクト(`jars_found` / `jars_identified` / `unidentified_jars[]` / `completeness: "incomplete"`)を**JSONの先頭**に置く(LLMは逐次的に読む)
  2. フィールド名に意味論を焼き込む: `vulnerability_count` ではなく `identified_vulnerability_count`
  3. `unidentified_jars[].hint` は固定文字列(「shaded/minimizedの可能性。ビルド元プロジェクトのlockfileスキャンを推奨」)。`path` はスキャン対象由来のファイル名なので `sanitizeExternalText` を通す(単一境界ポリシーの適用対象)
- **エラーとresultの線引き**: JARが1つも見つからない → 新エラー種別 `no_scannable_artifacts`(`manifest_not_found` と対称)。**全JARが同定不能 → エラーではなく成功レスポンス**(`jars_identified: 0` + completeness警告)。「一部だけ不能」との連続性を保つ

### 残タスク

- [x] `scan_java_artifact` の入力Zodスキーマとcoverage先頭の出力を実装(2026-09-15)。WARを含む外側アーカイブ単位の3状態を返し、全体のcompletenessは常にincomplete
- [x] runner.tsのプラグイン引数対応+上限付きJAR/WAR列挙を実装。列挙済み絶対パスだけを渡し、default pluginsを無効化、`--all-packages`で既知脆弱性のないパッケージも取得。`unknown:unknown`等は同定不能として扱う
- [x] suggest_fixは今回の実装では既存のマニフェスト方式専用を維持。アーティファクトへの拡張は別途検討
- [x] 実プロジェクトのfat JAR(Spring Boot等)・shaded JARでの実機検証 → 2026-10-08に実施(下記「B3 詳細設計メモ」の検証結果)

実装時の検証: ピン留め済み2.4.0で合成JAR、WAR内の`WEB-INF/lib`、Boot形式の`BOOT-INF/lib`、同定済み・既知脆弱性なし、メタデータなしの5ファイルをMCP経由で確認。`--all-packages`では同定不能のプレースホルダーも出力されるため、source.pathの存在だけでなくMaven座標の有効性を確認する。実プロジェクト由来の成果物での検証は上記のとおり未完了。

## SBOM入力スキャン(2026-09-26)

- `scan_sbom`を新設。CycloneDX 1.4/1.5/1.6およびSPDX 2.2/2.3のJSONファイルを受け付ける。XML/tag-value/SPDX 3は対象外
- 許可ルート検証、通常ファイル確認、16MiB上限の読み込み後、専用一時ディレクトリの標準名ファイルへコピー。`sbom`プラグインのみで正確なコピーをスキャンし、成功・失敗ともに削除する
- レポート先頭のcoverageで識別範囲を示し、網羅性・元成果物との一致は未検証と明示。スキャナーが返した空バージョン等はunidentified_packagesへ分離し、識別済み依存の結果を失わない
- 入力SHA256は監査用であり、JARとの一致やSBOM生成元の真正性を証明するものではない
- SBOM生成やビルド実行は含めない。BookmapのJARを補完するには対応ビルドのSBOMが別途必要
- 外部の`osv-scanner-dummy-project`でCycloneDX Maven plugin 2.9.3によるSBOM生成とMaven Shade 3.6.2によるfat JAR生成を検証。7依存の元JAR SHA-256がSBOMと一致し、5,683クラスのバイト列がfat JARと一致。両入力のMCPスキャンで17件の脆弱性識別子・対象パッケージが一致した(件数は照会時点のOSVデータに依存)
- この照合はアプリケーションクラスやrelocation/minimizeのないテスト用成果物に限定。署名・モジュール記述子・その他リソースは対象外で、製品のcoverage保証は変更しない。外部検証スクリプトはnpm配布物に含めない

## 対象エコシステム拡大(JavaScript / Python / Go)詳細設計メモ(2026-10-07)

バックログB2の詳細設計。確定方針(汎用`scan_project`の新設・既存ツール維持・lockfile方式・requirements.txtは欠けを明示して受け付ける)を前提とする。

### 非目標

- パッケージマネージャー・ビルドツールの実行(`npm install` / `pip install` / `uv lock` / `go build`等)。いずれも任意コード実行や外部取得を伴う。lockfileの生成は利用者が信頼できる環境で行う
- Goの呼び出し解析(govulncheck相当。Goツールチェーンとモジュール取得が必要)
- オフラインの脆弱性DB照会、言語別ツールの増設

### 実機確認結果(2026-10-07、osv-scanner v2.4.0)

**読み込めるファイル**(最小構成のフィクスチャで確認):

| エコシステム | ファイル | 開発用依存の区別(`dependency_groups`) |
|---|---|---|
| npm | `package-lock.json` | あり(`dev`) |
| npm | `npm-shrinkwrap.json` | 未確認(パッケージは読める) |
| npm | `yarn.lock`(v1) | なし(形式に情報がない) |
| npm | `pnpm-lock.yaml`(v9) | **なし**(devDependenciesに書いたパッケージも区別されない) |
| npm | `bun.lock`(テキスト形式) | なし |
| PyPI | `poetry.lock` | あり(`dev`) |
| PyPI | `Pipfile.lock` | あり(`develop`→`dev`) |
| PyPI | `uv.lock` | なし |
| PyPI | `pdm.lock` | **不正確**(groups未記載のパッケージが`optional`になる) |
| PyPI | `requirements.txt` | なし |
| Go | `go.mod` | なし(`// indirect`も出力に現れない) |

- `dependency_groups`は形式によって欠落・不正確なため、**生の値として表示するだけにし、優先度判定には使わない**
- lockfileが無い場合: `package.json`だけ・`pyproject.toml`だけのディレクトリはexit 128(パッケージなし)。検出側で案内する必要がある
- `go.mod`は`toolchain`指定があっても標準ライブラリ(stdlib)を報告しない
- `-r`は`node_modules`配下のlockfileを拾わない
- `--lockfile <形式>:<パス>`で、ファイルごとに解析形式を明示して個別にスキャンできる(pom.xmlも可。推移的依存の解決も`-r`と同じく行われる)
- 通信先: lockfileはapi.osv.devのみ。`requirements.txt`はpom.xmlと同じくapi.deps.devで推移的依存を解決する(`--no-resolve`で止まる)。`--index-url` / `--extra-index-url`に書いた任意のURLへは接続しない(deps.devモード)
- OSVの影響範囲の型: npmは`SEMVER`(一部`ECOSYSTEM`)、Goは`SEMVER`のみ、PyPIは`ECOSYSTEM`+`GIT`。パッケージ名はPyPIも小文字に正規化されて返り、OSVレコード側の名前と完全一致した(lodashのアドバイザリにはlodash-es等の別パッケージも並ぶため、名前の完全一致での絞り込みは必須)
- `requirements.txt`: バージョン未固定の行は出力から消え、`>=2.0`は下限`2.0`を使用中バージョンとみなす。**`-r`による取り込みをたどり、相対パスならスキャン対象ディレクトリの外のファイルも読む**(絶対パスの取り込みはたどらない)

**現行版(v0.3.3)の不具合**(上記の確認中に判明):

1. **スキャン範囲の境界の迂回**: Java用ツールは`-r <ディレクトリ>`でスキャンするため、ディレクトリ内の`requirements.txt`も読む。`-r ../../outside/x.txt`を書いた`requirements.txt`を置くと、`OSV_MCP_ALLOWED_ROOT`の外のファイルが読まれ、`名前==バージョン`として解析できた行が結果に含まれ、api.osv.devへ送られる(MCP経由で再現)
2. **suggest_fixの誤表示**: Javaプロジェクトにnpmのlockfileが同居すると、npmパッケージも結果に含まれる。修正版の抽出がMaven専用のため、修正版のあるnpmの脆弱性(lodash: 4.17.21で修正)を「現在より新しい修正版がない(unfixed)」と返す
3. **範囲の不一致**: `manifests`(検出は深さ3まで)と実際のスキャン範囲(`-r`、深さ無制限・全エコシステム)が一致しない。B1のレビュー指摘(深い階層のpom.xml)と同根

### 中核の設計判断: 検出したファイルだけを個別に渡す

`-r <ディレクトリ>`をやめ、検出側(Node)が列挙したファイルだけを`--lockfile <形式>:<絶対パス>`で渡す。JAR実体スキャン(列挙済みの絶対パスだけを渡す)と同じ考え方で、**検出結果を唯一のスキャン範囲にする**。

- 応答の`manifests`と実際のスキャン範囲が常に一致する(不具合3の根本解決)
- Java用ツールは`pom.xml`と`gradle.lockfile`だけを渡すため、`requirements.txt`やnpmのlockfileはスキャンされない(不具合1・2はJava用ツールでは発生しなくなる)
- 解析形式を明示するため、ファイル名からの推測に依存しない
- 代わりに検出側の探索上限が実質的なスキャン範囲になる。深さ3では深い階層のMavenマルチモジュールを取りこぼすため上限を見直し、**上限に達したら黙って打ち切らずエラーにする**(`artifact_search_limit_exceeded`と同様)。実装時の判断(Phase 0): Javaのソースツリー(`src/main/java/com/...`)は深いため、深さ8程度で打ち切るとエラーになるプロジェクトが続出する。そこで深さでは実質打ち切らず(安全弁として64)、上限は探索エントリ総数(20万)とマニフェスト数(1,000)で設け、超過時は`manifest_search_limit_exceeded`。従来の`-r`も全体を走査していたため、処理量は同等

### 検出(`projectDetector`の一般化)

- 対象: 上表のファイル+既存のpom.xml/gradle.lockfile。同じディレクトリに複数のnpm系lockfileがあればすべて渡す(実際に使われているものを推測しない)
- 除外ディレクトリ: 既存(`.git`、`node_modules`等)に加え、`.venv`、`venv`、`site-packages`、`__pycache__`、`.tox`、`vendor`
- lockfileが無いマニフェスト(`package.json`、`pyproject.toml`、`Pipfile`): そのディレクトリをcoverageの`lockfile_missing`に記録し、生成コマンドを案内する(`npm install --package-lock-only --ignore-scripts`等。生成は利用者が信頼できる環境で行う旨を明記)
- エラーと結果の線引き(JAR実体スキャンと同じ): 対応ファイルが1つも無ければエラー(`no_manifest_found`を流用)。一部だけ欠ける場合は成功レスポンスにcoverageで示す

### requirements.txtの扱い

Node側で各行を分類してから渡す(pipは使わない。サイズ上限付きの単純な行解析):

- `名前==バージョン`: スキャン対象
- 未固定・範囲指定(`>=`等): coverageの`unpinned_requirements`に記録。`>=`の行はosv-scannerが下限を使用中バージョンとみなすため、該当パッケージに`version_is_lower_bound: true`を付ける
- `-e`・URL・VCS参照: スキャンできない依存としてcoverageに記録
- **取り込み(`-r` / `--requirement` / `-c` / `--constraint`)**: 取り込み先を取り込み元からの相対パスとして解決し、realpath後に**プロジェクトディレクトリ内**であることを検証する(`OSV_MCP_ALLOWED_ROOT`未設定でも適用)。外を指す・存在しない・シンボリックリンク経由の場合は、そのrequirements.txtをスキャン対象から外し、coverageに理由を記録する。取り込みの連鎖も同様に検証し、深さとファイル数に上限を設ける
- 推移的依存の解決(deps.dev)はpom.xmlと同じ扱い。`dependency_resolution`の警告文は「pom.xml / requirements.txt」に一般化する

### suggest_fixの言語対応

- バージョン比較をエコシステム別に差し替える。インターフェース: 比較・系統(major.minor)の抽出・破壊的変更の判定
  - Maven: 既存の`mavenVersion.ts`
  - npm・Go: Semantic Versioning 2.0.0の優先順位(プレリリースの扱い、ビルドメタデータは無視)。Goは`v`なしで返る版、疑似バージョン(`0.0.0-20190101-abcdef`)、`+incompatible`に対応
  - PyPI: PEP 440(epoch、プレ/ポスト/開発版、ローカル版、正規化)。テストは公開されている参照実装のテストケースを移植する(移植前にライセンスを確認)
- `affectedVersions.ts`: `SEMVER`型の範囲を検証対象に加える。`GIT`型はコミット単位でリリース版と無関係のため、同じaffectedエントリに`ECOSYSTEM`/`SEMVER`型があれば無視する(`GIT`型しか無ければ情報不足のまま)
- `extractFixedVersions`: Maven限定の条件を外し、エコシステム別の比較で並べる
- パッケージ名の照合: PyPIは防御的にPEP 503の正規化(小文字化、`-_.`の連続を`-`)で比較する
- 破壊的変更の扱い: npm・Goでは0.x系のマイナー更新(`0.3`→`0.4`)も`cross_major`として扱う。Goのv2以上はモジュールパス自体が変わる(OSV上も別パッケージ)ため、その旨を注記に含める
- 未対応エコシステム: `verification: "unsupported_ecosystem"`を返し、CVEを`unfixed`に数えない(不具合2の再発防止)
- 直接/推移的依存の区別(v0.6.0): osv-scannerの出力には無い。独自解析が必要なため、JSON(package-lock.json)と行形式(go.mod、requirements.txt)に限定し、YAML/TOMLのパーサー追加は見送る。推移的依存への推奨は「親パッケージの更新」とし、npmの`overrides`はルートプロジェクトでのみ有効な点を推奨文に含める

### 応答スキーマ(`scan_project`)

誤要約対策の原則(JAR実体スキャン)を踏襲し、件数より前に範囲情報を置く:

- `dependency_resolution`(B1と同じ)
- `coverage`: `manifests`(ファイルごとのエコシステムと形式)、`lockfile_missing[]`、`unpinned_requirements[]`、`skipped_files[]`(取り込み先の検証失敗等、理由付き)。ファイル名・行内容は`sanitizeExternalText`を通す
- `ecosystem_breakdown`: エコシステム別の件数
- `packages[]`: 既存の項目に`dependency_groups`(生の値)、`version_is_lower_bound`を追加

### 段階計画と完了条件

- **Phase 0(v0.3.4、修正リリース)**: 既存ツールを「検出したファイルだけを個別に渡す」方式へ切り替え、探索上限の引き上げと上限到達時のエラー化。suggest_fixで非Mavenを`unsupported_ecosystem`にする。完了条件: 上記の不具合1〜3の再現手順を回帰テスト化し、MCP経由で解消を確認
- **v0.4.0**: `scan_project`(全形式の検出、requirements.txtの行分類と取り込み検証、coverage、エコシステム別集計)。suggest_fixはJava以外を`unsupported_ecosystem`のまま
- **v0.5.0**: suggest_fixのnpm/Go対応(semver比較、`SEMVER`範囲、0.x規則)
- **v0.6.0**: suggest_fixのPyPI対応(PEP 440、`GIT`範囲の扱い)、直接/推移的依存の区別
- **以降**: Goバイナリスキャン(ビルド情報からstdlibの版も取得できる)

### テスト方針

- 上表の各形式の最小フィクスチャ(正常系)と、lockfile欠如・取り込みの境界外・未固定行などの異常系
- バージョン比較は各仕様の参照テストケース(semver仕様の例、Goの`golang.org/x/mod/semver`、PEP 440の参照実装)
- MCP経由のE2Eと、接続先の記録(CONNECTプロキシでの確認手順をB1から再利用。npm配布物には含めない)

### 未確認事項

- `npm-shrinkwrap.json`の開発用依存の扱い、旧形式`bun.lockb`(バイナリ)の対応可否、yarn v2以降(berry)のlockfile
- 取り込みの検証で外したrequirements.txtの、取り込み以外の行をスキャンすべきか(部分スキャンを許すか)
- `--lockfile`で個別に渡したpom.xmlが、親POMやモジュールを`-r`の場合と同じく解決するか(マルチモジュールの実プロジェクトで確認)

## suggest_fix npm/Go対応(v0.5.0)詳細設計メモ(2026-10-07)

### 実データの調査結果(2026-10-07、api.osv.dev)

利用者の多いnpm 43パッケージ(脆弱性550件)とGo 27モジュール(947件)のOSVレコードを取得し、対象パッケージの`affected`エントリを集計した。

| 項目 | npm | Go |
|---|---|---|
| 範囲の型 | SEMVER 877 / ECOSYSTEM 1 / 範囲なし 1 | SEMVER 1166 / ECOSYSTEM 6 |
| GIT型 | 0 | 0 |
| `last_affected` | 18 | 24 |
| 同じパッケージに複数の`affected`エントリ | 186 | 118 |
| プレリリースの修正版(`fixed`) | 16(`5.0.0-beta.3`、`15.6.0-canary.61`等) | 118(ほぼ疑似バージョン `0.0.0-20180925071336-cf3bd585ca2a`) |
| ビルドメタデータ | 0 | 34(`20.10.14+incompatible`) |
| SemVerとして解釈できない値 | 1(next: `introduced: "13.0"`) | 7(docker/dockerのGHSA: `19.03.9`、`17.06.0-ce`) |

結論:
- 比較器はSemantic Versioning 2.0.0の優先順位(ビルドメタデータは無視)で足りる。npm・GoともECOSYSTEM型の順序もSemVerと同じため、両方の型を受け付ける
- GIT型は対象のエコシステムに現れないため、無視の規則はv0.6.0(PyPI)で扱う。現れた場合は従来どおり情報不足とする
- SemVerとして解釈できない値を含むレコードは情報不足として扱う(推奨を保留する安全側)。docker/dockerはGO-のレコードが正しくてもGHSA側の`19.03.9`で保留になる。既知の制限として記録し、別名レコードの選び方は実例が増えてから検討する
- プレリリース・疑似バージョンの修正版が候補に普通に混じる。そのまま「最小の検証済み候補」を選ぶとcanary版を推奨してしまう

### 実装中の不具合(公開中のv0.4.0・v0.4.1)

`scan_project`の`fixed_versions`がnpm・Go・PyPIで常に空になる。`extractFixedVersions`がMavenのECOSYSTEM型だけを集めているため(Javaのみの時代の名残)。READMEは「空配列は修正版が存在しないことを意味する」と説明しているため、lodash 4.17.20(4.17.21で修正)を「修正版なし」と読ませてしまう(実機で確認)。suggest_fixはMaven以外を`unsupported_ecosystem`にしているため影響しない。

### 段階計画(2026-10-07 確定: v0.4.2を先に出す)

- **v0.4.2(修正リリース)**: `fixed_versions`の不具合修正
  - SemVer比較器(`src/utils/semverVersion.ts`)を追加し、エコシステムごとの比較を`src/osv/versionScheme.ts`にまとめる(Maven: `mavenVersion.ts`、npm・Go: SemVer、その他: 比較なし)
  - `extractFixedVersions`: Maven・npm・GoはECOSYSTEM/SEMVER型の`fixed`を集めて比較器で昇順に並べる。PyPI等の比較器がないエコシステムはECOSYSTEM型の`fixed`を重複除去してOSVの記載順のまま返す(並び順は保証しない旨をREADMEに書く)。GIT型(コミットハッシュ)は集めない
  - READMEの`fixed_versions`の説明を修正する(空配列の意味、並び順を保証する範囲)
  - 完了条件: lodash・minimist・golang.org/x/textの修正版が`scan_project`の応答に入ることをMCP経由で確認する
- **v0.5.0**: suggest_fixのnpm/Go対応(以下)

### バージョン比較(`versionScheme.ts`)

エコシステムごとに次の操作を提供する: `parse`(解釈できなければnull)、`compare`、`series`(系統)、`isPrerelease`。

- SemVer: `MAJOR.MINOR.PATCH[-pre][+build]`を厳密に解釈する。数値部の先頭ゼロは不正。優先順位はsemver.org 11節のとおり(数値の識別子は数値で比較、英数字は辞書順、数値の識別子は英数字より小さい、識別子が多いほうが大きい)。ビルドメタデータは比較で無視するため、`20.10.14+incompatible`と`20.10.14`は等しい
- 先頭の`v`は防御的に1文字だけ受け付ける(osv-scannerとOSVはGoの版を`v`なしで返すが、念のため)
- Goの疑似バージョン(`0.0.0-20190101120000-abcdef`、`1.3.1-0.20190301021747-ccb9e902956d`)はSemVerのプレリリースとして正しく並ぶため、特別扱いは表示(注記)だけにする
- テスト: semver.org仕様の例と、Goの`golang.org/x/mod/semver`・node-semverのテストケース(移植前にライセンスを確認し、出典を明記)

### 影響範囲の検証(`affectedVersions.ts`)

- 比較を`versionScheme`経由にする。受け付ける範囲の型: MavenはECOSYSTEM、npm・GoはSEMVERとECOSYSTEM。それ以外はこれまでどおり情報不足(`complete: false`)
- `introduced`・`fixed`・`last_affected`・`limit`・`versions[]`のいずれかが解釈できない場合は情報不足とし、その区間は判定に使わない(候補を「影響なし」と言えなくなるだけで、誤って安全と判定する方向には倒れない)

### 推奨の選び方(`suggestFix.ts`)

- 系統の判定をエコシステム別にする。npm・Go(SemVer)では、npmの`^`(キャレット)が互換とみなす範囲を「同じ系統」とする:
  - 1.0.0以上: 従来どおり(`same_minor` / `major_internal` / `cross_major`)
  - 0.x(0.1以上): 同じ`0.minor`内なら`same_minor`。マイナーが変わる更新は`cross_major`(破壊的変更の可能性)。`major_internal`は発生しない
  - 0.0.x: どの変更も`cross_major`
  - 実データでの例: golang.org/x/text 0.3.0は、3件が0.3.8(`same_minor`)で直るが、GO-2026-5970は0.39.0でしか直らないため、推奨は0.39.0(`cross_major`)になる
- **プレリリースの扱い**(2026-10-07 推奨案で確定): 候補の順位を「正式版 → Tier順 → 版の昇順」とし、正式版の候補で全件を解消できない場合だけプレリリース・疑似バージョンを推奨して`recommended_is_prerelease: true`を付ける。同じTierのプレリリースより、上のTierの正式版を優先する(canary版より正式版のメジャー更新を勧める)
- 現在の版を解釈できない場合(npmのgit依存・`file:`依存など)は推奨を出さず、新しい`verification: "unparseable_version"`を返す。CVEは`unfixed`に数えない
- 注記の追加:
  - Go: v2以上は別のモジュールパス(`/v2`等)でOSV上も別パッケージになるため、新しいメジャー系列の修正版は候補に含まれない。修正版候補がない(unfixed)場合とcross_majorの場合に付ける
  - Go: 現在が疑似バージョン(タグのないコミット)である旨
  - 推移的依存の場合: npmは直接依存の更新か`overrides`(ルートの`package.json`でのみ有効)、Goは`go get <module>@<version>`で直接requireに加える。直接/推移的の区別はv0.6.0のため、v0.5.0では条件付きの一般的な注記にとどめる
- PyPIは`unsupported_ecosystem`のまま(v0.6.0)

### suggest_fixの検出範囲と応答(2026-10-07 推奨案で確定)

- 検出を`detectJavaProject`から`scan_project`と同じ`detectProject`に切り替え、スナップショット経由のスキャン(`scanFromSnapshot`)を共有する。Java専用ツール(`scan_java_project`)は変更しない
- 応答: 既存の`project_dir`・`manifests`・`dependency_resolution`・件数・`suggestions`は維持し、`scan_project`と同じ`coverage`を件数より前に追加する。`skipped_manifests`と`scope_warning`は`coverage.skipped_files`と`coverage.warning`に統合して廃止する
- 利用者から見た変更: Javaプロジェクトに同居するnpm・Go・Pythonのlockfileもsuggest_fixの対象になる(PyPIは`unsupported_ecosystem`として表示)
- ツールの説明文(suggest_fix・scan_project)とREADMEの「Javaのみ」を更新する
- 実装時に確認: Gradleのビルドファイル(`build.gradle`)を直接指定した場合の扱いが`detectProject`と`detectJavaProject`で同じか

### 完了条件とテスト

- 単体: SemVer比較器、0.x・0.0.xの系統判定、プレリリースの順位、解釈できない値での情報不足、Goの`+incompatible`
- 実データの期待値(MCP経由、実バイナリ):
  - lodash 4.17.20 → 4.18.0(`major_internal`。4.17.21・4.17.23では4.18.0で直る2件が残る)
  - minimist 1.2.5 → 1.2.6(`same_minor`。0.2.4の区間は現在より古いため候補外)
  - golang.org/x/text 0.3.0 → 0.39.0(`cross_major`、0.x規則)
  - npmのcanary版が修正版に含まれるパッケージ(next等)で正式版が推奨されること
  - Mavenの既存の期待値(log4j 2.14.1 → 2.25.4)が変わらないこと

## suggest_fix PyPI対応・直接/推移的依存の区別(v0.6.0)詳細設計メモ(2026-10-07)

### 実データの調査結果(2026-10-07、api.osv.dev・osv-scanner v2.4.0)

利用者の多いPyPI 49パッケージ(脆弱性3,356件。PYSEC 1,693 / GHSA 1,660)のOSVレコードを取得し、対象パッケージの`affected`エントリを集計した。

| 項目 | 件数 |
|---|---|
| 範囲の型: ECOSYSTEMのみ | 4,357 |
| 範囲の型: ECOSYSTEM + GIT | 402(約8.5%) |
| 範囲の型: GITのみ / 範囲なし | 3 / 4 |
| `versions[]`あり | 4,736(ほぼ全件) |
| `last_affected` | 154 |
| プレリリースの`fixed` / `introduced` | 207 / 313(`3.2a1`等) |
| post版 / epoch | 2 / 0 |
| 正規形でないがPEP 440として正しい値 | 21(Djangoの`1.8c1`、TensorFlowの`2.8.0-rc0`) |
| PEP 440として不正な範囲の値 | 13(PyTorchの`last_affected: "2.6.0-cu124"`、`"2.6.0-NA"`) |

- `versions[]`には`v2.5.2`(先頭の`v`)のほか、GitリポジトリのタグがそのままPEP 440でない値として入る(`0.9-doduo`、`ciflow/periodic/317eeb8`、`nightly-binary`等)。ECOSYSTEM+GITのエントリは全件`versions[]`を持つ
- osv-scannerはPyPIの名前を小文字に正規化して返し(`Jinja2`→`jinja2`、`PyYAML`→`pyyaml`)、OSVレコード側の名前と一致した
- **osv-scannerの出力には直接/推移的の区別がない**(パッケージごとの項目は`name`・`version`・`ecosystem`と`groups`・`vulnerabilities`のみ)。区別するには本サーバーがlockfile・マニフェストを解析する必要がある

### 段階計画(2026-10-07 推奨案で確定)

独立した2つの機能のため分けてリリースする。

- **v0.6.0**: suggest_fixのPyPI対応(PEP 440、GIT範囲の扱い、`versions[]`の扱い、下限スキャンの注記)
- **v0.7.0**: 直接/推移的依存の区別(`scan_project`・`suggest_fix`の両方)

### PEP 440の比較(`src/utils/pep440Version.ts`)

- PEP 440の正規化に従って解釈する: 大文字小文字の無視、先頭の`v`、epoch(`1!`)、リリース番号(末尾のゼロは比較で無視: `1.0` = `1.0.0`)、プレリリース(`a`/`b`/`rc`と別表記`alpha`/`beta`/`c`/`pre`/`preview`、区切り文字`.`/`-`/`_`の省略・番号の省略)、post版(`.post1`、`-1`、`rev`/`r`)、dev版(`.dev1`)、ローカル版(`+cu124`)
- 優先順位: epoch → リリース番号 → `1.0.dev1` < `1.0a1.dev1` < `1.0a1` < `1.0a1.post1` < `1.0b1` < `1.0rc1` < `1.0` < `1.0.post1.dev1` < `1.0.post1`。ローカル版は同じ公開版より後で、区切りごとに数値は数値として、英字は辞書順で比べ、数値は英字より大きい
- プレリリースの判定: プレリリース・dev版を持つ版(post版は正式版扱い)。v0.5.0と同じく、正式版で解消できない場合だけ推奨して`recommended_is_prerelease`を付ける
- 解釈できない値(`2.6.0-cu124`、`0.9-doduo`)はnull
- テスト: PyPA `packaging`(Apache-2.0 または BSD-2-Clause。本プロジェクトはApache-2.0)のバージョン比較テストのケースを移植し、出典を明記する

### Tierの判定(2026-10-07 推奨案で確定)

npm・Goと同じ規則(1.0以上はmajor.minor、0.xのマイナー更新と0.0.xの更新は`cross_major`)を使う。PyPIにはnpmのキャレットのような共通の互換規則はないが、0.x系でマイナー更新が破壊的変更になるパッケージが実在する(FastAPI等)ため、破壊的変更の可能性を少なく見積もらない側に倒す。epochが変わる更新も`cross_major`。日付ベースの版(certifiの`2023.7.22`→`2024.2.2`)は年が変わると`cross_major`になる(安全側)。

### 影響範囲の扱い(`affectedVersions.ts`)

- PyPIのECOSYSTEM範囲をPEP 440で比較する
- **GIT範囲**: 同じaffectedエントリにECOSYSTEM範囲があればGIT範囲は無視する(コミット単位の範囲で、リリース版の判定はECOSYSTEM範囲と`versions[]`が担う)。GIT範囲しかないエントリは従来どおり情報不足
- **`versions[]`の解釈できない値は無視する**(2026-10-07 確定): `versions[]`は「この版は影響を受ける」という等価判定にだけ使う。PEP 440として解釈できない文字列(Gitのタグ名等)は、解釈できる候補と等しくなりえないため、無視しても候補の判定は変わらない。現行(v0.5.0)の規則はこれを情報不足として扱うため、そのままPyPIに適用すると`versions[]`にタグ名が混じるレコードの推奨がすべて保留になる。npm・Goにも同じ規則を適用する(結果が保留から推奨に変わりうるのは、`versions[]`に不正値がある場合だけ)
- 範囲の境界(`introduced`・`fixed`・`last_affected`)の解釈できない値は従来どおり情報不足(PyTorchの`2.6.0-cu124`のレコードは推奨保留。既知の制限)
- 名前の照合はPEP 503の正規化(小文字化、`-`・`_`・`.`の連続を`-`)で比較する(実データでは完全一致したが防御的に)

### 推奨の選び方

- 現行の順位(正式版 → Tier → 版 → ビルドメタデータ)をそのまま使う。PEP 440のローカル版(`+cu124`)はビルドメタデータと同じ扱い(現在の版と有無が同じものを優先)
- **下限でスキャンした依存**: requirements.txtの`>=X`・`~=X`の行は、osv-scannerが下限Xを使用中の版とみなしてスキャンしている(`version_is_lower_bound`)。この場合の推奨は「下限をY以上に引き上げる」意味になるため、`upgrade_note`にその旨を明記する(実際にインストールされる版は異なる可能性がある)
- `update_hint`(PyPI): requirements.txtの版の指定、またはpyproject.toml・Pipfileの指定を更新してlockfileを再生成する。推移的依存は`pip`の制約ファイル(`-c`)や、uv・Poetryの上書き設定で版を指定する

### 直接/推移的依存の区別(v0.7.0、2026-10-07 推奨案で確定)

- osv-scannerの出力にないため、本サーバーがスナップショットのコピーを解析する(新しい外部依存は追加しない)
- 対象: JSONと行形式のみ。YAML・TOMLのパーサーは追加しない
  - `package-lock.json`(v2以降): ルートとworkspaceの`dependencies`等に書かれた名前で、`node_modules/<名前>`の版と一致するものを直接依存とする。推移的依存には、Nodeの解決規則(入れ子の`node_modules`から上位へ探す)で依存関係をたどり、それを要求している直接依存の名前(`introduced_by`、件数上限付き)を付ける
  - `go.mod`: `require`のうち`// indirect`のないものが直接依存
  - `requirements.txt`: 本サーバーが書いたコピーの行が直接依存。それ以外(deps.devで解決された依存)は推移的
  - `pom.xml`: 当面は対象外(候補: `<dependencies>`の名前で判定できるが、親POM・BOMの依存管理を含めて別途検討)
  - それ以外(yarn.lock、pnpm-lock.yaml、bun.lock、poetry.lock、uv.lock、Pipfile.lock、pdm.lock、gradle.lockfile): `unknown`
- 出力: パッケージごとに`dependency_relation`(`direct` / `transitive` / `mixed`(lockfileによって異なる) / `unknown`)。npmの推移的依存には`introduced_by`。`update_hint`は区別に応じて具体化する
- 同じ名前・版が複数のlockfileに現れるため、スキャン結果のパッケージにスキャン元のファイルを保持する(現行は`source_files`をレポート全体でしか持たない)
- 解析は同じファイルを1回だけ、上限付きで行う(`LockfileKeyCache`と同じ考え方)

### 完了条件とテスト(v0.6.0)

- 単体: PEP 440の正規化と比較(`packaging`のテストケース)、Tier、GIT範囲の無視、`versions[]`の不正値の無視、下限スキャンの注記
- 実データの期待値(MCP経由、実バイナリ): requests 2.19.0・urllib3 1.23・jinja2 2.10・django 3.2.0の推奨と、各CVEの`recommended_status`。PyTorchのような不正な境界値は保留
- Maven・npm・Goの既存の期待値が変わらないこと(`versions[]`の規則変更で変わるものは理由を確認する)

## 直接/推移的依存の区別(v0.7.0)詳細設計メモ(2026-10-07)

v0.6.0の設計メモ(上記)で確定した方針(JSONと行形式のみ解析、pom.xmlは当面対象外)の詳細。

### 実データの確認結果(2026-10-07、npm 11・osv-scanner v2.4.0)

`npm install --package-lock-only --ignore-scripts`で、workspace・別名・入れ子を含むpackage-lock.json(v3)を生成してスキャンした。

- ルートの`packages[""]`に`dependencies`・`devDependencies`・`workspaces`。workspaceは`packages/sub`(本体)と`node_modules/sub`(`link: true`、`resolved: "packages/sub"`)の2つのキー
- 別名(`"old-lodash": "npm:lodash@4.17.15"`)は`node_modules/old-lodash`に`name: "lodash"`。osv-scannerは本来の名前で`lodash 4.17.15`と報告する
- 同じ名前の別の版は入れ子に置かれる(`node_modules/qs` 6.7.0はexpress経由、`packages/sub/node_modules/qs` 6.5.2はworkspaceの直接依存)。osv-scannerは名前と版の組ごとに1件で報告する
- osv-scannerは開発用依存に`dependency_groups: ["dev"]`を付ける(既存の出力のまま)
- go.mod: `// indirect`の付いたrequireも報告される。`replace`は適用後の版で報告され(`golang.org/x/text`→`0.3.5`)、パスを変える`replace`は置換先のパスで報告される(`golang.org/x/text => github.com/golang/text`は`github.com/golang/text 0.3.2`)
- requirements.txt: deps.devで解決された依存(`requests==2.19.0`に対する`idna`・`urllib3`)はファイルに書かれていない名前として報告される。`--no-resolve`では書いた依存だけ

### 判定の規則

ファイル(スナップショットのコピー)ごとに、名前と版の組の関係を判定する。

- **package-lock.json(v2以降)**
  - 起点: ルート(`""`)とworkspace(`node_modules/`で始まらないキー)。起点の`dependencies`・`devDependencies`・`optionalDependencies`・`peerDependencies`を、Nodeの解決規則(`<起点>/node_modules/<名前>`から上位の`node_modules`へ順に探す。`link: true`は`resolved`のworkspaceへ)で解決したエントリが**直接依存**
  - 直接依存から`dependencies`・`optionalDependencies`・`peerDependencies`をたどって到達するエントリが**推移的依存**。経由した直接依存の名前を`introduced_by`に集める(別名は依存のキー名ではなく本来の名前)
  - エントリの名前は`name`があればそれ、なければキーの最後の`node_modules/`以降(`@scope/name`を含む)
  - 同じ名前と版のエントリが直接依存でもあり推移的にも到達する場合は`direct`とし、`introduced_by`も付ける(直接依存を更新しても、他の経路の同じ版が残りうるため)
  - どの起点からも到達しないエントリ(extraneous)は`unknown`
  - lockfileVersion 1(依存の木だけでルートの直接依存の一覧がない)は`unknown`
- **go.mod**: `require`のうち`// indirect`の付かないものが`direct`、付くものが`transitive`。`replace`で置換されたモジュールは置換先のパスにも同じ関係を当てる(osv-scannerは置換先のパスで報告する)。`introduced_by`はgo.modだけでは分からないため付けない
- **requirements.txt**: 本サーバーが書いたコピーの行(取り込みを展開した行を含む)の名前が`direct`(PEP 503で照合)、それ以外の名前(deps.devで解決された依存)が`transitive`
- **それ以外の形式**(pom.xml、gradle.lockfile、yarn.lock、pnpm-lock.yaml、bun.lock、poetry.lock、uv.lock、Pipfile.lock、pdm.lock): `unknown`

### スキャン結果との対応付け

- osv-scannerの`results[].source.path`(スナップショットのコピーのパス)とパッケージの組を、パッケージごとに保持する。現行の`parseOsvScanOutput`はファイルをまたいで集約するため、応答に出ない形(シンボルのキー)でパッケージごとのスキャン元を残す(`scan_java_project`等の既存の応答は変えない)
- 複数のファイルに現れるパッケージは、ファイルごとの判定がすべて同じならその値、異なれば`mixed`。`introduced_by`はファイルをまたいで合わせる

### 出力(2026-10-07 推奨案で確定)

`scan_project`の`packages[]`と`suggest_fix`の`suggestions[]`に次を加える。`scan_java_project`・`scan_sbom`・`scan_java_artifact`は変えない。

- `dependency_relation`: `direct` / `transitive` / `mixed` / `unknown`(すべてのパッケージに付ける。値がないと「直接依存」と誤読されうるため、判定できない形式も`unknown`と明示)
- `introduced_by`(npmのみ): その版を推移的に要求している直接依存の名前。最大10件、超えた分は`introduced_by_omitted`に件数
- `declared_in`(npmの直接依存のみ): 直接依存として宣言しているpackage.json(`package.json`、`packages/sub/package.json`)。workspaceの直接依存をどこで更新すればよいかを示す
- `update_hint`(suggest_fix)を関係に応じて具体化する:
  - npmの直接依存: `declared_in`の指定を更新
  - npmの推移的依存: `introduced_by`の直接依存を更新する。直らない場合はルートのpackage.jsonの`overrides`(ルートのプロジェクトでのみ有効)
  - Goの`// indirect`: `go get <module>@<version>`(go.modの`// indirect`のrequireが更新される)。`replace`で置換されている場合は`replace`の版を更新する
  - PyPIの推移的依存: 制約ファイル(`-c`)、またはuv・Poetryの上書き設定
  - `unknown`・`mixed`: 現行の一般的な案内(直接・推移的の両方を記載)

### 上限と安全性

- 解析対象はスナップショットのコピー(検証済み・サイズ上限内)だけ。元のファイルは読まない
- package-lock.jsonは1ファイル1回だけ解析し、解析する合計サイズに上限を設ける(`LockfileKeyCache`と同じ256MiB)。上限を超えたファイルは`unknown`にする(スキャン自体は続ける)
- 依存のたどりは訪問済みのエントリを記録して循環で止める。たどる辺の総数にも上限を設け(例: 200万)、超えたら`unknown`
- 出力する名前・パスは`sanitizeExternalText`を通す

### 完了条件とテスト

- 単体: Nodeの解決規則(入れ子・上位への探索・scope付き名前・link)、別名、workspace、直接かつ推移的、extraneous、lockfileVersion 1、循環、上限、go.modの`// indirect`・`replace`(パスの変更を含む)・単一行と括弧のrequire、requirements.txtの取り込み展開、複数ファイルでの`mixed`
- 実データ(上記のlockfile、MCP経由、実バイナリ): express・lodash(両方の版)・minimist・node-fetch・qs 6.5.2が`direct`(`declared_in`付き)、qs 6.7.0・body-parser・cookie・path-to-regexp・send・serve-staticが`transitive`で`introduced_by: ["express"]`。go.modとrequirements.txtも上記の期待値どおり
- `scan_java_project`等の既存の応答が変わらないこと

## 推奨先のOSV照会(v0.8.0候補)詳細設計メモ(2026-10-08)

### 背景

suggest_fixの推奨は、スキャンで分かった脆弱性(現在の版に該当するもの)の影響範囲だけで検証している。推奨先に、現在の版には該当しない新しい脆弱性があっても分からない。実例: cryptography 3.2の推奨49.0.0は、44.0.0で混入し50.0.0で修正された2件(GHSA-g6cj-pr64-35w5、PYSEC-2026-3552)に該当する(v0.6.0の検証で判明)。

### 実データの確認(2026-10-08、api.osv.dev)

- `POST /v1/query`(パッケージと版)は、その版に該当する脆弱性の**完全なレコード**を返す。既存の影響範囲の検証(`extractAffectedVersions`)と修正版の抽出をそのまま使える
- 版の表記: Goは`v`の有無どちらでも同じ結果。`+incompatible`、Mavenの`group:artifact`、PyPIの大文字・`3.2`と`3.2.0`の違いも受け付けた
- 応答: 脆弱性の多い版でも約300KB・1秒程度(jackson-databind 2.9.8で59件・313KB)。推奨先は脆弱性が少ないため小さい。`next_page_token`(続きのページ)は今回の照会では出なかった
- **試作での検証**(既存のビルド済みモジュールと実APIで、下記のアルゴリズムを実装して実行): 4構成・23パッケージで照会24回。cryptography 3.2は49.0.0(2件該当)→50.0.0(0件)に変わり、他の22件は推奨が変わらず照会1回(推奨先の既知の脆弱性0件)

### アルゴリズム

パッケージごとに、現行の推奨(スキャンした脆弱性の範囲外と確認できた候補)を起点にする。

1. 推奨先をOSVに照会する
2. 該当する脆弱性がなければ確定(`candidate_check: "clean"`)
3. 該当する脆弱性があれば、
   - スキャンで既に知っている脆弱性(IDまたは別名が一致)なのに該当と返った場合は、手元の範囲情報とOSVの判定が食い違っている。安全側に倒し、その候補を除外する
   - 新しい脆弱性は修正対象に加え(影響範囲と修正版を取り込む)、修正版を候補に加える(例: 50.0.0)
4. 候補を選び直して1へ。選び直しは現行と同じ順位(正式版 → Tier → 版 → ビルドメタデータ)で、修正対象(スキャンした脆弱性+照会で見つかった脆弱性)の範囲外と確認できるもの
5. 選び直せる候補がない(新しい脆弱性に修正版がない等)、または照会の上限に達した場合は、最後に照会した推奨を返し、該当する脆弱性のIDを示す(`candidate_check: "has_known_vulnerabilities"`)

照会は推奨を出したパッケージだけに行う(推奨保留・未対応・`unparseable_version`は照会しない)。

### 上限と失敗時の扱い(2026-10-08 推奨案で確定)

- 1パッケージあたり照会4回まで、1回のツール呼び出しで合計60回まで、同時4件まで。1回の照会は15秒・4MiBまで(`explain_vulnerability`と同じ)。続きのページがあれば5ページまでたどり、超えたら失敗扱い
- **照会に失敗しても推奨は出す**(スキャンした脆弱性に対する検証は済んでいるため)。`candidate_check: "failed"`と注記で「推奨先の既知の脆弱性は確認できていない」と示す。上限で照会しなかったものは`"skipped"`
- 照会の失敗でツール全体をエラーにしない

### 送信内容と設定(2026-10-08 推奨案で確定)

- 送信先はapi.osv.devだけ(スキャンと同じ)。送るのは、スキャンで既に照会したパッケージの名前と、推奨候補の版(公開されている修正版)。社内パッケージの名前を新たに送ることはない(osv-scannerがスキャン時に全パッケージの名前と版を照会済み)
- 既定で有効にし、`OSV_MCP_NO_CANDIDATE_CHECK=1`で無効化できるようにする(照会の時間を省きたい場合)。無効時は`candidate_check: "disabled"`

### 出力(suggest_fix)

- `candidate_check`: `clean` / `has_known_vulnerabilities` / `failed` / `skipped` / `disabled`(推奨がない場合は出さない)
- `recommended_known_vulnerabilities`: 推奨先に該当する脆弱性のID(`has_known_vulnerabilities`の場合だけ)
- 照会で推奨が変わった場合は`upgrade_note`に理由を加える(例:「49.0.0は2件の既知の脆弱性に該当するため、50.0.0を推奨」)。`upgrade_tier`・`per_cve_detail`は最終的な推奨に対するもの。照会で見つかった脆弱性は`per_cve_detail`に加えない(現在の版の脆弱性ではないため)が、件数と最初に推奨しかけた版を注記に残す
- 照会で得た外部由来のテキスト(IDのみ出力)は`sanitizeExternalText`を通す

### 実装

- `src/osv/osvApi.ts`に`queryOsvPackageVersion(ecosystem, name, version, options)`を追加(`fetchOsvRecord`と同じくfetchの差し替え・タイムアウト・応答サイズ上限・`readResponseBytes`)
- `src/osv/suggestFix.ts`の候補選定を「修正対象の一覧を受け取って候補を返す」関数に切り出し、照会の繰り返しから再利用する(現行の推奨はこの関数の1回目の結果と一致させる)
- 照会は`handleSuggestFix`(ツール層)で行い、`suggestUpgradeForPackage`は同期・純粋なまま残す(テスト容易性)
- テスト: fetchを差し替えた単体テスト(新しい脆弱性→修正版への切り替え、既知の脆弱性の食い違い、修正版のない新しい脆弱性、失敗・タイムアウト・上限・ページ、無効化)と、実APIでのMCP経由の確認(cryptography 3.2→50.0.0、他の推奨は不変)

## pom.xmlの直接/推移的依存の区別 詳細設計メモ(2026-10-08)

v0.7.0では、親POM・BOM・プロファイル・プロパティの解釈を自前で行うと osv-scanner の解釈とずれる(v0.4.0の親POMの境界の迂回と同じ型の問題)ため、pom.xmlを`unknown`にしていた。

### 実データの確認(2026-10-08、osv-scanner v2.4.0、`--data-source deps.dev`)

親POM(`<dependencies>`と`<dependencyManagement>`)、プロパティ参照のgroupId、testスコープ、optional、`activeByDefault`のプロファイル、版を書かず依存管理から版を得る依存を含むpom.xmlを`--all-packages`でスキャンした。

- **osv-scannerは同じpom.xmlを2つの`results[]`に分けて報告し、`source.type`で区別できる**
  - `type: "lockfile"`: pom.xml(と親POM)に**宣言された依存**。親POMの`<dependencies>`(commons-collections)、プロパティを展開したgroupId(log4j-core)、testスコープ(`dependency_groups: ["test"]`)、optional、`activeByDefault`のプロファイルの依存(commons-text。版は親の`<dependencyManagement>`から)を含む。`<dependencyManagement>`にあるだけの依存は含まない
  - `type: "unknown"`: deps.devで解決された**推移的依存**(jackson-annotations、commons-lang3、log4j-api)
- 宣言もされ、推移的にも要求される依存(jackson-core)は`"lockfile"`の側だけに現れる(重複しない)
- `--no-resolve`では`"lockfile"`の側だけになる(宣言された依存だけをスキャンするため正しい)
- requirements.txtも同じ形(書いた`requests`が`"lockfile"`、deps.devで解決された`certifi`・`chardet`・`idna`・`urllib3`が`"unknown"`)。v0.7.0の自前の判定(コピーに書いた行)と一致する
- osv-scannerの出力には、推移的依存を要求している直接依存(依存グラフ)も、宣言した場所(子か親POMか)も含まれない

### 方針(2026-10-08 推奨案で確定)

**osv-scannerの`source.type`で判定する**(pom.xmlを自前では解析しない)。

- 直接依存の範囲が osv-scanner の解釈(親POM・プロファイル・プロパティ・依存管理)と常に一致する。自前で解釈すると、v0.4.0の親POMの件と同じく解釈のずれが判定の誤りになる
- 文書化された仕様ではないため、osv-scannerのピン留めを更新するときに再確認する(B5の監査と同じ扱い。`binaryDownloader.ts`の注記に追記)。想定外の形(pom.xmlの結果に`"lockfile"`・`"unknown"`以外の`type`がある等)のときは`unknown`にする(誤って直接依存と言わない)
- 代替案(採らない): pom.xmlの`<dependencies>`を自前で解析する。親POMの連鎖・プロファイルの有効化条件・プロパティ展開・BOMを osv-scanner と同じに再現する必要があり、ずれの余地が大きい

### 判定の規則

- pom.xmlのスキャン元(スナップショットのコピー)について、`type: "lockfile"`の結果に現れたパッケージは`direct`、`type: "unknown"`の結果だけに現れたパッケージは`transitive`
- 同じpom.xmlの両方に現れた場合は`direct`(実データでは重複しないが、防御的に)
- それ以外の`type`、`type`がない場合は`unknown`
- requirements.txtはv0.7.0の自前の判定のまま(実データで`source.type`と一致することを確認済み。判定の根拠を増やさない)
- gradle.lockfileは解決済みの全依存の一覧で直接/推移的の情報がないため`unknown`のまま

### 対応付け

- `parseOsvScanOutput`がパッケージごとに保持するスキャン元(`packageSources`、応答には出さない)を、パスだけでなく`source.type`も持つ形にする
- 関係の判定(`RelationLookup`)にスキャン元の`type`を渡し、pom.xmlの判定はそれだけで行う(ファイルは読まない)

### 出力とupdate_hint

- `dependency_relation`をMavenのパッケージ(pom.xml由来)にも付ける。`introduced_by`・`declared_in`は付けない(osv-scannerの出力から分からない)
- `update_hint`(Maven、suggest_fix):
  - 直接依存: pom.xmlの`<dependency>`の版を更新する。版を親POMの`<dependencyManagement>`・プロパティ・BOMで管理している場合は、そちらを更新する
  - 推移的依存: `<dependencyManagement>`で版を指定して上書きする(Mavenの依存の調停で優先される)か、それを要求している直接依存を更新する
  - `unknown`(gradle.lockfile等): 現行の一般的な案内
- 現行のMavenの`update_hint`は無い(npm・Go・PyPIだけ)。Mavenにも付ける

### 完了条件とテスト

- 単体: `source.type`ごとの判定、両方に現れる場合、想定外の`type`、requirements.txt・package-lock.json等の既存の判定が変わらないこと
- 実バイナリ(MCP経由): 上記の構成で、jackson-databind・jackson-core・commons-collections・commons-text・log4j-core・snakeyamlが`direct`、jackson-annotations・commons-lang3・log4j-apiが`transitive`。`--no-resolve`でも宣言された依存が`direct`
- `scan_java_project`の応答は変えない(v0.7.0と同じく`scan_project`・`suggest_fix`だけ)

**実装済み(2026-10-08)**: `parseOsvScanOutput`がスキャン元を`{path, type}`で保持し(応答には出さない)、`pomRelations`が`source.type`で判定。同じファイルの複数の結果は、ファイルごとに直接依存を優先して1つにまとめる(要らない`mixed`を出さない)。Mavenの`update_hint`を追加(`unknown`では付けない)。`binaryDownloader.ts`のピン留めの注記に再確認の対象として追記。実バイナリでMCP経由の確認: 上記の構成で期待値どおり(解決あり・なし)。npm・Go・PyPIとMavenの推奨はv0.8.0と出力のハッシュが一致(5構成)、`scan_java_project`の応答は不変

## B3 詳細設計メモ(2026-10-08)

B3は2項目: (1) JAR/WAR実体スキャン(`scan_java_artifact`)の実物での検証、(2) サーバープロセスの権限の最小化。

### (1) 実物のfat JAR・shaded JAR・WARでの検証

#### 目的

これまでの検証は合成JAR(pom.propertiesを手で入れたもの)だけ。実物の成果物で次を確かめる。

- 同定率: 同梱されたライブラリのうち、osv-scannerが名前と版を復元できる割合(BOOT-INF/lib・WEB-INF/libのネストJARと、shadedで再配置された依存)
- 既知の脆弱性の検出: 古い版の成果物で、同梱ライブラリの既知の脆弱性が実際に検出されるか(陽性対照)
- 応答の正しさ: `coverage`(`jars_found`・`jars_identified`・`unidentified_jars`)と`completeness: "incomplete"`が実態と食い違わないか。特にfat JARの中の同定できないネストJARは、外側のアーカイブ単位の`coverage`には現れない(現行設計の限界)ため、その量を測る
- 性能: 100MB級のfat JARでの所要時間・スナップショットへのコピー(合計2GiBの上限)・出力サイズの上限に収まるか

#### 検証対象(2026-10-08 ダウンロードの許可を得た)

公開リポジトリの成果物をスクラッチ領域にダウンロードし、**実行はせず**スキャンだけ行う。取得後に公開されているチェックサム(Maven Centralの`.sha1`、Jenkinsの`.sha256`)と照合する。

| 種類 | 成果物 | サイズ | 取得元 |
|---|---|---|---|
| Spring Boot fat JAR(新) | io.zipkin:zipkin-server:3.6.1 `-exec.jar` | 135.3MB | Maven Central |
| Spring Boot fat JAR(旧、陽性対照) | io.zipkin:zipkin-server:2.23.2 `-exec.jar`(2021年) | 62.0MB | Maven Central |
| WAR(新) | jenkins.war 2.580.1(最新LTS) | 54.0MB | get.jenkins.io(ミラーへリダイレクト) |
| WAR(旧、陽性対照) | jenkins.war 2.303.3(2021年のLTS) | 72.3MB | get.jenkins.io |
| shaded(依存を再配置) | io.grpc:grpc-netty-shaded:1.84.1 | 10.9MB | Maven Central |
| shaded(旧、陽性対照) | io.grpc:grpc-netty-shaded:1.30.0(2020年、旧nettyを同梱) | 7.1MB | Maven Central |
| shaded | org.apache.calcite.avatica:avatica:1.29.0 | 8.0MB | Maven Central |
| shaded(大規模) | org.apache.hadoop:hadoop-client-runtime:3.5.0 | 30.1MB | Maven Central |

合計約380MB。

#### 正解データの作り方

- ネストJARの一覧: Python標準の`zipfile`で、外側のアーカイブの`BOOT-INF/lib/*.jar`・`WEB-INF/lib/*.jar`と、それぞれの`META-INF/maven/*/*/pom.properties`の有無を列挙する(検証用のスクリプトだけで使い、サーバーにzip解析は入れない)
- shaded JAR: 外側の`META-INF/maven/*/*/pom.properties`の一覧(残っている依存のメタデータ)と、再配置されたパッケージ(例: `io/grpc/netty/shaded/io/netty/`)の有無を比べ、メタデータの残っていない同梱依存を数える
- 陽性対照: 旧版の同梱ライブラリの版をOSV APIで照会し、既知の脆弱性がある同梱ライブラリの一覧を作って、スキャン結果と突き合わせる

#### 結果に応じた対応(検証後に判断)

- 同定できないネストJARが多い場合: 応答に外側のアーカイブごとの「ネストJARの数・同定できた数」を出す案を検討する。ただしNode側でzipを解析することになり攻撃面が増える(現行設計はzip展開をosv-scannerに任せている)ため、上限付きの中央ディレクトリの読み取りだけにする等、別途設計する
- shadedで再配置された依存が同定できない場合: 既知の限界としてREADMEに具体例付きで明記する(SHA1→GAVのDBは採用しない方針のまま)
- 性能・上限の問題があれば修正する

#### 検証結果(2026-10-08、osv-scanner v2.4.0、8成果物はチェックサム照合済み)

| 成果物 | ネストJAR(pom.propertiesなし) | osv-scannerの報告 | うちpom.properties由来 / それ以外から推測 | 応答 |
|---|---|---|---|---|
| zipkin-server 3.6.1 exec | 157(63) | 150件 | 85 / 65 | 19パッケージ・86件、3.5秒 |
| zipkin-server 2.23.2 exec | 111(53) | 112件 | 58 / 54 | 19パッケージ・111件、2.8秒 |
| jenkins.war 2.580.1 | 78(21) | 118件 | 70 / 48 | 1パッケージ・1件、1.9秒 |
| jenkins.war 2.303.3 | 107(32) | 198件 | 98 / 100 | 31パッケージ・119件、3.6秒 |
| grpc-netty-shaded 1.30.0 | -(外側にnettyのpom.properties 14件) | 14件 | 14 / 0 | 7パッケージ・48件 |
| grpc-netty-shaded 1.84.1 | -(pom.propertiesなし) | 1件 | 0 / 1(`jar:grpc-netty-shaded`) | 0件 |
| avatica 1.29.0 | -(pom.propertiesなし、protobuf・jackson等を再配置) | 1件 | 0 / 1(`avatica:avatica`) | 0件 |
| hadoop-client-runtime 3.5.0 | -(外側にpom.properties 68件) | 68件 | 68 / 0 | 7パッケージ・24件 |

- **pom.propertiesがあれば取りこぼしはない**(全成果物で、pom.propertiesのGAVはすべて検出)。shadedでもメタデータを残していれば(grpc-netty-shaded 1.30.0、hadoop-client-runtime)同梱依存を同定できる
- **重大な発見: pom.propertiesのないJARは、osv-scannerがファイル名等からMaven座標を推測し、groupIdを誤る**。例: `spring-beans:spring-beans@5.3.2`(正しくは`org.springframework:spring-beans`)、`armeria:armeria`(`com.linecorp.armeria`)、`bcprov:bcprov-jdk15on`(`org.bouncycastle`)、`jar:grpc-netty-shaded`、`avatica:avatica`、`all:opentelemetry-api`。誤った座標はOSVで照会しても0件になり、**既知の脆弱性を黙って取りこぼす**。実例: zipkin-server 2.23.2のspring-beans 5.3.2はSpring4Shell(CVE-2022-22965)を含む2件に該当するが検出されない。bcprov-jdk15on 1.68(5件)、armeria 1.3.0(1件)も同様。Spring Frameworkの本体JAR(Gradleでビルドされpom.propertiesを含まない)はこの形で一律に取りこぼす
- **現行の`coverage`はこれを「同定済み」と数える**: grpc-netty-shaded 1.84.1・avaticaは推測の座標1件だけで`identified_without_known_vulnerabilities`になり、「同定でき、既知の脆弱性なし」と誤読させる。fat JAR・WARでもネストJARの単位の状況は応答に現れない
- **応答の肥大**: 応答の93%が`affected_versions`(suggest_fixの推奨の検証に使う内部の影響範囲データ。READMEに記載なし)。jenkins.war 2.303.3で555KB中517KB。全スキャンツールの応答に含まれ、LLMの文脈を大きく消費する
- 性能: 135MBのfat JARでも3.5秒。スナップショットのコピー・出力の上限には余裕がある

#### 対応方針(2026-10-08 推奨案で確定。権限の最小化と合わせてv0.10.0)


1. **`affected_versions`を応答から外す**(全スキャンツール)。内部では保持し(パッケージのスキャン元と同じくWeakMap等)、suggest_fixの検証は従来どおり行う。応答は数分の一になる
2. **推測された座標を区別する**: osv-scannerの出力には座標の出所(pom.propertiesか推測か)がない。Node側でzipを解析しない方針は維持し、座標の形で判定する: groupIdに`.`がなく、artifactIdと同じかartifactIdの接頭辞であるもの(`spring-beans:spring-beans`、`armeria:armeria-brave`、`jar:…`)を`coordinates_inferred: true`とする。`commons-io:commons-io`・`junit:junit`のような古い形式の正しい座標も含まれる(安全側の誤検知)
   - `scan_java_artifact`の`coverage`に`inferred_coordinates`(件数と一覧、上限付き)と警告(「groupIdを推測した可能性があり、既知の脆弱性を照合できていない可能性がある。ビルド元のlockfile/pom.xmlのスキャンを推奨」)を追加
   - アーカイブの状態: 推測の座標だけで同定したもの(grpc-netty-shaded 1.84.1、avatica)は`identified_without_known_vulnerabilities`ではなく、新しい状態`inferred_only`にし、`jars_identified`に数えない
   - 座標の補正(Maven Centralやdeps.devでの正しいgroupIdの照会)は、送信先・送信内容が増えるため行わない
3. **READMEに実例付きで限界を明記**: Spring Frameworkの本体JARなどpom.propertiesを含まないJARは、groupIdの推測により脆弱性を取りこぼしうる。正確な結果にはビルド元のlockfile/pom.xmlのスキャン(`scan_project`)を使う

### (2) 権限の最小化

#### 実機確認(2026-10-08、Node 24.18、macOS)

Nodeの権限モデル(`--permission`)でサーバーを起動し、スナップショット方式のスキャンが動くか確認した。

- `--allow-fs-read`(サーバー本体のディレクトリ・スキャン対象・一時ディレクトリ)、`--allow-fs-write`(一時ディレクトリ)、`--allow-child-process`で、検出→スナップショット→スキャン→削除まで動作した
- **一時ディレクトリはsymlinkの解決前・解決後の両方の読み取り許可が必要**(macOSの`/var/folders/...`は`/private/var/folders/...`へのsymlink。`ScanSnapshot.create`の`realpath(os.tmpdir())`が解決前のパスを読む)。片方だけでは`ERR_ACCESS_DENIED`で失敗し、ツールの応答は`internal_error`になる
- 許可外のパスを指定すると、権限モデルの拒否が`project_not_found`(「指定されたパスが存在しません」)と表示される(原因が分かりにくい)
- **`--allow-child-process`が必須で、子プロセスのosv-scannerは権限モデルの制限を受けない**(Node自身もこのフラグは権限モデルを無効にしうると警告する)。osv-scannerには検証済みのコピーだけを渡しているため実害は限定的だが、多層防御としては不完全
- バイナリの自動ダウンロードを使う場合は、キャッシュディレクトリ(`$XDG_CACHE_HOME/osv-scanner-mcp`、既定は`~/.cache/osv-scanner-mcp`)への書き込み許可も必要

#### 方針(2026-10-08 推奨案で確定)

**任意の多層防御として文書化し、権限モデル下で正しく動くようにする**。既定の起動方法は変えない。

- READMEに「権限を絞って起動する」節を追加し、MCPクライアントの設定例(`node --permission --allow-fs-read=... ...`)と、子プロセス(osv-scanner)は制限を受けないことを明記する。OSレベルの隔離(コンテナ、macOSのsandbox-exec等)はさらに強いが、環境依存のため例示にとどめる
- コード側の対応:
  - 権限モデルの拒否(`ERR_ACCESS_DENIED`)を`project_not_found`ではなく専用のエラー(例: `permission_denied`、「Nodeの権限モデルで読み取りが許可されていません」)にする
  - 一時ディレクトリの解決で、解決前のパスの読み取りが拒否された場合の案内(エラーメッセージで両方の許可が必要と示す)
  - 起動時に権限モデルが有効かを`process.permission`で検出し、スキャン対象(`OSV_MCP_ALLOWED_ROOT`)・一時ディレクトリ・キャッシュの読み書きが許可されていなければ、stderrに警告する(fail-closedの起動拒否にはしない)
- テスト: 権限モデル下でサーバーを起動するE2Eテスト(許可内のスキャンが成功、許可外が`permission_denied`)

#### 採らない案

- 既定で権限モデルを有効にする(`npx`での起動ではNodeのフラグを渡せず、クライアント設定の互換性が崩れる)
- osv-scannerをサンドボックスで包む(OSごとの仕組みが必要で保守できない)

### 段階計画(案)

1. (1)の検証(ダウンロードの許可を得てから)。結果をこのメモに記録し、対応が必要なら別途設計
2. (2)のコード対応とREADME(v0.10.0候補)

## Rust(crates.io)対応 詳細設計メモ(2026-10-11)

`scan_project`・`suggest_fix`の対象にRust(`Cargo.lock`)を加える。既存の方針(lockfile方式・検出したファイルだけを個別に渡す・スナップショットのコピーをスキャン・ビルドツールを実行しない)を前提とする。

### 非目標

- `cargo`の実行(`cargo generate-lockfile` / `cargo metadata` / `cargo audit`等)。レジストリ・gitの取得や`.cargo/config.toml`の設定を伴う。lockfileの生成は利用者が信頼できる環境で行う
- Rustバイナリ(cargo-auditable)のスキャン、関数単位の到達性の解析(`affects.functions`の活用)
- crates.ioのAPI照会(yanked版の確認等)。通信先を増やさない

### 実機確認結果(2026-10-11、osv-scanner v2.4.0・api.osv.dev)

手書きの最小フィクスチャ(workspace・pathの依存・gitの依存・別レジストリ・同名の複数版)で確認:

- `--lockfile Cargo.lock:<パス>`で読める。エコシステムは`crates.io`、`source.type`は`lockfile`、`dependency_groups`は出ない。lockfileの形式はv1(`[metadata]`のchecksum・`"名前 版 (source)"`形式の依存)・v3・v4のいずれも読める。`[[patch.unused]]`は無視される。`sparse+https://index.crates.io/`も通常どおり
- `Cargo.toml`は解析形式として指定できない(exit 127「could not determine extractor」)。`Cargo.toml`だけのディレクトリはスキャンできない
- **sourceを見ずに全パッケージをcrates.ioとして照会する**: workspaceのメンバー・pathの依存(`source`なし)、gitの依存(`git+...`)、別レジストリの依存(`registry+https://my-company.example/index`)も`crates.io`として照会され、同名・同版のcrates.ioのアドバイザリが付く。ローカルのcrateを`failure 0.1.8`、gitのforkを`smallvec 1.6.0`、別レジストリのcrateを`atty 0.2.14`にすると、いずれもcrates.ioの脆弱性が報告された(誤検知)。あわせて**社内crateの名前がapi.osv.devへ送られる**。cargo-auditはcrates.io由来のパッケージだけを照合するため挙動が異なる
- OSVのレコード(代表的な50 crateの360件): 範囲の型は`SEMVER`のみ(`GIT`・`ECOSYSTEM`なし)。IDは`RUSTSEC-*`と`GHSA-*`。`introduced: "0.13.0-0"`のようにプレリリースの最小値を下限にする記法が多い。`fixed`のない範囲が15件、`last_affected`が4件、`versions[]`の列挙が20件。ビルドメタデータ付きの版(`openssl-src`の`111.25.0+1.1.1t`等)はこの範囲の境界には現れなかった
- **RustSecの情報提供アドバイザリ**: `affected[].database_specific.informational`が`unmaintained`(保守終了)・`unsound`(健全性の欠陥)・`notice`のレコードがある(上記360件中で`unsound` 21件、`unmaintained` 7件)。osv-scannerの出力にもそのまま含まれ、通常の脆弱性と区別されない。多くは`introduced: "0.0.0-0"`だけで修正版がない(例: `atty`のRUSTSEC-2024-0375)。一方、GHSAが同じ欠陥を脆弱性として登録していると同じグループにまとまる(`failure`: unsoundのRUSTSEC-2019-0036・unmaintainedのRUSTSEC-2020-0036・GHSA 2件が1グループでCVSS 9.8)。cargo-auditは情報提供を既定で警告として別扱いにする

### 中核の設計判断1: スキャンするのはcrates.io由来のパッケージだけ(コピーを生成する)

requirements.txtと同じく、元の`Cargo.lock`はosv-scannerに渡さず、**本サーバーが解析した結果からcrates.io由来のパッケージだけを書いたコピー**をスキャンする。

- 対象: `source`が`registry+https://github.com/rust-lang/crates.io-index`または`sparse+https://index.crates.io/`のパッケージ
- `[replace]`で置換されたパッケージ(`replace = "名前 版 (source)"`を持つもの)は使われないためスキャンしない。置換先は別の`[[package]]`として記載され、そのsourceで分類する(cargo 1.98で確認: pathへの置換は`replace = "anyhow 1.0.102"`とsourceなしの置換先)。置換先を解釈できない・記載が無い場合はファイル全体を除外する(レビュー指摘、2026-10-11: `replace`をchecksumと同様に読み飛ばすと、置換元のcrates.ioのcrateが残り、使っていない版の脆弱性を報告する)
- `source`なし(workspaceのメンバー・pathの依存): 利用者自身のコードとしてスキャンしない。coverageには数だけ示す(`local_crates`)。完全性(`complete`)には影響させない
- `local_crates`・`unscannable_crates`は、Cargo.lockをスキャンした場合だけcoverageに付ける(従来の応答を変えない)
- gitの依存・別レジストリの依存: スキャンしない。第三者のコードが未検査なので、`coverage.unscannable_crates[]`に名前・版・理由(git: 版がcrates.ioのリリースと対応しない / 別レジストリ: crates.ioと同名でも別物で、名前を外部に送らない)を記録し、`complete: false`にする。sourceのURLは応答に出さない(認証情報やホスト名を含み得る)
- コピーの形式: `version = 3`と、各パッケージの`name`・`version`・`source`だけの`[[package]]`。osv-scannerが読む内容は常に本サーバーが生成したものになる(解析の食い違いによる取りこぼし・境界外の読み込みが起きない)
- 解析器(`src/utils/cargoLock.ts`): cargoが生成する範囲のTOMLだけを受け付ける厳格な行解析(TOMLの汎用パーサーは追加しない)。受け付ける行: コメント・空行、先頭の`version = 整数`、`[[package]]`、`[[patch.unused]]`(読み飛ばす)、`[metadata]`(v1。読み飛ばす)、`キー = "文字列"`、`dependencies = [`〜`]`の各行の`"..."`。文字列のエスケープは`\"` `\\` `\uXXXX`程度。**想定外の行が1つでもあればファイル全体をスキャン対象から外し**、`skipped_files`に理由を記録する(部分的に読んで取りこぼしを隠さない)。サイズ・パッケージ数の上限は既存の読み込みの上限を共用
- 同じパッケージの重複(name・version・sourceが同じ)はコピーで1つにまとめる

### 中核の設計判断2: 情報提供アドバイザリを脆弱性と区別して示す

保守終了・健全性の欠陥を「脆弱性」として件数に含めると、LLMが重大度を誤って要約する。一方で隠すと保守終了のcrateを見落とす。

- 判定: グループに関連する**すべてのID**(グループの`ids`・`aliases`と、各レコードの`aliases`)について詳細のレコードがあり、そのすべてが、そのパッケージの`affected[]`のすべてに`database_specific.informational`(既知の種類)を持つ場合だけ、そのグループを情報提供とする。GHSA等が脆弱性として登録していれば(1件でも`informational`なし)従来どおり脆弱性(上の`failure`は脆弱性のまま)。**詳細の欠けたID・未知の種類があれば分類を確かめられないため脆弱性として扱う**(レビュー指摘、2026-10-11: 「取得できたレコードのすべて」では、RustSecの情報提供レコードだけ詳細があり、aliasesにだけ現れるGHSAの詳細が欠けた場合に脆弱性から外してしまう)。実データ(情報提供のレコード36件)では10件がGHSA・CVEのaliasesを持ち、通常はGHSAも`ids`に詳細付きで含まれる
- 出力: 該当グループの`ScanReportVulnerability`に`informational: "unmaintained" | "unsound" | "notice"`(複数の種類なら`unsound` > `unmaintained` > `notice`の順で1つ)を付ける。`packages[]`には残す
- 件数: 情報提供のグループは`vulnerability_count`・`severity_breakdown`・`vulnerable_package_count`に数えず、`informational_count`(新設)に数える。実装時の判断: `informational_count`は1件以上の場合だけ付ける(scan_java_project等は報告をそのまま展開するため、常に付けると従来の応答が変わる)。scan_project・scan_sbom・`ecosystem_breakdown`も同じ。suggest_fixの`vulnerable_package_count`も情報提供だけのパッケージを数えない情報提供だけのパッケージも`packages[]`に含め、並び順は脆弱性のあるパッケージの後ろ
- 既存のエコシステムへの影響: `informational`はRustSec由来のレコードだけが持つため、Maven・npm・PyPI・Goの応答は変わらない(回帰テストで確認)

### 検出(`manifestDetector.ts`)

- `Cargo.lock` → エコシステム`crates.io`。解析形式`Cargo.lock`を`MANIFEST_FORMATS`に追加(osv-scannerにはコピーだけを渡す)
- `Cargo.toml`(lockfileなし) → `lockfile_missing`。案内は「信頼できる環境で`cargo generate-lockfile`を実行してから再スキャン(依存の取得を伴う)」。ライブラリのcrateはCargo.lockをコミットしない慣習が長かったため、ここに記録されるケースが多い旨をREADMEに書く
- workspace: メンバーの`Cargo.toml`はサブディレクトリにあり、`Cargo.lock`はworkspaceのルートにだけある。上位の`Cargo.lock`に、メンバーの`[package] name`と同名の`source`なしパッケージがあり、**かつ`Cargo.lock`と同じディレクトリの`Cargo.toml`の`[workspace]`の`members`・`exclude`で所属を確認できた場合だけ**充足とする(レビュー指摘、2026-10-11: 名前だけでは、ルートの`app@0.1.0`と独立したサブプロジェクトの`app@0.2.0`を区別できず、サブ側の欠落を隠す)。所属の規則はcargo 1.98で確認: `members`はglob(`*`・`?`のみ対応。`**`・`[...]`等は判定できない)で展開し、`exclude`はパスの前方一致で除くが、`members`に文字どおり書かれたパスの配下は`exclude`より優先する。Cargo.tomlは文字列・配列の外で始まる行だけを見出し・キーとして読む(レビュー指摘、2026-10-11: 行ごとに判定すると、`description = """`の複数行文字列の中の`[workspace]` / `members = ["sub"]`を本物の設定と誤認し、独立した`sub`の欠落を再び見逃す。`[package] name`の読み取りも同様)。閉じない文字列・括弧の不整合、読み落としの可能性がある書き方(引用符付きのキー、ルートのテーブルの`workspace.`のドット付きのキー、配列内の複数行文字列)は解釈できないものとしてnull。同名があっても所属を確認できなければ`unconfirmed`(workspace外のpathの依存は収録されているが、同名の独立crateと区別できないため。ルートに`[workspace]`の無いプロジェクトのpathの依存も`unconfirmed`になり`complete: false`になる。依存元のCargo.tomlの`path = "..."`との照合は今後の改善)。同名のパッケージが無ければ`status: "missing"`(workspaceのメンバーでもpathの依存でもないため、そのcrateは別のlockfileを使う)。`name`は`[package]`テーブルの`name = "..."`だけを行解析で読み、読めなければ(virtual manifest・`name.workspace`等)`status: "unconfirmed"`
- 除外ディレクトリ: `target`は既存。`.cargo`(レジストリのキャッシュ等)を追加。`vendor`は既存(`cargo vendor`の出力を含む)

### 直接/推移的依存の区別(Cargo.lockから)

- `source`なしのパッケージ(workspaceのメンバー・pathの依存)を起点とし、その`dependencies`にあるパッケージを**直接**、それ以外の到達できるパッケージを**推移的**とする。推移的依存には、起点からたどって最初に通る直接依存を`introduced_by`(最大10件、npmと同じ)に付ける
- `dependencies`の要素は`"名前"`・`"名前 版"`・`"名前 版 (source)"`の3形式。名前だけで複数版がある等で一意に決まらなければ、そのパッケージは`unknown`
- Cargo.lockには開発用・ビルド用・対象OS限定の依存の区別がない(`[dev-dependencies]`・`[build-dependencies]`・`[target.'cfg(windows)'.dependencies]`もすべて含まれる)。直接/推移的の区別だけを示し、本番で使われるかは判定しない旨をREADMEに書く
- gitの依存の配下にあるcrates.ioの依存も推移的として扱う(`introduced_by`はgitのcrate名)

### suggest_fix

- バージョン比較: `crates.io`をSemVerのエコシステムに加える(`versionScheme.ts`)。Cargoのキャレット(`^`、既定の要求)はnpmと同じ規則(1.0以上はメジャーが同じなら互換、0.xはマイナーまで、0.0.xは完全一致)のため、`classifyCaret`をそのまま使う。すなわち正式版の推奨で`cross_major`でなければ、Cargo.tomlの既定の要求の範囲内で更新できる(プレリリースの推奨は例外。下記`update_hint`)
- 情報提供のグループは修正版の推奨の対象にしない(`unmaintained`は版を上げても解消しない)。`per_cve_detail`に`informational`を付けて残し、`unfixed`の件数に数えない。注記に「保守終了のcrateは代替への移行を検討」を含める
- 推奨先のOSV照会(`candidateCheck.ts`): 候補に該当するレコードのうち、`unmaintained`・`notice`の情報提供はcrate全体の状態で版の選択に関係しないため無視する。`unsound`は版ごとの欠陥のため従来どおり既知の脆弱性として扱う
- `update_hint`(直接/推移的とTierで分ける):
  - 直接・`cross_major`以外: `cargo update -p <name>@<現在の版> --precise <推奨版>`でCargo.lockだけを更新できる(Cargo.tomlの要求が`=`や`~`で固定されていれば要求を変更)
  - 直接・`cross_major`: 依存元のcrate(`source`なしのパッケージ名)のCargo.tomlの要求を変更する
  - 推移的・`cross_major`以外: 同じく`cargo update -p <name>@<現在の版> --precise <推奨版>`(依存元の要求が許す範囲なら、Cargo.tomlを変えずに更新できる)
  - 推移的・`cross_major`: `introduced_by`の直接依存を、推奨版を許す要求の版へ更新する必要がある。`[patch.crates-io]`は要求範囲を強制的に変える仕組みではなく、同じcrateを別のソース(修正を取り込んだforkやバックポート)に差し替える仕組みで、差し替え先の版も依存元の版要求を満たす必要がある(Cargo公式文書「Overriding Dependencies」)。そのため案内は「依存元の要求の範囲内の修正版(バックポート)を`[patch.crates-io]`で使う」場合に限定し、メジャー更新の代替としては示さない(レビュー指摘、2026-10-11)
  - **プレリリースの推奨**(`recommended_is_prerelease`): Cargoの要求(`"1.2"`等の既定のキャレット)は、要求自体にプレリリースを書かない限りプレリリース版に一致しない(Cargo公式文書「Specifying Dependencies」)。`cross_major`でなくても`cargo update --precise`だけでは更新できないことがあるため、直接依存なら要求をプレリリース版に変更し(`"=1.3.0-rc.1"`等)、推移的依存なら依存元の要求がその版を許す必要がある旨を案内する(レビュー指摘、2026-10-11)。上の「`cross_major`でなければ既定の要求の範囲内」は正式版の推奨に限る
  - `<name>@<版>`の指定は、同じcrateの複数版がCargo.lockにある場合に対象を一意にするため

### 段階計画(推奨案)

- **v0.12.0**: `scan_project`のCargo.lock対応(解析器・crates.io由来だけのコピー・`local_crates`/`unscannable_crates`・`lockfile_missing`とworkspaceの確認)と、情報提供アドバイザリの区別(`informational`・`informational_count`)。suggest_fixはcrates.ioを`unsupported_ecosystem`のまま
- **v0.13.0**: suggest_fixのcrates.io対応(SemVer比較・情報提供の扱い・候補照会での除外)と、Cargo.lockからの直接/推移的依存の区別・`update_hint`

### 完了条件とテスト

- 解析器: v1/v3/v4、`[[patch.unused]]`、`[metadata]`、同名の複数版、依存の3形式、エスケープ、想定外の行・壊れた入力でファイル全体を除外、サイズ上限
- 誤検知の回帰テスト: ローカル・git・別レジストリのcrateに同名のcrates.ioの脆弱性がある場合に、報告されず`unscannable_crates`・`local_crates`に示されること(偽スキャナーでコピーの内容を検証し、実バイナリでMCP経由でも確認)
- 情報提供: 情報提供だけのグループ・GHSAと混在するグループ・詳細の欠けたaliases・件数の分離・既存エコシステムの応答の不変(v0.11.0のworktreeとの出力ハッシュの比較)
- v0.13.0の`update_hint`: プレリリースの推奨(要求の変更が必要な旨)、推移的依存の`cross_major`(依存元の更新。`[patch.crates-io]`をメジャー更新の代替として示さない)
- 実バイナリでMCP経由の確認(複数言語の混在を含む)と、接続先がapi.osv.devだけであること

### v0.12.0の実装結果(2026-10-11)

- 実装: `src/utils/cargoLock.ts`(解析・分類・コピーの生成・Cargo.tomlのname)、`manifestDetector.ts`(`CargoLockCache`で解析を1回にし、workspaceの確認とスキャン対象の生成で共用)、`scanProject.ts`(コピーの書き込み・coverage)、`scanReport.ts`(`informational`・`informational_count`・`hasVulnerability`)
- osv-scannerは`--lockfile Cargo.lock:<生成したコピー>`(拡張子`.txt`)でも読むことを実機で確認
- 実バイナリでMCP経由の確認: 誤検知のフィクスチャ(ローカルの`failure`・gitの`smallvec`・別レジストリの`atty`)で、crates.io由来の`time`だけが報告され、3件は`local_crates`・`unscannable_crates`に出た。workspaceのフィクスチャで`atty`のunmaintainedが情報提供になり、GHSAと混在するunsoundは脆弱性のまま。Cargo.lockだけのスキャンの接続先はapi.osv.devだけ(CONNECTプロキシで確認)。5エコシステム混在でも件数が分かれる
- 回帰: npm・Go・PyPI・Gradleの混在プロジェクトで、scan_project・suggest_fixの応答がv0.11.0とバイト単位で一致(候補照会は無効にして比較)
- 変異確認: 全crateをスキャン対象にする変更・情報提供の判定を外す変更・aliasesを判定に含めない変更・`[replace]`の置換元を除かない変更・名前だけでworkspaceの所属を判定する変更・Cargo.tomlを行ごとに判定する変更で、それぞれ追加したテストが失敗する
- cargoで生成したlockfile(`--offline`、ダウンロードなし)での確認: `[replace]`でpathに置換した`anyhow`はスキャンされない(osv-scanner単体では置換元をスキャンする)。members・exclude・globのworkspaceで、非メンバーと除外したcrateは`missing`

### 未確認事項

- 実プロジェクト(大きなworkspace、cargo vendor・source置換を使うもの)のCargo.lockでの解析の成否と所要時間。生成済みのCargo.lockの取得はダウンロードを伴うため、実施時に許可を得る
- `cargo update --precise`の実機確認(レジストリの取得を伴う)
- osv-scannerの将来の版で、sourceによる絞り込みや`informational`の扱いが変わるか(2.6.0へのピン更新時に再確認)

## suggest_fixのRust対応・Cargo.lockの直接/推移的依存(v0.13.0)詳細設計メモ(2026-10-13)

上の「Rust(crates.io)対応 詳細設計メモ」のv0.13.0部分の詳細。v0.12.0の`Cargo.lock`解析・crates.io由来だけのコピー・`informational`を前提とする。

### 設計中に見つかった公開中の不具合(v0.8.0〜v0.12.0、全エコシステム)

**推奨先のOSV照会が、修正版のない既知の脆弱性を「判定の食い違い」と誤認して推奨を保留する。** `candidateCheck.ts`は、照会で返ったレコードのIDがスキャンで既に知っている脆弱性なら、無条件に「手元の範囲情報とOSVの判定が食い違っている」とみなして候補を除外する。しかし修正版のない脆弱性(`tier: "unfixed"`)は修正対象ではなく、推奨先にも該当するのが正しい(手元の判定も`recommended_status: "affected"`)。そのため、修正できる脆弱性と修正版のない脆弱性を併せ持つパッケージでは、照会を有効にすると(既定)推奨が必ず保留になる。

- 実データでの再現(2026-10-13、v0.12.0): PyPIの`ecdsa==0.13`。照会なし(`OSV_MCP_NO_CANDIDATE_CHECK=1`)では`0.19.2`を推奨(`verified`、PYSEC-2026-1325は`unfixed`で推奨先でも`affected`)。照会ありでは`candidate_check: "conflict"`・`recommended_upgrade: null`になり、注記は「範囲情報が食い違う」と誤った説明をする
- 単体でも再現: 修正版あり(`0`〜`1.5.0`)と修正版なし(`0`〜)の2件を持つnpmパッケージで、照会が修正版なしの脆弱性を返すと`conflict`
- Rustでは、全版に該当する`unmaintained`(例: `atty`のRUSTSEC-2024-0375)が同じ形になるため、v0.13.0の前提としても修正が要る

**修正(v0.12.1として先に出すことを推奨)**: 既知のIDのレコードは、その脆弱性が**修正対象**(`tier`が`unfixed`以外。推奨は全修正対象の範囲外と確認済み)の場合だけ食い違いとして扱う。修正対象でない既知の脆弱性(`unfixed`。v0.13.0では情報提供も)のレコードは、手元の判定と矛盾しないため無視する(修正対象にも加えない)。推奨先に該当することは`per_cve_detail[].recommended_status`で既に示している。`candidate_check: "clean"`の意味は「スキャンで示した脆弱性のほかに、推奨先に該当する既知の脆弱性はない」と明記する(README・ツールの説明)。

**v0.12.1の実装結果(2026-10-13)**: `candidateCheck.ts`で、`unfixed`の脆弱性のIDと別名だけに一致するレコードを照会結果から除く(別名が修正対象の脆弱性とも重なる場合は修正対象を優先し、従来どおり食い違いとして扱う。照会で新しく見つかった脆弱性は除かない)。回帰テスト4件(主ID・別名、新しい脆弱性との混在、修正対象と重なる別名、ecdsaの形)は修正を外すと失敗する。実データでMCP経由: `ecdsa==0.13`は`0.19.2`(`clean`・`verified`、PYSEC-2026-1325は`affected`)。npm・Go・PyPI・Gradleの16パッケージで照会ありの応答をv0.12.0と比較し、変わったのは`ecdsa`だけ

### 実データの確認(2026-10-13、api.osv.dev・cargo 1.98)

**推奨の成否**: 既知の脆弱性を持つ実在の38パッケージ(44 crateから)の`Cargo.lock`で、`versionScheme`だけcrates.ioを有効にした一時ビルド(照会なし)を実行:

- 33件が`verified`。`same_minor`(`smallvec 1.6.0→1.6.1`、`openssl 0.10.30→0.10.79`等)、`major_internal`(`tokio 1.8.0→1.38.2`)、`cross_major`(`time 0.1.43→0.2.23`、`idna 0.2.3→1.0.0`等)
- 4件(`failure`・`atty`・`ansi_term`・`yaml-rust`)は修正版のない情報提供・unsoundだけ → 下記の情報提供の扱いで整理する
- `rustls 0.20.0`は`no_verified_candidate`: GHSA-6g7w-8wpp-frhjの`affected[]`に`versions: ["0.20"]`(SemVerでない)だけのエントリがあり、未記載の版が非該当と言えないため保留(既存の安全側の扱いで正しい。データの不備)
- `borsh 0.9.0→1.0.0-alpha.1`(プレリリースの推奨): GHSAが`0`〜`1.0.0-alpha.1`を該当とするため、0.10.4では解消しない。プレリリースの案内(下記)が必要な実例
- ビルドメタデータ: `openssl-src 111.10.0+1.1.1g→111.25.0`、`libgit2-sys 0.12.0+1.1.0→0.16.2`。OSVの修正版はメタデータなしで、実際の版は`111.25.0+1.1.1t`等。cargoでは`--precise 0.7.5`(メタデータなし)も`-p toml_datetime@0.7.5+spec-1.1.0`(あり)も通る(cargo 1.98で確認)ため、推奨版をそのまま案内に使える

**Cargo.lockの依存の記法**(cargo 1.98で生成): 同名のパッケージが1つなら`"名前"`、複数の版があれば`"名前 版"`(`"anstream 0.6.21"`・`"anstream 1.0.0"`)。同名・同版でsourceが異なる場合だけ`"名前 版 (source)"`。v1形式は常に`"名前 版 (source)"`

**`cargo update --precise`**(`--offline`、ダウンロードなし): 
- 直接依存・要求の範囲内(`anyhow = "1.0.102"`で`--precise 1.0.103`): Cargo.lockだけが更新される
- 同名の複数版がある場合、`-p anstyle-parse`は拒否され(`anstyle-parse@0.2.7`等の指定を求める)、`-p anstyle-parse@0.2.7 --precise 0.2.6`は推移的依存でも通る
- 要求の範囲外(`anstream = "=0.6.21"`に`--precise 1.0.0`): 失敗する(Cargo.tomlの変更が必要)

### バージョン比較・Tier

- `versionScheme.ts`の`SEMVER_ECOSYSTEMS`に`crates.io`を加える(範囲の型は`SEMVER`。実データは`SEMVER`のみ)。Tierはnpmと同じキャレットの規則(`classifyCaret`)
- パッケージ名は完全一致で照合する(OSVの名前とCargo.lockの名前は同じ表記。crates.ioは`-`と`_`の違いだけの名前の重複を禁止しているが、表記は公開時のまま)

### 情報提供のアドバイザリ(suggest_fix)

- `informational`のグループは修正対象にしない(候補の検証にも使わない)。`per_cve_detail`には`tier: "informational"`(新設)と`informational`(種類)を付けて残し、`recommended_status`(推奨先での判定)も示す。`unfixed_vulnerability_count`には数えない
- 情報提供だけのパッケージ: 推奨は出さず、`verification: "informational_only"`(新設)。注記は種類別(`unmaintained`: 版を上げても解消しないため代替crateへの移行を検討 / `unsound`: 修正版があれば`fixed_versions`を確認 / `notice`: 内容を`explain_vulnerability`で確認)
- 推奨先の照会: 既知の情報提供は上の修正で無視される。照会で新しく見つかったレコードのうち、`unmaintained`・`notice`(`recordInformationalKind`で判定)はcrate全体の状態で版の選択に関係しないため無視し、`unsound`は版ごとの欠陥のため新しい脆弱性として修正対象に加える(設計メモ「Rust(crates.io)対応」のとおり)

### Cargo.lockの直接/推移的依存(`dependencyRelations.ts`に`cargoLockRelations`)

- 入力: 検出時に解析済みの全パッケージ(`CargoLockCache`の結果に保持する。コピーには依存を書かないため、スナップショットのコピーは読まない。requirements.txtと同じく検出時の検証済みデータを渡す)
- 依存の解決: `"名前"`は同名のパッケージが1つの場合だけ、`"名前 版"`は同名・同版が1つの場合だけ、`"名前 版 (source)"`は完全一致で解決する。解決先が`replace`を持てば置換先へたどる。解決できない参照があれば、その参照元から先は判定しない(到達できないパッケージは`unknown`)
- 起点: sourceなしのパッケージ(workspaceのメンバー・pathの依存。置換先のpathのcrateを含む)。起点の依存にあるcrates.io由来のパッケージが**直接**、直接依存(gitの依存・別レジストリのcrateを含む)から到達できるものが**推移的**。推移的依存には、到達経路の最初の直接依存を`introduced_by`(最大10件、npmと同じ)に付ける。直接依存が他の依存からも要求される場合は`direct`のまま`introduced_by`も付ける(npmと同じ)
- 開発用・ビルド用・対象OS限定の依存の区別はできない(Cargo.lockに情報がない)
- `declared_in`: 直接依存を宣言しているローカルのcrateのCargo.toml(プロジェクトからの相対パス)。検出時に見つけたCargo.tomlの`[package] name`(`cargoTomlPackageName`)と名前で対応付け、依存元のすべてのcrateを一意に対応付けられた場合だけ付ける(同名のCargo.tomlが複数・プロジェクト外のpathの依存等で対応できなければ付けず、案内文にcrate名を示す)。Cargo.tomlの読み込みは既存の上限(1件1MiB、合計の上限)の範囲
- 上限: 依存の辺の数はnpmと同じ上限(`MAX_DEPENDENCY_EDGES`)。超えたら`unknown`
- スキャン結果との対応: osv-scannerの結果のパッケージ(名前・版)を、そのCargo.lockのcrates.io由来のパッケージと対応付ける(コピーには同名・同版が1つしかない)

### `update_hint`(crates.io)

推奨版・現在の版・crate名を埋め込む。crate名は解析時に文字の範囲を検証済み、推奨版はOSV由来の外部データのため`^[0-9A-Za-z.+-]{1,64}$`に一致する場合だけ埋め込み、一致しなければ一般的な文にする。

| 依存 | Tier | 案内 |
|---|---|---|
| 直接 | `cross_major`以外 | `cargo update -p <name>@<現在の版> --precise <推奨版>`。Cargo.tomlの要求が許す場合(既定のキャレットなら許す)はCargo.lockだけが更新される。`=`や`~`で固定していれば、`declared_in`のCargo.tomlの要求を変更する |
| 直接 | `cross_major` | `declared_in`のCargo.tomlの要求を推奨版に変更する(破壊的変更の可能性。0.xはマイナー更新も含む) |
| 推移的 | `cross_major`以外 | 同じ`cargo update -p ... --precise ...`。依存元(`introduced_by`)の要求が許す範囲ならCargo.tomlを変えずに更新できる。要求を満たせないと報告されたら依存元を更新する |
| 推移的 | `cross_major` | 依存元(`introduced_by`)を、推奨版以上を要求する版へ更新する。`[patch.crates-io]`は要求範囲を変える仕組みではなく、依存元の要求を満たす版の修正(バックポート)を別ソースから使う場合に限る |
| 不明・混在 | - | 上の直接・推移的の両方の方法を示す |

- プレリリースの推奨(`recommended_is_prerelease`)では全行に追記: Cargoの要求は要求自体にプレリリースを書かない限りプレリリースに一致しないため、`--precise`だけでは更新できないことがある。直接依存なら要求を`"=<推奨版>"`に変更し、推移的依存なら依存元の要求がその版を許す必要がある
- `-p <name>@<現在の版>`は、同名の複数版がCargo.lockにある場合に対象を一意にするため常に付ける

### 段階計画(推奨案)

- **v0.12.1(修正リリース)**: 推奨先の照会の誤った`conflict`の修正。回帰テスト(修正版なしの既知の脆弱性が推奨先に該当しても推奨を保留しない・修正対象の脆弱性が該当と返れば従来どおり`conflict`)と、実データ(`ecdsa==0.13`)でMCP経由の確認。既存の推奨の不変(照会なしの出力がv0.12.0と一致)
- **v0.13.0**: crates.ioの推奨(SemVer・情報提供の扱い・照会で新しい`unmaintained`/`notice`を無視)、Cargo.lockの直接/推移的依存・`declared_in`、`update_hint`

### 完了条件とテスト(v0.13.0)

- 依存の解決: 3つの記法、同名の複数版、`replace`の置換先、gitの依存の配下、解決できない参照、辺の上限。cargoで生成したlockfile(上記の`anstream`の2版・`[replace]`)をフィクスチャにする
- 情報提供: 情報提供だけのパッケージ(`informational_only`)、修正可能な脆弱性と`unmaintained`を併せ持つパッケージ(推奨が出て、照会で`unmaintained`が`conflict`にならない)、照会で新しく見つかった`unmaintained`(無視)と`unsound`(修正対象に追加)
- `update_hint`: 上表の各行、プレリリース、推奨版の文字の範囲外(埋め込まない)
- 実データでMCP経由: 上の38パッケージ(照会あり)、`borsh`(プレリリース)、`openssl-src`(ビルドメタデータ)、他エコシステムの応答の不変(v0.12.1との比較)

### v0.13.0の実装とレビューでの修正(2026-10-13)

- **設計の誤り(修正版のあるunsound)**: 上の「情報提供のアドバイザリ」では情報提供をすべて修正対象から外したが、`unsound`は版ごとの欠陥で修正版を持つものが多い。実データ(照会あり)で`lru 0.6.0`に`0.7.1`(RUSTSEC-2026-0253は`0.18.2`で修正)、`git2 0.13.0`に`0.20.4`(RUSTSEC-2026-0183/0184は`0.21.0`)を推奨し、推奨先でも該当し、`fixed_in`も`null`になっていた。修正: 修正対象から外すのは`unmaintained`・`notice`と、現在より新しい修正版のない`unsound`だけ。修正版のある`unsound`は通常の脆弱性と同じくTierを求めて修正対象にし、`informational: "unsound"`を残す。修正対象が1件も残らない場合だけ`informational_only`。修正後は`lru→0.18.2`・`git2→0.21.0`
- `introduced_by`にローカルのcrate(pathの依存)が入っていた(`app`→`mylib`→`tokio`で`tokio`に`introduced_by: ["mylib"]`)。ローカルのcrateはそれ自体が起点でその依存は直接依存のため、推移的依存の探索の起点から外した
- 推奨がない場合の`update_hint`が「推奨を許すなら`cargo update ...`」と書いていた。推奨がなければコマンドを示さず、直接/推移的依存の方向だけを示す
- `[patch.crates-io]`の注意を全ての案内に付けていたため、推移的依存の`cross_major`だけにした。プレリリースの案内の`=<version>`は推奨版を埋め込む(ビルドメタデータは除く)
- 実装時の追加(設計に無かったもの): `declared_in`を一意に対応付けられない場合は`declaring_crates`(crate名、最大10件)を返す。案内の`--precise`はビルドメタデータを除いた版にする
- 確認: 実際の`Cargo.lock`(gix 420件・cargo-audit 399件、ローカルのレジストリのソースに同梱のもの)で関係の判定は2〜4ms、crates.io由来で`unknown`なし。38パッケージ(照会あり)で`verified` 33・`informational_only` 2・保留3、照会は33件とも`clean`

### 未確認事項

- プレリリースへの`cargo update --precise`の実機確認(キャッシュに依存元の揃ったプレリリースのcrateが無い)。案内はCargo公式文書の要求の規則に基づく
- crates.ioでyankされた版を推奨する可能性(OSVはyankを知らない。crates.ioのAPI照会は通信先を増やすため行わない。注記で触れる)

## osv-scannerのピン留め更新(2.4.0 → 2.7.0)詳細設計メモ(2026-10-15)

本サーバーの境界の検証・関係の判定・出力の解釈は、ピン留めした版の実挙動に合わせている(`binaryDownloader.ts`の注記)。更新は版を書き換えるだけでなく、実バイナリでの再監査を伴う。

### 対象の版(2026-10-15 確認)

リリース: 2.5.0(08-07)、2.5.1(08-17)、2.6.0(09-14)、**2.7.0(10-12、最新)**。当初は2.6.0を想定していたが、2.7.0が出ている。

**推奨: 2.7.0を対象にする。** 再監査(B5・親POM・requirements.txt・source.type・Cargo)は版ごとに必要で、2.6.0で行ってもすぐ2.7.0でやり直しになる。2.7.0にはプライバシー上の改善(下表の「ローカルのnpmパッケージを照会しない」)と、Mavenのgroup IDの修正も含まれる。ただし公開から3日のため、**公開から2週間(2026-10-26以降)経ち、重大な不具合の報告や2.7.xの修正版がないことを確認してからリリースする**(検証は先に進める)。2.7.1が出た場合はそれを対象にし直す。

### 変更点と本サーバーへの影響(リリースノートより)

| 版 | 変更 | 影響・確認事項 |
|---|---|---|
| 2.5.0 | スキャン・絞り込み・照合を**osv-scalibrのパイプラインに全面移行** | 出力の構造・`source.type`・グループ化・エラー時の終了コードとstderrが変わり得る。全項目の再確認の主因 |
| 2.5.0 | requirements.txt抽出器の正規表現の修正(名前・要求ごとのオプション) | 本サーバーは正規化した行(`名前==版`・`>=`・`~=`)だけを書くが、下限を使用中の版とみなす挙動(`version_is_lower_bound`)の再確認 |
| 2.5.0 / 2.5.1 | PURLの型の対応付け、照会時の名前空間(npmのscope等)の保持 | npmのscope付きパッケージ・Mavenの照会結果の比較 |
| 2.6.0 | **JSのlockfileのgitの依存からリポジトリURLを抽出し、OSVのタグと照合**。JS・Cargoのgitの依存に`pkg:git`を付けて、レジストリのパッケージとの誤検知を避ける | osv-scalibrのソース(`osvutil.go`)では、エコシステム`GIT`の照会でリポジトリURLを名前に使う。**package-lock.json等の社内gitリポジトリのURLがapi.osv.devへ送られる可能性**(新しい送信内容)。Cargoのgitの依存は本サーバーがコピーから除いているため送られない |
| 2.6.0 | tar爆弾による展開時のOOM・ディスク枯渇の防止 | JAR/WARのスキャン(`scan_java_artifact`)に有利。同定の結果が変わらないことを確認 |
| 2.6.0 | `--allow-no-lockfiles`で`results`が`null`でなく`[]` | 本サーバーは使っていない。パーサーはどちらも受け付ける |
| 2.7.0 | **Mavenの依存の版のプロパティの事前展開**(best-effort)、Maven解決のキャッシュ | 親POM・プロパティの解釈が変わる。`${env.X}`等の展開で**環境変数の値が版としてdeps.dev・OSVに送られないか**、範囲外のファイルを読まないかを確認 |
| 2.7.0 | ローカルのnpmパッケージ(`file:`・workspace・ローカルのtarball)をOSVに照会しない | 社内パッケージ名の送信が減る(改善)。npmの関係の判定・件数への影響を確認 |
| 2.7.0 | JSON出力にpurlを含める | パーサーは未知のフィールドを無視する。応答には出さない |
| 2.7.0 | Mavenのgroup IDの保持(CycloneDX)、Goのモジュールの名前空間を大文字小文字を区別せず照合 | SBOM・Goの結果の比較 |
| 2.7.0 | `--experimental-`のフラグを`--x-`に改名し、旧名は非推奨 | 本サーバーは`--experimental-plugins java/archive`を使う。**旧名が引き続き動くこと**を確認し、警告が出るなら新名に移る(固定の引数リストとテストを更新) |

### チェックサムの取得(供給網)

従来は公式リリースの`osv-scanner_SHA256SUMS`から転記した。今回は3つの経路で照合してから埋め込む:

1. GitHub APIのリリース資産の`digest`(2026-10-15に取得済み。darwin_arm64は`d4926ef8…f70b`等)
2. `osv-scanner_SHA256SUMS`(554バイト)
3. ダウンロードしたdarwin_arm64の実体のSHA-256(検証用に使う1件だけ)

対象は従来と同じ5種(darwin amd64/arm64、linux amd64/arm64、windows amd64)。windows arm64は従来どおり対象外。

### 実バイナリでの再確認(陽性対照つき。2.4.0と2.7.0を同じ時刻に並べて実行し、OSVのデータの更新と版の違いを分ける)

1. **B5の再監査**: 各形式のローカル参照で範囲外を読まないこと(既存のフィクスチャを再利用)。**陽性対照**(requirements.txtの`-r`、親POMの範囲外)が引き続き検出できることも確認する
2. **親POM**: `<relativePath>`・既定の`../pom.xml`・`<packaging>pom</packaging>`の条件、B4の回帰ケース(重複した`<parent>`、名前空間付き、CRの改行)の解釈がGoのXMLデコーダーと一致したままか
3. **Mavenのプロパティの展開(2.7.0)**: `${env.HOME}`・`${user.home}`・未定義のプロパティ・親POMのプロパティ・`${project.version}`を版に書いたpom.xmlで、送信される版・範囲外の読み込みを確認する
4. **requirements.txt**: 正規化したコピーの`==`・`>=`・`~=`の扱いと、`version_is_lower_bound`の前提
5. **pom.xmlの`source.type`の分離**(`lockfile` / `unknown`): `pomRelations`の前提
6. **Cargo.lock**: gitの依存・ローカルのcrate・別レジストリのcrateの扱い(sourceで絞り込むようになったか)、`informational`が出力に残るか。いずれにしてもコピー方式は維持する(社内crateの名前を送らないため)
7. **JSのlockfileのgitの依存**: `--all-packages`で、gitの依存がエコシステム`GIT`・リポジトリURLで照会されるかを確認する。送られる場合の対処は下記
8. **JAR/WAR**: 合成JAR(pom.properties入り)・ネストしたJAR・同定不能のJARで、同定・`inferred_only`の判定(groupIdに`.`がない座標)・終了コードが変わらないこと。実物のfat/shaded JARでの確認はダウンロードを伴うため、必要なら別途許可を得る
9. **SBOM**: CycloneDX・SPDXの既存フィクスチャ
10. **出力と終了コード**: 脆弱性あり(1)・なし(0)・パッケージなし(128)・解析失敗、stderrの形式(`runner.ts`の扱い)、`--experimental-plugins`の警告
11. **接続先**: lockfileはapi.osv.devだけ、pom.xml・requirements.txtはdeps.devも(CONNECTプロキシで記録)
12. **回帰の比較**: 混在プロジェクト(npm・Go・PyPI・Gradle・Rust)と`ecdsa`等の実データで、`scan_project`・`suggest_fix`の応答をv0.13.0(2.4.0)と比較し、差分を1件ずつ説明できること

### JSのlockfileのgitの依存のURL(確認7で送られると分かった場合)

- 推奨: v0.14.0では**READMEの通信先の表に明記**し(「package-lock.json等のgitの依存は、リポジトリURLとコミットがapi.osv.devに送られる」)、ツールの説明にも1文加える。Cargo.lockと同様にコピーから除く方式は、package-lock.json・yarn.lock・pnpm-lock.yaml・bun.lockの書き換えが必要で影響が大きいため、要望があれば別途検討する(バックログに記録)
- 代替: 該当する依存があるとき応答の`coverage`に「送信した」旨の注意を出す(lockfileの解析が必要)

### 変更するもの

- `binaryDownloader.ts`: `PINNED_OSV_SCANNER_VERSION`・`ASSET_CHECKSUMS`・注記(取得日と照合の経路)
- 実挙動の違いに応じた修正(確認の結果次第。2.4.0の挙動を前提にした注記・テストの更新)
- README: 通信先の表の確認日と版、gitの依存の送信内容、要件の記載
- キャッシュ: 新しい版は`~/.cache/osv-scanner-mcp/v2.7.0/`に入る。旧版のディレクトリは削除しない(READMEに手動削除の案内)
- リリースは**v0.14.0**(スキャン結果・送信内容が変わり得るため、修正版ではなくマイナー版)

### 実バイナリでの確認結果(2026-10-15、2.4.0と2.7.0を並べて実行)

**チェックサム**: 6種(darwin amd64/arm64、linux amd64/arm64、windows amd64/arm64。設計時に「windows arm64は対象外」と書いたのは誤りで、従来から6種を埋め込んでいる)とも、GitHub APIの`digest`と`osv-scanner_SHA256SUMS`が一致。darwin_arm64はダウンロードした実体のSHA-256(`d4926ef8da134332543be276dff157e4c170f99ad91fc48e89448a8816bdf70b`)とも一致。`--version`は`osv-scanner version: 2.7.0`(`osv-scalibr version: 0.5.3`)

**変わらなかったもの**:
- B5の再監査(package-lock.json・yarn.lock・pnpm-lock.yaml・poetry.lock・go.mod・pom.xmlの`<modules>`とBOMの`import`、resolveあり・`--no-resolve`): 範囲外の読み込みなし。陽性対照のrequirements.txtの`-r`は2.7.0でも範囲外を読み、親POMの`<relativePath>`も範囲外を読む(本サーバーの対策は引き続き必要)
- Mavenのプロパティ: `${env.X}`・`${user.home}`・未定義のプロパティは両版とも展開されず、その依存は出力から消える(環境変数の値は送られない)。`${project.version}`・親POMのプロパティは両版とも展開される
- pom.xmlの`source.type`の分離(宣言=`lockfile`、deps.devで解決=`unknown`)、requirements.txtの`==`・`>=`(下限)・`~=`・`===`の扱い、終了コード(脆弱性あり1・なし0・パッケージなし128・解析失敗127)とstderrの形式
- Cargo.lock: 2.7.0でもsourceを見ずに、ローカル・gitの依存・別レジストリのcrateをcrates.ioとして照会し、同名のアドバイザリが付く(2.6.0の`pkg:git`の変更は`--lockfile Cargo.lock:`の経路では効いていない)。コピー方式は引き続き必要。`informational`は出力に残る
- 接続先: lockfile・Cargo.lock・JAR/WARはapi.osv.devだけ、pom.xml・requirements.txtはapi.deps.devも(CONNECTプロキシで記録)
- MCP経由の応答: npm(`resolved`付き)・Go・PyPI・Gradle・pom.xml(親POMあり)・Rustの混在プロジェクトで、`scan_project`(26パッケージ・249件)と`suggest_fix`(26件)がv0.13.0+2.4.0と**完全に一致**。`scan_java_artifact`(合成JAR・fat JAR・WAR・同定不能のJAR)と`scan_sbom`(CycloneDX・SPDX)も完全に一致
- pnpm-lock.yaml・bun.lock・yarn.lockのレジストリのパッケージは両版とも照会される

**変わったもの(要判断)**:
1. **package-lock.jsonで`resolved`の無いエントリを照会しない(2.7.0、偽陰性)**: osv-scalibrの`DeterminePackageSource`は、`resolved`がnpmを含むhttp(s)のURLなら公開レジストリ、その他のhttp・gitなら「その他」、**それ以外(空を含む)はローカル**とみなし、ローカルは照会しない。`lodash 4.17.20`で、`resolved`なし・`inBundle: true`(バンドルされた依存)・`file:`は2.4.0では5件、2.7.0では0件。`file:`は正しくローカルだが、**バンドルされた依存と、npmの`omit-lockfile-registry-resolved=true`で生成したlockfile(レジストリのパッケージに`resolved`を書かない)は、実際のレジストリのコードなのに黙って照会されなくなる**。`resolved`がyarnpkg・社内のレジストリのURLでも照会は続く
2. **gitの依存がリポジトリURLで照会される(2.6.0〜、送信内容の変化)**: package-lock.json・yarn.lockの`git+ssh://git@git.mycompany.example/team/priv.git#<commit>`は、2.4.0では`npm:priv@1.2.3`(+commit)として照会されたが、2.7.0では**エコシステム`GIT`・名前`https://git.mycompany.example/team/priv`**で照会される。社内のgitホスト名とリポジトリのパスがapi.osv.devへ送られる
3. **`--experimental-`のフラグの非推奨**: 2.7.0は`--experimental-plugins`・`--experimental-no-default-plugins`を受け付けるが、stderrに非推奨の警告を出す。新名`--x-plugins`等は**2.4.0では未定義でexit 127**。`OSV_SCANNER_PATH`やPATH上の古い版を使う利用者がいるため、旧名を使い続ける(警告はstderrのため応答に影響しない)

### 判断(推奨案)

- 1(`resolved`なし): **package-lock.json(npm-shrinkwrap.jsonを含む)のスナップショットのコピーで、`resolved`の無いエントリに公開レジストリの形のURLを補い、2.4.0と同じく照会させる**。対象は、キーが`node_modules/`を含み、`link`でなく、`resolved`が無いエントリだけ(ローカルのディレクトリの依存は`link: true`とキーが`node_modules/`を含まない対象のエントリ、tarballは`resolved: "file:..."`のため対象外)。送信される名前は2.4.0と同じで、新たな送信はない。補った件数は応答に出さない(スキャンの範囲は2.4.0と同じになるため)。JSONの解析・再出力は本サーバーで行い、重複したキー等で解析できない場合は元のコピーをそのまま渡す(2.7.0の挙動になる。従来どおり`coverage`の範囲は変えない)
- 2(gitのURL): v0.14.0では**READMEの通信先の表とツールの説明に明記**する。コピーから除く・`resolved`を外して照会させない等の対処は、gitの依存の公開リポジトリでの正しい検出(OSVのGITの範囲)を失うため、要望があれば別途検討する(バックログ)
- 3(フラグ): 旧名を維持。テストに「2.4.0と2.7.0の両方で動く引数」である旨の注記を加える

### v0.14.0の実装(2026-10-15)

- `binaryDownloader.ts`: 2.7.0と6種のチェックサム(取得日・照合の経路を注記)
- `npmLockCopy.ts`(新規)・`scanProject.ts`: スナップショットのpackage-lock.jsonのコピーで`resolved`を補う(v2以降の`packages`と、v1の`dependencies`の入れ子の両方)。補うエントリが無ければコピーを書き換えない。単体テスト・統合テスト(コピーだけが変わり元のファイルは変えない)を追加し、補完を外すと統合テストが失敗することを確認
- 実機(MCP経由、検証済みのキャッシュの2.7.0): `resolved`なし・`inBundle`・v1の`lodash 4.17.20`が、補完なしの0件から検出されるようになった(グループ単位で3件)
- (レビュー指摘)v1の別名の依存(`"version": "npm:lodash@4.17.20"`、スコープ付きの`npm:@babel/traverse@7.22.0`)は版の文字種の確認で対象外になり補われなかった(`filled: 0`)。osv-scannerはこの表記を実際の名前と版で照会し、`resolved`が無いと2.7.0では照会しない(2.4.0では`lodash` 5件・`@babel/traverse` 1件、2.7.0では0件)。実際の名前と版を取り出して補う。MCP経由で`lodash`・`@babel/traverse`とも検出されることを確認
- 回帰: 5エコシステムの混在プロジェクトで、`scan_project`・`suggest_fix`の応答がv0.13.0+2.4.0と**バイト単位で一致**
- `--experimental-`のフラグは維持(`runner.ts`に理由を注記)。README・SECURITY.md・ツールの説明にgitの依存のURLの送信、READMEに`resolved`の補完と旧版のキャッシュの削除を記載。2.4.0を前提にしたコードの注記に2.7.0での確認を追記
- リリースは2.7.0の公開から2週間後(2026-10-26以降)、重大な不具合の報告と2.7.xの修正版がないことを確認してから

### Cargo.tomlのworkspaceのglob照合の計算量(v0.12.0〜v0.13.0の不具合、v0.14.0で修正、2026-10-22)

- **ReDoS**: `workspaceIncludes`の`members`のglobを正規表現(`*`→`[^/]*`)に変換して照合していたため、`*a*a…*b`のようなパターンで指数的なバックトラックが起きた(28文字の入力で454ms、長さに対して指数的に増える)。攻撃者が用意したリポジトリのルートのCargo.tomlで、スキャンを止められる
- 修正(利用者が実装): セグメントごとの動的計画法(パターン長×セグメント長)に置き換え、1回の判定の計算量に上限(100万セル)を設け、超えたら判定できない(null、`unconfirmed`)
- **残っていた問題(レビュー指摘)**: 上限が`workspaceIncludes`の呼び出し(メンバーのCargo.tomlごと)で戻るため、同名のcrateを名乗るCargo.tomlを大量に置くと計算量が積み上がる(2,000件で`detectProject`が4.6秒の同期処理、走査の上限20万エントリでは数分)。修正: 検出全体で共有する上限(`GlobWorkBudget`、1,000万セル、`CargoLockCache`が持つ)を設け、使い切った後のglobの判定はnull
- 共有の上限を入れたところ、メンバーを文字どおりに列挙した大きなworkspace(1,000件)で、文字どおりの比較の分も上限に数えたため714件が誤って`unconfirmed`になった。workspaceごとに1回だけパターンを前処理し(`WeakMap`)、文字どおりのメンバーは集合で引き、`exclude`・文字どおりのメンバーの前方一致は祖先のパスを集合で引く。上限に数えるのはglobの照合だけ。上限を使い切ったら残りのglobを見ない(大量のパターン×メンバーの空回りを防ぐ)
- 確認: 1,000件の文字どおりのworkspaceは0.3〜0.5秒で全件収録済み。2,000件の重いglobと、25,000パターン×5,000件のglobは、それぞれ1〜2秒で`unconfirmed`(globの照合は58ms、残りはファイルの読み込み)。MCP経由の`scan_project`も同じ。変異確認: 共有の上限から引かない・使い切っても残りのglobを見る・文字どおりのメンバーも上限に数える、の各変更で追加したテストが失敗する
- **宣言元のCargo.tomlの対応付け(v0.13.0〜、v0.14.0で修正、2026-10-22)**: 検出時にプロジェクトの全Cargo.tomlの`[package] name`を集め、(1) 同名の集約で配列を毎回コピーしていた(同名の数の2乗、利用者が`string | null`の印に変更して線形に)、(2) Cargo.lockごとに**全crate名**をたどって`path.relative`し、Cargo.lockごとに全件のMapを作っていた(Cargo.lockの数×crate名の数の処理とメモリ)。(2)は`declared_in`に使うそのCargo.lockのローカルのcrate名だけを引くよう修正。実測(小さいCargo.lock 900件と名前が一意なCargo.toml 2万件の`detectProject`): 修正前はCPU 53秒・ヒープ3.6GB・Mapの合計1,800万件、修正後はCPU 20秒・20MB・0件。残る時間はファイル2万件の安全な読み込み(1件約1msの`realpath`等の確認)で、件数に比例する
- **go.modのreplaceの照合(v0.7.0〜v0.13.0、v0.14.0で修正、2026-10-22)**: 直接/推移的依存の判定(`goModRelations`)が、requireごとにreplaceの一覧を`find`で走査していた(require数×replace数)。1.6MBのgo.mod(requireとreplaceを各2万行)で2.81秒、関係の判定の読み込みの上限(合計256MiB)まで大きいgo.modを置くと数分になりうる。修正(利用者が実装): replaceをモジュールのパス→版(版の限定なしはnull)の索引にし、版の一致を優先・各版で最初の宣言を採るという従来の規則のまま定数時間で引く。同じ入力で0.02秒
- **Cargo.lockの解析のメモリの増幅(v0.12.0〜v0.13.0、v0.14.0で修正、2026-10-22)**: `parseCargoLock`がファイル全体を行の配列に分割し、行数・依存の要素数・文字列の長さに上限がなかった。60MBの空行だけのCargo.lockで解析に1.36GB(最大常駐)、読み込みの合計の上限(256MiB)まで置くと数GB。修正(利用者が実装): 行の配列を作らず1行ずつ読み、検出全体で共有する上限(行100万・依存の要素20万・文字列の文字数1件65,536・合計16Mi)を設ける。超えたファイルは理由付きで除外し、以降のファイルも同じ理由で除外。同じ入力で0.01秒・241MB(大半はファイルの内容)。実在のlockfile(約400パッケージ)は各上限の0.4〜0.7%で、同程度のlockfileが約140件を超えるリポジトリでは以降が除外される
- **上限の端数(2026-10-22、修正は利用者)**: 「上限を使い切ったら残りのglobを見ない」は残りが0以下の場合だけ効いていた。どのパターンの準備のコスト(パターン長+対象の長さ+1)にも満たない正の端数が残ると、各globの照合が何も引かずにnullを返し、残りが0にならないため、以降のメンバーごとに全パターンを空回りした。実測: 端数7で2,000件×10万パターンが0.75秒(ルートのCargo.toml 1MiBで約10万パターン、走査の上限約20万エントリまで増やすと数十秒以上)。修正: 準備のコストが残りを超えたら残りを0にして打ち切る(DPの表の確保だけが足りない場合は残りを保ち、安いglobの照合は続ける)。同じ入力で0.02秒
- **`[replace]`の置換先の確認(v0.12.0〜v0.13.0、v0.14.0で修正、2026-10-22)**: `parseCargoLock`は置換を持つパッケージごとに、全パッケージを走査して置換先を探していた(パッケージ数の2乗)。上限の5万パッケージ(2.5万件の置換)の4.6MBのCargo.lockで1.88秒、読み込みの合計の上限(256MiB)まで複数のCargo.lockを置くと数十秒〜数分の同期処理になりえた。修正(利用者が実装): 全パッケージの同一性(name・version・source)の個数を1回だけ数え、置換先の個数が自分自身を除いて1以上かで判定する(従来と同じ規則)。同じ入力で0.10秒。テストは再走査しないこと・上限いっぱいで全置換が末尾を指す場合・別の重複と自己参照の区別・連鎖と循環を確認

### requirements.txtの取り込みの再展開による資源の枯渇(v0.4.0〜v0.13.0の不具合、v0.14.0で修正、2026-10-22)

- **事象**: 取り込み先のファイル(`-r shared.txt`)は1回だけ読んでキャッシュするが、取り込むrequirements.txtごとに解析し直し、正規化した行を各コピーに書いていた。読む量の上限(64MiB)はキャッシュ済みの再展開に効かないため、大きな共通ファイルを多数のrequirements.txtから取り込むと、処理時間・メモリ・コピーの行数が取り込み元の数に比例して増える。実測(950KB・80,000行の共通ファイルを200件から取り込み): 修正前7.8秒・ヒープ1,027MB・コピー1,600万行。1,000件では約5GBとなり、メモリ不足でサーバーが落ちうる
- 修正(利用者が実装): 1回のスキャンで共有する上限を追加。展開する量(64MiB、キャッシュ済みの再展開も数える)と論理行数(10万行)。超えたら、ルートのrequirements.txtは`skipped_files`(理由付き)、取り込みの途中なら`unscannable_requirements`(その取り込みは途中まで展開)に記録し、`complete: false`
- 確認: 同じ入力で修正後0.07秒・22MB・コピー99,998行、198件を理由付きで除外。MCP経由の`scan_project`も同じ(全体20秒の大半はosv-scannerによる約10万件の照会)

### npmのlockfileのJSONの解析による資源の枯渇(v0.4.0〜v0.13.0の不具合、v0.14.0で修正、2026-10-22)

- **事象**: npm workspacesの収録確認(`LockfileKeyCache`、v0.4.0〜)と直接/推移的依存の判定(v0.7.0〜)が、package-lock.jsonを`JSON.parse`で丸ごと解析していた。上限はサイズ(1件64MiB・合計256MiB)だけで、構造の量は無制限。実測(修正前のコード): 空のオブジェクト2,000万個の60MBのlockfile1件で、workspaceの確認だけでメモリ2.45GB(最大常駐)。数件でメモリ不足になりうる。v0.14.0で追加した`resolved`の補完(未公開)も同じ解析と、インデント付きの再出力(深い入れ子で出力が膨らむ)を行っていた
- 修正(利用者が実装): `parseNpmLock`で、`JSON.parse`の前に入れ子の深さ(128)と構造の記号の数(1件100万・解析の段階ごとに200万)を数え、入力・出力を1件16MiB・スキャン全体64MiBに制限。補完したコピーは詰めたJSONで、出力の大きさを作る前に見積もる。workspaceの確認・関係の判定は上限超過で`unconfirmed`・`unknown`
- **レビュー指摘**: 補完の段階だけは上限超過でスキャン全体を`scan_input_too_large`で止めていたため、正当な大きいlockfile(4万パッケージ・17.2MB、補う必要のないもの)で、他のエコシステムを含むスキャン全体が失敗した(修正前は正常にスキャン)。実在のlockfileは1パッケージあたり約500バイト・構造の記号約22個で、1件の上限は約3.3万パッケージに当たる。修正: 補完の上限を超えたlockfileは補わずにそのまま渡し(osv-scannerは大きなlockfileも解析できる。上限は本サーバー自身の解析・再出力のためのもの)、`coverage.skipped_files`に理由を出す(`complete: false`)。補う必要のない(書き換えない)コピーは出力の上限に数えない
- 確認: 4万パッケージのlockfileはMCP経由でスキャンでき(`lodash`を検出、`complete: false`と理由)、5,000段の入れ子のlockfileは1秒で終わる。60MBの攻撃的なlockfileのworkspaceの確認は0秒・51MB。変異確認: 補完の上限超過で再びスキャンを止めると、追加したテスト8件が失敗する

### 必要なダウンロード(実施前に許可を得る)

- `osv-scanner_darwin_arm64`(v2.7.0、55,336,530バイト)と`osv-scanner_SHA256SUMS`(554バイト)。公式のGitHub Releases(google/osv-scanner)。本サーバーの自動ダウンロードと同じ経路・同じ検証で取得できる

## スキャンの実行履歴(v0.15.0候補)詳細設計メモ(2026-10-23)

利用者の要望: 実行の記録(いつ・何を・どの範囲でスキャンしたか)と、前回からの変化(新たに見つかった・解消した脆弱性)の両方を確認したい。現状のサーバーは呼び出しの間で何も保存しない(結果はMCPクライアントに返すだけ)。

### 非目標

- 結果の全文の保存(大きく、社内のパッケージ名・パスを広く残す)。保存するのは要約と、差分に必要な識別子だけ
- 別のマシン・利用者との共有、外部への送信。履歴はローカルのファイルだけ
- MCPのresources(対応していないクライアントがある)。ツールで返す

### 有効化と保存先

- **既定は無効**。`OSV_MCP_HISTORY=1`(`true`・`yes`)の場合だけ記録する(社内のパッケージ名・パスをディスクに残すため、明示的に選んだ場合だけ)
- 保存先: `$XDG_STATE_HOME/osv-scanner-mcp/history/`(未設定なら`~/.local/state/osv-scanner-mcp/history/`)。履歴は作り直せるキャッシュではないため、`~/.cache`ではなく状態の置き場所(XDG Base Directory)。`OSV_MCP_HISTORY_DIR`で変更できる(絶対パスのみ)
- ディレクトリは0700・ファイルは0600。作成・読み込みの前に、ディレクトリがシンボリックリンクでなく所有者が自分であることを確かめる(起動時の残骸の掃除と同じ確認)。満たさなければ記録しない(stderrに警告)

### 記録の単位と形式

- **1回のツール呼び出し=1ファイル**(`<UTC時刻>-<乱数>.json`)。一時ファイルに書いてから`rename`する。1つのファイルに追記する方式(JSON Lines)は、複数のクライアントが同時にサーバーを動かすと行が混ざりうるため採らない。ファイル名の先頭の時刻で並べる
- 対象のツール: `scan_project`・`suggest_fix`・`scan_java_project`・`scan_java_artifact`・`scan_sbom`(`explain_vulnerability`はスキャンでないため記録しない)
- 記録の内容(`schema: 1`):
  - 共通: `id`、`started_at`(UTC)、`duration_ms`、`tool`、`server_version`、`osv_scanner_version`(ピン留め・PATH・OSV_SCANNER_PATHの別を含む)、`target`(入力のパスと解決後のプロジェクトのディレクトリ)、`allowed_root_set`
  - 結果: `status`(`ok` / `error`)、失敗時は`error_kind`だけ(メッセージは残さない)
  - 範囲: `coverage.complete`、スキャンしたマニフェストの一覧(パス・エコシステム・形式)、欠け(`lockfile_missing`等)の件数
  - 件数: 脆弱性・情報提供・深刻度別、脆弱なパッケージの数
  - **差分用の識別子**(`findings`): パッケージごとに`ecosystem`・`name`・`version`と、脆弱性のIDと別名の一覧(情報提供は種類も)。`suggest_fix`では推奨版・Tier・`verification`も。上限(例: 1万件)を超えたら打ち切り、`findings_truncated: true`を付ける(差分は「不完全」と示す)
- 1件の上限(例: 1MiB)。超える場合は`findings`を省いて要約だけ記録する
- 記録の失敗はスキャンを失敗させない(stderrに警告。応答には影響しない)

### 保持

- 既定で最新500件(`OSV_MCP_HISTORY_MAX_ENTRIES`で変更、上限あり)。書き込みのたびに古いものから削除する(削除の競合は無視する)
- 合計サイズの上限(例: 100MiB)も設け、超えたら古いものから削除する

### 閲覧: 新しいツール`scan_history`

- 入力: `project_path`(省略可)、`limit`(既定10、最大50)、`run_id`(省略可。指定するとその回の詳細)
- 出力:
  - `runs`: 新しい順の要約(時刻・ツール・対象・`status`・件数・`coverage.complete`)。`project_path`を指定すると、その対象の回だけ
  - `changes`(`project_path`指定時): 同じ対象・同じ種類のスキャン(プロジェクト / Javaプロジェクト / JAR・WAR / SBOM)の、直近の成功した2回の比較。`suggest_fix`と`scan_project`は検出が同じため同じ種類として比べる
    - `new_vulnerabilities`: 今回あって前回なかった(パッケージ・版と脆弱性の組。IDか別名が重なれば同じ脆弱性とみなす。OSVの代表IDが入れ替わっても誤検知しない)
    - `resolved_vulnerabilities`: 前回あって今回ない。理由を分ける: `upgraded`(同じパッケージの版が変わった)、`removed`(パッケージが無くなった)、`no_longer_reported`(同じ版のまま報告されなくなった。OSVのデータの更新等)。※実装では名前と比べ方を変更(下の「実装メモ」)
    - `version_changes`: パッケージの版の変化
    - `coverage_changes`: `complete`の変化、マニフェストの増減
    - 注意書き: 差分はスキャンの時点のOSVのデータに依存する(コードを変えていなくても、データの更新で増減する)。`findings_truncated`の回が含まれる場合は不完全と示す
- 履歴が無効なら`history_disabled`(有効化の方法を案内)。エラーにせず空の結果にすると「履歴がない」と誤読されるため

### 安全性

- **許可ルート**: `OSV_MCP_ALLOWED_ROOT`設定時は、対象が許可ルートの内側の回だけを返す(許可ルートを狭めて起動し直した場合に、範囲外の過去の情報を返さない)。`project_path`も従来どおり検証する
- 外部由来の文字列(パッケージ名・パス・ID)は、読み出し時にも`sanitizeExternalText`を通す(ファイルの改ざん・プロンプトインジェクション対策)。記録を読むときはサイズの上限付きで安全に読み、解釈できないファイルは無視する(件数を`skipped_records`に示す)
- 履歴のファイルは本サーバー以外も書き換えられる前提で扱う(信頼しない入力)
- Nodeの権限モデル(`--permission`)で起動した場合、履歴が有効で保存先に書き込めなければ起動時に警告する(既存の`permissionModelWarnings`に追加)

### 段階計画(推奨案)

- **v0.15.0**: 記録(全スキャンツール)と`scan_history`(一覧・詳細・直近2回の差分)
- 以降(要望があれば): 任意の2回の比較、履歴の書き出し(CSV等)

### 完了条件とテスト

- 記録: 有効・無効、保存先の検証(シンボリックリンク・所有者・権限)、一時ファイルとrename、記録の失敗でスキャンが失敗しないこと、上限(件数・サイズ・findings)と打ち切りの表示、同時に複数のプロセスが書く場合
- 差分: 新規・解消(upgraded・removed・no_longer_reported)、別名での同一視、代表IDの入れ替わり、範囲の変化、打ち切りを含む場合
- 閲覧: 許可ルートの外の回を返さない、改ざん・壊れたファイルの無視、外部由来の文字列の無害化、`history_disabled`
- 実バイナリでMCP経由: 同じプロジェクトを依存を変えて2回スキャンし、差分が期待どおりになること。履歴を無効にした場合に何も書かないこと

### 実装メモ(設計からの変更点)

- **差分はパッケージ(エコシステムと名前)単位で比べる**: 当初の「パッケージ・版と脆弱性の組」で比べると、版を上げても残る脆弱性(例: lodash 4.17.20→4.17.21で残る3件)が新規にも解消にも数えられた(MCP経由の確認で判明)。版が変わっても残る脆弱性はどちらにも数えず、`version_changes`の`still_affected`に件数を示す
- **解消の理由の名前を変更**: `upgraded`→`version_changed`、`removed`→`package_not_reported`、`no_longer_reported`→`same_version_not_reported`。スキャン結果には脆弱なパッケージしか載らないため、結果から消えたパッケージが「更新された」(既知の脆弱性のない版へ)のか「削除された」のか「範囲外になった」のかは区別できない。断定する名前を避け、観測できる事実だけを示す。`version_changed`には今回の版(`current_versions`)を付ける
- 比較は失敗した回(`status: "error"`)を飛ばし、同じ種類の直近の成功した2回を使う。2回未満なら種類ごとに`note`で示す
- `suggest_fix`の件数は、記録した`findings`から情報提供を除いて数え直す(応答に`vulnerability_count`がないため)
- 上限: `findings`は5,000パッケージ・合計2万件の脆弱性・別名は各20件・文字列は512文字。1件の記録が1MiBを超えたら`findings`を省く(`findings_omitted`)。それでも超えれば(長いパスのマニフェストが多い場合)マニフェストの一覧を半分ずつ減らし、最後は一覧を省く(`manifests_truncated`。マニフェストの増減は比べず`incomplete`に示す)。深刻度別の件数のキーは16個まで。対象のパス(`target.input`・`target.resolved`)は他の文字列の512文字の上限では照合に使えないため、4,096文字(LinuxのPATH_MAX。これより長いパスは実在せずスキャンは失敗する)で切り詰め`target_truncated`を付ける(非常に長い入力パスで失敗した回の記録が上限を超えた。レビューで指摘)。それでも収まらない記録は書かずに例外にし、記録側が警告する。これで残りの項目は大きさに上限があり、保存したものは読み出しの上限(同じ1MiB)で必ず読み戻せる。`scan_history`で1回に読む量は合計64MiB、`run_id`の詳細は500パッケージまで、差分の各一覧は500件まで(超えたら`incomplete`)
- 対象の照合: `project_path`は実パスで解決し、解決できなければ(削除済みのプロジェクト)絶対パスのまま照合する。記録の`target.resolved`(応答の`project_dir`、なければ入力の実パス)か入力のパスと一致する回を選ぶ
- 保存先は作成・確認の後の実パスで読み書きする(安全な読み込みの境界の確認が実パスで行われるため。macOSの`/var`→`/private/var`等)
- 差分の照合はパッケージごとにIDと別名の集合を作って行う(件数に比例する時間)。相手側の全件を走査する方式では、上限内の2万件同士で数秒〜十数秒、同期処理でサーバーが止まった(レビューで指摘)
- 文字列の無害化は二重: 記録を解釈するとき(`unknownJson`の取り出し)と、応答を返す直前(`sanitizeDeep`)。どちらか一方が漏れても他方で止まる

## .NET(NuGet)対応(v0.16.0候補)詳細設計メモ(2026-10-23)

利用者の要望: .NETのプロジェクトも`scan_project`でスキャンしたい。v0.16.0はスキャン(検出・範囲・直接/推移的の区別)まで、`suggest_fix`のNuGet対応はv0.17.0(Rustと同じ二段階)。

### 非目標

- `dotnet restore`・MSBuildの実行や評価(プロパティ・条件・`<Import>`の解決)。ビルドは実行しない方針(既存と同じ)
- ユーザー単位・マシン単位の`NuGet.Config`(`~/.nuget/NuGet/NuGet.Config`等)の読み込み。スキャン範囲の外を読まない
- 中央パッケージ管理(`Directory.Packages.props`)の版の解決(lockfileへの誘導で対応。下の「中央パッケージ管理」)
- `suggest_fix`のNuGet対応(v0.17.0)。v0.16.0では既存どおり`verification: "unsupported_ecosystem"`

### 実機確認(osv-scanner 2.7.0、2026-10-23)

Newtonsoft.Json 12.0.1(GHSA-5crp-9r3c-p9vr、13.0.1で修正)で確認。

| 形式 | osv-scannerの挙動 | 判断 |
|---|---|---|
| `packages.lock.json`(`RestorePackagesWithLockFile`) | 直接・推移的の全パッケージを確定版で照会。`type: Project`は照会しない | 主対象 |
| `packages.config`(.NET Framework) | 確定版で照会(推移的も平坦に列挙される形式) | 対象 |
| `*.deps.json`(ビルド出力) | `type: project`(自分のプロジェクト)も**NuGetのパッケージとして照会する**(公開パッケージと同名なら誤検知、社内名はapi.osv.devに送られる。Cargo.lockのローカルcrateと同じ問題) | コピーで除外して対象 |
| `.csproj` | `Version="$(Prop)"`・範囲`[12.0.1,13.0.0)`を**そのまま版の文字列として照会する** | そのままは渡さない |
| `Directory.Packages.props`・Versionの無い`PackageReference` | 読まない(エラー) | 範囲外として示す |

- **解釈できない版の文字列はOSVで「全ての版より前」とみなされる**: api.osv.devに`$(NJ)`・`[12.0.1,13.0.0)`・`garbage`を送ると、どれも12.0.1と同じ脆弱性が返る(13.0.1は0件)。未解決の版を送ると、修正済みでも脆弱と報告される(誤検知)。**確定版と確認できたものだけを送る**
- `.csproj`の`<Import Project="../...">`・`Directory.Build.props`はたどらない(範囲外のローカル参照は起きない)。ただし下の方針により、元のファイルはosv-scannerに渡さないため、そもそも依存しない
- 複数のターゲットフレームワーク(`net48`・`net8.0`・`net8.0/linux-x64`)で版が違う場合、各版を照会する
- 自己完結型アプリのランタイムパック(`Microsoft.NETCore.App.Runtime.linux-x64` 8.0.0)は脆弱性12件。照会対象に含める
- サーバーが書く正規化した`packages.lock.json`を`--lockfile packages.lock.json:<絶対パス>`で渡すと、2.7.0・2.4.0とも同じ結果(フレームワーク名は任意の文字列でよい)

### 方針: 全形式をサーバーが解析し、正規化したコピーだけを渡す

- `packages.lock.json`・`packages.config`・`*.deps.json`・`obj/project.assets.json`・`.csproj`を、サーバーが読んで(`readRegularFile`、サイズ上限つき)解析し、**照会してよいパッケージだけを書いた`packages.lock.json`形式のコピー**をスナップショットに書く。元のファイルはosv-scannerに渡さない(Cargo.lock・requirements.txtと同じ。解釈の食い違いによる範囲外読み込み・誤照会を構造的に防ぐ)
- `MANIFEST_FORMATS`に`packages.lock.json`を追加するが、渡すのはコピーだけ(Cargo.lockと同じ扱い。テストで元のファイルを渡さないことを確かめる)
- コピーは(名前, 版)ごとに1件。同じ名前の別の版は別のフレームワークのグループに分けて書く(JSONのキーの重複を避ける)。応答のパスは元のファイルに戻す(既存のコピーの対応付けを使う)

### 検出とプロジェクトごとの対応付け

**単位はプロジェクトのファイル**(`*.csproj`・`*.fsproj`・`*.vbproj`)。ディレクトリ単位にしない: 同じディレクトリに複数のプロジェクトがある場合、1つのlockfileを全プロジェクトの完全な情報とみなせない(レビュー指摘)。プロジェクトごとに、**そのプロジェクトのものと確認できた**情報源を次の順で探し、最初に見つかったものを使う。

1. **lockfile**(NuGetの公式の説明: 既定はプロジェクトのディレクトリの`packages.lock.json`、同じディレクトリに複数のプロジェクトがある場合は`packages.<プロジェクト名>.lock.json`、`NuGetLockFilePath`で別の場所も指定できる)
   - `packages.<プロジェクト名>.lock.json`(プロジェクトのファイル名から拡張子を除いた名前。大文字小文字を区別しない) → そのプロジェクトのものと確認できる
   - `packages.lock.json` → **そのディレクトリのプロジェクトのファイルが1つだけの場合に限り**、そのプロジェクトのものとする
   - プロジェクトのファイルに`NuGetLockFilePath`がある場合(値は評価しない) → 既定の名前のlockfileがあっても対応付けを確認できないため、確認済みとはしない
2. **`obj/project.assets.json`**(`dotnet restore`の生成物。lockfileは既定で無効のため、これが無いと多くのプロジェクトで推移的依存を見られない) → ファイルの`project.restore.projectPath`(または`projectName`)が**そのプロジェクトのファイルと一致する場合だけ**使う(同じディレクトリの複数のプロジェクトは`obj`を共有して上書きし合うため、名前で確かめる)。プロジェクトのファイルより古い場合は「古い可能性」を`coverage.warning`に示す(更新日時の比較)。`BaseIntermediateOutputPath`等で`obj`の場所を変えている場合は見つからず、3になる
3. **プロジェクトのファイルの`PackageReference`** → 直接依存だけ(下の「`.csproj`の読み方」)。`lockfile_missing`に`status: "direct_only"`(新しい値)で載せ、`RestorePackagesWithLockFile`の有効化を案内する

対応付けを確認できない場合:
- どのプロジェクトのものか確認できないlockfile(複数のプロジェクトがあるディレクトリの`packages.lock.json`等)も、**載っているパッケージは実在するためスキャンする**。ただし、どのプロジェクトも確認済みにしない
- 確認済みの情報源の無いプロジェクトは、3(直接依存だけ)で扱い、`lockfile_missing`には`status: "unconfirmed"`(既存の値)で「lockfileはあるが、このプロジェクトのものと確認できない」と示す。`coverage.complete`は`false`

その他:
- `packages.config`(.NET Framework。全ての依存が確定版で列挙される: NuGetの公式の説明) → 完全。プロジェクト別の`packages.<プロジェクト名>.config`も同じ規則で対応付ける。`developmentDependency="true"`は`dependency_groups: ["dev"]`
- `*.deps.json` → 直接指定された場合と、プロジェクトのディレクトリの`bin/`・`obj/`の外で見つかった場合(配置済みのアプリ等)。`bin/`・`obj/`の中は同じプロジェクトの重複になるため走査しない(走査関数に「プロジェクトのファイルがあるディレクトリの`bin`・`obj`を飛ばす」判定を追加。名前だけで飛ばすと他のエコシステムの`bin`まで飛ばすため)。`obj/project.assets.json`は走査ではなくプロジェクトのディレクトリから直接読む
- `project_path`にファイルを直接指定した場合はその形式だけ(既存と同じ)

### 各形式で照会するもの・しないもの

| 形式 | 照会する | 自分のプロジェクト(数だけ数える: `local_projects`) | その他(`unscannable_nuget_packages`に理由つき) |
|---|---|---|---|
| `packages.lock.json` | `type`が`Direct`・`Transitive`・`CentralTransitive` | `Project` | 未知の`type`、確定版でない`resolved` |
| `project.assets.json` | `libraries`の`type: package` | `project` | その他の`type` |
| `*.deps.json` | `libraries`の`type`が`package`・`runtimepack` | `project`・`reference` | その他の`type` |
| `packages.config` | `package`の`id`・`version` | — | 確定版でない`version` |

- **確定版**(復元の結果の形式で使う: lockfileの`resolved`・`project.assets.json`・`*.deps.json`・`packages.config`の`version`): NuGetの版の形式(`^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)。それ以外の文字列は照会しない(解釈できない版はOSVで全ての脆弱性に一致するため)
- **名前**: NuGetのIDは大文字小文字を区別しないため、比較は小文字化して行い、最初の表記を使う。使える文字(`^[A-Za-z0-9_.-]{1,100}$`)以外は照会しない

### `.csproj`の読み方(直接依存だけの場合)

**版の指定は確定版ではない**(レビュー指摘。NuGetの公式の説明: `Version="3.6.0"`は「3.6.0以上で最も低い版を優先」、完全一致は`[3.6.0]`。指定の版が無ければ、それより上の最も近い版に解決される):

| 指定 | 扱い |
|---|---|
| `[x]`(完全一致) | 確定版xとして照会 |
| `x`・`[x,)`・`[x,y)`・`[x,y]`(下限を含む) | **下限xとして照会**し、`version_is_lower_bound: true`を付ける(requirements.txtの`>=`と同じ扱い)。実際に復元される版はxより上でありうる(OSVの結果は下限の版のもの)ことを`coverage.warning`に示す |
| `(x,)`・`(,y]`・`(x,y)`等(下限を含まない・下限が無い) | 照会しない(理由`range`) |
| `$(...)`を含む | 照会しない(理由`property`) |
| `*`を含む(フローティング) | 照会しない(理由`floating`) |
| 版が無い(中央パッケージ管理) | 照会しない(理由`central_package_management`) |

**評価しないため、使われるか確かめられない参照は照会しない**(レビュー指摘。NuGetの公式の説明: `PackageReference`と`ItemGroup`のどちらにも`Condition`を付けられる):

- 照会するのは、`<Project>`の直下の`<ItemGroup>`の直下にある、**`Condition`の無い**`<PackageReference Include="...">`だけ。`PackageReference`自身・親の`ItemGroup`・子の`<Version>`のどれかに`Condition`がある場合、`<Choose>`/`<When>`/`<Otherwise>`の中、`<Target>`の中は照会しない(理由`conditional`)
- `Update=`・`Remove=`で同じ名前を扱う要素がファイル内にある場合、**その名前の`Include`も全て照会しない**(理由`updated`/`removed`。`Update`だけ未解決にすると、先行する`Include`の古い版を照会してしまうため)
- 同じ名前の`Include`が複数ある場合は照会しない(理由`duplicate`)
- `VersionOverride`がある場合は照会しない(理由`central_package_management`)
- プロジェクトのディレクトリからスキャン対象のディレクトリまでの`Directory.Build.props`・`Directory.Build.targets`(暗黙に読み込まれる)に`PackageReference`(`Include`・`Update`・`Remove`)がある場合、その名前も照会しない(理由`updated`)。スキャン対象の外の同名のファイルは確かめられないことを`coverage.warning`に示す
- `.NET SDK`が暗黙に追加する参照(NuGetの公式の説明)はファイルに無いため含まれない。直接依存だけの場合は、そもそも`coverage.complete: false`

### 直接/推移的の区別

- `packages.lock.json`: `Direct` / `Transitive`(`CentralTransitive`も推移的)
- `project.assets.json`: `project.frameworks.*.dependencies`に載るものが直接
- `*.deps.json`: `type: project`のライブラリの`dependencies`に載るものが直接
- `packages.config`: 区別できない(`unknown`)。`.csproj`(直接依存だけの場合): 全て直接
- `introduced_by`(どの直接依存が持ち込んだか)と`declared_in`はv0.17.0(`suggest_fix`と合わせて。Rustと同じ順序)

### 中央パッケージ管理(`Directory.Packages.props`)

- lockfile・`project.assets.json`があれば版は確定しているため問題ない
- どちらも無い場合、版は`Directory.Packages.props`(上位のディレクトリをたどる・`<Import>`・条件を持てる)にあり、正しく解決するにはMSBuildの評価が要る。v0.16.0では解決せず、`unresolved_package_references`(理由`central_package_management`)にして、lockfileの有効化を案内する

### 非公開フィード

- lockfile等にはパッケージの取得元が記録されないため、非公開フィードのパッケージを見分けられない(Rustの`source`のような手がかりが無い)。**その名前もapi.osv.devに送られる**ことをREADME・SECURITY.md・ツールの説明に明記する
- プロジェクトのディレクトリから`scan_project`の対象ディレクトリまでの`nuget.config`(大文字小文字を区別しない)に、nuget.org(`api.nuget.org`)以外の`packageSources`があれば、`coverage.warning`で「非公開フィードのパッケージ名も送られる」と示す(読むのはスキャン範囲の中だけ)
- `packageSourceMapping`による非公開パッケージの除外は以降の候補

### 上限と安全性

- XML(`.csproj`・`packages.config`)は専用の小さな走査で読む(外部のライブラリは使わない)。`DOCTYPE`・`ENTITY`・CDATAは扱わず、そのファイルを`skipped_files`にする(エンティティ展開による資源枯渇を避ける。`pomParent.ts`と同じ考え方)。1件4MiB
- JSON(`packages.lock.json`・`project.assets.json`・`*.deps.json`)は`npmLockCopy.ts`の事前検査(入れ子の深さ・構造の数)を共用し、1件16MiB・スキャン全体64MiB。上限を超えたファイルは`skipped_files`に理由つきで示す(スキャンは止めない)
- 照会するパッケージの数はスキャン全体で上限を設ける(例: 20万件。超えた分は`skipped_files`)
- 名前の一覧の照合はMap・Setで行う(件数に比例する時間。過去の二乗時間の指摘を踏まえる)

### 応答の変更

- `coverage`: `local_projects`(数)、`unscannable_nuget_packages`、`unresolved_package_references`を追加。`lockfile_missing`の`status`に`direct_only`を追加。`ecosystem_breakdown`に`NuGet`
- `.csproj`の下限の指定から照会したパッケージには、requirements.txtの下限と同じ`version_is_lower_bound: true`を付ける(`scan_project`・`suggest_fix`の既存のフィールド)
- 履歴: 範囲の欠けの件数に新しい一覧を加える(`historyRecord.ts`のGAP_FIELDS)
- README・ツールの説明(`scan_project`のエコシステムの一覧)・SECURITY.md(送信先)を更新

### 段階計画(推奨案)

- **v0.16.0**: 上記のスキャン(`packages.lock.json`・`project.assets.json`・`packages.config`・`*.deps.json`・`.csproj`の直接依存)と直接/推移的の区別、非公開フィードの警告
- **v0.17.0**: `suggest_fix`のNuGet対応(NuGetの版の順序: 4つ目の数・プレリリースの大文字小文字を区別しない比較・`1.0`=`1.0.0`の正規化)、`introduced_by`・`declared_in`、`dotnet add package X --version Y`の案内
- 以降(要望があれば): 中央パッケージ管理の版の解決、`packageSourceMapping`による除外

### 完了条件とテスト

- 各形式の解析: 照会する・自分のプロジェクト・照会しないものの分類、確定版の判定(`$(...)`・範囲・`*`・`[x]`・4つ目の数・プレリリース)、名前の大文字小文字、複数のフレームワークの版
- 対応付け: `packages.<名前>.lock.json`、1つのディレクトリに1つ・複数のプロジェクトがある場合の`packages.lock.json`、`NuGetLockFilePath`、`project.assets.json`の`projectPath`の一致・不一致、確認できないプロジェクトの`unconfirmed`と`complete: false`。確認できないlockfileもスキャンすること
- 優先順位: 確認済みのlockfileがあれば`project.assets.json`・`.csproj`を使わない、`project.assets.json`の古さの警告、`direct_only`
- `.csproj`: 版の指定の各形(完全一致・下限・下限を含まない範囲・`$(...)`・`*`・版なし)、`Condition`(参照・`ItemGroup`・子の`Version`)、`Choose`・`Target`の中、`Update`・`Remove`が先にも後にもある場合、重複、`VersionOverride`、`Directory.Build.props`/`.targets`の`PackageReference`
- 走査: プロジェクトのディレクトリの`bin`・`obj`は飛ばし、他のエコシステムの`bin`は飛ばさない
- 安全性: 元のファイルをosv-scannerに渡さない、XMLの`DOCTYPE`・`ENTITY`の拒否、JSON・XML・件数の上限、`nuget.config`はスキャン範囲の中だけ読む
- 実バイナリでMCP経由: 各形式で既知の脆弱性を検出し、`type: project`の同名パッケージ・未解決の版を照会しないこと。2.4.0でも同じ結果
- **実物のファイルでの確認**: 手元に.NET SDKが無いため、`dotnet restore`で生成した実物(`packages.lock.json`・`project.assets.json`・`*.deps.json`)は公開リポジトリから入手するか、利用者に用意してもらう(ダウンロードは許可を得てから)

### 実装メモ(設計からの変更点、2026-10-23)

- 構成: 各形式の解析・XMLの走査・コピー・関係は`src/utils/nugetFiles.ts`、プロジェクトとの対応付けは`src/utils/nugetProject.ts`。検出(`manifestDetector.ts`)は走査で.NETのファイルを振り分け、`analyzeNuget`の結果を`DetectedProject`の`nugetCopies`等に入れる。`scanProject.ts`がコピーを`packages.lock.json`形式で渡す
- 注意の文言は`coverage.warning`(範囲の欠けの定型文)とは別の`coverage.nuget_warnings`(配列)にした。下限・`project.assets.json`の古さ・直接依存だけの場合の確かめられない参照・非公開フィードを並べる。非公開フィードと古さは`complete`を変えない(範囲の欠けではないため)
- `nuget.config`は、プロジェクトのディレクトリから上をたどる代わりに、スキャン対象の中の全ての`nuget.config`を確かめる(注意を示す側に広い)。解釈できない`nuget.config`も注意の対象
- `Directory.Build.props`/`.targets`は、プロジェクトのディレクトリかその上(スキャン対象の中)にある全てのものの名前を使う(MSBuildが自動で読むのは最も近い1つだが、それが上位を読み込むことがあるため広く取る)。解釈できないものは`skipped_files`にし、その下の全ての参照を照会しない
- 直接の`PackageReference`が無いプロジェクトも、確認済みの情報源が無ければ`lockfile_missing`(`direct_only`)に残す(当初は雑音を避けて無視していたが、`Directory.Build.props`やSDKが参照を加える構成で欠落を隠し、別のエコシステムのlockfileが同居すると`complete: true`になった。レビュー指摘)
- **脆弱性チェック(2026-10-24)での修正**:
  - XMLの文字参照の展開(`pomParent.ts`の`decodeEntities`、.NETのXMLの走査と共用)は、Unicodeの範囲外・サロゲートの文字参照(`&#x110000;`・巨大な10進数等)を`String.fromCodePoint`にそのまま渡して例外にしていた。1つの`pom.xml`(親POMの`relativePath`)・`.csproj`等で**スキャン全体が`internal_error`**になり、同じプロジェクトの他のエコシステムも結果を返さない(リポジトリにファイルを1つ置くだけでスキャンを妨げられる)。v0.4.0〜v0.15.0の`pom.xml`に該当。範囲外は解釈できない(`undefined`)として、そのファイルだけを除外する。定義済み実体の照合を`in`から`Object.hasOwn`にし、`&constructor;`等がプロトタイプのプロパティとして展開されないようにした
  - osv-scannerに渡す.NETのコピーは1,000件まで(走査のマニフェストの上限と同じ)。コピーごとに`--lockfile`の引数になり、9,000件で引数の長さの上限(macOSのARG_MAX 1MiB)を超えてスキャン全体が`internal_error`になっていた。超えた分は`skipped_files`(マニフェストにも数えない)
  - `project.assets.json`の「古い可能性」の注意は、プロジェクトごとではなく1件にまとめる(名前は5件まで、残りは件数)。応答が際限なく大きくならないように
  - 依存: `body-parser` 2.4.0(GHSA-27r3-jxmh-p828)・`fast-uri` 3.1.9(4件)にロックファイルだけ更新(MCP SDK経由。配布物にロックファイルは含まれない)
- `*.deps.json`のランタイムパックは、SDKがライブラリ名に`runtimepack.`を付ける(`runtimepack.Microsoft.NETCore.App.Runtime.linux-x64/8.0.0`)。接頭辞を除いて照会する(付けたままではOSVで0件、正しい名前で12件。当初のテストの入力は接頭辞の無い形で、実際の形と違っていた。レビュー指摘)
- `NuGetLockFilePath`のあるプロジェクトは、既定の名前・名前付き(`packages.<名前>.lock.json`)のどちらのlockfileとも対応付けない(当初は名前付きの判定で先に返し、別の保存先を指定したプロジェクトが古い名前付きlockfileで確認済みになっていた。レビュー指摘)
- `.csproj`を直接指定した場合は、他のマーカー(`package.json`等)と同じく、そのディレクトリを走査する
- `packages.config`の`developmentDependency`による`dependency_groups: ["dev"]`は見送り(`dependency_groups`はosv-scannerの出力をそのまま返す項目で、本サーバーが付ける仕組みが無い)
- 下限の印: 同じ名前・版を別のファイルで確定版として照会した場合は付けない(確定版の結果が実在を示すため)
- 名前に`;`区切りの複数の指定(`Include="A;B"`)を扱う。`$(...)`・ワイルドカードを含む名前は照会せず(理由`property`)、`Update`・`Remove`の名前にあれば全ての名前を照会しない
- 確認: 単体・統合のテスト(70件)、変異確認(対応付けの各規則・Conditionの親・Update・下限・deps.jsonのproject・DOCTYPE・bin/objの除外・下限の表示・関係の直接優先・非公開フィード・別の版の別グループの13通りと、レビュー指摘の修正3件(`runtimepack.`の接頭辞・名前付きlockfileの`NuGetLockFilePath`・参照の無いプロジェクトの欠け)で、追加したテストが失敗する)。MCP経由で実バイナリ(2.7.0)に複数の形式を混ぜた構成を渡し、対応付け・未解決の理由・`bin`の除外が設計どおりであることを確認
- **実物での確認(2026-10-23)**: 公開リポジトリの実物7件(Project-MONAI/monai-deploy-informatics-gatewayの`packages.lock.json`と`.csproj`、EasyPost/easypost-csharpの`packages.lock.json`(6つのフレームワーク)と`.csproj`、Tophness/StickyMouseの`obj/project.assets.json`と`.csproj`、bitmono-project/BitMonoの`*.deps.json`。利用者の許可を得てダウンロード、作業用の領域のみ)で確認。コピーのパッケージは、osv-scannerが元のファイルから読む全パッケージ(`--all-packages`)から自分のプロジェクトだけを除いたものと一致した(MONAI: 43件中`Project`の1件、BitMono: 16件中`type: project`の4件(`Echo`等。osv-scannerだけではNuGetとして照会される))。StickyMouseの`projectPath`(Windowsのパス)で対応付けできた
- 実物の確認で判明: ダウンロード(`git clone`も同じ)はファイルを任意の順に書くため、更新日時のわずかな差で`project.assets.json`を古いと誤って示した。差が60秒を超える場合だけ示す

## NuGetの修正提案(2026-10-26、ソース実装)

- `nugetVersion.ts`と`versionScheme.ts`でNuGet VersionReleaseの比較を追加。1〜4個の数値部、ゼロ埋めによる正規化、4つ目のrevision、プレリリースの大文字小文字を区別しない比較、メタデータの無視。純数字のプレリリース識別子の先頭ゼロや解釈できない境界は推奨の根拠にしない。IDの照合は大文字小文字を区別しない。
- `suggest_fix`は既存の影響範囲検証・候補のOSV再照会を利用する。NuGetの範囲はECOSYSTEM型。情報不足なら保留し、修正版なし・照会失敗・conflictは既存の区別を維持する。
- 更新案内は直接/推移的依存・中央管理とランタイムパックで分ける。`.csproj`の下限から検査した場合は`version_is_lower_bound`を維持し、requirements.txtではなくPackageReferenceの下限であると示す。互換性・制約の充足や実際の復元版は保証せず、dotnet/MSBuildを実行しない。
- MCPと実際のOSV-Scanner 2.7.0で、lockfile・assets・packages.config・deps.json・直接参照のみ・不正XML混在・ランタイムパックの7ケースを確認。Newtonsoft.Json 12.0.1 → 13.0.1、Microsoft.NETCore.App.Runtime.linux-x64 8.0.0 → 8.0.32。候補のOSV再照会はいずれもclean。検証用ファイルは不変。
- `introduced_by`/`declared_in`の拡張と復元の実行はこの実装に含めない。パッケージの推奨版はNuGetフィードでの存在確認や対象TFM/RIDでの復元を代替しない。リリース番号は変更しない。

## Composerの依存関係(2026-10-26、ソース実装)

- lockfileと同じディレクトリのcomposer.jsonを安全に一度読み、require/require-devを直接依存とする。lockfileの各パッケージのrequireをたどり、到達する依存にintroduced_byを付ける。依存パッケージのrequire-dev/suggest/conflictはたどらない。直接宣言はプロジェクト相対のcomposer.jsonをdeclared_inに示す(推移的依存に直接宣言は付けない)。同じ依存が直接かつ別ルート由来ならdirectとintroduced_byを併記。
- 名前の重複、provide/replaceにより曖昧な参照、仮想依存、到達できない依存は推測しない。制約の充足やlockfileの鮮度を検証するソルバーではない。循環は訪問済み集合で止め、全Composerファイルで共有する2,000,000操作の予算を超えた解析はunknown。introduced_byは既存の10件/省略数の上限に従う。
- path/branch依存はグラフの中継点にはなるが、スキャナー入力には引き続き含めない。pathのURLや依存パッケージの実ファイルをたどらない。composer.jsonは4MiBまでで、入力・JSON予算をComposer全体で共有する。無い/読めない/解釈できない場合は関係だけunknownとし、lockfileの検査は継続する。
- scan_project/suggest_fixとも同じ捕捉済みグラフを使う。Composerの更新案内は直接依存のdeclared_in、推移的依存のintroduced_byに合わせる。
- MCPとOSV-Scanner 2.7.0で、symfony/http-kernel v5.4.0(直接) → symfony/http-foundation v5.4.0(推移的)、開発依存のsymfony/process v5.4.0(直接)を確認。修正提案は順に5.4.20/5.4.50/5.4.51、候補照会は全てclean。検証用ファイルは不変。

## バックログ(2026-10-07)

着手順: B1(v0.3.3) → B2の設計メモ作成 → B2の段階実装。

### B1. ネットワーク通信先の透明化(v0.3.3、最優先)

**背景(2026-10-07 実機確認、osv-scanner v2.4.0)**: ログ用のCONNECTプロキシ経由で接続先ホスト名を記録した(TLSの中身は見ていない)。READMEの「照会先はOSVデータベースのみ」は**公開中の版でも事実と異なる**。

| スキャン対象 | 接続先 | 推移的依存の補完 |
|---|---|---|
| `pom.xml`(現行の`scan_java_project`。MCP経由でも確認) | `api.osv.dev` + `api.deps.dev` | あり |
| `requirements.txt` | `api.osv.dev` + `api.deps.dev` | あり |
| `gradle.lockfile` / `package-lock.json` / `go.mod` | `api.osv.dev` のみ | なし |
| `pom.xml` + `--no-resolve` | `api.osv.dev` のみ | なし(直接依存のみ) |
| `pom.xml` + `--data-source native` | `api.osv.dev` + `repo.maven.apache.org` + **pom.xmlの`<repositories>`に書かれた任意のURL** | あり |

- 推移的依存の解決のため、宣言された依存の名前・バージョン(社内パッケージ名を含む)がdeps.devへ送られると考えられる(通信内容は暗号化のため推定)
- `--data-source native` はスキャン対象が指定した任意ホストへ接続する(SSRF相当)。**採用禁止**
- `--no-resolve` は通信先をOSVのみにできるが、pom.xmlでは推移的依存がすべて欠落し検出漏れが大きく増える

**タスク**:
- [x] README・SECURITY.mdのネットワーク記述を事実どおりに修正(pom.xml/requirements.txtではdeps.devへ依存の名前とバージョンが送られる。lockfile方式なら送られない) → READMEに「通信先とプライバシー」節を新設。JAR/WAR・SBOMスキャンはapi.osv.devのみと実機確認(2026-10-07)
- [x] 環境変数(案: `OSV_MCP_NO_REMOTE_RESOLUTION=1`)で `--no-resolve` を付与。既定は現行動作(互換性維持)。検出漏れとのトレードオフと、社内パッケージ名を出したくない場合はlockfile方式を使う回避策をREADMEに記載 → projectモードのみに付与(artifact/sbomは外部解決をしないため)。MCP経由で接続先がapi.osv.devのみになり、推移的依存(jackson-core)が抜けることを確認
- [x] 固定引数に `--data-source native` が含まれないことをテストで保証 → 既定値の変更に備え `--data-source deps.dev` も明示指定
- [x] (レビュー指摘)`OSV_MCP_NO_REMOTE_RESOLUTION` が止めるのはdeps.devへの送信だけで、OSVへのパッケージ名・バージョン送信は続くことを明記
- [x] (レビュー指摘)推移的依存を省略したことを応答に反映。`scan_java_project` / `suggest_fix` の先頭付近に `dependency_resolution`(`transitive_resolution: enabled/disabled`、無効時は警告)を追加。無効化の判断はツール側で1回だけ行い、スキャナー引数と応答の両方に同じ値を使う(伝播をテストで確認)
- [x] (レビュー指摘)当初は警告をマニフェスト一覧にpom.xmlがある場合だけ付けていたが、一覧の探索は深さ3まででosv-scannerの`-r`(深さ無制限)と範囲が一致せず、深い階層のpom.xmlで警告が漏れた。無効時は「マニフェストからの推移的依存の解決を省略。lockfileに記録された依存は対象」という条件付きの警告を常に返すよう変更し、直下gradle.lockfile+`a/b/c/pom.xml`構成の回帰テストを両ツールに追加

### B2. 対象エコシステムの拡大(JavaScript / Python / Go)

**確定した方針(2026-10-07)**:
- ツール構成: 汎用の `scan_project`(lockfileを自動判別し、Java含む全エコシステムを一括スキャン)を新設。既存の `scan_java_project` 等は互換性のため維持。言語別ツールの増設はしない
- 検出はlockfile方式で統一(`npm install`/`pip install`は任意コード実行を伴うため採用しない。Gradleと同じ判断)
- `requirements.txt` は受け付けるが、バージョン未固定・範囲指定の行をcoverageで明示する

**実機確認で判明した前提(2026-10-07、osv-scanner v2.4.0)**:
- スキャン自体は現行のまま3言語とも動作する(エコシステム名は `npm` / `PyPI` / `Go`)。Java固有なのは検出(`projectDetector.ts`)とバージョン比較・推奨(`mavenVersion.ts` / `affectedVersions.ts` / `suggestFix.ts`)
- OSVの影響範囲の型: npmは`SEMVER`(一部`ECOSYSTEM`)、Goは`SEMVER`のみ、PyPIは`ECOSYSTEM`+`GIT`。**現行の`affectedVersions.ts`は`ECOSYSTEM`以外を情報不足とみなすため、3言語ともsuggest_fixが全件推奨保留になる**
- `requirements.txt`: バージョン未固定の行(`flask`)は出力から無言で消える。`Jinja2>=2.0`は下限`2.0`を使用中バージョンとみなす(誤検知の原因)
- npmの開発用依存には `dependency_groups: ["dev"]` が付く
- Goは`v`なしの版で返る。`go.mod`のスキャンでは標準ライブラリ(stdlib)が報告されない

**段階計画**:
- [x] 詳細設計メモの作成(B1完了後) → 上記「対象エコシステム拡大 詳細設計メモ」節(2026-10-07)
- [x] **Phase 0(v0.3.4)**: 現行版の不具合3件(requirements.txtの取り込みによるスキャン範囲の境界の迂回、suggest_fixのnpm誤表示、manifestsとスキャン範囲の不一致)の修正。検出したファイルだけを`--lockfile`で個別に渡す方式へ切り替える → 実装済み(2026-10-07)。`runOsvScan`は検出済みマニフェストの絶対パスを受け取り、許可した3形式以外は渡さない。suggest_fixはMaven以外を`unsupported_ecosystem`(CVEは`tier: "unsupported"`、unfixedに数えない)。3件の再現手順を回帰テスト化し、実バイナリでMCP経由の解消を確認。利用者から見た変更: Java用ツールは同じディレクトリのJava以外のlockfile(npm・PyPI等)をスキャンしなくなる(v0.4.0の`scan_project`で扱う)
  - (レビュー指摘)上限エラーで「マニフェストを直接指定」と案内していたが、直接指定でも親ディレクトリ全体を再探索しており回避できなかった。マニフェストの直接指定は境界検証後にそのファイル1件だけを返すよう分岐(Gradleビルドファイルの指定は従来どおりディレクトリを探索)。pom.xml+child/pom.xml構成の回帰テストを追加。v0.3.3以前は直接指定でもディレクトリ全体(`-r`)をスキャンしていたため、これも利用者から見た変更
- [x] v0.4.0: `scan_project`(3言語の検出、`.venv`/`site-packages`/`vendor`の除外、lockfile欠如時の案内エラー、requirements.txtのcoverage明示、エコシステム別集計・dev依存表示)。suggest_fixはJava以外を「未対応」と明示的に返す → 実装済み(2026-10-07)。実装時の判断:
  - 走査・境界検証を`projectWalk.ts`に切り出し、Java用と共有。osv-scannerに渡す単位を「パス+形式」(`ManifestTarget`)にし、許可する形式は`manifestFormats.ts`の一覧に限定
  - lockfile欠如: 同じディレクトリに同じエコシステムのlockfileがあれば記録しない。gradleのビルドファイルはgradle.lockfileでのみ満たされる(pom.xmlでは満たさない)。対応ファイルが1つも無ければ案内を含む`no_manifest_found`
  - requirements.txtの対象名は`requirements.txt`・`requirements-*.txt`・`*-requirements.txt`等。分類は実機確認(`==`/`===`は固定、`>=`/`~=`は下限、それ以外の指定は範囲)に合わせ、`>=`/`~=`の行に該当するパッケージには`version_is_lower_bound`を付ける
  - 応答: `coverage`(complete・warning・各一覧、各200件まで+`omitted_items`)を件数より前に置き、`ecosystem_breakdown`は脆弱性0件のエコシステムも含める。スキャン対象由来の文字列はすべて`sanitizeExternalText`を通す
  - 既存ツールへの影響: `dependency_groups`はosv-scannerが値を返した場合だけ出力するため、Mavenの出力は変わらない
  - (レビュー指摘P1)当初は事前解析で取り込み先を検証してから元のrequirements.txtを渡していたが、osv-scannerは`- r ../x.txt`(空白入り)も取り込みとしてたどる一方、事前解析は未知のオプションとして無視しており、範囲外の内容が結果に入りcompleteにもなった。**解釈のずれがそのまま迂回になる構造**のため、元ファイルを渡すのをやめ、解釈できた依存の行だけを`名前==版`等に正規化して専用の一時ディレクトリ(`mkdtemp`、`0600`・`wx`、成功・失敗とも削除)に書いたコピーをスキャンする方式に変更(`scan_sbom`と同じ考え方)。コピーには取り込み・オプションを含めないため、osv-scannerがたどれる参照が存在しない。解釈できないオプション・版は無視せず`unscannable_requirements`に理由付きで記録
  - (レビュー指摘P2)osv-scanner 2.4.0は`--requirement`と`-c`をたどらない(実機確認。たどるのは`-r`系のみ)。取り込みは本サーバーがプロジェクト内のものだけ展開してコピーに含める(`--requirement`も確実にスキャンされる)。外・存在しない・URL・深さ5超・50ファイル超の取り込みと制約ファイル(`-c`、適用しない)は、ファイルごと外さず該当行を`unscannable_requirements`に記録し、残りはスキャンする(コピーに取り込み指定が無いため安全)。`skipped_files`は元ファイル自体が読めない・1MiB超の場合のみ
  - (レビュー指摘P3)当初は上位に同じエコシステムのlockfileがあれば充足扱いにしていたが、workspace設定の無いルートのlockfileで独立した子の欠落を隠していた。上位のlockfileだけの場合は、package-lock.json(v2以降)の`packages`に子のディレクトリが収録されていることを確認できたときだけ充足とし、未収録なら`status: "missing"`、確認できない形式(yarn.lock、Python系、gradle等)なら`status: "unconfirmed"`で報告
- [x] v0.4.2: `scan_project`の`fixed_versions`がnpm・Go・PyPIで常に空になる不具合の修正(上記「suggest_fix npm/Go対応(v0.5.0)詳細設計メモ」参照) → 実装済み(2026-10-07)。`semverVersion.ts`(SemVer 2.0.0の厳密な解釈と優先順位)と`versionScheme.ts`(エコシステム別の範囲の型と並べ替え)を追加し、`extractFixedVersions`を一般化。同じ`parseOsvScanOutput`を使う`scan_sbom`(npm・PyPI等のSBOM)も同じく直る。実バイナリでMCP経由の確認: lodash `[4.17.21, 4.18.0]`、golang.org/x/text `[0.39.0]`等が入り、Mavenの`fixed_versions`とsuggest_fixの出力はv0.4.1と同一
  - (レビュー指摘、v0.4.2に同梱)存在する親POMをスナップショットへコピーできない場合(10MiB超・FIFO・末尾のシンボリックリンク等)に、子のpom.xmlを黙って完全扱いにしていた(v0.4.1で混入)。子はスキャンし、`incomplete_manifests`(scan_projectは`coverage.skipped_files`、complete=false)で欠落の可能性を示す。子に依存が無く`no_packages_found`になる場合もエラーに理由を含める(実バイナリで確認)。親POMが存在しない(ENOENT)場合は元の配置でも読まれないため報告しない
  - (レビュー指摘)コピーの書き込みで`bytesWritten`を確認せず、部分書き込みで欠損しうる → 書き切るまで繰り返す。SemVerの数値のプレリリース識別子を`Number`にしていたため2^53超で同値になる → `BigInt`で比較
  - (検証中に発見)スキャナーのエラーの`detail`(stderr)に一時ディレクトリのパスが出ていた → 元のパスに戻す
- [x] v0.5.0: suggest_fixのnpm/Go対応(semver比較、`SEMVER`範囲の検証、0.x系のマイナー更新を破壊的変更として扱う、Goのv2以上はモジュールパス変更を注記) → 実装済み(2026-10-07)。実装時の判断:
  - `versionScheme.ts`にエコシステム別の操作(`isValid`・`compare`・`isPrerelease`・`classify`・`seriesLabel`)をまとめ、`affectedVersions.ts`と`suggestFix.ts`はそれ経由で比較する。Mavenは`isPrerelease`を常にfalseにして従来の推奨を変えない(v0.4.2と出力のハッシュが一致)
  - 解釈できない版を含む区間は判定に使わず情報不足にする。`candidateStatus`はエコシステムを引数で受ける(`affected_versions`は応答に出るため、証拠にフィールドを足さない)
  - 候補の順位: 正式版 → Tier → 版の昇順 → ビルドメタデータの有無が現在と同じもの。実データでGoの修正版に`23.0.3`と`23.0.3+incompatible`が並び、優先順位が等しいため、`/vN`の無いモジュールで使えない形を推奨しうることが判明して追加
  - 現在の版を解釈できない場合は`verification: "unparseable_version"`(CVEは`tier: "unsupported"`)。npm・Goには`update_hint`(overrides・`go get`・`/vN`の注記)を付け、Mavenの出力は変えない
  - (レビュー指摘)当初は解釈できない修正版しか無いCVEを`unfixed`にして修正対象から外していたため、別CVEの修正版だけで`verified`の推奨を出しえた(現在1.0.0、CVE-Aの修正版`13.0`、CVE-Bの修正版`1.0.1`で1.0.1を推奨)。「修正版の記載がない・現在以下」(`unfixed`)と「修正版を解釈できない」(`unparseable_fix`)を区別し、後者は修正対象に残して推奨を保留する。両方が混在する回帰テストを追加
  - suggest_fixの検出・スキャンを`scan_project`と共通化(`scanFromSnapshot`・`buildCoverage`を共有)。`skipped_manifests`/`scope_warning`は`coverage`に統合。requirements.txtも対象になるため、deps.devへの送信はscan_projectと同じ
  - 実バイナリでMCP経由の確認: lodash 4.17.20→4.18.0(major_internal)、minimist→1.2.6、golang.org/x/text 0.3.0→0.39.0(cross_major)、golang.org/x/netの疑似バージョン→0.56.0(注記付き)、next 15.5.0→15.5.24(canaryではなく正式版)、express→4.20.0、jwt/v4→4.5.2。docker/dockerは不完全な範囲を含むため保留(既知の制限どおり)。log4j 2.14.1→2.25.4は不変
- [x] v0.6.0: suggest_fixのPython対応(PEP 440比較、`ECOSYSTEM`範囲がある場合の`GIT`範囲の無視) → 実装済み(2026-10-07)。実装時の判断:
  - `pep440Version.ts`: PyPA `packaging`と同じ正規化・比較。packagingのテストの順序一覧を移植し、さらにpipに同梱のpackaging 26.2と乱数で生成した1,500件・20,000組の比較で差分ゼロを確認
  - Tierはnpm・Goと共通の`classifyCaret`(epochの変更もcross_major)。`samePackageName`でPyPIの名前をPEP 503で照合(`fixed_versions`の抽出と影響範囲の両方)
  - **実データの検証で判明**: PYSECのレコードは1つの範囲に複数の区間を版の順でなく並べる(`introduced 2.0.0 → fixed 2.0.6, introduced 0 → fixed 1.26.17`)。v0.5.0までの検証は記載順を前提に「前の終点より小さい始点」を不正として情報不足にしていたため、DjangoやUrllib3の推奨がすべて保留になった。OSVの仕様(Evaluationの`sorted(range.events)`、並び順は推奨のみ)に合わせ、eventsを版の順に並べてから区間にする。同じ版では終点を始点より前に置き(その版を影響ありとみなす安全側)、並べても始点と終点が交互にならない範囲(重なり・始点のない終点)は曖昧なため情報不足のまま。全エコシステムに適用し、Maven・npm・Goの既存の期待値(3構成)はv0.5.0と出力のハッシュが一致
  - suggest_fixでも`markLowerBounds`を適用し、下限でスキャンした依存に`version_is_lower_bound`と注記を付ける
  - 実バイナリでMCP経由の確認(requirements.txt、`--no-resolve`): requests 2.19.0→2.33.0、urllib3 1.23→2.8.0、jinja2 2.10→3.1.6、django 3.2.0→5.2.17、pillow 8.0.0→12.3.0、fastapi 0.65.0→0.109.1(0.x規則でcross_major)、torch 2.5.0→2.13.0、flask>=1.0→3.1.3(下限の注記)。推奨先をOSV APIに直接照会し、8件は既知の脆弱性0件
- [x] (v0.6.0の検証で判明)推奨先に、現在の版には該当しない新しい脆弱性がありうる。例: cryptography 3.2→49.0.0(cross_major)は、44.0.0で混入し50.0.0で修正された2件(GHSA-g6cj-pr64-35w5等)に該当する。スキャンは現在の版の脆弱性しか知らないため検出できない(「未検出の脆弱性がないことは保証しない」の具体例)。対策案: 推奨候補をapi.osv.devに照会し、既知の脆弱性がある候補を避ける(送信先・送信内容はスキャンと同じ。公開版の名前と版のみ)。照会回数の上限と、照会失敗時の扱いを決めて実装する → 詳細設計メモ作成済み(上記「推奨先のOSV照会(v0.8.0候補)詳細設計メモ」、2026-10-08) → 実装済み(2026-10-08)。`osvApi.ts`に`queryOsvPackageVersion`(`/v1/query`、続きのページは5ページまで)、`candidateCheck.ts`で照会と選び直し。`suggestUpgradeForPackage`は同期・純粋のまま、照会で見つかった脆弱性(`extraTargets`)と除外する候補(`excluded`)を受け取って選び直す(contextなしの結果が従来の推奨)。実APIでMCP経由の確認: cryptography 3.2→50.0.0(49.0.0の2件を注記)、他の5構成の推奨はv0.7.0と同一。1回の呼び出しの所要時間は2〜4秒
  - (レビュー指摘)食い違い(スキャン済みの脆弱性に該当とOSVが返す)で候補を除外しても、他に候補がない場合に元の推奨を`verified`のまま返していた。新しい脆弱性に修正版がない場合(`has_known_vulnerabilities`、推奨は残す)と区別し、食い違いの場合は`candidate_check: "conflict"`で推奨を保留する(`no_verified_candidate`)
  - (レビュー指摘)JSONのnull・文字列・配列の応答や`{"vulns":[null]}`を空の結果として`clean`にしていた。応答のルート・各レコード・ページトークンの型を検証し、不正なら失敗(`failed`)にする
- [x] v0.7.0: 直接/推移的依存の区別(npmの`overrides`はルートプロジェクトでのみ有効な点を推奨文に反映)。v0.6.0から分離(2026-10-07) → 詳細設計メモ作成済み(上記「直接/推移的依存の区別(v0.7.0)詳細設計メモ」) → 実装済み(2026-10-07)。実装時の判断:
  - パッケージごとのスキャン元は`WeakMap`で保持し(`packageSources`)、応答のJSONに出さない。`scan_java_project`等の応答は不変(パッケージのキーが変わらないことを確認)
  - 判定は`scanFromSnapshot`内で、スナップショットを消す前にコピーを読んで行う。package-lock.jsonの解析は合計256MiBまで、たどる辺は200万まで。超えた・解析できないファイルは`unknown`(スキャンは続ける)
  - Goは`replace`の置換元・置換先に`replaced_in_go_mod`を付け、`update_hint`でreplaceの版の更新を案内する(requireの版を変えても効かないため)。コメントが`indirect`だけか`indirect;`で始まる場合だけ間接依存(Goと同じ)
  - (レビュー指摘)当初はreplaceを名前だけで照合し、版を限定したreplace(`replace a v1.0.0 => b v1.0.1`)をrequireの版(v1.2.0)が一致しなくても適用扱いにしていた。osv-scanner 2.4.0で、版を限定したreplaceはrequireの版が一致する場合だけ適用されることを確認し(一致しなければ元の版で報告)、Goと同じ規則(版を限定したものが優先、限定しないものは全版)で適用されたreplaceだけを判定するよう修正。`replaced_in_go_mod`は置換先の名前と版(ローカルディレクトリへの置換は置換元の名前)に付ける
  - (レビュー指摘)判定用のlockfileを全体読み込みの後で予算と比較していたため、予算を超えて解析しないファイルもメモリに載せていた。`readRegularFile`で残りの予算を上限にし、読み込み前のサイズ確認と読み込み途中の打ち切りを行う(go.modも同じ予算に含める)
  - 実バイナリでMCP経由の確認: 設計メモの期待値どおり(express・lodash 2版・minimist・node-fetch・qs 6.5.2が`direct`で`declared_in`付き、qs 6.7.0・body-parser・cookie・path-to-regexp・send・serve-staticが`transitive`で`introduced_by: ["express"]`、go.modの`// indirect`と`replace`、requirements.txtのidna・urllib3が`transitive`)。suggest_fixの推奨・注記・CVEごとの詳細は4構成でv0.6.0と出力のハッシュが一致 → 詳細設計メモ作成済み(2026-10-07、上記「suggest_fix PyPI対応・直接/推移的依存の区別(v0.6.0)詳細設計メモ」)
- [ ] 以降: Goバイナリスキャン(ビルド情報からstdlibの版も取得でき、go.modで拾えないstdlibの脆弱性を補える)

### B4. pom.xmlの親POM(`<parent><relativePath>`)によるスキャン範囲外の読み込み(v0.4.0で対応)

**背景(2026-10-07 実機確認、osv-scanner v2.4.0)**: v0.4.0のレビュー対応中、requirements.txtの取り込みと同じ種類の問題を確認した。

- `<parent>`の`<relativePath>`がスキャン範囲の外(例: `../outside/pom.xml`)を指すと、osv-scannerはその親POMを読み、そこに書かれた依存が結果に入る(`--no-resolve`でも同じ)
- `relativePath`を省略した場合もMavenの既定値`../pom.xml`を参照し、親のGAVが一致すれば読む(一致しなければ読まない)
- 影響: `scan_java_project` / `suggest_fix`(公開中のv0.3.4を含む)と`scan_project`。`OSV_MCP_ALLOWED_ROOT`の外にあるpom.xmlの依存情報が結果に入り、照会先に送られうる
- 同種の確認: `go.mod`の`replace`によるローカルパスは読まない(パス名がパッケージ名として出るだけ)

**設計上の論点**: サブモジュールだけをスキャンしたときに親POMを読むのはMavenとして正当な動作で、requirements.txtのように「プロジェクトディレクトリ外は読まない」とすると正当な利用を壊す。境界を`OSV_MCP_ALLOWED_ROOT`にするか、親POMを読ませない(`<relativePath/>`を明示した検証済みコピーをスキャンし、親はリポジトリから解決させる)か、範囲外の親を指すpom.xmlをスキャン対象から外して報告するか、を決める必要がある。

- [x] 方針決定と実装 → **境界を`OSV_MCP_ALLOWED_ROOT`とする案で確定**(2026-10-07)。v0.4.0に含めてリリース
  - 追加の実機確認: 親の親もたどる(連鎖の途中が外でも読む)、`<relativePath/>`(空)はローカルを参照しない、ディレクトリを指す場合はその中のpom.xml、GAV不一致なら読まない
  - `src/utils/pomParent.ts`: 親POMの連鎖を最大10段たどり、参照先が実在して許可ルートの外ならpom.xmlを除外理由付きで返す。GAVの一致は確認せず安全側に除外。プロパティ参照等で評価できないrelativePathも除外。許可ルート未設定時は検証しない(任意のパスをスキャンできる状態のため)
  - `scan_java_project` / `suggest_fix`: 外したpom.xmlを`skipped_manifests`と`scope_warning`で件数より前に返す(外したものが無ければ出力しない=既存の出力は不変)。全件除外・直接指定は`path_outside_allowed_root`
  - `scan_project`: `coverage.skipped_files`に記録(completeはfalse)
  - 実バイナリでMCP経由で確認: 許可ルート内の親を持つサブモジュールは従来どおり親の依存を検出し、外を指す親のpom.xmlは除外され範囲外の依存が混入しない
  - (レビュー指摘P1)当初は正規表現で「最初の`<parent>`」を探していたが、`<m:parent>`を親なしと判断し、osv-scannerは範囲外の親POMを読んだ(complete=trueにもなった)。追加の実機確認で、osv-scanner(Goのencoding/xml)は要素を**名前空間・接頭辞に関係なくローカル名で照合**し(`<m:parent>`、別名前空間の`<x:parent>`、`<parent xmlns="別">`、`<m:relativePath>`も読む)、**ルート直下の`parent`だけ**を対象にし(入れ子のおとりは無視)、**重複すると後のものが有効**、文字参照・CDATAは展開、前後の空白は除去、大文字の`<Parent>`は読まないことを確認。正規表現をやめ、先頭から順に読む小さなXMLパーサーに置き換えてGoの解釈に合わせた。外部のXMLパーサーは使わない(重複・CDATAの扱いが別のずれを生みうるため)。同じ解釈を保証できない構文(ルート直下のparent・relativePathの重複、CDATA・DOCTYPE、未知の実体参照、プロパティ参照、閉じていないタグ、UTF-8以外)は除外。11通りの書き方すべてで、実バイナリでもMCP経由で範囲外の依存が混入しないことを確認
  - (レビュー指摘P1)自作パーサーがXML 1.0の行末処理(解析前にCRLF・CRをLFへ正規化)をしておらず、`relativePath`にCRを書くと、検査側は`a\rb`を探して「参照先なし」と判断し、osv-scannerは`a\nb`(改行を含む名前の許可ルート外のディレクトリ)の親POMを読んだ。解析前の正規化を追加。あわせて、文字の正規化や前後の空白の除去の細部(JSの`trim`とGoで扱いが異なる: U+FEFF・U+0085等)で参照先がずれる余地を残さないよう、`relativePath`に制御文字・通常の空白以外の空白・書式文字が含まれる場合は解釈できないものとして除外(通常の空白・日本語のディレクトリ名は許可)。実バイナリでMCP経由の解消と、CRLFで書かれた正当なpom.xmlが従来どおりスキャンされることを確認

### 許可ルート未設定時の親POMのスナップショット外参照(v0.4.1〜v0.13.0の不具合、v0.14.0で修正、2026-10-22)

- **事象**: `snapshotPom`は、親の参照がスナップショットの外に出る場合・解釈できない場合・連鎖が上限を超える場合を、許可ルート設定時だけ除外し、未設定時はそのまま(または欠落の注記付きで)スキャンしていた。osv-scannerは、余分な`../`でルートを越えると親を読まないが、**スナップショット内のコピーの位置からちょうどルートに届く数の`../`+絶対パス**なら本物のファイルを読む(2.4.0・2.7.0で確認)。コピーの深さは「一時ディレクトリの実パスの深さ+3(snap・tree・_)+元の深さ」
- 再現(HEAD、許可ルートなし、MCP経由、2.7.0): `../`×17+元の外のpom.xmlの絶対パスで、検証もコピーもしていない外の親POMの`log4j-core`が結果に出た。「osv-scannerには元のファイルを渡さない」というスナップショットの保証(差し替え・名前付きパイプへの対策)が、許可ルート未設定時に崩れていた
- 修正(利用者が実装、作業ツリー): 許可ルートの有無に関係なく、スナップショットの外に出る参照・解釈できない参照・上限超過を除外する。全ファイルのコピー後に、osv-scannerが見る連鎖をコピーだけでたどり直して検証する(`validateCopiedPom`。完成したコピーだけを親として扱う)
- 除外の種類: 許可ルート未設定時は`unreadable`にし、全件が除外されたときのエラーを`no_manifest_found`にする(当初は`outside_allowed_root`で、未設定なのに`path_outside_allowed_root`と示していた)。許可ルート設定時は従来どおり`outside_allowed_root`・`path_outside_allowed_root`

### 親POMの空のrelativePath(v0.4.0〜v0.13.0の不具合、v0.14.0で修正、2026-10-22)

- **事象**: `<relativePath/>`・`<relativePath></relativePath>`・空白だけの値を、Mavenの仕様どおり「ローカルの親を参照しない」と解釈していた(`pomParent.ts`の注記は2026-10-07の2.4.0の実機確認としていたが、2026-10-22の再確認では2.4.0・2.7.0とも既定の`../pom.xml`を読む)
- 影響: v0.4.0(元のファイルをスキャン)では許可ルートの検証をすり抜け、許可ルートの直下の`pom.xml`の空のrelativePathで、許可ルートの1つ上の親POMをosv-scannerが読んだ(v0.4.0のタグでMCP経由で再現: `log4j-core`が結果に出る)。v0.4.1以降はスナップショットのコピーだけを渡すため読まれないが、親をコピーしないため継承した依存が黙って欠け(`complete: true`のまま)、許可ルートの検証も行われなかった
- 修正: 空・空白だけの値を既定の`../pom.xml`として扱う(`parentRelativePath`)。親が許可ルート内ならコピーし、外なら他の親POMと同じく除外する。MCP経由(2.7.0): 許可ルートなしで`log4j-core`を検出、許可ルートが子のディレクトリなら`path_outside_allowed_root`
- 同時に確認した他の参照(2.4.0・2.7.0): 既定の`../pom.xml`に親が無い場合に上の階層をたどらない、relativePathの参照先が無い場合に`../pom.xml`へ戻らない、絶対パスのrelativePathは読まない(GoのJoinで連結される)。いずれもスナップショットの外を読む経路はない
- Security Advisory 2の影響範囲を`< 0.4.0`から`< 0.4.1`に訂正(文案)

### B5. ローカル参照によるスキャン範囲外の読み込みの監査(2026-10-07、osv-scanner v2.4.0)

requirements.txtの取り込み・親POMと同じ種類の問題(osv-scannerがファイル内のローカル参照をたどり、範囲外を読む)が他の形式にないか、v0.4.0の公開前に実機で監査した。範囲外のディレクトリに各形式のマニフェスト(npm: `lodash@4.17.20`、Python: `Jinja2==2.0`、Maven: `log4j-core@2.14.1`)を置き、それが結果に現れるかで判定(`--data-source deps.dev`の既定と`--no-resolve`の両方)。

| 形式 | ローカル参照 | 範囲外の読み込み |
|---|---|---|
| package-lock.json | `link: true`、`file:`(resolved) | なし |
| yarn.lock | `file:`、`link:` | なし |
| pnpm-lock.yaml | `link:`、`file:`(directory)、範囲外のimporter | なし |
| bun.lock | `file:`、範囲外のworkspace | なし |
| poetry.lock | `source.type = "directory"` | なし |
| uv.lock | `directory`、`editable` | なし |
| Pipfile.lock | `path`、`editable` | なし |
| pdm.lock | `path` | なし |
| go.mod | `replace => ../path` | なし(パス名がパッケージ名として出るだけ) |
| pom.xml | `<modules>`、`file://`のリポジトリ(Maven構成を配置)、BOMの`scope=import` | なし |
| requirements.txt | `-r`(相対パス) | **あり**(v0.3.4で元ファイルを渡さない方式、v0.4.0で専用コピー方式で対処) |
| pom.xml | `<parent><relativePath>` | **あり**(v0.4.0で許可ルートの検証で対処。`<packaging>pom</packaging>`の親だけが読まれる) |

- 陽性対照: 同じ判定方法で、requirements.txtの`-r`と親POMの範囲外の読み込みを検出できることを確認
- 限界: 結果に影響しない読み込み(読んだが使わない)は検出できない(ファイル単位の監視は管理者権限が必要なため未実施)
- **osv-scannerのピン留めバージョンを更新するときは、この監査と、requirements.txtの取り込み・親POMの解釈(名前空間・重複・改行等)の実機確認をやり直すこと**

### B6. 検査と読み込みの不一致・繰り返し解析・名前付きパイプ(v0.4.1、2026-10-07)

**指摘(v0.4.0公開後)**:
1. 検査と読み込みの間にファイルを差し替えると、範囲外の内容を返せる(本サーバーは検査するだけで、osv-scannerには元のファイルを渡していた。lockfile・pom.xmlと親POM・JAR/WAR。requirements.txtの解析とSBOMもパスの解決と読み込みの間に隙があった)
2. workspaceの収録確認で、package.jsonの数だけ同じlockfile(最大64MiB)を読み直して解析していた(キャッシュも合計の上限も無し)
3. 親POMが名前付きパイプ(FIFO)を参照すると、`stat`の後の`readFile`で処理が止まる(requirements.txtの取り込み先も同じ)

**対応(スナップショット方式)**:
- `src/utils/safeRead.ts`: `O_NOFOLLOW`・`O_NONBLOCK`で開いて`fstat`で通常のファイルか確認、上限付きで読み、読み終えた後にパスを解決し直して境界の内側かつ開いた実体と同じ(dev・inode一致)かを確認。大きなJAR/WAR向けにストリーミングのコピーも提供。requirements.txtの解析・workspaceの収録確認・SBOMの読み込みもこれに統一
- `src/utils/scanSnapshot.ts`: osv-scannerには元のファイルを一切渡さず、安全に読んだ内容を専用の一時ディレクトリ(0700、終了時に削除)へコピーしてスキャンする。検査(親POMの検証)もコピーに対して行う。親POMは元の配置を一時ディレクトリ内に再現(`tree/<ルート>/<元の絶対パス>`)してコピーするため、osv-scannerが相対パスで親をたどっても見つかるのはコピーだけ。**解析がosv-scannerと多少ずれても範囲外は読まれず、最悪でも親が見つからないだけ**になり、レビュー指摘が続いた「解析の不一致が迂回になる」構造を解消
- 設計時に判明した追加の論点: 一時ディレクトリ内の配置は元より深いため、`..`を重ねた参照は一時ディレクトリを抜けて本物のファイルシステムに届く(コピーではなく元のファイルが読まれ、差し替えの隙が戻る)。参照先をGoの`filepath.Join`と同じ規則(Nodeの`path.join`)で一時ディレクトリ内で解決し、外に出る場合は除外
- 解析の繰り返し: workspaceの収録確認はlockfileごとに1回だけ解析して使い回し(合計256MiBまで)、requirements.txtは共通の取り込み先を1回だけ読む(合計64MiBまで)、親POMの解析もファイルごとに1回。コピーの合計は2GiBまで(超えると`scan_input_too_large`)
- 応答には一時ディレクトリのパスを出さない(`source_files`・JAR/WARのパスは元のファイルに戻す)
- 回帰テスト: FIFOで止まらないこと(時間制限付き)、差し替えの検出(dev・inodeの不一致)、途中のディレクトリのシンボリックリンク、`..`による一時ディレクトリの外への参照、合計サイズの上限、ツール単位で「起動時に元のファイルを範囲外の内容に差し替える偽スキャナー」でも結果に影響しないこと、lockfileを1回だけ解析すること(約10.4MBのlockfileと1500件のpackage.jsonで356ms。修正前は1500回の解析)
- 実バイナリでMCP経由の確認: 許可ルート内の親POMを持つサブモジュールは、一時ディレクトリ内に再現した親から依存を引き継いで従来どおり検出。範囲外の親は除外。複数言語・JAR/WAR・suggest_fixも従来どおり。実行後に一時ディレクトリが残らない

### B7. 強制終了時に一時ディレクトリ(元のファイルのコピー)が残る(2026-10-08)

**事象(2026-10-07 実機確認)**: scan_projectの実行中にサーバーへSIGTERM(`child.kill()`)を送ると、package-lock.json・go.mod・生成したrequirementsのコピーを含む`osv-mcp-snap-*`が一時ディレクトリに残った。スナップショットの削除は`finally`だけで、シグナルハンドラが無かった(シグナルの既定動作で即終了し`finally`は実行されない)。osv-scannerの子プロセスも親の終了後に残り得た。MCPクライアントはstdinを閉じるかSIGTERMでサーバーを止めることが多い。

**対応(`src/utils/processCleanup.ts`)**:
- [x] 作成中の一時ディレクトリ(`osv-mcp-snap-*`・`osv-mcp-sbom-*`)と実行中のosv-scannerを登録し、終了時に同期的に片付ける(`fs.rmSync`・子プロセスへSIGKILL)。登録は`mkdtemp`/`spawn`の直後の同じ同期処理内で行うため、その間にシグナルの処理は割り込まない
- [x] SIGTERM/SIGINT/SIGHUP: 後始末して128+シグナル番号(143/130/129)で終了。stdinの`end`/`close`(クライアントがトランスポートを閉じた): 後始末して0で終了(応答の送り先が無いため実行中のスキャンは待たない)。`process.exit`・未捕捉例外は`exit`イベントで後始末
- [x] 起動時に前回の異常終了(SIGKILL・電源断等)の残骸を削除。対象は「名前が`osv-mcp-(snap|sbom)-`+mkdtempの6文字に完全一致」「`lstat`で実体のディレクトリ(シンボリックリンクはたどらない)」「所有者が自分」「最終更新から24時間以上」をすべて満たすものだけ。24時間は別のサーバープロセス(複数クライアント・スリープ明け)が使用中のものを消さないための余裕(消すと親POMが欠けたまま黙ってスキャンされ得る)。getuidの無いWindowsでは行わない。起動は待たない
- [x] テスト: 単体(登録・削除・SIGKILL、残骸の判定条件・シンボリックリンク・所有者)と、ビルドしたサーバーを起動し遅いスキャナーでscan_project中にSIGTERM/SIGINT/SIGHUP・stdin終了を送ってスナップショットとスキャナーが残らないことの確認(`src/test/server/shutdown.test.ts`。ハンドラを外すと全件失敗することを確認済み)

**残課題**:
- [ ] SIGKILL・OOM killer等の捕捉できない終了では残る(次回起動時の掃除まで、最長24時間+次の起動まで)。一時ディレクトリ自体は0700のため他ユーザーからは読めない
- [ ] Windowsではシグナルの扱いが異なり(SIGTERMは捕捉不可)、起動時の掃除も行わない。Windowsでの実機確認は未実施
- [x] テストの後始末漏れ: `src/test/osv/binaryDownloader.test.ts`の`osv-mcp-dl-404-*`・`osv-mcp-dl-net-*`がテスト実行ごとに一時ディレクトリへ残る(2026-10-08時点で各114件。サーバー本体ではなくテストの問題) → 修正済み(2026-10-08)。HTTPエラー・ネットワークエラーのテストのキャッシュを、afterAllで削除する共有のcacheDir配下に作る。残っていた312件(空のv2.4.0ディレクトリのみ)を削除

### B8. 英語化(2026-10-08)

- [x] README・ツールの説明・応答の文言(注記・案内・警告・エラーメッセージ・stderr)を英語にした。応答のフィールド名・列挙値は従来から英語。コードのコメント・設計メモ(このファイル)・テスト名は日本語のまま
- 文中に埋め込む読み込み失敗の理由(safeReadのMESSAGES)は小文字で始め、単独の理由として示すときだけ先頭を大文字にする(`capitalizeReason`)

### B3. 既存の未完了項目

- [x] JAR実体スキャン: 実プロジェクトのfat JAR・shaded JARでの実機検証(上記「JAR実体スキャン」節の残タスク) → 検証済み(上記「B3 詳細設計メモ」、2026-10-08)。推測の座標の区別と、`affected_versions`の応答からの除外を実装(v0.10.0)
- [x] 権限の最小化: MCPサーバープロセスに必要以上のファイルシステム権限を与えない(上記「セキュリティ考慮事項」節) → 実装済み(上記「B3 詳細設計メモ」、v0.10.0)。Nodeの権限モデルでの動作、`permission_denied`、起動時の警告、READMEの「権限を絞って起動する」。E2Eテスト(`src/test/server/permission.test.ts`)で、許可内のスキャンの成功・許可外のパスとOSV_SCANNER_PATHの拒否の表示・欠けた許可の警告を確認。実装中に、OSV_SCANNER_PATHの読み取りの拒否が`binary_not_found`になる箇所も見つけて修正
  - (レビュー指摘)`scan_java_artifact`・`scan_sbom`の入力パスの解決とSBOMの読み込みで、権限モデルの拒否を`project_not_found`・`sbom_not_found`に変換していた。各所で拒否を保持して`permission_denied`にし、E2Eの回帰テストを追加。あわせて、ディレクトリ探索で権限モデルに拒否されたディレクトリを黙って飛ばしていた箇所もエラーにした
  - (レビュー指摘)推測の座標だけのアーカイブでも、脆弱性が見つかると`identified_with_vulnerabilities`になり`jars_identified`に数えていた。同定の確度と検出件数を分け、脆弱性の有無に関係なく`inferred_only`にする(件数は`identified_vulnerability_count`に示す)
