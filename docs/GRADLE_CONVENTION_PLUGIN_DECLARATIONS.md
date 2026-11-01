# Gradle convention plugin由来のdeclared_in: 設計

設計日: 2026-10-31。対象基準はa9cd1fd（C1a／C1b、local catalog alias／bundle・ProviderConvertible対応）。本書は未実装・未実証の拡張設計であり、既存のconvention-plugin拒否を解除しない。以下のAPI名・schema番号・環境設定・reasonは提案値。公開API実証を先に行い、陽性条件を満たせない形は未対応として残す。

## 1. 対象と宣言元の意味

物理declared_inは依存を追加したソース。consumerのplugins block、plugin marker、plugin JAR、catalog TOML、生成adapterクラスへ置き換えない。

| 形 | 初期候補となるdeclared_in | 採用範囲 |
| --- | --- | --- |
| buildSrcのprecompiled script plugin | buildSrc/src/main/kotlin/*.gradle.ktsまたはgroovy/*.gradle | 入力捕捉・生成／compile／実行の対応を実証した経路のみ |
| buildSrcのbinary plugin | 実際に追加処理を持つ.kt／.java／.groovy | 実装クラスと呼び出したローカルhelperの全対応を確認した経路のみ |
| リポジトリ内の独立build-logicをincludeBuildで利用 | build-logic配下の同種ソース | producer buildを別identityで登録。mainのproject IDへ混ぜない |
| 独立pluginリポジトリをローカルcheckoutして利用 | scan boundary内に準備したcheckoutのソース | 同じexport invocationでそのcheckoutから構築・使用する経路に限る |
| Maven／Plugin Portal／ローカルMavenへ別途発行済みのbinary plugin | 初期は省略 | 同じ版のsource JAR・Git tag・checkoutだけでは実行artifactとの対応にならない |
| 境界外のcheckout、runtime生成ソース、settings plugin | 初期は省略 | 別の早期捕捉／境界／生成物対応の実証が必要 |

独立pluginを考慮するが、外部配布pluginの任意source取得まで初期対応へ含めない。source JARの自動download・展開、Gradle cacheからの探索、consumerを含まないproducerのGAV推定は行わない。境界内のローカルcheckoutへ切り替える場合も、別途ビルドしたJARの使い回しでは陽性化しない。

plugin AがBへ委譲しBが依存を選択して追加するならBの物理実装を登録する。callerが具体依存を渡すだけの共通登録helperならcallerを登録する。後述source mapにこの責任を明示し、stack trace・line number・クラス名の文字列推測で決めない。初期は行番号を返さない。

## 2. 公開APIで観測できることと実証の問い

- [PluginContainer](https://docs.gradle.org/current/javadoc/org/gradle/api/plugins/PluginContainer.html)は適用済みPlugin実体を扱い、findPlugin／withIdで指定pluginを照合できる。ただしwithIdの通知をapply処理の入口・全追加試行の観測と見なさない。記録開始はplugin自身の明示helper呼出しで行う。
- [Gradle.beforeSettings](https://docs.gradle.org/current/javadoc/org/gradle/api/invocation/Gradle.html)はsettings評価前のcallback。mainのbeforeSettingsだけでbuildSrc・全included buildの初期化より必ず先になるとは未実証。root実行前の準備と各buildのcallbackの順を実測する。
- [IncludedBuild](https://docs.gradle.org/current/javadoc/org/gradle/api/initialization/IncludedBuild.html)は名前・projectDir・task参照を公開するが、実行classと元ソースの完全な対応表を返すAPIではない。build名をidentityにしたり、task参照をcompile実施の証明にしたりしない。
- [TaskState](https://docs.gradle.org/current/javadoc/org/gradle/api/tasks/TaskState.html)は終了後の実行状態を表す。didWork、SUCCESS表示、task名、--rerun-tasks単独をソース由来の証明にしない。compile／生成／packagingの実施と各入力・出力・loaded originを結ぶ必要がある。
- Javaの公開class／ProtectionDomain／CodeSource情報はloaded origin候補を照合する補助に限る。resource URL、Gradleの装飾class、instrumented cache、親classloader、委譲先の情報を同一視しない。private reflection・内部build operation・内部classloader APIに依存しない。公開APIだけで対応を確認できなければその経路は未対応。

上記リンクは現行ドキュメントでAPIの目的を確認した参考資料。対象8.11.1／9.2.1の利用可否・通知順序は別途実行して確認する。特にGradleによるclass変換とbuildSrc出力のロード形態は設計時点で未確認。

## 3. 信頼契約と責任分離

既存registered-helper-v1とcatalog信頼の意味は変更しない。追加案はOSV_MCP_GRADLE_PLUGIN_TRUST=local-plugin-build-v1。起動時固定、未設定・空は無効、未知値は警告＋無効。plugin宣言元の採用にはhelper信頼と追加plugin信頼の両方を必要とし、catalog契約があればcatalog信頼も必要。

| 主体 | 責任／検証可能な内容 |
| --- | --- |
| build作者 | 全寄与plugin・source・構築入力・helper経由追加の完全性、取得したclassが登録対象を実行すること、追加後不変を表明 |
| 信頼済み準備／producer adapter | 評価前baseline、同一invocationのbuild記録、出力inventory、plugin identityとsource handleを生成し、観測欠落を不完全とする |
| consumer側登録adapter | 実際の対象project／configuration・試行・元Action・保持実体を記録し、producer情報と照合する |
| MCP reader | 境界・現在bytes・hash・参照・build／scope／record被覆・互換性を再計算。Gradle・compiler・plugin・ネットワークsource取得を実行しない |

SHA-256やinvocation IDは対応・鮮度の確認用で、署名や作者の正しさの独立証明ではない。compilerが忠実であること、列挙外の入力や委譲実装がないこと、登録した物理sourceが追加箇所であることは作者表明を含む。receipt JSON単独、artifactとsourceのhashが両方存在することだけで「ソースとバイナリの意味的同一性を証明済み」としない。

必須の表明案はall-plugin-build-inputs-listed、all-contributing-plugin-additions-use-helper、source-artifact-mapping-reviewed、immutable-during-export。既存Providerのstable-during-export、scopeのall-contributing-additions-use-helper、immutable-after-addを代替しない。

追加limitations案: plugin_build_inputs_author_attested、plugin_source_mapping_author_attested、plugin_compiler_and_loader_trusted、plugin_input_transient_changes_not_detectable。既存helper／Provider／catalogのlimitsも条件に応じて維持する。観測したloaded originが確定不能なケースを、limitations表示だけでacceptedへ昇格させない。

## 4. 作者契約・入出力・identity

### 4.1 版と固定manifest

固定名osv-mcp-gradle-declarations.jsonのcontractVersion=3を提案。sources／scopes／trustModelは既存と同義で、plugin実装sourceもboundary root相対のsourcesへ含める。catalogPolicyはnoneまたはexplicit-local-v1とし、catalogs／各scope.catalogIdsは必須（noneでは空、localでは既存v2同等の検証）。追加はpluginPolicy=explicit-local-build-v1、plugins、各scope.pluginIds（空も明示）とする。

pluginsのlocal entryの必須field案:

| field | 内容 |
| --- | --- |
| id | manifest内一意のopaque ID。plugin IDやbuild名を兼ねない |
| producer | kind=build-srcまたはincluded-build、rootDirectory、projectPath。rootDirectoryはboundary相対。projectPathはproducer内の位置 |
| pluginIds／implementationClass | 対象pluginの全公開IDと元implementation class。class適用のみはpluginIds=[]を明示して実証済みの別経路で照合 |
| sourcePaths | 実装・委譲helperの物理source集合。全てsourcesとinputPathsへ含める |
| inputPaths | producer settings/build、適用script、source、resource、catalog、lock等の明示ファイル集合 |
| outputRoots | 期待するclasses／resourcesディレクトリまたはJARのroot相対pathとrole。空やroot自身を許さない |
| sourceMappings | sourceId・sourcePath・対応implementationを結ぶ作者登録。precompiledは元scriptと生成クラスの実証済み対応方式も指定 |
| assertions | §3の必須表明。欠落をtrueへ補完しない |

inputPathsはsourcePathsだけでは不十分。ただしcompile classpath全件を通常のsource／artifact捕捉予算へ入れない。構築入力を次の二種に分類し、全classpath entryをいずれかへ一意に対応させる。欠落・曖昧・重複分類はgraph入力検証不能とする。

| 分類 | 対象 | 検証契約 |
| --- | --- | --- |
| trusted-toolchain | 明示承認したGradle／JDK／同梱compiler・標準ライブラリ、Gradle配布由来の生成gradle-api JAR | 下記のtoolchain profileを使用。source用の4 MiB/件・64 MiB/scanでは再捕捉しない |
| plugin-build-input | pluginソース、独自compile／runtime依存、processor、compiler plugin、構築script・resource等 | 境界内の明示inventoryへ通常どおり捕捉し、4 MiB/件・64 MiB/scanでreaderが現在bytesを再検証 |

trusted-toolchainはpath名・group名・gradleApi()という表記・producerのrole指定だけでは認定しない。信頼済み利用者が別途承認したprofileの内容digestをconsumer起動時に許可する方式を提案する（設定案OSV_MCP_GRADLE_PLUGIN_TOOLCHAIN_PROFILES、SHA-256 digestの厳格な許可集合。空は許可なし、未知／不正値は警告＋無効、起動後変更は無視）。graphはprofile記述を埋め込み、そのdigestを照合するだけで、toolchain pathや取得URLを指定してMCPに読ませることはできない。

profileはschema version、Gradle配布digest／版、JDK identity、compiler identity、全許可entryのrole・size・content digest、生成gradle-apiの親配布digestと生成方式を持つ。profile本体は最大1 MiB・entry最大2,000・未知field／重複entry拒否。生成gradle-apiも期待する実bytes digestを含める。生成前に値が不明なら別の信頼済み事前準備でprofileを作成・承認し、export中に自動承認しない。版番号だけの一致や任意JARを含むprofileをproducerが自己承認することは禁止する。

大きいtoolchain bytesの照合は、明示的に選んだtoolchainを扱う信頼済み準備／export側でstreaming hashを採り、起動前・構築前後にprofileと比較する。上限案は1 entry 512 MiB、合計2 GiB/invocation、1回の読取buffer最大1 MiB、entry最大2,000とし、超過・読取失敗・不一致は採用不可。同一entryの検証をbuild間で共用するが、必要な再照合も合計読取予算へ算入する。この経路でJARを展開・実行せず、plugin入力の予算やMCPの境界を広げない。

MCPはtoolchainの実bytesをscan時に再検証したとは主張せず、起動時に承認されたprofileと、そのexportでadapterが検証したtoolchain receiptとの対応を受理する。これは追加plugin信頼に含まれる環境の作者表明で、limitationsへplugin_toolchain_profile_author_attestedを追加する。実行時のprofile不一致・未承認profileならgraph不採用。実行後の環境変更や、信頼したcompiler／loaderの内部動作は独立証明の対象外と明記する。

通常のbuildSrc／included pluginが利用する大きいgradle-api JARをこのtoolchain経路で扱い、小さいplugin固有ソース・生成artifactは従来予算内で検証する。独自依存やprocessorをサイズ超過・境界外だからという理由でtoolchainへ昇格させない。plugin固有classpath bytesを捕捉できない場合や未登録の環境／外部service／生成入力に依存する場合は初期未対応。環境metadataとhashだけで完全再現性を保証しない。

scopeはconsumerのprojectPath・resolvableConfiguration・declarationConfigurationsを持つ。producer buildのdependency graphをmainのグラフへ統合する仕様ではない。最初の対象contextは既存どおりmain buildのproject。producer tupleはplugin証拠専用の名前空間とし、同じ:appや同名build-logicでもrootDirectory・projectPath・invocationを別々に照合する。

remote entryはkind=external-artifact、pluginIdsと診断用artifact identityのみの別tagged unionとし、state=unverifiable固定。source JAR pathをlocal entryへ丸めない。未知kind・未知field・重複ID・path・source参照・scope参照は拒否。manifestの上限・duplicate key・深さ・文字列制限を既存と共用する。

### 4.2 helper案

```text
preparePluginInputs(contract, invocation) -> prepared build/source inventory
beginPlugin(targetProject, pluginSpecId, pluginInstance, producerReceiptId) -> PluginHandle
pluginSource(pluginHandle, sourceId) -> SourceHandle
add / addProvider / addProviderConvertible / addCatalogLibrary / addCatalogBundle
  (existing arguments, pluginSourceHandle, originalAction?) -> RegistrationHandle
finishPlugin(pluginHandle) -> observed registration summary
```

beginPluginはPlugin.applyの先頭で呼ぶ候補。scopeとsourceは事前準備済みで、consumer側extensionは適用前に準備する。precompiled scriptには定型登録コードを明示的に追加する。自動source注入を実装済みとはしない。別buildのadapterクラスをclass castせず、公開extensionとの型付き／Groovy bridgeを実証する。プロセス間でopaque objectを渡さず、producer receipt参照をconsumer coordinatorで解決する。

pluginInstanceの観測とPluginContainer照合がapply中に完了できない場合はpendingにして、apply後に照合する。未確認中も通常の追加は元どおり行い、最終確認前に宣言元を公開しない。例外でfinishPluginへ到達しない場合もpendingを完全にしない。deferred Providerのmaterializationがfinish後に起きることを許容し、finishをcallback数確定の意味にしない。

元Actionを先に実行し、その後にsnapshotを取得する。元の例外・Provider／Convertible・bundleの通常委譲を維持する。追加get／isPresent／map／asProviderや未使用configurationの解決を行わない。未準備・別projectのhandle、複製map、receipt IDだけを持つ捏造handleでsourceを登録できない。親pluginのhandleを子pluginの実装sourceへ自動流用しない。

### 4.3 export出力案

graph schemaVersion=3、declaration adapterVersion=5を予約案とする。graph v3にはpluginInputsの必須inventoryを設け、plugin非使用でもinventoryComplete=true、entries=[]を明示。entryはpluginSpecId、producer tuple、state、graphInputRefs、buildReceiptId、artifactInventoryIdを持つ。artifact参照は後述の厳格なbinary inventoryへ分離し、既存text-input parserへJARを渡さない。

buildReceiptはinvocationId、manifest hash、producer identity、承認toolchain profile digestと検証receipt、入力inventory digest、生成／compile／packagingのtask identity・観測状態、出力inventory digest、loaded-origin照合状態を持つ。pluginApplicationはapplicationId、consumerProjectId、pluginSpecId、receipt参照、元implementation identity、状態・理由を持つ。宣言recordの出自は次のdiscriminated unionで表し、bundle groupと全memberにも同じ出自を保持する。同じpluginが複数projectへ適用されれば別application、同じsource／artifactはinventoryを共用する。applicationには全期待試行ID集合を記録し、record側参照と双方向に検証する。

### 4.4 script／plugin宣言の識別と参照規則

adapter v5の各recordとcatalog groupへoriginを必須化する。未知kind・欠落をscriptへ補完しない。

```text
origin = { kind: "script" }
       | { kind: "plugin", pluginApplicationId: ID, sourceMappingId: ID }
       | { kind: "unverified", reason: REASON }
```

- script: source.kindはbuild-scriptまたはapplied-script、既存の事前準備済みscript handleに一致すること。pluginApplicationId／sourceMappingIdはnullも含めfield自体を禁止。通常scriptからの既存helper呼出しはこの形で出力でき、架空のplugin applicationは作らない。
- plugin: 両IDは必須・非null。source.kind=convention-pluginで、applicationのconsumer project／pluginSpec／scope.pluginIds、producer receipt、mappingのsourcePath／hashへ完全一致すること。script sourceへ変更したり、sourceだけ残してIDを削除したりすれば不正。mapping未確定などで陽性形を出せない観測はunverifiedを使う。
- unverified: source=null、reason必須、plugin参照fieldは禁止。未観測／source不明を診断する形であり、scopeの宣言元を不完全にする。空のsourceで完全として通さない。

originは呼出し側の文字列やsourceのsuffixから選ばず、adapterが準備したopaque handleの型・identityと追加試行台帳から決める。plugin manifestのsourceMappingsへ登録したpathは同じ契約のscript sourceとして再登録不可とし、通常source(path, build-script)へplugin実装pathを渡してもscript handleを発行しない。precompiled .gradle.ktsもsuffixだけでscript扱いにしない。

readerはmanifestのsource役割、applicationの全期待試行ID集合、record／group／memberのorigin参照を双方向で照合する。applicationが指すrecordをscriptへ変更、application側だけ参照削除、bundle memberだけscriptへ変更、IDを別applicationへ付け替えた場合は拒否する。影響scopeはplugin信頼を要求し続ける。個々のoriginを変更しても契約・scopeから判断する追加信頼の必要性は解除できない。

scriptとpluginの両方で同じGAVを追加した場合は別試行のまま同じedgeへbindingし、両sourceを併合する。plugin側が未採用なら既存の完全性ANDで一覧全体を省略する。pluginを含まない別scopeは既存helper信頼だけで採用できるが、非使用をinventoryとscopeで確認する。作者が全manifestと台帳を虚偽に書き換える限界は§6どおりで、originという自己申告だけでその問題を解決したとはしない。

sourceはkind=convention-plugin（plugin originの場合）、boundary相対path、捕捉hash。宣言・group・member・application・receipt・source mapの参照をreaderが再計算する。producer complete=trueやplugin ID一致だけでは採用しない。未観測・曖昧なclass対応はsource=nullと理由を出し、成功した他memberだけを完全一覧として返さない。

## 5. ソース取得・ビルドと実行artifactの対応

1. **Gradle起動前:** ユーザーが明示実行する信頼済み準備コマンドでmanifestを読み、main／buildSrc／included producerの全plugin-build-input・不在候補を一括捕捉し、trusted-toolchainは§4.1の承認profileと別経路で照合する。runtime専用invocation IDを発行し、その実行のcoordinatorだけへ渡す。既存companionを準備用ファイルで上書きしない。rootのsettings評価後にbuildSrc sourceの初回hashを採らない。
2. **各build初期化前:** init adapterがbaselineとinvocationを受け取ったことを確認する。mainだけに-Iが適用されたと思い込まず、buildSrc・included buildで実際の順序・受渡しを実証する。registryのstatic変数やGradle daemon間の共有を前提にしない。
3. **producer構築:** 明示されたcompile／生成／packaging経路を観測し、入力baseline・出力manifestを結ぶ。同じexport invocation内の正常な実行だけが初期陽性候補。UP-TO-DATE、FROM-CACHE、NO-SOURCE、skipped、過去receiptの再利用は初期不採用。強制再構築等は検証コマンドで明示する操作であり、MCPやhelperが黙ってtask graph／cache設定を変更しない。
4. **生成物:** precompiled scriptのgenerated source／descriptor／classは期待outputで、初回source baselineの代用品にはしない。元scriptとcompilerの生成経路を対応させる必要がある。初期非対応の任意生成.kt等を後からsourcesへ追加して採用しない。元sourceの不在→生成はstale。
5. **plugin適用:** 実体・plugin ID・implementationと、公開APIで観測可能なload origin、検証済み出力集合を照合する。descriptorは補助で、plugin markerの座標と実装JARを混同しない。ディレクトリloadは全出力ファイル集合、JAR loadはartifact bytesを照合。instrumentationで別bytesへ変換され、変換前後の対応が公開APIで確認できないなら未対応。class resource URL一致だけでは陽性にしない。
6. **登録とexport:** 登録時、export開始、解決後・atomic write直前にソース・構築入力・確定後のartifact inventoryを再確認。変更・欠落・集合の増減はpublicationを拒否し、旧companionを維持する。source handleを発行した後にproducer receiptが失効した場合も全参照を無効にする。
7. **MCP静的取込:** 現在のplugin固有ソースとartifactを同じ境界で読み直し、manifest・receipt・graph入力・applicationの参照を検証する。toolchain bytesは開かず、承認profileとtoolchain receiptを照合する。MCPはproducerを再ビルドしない。別途生成したreceiptに同じinvocation文字列を書いただけでは構築観測を満たさない。JSONを編集できる作者の虚偽表明まで防ぐ署名契約とはしない。

compiler／クラスロードを独立に再現する仕様ではない。入力完全性と実装source mapは作者表明、実行記録とloaded originの対応はadapterの観測、現在bytesとschemaの確認はreader、と責任を分ける。三者を一つのhash一致へ縮約しない。

### 読取範囲・予算

manifestは固定名、graphが参照するplugin固有ファイルの全pathはboundary root相対・symlink拒否・通常file限定。sourceを探索で自動拡張しない。source suffixは.gradle／.gradle.kts／.kt／.java／.groovyをroleごとに制限する。build入力の既存許可suffixを維持し、resourceやbinaryはgraph v3の専用roleで明示検証する。任意suffixやURLを一般のinputPathsへ許可しない。日本語・空白を含むpathを保持し、basenameや大小文字を勝手に正規化してidentityを併合しない。CP03／04／23に同名ファイル・日本語／空白・case衝突の対照を含める。

plugin-build-input／生成artifactの捕捉とMCPの読取は既存4 MiB/件・64 MiB/scanを引き上げない。plugin固有のJAR・class・resource・読取直しを含む共有byte予算を明示して実装し、超過は採用不可。trusted-toolchainの大容量検証は§4.1の信頼済み準備側の別予算で、MCP読取の例外ではない。JAR／resourceの検証を追加する場合、archive内path・重複entry・圧縮後／展開後サイズ・entry数も制限し、ディスクへ展開・実行しない。directory inventoryはrootごとの集合hashだけを信じず、全列挙ファイルの集合・hash・欠落／追加を検証する。sourceとartifactを別budgetで無制限に読む抜け道を作らない。

plugin数100、source数10,000、output entry総数10,000、application／recordは既存10万、観測128/試行を初期上限案とする。入力・artifact・source対応indexの共有workは200万、宣言探索は既存の独立予算に算入する。同一artifactと失敗をscan内cacheし、context数×artifactサイズの再読取を避ける。上限・読取エラーで通常の依存追加や元Actionを停止させず、観測を不完全にする。

## 6. 完全性・信頼・coverageの判定

採用条件は(1)graph入力が全て検証済み、(2)plugin source-artifact対応を観測済み、(3)helper・plugin・必要ならcatalogの全信頼有効、(4)source mapとscope表明・applicationと全追加試行の被覆が完全、(5)既存key／shape・edge bindingとlockが整合、のAND。scopeのextendsFrom閉包・異なるconfigurationからの同値追加・bundle member全件にも適用する。

| 状態 | 関係metadata | declared_in | lock由来の脆弱性coverage |
| --- | --- | --- | --- |
| 全条件充足 | 既存graph解析どおり | 全物理sourceの和集合 | 維持 |
| graph入力・artifactの対応は検証済み、plugin信頼のみ無効 | 保持 | 影響scopeの全一覧を省略 | 維持 |
| 入力と実行artifactは検証済み、追加箇所mapping／表明／観測だけ不足 | 保持 | 影響scopeの全一覧を省略 | 維持 |
| 構築入力欠落／stale、未承認／不整合toolchain profile、実行artifact対応不能、remote／plugin固有入力の境界外 | 影響contextを採用せずunknown | 省略 | このmetadata制限だけでは下げない |
| 影響contextやplugin inventory自体の範囲が不明 | graph文書全体を採用しない | 省略 | 同上 |
| 検証後にlockに対する実際のgraph欠落等を確認 | 既存coverage規則で判定 | 完全性AND | 確認した欠けに応じ不完全 |

mapping不足とgraph入力検証失敗を区別する。source-artifact対応がないのに「sourceだけ未確認」としてgraphを採用しない。共有producerが失効したら、その全application／contextへ伝播する。影響集合を独立に証明できる場合だけ他contextを保持する。

同じGAVに有効なscript宣言と未確認plugin宣言が混在した場合、確定したscriptだけの部分一覧を返さない。全関連context・複数lockのdeclaredInCompleteをANDし、unknown／未提供も既存の抑制規則に従う。確定transitiveにはplugin sourceを転記せず、introduced_byだけを既存graphから計算する。context順序やファイル順でtrust／一覧を変えない。

metadataには既存helperと独立のplugin_trust_model／plugin_trust_status、application／producerの診断、limitationsを追加する案。追加信頼が無効でも入力検証は必須。helperだけacceptedでもpluginがdisabledならdeclarations_complete=false。欠けた表明はmissing_assertion、source mapping不整合はinvalid、未対応load形はunverifiableとして診断する。最上位の完全性は各状態と全scopeをANDし、個別statusのacceptedだけで採用しない。plugin_trust_statusはconsumer設定無効ならdisabled、有効なら全関連applicationをinvalid > unverifiable > missing_assertion > acceptedの優先順で併合し、空のapplicationだけから必要な証拠をacceptedにしない。graph入力検証結果は別のplugin input状態／理由として常に残し、disabledで隠さない。未評価と非使用を空配列だけで同一視せず、manifest／scope／観測を照合して非使用を確定する。

### 互換性・迂回防止

契約v1／v2とadapter v2／v3／v4は現行のまま。v3契約はv5宣言adapterとgraph v3のplugin入力検証を必須とする。旧版へ機械的にfallbackしてplugin recordをscript扱いにしない。未知graphは旧readerでは不採用、新readerは独立に検証できる従来形式だけを従来どおり扱う。

固定manifestをproducerのentriesとは独立に確認し、contract v3・pluginPolicy・plugins・scope.pluginIds・plugin sourceのいずれかに新形式の要請があれば必須検証を省略しない。空entries、catalogGroup省略、records空、信頼設定無効、adapter downgrade、manifestのgraph入力参照欠落を検証回避に使えない。新plugin関連fieldのあるv1／v2契約は厳格schemaで拒否する。

manifestからplugin情報を全て除去し、虚偽の旧作者契約へ書き換えた未知の同値追加を一般に独立検出できるとは主張しない。その限界は既存helperの作者信頼と同じ。観測可能なconvention-plugin recordや新schemaのinventoryを隠すだけのdowngradeは拒否し、形式変更を新たな信頼表明の代用にしない。

## 7. 回帰テスト条件

API実証は通常追加、登録なし棚卸し、登録付きの経路を比較。Groovy／Kotlin consumer × Gradle 8.11.1／9.2.1で実行し、producerのprecompiled Groovy／Kotlin、binary Kotlin／Java／Groovyはそれぞれ利用するcompiler環境を固定して別ケースとして記録する。対応不能な組合せをskipして全形対応済みとしない。

| ID | 条件 | 必須の期待結果 |
| --- | --- | --- |
| CP01 | buildSrc binary pluginが同期依存追加 | 実装.kt／.java／.groovyだけをdeclared_inへ。consumer build fileへ置換しない |
| CP02 | buildSrc precompiled Groovy／Kotlin plugin | 元script・生成／compile・loadの対応を確認。生成adapter pathは返さない |
| CP03 | included build-logicと別checkoutのローカルplugin | producerとconsumerのbuild identityを分離し、境界内sourceを取得 |
| CP04 | 同名build、同じproject path／plugin IDを持つ別producer | receipt／sourceを誤共有せず、未適用の実装は採用しない |
| CP05 | 同一pluginを複数project、異なるconfigurationへ適用 | applicationは別、input inventoryは共用、各consumerのsource一覧が完全 |
| CP06 | 同値の追加二試行、extendsFrom diamond、scriptとpluginの混在 | 試行IDを保持して全source和集合。継承だけはID重複除去 |
| CP07 | plugin A→B、複数ファイルhelperへの委譲、apply順逆転 | 登録契約で決めた実際の追加実装を保持。outer plugin／callerへ推測転記しない |
| CP08 | Provider／Convertible／catalog library／bundleをplugin内で追加 | 通常経路と評価フェーズ・計測可能な回数・Action順・結果一致。catalog信頼も別途必須 |
| CP09 | 部分bundle Action失敗、Provider空／不安定、例外捕捉して継続 | 元例外を維持し、成功memberだけの一覧を返さない。未使用configurationは実現しない |
| CP10 | begin前の追加、未登録実体、mutation／remove／copy、finish未到達 | 観測欠落を不完全とする。未計装同値追加は自動検出保証に使わない |
| CP11 | plugin適用前にextensionがない／callbackがapply後 | 通常追加を妨げず未採用。withIdの順序だけを観測の完全性にしない |
| CP12 | main／buildSrc／includedのsettings評価・plugin compile前に入力変更 | 起動前baselineから差を検出。export拒否、旧companion不変 |
| CP13 | 先行taskによる入力変更、削除、事前不在source生成、export直前変更 | staleを検出。late captureによる陽性化禁止 |
| CP14 | UP-TO-DATE／FROM-CACHE／NO-SOURCE／skip／失敗／過去receipt | 初期source-artifact対応は不採用。同じinvocation文字列だけでは採用しない |
| CP15 | 同名ソース＋別JAR、別版実装、同じplugin marker＋異なるimplementation | hash／loaded origin／receiptを別々に照合し、source JARだけで成功しない |
| CP16 | instrumentation、decorated class、複数classloader、class直適用 | 公開APIで対応を確認できた形のみ陽性。不明はunverifiableで記録 |
| CP17 | class／resource出力の追加・差替え、JAR内容変更、別receipt流用 | graph入力staleまたは対応失敗。sourceだけ一致しても採用しない |
| CP18 | sourceMappingのclass/source偽装、別application／scope／buildへの参照 | 全参照をreaderが再計算。producer complete=trueを信じない |
| CP19 | graph入力は全検証済みでsource mappingの一部だけ未登録、pluginと完全なscriptの混在 | scope／GAVのdeclared_inを全省略、部分一覧なし |
| CP20 | helper／plugin／catalog信頼の全有無組合せ、未知値、起動後env変更 | 独立gate・起動時固定。入力検証はどの設定でも省略しない |
| CP21 | plugin表明／providerPolicy／scope.pluginIdsの欠落 | 各理由を区別し、graph入力が有効ならrelation／coverageは保持 |
| CP22 | 空plugin entries×adapter v2／v3／v4へ変更、manifest入力参照欠落 | contract v3から必要性判定し拒否。未知／不正契約の空配列で迂回しない |
| CP23 | remote plugin＋source JAR、境界外checkout、symlink／path traversal | 自動取得・境界拡張なし、declared_inなし。影響graphも規則どおり拒否 |
| CP24 | 不正JSON、duplicate key、未知kind／field、参照重複、過大入力 | 上限・厳格schemaで拒否。compiler／JARをreaderで実行しない |
| CP25 | archive重複entry／zip bomb、巨大class、artifact数・work超過 | byte／entry／work予算を共有し失敗をcache。通常追加は継続 |
| CP26 | 同一artifactを多数context、失敗を多数lockで参照 | cache共有で読取・indexを増幅しない。予算不足を成功へ丸めない |
| CP27 | context／lock／plugin登録順逆転、完全と不完全が混在 | trust summary・declared_in・introduced_by・coverageが順序不変 |
| CP28 | ソース変更→復元、虚偽のsource map／列挙入力表明 | 独立検出不能の作者信頼限界を記録。検出できたというテスト名にしない |
| CP29 | configuration cache、parallel、task-output Provider、settings plugin | 初期対象外の明示判定。既存対応を無条件に拡張しない |
| CP30 | 既存C1a／C1b／catalog v1/v2契約 | 出力・信頼採用・拒否・source完全性・3ツールの互換性を維持 |
| CP31 | 標準gradle-apiが4 MiB／64 MiBを超えるbuildSrc／included plugin、Groovy／Kotlinの標準toolchain | 承認profileのstreaming照合経路で構築入力を被覆し、plugin固有source／artifactの既存予算を超過せず陽性候補へ進める。MCPはtoolchain pathを開かない。load対応等の別gateは別途必要 |
| CP32 | toolchain profile未承認／hash不一致／版だけ一致、独自processor・plugin依存のtoolchain偽装、profile設定の後変更 | 起動時allowlistと全entry分類を検証し、graph不採用。任意JARをtoolchainへ付け替えて予算・境界を迂回しない |
| CP33 | 大容量toolchainの512 MiB/entry・2 GiB合計・entry数上限／再読取、plugin固有4 MiB/件・64 MiB超過 | 各予算の境界を検証。準備側streamingのbuffer上限、失敗cache、再照合算入を確認。plugin入力の制限は緩めない |
| CP34 | 同じcontextで通常script＋buildSrc／included pluginの同値依存、両順序・bundle混在 | script originにplugin参照なし、plugin originに両IDあり。架空applicationなしで全物理sourceを併合し、plugin信頼なしでは部分一覧を抑制 |
| CP35 | plugin record／bundle memberをscript originへ変更、ID削除／null化、source.kind変更、application側の試行参照だけ削除 | manifestのsource役割・scope・台帳の双方向被覆から拒否し、追加信頼を迂回できない。precompiled scriptのsuffixを根拠にscript扱いしない |
| CP36 | 通常scriptだけのscope、script originへのplugin参照混入、origin欠落／未知値、source不明 | 正常scriptはplugin application不要で採用。参照混入・欠落・未知originは拒否、unverifiedは完全性を下げる。他のplugin scopeの状態で順序依存にしない |

## 8. 実装順と完了条件

1. **公開API実証:** CP01〜17およびCP31／34の核についてbuildSrcとincluded build、precompiledとbinaryを分けて検証。評価前捕捉順序、compile出力のload対応、init情報のbuild間受渡しが実証できるまで本番採用を有効にしない。instrumentation対応が確認できないなら陽性形は空でもよく、制限と代案を記録する。
2. **schema／安全な静的取込:** 契約v3／graph v3／adapter v5と独立trust、固定manifest検出、source／artifact inventory、各budgetとreaderの参照検証を実装。まずCP18〜30およびCP32〜36の静的条件を回帰で確認し、模擬JSON成功だけを本番plugin対応としない。
3. **本番adapter:** 同期から開始し、Provider／catalogの既存成功経路へ接続。buildSrc／includedの各形は個別に有効化し、失敗形を省略する。型付き独立helper pluginの配布はAPI公開・classloader互換を別途検証する。
4. **3ツール・OSV実接続:** 既知脆弱版をbuildSrc／included pluginから追加。scan_project／scan_java_project／suggest_fixでdeclared_in、trust／limits、候補と独立OSV再照会を確認。信頼無効・表明なし・未対応artifact対照、script混在時の全一覧抑制も確認。MCP中のGradle非起動、入力hash不変、source／artifact本文がOSV・scanner入力へ送られないことを検証する。

実証記録にはGradle／JDK／compiler版、DSLとproducer種別、実際のinit／compile／applyイベント列、観測できたload形、失敗・未対応条件、ソースhashとハーネスhashを保存する。OSV cleanは更新後のビルド互換性・source-artifact対応の証明と分ける。

## 9. 参考資料と設計時点の状態

- [Convention Plugins](https://docs.gradle.org/current/userguide/implementing_gradle_plugins_convention.html)
- [Sharing Build Logic using buildSrc](https://docs.gradle.org/current/userguide/sharing_build_logic_between_subprojects.html)
- [Pre-compiled Script Plugins](https://docs.gradle.org/current/userguide/pre_compiled_script_plugin_advanced.html)
- 公開APIの根拠は§2のJavadoc。いずれも現行版の説明であり、8.11.1／9.2.1での実測結果ではない。

今回追加するのは設計・回帰テスト条件のみ。本番adapter、reader、信頼設定、公開API実証テスト、実接続ハーネスは変更しない。既存のconvention-plugin sourceは引き続き未採用。


## 10. 公開API実証の結果（2026-10-31）

**登録試行・混在source・toolchain分類は実証できたが、今回のload形ではsource-artifact対応の陽性gateは未成立。** 本番のconvention-plugin採用は有効化しない。これは公開API全般で対応が不可能という証明ではなく、以下の構成・観測方法で採用条件を満たせなかった記録である。

### 実行行列と再現方法

Groovy／Kotlin consumer × Gradle 8.11.1／9.2.1の4構成それぞれで、次のproducer 3種を別fixtureとして実行した（通常12 fixture）。レビュー修正後は、未記録classpath resourceを追加する陰性fixtureを各consumer／Gradle版に追加し、計16 fixtureで再検証した。各fixtureはplain（通常委譲）、control（解決後棚卸し）、registered（登録付き）の3 projectに同じpluginを適用し、別にscript単独projectを用意する。

| producer | 構築方法 | 物理source候補 |
| --- | --- | --- |
| buildSrc binary Java plugin | 標準java-gradle-plugin／JavaCompile | buildSrc/src/main/java/proof/Convention.java |
| 独立build-logic binary Kotlin plugin | includeBuild、公開JavaExecと同梱Kotlin compiler CLI | build-logic/src/main/kotlin/proof/Convention.kt |
| 独立build-logic precompiled Groovy plugin | includeBuild、標準groovy-gradle-plugin | build-logic/src/main/groovy/proof.convention.gradle |

Kotlin binaryのcompilerはGradle同梱のK2JVMCompiler CLIを明示実行する試作経路。標準kotlin-dsl／Kotlin Gradle Pluginの対応実証には読み替えない。compiler／DSL pluginの追加downloadはせず、Gradle API JARは事前準備済みcacheを使用する。JDKは21.0.13+9。binary Groovy、precompiled Kotlin、buildSrc内のprecompiled plugin、発行済みの外部binary pluginは今回未実証。

回帰は[src/test/gradle/conventionRegistration.integration.test.ts](../src/test/gradle/conventionRegistration.integration.test.ts)、試作は[init fixture](../src/test/fixtures/gradle-convention-registration.init.gradle)、診断用の参照検証は[test-only helper](../src/test/fixtures/gradleConventionProof.ts)。本番schema／静的readerではない。各版で128件のnative回帰を再実行して成功。別の[policy・実ディスク回帰](../src/test/gradle/conventionProofPolicy.test.ts)32件は参照・信頼・予算判定と制限付きディレクトリ捕捉を確認し、実pluginの採用成功には数えない。最終結果は末尾に記録する。

```sh
env OSV_MCP_TEST_GRADLE=/trusted/gradle-8.11.1/bin/gradle \
  JAVA_HOME=/trusted/jdk-21 GRADLE_USER_HOME=/trusted/prepared-gradle-cache \
  OSV_MCP_GRADLE_CONVENTION_OUTPUT=/tmp/convention-proof \
  npm test -- src/test/gradle/conventionRegistration.integration.test.ts
```

同じコマンドの実行ファイルを9.2.1へ替えて再実行する。cacheに生成gradle-api JARがなければ、この試験より前の信頼済み準備が必要。出力prefix指定時は版・consumer DSL・producer・kindごとのJSONを保存し、一時fixtureは終了時に削除する。compilerやJARをMCPが実行する手順ではない。

### 確認できたこと

- Node側の起動前baselineと最終source hashが一致。各producerのbeforeSettingsとcompile／jarの公開task callbackを記録し、mainとproducerを別identity・同一invocationで対応付けた。static変数のbuild間共有は不要だった。任意の複雑なbuildの入力完全性を自動発見した実証ではない。
- 3経路の解決GAV・元Actionのtraceが一致。pluginとscriptが同じreview:parent:1を独立追加して一つの保持依存へ合流しても、registeredはplugin／scriptの別origin・試行ID・両source候補を保持した。applicationの期待試行集合は追加時に別台帳へ記録し、recordから事後生成しない。レビュー修正でProviderにもp0／p1の安定IDを付け、未実現を含め同期recordと同じapplication被覆で検証する。未使用Providerを検証のために評価しない。
- plugin IDから公開PluginContainerでbinary plugin実体を照合できた。precompiled scriptで登録コードのthisは生成Pluginの実体とは同一でなかった。この形のbeginPluginに実体を渡す方法は追加検討が必要。
- lazy configurationのProviderは1回、unused configurationは0回。通常／棚卸し／登録付きで評価phase・回数・結果が一致した。callback数とsupplier数は別々に記録する。plugin内catalog／bundle／Convertibleの実証を代替する結果ではない。
- script単独projectはplugin applicationを作らず、script originと物理sourceを維持。pluginを含むprojectは下記のgateが未成立なので、確定したscriptだけの部分declaredInも返さない。これらはtest-only報告の値であり、MCP本番応答ではない。

### source-artifact対応が未成立の理由

binary pluginの公開CodeSource／class resourceは、準備したproducerのclasses directoryやJARではなく、scan boundary外のGradle管理cacheにあるJARを指した。そこから診断用に読んだ対象classの内容hashはcompile出力と一致した。JAR全体のraw hashは一致する場合と一致しない場合があり、class内容一致とarchive全体一致を分けて記録した。

この一致だけから、classloaderが実行した変換後bytecodeまで対応を証明したとはしない。cacheの探索・private reflection・内部instrumentation設定の変更は行っていない。公開CodeSourceが示したファイルの有界な診断読取は信頼済みexport試験側のみで行い、MCPの境界を広げる案ではない。test-only helperはloaded_origin_outside_prepared_outputsとしてsourceArtifactVerified=false、診断結果はplugin_loaded_origin_unverifiable、混在一覧は空とした。precompiled scriptの実体照合不足も陽性へ丸めない。

したがって、次は実行artifact／変換の信頼契約とprecompiled plugin instanceの登録方法を再検討し、公開APIで十分な対応を観測できる形を追加実証する。classpath／outputのhashが両方あるだけで本番adapter／v5 readerの実装へ進めない。

### toolchainと迂回対照

試験runnerが実行前に選んだGradle配布JAR群と生成gradle-apiをstreaming hashし、profile digestを別のconsumer policyへ許可した。生成API JARは各版とも64 MiBを超えるが、plugin source／outputを読む4 MiB/件・64 MiBの枠へ入れずに分類・検証できた。toolchainのbufferは1 MiB、準備・最終照合・観測したcompile classpathの読取合計は各fixtureで2 GiB以内。profileの完全な本番schema、実環境での独立したprofile配布・承認運用を実装した試験ではない。

compile classpathに含まれるproducerの生成classes directoryはtoolchainへ昇格しない。レビュー修正後は実ディレクトリを列挙して現在の全ファイル集合とhashを捕捉し、観測済みoutput inventoryとの完全一致を確認する。記録済みファイルだけの再hashではない。ただし捕捉はGradle終了後にNode側で行う事後snapshotであり、compileGroovyがclasspathを読んだ時点の状態ではない。compile中だけ存在したファイル、変更後に復元されたファイルは検出できない（plugin_classpath_transient_changes_not_detectable）。task開始時点のsnapshotは今回実装していない。precompiled Groovyの通常fixtureにもHelper.groovyを追加してGroovyCompileを実行し、この分岐を通る陽性対照を設けた。NO-SOURCE／skipped taskのclasspathは追加実現しない。toolchain外の一般的な外部plugin依存の捕捉、全resource inventoryの攻撃耐性までは今回実証していない。

各native報告を基に、未承認profile、profile改変、entry hash偽装、plugin recordのscript化・参照null化、application側だけの参照削除、scriptへのplugin参照混入、origin欠落を診断回帰で拒否した。synthetic回帰では容量・buffer・entry数上限、source stale、plugin信頼無効、script単独scope等も確認。これらはJSON/schemaの全攻撃条件や全CP01〜CP36の達成を意味しない。

### 証跡と未実証範囲

[機械可読記録](validation/gradle-convention-plugin-2026-10-31.json)にはソースhash、各版の承認profile、通常12件と未記録resource追加4件のpublic API報告・候補source・不採用理由・toolchain読取量を保存する。個人環境の絶対pathを含めず、診断用cache URLは変数名へ置き換える。

今回未実証なのは、実行artifact対応の陽性、完全な契約v3／graph v3／adapter v5、本番の起動設定・safe reader・全予算・atomic publication、評価／先行taskによる入力変更のnative対照、継承diamond、plugin間委譲、settings plugin、cache再利用、並行実行、configuration cache、外部配布plugin。既知脆弱版のOSV実接続も実施していない。既存C1a／C1b／catalogの実接続結果を今回のplugin gateの達成へ流用しない。

初回実証の72件／版・通常全体1,611件成功の記録は、レビュー修正前のもの。レビューで見つかった2件を成功済みと読み替えず、以下の追加回帰と更新したJSONで再検証する。

### レビュー修正と追加回帰

1. classpath directoryはsourceと共有するbyte予算・entry予算で実際に列挙し、各ファイルのhashと集合を取得する。記録との追加・削除・内容変更のいずれもplugin_classpath_directory_mismatch。snapshot不在／読取失敗も記録済みhashへfallbackしない。symlink、過大file、entry数、共有byte予算の対照も追加した。scan内では同一directoryの捕捉をcacheする。
2. Providerにも安定した試行IDを付け、追加時にapplicationの期待試行集合へ登録する。診断ではrecordsとproviderRecordsを一緒に走査し、IDの一意性、origin／source mapping、application側の期待集合を双方向照合する。sourceをscriptへ書き換える、origin／ID／参照を消す、recordだけを削除する、逆参照だけを削除する、重複IDを作る対照を追加した。pendingなunused Providerも出自は検証でき、supplierを追加実行しない。

修正前には、現在のdirectoryに追加fileがあるのにinputVerified=trueとなる対照と、Providerのorigin欠落でもoriginsVerified=trueとなる対照が失敗した。修正後はこれらを拒否し、変更のないdirectoryと正常なmaterialized／pending Providerは通る。

陰性のnative fixtureでは、compileJavaのoutput receipt記録後、compileGroovyの直前にclasses directoryへunrecorded.propertiesを追加する。現在snapshotには存在し、元receiptには存在しないことを確認し、inputVerified=falseかつplugin_classpath_directory_mismatchを必須にした。解決GAVの一致とplugin宣言元の未採用は維持する。

既知の制限の対照として、同じ位置で追加したファイルをcompileGroovyのdoLastで削除するnative fixtureも各consumer／Gradle版に置いた。事後snapshotには残らず、入力検証は通過する（inputVerified=true）。これは現状未検出であることを固定する記録で、検出の実証ではない。plugin宣言元はload元のgateで引き続き未採用。


レビュー修正後の最終確認: Gradle 8.11.1は128件成功（113.97秒）、9.2.1は128件成功（112.45秒）。通常12 fixtureは入力・出自検証を通過し、未記録classpath resource追加の4 fixtureは入力不一致として拒否した。policy・実ディスク回帰32件を含む通常全体は1,631件成功／273件skip（計1,904件）。型チェック・ビルドも成功。plugin由来declared_inの採用は全16 fixtureで0件のまま、本番拒否を維持する。

6d9b1e5レビュー後の追加確認: 一時的なclasspath file対照4件を加え、Gradle 8.11.1／9.2.1とも130件成功（policy・実ディスク32件込みで各162件）。4件は事後snapshotで未検出のまま入力検証を通過し、plugin宣言元は全20 fixtureで未採用。更新後のsource hashと事例は検証JSONのpostReviewRevisionに記録した。


## 11. 改訂案: ロード／変換の信頼とprecompiled実体登録

設計日: 2026-10-31、実証基準6d9b1e5。§10の実行artifact対応は未採用のままである。本節は追加設計で、既存の実証JSON・128件／版の結果を新方式の成功証拠へ読み替えない。§1〜8のsource-artifact要件を以下の二policyへ分ける案であり、矛盾する箇所は本節の将来契約を優先する。本番実装・新policyの公開API実証は今回含めない。

### 11.1 採用の強さを分ける

| policy案 | 必要な証拠と信頼 | 判定 |
| --- | --- | --- |
| prepared-output-only-v1 | 準備済み出力へのload対応と、未確認変換がないことを従来の公開API gateで確認 | 既存案のlocal-plugin-build-v1だけで候補化できる。§10のcache由来の形は引き続き未採用 |
| approved-gradle-loader-v1 | 同一exportで構築したartifactと公開CodeSourceの元artifactの完全な内容対応を確認し、実際のclass定義・変換経路は承認済みruntimeを明示信頼 | 新しいlocal-plugin-loader-attested-v2でのみ候補化。独立した実行bytecode検証とは表示しない |

追加consumer設定案OSV_MCP_GRADLE_PLUGIN_TRUSTは、旧値local-plugin-build-v1か新値local-plugin-loader-attested-v2のいずれか一つ。新値は旧policyの基準も受理できるが、旧値・未設定・未知値で新policyを採用しない。どちらも既存helper信頼が必要で、catalogを含む契約はcatalog信頼も別途必要。起動時に固定し、profileの許可だけでplugin trustを有効化しない。

新policyで作者が表明する追加事項は、approved-runtime-load-chain-only、no-unregistered-agents-or-classloaders、plugin-artifacts-immutable-through-load、precompiled-registration-source-reviewed。これは未知の変換を技術的に検出できるという表明ではなく、承認したruntime以外を使わないという信頼契約である。dynamic attach、native agent、独自classloader、未登録init／settings plugin等の影響を独立列挙できたとはしない。観測した矛盾・未知経路は表明で上書きしない。

新policyのassurance案はauthor-attested-loader-and-structurally-checked、source_artifact_statusはbuild-lineage-and-runtime-attested、transform_statusはtrusted-runtime-not-independently-observedとする。従来の「未確認loadを省略する」契約へ黙って意味を追加しない。既存limitationsに加えplugin_runtime_transform_author_attested、plugin_loaded_bytes_not_independently_observed、precompiled_registration_origin_author_attested（該当時）を必須表示する。元artifactの対応を確認できない場合は、新値でもunverifiable。

### 11.1.1 policyごとの必須証拠（レビュー修正）

loadEvidenceはloadPolicyをdiscriminatorとするstrict unionで、共通fieldとpolicy固有fieldを分ける。共通fieldはapplication／producer／invocation／pluginSpec／公開実体の参照、toolchainProfileDigest、構築artifact inventory、観測phase、source／scope／全試行の対応。loadPolicy未指定・未知値をstrictへ補完しない。

| 必須証拠・条件 | prepared-output-only-v1 | approved-gradle-loader-v1 |
| --- | --- | --- |
| 評価前source／input、同一exportの構築lineage、現在の構築出力とtoolchain profile | 必須 | 必須 |
| 元load場所の関係 | 公開CodeSourceが準備済みproducer出力そのものを指し、従来の未確認変換なしのgateを満たすdirectLoadEvidenceが必須 | 公開CodeSourceの元artifactを、承認rootから取得して構築artifactと全内容照合するruntimeSnapshotRefが必須 |
| loaderProfileDigest／構成比較／追加runtimeAttestations | fieldを禁止（nullも不可）。loader profile設定は不要で、その未設定・不正値だけを理由にこのpolicyのgraphを拒否しない | 必須。toolchainとは独立の承認profileと比較可能な構成の一致が必要 |
| runtimeSnapshotRef | 禁止。既存のpreparedArtifactInventoryRefを使い、boundary内のproducer出力をMCPが再検証 | kind=jarまたはdirectoryのsnapshot unionが必須 |
| binary-instance登録のconsumer plugin trust | local-plugin-build-v1またはlocal-plugin-loader-attested-v2 | local-plugin-loader-attested-v2のみ |
| precompiled-pending登録のconsumer plugin trust | §11.4の追加の出自表明があるためlocal-plugin-loader-attested-v2のみ。ただしloader profileは不要 | local-plugin-loader-attested-v2とloader profileの両方が必要 |
| load assurance | 従来のprepared-outputの観測保証を維持。新しい変換信頼のassuranceを付けない | author-attested-loader-and-structurally-checkedと追加limitationsを必須化 |

consumerがv2 trustを選んだだけでstrictをattestedへ変換したり、strictの追加profileを要求したりしない。必要なtrustはloadPolicyとregistrationFormの両方から決定する。helper／catalog等の共通gateはそのまま維持する。precompiledの出自表明はload assuranceと別の登録assurance／limitationsへ記録する。

strictのdirectLoadEvidenceは「CodeSourceの観測対象がproducer receiptの準備済み出力であること」と未確認変換なしの従来gateを結ぶ証拠。コピーしたruntime snapshotをprepared出力に昇格させず、単なるhash一致やloader profileを代用しない。このgate自体の新たな陽性実証はまだない。strict用証拠不足の場合に、無断でattestedへfallbackすることも禁止する。

一つのgraphに両policyが混在した場合はapplicationごとに必須field・設定を判定する。loader profile未設定はattested側の入力不採用理由であり、独立に検証できるstrict側のgraphまで失効させない。影響scope不明なら従来どおり全体不採用。同じGAVの一覧は全contextの完全性ANDで抑制する。

### 11.2 承認runtime profileとload evidence

approved-gradle-loader-v1に限り、§4.1のtoolchain profileに紐付く別のloader profileを事前承認する案とする。strict policyにはこの追加profileを要求しない。設定案OSV_MCP_GRADLE_PLUGIN_LOADER_PROFILESはcontent digestの許可集合。graphから指定されたpath／URLを読み込んで承認しない。旧toolchain profileの許可だけではruntimeのload／変換を承認しない。

必須field案はschemaVersion、toolchainProfileDigest、Gradle／JDK identity、loaderPolicy=gradle-managed-only、transformPolicy=operator-attested-pipeline、許可されたagent／instrumentation構成とそのdigest、外部コード・agent・classloaderを追加しない表明、承認したexport設定。runtimeを選んだ信頼済み利用者が内容を確認してdigestを許可し、producerは自己承認できない。profileは1 MiB／2,000 entry以内、strict schema・重複拒否。実証対象は当面8.11.1／9.2.1と固定JDKの個別profileで、版の前方互換を推定しない。

公開RuntimeMXBean等で取得可能なVM引数・版・明示agent構成を観測してprofileと比較する候補だが、その情報が全変換のinventoryとは主張しない。JDKパス名・Gradle版・CodeSource URLだけが同じでも承認条件を満たさない。観測不能な部分の作者表明と、比較可能な構成の不一致を別fieldへ残す。

applicationごとのloadEvidenceは次を持つ。

| field | 内容 |
| --- | --- |
| applicationId／producerReceiptId／invocationId | consumer project、producer build、同一実行との対応。producer receiptを別applicationのload観測の代用品にしない |
| pluginSpecId／implementationClass／instanceObservationId | 適用後に公開APIで取得した実体に結ぶopaque ID。生objectやclassloaderをJSONへ出さない |
| toolchainProfileDigest | 両policy共通のtoolchain承認と照合結果 |
| loaderProfileDigest／runtimeAttestations | approved-gradle-loader-v1だけに必須。strictでは禁止 |
| codeSourceKind／resourceObservation | CodeSourceのfile-JAR／directory等の種類と診断情報。class resourceは実行済みbytecodeの証明に使わない |
| builtArtifactInventoryRef | 両policy共通の構築出力inventory |
| directLoadEvidence／preparedArtifactInventoryRef または runtimeSnapshotRef | strictは前者、attestedは後者だけを持つ。snapshotはjar／directoryのtagged union。path一致・単一class一致では代用しない |
| comparison | raw-exact、entry-content-exact、directory-content-exact、unverifiableのいずれかと理由 |
| loadObservationPhase | 最初のload元観測の論理phase。snapshot取得phaseと分離する。attestedではload時不変を独立観測した値ではないことも明示 |
| snapshotCapturePhase／runtimeSnapshotRef.capturePhase | snapshotを実際に取得したphase。after-apply callbackで取得しない場合にafter-applyを記録しない。ビルド終了後の捕捉はpost-build |

build receiptには構築lineage、loadEvidenceには各applicationの実体・観測を保持する。同一producerを二つのconsumerが異なるclassloaderで使う場合も、同じprofile／artifact digestだけを根拠にloadEvidenceを共用しない。classloaderそのものの正しさの独立証明は新policyの保証に含めない。

### 11.3 artifact照合と読取境界

同一exportで構築したproducer artifactを正とし、そこへsource baseline・構築入力・compiler receiptを結ぶ。公開Plugin実体のCodeSourceから取得した元artifactだけを比較対象にする。cache全体の探索や、manifest指定の任意URLへのアクセス、class名からのcache path生成は行わない。

| 観測した元artifact | 許可する照合 |
| --- | --- |
| JAR raw bytesが同じ | 全artifactのSHA-256／size一致。新policyでもloader信頼等の他gateは必要 |
| JAR raw bytesは異なるが内容が同じ | 以下のentry-content-exact。ZIP envelopeの差と内容差を区別 |
| directory | §11.3.2の全tree（空directoryを含む）と各fileのsize／hashの一致。記録済みsubsetだけの一致は禁止 |
| classのみ一致、descriptorのみ一致、内容不一致、未知scheme／取得不能 | unverifiable。承認loader profileでも陽性へ上書きしない |

entry-content-exactは全file entryの名前・非圧縮size・内容hashを完全照合する。classだけでなくmanifest、plugin descriptor、service定義、resource、署名関連entryも含める。ZIP順序・timestamp・圧縮方法・オフセット・許可したenvelope metadataだけを比較対象外とする。名前の大小文字・Unicode・本文・manifest改行を勝手に正規化しない。重複名、絶対path、..、区切り文字の曖昧さ、未知encoding／特殊entry等は拒否する。directory entryを除外する場合も、その配下fileを一つも落とさないことを検証する。署名を再検証したという保証にはしない。

境界外のGradle cacheをMCPに読ませない。approved-gradle-loader-v1のexport側だけが、利用者が事前承認したcanonical runtime/cache root内で、実Pluginの公開CodeSourceが指す通常JAR fileまたはdirectoryを捕捉する。symlink・非file URL・root逸脱・特殊fileを拒否し、OSVへの本文送信やsnapshotしたartifactの実行はしない。承認rootはgraph由来にはしない。strictはboundary内の準備済み出力を直接検証し、この外部捕捉経路を使わない。

#### 11.3.1 snapshotのtagged union

approved-gradle-loader-v1のruntimeSnapshotRefは次の二種。共通でsnapshotVersion=1、invocationId、capturePhaseを持ち、applicationから参照する。保存場所は固定prefix .osv-mcp/plugin-runtime/<invocation>/以下へadapterが決定し、manifestから任意のコピー先を指定させない。

| kind | 必須field | 保存形式 |
| --- | --- | --- |
| jar | size、sha256、snapshotPath | jars/<sha256>.jarへ元JAR bytesをそのまま保存 |
| directory | treeDigest、manifestPath | directories/<treeDigest>/manifest.jsonとblobs/<sha256>の通常file群。directoryをJARへ詰め直さない |

jarにtreeDigest／manifestPath、directoryにJAR用size／sha256／snapshotPathを混ぜた文書は拒否する。graph v3にはruntime-origin-snapshot-jar／runtime-origin-snapshot-directoryの専用roleを設け、既存text inputのsuffix許可を広げない。loader profile参照はloadEvidence側にあり、snapshotを共有しても各applicationの実体・profile照合は別に必要。

MCPはboundary内snapshotと構築artifactだけを再検証し、保存した外部pathをたどらない。snapshotは解決のために実行する入力ではなく、既に実行された元load artifactを作者信頼で記録した証拠。生成outputとしてcapturePhaseを記録し、評価前source baselineと混同しない。after-applyでの初回hashをload時にも同じだったことの独立証明にはしない。

#### 11.3.2 directory snapshotの捕捉・digest・保存

1. export側は承認rootとCodeSourceからdirectoryを確定し、rootと全path成分のsymlinkを拒否してから再帰列挙する。entryは全directory（空directoryも含む）と全通常file。root自身は暗黙のdirectoryとしentryに入れない。file／directory以外、重複path、fileとdirectoryの衝突を拒否する。
2. directory相対pathは有効なUTF-8、区切りは/、先頭/・空成分・.・..・逆slash・colon・制御文字は禁止。各pathはUTF-8で4,096 byte以内、深さ64以内。名前の大小文字・Unicode正規化・日本語・空白を変更しない。各fileは安全なopenとopen前後のidentity／size・更新状態検査で捕捉し、内容をhashしながらblobへコピーする。
3. manifestのstrict schemaはsnapshotVersion:1、kind:directory、digestAlgorithm:sha256-tree-v1、treeDigest、entries。entryは{kind:directory,path}または{kind:file,path,size,sha256}のunion。directoryにsize／sha256は付けず、fileのsizeは0以上4 MiB以下のsafe integer、sha256は小文字hex64桁。全祖先directoryをentriesへ含め、file祖先や同名衝突を拒否する。JSON重複key・未知fieldも拒否する。
4. treeDigestはJSONの表示順やserializerに依存させない。UTF-8 path byteの辞書順でentryを一意に並べ、ASCIIのOSV-MCP-DIRECTORY-SNAPSHOT-V1と末尾NUL、entry数のuint32 big-endian、各entryのkind byte（directory=0、file=1）＋path長uint32 big-endian＋path bytesを順に連結する。fileだけは続けてsize uint64 big-endian＋sha256の生32 bytesを付け、その全体のSHA-256を小文字hexで表す。manifestはこの順でentriesを保存し、並び違反を黙って補正しない。
5. file内容は同じsnapshot containerのblobs/<sha256>へ保存する。論理pathをblob取得pathへ展開せず、同じ内容の複数fileは一blobを共有できる。manifestには各fileを別entryで残す。異なる内容が同じdigestを名乗る、sizeが合わない、blobが欠ける場合は拒否する。
6. 64 MiBの共有plugin読取予算にsource・列挙fileのhash／コピー・再照合を算入し、各file4 MiB、entry数10,000（directoryも数える）、manifest4 MiB、深さ64、既存work予算を維持する。構築出力・runtime snapshot・readerの各実行段階でそれぞれ予算を守り、実際の再読取も算入する。取得エラーや予算超過を記録済みfileのsubset検証へfallbackしない。
7. 固定prefix内の専用一時containerへmanifestとblobを作成し、再列挙して集合／hash・コピー前後の元treeを検証した後にcontainerをatomicに公開する。公開済み同digest containerがあれば内容を検証して共有し、検証せず上書きしない。manifestだけ先に公開しない。途中失敗は未公開の一時物だけを片付け、既存containerと既存companionを維持する。複数snapshotの完了後にだけgraph companionをatomic writeする。

同じsource／runtimeを共用するapplication間ではcontent digest単位でcontainerを共用できるが、公開実体・捕捉phase・loader profileのapplication固有記録は共用しない。二回の列挙間で変更して復元する等、観測不能な変化は新policyの不変表明に含まれ、独立検出を保証しない。

#### 11.3.3 MCPのdirectory再検証と採用

readerはmanifestPathが固定prefix・invocation・treeDigestから一意に定まる場所であることを確認し、boundary内で安全に読む。実containerの全entryを列挙し、manifest.jsonとblobs/およびmanifestが要求する一意なdigest blobだけがあることを検証する。symlink、余分なblob／file／subdirectory、欠けたblob、特殊fileは不正。論理pathは比較用dataであり、ファイルを開くpathとして使用しない。

strict schema・path・祖先・entry順・上限を検査し、全blobの現在bytesのsize／hash、manifestから再計算したtreeDigest、runtimeSnapshotRefのdigest、container名を全て照合する。manifestのdigest記載だけを信じず、同一blobもcache済みbytesと対応を確認する。manifest／blobのどちらかが変わった、読めない、snapshotが欠落した場合は影響graphを採用しない。

構築側directory inventoryも同じsha256-tree-v1で再捕捉し、runtime側の全entry（directory構造とfileのpath・size・hash）と一致して初めてdirectory-content-exact。構築側の現在の未記録追加・削除・内容変更も拒否する。構築JARとruntime directory等の異種比較は初期未対応とし、勝手にclassだけの比較へ縮退しない。empty treeは表現できるが、descriptor／entrypoint・lineageの別gateを満たすpluginとしては採用しない。

strict policyのdirectory CodeSourceは、このcontainerを必須にせず、boundary内の準備済みproducer directoryとdirectLoadEvidenceを直接照合する。新policyはdirectory containerと承認loader profileを必須にする。どちらも元のsource-pathをdeclared_inに保持し、snapshotやblobを宣言元として返さない。

load時の元artifact不変・承認runtimeがそのartifactに正しく由来するclassを定義／変換したことは、新policyの表明である。raw／entry一致はその信頼対象を限定する観測であり、変換後の実行class bytes一致の証明ではない。sourceや構築入力は従来どおり評価前捕捉必須で、元artifactの初回観測を理由にlate captureを許さない。

§5の4 MiB/件・64 MiBのplugin読取予算、10,000 entry、共有work予算を維持する。JAR圧縮bytes、展開してhashするbytes、directory、snapshotの再確認を共有予算へ算入し、archiveをディスクへ展開しない。toolchainの大容量予算へplugin artifactを逃がさない。予算超過・コピー途中失敗はcomplete扱いにせず、公開companionはatomic writeまで更新しない。export後にsnapshot／構築出力が変更された場合もstale。

### 11.4 precompiled pluginの二段階登録

scriptのthisをPluginとして渡すbeginPlugin案はprecompiledには使わない。以下は未実装のhelper API案。

```text
preparePluginApplications(targetProject, preparedContract)
  -> install after-apply observers; no plugin application or source execution
beginPrecompiled(targetProject, pluginSpecId, sourceMappingId)
  -> PendingPluginHandle(applicationId, registrationSessionId)
pluginSource(pendingHandle, sourceMappingId) -> prepared SourceHandle
add / addProvider / addProviderConvertible / addCatalogLibrary / addCatalogBundle
  -> record an attempt before normal delegation
endPrecompiled(pendingHandle, outcome: complete | failed) -> close the explicit registration block
finalizePluginApplications(targetProject) -> resolved evidence or incomplete reasons
```

1. root init／beforeProjectの実証済み早期段階で、manifestの対象projectとplugin IDごとに[PluginManager.withPlugin](https://docs.gradle.org/current/javadoc/org/gradle/api/plugins/PluginManager.html)を設置する。このcallbackは適用後の照合用で、追加時刻の観測には使わない。callback引数AppliedPluginはPlugin実体ではない。
2. 元precompiled scriptの最初の登録対象文より前にbeginPrecompiledを明示する。scriptのthisを渡さず、事前準備済みsource mappingを選ぶ。sourcePathは元.gradle／.gradle.kts、scopeは対象consumerへ固定する。呼出しがその元scriptから行われることはprecompiled-registration-source-reviewedの作者表明であり、IDやcallbackから独立証明したとはしない。
3. pending handleでも試行ID・source・application参照を委譲前に確保する。Provider／bundle callbackがendより後でも同じ台帳へ記録し、早期get／map／追加asProviderを行わない。endは明示block終了と呼出し側が報告したoutcomeだけを示し、plugin適用成功や全Provider実現の意味ではない。元例外をcatchして再throwする経路ではfailedを記録してからendを完了させ、collector自身の記録失敗だけで元例外を置換しない。
4. after-apply callbackで[PluginContainer.findPlugin(id)](https://docs.gradle.org/current/javadoc/org/gradle/api/plugins/PluginContainer.html)から実体を取得する。既に適用済みなら公開APIの即時callbackを扱うが、observer設置前の適用やbeginより先に確認した適用はpreexisting-applicationとして不完全にする。beginのない過去試行を後から復元せず、callback後にbeginを呼んでも遡及的に正常化しない。nullならpendingのまま保持し、projectsEvaluatedの最終照合でも取得不能なら不完全。照合のためにapply・getOrCreate・新instance生成をしない。
5. publicに取得したPluginの実装classを、producerが生成して捕捉したMETA-INF/gradle-plugins/<id>.propertiesのimplementation-class、pluginSpec、producer receiptへ照合する。descriptorはduplicate key等を厳格に検査し、source→descriptor／生成entrypointの対応は作者がレビューしたmappingに限定する。ファイル名から生成クラス名を推定せず、script classと生成wrapper classの同一性も要求しない。未知decoratorをsuffix除去等で一致扱いにしない。
6. §11.2〜3のapplication固有loadEvidenceを完成させる。単なるplugin IDの存在ではresolvedにせず、実体・entrypoint・lineage・source mapping・全試行被覆・runtime trustをANDする。すべて満たした後にのみ候補となる。precompiledのpending登録は新trust値v2を必須とし、旧v1だけでは採用しない。

applicationのidentityはinvocation＋consumer project＋解決済みproducer/pluginSpec。registrationSessionはそのapplicationで実行した明示blockに付くIDで、plugin本体のapply呼出し回数を推定する値ではない。初期は一source entrypointにつき一begin/endを必須とする。重複begin、別project・別producerのhandle、再入による曖昧さ、期待entrypointの未開始・未終了は不完全。同一実体へ対応する複数plugin IDのcallbackは、manifestが同一specのaliasとして列挙した場合だけidempotentに併合する。異なる実体やproducerへ変わった場合はinvalid。

precompiledのplugins blockがbodyより先にchild pluginを適用する場合、childの過去試行をbegin後の台帳へ移さない。childが自身の準備済み登録契約で全追加を記録すれば別applicationで対応し、未登録なら関連scopeを不完全にする。helperへの委譲は既存handleの承認済みsourceMappingsだけを使う。元例外はそのまま維持し、helperが観測したAction失敗・failed outcome・未終了blockはcatchして継続しても不完全とする。script内部で隠された任意の例外まで独立に検出する保証にはしない。

### 11.5 buildSrc・独立plugin・完全性

| 対象 | 必須対応 |
| --- | --- |
| buildSrc binary／precompiled | 起動前のsource／構築入力捕捉、producer側compile→artifact receipt、consumer固有の実体照合。buildSrcだからroot script扱いにはしない |
| included build-logic／境界内独立checkout | 別build identity・同一export invocation・独立receipt。名前やplugin IDだけでbuildSrcと併合しない |
| 発行済みbinary／source JAR／境界外checkout | 新loader trustがあっても従来どおり未対応。ローカルsourceから同一exportで構築したというgateは免除しない |
| class直接適用、未知wrapper／独自loader、settings plugin | ID付きの初期precompiled方式では不採用。独立に実証した別adapterなしに自動fallbackしない |

完全性の判定は次の順序に固定する。

- graph gate: 共通の事前source／input・構築lineage・構築artifact・toolchain profileを検証し、§11.1.1のpolicy固有証拠を追加検証する。strictはdirectLoadEvidenceとprepared出力だけ、新policyはjar／directory snapshotの全内容対応とloader profileの許可・構成比較を必須にする。不一致・未承認・取得不能は影響graphを採用しない。範囲不明なら全文書不採用。lock由来の脆弱性coverageはこのmetadata制限だけでは下げない。
- declaration gate: graphが有効な場合に、helper／plugin／catalogの必要trust、全source mapping表明、pending解消、session終了、scope継承、同期・Provider・bundle全IDとapplication逆参照、既存key／shape・edge bindingを検証する。出自／登録だけ不足ならgraphのrelation・introduced_byを保持し、宣言元一覧を全省略する。
- aggregate gate: 同じGAVのscript＋plugin混在、複数context／lockを既存の完全性ANDで併合。scriptだけの部分一覧を返さず、context順に依存しない。非使用を確認したscript単独scopeには不要なplugin trustを要求しない。

そのpolicyに必要なprofileが許可されていてもconsumer plugin trustが無効なら宣言元は省略し、必要なprofile／artifact検証は省略しない。strictに不要なloader profileの状態を伝播させない。新policyが必要なのに旧trustしかない場合、input_statusが有効でもplugin_trust_status=disabled_for_required_policyと診断する案。未知policyはunverifiable、出自の不一致はinvalid、pending未解消／表明不足はmissing_assertion、採用時は上記のattested assuranceを明示する。いずれもdeclarations_completeのANDを緩めない。consumer設定そのものが無効ならplugin_trust_status=disabledを優先し、有効な設定の集約順はinvalid > unverifiable > disabled_for_required_policy > missing_assertion > acceptedとする。applicationごとのload assuranceを保持し、strictとattestedが混在した最上位assuranceはattestedへ揃える。入力状態の失敗は別fieldにも必ず残し、disabledで隠さない。

契約v3／graph v3／adapter v5は未実装の予約案なので、本節の必須loadPolicy、policy別に必須／禁止となるprofile・snapshot参照、session／loadEvidenceをそのstrict schemaへ統合する。既存v1／v2契約や本番v2〜v4 adapterを拡張済みとは扱わない。policy・scope・profile・source mappingから必要性を判定し、空entry、空record、旧adapter／旧trustへの変更やscript origin化でv2信頼を回避できないようにする。未採用flagを単に削除して陽性にしない。

### 11.6 追加回帰条件（未実行）

Groovy／Kotlin consumer × Gradle 8.11.1／9.2.1を基本行列にし、producerのbuildSrc／included、binary／precompiledを区別する。まずJava binary・既存Groovy precompiledで垂直に実証し、Kotlin precompiledと標準kotlin-dsl経路も別途実証する。対象外をskipして全形成功としない。

| ID | 条件 | 必須確認 |
| --- | --- | --- |
| CP37 | strict旧policyとapproved-loader新policy、旧／新／無効／未知trust | policy別の必須fieldを検証。strict binaryはtoolchain承認＋旧trust・loader profile未設定で候補化、新policyは旧trustだけで採用しない。precompiled-pendingはstrictでも新trustが必要 |
| CP38 | toolchainのみ承認、loaderのみ承認、profile改変／版だけ一致 | strictにloader profileを要求せず、新policyでのみ両profileを独立に要求。自己承認・必要profileの不一致で影響graph不採用 |
| CP39 | 公開CodeSourceのJARとproducer JARのraw完全一致 | 全内容・application固有load証拠を確認し、新policyの候補に進める。実行bytesの独立証明と表示しない |
| CP40 | ZIP順序／timestamp／圧縮だけ変更、内容集合は同じ | 全file entry照合でentry-content-exact。classだけの比較で成功しない |
| CP41 | manifest／descriptor／resource／service／classの一件だけ変更 | raw hash不一致をenvelope差へ丸めず、graph不採用 |
| CP42 | duplicate entry、未知encoding、path曖昧、圧縮膨張・過大archive | bounded parserで拒否。JAR展開・実行・無制限readなし |
| CP43 | directoryの未記録追加・削除・内容変更、snapshot欠落 | strictの直接参照と新policyのdirectory containerを区別し、全tree／blob検証で拒否。既存修正を維持 |
| CP44 | 境界外runtime artifactのapproved root内／外、symlink、非file URL | export側だけに限定。MCPはboundary内snapshotだけを読み、JSONの外部pathをたどらない |
| CP45 | after-applyの初回観測、load前後のartifact変更／復元、未登録agent・loader | 観測可能な不一致は拒否、復元等の未観測分はattestation限界を表示。検出できたと偽らない |
| CP46 | 同じproducer／digestを二consumer・異なるclassloaderで使用 | 各applicationの実体・loadEvidenceが必須。片方だけ未確認なら両方acceptedにしない |
| CP47 | precompiled beginがcallbackより前／後、既適用の即時callback | 正常なbegin先行だけを適用後照合で解消。callback先行・既適用への遅い登録は不完全とし、後付けbeginで正常化しない |
| CP48 | script thisとPlugin実体が異なるGroovy／Kotlin precompiled | this同一性を要求せず、公開実体＋捕捉descriptor＋作者mappingで対応。未知なら未採用 |
| CP49 | withPluginのAppliedPluginを実体と取り違える、findPlugin=null | 生Pluginを取得するまでpending。callback発火だけで成功しない |
| CP50 | 同じplugin IDの別producer／別implementation、descriptor偽装 | 実体class・descriptor・receipt・source mapを全照合し、名前だけ一致では拒否 |
| CP51 | 同一specのalias二通知と、別実体への差替え | 正当aliasはidempotent、別実体はinvalid。再applyしない |
| CP52 | 重複begin／未begin／未end、例外捕捉して継続、未知decorator | 不完全を保持。元のAction／apply例外の振舞いを維持 |
| CP53 | end後のProvider／bundle callback、未使用Provider、部分Action失敗 | IDを委譲前確保し全memberを保持。評価時刻・supplier回数を通常経路から変えない |
| CP54 | precompiled plugins blockが先にchild pluginを適用 | childは別applicationの独立台帳。未登録追加をparentのsourceへ付け替えない |
| CP55 | Providerのscript化・ID欠落・逆参照削除、pending Provider | 同期と共通の双方向被覆で拒否。pending確認のため追加評価しない |
| CP56 | script／plugin同値依存、別scopeのscript単独、context順逆転 | 完全時だけ和集合、片方不足は全一覧抑制、不要なtrust要求と順序依存なし |
| CP57 | 空load inventory・session省略・adapter downgrade・旧trustへ変更 | 契約から必要性を判定し拒否。未知schemaを従来sourceとして採用しない |
| CP58 | buildSrc／includedの同名project・別invocation receipt流用、発行済みplugin＋source JAR | identityと同一構築実行を検証し拒否。新loader profileでも免除しない |
| CP59 | snapshotの途中失敗・後変更、予算超過、多context再参照 | atomic publication・旧companion維持、共有cache／予算の境界を確認 |
| CP60 | 新policy採用候補／無効／表明なしの3ツール実接続（本番実装後） | declared_in／assurance／limits／coverage、候補OSV再照会、入力不変・MCP中ビルド非起動を確認 |
| CP61 | strict binaryの正常証拠、loader profile未設定／不正設定、新trust選択の有無 | 不要なprofileの状態でstrict graphを拒否しない。新policy固有fieldをstrictへ混入した文書は拒否 |
| CP62 | strict precompiled-pending、toolchainのみ承認、旧／新trust | loader profile不要のまま、新trustなら登録gateの候補、旧trustなら宣言元だけ不採用。graphまで誤って失効させない |
| CP63 | strict／attested混在、片側だけloader profile不足、同一GAV／独立scope、順逆 | 必要性をapplication単位で判定し、独立strict graphは保持。同一GAVの不完全一覧は全省略 |
| CP64 | 正常なdirectory container、空file・空directory・同一blob共有、日本語／空白path | 全tree digestとblobを再計算して新policyのdirectory採用候補へ進める。declared_inは元sourceのみ |
| CP65 | runtime manifest／blob・構築directoryの追加・削除・内容変更、snapshot欠落 | file集合だけでなく全treeを再照合しgraph不採用。copy元pathをMCPから再読取しない |
| CP66 | blob欠落／余分なblob、file/dir衝突、祖先欠落、順序違反、digest・size偽装 | strict schemaとcontainerの実集合・現在bytesを照合し拒否。jar／directory用fieldの混入も拒否 |
| CP67 | symlink、特殊file、深さ／entry／byte予算超過、異なるserializer | 安全に拒否し、同じentry treeは仕様化したbinary encodingで同じdigest。Unicodeやcaseを勝手に併合しない |
| CP68 | コピー途中失敗、manifest先行公開、既存同digest container不正、contextで共有 | 不完全containerを公開せず旧companion維持。共有storageとapplication固有load証拠を区別 |

完了順は契約レビュー→CP37〜59およびCP61〜68の公開API／artifact照合の実証→成立した形だけの本番schema／adapter／reader→CP60とする。§10で得たclass hash一致だけをCP39〜41の全artifact照合へ流用しない。今回追加したのは契約と条件であり、既存の実証データは変更せず、本番の未採用判定も維持する。


## 12. 改訂したload信頼・二段階登録の公開API実証（2026-10-31）

§11の契約を本番とは独立したtest-only exporter／検証器で実証した。明示承認された `approved-gradle-loader-v1` は32 fixtureで宣言元の採用候補になった。これは作者・運用者のruntime／変換表明を信頼した結果であり、実行中の変換済みclass bytesを独立観測した証拠ではない。実runtimeの `prepared-output-only-v1` は変換不明のため全件不採用を維持した。この実証harnessは変換を観測する公開APIを持たないため、strict証拠のunverifiedTransformを常にtrueとして渡す。strictの不採用は観測による否定ではなく、この前提による結果である。strictの正常証拠・loader profile不要という判定はsynthetic policy回帰で確認しており、実runtimeのstrict陽性実証とは区別する。本番schema／adapter／reader、MCP設定の採用は有効化していない。

### 12.1 構成と公開API

Gradle 8.11.1／9.2.1、Groovy／Kotlin consumer、buildSrc／独立included build-logicを組み合わせた。各producerでbinary Java・binary Kotlin・precompiled GroovyのJARを確認し、binary Javaではdirectory runtime artifactも追加した。計16 fixture／版、32 fixtureとなる。Kotlin binary producerは同梱K2コンパイラを公開JavaExecで実行する制御fixtureであり、標準Kotlin Gradle plugin／kotlin-dslやprecompiled Kotlinの実証は含まない。

precompiledは評価前に `PluginManager.withPlugin` のobserverを準備し、script側のbeginでpending登録、endで結果を記録する。適用後callbackで `PluginContainer.findPlugin` から実Pluginを取り、生成descriptorのimplementation-classと照合した。scriptの `this` をPlugin実体へ代用しない。同期追加とProviderを共通台帳で保持し、通常・棚卸し・登録のgraph／Action／Provider評価を比較した。lazy Providerは各1回、未使用Providerは0回で一致する。遅いobserver、未終了、明示failed outcomeの計96 sessionはgraph入力を保持して宣言元を不採用とした。任意の例外を投げた場合の動作保存までは実証していない。

起動前にtoolchain profileと独立したloader profileを承認し、実際のJDK version・明示agent引数・artifact内容を照合する。後から観測した結果を自動承認する方式ではない。ただし、これは制御fixtureのprofile準備であり、本番の承認配布・全startup設定検証・動的agentや未知classloaderの完全な棚卸しを実装したものではない。

### 12.2 artifactとdirectory snapshot

公開Sync taskとruntimeElementsのoutgoing directory artifactを使い、buildSrc／included双方で実際のdirectory CodeSourceを得た。directoryはJARに変換せず、全file／directory（空directoryを含む）の順序付きtree、内容addressed blob、strict manifestとして境界内にatomic保存する。readerは保存済みcontainerだけを読み、元runtime pathを追わない。全entry集合・祖先・size・hash・blob過不足を再検証する。`sha256-tree-v1` のbinary encodingには独立Python計算のgolden vectorを追加した。

JARはraw SHAとZIP全file内容を別途照合する。manifest、descriptor、service、resourceも対象とし、class hashだけで採用しない。directory blobの変更・削除・追加とJARの変更を実保存先で行う48対照は全件拒否し、復元後の再検証も成功した。予算超過、symlink、不正path、重複JSON、tree順序／祖先不正、不完全な既存container、atomic公開前の失敗は単体回帰でも確認する。

directory runtime artifactの8件では、公開CodeSourceのload元が準備済みの `plugin-image` directoryそのものだった。同じ実体をビルド終了後に2回読む比較は失敗し得ないので、内容一致とは数えず `same-path-origin` として記録する。load時点の内容は捕捉していない（`plugin_directory_snapshot_post_build`、`plugin_directory_origin_same_path_not_compared`）。load元が別directoryの場合だけtree digestで `directory-content-exact` を判定し、その分岐は単体回帰で確認する。policyは比較種別をartifact種別へ束縛し、JARにdirectory比較、directoryにJAR比較を使う証拠を拒否する。

classpathは従来どおりビルド終了後のsnapshotであり、compile時点の完全inventoryではない。途中だけの変更や復元された変更は検出できないという `plugin_classpath_transient_changes_not_detectable` を保持する。新policyでもこの制限を解消したとは扱わない。

### 12.3 回帰・検証データと再現

- 実Gradle: 各版280件成功（32 fixture合計）。新policy候補32件、strict実runtime候補0件。directory 8件、JAR 24件。
- snapshot／policy／JAR単体: 53件成功。通常全体: 1,684件成功、opt-in等555件skip。typecheck・build成功。
- 実証ハーネス: [pluginLoad.integration.test.ts](../src/test/gradle/pluginLoad.integration.test.ts)、[test-only exporter](../src/test/fixtures/gradle-plugin-load.init.gradle)。単体は同directoryのpluginLoadSnapshot／pluginLoadPolicy／pluginJarContents.test.ts。
- 検証データ: [gradle-plugin-load-2026-10-31.json](validation/gradle-plugin-load-2026-10-31.json)。baseline 6460ad4からの追加で、source hash・承認profile・構成別観測と判定を保存する。旧実証JSONは変更しない。保存物は観測値とmanifest entryであり、runtime blobの配布archiveではない。一時fixtureのcontainerはテスト終了時に削除し、再実行で再生成する。

準備済みJDK／Gradle cacheで次を各Gradle版について実行する（実証はoffline、configuration cache／並行実行無効）。

```sh
env OSV_MCP_TEST_GRADLE=/trusted/gradle-8.11.1/bin/gradle \
  JAVA_HOME=/trusted/jdk-21 GRADLE_USER_HOME=/trusted/prepared-gradle-cache \
  OSV_MCP_GRADLE_CONVENTION_OUTPUT=/tmp/plugin-load-proof \
  npm test -- src/test/gradle/pluginLoad.integration.test.ts
npm test -- src/test/gradle/pluginLoadSnapshot.test.ts src/test/gradle/pluginLoadPolicy.test.ts src/test/gradle/pluginJarContents.test.ts
```

次はこの実証のレビュー後、成立した形に限定した本番schema／adapter／静的readerへ進む。CP37〜CP68全条件の本番完了ではない。precompiled Kotlin、標準kotlin-dsl、compile開始時のclasspath捕捉、未知loader、plugin内部catalog、nested child／alias、configuration cache・並行実行は残る。CP60の3ツール／OSV実接続は本番実装後に別途行う。


### 12.4 実証レビュー後の修正・再検証

重複beginでは、同じplugin ID／sourceの先行sessionと新sessionの両方にregistrationUnique=falseを保持する。先行sessionが既にcompleteで終了していても解除せず、両方をendした後も宣言元は不採用とする。graph入力と通常の依存追加は保持する。binary Java／Kotlin、precompiled Groovyの実producerから「開始中の重複」「終了後の再開始」を呼ぶ対照を各fixtureへ追加した。

load元の最初の観測はafter-apply callbackではなく検証taskのreport処理なので、loadObservationPhase=verification-taskと記録する。JAR snapshotも同task内の取得としてsnapshotCapturePhase=verification-task、directoryはGradle終了後のNode側取得としてsnapshotCapturePhaseとDirectoryRef.capturePhaseをpost-buildにした。after-applyはPlugin実体を解決するcallbackの時刻だけを意味し、そこでartifactを捕捉したとは記録しない。全applicationについてphaseの回帰を追加した。snapshotの保存／再検証がload時不変の独立証明ではない制限は維持する。

修正前の対象native回帰3件が失敗することを確認した後、修正後の同3件が成功した。両DSL・両producer種別を含む全32 fixtureをGradle 8.11.1／9.2.1で再実行し、各280件を確認した。検証JSONは今回のsource hashと再実行観測へ更新し、重複sessionの拒否と実際の取得phaseを保持する。

### 12.5 06aa8f3レビュー後の修正

1. directory artifactのload元と準備済み出力が同じpathの場合は `same-path-origin` とし、`directory-content-exact` と区別する。上記2件のlimitationを必須表示する。loader-attested policyでの候補化は維持するが、内容比較の証拠には数えない。別pathの一致・不一致は単体回帰で判定する。
2. 証拠に `artifactKind`（jar／directory／unavailable）を追加し、比較種別との組合せが不整合ならplugin_load_inputs_unverifiableとする。
3. snapshot単体回帰は拒否理由まで検証する。manifestの順序不正は兄弟entryの入替えで祖先検査を通した上でsnapshot_entry_orderを確認し、宣言sizeとblobの不一致は自己整合したmanifest・digest・containerを作ってsnapshot_blob_mismatchを確認する。修正前の順序／size対照はそれぞれ祖先欠落・digest不一致で拒否されており、対象の検査を通っていなかった。

修正後、Gradle 8.11.1／9.2.1とも280件成功、snapshot／policy／JAR単体60件成功。directory 8件はsame-path-originで、JAR 24件の比較結果は変わらない。更新後のsource hashと判定は検証JSONのpostReviewRevisionに記録した。


## 13. 本番adapter・静的取込（2026-11-01）

公開API実証に続き、contract v3／graph schema v3／adapter v5を実装した。設定・完全なmanifest例・profileのfield・起動／export手順は[利用手順](GRADLE_CONVENTION_PLUGIN_USAGE.md)。旧v1／v2契約、adapter v2〜v4の意味は維持する。

- 本番の独立plugin-provenance init scriptがmain評価前baseline、producer評価前の一致、同一invocationのcompile／package receipt、全出力とclasspath分類を捕捉する。承認toolchainの実bytesをstreamingで構築前後に照合し、実際のJDK bin/java・lib/modules・releaseとの対応を必須にした。loader profileは別承認で、公開VM引数のagent構成・Gradle／JDK identityと比較する。
- binary-instanceとprecompiled-pendingの二段階helperを公開extensionへ実装。適用前observer、適用後の実Plugin、descriptor、source mappingを照合する。sessionはopaqueなidentity handle、重複beginは終了後の再開始も不完全に固定する。configure Action失敗はcatchして継続・end completeとしても復旧しない。
- load元観測とsnapshot取得はexport-task。元JAR bytes、directoryの完全tree／空directory／共有blobを固定prefixへatomic保存し、既存containerの不一致・途中失敗ではcompanionを更新しない。source／snapshotのexport側読取はbuild間で共有する64 MiB／10,000 entry予算、toolchainは別のstreaming予算を使う。
- 静的readerはboundary内だけを安全に読み、source・構築出力・snapshotの現在bytesと集合を再検証する。JAR全file内容の比較では許可したZIP envelope差だけを無視し、未知prefix／隙間も拒否する。toolchain／loader profileの承認は起動時固定の別集合。strictには不要なloader設定を伝播させない。生runtime pathはMCPへ渡さない。
- adapter v5の同期／Provider記録にscript／pluginのoriginとapplication逆参照を持たせる。既存key／shape、scope継承・保持実体・全追加試行の被覆とANDし、片方が不完全な同一GAVはscript部分だけを返さない。context順序でも結果を変えない。plugin consumer trustが無効でもhelper自体の信頼状態は保持し、plugin_trust_statusへ別途表示する。

metadataはcontext別plugin_trust_statusとapplicationのload_policy／input_status／trust_status／source_artifact_status／transform_status、最上位assurance・limitationsを返す。外部由来のapplication IDは内部照合時には変更せず、返却時だけ不可視文字を除去する。入力の検証不能は影響graph不採用、出自・sessionだけの不足はrelation／introduced_byを保持して宣言元一覧を省略する。脆弱性coverageはmetadata不足だけでは下げない。

### 13.1 対応範囲・独立した未対応gate

本番の実行検証はbuildSrc／included root producer、Groovy／Kotlin consumer、Gradle 8.11.1／9.2.1、binary Java／明示K2 JavaExec binary Kotlin／precompiled Groovyを対象とする。Java・Groovy precompiledはJAR／directory両方、Kotlin binaryはJARで確認した。新policyのassuranceは作者・運用者のruntime／変換表明を含み、実行bytecodeの独立観測ではない。実runtimeのstrict policyは未確認変換の拒否を維持し、strict陽性はsynthetic分類だけとする。

precompiled Kotlin、標準kotlin-dsl／Kotlin Gradle plugin、発行済み外部plugin、plugin ID alias、producer子project、plugin内部catalog／bundle、configuration cache、並行exportは未採用。classpathのcompile開始時完全inventory、復元された一時変更、全native library／動的agent／未知loaderの独立棚卸しも保証しない。MCP用のprofile自動取得／自動承認は追加せず、利用者が事前に準備・確認する。3ツール・OSV実接続は本番レビュー後の別作業。

### 13.2 検証・回帰

本番のpluginExporter.integration.test.tsは、通常16構成（2 consumer DSL×2 producer×2 form×2 artifact）にKotlin binary 4構成、重複session、Provider、Action失敗、誤ったJDK対応付けを加えた。信頼無効／旧trust／profile不足、出自・session・classpath・descriptorの改変、入力・snapshot・構築出力の実disk変更を検証する。static-onlyの回帰はpolicy別のfield禁止、起動時設定、完全性・context順序、snapshot／ZIPの境界・予算を確認する。

再現はOSV_MCP_TEST_GRADLE、JAVA_HOME、準備済みGRADLE_USER_HOMEを指定し、対象testを実行する。OSV_MCP_GRADLE_PLUGIN_OUTPUTを指定するとnative exportの観測JSONを保存する。検証用fixture／blobは終了後に削除し、再実行で再生成する。検証結果・source hashは[gradle-plugin-production-2026-11-01.json](validation/gradle-plugin-production-2026-11-01.json)に記録する。旧公開API実証のJSONは変更しない。

```sh
env OSV_MCP_TEST_GRADLE=/trusted/gradle-8.11.1/bin/gradle \
  JAVA_HOME=/trusted/jdk-21 GRADLE_USER_HOME=/trusted/prepared-gradle-cache \
  OSV_MCP_GRADLE_PLUGIN_OUTPUT=/tmp/plugin-production \
  npm test -- src/test/gradle/pluginExporter.integration.test.ts
```


検証結果: Gradle 8.11.1／9.2.1の本番native回帰は各280件成功。既存C1a／C1b／catalogのnative互換回帰は各44件成功。通常全体は1,763件成功・835件skip、plugin関連のstatic単体は72件成功（文書回帰を含め73件）。typecheck・build・package dry-run・diff checkも成功した。各版23件のexport観測（計46件）を記録し、誤JDK profileは各版1件でexport拒否を確認した。配布対象の3 init scriptと新しい静的readerがpackageに含まれることを確認した。


### 13.3 本番レビュー後: 再exportとsame-path directoryの修正（2026-11-01）

1. task終了時のreceiptは、そのtaskの宣言出力へ対応するoutputRootsだけを捕捉する。存在する全rootを一律に記録すると、compile時の前回JAR／plugin-imageとpackage後の今回出力が同じinvocationに混在し、正常な再exportがplugin_artifact_staleになるため。ProcessResourcesの出力も独立に記録し、resourcesの鮮度確認を省略しない。
2. exporterがdirectoryの公開CodeSourceと準備済み出力のcanonical pathを比較してoriginRelationを記録する。same-path-originとdistinct-path-originを区別し、JARはnull限定。readerはkindとの整合を検証し、現在bytes／treeの再検証後のcomparisonをmetadataへ返す。同一pathの候補にはplugin_directory_origin_same_path_not_compared、directoryの事後捕捉にはplugin_directory_snapshot_post_buildを追加する。same-pathの採用は明示的loader trustの下で維持するが、独立した内容比較とは扱わない。

修正前の再exportと必須limitation確認の回帰が失敗することを確認した。再exportではsourceの実classを変えるmarkerを追加し、同じbuild directoryで改めてexport／静的取込する。Groovy／Kotlin consumer、buildSrc／included、binary Java／Kotlin・precompiled Groovy、JAR／directoryの対応構成で確認する。distinct directoryの一致／不一致、originRelationの欠落・null・未知値・JARへの混入もstatic回帰へ追加した。検証JSONはinitial／reexportの両観測と、各静的取込metadataへ更新する。


再検証結果: Gradle 8.11.1／9.2.1とも各328件成功。各版20 projectでsourceと構築artifactの両方を変更して同じbuild directoryから再exportし、relation／declared_inの採用を確認した（計40再export）。initial 46件＋reexport 40件の計86観測を保存し、source hash、異なるinvocation、変更されたartifact、静的取込metadataを照合した。directoryの32観測はsame-path-originで、両必須limitationsを確認。distinct directoryの一致／不一致はstatic回帰で確認したもので、nativeの別path実証とは扱わない。

通常全体は1,770件成功・883件skip、plugin static単体79件（文書回帰を含め80件）、typecheck・build・diff checkも成功。先行検証の既存adapter native各44件は今回再実行していない。旧観測のsource hash・集計は検証JSONのpreReviewへ残し、最新観測・結果をrootとpostReviewRevisionへ更新した。本番3ツール／OSV実接続は引き続き未実施。

### 13.4 4e01d11レビュー後: profile未承認の扱い（2026-11-01）

toolchain／loader profileの未承認は、入力の鮮度ではなくconsumer側の信頼設定である。catalog信頼・未対応modelと同じく宣言元だけを省略し、検証済みのrelation／introduced_byは保持するよう改めた。理由はplugin_toolchain_not_approved／plugin_loader_not_approved、plugin_trust_statusはdisabled_for_required_policy（trust無効ならdisabled）。profileの構造、receipt、runtime identity、構築入力・出力・snapshotのhashは未承認でも従来どおり検証し、不一致はgraphを不採用にする。applicationとspecのloader profile不一致はplugin_loader_profile_mismatchとして入力不一致に残す。全設定未指定の既定状態でもrelationを保持する回帰を追加した。

同じレビューで、src/test/gradle全体をGradle 8.11.1で実行した際に同一project再exportの回帰が既定30秒のtest timeoutで間欠的に失敗した（単独実行では成功）。再exportとfixtureを伴う個別回帰は完全なGradle buildを実行するため、fixture exportと同じ210秒の上限を明示した。採用判定・期待値は変更していない。


## 14. 標準kotlin-dsl／precompiled Kotlinの追加設計・実証

[専用設計書](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md)へ、標準KotlinCompileの公開API、元script→生成adapter→compile→descriptor→load元の対応、toolchainと派生classpath入力の責任分離、本番向けの追加pipeline信頼・完全性条件を整理した。実証はtest-onlyであり、§13の本番schema／対応範囲を拡張しない。既存の明示JavaExec binary Kotlin、precompiled Groovyの結果と区別する。
