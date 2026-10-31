# Gradle Stage A/B 実装・実接続検証

検証日: 2026-10-31。リリース・コミットは今回の作業に含めない。

## 実装範囲

- 明示実行するinit scriptを`gradle/export-dependency-graph.init.gradle`へ追加し、npm配布にも同梱。
- スキャン中にはGradle／Wrapper／JVMを起動せず、検出済みlockのスナップショットとJSON companionを共通処理で取り込む。
- selected component・variant単位の非constraint辺からdirect/transitive・introduced_byを生成。configuration間・lock間の完全性を最終出力まで保持。
- lock hash・既知input hash・project/configuration/scope対応を検証。古い／不正なJSONだけではcoverageを下げず、有効なcontextのlock外module・未解決要求・file依存を欠けとして報告。
- JSON／lockの関係解析は各16 MiB/件・64 MiB/scan、inputは4 MiB/件・64 MiB/scan。JSONの重複key・深さ128・schema・ID参照を検証し、index/traversal各200万操作を共有。
- source-mapはStage C。ownerBuildFileを物理宣言元とみなさず、declared_inを省略しdeclarations_complete=falseを返す。

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

## 残る制約

物理宣言元source-map、buildscript lock、composite/included build、独自lock path、Android固有構成などはStage C以降。入力hashの一致だけでは環境変数・外部init script・remote plugin等を含む完全な鮮度は保証しない。artifact有無・Java/Android/variant互換性もOSVのclean判定とは別に確認が必要。
