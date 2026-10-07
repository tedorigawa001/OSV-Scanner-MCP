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
- [ ] MCPサーバープロセスに必要以上のファイルシステム権限を与えない
- [ ] ネットワークアクセスはOSV-Scannerの照会先(OSV API等)に限定されることを明示し、README等でユーザーに透明性を提供 → 2026-10-07の実機確認でpom.xml/requirements.txtのスキャンはdeps.devにも接続すると判明。バックログB1で対応

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
- [ ] 実プロジェクトのfat JAR(Spring Boot等)・shaded JARでの実機検証

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
- [ ] テストの後始末漏れ: `src/test/osv/binaryDownloader.test.ts`の`osv-mcp-dl-404-*`・`osv-mcp-dl-net-*`がテスト実行ごとに一時ディレクトリへ残る(2026-10-08時点で各114件。サーバー本体ではなくテストの問題)

### B3. 既存の未完了項目

- [ ] JAR実体スキャン: 実プロジェクトのfat JAR・shaded JARでの実機検証(上記「JAR実体スキャン」節の残タスク) → 検証計画作成済み(上記「B3 詳細設計メモ」、2026-10-08)
- [ ] 権限の最小化: MCPサーバープロセスに必要以上のファイルシステム権限を与えない(上記「セキュリティ考慮事項」節) → 詳細設計メモ作成済み(上記「B3 詳細設計メモ」、2026-10-08)
