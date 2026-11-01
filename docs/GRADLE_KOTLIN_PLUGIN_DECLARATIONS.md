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
| KP33 | matrix内の依存Provider／Actionの旧対照を維持。独立したpublic FileCollection supplier対照は両版とも追加評価を検出し、recipe非干渉は不成立。snapshot内部supplierすべてのtraceは観測していない |
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

集約ハーネスは正常16観測と両版のsupplier結果の存在、観測collector／verifierのsource hash一致を確認し、旧候補と新契約の不採用を別々に記録する。sourceを変更した場合は元観測を再取得する。次工程は、supplierを追加評価しない取得契約の再設計・実証とplugins-block用公開recipeの検討。そのレビュー前に本番v4／v6を有効化しない。


### 9.13 公開API実証レビュー2件の修正・再検証（2026-11-01）

#### 期待entryの欠落

package検証は、コピー後の出力に存在するfileだけを起点にしない。baselineの`src/main/resources`、生成descriptor、compile出力から期待entryを組み立て、対応するprocessResources出力・Jar入力・JAR entryを照合する。MANIFESTは事前固定literalの必須entryとして、ちょうど一つ存在することも検査する。期待したresourceがコピーされず、出力・Jar入力・entryがすべて欠けた場合も`kotlin_package_origin_incomplete`になる。実際のコピー出力だけを減らして期待集合も縮めることはできない。

静的対照では、修正前にMANIFEST欠落と、通常resource／services／descriptorの未コピーを再現して失敗を確認し、修正後に拒否を確認した。native matrixでは正常な実観測を複製してMANIFEST・resource・services・descriptor・`.kotlin_module`・classを個別に欠落させる。resource系はbaseline／生成descriptorを残し、コピー出力・Jar入力・entryを同時に削る。各対照の拒否理由を`pipeline.expectedEntryRejections`へ保存する。非classを実diskで欠落させる各stageのnative対照まで追加したものではなく、公開API実観測に基づくinventory対照である。

#### supplier観測の実行版・source hash・trace

独立supplierハーネスは、実際にprecompiled pluginを適用するGroovy／Kotlin consumerと、included `build-logic` producerを作る。各consumerでcontrol／observerを実行し、信頼された呼出し側が各runの前にproducer出力を明示的に削除する。

- 実行前にharness・collector・共有verifier・型宣言のsource hashと、consumer／producerの物理入力hashを固定し、run前後にも照合する。
- Gradle collector自身が実`gradle.gradleVersion`、consumer DSL、run UUID、observe設定、collector hash、実fixture fileのhash、traceを観測時に保存する。run UUIDを照合し、前回のreportを流用しない。
- `osv-mcp.kotlin-supplier-proof-v2`に観測を保持し、両DSLを持つ`osv-mcp.kotlin-supplier-matrix-v2`へまとめる。単なる出力ファイル名から版を付け直さない。
- native実行と集約ハーネスは同じ`verifySupplierProof`／`verifySupplierMatrix`を使う。実版・起動mode・source hash・fixture hash・runの一意性と、compile前後の厳密なtraceを照合する。
- controlの3評価とobserverの4評価、compile前からcompile終了まで同じprefix、compile後の追加1評価を要求する。任意の異なるtrace、phase欠落・重複、compile中の追加評価、旧report、別版、古いsource hashは拒否する。集約時の現在hashを過去のsupplier結果へ書き込んで鮮度確認済みにしない。

これらは信頼された検証runnerの来歴・再現性の確認であり、署名された実行証明ではない。sourceや実行bytecodeの一時変更・復元、KGP内部supplierすべてのtraceは独立観測できない。compile-classpathのgetter追加評価は引き続き契約不成立で、全構成の新pipeline採用は0件。9.2.1 precompiledのplugins-block用公開recipe不足も維持する。mappingは§9.12の限定したassertion specimenのままで、本番v4 parser・raw digest／context併合の実装へ範囲を広げない。

#### 再現と検証データ

§9.12のnativeコマンドを各版で再実行する。supplier出力は同一版の両DSLの結果を一つのファイルへ保存するため、`-t`で片方だけ実行したreportを正常matrixとして集約しない。集約は旧reportや不足したDSLを拒否し、source hashが変わった場合は観測を再取得する。

```sh
npx vitest run src/test/gradle/kotlinPipeline.test.ts src/test/gradle/kotlinSupplierProof.test.ts
```

[検証JSON](validation/gradle-kotlin-pipeline-2026-11-01.json)の主観測は修正後のsource hashへ更新する。`preReview`は初回のsource hash・観測件数・元JSONのhashを保持する要約で、初回supplier結果に実行時の版／source hashの結び付けがなかったことも明記する。


#### 修正後の実行結果

| 検証 | 結果 |
| --- | --- |
| Gradle 8.11.1 matrix（両consumer DSL・両producer・両Kotlin形式） | 332件成功、終了処理も成功 |
| Gradle 9.2.1 matrix（同上） | 332件成功、終了処理も成功 |
| supplier観測（各版のGroovy／Kotlin consumer） | 各版2件成功。4組ともcontrol 3回／observer 4回 |
| 期待entry欠落の保存結果 | 正常16観測×6種類、計96対照を拒否 |

8.11.1の初回再検証は機能検査332件が通過したが、終了時のfixture削除が既定の10秒を超えてsuiteは失敗した。`--hookTimeout=120000`で単独再実行し、終了処理を含めた332件成功を確認した。失敗した実行を成功件数へ二重計上しない。更新した主観測の8.11.1データはこの単独再実行の結果である。

静的なpackage／supplier／集約回帰は計56件、通常全体は1,850件成功・native opt-in等1,073件skip。型チェック・buildも成功。本番adapter・reader・schema・信頼設定の変更はなく、採用0件の判定を維持する。
