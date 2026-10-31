# Gradle catalog alias／bundle・ProviderConvertible: 設計と公開API実証

設計日: 2026-10-31。対象はGroovy／Kotlin × Gradle 8.11.1／9.2.1。これは次段階のcatalog拡張の設計とtest-only実証であり、本番adapter、reader、契約、trust設定は変更しない。本番は引き続きcatalogPolicy=noneで、alias／bundleの採用を有効化しない。

## 1. 公開APIと実証の問い

- [DependencyHandler](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/dsl/DependencyHandler.html)のaddProvider／addProviderConvertibleへ元の値を渡し、Gradleが呼ぶActionだけで実体を記録する。helperによるProvider.get／isPresent／getOrNull／map、追加のasProvider、collection listenerを使わない。
- [VersionCatalog](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/VersionCatalog.html)のfindLibrary／findBundleはOptionalの中にProviderを返す。Optional.getはProvider.getと区別する。aliasはGradle APIの正規化を利用し、生成accessorのclass名からsourceやTOMLキーを推測しない。
- [VersionCatalogBuilder](https://docs.gradle.org/current/javadoc/org/gradle/api/initialization/dsl/VersionCatalogBuilder.html)はfrom／version／library／bundleを構成できる。公開VersionCatalogの名前・alias一覧だけでは、元ファイルや全構築入力、bundleのmember alias一覧を取得できない。modelにaliasがあることを入力inventoryの完全性と同一視しない。
- 現行版のJavadocはAPI形の参考であり、対象二版の挙動は実行行列で確認する。内部Gradle API、生成accessorの内部class、reflectionによるprivate field参照を根拠にしない。

## 2. 方式と観測範囲

通常追加、通常追加＋解決後棚卸し、登録Action付き追加の3経路を同じproject構成で比較する。登録側は試行ID・source・usageを**委譲前**に用意し、元Actionを先に実行してから依存snapshotを採る。元の例外はそのまま伝播させ、記録失敗だけを不完全にする。

libraryはProviderのままaddProviderへ、ProviderConvertibleは変換せずaddProviderConvertibleへ一度だけ委譲する。bundleも元の型付きProvider／ProviderConvertibleをそのまま渡す。原理を共用してもlibraryの「一追加→一依存」とbundleの「一追加→複数依存」を同じ台帳へ無条件に混ぜない。

比較する時刻は論理フェーズとイベント順。壁時計時刻や実行コストのゼロを保証しない。アプリ側が全経路で同じ計測mapを付けたlibrary Providerと、公開ProviderConvertibleのasProviderでは、supplier／変換回数を数える。helper自身はmapを足さない。

**bundleの計測限界:** 元のcatalog bundle Providerの内部get回数を、公開APIで透過的に計数できたとは主張しない。実際にbundleへアプリ側のmapを追加した対照は、通常APIでも解決に失敗した。bundleの型付き経路を維持できないことが原因と考えられるが、内部APIで機構を証明したものではなく、本式と対象二版の観測に限定する。型情報を変える計測を「同じbundleの評価回数」として扱わない。bundleでは元の型を保持した経路の解決結果・member Actionの順序と回数・公開変換回数を比較し、helperが追加照会しないことをコードで確認する。Action callback数もProvider supplier数ではない。

## 3. 実測した挙動と採用条件

- library aliasは登録付きでも元と同じ結果。version.ref、生成されたlibrary ProviderConvertible、明示findLibraryの経路を確認する。
- bundle pair=[client, client-tools, same]はalpha／betaの2 moduleへ解決されるが、登録callbackは3件。同じalphaを指す二aliasを一つの追加試行へ潰さない。
- 同じbundleをmain scriptとapplied scriptから独立に追加すると二つのgroup ID、各3観測を保持し、同じ保持実体へ合流しても両使用scriptを残す。
- bundleの元Actionはproject評価中に呼ばれるケースがある。これは通常APIと共通であり、登録をexport taskまで遅らせない。台帳を呼出し後に初期化すると観測を失う。
- 元Actionがversionを1→2へ変更するケースでは、Action後のsnapshotで2を保持する。Actionが評価中に投げたsentinel例外も通常APIと同じフェーズで呼出し側へ届く。
- 型情報を失うmap付きbundleは通常API・登録側とも失敗する。回避のために早期getしてlistへ展開したり、別の追加方法へ置換したりしない。
- 空bundleはcallbackゼロ。未解決のmap付きbundleを未使用configurationへ登録した対照はsupplierゼロ。空・未実現を追加照会なしに一般判別できるとは扱わない。未使用の**元の型付きbundle全般**が遅延実現されるという結論にはしない。
- strict版を持つaliasは解決できても、既存の既定key契約では宣言元の採用対象外。試作snapshotのsupportedフラグはshapeの観測であり、rich versionを含む本番採用判定ではない。

## 4. 宣言元と使用情報の契約案

試作のsource文字列はproject相対の使用ラベル（build／extra）で、報告のproject名と合わせてfixtureの実pathを特定する。本番採用可能なsource handleやhash検証を実装したものではない。

物理declared_inは、依存を追加した**使用script**。catalog TOMLはversion編集用の補助入力で、declared_inに混ぜない。rootから子へ追加した場合はroot script、applied scriptなら末端script。sourceHandleはC1a/C1bと同じ事前準備・境界・hash規則で検証する。convention pluginはsource-artifact対応の別gateを維持する。

将来のhelper案:

```text
catalogSource(catalogId) -> prepared catalog handle
addCatalogLibrary(configuration, catalogHandle, alias, sourceHandle, Action?)
addCatalogBundle(configuration, catalogHandle, bundleAlias, sourceHandle, Action?)
addProviderConvertible(configuration, originalConvertible, sourceHandle, Action?)
```

catalog helperは名前付きcatalogのfindLibrary／findBundleのOptionalを取り、Providerを評価せず通常追加へ渡す。欠けたaliasは通常の選択操作の失敗を維持し、別aliasへfallbackしない。任意のConvertibleにcatalogの由来を自動付与しない。生成accessorを直接渡すAPIも設ける場合は、catalog／usage kind／aliasを明示し、その対応が作者表明であることをmetadataへ出す。同値GAVだけからaliasを逆引きして証明済みにはしない。

使用情報はcatalogInputId、catalog名、usage kind（library／bundle）、指定aliasとGradle正規化名、追加group IDを分ける。同じ名前のversion aliasとlibrary aliasを混同しない。

### bundleの台帳

次版adapter（案: version 4）には追加groupと依存memberを分離する。

```text
catalogAdditions: [{ id, ownerProjectId, configuration, sourceId,
  catalogInputId, usage: { kind, alias, normalizedAlias },
  registrationForm: provider | provider-convertible,
  callbackCount, observationComplete, memberIds, state, reasons }]
records: [{ id, groupId, materializationSnapshot, resolveSnapshot,
  source, state, reasons, ...binding evidence }]
```

libraryはC1bの安定した同一試行の世代照合を維持する。bundleは異なるmember keyが正常なので、v3の「全materializationsが同じkeyである」検査へ渡さない。member IDはgroup内の観測に付くopaque IDとし、callback順だけを根拠にTOML member aliasへ結び付けない。同じGAVのaliasが複数ある場合、member別aliasを省略してbundle usageと全使用scriptを保持する。

初期陽性は固定されたローカルcatalog入力のbundle、既知のmember数上限内、元Actionによるmodule identity変更なし、既定shape／単純版に限定する。事前検証したbundle定義のmodule multisetと、全callback・保持実体・root bindingを照合する。元Actionの版変更は使用scriptの宣言として保持できるが、catalogの版編集キーの案内は抑制する。

独立のbundle追加は別group。callbackが想定member数と合わない、再実現とmember重複を区別できない、途中失敗、非既定shape、曖昧な実体対応、未観測、入力不完全、上限超過ならscope全体の宣言元を省略する。空bundleをcallbackゼロだけから完全扱いしない。初期実装は複数generationのbundleを積極採用せず、不完全として残す。groupの元Action失敗を記録した上で同じ例外を再throwし、アプリが例外を捕捉して処理を続けても部分member一覧を完全としない。

ID、member参照、scope、source hash、group/member被覆、重複・未知参照、key／shape、実selected版とlock対応をreaderで再計算する。exporter complete=trueだけを採用しない。既定上限を引き上げず、memberも全record上限10万・観測128/試行・共有work予算へ算入する。予算超過で元のActionや通常追加を止めない。

## 5. catalog入力の鮮度・完全性

### 完全性は公開modelだけで自動証明できない

libsとtoolsのcatalog名・alias一覧を列挙する実証を追加したが、その一覧にはfrom元pathやsettingsの上書き元がない。catalogファイルの探索結果やaliasのGAV一致だけで完全とはしない。追加の作者契約は「全catalog構築・変更が列挙入力だけに依存し、評価中に変更されず、未登録の構築／上書きがない」。これはProviderの安定性表明とは別の責任で、hash一致は作者表明の独立証明ではない。

契約案はcontractVersion=2、catalogPolicy=explicit-local-v1。catalogごとにid／name／kind、importしたTOML全件、settingsと適用script／plugin等の構築コード全件、追加ローカル入力、overrideの有無、入力完全性の作者表明を保持する。初期対応はimport-onlyと、入力を全て捕捉できる制御されたローカルoverride。programmatic／remoteや未捕捉の外部値は別実証までunverifiable。

契約fragment案（本番未実装）:

```json
{
  "contractVersion": 2,
  "catalogPolicy": "explicit-local-v1",
  "catalogs": [{
    "id": "libs", "name": "libs", "kind": "local-toml",
    "tomlPaths": ["gradle/libs.versions.toml"],
    "inputPaths": ["settings.gradle", "gradle/libs.versions.toml"],
    "constructionPolicy": "registered-inputs-only",
    "mutationPolicy": "immutable-during-export",
    "overridePolicy": "none",
    "inputCompletenessAssertion": "all-catalog-construction-inputs-listed"
  }]
}
```

既存のtrustModel／sources／scopesも必須とする。scopeにはproviderPolicyに加えてcatalogIdsを列挙し、全寄与usageがその集合に入ることを確認する。id／nameの重複、未知catalog参照、tomlPathsがinputPathsに含まれない入力、設定sourceの欠落を拒否する。制御された上書きはoverridePolicy=registered-localとし、上書きsourceもinputPathsへ含める。上書きがないこと自体も公開modelから自動証明したとは扱わない。

consumerも既存の登録helper信頼だけでcatalog宣言元を自動採用しない。追加の明示catalog信頼設定（案: OSV_MCP_GRADLE_CATALOG_TRUST=local-catalog-inputs-v1）を必要とする。現行設定の意味を後から拡張しない。graphの入力検証とdeclared_inの信頼採用は分離する。

### 捕捉・検証順序

1. 信頼済みinit段階でmanifestを読み、settings評価・catalog生成より**前**に列挙済み入力と不在候補を安全に捕捉する。settingsEvaluatedやexport時の初回hashでは遅い。settings pluginがさらに読むsourceは、それより前に準備できなければ未検証。
2. default gradle/libs.versions.tomlだけでなく、実importしたcustom catalog、settings側version上書き、applied settings script等をgraph入力として扱う。build sourceと同じ4 MiB/件・64 MiB/scan、root相対path・symlink拒否・通常file限定・安全なopen/readを維持する。今回のcustom入力はcatalog/company.versions.toml。任意suffixを許可せず、追加suffixを要する場合は明示的なreader拡張とする。
3. helper登録時／export前／解決後・atomic write前に基準を検証する。変更・削除・不在からの生成はexportを拒否し、既存companionを維持。試作はbeforeSettingsと最終hashの比較、および旧publication markerが残る対照を実行する。全check pointや本番atomic writeを実装した試験ではない。試作のpublicationAllowedは既知入力hash条件だけを表し、catalog inventory完全性・binding採用・全scenarioの正常解決を表さない。
4. export時に公開catalog名の集合とmanifestのcatalog集合を比較し、未知catalog・未捕捉入力・取得不能があればinventoryComplete=false。name集合一致でも全入力を自動発見したとはしない。catalogごとのinputPathsは既存graph.inputsのhash参照と照合する。
5. MCPはGradleを実行せず、同じ境界・予算で入力hash／不在状態と契約を確認。catalog入力の不一致はdeclared_inだけの失敗ではなくgraph stale。Providerの安定性表明でこれを回避しない。

hash捕捉間で入力を変更し元へ戻す操作や、環境変数・外部init script・未捕捉pluginの影響まで独立検出できるとは主張しない。入力不変・全依存入力の作者表明を信頼metadataへ明記する。catalog・script本文や入力manifestをOSVへ送らず、スキャナー入力にも加えない。

### catalog種別と判定

| 入力 | 初期判定 | graph／宣言元 |
| --- | --- | --- |
| 全入力捕捉済みlocal TOML、import-only | verifiable候補 | 入力・graph検証後に関係情報を採用。宣言元には追加のcatalog信頼契約が必要 |
| local import＋全構築入力捕捉済みoverride | verifiable候補 | 使用scriptを保持。編集先の一意性がなければ具体キーは案内しない |
| 未捕捉programmatic値／環境変数／外部service依存 | unverifiable | 影響contextのgraph・declared_inを採用しない |
| remote配布catalog／source-artifact対応未確認 | unverifiable | ローカルcacheのhashだけで陽性化しない |
| 名前・使用catalogのinventoryが不完全 | inventoryComplete=false | 影響範囲不明なら文書全体のgraph採用を拒否 |
| 対応外key／shapeやbundle観測不完全だけ | 宣言元不完全 | 検証済みrelation・introduced_by・coverageは保持 |

catalogの検証不能だけではlockスキャンの脆弱性coverageを下げない。未知adapter v4を旧readerへ渡す場合、検証可能なgraph入力は既存規則で扱い、declared_inは省略。catalog graph入力自体が未検証ならreaderの新旧や宣言元信頼設定に関係なくgraph採用不可とする。

## 6. version編集案内

実証のtools catalogはcompany.versions.tomlのversion.ref=1をimport後、settingsでclient=2へ上書きした。実際の要求・選択・snapshotは2。TOML上のversion.refだけを見て編集先を案内すると効果がない。

初期はdeclared_inの使用scriptを案内し、catalogのlibrary／version／bundleキーは補助候補としてのみ扱う。具体キーの提案には、入力を全て検証した上で最終版の定義元が一意で、上書きや元Actionの版変更がなく、rich versionや他の制約の影響がないことが必要。一意性が確認できなければcatalog名／usage aliasの診断情報だけを返す。TOMLをdeclared_inに混ぜず、自動編集もしない。修正候補のOSV cleanはartifact存在・variant・Java互換性を証明しない。

## 7. 回帰テストと次の実装gate

今回のtest-only fixtureはsrc/test/fixtures/gradle-catalog-registration.init.gradle、回帰はsrc/test/gradle/catalogRegistration.integration.test.ts。ローカルMaven POMのみを使い、offline・configuration cache無効で実行する。本番のcatalog input readerやtrust受理を模擬JSONだけで対応済みとはしない。

| 条件 | 必須確認 |
| --- | --- |
| version.ref、findLibrary、生成library Convertible、明示Convertible | 通常／棚卸し／登録付きでイベント列・計測可能なsupplier／変換回数・結果が一致 |
| 元bundle Provider、生成bundle Convertible、明示bundle Convertible | nativeの型を保持して正常解決。member Action数と順序を維持 |
| member同値、別scriptから同一bundleを二度追加 | 各groupと全member観測を保持。両使用sourceを維持 |
| 元Actionによる版変更・評価時の例外 | Action後snapshot、元と同じ結果・例外フェーズ |
| map付きbundle | 通常APIも失敗する陰性。helperが早期展開で成功へ変えない |
| empty／未使用map付きbundle | callbackゼロ／supplierゼロを観測。一般の不在・未実現判別と混同しない |
| strict版alias | 解決結果は保持し、既定keyに収まる陽性と混同しない |
| settings override、custom TOML | 有効値2と定義値1の差、両catalogの公開inventory、全既知入力hashを保持 |
| 評価中と先行taskでTOML／settingsを変更・不在入力を生成 | stale検出、publication拒否、旧marker不変 |

本番実装前の追加必須gate: manifestの厳格schema・duplicate/depth/size/path検査、未登録catalog／構築入力、remote／programmatic／ambient値の陰性、settings pluginの早期捕捉、transientな復元変更の限界metadata、bundleのcallback予算超過／途中Action失敗／member削除・copy／context順逆転、3ツールの最終完全性AND・起動設定有無・未知adapter互換、既知脆弱版でのOSV実接続。convention pluginのsource-artifact、configuration cache、task出力Provider、並行実行は別gate。

再現例:

```sh
env OSV_MCP_TEST_GRADLE=/trusted/gradle/bin/gradle \
  JAVA_HOME=/trusted/jdk-21 GRADLE_USER_HOME=/trusted/cache \
  OSV_MCP_GRADLE_CATALOG_OUTPUT=/tmp/catalog-proof \
  npm test -- src/test/gradle/catalogRegistration.integration.test.ts
```

出力prefixを指定すると版・DSL・変更mode（none／evaluation／task）別JSONを保存する。通常はfixtureと一時報告を終了時に削除する。機械可読結果はvalidation/gradle-catalog-2026-10-31.jsonに保存する。


## 8. 検証結果（2026-10-31）

| Gradle | Groovy | Kotlin | 結果 |
| --- | --- | --- | --- |
| 8.11.1 | 18条件 | 18条件 | 通常／棚卸し／登録のイベント・計測回数・結果が一致 |
| 9.2.1 | 18条件 | 18条件 | 同上 |

4構成・計72回帰条件。各構成のnone／evaluation／taskの12報告でも、nativeとの比較と期待した鮮度判定を機械検証した。通常のsupplier計測はalias=1、countedConvertible=1、map付きbundle陰性のsupplier=1、明示Convertible変換はlibrary／bundle合わせて2回。bundle／bundle Convertibleは各3member観測、独立二重bundleは各3観測・二group。settings上書きは版2、strict aliasはstrict=1を保持した。空bundleと未使用map付きbundleはそれぞれcallback0とsupplier0。

Gradle 8を含む全体実行では1,609件成功、公開文書のコマンドprefixチェック1件が失敗した。実行例を通常のenvコマンドへ修正後、同チェック1件を再実行して成功。さらに現在の文書を含む通常npm testは1,486件成功・124件skip（実Gradle／性能比較のopt-in条件）だった。失敗した文書チェックを含む全体実行を、全件成功の記録へ読み替えていない。Gradle 9のfocused実行は36件成功。型チェック・ビルド・diff checkも成功。本番コードの変更・MCP／OSV実接続・catalog採用の有効化は行っていない。

記録後、回帰を補強した。上記のsupplier／変換回数・strict=1・上書き後のalpha:2をnativeとの一致だけでなく固定値でも確認し（両経路とも評価ゼロの場合に通らないように）、鮮度対照の変更対象へ実際にimportするcatalog/company.versions.tomlを加えた（変更検出4件）。Gradle 8.11.1／9.2.1のfocused実行で各36件成功。保存済み報告は変更なし構成のもので、補強の影響を受けない。
