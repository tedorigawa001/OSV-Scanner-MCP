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


### 9.28 48055fdレビュー修正・公開記録の静的再検証（2026-11-01）

§9.26／§9.27の検証JSONは集約時だけ検証され、通常のテストでは読まれていなかった。検証器・source・参照記録が後から変わっても、公開記録との不一致を検出できなかった。

- `snapshotReadiness.test.ts`へ公開記録の再検証を追加した。source／検証source／API参照記録のhash、両版・両DSLの判定、TaskState拒否80条件、故障観測、scope件数を現在の検証器で再計算して照合し、絶対pathの残存も拒否する。古い判定、別control runとの組合せ、run IDの再利用、scopeの水増し、source hashの不一致、絶対pathの6負例を追加した。修正前の記録では検証sourceの不一致で失敗することを確認した。
- 故障proofは、自身のobserve run以外のrunとcase identityが通常caseと完全に一致し、故障runのrun IDが通常runと異なることを必須にした（`snapshotReadinessRecord.mjs`、集約と静的テストで共用）。
- 同じnative run集合の再集約では、観測時の`recordedAt`／`baselineRevision`を保持し、再集約時点を`reconsolidatedAt`／`reconsolidatedRevision`へ別記する（§9.25と同じ方針）。
- `jarEntries`を算出する`gradlePluginJarProof.ts`とその依存`gradlePluginLoadProof.ts`を`verificationSourcesSha256`へ加えた。

Gradleは再実行せず、§9.27で保存したv2のnative出力を再集約した。run集合・判定・scopeは変わらず、変化は検証source hashと再集約時点だけである。条件付きwitness 4組、承認済みrecipe・全pipeline候補・本番採用0件の判断は変わらない。


### 9.29 snapshot内容束縛・capture鮮度の公開API境界実証（2026-11-01）

以下のv1結果はレビュー前の履歴である。現在のv2結果と計測・拒否条件は§9.30を参照する。

#### 取得方式と採用条件

§9.22.8の自然消費時receiptと、公開Task lifecycle境界での内容観測を区別する。採用可能なowner receiptは、同一invocation／実Task／snapshot property／slotの具体列を所有者が自然消費する経路から渡し、全fileのsize／SHA-256と保存bytesまたは自然時に検証したbaselineへ結ぶ必要がある。元getterを追加で呼んで自然消費と称することは禁止する。消費中不変と観測区間の対応はrecipe契約として別途必要である。

今回の公開API候補は、producer settingsでKGP構成前に実参照を登録し、Task.doFirstでsnapshotの具体列を一度取得する方式とした。doFirstはTask actionの前へ処理を追加する公開境界であり、KGP内部のcompiler消費callbackではない。Gradleの入力処理後にcached列を読めても、compilerが実際に読んだbytesと同一だった証拠にはならない。したがって以下はboundary content observationであり、owner-materialized receiptの成立やpublic-stable-reread-v1の承認へ昇格させない。

1. 実Taskとnested propertyを参照identity、実行時Gradle／KGP API artifact digestへ束縛する。単一worker・parallel無効・必須compileの再実行を固定する。
2. doFirstのgetter区間で列を取得し、非空snapshot全件の相対path、size、SHA-256、保存bytesを記録する。登録・Task・Action・boundary・getter・supplier eventを記録し、getterをcached読取でも計数する。
3. 正常Task完了後、保持済み具体pathから内容を再検査する。boundaryとpost-actionの集合・内容が一致しなければ候補を採用しない。両端一致は途中の変更・復元やcompilerの実読取の証明ではない。
4. 最初のcaptureは元KGP getterを呼ばず、保存bytesのsize／digestを先に検証し、保持済みpathの現在内容と元の証拠を照合する。capture時のhashでbaselineを作り直さない。保存bytes不一致はkotlin_pipeline_snapshot_storage_mismatch、現在file不一致はkotlin_derived_snapshot_staleとする。
5. 内容証拠がない場合はkgp_capture_content_evidence_unavailableとしてgetter 0で拒否する。snapshot境界候補が成功しても、自然消費時の内容証拠が不足する本番gateはunsupportedのままとする。

#### 隔離・故障対照・回帰条件

実派生fileの変更は、通常cacheから独立にcopy-on-write複製した検証専用GRADLE_USER_HOME内だけで行う。専用markerのないcacheはhelperが起動時に拒否する。対象はそのhome配下の実fileに限定し、afterTaskで変更、最初のcapture後にfinallyで復元し、復元digestも照合する。コピーや復元を共有cacheの保護・全競合の保証と混同しない。

| mode | 確認内容 |
| --- | --- |
| control | 同じ登録・空concrete sensor・通常compile、snapshot値読取なし |
| boundary | doFirst全file内容とpost-actionが一致し、最初のcaptureも一致 |
| mutate-same-size | compile完了後、非空の実派生fileを同sizeで1byte変更。最初のcaptureでstale |
| mutate-size | 同じ区間で実fileを1byte増加。最初のcaptureでstale |
| delete | 同じ区間で実file削除。最初のcaptureでstale |
| blob-corrupt | 元fileを変えず保存bytesだけ変更。storage mismatch |
| no-receipt | compile成功でも内容receiptを作らず、captureは元getter 0でunavailable |

共有verifierで全必須event・phase・getter数、TaskStateの必須boolean、binding／API、fixture source、集合と保存bytesのdigest、変更対象・復元を照合する。自然supplier／Action traceとJAR全entryをcontrolに比較する。境界／captureでの追加supplier評価、必須境界欠落、証拠欠落、再baseline化、偽の採用状態を拒否する。native・集約は同じ改変対照一覧を再実行する。

#### 範囲と残課題

この実証はincluded rootの標準kotlin-dsl binary Kotlin producerを、Groovy/Groovy・Kotlin/Kotlinのconsumer／producerで検証する。全observer、残り3入力、未知supplierの独立発見、既存build無変更baseline、buildSrc／precompiled／DSL全交差、本番schema／adapter／信頼設定は対象外である。KI23相当の証拠欠落、KI24相当の実派生file変更、KI26相当の保存bytes破損に関する境界候補の診断であり、自然消費receiptを前提にしたKI01〜KI26の全面達成ではない。

次に必要なのは、KGP所有者が自然消費した具体列と内容を渡す公開hook、または消費中を含めて同じbytesを拘束する承認可能なproducer／toolchain契約である。doFirst／afterTaskの両端hashだけではこの不足を埋めない。承認済みrecipe・自然消費内容束縛・本番採用は0を維持する。


#### 再現と保存形式

共有依存cacheを直接使わず、専用homeへ独立copy-on-write複製（macOSでは`cp -cR`）または通常copyを作り、`osv-content-isolated-cache`という検証専用markerを置く。hardlink copyや共有cacheへのmarker追加で代用しない。JDK 21、両Gradle実行環境、標準kotlin-dsl依存のoffline cacheを使う。

```sh
JAVA_HOME=/path/to/jdk GRADLE_USER_HOME=/path/to/isolated-cache OSV_MCP_TEST_GRADLE=/path/to/gradle-8.11.1/bin/gradle OSV_MCP_SNAPSHOT_CONTENT_OUTPUT=/tmp/snapshot-content-8.11.1.json npx vitest run src/test/gradle/snapshotContent.integration.test.ts --maxWorkers=1 --hookTimeout=120000
# 9.2.1も同様に実行し、binaryと出力suffixを変更する。cacheへの改変実行を並列化しない。
JAVA_HOME=/path/to/jdk GRADLE_USER_HOME=/path/to/isolated-cache OSV_MCP_GRADLE_RUNTIME_ROOT=/path/to/runtime node src/test/manual/gradleSnapshotContentResults.mjs /tmp/snapshot-content docs/validation/gradle-snapshot-content-2026-11-01.json
npx vitest run src/test/gradle/snapshotContent.test.ts src/test/gradle/snapshotContentRecord.test.ts --maxWorkers=1
```

保存時は全bytesを内容アドレス付きgzip blobへ重複排除し、receiptのblobRefと分離してJSON内へ収録する。解凍後size・SHA-256をblobRefと照合し、元のrunを復元して共有verifierを再実行する。保存bytes破損負例ではblobの実digestとreceiptの期待digestが異なる状態を保持し、圧縮・再保存で正常化しない。source hash、fixture hash、実行API artifact／公開Task method、run ID、区間event、TaskState、JAR全entry、native拒否対照を保存する。API承認digestは既存KGP取得診断recordのhashへ結び、集約時には実artifactも再照合する。端末固有pathはtoken化し、残存絶対pathを拒否する。

今回も`kotlin.incremental=false`、in-process compiler、offline・rerun-tasks・cache再利用無効の限定条件である。Gradleによるsnapshot入力評価とKGP compiler内部での実消費は同義ではなく、incremental有効時・cache hit時・並列時の保証へ拡張しない。保存bytes全件の追加I/Oは発生しており、「追加評価0」は登録した空concrete sensorの計測値に限定する。


#### 実行結果

Groovy／Kotlin × Gradle 8.11.1／9.2.1で各版16テスト、7 mode×4組＝28 buildが成功した。boundaryの全23 file（8.11.1、28,184,778 bytes）／20 file（9.2.1、29,312,677 bytes）を保存した。controlを含め全modeの空concrete sensorは各2評価で、getter／boundary／capture区間への追加評価は0。boundaryのgetterは1回、captureでは0回、no-receiptは全区間で0回であった。自然supplier・Action traceとJAR全entryもcontrolと一致した。

実派生fileの同size変更・サイズ変更・削除12件を最初のcaptureでkotlin_derived_snapshot_stale、保存bytes破損4件をkotlin_pipeline_snapshot_storage_mismatch、receipt未取得4件をkgp_capture_content_evidence_unavailableとして拒否した。27種類×4組＝108件の記録改変対照をnativeと集約で再検証した。静的・保存記録再生63テストが成功し、検証JSON内の全blobを復元して判断・拒否対照を再計算した。

初回8.11.1はhelperのbyte配列操作／finally内の二次例外で失敗した。配列操作をArrays.copyOfへ変更し、復元時の診断record未作成を安全に扱った後、両版を最後まで取り直した。失敗buildを上記成功件数へ含めず、検証JSONは最終source hashと一致する成功matrixだけを保存する。承認済みrecipe・自然消費時内容束縛・全pipeline候補・本番採用は引き続き0である。

最終確認: 通常全体2,258テスト成功・native opt-in等1,153件skip。typecheck・build・差分検査も成功。検証JSONの実証source 4 fileと検証source 7 fileのhashは現在のファイルに一致した。


### 9.30 snapshot内容実証のレビュー修正・cached読取とsupplier区間（2026-11-01）

§9.29の2指摘を修正した。修正前の一時コピーでは、captureとno-receiptに実cached getterを追加してもGroovy／9.2.1の8テストが成功した。またsupplier対をgetter内へ移しphaseをnaturalにしてcontrol側traceも対応させると、case全体を追加評価0として受理した。新しい区間対照7件が修正前に失敗することを確認した（うち2件は拒否したが理由が区間評価違反と異なった）。

#### 共通readerと実cached読取の故障対照

KGP propertyの値読取をreadSnapshot brokerへ集約し、全呼出しにgetter:begin/endとcounterを記録する。通常boundaryと故障読取は同じbrokerを使い、endはfinallyで閉じる。通常のcontent処理は保持した具体file列から取得し、KGP propertyを再列挙しない。この固定helperの計測であり、任意sourceの公開getterを自動捕捉する一般sandboxではない。

`osv.content.readFault=capture`はboundary modeのcapture区間で、`no-receipt`はreceiptを作らないmodeの拒否前に、同じ登録済みpropertyを実際に読む。通常7 modeとは別に2 build／fixtureを実行する。cached読取でsupplier評価が増えなくても、getter eventとcounterで検出し、snapshot_content_no_read_violatedとする。

故障の期待拒否は、schema／run ID／API／source／binding／TaskState／event／artifact／内容・改変判断をすべて検査した後に認定する。flagだけで実読取がない場合はfault_not_reproduced、counter／event不一致、artifact欠落、未承認flagは別に拒否する。故障run IDは通常run・他故障と異なる必要がある。通常対応modeとの内容・trace・binding・fixture・JAR entryの一致を検査する（run ID、fault flag、捕捉した追加getter、JAR全体hashを除く。JAR全体hashは各buildの実bytesから別々に算出する）。

#### supplierのphaseと位置を独立に照合

宣言されたphaseがconfiguration／natural／actionでも、それだけで許可しない。registration:end、task:begin/end、action:begin/endの位置から合法な自然評価区間を判定する。configurationは登録後・Task開始前、naturalはTask内・Action外、actionはAction内を要求する。そのうえでboundary、post-action、capture、mutation、restoreのobserver区間との重複をphaseに関係なく拒否する。getterはboundary内に位置するため同じ規則で拒否される。

supplier対の開始／終了、同phase、counterも照合する。observer区間の評価はsnapshot_content_extra_evaluation、observer外でもphaseと位置が一致しないものはsnapshot_content_supplier_phase_invalidとする。Task終了後のcapture評価を単にTask区間外として扱わず、observer違反として分類する。

共有改変対照へ、3種のphase×5位置（boundary開始直後、getter内、getter終了後のboundary内、post-action内、capture内）の15件を追加した。既存27件と合わせ42件／fixtureをnative・集約で再実行する。さらに全modeのsupplier対を同時移動しcontrolのtraceも合わせる3種のcase対照を共用し、全体比較だけでは通ってしまう不正な記録を拒否する。

#### v2記録と範囲

run／case／matrix／experimentをv2へ更新し、readFault、実故障run、故障判定、case単位の対照を保存する。blob保存／復元は故障runも対象とし、公開記録テストは通常結果と故障・全拒否対照を再計算する。旧未コミットv1はpreReviewsにhash付き要約として残すが、コミット済み原本への参照や現在の証拠とは扱わない。JAR entry parserと依存、API照合helperも検証source hashへ含める。

通常の境界観測4組と実file改変拒否12件、保存bytes破損4件、receipt未取得no-read拒否4件は維持する。故障buildの実読取8件を正常なno-read件数に加えない。Task境界観測と自然消費bytesの区別、限定sensor・incremental無効・単一workerという範囲は不変であり、自然消費時内容束縛・承認済みrecipe・全pipeline候補・本番採用は0のままである。


最終native再検証: Groovy／Kotlin × Gradle 8.11.1／9.2.1の各版20テストが成功した。通常28＋故障8＝36 buildを保存し、実cached読取8件は計測supplier追加0でもno-read違反として拒否した。42対照×4組＝168件と、controlを含む同時trace移動3対照×4組＝12件をnative・集約で再計算した。静的・公開記録再生106テストも成功し、source 4 file・検証source 11 fileのhash一致、故障を含む保存blob復元、旧v1履歴要約1件を確認した。

通常全体の最終確認: 2,301テスト成功・native opt-in等1,157件skip。typecheck・build・差分検査も成功。


### 9.31 503f25cレビュー修正・公開記録の保存bytes縮小（2026-11-01）

503f25cの検証JSON（v2）は、全run・全fileのboundary bytesを内容アドレス付きgzip blobとして収録し、11.3MB（blob 42件、展開94.8MB）だった。中身はgradle-api、kotlin-stdlib／reflect、groovy、javaparser等の第三者JARから生成されたKGP classpath snapshotである。公開記録から再生する判定のうち実bytesを要するのは保存bytes破損（blob-corrupt）だけで、stale／receipt未取得の判定はsize／SHA-256だけで足りる。

#### 保存方式の分離

- 共有verifierへstorage modeを追加した。`native`（既定）は全receipt entryのbytesを必須とし、nativeと集約時の照合で使う。`published`は`bytesOmitted: true`でbytesを省いたentryを許すが、blob-corruptで破損させたfileのbytesはどちらのmodeでも必須とする。bytesを省いたentryについては、公開記録から保存bytesを再照合できない。
- 集約はnative modeで全bytesを検証した後、blob-corruptの破損file以外のbytesを除き、published modeで判定・記録改変対照・同時trace対照を再計算する。結果がnativeと一致しなければ書き出さない。公開記録テストは、保持しているbytesがこの方針どおりであることと、未使用blobがないことを確認する。
- helperの改変対象（同size変更・サイズ増加・削除・保存bytes破損）を、最初の非空fileから「最小の非空file」（size、同sizeなら相対path順）へ変更した。verifierはこの選択を照合する。破損証拠のbytesを小さく保つための変更で、判定条件は変えていない。
- 記録改変対照に、native modeでbytesを省いた記録の拒否を加えた（43対照／fixture）。

#### その他の修正

- 同じnative run集合を集約し直す場合は、観測時の`recordedAt`／`baselineRevision`を残し、再集約時点を`reconsolidatedAt`／`reconsolidatedRevision`へ別記する（§9.25、§9.28と同じ方針）。
- scopeの件数を、mode数からの固定計算ではなく各runの判定理由から数えるようにした（`contentRecordCounts`）。
- 公開記録テストに改ざん負例6件を追加した（古い判定、未使用blob、方針外のbytes保持、件数の水増し、source hashの不一致、絶対path）。v2記録に対して失敗することを確認した。

#### 再実行と記録

helperとverifierが変わるため、両DSL・両Gradle版でnativeを取り直した（各版20テスト成功、通常28＋故障8＝36 build）。experimentをv3へ更新し、v2はコミット済み原本（503f25c）のhash付き要約としてpreReviewsへ残した。検証JSONは789KBで、保持blobは1件（破損させた446 bytesのgradle-installation-beacon snapshot。4組で同一bytesのため重複排除）である。

境界候補4組、実file改変拒否12件、保存bytes破損拒否4件、receipt未取得no-read拒否4件、実cached読取拒否8件、記録改変拒否172件（43対照×4組）、同時trace移動拒否12件を保存し、公開記録から再計算した。503f25cの履歴には11.3MBの記録が残る。Task境界観測と自然消費bytesの区別、および自然消費内容束縛・承認済みrecipe・全pipeline候補・本番採用0件の判断は変わらない。


### 9.32 snapshot自然消費hookの調査・producer所有契約と打切り条件（2026-11-01）

以下のv1結果はレビュー前の履歴。現在のguard検証・artifact証拠の束縛とv2再実行は§9.33を参照する。

§9.29〜9.31のTask境界観測を自然消費receiptへ昇格させる条件を調査した。対象は既存tuple（Gradle 8.11.1／KGP 2.0.20、Gradle 9.2.1／KGP 2.2.20）。**現対象の既存KGPへ採用できる自然消費hookを確立できなかったため、透過取得recipeはunsupportedのまま打切る。BTAの公開入力型は別driverの候補であり、今回の承認recipe・自然消費内容束縛・本番採用は0件。** 全KGP公開APIについて不存在を証明したという結論ではない。

#### 9.32.1 調査の根拠と範囲

[調査JSON](validation/gradle-snapshot-owner-survey-2026-11-01.json)へ、14公開型×2 tupleのsignature・選択JAR／class digest、公式tag sourceとdigest、KotlinCompileの対象methodのbytecode、公開BTA constructorの実行結果を保存する。実Gradle／KGP artifactは既存取得診断recordのhashへ照合し、javap -sysinfoで各型の実解決元も照合する。公開methodでも`$kotlin_gradle_plugin_common`等のmangled内部実装をsupported extension pointと扱わない。

公式sourceは[2.0.20](https://github.com/JetBrains/kotlin/blob/v2.0.20/libraries/tools/kotlin-gradle-plugin/src/common/kotlin/org/jetbrains/kotlin/gradle/tasks/KotlinCompile.kt)／[2.2.20](https://github.com/JetBrains/kotlin/blob/v2.2.20/libraries/tools/kotlin-gradle-plugin/src/common/kotlin/org/jetbrains/kotlin/gradle/tasks/KotlinCompile.kt)のKotlinCompile.ktを取得した。原headerを含むbytesとApache-2.0の由来を記録する。tag sourceと実artifactの対象bytecodeは相互の補強証拠であり、reproducible buildによる全source一致の証明ではない。bytecodeのprivate methodは静的診断だけに使い、reflection／private呼出し／task差替えは行わない。

| 候補・確認した公開面 | 得られるもの／不足 | 現判定 |
| --- | --- | --- |
| KotlinCompile／ClasspathSnapshotProperties | 公開collection参照。getClasspathChangesはprivateで、呼出し元はKotlin内部のcompiler環境構築。自然消費済みの具体列・bytesを渡すcallbackをこの範囲で確立できず | existing KGP unsupported |
| Task.doFirst／doLast、TaskInputs、InputChanges | action順序、入力collection、変更情報。消費readerの具体値・bytes receiptではない | Task境界候補の範囲を維持 |
| BuildEventsListenerRegistry、TaskFinishEvent、TaskSuccessResult | Task完了通知・結果。完了状態は消費値を渡さない | ready発行根拠にしない |
| TransformAction | transform所有者の生成処理。既存KGP transformの消費後callbackへ観測器を追加するAPIではない。別transformでの再生成は別入力になる | consumer receiptとして不採用 |
| KotlinCompilerPluginSupportPlugin、KotlinCompilerArgumentsProducer | compiler plugin設定／引数生成。既に自然消費された派生snapshot列・bytesを渡す契約ではない。引数生成の手動呼出しも消費済みwitnessにはならない | 不採用 |
| BTA CompilationService、JvmCompilationConfiguration、ClasspathSnapshotBasedIncrementalCompilationApproachParameters | callerがcompiler・IC入力を渡す公開API。既存KGPに登録してその入力を横から受け取るhookとは異なる | 新しいowner driverの設計候補のみ |

[現行Kotlin文書のBTA説明](https://kotlinlang.org/docs/build-tools-api.html)や[compiler plugin説明](https://kotlinlang.org/docs/custom-compiler-plugins.html)を、旧tupleの成立証拠へ流用しない。今回のBTA JARは対象版cacheから一意に選択しdigestを固定した**利用可能なAPI artifact**である。既存KGPの実compileで選択されたBTA実装・compiler artifactと証明したものではない。Java probeが実際にロードしたBTA／stdlibのCodeSourceとdigestは別に照合した。

#### 9.32.2 compiler分岐と既存実証の位置付け

両tag sourceと対応する実KotlinCompile bytecodeで、callCompilerAsyncからgetClasspathChangesへの呼出しはisIncrementalCompilationEnabledの条件下にあり、無効側ではincremental environmentがnullになる。getClasspathChanges内でsnapshotのfiles列を取得する。検証器は対象methodを分離し、guardのifeq先が当該呼出しを飛び越えてaconst_nullへ到達することを確認する。単なるmethod名の存在や別method内の同じoffsetを根拠にしない。

したがって、これまでのincremental無効・in-processという条件で、非空snapshotがGradle入力として評価されたことを、compiler環境がその派生bytesを消費した証拠にできない。今回も実compilerの全readを計測したのではなく、限定したsource／bytecode制御経路の診断である。incremental有効へ変えるだけでも消費中不変・hook・追加評価の不足は解消しないため、設定だけを切り替えてrecipeを承認しない。

#### 9.32.3 BTA公開constructorの実証

両版の公開ClasspathSnapshotBasedIncrementalCompilationApproachParametersへ、非空のsynthetic regular fileを含むList<File>を渡すstandalone Java probeを実行した。実行版BTA JAR／stdlibのCodeSourceとhashを指定artifactへ照合した。

- 可変Listを渡した後に元Listへ追加すると、parameterの取得列も増えた。取得列への追加も可能だった。constructorの存在だけでは列の防御的copy・sealを保証しない。
- callerがListを防御的copyし、Collections.unmodifiableListで包んでから渡すと、元Listの変更は反映されず、取得列への変更も拒否した。これはcallerが作ったcopyとwrapperの性質であり、BTAがcopyやsealを行ったことを示さない。BTA自体について観測したのは、渡されたListを参照のまま保持すること（alias）と、取得列が変更可能なことだけである（§9.34で訂正）。
- これは同一の具体File列をAPI引数として保持する仕組みの実証に限る。Fileはpath参照であり、Listの固定はfile bytesを固定しない。probe fileは正規KGP snapshotではなく、compileJvm・snapshot生成・compiler呼出しは0回。既存KGPの採用証拠やGroovy／Kotlin native matrixへ加算しない。

#### 9.32.4 producer所有の二つの契約案

新しいdriverを作る場合も、以下を別mode・別profileとして扱い、暗黙に既存KGP recipeを置換しない。本節は設計であり、本番helper／schema／環境設定の実装ではない。

**A. owner-consumer-receipt（自然消費receipt候補）**

登録は§9.22のbindingにdriverKind、driver source／実行artifact digest、compiler／BTA実装とclasspath、execution strategy、snapshot format／generator digest、libraries sequence digest、storage policyを加える。実driver instanceとinvocation／stage／slotを自然な構成経路で結び、seal前に登録を閉じる。KGP task pathだけで新driverのidentityを代用しない。

beginSlot／completeSlotはproducerが所有する実消費経路から発行する。具体列は防御的copy＋変更不能にし、slot内の順序・重複・logical IDを固定する。bytesはconsumerの実readと同じ経路で有界streaming保存し、同じopen実体・size／digest・保存bytesをcompleteへ渡す。readerの共有が公開APIで成立しない場合は、このmodeを登録しない。Task開始、BTA parameter構築、compiler呼出し直前／直後、成功戻り値で自然時のreadを推定しない。

実行が非同期ならworker／daemonの消費完了までtokenをreadyにしない。失敗・再入・異なる列の追加消費・保存失敗・予算超過は不可逆にfailed／invalidatedとし、別tokenや再試行で回復しない。captureは完成receiptだけを使い、元KGP getterを呼ばず、最初のcaptureから元内容証拠へ再照合する。

**B. owner-sealed-offered-inputs（提供入力の固定候補）**

BTAのFile引数を受け渡すだけの初期候補はこのmodeとする。producerが生成したsnapshotをprivate stagingへ保存し、実regular fileの安全なopen、完全なinventory、generator／libraries対応、size／digest／保存bytesを固定する。その同じpath列を防御的copyしてBTA parameterへ渡し、consumerが終わるまでstagingを変更・削除・再利用しない。前後のhashも記録する。

ただしFile引数にはimmutable bytesの公開保証がなく、read-only permissionやadvisory file lockだけでは他writerを排除したことにならない。writer集合、process境界、symlink／path置換、mmapやworkerの読取終了、再利用cacheとの分離をsource監査とproducer／toolchain profileへ明示する必要がある。BTA API自体がこの保証を与えたとは扱わない。

このmodeで得られるのは提供した入力の証拠であり、compilerがその全snapshotを消費したreceiptではない。skip／incremental no-op／非incremental経路も区別し、compileJvmの成功だけでconsumedへ遷移しない。実消費との対応を公開契約・承認済みrecipeで別途確立できるまでは、offered-inputs-onlyとして保存し、自然消費slotのready・declared_in完全性の根拠には使わない。AとBのmode交換で不足証拠を回避しない。

将来のreceipt metadata案はconsumptionStatus（unsupported／offered-inputs-only／receipt-complete）、observationKind（owner-read／before-call／after-call／task-boundary）、driver／consumer binding、read interval、contentBindings、producer／toolchain追加信頼とlimitationsを保持する。状態と証拠が矛盾するreceipt-completeはgraph拒否、合法な未対応はno-readのunavailableとして宣言元全体を省略する。relation／introduced_by・lock由来coverageや既存のintegrity検査をこの省略で迂回しない。

#### 9.32.5 採用と打切りの条件

1. exact tupleに、同じ自然消費値・bytesを渡すsupported public hook、またはその対応を保証する公開契約が見つからない → **既存KGPの透過recipe調査を現対象で打切り、unsupportedを維持**。Task callbackを増やす反復で代用しない。上流API・対象version・明示owner integrationが変わる場合だけ再開する。
2. 候補がprivate／internal／mangled public method、reflection、既存collectionの事後固定化、別ArtifactView・再transform・再評価を必要とする → 不採用。追加信頼だけで禁止APIを許可しない。
3. BTAのcaller側でのみ成立する → 既存KGPへの透過対応を止め、**新owner driverの別工程**へ分ける。既存KGP実行artifactの証拠とBTA利用可能artifactの証拠を混ぜない。
4. 列のsealだけでbytes不変、消費中不変、消費完了の根拠がない → offered-inputs-only止まり。自然receiptをreadyへしない。
5. 将来native実証を行う場合は、正規非空snapshotを生成する実owner driver、実BTA／compiler実装・引数対応、消費中変更とreceipt後変更の拒否、全observerの追加評価、既存buildとの差を両DSL・両Gradle版で検証する。synthetic parameter probeを陽性matrixへ数えない。
6. snapshotが将来成立しても残り3 slot・全stage・package／loaderの条件が未成立なら、全pipeline候補・本番採用は0。

#### 9.32.6 回帰条件と今回の実施範囲

| 条件 | 検証対象／次の実証条件 |
| --- | --- |
| SO01 | exact source・artifact／API classのbinding、source guardとbytecode branch。別Gradle API・KGP／BTA artifact、改変source・signature・bytecodeを拒否（今回静的対照） |
| SO02 | Task callback、Task成功、非空fileを自然hookへ昇格しない。内部methodをpublic hookとしない（今回source／bytecode診断。全API不存在の証明ではない） |
| SO03 | BTA mutable parameterのaliasとcaller defensive copyを実測。file bytesや実compilerの消費を成立としない（今回2 standalone probe） |
| SO04 | BTAのcache候補をruntime選択済みと偽装、synthetic pathを正規snapshotと偽装、未実行compiler／DSL matrix・recipeの水増しを拒否（今回静的対照） |
| SO05 | 新driver登録とsealが自然消費前、同じowner／invocation／library cohort・実compiler tupleを拘束。既存KGPと別ownerのreceipt交換を拒否（未実施） |
| SO06 | Aの実消費readerから同一bytesを取得し、Provider／FileCollectionをobserverが呼ばない。hook不在はsource getter 0で打切る（新driver未実施） |
| SO07 | Bのprivate stagingの完全性、path置換・writer追加・worker継続・一時変更、実消費との対応を検証。両端hashだけでAへ移行しない（未実施） |
| SO08 | receipt／保存blob／baseline参照の欠落・不整合、消費中変更・最初のcapture前変更・保存失敗・容量超過を拒否。再baseline化・別tokenへの回復禁止（新driver未実施。既存Task境界負例の陽性流用禁止） |
| SO09 | 新driverのcontrol／全observerと未変更buildを比較し、評価・解決・transform・artifact差を記録。両DSL・両版、incremental／cache／parallelを別matrixにする（未実施） |
| SO10 | offered-inputs-only、別slot未準備、信頼未承認ではdeclared_in部分一覧を返さない。schema不正・integrity違反は省略へ格下げしない（本番未実施） |

今回追加したGradle build／compiler実行は0。14型×2 tupleの静的API／bytecode調査、公式source 2件、standalone公開constructor probe 2件であり、既存の36 buildを再実行・追加計上していない。次に実装へ進める候補はBの新owner driverの限定実証であるが、それだけで自然消費対応は完了しない。Aに必要なconsumer側hookまたは同等の公開保証が成立しなければ、自然消費receiptの取得は打切りを維持する。

再現には対象Gradle配布物、既存cache、JDK 21と、上記raw tag URLから取得したKotlinCompile-2.0.20.kt／KotlinCompile-2.2.20.ktを用意する。ハーネス自体はネットワーク取得を行わず、source digestを固定照合する。

```sh
JAVA_HOME=/path/to/jdk GRADLE_USER_HOME=/path/to/cache OSV_MCP_GRADLE_RUNTIME_ROOT=/path/to/runtime node src/test/manual/gradleSnapshotOwnerSurvey.mjs /path/to/tag-sources docs/validation/gradle-snapshot-owner-survey-2026-11-01.json
npx vitest run src/test/gradle/snapshotOwner.test.ts --maxWorkers=1
```

最終確認: 14型×2 tupleの実artifact解決元・source／bytecode分岐と、BTA公開constructor probe 2件を現sourceで再取得した。公開記録のsource 7 fileのhashを照合し、scope・artifact・source・signature・bytecode・probe・判定の改変負例を含む通常全体2,339テストが成功（native opt-in等1,157件skip）。typecheck・build・差分検査も成功。新しいGradle build／compiler実行・自然消費内容束縛・承認recipe・本番採用は0件である。


### 9.33 owner調査レビュー修正・guard範囲とartifact別の固定期待値（2026-11-01）

§9.32の2指摘を修正した。修正前はgetClasspathChangesの読取offsetをguardより前へ変更しても同じfactsを返し、signature／bytecodeとその自己hashを一緒に変えた記録も受理した。両対象版の8負例が修正前に失敗することを確認した（その時点の公開記録再生1件は、テストsource更新による既存hash不一致でも失敗した）。

#### guardと命令列

対象method内のisIncrementalCompilationEnabled呼出し、直後のifeq、getClasspathChanges読取、無効側の飛び先を別々のoffsetとして取得し、`guard call < ifeq < read < false target`を要求する。false targetが同じmethodのaconst_nullであることも照合する。caller／private readerはそれぞれ命令offsetがsafe integerで厳密に増加する必要があり、重複・逆順・別methodのoffsetを混ぜた証拠を拒否する。

実際の呼出し行を前へ移す対照に加え、offset自体は単調増加しているがreadがguardより前にあるsynthetic命令列も拒否する。これにより順序エラーだけでなくguardの下限検証を試す。任意JVM bytecodeの完全なcontrol-flow／verifier解析を実装したのではなく、対象tupleの固定bytecodeとの一致を次の独立照合で要求する。

#### artifactから独立に固定した期待表

修正前のcollectorを用い、両対象版の実JARを既存reference digestへ照合し、各型のjavap -sysinfo解決元を実JARへ確認した結果を新たに取得した。この実artifact由来の値を、レビュー対象の承認データ`gradleSnapshotOwnerExpected.mjs`へ固定した。旧公開記録の自己申告値をそのまま承認したのではない。

期待表はtuple別の7 artifact digestと、artifact digestをkeyにした14型×2 tupleのclass digest／public signature digest、KotlinCompileの対象method列のbytecode digestを保持する。既存referenceのGradle／KGP digest照合も維持する。記録側は、固定期待値との一致と、保存文字列を再hashした自己整合の両方を満たす必要がある。class digestがhex64であるだけ、artifact digestの文字列を併記しただけでは受理しない。

自己hashを更新したpublic accessor削除・改名、bytecodeのreceiver改変、整形式の別class digest、signatureとclass digestの同時置換を両対象版で拒否する。collectorはこの期待表を読み取るだけで更新しない。未知のartifact／class／signature／bytecodeは失敗とし、追加tupleや変更を許可するには実artifactの再調査と期待表の明示レビューが必要である。

期待表はJDK 21.0.13+9で実取得したjavap出力に対応する。artifactが同じでも表示形式が変わる別toolchainを自動的に同等とせず、必要なら期待profileを別にレビューする。これはrepository内の承認データによる証拠照合であり、電子署名や任意に改変された実行環境への独立証明ではない。期待表自体のhashも他の検証sourceと同じく公開記録へ束縛する。

#### 再実行と範囲

experimentをv2へ更新し、旧未コミットv1はpreReviewsにhash付き要約として残す。現在の調査・公開API実証を両対象版で取り直し、14型×2 tupleのsignature／実artifact解決元、公式sourceとbytecode分岐、BTA公開constructor probeを同じ検証器で再照合する。再現コマンドは§9.32と同じ。期待表の自動生成・更新コマンドを通常collectorへ組み込まない。

BTAで確認したのはmutable Listのaliasと防御的copyによる列固定であり、file bytesや実compiler消費の保証へ拡張しない。追加Gradle build／compiler実行は0、standalone constructor probeは各対象版1件ずつである。既存KGPのhook未成立によるunsupported・打切り、BTAには別owner driverが必要という結論、SO05以降の未実施範囲、自然消費内容束縛・承認recipe・本番採用0件は不変。

最終再実行: Gradle 8.11.1／KGP 2.0.20、Gradle 9.2.1／KGP 2.2.20の14型ずつと、BTA公開constructor probe 2件を現sourceで取り直した。28型の固定期待値・tuple別artifact・guard分岐との一致を確認し、公開記録をv2へ更新した。旧v1履歴要約は1件、source hashは期待表を含む8 fileに一致する。回帰41テストが成功した。ここで追加実行0とするcompilerはKotlin compiler（compileJvm等）であり、probe用のjavac／javaの実行とは区別する。

通常全体の最終確認: 2,353テスト成功・native opt-in等1,157件skip。typecheck・build・差分検査も成功。自然消費内容束縛・承認recipe・本番採用0件の判断は不変。


### 9.34 96f7da8レビュー修正・JDK profileの束縛とsource抜粋化（2026-11-01）

- 固定期待表は「JDK 21.0.13+9のjavap出力」に対応するが、記録の`jdkTools`は検証されていなかった。javapの版・hashの改変や`jdkTools`の欠落も受理していた。期待表へjava／javac／javapの版文字列とhashを`ownerJdkProfile`として固定し、verifierで一致を必須にした。
- 調査JSONはKotlinCompile.ktのtag source全文（2.0.20で22KB、2.2.20で26KB）をbase64で収録していたが、ヘッダが参照する`license/LICENSE.txt`本体は含まず、`license`欄も検証していなかった。公開記録は全文を再配布せず、全文のSHA-256・取得元URL・Apache-2.0・LICENSEへのURL・原著作権表示（notice）と、判定に使う3か所（`isIncrementalCompilationEnabled`の分岐ブロック、`private fun getClasspathChanges(`の宣言行、`classpathSnapshot.files.toList()`の読取行）の行番号付き抜粋だけを保持する。collectorは全文のdigestを固定値と照合してから抜粋を作る。抜粋はsource内で一意であることを要求し、tuple別に抜粋のdigestを固定する。verifierは抜粋から判定を再計算し、license・notice・URLとkey集合も照合する。
- §9.32.3の防御的copyの記述を訂正した。BTAについて観測したのはaliasと取得列の可変性だけで、copy後の固定はcaller側のcollectionの性質である。
- 内容が同じsurveyを再収集した場合は観測時の`recordedAt`／`baselineRevision`を残し、再収集時点を`reconsolidatedAt`／`reconsolidatedRevision`へ別記する。survey本体（JDK profileと両tuple）のtoken化後digestで同一性を判定する。
- 改ざん負例7件を追加した（抜粋の改変・行番号の移動、全文bytesの再収録、license改変、notice欠落、JDK profileの改変・欠落）。抜粋抽出の一意性・notice必須の単体検査と、全文を再収録しないことの確認も加えた。v2記録で失敗することを確認した。

Gradle build・Kotlin compiler（compileJvm等）の実行は0のまま、javapとprobe用のjavac／javaで両対象版の調査を取り直した。tag sourceは前回取得したfileをdigest照合して再利用し、新たな取得はしていない。記録はv3（105KB）で、v2はコミット済み原本（96f7da8）のhash付き要約、旧v1要約とともにpreReviewsへ残す。既存KGPのhook未成立によるunsupported・打切り、BTAには別owner driverが必要という結論、承認recipe・自然消費内容束縛・本番採用0件は変わらない。96f7da8の履歴にはtag source全文が残る。


### 9.35 producer所有BTA driverの限定実証（2026-11-02）

§9.32のB（owner-sealed-offered-inputs）の最小driverをtest-onlyで追加した。既存KGP task・Provider・compiler runnerを変更せず、producerがJavaCompileで専用Java driverを構築し、JavaExecで実BTAを呼ぶ。**提供した入力の束縛・前後の鮮度と実コンパイルを確認する実証であり、自然消費receipt・既存KGPの透過対応・承認recipe・本番採用へ昇格させない。**

#### 構成と入力・artifactの対応

Gradle 8.11.1／BTA・Kotlin compiler 2.0.20と、Gradle 9.2.1／2.2.20を別profileにする。Groovy build.gradleとKotlin build.gradle.ktsは共通のGroovy adapterをapplyし、同じJava driverを呼ぶ。両DSLのproject wrapperの実証であり、Kotlinで別実装したadapter、buildSrc／precompiled plugin／既存build無変更の実証ではない。

runtimeは`gradleBtaDriverRuntime.mjs`の座標・相対path・SHA-256で固定した閉じた集合とする。compiler／BTA／scripting／stdlib／reflect等は同じKotlin版を指定し、reflectはcompiler POM既定の1.6.10から同版へ明示的に揃えた独自profileである。必要なcoroutines・annotations、2.0.20ではbuild-common・trove4jも含める。cache全JARの走査やMavenの既定解決結果と同一とは主張しない。既存KGPが選んだcompiler classpathの証拠にも流用しない。

nativeハーネスはprofileの全file hashを実行前後に照合する。driverは実classpath全件と、public CompilationService API、ロードしたservice implementation／proxy、K2JVMCompiler classのCodeSource／digest、service.getCompilerVersionを記録する。専用driver classの全inventoryは実JavaCompile出力と照合する。固定classpathに別版compilerを追加することや、座標名だけで実装一致とすることは許可しない。class originは閉じたruntimeの実装対応の証拠であり、全内部classloaderやcompiler全readの独立証明ではない。

| stage | public API・成果物と対応 |
| --- | --- |
| library | 自作Library.ktを実compileJvmでcompileし、dep/Library.classとmodule metadataを生成。driverが固定entry時刻のlibrary.jarへ格納。ハーネスがJAR全entryとclass出力を照合 |
| snapshot | library.jarと同版stdlib.jarをcalculateClasspathSnapshot(CLASS_MEMBER_LEVEL)へ渡す。返却された正規snapshotをsaveSnapshotで保存し、非空file・class数・元JAR digest・生成snapshot digestを記録。library側は1 classを要求 |
| seal／offer | snapshotをproducer専用のprivate rootのstagingに置き、evidenceへ同じbytesを保存。具体File列を一度選択し、防御的copy＋unmodifiable Listにする。IC stateも同じprivate rootへ置く |
| warm | 同じ具体snapshot列でpublic IC parameterを作り、SourcesChanges.Unknownを使ってconsumer v1をcompile。先行出力を独立したstageとして記録 |
| consumer | sourceをv2へ変更し、SourcesChanges.Knownでmodified sourceを明示。元のsnapshot列を再評価せず同じ具体列をpublic parameterへ渡してcompile。実行結果、引数、source hash、snapshot ID列、全出力を記録 |
| execution | ハーネスが生成consumer classとlibrary.jar・stdlibで実プログラムを実行。consumer完了時はlibrary-value:v2、gate拒否でwarm出力しかない場合はv1と明示。先行出力を最終compileの成功証拠へ流用しない |

consumer compileはwarm時とは別のclass digestになる必要がある。library source／JAR entry、snapshotの元入力digest、consumerのclasspath引数とsnapshot ID、compiler実装、各stageのsource／出力と実行結果を照合する。private IC cacheのinventoryも診断として保存するが、これをcompilerの全入力manifestや自然消費bytesの完全性とは扱わない。

#### private staging・改変拒否

private root、staging、evidenceはowner-onlyのrwx------で作成する。safeBytesは親directoryの実path、NOFOLLOW_LINKSでのregular file、fileKey、size／mtimeの前後一致を確認して、1 MiB buffer・1 file最大32 MiBで取得する。既存shared cacheのsnapshotを変更せず、自作project内の派生fileだけを故障注入する。runtime JARはread-onlyの入力としてhashを照合する。

consumer前のgateは保存evidenceのsize／digestを先に検証し、次にstaging内の具体pathを元のseal digestへ照合する。保存bytes不一致はkotlin_pipeline_snapshot_storage_mismatch、source不一致はkotlin_derived_snapshot_staleでconsumer呼出しを止める。consumer後にも同じ検査を行い、改変があればcompile成功・出力が存在していても候補を採用しない。captureで新しいbaselineを作り直さない。

owner-only permissionと前後hashは他writerの不存在や消費中不変を保証しない。特に同じuser／processによる変更と復元、mmap、consumer内部の読取範囲は未検証である。private stagingを自然消費receiptの代用にしない。

| mode | 実処理・期待結果 |
| --- | --- |
| control | 同じdriver・生成・gate・warm／consumer・post検査を行い、observerを無効にする |
| observe | concrete ledgerのobserverとconsumer後のcaptureを追加。提供入力と最終出力が整合 |
| mutate-before | warm後・最終consumer gate前にlibrary.snapshotを同sizeで1byte変更。consumerは呼ばずstale。残るv1出力は最終成功に数えない |
| mutate-after | consumer成功後・post検査前に同snapshotを変更。v2出力を実行できてもstaleとして候補を拒否 |
| blob-corrupt | evidence側だけを同sizeで変更。staging sourceを読む前にstorage mismatch。最終consumerは呼ばない |
| source-fault | Gradle側のobserver区間でowned Providerを実際に追加get。BTA・出力検証も行ったうえで追加評価違反として拒否 |

#### 追加評価の計測

Gradleのowned Providerは非空の固定runtime file列を返す。各supplierのbegin/end・phase・回数、target Task／Actionの境界、故障readerのbegin/end・counterを記録する。phaseとイベント位置を照合し、controlと各modeの自然traceを比較する。source-faultの実読取だけはobserver区間へ結び、自然trace比較から分離する。flagだけで読取がなければfault_not_reproducedとして拒否する。

Java側は具体snapshot列の選択をowner-offerで一度だけ行う。observer／captureにはGradle ProviderやKGP collectionを渡さず、保持済みdescriptor／具体pathを使う。selection begin/endとcounter、compile・snapshot生成・gate・post・captureの区間を厳密に照合する。control／observeでlibrary／snapshot／warm・最終consumer出力が一致することも要求する。

追加評価0は、このowned Gradle Providerと具体列selectionの計測範囲に限定する。captureのfile hash／保存evidence読取は追加I/Oであり、0 I/Oという意味ではない。BTA／compiler内部の全supplier・全observerの非干渉、既存KGPとの透過的な非干渉は未成立である。

#### 保存記録・再現・採用範囲

[検証JSON](validation/gradle-bta-owned-driver-2026-11-02.json)には全stage・event・digest・JAR entry・program実行結果・拒否対照と、source／検証source hashを保存する。staging／evidenceの全bytesはnative実行中の使い捨てproject内で照合し、公開JSONにはsnapshotのsize／digest／class数だけを保持する。第三者stdlib由来snapshot bytesは公開しない。公開記録から再生できるのは保存metadataの整合性・判定であり、元snapshot bytesの再照合やcompiler再実行ではない。

nativeと集約・通常テストは同じverifierと改変対照一覧を使う。runtime交換、元library source／JAR entry／snapshot対応の破壊、選択の追加評価、mutable List、必須event／compile欠落、snapshot引数の省略、先行出力流用、最終出力・実行結果の偽装、TaskState欠落、supplier phase偽装、偽の故障を拒否する。端末固有pathは既存のtoken方式へ変換し、残存を拒否する。

```sh
JAVA_HOME=/path/to/jdk21 GRADLE_USER_HOME=/path/to/cache OSV_MCP_TEST_GRADLE=/path/to/gradle-8.11.1/bin/gradle OSV_MCP_BTA_DRIVER_OUTPUT=/tmp/bta-owned-8.11.1.json npx vitest run src/test/gradle/btaDriver.integration.test.ts --maxWorkers=1 --hookTimeout=120000
# 9.2.1もbinary・出力suffixを変更して実行する。
JAVA_HOME=/path/to/jdk21 GRADLE_USER_HOME=/path/to/cache OSV_MCP_GRADLE_RUNTIME_ROOT=/path/to/runtime node src/test/manual/gradleBtaDriverResults.mjs /tmp/bta-owned docs/validation/gradle-bta-owned-driver-2026-11-02.json
npx vitest run src/test/gradle/btaDriver.test.ts --maxWorkers=1
```

これは§9.32のBの限定実証であり、SO05のowner binding、SO07のstagingと前後検査、SO08の改変拒否、SO09の限定control／observerの部分確認である。Aの実消費hook、SO06の自然消費receipt、全writer排除、全read-plan・残り3 slot、本番helper／schema／静的取込・追加信頼は未成立。既存KGPのunsupported・打切りは維持する。BTA native実行が成功しても、offered-inputs-onlyをreceipt-completeやdeclared_in完全性へ昇格させない。

BTA driverのJDK対応は、Gradle daemon側java／javacと、実JavaExec child側javaの版・実行file hashを固定JDK 21.0.13+9 profileへ独立に照合する。record側のapproval hashを同時に書き換えても未知JVMを受理しない。


最終native結果: Groovy／Kotlin × Gradle 8.11.1／9.2.1の各版16テスト成功。最終matrixの24 buildでcompileJvm 64回（library 24、warm 24、consumer 16）、正規snapshot生成48回を確認した。source／保存証拠の改変によりconsumer前で止めた8 buildでもwarmのv1出力を実行し、最終consumerのv2成功へ流用していない。提供入力候補はcontrol／observeの8件、stale拒否8件・storage mismatch拒否4件・実追加評価の拒否4件。共有改変21対照×4組＝84件をnative・集約で再検証した。

全4組でGradle owned supplierはcontrol／observeとも3評価、Java具体列の選択は1回だった。source-faultではsupplierが4評価となり、observer区間の実get 1回を検出した。captureの追加I/Oは別に発生する。30件の静的／公開記録回帰テストも成功し、実証source 6 fileと検証source 8 fileのhash一致を確認した。

最初のstandalone試行ではIC outputDirsにworking directoryが不足し、初回Gradle試行ではJavaCompileのsource／targetCompatibilityが未設定で失敗した。設定を明示してから取り直し、失敗・試行段階のbuildを上記最終matrixへ加算していない。JVM identityの補強後も両版を再実行し、現在sourceに一致する最終結果だけを検証JSONへ収録した。

最終確認: 通常全体2,391テスト成功・native opt-in等1,173件skip。typecheck・build・差分検査も成功。


### 9.36 BTA configuration／snapshot parameterの実参照束縛（2026-11-02）

§9.35の初期v1記録では、snapshot ID列の検証と、最終compileJvmへ渡すconfigurationの対応が不足していた。現在の実証はv2へ更新し、旧v1は検証JSONのpreReviewsへhash付きの参考要約として残す。§9.35末尾の件数は初期検証の履歴であり、現在の結果は本節を用いる。

専用driver内のIdentityHashMapと非公開Bindingで、実service・project・configuration・snapshot parameterの参照を対応付ける。公開useIncrementalCompilationの実receiverと実parameterを呼出し完了後に登録する。descriptorはparameterの実snapshot File列をstaged列とpath単位で照合し、対応するsealed entryのsize／digestを写したものである（sealed-by-path）。照合時にsnapshot bytesを読み直さないため、snapshot内容の保証はpreflight／postflightの検査が担う。独立した報告用入力列だけでcompile成功を検証しない。libraryの非IC configurationも明示登録する。

compile直前に、登録済みconfigurationの実参照、期待Binding、service／project、stage、source／出力path、引数、source hash、実parameter参照とsnapshot descriptorを照合する。Bindingは一度だけ使用可能で、検証に成功してから実BTAを呼ぶ。ただしnative負例はconfiguration実体の差替え3種だけであり、Bindingの再使用、context不一致、parameterのpath不一致の拒否は記録改変対照でのみ確認している。path不一致は拒否記録を残さずdriverの例外終了になる。BTA内部fieldのreflectionは用いない。この保証は固定sourceの専用broker経路に限定し、任意の呼出し元を隔離する機構とは扱わない。

| native負例 | 最終consumerへ実際に渡す値 | 結果 |
| --- | --- | --- |
| default-config | 新しい既定configuration。IC parameterなし・未登録 | configuration_unregisteredとしてBTA呼出し前に拒否 |
| unregistered-config | 実useIncrementalCompilation済みだが未登録のconfiguration | configuration_unregisteredとして拒否 |
| foreign-config | 同じstage・source・引数・snapshot値で別途登録したconfiguration／parameter | configuration_binding_mismatchとして実参照不一致を拒否 |

3負例×両DSL×両Gradle版の12件すべてで、最終consumerのcompileJvm呼出しは0回、最終出力一覧は空である。残るwarm出力v1はwarmとして実行・記録し、最終consumerの成功へ流用しない。別configurationが値として同じsnapshot列を持っていても、期待するconfiguration／parameter実体を代用できない。

再現方法は§9.35と同じで、9 modeを各DSL・各Gradle版で実行する。program・case・run・matrix／experiment記録はv2とし、configurationの生成・useIncrementalCompilation・登録・直前検証を必須証拠に追加した。証拠欠落、receiver／parameter／消費configurationの交換、snapshot変更、拒否記録欠落も共有改変対照で拒否する。

再検証結果はGradle 8.11.1／9.2.1で各28テスト成功。全36 buildで実compileJvm 88回（library 36、warm 36、consumer 16）、正規snapshot 72個を生成した。提供入力候補8件、stale拒否8件、保存破損拒否4件、実追加評価拒否4件、configuration拒否12件。共有記録改変29対照×4組＝116件を再検証し、静的／公開記録44テストも成功した。control／observeのowned supplierは各3回、Java具体列selectionは1回で一致する。

自然消費receipt、全writer排除、compiler内部全supplierの非干渉、既存KGPへの透過対応は引き続き未成立である。承認recipe・自然消費内容束縛・本番採用はすべて0件を維持する。

最終確認（§9.36）: 通常全体2,405テスト成功・native opt-in等1,185件skip。両Gradle版のnative各28テスト、typecheck・buildも成功。

#### 9.36.1 fd66e03レビュー修正・公開記録v3（2026-11-02）

native実行・driver・verifierは変更せず、同じnative集計を公開記録v3へ再集約した。`btaSources`はnative実行時のhashへ束縛されているため、公開形式の検証は別moduleの`btaDriverRecord.mjs`へ置く。

- 記録の`bindingSemantics`に、descriptorの出所（sealed-by-path）、内容保証（preflight／postflight）、native未実証の拒否3種を固定値で記録し、欠落・改変・旧schemaを拒否する。
- private IC cacheの全inventory（各run 66件）は公開せず、entry数・総size・inventory digest・shrunk snapshot entryだけを残す。再生時はshrunk entryだけを持つnative viewへ戻し、元のverifierと記録改変対照を再実行する。全inventoryの再収録や要約の改変は拒否する。記録は1.74MBから1.21MBになった。
- native観測のdigest（`observationSha256`）が同じ場合は`recordedAt`／`baselineRevision`を保持し、再集約時点を`reconsolidatedAt`／`reconsolidatedRevision`へ分けて記録する。v2はfd66e03のcommit済み原本としてhash付き要約を`preReviews`へ残す。
- 失敗log（native harnessが一時領域へ書くfile）の位置は`btaSources`内のため今回は変更せず、次回のnative再実行時に扱う。

再集約は2回行い、2回目は再集約時刻以外が一致した。旧v2記録では静的テスト55件中52件が失敗することを先に確認した。結論・件数（36 build、実compileJvm 88回、configuration拒否12件、記録改変拒否116件）と、自然消費receipt・承認recipe・本番採用0は変わらない。


### 9.37 producer所有driverの提供入力証拠・採用範囲と信頼契約（設計、2026-11-02）

本節は§9.35〜9.36の実証を将来の本番取込へ接続する契約案である。本番helper・schema・設定・承認profileは未実装であり、以下の名称も設計上の識別子とする。今回、新規native実行・承認recipe・本番採用は0件。現在のtest-only profileを本番の承認一覧へ自動転記しない。

#### 9.37.1 採用する情報と禁止する昇格

対象は明示的に導入したproducer所有BTA driverが、snapshot slotへ提供した入力の証拠である。既存KGPへ透過的に追加するobserverではない。取込成功時もconsumptionStatusはoffered-inputs-only、observationKindはbefore-call-and-after-call、naturalContentBindingはfalseとする。全snapshotの実消費、自然消費時点のbytes、消費中不変、全writer排除を表明しない。

§9.35〜9.36のtest記録とは語の割当てが異なる。test記録の`observationKind:offered-inputs-only`は本envelopeの`consumptionStatus`に当たり、本envelopeの`observationKind`（before-call-and-after-call）はtest記録のpreflight／postflightの組に当たる。test記録のfieldを本envelopeの同名fieldとして読まない。

利用先は独立した診断metadataに限る。自然消費slotのready、Kotlin構築pipelineの完全性、実行artifactと宣言sourceの完全な対応、declared_inの採用／補完、coverage.completeの改善には使わない。既存経路で独立に成立したdeclared_inはその経路の根拠で判定し、この証拠を混ぜて不足部分を埋めない。relation／introduced_by・lock由来coverage・脆弱性照会は既存の判定を維持する。

#### 9.37.2 helperの境界と登録・完了契約

将来のhelperはowned driverのcompile broker内だけに置く。beginOfferはcaller指定のdriver instance、invocation、stage、slot、project、承認profile IDと、所有済みの具体値・manifest参照を受け取り、外部から作成できないhandleを返す。Provider／FileCollection／任意callbackを受け取らず、登録のためにKGP getterを呼ばない。source／runtime／入力manifestのseal後、対象compileの前に登録を閉じる。

bindConfigurationは実service・project・configuration・IC parameterを§9.36の実参照で拘束する。公開useIncrementalCompilationの実receiver／parameterと呼出し完了をbrokerが記録し、getterの具体snapshot列をseal時の順序・重複を含む列へ照合する。照合不一致（件数・path・順序）はbinding拒否としてfailedに記録し、BTA呼出し前に止める。§9.36.1のtest driverのように例外終了で拒否記録を欠く実装は本契約を満たさない。path照合はsnapshot内容の保証ではなく、内容はseal時の保存証拠とprecheck／postcheckが担う（sealed-by-path）。登録後のconfiguration変更は禁止する。公開APIだけで内部mutationを検出できない場合は、configurationを外へ公開せずbrokerだけが生成・設定・使用することをprofileの信頼前提とする。任意callerへ渡したconfigurationは対象外。

compile直前gateはhandleの状態、登録締切、実参照、stage／source／引数／出力先、snapshot列、保存証拠とstagingの一致を確認する。gate成功と同時にhandleを使用済みにし、失敗したBTA呼出しも再利用しない。再compileは別invocation・別登録とする。既定・未登録・別configuration、別parameter、別service／project、別stage、再入・重複使用はBTA呼出し前に拒否する。

completeOfferは同期BTA呼出しの正常終了と前後の検査、および予定したcaptureの全完了が揃った場合だけ、提供入力の診断候補を完了する。postcheck成功後・capture完了前は中間状態（postchecked）であり、envelopeへcompletedとして出力しない。completedは終端状態で、以後の検査結果で書き換えない。completedは「束縛したBTA呼出しと前後検査の完了」を意味し、compiler内部の実作業や自然消費の完了を意味しない。BTA失敗・例外・保存失敗・検査失敗はfailedへ不可逆遷移させ、再seal・baseline更新で回復しない。現在の候補範囲はin-processの同期呼出しで、worker／daemon・parallel・外部cache復元は未対応とする。

BTAの成功戻り値・出力の存在・Task実行だけでは、内部incremental no-opを判別しない。現契約はexecutionEvidence=bta-call-only、compilerWorkStatus=unknownを必須とし、内部no-opの可能性を含む。BTAを呼ばないTask skip／cache復元はcompletedにできないが、正常終了した実BTA呼出しは内部no-opが不明でも提供入力証拠としてcompletedにできる。これを「実コンパイル確認済み」と表示・集計しない。将来compilerWorkStatus=performedを採用するには、公開APIに基づくwitnessの取得点・実invocationへの束縛・判定条件と、変更なし再呼出しのnative対照を別profileで実証する必要がある。source変更や出力digest差は診断の補助情報であり、全snapshotの実消費receiptや普遍的なno-op判別器とは扱わない。

#### 9.37.3 保存する証拠とmanifest

本番用のenvelope案をosv-mcp.gradle-owned-offer-v1とする。既存のtest用program／run-v2を本番schemaとみなさない。producerStateはcompleted／failed／unavailableの判別unionとする。下表はcompletedの必須証拠であり、他状態へ一律に要求しない。必須の非空列を空配列で代用しない。自然な空出力inventoryは許可するが、それを実コンパイルの証拠にはしない。

全状態にschema、graph／export ID、producer project、invocation／stage／slot、要求profile ID、producerState、limitations、naturalContentBinding=falseを要求する。未取得の実体ID・digestは成功値として埋めず、phaseに従って省略する。reader側の信頼判定は別のimportStatusで保持し、producerStateを上書きしない。envelope欠落はreaderがunavailableを返す場合であり、存在する不正envelopeを欠落扱いしない。

| producerState | 必須・許可する証拠 | 禁止・省略条件 |
| --- | --- | --- |
| completed | 下表の全証拠、正常なBTA終了、pre／post検査成功、executionEvidence=bta-call-only、compilerWorkStatus=unknown | failure／unavailable reasonは禁止。未実行・未検査項目をsuccessで補完しない |
| failed | failureReason、failurePhase、最後に完了したphase、そこまでの必須証拠と失敗event。呼出し開始済みなら開始記録、呼出しが戻ったなら終了結果を要求 | failurePhase以降の未到達証拠は省略し、後続success・completed結果を禁止。失敗phaseで未生成の値は明示的なnot-producedとする |
| unavailable | unavailableReason、blockedBeforePhase、実施済みphase一覧（空も可）、no-read範囲。合法な未対応理由に限定 | 未実施のconfiguration／compile／検査証拠は省略。既知の失敗・改変を未対応に置換しない |

phase順はregistration→generation→seal→binding→precheck→call→postcheck→captureとする。各phaseにbegin／success／failureを区別し、failedでは成功したprefixと最初のfailureを必須にする。call失敗では終了error／例外記録を要求するが、未生成の最終出力一覧・post検査を要求しない。binding／precheck拒否ではcall開始を禁止する。storage失敗は実際の発生phaseへ結び付ける。captureはinvocation開始時に回数を固定する0回以上の追加検査であり、completedはpostcheck成功と予定capture全件の成功を必須とする。capture失敗はpostchecked→failed（failurePhase=capture）であり、completed→failedの遷移は存在しない。予定回数と実施回数の不一致は構造不正とする。過去completedを現候補へ流用しない。phase前後の証拠不足・順序矛盾は構造不正である。

| 区分 | 必須内容と照合 |
| --- | --- |
| identity | graph／export ID、driver instance、invocation、stage、slot=snapshot、producer project、configuration／parameterのrun-local ID。実参照の保証はbrokerが担い、静的readerはIDだけで再証明しない |
| producer | driver source・構築入力manifest・実行class inventoryのdigest、broker実装版、適用profile digest。sourceと実行classの対応を承認profileの構築条件へ結ぶ |
| runtime | Gradle／JDK／BTA／compiler版と実artifact digest、閉じたclasspathの順序・全inventory、実CodeSource、executionStrategy=in-process。選択候補と実ロードartifactを区別 |
| generation | library cohortの順序・logical ID・JAR digest、snapshot generatorの実artifact／設定、正規生成の結果、元libraryからsnapshotへの全対応 |
| content | 非空snapshot列のlogical ID・具体path・size／digest、seal時の保存bytesまたは内容参照、staging inventory・storage policy。順序・重複を維持 |
| invocation | source manifest digest、引数の順序・classpath、出力先、実configuration／parameter登録・直前gate・compile開始／終了・post検査の順序、結果と出力inventory、executionEvidence／compilerWorkStatus |
| observation | control／observerの承認済み計測範囲・結果、追加評価の有無、capture履歴、制約の固定集合。未計測を0としない |

run-local IDやrecordの自己hashは真正性を保証しない。静的取込にはproducerを明示的に信頼する必要があり、未知のproducerが期待digestを自己申告しても採用しない。export内容全体とmanifestのdigestを結び、別graph・別export・別stageの証拠交換を拒否する。

保存bytes／baseline参照はseal時に固定し、以後のcaptureで再基準化しない。baseline参照は許可された証拠root配下のregular fileと期待size／digestを必須にし、絶対path・root逸脱・symlink・未記録fileを拒否する。readerは有界に検証し、上限超過を部分成功にしない。公開検証JSONのdigest-only縮約は参考記録として許容するが、本番の完全な内容検証用envelopeとして採用しない。

取込時には保存証拠と、現exportが参照するstaging／source／library／runtime manifestを再照合する。過去runの時点記録はhistoryとして区別できるが、現runの診断候補へ流用しない。前後hashが一致しても区間内変更の不存在を証明したとは扱わない。

#### 9.37.4 追加信頼とprofileの責任

将来設定案はtrustOwnedBtaOfferedInputs（既定false）とapprovedOwnedBtaProfilesの併用とし、既存の宣言元・Provider・catalog・plugin・Kotlin pipeline向け信頼で代用しない。設定をrecord側から有効化できない。追加信頼が許可するのは、所有producerの登録・実参照検査・保存処理についての表明を診断用途で受け入れることだけである。

承認profileは独立に管理する固定manifestとし、対象tuple、JDK、閉じたruntimeとdriver構築artifact、実行方式、snapshot generator／format、storage条件、計測範囲、必須limitations、対応schema／broker版を拘束する。現在の実証対象はGradle 8.11.1／Kotlin 2.0.20とGradle 9.2.1／Kotlin 2.2.20、固定JDK 21.0.13+9、共通Groovy helperとJava driverである。版番号一致だけで別digestを許可せず、未知版・未知driver・Kotlin製の別helper・buildSrc等へ承認を一般化しない。

固定limitationsは、offered-inputs-only、no-natural-consumption-receipt、no-all-writer-exclusion、no-compiler-internal-supplier-proof、no-transparent-kgp-integration、snapshot-slot-only、no-compiler-work-witnessとする。削除・緩和やreceipt-completeへの変更を追加信頼で許可しない。現profileのnative成功は候補の実証であり、未実施のstaging・実行条件の検証を埋めない。本番承認前には§9.32のSO07〜SO10と本節の条件を満たす必要がある。

#### 9.37.5 gate順序と拒否理由

静的readerは最初に有界parse・schema／必須証拠の構造検証を行う。producerState別の必須・禁止項目とphase順を検証し、構造不正を「信頼無効」へ格下げしない。その後の読取前gateで設定と独立したprofileを確認し、承認されない場合はproducerのsource getter・staging・baseline・runtimeへアクセスしない。既に読んだenvelope内で判明する矛盾も拒否し、gateが閉じているため未実行のfile検査を成功と記録しない。gate通過後だけpath安全性・内容・鮮度・bindingを検証する。

理由はproducerがenvelopeへ記録するものと、readerが判定するものに分ける。producerが自ら検出して記録した拒否は、そのproducerが契約どおり停止した証拠であり、graph拒否の理由ではない。graph拒否はenvelopeの表明とreaderの検証結果が矛盾する場合に限る。

| producerState | producerが記録する理由案 | readerの扱い |
| --- | --- | --- |
| unavailable | unavailableReason: execution_unsupported／evidence_unavailable（producer側で取得不能な実行方式・証拠） | 構造が正しければimportStatus=producer_unavailable。診断候補なし、自然消費readyはfalse |
| failed | failureReason: binding_mismatch／configuration_unregistered／configuration_reused／ic_state_mismatch／storage_identity_mismatch／storage_inventory_mismatch／path_invalid／content_mismatch／stale／storage_failed／budget_exceeded／compile_failed／extra_evaluation（§9.46で実装へ合わせた） | 構造が正しく、gate通過後の再照合で記録と矛盾しなければimportStatus=producer_failed。診断候補なし。graphは拒否しない。readerが再読取で確認するのはstale／content_mismatchだけで、identity・IC・保存境界の拒否はproducerの表明として受理する |
| completed | なし | 全検証成功時だけimportStatus=accepted（offered-inputs-only） |

| readerの判定 | 理由案（importStatus） | 扱い |
| --- | --- | --- |
| 信頼・承認なし | owned_offer_trust_disabled／owned_offer_profile_unapproved／owned_offer_envelope_missing | importStatus=unavailable。producerStateを書き換えず、gate後の読取は行わない |
| task action未実行（§9.43） | owned_offer_action_not_executed | importStatus=unavailable、executionEvidence=not-called。envelopeの構造は検証するが内容は読まない。非対応strategyのexecution_unsupportedとは区別する |
| 実行witness不正（§9.43） | owned_offer_execution_invalid | 呼出側が渡したwitnessの欠落・状態矛盾・期待ID不一致。graphを拒否する |
| 構造不正 | owned_offer_schema_invalid／owned_offer_required_evidence_missing | graphを拒否。必須非空列の空配列・未知status・必須limitations欠落・状態とphaseの矛盾を含む |
| integrity違反 | owned_offer_profile_mismatch／owned_offer_claim_mismatch／owned_offer_content_mismatch／owned_offer_path_invalid／owned_offer_inventory_mismatch（§9.46） | graphを拒否。completedなのに再照合で内容が合わない場合はcontent_mismatch、producerが記録したstale等の拒否をreaderが確認できない場合はclaim_mismatchとする（§9.48）。binding・鮮度が合わない場合、failedのfailureReason・failurePhaseが証拠と食い違う場合、記録された拒否を別理由・別phaseへ付け替えた場合、実行済みwitnessの下でenvelopeが別のexecutionIdを持つ場合（§9.43）を含む。部分metadataやdeclared_inへ縮退させない |

未知profile IDはunapprovedだが、既知承認profile IDを名乗って実artifactが異なる場合はmismatchとする。未定義の「省略可能な証拠mode」は設けない。合法なfailed／unavailableは上記unionで判定し、未到達証拠の省略だけでgraphを拒否しない。completedを表明して必須証拠が欠ける場合や、failed／unavailableの状態・phaseに矛盾する証拠がある場合は構造不正である。producerが記録したfailureReasonはreaderのintegrity理由へ昇格させず、readerのintegrity違反をproducer_failedへ格下げしない。本理由は設計案であり、§9.36のtest fixtureの既存reason文字列を今回変更しない。

#### 9.37.6 回帰テスト条件（未実装）

| ID | 条件 |
| --- | --- |
| OO01 | 明示信頼＋独立承認profile＋全証拠の正常系のみ診断候補。statusはoffered-inputs-only、自然readyはfalse |
| OO02 | 信頼無効・profile未承認・未対応strategyでfile／getter読取0。completed／failed／unavailable各unionの正常構造をgate前に受理し、状態別の必須欠落・禁止項目・不正phaseは信頼無効でも拒否。importStatusとproducerStateを混同しない |
| OO03 | 既定・未登録・同値の別configuration、別parameter／service／project／stageを実nativeで拒否。自己申告IDの一致で回避不可 |
| OO04 | 重複begin・締切後登録・再入・使用済みhandle・失敗後再利用・登録後mutationを拒否。broker外公開configurationは未対応 |
| OO05 | 別export／graph／invocationの交換、source／構築class／runtimeの変更を拒否。未知profileと既知profile不一致を区別 |
| OO06 | snapshotの空列・順序／重複変更、別library cohort・generator・format・parameter列への交換を拒否。parameterのpath列不一致はnativeでbinding拒否（failed記録、BTA呼出し0）になることを必須とし、例外終了・記録欠落は不合格 |
| OO07 | staging／baselineのroot逸脱・symlink・path置換・未記録file・保存bytes改変・容量超過を拒否。digest-only公開recordは本番候補に不可 |
| OO08 | seal後・最初のcapture前・post検査前の改変を拒否。capture複数回でも元baselineへ照合し再sealで回復しない |
| OO09 | 変更なしでBTAを実再呼出しするnative対照を両DSL・両版に追加。正常終了してもbta-call-only／unknownでありperformedや自然消費へ昇格不可。BTA未呼出しのskip／外部cache復元、compile失敗・worker継続はcompleted不可。warm出力を最終成功へ流用しない。将来の実作業witnessは別profileで検証 |
| OO10 | control／全対象observerの追加評価・区間偽装・必須event欠落を拒否。未計測内部supplierを0と表明不可 |
| OO11 | limitations削除・status昇格、offered証拠から自然ready・declared_in補完・coverage改善を行う変換を拒否 |
| OO12 | 未対応で宣言元の部分一覧を生成しない。独立した既存宣言元の判定、relation／introduced_by・lock coverageは維持 |
| OO13 | precheck拒否・binding拒否・seal中storage失敗・call例外・postcheck失敗・capture失敗・未対応unavailableの正常unionをproducer_failed／producer_unavailableとして受理し、graphを拒否せず未到達証拠を要求しない。到達済み必須証拠欠落、失敗後success、precheck拒否後call、偽failureReason／failurePhase、postchecked状態のcompleted出力、予定capture数の不一致、completed→failed・failed→completed／unavailable、reader integrity違反のproducer_failedへの格下げ、producer記録拒否のgraph拒否への誤昇格を拒否。readerのimportStatusとproducerStateを別fieldで検証 |
| OO14 | 両DSL・両対象版を個別profileで検証し、未実施strategy・残り3 slot・全pipelineへ実証範囲を拡張しない |

次工程はこの契約に対するproducerの状態機械・envelopeの限定実証と、未実施staging条件の検証である。本番取込・承認profileの有効化はそれらの結果をレビューしてから別工程で行う。


### 9.38 producer所有helper・状態別envelopeの限定実証（2026-11-02）

§9.37の次工程1として、test-onlyの`BtaOfferProbe.java`、共通Groovy wrapper、`btaOfferContract.mjs`の静的readerを追加した。本番adapter・scanner・設定・schema validatorには接続していない。Groovy／Kotlinのproject wrapperから同じJava brokerを呼ぶ実証であり、Kotlinで別実装したhelperや既存KGPの透過対応ではない。

#### 実configurationと状態遷移

brokerの非公開Handleはowner、実service／project／configuration／IC parameterを保持する。configurationとparameterはbroker内で作成・設定し、具体snapshot列は変更不能なcopyにする。source hash、引数copy、出力先、snapshot descriptorを対応付け、public useIncrementalCompilationが返ってからbinding成功を記録する。registrationを閉じた後だけconsumerを許可し、precheck成功時に使用済みへ遷移する。call中の再入・完了後再使用・失敗後再使用は追加BTA呼出し前に拒否する。

状態eventはphaseごとのbeginとsuccess／failureを持つ。未到達の証拠を埋めず、実callの失敗にはBTAのerror resultまたは例外種別を保存する。静的readerは状態union・成功prefix・最初のfailure・phase順・必須／禁止項目・固定limitationsを、信頼gateより前に検証する。failedだからといってintegrity違反を省略へ格下げしない。ただしこの初期readerは、producerが自ら記録したstale／binding拒否もgraph拒否として扱っており、§9.37.5（b48427a）の分類と食い違っていた。現行の判定は§9.40による。

| native case | 実処理・検証 |
| --- | --- |
| completed | 正規非空snapshot 2個をpublic IC parameterへ渡し、実BTAでconsumerを呼び、pre／post検査成功。completedはbta-call-only／compilerWorkStatus=unknown |
| storage-failed | 保存済みbaselineへCREATE_NEWで再書込し、実FileAlreadyExistsExceptionを捕捉。sealでfailedとし、未到達のbinding／call／postを要求しない |
| call-failed | 不正Kotlin sourceを実BTAへ渡す。error resultとcall failureを記録し、出力／post成功を補わない |
| post-failed | BTA正常終了後にstagingのsnapshotを変更。postcheckのstaleをfailedとして記録（初期readerはgraph拒否。§9.40でproducer_failedへ修正） |
| foreign-config／foreign-project／foreign-parameter | 実public configuration、別ProjectId、同じsnapshot値を持つ別parameterを渡し、実参照不一致をprecheckで拒否 |
| stale-precheck／source-changed | snapshotまたはsourceをbinding後に実変更し、call前に拒否 |
| unsupported | registration前に止まる合法なunavailable。実consumerの成功へ数えない |

別に、重複begin、call中再入、完了handle再使用、完了後の不正phase、failed handle再使用、締切後登録を実行し、操作前後のBTA call counterが変化しないことを検証する。context・parameter拒否はmetadataの書換えだけでなく、実BTAオブジェクトを使ったnative対照である。今回のforeign-configは既定configurationで、同値の別登録configurationは§9.36の別matrixが根拠となる。

#### 静的gate・保存内容・profile

readerはgraph／export identityを照合し、信頼無効・profile未承認・非対応strategyでは渡されたfile readerを呼ばない。信頼設定とprofileはenvelope外から渡す。nativeケースごとに、呼ばれると例外になるreaderでもgate結果を検証する。既にenvelope内で判明するintegrity違反はgate前に拒否し、その際もfile読取0である。

承認されたcompletedだけ、元sealのbaselineとstagingをsize／digestへ再照合する。nativeで実bytesを読み、改変対照では最初の読取から元digestへ照合する。readerのテスト用上限はenvelope 1 MiB、1 snapshot 32 MiB、baselineとstaging合計128 MiB。配列・文字列・phase数にも上限を設け、pathは相対pathとして検証する。symlink／path置換への完全なnative検証、全inventory、競合writer・消費中変更の保証は次工程に残す。

profileは既存の固定BTA runtime manifestとJDK profileを使う独立したtest用値であり、本番承認ではない。nativeハーネスは実runtime全JAR、Gradle親java／javacとchild java、実JavaCompileのclass inventory、fixture sourceを照合する。registrationにはproducer source／runtime manifest／profileのdigestを結ぶ。producerSha256は`BtaOwnedDriver.java`と`BtaOfferProbe.java`の2 sourceのhashだけから作り、Gradle wrapper・runtime-profile・readerの実装を含まない。本番で必要な完全なproducer構築・入力manifestのschema／静的再照合をすべて実装したものではなく、今回のreaderは状態・gate・参照証拠の限定prototypeである。§9.37のenvelope名も仮称のままで、本番取込用の完成schemaとは扱わない。

#### 結果・再現・残る範囲

[検証JSON](validation/gradle-bta-offer-contract-2026-11-02.json)へ、source／検証source hash、実class inventory、全envelope・拒否記録・gate判定を保存した。Gradle 8.11.1／9.2.1 × Groovy／Kotlinの4 build、各版24テスト成功。BTA呼出し16回（library 4、consumer 12）、正常終了12回・意図したcompile失敗4回、正規snapshot 8個。completed 4、failed 32（うちintegrity拒否24）、unavailable 4、handle操作の拒否24件を確認した。成功呼出し数はcompiler内部の実作業回数・自然消費回数を意味しない。

静的／公開記録再生50テストで、正常なfailed／unavailable prefix、状態別の証拠欠落・不正phase・limitations削除・configuration／parameter交換・誤ったwork表明・信頼gate内読取・profile不一致・改変を確認した。公開JSONはmetadata再生用であり、正規snapshot bytesを収録していない。native中に実施した内容再照合を、公開metadataだけで再実行したと扱わない。実証sourceはnative実行前後と集約時に照合し、保存記録と現在sourceの不一致をテストで拒否する。

```sh
env JAVA_HOME=/path/to/jdk21 GRADLE_USER_HOME=/path/to/cache OSV_MCP_TEST_GRADLE=/path/to/gradle-8.11.1/bin/gradle OSV_MCP_BTA_OFFER_OUTPUT=/tmp/bta-offer-8.11.1.json npx vitest run src/test/gradle/btaOffer.integration.test.ts --maxWorkers=1
# 9.2.1もbinaryと出力suffixを変えて実行する。
node src/test/manual/gradleBtaOfferResults.mjs /tmp/bta-offer docs/validation/gradle-bta-offer-contract-2026-11-02.json
npx vitest run src/test/gradle/btaOffer.test.ts --maxWorkers=1
```

初回のJavaCompile設定不足と、最初のハーネスでのsnapshot読取用child processのbuffer不足は修正し、最終sourceで取り直した4 buildだけを記録に含めた。試行buildは上記件数へ加算していない。

OO01〜OO05・OO08・OO10〜OO14のうち状態／gate／handle／metadataに関する部分を実証したが、全条件達成とはしない。OO06〜OO08の完全な入力manifest・storage／path安全性・容量故障のnative対照、全observerの評価計測、OO09の変更なしBTA再呼出しは未実施である。今回はProvider／KGP getterをobserverへ渡さず、readerの呼出し回数を検証したが、compiler内部全supplierの追加評価0は表明しない。本番helper・静的取込・profile承認、自然消費receipt、declared_in／coverageへの昇格は行っていない。

最終確認（§9.38）: 通常全体2,466テスト成功・native opt-in等1,209件skip。typecheck・build・差分検査も成功。


### 9.39 状態別envelopeのレビュー修正・call結果とcase別期待値（2026-11-02）

§9.38の初期実証には、call失敗のdetailが非空文字列なら成功値・未知値も受理する問題と、保存記録のcase別期待状態を検証せず件数を固定で返す問題があった。修正前に成功／未知result、storage-failed／call-failedをunavailableへ変更して全判定も更新する4対照が失敗することを確認した（別途、source fingerprintの旧記録不一致も検出）。

- callのfailureはreason=compile_failedを要求する。errorKind=resultでは、対象API artifactのenumを照合したCOMPILATION_ERROR／COMPILATION_OOM_ERROR／COMPILER_INTERNAL_ERRORだけを許可し、COMPILATION_SUCCESS・未知値をschema不正として拒否する。errorKind=exceptionは例外記録として区別する。既知error 3種の受理は静的対照であり、OOM／内部errorをnativeで発生させた実証ではない。
- 全10 caseについてproducerState、failedのfailurePhase／failureReason、unavailableの理由／blockedBeforePhaseを独立した期待表へ固定する。call-failedのnative対照には実COMPILATION_ERROR resultを要求する。記録とtrusted／gate判定を同時に書き換えてもfailed→unavailableへ変更できない。
- producerの報告をprobe-v2へ更新し、libraryの実結果・source／JAR digest・出力inventoryと、実snapshot生成descriptorを保存する。snapshot生成を各offerのgeneration記録へ照合し、libraryと固定runtimeのstdlib／generator artifactに対応付ける。
- 完了／失敗／未対応は検証済みproducerStateから、consumer呼出し・正常終了は検証済みcallのbegin／successから集計する。library呼出しは検証済みlibrary結果、snapshot数は検証済み生成descriptor、handle拒否は理由・操作前後counterを検証したauditから算出する。producer側counterとの不一致も拒否し、caseの数だけから実行回数を推定しない。build数は検証したnative caseの数であり、内部compiler作業回数ではない。

検証記録はexperiment-v2へ更新した。旧未コミットv1はhash・観測時点・scope付き参考要約をpreReviewsへ残し、現sourceに合う新規native結果だけを現在のmatrixとして収録する。両DSL・Gradle 8.11.1／9.2.1を取り直し、各版24テスト成功。最終matrixは4 build、BTA呼出し16回・正常終了12回、snapshot 8個、completed 4／failed 32／unavailable 4、handle拒否24／integrity拒否24である。前回実行分との累積値ではない。

静的／公開記録再生は62テスト成功。成功・未知call結果の拒否、既知error 3種の受理、storage-failed／call-failedからunavailableへの全判定同時変更、失敗phase／理由の変更、library／consumer／snapshot counterの不一致を追加対照とした。再現コマンドは§9.38と同じ。

本番取込・承認profile・自然消費receipt・内部no-op判別の実証は追加していない。bta-call-only／compilerWorkStatus=unknownと、§9.38の未実施範囲を維持する。

最終確認（§9.39）: 通常全体2,478テスト成功・native opt-in等1,209件skip。typecheck・build・差分検査も成功。公開文書の再現例から個人用proxy接頭辞を除去し、文書検査も通過した。


### 9.40 a6d5409レビュー修正・producer記録拒否とcapture計画（2026-11-02）

§9.38〜9.39のreaderは、producerが自ら記録したstale／binding_mismatch等をgraph拒否としていた。§9.37.5（b48427a）の分類と食い違うため、readerを契約どおりに直し、両DSL・両Gradle版のnativeを再実行した。

- producerが記録したfailedは、構造が正しければ`importStatus=producer_failed`として受理し、graphを拒否しない。producerの理由は`producerReason`に分け、readerの理由（`reason`）と混ぜない。unavailableは`producer_unavailable`とし、信頼無効・profile未承認・非対応strategyだけをreader側の`unavailable`とする。
- stale／content_mismatchは信頼gate通過後にreaderが再読取し、snapshotのbaseline／stagingまたはsourceの不一致を自ら観測した場合だけ受理する。内容が一致すれば`owned_offer_claim_mismatch`でgraphを拒否する。identityの拒否（binding_mismatch等）はbroker内の実参照比較の表明であり、静的readerは再証明しない。この理由同士の付替え（staleからbinding_mismatchへ）は検出できない。
- 理由ごとに記録可能なphaseを固定し、不可能なphaseへの付替えは`claim_mismatch`とする。graph／exportの不一致もproducer用のbinding_mismatchではなく`claim_mismatch`とする。
- envelopeに`plannedCaptures`（invocation開始時に固定、上限8）を追加した。brokerは初期状態をpendingとし、postcheckと予定capture全件の成功後にだけcompletedを書く。completedのcapture数不一致、予定なしのcapture失敗、pendingの出力を拒否する。unavailableはbinding以前に限る。
- nativeに`capture-failed`（予定1回のcapture前にsnapshotを変更）と`foreign-paths`（path列を逆順にした別parameter）を追加した。後者は例外終了ではなくprecheckのbinding拒否としてfailedに記録され、BTA呼出しは0回である。同じparameterのままpath列だけを変える経路は、不変Listのため到達できない。

Gradle 8.11.1／9.2.1で各版30テスト成功。最終matrixは4 build、BTA呼出し20回（library 4、consumer 16）・正常終了16回、snapshot 8個、completed 4／failed 40／unavailable 4、handle拒否24件。producer記録拒否32件はすべて`producer_failed`で、うちstale 16件はreaderの再読取（各5 file）で不一致を確認した。readerによるgraph拒否は0件である。前回の件数との累積ではない。

検証記録はexperiment-v3とし、v2はa6d5409のcommit済み原本としてhash付き要約を`preReviews`へ残した。静的／公開記録再生は83テスト成功。修正前のreaderとv2記録では、83件中32件が失敗することを先に確認した。公開記録ではstale再読取の結果を記録値として照合するだけで、snapshot bytesを持たないため再読取そのものは再実行できない。

本番取込・承認profile・自然消費receipt・内部no-op判別の実証は追加していない。bta-call-only／compilerWorkStatus=unknownと、§9.38の未実施範囲を維持する。


### 9.41 OO09・変更なしBTA再呼出しと実Task skip／cache対照（2026-11-02）

§9.40のhelper実証を拡張し、変更なしの実BTA再呼出しと、BTA task actionを実行しないGradleの対照を追加した。test-onlyの共通Groovy wrapper／Java brokerを両project DSLから使用し、既存KGPや本番adapterは変更しない。

#### 変更なし再呼出しの束縛

completedの直後に別invocation／別Handleのunchangedを登録済みの計画に従って実行する。source・library・snapshotを再生成／再書込せず、同じproject実参照、source path／bytes、snapshotのpath列とsealed descriptor、IC directory／shrunk snapshot、引数、出力先を再利用する。configuration／IC parameterは新しく生成し、別の実参照であることを記録する。projectのfinishは両呼出しの後まで遅延し、同じserviceとprojectで連続実行する。

最初はSourcesChanges.Unknown、再呼出しは公開SourcesChanges.Knownのmodified／removedを両方空にして渡す。bindingにはsourceChangesとincrementalStatePathを追加し、期待するknown-empty、初回とのsource・引数・IC／出力先・projectの一致、configuration／parameter IDの相違を独立に検証する。unchangedEvidenceは実参照比較・呼出しcounterの増分・前後の出力inventoryを保存し、envelopeのbinding／call証拠と照合する。

両対象版で正常終了し、出力inventory／digestは初回と一致した。ただし成功戻り値・既存出力・同一digestからcompiler内部のno-opを認定しない。再呼出しもexecutionEvidence=bta-call-only、compilerWorkStatus=unknown、naturalReady=falseである。今回確認したのは「変更なしと表明した具体入力・IC状態で実BTAをもう一度呼び、正常終了した」ことであり、compiler内部の作業・read・全supplierの有無ではない。

#### 実Taskの未実行・復元対照

各DSL／版の一時projectで次の3 buildを順に実行する。cacheはproject専用のlocal directoryを使い、remote cacheへは接続しない。JavaExecのcache許可とfixture／runtime入力・出力の指定はこの閉じた実証用であり、一般のBTA taskを安全にcache可能と認定する設定ではない。

| build | 実処理と期待証拠 |
| --- | --- |
| seed | offerProofのJavaExec actionを実行。実BTA matrixとreportを生成し、local build cacheへ保存 |
| skip | onlyIf=falseで同じtaskを実SKIPPEDにする。seedの成功reportは残っているがactionは実行しない |
| cache | reportとbuild/proof出力を削除して再build。実FROM-CACHEで元出力が復元され、actionは実行しない |

TaskStateのdidWork／skipped／noSource／failure／skipMessage、doFirstのaction counter、各build固有executionIdをcache対象外のafterTask reporterから取得する。cache外のaction logにはseed executionIdが1回だけ残り、skip／cache buildで増えないことを別に確認する。実行されていない状態の欠落・不正値・action実行との矛盾は拒否する。

classifyOfferExecutionはこのfresh witnessを検証し、seedは「今回のenvelopeを検査可能」とするだけで実コンパイルを認定しない。skip／cacheはexecutionEvidence=not-called、importStatus=unavailable、理由execution_unsupportedとする。ハーネスはそれらをcurrent envelopeとしてreadOwnedOfferへ渡さない。残存／復元reportのSHA-256を元のseed reportと照合してhistoryとして保持するが、その中のcompletedを新しいBTA呼出し・新しいHandleの完了へ数えない。既存readerの信頼／profile gateやproducer_failedの取扱いは維持する。

#### 結果・記録・回帰条件

probeはv3、native matrixはv3、[検証JSON](validation/gradle-bta-offer-contract-2026-11-02.json)はexperiment-v4へ更新した。旧commit済みv3はhash・scope・観測時点・commit付き参考要約をpreReviewsへ残す。native source／fixture／runtime／親child JDK／実class inventoryを実行前後と集約時に照合し、公開metadataは同じ検証器で再生する。第三者snapshot bytesやlocal cache bytesは公開しない。

Groovy／Kotlin × Gradle 8.11.1／9.2.1で各版36テスト成功。最終matrixは12 build（seed 4、SKIPPED 4、FROM-CACHE 4）、変更なし実再呼出し4件、実BTA呼出し24回（library 4、consumer 20）・正常終了20回、snapshot生成8個。completed 8／failed 40／producer unavailable 4、handle拒否24、producer記録拒否32、readerによるcontent拒否再確認16、reader graph拒否0。skip／cacheの8 buildはBTA呼出しを加算しない。数値は今回の最終matrixであり、前節と累積しない。

静的／公開記録再生103テスト成功。unchangedのsource・引数・project・IC path変更、configuration／parameter ID再使用、known-emptyのunknownへの付替え、skip／cacheの成功採用、TaskState必須field欠落、FROM-CACHEとaction実行の矛盾を拒否する。source fingerprint不一致を更新だけで隠さず、現sourceで両版のnativeを再取得した。

再現コマンドは§9.38と同じ（各版のハーネスが3 build×2 DSLを実行する）。OO09の変更なし再呼出し・実Task skip／cache復元の区別は今回の範囲で実証した。compiler内部no-opの判別・実消費receipt、worker／daemon・parallel、全observerの追加評価計測、未実施staging／完全な構築入力manifest、本番取込・profile承認は引き続き未成立。offered-inputs-onlyをdeclared_in完全性やcoverage改善へ昇格させない。

最終確認（§9.41）: 通常全体2,519テスト成功・native opt-in等1,221件skip。typecheck・build・差分検査も成功。


### 9.42 OO09レビュー修正・IC内容束縛と取込入口の実行gate（2026-11-02）

§9.41にはIC状態をpathだけで比較する不足と、実行classifierがreaderから独立している不足があった。レビュー用の一時コピーでは、初回完了後にIC内容を消去してもunchangedがcompletedとなり、sameIcPath=trueのまま通過した。採用gateの回帰対照でも、修正前はSKIPPED／FROM-CACHEをreaderへ渡すとfile readerが呼ばれることを確認した。

#### IC内容の観測点と拒否

初回のpostcheckと予定captureを終えた後、completedへ遷移する前に、IC directoryの完全なsnapshotを保持する。rootのfileKey、全directory／regular fileの相対path・種類・fileKey、fileのsize／SHA-256を保存し、再呼出しのprecheckで新たに取得したsnapshotと照合する。shrunk snapshotを含む非空の先行状態を必須とし、snapshotを再呼出し側の内容で作り直さない。

取得はNOFOLLOW_LINKSの属性照合と既存safeBytesを使い、symlink／非regular entryを許可しない。上限は4,096 entry、1 file 32 MiB、合計128 MiB。directoryのmtimeやsizeのような自然に変わる値は比較せず、fileの内容と実体を照合する。これは初回完了後から再呼出し直前までの二観測点の対応であり、区間内の変更・復元や全writer不存在の証明ではない。

正常なunchangedとは別に、ic-delete-seed／ic-modify-seed／ic-reset-seedを実BTAで先行成功させ、それぞれの状態を固定する。各retryは新しいHandle／configuration／parameterを持ち、対応するseedと同じsource・snapshot・project・引数・出力先・IC pathを使い、Knownのmodified／removedは空である。別caseの自然なIC更新によって拒否されただけにならないよう、各対照は独立したIC directoryを持つ。

| native負例 | 実変更と期待結果 |
| --- | --- |
| ic-delete | seed後にshrunk-classpath-snapshot.binを削除。inventory欠落をprecheckで拒否 |
| ic-modify | 同fileを同sizeで1byte変更。digest不一致をprecheckで拒否 |
| ic-reset | IC directory全体を削除して空directoryを再作成。状態の再初期化をprecheckで拒否 |

いずれもproducerState=failed、failurePhase=precheck、failureReason=ic_state_mismatchを記録し、BTA retryのcall eventは生成しない。理由はproducer自身の拒否としてgate通過後にproducer_failedで受理する。静的readerが実参照や過去IC状態を再証明したとは扱わない。公開記録では、独立したseed baselineとpre-call snapshotの対応・内容・matched・call counter、caseごとの期待変更を検証する。

#### 実行witnessを必須とする取込入口

公開するtest用取込入口readOwnedOfferは、設定側の期待executionIdとexecutionWitnessを必須とする。独立したclassifierを呼出側で使い忘れても採用できない。ただしwitnessと期待IDはどちらも呼出側が渡す値であり、readerはその真正性を検証できない。偽のwitnessに古いenvelopeと同じIDを与えれば採用される。witnessの真正性は呼出側（ここではハーネスと、producerと同じbuild logicが書くGradle afterTask reporter）に依存する（§9.43）。witnessの必須field・状態整合性・期待IDを検証した後、action未実行ならenvelopeの成功状態へ進まず、executionEvidence=not-called／importStatus=unavailable／fileReads=0を返す。ここでの0はsnapshot／sourceのfile reader呼出し数で、ハーネスが読むreportやTaskStateなどのmetadata I/Oを含まない。

action実行済みの場合も、envelopeのexecutionIdがfresh witnessのexecutionIdと一致することを、内容読取前に要求する。childへはdoFirst内で実行IDを環境変数として渡し、brokerが全envelopeとreportへ格納する。このIDは実行metadataとしてtask action時に設定し、local cache keyには加えない。FROM-CACHEのreportは元seed IDのままであり、新しいbuild IDへ付け替えない。

nativeハーネスは各buildの残存／復元されたcompleted envelopeを実際にreadOwnedOfferへ渡す。seedでは通常の内容検証を行い、実SKIPPED／FROM-CACHEでは呼ばれると失敗するfile readerを渡して、入口自身が追加読取0で採用を止めることを確認する。分類結果だけでなく取込判定、実file reader counter、envelopeの元executionIdも記録・再検証する。freshな実行済みwitnessを使って古い成功を採用する試み、witness欠落、期待ID不一致も拒否する。

#### 再検証結果と保存記録

両DSL・Gradle 8.11.1／9.2.1で各版42テスト成功。最終matrixは12 build（seed／SKIPPED／FROM-CACHE各4）、正常な変更なしretry 4件、IC状態拒否12件、未実行buildでの成功envelope採用拒否8件。実BTA呼出しは36回（library 4、consumer 32）、正常終了32回・意図したcompile失敗4回、snapshot生成8個。追加したIC負例用seedを含めcompleted 20／failed 52／producer unavailable 4、handle拒否24、producer記録拒否44、content拒否のreader再確認16、reader graph拒否0。IC retry拒否とskip／cacheのbuildはBTA呼出しへ加算しない。

probe／native matrixはv4、[公開検証記録](validation/gradle-bta-offer-contract-2026-11-02.json)はexperiment-v5へ更新した。旧未コミットv4はhash・観測時点・scope付き参考要約としてpreReviewsへ残し、現sourceで取り直した結果だけを現在のmatrixに収録する。IC inventoryはmetadataだけを保持し、cacheや第三者snapshotのbytesは公開しない。公開記録の再生でnative時のfile読取・実体比較を再実行したと扱わない。

静的／公開記録再生121テスト成功。IC baseline欠落・pre-call snapshot欠落・digest改変・拒否を一致へ変更・削除後の再baseline化・検査中の追加BTA call、skip／cacheの採用表明・file reader追加・復元IDの付替えを拒否する。再現コマンドは§9.38と同じ。bta-call-only／compilerWorkStatus=unknown、自然消費receipt・本番採用0、未実施staging／完全な入力manifest／全observer計測の範囲は維持する。

最終確認（§9.42）: 通常全体2,537テスト成功・native opt-in等1,227件skip。typecheck・build・差分検査も成功。


### 9.43 c555f4fレビュー修正・実行gateの理由と公開IC記録（2026-11-02）

§9.42のreaderとIC記録について、実行witnessの信頼前提、reader理由の分類、公開記録の端末固有値と重複を直し、両DSL・両Gradle版のnativeを再実行した。

- 実行witnessの真正性は呼出側に依存することを§9.42に明記し、偽のwitnessで古いenvelopeが採用されることを静的テストで固定した。readerが保証するのは、witnessの構造・状態整合性と、期待ID・envelopeのexecutionIdの一致だけである。
- task action未実行は`owned_offer_action_not_executed`とし、非対応strategyの`execution_unsupported`と分けた。戻り値は他の結果と同じ形（producerState・producerReason・fileReads等）にし、未実行でも保持されたenvelopeの構造は検証する（file reader呼出しは0）。実行済みwitnessの下でenvelopeのexecutionIdが異なる場合は、readerが検出した表明の矛盾として`owned_offer_claim_mismatch`とする。§9.37.5の表へ両理由を追加した。
- IC inventoryの`fileKey`／`rootKey`は、broker内で実体の同一性を比較したうえで、run内の`key-N`へ置き換えて記録する。device番号・inode番号は記録しない。`icChecks`から基準の複写を除き、基準は`icBaselines`だけに置く。記録は1.49MBから1.13MBになった。
- `sameIcContents`は該当invocationのIC検査から取り、modesの並び順に依存しない。`preReviews`の`committedIn`は短縮hashへ揃えた。

両DSL・Gradle 8.11.1／9.2.1で各版42テスト成功。件数は§9.42と同じ（12 build、BTA呼出し36回・正常終了32回、completed 20／failed 52／unavailable 4、IC状態拒否12、未実行buildでの採用拒否8、reader graph拒否0）。probe／native matrixはv5、検証記録はexperiment-v6とし、v5はc555f4fのcommit済み原本として要約を`preReviews`へ残した。静的／公開記録再生は126テスト成功。修正前のreaderとv5記録では126件中7件が失敗することを先に確認した。

bta-call-only／compilerWorkStatus=unknown、自然消費receipt・本番採用0、§9.38〜9.42の未実施範囲は変わらない。


### 9.44 staging・保存証拠の境界検証とcapture前後の改変拒否（2026-11-02）

次工程1として、test-onlyのBtaOfferStorage.javaを追加し、producerのstagingとevidenceを独立した保護領域として検証する。既存のhelper・実行gate・IC内容束縛・producer記録拒否の分類は維持する。本番adapterや汎用の静的filesystem readerの実装ではない。

#### 保存・seal・検査の契約

生成された非空snapshotの具体列から保存する名前・size／digestを固定し、CREATE_NEWでstagingとevidenceへ書き込む。上書き・再baseline化は許可しない。保存成功後のsealで、project rootから各保存rootまでの全lexical ancestor、root本体、全direct entryの種類と実体をNOFOLLOW_LINKSで検査する。領域はsnapshot 2 fileだけのflat inventoryとし、未記録fileを許可しない。親directory・root・fileのidentityはnative内で比較し、公開記録ではrun-local key-Nだけを保持する。

seal以降のprecheck／postcheck／captureは同じledgerへ照合する。repeatは親seedのledgerを継承し、現在のfileからledgerを作り直さない。directory／fileのsymlink、非regular entry、名前一覧の不一致、祖先・root・fileの実体変更、容量超過を内容読取より前に拒否し、実体が同じ場合だけ安全なbounded readでsize／digestを照合する。内容読取後にも祖先・file identityを再確認する。

標準上限は1 file 32 MiB、領域合計128 MiB、1 root 16 entry。保存時はsourceのsizeと累積書込量を検査してから開き、検査時も属性値で上限を確認してから内容を読む。負例用の閉じたprofileではtotal上限1 KiB、entry上限1を別に用いる。これらを本番の承認profileとは扱わない。

保存途中の例外はsealのfailedへ不可逆に遷移させる。storage-failedは正常な保存処理のevidence書込先へdirectoryを先置きし、実CREATE_NEWのFileAlreadyExistsExceptionを検出する対照へ置き換えた。保存成功後の無関係な重複書込で失敗を代用しない。未完成の保存領域からbindingやBTA callへ進まない。実証した保存I/O故障はこの衝突であり、実disk-fullや全種類のI/O故障を発生させたという意味ではない。

#### native負例

| 対照 | 操作・拒否 |
| --- | --- |
| staging／evidenceのfile symlink | 元fileを保護領域外の同project内へ移動し、同じbytesへ向くlinkを作成。path_invalid、内容読取0 |
| staging／evidenceのroot symlink | rootを退避してlinkへ差替え。path_invalid、内容読取0 |
| staging／evidenceのfile置換 | 同じbytesの新fileをatomic moveで差替え。storage_identity_mismatch、内容読取0 |
| staging／evidenceのroot置換 | rootを退避し、同内容の新directory／fileを作成。storage_identity_mismatch、内容読取0 |
| staging／evidenceの未記録file | unregistered.txtを追加。storage_inventory_mismatch、内容読取0 |
| staging／evidenceのfile容量超過 | sparse fileを32 MiB＋1 byteへ拡張。budget_exceeded、内容読取0 |
| 合計容量・entry超過 | 実snapshotが1 KiBのtotal上限を超える保存、2 entryが上限1を超えるseal。budget_exceededとしてBTA前に拒否 |
| capture前の内容改変 | stagingまたはevidenceを1 byte変更し、capture開始後の検査でstale |
| capture処理後の内容改変 | 最初のcapture検査の後にstagingまたはevidenceを変更し、capture成功前の後検査でstale |
| capture処理後の置換・未記録file | 同bytesのfile置換またはfile追加を行い、後検査でidentity／inventory拒否 |

上表の追加20 caseを各DSL／版で実行する。captureは予定1回をbegin→前検査→処理後の後検査→successとして扱い、後検査が失敗すればcaptureのfailureだけを記録してcompletedにしない。capture-failed等の既存内容改変対照も同じ検査経路へ移行した。単にcapture後へfailure flagを追加したものではなく、実file操作と元ledgerへの再照合で拒否する。

producer側のpath_invalid／storage_identity_mismatch／storage_inventory_mismatch／budget_exceeded／storage_failedは、正しいphaseで記録されたproducer_failedとして受理する。staleは既存契約どおり信頼gate後にreaderが内容不一致を再確認する。producerの拒否と、readerが表明の矛盾を検出してgraphを拒否する場合を混同しない。

#### 証拠・回帰・再検証結果

storageSealsは最初のledgerを一度だけ保存し、storageChecksはphase・前後のcall counter・理由・読取数・上限・観測digestを持つ。成功時はledgerのdigestとの一致を検証し、観測全体の複写を保存しない。拒否時は原因の検証に必要な観測metadataを保持する。書込失敗には実error種別・完了書込量・試行sizeも記録する。新しい公開検証器btaOfferStorageProof.mjsは、sealと生成descriptorの対応、全検査の順序、captureの前後、理由に対応する実体／inventory／容量／内容の不一致を検証する。

Groovy／Kotlin × Gradle 8.11.1／9.2.1の最終sourceで各版82テスト成功。12 build（seed／SKIPPED／FROM-CACHE各4）、実BTA呼出し60回（library 4、consumer 56）・正常終了56回、snapshot生成8個。captureの拒否対照にも実BTAの先行成功を要求し、precheck・sealでの拒否はcall eventなしとする。completed 20／failed 132／producer unavailable 4である。

保存領域の拒否は96件（新規20 case×4組＝80、実保存失敗4、既存のpostcheck／capture／precheckの内容改変12）。IC状態拒否12、未実行buildでの成功envelope採用拒否8、handle拒否24、producer記録拒否124、readerによる内容拒否再確認32、reader graph拒否0。前節との累積ではなく、現在のmatrixから検証済み証拠を集計した値である。

静的／公開記録再生158テスト成功。ledger／audit欠落、基準digestやidentityの変更、拒否の成功化、unsafe fileの読取、拒否中の追加BTA call、capture前検査の削除を拒否する。symlinkをregular fileへ偽装、容量違反を消去し観測の自己hashも更新する対照も拒否する。変更前には必須storage auditの欠落を検出できないことを先に確認した。

probe／native matrixはv6、[検証記録](validation/gradle-bta-offer-contract-2026-11-02.json)はexperiment-v7へ更新。旧commit済みv6はhash・観測時点・scope・commit付き要約をpreReviewsへ残した。再現方法は§9.38と同じで、追加Java helperも同じJavaCompileから構築する。runtime／JDK／class inventory・sourceの一致をnativeと集約で検証する。公開記録にsnapshotやlocal cacheのbytesは含めず、metadata再生をnativeのread再実行とは扱わない。

今回保証するのは、閉じたproducer経路の保存・検査時点と、capture処理前後の観測である。全writer排除、区間内の変更と復元、compilerが自然消費したbytes、terminal completed後のあらゆる競合を保証しない。汎用の静的path／storage manifest取込、全observerの追加評価計測、本番profile承認・本番採用は別工程に残す。内部no-opはunknown、自然消費receipt・本番採用0を維持する。

最終確認（§9.44）: 通常全体2,574テスト成功・native opt-in等1,267件skip。typecheck・build・差分検査も成功。


### 9.45 保存境界レビュー修正・書込前symlink拒否と列挙上限（2026-11-02）

§9.44のwriteは保存先の祖先／root検証より先に書き込み、rootViewはsort後にlimitを適用していた。レビュー時の一時コピーでは、project外を指す保存root symlink経由でfileを作成し、その後のsealで初めてpath_invalidとなった。また、maxEntries=16でも200 entryを全件列挙してから拒否していた。両問題を修正し、現在sourceで両DSL・両Gradle版を再実行した。

#### 書込前の両保存先gate

writeの最初に、staging・evidence両方がproject配下の正規化済みlexical pathであることと、project rootから各保存rootまでの全componentがNOFOLLOW_LINKSでdirectoryであることを確認する。一方のrootが不正な場合に、他方へ先に部分保存しない。source snapshotの読取より前に両保存先を検証し、最初のdirectory実体を保持する。各file書込の直前と保存処理終了時にも、両保存先と最初の実体の一致を確認する。最終fileはCREATE_NEW／WRITE／NOFOLLOW_LINKSで開く。

新規native対照はstaging-before-write-symlink、evidence-before-write-symlink、parent-before-write-symlinkの3種。project外に専用directoryと既知のsentinelを用意し、空の保存rootまたは共通祖先をそのdirectoryへのsymlinkにして、実際のwrite入口を呼ぶ。いずれもsealのwriteでpath_invalidとなり、snapshot sourceの読取0、保存write試行0、保存byte 0で拒否する。領域外の相対file inventory／size／digestが前後で同じことも独立に確認する。

領域外directoryとsentinelの作成は故障準備であり、上記0件は検証対象のproducer保存処理の書込を指す。故障用directoryとlinkは観測後に元へ戻し、テストが作った領域外directoryを削除する。絶対pathは公開証拠に含めない。先行symlinkの拒否を実証したもので、検証とopenの間に任意writerが祖先を入れ替える競合を完全に排除する保証ではない。

#### sortより前の列挙予算

rootViewはdirectory streamのsource側で受け取ったentryを計数し、最初のmaxEntries＋1件だけを保持する。上限超過ならそこでbudget_exceededとし、sort・entry属性検査・内容読取へ進まない。上限内の場合だけ、最大maxEntries件をsortして従来のinventory／実体／内容検証を行う。

各listingにrole・実列挙数・上限を保存し、全storageChecksでcount≦maxEntries＋1を要求する。成功する検査では内容読取前後の各root listingも照合する。これはJava directory streamから検査が受け取るentry数であり、filesystem providerやOS内部のbuffer／syscall数を計測したものではない。

staging-many-entries／evidence-many-entriesは、通常の2 snapshotに200 fileを実追加した202-file directoryを使う。maxEntries=16に対して17件で停止し、内容読取0でprecheckのbudget_exceededとなる。故障準備・Gradleのcache出力走査をこのlistingの計測へ含めない。上限1の既存entry-budget対照も2件で止まる。

#### 検証結果・記録

Groovy／Kotlin × Gradle 8.11.1／9.2.1で各版96テスト成功。書込前symlink拒否は12件で、保存処理の領域外write 0。202-file directoryの列挙上限拒否は8件、各17件で停止した。全listingも上限＋1以内であることを検証した。BTA前に止める新規5 caseのため、BTA実行回数は前節と同じである。

最終matrixは12 build、BTA呼出し60回・正常終了56回、snapshot生成8個、completed 20／failed 152／producer unavailable 4、保存領域拒否116件。IC状態拒否12、未実行buildの成功envelope採用拒否8、handle拒否24、producer記録拒否144、内容拒否のreader再確認32、reader graph拒否0。前節との累積ではない。

probe／native matrixはv7、[検証記録](validation/gradle-bta-offer-contract-2026-11-02.json)はexperiment-v8へ更新した。旧未コミットv7はhash・観測時点・scopeを持つ参考要約としてpreReviewsへ残す。native source／実class／runtime／親child JDKを照合し、現在sourceの最終matrixだけを収録する。再現方法は§9.38と同じ。

静的／公開記録再生177テスト成功。新規probe・列挙counterの欠落を修正前に見逃すことを先に確認し、領域外file追加、拒否前のwrite試行・保存byte・source読取、列挙202件への変更、counter削除、故障fixture数の偽装を回帰対照に追加した。write前の拒否も必須の観測metadataとphaseへ結び付け、単に後段でseal失敗となった場合を同じ成功対照として扱わない。

内部no-opはunknown、自然消費receipt・本番採用0を維持する。全writer排除、汎用の構築／入力manifestと静的path取込、全observerの追加評価計測は別工程である。

最終確認（§9.45）: 通常全体2,593テスト成功・native opt-in等1,281件skip。typecheck・build・差分検査も成功。


### 9.46 a5be821レビュー修正・取込み時のbounded readerと理由表（2026-11-02）

§9.44〜9.45の保存境界の保護はproducerの保存・検査時点だけに働き、readerが取込み時に基準fileを読むcallbackはsymlinkを辿り、lexicalなpath検査しか行っていなかった。completed後にstagingのfileを同じbytesへのsymlinkへ差し替えても`accepted`となり、§9.37.3（OO07）のreader側要件を満たしていなかった。

- contractに取込み用の`boundedOfferReader(root)`を追加した。rootをrealpathで固定し、各componentをlstatでsymlinkでないdirectory、最後をregular fileと確認する。O_NOFOLLOWで開いたfileの実体（dev／ino／size）がlstat時と同じことも確認する。違反は`owned_offer_path_invalid`、32 MiB超は`owned_offer_budget_exceeded`である。
- readOwnedOfferは各基準fileを、そのdirectoryに登録された名前一覧と一緒にreaderへ渡す。bounded readerは上限16＋1件までの一覧が登録名と一致することを要求し、登録外entryを`owned_offer_inventory_mismatch`で拒否する。nativeハーネスの全読取（seed取込・全case判定・stale再確認）をこのreaderへ置き換えた。
- nativeでは各DSL／版で、completed後に実storageを改変して取込みを試すprobeを追加した。stagingのfileを同bytesへのsymlinkへ差替え、evidence rootをproject外へ移してsymlinkで置換、登録外fileを追加の3種で、いずれも取込みで拒否する。復元後のcontrolは元の判定と一致する。reader側の拒否は12件である。
- §9.37.5の理由表を実装へ合わせた。producer理由に`ic_state_mismatch`／`storage_identity_mismatch`／`storage_inventory_mismatch`／`path_invalid`を加え、未実装の`parameter_mismatch`を除いた。producerの`path_invalid`（failureReason）と、readerが検出する`owned_offer_path_invalid`（graph拒否）は別の判定である。readerが再読取で確かめるのはstale／content_mismatchだけで、保存境界・IC・identityの拒否はproducerの表明として受理する。failedは診断候補にならないため、偽の拒否は採用を増やさない。
- §9.44の記録縮小（祖先列の共有化）は見送った。祖先列は記録2.92MBのうち約0.19MBで、残りは主にcase数に比例するenvelopeと保存検査記録である。

Java producerは変更していない。両DSL・Gradle 8.11.1／9.2.1で各版104テスト成功。件数は§9.45と同じ（12 build、BTA呼出し60回、completed 20／failed 152／unavailable 4、保存領域拒否116、reader graph拒否0）に、取込み時のreader境界拒否12を加えた。native matrixはv8、検証記録はexperiment-v9とし、v8はa5be821のcommit済み原本として要約を`preReviews`へ残した。静的／公開記録再生は189テスト成功。修正前のreaderとv8記録では189件中13件が失敗することを先に確認した。

検査とopenの間に任意writerがcomponentを入れ替える競合、全writer排除、汎用の静的path／manifest取込は引き続き未成立である。bta-call-only／compilerWorkStatus=unknown、自然消費receipt・本番採用0を維持する。


### 9.47 producer所有driverの構築・入力manifest契約（設計、2026-11-02）

§9.37のmanifest要件を、§9.38〜9.46の限定実証から次の公開API実証へ進められる形へ具体化する。本節は設計であり、新規collector／本番schema／承認profileの実装・native実行は行っていない。既存のtest記録のsource hash・実class inventory・runtime manifestを、以下の全要件に適合したmanifestへ読み替えない。

#### 9.47.1 完全性の範囲と採用する表明

completenessDomainはowned-recipe-inputsとし、独立に承認したrecipeが構築・起動・snapshot生成・BTA呼出しへ渡す入力集合を対象にする。Gradle全体、任意plugin／buildSrc／applied script、compilerの内部read-plan、KGP所有4入力全体の完全性ではない。対象recipeの入力を列挙できない場合、その範囲はunavailableであり、既知の入力だけをcompleteとして出さない。

状態は区別して保持する。manifestStructureは構造と参照閉包、inputCompletenessは承認recipeの必須role・directory inventory・入力宣言との一致、currentContentMatchはreaderが確認した現在の内容一致、producerBuildAssuranceはtrusted-recipe-receipt、executionAssuranceはcaller-witness、loaderAssuranceはapproved-loader-policyとする。どれか一つの成功を他の成功へ変換しない。run-local ID、自己hash、CodeSourceのpath、同じclass名、現在のfile内容だけでは過去の実行bytecodeや実消費bytesを再証明できない。

採用先は引き続き診断metadataだけで、consumptionStatus=offered-inputs-only、executionEvidence=bta-call-only、compilerWorkStatus=unknown、naturalContentBinding=falseとする。manifestが完全でも自然slotのready、declared_in補完、coverage.complete改善、全Kotlin構築pipelineの採用条件を満たしたことにはしない。

#### 9.47.2 bundleと参照の形式

仮称osv-mcp.gradle-owned-manifest-bundle-v1を、将来のoffer envelopeから参照する別objectとする。既存test用envelopeのv1やexperiment記録のversionは今回変更しない。bundle headerの共通必須fieldはschema、completenessDomain、graphId／exportId／project／context／executionId／invocation、要求profileId／recipeId、coreGraphDigest、producerState、completedThrough、approvalStatus、evidenceIndexRef、limitationsとする。成功stageのrefは一律に要求せず、次の状態・到達stageのunionで決める。null・空文字列・全0 digest・架空objectで未生成refを埋めない。

stage順はprepare→build→runtime-selection→snapshot-generation→offerとし、completedThroughは必要な成功receiptが揃った連続prefixの終端（noneを含む）とする。prepareでsealするinputManifestRefはdriver構築用の入力manifestであり、まだ生成されていないclass／snapshotのdigestを含めない。後続stageは、そのstage用の入力manifestと上流output refを自分のreceiptへ保持する。§9.47.3の全roleはこの閉包全体で満たすもので、prepare時に未来の出力を列挙する要求ではない。

| completedThrough | 必須の成功ref（累積） | 禁止する未到達の成功ref |
| --- | --- | --- |
| none | なし | inputManifestRef・buildReceiptRef・runtimeSelectionRef・generationReceiptRef・offerReceiptRef |
| prepare | inputManifestRef | buildReceiptRef・runtimeSelectionRef・generationReceiptRef・offerReceiptRef |
| build | 上記＋buildReceiptRef | runtimeSelectionRef・generationReceiptRef・offerReceiptRef |
| runtime-selection | 上記＋runtimeSelectionRef | generationReceiptRef・offerReceiptRef |
| snapshot-generation | 上記＋generationReceiptRef | offerReceiptRef |
| offer | 上記＋offerReceiptRef | なし |

| producerState | 到達stageと追加必須field／ref | 禁止・省略条件 |
| --- | --- | --- |
| completed | completedThrough=offer。表の成功ref全件。approvalStatus=approved、profileDigest／recipeDigest必須 | failureStage／failurePhase／failureReason／failureReceiptRef、blockedStage／unavailableReason／unavailableEvidenceRefを禁止 |
| failed | completedThroughはnone〜snapshot-generation。failureStageは直後のstage、failurePhase／failureReason／failureReceiptRef必須。approvalStatus=approved、profileDigest／recipeDigest必須 | 失敗stage自身と以降の成功refを禁止。failureReceiptへ実施済みsubphase・結果／例外・部分出力・not-producedを記録し、それを成功refへ代用しない |
| unavailable | completedThroughはnone〜snapshot-generation。blockedStageは直後のstage、unavailableReason／unavailableEvidenceRef必須。成功prefix分のrefだけを要求 | blockedStage以降の成功refとfailure用field／refを禁止。合法な未対応だけを許可し、既知の失敗を未対応へ付け替えない |

approvalStatus=approvedはproducer側で独立したprofile／recipeを解決したという記録で、reader設定の追加信頼や承認を有効化しない。unavailableでも既に解決済みならprofileDigest／recipeDigestを要求する。解決前はapprovalStatus=unavailable、producerState=unavailable、completedThrough=none、blockedStage=prepareに限り、両digestと全成功refを禁止して要求IDだけを保持する。未承認profileの自己申告digestで解決済みを装わない。

evidenceIndexRefは全状態で要求するが、既に保存できたobjectだけを列挙するmetadata indexである。failureReceiptRef／unavailableEvidenceRefはbinding・理由・観測済みprefixを持つ独立した小さいobjectとして保存し、indexにはこれらと存在する成功objectのrefを入れる。index自身とbundleへの逆参照を置かない。未生成の入力／成果物を要求せず、読取未実施を成功として記録しない。状態object／indexそのものを保存できなければ、成功bundleを作らずexport失敗として扱う。

例えばprepare中の入力改変はcompletedThrough=none＋failureStage=prepare＋failureReceiptRefだけで合法なfailedとなる。構築失敗はprepareの成功refとbuildのfailure receipt、snapshot生成失敗はruntime-selectionまでの成功refとgenerationのfailure receiptを要求する。未承認toolchainはprepare前のunavailable、build成功後の未対応loaderはbuildまでのprefixを持つunavailableとして表す。これらへ未到達refの欠落を理由にschema拒否を行わない。

共有する上流構築receiptは元のbuildInvocationId／artifact IDを維持し、このofferからの利用refとして結ぶ。prefixを満たしても、新しいofferのたびにcompilerを実行したとは数えない。readerはstage別のbinding対応を照合し、共有refで別構築や別contextの出力を混在させない。

各refはrole・objectDigest・byteLengthを持ち、型が一致する保存objectだけを参照できる。file参照はrootIdと相対path、size、raw SHA-256を持ち、rootIdはreader設定側の承認root registryで解決する。manifestの絶対pathやURLで新しい読取rootを許可しない。artifact cacheの座標や表示名はidentityの代用にしない。root registryはproject／source／build evidence／approved toolchain image／approved runtime artifactを役割別に分ける。

object digestは、typed schemaの既知ASCII field名を昇順にし、配列の順序・重複を維持する再帰的canonical JSONのUTF-8 bytesから算出する。文字列はJSON.stringifyと同じescaping、整数は非負のsafe integerのみ、lone surrogate・未知field・重複JSON keyを拒否する。logical pathのcase・Unicode・空白・percent文字を変換しない。fileのraw digestはBOM／改行／encodingを正規化しない。canonical JSONのcross-language test vectorを実装前に固定する。JSON.stringifyは`\b`・`\f`と、その他のU+0000〜U+001Fを`\u00xx`（小文字hex）でescapeし、U+007F以上は原文のまま出力する。既存test fixtureの`BtaOwnedDriver.json()`はbackslash・引用符・`\n`・`\r`・`\t`だけをescapeするため、この規則を満たさない。collectorやreceiptのdigest計算へ流用しない（§9.48）。

循環hashを作らないため、将来のgraph wrapperをcoreGraphとownedOfferBundlesへ分け、coreGraphにはbundleへの参照を置かない。offer envelopeとbundleの間も参照の向きを一方に固定する（§9.48）。envelopeはbundleのdigest・refを持たず、bundleの`offerReceiptRef`はenvelopeとは別のoffer receipt objectを指す。offer receiptはenvelopeのdigestを含んでよいが、envelope・offer receiptのどちらもbundle digestを含めない。envelopeとbundleの対応は、`ownedOfferBundles`の各entryが両方のdigestを組として持つことで結ぶ。readerはその組と、bundle内のoffer receiptが持つenvelope digestの一致を照合する。coreGraphDigestはcoreGraph全体のcanonical digestで、trusted callerが期待する値へ照合する。bundle digestはheaderとrefのcanonical bytesから算出し、bundle自身のdigestをheaderへ入れない。各receiptも上位bundle digestを含めず、共通binding IDと上流のobject refを保持する。class／JAR／compiler出力のinventoryは実際の成果物rootだけを対象とし、receipt・manifestは別evidence rootへ保存して自己参照を避ける。未知の循環参照・参照先のrole違反はschema不正とする。

#### 9.47.3 必須入力roleと生成の対応

| role | 必須証拠・完全性条件 |
| --- | --- |
| driver-sources | 実compilerへ渡す全sourceの順序・raw bytes／保存参照・encoding、source directoryの全inventory。内側classも含む構築結果へsource集合として結ぶ。SourceFile属性だけでclass単位の宣言元を断定しない |
| driver-build-recipe | 所有executorの実装artifact／source、compilerの実起動方式、実行file／toolchain image、引数列・cwd・明示environment・system property、compile classpath／module path、source path、processor／plugin／生成source policy |
| driver-build-inputs | response fileの元bytesと展開列、明示resource・生成sourceの上流receipt、構築に使う追加file／literal。未登録のgenerator・自動探索・暗黙source探索を許可しない |
| driver-output-set | §9.47.4の新規・空の専用rootの開始証拠、compiler正常終了、同じroot実体の終了証拠とclass／nonclass全inventory・size／digest。余分なclass、欠落、後付けresourceを拒否。JARへ格納する場合はpackaging receiptと全entryの対応も要求 |
| execution-environment | 独立に承認したJDK imageとGradle／launcher、loader policy、起動引数、明示env／property、実行strategy。bin/java／javacのhashだけでJDK全体を完全としない |
| runtime-classpath | 実BTA childへ渡す全directory／JARの順序・重複・全内容digest、API／impl／compiler／stdlib等のrole。承認profileの閉じた集合と一致。親loader・service provider選択もpolicyの範囲へ含む |
| library-cohort | BTAのcompile classpathとsnapshot generatorへ渡すlibrary列の順序・重複・logical ID・内容digest。自作libraryは構築receipt、外部artifactは独立承認artifactとの一致が必要 |
| snapshot-generation | 実generator instance／実行artifact・format／granularity／設定、元libraryの各occurrence、実save先、返却結果、保存size／digest。一括生成ならbatchの全入力・全出力と対応granularityを明示し、曖昧な1対1対応を捏造しない |
| offer-inputs | consumer source集合、実引数列・classpath・出力先、実configuration／parameterへのbinding、snapshot列、IC基準とKnown／Unknown changes。初回完了後→repeat前のIC内容束縛を維持 |
| storage-and-observation | §9.44〜9.46の保存ledger・capacity policy・読取root・保存bytes参照、予定capture、phase順と全observerの承認済み計測範囲。未計測を0と表明しない |

同じartifactを複数roleで使う場合も各roleとoccurrenceを残す。content objectの保存は共用できるが、classpathやsnapshotの配列をdeduplicate／sortして意味を変えない。input directoryはrecipeで閉じたrootとし、checkout全体を無条件に走査しない。登録名との全inventory照合で完全性を確認し、見つけたfileだけを一覧にしてcompleteとしない。

JARはraw file全体のdigestをprimary identityにし、entry inventoryは欠落・追加とstage対応の検証に用いる。class entryはcompilerのoutput-set ref、resourceは登録file refまたは承認generatorのoutput ref、MANIFEST等の固定metadataはrecipeに固定したliteral bytes refへ結ぶ。未知のnonclass entryを「tool生成」と自己申告するだけでは許可しない。entry名の重複、path traversal、絶対path、file／directory衝突、展開予算超過を拒否し、名前を正規化して危険なentryを合法化しない。JARを検証するために展開・実行しない。

#### 9.47.4 構築receiptと信頼境界

最初の実証候補は、所有executorが具体的なsource／classpath／引数を固定してjavacを起動する閉じたrecipeとする。annotation processingは-proc:none、暗黙source探索は明示sourcepathと-implicit:none等の固定policyで禁止する。Kotlin compilerやprocessorを使う別recipeは、独自の入力closureと実証が必要。今回のJavaCompileが成功したことだけでその全入力closureを確認したとは扱わない。

初期driver構築recipeのoutput rootは、buildInvocationIdごとに所有executorが承認output parent配下へ新規作成する専用directoryとする。既存rootは空でも再利用しない。候補pathが既存file／directory／symlinkの場合はoutput_root_exists、祖先のsymlink・root逸脱・別実体への置換はoutput_root_invalidとして、compilerを起動せずbuildのfailedに記録する。caller所有pathを削除・掃除して新規とみなす処理は禁止する。

root作成直後とcompiler呼出し直前の2点で、同じroot実体であることとdirect entry数0を検証する。class／resource／隠しfile／symlink／空の子directoryもentryとして数え、一つでもあればoutput_root_not_emptyで止める。空判定は最初の1 entryで拒否でき、directory全件を走査・sortしない。rootの所有buildInvocationId、承認parent、lexical path、nativeでの実体token、作成・直前検査の順序と空inventoryを開始証拠へ保存する。outputはsource root、登録済み入力directory、compile classpath／module path／source pathと包含・alias関係を持たないことを検証し、旧driver出力を暗黙のcompiler探索先に入れない。

compiler終了後は同じroot実体へ全output inventoryを対応付け、必要なdriver entrypointとpackaging用の登録entryが揃うことを確認する。実体変更は失敗とし、現在の別rootを今回のoutputとして採用しない。JARを作る場合も新規archiveをCREATE_NEWで作り、fresh output-setと登録resource／literalだけから全entryを構成する。compile成功後にpackagingが失敗した場合はbuild失敗であり、成功buildReceiptRefは発行しない。

compiler失敗時の部分outputはfailureReceiptの診断証拠に限り、実行・packaging・成功output集合へ利用しない。再試行には新しいbuildInvocationIdと新しい空rootを要求する。最初のrecipeでは増分構築・既存outputへの上書き・build cache復元を新規driver構築として認めない。将来の増分recipeは親output manifest、削除／継承規則、書込結果の帰属を含む別契約と実証を必要とする。

この空root条件は実際にdriverをjavacで構築するstageへ適用する。構築済みdriver artifactの上流ref利用や、OO09のBTA consumer出力／IC状態の再利用を禁止するものではない。それらは元build receiptまたは親consumer／IC基準に結び、新しいdriver構築へ数えない。fresh rootと検査点は過去のclass混入を防ぐ開始条件であり、任意の同時writerの不存在を独立証明する機構ではない。outputへの書込を所有compilerと承認packagerに限定するproducer信頼も必要である。

source capture・sealは、所有producerが実行する具体invocationの構成完了後、実compiler呼出しの直前に置く。configuration時点の先行hashやTask.inputs.filesへの追加getで代用しない。自然に完成した具体値／保存済みbytesだけを受け取り、Provider・FileCollection・任意callbackを追加評価しない。compiler終了後の出力inventoryへbuild receiptを発行し、起動前と終了後の入力を元sealへ照合する。変化した入力は同じreceiptの新baselineへ置き換えず、failedにする。

receiptは実compiler instance／process、source集合、実引数・environment、toolchain、全入力ref、結果、output-set ref、時系列を結ぶ。静的readerはこの結び付けを再実行・再コンパイルして証明せず、承認済みexecutorの表明として受理する。構築されたdriver classが対応source集合の出力であることと、そのclassが実行されたというloaderの表明は別のassuranceである。CodeSource現在値だけでロード／変換前後のbytecode一致を保証しない。追加信頼で未承認transformer・agent・loaderを許可しない。

JDKは実行file以外のmodule／library／設定を含む承認imageへ結ぶ。初期候補はtrusted provisionerが承認・固定したimage inventoryと現在のimageの一致を確認できるものに限り、archive digestの自己申告だけでは採用しない。image内linkを許す場合は別の明示policyと閉包が必要で、現在のbounded readerのsymlink拒否を暗黙に緩和しない。対応を確立できなければtoolchain image assuranceはunavailableである。

起動env／propertyは所有launcherが明示的に構成する。JAVA_TOOL_OPTIONS等のagent／任意引数注入、未登録argfile・classpath追加、未承認native／service-provider入力を受理しない。完全な環境値やsecretを公開manifestへ列挙せず、承認した非secret値は保存値へ、秘密入力が必要なrecipeは別の保護された証拠契約へ結ぶ。未定義secretをhashだけ保存してcompleteとしない。

Gradleのsettings／init／build script・convention pluginを構築制御へ使う場合、実際に評価／ロードされた実体と対応付ける既存の承認済みprovenance契約が必要である。事後にscriptの現在bytesをhashするだけでは、評価したbytesとの一致を証明できない。最初のmanifest実証が保証するのは所有compiler recipeの入力であり、未証明のhost script評価や任意Gradle build全体へ完全性を拡張しない。

#### 9.47.5 seal・静的取込・鮮度

prepareでdriver用入力manifestを構成してsealし、build→runtime-selection→snapshot-generation→offerで各stage用の入力manifestとreceiptを上流refへ順に結ぶ。bundleの必須ref・失敗／未対応の省略は§9.47.2のunionに従う。各stageは自分の入力がreadyであることを確認してから進み、出力生成前の不明refを成功値で埋めない。planned captures、IC基準、storage ledgerは各invocation開始時に固定する。offer内部の失敗phase・未到達証拠の省略は§9.37を維持し、bundleのstage順と混同しない。

readerは有界parseでschema・ref型・DAG・必須role・binding／状態の構造矛盾を検証し、trusted callerのgraph／export／context／execution／invocationへ照合する。信頼無効・未知profile・未知recipe・Task未実行では、構造検証を維持しつつ入力file／artifact／KGP getterへ進まない。既存の実行gateとbounded readerを迂回してmanifest参照を開かない。readerはGradle・compiler・generatorを実行しない。

gate通過後は承認rootだけからobject／fileをbounded streamingで読み、size／digest・全inventory・保存bytes・元sealとの対応を照合する。source・driver class・library・runtime・snapshotの現在値をそれぞれ対応するseal／receiptへ確認し、内容一致だけでreceiptの真正性や現在の実行を証明したとしない。run-local identity tokenは同一native観測内の実体比較に限り、別process／再取込の実inodeへ読み替えない。

snapshot領域の32 MiB／128 MiB／16 entryをruntime JARやtoolchain inventoryへ流用しない。新artifact用readerはprofileに固定した別budgetとし、初期案は1 file 512 MiB、全raw file 4 GiB、inventory 65,536 entry、metadata object 8 MiB。listingは上限＋1で停止し、上限内だけsortする。JAR展開byte・entry数・compression比・object参照総数・depth・全context合計のbudgetも固定し、同じobjectへの重複refで無限に再読取しない。実装・native実証で妥当性を確認するまで、この数値を本番の承認値としない。

過去runの証拠はhistoryとして区別する。現在のcoreGraphやsourceが変わったのに古いmanifestへ一致を表明、fresh witnessへ古いenvelopeを付替え、他contextのoutputを混在させる場合はreader integrity拒否である。過去のcurrentContentMatchを再取込時に再使用せず、最初の読取から元sealへ確認する。元の証拠が不足する場合に現fileから再baseline化しない。

#### 9.47.6 未対応・失敗・拒否の分類

以下のowned_manifest_*は設計上の理由案であり、既存のfixture reasonや公開APIは今回変更しない。producerの記録理由とreaderのgraph拒否理由を分離する。

| 条件 | 分類と扱い |
| --- | --- |
| 対応外recipe／image／loader、入力closureの取得方法未成立 | producer unavailable。必須証拠未取得と読取しなかった範囲を明示し、completeを出さない |
| 取得不能な入力を含めcompletedと表明、必須ref欠落、循環・role不正、未知schema | reader schema_invalid／required_evidence_missing。信頼無効でも構造矛盾を拒否 |
| producerが記録したinput_changed／inventory_mismatch／storage_failed／budget_exceeded／build_failed／output_root_exists／output_root_invalid／output_root_not_empty | 合法なphase・証拠と一致すればproducer_failedとして保持し、診断候補にしない。未到達の後続receiptは要求しない |
| caller信頼無効、profile／recipe未承認、Task action未実行 | reader unavailable。入力読取0、producerStateを上書きしない |
| 既知profileを名乗る別digest、現在内容と成功表明が不一致、別binding・古いreceiptの交換、authority自己申告 | reader profile_mismatch／claim_mismatch／content_mismatch。graph拒否し、producer_failedや部分的な診断へ格下げしない |
| path逸脱・symlink・登録外entryをreaderが検出 | reader path_invalid／inventory_mismatch。producerのpath_invalidとは別の判定 |

bundleや状態objectの欠落は、readerから見た状態で分ける（§9.48）。

| 状態 | 分類と扱い |
| --- | --- |
| envelopeとbundleがともにない（index・状態objectを保存できなかったexport失敗を含む） | reader unavailable（owned_offer_envelope_missing）。producerStateを推測せず、入力を読まない |
| bundleを必須とするprofileで、envelopeだけがありbundleがない | reader required_evidence_missing。構造不正としてgraphを拒否する |
| bundleはあるがindex・failure／unavailable証拠の参照先がない | reader required_evidence_missing |
| bundleを必須としない現行test profile（§9.38〜9.46） | bundleの有無を判定へ使わない。§9.37の判定を維持する |

合法な未対応と、成功表明に必要な証拠の欠落を取り違えない。新しい理由がどのstageで合法かをschemaに固定し、未知reason・失敗後のsuccessを拒否する。failedの内容拒否をreaderが再確認する範囲は承認recipeに明記し、実参照や過去の実行artifactとの関係を静的readerが独立に再証明したと扱わない。

#### 9.47.7 回帰条件と次の公開API実証（未実装）

| ID | 条件 |
| --- | --- |
| BM01 | canonical JSONのobject順・配列順／重複・日本語／空白path・raw sourceのBOM／CRLFをcross-language vectorで確認。U+0000〜U+001F・U+007F・U+2028／U+2029・surrogate pairを含む文字列でJava／Node.jsのbytesが一致し、lone surrogateを両方で拒否する。別内容の正規化による同一視を拒否 |
| BM02 | completedの全ref、failed／unavailableの各completedThroughと次stageの正常unionを受理。prefix分の必須ref欠落、未到達の成功ref、null／空／全0 digestによる穴埋め、解決前のprofile／recipe digest、failure／unavailable refの混在を拒否。evidence indexは存在するobjectだけを参照し、未知field・循環・self digest・receiptを含む成果物inventoryも拒否 |
| BM03 | coreGraph変更、graph／export／context／execution／invocation交換と上位refの自己更新を、trusted callerの期待値から拒否 |
| BM04 | source追加／欠落／変更、seal後・最初の構築前の改変、事後hashへの再baseline化を拒否。構築後も元sealへ照合 |
| BM05 | implicit source探索、processor／pluginの自動検出、未登録generator・生成source・argfileを拒否。追加評価なしで取得不能な入力はno-readのunavailable |
| BM06 | 新規・空の専用driver output root→source集合→実compiler invocation→正常終了→同じrootの全outputを実証。既存の空root、class／resource／隠しfile／空子directory／symlink混入、作成後〜起動前の追加、root置換・入力rootとのaliasをcompiler呼出し0で拒否。内側classを含むbuild1の後、削除したsourceのbuild2を新rootへ構築して古いclassがないことと旧root不変を確認。旧root再使用・失敗後の部分output再利用・後付けresource・別構築output交換を拒否。consumer／IC再利用は独立に正常系を維持し、class単位source対応へ水増ししない |
| BM07 | JAR全entryとcompiler output／file／literal／generator stageの対応。余分なresource・欠落MANIFEST・未登録生成物、重複名・traversal・展開予算超過を拒否 |
| BM08 | javac／javaが同じでもJDK module／library／設定が異なるimageを拒否。未承認image/link policy・実image未照合はunavailableで停止 |
| BM09 | runtimeの追加／欠落／順序・重複変更、API／impl／compiler／stdlibのrole交換、service provider・loader policy不一致を拒否 |
| BM10 | CodeSourceだけを実行bytecodeの独立証明に昇格、未承認agent／transformer・parent loader入力、環境注入を拒否 |
| BM11 | library occurrenceの順序・重複・digestとsnapshot生成／save結果を実BTAで照合。別cohort・format・generator・parameter列の交換を拒否 |
| BM12 | 変更なしrepeatは新Handleと同じIC基準・source／snapshot／引数を使用。IC削除・改変・再初期化とsnapshot再baseline化を拒否 |
| BM13 | seal後・precheck／postcheck／capture前後・初回reader capture前の改変、保存bytes欠落／破損を拒否。履歴証拠で現入力を補わない |
| BM14 | 全rootのwrite前symlink拒否・read時symlink／path置換・未記録file・保存失敗・容量超過。大directoryで列挙上限＋1とartifact streaming上限を確認 |
| BM15 | 信頼無効・profile／recipe未承認・Task未実行でartifact／source reader・KGP getter読取0。保持された不正schemaはgate前に拒否 |
| BM16 | SKIPPED／FROM-CACHEの成功receiptを新しい構築・BTA実行へ数えない。fresh witness＋古いenvelope、偽のwitnessだけでは真正性を保証しない範囲も固定 |
| BM17 | prepare中の入力改変、buildのroot割当／空判定／compiler／packaging失敗、snapshot生成失敗、offer失敗、prepare前toolchain未対応・build後loader未対応の合法prefixを受理。未到達receiptは要求せず、部分classはfailure receiptだけに保持し実行不可。index／状態証拠の保存失敗で成功bundleを生成しない。failed→completed／unavailable、飛び越したstage・偽のcompletedThrough／failureStage／phase／理由、成功ref付替え、失敗後旧rootへの再試行と固定件数の水増しを拒否 |
| BM18 | controlと全承認observerを比較し、supplier評価・解決・transform・file I/Oを区別。manifest収集の追加評価、計測欠落、区間偽装を拒否 |
| BM19 | 未対応secret／host script評価・buildSrc等の不完全なclosureを、既知fileの一覧だけでcompleteにしない。policy別必須証拠欠落を拒否 |
| BM20 | 完全なmanifestを自然消費receipt・compilerWorkStatus=performed・declared_in補完・coverage改善へ変換することを拒否 |

実証は、(a) schema／canonical digest／状態別の静的contract、(b) 所有compiler recipeの構築と実class対応、(c) 実runtime／library／snapshot／offerのref閉包と鮮度、の順に進める。nativeはGroovy／Kotlin wrapper × Gradle 8.11.1／9.2.1を別tupleで実行し、採用条件・fixture hash・実artifact・拒否数・実compiler／BTA呼出し数を保存する。JavaCompile／既存buildの透過対応、承認imageやloader policyが未成立なら未成立として結果に残す。全observer・manifestが揃うまで本番profile承認・本番取込を有効化しない。


### 9.48 13af673レビュー修正・参照の向き・reader理由・欠落時の分類（2026-11-02）

§9.47の設計について、次の4点を文書だけで直した。実装・native実行・承認profileは0件のままである。

- offer envelopeとbundleの参照の向きを固定した。envelopeはbundleを参照せず、bundleの`offerReceiptRef`はenvelopeとは別のoffer receiptを指す。両者の対応は`ownedOfferBundles`のdigestの組で結ぶ。これで、bundle→offer receipt→envelope→bundleの循環hashを避ける。
- §9.37.5のreader integrity理由に`owned_offer_content_mismatch`を加えた。completedを再読取して内容が合わない場合（実装済み）と、producerが記録した拒否をreaderが確認できない場合（`claim_mismatch`）を分ける。
- envelopeとbundleの欠落、bundleだけの欠落、index参照先の欠落をreaderがどう分類するかを§9.47.6へ加えた。現行test profileではbundleを判定に使わない。
- canonical JSONのescape規則を具体化した。既存の`BtaOwnedDriver.json()`はこの規則を満たさず、collectorへ流用しないことを明記した。BM01へ制御文字・U+2028／U+2029・surrogateのvectorを加えた。

§9.47の記述が前提とする§9.46（取込み時のbounded reader）は62ca4f0でcommitした。

### 9.49 manifestの静的contract実装（2026-11-02）

§9.47末尾の実証(a)として、`src/test/fixtures/ownedManifestContract.mjs`へbundleのtyped union、canonical JSON、保存metadataの参照閉包検証を実装した。これはtest用の静的contractであり、本番adapter／readerを有効化しない。返却する`structure_verified`はこの層の構造検証結果であり、`diagnosticEligible=false`・`naturalContentBinding=false`を維持する。

#### 入出力とschema

`verifyManifest({coreGraph,bundle,envelope,entry,objects}, expected)`は、渡されたbytesのみを扱い、project fileの読取・Provider評価・compiler／BTA呼出しを行わない。entryは`{bundleDigest,envelopeDigest}`、objectsは`{objectDigest,bytes}[]`である。expectedには呼出側が独立保持するgraph／export／project／context／execution／invocation、profile／recipe ID・digest、coreGraphDigest、共有上流のbuildInvocationId、許可するlogical rootIdsを渡す。coreGraph自身の意味的妥当性と実行witnessの真正性はこのAPIの保証に含まれず、既存の上位検証の責任である。

bundleは§9.47.2の`osv-mcp.gradle-owned-manifest-bundle-v1`を使い、共通header・累積成功ref・failed／unavailable固有fieldを厳密に区別する。未知field、必須field欠落、未到達ref、未解決なのに付いたprofile／recipe digest、null／空／全0 digestを拒否する。approvedは独立したexpected digestへ一致させるだけで、追加信頼を有効にしない。

この段階の保存objectは`osv-mcp.gradle-owned-object-static-v1`で、schema／role／binding／refs／filesを共通必須とする。bindingはinvocationを除く共通IDであり、共有上流構築をofferごとの新規構築と数えない。roleごとの追加fieldと参照は次の通り固定する。

| role | 必須追加field・ref |
| --- | --- |
| input-manifest | buildInvocationId、非空のsource file列。上流object refなし |
| build-receipt | buildInvocationId、対応input-manifestへの単一ref |
| runtime-selection | buildInvocationId、対応build-receiptへの単一ref |
| generation-receipt | buildInvocationId、対応runtime-selectionへの単一ref |
| offer-receipt | invocation／envelopeDigest、対応generation-receiptへの単一ref |
| failure-receipt | invocation／stage／phase／reason／completedThrough、bundleと一致する成功prefixのref列 |
| unavailable-evidence | invocation／stage／reason／completedThrough、bundleと一致する成功prefixのref列。phaseは禁止 |
| evidence-index | 存在するprefix objectと状態objectのrefのみ。重複・自分自身・bundleへの参照は禁止 |

fileは`{rootId,path,size,sha256}`で、許可logical root、相対path、非負safe integer、非0 SHA-256を要求する。絶対path・drive path・backslash・空component・`.`／`..`・NUL、evidence／receipt／manifest rootを成果物として列挙することを拒否する。実rootの実体確認やsymlink拒否はこの静的検証では行わず、後続のbounded readerへ残す。

envelopeは本番形式とは別の`osv-mcp.gradle-owned-envelope-static-v1`で、共通ID・producerState・completedThrough・naturalContentBinding=falseのみを持つ。envelopeからbundleへの逆参照は認めず、completedのoffer receiptにあるenvelopeDigestとentryの組を照合する。既存offer envelopeや旧profileの契約は変更しない。この最小object schemaには§9.47.3の全入力role・構築output・artifact inventoryの実証をまだ含めない。将来それらのschemaと実証を加えるまで、この構造結果を「完全な入力manifest」や本番採用へ昇格させない。

#### canonical digest・閉包・拒否

Node側はduplicate keyを検出するJSON parserとcanonical encoderを分離した。UTF-8不正、lone surrogate、負数・小数・負0・unsafe integer、配列のhole、深さ超過を拒否する。object keyを辞書順に並べ、配列の順序・重複、文字列のUnicode・空白・percent・BOM／CRLFを保持する。保存objectはcanonical bytesそのものを要求し、refのrole・byteLength・SHA-256を照合する。

参照探索は状態別に必要な全objectがindexに収録されることを要求し、未収録・余分なobject、role違反、重複index、循環を拒否する。循環検査は未検証の自己申告digestを信じる前に行い、その後で各保存objectの実bytesを再hashする。上限は1 object 1MiB・object総量8MiB・128 objects・4096 ref探索・JSON深さ32・100000 nodesである。

失敗phase／理由も任意文字列にしない。prepareのcapture／seal、buildのallocate-output／verify-empty／compiler／packaging、runtime-selectionのselect、snapshot-generationのgenerate、offerのbinding／precheck／call／postcheck／captureと、実装の`failureCases`に固定した理由の組だけを認める。unavailableはprepareのtoolchain_unsupported／profile_unapproved／recipe_unsupported、buildのbuild_unsupported、runtime-selectionのloader_unsupported、snapshot-generationのgenerator_unsupported、offerのconsumer_unsupportedに限定する。この表は静的fixtureの初期語彙であり、既存native producerの理由全件を新形式へ移行したという意味ではない。

構造不正は`owned_manifest_schema_invalid`、循環はcycle、欠落はrequired_evidence_missing、独立expectedとの不一致はbinding_mismatch、保存bytes／digest不一致はcontent_mismatch、状態receiptとbundleの主張矛盾はclaim_mismatchとして拒否する。envelopeとbundleが両方ない場合だけはowned_offer_envelope_missingのunavailableを返す。ここでの理由は静的contract用で、本番readerのproducer_failed／producer_unavailableや信頼gateの代替にはしない。

#### 回帰テスト・再現・判定

`src/test/gradle/ownedManifest.test.ts`にBM01・BM02・BM03・BM17の104テストを追加した。正常prefixと失敗phaseの組、必須／禁止ref、空・偽ref、index／状態object欠落、未知field、循環、file path、親refも更新したcontext・build・envelope交換と状態claim改変を確認する。BM17の構築失敗は合法な静的metadataを表すfixtureであり、実compilerの失敗・root新規作成・保存失敗・再試行を今回新しくnative実証したものではない。

`src/test/manual/gradleOwnedManifestResults.mjs`をNodeで実行すると、固定hashのJDK 21.0.13で独立した`ManifestCanonicalProbe.java`を構築し、Nodeとの12 vector（正常6・拒否6）のbytes一致を確認する。制御文字全域、DEL、U+2028／U+2029、surrogate pair、lone surrogate、BOM／CRLF、数値境界を含み、既存`BtaOwnedDriver.json()`は使用しない。probeはJSON parserの共用による循環した検証を避けるため、型付きbinary vectorから独立にJSONを生成する。duplicate JSON keyの拒否はNode parserの回帰で確認する。

[検証データ](validation/gradle-owned-manifest-contract-2026-11-02.json)には実JDK／javac・probe class・sourceのhash、12 vectorと36行の正常union／失敗phase検証結果を保存した。再生テストで現在sourceのhashと結果を照合する。Gradle／Kotlin DSLのnative matrix、実driver構築、BTA呼出しは今回0。単独canonical probeのjavac／java各1回をdriver構築やBTAの実行件数へ加えない。

型検査・build・全体テストの結果はDESIGN_TODOへ記録する。次は実証(b)の所有compiler recipe、source→新規output→実行artifactの対応と、実証(c)の実runtime／library／snapshot／offerの入力閉包・鮮度である。toolchain image、loader／executorの独立承認、全observer、自然消費receipt、本番採用は未成立を維持する。

#### 451b629レビュー修正（2026-11-02）

静的contractをすり抜ける3種の入力を直した。Gradle・BTA・ダウンロードは0で、canonical oracleのjavac／javaを各1回だけ再実行した。

- 承認状態とunavailable理由を対応させた。approvalStatus=unavailable（profile未解決）はprepareの`profile_unapproved`だけを許し、解決済み（approved）では`profile_unapproved`を禁止する。修正前は、approvedのまま`profile_unapproved`を名乗るbundleや、未解決のまま`toolchain_unsupported`を名乗るbundleを受理していた。
- object field名を、空でない印字可能ASCII（U+0020〜U+007E）に限った。修正前はASCII以外のkeyを受理してUTF-16順に並べていた。Java oracleもUTF-16順のため一致していたが、code point順で並べる実装とは結果が変わる。encoder・parser・Java oracleの三者で同じ拒否を行い、vectorを4件追加した（拒否3、ASCII順の正常1）。
- bundle・envelope・coreGraphにも、保存objectと同じくcanonical bytesそのものを要求する。修正前は`123.0`・`1e0`・余分な空白・key順の変更を、parse後のdigestが同じなら受理していた。非canonicalな入力は`owned_manifest_content_mismatch`で拒否する。
- 再生テストで、記録のjava／javac hashを固定JDK profileへ照合する。記録へ`recordedAt`／`baselineRevision`を加え、schemaをv2とした。v1は451b629のcommit済み原本として要約を`preReviews`へ残した。

静的テストは104件から126件になった。修正前のcontractでは126件中19件が失敗することを先に確認した。Java／Nodeのcanonical比較は16 vectorで一致した。structure_verifiedの意味と、本番採用・自然消費receipt0は変わらない。

### 9.50 所有javac recipeの構築manifest・新規output・実行artifactの限定実証（2026-11-02）

§9.47の実証(b)として、閉じたjavac recipeを所有するtest用executorと、構築入力／output-set／JAR／構築receiptのtyped contractを追加した。source集合から新規outputを作り、全classを新規JARへ収録して、そのJARから`Driver`と`Driver.Inner`を実際にロード・実行した。Groovy／Kotlinのwrapper × Gradle 8.11.1／9.2.1で同じ条件を確認した。

#### recipeと構築manifest

`ownedJavacExpected.mjs`の`owned-javac-closed-v1`を初期recipeとする。実行は`ownedJavacProducer.mjs`が所有し、GradleのTask actionはJDK公開APIのProcessBuilderでこのexecutorを起動する。Kotlin wrapperも既存の実証と同様に共通Groovy scriptをapplyする。Kotlin sourceをjavacへ渡す実証や、KGP taskの入力を透過的に採取する方式ではない。

compilerは固定hashのJDK 21.0.13の`bin/javac`を、具体的な引数列・cwd・明示envで起動する。sourceはUTF-8、`--release 21`、`-proc:none`・`-implicit:none`・`-g:none`を固定し、classpath／sourcepathを所有する空directoryへ限定する。modulepath・processor・generator・resource・argfileの追加は初期recipeで認めない。compiler／Java childのenvはLANG=C・LC_ALL=C・TZ=UTCのみにし、親のCLASSPATH・JAVA_TOOL_OPTIONS等を継承しない。

新しい`osv-mcp.gradle-owned-javac-input-v1`は、buildInvocationId、独立したrecipeDigest、source directory全inventory（directory名・file名・raw bytes・size・SHA-256）、明示env・引数列、空入力の列、java／javac hash、executor source群とNode executable／versionの情報を持つ。日本語／空白pathは配列要素の値として保存し、ASCII以外のobject keyへ変換しない。source順とoutput inventoryは別に保持し、compilerへ渡したsource集合からoutput集合への対応を表す。class単位のsource帰属をSourceFile属性から推定しない。

構築時の型は§9.49の最小stage objectとは別のtest schemaである。input manifest・output-set・build receipt・evidence indexをcanonical digestで結び、output-setはbuildInvocationId・専用rootのrun内実体token・全inventoryへ対応させる。caseの`buildState=completed`はこの所有Java構築の完了だけを意味し、offerのproducerState=completedや、本番bundleの全stage完了を意味しない。旧static-v1の全stage objectを実BTAへ移行したものでもない。

#### seal・空root・outputとartifact

source capture後に入力manifestを別evidence rootへCREATE_NEWで保存し、compiler前と正常終了後の現在inventoryを、最初のsealへ比較する。差分を新しいbaselineへ置き換えない。seal後のsource変更・追加・欠落はcompiler呼出し前に、終了後の変更はpackaging前に拒否する。未登録sourceの混入もcapture時に拒否する。

outputは承認したworkspace内のoutput parentへbuildInvocationIdごとに新規作成する。既存の空directory・file・symlinkも再使用しない。ancestor symlink・source rootとのaliasを割当前に拒否し、作成直後とcompiler直前に同じroot実体とdirect entry数0を確認する。直前検査は最初の1 entryで拒否し、class／resource／隠しfile／空directory／symlinkの混入時にはcompilerを呼ばない。root置換も同様に拒否する。

正常終了後の同じrootから、内側classを含む全inventoryを取得する。初回は`Driver`・`Driver$Inner`・`Driver$Removed`と`Retired`・`Retired$Nested`を構築する。次の構築で`Retired.java`を実際に削除し、DriverからRemovedの宣言も除去する。新規outputとJARはDriver／Innerだけになり、元outputの全bytesは不変である。削除sourceのdigestと前回source cohortも照合する。

JARは所有packagerが新規fileへCREATE_NEWで作る。classはoutput-set ref、META-INF/MANIFEST.MFはrecipeに固定したCRLF literalへ結び、全entryとoriginを照合する。JAR全体のraw SHA-256を主identityとし、entry inventoryは代用にしない。readerは抽出せずにlocal／central header・CRC・名前・順序・内容を照合し、未知resource、MANIFEST欠落／別literal、重複名、traversal、file／directory衝突、展開予算超過を拒否する。予算対照は実際に圧縮した大きなentryを用い、展開前のsize上限で止める。

`java -cp <artifact> Driver <artifact>`の直前と直後に同じJARのraw digestを照合する。mainはouter／inner両classのCodeSourceが引数のJAR URIと一致することを確認し、内側classのmethodを実行する。構築receiptはsource seal・output-set・JAR digest・正常compiler終了・限定Java main実行scopeを結ぶ。これは所有executorの実行表明であり、CodeSourceをロード済みbytecodeの独立証明へ昇格させない。

#### failed prefix・部分output・保存失敗

2 sourceのうちGood.javaは正常、Broken.javaは未解決methodを含む負例で、実javacがGood.classを生成して非0終了することを確認した。この部分outputはfailureの診断inventoryだけに残し、packaging・Java実行・成功receiptを禁止する。同じrootでの再試行は、旧rootの内容を変えずcompiler呼出し0で拒否する。別のbuildInvocationId・新規rootでの正常再試行も検証し、Good.classを混在させない。

失敗phaseまでのcompiler記録・空root検査・元sealとの比較・output inventory等を必須にし、終端の理由だけを残して到達済み証拠を削る改変を拒否する。理由／phase／buildStateはcase別の独立した期待表へ照合する。実CREATE_NEWのpackaging保存失敗では既存artifactが不変であることを確認する。index／状態保存先をdirectoryにして実保存を失敗させる対照では、exported=falseとし成功receipt・indexを公開しない。この2 caseは保存前にJava mainを実行済みなので、実行件数から除外しない。

#### 検証結果と再現

[検証データ](validation/gradle-owned-javac-construction-2026-11-02.json)は、4 tuple・各39 case（合計156）、実javac呼出し76回、JARからのJava main実行20回、正常構築12件、拒否144件を保持する。今回のBTA呼出し・自然消費receipt・本番採用は全て0である。件数は保存された各caseを検証してから計算する。開発中の中間試行をこの最終matrixの件数へ混ぜない。

BM04〜BM07・BM17について、`javacBuild.integration.test.ts`は両DSLで各版78テスト、`javacBuild.test.ts`は210テストで現在source hash・実API artifact・JDK pins・Task実行witness・native証拠を再生する。改変対照には自己hashも更新したsource／recipe／output交換、時刻付替え、未知field、失敗後success、部分outputの実行表明、成功証拠欠落、JAR entryの出自変更、保存失敗のexport成功化、件数水増しを含む。

再現時はJDK 21.0.13とGradle cacheを用意し、各版について次を実行する。公開recordへ絶対pathは保存しない。

```bash
env JAVA_HOME=<jdk-home> GRADLE_USER_HOME=<gradle-cache> \
  OSV_MCP_TEST_GRADLE=<gradle-8.11.1-or-9.2.1>/bin/gradle \
  OSV_MCP_JAVAC_OUTPUT=/private/tmp/owned-javac-<version>.json \
  npx vitest run src/test/gradle/javacBuild.integration.test.ts --maxWorkers=1
node src/test/manual/gradleOwnedJavacResults.mjs /private/tmp/owned-javac \
  docs/validation/gradle-owned-javac-construction-2026-11-02.json
```

#### 採用判定と残る範囲

閉じたrecipeでのsource seal→fresh output→JAR→限定Java mainの対応は実証できた。一方、JDK／Nodeのimage全体の独立承認、loader／transformerの完全な証拠、host scriptの評価bytes、任意の同時writer排除は未成立である。現在内容のhash・run内token・callerが保持したTask witnessを、過去の実行の独立認証として扱わない。

Node executorは具体的なsource／引数／保存bytesだけを扱い、Gradle Provider／FileCollection／KGP getterを追加評価しない。ただし全observerのsupplier・resolution・transform・file I/Oを計測した実証ではない。実BTA runtime／library／snapshot／offerのmanifest閉包・鮮度、信頼無効／profile未承認時の本番no-read gate、既存buildへの透過対応は次段階へ残す。本番profile承認や取込を有効化せず、declared_in・coverage・compilerWorkStatusへ昇格させない。

#### cd2b982レビュー修正（2026-11-02）

構築を担う所有executor（Node）の起動環境、inventoryの並び順、記録した診断の3点を直し、両DSL・Gradle 8.11.1／9.2.1のnativeを再実行した。BTA呼出し・ダウンロードは0である。

- Gradle recipeはexecutorの環境変数を全て消し、`TZ=UTC`だけを渡して`node -- producer`で起動する。修正前は`NODE_OPTIONS`（`--require`等）を含むGradleの環境をexecutorがそのまま受け継いでいた。javac／javaの子processは修正前から固定環境である。nativeハーネスは毎回`NODE_OPTIONS`でpreload scriptを渡し、それがexecutorで実行されない（marker fileが作られない）ことを記録・検証する。
- executorの実環境は、固定値（`TZ`）の値と、それ以外の変数の名前だけを記録する。macOSは空環境で起動しても`__CF_USER_TEXT_ENCODING`（値にuser IDを含む）を加えるため、darwinに限りこの名前だけを許可し、値は記録しない。`execArgv`は空であることを要求する。
- source／output inventoryを、ICUのcollationに依存する`localeCompare`ではなくUTF-16 code unit順に並べ、verifierでもその順序を必須にした。並べた配列は入力manifest・output set・receiptのdigestへ入るため、Node／ICUの版で順序が変わるとdigestが変わりうる。
- 記録するjavac／javaの出力で、長いpathから先に`<artifact>`／`<output>`／`<case>`／`<workspace>`へ置き換える。修正前はrootを先に置換していたため、内側の3 tokenが一度も現れなかった。javacに`-J-Dstdout.encoding=UTF-8`／`-J-Dstderr.encoding=UTF-8`を渡し、LANG=Cのままでも日本語pathの診断を`???`へ失わずに記録する。
- 記録の重複（各caseのsource・class・JARの全bytes）の縮小は見送った。

記録はproof-v2とし、`baselineRevision`を加えた。v1はcd2b982のcommit済み原本として要約を`preReviews`へ残した。件数は変わらない（156 case、javac 76回、artifact実行20回、completed 12／refused 144、BTA 0）。静的テストは216件から217件になり、修正前の実装と記録では8件が失敗することを先に確認した。executor binaryのhashは引き続きexecutor自身の自己申告であり、Node imageの承認は未成立である。

### 9.51 所有javac driverと実BTAのmanifest接続・鮮度の限定実証（2026-11-02）

§9.47の実証(c)として、所有javacで構築したJARを実BTA runtimeへ接続し、source→fresh output→driver artifact→runtime→library cohort→snapshot generation→configuration／parameter→offerの対応を保存した。Groovy／Kotlin wrapper × Gradle 8.11.1／9.2.1で実行したtest-onlyの実証である。本番adapter・scan系toolへの取込は有効にしない。

#### 構築からruntimeへの対応

`OwnedBtaManifestDriver.java`を所有executor `ownedBtaManifestProducer.mjs`が直接javacで構築する。§9.50の空classpath recipeとは別に、`gradleBtaDriverRuntime.mjs`の閉じたtest profile（Kotlin 2.0.20／2.2.20）へ一致する非空classpathを明示する。profileの全JARをprivate runtime rootへコピーし、coordinate・raw SHA-256・size・occurrence・pathを保持する。stdlibの同一artifactを末尾にもう一度入れ、重複を消さないことも確認する。

sourceのraw bytes、具体的なjavac引数・固定env、java／javac hash、executor source群を入力manifestへsealする。output rootは新規作成し、作成直後とcompiler直前に空と同じ実体tokenを確認する。終了後の入力を元sealへ照合し、内側Binding classを含む全classを新規JARへ収録する。MANIFESTは固定literal、class entryはoutput-setへ結ぶ。build receiptはinput／output／JARのdigestを持つ。Node自体はGradleのProcessBuilderで環境を消しTZ=UTCだけを渡して起動し、Node optionsを継承しない。javac／java childのenvはLANG=C・LC_ALL=C・TZ=UTCに限定する。

Java childのclasspathはdriver JARを先頭に、manifestと同じruntime occurrence列を渡す。childは実`java.class.path`を照合し、driver・BTA API・implementation・Kotlin compilerのCodeSourceと現在のraw JAR hashを記録する。runtime順序変更・重複削除・private runtime JAR改変・driver JAR改変の4件は、childを起動せず拒否する。実行後もdriver／runtime／sourceを元sealへ照合する。原本のGradle cacheは変更しない。

#### library・snapshot・configuration／parameter

実BTAで旧libraryと現在libraryを各1回構築する。source集合・BTA引数・configuration・正常終了・全outputを保存し、新規library JARの全entryをcompiler outputへ対応付ける。未知resourceを自己申告で許すpolicyは設けない。library JARのraw digestをprimary identityとする。

cohortは`library, stdlib, library`の3 occurrenceである。各library入力のdigestを保持したまま、実`calculateClasspathSnapshot(..., CLASS_MEMBER_LEVEL)`と`saveSnapshot`で3 snapshotを生成する。旧／現在で計6回であり、同じartifactの重複も独立したoccurrenceとsave先として保持する。generation receiptはsource・library output／JAR・cohort digest・各snapshotのsize／digest・generatorの実artifact・format／granularity・上流driver build receiptを結ぶ。旧libraryと現在libraryのJARおよびlibrary snapshotのdigestが異なることを確認する。

offerは私有stagingと保存evidenceへsnapshotをコピーし、元generation receiptを変更しない。public BTA APIで作成したconfigurationとparameterを実参照で登録し、成功した`useIncrementalCompilation`のreceiver・parameter・snapshot path列・SourcesChangesを保存する。呼出し直前には、登録済みconfiguration／binding／parameter、service所有project、source hash、引数、generation、cohortの対応を検査する。JSONのID文字列だけでは呼出しを認可しない。

正常offerは実`compileJvm`へ渡し、consumer class等の出力を確認する。変更なしrepeatでは同じsource・引数・snapshot path・IC基準を使い、configuration／parameter／bindingは新しく作る。ICの前回成功後inventoryとrepeat前inventoryを照合する。内部no-opの判別は行わず、成功してもexecutionEvidence=bta-call-only・compilerWorkStatus=unknownを維持する。

#### 鮮度確認と拒否範囲

全19 offer caseを次の独立した期待表へ照合する。失敗理由をproducerの自己申告だけから期待値へ採用しない。

| 検証 | 結果 |
| --- | --- |
| 正常offer・変更なしrepeat | 実BTA正常終了、offered-inputs-only |
| staging改変・snapshot交換・旧snapshot bytesの流用 | snapshot_stale、consumer呼出し前に拒否 |
| 保存evidence改変 | snapshot_storage_mismatch、consumer呼出し前に拒否 |
| generation receipt交換 | generation_binding_mismatch |
| library JAR改変 | library_stale。拒否時の破損bytesも別fileへ保存してreaderが照合 |
| cohortの順序変更・重複削除 | cohort_binding_mismatch |
| default／別登録configuration | configuration_unregistered／configuration_binding_mismatch |
| 別parameter・parameterへのsnapshot順序変更 | parameter_binding_mismatch |
| project・引数交換 | context_binding_mismatch |
| 登録後のconsumer source変更 | source_stale |
| BTA戻り後のsnapshot改変 | postflightでsnapshot_stale。実BTA呼出しは件数へ含める |
| postflight後・capture前の改変 | captureでsnapshot_stale。過去の成功で補わない |

保存evidence→staging→libraryの内容をpreflight／postflight／captureで元generationへ照合する。Java child終了後、Node readerも各caseの保存snapshot・staging・consumer sourceを実際に再読取し、最後に観測された状態へ一致させる。元generationのsource・library JAR・全output・snapshotも最初のreader captureで再照合する。library改変の対照だけは共用libraryを次case用に復元するため、拒否時に保存した破損fileで過去の拒否を確認し、現在の復元済みlibraryをstaleと判定しない。

#### proof bundle・保存証拠

`owned-bta-proof-bundle-v1`はこの実証専用の参照DAGである。canonical bytesの各objectへrole／objectDigest／byteLengthを付け、input manifest・output-set・build receipt・runtime selection・2 generation receipt・19 offer／failure receiptを結ぶ。indexは既存objectだけを列挙し、自身・上位bundleへ逆参照しない。header自身のdigestも別fieldに置く。readerは独立に検証したnative証拠から期待するDAGを照合し、追加／欠落・role交換・循環や自己参照への変更を拒否する。

このschemaは本番`osv-mcp.gradle-owned-manifest-bundle-v1`への採用ではなく、構築・runtime・generation・offerの閉包を検証するtest用表現である。graphのcoreGraphDigest／追加信頼／profile承認／envelopeとの組を含む本番取込の契約は後続に残す。offer／failure receiptのproducerStateは今回の限定executor内の結果であり、scanのcoverage・declared_inへ変換しない。

[検証データ](validation/gradle-owned-bta-manifest-2026-11-02.json)へ、実JDK／Gradle API・executor／fixtureのhash、source／class／JAR bytes、runtime occurrence、generationとbinding・全観測、proof bundleを保存する。collectorは保存native証拠を検証してから件数を算出する。公開recordに絶対pathや秘密environment値は入れない。

#### 検証結果・再現

最終4 buildでjavac 4回・driver Java child 4回、実BTA compileJvm 24回（library 8・consumer 16）、snapshot生成24回を確認した。offerは76件でcompleted 8／failed 68、runtime起動前拒否16を加えた拒否は84件である。BTA後の失敗8件も実consumer呼出し16回へ含める。自然消費receipt・本番採用は0を維持する。開発中の中間実行はこの最終matrixへ加算しない。

`btaManifest.integration.test.ts`は各版48テスト（各DSL24）、`btaManifest.test.ts`は133テストで記録を再生し、source／runtime／generation／binding・到達済み証拠の欠落、最初のreader観測の差分、参照交換、偽の成功化、件数水増しを拒否する。再現は既存JDK／runtime cacheを使い、各版について以下を実行する。

```bash
env JAVA_HOME=<jdk-home> GRADLE_USER_HOME=<gradle-cache> \
  OSV_MCP_TEST_GRADLE=<gradle-8.11.1-or-9.2.1>/bin/gradle \
  OSV_MCP_BTA_MANIFEST_OUTPUT=/private/tmp/owned-bta-manifest-<version>.json \
  npx vitest run src/test/gradle/btaManifest.integration.test.ts --maxWorkers=1
node src/test/manual/gradleOwnedBtaManifestResults.mjs /private/tmp/owned-bta-manifest \
  docs/validation/gradle-owned-bta-manifest-2026-11-02.json
```

#### 採用判定

所有recipeでsourceから実BTA入力までのmanifest対応と、限定caseでの鮮度確認・拒否を実証した。保証の根拠は承認候補executorの表明とcallerの実行witnessであり、公開recordの再生だけで過去の実行・ロード済みbytesを独立認証したとは扱わない。JDK／Node image全体、loader／transformer、host script評価bytes、任意の同時writer排除、全observerの追加評価計測は未成立である。

KGP所有getterやGradle Provider／FileCollectionを追加評価しない所有driver方式を維持するが、既存KGPの自然消費bytes receiptや透過取得が成立したという結果ではない。次はtoolchain／loader／executorの追加信頼・profile・読取前gateと、このproof manifestから本番adapter／静的取込へ渡す採用条件の具体化である。現時点で本番profile承認・scan系toolでの診断採用・coverage／declared_in補完を有効にしない。
