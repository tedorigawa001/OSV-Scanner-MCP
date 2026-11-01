# Gradle convention plugin宣言元の本番登録

設計は[GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md](GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md)。contract v3／graph schema v3／adapter v5を使う。MCPはGradle、plugin、compiler、snapshot内のclassを実行しない。構築とexportは、利用者が選んだ信頼済みbuild環境で明示実行する。

## 対応範囲と信頼

boundary内のbuildSrcまたは独立included buildのroot project（projectPath `:`）を対象とする。binary Java、同梱K2を明示JavaExec task `compileProofKotlin`で実行するbinary Kotlin、precompiled Groovyで実行検証する。precompiled Kotlin、標準kotlin-dsl／Kotlin Gradle plugin、plugin ID alias、nested producer project、外部配布済みpluginやsource JAR、configuration cache／並行実行は今回の採用対象ではない。plugin自身からのcatalog登録は不採用とし、通常scriptのcatalog登録と必要な追加catalog信頼は維持する。

| 設定（MCP起動前） | 意味 |
| --- | --- |
| OSV_MCP_GRADLE_DECLARATION_TRUST=registered-helper-v1 | 既存helper契約への信頼。plugin信頼とは別に必要 |
| OSV_MCP_GRADLE_PLUGIN_TRUST=local-plugin-build-v1 | prepared-output-only-v1のbinary登録だけに使う旧trust |
| OSV_MCP_GRADLE_PLUGIN_TRUST=local-plugin-loader-attested-v2 | loader-attested policy、またはprecompiled-pendingの追加登録契約への信頼 |
| OSV_MCP_GRADLE_PLUGIN_TOOLCHAIN_PROFILES | 承認済みtoolchain profileのSHA-256をcomma区切り、最大32件 |
| OSV_MCP_GRADLE_PLUGIN_LOADER_PROFILES | 別途承認したloader profileのSHA-256をcomma区切り、最大32件。attested policyだけに必要 |

設定は起動時固定。未設定・空のtrustは無効、未知trustは警告＋無効。profileは小文字hex64桁の重複しない集合とし、空は許可なし、不正な集合はそのprofile集合だけを無効にする。不要なloader設定の不正でstrictのtoolchain承認まで無効にしない。profileをgraphから自己承認したり、指定path／URLをMCPが読み込んだりはしない。profileの未承認はconsumer側の信頼設定なので宣言元だけを省略し（plugin_toolchain_not_approved／plugin_loader_not_approved、plugin_trust_statusはdisabled_for_required_policy、trust無効ならdisabled）、検証済みのrelation／introduced_byは保持する。applicationとspecのloader profile不一致（plugin_loader_profile_mismatch）、receipt・hash・runtime identityの不一致は従来どおり入力不一致としてgraphを不採用にする。

`approved-gradle-loader-v1`は実PluginのCodeSourceが指す元JAR／directoryと、同一export invocationで構築した全artifactを照合したうえで、承認したruntime／変換経路を作者・運用者の表明として受け入れる。assuranceはauthor-attested-loader-and-structurally-checked、source_artifact_statusはbuild-lineage-and-runtime-attested、transform_statusはtrusted-runtime-not-independently-observedとなる。実行中の変換済みbytecodeを独立観測した保証ではない。

`prepared-output-only-v1`にはloader profileを要求せず、attested用snapshot／profile fieldの混入を拒否する。ただし本番exporterは未確認変換をunverifiedTransform=trueとして残すので、今回の実runtimeではstrict policyのgraphを採用しない。strictの陽性分類はsynthetic回帰だけであり、無断で新policyへ切り替えない。

## 作者manifest

固定名 `osv-mcp-gradle-declarations.json` の例。全sourceと構築入力を明示する。outputRootsのうちplugin-artifactは一つとし、生成classes／resourcesは別roleで棚卸しする。省略した入力の完全性をcollectorが独立に推定するものではない。

```json
{
  "contractVersion": 3,
  "trustModel": "registered-helper-v1",
  "catalogPolicy": "none",
  "catalogs": [],
  "pluginPolicy": "explicit-local-build-v1",
  "sources": ["build.gradle", "buildSrc/src/main/java/proof/Convention.java"],
  "plugins": [{
    "id": "local",
    "producer": {"kind": "build-src", "rootDirectory": "buildSrc", "projectPath": ":"},
    "pluginIds": ["proof.convention"],
    "implementationClass": "proof.Convention",
    "registrationForm": "binary-instance",
    "sourcePaths": ["buildSrc/src/main/java/proof/Convention.java"],
    "inputPaths": ["buildSrc/settings.gradle", "buildSrc/build.gradle", "buildSrc/src/main/java/proof/Convention.java"],
    "outputRoots": [
      {"kind": "directory", "role": "classes", "path": "buildSrc/build/classes/java/main"},
      {"kind": "directory", "role": "resources", "path": "buildSrc/build/resources/main"},
      {"kind": "jar", "role": "plugin-artifact", "path": "buildSrc/build/libs/logic.jar"}
    ],
    "sourceMappings": [{"id": "entry", "sourcePath": "buildSrc/src/main/java/proof/Convention.java", "implementationClass": "proof.Convention"}],
    "toolchainProfileDigest": "REPLACE_WITH_APPROVED_TOOLCHAIN_SHA256",
    "loadPolicy": "approved-gradle-loader-v1",
    "loaderProfileDigest": "REPLACE_WITH_SEPARATELY_APPROVED_LOADER_SHA256",
    "assertions": {
      "buildInputs": "all-plugin-build-inputs-listed",
      "additions": "all-contributing-plugin-additions-use-helper",
      "mapping": "source-artifact-mapping-reviewed",
      "mutation": "immutable-during-export"
    }
  }],
  "scopes": [{
    "id": "runtime", "projectPath": ":", "resolvableConfiguration": "runtimeClasspath",
    "declarationConfigurations": ["implementation"],
    "assertion": "all-contributing-additions-use-helper", "mutationPolicy": "immutable-after-add",
    "catalogIds": [], "pluginIds": ["local"]
  }]
}
```

上のdigest placeholderは有効な値ではない。実際の承認済みdigestへ置き換える。Providerを登録するscopeは既存どおりproviderPolicy=stable-during-exportも必要。catalogPolicy=explicit-local-v1の場合は既存v2同等のcatalogs／catalogIdsと追加catalog信頼を併用する。

included buildはproducer.kind=included-build、rootDirectoryをboundary相対のbuild-logic等へ変更し、input／output／source pathも合わせる。全sourcePathsをsourcesとinputPathsへ含め、producerのsettings／build script、独自依存・resource・生成入力等もinputPathsへ列挙する。toolchain外classpathはboundary内の列挙済み入力または明示した生成outputだけを許可する。build前に全producerのbaselineを捕捉し、各buildの評価前、export前後にも照合する。異なるproducer／invocationのreceiptは流用しない。

## 登録helper

binary pluginのapply内で `beginPlugin(specId, this)`、`pluginSource(session, sourceMappingId)`、既存のadd／addProvider等、`endPlugin(session, outcome)`の順に呼ぶ。別buildのadapter classへcastせず、公開extensionとのGroovyObject等のbridgeを使う。source handleとsessionはidentityで検証し、複製mapや別projectのhandleを拒否する。

precompiled GroovyはregistrationForm=precompiled-pending、sourcePaths／sourceMappingsを元の`.gradle`へ、implementationClassを実際の生成Plugin classへ設定する。scriptのthisは渡さず次の形にする。`implementation` configurationの作成は通常のbuild側で済ませる。

```groovy
def h = extensions.getByName('osvMcpDeclarations')
def session = h.beginPrecompiled('local')
Throwable original = null
try {
    def source = h.pluginSource(session, 'entry')
    h.add('implementation', 'example:library:1.0', source)
} catch (Throwable error) {
    original = error
    throw error
} finally {
    if (original != null) {
        try { h.endPlugin(session, 'failed') } catch (Throwable ignored) { }
    } else {
        h.endPlugin(session, 'complete')
    }
}
```

adapterはplugin適用前に公開withPlugin observerを設置し、適用後にfindPluginで実Pluginを取得する。descriptor・実class・構築記録との対応が確認できるまでpending。重複beginは、先行session終了後の再開始でも両sessionを不完全に固定する。未終了・failed・捕捉されたconfigure Action失敗もcompleteで復旧させない。Provider callbackはend後でも元の試行へ記録し、登録のためのget／isPresent／mapや未使用configurationの解決を追加しない。

## 承認profileの準備とexport

export前に信頼済み利用者がtoolchain／loader profileを別途準備・確認する。profile生成を自己承認する自動bootstrapは実装していない。厳密なfieldは[本番schema](../src/utils/gradlePlugins.ts)と[実行ハーネス](../src/test/gradle/pluginExporter.integration.test.ts)を参照する。

- toolchain profile: schemaVersion=1、gradleVersion、distributionSha256、jdkIdentity（実java.runtime.version）、compilerIdentity、generatedApiMethod、entries。entryはid／role／size／sha256。roleはgradle-distribution、gradle-api-generated、compiler、standard-library、jdk-runtime。選択したJDKのbin/java・lib/modules・releaseをjdk/java・jdk/modules・jdk/releaseとして必須登録する。
- exporter用toolchain設定file: `{ "profile": <上記profile>, "paths": [{"id": "entry-id", "path": "/trusted/actual/file"}] }`。この実path対応表はgraphへ出力しない。JDK実体と、lib/で始まるGradle entryの実際の選択元も比較し、構築前後にstreaming hashを照合する。MCPはtoolchain実bytesを再読取せず、承認profileとreceiptの対応を検証する。
- loader profile: schemaVersion=1、toolchainProfileDigest、gradleVersion、jdkIdentity、loaderPolicy=gradle-managed-only、transformPolicy=operator-attested-pipeline、agents（kind／entryId／sha256）、exportSettings（configurationCache=false、parallel=false）、attestations（approvedRuntimeOnly／noUnregisteredAgentsOrLoaders／artifactsImmutableThroughLoadを明示true）。agentはtoolchain entryにも対応させ、公開VM引数と照合する。動的agent等の完全な独立棚卸しではない。

profileのdigestはobject keyをUTF-16辞書順へ再帰的に整列し、array順を保ち、非ASCIIを小文字\uXXXXでescapeしたcompact JSONのUTF-8 SHA-256。ビルド済みの `dist/utils/gradlePlugins.js` がexportするpluginProfileDigestでも計算できる。profileは1 MiB・2,000 entry以内、toolchain読取は512 MiB/entry・2 GiB/invocation・1 MiB buffer以内。新しいruntime／agent構成は新しいprofileとして確認・承認する。

```sh
./gradlew \
  -I /trusted/path/plugin-provenance.init.gradle \
  -I /trusted/path/register-declarations.init.gradle \
  -I /trusted/path/export-dependency-graph.init.gradle \
  -DosvMcpPluginBoundary=/absolute/consumer/root \
  -DosvMcpPluginToolchainProfile=/trusted/toolchain-export-config.json \
  -DosvMcpPluginLoaderProfile=/trusted/loader-profile.json \
  -DosvMcpPluginRuntimeRoots=/trusted/gradle-cache \
  -PosvMcpDeclarationContract=osv-mcp-gradle-declarations.json \
  -PosvMcpConfigurations=runtimeClasspath \
  osvMcpExportDependencies --offline --no-daemon --no-configuration-cache --no-parallel --no-build-cache --rerun-tasks
```

事前にlockfileと依存cacheを準備する。init scriptの順序とboundaryの明示は必須。runtime rootsはexport利用者が指定するcanonical rootで、複数はOSのpath separatorで区切る。MCP側は宣言・pluginの両trustと、別々に確認したprofile digest集合を起動時に設定する。exportはソースに隣接するsnapshotとcompanionを保存し、scan側のboundaryにもそれらを含める。

## snapshot・鮮度・完全性

JARは元bytesを `.osv-mcp/plugin-runtime/<invocation>/jars/<sha256>.jar` へ保存する。directoryは同prefixのdirectories/<treeDigest>/manifest.jsonと内容addressed blobsへ、全file／空directoryを含めてatomicに保存する。元treeの再照合とstagingの内容検証後にだけ公開し、既存同digest containerが不正なら置き換えず失敗する。全snapshotが完了してからcompanionをatomic writeする。途中失敗では既存companionを維持する。

本番はload元観測とsnapshot取得の両方をexport taskで行い、loadObservationPhaseとsnapshot refのcapturePhaseにexport-taskを記録する。attested applicationのoriginRelationはdirectoryならsame-path-originまたはdistinct-path-origin、JARなら明示nullとし、kindとの不整合・欠落は拒否する。適用後callbackはPlugin実体取得だけであり、そこでsnapshotしたとは記録しない。

同一projectの再exportでは、compile／ProcessResources／packageの各receiptへ、そのtask自身が宣言したoutput rootだけを記録する。前回のJARやplugin-imageが存在しても、compile receiptへ取り込まない。resourcesはProcessResourcesで、最終artifactはJar／pluginImageの完了後に結ぶ。

静的取込はboundary内のsource・構築出力・snapshotの現在bytesと完全な集合を再検証し、外部runtime pathを再読取しない。JARは全file内容（manifest／descriptor／service／resourceを含む）を照合し、未知encoding・重複・不正path・未承認prefix／隙間・破損を拒否する。ZIP entry順・timestamp・圧縮方式等の許可したenvelope差だけを無視し、署名を再検証したとは主張しない。directoryはbinary tree digestと全blobの過不足・hash・sizeを再計算する。snapshot／構築出力／入力の欠落や変更は影響graphを不採用にする。通常sourceとplugin artifactは共有64 MiB、各file4 MiB、directory entry10,000、work予算を使い、同一scanの構築検証・artifact・snapshotはcacheする。

登録だけが不完全ならrelation／introduced_byを保持し、同一GAVに寄与するscript／pluginの宣言元一覧は全体を省略する。metadataにはcontextごとのplugin_trust_status、applicationのload policy／input status／source-artifact status／transform status／comparison、assuranceとlimitationsを返す。comparisonはreaderで再検証したraw-exact／entry-content-exact／directory-content-exact／same-path-origin（strictの分類はdirect-origin）。directoryの事後捕捉にはplugin_directory_snapshot_post_buildを付け、load元と準備済み出力が同じpathならplugin_directory_origin_same_path_not_comparedも必須表示する。同一pathのsnapshotと現在bytesの照合は鮮度確認として維持するが、別実体の内容比較の証拠には数えない。profileの構造・receipt・runtime identityの検証はhelper／plugin信頼無効や未承認でも省略しない。metadata不足だけではlockfile由来の脆弱性coverageを下げない。

classpath inventoryはtask完了後の観測とexport後の再検証であり、compile中だけの変更や復元された変更は独立に検出できない。承認JDKの上記実体を照合しても、実行中の全native libraryや未知loader／変換を独立検証した保証にはならない。作者のinput完全性・source対応・承認runtimeの表明と、これらの限界をlimitationsに残す。

本番実装レビュー後の[3ツール／OSV実接続検証](GRADLE_LIVE_VALIDATION.md#convention-plugin本番adapterの実接続検証2026-11-01)では、Groovy／8.11.1のbuildSrc JARとKotlin／9.2.1のincluded precompiled Groovy directoryを検証した。8条件×3ツール×2 projectの48呼出し、候補版の独立OSV再照会64件が成功。信頼無効・profile未承認・実際の未終了登録では宣言元を省略し、再export後の採用とsnapshot改変の拒否も確認した。独立producerのlock不足によるcoverage警告と、追加信頼契約の限界は維持する。


標準kotlin-dsl／precompiled Kotlinは[設計・公開API実証](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md)を別途追加した。本番adapter／静的取込への実装は未完了で、この手順の対応範囲を変更しない。
