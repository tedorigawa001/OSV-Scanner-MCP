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


## 9. Kotlin構築pipelineの信頼契約・入力manifest具体案

2026-11-01追補。§4〜5の提案を具体化し、矛盾する将来要件は本節を優先する。**設計のみで、本番schema・helper・collector・reader・設定は未実装。既存20観測を、本節の派生入力対応や非class entry被覆の成功証拠へ読み替えない。** 次の公開API実証で成立したrecipe／version tupleだけを本番へ移植する。

### 9.1 採用範囲と責任

初期対象は境界内buildSrc／included buildのroot project、標準kotlin-dslによるbinary Kotlin／precompiled Kotlin、JAR、in-process compiler、configuration cache・parallel・build cacheなしの明示再構築。Gradle 8.11.1／9.2.1を別々のprofileで確認する。KGP／compiler／kotlin-dslの版は実際に選択されたartifactへ結び、Gradle版からの推測や、cacheに同じ版が存在することだけでは確定しない。

| 担当 | 必須責任 | 独立証明しないこと |
| --- | --- | --- |
| 作者 | 全物理入力、生成stage、source mapping、resource、package期待集合を登録 | 列挙外入力がないこと・元sourceが正しい追加箇所であることは作者表明を含む |
| 信頼済みexport環境の利用者 | 実toolchainとpipeline recipeを事前確認して別々に承認。実行設定・入力不変を表明 | hashやprofileはcompilerの忠実性・実行bytecodeの証明／署名ではない |
| exporter | 公開APIから実体・集合・順序・hash・stageイベントを記録し、現在bytesと対応を検査 | KGP内部transformの独立追跡、全内部Providerの非干渉、復元された一時変更は保証しない |
| MCP reader | 境界内のmanifest・blob・参照・完全性・許可profileを再検証 | Gradle／KGPの実行、外部cacheへの追跡、OSVへのsource送信は行わない |

Kotlinのclasspath snapshotはlibraryのABI情報を表す派生物で、JARのcontent hashとは異なる。[Kotlin公式説明](https://kotlinlang.org/docs/gradle-compilation-and-caches.html)が区別するsnapshot方式を、単なるbyteコピーと扱わない。Gradleの[Artifact View／transform API](https://docs.gradle.org/current/userguide/artifact_transforms.html)を別途解決しても、それだけでKGPが実際に利用した既存transform結果との対応にはならない。

### 9.2 独立した信頼設定とprofile

必要条件は既存helper信頼、`local-plugin-loader-attested-v2`、承認toolchain／loader、および次のpipeline信頼・profileのすべて。catalogを使うscopeには既存catalog信頼も必要。strict load policyを自動でattestedへ変更しない。

| 設定 | 値と判定 |
| --- | --- |
| OSV_MCP_GRADLE_KOTLIN_PIPELINE_TRUST | `registered-kotlin-dsl-build-v1`だけを許可。未設定・空はdisabled、未知値は警告＋設定invalidとして宣言元を省略 |
| OSV_MCP_GRADLE_KOTLIN_PIPELINE_PROFILES | 小文字hex64桁digestのcomma区切り、最大32件。重複・不正値はこの集合だけを無効化し警告 |

設定は起動時固定。pipeline設定の不正で、非Kotlinのhelper／catalog／plugin許可を無効化しない。graphのprofile本文やproducerが指定したpathを、MCPが読み込んで自己承認することは禁止する。

`KotlinPipelineProfile` schemaVersion=1の全fieldを以下で定義する。objectはすべてstrictで未知fieldを拒否する。digestは本番`pluginProfileDigest`のcanonical方式で本文全体へ計算し、本文自身にdigestを含めない。物理pathは利用者が渡す別のexport設定に置き、profileには論理entry IDだけを保存する。

| field | 型・制約 |
| --- | --- |
| schemaVersion／policy | `1`／`registered-kotlin-dsl-build-v1`固定 |
| toolchainProfileDigest | 既存toolchain profile本文のSHA-256。KGP・kotlin-dsl実装／driver／compiler推移的依存は明示した`compiler`等のentryへ登録し、group名から自動承認しない |
| versions | gradle、kotlinDsl、kgp、compiler、jdkIdentityの非空文字列。実行時に選択した実装・compilerClasspath・JDK receiptと一致 |
| implementations | kotlinDsl／kgp／compilerの各`{entryIds:[ID...]}`。必要な全JARを含め、toolchainへの参照切れ・重複・未観測実装を拒否 |
| collector | `{recipeSetId, implementationSha256}`。配布collectorの確認済みrecipe集合と実コードdigest。未確認IDをgraphから動的に追加できない |
| execution | compilerStrategy=`in-process`、fallback=`error`、compilation=`full-rebuild`、incremental=`false`、outputReuse=`forbid`、configurationCache／parallel／buildCache=`false`。public option recipeと明示設定の照合ができないtupleは未対応 |
| stageRecipes | `{id, role, publicCollectorId, implementationEntryIds, inputRoles, outputRoles}`の配列。role／collector IDは静的registryの閉じたenum。task名だけで型・実装を信用しない |
| derivedPolicies | `{id, kind:"attested-classpath-cohort-v1", captureRecipeId, bindingKind:"aggregate", sourceRole}`の配列。sourceRoleは`libraries`／`plugins-block-classpath`の閉じたenum（§9.4.1） |
| packagePolicy | manifest=`profile-literal-v1`、resources=`byte-copy-v1`、duplicates=`fail`、signatures=`unsupported`。`manifestLiteral={id,bytesBase64,size,sha256}`に期待bytesとsize／SHA-256を保持 |
| attestations | pipelineReviewed、allStageInputsRegistered、inputsImmutableDuringStages、noUnregisteredCompilerPlugins、publicObservationReviewedをすべて明示true。derivedBindingScope=`cohort-not-per-artifact` |

generator stageの登録元pluginを公開APIだけで完全に特定したとは扱わない。確認した公開TaskProviderへの明示登録と承認plugin modelとの対応は追加契約に含め、`kotlin_stage_role_registration_author_attested`をlimitationsへ加える。Kotlin compileは公開KotlinCompile型／libraries APIを確認し、独自の同名taskを同一recipeへ昇格させない。

`implementations`は選択したplugin implementation／driverの実bytesを、公開APIで確認できる範囲でtoolchain receiptへ結ぶ。実装のロード元やversionの観測が未成立なら`recipe_unsupported`とし、artifactファイル名や座標だけで陽性化しない。既存実証profileのようにcacheのKotlin関連JAR全件を集める方式は、本番profileの選択実装確認の代用にしない。

`execution`はrequested設定と観測結果を分ける。既存実証の`requested-in-process`だけでは条件達成としない。利用する公開option／runtime観測と、fallback・compiler plugin・free compiler argsの許可範囲をtuple別recipeへ固定する。観測不能な動作は表明の範囲を明示し、recipe未実証のまま有効にしない。KAPT／KSP、daemon／out-of-process、独自compiler plugin、混在Java／Groovy compile、任意transformは初期対象外。

### 9.3 作者manifestとexport schema

contractVersion=4、graph schemaVersion=4、declaration adapterVersion=6を予約する。既存v1〜v3契約／adapter v2〜v5の意味は変えず、新fieldを旧schemaで許可しない。contract v4の非Kotlin plugin specは既存形を保ち、Kotlin specだけにbuildMethod=`standard-kotlin-dsl-v1`とpipelineIdを必須とする。

固定manifest `osv-mcp-gradle-declarations.json` に`kotlinPipelines`を追加する。一つのentryは次の全fieldを持つ。`assertions` object自体は必須で、mapping subkeyだけを下記のとおりoptionalとする。

| field | 内容 |
| --- | --- |
| id／producer／pluginSpecIds | pipeline ID、既存producer tuple、関係する全spec ID。producerをまたぐ共有禁止 |
| pipelineProfileDigest | §9.2のprofile digest。specのtoolchain digestとprofile内のtoolchain digestも一致 |
| inputManifest | `{files:[{id,path,role}], absentCandidates:[{id,path}]}`。settings／build／適用script／source／resource／lock／設定・明示した独自依存を列挙。roleはsource、build-script、resource、plugin-library、configurationの閉じたenum |
| stagePlan | `{id,role,taskPath,recipeId,inputSlots,outputRoots}`。各rootは`{id,path,role}`。roleはpackage-candidate、intermediate、local-state、archive。実rootの用途をrecipeで固定 |
| sourceMappings | `{mappingId,pluginSpecId,sourceKind,physicalSourceId,adapterStageId}`。sourceKindはbinary-kotlin／precompiled-kotlinで、specのregistrationFormと一致。binaryはadapterStageId=null。precompiledは生成adapterへの参照必須。physicalSourceIdはbaselineの元.kt／.gradle.ktsのみ |
| cohorts | `{id,consumerStageId,sourceRole,captureRecipeId,policyId}`。sourceRoleはconsumer stageのroleで決まり、kotlin-compileは`libraries`、plugins-block-compileは`plugins-block-classpath`。consumer stageごとに別cohortとし、stageをまたいで共有しない。実collectionのcaptureを予約し、登録時にProviderを評価しない |
| packagePlan | `{stageId,terminalRootIds,descriptorBindings,resourceMappings,manifestPolicyId}`。descriptorBindingsはpluginSpecId／pluginId／implementationClass、resourceMappingsは入力ID→出力相対pathの明示copy関係 |
| assertions | buildInputs=`all-plugin-build-inputs-listed`とmutation=`immutable-during-export`は必須literal。mappingはoptionalで、値は`source-artifact-mapping-reviewed`／`not-asserted`のenum。省略は未表明。既存scope／Provider表明を代替しない |

inputSlotsは`{id,role,sourceRef}`、receipt inputsは`{slotId,refs:[logicalRef...]}`の配列とする。roleはphysical、generated、libraries、compiler-classpath、derived、registered-scalar、profile-literal、package-literal-fileで、slotのcardinalityと許可ref kindをrecipeへ固定する。入力refの省略・role交換・二重所有を禁止する。sourceMappingの元sourceは既存spec.sources／sourcePathsとの集合対応も検査する。

物理filesと既存plugin specのinputPathsはproducer内の和集合で一致させ、片側だけに入力を隠さない。absentCandidatesは評価前に不在を捕捉し、後の出現をstaleとする。生成入力はphysical fileへ偽装せず、原則stage-output参照にする。唯一の例外は§9.6.1のpackage-literal-fileで、既定MANIFESTの専用slotだけに許可する。未登録generatorが作った.ktを宣言元へ昇格させない。

graph v4には`kotlinPipelineEvidence`を必須とし、`{evidenceVersion:1, invocationId, inventoryComplete, profiles, producers}`を持たせる。非使用でもinventoryComplete=trueと空配列を明記する。producer evidenceは`{pipelineId,producer,manifestDigest,profileDigest,physicalInputs,stages,sequences,cohorts,packageInventory,state,reasons}`。同一invocation内のIDは一意とし、全参照をproducer／invocation／stageへ束縛する。

stage roleのenumはextract、external-spec、plugins-block-compile、accessors、adapter、kotlin-compile、descriptor、resources-copy、package、non-contributing-java-compile。binaryでは少なくともkotlin-compile／descriptor／resources-copy／packageの4 roleを実行し、precompiledでは全roleをplanへ載せる。extract／adapter／kotlin-compile／descriptor／resources-copy／packageはprecompiledの必須実行role。plugins blockがない場合のcompile／accessors等の非使用は、下記の閉じた条件だけで認める。

各stage receiptは`{id,role,taskPath,recipeId,ordinal,state,inputInventoryComplete,inputs,scalars,outputs,observationPhase}`。実行時stateはexecuted／not-applicable／unavailableのtagged unionとする。

- executedにはexecuted=true、didWork=true、skipped=false、failure=falseと実input／output集合が必須。ordinalのDAGで生成前使用・循環・同じstageの重複を拒否する。
- not-applicableはそのsource kindでrecipeが任意と定めたstageだけ。空入力集合・非使用の根拠を必要とし、必須Kotlin compile／packageへ使えない。
- cache hit／up-to-date／no-source／failedを成功receiptへ変換しない。必要stageが実行されなければunavailable。binaryとprecompiledのstage必須集合をprofileへ固定する。
- file参照は`physical-input`、`stage-output`、`toolchain-entry`、`derived-snapshot`、`package-literal-file`のunion。最後の型は§9.6.1の条件に限定し、一般の生成物の分類先にしない。scalarは公開option／plugin model／固定profile literal、および§9.6.1専用のpublic-locationをrecipeごとに許可し、任意のJSONを入力証拠にしない。
- 出力所有者は一つ。classes root内のfileをlocal-stateへ付け替えて除外できない。source／generated sourceはintermediate、Kotlin classes rootの全fileはpackage-candidate、compiler cacheは明示local-stateとして区別する。Jar自身の出力はarchiveとし、terminalRootIdsには含めず、ちょうど一つのarchiveRefへ結ぶ。

not-applicable条件は、binaryのprecompiled source集合が空、または確認済みextract stageのplugins-block出力と次stageのpublic source slotが両方空で、消費する生成物もない場合に限定する。型ごとに許可したstageだけへ適用し、空配列の自己申告、単なるno-sourceフラグ、過去の生成物の残存では非使用としない。

標準kotlin-dslのproducerには、保存済み20観測のすべてで`:compileJava`（didWork=false、noSource=true）が現れる。これは`non-contributing-java-compile` roleとして扱い、次の条件をすべて満たす場合だけstate=not-applicableを認める。

- Java source rootの候補pathを評価前のabsentCandidatesで捕捉し、export終了まで不在のまま（または空のdirectoryのまま）である。
- そのtaskの公開outputs（Java classes root）が空で、package入力にもJAR entryにも現れない。
- recipeがこのtask pathと公開型を確認済みで、didWork=false／noSource=trueを観測した。noSourceフラグだけでは根拠にしない。

Java sourceが一件でも存在する、出力rootが空でない、Java classes rootのfileがpackage入力へ届く場合は、混在Java compileとして`kotlin_pipeline_recipe_unsupported`にする。このroleはKotlin compile／packageの代替にならず、ほかのno-source stageへ拡張しない。

入力・出力ともpath／kind／size／SHA-256または完全tree digestを保存する。pathは境界相対で既存safe-reader規則を用い、IDを返却時のsanitize後の値で照合しない。group ID等の新しい論理IDはASCII `[a-z][a-z0-9._-]{0,127}`。SHA-256は小文字hex64、sizeはsafe integer。未知field、duplicate JSON key、参照切れ、二重分類を拒否する。

#### 9.3.1 mapping未表明のschemaと宣言採用条件

contract v4のstandard-kotlin-dsl分岐では、pipeline entryの`assertions.mapping`と、そのpipelineを参照するKotlin plugin specの`assertions.mapping`を同じoptional enumにする。旧plugin spec schemaをそのまま呼び出して、Kotlin spec側にだけ必須literal判定を残さない。非Kotlin specおよびcontract v1〜v3のschema・挙動は変更しない。

| raw mapping値 | schema | 宣言用の表明状態 |
| --- | --- | --- |
| `source-artifact-mapping-reviewed` | 有効 | reviewed |
| `not-asserted` | 有効 | unasserted |
| mapping subkeyの省略 | 有効 | unasserted |
| null、boolean、その他の文字列 | 不正 | kotlin_pipeline_schema_invalid |
| assertions object自体の省略／不正型、buildInputs／mutationの必須literal不正 | 不正 | kotlin_pipeline_schema_invalid |

たとえば次の二つはmappingについて同じ未表明状態を表す。これはschemaの部分例で、その他のmanifest必須fieldは通常どおり必要。

```json
{
  "assertions": {
    "buildInputs": "all-plugin-build-inputs-listed",
    "mapping": "not-asserted",
    "mutation": "immutable-during-export"
  }
}
```

```json
{
  "assertions": {
    "buildInputs": "all-plugin-build-inputs-listed",
    "mutation": "immutable-during-export"
  }
}
```

省略をunassertedへ解釈するのは宣言判定の内部処理だけ。manifestをrewriteしたり、hash計算前にdefaultを埋めたりしない。`manifestDigest`と評価前baselineは元のUTF-8 file bytesのSHA-256に結ぶ。mappingを削除・変更したmanifestへ古いcompanionを組み合わせた場合は、正当にstale／digest不一致となる。未表明の正常対照は、新しいmanifestと整合した新exportで作る。

各contributing contextの`source_mapping_attestation`は、pipelineとそのcontextで必要な全Kotlin specの両方が明示reviewedの場合にだけreviewed、それ以外はunassertedとする。片側だけのreviewed、承認済みpipeline profileのpipelineReviewed、graph内のaccepted flagでは補完しない。MCPが固定raw manifestから再計算し、exportされた診断値があっても採用の根拠にしない。

未表明でもsourceMappings配列、物理source ID、adapter／compile edge、implementationClass、producer／invocation、全hashは必須である。未表明を理由にこれらの検証をskipしたり、空sourceへ置き換えたりしない。全input integrity検査が通過した場合だけ、`input_status=verified`を保って`kotlin_source_mapping_assertion_missing`／missing_assertionとし、contributing GAVの宣言元一覧全体を省略する。relation／introduced_byとlock由来coverageは維持する。

参照切れ・不正型・hash不一致が同時にあれば、それぞれの入力エラーを優先する。mapping未表明で入力破損をdeclaration-onlyへ格下げしない。Kotlinを使わない独立scopeにはこの新しいoptional判定を持ち込まない。

### 9.4 派生classpath snapshotの対応付け

初期方式は**一つのconsumer stageの、順序付きlibrary集合から、明示したsnapshot集合へのaggregate対応**である。個別JARと個別.binの一対一対応を主張しない。多対多を許す代わりに、全sourceと全derived memberを取りこぼさない閉じたcohortを要求する。

runtime cohortの参照形は次のとおり。各refの本文はproducer evidence内の別inventoryへ置く。

```json
{
  "id": "classpath-main",
  "consumerStageId": "compile-main",
  "sourceRole": "libraries",
  "sourceSequenceRef": "libraries-main",
  "derivedCollectionRef": "snapshot-files-main",
  "captureRecipeId": "kgp-snapshot-collection-v1",
  "policyId": "attested-classpath-cohort-v1",
  "bindingKind": "aggregate",
  "bindingAssurance": "author-attested",
  "observationPhase": "post-task",
  "inputInventoryComplete": true
}
```

`kgp-snapshot-collection-v1`は**将来のregistry IDであり、公開collectionが既に取得できるという実証結果ではない**。採用するtupleで、安全に再観測できるpublic collectionと取得recipeの成立を別途証明する。成立しなければ`kotlin_derived_capture_unavailable`とし、汎用Task.inputsの残りやcacheの走査から推測して埋めない。

1. 登録helperはstage IDと静的に許可したpublic collection handleを保持する。任意path配列・作者のmap・Providerの値をcapture済みhandleとして受け入れない。登録時のget／isPresent／mapや追加ArtifactView解決は禁止する。
2. public `KotlinCompile.libraries`から得た順序を`orderBasis=public-file-collection-iteration`として保存する。各要素はordinal、論理input ref、size／hashまたはtree digestを持つ。別に観測したcompilerClasspathも独立sequenceとし、librariesへ混ぜない。実効compiler引数の内部順まで独立証明したとはしない。
3. 既に実行されたstageの確認済みpublic collectionからsnapshot集合を取得する。collectionを取得するための新しいresolutionやsupplier評価が起きるrecipeは、非干渉対照が成立するまで未対応。private task field・build operation・transform cache metadataの解析へfallbackしない。
4. public Task.inputsの全fileを、既知のphysical／generated／toolchain／derived slot、またはpackage stageだけの専用package-literal-file slotへ一意に割り当てる。未知の残りは`input_unclassified`。`.bin`拡張子、`transforms/`以下の位置、元JARに似たbasename、同じcontent hashはcohort所属の根拠にしない。
5. cohortのsourceSequenceはそのstageのlibrariesとrole・順序・重複を含めて一致する。derivedCollectionもpublic collectionのiteration順を保持し、そのfile inventoryと完全一致させる。sequenceのordinalは連続し、公開APIに存在した同じrefの繰返しは勝手にdedupしない。derived memberの欠落・追加・他stage／producer／invocationからの流用を拒否する。snapshot個数とlibrary個数の一致は要求しない。
6. `sourceSequenceDigest`と`derivedCollectionDigest`を別々に計算し、cohort ID／consumer／policy／profile／invocationを含む`bindingDigest`へ結ぶ。これは集合の固定用で、変換関数の正しさや個別artifact由来の独立証明ではない。
7. 各snapshotの実bytesを境界内へ保存し、export終了前に元bytesのsize／hashと再照合する。MCPは保存blobだけを再検証し、生の外部cache pathへアクセスしない。外部cacheのexport後の変更を検出したとは扱わない。

sourceが空なのにderivedが存在する、derivedなしをpolicyが許可しないのに空集合にする、二つのcohortが同じconsumerの同じinputを二重所有する場合は不完全。byte blobの共有は可能だが、論理file／consumerの被覆は省略しない。個別artifact対応の公開APIが今後確認できても、別のbindingKind／recipeとして版管理し、aggregateをper-artifactへ読み替えない。

#### 9.4.1 plugins block compileの派生入力

保存済み観測では、9.2.1のprecompiled構成の`:compilePluginsBlocks`に`derived-or-unapproved-task-input`が20件ある（8.11.1では0件）。初期方式はKotlinCompile.librariesだけでは閉じないため、plugins-block-compile stageにも同じaggregate cohortを独立に定義する。

- sourceRoleは`plugins-block-classpath`。そのstageで公開APIから取得できるclasspath集合をsourceSequenceとし、kotlin-compileのlibrariesとは別sequence・別cohortにする。片方のcohortのderived memberを他方へ付け替えない。
- 取得recipe（予約ID `kgp-plugins-block-snapshot-collection-v1`）は、対象tupleで公開collectionと非干渉の実証が成立した場合だけ有効にする。名前や型の推測、Task.inputsの残りからは作らない。
- 実証が成立しないtupleでは、そのprecompiled構成をkotlin_pipeline_recipe_unsupportedとして初期対象外とする。8.11.1のように派生入力がない構成でも、空のcohortを要求せず、公開入力の完全分類だけを要求する。
- KP01の正常構成数は、成立したrecipeの範囲で数える。9.2.1 precompiledのcohortが未成立なら、正常構成は12（9.2.1 precompiled 4構成はrecipe_unsupported）とする。

### 9.5 capture時刻・鮮度・予算と保存

physical input baselineとmanifest hashは、全producerを含め最初のsettings評価前に捕捉する。stageの開始イベントにはstage／ordinalと、静的manifestで既に登録された出力rootの空状態だけを記録し、入力観測のために未評価Providerを先行実現しない。実証可能なpost-task recipeでstage input／outputのsnapshotを作り、packageとexport終了時に再検証する。`observationPhase=post-task`をcompile開始前・実際の消費時刻と偽らない。

full-rebuildでは公開option recipeでincremental=falseを確認し、各producerのKotlin classes rootがcompile開始前に空であることを有界に検査する。--rerun-tasksやdidWork=trueだけでは、以前のclassの再利用がない証拠にしない。必要なcleanは利用者が信頼した準備操作でproducerごとに明示実行し、exporter／MCPが独断で出力を削除しない。再export時も同じ条件を必要とし、非空rootはkotlin_pipeline_previous_outputs_presentで不採用にする。この新条件を、既存の再export実証だけで達成済みとしない。

元sourceの評価中変更・stage間変更、生成adapterのcompile前差し替え、compile後のclass変更、resourceのpackage前変更は、baseline／生成元snapshot／次stage入力／JARのedge照合で拒否する。観測の間で変更して復元した入力や、未知の実行時読取は検出保証外。`inputsImmutableDuringStages`はその限界に対する追加信頼であり、hashが独立に保証する事実ではない。

保存済み観測のexternalInputObservationsには、8.11.1の18,451,885 bytes、9.2.1の18,858,585 bytesのgradle-api snapshotがある。ただしこれは`derived-or-unapproved-task-input`の診断記録で、cohort対応の陽性証拠ではない。4 MiB/file制限を一律適用すると標準構成を扱えないため、次の専用経路を予約する。

| 区分 | 上限と扱い |
| --- | --- |
| 通常source・plugin固有入力・生成物・JAR | 既存4 MiB/file・共有64 MiB/scan。大きいという理由でtoolchainへ移さない |
| 元toolchain binary | 既存512 MiB/file・2 GiB/export・1 MiB bufferのstreaming照合。MCPは元外部pathを読まない |
| 大きいderived snapshot | **cohortの全sourceが明示したtoolchain-entryの場合だけ**64 MiB/file・共有256 MiB/exportおよびscan。1 MiB chunk、最大64 chunks/file、buffer最大1 MiB |
| mixed／plugin由来derived | 通常4 MiB/file・共有64 MiBを消費。独自libraryを含むaggregateをtoolchain-onlyへ分類変更しない。安全に分割できない大きいmixed cohortは初期未対応 |
| manifest・work | profile／作者契約は各1 MiB、profile最大32、producer最大100、stage合計2,000、通常file／directory entry合計10,000、derived file合計2,000、chunk参照合計4,096。companion各16 MiB／共有64 MiB、既存2,000,000 work予算を共有 |

上限はprofileから増やせない。大きいderived区分を使うには、source分類・完全性・対応profile・policyの構造が有効であることが必要。**利用者のallowlist承認がない場合も同じ入力検証は行う**。単なるtrust無効／profile未承認をsize不正としてgraph拒否へ変えない。一方、toolchain-onlyを立証できないmixed sourceの偽装は入力不正として拒否する。

保存prefixは`.osv-mcp/kotlin-pipeline/<invocationId>/`とし、manifestは`producers/<pipelineId>/manifest.json`、内容blobは`blobs/<sha256>`へ置く。`FileSnapshot`は`{size,sha256,chunks:[{size,sha256}]}`。chunkは1 MiB以下で最後以外は1 MiB、合計size・順序付き結合hash・blob名・現在bytesをすべて照合する。0-byte fileだけはchunks=[]とし、空fileの正しいSHA-256を要求する。

blobの重複読取はcacheできるが、file size上限・論理参照数・workは参照ごとにも検査する。通常区分と大きいderived区分を区別したcache key／予算を使い、shared blobやcontext順序で4 MiB制限を迂回しない。全consumerがtoolchain-onlyかは各refで再判定する。大きいderivedの再検証はchunkを順次読み、検証済みdigestだけをcacheし、256 MiB全体をメモリへ保持しない。

既存safe-readerと同じ境界・symlink・特殊file・開いたfileの同一性検証を使い、cache／JDK／agentの実pathはexport側でcanonical化する。外部rootは利用者が事前に許可したものだけ。staging内で全manifest／blobを検証し、既存同digest blobも照合後にatomic publishする。公開prefixのfile集合も全producer manifestとblob参照の和集合へ一致させ、未参照blob・余分なfile・staging残骸を拒否する。全producerの保存完了後にだけcompanionを更新する。不正な既存blobを上書きして成功扱いせず、途中失敗では前のcompanionを保つ。

取得失敗と保存領域の不整合は区別する。export時に公開slotから実fileやcollectionを取得できない場合は、型ごとの`*_capture_unavailable`（unverifiable）とする。export時に元bytesと捕捉bytesが一致しない場合は、型ごとのstale理由（`kotlin_derived_snapshot_stale`等）とする。MCPが読むときに、manifestが参照するblob・chunkが欠落・改変・順序交換・size不一致の場合は、型（physical-input、stage-output、toolchain-entry、derived-snapshot、package-literal-file）を問わず`kotlin_pipeline_snapshot_storage_mismatch`（invalid）とする。保存領域の不整合を取得不能へ格下げしない。

### 9.6 JAR全entryと生成元stageの対応

`PackageInventory`は`{producer,invocationId,packageStageId,archiveRef,entries}`。entriesは全非directory ZIP entryのpath・size・SHA-256・originを一件ずつ持つ。MCPは現在JARを安全にparseし、その実集合とinventory集合の完全一致を要求する。directory entryはpayloadなしの構造として検査し、file／directory衝突・未知ZIP形式・重複名を許可しない。

originは次の閉じたunionとし、JARから逆に作った「生成元hash」だけでは被覆と認めない。

| origin | 必須のedgeと検査 |
| --- | --- |
| stage-output | producer／invocation／stage／root／相対file ref。生成元snapshot→必要なcopy stage→package入力→JAR entryのsize／hashがすべて一致 |
| profile-literal | profile digest／literal ID／package stage ref。**JARを読む前からprofileに固定された期待bytes**とJAR entryを照合。初期はdefault MANIFESTだけ |

各entryのownerはちょうど一つ。package root候補の全fileは、ちょうど一つのentryへ届く必要がある。生成.kt等のintermediateやcompiler local-stateはrecipeで明示して除外するが、未知entryをauxiliaryと付け替えて採用しない。複数元fileの同名path、重複copy、サービス定義の連結・merge・filtering、曖昧renameは初期拒否する。

| entry種別 | 元stage・入力 |
| --- | --- |
| `.class` | Kotlin compileのclasses root。全class集合の完全一致と全file hashを要求。descriptor実装classはcompile／JAR／ロード元classのhashも一致 |
| `.kotlin_module`等 | Kotlin compileがそのrootへ出力したmetadata。拡張子だけで無視せず、compilerのmoduleName等のscalar inputを含むreceipt→package入力→entryへ結ぶ |
| `META-INF/gradle-plugins/<id>.properties` | pluginDescriptors→processResources→package。公開plugin modelのplugin ID／implementationClass集合をregistered scalar inputとして固定。descriptor集合は登録plugin集合と一致し、実装classも照合 |
| 通常resource／`META-INF/services/*` | baseline resource input→processResourcesのbyte-copy→package。source→出力pathの明示mappingと全size／hash一致。入力側で同じtargetへ二重登録しない |
| `META-INF/MANIFEST.MF` | entry originはpackage stageのprofile-literal。公開入力に現れる一時fileは別途package-literal-fileとして同じliteralへ結ぶ。literal・入力file・entryの三者一致を要求し、空入力から任意manifestを信用する例外にしない |

plugin modelの生成入力は、公開APIで観測したplugin declarationのID／implementationClassの完全な集合と、producerのbuild/settings baselineへ結ぶ。descriptor bytesは構築stageが生成した実fileとして保存し、propertiesの重複keyや未知plugin ID、class参照不一致を拒否する。descriptor名が一致しただけでresourceの生成元を確定しない。

MANIFEST初期policyは、既定manifestの固定literalだけを許可する。期待bytesはbase64からdecodeしてsize／SHA-256も再計算し、公開確認したGradle tupleのpackage設定と照合する。初期registryはそのtupleの既定MANIFESTの期待bytesを固定し、profileが別のliteralを指定しても承認だけでcustom manifestへ拡張しない。JAR entryを読み、その内容でprofile literalや入力receiptを生成するのは禁止。Jar.manifestの再serializeがProvider評価や生成処理を追加する場合、その出力を事前stageの証拠にしない。

custom／動的manifest、merge・属性追加、manifest Class-Path等の独自処理は初期未対応。今後は専用の明示生成stageと確認済みserialization recipeが必要になる。署名entry（.SF／.RSA／.DSA／.EC等）、multi-release JAR、任意追加CopySpec・entry名変換も、現policyでは許可しない。resource改変をliteralへ付け替えることも禁止する。

package receiptのarchive path・size／hashと現在JAR、runtime snapshotの全file内容を別々に照合する。runtime側が構築JARと同じでも、構築stageへのedgeが欠けていれば拒否する。同内容のresourceがあるだけで、異なるpath／producerの所有権を流用しない。

#### 9.6.1 一時MANIFESTを固定literalへ結ぶfile入力型

保存済み20観測すべてのJar公開入力に、`<producer>/build/tmp/jar/MANIFEST.MF`が存在する。このfileは評価前baselineにも先行stage出力にもない。これをphysical-inputへ加えたり、同じpackage stageのstage-outputを入力元にしたりせず、専用の`package-literal-file`として扱う。

以下がこのfile参照型の全fieldで、未知fieldは拒否する。`content`は§9.5のFileSnapshotであり、新しい外部path readerを導入しない。

| field | 型・制約 |
| --- | --- |
| kind | `package-literal-file`固定 |
| id | invocation内で一意な論理file ID |
| producerRef／invocationId | 対応するproducer evidenceのpipelineIdと、今回のexport ID |
| packageStageId／inputSlotId | このfileを公開入力に持つpackage stageと、専用slotのID。他stageへの共用不可 |
| captureRecipeId | 確認済みregistryの`gradle-jar-manifest-input-v1`。将来のrecipe IDで、現時点の取得実証ではない |
| profileDigest／literalId | 同じpipelineの承認対象profile本文と、packagePolicy.manifestLiteral.idへの参照 |
| temporaryRootRef | 同じpackage stageのpublic-location scalar ID。Jarの公開temporary directoryから捕捉したroot以外を参照しない |
| path | collectorが取得した境界相対の実file path。作者が任意fileを指定する入力ではない |
| content | `{size,sha256,chunks}`。通常4 MiB/file・共有64 MiBの区分。大きいderived／toolchainの例外は使えない |
| observationPhase | `post-task`固定。compile前やJar action前に取得したと偽らない |

対応するinput slotはrole=`package-literal-file`、sourceRef=`{profileDigest,literalId}`、refsのcardinality=1とし、この型だけを許可する。profileのpackage recipeに同じslot・captureRecipeIdを登録する。scalarのprofile-literal slotと、観測したfile入力のslotを区別し、scalar値があるだけで実fileを分類済みにしない。

専用public-location scalarは`{id,kind:"public-location",locationKind:"jar-temporary-directory",path,captureRecipeId}`。pathは境界相対で、同じproducerの実Jarからpost-taskに捕捉する。readerはtemporaryRootRefのownerを照合し、file pathがそのrootとregistry固定suffix（初期はMANIFEST.MF）の結合に一致することを検査する。これはpackage output rootや新しいgeneration stageではない。

public collectionと一時fileの結び付けはtuple別のcapture recipeで確認する。実Jar／Taskの公開APIから得た実体・temporary directory・既に存在する公開inputsのmemberを照合し、profileが許可した一時MANIFESTだけを選ぶ。basename、作者指定のpath、同じbytesの別fileだけでは認めない。recipeの公開API・観測の非干渉が未確認なら`kotlin_package_literal_capture_unavailable`とし、汎用の残りfileやJAR entryから逆算しない。

literalの期待bytesはprofile準備時に固定され、package実行前から存在する。file記録は**その定数を具現化した一時入力の観測**であって、package stageが先に生成した出力というDAG edgeではない。packageStageIdはconsumerの識別子として検証し、generationの親stageとしてDAGへ追加しない。従来のstage-output edgeの順序検査は緩めず、この例外を任意の同stage入出力へ拡張しない。

検証順は次のとおり。

1. profile literalをdecodeし、registry既定bytes・size／hashと一致させる。literalの作成に一時fileやJARの現在内容を使わない。
2. `producerRef`／invocation／package stage／slot／recipe／profile／literalを照合する。literal ID、stage、公開memberと異なるpathへの付け替えは`kotlin_package_literal_binding_invalid`。境界外・symlink等は既存unsafe_path判定を優先する。
3. 公開slotで実fileを取得してsnapshotを保存し、export前にも元fileと照合する。export時の取得不能は`kotlin_package_literal_capture_unavailable`。MCPが読むときの保存blob欠落・不一致は§9.5の`kotlin_pipeline_snapshot_storage_mismatch`。保存bytes・size／hashが固定literalと異なれば`kotlin_package_literal_file_mismatch`。
4. 現在のJAR内`META-INF/MANIFEST.MF`のsize／hashも、同じ固定literalと照合する。entryだけの不一致は`kotlin_package_entry_mismatch`。一時fileとJARを同じ悪いbytesへ変えても、固定literalとの比較で拒否する。
5. 一時fileには通常のpublic-input分類を一件与えるが、package-candidateやarchive出力へ重複計上しない。JARのMANIFEST entryのownerは引き続き一つのprofile-literalで、input fileを二つ目のentry ownerにしない。

MCPは保存されたcontentを読み、この型のchunk参照も保存prefixの正当な参照集合へ含める。一時pathとtemporary rootはexport時の所有元・観測診断であり、baseline物理入力にはしない。exporterはcapture時の境界・symlink・特殊fileを検査し、MCPはpathの構造とowner関係を検査するが、一時pathを再open／再生成しない。保存blobには通常のsafe-reader検証を適用する。export完了後に一時fileが消えても、保存snapshot・profile literal・現在JARがすべて検証できればそれだけではstaleにしない。逆にsnapshotを省略してJARから再生成することは禁止する。

他resource、descriptor、compiler snapshot、任意の.tmp fileにはこの型を使えない。登録したMANIFEST slot以外の残り入力は従来どおりinput_unclassified。専用型を外すだけで正常Jarが拒否される対照と、専用型へ偽装した無関係fileが拒否される対照を両方必要とする。

### 9.7 取込・完全性・信頼metadataの判定順

1. 固定作者manifestを独立に読み、新pipelineの必要性を判定する。v4／standard-kotlin-dslが必要なmanifestに、旧graph・旧adapter・空pipeline配列を合わせても検証を省略しない。manifestが壊れて必要性を確定できなければ保守的に不採用とする。
2. profile本文のschemaとdigest、producer／invocation、登録集合、全stage／input／cohort／package edge、保存snapshotの現在bytesを検査する。信頼設定が無効・未承認でも省略しない。
3. 入力integrityがverifiedの場合にだけ、helper／plugin／pipeline／必要なcatalog信頼、各allowlist、raw manifestから求めたmapping表明状態、登録sessionとscopeの完全性を判定する。許可済みprofileのdigestがgraphにあるだけで、破損bytesを通さない。
4. 同一GAVの全contributing context／lockの宣言元を完全性ANDで併合する。一つでもKotlinの宣言被覆が不完全なら、script側だけの一覧も返さない。verifiedなgraphのrelation／introduced_byは維持する。

| 条件 | input_status | pipeline trust／宣言元 | graph・coverage |
| --- | --- | --- | --- |
| 全証拠が整合し全信頼・承認あり | verified | accepted、登録も完全なら採用 | 検証済みrelation／introduced_byを採用 |
| pipeline trustなし／旧plugin trust／profile未承認 | verified | disabled／disabled_for_required_policy、宣言元全省略 | graphを信頼設定だけで失効させない |
| consumer設定の未知値・不正allowlist | verifiedなら維持 | invalid＋設定理由、宣言元省略 | 非Kotlinの設定へ伝播させない |
| mappingが有効な未表明状態（省略／not-asserted）、またはsessionだけが不完全 | verified | missing_assertion、一覧全省略 | relation／introduced_byは維持。型・参照・hash不正とは分離 |
| 必要collection取得不能、未知入力、stage被覆不足 | unverifiable | unverifiable、一覧省略 | 影響graphを不採用 |
| hash・参照・schema・producer不一致 | invalid | invalid、一覧省略 | 影響graphを不採用 |

profile「未承認」と、本文欠落・digest不一致・実装tuple不一致を区別する。前者はconsumer policy、後者は入力integrityの失敗。原因producer／contextを特定できない破損は全文書のmetadataを不採用にする。どちらもlockfileの脆弱性検出を止めず、metadata不足だけでlock由来のcoverageを下げない。producer自身のlock不足等、別のcoverage警告は維持する。

metadataにはproducer／contextごとに`kotlin_pipeline_trust_status`、profile ID、`input_status`、`source_mapping_attestation=reviewed|unasserted`、`derived_binding_assurance=cohort-author-attested`、stage／package completeness、`reasons`を出す。最上位statusはinvalid > unverifiable > missing_assertion > disabled_for_required_policy > disabled > acceptedで併合する。設定不正もtrust_status=invalidだが、graph採否は常に独立したinput_statusから決める。declared_in完全性はstatusだけでなく全必要条件をANDする。pipelineの宣言採用条件がすべて成立するときだけassuranceを`author-attested-kotlin-pipeline-and-structurally-checked`とし、それ以外はnullとする。独立した既存helperのassuranceを上書きせず、既存loader等のstatus・limitationsも失わない。

必須limitationsは`kotlin_build_pipeline_author_attested`、`kotlin_derived_classpath_inputs_not_independently_bound`、`kotlin_effective_compiler_inputs_author_attested`、`kotlin_stage_role_registration_author_attested`、`plugin_classpath_transient_changes_not_detectable`、既存のsource mapping／runtime transform／loaded bytesの限界。これらの表示だけで欠落した集合や壊れたedgeをacceptedへ昇格させない。

### 9.8 拒否理由の契約

下表は将来実装のreason ID。schema検証失敗を後続の一般的なmissing理由へ丸めず、確認できた最も具体的な理由を保持する。複数独立原因は安定した順序でuniqueに併記する。親edgeが無効なため検査不能な子のエラーを捏造しない。

| reason | 条件・分類 |
| --- | --- |
| kotlin_pipeline_trust_disabled | 新trust未設定。policyのみ、graph維持 |
| kotlin_pipeline_trust_config_invalid | 未知trust／不正profile allowlist。policyのみ |
| kotlin_pipeline_profile_not_approved | 整合した本文がallowlistにない。policyのみ |
| kotlin_pipeline_required_policy_missing | 旧plugin trust等で新pipelineに必要な別信頼がない。policyのみ |
| kotlin_source_mapping_assertion_missing | v4 Kotlinのmapping省略／not-asserted。宣言のみmissing_assertion、inputが整合すればgraph維持 |
| kotlin_pipeline_schema_invalid | 未知version／field、duplicate key、不正型。mappingのnull／boolean／未知文字列、assertions object欠落も含む。許可したmapping subkeyの省略は除く。input invalid |
| kotlin_pipeline_inventory_incomplete | 必要pipeline／producer／stage／inputの被覆欠落。input unverifiable |
| kotlin_pipeline_profile_mismatch | 本文digest、toolchain参照、実装entry／version／実行設定が不一致。input invalid |
| kotlin_pipeline_previous_outputs_present | full-rebuildを要求したclasses rootに前回出力が残る。input unverifiable |
| kotlin_pipeline_recipe_unsupported | 必要な公開recipe／実装tuple未確認。input unverifiable |
| kotlin_pipeline_producer_mismatch | producer／spec／stageの所有者不一致。input invalid |
| kotlin_pipeline_invocation_mismatch | 別exportのsnapshot／receipt参照。input invalid |
| kotlin_pipeline_inputs_stale | baseline物理入力・不在候補・元toolchain照合不一致。input invalid |
| kotlin_pipeline_input_unclassified | public入力に未知の残り・二重分類。input unverifiable |
| kotlin_derived_capture_unavailable | 実snapshot集合を安全に取得できない。input unverifiable |
| kotlin_derived_cohort_mismatch | source role／順序／consumer／policy／digest不一致。input invalid |
| kotlin_derived_inventory_incomplete | derived集合の欠落・追加・空集合偽装。input unverifiable |
| kotlin_derived_snapshot_stale | export時に元snapshotと捕捉bytesのsize／hashが不一致。input invalid |
| kotlin_pipeline_snapshot_storage_mismatch | MCPが読むときに参照blob・chunkが欠落・改変・順序交換・size不一致（全file型共通）。input invalid |
| kotlin_derived_source_classification_invalid | mixed入力をtoolchain-onlyに昇格、大きい区分の不正使用。input invalid |
| kotlin_stage_receipt_incomplete | 必須stageの未実行・skip・failure・不正なnot-applicable。input unverifiable |
| kotlin_stage_lineage_mismatch | 入力と生成元、生成順、stage出力rootの対応不一致。input invalid |
| kotlin_package_origin_incomplete | 未束縛entry・未収録terminal file・複数owner。input unverifiable |
| kotlin_package_entry_mismatch | stage出力／copy／package入力／entryのpath・size・hash不一致。input invalid |
| kotlin_package_archive_mismatch | archive path・size／hash・package参照不一致。input invalid |
| kotlin_descriptor_mapping_invalid | 未知／重複plugin ID、properties、実装class対応不一致。input invalid |
| kotlin_package_literal_capture_unavailable | export時に一時MANIFESTの確認済みpublic slotから取得できない。input unverifiable |
| kotlin_package_literal_binding_invalid | literal fileのslot／recipe／profile／literal／consumer stage不一致、他用途への流用。input invalid |
| kotlin_package_literal_file_mismatch | 一時fileのsnapshot／blob／size／hashが固定literalと不一致。input invalid |
| kotlin_manifest_policy_unsupported | 動的manifest・未承認literal・custom serialize等。input unverifiable |
| kotlin_pipeline_budget_exceeded | いずれかの累積・file・entry・work上限超過。input unverifiable |
| kotlin_pipeline_unsafe_path | 境界外・symlink・特殊file・危険なZIP path。input invalid |

既存登録sessionの未終了・failed・重複・出自不一致は、既存plugin declarationの理由とmissing_assertion判定を継承する。Kotlinの入力不正と混同して原因を置き換えない。署名／multi-release／独自compiler plugin等の範囲外処理はrecipe_unsupportedへ分類する。

### 9.9 回帰テスト条件（KP01〜KP47）

次の条件は未実装のテスト仕様で、既存22件／188件を達成件数に加算しない。静的対照は対象edge以外を有効に保ち、期待reasonまで確認する。検査を削除すると対象テストだけが失敗する対照を用意する。

| ID | 条件 | 期待する主reason／結果 |
| --- | --- | --- |
| KP01 | 両consumer DSL×両Gradle×両producer×binary／precompiled、全stage実行 | 正常16構成。全entry被覆・宣言元・信頼metadata採用。9.2.1 precompiledのplugins-block cohort recipe（§9.4.1）が未成立なら、その4構成はkotlin_pipeline_recipe_unsupportedとし正常12構成 |
| KP02 | helper／plugin／pipeline／必要catalog trustを個別に無効化、旧trust | input検証は実行、宣言元全省略、relation維持。必要policyの理由 |
| KP03 | toolchain／loader／pipeline profileを個別に未承認、設定未知値・重複・不正digest、起動後env変更 | 未承認／設定不正のみではgraph不採用にしない。起動時固定 |
| KP04 | profile本文だけ変更、digest／選択実装／compiler版／JDK／option不一致 | kotlin_pipeline_profile_mismatch。別版のcache存在で通さない |
| KP05 | 標準Kotlin manifestに旧graph／adapter、空pipeline／entry／record、script-origin化 | kotlin_pipeline_schema_invalid／kotlin_pipeline_inventory_incomplete。Kotlin必要性を迂回しない |
| KP06 | malformed固定manifest、未知field、duplicate JSON key、参照切れ | kotlin_pipeline_schema_invalid。不要扱いへfallbackしない |
| KP07 | 別producer／invocationの一つのstage・cohort・blob refだけ流用 | kotlin_pipeline_producer_mismatch／kotlin_pipeline_invocation_mismatch |
| KP08 | begin前baseline後のsettings評価／先行taskでsource更新、不在入力出現 | kotlin_pipeline_inputs_stale。評価後の初回hashをbaselineにしない |
| KP09 | public libraries順序変更、compilerClasspathとrole交換、source要素の欠落・追加 | kotlin_derived_cohort_mismatch。集合が同じでも順序を無視しない |
| KP10 | 同じbasenameの異なるJAR／bin、cache layout変更、同bytes別path | 内容一致だけでownerを流用しない。明示cohortならlayoutへ依存しない |
| KP11 | library数とsnapshot数が異なる正常aggregate、確認済みpublic collection | cohort-author-attestedとして採用。一対一対応とは表示しない |
| KP12 | derived member欠落・追加・空集合、consumer内の重複所有 | kotlin_derived_inventory_incomplete。全部別cohortへ逃がさない |
| KP13 | public snapshot collection取得不能、未知Task.inputsの残り、別ArtifactViewで代用 | kotlin_derived_capture_unavailable／kotlin_pipeline_input_unclassified。診断collectionを採用しない |
| KP14 | source／derived digestは同じでもstage・policy・profileを交換 | kotlin_derived_cohort_mismatch。bindingDigestを再計算 |
| KP15 | export前に元cacheを変更、保存したderived blob／chunkの変更・削除・順序交換・size偽装 | export時の不一致はkotlin_derived_snapshot_stale、保存領域の不整合はkotlin_pipeline_snapshot_storage_mismatch。妥当な他fieldで検査対象へ到達 |
| KP16 | 18 MiB相当（64 MiB以内）のtoolchain-only snapshot、共有context多数 | 専用streaming経路で再検証、元外部pathはMCPが開かない |
| KP17 | 同じ大きいsnapshotをmixed／plugin入力cohortへ付け替え | kotlin_derived_source_classification_invalidまたはkotlin_pipeline_budget_exceeded。小さい区分の上限を維持 |
| KP18 | 4／64 MiB/file、256 MiB累積、通常64 MiB、chunk／entry／work境界±1 | 上限は通過、超過はkotlin_pipeline_budget_exceeded。profileで上限拡張不可 |
| KP19 | 同bytesの共有chunk、大きい区分→小さい区分の解析順と逆順 | 小さいrefの上限をcacheで迂回しない。結果・declared_inは順序非依存 |
| KP20 | cache／JDK／agentのalias、原pathのsymlink／特殊file／root外参照 | 正規化で同じ実体を照合。安全規則違反はkotlin_pipeline_unsafe_path |
| KP21 | adapter hashだけ変更、generatorだけcompile後へ移動、compile重複 | kotlin_stage_lineage_mismatch／kotlin_stage_receipt_incomplete。package順を同時に壊さない |
| KP22 | 必須compile／packageのskip・cache hit・failed、前回class残存、任意stageの正当非使用 | 必須はkotlin_stage_receipt_incomplete、出力残存はkotlin_pipeline_previous_outputs_present。確認したnot-applicableだけ許可 |
| KP23 | compile後に実class定数を変更、削除、extra class追加 | kotlin_package_entry_mismatch／kotlin_package_origin_incomplete。runtime JAR一致だけでは採用しない |
| KP24 | .kotlin_moduleだけcompile後変更、entryを未束縛へ変更 | kotlin_package_entry_mismatch／kotlin_package_origin_incomplete。class一致で通さない |
| KP25 | descriptorを生成後／processResources後に変更、未知ID／重複key／class不一致 | kotlin_package_entry_mismatch／kotlin_descriptor_mapping_invalid。元stageの正当性も検査 |
| KP26 | 通常resource・servicesを変更／追加／削除、同名2source、source pathを交換 | kotlin_package_entry_mismatch／kotlin_package_origin_incomplete。JAR集合の過不足を拒否 |
| KP27 | JAR内MANIFESTだけ一byte変更、literalをJAR内容から逆生成、任意attribute追加 | kotlin_package_entry_mismatch／kotlin_manifest_policy_unsupported。固定profile値から検証。一時file側の対照はKP37〜KP40 |
| KP28 | signed／multi-release JAR、独自CopySpec変換、resource merge／filter | kotlin_pipeline_recipe_unsupported。class以外を例外扱いしない |
| KP29 | package archiveだけpath／hash変更、runtime snapshotだけ変更 | kotlin_package_archive_mismatchと既存snapshot理由を対象検査ごとに確認 |
| KP30 | 同じclass/resource bytesの別stage／producer、所有元の重複、local-state偽装 | kotlin_package_origin_incomplete／kotlin_pipeline_producer_mismatch。hashだけでsourceを同一視しない |
| KP31 | 同一projectを明示clean・非incrementalで再export、元source／resource更新、古いstage／blob参照混入 | 新invocationは採用、旧refは拒否。前回artifactを現在compile出力へ混ぜない |
| KP32 | 途中保存失敗、既存同digest blob破損、companion更新前の中断 | 旧companion維持。破損blobを上書きして成功にしない |
| KP33 | plain／control／registeredのAction／依存Provider／未使用Provider、recipeが観測するsupplierの対照 | 可観測trace／回数／phase一致。成立しないrecipeは未対応 |
| KP34 | 復元された一時入力変更、内部transformの未観測動作 | 検出を保証せずlimitationsを維持。陽性証明へ数えない |
| KP35 | 複数context／lockのscript＋Kotlin、1 contextだけtrust／登録不足、非Kotlin単独scope | 部分declared_inを返さず、独立scopeに不要なpipeline trustを要求しない。mapping未表明の独立対照はKP41〜KP44 |
| KP36 | 本番実装後の3ツール、候補OSV再照会、trust無効／未承認／入力改変 | metadataと脆弱性coverageを分離。入力本文／snapshotをOSVへ送らない |
| KP37 | 両Gradle・両producerでJar公開入力に一時MANIFESTがあり、baseline／先行stage出力にはない正常系 | package-literal-fileで採用。自己stageの生成edge・循環・input_unclassifiedを発生させない。JAR entryのownerはprofile-literal一つ |
| KP38 | 一時MANIFESTをstage-output／physical-inputとして偽装、無関係file／resource／別Jar入力を専用型へ付け替え | kotlin_package_literal_binding_invalid。この型を外した対照だけが正常系を失敗させ、一般のDAG検査は維持 |
| KP39 | 一時fileだけを変更、JAR entryだけを変更、両方を同じ誤bytesへ変更、保存blobを削除 | file側はkotlin_package_literal_file_mismatch、entryだけはkotlin_package_entry_mismatch、保存blob削除はkotlin_pipeline_snapshot_storage_mismatch。固定literal不変、ZIP／他hashは対象検査まで整合させる |
| KP40 | public slot取得不能、別stage／recipe／literal ID参照、境界外path、export後の一時file削除 | 未取得はkotlin_package_literal_capture_unavailable、binding不一致はkotlin_package_literal_binding_invalid、危険pathはkotlin_pipeline_unsafe_path。保存snapshot・literal・JARが正常ならexport後のtemp削除だけでは失効しない |
| KP41 | pipeline／Kotlin specのmappingをそれぞれ省略／not-assertedとした新manifestで整合した新export | 有効schema、input_status=verified、missing_assertion、kotlin_source_mapping_assertion_missing。宣言元全省略・relation／introduced_by／coverage維持。defaultをmanifestへ書き戻さない |
| KP42 | mapping=null／false／未知文字列、assertions object欠落、buildInputs／mutation不正、旧schemaのmapping省略 | v4 Kotlinの不正値はkotlin_pipeline_schema_invalid。mapping subkey省略との独立対照。非Kotlin／v1〜v3は現行schema挙動を維持 |
| KP43 | mapping未表明に、source ID欠落／参照切れ／stage hash不一致を一つずつ追加。mapping変更前のcompanionも別対照 | schema不正はkotlin_pipeline_schema_invalid、edge破損はkotlin_stage_lineage_mismatch、baseline／古いmanifest digest不一致はkotlin_pipeline_inputs_stale。未表明でinput検査を短絡しない |
| KP44 | pipelineとspecの片側だけreviewed、graph診断だけreviewedへ変更、一つのcontributing contextだけ未表明、非Kotlin独立scope | raw manifestからAND再計算し、未表明contextのkotlin_source_mapping_assertion_missingを保持。scriptだけの部分一覧を返さず、独立scopeの既存信頼を変更しない |
| KP45 | 9.2.1 precompiledのplugins-block-compileの派生入力をplugins-block-classpath cohortで束縛、cohortを外す、kotlin-compileのcohortへ付け替える | recipe成立時は採用。cohortなしはkotlin_pipeline_input_unclassified、付け替えはkotlin_derived_cohort_mismatch。recipe未成立ならkotlin_pipeline_recipe_unsupported |
| KP46 | NO-SOURCEのcompileJava（Java source不在・出力空）、Java sourceを一件追加、Java classes rootのfileをpackage入力へ追加、他taskをこのroleへ偽装 | 正常系はnon-contributing-java-compileとして採用。それ以外はkotlin_pipeline_recipe_unsupported、偽装はkotlin_stage_lineage_mismatch |
| KP47 | physical／stage-output／toolchain／derived／package-literal-fileの各保存blobを削除・改変、export時の取得不能を別対照 | 保存領域はどの型もkotlin_pipeline_snapshot_storage_mismatch、取得不能は型ごとのcapture_unavailable。両者を混同しない |

KP09〜KP20の公開collection／recipeの成立、全非class entryの対応、一時MANIFEST専用slot（KP37〜KP40）とnon-interferenceは新しいnative実証を必要とする。静的manifest操作だけで公開APIの取得可能性を証明しない。新実証では正常・不採用・未取得を別々に保存し、recipe／profile本文、元sourceとcollectorのhash、選択実装、実行設定、実際のcapture phase、reason、予算実測を記録する。

この設計の次工程はrecipeとpackage entry被覆の公開API実証、そのレビュー、成立範囲だけの本番v4／v6実装、最後に3ツール実接続。現行188件／版や22件のsource hash・検証JSONは今回変更しない。


### 9.10 設計レビュー2件の反映範囲

§9.6.1で一時MANIFESTを事前固定literalへ結ぶpackage専用file型を追加し、public入力の完全分類とDAGの循環禁止を両立させた。§9.3.1でmapping未表明の有効なschemaを定義し、表明不足と参照・hash・型の破損を分離した。拒否理由3種と未表明理由1種、KP37〜KP44を追加した。今回も設計とテスト条件のみで、本番schema・collectorの実装、新規API実証、既存観測JSONの更新は行っていない。

### 9.11 9fbd9edレビュー3件の反映範囲

保存済み観測との照合で見つかった3件を反映した。§9.4.1で9.2.1 precompiledのplugins-block-compileの派生入力に別cohortを定義し、recipe未成立時は当該構成を初期対象外とする。§9.3で全観測に現れるNO-SOURCEのcompileJavaをnon-contributing-java-compileとして閉じた条件で扱う。§9.5でexport時の取得不能と、MCPが読むときの保存領域の不整合を分け、共通のkotlin_pipeline_snapshot_storage_mismatchを追加した。KP45〜KP47を追加し、合計47条件。設計とテスト条件のみで、本番コード・実証コード・観測JSONは変更していない。


### 9.12 具体化した契約の公開API実証（2026-11-01）

以下は初回実証の結果。レビュー修正後の再検証は§9.13を参照する。検証JSONの主観測は再検証で更新し、初回のsource hash・観測件数等は`preReview`へ保持する。

**現方式は新pipeline契約への採用不可。** KGPの公開collectionからsnapshotを取得できることと、評価時刻・実行回数を維持できることを分離した。両Gradle版の独立supplier対照で、post-taskの`libraries.files`／snapshot collectionの読み取りを加えると、libraries supplierがcompile後に一回余分に評価された（control 3回、observer 4回）。したがって`kgp-snapshot-collection-v1`は取得可能性の実証に留まり、非干渉のrecipeとしては未成立。固定profileを承認するだけではこの差を無視できない。

本番adapter・reader・schema・起動時信頼設定は変更していない。新しい実証はtest-onlyで、既存helper／loaderの宣言元候補が成立しても新契約の採用には数えない。検証JSONの`contractDecision.adopted=false`を参照する。既存の`gradle-kotlin-plugin-2026-11-01.json`は変更しない。

#### 取得と対応付けで確認した事項

| 対象 | 観測と判定 |
| --- | --- |
| compile-classpath | KGP 2.0.20／2.2.20の公開`KotlinCompile.libraries`と`classpathSnapshotProperties.classpathSnapshot`をpost-taskで取得。公開iteration順をそのまま記録し、basenameによる一対一対応は推定しない。実際にlibrariesとsnapshotの個数は異なる |
| 選択実装 | 実際に適用されたPlugin instanceのclass／CodeSourceを記録。KotlinPluginWrapper／KotlinDslPluginを準備済みtoolchainの実fileへ対応付け、compilerClasspathも別の公開Configurationから記録。cacheに存在する全JARだけで選択を推定しない |
| 実行設定 | 実タスクのincremental=false、executionStrategy=IN_PROCESS、fallback=falseを確認。compile直前のclasses rootは空。旧collectorのstage実行・元source／生成adapter／archive／load検査も実行 |
| 大きいderived file | Gradle API snapshotを1 MiB単位で読み、hash付きchunkへ保存して独立再読込。外部cacheの元pathを静的再検証側が開かない。大きいrefを通常4 MiB区分へ付け替える対照は拒否 |
| 非class entry | `.kotlin_module`、plugin descriptor、通常resource、services、MANIFESTを含む全entryを棚卸し。descriptorの公開plugin ID／implementationClass、生成descriptor→processResources→Jarの対応も照合。MANIFESTを除く各entryはcompile／resources出力に対応し、resourcesはbaselineまたはdescriptor出力へ遡る |
| 一時MANIFEST | 実Jarのpublic temporaryDir、public input membership、post-taskのfileを照合。`Manifest-Version: 1.0\r\n\r\n`を実行前に固定し、fileとJAR entryを別々に検証。fileはbaseline／先行stageの出力ではなく、自己DAG edgeを作らない |
| 保存内容 | snapshotの改変・削除をnative fixtureの実保存fileで拒否。別の静的対照でchunk順序・size・hash不一致を`kotlin_pipeline_snapshot_storage_mismatch`へ分類 |
| NO-SOURCE Java | compileJavaの実noSource、Java source不在、Java classes出力空を記録。任意のskipを成功compileへ昇格させない |
| plugins-block | Gradle 9.2.1 precompiledの役割付きsource／derived collectionを取得する公開recipeは未成立。internal Task型のgetterやTask.inputsの未分類残りをcohortへ偽装しない。対象4構成はこれも追加の不採用理由 |
| mapping | 新contract用assertion specimenでpipeline／contributing specのAND、mapping省略／not-asserted、null／boolean／未知値、必須assertions不正、入力破損との分離を検証。本番v4 schema parser・raw manifest digest照合・複数context併合の実装ではない |

公開getterの存在は[KGP 2.0.20の実装](https://github.com/JetBrains/kotlin/blob/v2.0.20/libraries/tools/kotlin-gradle-plugin/src/common/kotlin/org/jetbrains/kotlin/gradle/tasks/KotlinCompile.kt)と[KGP 2.2.20の実装](https://github.com/JetBrains/kotlin/blob/v2.2.20/libraries/tools/kotlin-gradle-plugin/src/common/kotlin/org/jetbrains/kotlin/gradle/tasks/KotlinCompile.kt)を照合した。`@Internal`というGradle入力annotationと、Kotlinのinternal可視性は区別する。利用したsnapshot getterはpublicで、非公開の`$kotlin_gradle_plugin_common` getter、Gradle internal task型、追加ArtifactViewは使っていない。APIが公開であることだけではsupplierの非干渉を保証しない。

#### 実行結果

[機械可読の検証記録](validation/gradle-kotlin-pipeline-2026-11-01.json)には、Groovy／Kotlin consumer × buildSrc／included root producer × binary／precompiled Kotlin × 両Gradle版の正常16観測と、実class差し替え4観測を保存した。新規pipeline検査を有効にしたnative回帰は各版284件（既存188件を含む）、独立supplier対照は各版1件が成功した。「テスト成功」は不採用の検出を含み、新契約の成立件数ではない。

| Gradle | libraries／snapshots | 最大snapshot | 保存読込bytes／chunk参照 | 新契約採用 |
| --- | --- | --- | --- | --- |
| 8.11.1 | 25／23 | 18,451,885 bytes | 28,184,803 bytes／47 | 0／8 |
| 9.2.1 | 22／20 | 18,858,585 bytes | 29,312,702 bytes／44 | 0／8 |

静的specimenは29件、通常の全体テストは1,823件成功・native opt-in等1,072件skip。型チェックとbuildも成功した。

表の読込予算はderivedと一時MANIFESTの専用observer分。旧collectorのtoolchain／stage hash読込を含む全exportの総費用ではない。各数値は正常fixtureごとに一致した。

#### 回帰条件との対応と未実証範囲

今回の実証はKP01〜KP47すべての達成ではない。次の「部分」は各条件の一部の対照のみで、本番readerの成立へ読み替えない。

| 条件 | 今回の範囲 |
| --- | --- |
| KP01、KP11、KP13、KP45 | matrixの取得・全entry対応と正常入力を観測。全構成の新契約採用は非干渉gateで不可。9.2.1 precompiledにはplugins-blockの公開recipe不足もある |
| KP15〜KP19、KP47（部分） | derivedのstreaming保存・再検証、約18 MiB実入力と19 MiB合成入力、通常区分の上限維持、改変・削除・順序・size・hash対照。全入力型・全予算境界・全context順序は未実装 |
| KP22、KP23、KP46（部分） | 空classes root、NO-SOURCE Javaを観測。既存の実class差し替え4 fixtureも新設定で再実行。全skip／reuse／Java追加／role偽装対照は未実装 |
| KP24〜KP27、KP30（部分） | 実JAR全entry対応と、解析済みentry一覧のmetadata／descriptor／resource／service／MANIFEST hash変更・未所有entry追加を拒否。非classを実disk上で変更する各stageのnative対照は未実施 |
| KP33 | matrix内の依存Provider／Actionの旧対照を維持。独立したpublic FileCollection supplier対照は両版とも追加評価を検出し、recipe非干渉は不成立。対照が再現したのはlibraries／snapshot collectionの読み取りだけで、実observerの`Task.inputs.files`・`kotlinCompilerClasspath`・`project.plugins`・Jarの`Task.inputs.files`は含まない（§9.14）。snapshot内部supplierすべてのtraceは観測していない |
| KP37〜KP40（部分） | 一時MANIFESTのnative public slot、固定literal三者照合、別stage／recipe／slot／root／public input不足、fileのみ／entryのみ／両者同じ誤bytesの拒否。生産schemaのproducer／invocation／profile bindingとexport後temp削除は未実装 |
| KP41〜KP44（部分） | assertionの小さいspecimenのみ。省略と型不正の分離、片側未表明、入力検証の非短絡。生産manifest、参照edge、旧schema、graph／coverage／context併合の対照は未実装 |
| その他（KP02〜KP10、KP12、KP14、KP20〜KP21、KP28〜KP29、KP31〜KP32、KP34〜KP36） | 新v4契約としては未実施。旧実証のprofile／loader／registration検査を新契約の成立証拠へ流用しない |

snapshot保存先は実証専用の`.proof/pipeline-blobs`であり、§9.5の本番保存schema・atomic companion更新・全型の安全なpath検証・全予算実装を証明しない。mapping specimenも完全なschema validatorではない。load済み実行bytecode、内部transform、途中で変更して復元された入力は引き続き独立観測できない。

#### 再現

JDK 21と対象Gradle、対応する標準kotlin-dsl／KGP／compiler依存を準備し、キャッシュ済み状態で実行する。`GRADLE_USER_HOME`を共有するnative検証と通常の全体テストは分ける。次をGradle 8.11.1／9.2.1それぞれで実行する（環境変数には各環境の実pathを設定）。

```sh
OSV_MCP_KOTLIN_PIPELINE_PROOF=1 OSV_MCP_GRADLE_KOTLIN_OUTPUT=/tmp/kotlin-pipeline-proof npx vitest run src/test/gradle/kotlinPlugin.integration.test.ts --maxWorkers=1 --hookTimeout=120000
OSV_MCP_KOTLIN_SUPPLIER_OUTPUT=/tmp/kotlin-supplier-9.2.1.json npx vitest run src/test/gradle/kotlinPipelineSupplier.integration.test.ts --maxWorkers=1 --hookTimeout=120000
```

supplier出力のsuffixは実行版に合わせる。`OSV_MCP_TEST_GRADLE`、`JAVA_HOME`、`GRADLE_USER_HOME`を設定しない実行をnative証拠へ数えない。両版の出力をまとめる手順と静的テストは次のとおり。

```sh
node src/test/manual/gradleKotlinPipelineResults.mjs /tmp/kotlin-pipeline-proof /tmp/kotlin-supplier docs/validation/gradle-kotlin-pipeline-2026-11-01.json
npx vitest run src/test/gradle/kotlinPipeline.test.ts
```

集約ハーネスは正常16観測と両版のsupplier結果の存在、観測collector／verifierのsource hash一致を確認し、旧候補と新契約の不採用を別々に記録する。sourceを変更した場合は元観測を再取得する。次工程は、supplierを追加評価しない取得契約の再設計・実証とplugins-block用公開recipeの検討。非干渉の対照は、再設計後のobserverと同じ読み取りをすべて行って取る。そのレビュー前に本番v4／v6を有効化しない。


### 9.13 公開API実証レビュー2件の修正・再検証（2026-11-01）

#### 期待entryの欠落

package検証は、コピー後の出力に存在するfileだけを起点にしない。baselineの`src/main/resources`、生成descriptor、compile出力から期待entryを組み立て、対応するprocessResources出力・Jar入力・JAR entryを照合する。MANIFESTは事前固定literalの必須entryとして、ちょうど一つ存在することも検査する。期待したresourceがコピーされず、出力・Jar入力・entryがすべて欠けた場合も`kotlin_package_origin_incomplete`になる。実際のコピー出力だけを減らして期待集合も縮めることはできない。

静的対照では、修正前にMANIFEST欠落と、通常resource／services／descriptorの未コピーを再現して失敗を確認し、修正後に拒否を確認した。native matrixでは正常な実観測を複製してMANIFEST・resource・services・descriptor・`.kotlin_module`・classを個別に欠落させる。resource系はbaseline／生成descriptorを残し、コピー出力・Jar入力・entryを同時に削る。各対照の拒否理由を`pipeline.expectedEntryRejections`へ保存する。非classを実diskで欠落させる各stageのnative対照まで追加したものではなく、公開API実観測に基づくinventory対照である。

#### supplier観測の実行版・source hash・trace

独立supplierハーネスは、実際にprecompiled pluginを適用するGroovy／Kotlin consumerと、included `build-logic` producerを作る。各consumerでcontrol／observerを実行し、信頼された呼出し側が各runの前にproducer出力を明示的に削除する。

- 実行前にharness・collector・共有verifier・型宣言のsource hashと、consumer／producerの物理入力hashを固定し、run前後にも照合する。
- Gradle collector自身が実`gradle.gradleVersion`、run UUID、observe設定、collector hash、実fixture fileのhash、traceを観測時に保存する。consumer DSLは実行中のGradle状態の観測ではなく、consumer rootに`build.gradle.kts`があるかどうかから判定する（fixture fileのhashは別途照合する）。run UUIDを照合し、前回のreportを流用しない。
- `osv-mcp.kotlin-supplier-proof-v2`に観測を保持し、両DSLを持つ`osv-mcp.kotlin-supplier-matrix-v2`へまとめる。単なる出力ファイル名から版を付け直さない。
- native実行と集約ハーネスは同じ`verifySupplierProof`／`verifySupplierMatrix`を使う。実版・起動mode・source hash・fixture hash・runの一意性と、compile前後の厳密なtraceを照合する。
- controlの3評価とobserverの4評価、compile前からcompile終了まで同じprefix、compile後の追加1評価を要求する。任意の異なるtrace、phase欠落・重複、compile中の追加評価、旧report、別版、古いsource hashは拒否する。集約時の現在hashを過去のsupplier結果へ書き込んで鮮度確認済みにしない。

これらは信頼された検証runnerの来歴・再現性の確認であり、署名された実行証明ではない。sourceや実行bytecodeの一時変更・復元、KGP内部supplierすべてのtraceは独立観測できない。compile-classpathのgetter追加評価は引き続き契約不成立で、全構成の新pipeline採用は0件。9.2.1 precompiledのplugins-block用公開recipe不足も維持する。mappingは§9.12の限定したassertion specimenのままで、本番v4 parser・raw digest／context併合の実装へ範囲を広げない。

#### 再現と検証データ

§9.12のnativeコマンドを各版で再実行する。supplier出力は同一版の両DSLの結果を一つのファイルへ保存するため、`-t`で片方だけ実行したreportを正常matrixとして集約しない。集約は旧reportや不足したDSLを拒否し、source hashが変わった場合は観測を再取得する。

```sh
npx vitest run src/test/gradle/kotlinPipeline.test.ts src/test/gradle/kotlinSupplierProof.test.ts
```

[検証JSON](validation/gradle-kotlin-pipeline-2026-11-01.json)の主観測は修正後のsource hashへ更新する。`preReview`は初回のsource hash・観測件数・元JSONのhashを保持する要約で、初回supplier結果に実行時の版／source hashの結び付けがなかったことも明記する。初回の検証JSONはコミットしていないため、`preReview.recordSha256`はリポジトリ内の記録と照合できない参考値である。


#### 修正後の実行結果

| 検証 | 結果 |
| --- | --- |
| Gradle 8.11.1 matrix（両consumer DSL・両producer・両Kotlin形式） | 332件成功、終了処理も成功 |
| Gradle 9.2.1 matrix（同上） | 332件成功、終了処理も成功 |
| supplier観測（各版のGroovy／Kotlin consumer） | 各版2件成功。4組ともcontrol 3回／observer 4回 |
| 期待entry欠落の保存結果 | 正常16観測×6種類、計96対照を拒否 |

8.11.1の初回再検証は機能検査332件が通過したが、終了時のfixture削除が既定の10秒を超えてsuiteは失敗した。`--hookTimeout=120000`で単独再実行し、終了処理を含めた332件成功を確認した。失敗した実行を成功件数へ二重計上しない。更新した主観測の8.11.1データはこの単独再実行の結果である。

静的なpackage／supplier／集約回帰は計56件、通常全体は1,850件成功・native opt-in等1,073件skip。型チェック・buildも成功。本番adapter・reader・schema・信頼設定の変更はなく、採用0件の判定を維持する。


### 9.14 340facdレビュー修正（2026-11-01）

#### supplier対照の範囲

§9.13の独立supplier対照がcompile後に読むのは`KotlinCompile.libraries.files`と`classpathSnapshotProperties.classpathSnapshot.files`だけである。実際のpipeline observerはcompileKotlinで`Task.inputs.files`・`kotlinCompilerClasspath`・`project.plugins`も読み、Jarでも`Task.inputs.files`を読む。`Task.inputs.files`にはlibrariesも含まれるため、実observerでの追加評価は「3回→4回」より多い可能性がある。この結果は追加評価の下限であり、実observer全体の回数ではない。

現recipeの不採用は変わらない。次の再設計で非干渉を主張するには、そのobserverが行う読み取りをすべて対照で再現し、control／observerのtraceを比べる。読み取りの一部だけを再現した対照で非干渉を成立扱いにしない。

#### 期待entry欠落の保存内容

native回帰は、assertが通った後に固定の理由文字列を保存していた。集約ハーネスはその定数を照合するだけで、実際の判定を確かめていなかった。修正後は、各対照の`assessPipelinePackage`の結果（`complete`と`reasons`）をそのまま`pipeline.expectedEntryRejections`へ保存する。集約側は6種類それぞれについて`complete=false`かつ`reasons`に`kotlin_package_origin_incomplete`が含まれることを要求する。固定理由だけの旧形式、受理された結果、別の理由だけの結果は拒否する。

Gradleは再実行していない。保存済みの正常16観測に対し、native回帰と同じ欠落操作を静的に適用して`assessPipelinePackage`を再計算した。96対照すべてが`complete=false`、理由は`kotlin_package_origin_incomplete`のみで、検証JSONの`postReviewRevision.expectedEntryRejectionsRecomputed`に保存した。主観測の`expectedEntryRejections`は旧形式のまま残し、書き換えない。

#### 集約ハーネスの実行場所

集約ハーネスはリポジトリ内のsourceと`git rev-parse`をcaller側の作業ディレクトリから解決していた。修正後はハーネス自身の位置からリポジトリrootを求める。引数の観測・supplier・出力pathは従来どおりcaller基準である。

#### 検証

| 検証 | 結果 |
| --- | --- |
| 静的なpackage／supplier／集約回帰 | 59件成功（リポジトリ外を作業ディレクトリとする集約4件と、期待entry証拠の形式3件を含む） |
| 修正前の集約ハーネスでの対照 | 作業ディレクトリ依存の4件と、固定理由の受理1件が失敗することを確認 |
| 保存済み観測からの再計算 | 正常16観測×6種類、計96対照を拒否 |

native matrixとsupplierは再実行していない。統合テストと集約ハーネスのsource hashが変わったため、主観測は修正前sourceの結果として扱う。新しく集約し直すにはnative観測を再取得する。supplierのsourceは変更しておらず、supplier観測は引き続き有効である。


### 9.15 全observerを対象とする入力取得方式の再設計（2026-11-01）

以下は初回v1実証の記録。レビュー修正後のv2再検証は§9.16を参照する。検証JSONの主観測はv2へ更新し、初回のsource hash・件数の要約を`preReview`へ保持する。

#### 透過的な取得とproducerが宣言する固定化契約を分離する

通常のlive FileCollectionをexport時に読み直す方式では、supplierを追加評価しないことを一般には保証できない。observerから`finalizeValue()`／`finalizeValueOnRead()`を呼ぶ対処も、元のbuildの評価回数・変更可能期間を変え得るため、透過的な取得とはしない。`Provider.map`等で既存Providerを包み替えたり、内部のtask input snapshotへアクセスしたり、別ArtifactViewで値を取り直す方式も採用しない。

今回の候補は、**producer自身が入力を作成するときに、最初の自然な読取で固定化する契約を明示する方式**である。同じproducer設定を持つcontrolとobserverを比較し、observerは公開getterの読取・物理fileのhash取得だけを行う。固定化設定はobserverの有効／無効から独立し、observerの実行前から両方に存在する。通常buildに設定を注入して「非干渉になった」とは扱わない。

公開APIの[`HasConfigurableValue.finalizeValueOnRead()`](https://docs.gradle.org/current/javadoc/org/gradle/api/provider/HasConfigurableValue.html#finalizeValueOnRead())は、次の読取で値を計算してsourceを追跡しなくする。ただし値のdeep immutabilityやfile内容の不変を保証しない。今回のfixture factoryはconcreteな空file listを返す計測用supplierと、標準kotlin-dslが持つ実際の非空classpath／snapshot／source／Jar入力を併用する。任意のFileTree・入れ子のlive collection・任意pluginのProviderへ保証を一般化しない。

| 条件 | Producer設定 | observerの処理 | 判定の意味 |
| --- | --- | --- | --- |
| raw | liveな計測用file collections | reader全体を実行 | 追加評価を検出する負例。通常buildの透過対応は成立扱いにしない |
| owned | 計測用collectionsを作成時に`finalizeValueOnRead()`で宣言。fixtureではinit scriptが注入し、KGPのlibraries／snapshot collectionは既存collectionへの事後固定化（§9.17） | 同じreader全体を実行。readerは固定化・置換・wrapを行わない | 同じowned baselineに対する、計測したsupplier／callbackの非干渉候補 |
| tainted | ownedに未固定のTask.inputs／Jar source Providerを混在 | 実験上はreader全体を実行して差を検出 | 登録完全性を仮定できない入力の負例。本番で未知の入力を試し読みする設計ではない |

#### 登録adapterの契約案

将来のproducer helperは、既存Providerの事後wrapではなく、producerが所有するfile collectionの作成時に登録する。最低限、producer／task／role、実collectionへのhandle、sourceの許可形式、最初の自然な読取で固定化するlifecycle、宣言元とsource hash、profile digest、完全列挙・export中不変の作者表明を結ぶ。supplierの戻り値として許可する具体的なfile値と、liveな入れ子・treeを許可しない条件もprofileへ定義する必要がある。

固定化してもfile bytesは変わり得るため、従来のbaseline・stage・package hash照合とsnapshotの保存／再検証は維持する。librariesとderived snapshotの対応は引き続きaggregateであり、個別JAR由来を推定しない。

`Task.inputs.files`から、未登録のsupplierが存在しないことを値の取得前に独立検証する公開APIは今回確立していない。したがって作者による完全列挙と、レビュー済みproducer source／toolchain／recipe profileへの追加の信頼が必要になる。登録漏れ・未知のCopySpec・profile未承認時には、本番の設計上はgetterを試し読みせずcapture unavailableとし、宣言元を省略する。現行信頼設定の意味を拡張したり、単なる`mode=owned`を本番の採用証拠にしたりしない。

今回の登録処理はfixture内の試作で、一般向けadapter、起動時設定、新manifest schema、本番v4／v6を実装・有効化したものではない。旧条件を満たしたことにして本番へ進めず、追加契約のレビューを先に行う。

#### 実際に実行するreader全体

`gradle-kotlin-observer.init.gradle`の`readTask`を実observerそのものとし、全modeで同じ関数を呼ぶ。対照だけの縮小版は作らない。source hashを固定するため、readerを変更した場合は対照を取り直す。

| 対象 | 公開API／物理取得 |
| --- | --- |
| compileKotlin | incremental／executionStrategy／fallback、libraries、classpathSnapshot、kotlinCompilerClasspath Configuration、project.pluginsの型／CodeSource、Task.inputs.files、Task.outputs.files |
| Jar | public temporaryDirと一時MANIFEST、archiveFile、Task.inputs.files、Task.outputs.files |
| pluginDescriptors | gradlePlugin.pluginsのID／implementationClass、Task.inputs.files／outputs |
| processResources・他の実行stage | Task.inputs.files／outputs。inputsは元collectorと同様didWork時だけ取得 |
| compileJava NO-SOURCE | state・公開outputs、物理Java出力の不在。成功compileへ昇格させない |
| compile直前 | 物理classes root・Java sourceの棚卸し |

public APIで列挙したfileを1 MiB bufferでhashする。同じ物理fileのhash結果はstat付きで再利用するが、API getterの呼出しを抜いて対照を成立させることはしない。このproofはdigest receiptを作る試作で、§9.5の本番chunk storage・全共有予算を実装したものではない。

#### 対照・phase・来歴

対象はGroovy／Kotlin consumer、included-build rootのbinary Kotlin plugin、標準kotlin-dsl、Gradle 8.11.1／9.2.1。producer DSLはKotlin固定。buildSrc・precompiled Kotlin・plugins-blockの新しい取得方式まで確認したmatrixではない。

7種類の計測用supplier（libraries、compilerClasspath、compile input／output、Jar source／input／output）、未使用Provider、task Action、plugin適用、declaration実体化を記録する。taintedでは未固定input／Jar sourceも記録する。control／observerのtrace全体、phase、順序、生成JARの全entry内容を比較する。ownedのcontrolとrawのcontrolも比較し、固定化が元の評価回数を変えた事実を隠さない。

初期の広い対照で、Gradle 8.11.1のcompile中に別taskが進み、共有phase変数が上書きされることを確認した。最終計測はthreadごとのcontext stackでtask終了時に元のcontextへ戻し、worker数1・parallel無効を固定して実値を記録・検証する。`configuration-or-unbound`はtask contextがないことを示し、内部workerのengine phaseを推測しない。評価時刻の比較はこのcontextと順序であり、wall-clock時刻の一致ではない。

harness・reader・verifierと依存helperのsource hashをrun前後に照合し、Gradle自身の実版・collector hash・mode・run UUID・fixture hash・worker条件を保存する。consumer DSLはfixture fileからの判定であり、実行中のGradleモデルからの独立検証とは区別する。集約側は自身の位置からrepo rootを求め、実版とsource hash、全6条件／版、実際のtraceから判定を再計算する。

計測用compiler依存を単純追加した初期試行は、KGPのdefault compiler依存を抑制してbuildが失敗したため除外した。修正後は公開`withDependencies` callbackで既定依存の後に計測用file依存を追加する。順序の調査では[Gradle 9.2.1の実装](https://github.com/gradle/gradle/blob/v9.2.1/platforms/software/dependency-management/src/main/java/org/gradle/api/internal/artifacts/configurations/DefaultConfiguration.java)も参照したが、実行するcollectorは内部APIを呼ばない。

#### 再現

JDK 21、該当Gradleと標準kotlin-dsl／KGPのoffline cacheを準備し、`OSV_MCP_TEST_GRADLE`・`JAVA_HOME`・`GRADLE_USER_HOME`を指定する。nativeは通常の全体テストと分けて実行する。次を各Gradle版で実行し、出力suffixを実版に合わせる。

```sh
OSV_MCP_KOTLIN_OBSERVER_OUTPUT=/tmp/kotlin-observer-8.11.1.json npx vitest run src/test/gradle/kotlinObserver.integration.test.ts --maxWorkers=1 --hookTimeout=120000
node src/test/manual/gradleKotlinObserverResults.mjs /tmp/kotlin-observer docs/validation/gradle-kotlin-observer-2026-11-01.json
npx vitest run src/test/gradle/kotlinObserver.test.ts
```

`OSV_MCP_OBSERVER_MODES`や`-t`で絞った実験は診断用で、正常な全matrixへ数えない。失敗時の`.raw.json`は診断用であり、集約は両版の完全なmatrixだけを受け付ける。

計測したcallbackの非干渉が成立しても、すべてのGradle／KGP内部supplierの実行回数・内部transform・実行bytecode・一時的なfile改変と復元を独立観測したことにはならない。追加契約の適用可能性、完全な登録inventory、buildSrc／precompiled、snapshot保存、mapping／context併合、本番schema／readerと3ツール／OSVは引き続き別gateである。


#### 実証結果

[機械可読結果](validation/gradle-kotlin-observer-2026-11-01.json)に、両Gradle版×両consumer DSL×3条件の12対照、計24回のcontrol／observer buildを保存した。各版のnative回帰8件、静的回帰28件が成功。通常全体は1,881件成功・native opt-in等1,081件skipで、型チェック・buildも成功した。

| 条件 | 4組（両Gradle×両DSL）の結果 | 本番採用 |
| --- | --- | --- |
| raw | 全組でlibraries・compilerClasspath・Jar sourceに各1回の追加評価 | 0 |
| owned | 全組でtrace完全一致。計測用7 supplierはcontrol／observerとも各1回。JAR全entry内容も一致 | 0（追加producer契約の条件付き候補4組） |
| tainted | 全組で未固定compile input・Jar input・Jar sourceに各1回の追加評価 | 0 |

rawのcontrolではlibrariesが3回、compilerClasspathが2回、Jar sourceがGradle 8.11.1で4回・9.2.1で3回で、observer有効時はそれぞれ1回ずつ増えた（libraries 4回、compilerClasspath 3回、Jar source 8.11.1で5回・9.2.1で4回）。ownedはこれらも1回へ固定されており、元のbuildの評価契約と同じではない。同じfixture source・同じJAR entry内容であっても、この差を透過的と呼ばない。native回帰でもraw／ownedのcontrolの回数差を確認する。

Task.inputs.files・compilerClasspath・plugins・Jar入力だけを抜き出した縮小対照ではなく、記録したreader全体を実行した結果である。ただし計測用callbacks以外のすべての内部supplierを観測した保証はない。一般向けの完全登録adapter、source形式の強制、profile承認とfail-closed判定、本番入力manifest／snapshot取込は未実装である。次は、この限定したproducer契約を採用するかの設計レビューを行い、必要ならnonempty／入れ子・treeの制限、buildSrc・precompiledの対照へ進む。既存の信頼設定や本番schemaは変更しない。


### 9.16 producer固定化実証レビュー2件の修正・再検証（2026-11-01）

#### compilerClasspathを含む全登録区間の評価拒否

7種類のsupplierそれぞれに`registration:begin/end:<role>`を設け、compilerClasspathのfactoryとcallback登録も`policy:begin/end:compilerClasspath`で囲む。共有verifierは、対応するpolicy内に登録区間が一つずつあり、task実行前の同じcontextで閉じ、区間内にsupplier評価がないことを要求する。登録終了より前のsupplier呼出しも拒否し、owned／taintedの登録済みsupplierは各1評価であることを確認する。

以前はcompilerClasspathのfactoryがcompileKotlin／Jarのpolicy区間外にあり、`finalizeValueOnRead()`を`finalizeValue()`へ変えても回帰が通過していた。今回はfixture専用の`eagerCompiler` fault injectionで同じ変更を実際に行う。control／observerのtraceが同じでも、登録中の評価を`observer_policy_early_evaluation`として拒否する。flagの有無だけで負例を成立させず、実traceの登録区間に対してこの判定が発生することを検証する。

両Gradle版・両consumer DSLの4負例で、各々control／observerをbuildして全receiptを取得する。共有matrix verifierと集約は負例のproofを再検証し、同じ早期評価理由で拒否されることを要求する。証拠欠落等の別理由による失敗を早期評価の成功へ数えない。

#### 全observerの必須証拠

共有verifierへnative test内だけにあった検査を移した。compileKotlin／Jarの一部の配列だけで候補判定せず、このbinary fixture profileでは次を必須にする。

| receipt | 必須の証拠・条件 |
| --- | --- |
| pre-compileKotlin | classesとJava sourceの棚卸しが存在し、いずれも空 |
| compileKotlin | didWork／noSource、非incremental・IN_PROCESS・fallback無効、libraries／snapshots／compilerClasspath／plugins／Task inputs・outputs |
| compileJava | NO-SOURCE・didWork=false、Task inputs・outputs、Java出力の棚卸しが空 |
| pluginDescriptors | 実行状態、ID=proof／implementationClass=proof.Proof、Task inputs・outputs。file入力は空でも配列の存在が必要 |
| processResources | 実行状態、非空のTask inputs・outputs |
| Jar | 実行状態、temporaryRoot・manifest・archive、Task inputs・outputs。manifestのhash／sizeをpublic inputとJAR entryに結び、archiveのhashをpublic outputへ結ぶ |

receiptの欠落・重複、必要field／readSlotsの欠落は`observer_read_inventory_incomplete`、不正な実行設定・残存出力・不整合なfile証拠等はそれぞれの理由で拒否する。control側にはobserver receiptを要求せず、追加読取を入れて対照を汚染しない。

通常12対照それぞれで23種類の必須証拠を削り、計276件の拒否をnativeハーネス内で確認した。各`evidenceRejections`は実際のverifierの返却／例外から`accepted`と`reason`を記録し、集約側でも同じ欠落操作とverifier呼出しを再計算する。単なる保存済み理由文字列の照合で終わらせない。旧compile／Jarだけの縮小証拠を受理する対照と、compilerClasspathの早期評価対照は修正前に失敗を確認した。

これは固定fixtureの証拠検証であり、一般向けの本番manifest parser・全入力所有権の独立検証へ範囲を広げない。登録完全性、任意のlive tree／内部supplierの非干渉、buildSrc／precompiled、snapshot保存・静的取込等の未成立条件は維持する。

#### v2の記録と実行結果

case／run／matrixを`v2`へ更新し、source hashと実版に加えて実際の`eagerCompiler`設定、登録区間、全receiptを結ぶ。通常6条件／版と早期評価負例2条件／版が揃わないmatrix、旧形式、負例の別理由失敗は集約しない。[検証JSON](validation/gradle-kotlin-observer-2026-11-01.json)の主観測は修正後のsourceで再取得した結果である。`preReview`のv1要約は履歴であり、現在の成立証拠として流用しない。

| 検証 | 結果 |
| --- | --- |
| Groovy／Kotlin consumer × Gradle 8.11.1／9.2.1 | 各版native 10件成功、終了処理も成功 |
| 通常のraw／owned／tainted | 12対照・24 build。ownedの条件付き4候補、raw／taintedは追加評価あり |
| compilerClasspath早期評価 | 4負例・8 build、すべて正しい理由で拒否 |
| 全必須証拠の欠落 | 23種類×12対照、計276件を拒否・集約で再計算 |

合計32 native build。今回も、既存buildへの透過対応は未成立、本番採用は0件である。再現コマンドは§9.15と同じで、通常実行には早期評価負例も含む。静的テストは`src/test/gradle/kotlinObserver.test.ts`を実行する。

静的回帰76件、通常全体1,929件成功・native opt-in等1,083件skip。型チェック・buildも成功した。固定化方式の一般化や本番採用へ範囲を拡張したものではない。


### 9.17 2f232c9レビュー修正（2026-11-01）

Gradleは再実行していない。§9.15・§9.16の主観測とsource hashは変更せず、説明の訂正と制限の明記だけを行う。検証JSONには`postReviewRevision`を追記した。

#### 固定化方針の宣言元と適用対象

§9.15・§9.16でproducer固定化と呼んだ設定は、producerのbuild source（`build-logic/build.gradle.kts`）にはない。試験用init script（`gradle-kotlin-observer.init.gradle`）が`gradle.beforeProject`でbuild-logicへ注入し、controlとobserverの両方に同じものを適用している。そのため、§9.15の登録adapter案にある「宣言元とsource hash」の結び付けは再現していない。fixtureの`fixtureInputsSha256`にこの方針は含まれず、方針のsourceを結んでいるのはcollector hashだけである。

適用対象は次の二種類に分かれる。

| 対象 | 実際の処理 | §9.15の契約との関係 |
| --- | --- | --- |
| 計測用7 collection（libraries・compilerClasspath・compile input／output・Jar source／input／output） | init scriptが`p.files(provider)`を作成し、登録区間内で`finalizeValueOnRead()`を宣言してから各slotへ追加 | 作成時の登録という形は再現。ただし宣言元はproducer sourceではなくinit script |
| KGPの`KotlinCompile.libraries`と`classpathSnapshotProperties.classpathSnapshot` | `tasks.configureEach`の中で、KGPが作った既存collectionへ`finalizeValueOnRead()`を事後に適用 | 「既存Providerの事後wrapではなく作成時に登録」に反する。契約の範囲外 |

ownedの条件付き候補4組は、この二点の制限付きの記録である。init scriptによる注入とKGP collectionの事後固定化を、producer自身の宣言と同じものとして扱わない。rawのcontrolでlibrariesが3回から1回へ減った差（§9.15）にも、KGP collectionの事後固定化の影響が含まれる。

次の工程で固定化契約を検証する場合は、方針をproducerのbuild sourceへ置き、そのsource hashをfixture入力として結ぶ。KGPが所有するcollectionには、producerによる作成時登録がない。事後固定化以外で扱えないなら、capture unavailableとして宣言元を省略する。

#### archive hashの結び付け

`verifyReceipts`は、Jar receiptの`archive.sha256`とpublic outputのhashを照合している。ただし、どちらもobserver自身が報告した値である。ハーネスはJAR bytesを読んで`jarEntries`を作るが、archive全体のhashは記録していない。したがって現在の照合は、observer receiptの内部整合と、全entry内容のcontrol／observer一致にとどまる。ハーネスが読んだarchive bytesとobserver報告値の一致は確認していない。次にnative観測を取り直すとき、ハーネスでarchiveのsha256を記録し、共有verifierで照合する。

#### 欠落対照の一覧

23種類の欠落対照は、native test（`kotlinObserver.integration.test.ts`）と集約ハーネス（`gradleKotlinObserverResults.mjs`）の二か所に同じ一覧がある。集約側は件数・名前の集合を照合するので、片方だけ変えると集約を拒否する。共有の`gradleKotlinObserverProof.mjs`へ移すとobserver sourceのhashが変わり、32 buildの主観測が古くなる。このため今回は移さず、次のnative再取得で上記のarchive hashと一緒に行う。

#### 数値の訂正

§9.15のJar sourceの回数を訂正した。Gradle 8.11.1のraw controlは4回、observer有効時は5回であり、3回→4回なのは9.2.1だけである。libraries（3回→4回）とcompilerClasspath（2回→3回）は両版で同じ。raw／taintedの追加評価が各組3件という判定は変わらない。


### 9.18 producer所有入力の登録契約・完全性判定（設計、2026-11-01）

§9.17の制限を前提とする次工程の設計。**本節は未実装・未実証で、本番採用を増やさない。** §9.15のinit script注入、KGP所有collectionの事後固定化、空supplierの対照を本契約の成立証拠へ読み替えない。§9.2〜9.11の入力integrity・mapping・package被覆条件は引き続き必要。本節の登録はそれらに先行するcapture可否のgateであり、所有権の独立証明ではない。

#### 9.18.1 責任と初期範囲

producerが自分のbuild sourceからhelperを呼び、collectionの作成・固定化方針の宣言・slotへの接続を行う。export用init scriptは観測器の導入だけを行い、入力の作成、置換、固定化、既存Providerのwrapは行わない。同じhelperとproducer sourceを通常のcontrolでも使う。sourceは入力manifestに載せ、実行前後のhashをfixture入力と本番baselineへ結ぶ。適用script／convention pluginから呼ぶ場合は、その全sourceと実行artifactを既存plugin契約で結べる場合だけ許可する。

| 入力区分 | 所有者・登録方法 | 初期判断 |
| --- | --- | --- |
| producerが作る追加file collection | 作成時helperがhandleを発行。producerが明示的にslotへ接続 | 次の公開API実証対象 |
| KGP／Gradleが作るlibraries・derived snapshot・compiler Configuration等 | toolchain所有。作者のhandleで所有を偽装しない | 承認された専用recipeがないslotはunavailable |
| 固定物理入力・stage生成物 | manifest参照・stage edgeと承認済み公開recipeで取得 | 全getterの非干渉条件を満たす場合のみ許可 |
| Task.inputs／outputs、CopySpec全体 | 複数所有者のaggregate。追加collectionの登録だけでは被覆しない | 全構成を閉じたprofileで承認できるまで取得しない |

特に、producer作成collectionをKGP slotに追加しても、元のcollectionとその内部supplierを所有したことにはならない。producer helperだけで標準kotlin-dslのcapture成立を宣言しない。KGP所有slotに作成時登録または別の非干渉recipeが成立しなければ、初期binary Kotlinでも宣言元の本番採用は0件のままとする。

#### 9.18.2 helper入出力とlifecycle

以下は提案APIの概念形であり、実在する公開Gradle API名ではない。Gradle型の実装は次の実証で確定する。

| 操作 | 入力 | 出力・制約 |
| --- | --- | --- |
| beginInputs | pipelineId、producer tuple、profile digest、方針source IDとhash、実TaskProviderごとのrole plan | invocation専用session。ID再利用・重複beginはsession全体を不完全化 |
| createOwnedFiles | session、registrationId、許可されたsource kind、producerが所有するsupplier | opaque handleと新しいConfigurableFileCollection。内部で作成時にfinalizeValueOnReadを宣言。supplierを登録時に実行しない |
| attach | handle、実TaskProvider、slot role、承認された接続recipe ID | attachment token。task名だけの指定、別producer、handle交換を拒否。接続先stageはread planで実行必須と定めたものに限る |
| sealInputs | session、期待registration／attachment ID集合、完全列挙・export中不変の作者表明 | sealed ledger。receiptやfile集合はまだ取得しない |
| capture | sealed ledger、承認済みobserver recipe | 全gateと全handleの自然評価正常完了を非評価で確認した後だけ公開getterを読む。取得不能はunavailable、正常だけstage receiptを発行 |

handleは同一invocationの実collection identityに結び、serializableなIDだけで別collectionを登録し直せない。複数slotへ共有する場合は全attachmentを明記し、各slotのroleとstage関係を検証する。別producer／別invocationへの共有は禁止。TaskProviderへのAction登録だけではtaskをrealizeしない。helperの実装がget／files／iterator／provider評価や依存解決を登録中に呼ばないことをnative対照で確認する。

状態はopen → sealed → executing → captured／unavailable。sealは承認recipeに定めた最初のtask入力読取より前でなければならず、単にtask Actionより前であるだけでは足りない。境界を公開APIで確認できないtupleは未対応とする。登録中のsupplier評価、seal前の自然評価、seal後の追加・削除・接続変更、二重seal、異なるprofileへの差し替えは当該pipelineを不完全化する。失敗から再登録して完全へ戻さない。

違反は、helperが防止できるものと記録しかできないものに分けて扱う。

- **記録のみ（buildは失敗させない）**: 登録中の評価とseal前の自然評価。helperは所有supplierの呼出し時にsession状態を見て記録できるが、呼出し自体は防げない。export用helperがユーザーの通常buildを失敗させないため、`owned_input_early_evaluation`を記録し、pipeline全体をcapture unavailableにする。
- **防止（buildを失敗させる）**: helper所有collectionのseal後変更と、宣言済みsource kindと実値の不一致（§9.18.3）。sealでは、helperが自身の作成したcollectionへ公開APIの`disallowChanges()`を適用する。seal後の`setFrom`／`from`はその呼出し箇所で失敗し、helperは`owned_input_late_mutation`として診断する。これはhelperが所有するcollectionに限った作者承認済みの契約であり、下記で禁止する既存Providerへの`disallowChanges()`による代替とは別である。
- **検出不能（表明に依存）**: toolchain所有slotやTask.inputs／CopySpec等のaggregateへの、seal後の接続・変更。公開APIで独立に検出できないため、§9.18.4の作者表明と承認profileに依存する。検出したと主張しない。

handleごとに、session状態と独立した自然評価状態を保持する。状態は`not-evaluated` → `evaluating` → `ready`／`failed`。helperが所有supplierの呼出し開始・戻り値の検証と防御的copyの正常完了・例外を記録する。`ready`はseal後に、observerとは独立した通常buildの読取で評価が正常完了した場合だけ付与する。開始eventだけ、taskのdidWork、別handleの完了、過去invocationの成功を代用しない。seal前評価は既述の契約違反とし、readyへ昇格させない。失敗後の再試行成功でfailedを回復させない。追加評価・再入も契約違反として採用不可とする。

capture準備確認はledger内の状態を読むだけとし、Provider.get／isPresent、files／iterator、task input／output getter、probe用の評価・再試行を行わない。全read planが参照する全owned handleを確認してから、最初の対象getterへ進む。同じhandleを複数slotが共有する場合も実identityに結んだ同じ評価状態を確認する。一つでもnot-evaluated／evaluating／failedならpipeline全体をcapture unavailableとし、正常なhandleだけを先に読んで部分receiptを作らない。自然評価の完了を待つためのgetter呼出しや、captureからのsupplier実行は禁止する。

この状態はhelper所有supplierについてだけ観測できる。toolchain所有slotは別の承認recipeに、observerが初回評価を起こさない準備完了条件と非評価の確認方法を要求する。owned handleのreadyをKGP aggregateや内部supplierへ拡張しない。readyでもfile bytesの不変や全入力の登録完全性は保証せず、後続のintegrity検査と追加信頼は維持する。

helperは既存collectionへsetFrom／fromして所有者にならず、既存Providerへのmap・wrap、finalizeValue、disallowChangesによる代替もしない。作成時固定化で通常buildの評価契約が変わることは作者が明示承認する。observer無効のcontrolと同じ契約で比較し、未変更buildに透過的とは表現しない。

#### 9.18.3 許可するsource値とfile内容

初期source kindは`concrete-files-v1`のみ。supplierは新規の具体的なList<File>を返す。各要素は通常fileの絶対pathに限定し、返却値をhelperが防御的にcopyする。初回の自然な評価の内側で型・上限・path境界を検証し、検証のためにsupplierを先に呼ばない。空だけでなく、異なる内容を持つ複数の非空fileで実証する。logical IDと順序・重複の扱いはslot recipeへ固定し、librariesのsequenceとTask.inputsの集合を混同しない。

初期対象外はProvider／Closure／Callableを要素に持つ戻り値、FileCollection、FileTree、Directory、入れ子list、遅延Iterable、可変live tree、任意のObjectからのGradle path変換。戻り値を再帰的に展開して陽性化しない。未知kindは登録gateで拒否し、宣言済みkindと実値の不一致は最初の自然な評価内でbuildを失敗させる。正しいfile listへ途中変換して対照を通すことは禁止する。

concrete file listの固定化はbytesの固定化ではない。symlink／directory／境界外fileはこのsource kindでは拒否する。toolchain fileは別の承認済みsnapshot経路に限定し、producer入力をtoolchainへ分類変更して境界・容量制限を迂回しない。stage前後のhash、file集合、package edge、保存blobとMCP読取時の再検証を維持する。削除・追加・内容変更を検出したら採用不可。一時変更が元に戻る場合を完全検出できるとは主張せず、export中不変の追加表明を残す。

#### 9.18.4 読取前gateと完全性の根拠

Task.inputs.filesから未知supplierの不存在を安全に独立判定する公開手段は未成立である。「読み取る前に登録漏れを拒否」は、値を走査して漏れを発見するという意味ではない。以下の静的ledgerと追加信頼を検証し、根拠が欠けるときに一切の対象getterを呼ばないという契約である。

1. 利用者が起動時に追加の`producer-owned-inputs-v1`信頼を有効化し、toolchain／collector／producer方針source／接続recipeのdigestを別途承認していること。これは既存pipeline信頼に追加するgateであり、既存の信頼値だけで自動許可しない。設定名・構文は本番schema実装時に確定し、graphから自己承認しない。
2. 承認profileの全stage・全読取slot一覧がobserverの静的read planと一致すること。compileJava NO-SOURCE、descriptor、resources、Jar metadata、設定・plugin実装の観測も含め、compile／Jarのfile入力だけへ縮小しない。
3. 各slotにowner kind、実handleまたは承認済みtoolchain recipe、全attachment、方針source参照が揃い、期待ID集合とledgerが双方向一致すること。重複・余剰・欠落・role交換を拒否する。空集合にも明示的な非使用根拠を要求する。
4. 作者が、Task.inputs／outputs・CopySpec・pluginからの追加を含む全構成の列挙と、seal後の構成不変を表明し、その構成source全体が承認profileの対象であること。未知plugin／scriptや未承認source変更はgateを閉じる。公開mutation callbackだけで全変更を独立検出したとは扱わない。
5. 全read planで参照するowned handleが同一invocation内でseal後の自然評価を正常完了し、状態がすべてreadyであることをledgerだけで確認すること。未評価・評価中・評価失敗をgetterで調べたり回復させたりしない。
6. toolchain所有slotがすべて実証済みrecipeで被覆され、各recipeの非評価でのcapture準備完了条件も満たすこと。未対応のKGP collectionが一つでもあれば、producer登録が完全でもgetterを試さずunavailableにする。

gate検査自体でTaskProvider.get、Task.inputs.files、compiler Configuration.files、CopySpec走査、plugins列挙など実observer対象のgetterを呼ばない。非評価での実体照合が不可能な項目は推測せず未対応にする。公開getterを使う実装型／実行設定照合は、承認済みread planのcapture段階へ置く。

この完全性は`author-attested-and-profile-reviewed`であり、`independently-proven`ではない。悪意ある未申告変更を一般に防ぐsandboxではない。承認されたsource・toolchainを信頼できない環境には採用しない。

#### 9.18.5 export証拠・判定・静的取込

将来のv4証拠へ`ownedInputRegistration`を追加する案とする。strictなversioned objectにsession／invocation／producer、policy source hash、profile digest、read-plan digest、registrations、attachments、seal event、handleごとの自然評価状態と開始／正常完了／失敗event（invocation・順序・通常build／observerの由来を含む）、per-slot owner kind／recipe、完全性表明、state／reasonsを記録する。readyにはseal後の対応する開始・正常完了eventが必要で、失敗・追加評価eventと矛盾する証拠を拒否する。実handleはexport中だけに保持し、JSONに復元可能な実体handleを装わない。各stage receiptは対応slot IDを参照し、profileと期待集合をMCPでも再照合する。旧schemaへfieldだけ追加して新契約を許可しない。

| 状態・理由案 | export時 | MCPでの扱い |
| --- | --- | --- |
| owned_input_trust_disabled／profile_not_approved | 対象getterを呼ばずcapture unavailable | integrity検査可能な既存graphのrelation・introduced_by・lock由来coverageを維持し、contributing GAVのdeclared_in一覧全体を省略 |
| owned_input_registration_incomplete／recipe_unsupported／stage_not_executed | 不完全なledgerからcaptureしない。実行中発覚なら成功receiptへ変換しない | 有効なunavailable状態なら宣言元を全体省略。部分的なsource一覧を返さない |
| owned_input_early_evaluation | 登録中・seal前の評価を記録し、buildは継続。対象getterを呼ばずpipeline全体をcapture unavailable | 有効なunavailable状態として宣言元全体を省略。早期評価eventとready状態が矛盾する証拠はintegrity拒否 |
| owned_input_not_evaluated／evaluation_in_progress／evaluation_failed | ledgerのみで判定し、対象getterを一つも呼ばずpipeline全体をcapture unavailable | 有効なunavailable状態として宣言元全体を省略。失敗をreadyに書き換えた証拠やinvocation不一致はintegrity拒否 |
| owned_input_late_mutation／source_kind_mismatch | helperが防止する契約違反。変更箇所または最初の自然な評価でbuildを失敗させ診断。成功exportを発行しない | 古いexportを新しい成功結果として使わない。既存の鮮度判定に従う |
| 不正schema・参照・source hash・receipt／blob改変 | graphを書き出すならinvalidを明記し、採用可能としない | 証拠不整合としてgraphを拒否。信頼無効やmapping未表明でintegrity検査をskipしない |
| 全gate・stage・package検査成功 | input_status=verified。mappingの表明は別判定 | 追加信頼・limitationsと完全性をmetadataへ残した場合だけdeclared_in候補 |

必須limitationsは、作者による入力登録完全性、producer方針による元buildの評価契約変更、計測外の内部supplierの非干渉未証明、fileの一時変更の検出限界を区別する。追加信頼をloader／compilerの独立証明へ昇格させない。catalogを含むscopeには既存catalog信頼も必要。configuration cache・並行実行・compiler daemon・build cache再利用・任意CopySpec／filteringは引き続き初期対象外。

#### 9.18.6 次の公開API実証・回帰条件

以下をOI01〜OI16とし、**すべて未実施**。Groovy／Kotlin consumer × Gradle 8.11.1／9.2.1を必須とし、producer DSL・producer種別・binary／precompiledを個別に記録する。初期included root binaryでの結果をbuildSrc／precompiledへ流用しない。

| ID | 条件・期待結果 |
| --- | --- |
| OI01 | 方針とhelper呼出しをproducer sourceへ置き、control／observerで同一source hash。init scriptが固定化した対照は契約不成立 |
| OI02 | 非空の複数fileを返す所有supplierで全observerを実行。各handleがseal後の通常buildで自然評価を正常完了しreadyになることを要求。登録時評価0、自然評価のphase・回数・順序とAction／Provider traceが一致。開始だけ・別handle／別invocationの成功でreadyにしない。JAR期待entry被覆も一致 |
| OI03 | KGP libraries／snapshotへの事後固定化を禁止。専用recipe未成立ならgetter呼出し0でunavailable。producerセンサーだけの成功でcandidateにしない |
| OI04 | compilerClasspathを含む全登録区間へ早期finalizeValue負例。traceがcontrolと同じでも`owned_input_early_evaluation`でcapture unavailableとし、buildは成功したまま対象getter呼出し0・宣言元全体省略を確認 |
| OI05 | 未承認profile・source hash変更・信頼無効・全slotの欠落／余剰／role交換に加え、not-evaluated／evaluating／failedのhandleを個別に混在。全対象getter sentinelが発火せず、supplier回数も増えず、対応する準備未完了理由と宣言元全体省略を確認。状態確認でget／isPresent／files／iteratorを呼ぶ実装は失敗させる。read planで実行必須としたstageの実行が保証されない接続（NO-SOURCE、onlyIf等で読まれ得ないslot）は登録gateで`owned_input_stage_not_executed`として拒否する |
| OI06 | 重複begin／ID／seal、seal前自然評価、seal後のattach／変更、別producer／invocation handleを拒否。後の再登録で回復しない。seal後の`setFrom`／`from`は`disallowChanges()`により変更箇所でbuildが失敗し`owned_input_late_mutation`と診断されること、seal前の自然評価は`owned_input_early_evaluation`でbuildを失敗させずunavailableになることを区別して確認 |
| OI07 | 非空listの返却後のlist変更を防御的copyで隔離。各file bytes変更・削除・想定外追加はintegrity拒否。順序／重複規則も検証 |
| OI08 | 入れ子list・Provider要素・Closure・FileCollection・FileTree・遅延Iterable・directory・symlink・境界外pathを正確な理由で拒否。拒否のための追加評価を行わない |
| OI09 | unknown CopySpec／plugin／scriptと未固定supplierの混在はgateでunavailable。独立発見ではなく、どの表明／profile不一致で拒否したか保存 |
| OI10 | Task.inputs／outputs、libraries／snapshots、compilerClasspath、plugins、設定、Java precheck、descriptor／resources、Jar metadataを含む全read planで非干渉を比較。controlでは一度も評価されないhandle、評価開始後の再入capture、評価失敗を捕捉した後のcaptureを負例にし、getter呼出し0で拒否。readyな別handleを先に読まず、再試行・別slot共有・別invocation成功でも迂回できないことを確認。toolchain slotにもrecipe別の準備条件を検証。実行必須stageが実際には実行されずhandleがnot-evaluatedのまま残る場合も、getter呼出し0でunavailable |
| OI11 | 全必須receipt・field・slotを欠落させ共有verifierと集約の双方が拒否。欠落対象一覧は共有定義に一本化し、両方の検査集合を一致させる |
| OI12 | ハーネス自身が読んだarchive bytesのSHA-256を保存し、observer archive／public outputと束縛。entry一致のままarchive報告hashだけ偽装しても拒否。control／observer間のarchive hash一致自体は要求しない |
| OI13 | 保存blob・source・profile・read plan・producer／invocation参照の改変、旧schemaへのdowngradeを拒否。mapping未表明でもintegrityを検査 |
| OI14 | scope／contextの一部がunavailableならdeclared_inの部分一覧を出さず、検証済みrelation／introduced_byとlock由来coverageを保持 |
| OI15 | buildSrcとprecompiledを別matrixで確認。plugins-block用recipeが未成立のtupleは明示unavailable。consumer DSLの違いをproducer DSL実証へ読み替えない |
| OI16 | raw／所有／未固定混在を比較し、元buildとの評価契約差と所有baseline内の非干渉を別記。実版・run UUID・helper／observer／verifier／producer source hashをrun前後で照合 |

正常な全pipeline候補には、toolchain所有slotを含む全read planの成立が必要である。まずhelper所有入力だけの実証とKGP未対応時のno-read拒否を行い、それを全pipeline採用と数えない。その後、toolchain所有slotの非干渉recipeを別途成立させる。本番adapter／reader・snapshot storage・3ツール／OSV実接続は、この設計レビューと実証の後工程とする。


#### 9.18.7 061ed46レビュー修正

設計のみの修正で、実装・native実行・検証JSONは変更していない。

- 早期評価の扱いを統一した。§9.18.2では「pipelineを不完全化」、§9.18.5の表では「buildを失敗」としていた。helperは早期評価を記録できるが防止できないため、`owned_input_early_evaluation`は記録してcapture unavailableとし、buildは失敗させない。OI04をこれに合わせた。
- seal後変更の検出方法を定めた。helper所有collectionにはsealで`disallowChanges()`を適用し、変更箇所でbuildを失敗させて`owned_input_late_mutation`と診断する。toolchain所有slotやaggregateへのseal後変更は独立に検出できず、作者表明に依存すると明記した。§9.18.5の表では、防止するもの（late_mutation・source_kind_mismatch）と記録のみのもの（early_evaluation）を別の行に分け、OI06に両者を区別する確認を加えた。
- 実行されないstageへの接続規則を追加した。attachの接続先をread planで実行必須とした場合に限り、実行が保証されない接続は登録gateで`owned_input_stage_not_executed`として拒否する。OI05／OI10に負例を加えた。


### 9.19 producer所有helper・capture準備条件の公開API実証（2026-11-01）

以下は初回v1実証。getter計測・必須event検証のレビュー修正後は§9.20を参照。検証JSONの主観測はv2へ更新し、初回のsource hash・集計はpreReviewへ保持する。

§9.18のうち、producer sourceからの作成時登録、非空file値、handle単位の自然評価とno-read拒否をtest-onlyで実装した。**全pipelineのcapture成立、本番adapter／readerの対応を意味しない。** KGP所有slotのrecipeは未対応のまま、getter呼出し前に拒否する。

#### helperとfixture

`gradle-owned-inputs-helper.gradle`をproducerのbuild sourceから明示的にapplyし、`installOwnedProof`を呼ぶ。export init scriptからの入力注入はない。Groovy／Kotlin双方のproducer build source・適用helper・Kotlin source・非空入力2 fileをfixture入力hashに含め、control／observerのrun前後で検証する。helper／共有verifier／型宣言／native harnessのsource hashもrun前後で照合する。

prototypeはhelper内部のcreateOwnedFiles／attach／sealInputsとcapture closureで構成する。createは新しい公開ObjectFactory.fileCollectionとProviderFactory.providerを使い、その場でfinalizeValueOnReadを宣言する。既存のKGP collectionは固定化・置換・wrapしない。attachは実TaskProvider.configureでtask入力に接続し、sealは期待handle／attachmentの集合と未評価状態を確認する。新規ArrayList<File>の複数要素を自然評価内で検査・copyし、通常file・境界内・非symlinkを確認する。一般向けopaque APIや全登録完全性adapterへの移植は未実施。

main handleは実行するcustom taskの入力に接続する。auxiliaryは正常／KGP未対応条件では同じ実行taskへ、それ以外では実行しないtaskへ接続する。これにより未評価条件は実際にcontrolでも評価0回であり、単なる状態flagの差し替えではない。評価中は通常task Actionがauxiliaryを読むsupplierの内側からcaptureへ再入し、評価失敗はsupplierの例外を通常Actionが捕捉した後にcaptureする。いずれも追加評価を起こすprobeは行わない。

captureは全handle状態とrecipe可否を先に検査し、未準備のhandleがあればmainも含めて一つもgetterを呼ばない。準備が揃う正常条件だけ、両owned collectionのfiles getterを読む。各handleの開始／正常完了／失敗eventとcapture時の状態snapshotを保存し、共有verifierはevent順と理由を再検証する。評価中の拒否は後でreadyになっても覆さない。拒否後のsupplier再試行は行わない。

KGP未対応条件は、両owned handleがreadyでも`recipe_unsupported`にする。公開KotlinCompileのlibraries／classpathSnapshot、kotlinCompilerClasspath Configuration、compileKotlin Task.inputsの4 reader closureを用意し、read直前のcounterをすべて0と確認する。これらは実standard kotlin-dsl producerの実taskを参照するが実行しない。承認recipeが存在することや、KGP内部supplierの非干渉は実証していない。

#### matrixと証拠

Groovy consumer＋Groovy producer、Kotlin consumer＋Kotlin producerをGradle 8.11.1／9.2.1で実行する。producerはincluded build rootのbinary Kotlin、標準kotlin-dslを使う。consumer／producer DSLの全4交差、buildSrc、precompiledは対象外。各DSL・版でcontrol／observerを別buildとして実行し、producer出力を削除してoffline・rerun・cacheなし・worker 1・parallelなしで再構築する。各build内で5条件を実行するため、4対照×5条件＝20条件対照、native buildは8回である。

| 条件 | 通常buildのauxiliary評価 | observerでの期待結果 |
| --- | --- | --- |
| ready | 1回・正常完了 | 両handleを各1回読取。2 file×2 handleのhashを独立したfixture入力hashへ結ぶ |
| not-evaluated | 0回 | owned_input_not_evaluated、全owned getter 0回 |
| evaluating | 1回・supplier内からcaptureに再入 | owned_input_evaluation_in_progress、全owned getter 0回。自然評価完了後も拒否を維持 |
| failed | 1回・例外発生、通常taskが捕捉 | owned_input_evaluation_failed、全owned getter 0回、再試行なし |
| kgp-unsupported | 1回・正常完了 | recipe_unsupported、owned／KGP getterとも0回 |

control／observerの登録・supplier・Actionのevent列と最終handle状態／実行回数を比較する。正常条件も、observerが読む前に両handleの自然評価がseal後に正常完了していなければ共有verifierが拒否する。run UUID・実Gradle版・DSL・source hash・fixture hash、全5条件と準備状態snapshotの欠落、非空file hashの不一致、getterの追加読取も拒否する。

[機械可読結果](validation/gradle-owned-inputs-2026-11-01.json)と`gradleOwnedInputsResults.mjs`へ主観測と再検証方法を保存する。sourceを変更したらnativeを再取得し、現在のhashで古い観測を再ラベルしない。

#### 再現手順

JDK 21、対象Gradleと標準kotlin-dsl依存のoffline cacheを用意する。JAVA_HOME／GRADLE_USER_HOMEを設定し、次を8.11.1／9.2.1でそれぞれ実行する。出力suffixは実行版に合わせる。

```sh
OSV_MCP_TEST_GRADLE=/path/to/gradle-8.11.1/bin/gradle OSV_MCP_OWNED_INPUT_OUTPUT=/tmp/owned-input-8.11.1.json npx vitest run src/test/gradle/ownedInputs.integration.test.ts --maxWorkers=1 --hookTimeout=120000
node src/test/manual/gradleOwnedInputsResults.mjs /tmp/owned-input docs/validation/gradle-owned-inputs-2026-11-01.json
npx vitest run src/test/gradle/ownedInputs.test.ts --maxWorkers=1
```

#### OI条件との対応と残るgate

OI01のsource帰属とOI02／OI05／OI10の**所有handle準備判定部分**を対象とする。OI02／OI10の全observer非干渉は未達で、今回のobserverはowned collectionの読取のみ。未承認profile／未知入力の本番読取前gate、OI全条件、任意List型の負例、完全登録・追加信頼設定、toolchain入力の準備recipe、snapshot保存／静的取込、context併合、JAR独立hash照合は後工程である。過去の全observer実証を組み合わせて、本契約の全read planが成立したとは扱わない。

本番採用0件・全pipeline候補0件を維持する。helperの限定候補と未対応KGPのno-read拒否を分離し、次は本実証レビューとtoolchain所有slotの取得recipe検討へ進む。


最終検証: Gradle 8.11.1／9.2.1のnative各10件成功（各DSLの5条件）、8 build・20条件対照を保存した。正常helper候補4組、no-read拒否16組、全pipeline候補／本番採用はともに0件。静的回帰15件、通常全体1,944件成功・native opt-in等1,093件skip。typecheck・buildと差分検査も成功。試作中のplugin版指定不足・Groovy変数スコープの失敗、検証器変更中のsource hash不一致を成功観測へ数えず、最終sourceで両matrixを取り直した。


### 9.20 producer所有helperの読取計測・必須event検証の修正（2026-11-01）

§9.19のレビュー2件を修正した。**所有helperの限定実証であり、全observer・toolchain recipe・本番採用の未成立は維持する。** 修正前の共有verifierに、未評価条件のtraceへのgetter:main挿入と、両runの登録／Action event全削除を与え、いずれも受理してしまうことを静的回帰で確認してから修正した。

#### 共通readerとgetter証拠

adapter自身のowned collection読取を`readOwned`へ集約する。正常capture、通常Actionによる明示読取、故障注入も同じ経路を使い、observer読取はgetter:<handle> eventとcounter、通常Actionの明示読取はnatural-getter:<handle> eventを記録する。KGPの4 readerも共通の`readKgp`を通し、kgp-getter:<role>とcounterを結ぶ。Task.inputsを通じてGradleが自然に行う読取はsupplier eventで観測する。あらゆる内部getterを独立interceptしたとは扱わない。

共有verifierは、observer getterがcapture:gateより前にあればcounterや採否理由に関係なく`owned_proof_getter_before_gate`で拒否する。正常条件ではmain／auxiliary各1回・この順序・observer phase・gate後であることとcounter一致を要求する。拒否条件とcontrolではgetter eventもcounterも0を要求する。KGPもeventとcounterを照合し、未対応の4 readerを一つでも呼べば不成立にする。eventだけ追加、counterだけ変更、event欠落、phase変更、gate後の拒否handle読取も回帰対象とする。

native fault injection `osv.owned.preGateRead=true`は、not-evaluated条件でmainがreadyであるとき、capture冒頭からreadOwned(main)を**実際に**呼び、その後でgateへ進む。この読取はcachedなためsupplier回数やfile内容を変えなくても検出される。両DSL・両Gradle版でobserverの故障buildを追加し、元のcontrolと組み合わせたproofを共有verifierへ渡す。正確なgetter-before-gate理由で拒否されることを要求し、単にflag=trueやschema不正で失敗した負例を成功として扱わない。

#### 登録・Actionの必須inventory

各条件・各runにmain／auxiliaryのregistration:begin/end、seal、action:begin/endをそれぞれ一つ要求する。登録4境界→seal→Action開始→終了の順序と、登録／sealのregistration phase、Actionのnatural phaseを検証する。observerのgateは1回、controlには0回。評価中条件だけgateをAction内に要求し、他の条件はAction終了後に要求する。自然Actionで読むauxiliaryのeventも評価中／失敗条件で各1回・Action内に要求し、不明event名・phaseを許可しない。

欠落対象は共有verifier moduleの`ownedInputBoundaryEvents`／`ownedInputEvidenceTargets`へ置き、nativeと集約で同じ定義を使う。2 run×5条件×7境界＝70対照を、通常の各DSL・版のproofへ適用する。4 proof合計280件で実際の例外理由を保存し、集約側も同じ削除を再実行して理由一致を確認する。静的回帰では欠落に加えて重複・不正phase・順序逆転も拒否する。

#### v2の記録と再検証

case／run／matrix／experimentをv2へ更新し、実preGateRead設定と故障proof・拒否理由、event欠落対照を保存する。集約は通常4 proofだけでなく両DSL・両Gradle版の故障4 proofを要求し、同じ共有verifierで再検証する。現在のsource hashと一致しない観測は採用しない。再現コマンドは§9.19と同じで、通常のnativeテスト実行が故障buildも含む。

今回もobserverはowned collectionだけであり、KGP captureはunsupportedのno-read拒否である。全pipeline候補・本番採用は0件。buildSrc・precompiled、全read planの非干渉、完全登録adapter・追加信頼設定・静的取込・snapshot保存・OSV実接続の範囲は拡張していない。


| 再検証 | 結果 |
| --- | --- |
| Groovy／Kotlin × Gradle 8.11.1／9.2.1 | 各版native 14件成功、終了処理も成功 |
| 通常control／observer | 8 build・20条件対照。所有helper候補4組、準備未完了／KGP未対応のno-read拒否16組 |
| gate前のready handle実読取 | observer故障buildを4回追加。4 proofすべてgetter-before-gateで拒否、main supplierは各1評価のまま |
| 必須event欠落 | 70種類×4 proof＝280件を拒否し、集約で再計算 |
| 静的回帰 | 64件成功。登録／Action境界の欠落・重複・phase・順序、getter event／counter不一致を含む |

合計12 native build。保存したv2観測と現在のsource hashを照合し、旧v1要約は履歴としてのみ保持する。

最終確認: 通常全体1,993件成功・native opt-in等1,097件skip。型チェック・build・差分チェックも成功。今回の変更はtest-onlyの実証・検証器・記録で、本番採用0件を維持する。


### 9.21 38d0b2aレビュー修正・v3再検証（2026-11-01）

§9.19・§9.20のレビュー4件を修正し、両Gradle版のnativeを取り直した。**所有helperの限定実証とKGP未対応のno-read拒否という範囲は変えず、全pipeline候補・本番採用は0件のままである。**

#### KGP readerの実呼出し負例

修正前は、`kgp-unsupported`ではgateが必ず`recipe_unsupported`を返すため、gate後にKGP readerを呼ぶ行へ到達しなかった。「KGP getter 0回」は呼べない経路を数えた結果であり、KGP readerのevent・counter記録とverifierの拒否は実測されていなかった。到達しない行を削除し、native fault injection `osv.owned.preGateKgpRead=true`を追加した。この故障buildでは、`kgp-unsupported`条件のcapture冒頭で公開`KotlinCompile.libraries`のreaderを**実際に**一度呼び、その後gateへ進む。両DSL・両Gradle版の4 buildすべてで`kgp-getter:libraries`が1件・counter 1と記録され、共有verifierが`owned_proof_getter_before_gate`で拒否した。故障を名乗りながら実際にreaderを呼んでいない証拠は`owned_proof_fault_not_reproduced`、故障の設定と承認が一致しない証拠は`owned_proof_identity_mismatch`で拒否する。

故障の種類は共有verifier moduleの`ownedInputFaults`（`owned-pre-gate`／`kgp-pre-gate`）にまとめ、nativeと集約で同じ定義を使う。集約は各DSL・版で両方の故障proofを要求し、同じverifierで理由を再現する。

#### sealでの変更禁止

§9.18.2で定めたとおり、`sealInputs`はhelper所有の各collectionへ`disallowChanges()`を適用し、その事実をcaseごとの`changesDisallowed`に記録する。共有verifierは全条件・全runで`changesDisallowed=true`を要求する。ただし、seal後に実際に`setFrom`／`from`を呼んでbuildが失敗することを確かめるnative負例（OI06のlate mutation）はまだない。適用の記録はhelper自身の報告であり、late mutationの診断（`owned_input_late_mutation`）も未実装である。

#### 集約値の計算

集約ハーネスは、`helperCandidates`・`nativeBuilds`・`observerRejections`・`eventOmissionRejections`などの集計値を、固定値ではなく検証済みのmatrixから計算する。`nativeBuilds`は通常のcontrol／observer runと故障buildの合計である。gate前の読取の負例は、owned分と`kgpPreGateReadRejections`を別々に数える。

#### 過去記録の扱い

集約は、置き換えた記録を`preReviews`配列に一件ずつ要約として追加する。v1とv2の要約が入っている。v1のJSONはコミットしておらず、v1要約の`recordSha256`はリポジトリ内の記録と照合できない参考値である。v2要約の`recordSha256`は38d0b2aでコミットした記録のhashと照合できる。

#### v3の再検証結果

| 検証 | 結果 |
| --- | --- |
| Groovy／Kotlin × Gradle 8.11.1／9.2.1 | 各版native 16件成功、終了処理も成功 |
| 通常control／observer | 8 build・20条件対照。所有helper候補4組、no-read拒否16組 |
| gate前のowned handle実読取 | 故障4 buildすべてgetter-before-gateで拒否 |
| gate前のKGP reader実呼出し | 故障4 buildすべてkgp-getter 1件・counter 1を記録し、getter-before-gateで拒否 |
| 必須event欠落 | 70種類×4 proof＝280件を拒否し、集約で再計算 |
| 静的回帰 | 68件成功（KGP故障・偽の故障・承認不一致・変更禁止の欠落を含む） |

合計16 native build。case／run／matrix／experimentをv3へ更新し、主観測は修正後のsourceで再取得した結果である。再現コマンドは§9.19と同じで、通常のnative実行が両方の故障buildを含む。KGP readerの実呼出しは負例としてだけ行う。KGP所有slotの取得recipe・内部supplierの非干渉は引き続き未実証である。


### 9.22 KGP所有入力のcapture準備契約（設計、2026-11-01）

§9.18〜9.21に追加する設計。**実装・native実証・本番採用は行わない。現在の全pipeline候補／本番採用は0件で、4 slotすべて既定unsupportedを維持する。** producer所有handleのreadyや、過去の事後固定化実験をKGP所有入力のreadyへ転用しない。v3実証のKGP getter故障は拒否経路の実証であり、安全な取得方式の実証ではない。

#### 9.22.1 公開APIから分かることと不足すること

2026-11-01に、手元のGradle 8.11.1／9.2.1のgradle-core-api JARの公開シグネチャをjavapで照合した。HasConfigurableValueはfinalizeValue／finalizeValueOnRead／disallowChanges／disallowUnsafeReadを公開するが、汎用のisFinalized／isNaturallyEvaluated照会を持たない。FileCollectionとTaskInputsの公開シグネチャにも、全supplierの自然評価完了tokenや、既存materialized input snapshotを取得するAPIはない。これは当該interfaceの確認であり、KGPを含む全公開APIの不存在の独立証明ではない。

確認対象は各Gradle配布物の`lib/gradle-core-api-<版>.jar`である。JDK 21の`javap -cp <JAR> <class>`の出力から`Compiled from`行と閉じ括弧行を除き、行頭空白を削って並べ替えたもののSHA-256を記録した。method数は`(`を含む行の数である。

| 対象 | Gradle 8.11.1 | Gradle 9.2.1 |
| --- | --- | --- |
| JARのSHA-256 | `8abc5c441eec849e658981f573356ef0c1bd32e2293cc0b5335967ccb0abf682` | `37054573063abb60c5401d761491c17c404f2eb875485274c9087185f6fb9445` |
| `org.gradle.api.provider.HasConfigurableValue` | 4 method、出力digest `1c404618769a268a1ddd74bc81359c12ea2b83f6be3d21e0725ccb4bba0297a8` | 同一 |
| `org.gradle.api.file.FileCollection` | 13 method、出力digest `4712cca1aa904a06b11fcbe8b3596cf5e919add5a6fabe13f4184c2388fd0df5` | 同一 |
| `org.gradle.api.tasks.TaskInputs` | 10 method、出力digest `5a4380d6934179de0da11cb37819f1c036d48ebf528d5116d498bd6fbffefe50` | 同一 |

HasConfigurableValueの4 methodは両版とも`finalizeValue`・`finalizeValueOnRead`・`disallowChanges`・`disallowUnsafeRead`である。KGPの公開API（kotlin-gradle-plugin-api等）はこの確認に含まれず、§9.22.6のslot別調査で別に記録する。

Gradleの[HasConfigurableValue契約](https://docs.gradle.org/current/javadoc/org/gradle/api/provider/HasConfigurableValue.html)は、遅延固定化の要求と値の取得、値自体の不変性を区別する。[TaskInputs契約](https://docs.gradle.org/current/javadoc/org/gradle/api/tasks/TaskInputs.html)は入力FileCollectionを返すが、その内部supplierの完了照会は提供しない。これらのcurrent文書を版別成立証拠にせず、8.11.1／9.2.1の実API・実KGP artifactで別々に確認する。KGPの[公式snapshot説明](https://kotlinlang.org/docs/gradle-compilation-and-caches.html)に従い、classpath snapshotをlibrary bytesのコピーと扱わない。

禁止する推論は、taskが始まった／成功した／didWork=trueだから全slotが自然評価済み、ConfigurationがRESOLVEDだからfilesの全supplierがcached、afterResolveが発火したから全artifactが取得済み、snapshot fileが存在するから当該compileが消費済み、というもの。Provider.isPresent、FileCollection.isEmpty／contains／elements.get／iterator／files／asPath、TaskInputs.propertiesも準備確認のprobeに使わない。observerからのfinalizeValue／finalizeValueOnRead／disallowChanges、既存Providerのmap・wrap、別ArtifactView、reflection／internal APIでのsnapshot取得も禁止する。

#### 9.22.2 取得方式を二つに限定する

| captureMode | 値の取得と準備根拠 | 未成立時 |
| --- | --- | --- |
| owner-materialized-receipt-v1（優先） | 所有者が通常buildで既に計算した同一の具体file列を、その自然な消費経路から登録済みbridgeへ渡す。bridgeはsourceを再評価せず具体列の防御的copyと自然消費時点の内容証拠（§9.22.8）を保存。observerは元のKGP getter・Providerを読まず、receiptと、receiptに記された実fileのbytesだけを読む | 同一値を渡す公開hook／所有者協力がない場合はunsupported。afterTaskでgetterを読み直してreceiptを作らない |
| public-stable-reread-v1（限定候補） | 対象tupleの公開契約が、特定slotの自然消費とその後の再読取の非評価性を保証し、承認recipeがその前提をruntimeで非評価確認できる場合のみ、全slot gate後に既存getterを読む | 公開保証・自然消費の根拠・非評価のruntime確認のいずれかが不足したらunsupported。実験で一度traceが一致しただけでは承認しない |

owner-materializedのbridge APIは将来の概念形`beginSlot(binding)`／`completeSlot(token, concreteFiles, contentBindings)`／`failSlot(token, reason)`とする。begin／completeはobserverを有効にしたときだけ挿入せず、同じ所有者側の処理をcontrolでも使う。completeは所有者が自然な計算で得た具体列と、同じ自然消費時点に束縛した内容証拠を渡す。bridge内でSupplier／Provider／FileCollectionを受け取り直して展開しない。内容証拠の生成は所有者の自然処理側で行い、全体gateまで遅延させない。所有者が新たな公開拡張点を提供する必要がある場合は、その追加契約を明示する。現在の標準KGPにこのhookが実在すると仮定しない。

public-stable-rereadはrecipe作者の表明だけで公開保証を代替しない。必要な証拠は、正確な公開型・property・自然消費箇所と公開契約の根拠、固定化／安定性が元の所有者の通常処理で成立すること、返却値のdeepな再評価がない範囲、対象source形・変更制限、全observer対照である。taskの成功callbackだけでtokenを発行せず、recipeが定める全前提のwitnessを必要とする。§9.12〜9.17で追加評価または事後固定化を確認した既存recipeは、このmodeの承認対象にしない。

二方式とも、既存build無変更で全入力を透過取得する保証にはしない。所有者協力によるreceipt生成が通常buildの評価契約を変える場合、その差を別途記録して利用者が承認する。sourceの再評価ゼロとfile bytes不変、compilerの忠実性、全入力登録完全性は別の条件である。

#### 9.22.3 slot別のbinding・準備条件

| slot | 必須bindingとreadyの根拠 | 根拠にしてはいけない情報／現状 |
| --- | --- | --- |
| libraries | 実KotlinCompile instance・当該property role・producer／invocation／stage・採用recipeへ束縛。owner receiptはcompileが通常経路で消費する順序付きlibrary列を渡し終えたこと。再読取modeは当該propertyの公開安定性保証と自然消費witnessを別途必要とする | compiler開始／終了、inputの一部であること、producerが追加したcollectionのreadyでは不足。既存collectionの事後固定化は不許可。現在unsupported |
| classpath snapshot | 同じconsumer stageのlibraries sequence digest、sourceRole、派生collectionの具体列、aggregate cohort IDへ束縛。自然なtransform／compile消費経路のreceipt、または同じ派生collectionを安定再読取できる公開recipeが必要 | cache directoryの走査、別ArtifactViewでの再解決、単一JARとの推定対応、前runのfileでは不足。役割付き公開hook未成立ならunsupported。librariesだけreadyでも不可 |
| compilerClasspath | 実Configuration／compile consumerのidentity・選択済みcompiler実装profile・順序付き実file列へ束縛。所有者による自然なartifact/file値の消費完了receipt、または全file sourceに関する安定再読取の公開保証を必要とする | Configuration.state、beforeResolve／afterResolve、dependency graphの解決だけでは不足。これらcallback内でfilesを読んで自然消費を作らない。現在unsupported |
| Task.inputs | 実Task instance・当該stage・全input role／source登録とread-plan digestへ束縛。所有者が自然に列挙したaggregateのreceipt、または全入力の安定性と自然消費を保証する専用公開recipeが必要 | hasInputs／didWork、named propertyの一部、libraries等の和集合だけで実aggregateの完全性を推定しない。未知supplier／CopySpec／live treeが残ればunsupported。現在unsupported |

Task.inputsの完全なreceiptが他slotを含んでも、slot別のrole・順序・派生対応の証拠を代替しない。逆に他の3 slotがreadyでもTask.inputsはreadyにならない。物理fileの重複は許可したrole間で参照共有できるが、各slotのstate・binding・完全性を共有して省略しない。Task.outputs、設定、plugins、descriptor／resources、Jar等の残るread planも既存のgateを維持する。

#### 9.22.4 tokenと非評価の準備判定

bindingは`{producer, invocationId, pipelineId, stageId, slotId, ownerKind, recipeId, captureMode, profileDigest, readPlanDigest, ownerInstanceId, propertyRole}`。ownerInstanceIdは自然な所有者登録callbackで受け取った実instanceをinvocation内のidentity ledgerへ結んだ参照であり、task path／Configuration名やJSON上のIDだけでは発行しない。observerがTaskProvider.get／KGP getter／Configuration解決を呼んでownerを探すことは禁止。非評価での登録経路がなければbinding未成立とする。

slot状態はunbound → registered → materializing → ready、またはfailed／invalidated／unsupported。tokenはledger発行のopaque identityとし、readyは以下をすべて満たしたときだけ付与する。

1. recipe・信頼profile・runtime bindingが承認tupleと一致し、登録とsealが自然消費より前に閉じている。
2. 同一bindingで自然処理のbeginと正常complete、またはpublic-stable-rereadの全witnessが揃う。開始だけ、別slotの成功、task成功だけ、前invocation／別producerのreceiptでは不可。
3. owner-materializedは具体的なFile値の列だけを受け取り、許可されたsource形・順序・重複・上限・境界・所有roleを検証し防御的copyを完了している。Listの中のProvider／Closure／FileCollection／FileTreeや未知Iterableを展開しない。各fileの自然消費時点のsize／SHA-256と、保存bytesまたは検証済みbaseline参照が§9.22.8に従って揃い、保存証拠が検証済みになっている。File列だけやdigestだけでreadyにしない。派生snapshotとtoolchain fileは既存の専用boundary／storage予算規則を適用する。
4. receipt／witnessの欠落、重複begin／complete、再入、追加消費による値不一致、評価失敗、seal後の構成変更がない。失敗後の再試行・ID変更でreadyへ回復させない。実体への変更防止が公開APIでできない範囲は既存の作者表明と承認sourceに依存し、独立検出と区別する。

capture準備確認はledgerのstate・token・承認済みdigest・immutable receipt参照だけを読む。確認中にfile hash取得・file existence probeを含む対象collectionの探索を行わず、slotが準備できたかを試し読みしない。実instanceから新たに公開propertyを取得する照合もgate後のcapture recipeへ限定し、ready判定をその照合結果に循環依存させない。

全read planのowned handleとKGP slotを一括preflightし、一つでも未準備なら**既にreadyな他slotも含めてsource getter 0回**でunavailableとする。owner receiptは既に自然処理で生成された証拠であり、その存在はobserverのsource読取ではない。preflight中に新しいreceiptを生成しない。成功時もowner-materialized modeは元のKGP getterを呼ばない。自然処理で確定済みの内容証拠を使い、保存された具体pathの現在bytesをその証拠と照合する。captureで初めて取得したhash／snapshotを自然消費時点の証拠へ昇格させない。public-stable-reread modeだけが承認済みのgetterを共通reader経由で呼ぶ。

#### 9.22.5 信頼・manifest・metadataと拒否理由

既存pipeline／loader／producer-ownedの信頼を満たした上で、承認profileに`kgpCaptureRecipes`をstrictなversion付き要素として追加する案とする。各要素はslot role、captureMode、tuple（Gradle／kotlin-dsl／KGP／compiler／JDK identity）、公開API根拠、bridge／collector code digest、owner source／artifact digest、token issuer、自然消費phase、必要witness、許可source形・mutation制限、storage policyを含む。新しいmode・API・pluginはruntimeでgraphから動的登録しない。profile digestの承認は起動時固定で、producerが自己承認しない。schemaと環境設定の実装は別工程とする。

新しいexport証拠案`kgpInputReadiness`に全slotのbinding、state／reason、token ID、begin／complete／failureの順序と由来、receiptまたはwitnessの参照、runtime実装／profile digest、capture開始・getter event inventoryを保存する。public-stable-rereadには公開根拠とwitness、owner-materializedには自然消費時点の内容証拠を含む実具体列receiptが必須で、modeを交換して不足証拠を迂回しない。MCPはnative tokenの実体を再実行・復元せず、保存された来歴・参照・hash・許可profileを検証する。token自体を署名／独立証明と扱わない。

| reason案 | exportでの処理 | 取込結果 |
| --- | --- | --- |
| kgp_capture_recipe_unsupported／profile_not_approved／trust_disabled | gateを閉じ、対象source getterを呼ばない | 有効なunavailable証拠ならcontributing GAVのdeclared_in全体を省略。検証済みrelation／introduced_by・lock由来coverageは維持 |
| kgp_capture_not_evaluated／evaluation_in_progress／evaluation_failed | probe・待機用読取・再試行をせず全体unavailable | 部分的な宣言元一覧を返さない |
| kgp_capture_binding_incomplete／inventory_incomplete／invalidated | 非評価で発覚した不完全登録・未知sourceはcaptureしない | 有効なunavailable状態は省略。不正参照・自己矛盾・改変証拠は別途graph拒否 |
| kgp_capture_getter_before_gate／unapproved_getter | 実際の読取をevent＋counterで記録し、成功receiptを採用不可にする | 非干渉違反として採用しない。読取による副作用を元に戻せるとは主張しない |
| 不正schema・別invocation参照・receipt／blob hash不整合 | 成功証拠を発行しない | graphを拒否。信頼無効・mapping未表明でもintegrity検査をskipしない |
| kgp_capture_content_evidence_unavailable | 承認recipeに自然消費時点の内容取得hookがない、または自然処理での取得がI/O失敗・容量超過で完了しなかった。readyを発行せず、gateを閉じてsource getter 0 | 有効なunavailable証拠として宣言元全体を省略。合法な未対応状態として扱う |
| 内容証拠の意図的な欠落・自己矛盾（ready済みなのにcontentBindingsが無い、件数・fileId対応が合わない等） | 成功証拠を発行しない | schema／証拠不整合としてgraphを拒否。unavailableへ格下げしない |
| receipt後・capture前の内容変更（stale） | 最初のcaptureから自然時のsize／digestと照合し、不一致なら採用不可。capture時のhashで置き換えない | slotの型に従う既存理由。libraries・compilerClasspath・Task.inputs内のtoolchain／baseline物理fileは`kotlin_pipeline_inputs_stale`、classpath snapshot等の派生fileは`kotlin_derived_snapshot_stale`。Task.inputsは含まれる各fileの型で判定する。いずれもinput_status=invalidとし、宣言元は採用しない |
| 保存blob・chunkが自然時digestと不一致 | 成功証拠を発行しない | `kotlin_pipeline_snapshot_storage_mismatch`でgraphを拒否。capture unavailableへ格下げしない |

metadataにはcaptureMode／recipe／profile、slot別のinput_statusとready根拠、`kgp_readiness_owner_or_recipe_attested`、未観測の内部supplier・一時変更の検出限界を残す。owner receiptの取得可能性だけでsource mappingや全pipeline完全性をverifiedにしない。snapshotのaggregate対応・JAR全entry・一時MANIFEST・既存loader信頼・context併合の条件は独立に適用する。

#### 9.22.6 公開APIでの採用条件と次の実証

各slot・mode・tupleごとに次の条件を満たすまでregistryへ載せない。

- exact versionの公開型・method・hookが実在し、登録だけではtask realize／Provider評価／解決／transformを起こさない。既存KGP classpathSnapshotProperties等を別KGP版へ名前だけで流用しない。
- owner-materializedは実際の所有者の自然消費と同じ値をpublic hookから受け取れること。専用synthetic taskでのbridge動作は仕組みの実証に留め、実KGP recipeの採用へ数えない。public hookが見つからなければunsupportedの結論も保存する。
- public-stable-rereadは公開保証、非評価のruntime readiness判定、実KGP＋非空入力での全observer非干渉をすべて示す。compilerClasspathがRESOLVED等のproxyや、追加信頼だけで保証を補わない。
- controlは同じowner integrationを持ちobserverだけ無効。元build無変更のbaselineとも比較し、評価契約の変更は別記する。全observerと同じread planで、計測supplier／Provider／Action／解決／transformのphase・回数・順序とartifact内容を比較する。全内部supplierの観測保証は主張しない。
- 全slot・stage・metadata・package整合が成立した構成だけを全pipeline候補とする。1 slotの成功や故障readerの拒否を全体採用へ数えない。

初回調査はGradle 8.11.1／9.2.1 × Groovy／Kotlinの同DSL consumer・producer、included root binary Kotlinを別tupleで扱う。buildSrc／precompiled／plugins-block・全DSL交差は後続matrixに分け、未対応tupleへ陽性結果を流用しない。公開API調査とsynthetic receipt実証、実KGP owner hook／安定性recipe実証、全observer対照を段階別に記録する。

#### 9.22.7 回帰条件（KI01〜KI26、すべて未実施）

| ID | 条件・期待結果 |
| --- | --- |
| KI01 | 4 slotそれぞれで公開hook／公開保証と実版・実artifactを確認。API不在・未承認tupleはunsupported、対象getter／評価／解決0。internal APIで代替しない |
| KI02 | binding登録だけでTaskProvider.get・slot getter・Provider・依存解決・transformが実行されない。source／collector hashをrun前後で照合 |
| KI03 | 各slotの未評価・評価中・評価失敗で、readyな他slotも含む全source getter 0。状態照会のget／isPresent／isEmpty等probeを故障として拒否 |
| KI04 | task成功／didWork／NO-SOURCE／up-to-date／cache hitだけでreadyにしない。自然消費を省いたtaskでも成功する負例を含める |
| KI05 | ConfigurationがRESOLVED、afterResolve発火でもfile sourceの自然消費未完了ならcompilerClasspathを拒否。独立したartifact値の遅延評価を含める |
| KI06 | snapshot fileが前runから残る、別consumer stageが作る、別ArtifactViewだけ成功、librariesだけreadyの各負例を拒否 |
| KI07 | owner-materializedの非空・異なるbytesの複数file列と自然消費時点のsize／SHA-256・保存bytesまたはbaseline参照をready前に保存・検証。元source getter再読取0。内容証拠を得るためだけの追加collection読取を拒否 |
| KI08 | public-stable-rereadは公開保証とwitnessが揃ったtupleのみ許可。trace一致だけ・作者assertionだけ・事後固定化での成立を拒否 |
| KI09 | 同名task／Configuration、別実instance・slot role・stage・producer・invocation・profileのtokenを拒否。handle IDの文字列一致で回復させない |
| KI10 | begin／complete／failure欠落・重複・順序逆転・seal前完了・評価中再入・失敗後再試行を拒否。必須event一覧をnative／集約で共有 |
| KI11 | 返却listの変更をcopyで隔離。Provider要素・入れ子・live tree・未知Iterable・境界外入力は自然処理内で拒否。拒否のための追加評価0 |
| KI12 | libraries sequenceと派生snapshotのaggregate sourceSequenceを結び、順序・重複・別cohort・個別JAR対応への偽装を拒否 |
| KI13 | compilerClasspathの実file列と選択compiler profileを結ぶ。toolchainへの誤分類で境界／容量制限を迂回できない |
| KI14 | Task.inputsの未知property／supplier／CopySpec、部分slotの和集合だけの証拠はinventory不完全。未知入力を試し読みせず拒否 |
| KI15 | 全preflight完了前にreadyなowned handleまたはKGP readerを実際に読む故障を追加。cached読取でsupplier回数が不変でもevent＋counterで拒否 |
| KI16 | modeごとにgetter許可一覧を強制。owner receipt modeでの元getter読取、再読取modeでの未承認getter、event／counter不一致を拒否 |
| KI17 | 必須token／witness／receipt／slot inventoryを削除、mode交換、旧schemaへdowngrade。未表明を完全扱いにしない |
| KI18 | receipt完了後・最初のcapture前に派生fileを同pathで変更し、同size・mtime復元の場合も自然消費時点の証拠とのdigest不一致でstale拒否。削除・想定外追加・snapshot blob改変・容量超過も拒否。captureで初めて取ったhashを基準に成功させない（§9.22.8、KI23〜KI26） |
| KI19 | 信頼無効・profile未承認・recipe不足は有効unavailableとして宣言元全体省略。不正hash・別invocation参照はgraph拒否。relation／introduced_by維持と区別 |
| KI20 | 全observerの同一read planでcontrol／observerを比較。一部getterを省いた対照、空sensorだけ、別版・古いsource・偽の故障flagでは成立扱いにしない |
| KI21 | 一つのcontext／scope／slotが未準備ならdeclared_inの部分一覧を出さない。正常slotのreceiptだけで完全としない |
| KI22 | buildSrc・precompiled・plugins-block・DSL交差・cache／parallel等は別matrixで採否を記録。未実施をskipのまま成功件数や全pipeline候補へ加算しない |
| KI23 | receipt-bytes／baseline-refの両経路で、自然消費時点のsize／digest・保存証拠・時刻束縛の各欠落を拒否。path列だけ、digestだけ、capture後生成の証拠ではreadyにしない |
| KI24 | baselineが前invocation／別producer／slot／fileを参照、natural時再検証を欠く、古いsize／digestを流用、blobを欠く負例を拒否。承認toolchainの共有blobでも現invocationの自然時照合証拠を要求 |
| KI25 | receipt完了と最初のcaptureの間にnative側で実際の派生fileを改変。保存bytes／baseline-ref両経路、両DSL・両Gradle版でstale理由を確認。source getter 0、元の保存証拠を変更後bytesで上書きしない。改変は使い捨ての`GRADLE_USER_HOME`、または派生fileのコピー上で行い、他の検証と共有するcacheを変更しない |
| KI26 | 自然処理のhash／copy中の変更・保存失敗・容量超過でreadyを発行しない。保存bytes単独改変／sourceと保存blob両方の改変も元digestへ照合して拒否。戻した一時変更は検出限界として区別。改変・保存失敗の注入もKI25と同じく隔離したcache上で行う |

本節で確認したのは公開interfaceのシグネチャと設計上の不足条件だけである。KI01〜KI26のnative実証、KGPの実owner hook、再読取の公開安定性保証はいずれも未成立。次はこの設計のレビュー後、slot別の公開API調査と、成立しなければno-readのままunsupportedを維持する実証へ進む。


#### 9.22.8 receipt時点のfile内容の束縛（レビュー修正、設計のみ）

具体的なFile列のcopyはpath集合を固定するだけで、自然消費時点のbytesを保存しない。receipt後に生成snapshotが同pathで置換され、captureで初めてhashを取得した場合、消費時と異なるbytesを成功として保存する穴がある。このためowner-materialized modeでは、以下をcompleteの必須入力とする。

`contentBindings`はconcreteFilesの全要素へ順序・logical file ID・実path identity・roleを双方向対応させる。各entryは`{fileId, role, naturalObservation, size, sha256, storage}`を持つ。sizeは非負safe integer、sha256は小文字hex64桁、空fileにも正しいdigestを要求する。naturalObservationは同じproducer／invocation／stage／slot／tokenと、owner-natural-materialization phase、begin／end ordinal、所有者の消費との対応を記録する。後のcapture eventをnatural時刻としてラベルし直さない。

| storageの型 | 必須証拠と成立条件 |
| --- | --- |
| receipt-bytes | 自然消費経路で得た具体fileを安全にopenし、同時点のsize／SHA-256と内容bytesを有界streamingで取得する。保存済みFileSnapshotのsize／結合digest／全chunkを照合し、検証済みのstaging内immutable参照をcompleteへ渡す。元のpath列やdigestだけでは不足 |
| baseline-ref | 既存のphysical／stage-output／toolchain／derived baseline内のfile IDと、既に検証されたsize／digest・保存bytes参照を指定する。**同じ自然消費時点で実fileを再検証して一致した証拠**を必須とする。古いbaselineの存在、profileに期待digestがあること、mtime／size一致だけでは代用しない。参照先のbytesが保存されていない場合は不可 |

どちらの経路も、自然処理で既に具体化されたpathを使う。内容証拠作成のためにKGP getter・Provider・FileCollectionを追加読取しない。物理fileのhash／copyは所有者側の承認recipeに組み込み、controlでも同じ処理を行って非干渉を実証する。preflightは完成した証拠参照だけを検査し、そこでhash／copyを始めない。適切な自然処理hookや消費時刻との結び付けがない場合はunsupportedのままとし、事後読取で補わない。

baseline-refもproducer／invocation／stage／slotとの自然時照合参照を現invocationへ束縛する。profileで承認されたtoolchainの共有content blobを使う場合でも、参照先の検証・現invocationの実fileとの自然時一致を省略しない。別slot／別producerのdigestが偶然同じでも、内容blobの共有と来歴の共有を混同しない。単なるstage開始前baseline参照だけでは自然消費時点への束縛にならない。

内容の取得・保存には§9.5のsafe-reader、開いたfileの同一性、境界・symlink・特殊file拒否、1 MiB buffer／chunk、区分別上限・共有予算を適用する。directory等は承認recipeと全tree内容証拠が別途成立した場合だけ扱い、regular fileのentryへ偽装しない。hash／copy中の変更、I/O失敗、参照切れ、容量超過ではcomplete成功・readyを発行しない。通常入力をtoolchain-onlyへ移して上限を回避しない。ready時点では証拠が検証済みstaging内に保存されている必要があり、全体exportのatomic publish前にこれを外部の成功graphとして公開しない。

全体gate通過後のcaptureは、元collectionを再評価せず、receiptに保存した具体pathの現在bytesをnaturalObservationのsize／digestと照合する。**最初のcaptureでもこの比較が必要**で、capture時hashを新baselineとして登録し直さない。package・export終了時も既存の再検証を続ける。MCPは境界内の保存証拠と参照・chunk・digestを検証し、外部の元pathを追跡しない。sourceの現状確認はexport側の責任である。

自然時証拠と現在bytesの不一致は既存の型別stale理由（派生snapshotならkotlin_derived_snapshot_stale）で採用不可にする。保存blob／chunkがnatural時digestと一致しない場合はkotlin_pipeline_snapshot_storage_mismatchでgraph拒否し、capture unavailableへ格下げしない。自然時証拠が未取得ならready不可であり、後で取得したhashで埋め合わせない。不正schema・意図的な証拠欠落と、合法な未対応状態は区別する。receiptそのもののhash・bindingも保存証拠へ結び、sourceとblobを一緒に変更しても元のdigestを書き換えて成功にしない。

この方式もcompilerが実際に読んだ全bytesの独立証明ではない。自然消費hookと検証区間の対応、消費中不変は承認recipe／所有者契約に含める。観測の間に変更して元bytesへ戻す一時変更は検出保証外と明記する。実施済みv3観測は内容receipt方式の証拠へ流用せず、KI07／KI18と新規KI23〜KI26はすべて未実施とする。


#### 9.22.9 6e1ac6cレビュー修正（設計のみ）

- §9.22.5の理由表へ、§9.22.8で定めた結果を加えた。自然消費時点の内容証拠を取得できない合法な未対応（`kgp_capture_content_evidence_unavailable`、宣言元全体を省略）と、ready済みなのに証拠が欠ける・矛盾する不整合（graph拒否）を別の行に分けた。receipt後・capture前の変更はslotの型で既存のstale理由へ対応付けた（toolchain／baseline物理fileは`kotlin_pipeline_inputs_stale`、派生fileは`kotlin_derived_snapshot_stale`）。保存blob不一致は`kotlin_pipeline_snapshot_storage_mismatch`でgraphを拒否する。
- §9.22.1に、javapで確認したgradle-core-api JARのSHA-256、対象interface、method数、出力digestと手順を記録した。3 interfaceのシグネチャは両版で同一だった。KGPの公開APIはこの確認に含まれない。
- §9.22.2のowner-materializedの説明を、observerが元のKGP getter・Providerを読まず、receiptと記載された実fileのbytesだけを読む、と§9.22.4／§9.22.8に合わせた。
- KI25／KI26の改変注入を、使い捨ての`GRADLE_USER_HOME`か派生fileのコピー上で行う条件にした。共有cacheは変更しない。

実装・native実行・検証JSONは変更していない。4 slotの既定unsupportedと、全pipeline候補・本番採用0件の判断は維持する。


### 9.23 KGP所有4入力の取得可能性調査・公開API診断（2026-11-01）

初回v1の記録。API binding・故障trace検証の修正後の主観測は§9.24のv2を参照する。初回要約は検証JSONのpreReviewsへ保持する。

§9.22の最初の工程として、実KGPの4 getterの診断読取と、全slot unsupported時のno-read拒否を新しいtest-onlyハーネスで確認した。**自然消費時の内容束縛receipt・承認済み再読取recipeは未成立。全pipeline候補／本番採用は0件のまま。** KI01〜KI26の全達成や、本番captureの実装完了を意味しない。

#### 対象と公開API調査

Groovy consumer＋Groovy producer、Kotlin consumer＋Kotlin producer、included build rootのbinary Kotlin、標準kotlin-dslをGradle 8.11.1／9.2.1で実行した。実際に適用されたKotlinPluginWrapperのCodeSourceから選択JARを記録し、ハーネスと集約でdigestを独立照合した。8.11.1はkotlin-gradle-plugin-2.0.20-gradle85.jar、9.2.1はkotlin-gradle-plugin-2.2.20-gradle813.jarだった。ファイル名・cacheの存在だけで選択実装を決めず、nativeで得たCodeSourceとhashを起点に調査した。compilerの全実装選択・toolchain完全性を独立検証したものではない。

`gradleKgpAvailabilityResults.mjs`は、選択KGP JARと対応API JAR、対象Gradleのcore-api JARのhash、および14 public JVM型のjavap -public出力を保存する。調査対象はHasConfigurableValue、ConfigurableFileCollection、FileCollection、TaskInputs、Configuration、ResolvableDependencies、Task、KotlinCompile、ClasspathSnapshotProperties、AbstractKotlinCompile、AbstractKotlinCompileTool、KotlinCompileTool、KotlinCompilerArgumentsProducer、KotlinJvmCompileである。javapはofflineのAPI調査にのみ使い、native observerからreflectionやmangled internal methodを呼んで入力を取得しない。JVM上のpublic可視性を、安定した公開拡張点の保証と混同しない。

この調査範囲では、自然消費した同一の具体file列を渡す所有者hookと、全4 slotの準備完了を非評価で確認するrecipeを確立できなかった。これはKGP全公開APIを網羅した不存在の証明ではない。KotlinCompilerArgumentsProducerやserialized argumentsのmethod名があるだけで、具体値receiptの非評価取得を可能と判定しない。Configurationの解決callbackもfile列の自然消費完了tokenとは扱わない。

snapshot getterの詳細annotationは両KGP版で@Classpath／@Incremental／@Optionalだった。Gradleの[HasConfigurableValue契約](https://docs.gradle.org/current/javadoc/org/gradle/api/provider/HasConfigurableValue.html)にあるtask propertyの固定化は、限定再読取recipeの次の調査候補である。ただしこの注釈と今回の追加評価0だけでは、実instance／propertyの非評価binding、全前提のruntime witness、deepな再評価の不存在、消費時点の内容束縛まで成立しない。snapshotだけをsupportedへ変更しない。

#### native診断の方法

新しい`gradle-kgp-availability.init.gradle`は、同じ未固定sensorをcontrol／diagnostic／unsupportedへ入れる。libraries・snapshot・compilerClasspath sensorは空の具体list、Task.inputs sensorは非空の実fileを返す。既存KGP collectionにfinalizeValue／finalizeValueOnRead／disallowChangesを呼ばず、Providerの事後wrapや置換も行わない。sensor追加自体は試験用の構成変更であり、元build無変更での透過取得実証にはしない。

実compile成功後のdiagnosticだけ、libraries → classpath snapshot → compilerClasspath → Task.inputsの順に、公開getterを一度ずつ実際に読む。すべてのadapter読取を共通のreadSlotへ集約し、getter eventとslot別counterを照合する。getter直前／直後のsensor回数と、そのread phase中のeventを結び、実file集合をhashする。snapshot・compilerの空sensorがあっても、取得した元collection自体はすべて非空である。これは**順序付きの取得診断であり、slotごとに独立したbuildや本番observerと同じ全read planではない**。先行getterによる状態変化を除去した独立の非干渉保証にはしない。

unsupportedは承認recipe一覧が空であることだけで全4 slotを拒否する。getter closureをprobeしない。通常compileに必要なGradle／KGPの自然評価・解決は実行されるので、0なのは追加のobserver source getterである。自然評価そのものを止めた結果ではない。controlとの自然supplier・Action・task・解決event列一致を共有verifierで確認する。さらにfaultSnapshotRead故障では、unsupportedのsnapshot gateでreadSlotを実際に呼ぶ。この故障buildには先行diagnostic読取がなく、snapshot read phaseの計測supplier追加評価は0だった。それでもgetter eventとcounter 1によりkgp_availability_no_read_violatedで拒否する。集約でも実getter event 1件と追加計測supplier 0件を確認する。flagだけで故障を主張した記録や、故障flagの承認不一致は成立証拠にしない。

#### 実測結果と採否

| slot | 実collectionの要素数（8.11.1／9.2.1、各DSL共通） | 対応sensorの診断中の追加評価 | 判定 |
| --- | --- | --- | --- |
| libraries | 25／22 | +1 | このraw getter再読取は非干渉でない。unsupported |
| classpath snapshot | 23／20 | 0 | 今回の順序付き対照では追加を観測せず。準備recipe・内容receipt未成立のためunsupported |
| compilerClasspath | 8／7 | +1 | afterResolveが既に自然処理で発火していても追加評価あり。unsupported |
| Task.inputs | 39／35 | +1 | task成功後でも未固定の入力sensorを再評価。unsupported |

対応sensor以外の診断中deltaは全組0だった。control／unsupportedの自然評価回数は、libraries各3回、snapshot各2回、compilerClasspath各2回、Task.inputsは8.11.1で4回・9.2.1で3回だった。unsupportedでは全4 getter eventが0、全4 slotにkgp_capture_recipe_unsupportedを記録した。

通常は4 fixture×3 mode＝12 native build。さらにunsupportedでsnapshot getterを実際に呼ぶ故障4 buildを追加し、合計16 native buildとする。4 slot×4 fixture＝16診断と16 no-read拒否、実snapshot読取4負例を保存する。各build後にハーネスがJAR bytesからarchive SHA-256と全entryを取得し、3 modeのentry内容一致を確認する。故障proofは通常control／diagnosticと故障runを組み合わせ、集約でも同じno-read理由を再検証する。archive hashそのもののmode間一致は要求しない。このarchive記録をKGP消費入力の内容束縛証拠へ読み替えない。

#### 記録・検証器・再現

[検証JSON](validation/gradle-kgp-availability-2026-11-01.json)にnative run・実版・run UUID・mode・選択実装／source／fixture hash・compile状態・supplier delta・全診断file inventory・no-read拒否・JAR entry・API調査を保存する。共有`gradleKgpAvailabilityProof.mjs`をnativeと集約で使い、記録済みcounterとtrace、必須mode／slot／event、compile失敗、no-read違反、実装変更、artifact内容変更、偽のadoptionを拒否する。現在sourceと一致しない観測を再ラベルしない。

JDK 21と標準kotlin-dsl依存cacheを用意し、JAVA_HOME／GRADLE_USER_HOMEを設定する。次を対象2版で実行する。runtime rootにはgradle-8.11.1／gradle-9.2.1を含むdirectoryを指定する。

```sh
OSV_MCP_TEST_GRADLE=/path/to/gradle-8.11.1/bin/gradle OSV_MCP_KGP_AVAILABILITY_OUTPUT=/tmp/kgp-availability-8.11.1.json npx vitest run src/test/gradle/kgpAvailability.integration.test.ts --maxWorkers=1 --hookTimeout=120000
OSV_MCP_GRADLE_RUNTIME_ROOT=/path/to/runtime node src/test/manual/gradleKgpAvailabilityResults.mjs /tmp/kgp-availability docs/validation/gradle-kgp-availability-2026-11-01.json
npx vitest run src/test/gradle/kgpAvailability.test.ts --maxWorkers=1
```

#### 成立範囲と次工程

KI01の公開API調査と未対応拒否、KI05の解決後でもcompiler file再評価が起こる対照、KI15／KI16に関する診断／no-readの計測を部分的に確認した。opaque binding／owner token、自然消費時内容receipt、KI23〜KI26の保存bytes／baselineの実改変対照は未実装である。全observer非干渉、未知入力の本番登録gate、buildSrc／precompiled／plugins-block、DSL全交差、本番schema／adapter／readerは未検証のまま。

次は本調査のレビュー後、snapshot propertyに限定した公開固定化契約・自然消費witness・非評価bindingの成立性を詳しく調べる。または所有者が自然消費値を渡す公開hookを具体的に特定する。いずれも成立しなければunsupportedを維持し、synthetic bridge実証や過去の事後固定化結果だけで本番採用しない。


最終検証: Gradle 8.11.1／9.2.1は両DSL合わせて各14件成功、終了処理も成功。16 native build、16 slot診断、16 no-read拒否、snapshot実getter負例4件を保存した。静的回帰31件、通常全体2,028件成功・native opt-in等1,113件skip。typecheck・build・差分チェックも成功。初回の型チェックで見つかった静的fixtureの未定義可能なcounter更新は修正して再確認した。本番採用0件・全pipeline候補0件を維持する。


### 9.24 KGP取得診断レビュー修正・API bindingと故障trace（2026-11-01）

§9.23のレビュー2件を修正した。修正前に、8.11.1用directoryへ9.2.1のcore-api JARを置いたAPI調査と、故障getter／追加supplierを不正phaseへ移したtraceが集約で受理されることを再現した。新しい回帰テストでも、異なるAPI artifact・不正phase・getter区間外の追加評価が拒否されないことを確認してから修正した。変更はtest-onlyで、本番採用・全pipeline候補はともに0件のままとする。

#### 実ロード元とAPI調査対象の照合

nativeでTaskInputsのClass CodeSource（Gradle API）と、実KotlinPluginWrapperのclassloaderがロードしたKotlinCompileToolのCodeSource（KGP API）を記録する。各々の公開型名・canonical artifact path・SHA-256を`apiArtifacts`へ保存し、control／diagnostic／unsupported／故障runで一致を要求する。ClassLoaderによる型のロード元確認はmetadata調査だけに使い、reflectionでinput propertyや内部snapshotを取得しない。KGP本体のCodeSource記録も維持する。

ハーネスと集約は実fileのhashを独立再検証する。集約のGradle runtime directoryは、core-api候補が一つだけあることに加え、realpathとdigestがnativeの記録と両方一致することを要求する。版を示すdirectory名・JAR名だけで採用しない。別Gradle API、同名にrenameした異なるbytes、候補の曖昧さはkgp_availability_api_artifact_mismatchで拒否する。正しい実体へのdirectory／symlink aliasはcanonical化して許可する。

KGPの補助API JARもcache内の同版候補を列挙して選ぶ方式を廃止し、実ロードされたKotlinCompileToolのartifactだけを調査classpathへ入れる。調査は実KGP本体・実KGP API・nativeと照合したGradle APIの3 artifactへ束縛する。どの型にも汎用の自然評価完了hookがないと網羅的に証明した扱いにはしない。

#### getter区間と故障証拠の検証順

native readerは各slotのslot:begin/endと、実getterのgetter:<slot>／getter:end:<slot>を記録する。endはfinallyで記録し、順序・件数・counter・phaseを共有verifierが照合する。診断のbefore／after counterもphase名のfilterではなく、対応getterのevent index区間にある全supplier eventから再計算する。違うphaseへ移したsupplierを無視してdelta 0と判定しない。

故障proofでもschema・実版・source／fixture hash・実装／API binding・compile状態・全slot／task／Action境界・gate順序・file／artifact証拠・自然traceの一致を先に検証する。その後で、snapshot getterが一度実行された期待故障をkgp_availability_no_read_violatedとして認定する。最初のgetterを見つけた時点で検証を終了しない。

不明phaseはkgp_availability_trace_phase_invalid、gate／diagnostic phaseのsupplierが実getter開始〜終了の外にあればkgp_availability_supplier_outside_getterで拒否する。正常なnatural phaseへ移した追加評価も、controlとのevent列不一致で拒否する。getter内に本当に追加評価がある場合はkgp_availability_fault_extra_evaluationとして、今回のcached-read故障の成立へ数えない。slot区間・getter区間・task区間を混同せず、event名だけ正しい不正な位置も拒否する。

通常のGradle task graph準備では、登録終了後・最初のtask開始前にsupplierが評価される。このconfiguration phaseは登録処理中の評価とは別で、当該範囲のsupplier eventだけ許可する。最初の再検証ではこの通常処理も不正phaseとして拒否してしまったため、旧v1 traceで範囲を確認し、専用回帰を追加した。故障読取後の追加評価をconfigurationとラベルし直しても、その範囲外なので拒否する。

#### 共有回帰・v2記録

故障改変の14条件を`kgpAvailabilityRegressionTargets`で定義し、native／静的テスト／集約で共用する。不正なgetter開始／終了phase、不正phaseのsupplier、getter前後・slot前後への移動、configurationへの偽装、natural列への追加、必須区間欠落、故障artifact欠落、API binding不一致、getter内の実追加評価を含む。nativeが実際に得た例外理由を保存し、集約でも全改変を再実行して理由一致を要求する。期待したno-read理由なら何でも良い、という判定にはしない。

API不一致の純粋照合に加え、異なるGradle版のAPI JARを置いたdirectory、正しい実fileへのaliasを使うfile-system回帰を追加した。nativeで記録したKGP APIのbindingをGradle APIのbindingの代わりに照合し、拒否されることも確認する。これは記録済みの2つのbindingを交換した静的対照であり、native buildへ別artifactを実際に読み込ませた負例ではない。

case／run／matrix／experimentはv2へ更新する。主観測を修正後sourceで取り直し、旧v1要約をpreReviewsへ保存する。v1は未コミットのためrecordSha256は参考値で、リポジトリ内のコミット済み原本との照合証拠とはしない。再現コマンドは§9.23と同じで、通常native実行が新しい回帰も含む。

取得診断の採否は変えない。libraries／compilerClasspath／Task.inputsはraw再読取で追加評価あり、snapshotは限定した計測で追加評価0でも準備recipe・消費時内容receiptが未成立なのでunsupported。全observer、owner-materialized receipt、buildSrc／precompiled等を成立したものとして扱わない。


| v2再検証 | 結果 |
| --- | --- |
| Groovy／Kotlin × Gradle 8.11.1／9.2.1 | 各版native 18件成功、終了処理も成功。成功した最終16 buildを保存 |
| 取得診断／no-read | 各16件、実snapshot getter故障4件。getter区間と全証拠を再検証 |
| 故障traceの改変 | 14条件×4組＝56件を拒否、集約で全件再計算 |
| runtime API不一致 | 記録済みbindingを交換した静的対照4件に加え、実8.11.1／9.2.1のcore-api directoryを相互に提示した2件を拒否 |
| 静的回帰 | 56件成功。異なるAPI directory・同pathのbytes変更・正当なalias・不正phase／区間外評価等 |

通常全体2,053件成功・native opt-in等1,117件skip。typecheck・build・差分検査も成功。現在source／API artifactのhash照合と故障回帰の再計算を確認した。初回の過剰拒否で失敗したnative実行は成功件数に含めず、修正後の両版結果を採用した。snapshotの採用未成立、本番採用・全pipeline候補0件の判断は維持する。


### 9.25 5149117レビュー修正・記録pathの可搬化（2026-11-01）

#### 端末固有pathの除去

§9.23・§9.24の検証JSONは、選択KGP JAR・KGP API JAR・Gradle core-api JARの位置を、検証した端末のcache／runtimeの絶対pathのまま保存していた（82か所）。公開する記録に端末固有のpathを含めない方針に反し、集約の再検証もその絶対pathに依存していた。

集約ハーネスは、native記録の絶対pathで従来どおり全artifactのhashを再検証した後、公開する記録だけをtokenへ置き換える。`$GRADLE_USER_HOME`は`GRADLE_USER_HOME`、`$GRADLE_RUNTIME`は`OSV_MCP_GRADLE_RUNTIME_ROOT`の値と実path（realpath）の両方を置換元とし、全run・API調査・別版directory対照に同じ規則を適用する。書き出し前に記録全体を走査し、置換後も絶対pathが残れば`kgp_availability_record_path_not_portable`で書き出さない。記録の`pathTokens`がtokenと環境変数の対応を示す。

tokenから実pathへ戻す`resolveRecordedPath`は、対応する環境変数が絶対pathとして設定されている場合だけ解決し、`..`・空要素・tokenのない絶対pathを拒否する。補助moduleは`src/test/manual/kgpRecordPaths.mjs`で、検証用sourceとして`verificationSourcesSha256`へ含める。native観測のsource（`kgpAvailabilitySources`）は変更していない。

#### 再集約と観測時点の保持

Gradleは再実行していない。§9.24で保存したv2のnative生出力を同じ集約ハーネスで再集約した。tokenへの置換を除き、matrices・API調査・別版directory対照・preReviews・source hash・scopeは修正前の記録と一致した。native run IDの集合が前の記録と同じ場合、集約は観測時の`recordedAt`と`baselineRevision`（fdddf81）を保持し、再集約の時刻とrevisionを`reconsolidatedAt`／`reconsolidatedRevision`に別記する。

静的回帰に3件を加えた。cache／runtime pathと`jar:file:`内のpathの置換、置換対象外の絶対pathの検出、tokenの解決・拒否規則、公開記録全体に端末固有pathがないことである。最後の回帰は、修正前にコミットした記録では失敗することを確認した。

#### 表現の訂正と範囲

§9.24の「native別API artifact対照」は、記録済みのGradle APIとKGP APIのbindingを交換して照合する静的対照だった。native buildに別artifactを読み込ませた負例ではないため、そのとおりに訂正した。

5149117のcommit自体には絶対pathが残る。取得診断の採否、全4 slotのunsupported、本番採用・全pipeline候補0件の判断は変わらない。


### 9.26 snapshot限定の実参照binding・実行完了witness（2026-11-01）

初回v1の実証記録。cached preflight読取とTaskState検証のレビュー修正後の主観測は§9.27のv2を参照する。初回要約はpreReviewsへ保持する。

§9.23〜9.25のsnapshot追加評価0という観測を、**producer協力型の参照登録と実行完了witness**へ進めるtest-only実証を追加した。新しい本番recipeを承認したものではなく、全4入力の既定unsupported・全pipeline候補／本番採用0件は維持する。`conditionalRereadWitness`は以下の限定fixtureで条件と観測が揃ったことを示すだけで、public-stable-reread-v1の全採用条件を満たした意味ではない。

#### 公開契約と登録時刻

公開[HasConfigurableValue契約](https://docs.gradle.org/current/javadoc/org/gradle/api/provider/HasConfigurableValue.html)はtask propertyの実行開始時の暗黙固定化を説明する一方、値そのもののdeep immutabilityとは区別する。[9.2.1の公開interface source](https://raw.githubusercontent.com/gradle/gradle/v9.2.1/subprojects/core-api/src/main/java/org/gradle/api/provider/HasConfigurableValue.java)でもこの記述を確認した。8.11.1の同tag source本文は取得できていないため、current文書・正確な版のAPI注釈・実挙動を根拠として区別して保存し、8.11.1固有source本文を検証済みとは主張しない。

実KGP artifactに対して、KotlinCompile.getClasspathSnapshotPropertiesの@Nestedと、ClasspathSnapshotProperties.getClasspathSnapshotのConfigurableFileCollection／@Classpathをjavapで確認した。注釈調査はnativeが記録した実Task型のCodeSource・KGP API・Gradle APIへ束縛する。実行時にreflectionでfile inputを取得したり、内部のfinalized flagを照会したりしない。

初回試行では、producer build.gradleでplugins適用後にhelperを適用すると、snapshot collectionへのsensor追加が既に変更禁止として失敗した。これを解除せず、producer settingsのgradle.beforeProjectからhelperを適用し、tasks.configureEachをKGPのtask構成前に登録する形へ変更した。settings／build／適用helperすべてのsource hashをfixture入力へ結ぶ。export用init scriptから方針を注入した実証ではない。ただし既存build無変更の透過対応でもない。

#### 実参照の登録と非評価preflight

`gradle-snapshot-readiness.gradle`をproducerが適用し、installSnapshotProofを呼ぶ。Gradleが通常に実現するcompileKotlinのconfigure callbackで、実Task・nested owner・snapshot propertyのobject参照をprivate ledgerへ登録する。対照用に同じTaskのlibraries propertyと、通常task graphへ含めた別の実Task（snapshotDecoy）も保持する。TaskProvider.getは呼ばない。登録時の公開property accessorはobject handleの取得で、FileCollection.files／iterator／Provider.getによる値列挙はしない。API artifact hashと登録sourceのレビューを前提とし、任意のgetterについて非評価性を一般保証しない。

snapshotにはconcreteな空listを返すsensorを一つ追加する。元のKGP collectionへfinalizeValue／finalizeValueOnRead／disallowChangesを追加適用せず、置換・wrapもしない。実snapshot列は非空である。sensor登録も含む同じproducer設定をcontrol／observeに使う。未変更buildとの評価契約一致や全入力登録完全性は未実証で、closed source profileは作者表明・対象source／toolchainの信頼を含む。

preflightは、承認した実API digest、保持済みTask／property参照のidentity、閉じたsource kind、ledgerに記録したTask実行結果・Action境界・sensor自然評価完了を確認する。値getterやfile probeでreadyを調べない。TaskStateの成功だけで採用せず、次をすべて必要とする。

- 正しい実Taskと登録済みのsnapshot propertyが対応し、対象の公開Task型・property型が確認されている。
- `executed`・`didWork`、Action開始／終了、正常なafterTaskが揃い、skipped／noSource／failureでない。
- 登録終了後の通常処理でsensor評価が開始・正常完了している。sensor呼出しは元の全KGP内部supplierの独立観測ではない。
- source kindが固定したfixture profileの範囲である。未知のlive FileTreeは実行成功でも拒否する。

値列挙はこのpreflight後だけ行う。その直前に公開property accessorで現在の参照を再取得し、登録した実propertyとidentityが一致することを確認してからfilesを一度読む。このmetadata再確認はgate後の処理として別counterにし、preflightの成功根拠へ循環利用しない。task-1等の公開記録IDはrun ID内の表示labelであり、文字列から実object identityを復元・証明するtokenではない。

#### 対照と拒否条件

Groovy consumer＋Groovy producer、Kotlin consumer＋Kotlin producer、included rootのbinary Kotlin／標準kotlin-dslを両Gradle版で実行した。consumerはpluginを適用せず、included buildのsnapshotProof → jarを実行する。これによりcompileKotlinを意図的にskipした負例も、壊れたpluginをconsumerへ適用せず検証できる。

| mode／classifier | 実処理と結果 |
| --- | --- |
| control | 同じ登録・sensor・通常compileを実行し、値を読まない |
| observe | 正常compile後、保持済みbindingと実行witnessを確認。snapshot propertyを再読取し、sensorの追加評価0 |
| early | observe buildのdoFirst内で、実行未完了のledgerを分類。task_not_complete、値読取0 |
| wrong-task／wrong-property | observe buildのafterTaskで、実decoy Taskまたは実libraries propertyを候補bindingとして分類。対応するbinding_mismatch、値読取0 |
| skipped | 別buildでcompileKotlin.enabled=false。準備時のsensor評価があってもstage_not_executed、値読取0 |
| unknown-source | 別buildでsensorがlive FileTreeを返す。source_kind_unsupported、値読取0。sourceを列挙して未知か調べない |
| freeze-diagnostic | 別buildのcompile完了後に、実propertyへfrom(File)を一度試行。全4組でIllegalStateExceptionとなり変更を拒否。通常reader・preflightではこのmutation probeを行わない |

early／wrong bindingは、読み取り専用のpreflight分類器を実状態・実参照で試す負例である。失敗した本番capture sessionを後から回復して採用する実装ではなく、sessionの不可逆invalid化を含む本番adapterは未実装である。同じobserve buildで最後に行う正常読取と、これらの分類器テストを混同しない。

変更試行の拒否は、disallowChangesと値の最終化を独立に区別する公開isFinalized照会ではない。特に初回の設定時点でも変更が拒否されたため、事後の変更拒否だけを暗黙固定化の原因証明に使わない。公開契約・注釈・実binding・Task lifecycleと再読取traceに整合する限定witnessとして扱う。FileCollectionやfile bytesのdeepな不変を証明しない。

#### 保存結果・回帰・再現

[検証JSON](validation/gradle-snapshot-readiness-2026-11-01.json)に、実API sourceとhash、producer source／collector hash、run UUID、binding確認、Task state、sensor／Action／getter event、分類結果、診断変更試行、JAR entryとarchive hashを保存する。source pathは既存kgpRecordPaths moduleでtokenへ変換し、絶対pathの残存を拒否する。API承認digestの参照元は既存KGP取得診断の検証JSONへhashで束縛する。

共有verifierはsource／API不一致、登録・Task・Action・gateの欠落、binding不一致、gate以前のwitness count不一致、値読取の混入、再読取phaseのsupplier評価、非空snapshot証拠欠落、未実行stageの偽装、実mutation試行欠落を拒否する。control／observeの自然sensor・Action・Task event列と、通常compileを行う各modeのJAR entry内容を照合する。skip buildのJARは以前のclassを再利用せず、意図的に比較対象を分ける。

JDK 21と標準kotlin-dsl依存cacheを用意し、JAVA_HOME／GRADLE_USER_HOMEを設定する。次を対象2版で実行し、suffixを実版に合わせる。

```sh
OSV_MCP_TEST_GRADLE=/path/to/gradle-8.11.1/bin/gradle OSV_MCP_SNAPSHOT_READINESS_OUTPUT=/tmp/snapshot-readiness-8.11.1.json npx vitest run src/test/gradle/snapshotReadiness.integration.test.ts --maxWorkers=1 --hookTimeout=120000
OSV_MCP_GRADLE_RUNTIME_ROOT=/path/to/runtime node src/test/manual/gradleSnapshotReadinessResults.mjs /tmp/snapshot-readiness docs/validation/gradle-snapshot-readiness-2026-11-01.json
npx vitest run src/test/gradle/snapshotReadiness.test.ts --maxWorkers=1
```

#### 採用判定と残課題

4組で実binding＋実行完了＋非空snapshot再読取の条件付きwitnessを観測した。sensorはcontrol／observeとも各2評価、snapshotの値読取による追加は0、実snapshot列は8.11.1で23 file・9.2.1で20 fileだった。skipではsensorが準備中に1回評価されても正常完了と判定せず拒否した。5 mode×4 fixture＝20 build、early／wrong-task／wrong-property／skip／未知sourceの分類拒否は5種類×4組＝20件。4つの変更診断buildはすべて実変更を拒否した。

承認済みrecipe 0・全pipeline候補0・本番採用0は維持する。自然消費時点のsize／digest・保存bytesはなく、今回のfile hashは事後観測である。public-stable-reread-v1の本番承認、未知sourceを独立に発見する仕組み、全observer、残り3入力、既存build無変更baseline、buildSrc／precompiled等は未成立。次は本実証のレビューと、承認条件の不足を整理したうえで自然時内容receipt／入力鮮度を別に実証する。


最終確認: Gradle 8.11.1／9.2.1は両DSL合わせて各16件成功、終了処理も成功。成功した最終20 buildから条件付きwitness 4組・no-read分類拒否20件・変更試行の拒否4件を保存した。静的回帰29件、通常全体2,085件成功・native opt-in等1,133件skip、typecheck・build・差分検査も成功。最初のplugins適用後の登録失敗を成功へ数えず、producer settingsでの事前登録へ修正した両版結果を採用した。承認済みrecipe・本番採用は0件のままである。


### 9.27 snapshot witnessレビュー修正・cached preflight読取とTaskState（2026-11-01）

§9.26のレビュー2件を修正した。修正前は、一時コピーのpreflightへ実行完了後のcached files読取を加えてもGroovy／9.2.1の8テストが通り、getterCalls=0という分類結果を保存できた。またnoSource=trueやnoSource／skippedの欠落・非boolean値を共有verifierが受理した。TaskStateの9拒否対照が修正前に失敗することを確認してから変更した。

#### primitive factsと共通readerへの分離

preflightの分類ロジックをstaticなSnapshotPreflightClassifierへ分離した。分類器へは、profileApproved、taskIdentity、propertyIdentity、sourceKnown、stageObserved、stageCompleteというbooleanと、naturalCallsという非負Integerだけの変更不能Mapを渡す。実Task／FileCollection／Provider、private ledgerの参照は渡さない。キー集合と型を分類器でも検証する。実参照のidentity比較は呼出し側で行い、その結果だけを渡す。

値読取はprivateなreadSnapshot brokerへ集約し、正常captureと故障注入が同じ経路を使う。brokerは呼出しごとにcounterとgetter:begin/endを記録し、endはfinallyで閉じる。各分類にはpreflight:begin/endとgateを置く。共有verifierは各getterをcapture区間または対応preflight区間へ結び、counter・phase・順序と各check.getterCallsを照合する。source中の公開値getterを自由に呼べる一般sandboxを実装したのではなく、レビュー対象の固定helperで実参照と値読取を分離したものである。

故障flag `osv.snapshot.preflightReadFault=true`は、通常compile完了後のwrong-task分類で、拒否理由を判定する前にbrokerから登録済みsnapshotを**実際に**読む。値はcachedでsensorの追加評価は0でも、preflight区間のgetter event・counter 1によりsnapshot_readiness_preflight_readで拒否する。flagだけで読取しない記録、counter／event不一致、fault artifact欠落、source／API不一致を同じ成功負例へ数えない。

通常5 modeは維持し、故障は別のobserve buildを両DSL・両Gradle版へ一つずつ追加する。通常controlと通常の他modeを共有する故障proofを作り、全schema・API／source・TaskState・binding・event・artifact・自然traceを検証した後に、意図したpreflight-read違反を認定する。既存20 build＋故障4 build＝24 native buildとなる。

#### TaskStateを型と実行事実から再検証

observed／executed／didWork／skipped／noSource／failed／completedの全fieldを必須booleanにする。undefined・null・文字列・数値・object・arrayはsnapshot_readiness_stage_flags_invalidで拒否する。completedの申告値だけを使わず、observed・executed・didWorkがtrue、skipped・noSource・failedがfalse、Task区間内のAction開始／終了が揃うことから正常完了を再計算して照合する。不整合なbooleanの組合せはsnapshot_readiness_stage_invalidとする。

このfixtureのskipped modeはenabled=falseであり、skipped=true／didWork=false／completed=false／noSource=falseを期待する。noSourceによるskipとは区別する。正常modeのnoSource=trueも、skippedの欠落で条件式をすり抜ける状態も許可しない。分類器のstageComplete・naturalCalls等のprimitive factsは、同時点のledger eventと最終TaskState／Actionに照合する。

noSource／skippedの各々について、欠落、null、文字列、0、1、object、array、期待booleanの反転を5 modeで試す。80条件をsnapshotStateTargets／mutateSnapshotState／snapshotStateRegressionsで共用し、nativeが実際の拒否理由を確認して保存する。集約は全対照を再実行し、保存結果と一致しなければ出力しない。その他のTaskState fieldの欠落、completedの矛盾、factsへのobject混入なども静的回帰へ含める。

#### v2記録と範囲

case／run／matrix／experimentをv2へ更新し、実preflightReadFault値、primitive facts、preflight／getter区間、故障proofと観測、TaskStateの拒否対照を保持する。現在sourceと一致するnative結果で取り直し、旧v1は未コミットの要約としてpreReviewsへ保存する。旧recordSha256をコミット済み原本への参照と扱わない。path token化とAPI artifactの実file hash照合も維持する。再現コマンドは§9.26と同じで、新しいnative実行は故障buildも含む。

条件付きwitnessと本番採用の区別は変更しない。正しいbindingと実行完了を使う通常再読取4組は計測supplier追加0回のまま、preflight拒否20件も値読取0を確認する。故障4組の実preflight読取は別に拒否し、正常なno-read件数へ加えない。自然消費時のbytes束縛、全observer、任意live sourceのdeepな不変、承認済みrecipe／本番adapterは未成立である。


最終再検証: Groovy／Kotlin × Gradle 8.11.1／9.2.1の4組を実行し、両DSL合わせて各Gradle版20テストが成功した。通常20＋故障4＝24 native buildから、条件付きwitness 4組、cached preflight読取の拒否4件、TaskState改変の拒否80条件×4組＝320件、正常なno-read分類拒否20件を保存・集約側で再検証した。静的回帰132件、通常全体2,188件成功・opt-in等1,137件skip、typecheck・build・差分検査も成功。承認済みrecipe・本番採用は0件のままである。
