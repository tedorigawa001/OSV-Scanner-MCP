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

compile classpathに含まれるproducerの生成classes directoryはtoolchainへ昇格しない。レビュー修正後は実ディレクトリを列挙して現在の全ファイル集合とhashを捕捉し、観測済みoutput inventoryとの完全一致を確認する。記録済みファイルだけの再hashではない。precompiled Groovyの通常fixtureにもHelper.groovyを追加してGroovyCompileを実行し、この分岐を通る陽性対照を設けた。NO-SOURCE／skipped taskのclasspathは追加実現しない。toolchain外の一般的な外部plugin依存の捕捉、全resource inventoryの攻撃耐性までは今回実証していない。

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


レビュー修正後の最終確認: Gradle 8.11.1は128件成功（113.97秒）、9.2.1は128件成功（112.45秒）。通常12 fixtureは入力・出自検証を通過し、未記録classpath resource追加の4 fixtureは入力不一致として拒否した。policy・実ディスク回帰32件を含む通常全体は1,631件成功／273件skip（計1,904件）。型チェック・ビルドも成功。plugin由来declared_inの採用は全16 fixtureで0件のまま、本番拒否を維持する。
