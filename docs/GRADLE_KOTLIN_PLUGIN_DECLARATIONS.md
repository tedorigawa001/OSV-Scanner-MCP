# Gradle precompiled Kotlin／標準kotlin-dslの宣言元登録

設計・公開API実証日: 2026-11-01。基準revision: cc40e4c（7ef3922からの差分は文書の修正のみ）。本書は本番対応を拡張する前の設計とtest-only実証である。既存のcontract v3／graph v3／adapter v5と、本番のKotlin未対応判定は変更しない。従来の明示JavaExec `compileProofKotlin`と、標準Kotlin Gradle pluginのcompileを区別する。

## 1. 対象と完了条件

- consumer Groovy／Kotlin × Gradle 8.11.1／9.2.1 × producer buildSrc／独立included build × binary Kotlin／precompiled Kotlin、計16構成を対象とする。
- producerはboundary内のroot project `:`。両方式ともproducerのbuild.gradle.ktsで標準の`kotlin-dsl`を適用する。precompiledは`.gradle.kts`、binaryは`Plugin<Project>`の`.kt`を使う。consumerのDSLがKotlinというだけではこの条件を満たさない。
- 実証artifactはJAR。directoryの本番対応、producer子project、外部配布plugin、plugin ID alias、settings／init plugin、plugin間委譲・内部catalogはこの実証へ含めない。
- 公開Plugin実体・descriptor・同一invocationの構築JAR・公開CodeSource元の全JAR内容を結び、追加信頼下の採用候補を示す。実行中の変換済みclass bytesを独立観測した証拠にはしない。

Gradle公式文書ではprecompiled scriptのIDをファイル名・packageから導出し、buildSrc／included buildへ配置する。kotlin-dslはGradle版と対応するplugin版を使う。[precompiled script](https://docs.gradle.org/current/userguide/implementing_gradle_plugins_precompiled.html)、[Kotlin DSL primer](https://docs.gradle.org/current/userguide/kotlin_dsl.html)。本実証では実際に解決したartifact版を記録し、最新版を推測しない。

## 2. 宣言元と二段階登録の契約

binaryはapply内でbeginPlugin(specId, this)、precompiledはbeginPrecompiled(specId)を使う。後者でscriptのthisを渡さない。plugin ID適用前に公開withPlugin observerを登録し、適用完了後のfindPluginで得た実Pluginをpending sessionへ結ぶ。precompiledの生成class名をfilenameから推測して確定せず、構築JARのdescriptorと実classを照合する。

物理sourceから生成adapterへの対応は作者manifestへ明示する。declared_inは元のsrc/main/kotlin/*.gradle.ktsまたは*.ktで、build/generated以下、descriptor、consumerのplugins blockへの置き換えは行わない。consumer scriptにも同じGAVの追加があれば両物理sourceを保持する。

scope・sourceMapping・application・同期追加／Provider追加の双方向被覆は既存と同じ。遅いbegin、未終了、failed、重複begin（先行終了後も含む）、未知handle、出自・record IDの不整合は宣言一覧全体を不完全とする。登録不足だけなら検証済みrelation／introduced_byは保持する。

## 3. 公開APIで取得する構築証拠

KotlinCompileはGradleのAbstractCompileとして捕捉できるとは限らない。標準Kotlin compileへ従来のtask名compileProofKotlinを代用しない。

| 段階 | 実証で観測する公開情報 | 必須の対応 |
| --- | --- | --- |
| plugins block抽出 | Task.inputs／outputs | 元scriptと抽出出力 |
| 外部plugin spec生成 | Task.inputs／outputs | 承認classpathと生成source |
| plugins block compile | Task.inputs／outputs | 抽出source／specと生成class |
| accessor生成 | Task.inputs／outputs | 元script・plugins block classと生成source／metadata |
| adapter生成 | Task.inputs／outputs | 元scriptと生成Plugin adapter source |
| Kotlin compile | KotlinCompile.libraries、公開kotlinCompilerClasspath構成、Task.inputs／outputs | 元source・生成adapterのhashとcompile出力 |
| descriptor／resource／JAR | 公開Task.inputs／outputs、Jar.archiveFile | descriptor、compile出力、最終artifact |
| plugin適用・ロード元 | withPlugin、findPlugin、Class／ProtectionDomain／CodeSource | descriptorの実装class、実Plugin、構築artifact、runtime snapshot |

実証では内部precompiled task classをimport／castしない。公開Task APIを使い、観測した既知task名を役割へ対応付ける。名前が同じというだけで本番で任意taskをcompilerとして信頼しない。Kotlinの公開compile APIについては[compiler options文書](https://kotlinlang.org/docs/gradle-compiler-options.html)も参照する。

Task.inputsには元libraryだけでなくGradle cacheのclasspath snapshotなどの派生入力も現れる。librariesと同一bytesとして照合してはならない。実証のexternalInputObservationsはこれらをderived-or-unapproved-task-inputとして別記録する。この棚卸しは事後観測で、compilerがそのbytesを実際に消費したことや、内部変換の完全性の独立証明ではない。

## 4. toolchain・変換の信頼と責任分離

作者はproducerのsettings／build、物理source、resource、独自dependency・processor・生成入力を列挙する。利用者はGradle、kotlin-dsl plugin、Kotlin Gradle plugin、compiler・標準library・compiler依存、実JDKを確認してprofileを承認する。plugin固有dependencyを大きいという理由だけでtoolchainへ移さない。

実証profileは選択したGradle配布物、生成gradle-api、明示したKotlin ecosystemのcache JAR、JDKのjava／modules／releaseをhash化する。実行後も再hashし、公開java.homeとjava.runtime.versionを選択JDKと照合する。Kotlin compiler classpathとlibrariesは承認済み実fileへ対応付ける。未対応のclasspathは黙って除外しない。compiler daemon、独自compiler plugin、KAPT／KSP、追加transform・agentは今回の範囲外。

本番案では既存toolchain／loader信頼に加え、標準Kotlin構築pipelineへの明示opt-inを独立させる。提案設定はOSV_MCP_GRADLE_KOTLIN_PIPELINE_TRUST=registered-kotlin-dsl-build-v1とOSV_MCP_GRADLE_KOTLIN_PIPELINE_PROFILES。起動時固定のallowlistとし、graph由来のdigestを自己承認しない。名前とschemaは将来案で、今回は設定を実装しない。

実証profileのdigestは既存test-only proofDigest（JSON.stringifyのbyte列）を使う。本番pluginProfileDigestのkey整列方式とは異なる。本番schema案では既存のcanonical digestを維持し、test-only digestをそのまま本番allowlistへ流用しない。

pipeline profileはtoolchainProfileDigest、Gradle／kotlin-dsl／KGP版、対応するplugin・compiler artifactのentry ID、stage roleと許可した公開入力経路、compiler実行方式、cache／parallel設定を持つ。作者manifestはsource→generated adapter→compile→packageのmappingと、列挙していない構築入力がないことを表明する。派生classpath snapshotの対応は承認したGradle／KGP経路への表明として扱い、hash一致だけで独立検証済みにしない。追加信頼なしではsource一覧を採用しない。

既存approved-gradle-loader-v1は実行時ロード／変換の契約であり、Kotlin構築pipelineの信頼を暗黙に兼ねない。prepared-output-only-v1をloader-attestedへ自動変更せず、未確認変換のある実runtimeはstrictで引き続き拒否する。

## 5. 本番入出力案・完全性判定

既存schemaへ黙ってfieldを追加せず、将来contract v4／graph v4／adapter v6としてstrictに版管理する案とする。

- producer.buildMethod=standard-kotlin-dsl-v1、sourceMappingsのkind=binary-kotlin／precompiled-kotlin、pipelineProfileDigest、物理sourcePaths、生成adapterに対応する明示mapping IDを入力に追加する。パスはboundary相対、sourceとproducerを混同しない。
- exportはstage receiptにproducer／invocation／task／role、実行状態、物理入力hash、生成入力・出力の完全集合、libraries、compilerClasspath、派生入力の種別・hash・表明を保持する。task自身の出力だけを記録する。
- generation receiptは元sourceのhashに結び、compile receiptは同じgenerated adapterのhashに結ぶ。Kotlin出力rootの全fileをpackage入力とJARの同名entryへhash照合し、classの集合も完全一致させる。descriptorが指す実装classはcompile出力・JAR entry・ロード元classの三者でhashを一致させ、archive pathとJAR全体hashも同じpackage receiptへ束縛する。実Plugin／CodeSource／runtime snapshotは既存規則で照合する。生成class名の一致だけでは採用しない。
- JARの全entry（class以外のdescriptor、resource、MANIFEST、kotlin_module等を含む）を、記録したstage出力（pluginDescriptors、processResources、compile等）とpackage入力へ対応付け、どのstageにも由来しないentryがあれば拒否する。今回の実証はclassだけを照合しており、これは本番化で実装する。
- source／toolchain／生成物／構築artifact／snapshotの欠落・改変・別invocation・別producerとの混同はgraph採用を拒否する。pipelineの信頼無効／profile未承認は宣言元だけを省略する。
- cache hit／up-to-date／no-sourceで実行証拠がない段階を今回の成功receiptへ昇格させない。再利用receiptの鮮度契約は別設計とし、初期は明示再構築を要求する。
- declared_inは全contributing contextの完全性AND。同じGAVのscript側だけや、他contextの一部sourceだけを返さない。pluginを使わないscopeへ追加信頼を要求しない。

metadata案はkotlin_pipeline_trust_status、pipeline profile ID、source／generated lineage状態、compiler方式、既存plugin source_artifact_status／transform_status／comparisonと組み合わせる。limitationsにkotlin_build_pipeline_author_attested、kotlin_derived_classpath_inputs_not_independently_bound、plugin_classpath_transient_changes_not_detectableを明示する。実証用assessKotlinStagesのcompleteは限定したsource→adapter→compile manifestの整合性であり、この本番全体の完全性や派生入力の検証完了を意味しない。

## 6. 実証ハーネスと回帰条件

src/test/gradle/kotlinPlugin.integration.test.tsとtest-only init script gradle-kotlin-plugin.init.gradleを使用する。本番init script、MCPの取込／trust設定は変更しない。各fixtureにplain／control／registered、script-only、late／unfinished／failed／duplicate／duplicateClosedのsubprojectを設ける。

実証ledgerのbridgeはpluginSource(instance, pluginId, sourcePath)／beginPrecompiled(pluginId, sourcePath)と終了tokenを使う既存のtest-only APIで、本番のspec ID・session・pluginSource(session, mappingId)をそのまま実行したものではない。公開Gradle APIによる実体対応と登録挙動の成立性を調べる。本番helper・schemaへの移植とその回帰は次段階である。

| 条件 | 期待 |
| --- | --- |
| binary this、precompiled pending | 適用後の実Pluginとdescriptorへ結ぶ |
| 同値のscript／plugin追加 | 別recordを保ち、両sourceを返す候補 |
| 同期Action、使用／未使用Provider | plain／control／registeredでgraph・trace・評価回数一致、未使用0回 |
| late／未終了／failed／重複begin | 構築証拠を保持し、宣言一覧全体を省略 |
| helper・loader信頼無効／旧trust／profile不足 | 追加信頼の採用条件を満たさない |
| compile／class／package欠落、別producer、source変更、compile後のclass差し替え | stage完全性を拒否 |
| adapter欠落、hash相違、生成順序逆転、他producerの出力 | 物理source→generated adapterの対応を拒否 |
| JAR snapshot改変 | 再照合で拒否し、復元後に元hash確認 |
| cache／JDKのsymlink・/tmp経由の指定 | canonical pathで同じ実fileへ照合 |
| strict policy | 変換不明を陽性とせず不採用 |

nativeのplain／control比較はconsumerの依存Provider・Actionの挙動を対象とする。Task.inputsの観測で一切の内部Provider評価が変わらないと独立証明したものではない。producer compileは同じ一回の構築で共有し、比較用に独自compilerへ置き換えない。

KotlinStagesの単体回帰は生成manifestの構造を検証する。ディスクの改変拒否はJARのnative対照と既存safe reader／snapshot回帰で分担する。合成manifestテストを、実コンパイラの変換観測と読み替えない。

実証の照合対象はKotlin出力root配下のfileとJARのclass集合で、descriptor／resource／MANIFEST／kotlin_module等の非class entryはstage出力へ束縛していない。descriptorの内容は、ロードしたclass名との一致で間接的に確認するだけである。§3の表の「descriptor／resource／JAR」の対応のうち、非class entryは未検証の限界として残す。

## 7. 再現

まず信頼できる環境で公式kotlin-dsl依存を取得し、標準kotlin-dslを使う小さいproducerのjar taskを各Gradle版で一度実行してcacheを準備する。実証そのものはofflineで行い、cache不足を成功扱いしない。

```sh
JAVA_HOME=/trusted/jdk-21 \
GRADLE_USER_HOME=/trusted/prepared-gradle-cache \
OSV_MCP_TEST_GRADLE=/trusted/gradle-8.11.1/bin/gradle \
OSV_MCP_GRADLE_KOTLIN_OUTPUT=/tmp/gradle-kotlin-proof \
npx vitest run src/test/gradle/kotlinPlugin.integration.test.ts
```

9.2.1も同じ方法で別output prefixを使う。cache／JDKのpath alias照合を確認するときは、`GRADLE_USER_HOME` を `/tmp` 経由（macOSでは `/private/tmp` へのsymlink）で、`JAVA_HOME` をJDKへのsymlinkで指定する。テスト自体はaliasを作らないため、実際の指定は各観測JSONの `pathAliases`（cache／jdk）で確認する。通常npm testではnative matrixをskipする。temp fixtureとsnapshotはafterAllで削除し、指定prefixの観測JSONだけを保存する。

## 8. 検証結果

最終native matrixと通常回帰の実行結果、source hash、実toolchain・loader profile、stage receipt、applicationとpolicy判定をvalidation/gradle-kotlin-plugin-2026-11-01.jsonへ記録する。これは設計・公開API実証であり、本番adapter／静的取込・3ツールOSV実接続への対応完了ではない。観測JSONのassessment.inputVerifiedは元sourceと既存のlibraries／compiler classpath検査、policies.attestedは既存test-only loader判定の値である。新しいpipeline信頼設定や全派生入力の完全性を検証した値ではなく、productionAdoptionEligibleはfalseとして記録する。


### 初回実行結果（レビュー修正前）

[観測データ](validation/gradle-kotlin-plugin-2026-11-01.json)に16構成、2組のtoolchain／loader profileとsource hashを保存した。JDK 21.0.13+9-LTS、macOS arm64で実行した。

| Gradle | compilerClasspathで観測したcompiler | fixture | native成功 | 時間 |
| --- | --- | --- | --- | --- |
| 8.11.1 | kotlin-compiler-embeddable 2.0.20 | 8 | 144 | 215.30秒 |
| 9.2.1 | kotlin-compiler-embeddable 2.2.20 | 8 | 144 | 243.32秒 |

- 全構成で実Plugin／descriptorが一致し、precompiledはbegin→end→after-applyの順でpendingを解消した。元sourceと生成adapterのhashがcompile入力へ対応し、生成classを持つcompile／packageを観測した。
- JAR全内容の比較は8.11.1でentry-content-exact、9.2.1でraw-exactだった。strictは未確認変換の前提によって全て不採用。比較結果だけで独立した実行bytecode観測としない。
- 有効なregisteredの宣言元候補は元plugin source＋consumer scriptの2件。生成adapterは一覧へ含めない。plain／control／registeredでgraph、Action traceとProvider評価が一致し、使用Providerは1回、未使用は0回だった。
- late／unfinished／failed／duplicate／duplicateClosedでは候補一覧全体を省略。JAR snapshot変更は16構成とも拒否し、復元後のhash一致を確認した。
- 単体回帰12件が成功。通常回帰はnative compileとの並行時に既存の時間依存3件が失敗したが、native終了後にmaxWorkers=2で単独再実行し、1,784件成功／1,027件skipとなった。時間上限や本番コードは変更していない。typecheck・buildも成功。

保存JSONのpreReviewに初回のsource hashと検証集計を保持し、case本文は以下の修正後の観測に更新した。同じprofile本文を参照へまとめた観測記録で、snapshot archive自体は含まない。各caseのprofileRef／loaderProfileRefを上位辞書から復元できる。test-only候補化の条件が成立した範囲と、本番pipeline完全性が未成立の範囲をscopeとproductionAdoptionEligible=falseで区別する。

次はこの設計のレビュー、派生classpath入力を含むpipeline manifestと信頼設定の具体化、成立した範囲の本番helper／exporter／静的取込である。directory、daemon／out-of-process compiler、cache再利用・並行export、第三者compiler pluginは別の実証を要する。


### レビュー修正: compileからpackageへの束縛とpath alias

compile出力にclassがあるだけで候補化していた判定を修正し、Kotlin出力全fileのhashをpackage入力・JAR entryへ結ぶ。JARのclass集合に過不足がある場合、descriptor実装classのロード元hashが異なる場合も拒否する。source→adapterだけでなく、compile→package→load元までの内容対応を確認する。独立した実行bytecode観測や派生compiler入力の完全性を保証する範囲は広げない。

cache・JDK・toolchain file・agentの照合キーをrealpathへ統一する。/tmpと/private/tmpの違い、JDKのsymlink指定を別toolchainとして誤判定しない。正常構成の内容とfingerprintは実体のpathを基準とし、表示用診断にもcanonical rootを使う。

回帰にはcompile／package入力／JAR entry／ロード元classの不一致と余分なclassを追加する。またjar taskのdoFirstで有効な未使用classの文字列定数を変更し、コンパイル済み出力とJARだけが異なる実ディスク負例を追加する。pluginの適用とロード元JAR照合自体は成功しても、宣言元候補を省略する。


レビュー修正後の再検証は、正常16構成と実class差し替え4構成の計20観測を保存した。両Gradle版とも188件成功（正常8 fixtureの184件＋実ディスク負例2 fixtureの4件）。8.11.1はcacheを/tmp経由、JDKをsymlink経由で指定した全10 fixtureで成功。9.2.1はcanonical path指定の全10 fixtureで成功した。正常fixtureではcompile出力全fileとpackage入力・JAR entryが一致し、descriptorの実装classをロード元hashへ結べた。実ディスク負例ではロード元JARの全内容比較は成功したまま、kotlin_compile_package_mismatchを理由に宣言元候補を省略した。

単体回帰は16件成功。今回追加したcompile hash・package入力・JAR entry・ロード元classの不一致4件は、修正前に失敗・修正後に成功を確認した。各正常native fixtureでも5種類の観測改変（計80対照）を拒否した。cache aliasの修正前対照は同じcacheで12件のclasspathを未確認とし10テスト失敗、修正後は両root alias指定でもtoolchain／loader照合を維持した。

最終の通常回帰は単独実行で1,788件成功／1,071件skip（78 files成功／11 files skip）。build・typecheck、20観測のsource hashとprofile参照・compile/package対照の整合性を確認した。実行時間は8.11.1が375.44秒、9.2.1が423.57秒、通常回帰84.93秒。負荷条件が異なるため初回との性能比較としては扱わない。


### 6e1d969レビュー修正: 拒否理由の明示と順序対照の独立化

stage単体のmutationとnativeの5種類の観測改変は、`complete=false` だけでなく期待する拒否理由を確認する。従来の `generator-after-compile` はtask列全体を逆順にしたため、package段の不一致が同時に発生し、adapter生成順の判定を削除しても成功していた。generatorだけをcompileの後ろへ移し、compile→packageの順序を保ったまま `kotlin_adapter_lineage_missing` を確認する。判定を外すと当該テストが失敗することも確認した。compile重複、package artifactのproducer／invocation／archivePath／hash不一致、余分なclassの単体対照を追加し、stage単体は22件となった。判定ロジックとinit scriptは変更していない。

修正後の再検証: native integrationは両Gradle版とも188件成功（8.11.1はcacheを/tmp経由、JDKをsymlink経由で指定、9.2.1はcanonical path）。通常回帰は単独実行で1,794件成功／1,071件skip、typecheck成功。観測caseは再生成せず、検証JSONのpostReviewRevisionに新しいsource hashと結果を記録した。
