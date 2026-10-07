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
- [ ] v0.5.0: suggest_fixのnpm/Go対応(semver比較、`SEMVER`範囲の検証、0.x系のマイナー更新を破壊的変更として扱う、Goのv2以上はモジュールパス変更を注記)
- [ ] v0.6.0: suggest_fixのPython対応(PEP 440比較、`ECOSYSTEM`範囲がある場合の`GIT`範囲の無視)、直接/推移的依存の区別(npmの`overrides`はルートプロジェクトでのみ有効な点を推奨文に反映)
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

### B3. 既存の未完了項目

- [ ] JAR実体スキャン: 実プロジェクトのfat JAR・shaded JARでの実機検証(上記「JAR実体スキャン」節の残タスク)
- [ ] 権限の最小化: MCPサーバープロセスに必要以上のファイルシステム権限を与えない(上記「セキュリティ考慮事項」節)
