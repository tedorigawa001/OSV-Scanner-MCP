# Gradle Stage A/B・C1a 実装・実接続検証

検証日: 2026-10-31。リリース・コミットは今回の作業に含めない。

## 実装範囲

- 明示実行するinit scriptを`gradle/export-dependency-graph.init.gradle`へ追加し、npm配布にも同梱。
- スキャン中にはGradle／Wrapper／JVMを起動せず、検出済みlockのスナップショットとJSON companionを共通処理で取り込む。
- selected component・variant単位の非constraint辺からdirect/transitive・introduced_byを生成。configuration間・lock間の完全性を最終出力まで保持。
- lock hash・既知input hash・project/configuration/scope対応を検証。古い／不正なJSONだけではcoverageを下げず、有効なcontextのlock外module・未解決要求・file依存を欠けとして報告。
- JSON／lockの関係解析は各16 MiB/件・64 MiB/scan、inputは4 MiB/件・64 MiB/scan。JSONの重複key・深さ128・schema・ID参照を検証し、index/traversal各200万操作を共有。
- Stage A/BではownerBuildFileを物理宣言元とみなさず、declared_inを省略する。C1aの明示登録・信頼設定による宣言元対応と実接続結果は後述。

## Stage A: 実Gradleのexport

配布物の公式SHA-256を確認し、一時領域のJDK 21.0.13で検証した。既存のシステムJavaはこのMacで起動できなかったため変更せず、一時領域のARM版JDKを使用。

| 組合せ | 結果 |
|---|---|
| Gradle 8.11.1 + Groovy DSL | 通常の4 classpathと、全resolvable configuration指定のexportに成功 |
| Gradle 9.2.1 + Kotlin DSL | 全resolvable configuration指定のexportに成功 |
| Gradle 8.11.1 + java-test-fixtures／BOM／force／project substitution | variant別exportと静的取込に成功 |

9.xでは廃止されたBuildIdentifier.currentBuildを使わず、8.2以降の公開buildPathでbuildを区別する。external variantへのbridgeや未対応identityは完全なグラフとして扱わない。

variant検証では、`:lib`のmain／test-fixtureを別variantとして保持。`acme:local:1.0`のproject置換を外部moduleへ変換しないこと、force後のcommons-io 2.6で対応付くこと、JUnit BOMのconstraintがJUnit APIの導入元にならないことを確認。実exportの一部を`src/test/fixtures/gradle-variants.json`と`.lock`へ保存し、回帰テストに使用する。この確認は複数project全般の対応保証ではない。

## Stage B: 3ツールからOSVへの実接続

自作検証projectの宣言:

```groovy
plugins { id 'java-library' }
repositories { mavenCentral() }
dependencyLocking { lockAllConfigurations() }
dependencies {
    implementation 'org.apache.logging.log4j:log4j-core:2.14.1'
    implementation 'com.fasterxml.jackson.core:jackson-databind:2.9.10.7'
}
```

信頼済み環境で先に`dependencies --write-locks`を実行。その後init scriptの`osvMcpExportDependencies '-PosvMcpConfigurations=*' --no-configuration-cache`でcompanionを生成した。Kotlin DSLでも同じ依存宣言を使用。

MCPのstdio接続で`scan_project`・`scan_java_project`・`suggest_fix`を呼び出し、実OSV-Scanner 2.7.0とapi.osv.devへの照会を確認。Groovy／Kotlin両projectで同じ判定となり、coverage.complete=true、relations_complete=trueだった。

| パッケージ | 使用版 | 関係 | introduced_by | 提案版 | 候補のOSV再照会 |
|---|---|---|---|---|---|
| org.apache.logging.log4j:log4j-core | 2.14.1 | direct | 省略 | 2.25.4 | clean |
| org.apache.logging.log4j:log4j-api | 2.14.1 | transitive | org.apache.logging.log4j:log4j-core | 2.25.5 | clean |
| com.fasterxml.jackson.core:jackson-databind | 2.9.10.7 | direct | 省略 | 2.18.11 | clean |
| com.fasterxml.jackson.core:jackson-core | 2.9.10 | transitive | com.fasterxml.jackson.core:jackson-databind | 2.18.11 | clean |

提案版は検証時点のOSV応答であり、将来の固定期待値にはしない。Gradle-onlyの更新案内にpom.xmlが含まれないこと、declared_inが生成されないこと、元lockが変わらないことも確認した。

追加の実接続条件:

- 古いlock hashのJSONにlock外moduleを追加しても、3ツールとも由来はunknown、coverage.complete=trueを維持。
- 現在のlock hashに一致するJSONにlock外moduleを追加すると、3ツールともcoverage.complete=false、skipped_filesへgraph_modules_missing_from_lockを記録。graph-only module自体は追加照会しない。
- MCPのPATHに失敗する偽java／gradleを配置し、projectにも失敗する偽Wrapperを配置。スキャンが成功し、起動を示すmarkerがないことを確認。

一時領域の生応答・要約は`/private/tmp/osv-gradle-evidence/`へ保存（ローカル検証用であり配布物には含めない）。陽性は`final-groovy/`・`kotlin-9/`、陰性は`stale/`・`graph-gap/`、variant確認は`variant-validation.json`。

## 回帰テスト

- 実依存／lock constraintの分離、複数起点・cycle・direct優先、正確なGAV一致、実variantの分離。
- 重複JSON key、過深度、不正なID参照、symlink、子の探索境界、context不足、予算超過。
- 古いlock/input hashとcoverage、有効・無効contextの混在で有効な欠けを保持すること。
- lock間の不完全なintroduced_by・declared_inの抑制と入力順独立性、2種類の完全性の独立した併合。
- 3ツールでの共通判定、Maven/Gradle混在の更新案内、内部情報の非出力、スキャン中の元lock／JSON差し替え。

Stage A/B初回の検証結果: 全65ファイル・1,409テストが通過。typecheck・build・差分の空白チェックも成功。npm packのdry-runでexporterの同梱と、検証fixture／無関係な文書が配布対象外であることを確認した。

## レビュー修正: 評価前の入力hash捕捉

評価後のexportタスク内でinput hashを作ると、先行タスクが書き換えたbuild.gradleのhashと、既に評価済みの古い宣言のグラフを結び付けてしまう問題を修正した。

- `beforeSettings`でsettings／properties／既定catalog候補を捕捉。
- `projectsLoaded`で全projectのbuild fileを、どのprojectも評価されていない時点で捕捉。rootが子のファイルを書き換える場合も検出する。
- 未存在の既知候補も状態を保持し、評価中の生成・削除を検出。
- export開始時とグラフ解決後に比較し、差があれば既存companionを上書きせず失敗。別の実行で更新後の宣言を評価し直せば正常exportできる。

実Gradleの回帰テストを`src/test/gradle/exporter.integration.test.ts`に追加した。先行タスクの直接依存追加、評価中のbuild/settings変更、未存在入力の生成、rootによる子build変更、解決中の変更、通常export、Kotlinの通常／変更ケースを検証する。修正を遅いhash捕捉へ戻した一時scriptでは、依頼された先行タスク・評価中変更の2件が失敗することも確認した。

このテストは実Gradleを使うため、`OSV_MCP_TEST_GRADLE`を明示した場合だけ実行する。GradleやJDKを自動取得せず、ローカルに生成するMaven POMだけを`--offline`で解決する（外部依存やJARのダウンロードは不要）。実行例:

```sh
OSV_MCP_TEST_GRADLE=/absolute/path/to/gradle \
JAVA_HOME=/absolute/path/to/jdk \
GRADLE_USER_HOME=/absolute/path/to/test-cache \
npm test -- src/test/gradle/exporter.integration.test.ts
```

修正後の検証: Gradle 8.11.1の実回帰9件を含む全66ファイル・1,418テストが通過。Gradle 9.2.1でも実回帰9件が通過した（両版ともJDK 21、Groovy／Kotlin）。typecheck・build・空白チェックも成功。

## 導入元探索の効率化・性能比較(2026-10-31)

直接起点ごとのBFSで共有グラフを繰り返し訪問していた処理を効率化した。variantごとの非constraintグラフを反復型KosarajuでSCCへ縮約し、DAG上で起点集合を共有伝播する。GAV識別子もcomponentごとに再利用する。起点集合は非ゼロの32起点単位のwordだけを保持し、独立した大量の起点に全幅bitsetを確保しない。起点が4つ以下、または共有targetがないグラフでは軽い個別探索を維持する。その他もまず有用な個別探索を行い、起点間の再訪variant数と同一起点内の重複したqueue処理数が、それぞれ到達variant数を超えた場合だけSCCへ切り替える。共有辺の存在だけでは全体をSCC化しない。切替前の部分結果は破棄し、探索済みの作業は同じ予算に計上したままとする。

project-only経路の不完全性、GAVによる自己由来除外、variant分離、constraint除外、context間の独立性は維持する。導入元を出せない不完全contextは、直接依存の証拠だけを返して由来探索を省略する。

index／traversalのscan共有200万予算は変更しない。縮約・word伝播・結果の各起点への展開も予算へ課金する。大きな出力で予算を超えれば従来どおりlookupを不採用とし、部分的な導入元を完全な一覧として返さない。SCCによっても出力自体に必要な起点×moduleの容量は消えない。

計測環境: Apple M4 / darwin arm64 / Node v26.12.1。比較元は`3aa18e6`から修正前にbuildして保存した解析器。同じ生成グラフを両実装へ渡し、全moduleの関係・導入元・完全性と診断の一致を先に検証した。JSON読込・構文検証・結果比較は時間から除外し、analyzeGradleContextの対象context合計を測定。ウォームアップ後、実装の実行順を交代しながら7回計測した中央値を示す。時間の閾値は回帰テストの合否に使わない。

操作数は上限を十分大きくした場合の全contextの論理的な予算消費。完全context数は通常のscan共有200万予算での結果。共有の少ないケースは8 context×3文書=24件、その他は3件を対象とする。

| ケース | 起点 / module | 旧 → 新の中央値(ms) | 旧 → 新の操作数 | 完全context数: 旧 → 新 |
|---|---|---|---|---|
| 共有・小 | 40 / 150 | 2.943 → 1.166 | 54,900 → 32,772 | 3 → 3 |
| 共有・中 | 100 / 600 | 31.507 → 9.665 | 610,740 → 249,492 | 3 → 3 |
| 共有・大 | 200 / 1200 | 129.356 → 31.549 | 2,421,540 → 844,302 | 2 → 3 |
| 共有・循環 | 200 / 1200 | 129.128 → 27.797 | 2,422,146 → 745,569 | 2 → 3 |
| 単一起点 | 1 / 1200 | 2.200 → 2.195 | 43,092 → 43,092 | 3 → 3 |
| 独立した木 | 400 / 1200 | 2.121 → 1.888 | 10,800 → 10,800 | 3 → 3 |
| 共有辺1本の大きな木（24 context） | 400 / 6000 | 116.073 → 109.441 | 432,408 → 432,408 | 24 → 24 |

共有・大は約4倍に短縮し、予算消費を約65%削減した。通常予算で旧実装は3つ目のcontextが失敗し、新実装は3つとも完全な導入元を保持した。単一起点・独立した木では予算消費は同じだった。1ms未満の微小な時間差は実行条件の影響を受ける。全グラフで同じ速度向上を保証する結果ではない。最小・最大時間を含む[生データ](benchmarks/gradle-origins-2026-10-31.json)も保存した。

レビューで指摘された低共有の条件は、400本の独立した鎖・6,000 moduleに`v0→v1`の辺を1本追加したもの。8 contextを含むJSONを3文書として同じscan予算で処理する。1文書9,986,100 bytes、合計29,958,300 bytesで、それぞれ16 MiB／64 MiBの取込上限内である。

| 低共有ケースの実装 | 中央値(ms) | 全24 contextの操作数 | 通常予算で完全なcontext |
|---|---:|---:|---:|
| 最初の個別BFS | 116.073 | 432,408 | 24/24 |
| レビュー時の一律SCC切替 | 144.282 | 2,256,552 | 21/24 |
| 修正後の適応切替 | 109.441 | 432,408 | 24/24 |

修正後は低共有ケースを個別探索で完了し、レビュー時に比べ予算消費を約81%削減した。比較元・レビュー時・修正後の全moduleの判定・由来・完全性が、十分な予算では一致することも確認した。

回帰条件:

- 200起点／1,200 module／3 contextで完全な導入元を保持し、3ツールの10件上限・omitted=190も一致。
- 400起点／6,000 module／8 context×3文書の低共有ケースで、予算消費50万未満・全24件を完了。3ツールでも3文書のmetadataと推移的依存・introduced_byを保持。
- 起点間の再訪だけが多い共有chain、同一起点内の重複だけが多い独立diamondでも、軽い探索を維持する。切替前のprobeで予算超過した場合も部分一覧を返さない。
- 40個の決定的な生成グラフを独立した単純探索と照合。循環、同一moduleの別variant、project経由、rootとの循環、重複辺、constraintを含む。
- 15,000 moduleの共有循環を再帰なしで処理。
- 解決不完全なcontextが不要な探索で予算を消費せず、直接依存の証拠とcoverageの欠けを維持。
- 低い予算で共有伝播／結果展開を止め、部分的な由来を返さない。

最終検証: 実Gradleの回帰9件・性能比較テストを含む全68ファイル／1,446テストが通過。typecheck・build・空白チェックも成功。

性能比較の再実行: 比較元revisionを別checkoutでbuildし、`dist/utils/gradleGraph.js`を現在のcheckoutの`node_modules/.cache/gradle-origin-baseline/before.mjs`等へ保存する（既存のzod／jsonc-parserを解決できる位置に置く）。そのうえで次を実行する。レビュー時のSCC版も比較する場合は`gradleGraph.js`とその隣の`gradleOrigins.js`を同じフォルダーに保存し、`OSV_MCP_GRADLE_REVIEWED`を指定する。この指定は任意。比較用ファイルはサーバーから実行されず、明示した開発テストだけが読み込む。

```sh
OSV_MCP_GRADLE_BASELINE=/absolute/path/to/before.mjs \
OSV_MCP_GRADLE_REVIEWED=/absolute/path/to/reviewed/gradleGraph.js \
OSV_MCP_GRADLE_BENCH_OUTPUT=/absolute/path/to/comparison.json \
npm test -- src/test/benchmarks/gradleOrigins.test.ts
```

## Stage C1a: 本番adapter・静的取込の実接続（2026-10-31）

対象revisionは`71819b5534d5913910bbd77f1debec16479f85f2`。実行したadapter／exporter／readerのsource SHA-256、scannerのversion／SHA-256、生成した宣言・契約・lock、ツール別の結果と独立OSV照会の応答は[検証データ](validation/gradle-c1a-live-2026-10-31.json)に保存した。これは検証時点の結果であり、将来の推奨版や脆弱性件数の固定期待値ではない。

| 項目 | 実行条件 |
|---|---|
| Gradle／DSL | 8.11.1／Groovy、9.2.1／Kotlin |
| JVM | JDK 21.0.13+9（既存の検証用一時環境） |
| 外部scanner | OSV-Scanner 2.7.0、osv-scalibr 0.5.3 |
| 接続経路 | 実MCP stdio → dist/index.js → 実scanner。mock／fetch差替えなし |
| Gradle実行 | 自作projectでdependencies --write-locksを明示実行後、両init scriptでschema v2をexport。--offline・--no-configuration-cacheを指定 |
| 信頼契約 | registered-helper-v1、catalogPolicy=none、必要な全6 configurationをscopeへ収録 |
| OSV接続 | lockスキャンとcandidate check、さらに独立したPOST https://api.osv.dev/v1/query。manifestのremote resolutionは無効 |

### 検証projectと宣言元

通常のjava-library projectに、次の登録を置いた。Kotlin版も同じ構造で、ファイル名に`.kts`を付ける。

| 宣言場所 | configuration | パッケージ／使用版 |
|---|---|---|
| build.gradle | implementation | org.apache.logging.log4j:log4j-core:2.14.1 |
| gradle/extra.gradle（applied script） | runtimeOnly | 同じlog4j-core:2.14.1を別試行として登録 |
| gradle/extra.gradle | implementation | com.fasterxml.jackson.core:jackson-databind:2.9.10.7 |

これにより、異なるconfigurationの同値依存が解決graphでは合流しても、宣言元は二つとも必要になる。runtimeClasspathのexportにimplementation／runtimeOnly両試行があることを確認した。lockとv2 companionは各projectで新規生成し、既存のStage B検証projectは変更していない。

### 3ツールの実接続結果

両projectで、信頼設定あり／なし × scan_project・scan_java_project・suggest_fixの**計12呼出し**が成功した。全てcoverage.complete=true、relations_complete=true。各呼出しで4つの脆弱packageが応答に含まれた。

信頼設定あり:

- declarations_complete=true、trust_model=registered-helper-v1、trust_status=accepted。
- assurance=author-attested-and-structurally-checked。全6 configurationのcontext別状態もaccepted。
- limitationsにはunregistered_equal_additions_not_detectableとreverted_external_mutations_not_detectableを保持。
- log4j-coreのdeclared_inはbuild.gradleとgradle/extra.gradleの完全な集合。databindはgradle/extra.gradleのみ。Kotlin版は対応する`.gradle.kts`のpath。
- jackson-core／log4j-apiはtransitiveで宣言元を付けず、それぞれdatabind／log4j-coreをintroduced_byに表示。
- suggest_fixは全ての確定宣言元を更新案内に表示し、Gradle-onlyの提案へpom.xmlを混入しない。

信頼設定なし（別MCPサーバープロセスで環境変数を未設定）:

- declarations_complete=false、trust_status=disabled、assurance=null。全packageのdeclared_inを省略。
- 直接／推移的関係、introduced_by、スキャン対象packageと使用版、脆弱性coverageは維持。
- 3ツールとも同じ抑制となり、JSON自身の作者表明だけでは宣言元を採用しないことを確認した。

### 修正候補と独立したOSV再照会

以下はGroovy／Kotlin両projectで一致した**検証時点の提案**。ツール内のcandidate_checkは全てcleanであり、さらにハーネスから同じpackage／候補版を独立にPOST /v1/queryへ照会した。両project計8照会がHTTP 200、応答bodyは全て`{}`、next_page_tokenなし、vulnerability IDは0件だった。

| パッケージ | 使用版 | 関係 | 提案版 | ツール内検査／独立照会 |
|---|---|---|---|---|
| org.apache.logging.log4j:log4j-core | 2.14.1 | direct | 2.25.4 | clean／HTTP 200・0件 |
| org.apache.logging.log4j:log4j-api | 2.14.1 | transitive | 2.25.5 | clean／HTTP 200・0件 |
| com.fasterxml.jackson.core:jackson-databind | 2.9.10.7 | direct | 2.18.11 | clean／HTTP 200・0件 |
| com.fasterxml.jackson.core:jackson-core | 2.9.10 | transitive | 2.18.11 | clean／HTTP 200・0件 |

現在版の検出にはlog4j-coreのGHSA-jfh8-c2jp-5v3q等が含まれた。候補のcleanはOSVがその名前・版へ返した脆弱性情報の結果であり、Maven repositoryでのartifact存在、Java／variant互換性、ビルド・テスト成功を保証するものではない。今回は候補版への依存更新やrestore／compileは行っていない。

### 不変性・再実行

MCPのPATHに失敗する偽java／gradleを置き、projectには失敗する偽Wrapperを置いた。呼び出された場合に作るmarkerは全scenarioで存在しなかった。lock、companion、契約、settings、両宣言source、WrapperのSHA-256は3ツール実行前後で一致し、元ファイルの更新がないことを確認した。

明示実行専用の[再現ハーネス](../src/test/manual/gradleC1aLive.mjs)を追加した。通常のnpm testからは実行せず、scannerやGradleを自動取得しない。入力した信頼済み実行バイナリと、必要なMaven metadataを含むGradle cacheを使用する。fixtureと生応答は新しい一時領域へ保存し、その場所をstdoutに表示する。

```sh
bdo npm run build
bdo proxy env \
  JAVA_HOME=/trusted/jdk-21 \
  GRADLE_USER_HOME=/trusted/gradle-cache \
  OSV_MCP_LIVE_SCANNER=/trusted/osv-scanner \
  OSV_MCP_LIVE_GRADLE_8=/trusted/gradle-8.11.1/bin/gradle \
  OSV_MCP_LIVE_GRADLE_9=/trusted/gradle-9.2.1/bin/gradle \
  node src/test/manual/gradleC1aLive.mjs
```

今回の生応答とserver stderrは`/private/var/folders/s6/2sk4lqmn1_5dp8gdr0_lz1qw0000gn/T/osv-c1a-live-8jV02a/evidence/`へ保存。配布物へは含めない。ライブラリのコード変更はなく、手動ハーネスの構文検査・保存した結果の整合性・差分の空白チェックも確認した。

## 残る制約

C1bのProvider／catalog／bundle、convention pluginのsource-artifact対応、buildscript lock、composite/included build、独自lock path、Android固有構成などは引き続き未対応。C1aの物理宣言元は明示helperと作者表明の信頼契約に限定する。入力hashの一致だけでは環境変数・外部init script・remote plugin等を含む完全な鮮度は保証しない。artifact有無・Java/Android/variant互換性もOSVのclean判定とは別に確認が必要。
