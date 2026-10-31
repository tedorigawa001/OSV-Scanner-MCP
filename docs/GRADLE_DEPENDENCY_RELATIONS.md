# Gradleの依存関係・導入元・宣言元の設計

設計日: 2026-10-31。Stage A/Bのexporter・静的取込・応答拡張を実装。Stage C1aの同期登録adapterとC1bの明示Provider登録・v2/v3静的取込を実装（未リリース）。C1bの3ツール・OSV実接続も検証済み。catalog alias／bundle・ProviderConvertibleの本番adapter／静的取込も実装済み（§15）。catalogの3ツール実接続は別課題。宣言元登録adapterの入出力・完全性・回帰条件は6.6節とStage C1テスト計画へ具体化済み。

実装メモ: exporterは`gradle/export-dependency-graph.init.gradle`としてnpm配布にも同梱する。`-PosvMcpConfigurations=*`は全resolvable configuration、既定は存在する4つのclasspathを選択する。metadata状態は`coverage.dependency_metadata.gradle`へ出し、relationの完全性と物理宣言元の完全性を区別する。Stage Bの`declarationEvidence`は空配列のみ対応し、未知のsource-map形式を検証済みとは扱わない。Gradle 8.11.1／9.2.1とGroovy／Kotlin DSLで実export、既知の脆弱版で3ツールからのOSV実接続を確認。詳細は[実接続検証記録](GRADLE_LIVE_VALIDATION.md)を参照。

## 1. 推奨方式

**信頼済みのローカル環境／CIでGradleの解決グラフをJSONに出力し、MCPはlockfileとJSONを静的に読む。**

既存の「スキャン時にはGradle・Wrapper・ビルドコードを実行しない」方針を維持する。通常のlockfileだけのスキャンもそのまま使え、グラフがなければ関係情報は`unknown`とする。取得用Gradle処理をMCPの自動フォールバックにはしない。

`direct`は解決グラフのroot直下の実依存、`transitive`はその先の実依存と定義する。所属プロジェクトと実際の宣言ファイルは別の情報として扱い、宣言元が不明な場合に`build.gradle(.kts)`を推測で`declared_in`へ入れない。

## 2. lockfileだけでは取得できない情報

Gradle lockは解決済みの版とconfigurationの対応を保存するが、親子の依存辺、要求時のselector、選択variant、実際に依存を追加したソースファイルは保存しない。通常はプロジェクト／サブプロジェクトごとにlockを持ち、rootの`dependencies`タスクだけで全サブプロジェクトの状態が得られるとは限らない。[公式: Dependency locking](https://docs.gradle.org/current/userguide/dependency_locking.html)

実装で使う主な追加情報:

| 情報 | 主な取得元 | 用途 |
|---|---|---|
| rootと依存辺 | `ResolutionResult` | direct/transitive、到達可能性 |
| requestedとselected | `DependencyResult` / `ResolvedDependencyResult` | conflict resolution・force・substitution後の版への対応付け |
| 選択variantごとの依存 | `getResolvedVariant()` / `getDependenciesForVariant()` | 別variantの辺を誤って結合しない |
| constraintの区別 | `DependencyResult.isConstraint()` | BOMやlock由来の制約を親子関係と誤認しない |
| 未解決の辺 | `UnresolvedDependencyResult` | 経路・解決の不完全性を明示 |
| configurationの宣言と継承 | `Configuration.dependencies` / `extendsFrom`等 | 所属configurationの補助情報 |
| 宣言した実ファイル | 明示的な宣言元登録／対応adapter | `declared_in`。上記グラフAPIからは取得しない |

`ResolutionResult`はグラフと未解決依存を提供し、root variantは8.11で追加されたIncubating API。初期exporterの対応候補をGradle 8.11以上の8.x／9.xとし、実装時に対応版を固定して互換テストする。古い版では従来のlockスキャンを維持する。[ResolutionResult API](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/result/ResolutionResult.html)

selectedはrequestedと異なり得る。レポートを結び付けるのは**selectedのMaven座標と実際の版**であり、要求版やaliasではない。[ResolvedDependencyResult API](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/result/ResolvedDependencyResult.html)

## 3. 取得方法の比較

| 方式 | 評価 | 採否 |
|---|---|---|
| lockfileだけ | configuration別の固定版は分かるが辺がない | 従来のスキャン・照合の基準として継続 |
| Groovy/Kotlin DSLの静的解析 | literalやcatalog参照の候補は拾えるが、条件・変数・pluginによる追加を一般には解けない | 主たる判定には使わない |
| `dependencies` / `dependencyInsight`のテキスト | 人間向け。省略・重複・constraint表示等の解析が必要で、実行時にはビルドを評価する | 目視確認用。取込形式にはしない |
| Tooling API / BuildAction | 構造化情報は取れるが、プロジェクトを構成・評価する点は同じ | exporterの将来の実装候補。MCP内実行はしない |
| 信頼済み環境での専用exporter | Gradle自身の解決結果を構造化できる | 推奨 |
| CycloneDX/SPDX | 既存SBOMを利用可能。ただしconfiguration・variant・直接root・宣言元が常に揃うわけではない | 将来のadapter。既存`scan_sbom`とは別に検討 |
| POM／deps.devからグラフを再構築 | Gradle固有のsubstitution・exclusion・variant・constraints等を再現できない | Gradleの由来を確定する根拠にはしない |

Graph APIではライブラリartifact自体を要求せずにメタデータを解決できる。ただし、Gradleの構成処理、plugin取得、ビルドコードによる副作用や外部通信は別問題であり、exportを安全な静的処理とは呼ばない。[公式: Graph resolution](https://docs.gradle.org/current/userguide/dependency_graph_resolution.html)

## 4. exporterの動作

### 4.1 実行主体と配置

- リポジトリで管理するinit script／pluginを、利用者が信頼済み環境で明示的に実行する。
- MCPはその実行も、Wrapperの取得・更新も行わない。export失敗時にも自動実行しない。
- 既定出力案は各build rootの`osv-mcp-gradle-dependencies.json`。探索で無視する`build/`や`.gradle/`を既定の置き場所にしない。
- npm配布に含める場合、現行の`files: ["dist"]`に合わせてexporter資材を梱包し、配布版とschema版を固定する。

利用形の案（コマンド・task・propertyは未実装）:

```sh
./gradlew -I /trusted/path/osv-mcp-export.init.gradle osvMcpExportDependencies \
  -PosvMcpConfigurations=runtimeClasspath,testRuntimeClasspath \
  --no-configuration-cache
```

`--offline`はキャッシュのみで生成したい場合の任意指定で、コード実行を防ぐ機能ではない。exporterはコンパイル・testへの依存を意図的には追加しないが、既存ビルドの副作用がないことまでは保証しない。lockの生成／更新とexportは別操作とし、export時に`--write-locks`を自動追加しない。

### 4.2 収録範囲

- `(build ID, project path, scope kind, configuration)`ごとに独立したcontextを出力する。
- 初期対象は通常のproject configurations。`buildscript-gradle.lockfile`は`scope kind=buildscript`で分離し、明示選択時だけ取得する。
- 初期既定候補は存在する`compileClasspath`・`runtimeClasspath`・`testCompileClasspath`・`testRuntimeClasspath`。これだけで全Gradle／Androidプロジェクトを網羅したとは扱わない。
- exporterは選択されたcontext、存在するresolvable configuration、対象外・取得失敗のcontextを列挙する。存在しない要求configurationは成功扱いしない。
- 全configuration取得は明示オプションにする。`canBeResolved=false`を無理に変更しない。task実行中だけ生成されるconfiguration等は未対応として残す。
- settings/plugin解決、buildSrc、included builds、Android/Kotlin固有variantは段階的に対応する。`:lib`だけでbuildを識別せず、composite buildの同名projectを分離する。

### 4.3 グラフの表現

- moduleとprojectを`ComponentIdentifier`の種類で区別する。projectに公開用のgroup/versionがあっても公開Maven moduleへ変換しない。
- 状態は`(context, component ID, selected variant ID)`。componentだけで全variantの辺を合流させない。
- unresolved edge、constraint edge、substitution、selection reasonを失わない。例外全文・URL・認証情報・絶対パスは出力しない。
- graph生成前後でlockのバイト列hashを比較し、途中で変わったら生成失敗とする。JSONは一時ファイルからatomic renameする。
- 既知settings入力は`beforeSettings`、全projectのbuild fileは`projectsLoaded`で評価前にhashを捕捉する。存在しない既知候補もその状態を保持し、評価中の生成・削除を検出する。export開始時と解決後の書込前に基準と比較し、評価中／先行タスクの変更があれば既存companionを上書きせず失敗とする。変更後の宣言は別のGradle実行で再評価してからexportする。

variantごとの依存集合は異なり得るため、`getDependencies()`の単純な和だけで経路を作らない。[ResolvedComponentResult API](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/result/ResolvedComponentResult.html)

## 5. JSON契約案（v1）

下記は最小の例。IDはcontext内で一意とし、別context間の辺は許さない。`ownerBuildFile`は所属情報であり、`declared_in`の証明ではない。

```json
{
  "schema": "osv-mcp.gradle-graph",
  "schemaVersion": 1,
  "producer": { "exporterVersion": "1", "gradleVersion": "8.11" },
  "lockfiles": [
    { "id": "app-lock", "path": "app/gradle.lockfile", "sha256": "<64-hex>" }
  ],
  "projects": [
    { "id": "main::app", "buildId": "main", "projectPath": ":app", "directory": "app", "ownerBuildFile": "app/build.gradle.kts" }
  ],
  "inputs": { "complete": false, "files": [] },
  "contexts": [
    {
      "id": "app-runtime",
      "projectId": "main::app",
      "kind": "project",
      "configuration": "runtimeClasspath",
      "lockfileId": "app-lock",
      "lockConfiguration": "runtimeClasspath",
      "complete": true,
      "rootVariant": "root-v",
      "components": [
        { "id": "root", "kind": "project", "projectId": "main::app" },
        { "id": "module", "kind": "module", "group": "org.example", "name": "client", "version": "1.2.3" }
      ],
      "variants": [
        { "id": "root-v", "componentId": "root" },
        { "id": "runtime-v", "componentId": "module" }
      ],
      "edges": [
        {
          "fromVariant": "root-v",
          "requested": { "kind": "module", "group": "org.example", "name": "client", "selector": "1.+" },
          "selectedVariant": "runtime-v",
          "constraint": false
        }
      ],
      "unresolved": [],
      "unrepresentedDependencies": [],
      "declarationEvidence": []
    }
  ]
}
```

追加の契約:

- `inputs.files`にはroot相対pathとSHA-256を記録する。export時に存在しなかった既知の候補(例: 片方のDSLのbuild file)は`absent: true`として記録し、後から作成された場合もstaleとする。settings、build files、catalog、properties、宣言元登録に使ったファイル等を列挙するが、環境変数、外部init script、remote pluginの全影響を網羅したとはしない。
- lockのGAV集合と照合するための**全selected module集合**と、由来をたどる**非constraintの辺**を区別する。
- 解決失敗はcontext単位の`complete=false`と理由codeで記録する。非対応のID種別やvariantは成功へ丸めない。
- source依存、ローカルJAR等のグラフ／lock外の依存は`unrepresentedDependencies`に種類と件数を記録する。MCPに任意のローカル参照先を読ませない。
- `schemaVersion`不明、重複ID、dangling edge、重複JSON key、誤った型はそのcontext／文書を無効とする。原則として「読めた部分で完全」とは扱わない。

## 6. 判定・併合規則

### 6.1 lockとの対応付け

1. 通常の探索で見つかったlockだけを対象とし、JSON内のpathから探索範囲を広げない。
2. JSONのlock hashを、スキャナーへ渡す同じ捕捉済みlock bytesで確認する。
3. project・configuration・scopeを一意に対応付ける。通常lockとbuildscript lockを混ぜない。
4. contextの全selected module集合とlock内のそのconfigurationのGAVを照合する。Mavenの比較器で等価でも、`1`と`1.0`を同じartifact IDとして勝手に統合しない。
5. lock hashまたは既知input hashが違えばstaleとして、そのcontextを由来情報にもcoverage判定にも採用しない。必要なhashを境界・読取制限等で検証できない場合も同様。hash一致は、現在の全環境での再解決結果が同一である保証でも、署名・真正性の証明でもない。
6. lockにあるconfigurationの一部しかexportされていなければmetadataはpartial。未取得部分を「推移的だからrootにない」と推論しない。

### 6.2 direct / transitive

- root variantからの非constraint edgeで選択された外部moduleはdirect。`extendsFrom`で継承された宣言やpluginが追加した実依存も、その解決contextではdirectとなる。
- その先の非constraint edgeで到達する外部moduleはtransitive。directとtransitiveの両方の証拠があればdirectを優先する。
- constraintは版の選択に関わる情報として保持するが、実依存辺としてたどらない。lock由来の制約やBOMだけで全moduleをdirect／BOM由来にしない。[DependencyResult.isConstraint API](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/result/DependencyResult.html)
- `platform(...)`として実際に要求されたplatform自身にはdirectの証拠があり得る。一方、そのconstraintsが制御するlibraryをplatformの子とはみなさない。
- project依存は外部moduleへ変換しない。`app -> project(lib) -> module`はappの直接外部依存ではない。lib自身の取得済みcontextでdirectなら、全体集約時にはdirectとなり得る。
- constraintだけの経路、未解決・曖昧なvariant、lockにしかないentryはunknown。moduleにprojectの公開座標が付いているだけではdirectにしない。

### 6.3 introduced_by

- 各contextの直接外部moduleを起点に、実際の非constraint辺をvariant単位でたどる。出力名はselectedの`group:name`。
- projectを通過する辺でも、公開module起点が存在する場合だけその起点を保持する。公開起点のないproject-only経路に架空のMaven起点を作らない。rootからproject依存を経由して到達するmoduleは、公開module起点の一覧が由来の一部だけになるため、由来を不完全として`introduced_by`を出さない(実装済み、2026-10-31)。
- 複数起点、cycle、直接＋推移的の重なりを扱う。起点自身を自分の由来にしない。
- 同じGAVについて必要なcontextの一部が不足・不完全・予算超過なら、既知部分だけを完全な由来一覧のように返さず、一覧全体を省略する。空の一覧は「由来なし」と「不明」を混同しない。
- 確定した複数起点の10件上限・`introduced_by_omitted`は既存仕様を使う。未確定起点をomitted件数へ入れない。
- 多数の起点で共有するグラフはvariant単位の反復型SCCで縮約し、DAG上で疎な起点wordを伝播する。少数起点・共有のない木は軽い個別探索を維持する。共有先がある場合も個別探索を先行し、起点間の再訪と同一起点内の重複queue処理の両方が到達variant数を超えて初めてSCCへ切り替える。probeの作業は同じ予算へ計上し、切替時は部分結果を破棄する。縮約・word操作・由来の展開も既存のscan共有予算へ計上し、contextをまたぐ由来の混合や予算の引上げは行わない。不完全contextは由来を出せないため、直接依存の証拠を保持して不要な探索を省略する。
- configuration間でのdirectの証拠は保持するが、directの証拠がない場合にtransitiveと断定するには、そのlock GAVの関連contextが揃っている必要がある。

### 6.4 declared_in

**Gradleの所有projectと物理的な宣言ファイルを区別する。** `Configuration.dependencies`は所属・継承の情報を得られるが、物理ファイルの出所を持つAPIではない。[Configuration API](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/Configuration.html)

- 初期exporterだけで物理ファイルが取れない依存は、directとintroduced_byが分かっても`declared_in`を省略する。
- exporterの任意extensionとして、依存を実際に追加するhelper／convention pluginが、そのDependencyオブジェクトと宣言ファイルを同時登録できるsource-map契約を用意する。requested selector、宣言configuration、選択edge、ファイルの捕捉hashを結び付ける。
- この登録はビルド作者からの明示的な出所情報であり、汎用Gradle APIが自動発見した情報とは区別してmetadataへ記録する。単にJSONに`verified=true`があることを証明とはしない。
- evidenceの種類、path、hash、edgeへの一意な対応が確認できる場合に限り`declared_in`へ出す。宣言したsourceが許可範囲外、source-map未提供、曖昧なら省略する。stage 1ではsource-map対応を必須にしない。
- 通常の直接記述、`apply from`、rootの`subprojects`、buildSrc、convention pluginのどこから宣言されたか分からない場合、ownerBuildFileを代用しない。stack traceや文字列検索だけも根拠にしない。
- version catalogを使う場合、依存を追加したbuild/scriptが宣言元で、版を保持する`libs.versions.toml`は別の更新対象。catalogだけで「依存として使用された」とは確定しない。[Version catalogs](https://docs.gradle.org/current/userguide/version_catalogs.html)
- 同じGAVの直接宣言元に未確定部分があれば、初期版では`declared_in`全体を省略し、metadataの理由に残す。既存のフィールドを完全な宣言元一覧と誤読させない。

### 6.5 複数lockをまたぐ完全性の伝播

- `RelationInfo`に、由来と宣言元それぞれの完全性（例: `introducedByComplete`・`declaredInComplete`）を独立して持たせる。集合の未設定・空集合だけから完全性を推定しない。完全と確認できない値は不明として扱う。
- 同じ応答packageへ併合される同一GAVの全source／lockについて完全性を集約する。companion欠如、不正、stale、context不足、予算超過によるunknownも併合対象から落とさず、不完全という情報を保持する。完全性の併合はANDとし、ファイル内のrelation優先順位処理でも失わない。
- 最終出力では、全sourceで由来が完全な場合だけ集合を和集合にして`introduced_by`とその上限・omitted件数を生成する。一つでも不完全なら`introduced_by`・`introduced_by_omitted`を両方省略する。宣言元も独立して同じ規則を適用し、不完全なら`declared_in`全体を省略する。
- `combineRelations`の単純な集合併合だけでは満たせないため、`annotateRelations`を含む最終整形まで完全性を伝播する。宣言元を別途収集する経路にも同じ抑制を適用し、単一lock内だけで一覧を省略して済ませない。既存の他形式は完全性の契約を明示して移行するか、Gradleを含む併合に限定して適用し、従来の出力を暗黙に変更しない。
- 完全性は一覧の出力可否を制御する情報であり、`dependency_relation`の既存のファイル間`mixed`判定とは分離する。不完全な理由はmetadataに残す。


### 6.6 Stage C: 宣言元adapterの確定契約（実装予定）

以下はsource checkoutのC1a実装契約（未リリース）。v1は従来どおり物理宣言元を提供せず、明示adapterでv2を生成する。Stage C1は通常project configurationの明示登録に限定する。buildscript、Android固有モデル、外部included buildの探索拡張はC2以降とし、対応前は従来のunknown／省略を維持する。

#### 6.6.1 宣言元と信頼の意味

`declared_in`は「実依存の追加を記述した物理ファイル」の完全な集合とする。versionの格納先、pluginを適用しただけのconsumer、所有projectのbuild fileは代用しない。行番号・呼出し元stack・ソース文字列検索は証拠にしない。登録adapterはビルド作者の明示的な出所表明であり、悪意のあるビルドが偽のsource-mapを生成することを防ぐ署名機構ではない。MCPが確認するのは契約の整合性・捕捉ファイルの鮮度・対応の完全性である。完全性の根拠には6.6.2の作者表明が含まれ、その採用をMCPの起動設定と応答metadataに明示する。

公式APIの`DependencyHandler`は依存の追加、`Configuration`は宣言集合・継承を提供するが、任意の宣言オブジェクトから物理ファイルを得る契約ではない。Gradleのpluginはscript／precompiled script／binaryの形を取り得るため、plugin IDからソースパスを推測しない。[DependencyHandler](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/dsl/DependencyHandler.html)、[Configuration](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/Configuration.html)、[pluginの実装形態](https://docs.gradle.org/current/userguide/implementing_gradle_plugins.html)

#### 6.6.2 改訂した信頼契約と登録API（registered-helper-v1）

公開API実証を受け、C1は**全ての寄与する追加試行を明示helperへ通すというビルド作者の表明を、利用者が明示的に採用する方式**に改訂する。宣言集合の列挙やreaderの再検証だけで、未登録の同値追加がないことを証明できるとは扱わない。以下はC1aの実装契約（未リリース）。旧adapter version 1／三者の全fingerprint一致案を置き換え、登録APIはversion 2、信頼モデル名は`registered-helper-v1`とする。未公開のJSON schema v2案の中で改訂し、既存schema v1は変更しない。

信頼と検証を次の二層に分ける。

| 主体 | 責任と限界 |
|---|---|
| ビルド作者／CI | 指定scopeで全追加試行・遅延追加・独立重複宣言をhelper経由にしたこと、sourceの指定、実行pluginとソースの対応を表明。未計装の同値追加は見逃され得る |
| exporter | helperの試行台帳、実体との対応、解決後の宣言集合との整合性、mutation、scope閉包、公開APIで取得した解決要求を検証。表明の完全性を自動証明しない |
| MCP利用者 | 起動設定でこの信頼モデルを採用するか決める。JSON内の自己申告だけでは有効化しない |
| reader | 契約ファイル・source・lockの捕捉hash、scope、台帳・binding・fingerprintの整合性を検証。ビルドを再実行せず、登録されなかった同値の追加試行を発見できない |

**起動設定:** `OSV_MCP_GRADLE_DECLARATION_TRUST=registered-helper-v1`の場合だけ、このモデルに基づくdirectの`declared_in`を採用する。未設定はdisabled。値はサーバー起動時に一度だけ読み、プロセス中は固定して3ツールで共通に使う（scanごとに読み直さない）。未知値はサーバーを停止させず、起動時にstderrへ警告してdisabledとして扱い、Gradle metadataのreasonに`declaration_trust_config_invalid`を記録する。誤記で脆弱性スキャン全体が使えなくなることを避けつつ、宣言元は採用しない側へ倒す（他の真偽値設定の未知値は黙ってoffだが、本設定は信頼の採否に関わるため警告とreasonで明示する）。モデルの採用はスキャン先のGradleを実行する許可ではない。設定がdisabledでもgraph由来のrelation／introduced_by／coverageは従来どおり処理し、宣言元不足のreasonを残す。

**ビルド作者の表明:** 信頼済み起動時に`-p <build-root>`と`-PosvMcpDeclarationContract=osv-mcp-gradle-declarations.json`で明示する。固定名のroot相対JSON契約をinit scriptの初期段階で捕捉し、settings／project／buildSrcの評価・コンパイルより前にsource baselineを準備する。契約ファイルは4 MiB以下、通常ファイル・境界内限定、graph入力へ含め、評価中の変更はexport失敗とする。readerも固定名の契約だけを安全に読みhashを確認し、JSONが指す任意の設定ファイルを探索しない。表明のないscopeに自動適用しない。

```json
{
  "contractVersion": 1,
  "trustModel": "registered-helper-v1",
  "catalogPolicy": "none",
  "sources": ["app/build.gradle.kts", "gradle/dependencies.gradle.kts"],
  "scopes": [
    {
      "id": "app-runtime",
      "projectPath": ":app",
      "resolvableConfiguration": "runtimeClasspath",
      "declarationConfigurations": ["implementation", "runtimeOnly"],
      "assertion": "all-contributing-additions-use-helper",
      "mutationPolicy": "immutable-after-add"
    }
  ]
}
```

`declarationConfigurations`は当該resolvable configuration自身と全extendsFrom祖先のうち、実依存を持つものを**全て**含む必要がある。空の祖先もexporterが列挙してclosureを記録し、readerはscopeの漏れを検証する。scopeはproject ID・kind=project・configuration・lock対応へ固定し、別projectや別buildへ流用しない。表明は外部コードによる追加後のmutation／remove／re-addを禁止し、helperでの通常configure action後はimmutable-after-addとする。途中で変更して元に戻す操作はsnapshot比較で検出できないため、これも作者契約違反であり独立検出を保証しない。表明が途中から有効になった場合、観測前の台帳を作れないため不完全とする。C1では複数buildの契約統合は未対応。

登録extensionの擬似API:

```text
// 信頼済み起動段階のみ。project extension生成前に共通registryへ準備
prepareSources(contract) -> SourceHandle[]
// 具体依存を通常どおり一度だけ追加。実行前に試行IDを発行
add(project, configuration, concreteNotation, sourceHandle, configureAction?) -> RegistrationHandle
// copy/removalなども台帳へ残す。元のsourceを自動継承しない
remove(registrationHandle)
// 遅延版はC1bの実証後に提供。metadata目的のProvider.get()は禁止
addLater(project, configuration, provider, sourceHandle, configureAction?) -> RegistrationHandle
```

- `SourceHandle`は評価前のbuild ID・相対path・hashを持つopaque値。未準備sourceは不完全。`add`は通常追加と同じ変換／configure actionを実行し、追加**試行**ごとにIDを発行する。同値依存のaddがfalseでも試行を落とさず、異なるsourceを保持する。returnは試行IDとpending／materialized／removed／unsupported状態で、完全性の保証ではない。
- C1aのsupported範囲は同期的な外部module依存とする。追加前のconfigure action完了後、通常追加が実際に保持した実体を対応付ける。同値で既存実体へ畳まれた場合は独立試行を同じ保持実体へ結ぶ。未知のequals、複数候補、カスタムDependency型は不完全。座標だけで実体を補完しない。
- 元の`register(actualDependencyObject, source)`は移行診断用の`registerExisting`に限定する。追加試行を後から回復できないためC1の完全性には寄与せず、scopeを不完全にする。これでhelper経由だったことに変換しない。
- Provider／bundle／defaultDependencies／withDependenciesを含む遅延追加はC1bの別gateとする。通常のGradle追加処理の必要時に台帳をmaterializeする方式を実証し、Providerの再評価で同一試行を増殖させない。異なる結果の再評価、空／失敗、実体のcopyや追加時刻が追えない場合はscopeを不完全とする。実証前は通常の遅延追加を維持し宣言元を省略する。早期getや無条件whenObjectAddedで実装しない。
- 集合の棚卸しは解決完了後の確定した対象scopeだけで行い、未解決の別configurationを追加実現しない。最終集合の未登録実体は不完全として検出するが、畳まれた未登録試行は検出不能であることをmetadataに明記する。台帳が完全なのはビルド作者の表明が正しい範囲に限る。
- 依存の削除／同値再追加／mutationは解決前後の照合で不明部分を検出したら不完全。同じ保持実体へ複数試行が畳まれている状態で一部を削除した場合もC1では不完全とし、既知sourceだけの一覧を返さない。copyの登録・追加は新しい試行とする。adapterを無効化しても通常追加の意味を変えず、元のGradleエラーは握り潰さない。

#### 6.6.3 JSON v2とfingerprintの責任分離

schema v2は新readerだけが採用し、旧readerではunsupported_schema_versionとしてlockスキャンを継続する。v1 exportモードも残す。現在のv1 readerの未知version判定は実装済み。新しいadapterVersion=2以外の宣言契約はunsupportedとしてdeclared_inを省略し、対応可能なgraph本体の情報は維持する。

従来の「宣言全項目とedge全項目の一致」を廃止し、**解決要求キー**と**追加側の形状**を分離する。edgeに存在しない項目を空／falseで捏造しない。

| データ | 取得元 | readerの用途 |
|---|---|---|
| `declarationAtAdd` | helperで通常追加を行いconfigure actionを適用した時の実体 | 追加側snapshotの基準 |
| `declarationAtResolve` | 解決後の同じ保持実体 | key／shapeのmutation・未対応形の検出 |
| `resolutionKey`（edge側） | rootの非constraint edgeのModuleComponentSelector | 宣言側keyとの完全一致、実selected GAVへのbinding |
| `shape`（宣言側のみ） | ModuleDependency等の公開API | C1aで対応済みの既定形かを検査。edgeと一致したとは主張しない |

以下はcontextの追加部分の例。graphの残り、source inventory・graph入力、catalogInputsは省略する。edgeのrequestedは既存形式を維持する。

```json
{
  "edges": [
    {
      "id": "e1", "fromVariant": "root-v", "selectedVariant": "client-v", "constraint": false,
      "requested": { "kind": "module", "group": "org.example", "name": "client", "selector": "1.+" },
      "resolutionKey": {
        "version": 1, "status": "supported", "kind": "module", "group": "org.example", "name": "client",
        "versionConstraint": { "required": "1.+", "preferred": "", "strict": "", "rejected": [], "branch": null },
        "attributes": [], "capabilitySelectors": []
      }
    }
  ],
  "declarations": {
    "adapterVersion": 2,
    "trust": {
      "model": "registered-helper-v1", "contractPath": "osv-mcp-gradle-declarations.json",
      "contractSha256": "<64-hex>", "scopeId": "app-runtime"
    },
    "inventoryComplete": true,
    "configurationClosure": ["runtimeClasspath", "implementation", "runtimeOnly"],
    "configurationTopology": [
      { "name": "runtimeClasspath", "extendsFrom": ["implementation", "runtimeOnly"], "hasDependencies": false },
      { "name": "implementation", "extendsFrom": [], "hasDependencies": true },
      { "name": "runtimeOnly", "extendsFrom": [], "hasDependencies": false }
    ],
    "records": [
      {
        "id": "d1", "state": "materialized", "ownerProjectId": "main::app", "configuration": "implementation",
        "declarationAtAdd": {
          "key": {
            "version": 1, "status": "supported", "kind": "module", "group": "org.example", "name": "client",
            "versionConstraint": { "required": "1.+", "preferred": "", "strict": "", "rejected": [], "branch": null },
            "attributes": [], "capabilitySelectors": []
          },
          "shape": { "version": 1, "status": "supported", "artifacts": [], "targetConfiguration": null,
            "endorseStrictVersions": false, "transitive": true, "excludes": [] }
        },
        "declarationAtResolve": {
          "key": {
            "version": 1, "status": "supported", "kind": "module", "group": "org.example", "name": "client",
            "versionConstraint": { "required": "1.+", "preferred": "", "strict": "", "rejected": [], "branch": null },
            "attributes": [], "capabilitySelectors": []
          },
          "shape": { "version": 1, "status": "supported", "artifacts": [], "targetConfiguration": null,
            "endorseStrictVersions": false, "transitive": true, "excludes": [] }
        },
        "source": { "kind": "build-script", "path": "app/build.gradle.kts", "sha256": "<64-hex>" },
        "catalogUses": [], "reasons": []
      }
    ],
    "bindings": [{ "edgeId": "e1", "declarationIds": ["d1"], "complete": true, "reasons": [] }],
    "reasons": []
  }
}
```

**解決要求キーv1:** supported形は例の全フィールド必須・未知key拒否。group/nameは既存module atom、版制約はrequired／preferred／strict（未指定は空文字）、rejected（文字列集合）、branch（文字列またはnull）。attributesは`{name, type, value}`集合。typeはstring／boolean／integer／named、primitiveは対応型、namedは`{className, name}`を持つ。属性の宣言型も含めて比較し、configurationのconsumer属性をrequested属性へ混入させない。C1aでは属性は空のみ対応とし、非空の既知形はbindingをunsupportedにする。将来拡張時に型付き値の対応を実証する。

capabilitySelectorsは`getCapabilitySelectors()`の**全て**を対象にする。C1aは空集合だけsupported。新selectorを取り落とす可能性がある`getRequestedCapabilities()`だけの検査で空とみなさない。非空・未知selectorは公開値をtoString()して出さずkey全体をunsupportedとする。要求キーの取得責任は宣言側とedge側で独立する。[公式ComponentSelector API](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/component/ComponentSelector.html)

**追加側shape v1:** C1aのsupported形は例にある既定値だけで、全フィールド必須。artifacts非空、targetConfiguration非null、endorsement有効、transitive=false、excludes非空は`{version:1,status:"unsupported",reason:"unsupported_declaration_shape"}`とする。非既定shapeの細目・URLは出力せず、C1aのreaderもsupported形に非既定値があれば採用しない。特にplatform／test fixtures／classifier／custom artifactを通常module扱いへ丸めない。独立edge検証のないこれらの対応拡張は別adapter・別gateで実証する。[公式ModuleDependency API](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/ModuleDependency.html)

**共通正規化:** key／shapeのobject順は意味を持たず、集合配列は型付きtupleで辞書順に並べる。rejectedの完全一致重複だけを除去し、重複属性名は不正として拒否する。大文字小文字・空白・版文字列・nullと空文字を保持する。文字列最大4,096、配列各128件、integerはsafe integer限定。区切り文字連結や任意オブジェクトのtoString()による指紋化をしない。未取得・未対応keyは`{version:1,status:"unsupported",reason:"unsupported_resolution_key"}`とし、空の取得成功値で代用しない。未知version・型違反・必須項目欠落は文書不正、明示unsupportedは宣言binding不完全として分ける。

**readerの検証:** declarationAtAddとdeclarationAtResolveのkey／shapeが正規化後完全一致し、かつ両shapeがC1aのsupported既定形であることを検証する。その上で宣言keyとedgeのresolutionKeyの完全一致、既存requestedのgroup/name/selectorとkeyの整合性（selectorは同じModuleComponentSelector.versionから出す値、rich version時の導出規則は将来の版別adapterで固定）、root非constraint参照、scope・全試行の被覆、source/hash、selected GAVとlockを検証する。C1aはpreferred／strictが空、rejectedが空集合、branch=nullの要求だけを採用し、requiredとselectorが完全一致することを検証する。rich versionはC1aではunsupportedとし、別adapterの実証なしにrequiredだけからselectorを推定しない。binding.complete=trueだけでは採用しない。shapeをedgeへ転記する、解決keyだけ一致すれば未対応shapeも採用する、という処理は禁止する。

`configurationTopology`はexporterが解決後に取得した閉包の全nodeを一意nameと直接extendsFrom・hasDependenciesで表す。readerは参照整合性、resolvable rootからの到達閉包とconfigurationClosureの一致、依存を持つ全nodeの契約scope収録、各recordの所属を検査する。topologyそのものが実際のビルドに一致するかはproducerの信頼範囲であり、台帳・表明・graphだけから別の事実を証明したとは表示しない。node最大2,000/context、親参照最大2,000/nodeで、byte・専用index予算も適用する。

recordのstateはmaterialized／pending／removed／unsupported／unregisteredとし、materializedだけが通常bindingへ寄与する。pending／unsupported／unregisteredのsnapshotはnullを許し、理由必須・inventoryComplete=falseとする。removedの試行はtombstoneとしてsourceと元snapshotを保持し、bindingへ含めず、C1aではscope全体を不完全にする。未登録宣言や保持実体への対応不能を既知recordの削除で隠さない。

sourceのkindはbuild-script／applied-script／convention-plugin。未登録を観測した宣言はsource=nullとreasonを残す。sourceは評価前inventoryと同じpath/hashを持つ。catalogUsesはcatalogInputId・alias等の任意補助情報で、物理source集合にcatalogを混ぜない。リモート／programmatic catalogの鮮度規則は6.6.5を維持し、信頼表明で回避しない。

#### 6.6.4 台帳と解決edgeの対応・完全性の根拠

1. 信頼済み契約を評価前捕捉し、指定scopeにhelper台帳を導入する。全追加試行を独立IDで保持する。コレクションの通知回数を試行数とみなさず、whenObjectAdded／all等の網羅通知を登録しない。scope表明がなければdirectの宣言元は不完全とする。
2. Gradleが通常どおり解決した後でscopeの継承閉包・保持実体・台帳を照合する。未登録実体・未追跡copy・pending／unsupported試行・mutation・scope漏れを一つでも観測した場合、scope全体のinventoryComplete=falseとする。未計装の同値追加は検出できないので、検出がないことを表明の独立証明として表示しない。
3. 同じ試行の継承diamondはIDで重複除去する。別sourceの同値追加試行は別IDのまま保持し、一つの保持実体・root edgeへ合流しても全sourceを残す。configure action完了後の追加snapshotと解決後snapshotを比較する。未対応の遅延追加や解決前後で値が異なる試行があればC1aではscope全体を不完全とする。
4. 対応済みの同じresolutionKeyを持つ全試行とroot非constraint edgeを群化する。群内に未対応shapeがなく、全辺が同じselected GAVへ解決され、variant／要求の対応が曖昧でない場合に全試行のsourceを集合併合する。全edgeをbinding一件ずつで被覆し、同じ群の全試行ID集合を各bindingへ記録する。未被覆試行、binding漏れ、重複edge ID、重複宣言ID、別context参照は不正または不完全として採用しない。readerは群の完全性を再計算する。
5. force／conflictで版だけ変わる場合は実際のselected GAVへ対応付ける。module名変更substitution、module→project、project→moduleはC1aでは宣言元unsupported。constraintはbinding対象外、project-only経路にappのsourceを付けない。platform等の非既定shapeはC1a未対応。グラフのrelation／introduced_byは既存どおり保持する。
6. 正しい表明、利用者のモデル採用、全必要contextのscope被覆、棚卸し、既定shape、key対応、source/input/lock hash検証が揃って初めてdeclaredInComplete=trueとする。これは**registered-helper-v1の作者表明を信頼した完全性**であり、無条件の自動検出ではない。どれか不完全なら同GAVの一覧全体を省略する。予算と複数lockのAND併合は既存契約を維持する。

| 利用者設定・証拠 | directの宣言元 | graph関係／coverage |
|---|---|---|
| disabled、表明なし、旧adapter | 不完全・省略 | 検証済みgraphを維持 |
| accepted、同期helper、scope／key／shape／source全検証成功 | 作者表明に基づく完全な一覧＋信頼metadata | 既存判定を維持 |
| acceptedだが観測可能な未登録実体・mutation・pending | scopeの全directを不完全・省略 | 宣言元だけの失敗ならgraphを維持 |
| 作者表明が偽だが未計装同値追加が畳まれ検出不能 | 独立検証できない。受理され得る限界をmetadataに必須表示 | 自動検出保証と表現しない |
| source／契約等のgraph入力hash不一致 | 不採用・省略 | context全体stale。lockスキャンのcoverageを維持 |

**改訂後の実装gate:** C1aはGroovy／Kotlin、Gradle 8.11.1／9.2.1で同期literal・同値重複試行・scope継承・force後の版・未登録実体・mutation・起動設定disabledを実証する。ビルド作者の表明が偽の未計装同値追加を検出できない陰性例も残し、metadataがその限界を伝えることを確認する。C1bはProvider／bundleの実現時刻・実行回数・結果・台帳identityがadapterなしと一致することを追加実証するまで未対応。同期helper核の実証は下記のC1a結果を参照する。本番adapter／v2 readerの実装と結合検証は次節を参照。C1bは引き続き未対応。

#### C1a本番adapter・静的取込（2026-10-31、未リリース）

- `gradle/register-declarations.init.gradle`を追加し、既存exporterとともにnpm配布対象へ登録。利用者が両init scriptを明示実行する。adapterなしはv1、adapterありはv2、互換用にosvMcpSchemaVersion=1を指定可能。MCPはinit scriptを実行しない。
- C1aはcatalog利用を自動証明できないため、契約の必須項目にcatalogPolicy=noneを追加した。これは作者表明であり、未知のcatalog利用を独立検出する保証ではない。Provider／bundleとconvention-plugin sourceの採用は未対応。契約のsources・scopes・固定名・hash・重複・境界・サイズを検証し、評価前source baselineを準備する。
- project extensionはosvMcpDeclarations。source(path, kind=build-script)で準備済みのopaque handleを取り、add(configuration, notation, handle, Action?)で追加する。remove(handle)はtombstoneを保持し不完全にする。Groovy／Kotlinの使用例はREADMEへ記載。型付きの独立plugin artifactの配布は今回含めず、KotlinはwithGroovyBuilderで同じ公開extensionを使用する。
- scalarの通常追加は追加試行を全件保持し、集合が同値追加を捨てても既知保持実体へ結び付ける。追加時の集合列挙は行わず、未解決Providerを早期実現しない。Providerは通常のaddProvider経路へ委譲し、台帳をunsupportedとする。観測可能な未登録実体・削除・mutation・scope不足はinventoryComplete=falseとして出力する。
- レビュー修正: 保持実体はallDependenciesの集約集合ではなく、継承閉包内の各configurationのdependenciesをidentity集合にして照合する。異なるconfigurationの同値実体が集約時に消えても両試行を保持し、逆に同値の未登録実体が集約から消えても各宣言集合で検出する。同じ試行がdiamondで継承される場合のID重複除去は維持する。
- readerはschema v1/v2を受け付け、未知の将来versionと不正文書を区別する。v2のedge ID、declaration ID・binding参照、JSON重複key・深さ・型・上限を検証する。宣言解析はrelationから独立したscan共有index／traversal各200万操作を使用する。契約とsourceは安全に一度だけ捕捉し、許可suffix、4 MiB/件・64 MiB/scan、symlink拒否・境界制約を維持する。
- scope閉包・topology・全試行のbinding被覆、key／shapeの前後一致、既定shape、要求とselected GAV、source/input/lock hashを再検証する。convention-pluginや非既定shape、variant対応の曖昧さを成功へ丸めない。宣言元の失敗だけでは既存relation・introduced_by・脆弱性coverageを落とさない。graph入力の不一致や参照破損は従来どおりgraph採用不可。
- `OSV_MCP_GRADLE_DECLARATION_TRUST`は未設定で不採用、registered-helper-v1だけ有効。サーバー起動時に一度だけ読み、プロセス中は固定する。その他の値は起動を止めず、stderr警告・disabled扱い・全Gradle lockのmetadataに`declaration_trust_config_invalid`を記録する(レビュー修正、6.6.2/C23に一致)。採用時はdeclaration_provenanceのtrust_model／trust_status／assurance／contract_paths／limitationsを返す。同じGAVの全context／lockで完全性をANDし、不完全なsource一覧を抑制する。
- レビュー修正: trustはconfiguration別に保持し、一覧の採用は当該contextの検証結果だけで決める。lock全体のprovenanceはinvalid > missing_assertion > accepted（利用者未採用時はdisabled）の優先順位で集約する診断情報とし、一覧抑制のglobal switchにしない。contexts配列をconfiguration名順に返し、各contextのtrust_status・assurance・contract_pathsを示す。全体がinvalidでも独立した正常GAVの宣言元は維持し、同GAVが不正contextにも現れる場合は既存AND併合で全省略する。
- scan_project／scan_java_project／suggest_fixの共通captureへ接続した。declared_inはlock位置からの相対pathへ変換して既存のscan-root prefix処理に渡し、suggest_fixは確定したGradle宣言元を更新案内に示す。sourceや契約JSONをOSV入力へ追加しない。

最終検証（レビュー修正後）: 全72ファイル／1,522テスト、typecheck・buildが通過。Gradle 9.2.1でも本番結合10件が通過。npm packのdry-runで両init scriptの同梱とテスト／文書の除外を確認した。

結合検証は`src/test/gradle/registeredExporter.integration.test.ts`。実装時の3ツール応答回帰ではscannerをmockしてsource情報の接続と抑制を確認した。後続のC1a実接続ではGroovy 8.11.1／Kotlin 9.2.1の実scannerで3ツール×信頼設定有無の12呼出しと候補8件の独立OSV照会が成功し、declared_in・信頼metadata・更新案内を確認した。詳細は[実接続記録](GRADLE_LIVE_VALIDATION.md#stage-c1a-本番adapter静的取込の実接続2026-10-31)を参照。本番の二つのinit scriptから実JSONを生成し、Groovy／Kotlin × Gradle 8.11.1／9.2.1で両sourceの静的取込、信頼未採用時の省略、v1互換export、applied scriptによる評価中のsource変更拒否・既存companion不変を確認する。単体／3ツール回帰は改ざんbinding、snapshot mutation、source/契約のstale・symlink、scope不足、専用予算、別variant、複数lockの順序非依存の一覧抑制、信頼設定の固定を確認する。元の試作テストと新しい本番結合テストの役割は区別する。

追加した回帰条件: C02へimplementation／runtimeOnlyの同値依存の陽性と、登録済み集合が先に集約される場合の未登録同値依存の陰性を両DSLで追加。C19／C28へ正常・契約hash不一致contextの順序逆転を追加し、別GAVなら正常なdeclared_inを保持、同GAVなら全省略、provenance集約とcontext別診断は同一になることを単体と3ツールで確認する。修正前にこれらが失敗することも確認した。

#### C1a同期helperの実証結果（2026-10-31）

改訂契約の同期helper核を`src/test/fixtures/gradle-c1a-helper.init.gradle`に試作し、`src/test/gradle/synchronousHelper.integration.test.ts`で検証した。**テスト専用**であり、本番exporterやnpm配布へは追加していない。Groovy／Kotlin DSL × Gradle 8.11.1／9.2.1の4構成で各13テスト、計52件が通過した。JDK 21.0.13+9を使用し、各fixtureのローカルMaven POMだけで`--offline`解決する。外部scanner・OSVは呼び出していない。

| 実証対象 | 4構成共通の結果 |
|---|---|
| build scriptとapplied scriptから同値moduleを追加 | 保持実体1・edge1に対し台帳2試行。二つのsourceを完全な集合として保持 |
| base→left/right→diamondの継承 | baseの試行を一度だけ収録。consumerへsourceを付け替えず、保持実体1・試行1 |
| 追加後の要求版1→2のmutation | snapshot差を検出。scope不完全、宣言元一覧を全省略。実graphの要求版・選択版は2 |
| 別moduleの未登録追加 | unregistered_declarationを検出してscope不完全・一覧省略 |
| 保持実体を削除し同座標copyへ置換 | identity喪失と未登録copyを検出。旧sourceの転用なし |
| 契約scopeの継承祖先漏れ／表明なし | scope_incomplete／declaration_assertion_missingで一覧省略 |
| helper removeによるtombstone | 試行IDを残し、不完全として一覧省略 |
| transitive=falseの非既定shape | unsupported_declaration_shapeで一覧省略。通常moduleとして完全扱いしない |
| forceで要求1から選択2へ変更 | 元の要求keyに対応したsourceを選択版2へ結び付ける |
| configure action／通常追加経路との比較 | helper有効・利用者未採用・通常DependencyHandler.addの3経路で全13シナリオの要求／選択graph・保持依存数が一致。action呼出しは各2回で一致 |
| 無関係な未解決configurationのProvider | 全経路で未評価のまま。網羅的な追加通知やmetadata目的の実現を行わない |
| 利用者の信頼未採用を模した経路 | graphを維持して全宣言元一覧を省略 |
| 未計装の同値追加／変更後に元へ戻したmutation | 自動検出できず受理され得ることを確認。両限界をacceptedの報告に併記。検出成功と誤記しない |

この試作は、追加試行のconfigure action完了後snapshotを追加前に保存し、通常集合への追加が畳まれた場合も試行を捨てず保持実体へ対応付ける。解決後にscope閉包・全保持実体・試行snapshot・公開selector keyを照合する。key／shapeの値はGradleのコレクションを変更せずコピーして比較し、非既定shapeは成功値へ丸めない。Kotlin側からはwithGroovyBuilderで同じ試作extensionを呼ぶ。

**到達点:** C1aの同期literal・同値試行保持・継承・force・観測可能な未登録実体・mutation・宣言元抑制の実証条件を満たした。各構成は三つのsubprojectで通常追加経路と比較する。ソースは起動前にfixture契約からhash捕捉し、解決後に不変を確認した。未登録の同値追加と元に戻したmutationを検出できないという作者表明への依存は残る。

**未実証／未実装:** この報告JSONは本番v2通信形式ではない。信頼の有効／無効はsubproject別の試作modeで表し、実際のMCP起動設定の解析、SourceHandleの公開API、契約/schemaの厳格検証・安全な読取、lock hash対応、複数lockの完全性併合、declaration_provenanceの本番応答、Groovy／Kotlin用の型付き配布APIは今後の実装対象。Providerの解決が必要なC1b、失敗するProviderの挙動、platform／catalog bundle／convention pluginのsource-artifact対応も達成証拠には含めない。既存Stage A/Bの挙動は変更していない。

追加後の全体検証は実Gradle 8.11.1・従来の公開API実証・性能比較を含む全70ファイル／1,479テストが通過。Gradle 9.2.1の新しい両DSL実証26テストも通過し、typecheck・build・差分の空白チェックも成功した。

各構成の結果と試作sourceのSHA-256を[検証データ](validation/gradle-c1a-2026-10-31.json)へ保存した。元の詳細報告は任意の`OSV_MCP_GRADLE_C1A_OUTPUT` prefixへ保存でき、未指定時はfixtureとともに削除する。

```sh
env OSV_MCP_TEST_GRADLE=/trusted/gradle-8.11.1/bin/gradle \
  JAVA_HOME=/trusted/jdk-21 GRADLE_USER_HOME=/trusted/gradle-cache \
  OSV_MCP_GRADLE_C1A_OUTPUT=/tmp/osv-c1a \
  npm test -- src/test/gradle/synchronousHelper.integration.test.ts
```

同じテストをGradle 9.2.1でも実行する。初回の同値試行テストは試作未配置時の失敗を確認してから通過させた。追加した回帰テストは実Gradleの保持実体・graphと最終報告を確認し、MCP側のモック結果だけを根拠にはしていない。

#### 公開API実証の結果（2026-10-31、旧C1契約のgateは未充足）

`src/test/gradle/declarations.integration.test.ts`とtest専用init script `src/test/fixtures/gradle-declaration-probe.init.gradle`を追加し、Gradle 8.11.1／9.2.1、JDK 21で実行した。各版5テストを、通知登録あり／なしの2ビルドで確認。依存は一時領域のローカルMaven POMだけを使い、`--offline`で実行した。通常projectのGroovy DSLを使う公開APIの実証であり、Kotlin DSLやC1全体の対応完了を意味しない。

| 確認事項 | 両版の観測結果 | 設計への影響 |
|---|---|---|
| 別インスタンスの同値依存を2回追加 | 宣言集合1件、whenObjectAdded通知1件、root実依存edge1件 | 宣言集合と追加通知だけでは未登録の重複宣言を検出できない。これだけを根拠にinventoryComplete=trueにしない |
| Providerの依存をaddLaterで追加 | 通知なしは解決まで未評価、whenObjectAdded登録ありは解決前に評価済み。最終edgeは両者1件 | 通知の導入自体が遅延評価を変える。無条件のwhenObjectAddedを本番adapterの観測手段として採用しない |
| defaultDependenciesの追加 | 通知ありで解決前0件、解決後1件、edge1件 | 構成終了時だけの棚卸しでは遅延宣言を取り落とす |
| Dependency.copy() | 座標は同じ、identityは別 | 元実体の登録をcopyへ移してはならない。equals/contentEqualsの版間互換性には依存しない |
| 追加後に要求版を1から2へ変更 | 追加通知は1件のまま、解決前の要求版は2 | 追加通知はmutation検出にならない。追加時と解決直前のsnapshot比較が必要 |
| ModuleComponentSelectorの公開interface | attributes・requested capabilitiesは取得可能。ModuleDependency側のgetArtifacts／isEndorsingStrictVersionsに対応するgetterはない | 現行fingerprintの全項目をedgeから独立構築する契約は、このAPIだけでは成立しない。未取得項目を既定値で埋めない |

プローブは公開interfaceのmethod名だけを列挙し、内部実装クラスへのreflection・private field参照はしない。Providerのcallback回数は再評価で増え得るため、通知回数を宣言数と同一視しない。テストは特定の再評価回数を固定しない。

**当時の判定:** 改訂前の6.6.4の実装開始条件は未充足。v2 readerや本番adapterを有効化せず、Stage A/Bの挙動を維持する。現在の実証で「公開APIを使うどんな方式も不可能」とは結論しないが、単純なコレクション通知＋ResolutionResultだけの方式は不採用とする。

その後の設計判断として、6.6.2〜6.6.4の明示helper信頼モデルを採用する案へ改訂した。未計装同値追加の検証不能性は利用者が明示的に採用する信頼範囲とし、解決要求キーと宣言shapeを分離した。上の実証結果は旧方式の限界の証拠として保持し、新方式の有効性の証明へ読み替えない。改訂設計も実装前レビューと新gateの実証を要する。

再現方法（各Gradle版で同じテストを実行）:

```sh
env OSV_MCP_TEST_GRADLE=/trusted/gradle-8.11.1/bin/gradle \
  JAVA_HOME=/trusted/jdk-21 GRADLE_USER_HOME=/trusted/gradle-cache \
  npm test -- src/test/gradle/declarations.integration.test.ts
```

`OSV_MCP_GRADLE_PROBE_OUTPUT`に出力prefixを指定すると、版別・通知あり／なしのJSON報告を保存できる。未指定ならfixtureと報告はテスト終了時に削除する。スキャナーやOSVを起動するテストではなく、本番出力にも影響しない。

追加後の検証: Gradle 8.11.1の実export回帰・公開API実証・性能比較を含む全69ファイル／1,453テストが通過。9.2.1の公開API実証5テストも通過。typecheck・build・差分の空白チェックは成功。新しいOSV実接続は行っていない（本番スキャン処理の変更なし）。

#### 6.6.5 sourceの鮮度・読取範囲

- 既存の評価前hash捕捉を維持し、source inventoryも評価／pluginコンパイル前に捕捉する。export task実行時の初回hashでは不十分。buildSrc／included plugin buildのソースを捕捉するには、それらの評価・コンパイルより先の信頼済み起動段階が必要。準備できなければconvention pluginのsourceは未検証とする。
- 登録時、export開始時、解決後・atomic write直前に基準と比較する。既知sourceや既知inputの変更／生成／削除はexport全体を失敗させ、既存JSONを上書きしない。評価前不在のsourceを後から生成して登録しても採用しない。
- MCPは現在のscan boundary内にある列挙済みローカルsourceだけを安全に捕捉する。root相対path、symlink拒否、通常ファイル限定、4 MiB/件・64 MiB/scan、同じbytesをhash照合と案内に使用する。境界外のbuild-logicをJSONを手掛かりに探索しない。
- C1のsource許可種別は`.gradle`／`.gradle.kts`、convention plugin実装の`.kt`／`.java`／`.groovy`。catalog補助入力は`.versions.toml`。任意suffixを許可せず、既存input readerの拡張を明示的に実装する。追加のJSON入力は6.6.2の固定名osv-mcp-gradle-declarations.jsonだけを例外として許可し、4 MiB/件・64 MiB/scanの同じ捕捉予算を使う。ファイル本文をOSVへ送らず、snapshotのスキャナー入力にも追加しない。
- グラフ用inputと宣言元専用inputをv2で分離する。依存を追加するscript・plugin実装・使用catalogは解決に影響し得るため必ずgraph入力にも含め、宣言元専用へ格下げしない。宣言元専用は解決へ影響しない登録対応表等に限り、C1でその種別を実装しない場合は空とする。前者が不一致なら従来どおりcontext全体をstaleとする。後者だけ不一致／検証不能ならそのsourceを使うbindingを不完全とし、検証済みgraphのrelation・introduced_by・coverage証拠は保持する。同じファイルが両役割なら厳しいgraph側を優先する。
- catalogのgraph入力は種類別に固定する。ローカルTOMLは実際にimportされた全TOMLとcatalogを構成・上書きするsettings／pluginソースを評価前捕捉し、MCPが同じpath/hashを確認する。programmatic catalogは構築コードと参照したローカル入力の全てを同じ契約で捕捉できた場合のみ対応し、編集先キーだけが不明でもgraphと宣言元を維持できる。環境変数・外部サービス・未捕捉ファイルに依存して内容が決まる場合はC1では検証不能とする。
- v2 contextに必須の`catalogInputs: {inventoryComplete: boolean, entries: [...]}`を設ける。各entryはcontext内一意ID、kind（local-toml／programmatic／remote）、state（verifiable／unverifiable）、graphInputPaths（既存graph入力への参照集合）、reason（nullまたはcatalog_graph_inputs_unverifiable）を持つ。verifiableはremote不可・全参照のpath/hash検証必須。catalog不使用は棚卸し済みの空集合として表す。inventoryComplete=falseは影響不明として全文書を採用不可にする。任意のcatalogUsesを省略しても必須のcatalog入力検査を回避できない。catalogUsesに出す場合はcatalogInputIdで対応するentryへ結び付け、未知IDはschema参照不正とする。
- リモート配布catalogはartifactの同一性と評価前入力をローカルpath/hash契約だけでは確認できないため、C1では`catalog_graph_inputs_unverifiable`とする。未捕捉入力を持つprogrammatic catalogも同じ扱い。該当catalogの使用が確認されたcontextはgraph採用不可としてrelation=unknown、introduced_by／declared_inを省略し、relations_complete／declarations_complete=falseとする。catalog影響contextを列挙できない場合は文書の全contextへ適用する。独立に検証できた別contextの証拠は保持する。これはスキャン範囲の欠けの証拠ではなくmetadataの検証制限なので、lockスキャン由来のcoverageは維持する。編集先が不明なだけの対応済みローカルcatalogと混同しない。
- adapter source-mapの鮮度もビルド全体の再現性は保証しない。binary pluginの実行バイナリとローカルsourceの対応を証明できない場合、同名ソースがあるだけでは採用しない。C1のconvention-plugin対応は同じexport実行で準備済みローカルソースから構築されたことをadapterが確認できる形に限る。

convention pluginの具体化した拡張案は[GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md](GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md)を参照。buildSrc／included build／独立配布pluginを分け、起動前入力捕捉、source-artifact対応、独立trust、完全性、CP01〜CP36の回帰条件を定義する。設計段階であり、本番のconvention-plugin拒否は維持する。

#### 6.6.6 宣言方法ごとの扱い

| 宣言方法 | `declared_in` | 補助情報／省略条件 |
|---|---|---|
| build scriptのliteral／変数 | 実際に追加したbuild script | 変数の定義元やversion保持元は自動推定しない |
| `implementation(libs.client)`（C1b gate後） | aliasを使用して追加したscript／plugin実装 | C1aはProviderのまま通常追加して宣言元を省略。catalogは別のversion編集候補。alias未使用なら証拠なし |
| catalog bundle（C1b gate後） | 使用箇所のscriptを展開後の各依存へ登録 | 実証前は宣言元を省略。Providerを早期実現してC1aへ変換しない。同じmoduleを含む複数alias／bundleも全独立試行を保持 |
| version.ref／rich version／上書きcatalog（graph入力検証済み） | 使用箇所のscript | catalogから最終versionの編集先を一意に取れないときは具体的な編集キーを案内しない。library alias・version alias・bundle aliasを混同しない |
| precompiled convention plugin | 依存を追加した`.gradle.kts`／`.gradle`ソース | consumerの`plugins {}`だけを宣言元にしない |
| ローカルbinary convention plugin | 依存を追加した`.kt`／`.java`／`.groovy`ソース | sourceと実行artifactの対応未確認なら省略 |
| 外部配布plugin／remote script | 確認できなければ省略 | 外部ソースを取得せず、consumer build fileへ置換しない |
| `apply(from=...)`・多段apply | 実際に依存を追加した末端script | applyした側を追加しない。末端scriptの評価前準備が必要 |
| rootの`subprojects`／`allprojects` | 追加処理を書いたroot側script | ownerは対象子project。同名projectでもbuild IDで分離 |
| `extendsFrom` | 元の宣言を追加したscript | consumer configurationやbuild fileに付け替えない |
| helperを利用する呼出し | API契約で指定した追加箇所 | helperが内部で座標を決め追加するならhelper実装、callerが具体依存を渡して追加する登録helperならcaller。汎用のstack推定をしない |

catalogは依存の要求を共有する仕組みで、選択版そのものを保証しない。実際の出力GAVは引き続き解決graphのselectedを使う。[公式: Version catalogs](https://docs.gradle.org/current/userguide/version_catalogs.html)。convention pluginの構成例は[公式ガイド](https://docs.gradle.org/current/userguide/implementing_gradle_plugins_convention.html)を参照する。

#### 6.6.7 完全性と応答の判定

完全性の単位はまず`(lock, context, selected GAV)`、その後に同GAVの全context／全sourceへANDで併合する。対応済みの単一GAVのsource検証失敗等はそのGAVへ限定できるが、未登録実体・scope漏れ・台帳のmutation等の作者表明に関わる矛盾は、scope全体のinventoryを不完全とし、全direct GAVの宣言元を省略する。矛盾のない別GAVでscopeを部分的に完全扱いしない。

| 状態 | `declaredInComplete` | `declared_in`への寄与 |
|---|---|---|
| directで利用者が作者表明を採用し、全binding・全宣言の検証成功 | true | 全宣言sourceの重複除去集合（非空必須、信頼モデルをmetadataへ併記） |
| directの一件でも未登録／曖昧／source検証不能 | false | 既知部分も最終一覧から省略 |
| graphが完全で確定transitive、直接宣言なし | true | 完全な空集合。親の宣言fileを付けない |
| unknown／context不足／graph予算超過 | false | 宣言元を補完しない |
| v1／adapter未提供 | directはfalse、確定transitiveはtrue | 既存挙動を維持 |

- directの宣言元を採用したmetadataには必ず`declaration_provenance`を出す。`trust_model: registered-helper-v1`、`trust_status: accepted | disabled | missing_assertion | invalid`、`contract_paths`（scan相対の検証済みpath集合）、`assurance: author-attested-and-structurally-checked`（accepted時だけ。それ以外はnull）、`limitations: [unregistered_equal_additions_not_detectable, reverted_external_mutations_not_detectable]`を持つ。各lockのmetadataへ付け、複数モデルを単一のaccepted状態へ潰さない。これを返せないreaderは同モデルのdeclared_inを出さない。モデル未採用／表明なしは宣言元不完全で、relationと脆弱性coverageには影響しない。既存の確定transitiveの完全な空集合は作者表明を必要としない。
- 解決graph自体が不完全なcontextからdirectの証拠だけ得られる場合も、C1では宣言元の完全性はfalseとする。完全な別contextで穴埋めしない。
- bindingの不完全性はintroducedByCompleteへ伝播しない。逆にorigin探索の失敗時は、独立に完全な宣言bindingを得る実装契約がないC1ではfalse。将来独立計算へ移行する場合も、最終併合の二つのflagは分ける。
- `declarations_complete`は対象lockの全必要contextで全direct GAVの宣言元が完全な場合のみtrue。`relations_complete`とは独立。metadata `status`は現行どおりグラフ関係の状態を保ち、宣言元の不足は専用flagとreasonsで示す。空のcontextもadapter棚卸しが未完了なら宣言元完全とは宣言しない。
- 理由code: `declaration_adapter_missing`、`unsupported_declaration_adapter`、`declaration_inventory_incomplete`、`unregistered_declaration`、`ambiguous_declaration_binding`、`unsupported_declaration_selector`、`unsupported_substitution_mapping`、`declaration_source_unprepared`、`declaration_source_unverifiable`、`stale_declaration_source`、`declaration_budget_exceeded`、`catalog_graph_inputs_unverifiable`、`declaration_trust_disabled`、`declaration_assertion_missing`、`declaration_contract_mismatch`、`unsupported_resolution_key`、`unsupported_declaration_shape`、`declaration_mutation_detected`、`deferred_registration_not_supported`。パス・件数の診断は上限付きでsanitizeし、例外全文は出さない。
- source-mapだけの欠如・stale・制限では`coverage.complete`を下げない。graphに基づく既存のスキャン範囲の欠けは維持する。catalog編集情報だけが不明でも、catalogのgraph入力と使用箇所の証拠が完全なら`declared_in`は維持する。catalogのgraph入力自体が検証不能な場合は6.6.5のcontext不採用規則を優先する。
- `suggest_fix`は確定した全宣言元を案内する。catalog等は別の編集候補として扱い、版の実際の管理先が不明なら一般的なGradle制約の確認を促す。`declared_in`にcatalogを混ぜる、POM編集を案内する、source-mapだけで版互換性を保証する、という動作は禁止する。新しい公開catalogフィールドの追加はC1の必須要件にせず、追加する場合は別の応答契約を定義する。

#### 6.6.8 制限と実装順

recordsは10万/context、bindingsはroot非constraint edge数以下（最大20万/context）、source inventoryは1万/document、catalogUsesは各record最大32件を初期上限とする。JSONの既存16 MiB/件・64 MiB/scan制限が先に効く場合も黙って切り詰めない。構造の上限超過は文書無効、対応探索の予算超過は宣言元不完全とし、部分一覧を出さない。

宣言元処理はrelation解析と別の専用予算(index・traversal各200万操作のscan共有)とする。relationの残予算を使う方式では、無関係なsubprojectの追加だけで同じGAVの`declared_in`が消え、またlockfile単位の現行captureをscan全体の二段階処理へ組み替える必要がある。専用予算ならC21の「宣言予算が後続contextのrelation解析を悪化させない」を構造的に満たし、coverage・relationで予算を分けた既存方針とも一致する。contextごとの予算リセットや、全宣言×全edgeの総当たりを避ける。source捕捉はscan内キャッシュを共用し、source数×context数の再読込をしない。宣言元処理で予算が尽きても、確定したrelation／originの結果は破棄せず、failureを宣言元の不完全性として別に保持する。

順序は、(1)改訂信頼契約のレビュー、(2)C1aの同期helper・key/shapeのGradle実証、(3)v2 schema・起動設定・安全なcapture、(4)GAV別完全性と信頼metadata併合、(5)3ツールの案内・実接続、(6)C1bのProvider／catalog bundleとconvention plugin adapterの独立実証、の順とする。各段階で未対応形を省略し、C1の完了条件に含まれる対応形とC2送りの形を検証記録へ明記する。

## 7. coverage・応答・更新案内

- グラフ未提供、source-mapなし、関係だけの予算超過は、lock自体の脆弱性スキャンが完了していれば`coverage.complete=false`の理由にしない。
- 代わりに任意の`dependency_metadata.gradle`を追加する案とする。状態`complete/partial/unavailable`、捕捉したmetadata path、対象context、制限・stale・宣言元未確認の理由を返す。関係・宣言元の完全性を別々に示す。
- coverageの追加証拠として使えるのは、schema・参照整合性、捕捉済みlock hash、既知input hash、project・configuration・scopeの一意な対応を検証できたcontextだけとする。GAV集合の一致は関係情報採用の条件だが、検証済みcontextの集合差分はスキャン範囲の欠けを判定する証拠にできる。未解決要求等が明示された`complete=false`と、文書不正・stale等で証拠自体が無効な状態を区別する。
- 上記の有効なcontextに、スキャンしたlockにないmodule／未解決要求／非対応file依存があると判明した場合は、脆弱性のスキャン範囲にも欠けがある。`skipped_files`等で理由を示し`coverage.complete=false`とする。初期版ではgraph-only moduleを黙って追加スキャンしない。
- 古い／不正なJSON、検証不能なhash、曖昧なcontext対応だけを根拠にcoverageを下げない。その制限は`dependency_metadata.gradle`に記録し、lockスキャンや他の有効な証拠によるcoverage判定を保持する。無効なcontextがあっても、独立に検証できた別contextの欠けは取り消さない。
- メタデータは脆弱性スキャナーへの追加対象にしない。OSVには従来どおりlockを渡し、JSONから得たローカルproject名やURLを追加送信しない。
- グラフだけからGradleの子がroot lockで充足したとは扱わない。Gradle lockは通常project単位なので、子のlockへの明示的対応・hash・収録一致が必要。初期版では既存の子coverageを変更しない。
- `scan_project`・`scan_java_project`・`suggest_fix`で同じ捕捉・照合・RelationLookupを使う。
- **GradleもecosystemはMavenだが、更新案内をPOMにしない。** 現行`updateHint()`のMaven分岐はpom.xml向けなので、元manifest formatから内部のpackage-manager contextを伝える。Gradle-onlyではGradle案内、Maven/Gradle混在なら両方の変更先を案内する。
- directは確定した宣言元／catalog等の制約を更新、transitiveは`introduced_by`の直接依存を更新するか明示的なconstraintsを検討し、信頼済み環境でlockを再生成する。`--update-locks`だけで全制約・BOM・互換性が解決すると案内しない。
- 候補版のOSV再照会は現行処理を利用する。候補のartifact有無、Gradle variant、Java/Android互換性まで保証しない。

## 8. 安全な取込と実装配置

### 8.1 取込制限案

- JSON 16 MiB/件・64 MiB/scan、深さ128、重複key拒否、schema厳格検証。
- 宣言元・input file 4 MiB/件・64 MiB/scan。root相対pathのみ。symlink／通常ファイル以外／境界外は既存`safeRead`で拒否する。
- graph indexingとrelationship traversalは各scan共有200万操作。parserは既存同様にバイト数比例のfile別予算。最大component 10万・edge 20万・context 2,000/件を初期上限案とする。
- JSONに書かれたlock・source pathをそのまま開かず、検出済みlockと許可されたcompanion候補へ照合する。任意URL・plugin・スクリプト・絶対パスを評価しない。
- 捕捉した同じlock bytesをhash照合・metadata enrichment・OSV入力に使い、元ファイルの再読込で差し替えを取り込まない。

### 8.2 ファイル／処理の配置案

| 場所 | 役割 |
|---|---|
| `gradle/export-dependency-graph.init.gradle`（配布場所は実装時調整） | 信頼済み環境用exporter。MCPから呼ばない |
| `src/utils/gradleLock.ts` | lockのGAV/configuration/empty entryを検証付きで索引化 |
| `src/utils/gradleGraph.ts` | JSON契約検証、variant/context単位の関係解析 |
| `src/utils/gradleGraphCache.ts` | metadata/input/lockの安全な捕捉とhash照合 |
| `src/utils/manifestDetector.ts` / `projectDetector.ts` | 任意companionの関連付け。Java専用ツールも同一経路へ |
| `src/tools/scanProject.ts` | 既存のsnapshot・RelationLookup・宣言元prefix処理へ統合 |
| `src/osv/suggestFix.ts` | Gradleの更新案内。Maven案内との区別 |

自動検出はbuild root／lockの隣にある既定名だけとし、見つからなくても成功する。lockだけを直接指定した場合は、そのlockに対応するcompanion以外のproject探索を始めない。複数の候補が競合した場合に「最後のファイルが勝つ」方式にしない。直接指定した子lockのスキャン範囲外にbuild-root JSONがある場合は読まず、由来をunknownにする。全体の取込にはbuild rootをスキャンするか、対象project用に分割した隣接companionを利用する。

## 9. 段階的な実装・受け入れ条件

### Stage A: 取得APIと契約の検証

- 代表の8.11系・9.xで、Groovy/Kotlin両DSLの実exportを作る。
- `runtimeClasspath`等の実際のselected集合とlockを比較する。constraintsによるroot edge混入、test fixturesのvariant、module/project substitutionを確認する。
- source-mapなしでは物理宣言元が分からないことを確認し、ownerBuildFileから宣言元を生成しない。

### Stage B: MCP取込と関係判定

- 単一projectの通常lockを対象に、direct/transitive・introduced_byとmetadata状態を実装する。
- 単純な依存、diamond、cycle、複数起点、直接＋推移的、configurationごとの別版、constraint-only、BOM、force、exclusion、unresolvedを回帰テストする。
- JSON欠如・不正・過大・古いhash・部分contextでも既存lockスキャンを保つ。metadataだけの欠けと、判明した脆弱性スキャン範囲の欠けを区別する。
- 同じGAVに確定contextと不明contextが混在するときに、不完全なintroduced_byを出さない。
- coverageの回帰条件: lock更新後に古いJSONだけ残る場合と、lock hashは一致するが既知input hashが変わった場合は、JSONにlock外moduleがあっても由来を採用せず、metadataへstaleを記録する。lockスキャンが完全ならcoverageは完全を維持する。
- schema不正、hash検証不能、context対応の曖昧さも同様にmetadataの制限だけとする。対照として、hash・対応の検証済みcontextにlock外module／未解決要求／非対応file依存がある場合はcoverageを不完全にする。無効なcontextとの混在時にも有効な欠けを保持する。3ツールで同じ結果になることを確認する。

### Stage C: 宣言元・複数project・buildscript

- 明示的な宣言元登録adapterから`declared_in`を供給する。通常記述／catalog／convention plugin／applied script／継承に対して誤ったfileを指さない。
- 複数project、compositeの同名project、buildscript lock、独自lock path、Android等を順に追加する。古いGradleのadapterは必要性を見て別契約で検討する。
- unknownでも所属projectは診断に使えるが、物理宣言元とは区別する。
- 複数lockの回帰条件: 同一GAVを含むlock Aでは由来・宣言元が確定し、lock Bではcompanion欠如／stale／context不足／予算超過となる組合せを作る。最終応答で`introduced_by`・`introduced_by_omitted`・`declared_in`がすべて省略され、入力順を逆にしても一致することを確認する。併合処理の単体テストはStage Bから追加し、実際の複数project取込はStage Cで検証する。
- 完全性を独立して検証するため、両lockの由来は完全だが片方の宣言元だけ不明な場合は`introduced_by`を維持し`declared_in`だけを省略する。逆の場合は宣言元だけを維持する。両方完全なら重複除去した和集合を返し、由来が10件を超えた場合だけ正しいomitted件数を返す。relationの順位処理や`mixed`判定でも完全性が失われないことを確認し、3ツールの最終出力まで検証する。

### Stage C1の回帰テスト条件（実装時の必須条件）

以下は未実装のテスト計画。C1aの陽性は同期的な既定shapeに限定し、C1bや将来adapterを要する形はC1aでは省略する陰性として必須とする。対応拡張時に当該行の陽性条件も満たす。parser／binding／captureの単体テスト、実Gradle exporterテスト、3ツールの最終応答テストを分け、合成JSONだけで対応済みとはしない。実Gradleは8.11.1／9.2.1、通常script・applied scriptはGroovy／Kotlinの両DSLを確認する。未対応構成の陰性は全環境で省略を確認する。

| ID | 入力・操作 | 必須の期待結果 |
|---|---|---|
| C01 | literal／変数／公開keyへ正確に対応できるversionなし宣言を同期helperで追加。起動設定とscope表明を有効化 | 使用scriptだけがdeclared_in。selected GAVと対応し、作者表明を採用したmetadataを併記。版変数の定義元を混ぜない |
| C02 | 同じGAVを二つのscript、二つの宣言configurationから同期helperで追加し、一つのroot edgeへ合流 | 両追加試行IDと全sourceの和集合を保持。片方に観測可能な未登録実体があればscope全体を省略。追加順・JSON順を逆転しても同じ |
| C03 | 未計装の同値追加が集合から消えるケース、作者表明なし／偽の表明あり／途中導入を比較 | 表明なし・途中導入は全directの宣言元を省略。偽の表明と真の表明を公開集合から区別できるとは期待しない。accepted時も検出不能性のmetadataが必須。自動検証済みとは表示しない |
| C04 | 同じkeyでshapeだけ異なる宣言、keyの版制約／attributes／capabilityの差、object順・配列順の差、nullと空文字、未取得フィールド | 宣言の前後key/shapeとedge keyを責任別に比較。既定shapeのみ陽性。非既定shapeや非空属性／capabilityはC1a陰性。未取得を空値にしない。宣言shapeをedgeへコピーしても採用不能。欠落・未知versionは文書不正 |
| C05 | force／conflict後にselected版が変わる／module名変更／project substitution | 版だけの変更は実selected版へ対応。C1の非対応substitutionは宣言元省略、既存relationは保持 |
| C06 | extendsFromのdiamond、同じ宣言の多重継承、独立の同座標宣言 | 同じIDだけ重複除去。元scriptを保持し、独立宣言を潰さない。継承consumerのbuild fileを生成しない |
| C07 | Provider／defaultDependencies／withDependenciesの遅延追加、未実現provider、adapterあり・なしを比較 | C1aではscopeの宣言元省略。元の評価時刻・回数・エラー・解決結果を変えない。C1bは同一試行の再実現がIDを増殖させず全実体を対応付けられることを実証後に陽性化 |
| C08 | registerExistingへ同座標別実体／copyを渡す、同値追加の片方削除、削除後の再追加・mutation | registerExistingは完全性へ寄与しない。copyには新試行が必要。変更／曖昧な削除はscope全体不完全。元登録を新実体へ転用しない |
| C09 | catalog library alias／version.ref／rich version／bundle、重複alias | C1aはProvider／bundleを早期getせず宣言元省略。C1b gate後は使用scriptと全試行を返し、catalog TOMLをdeclared_inへ入れない。未使用aliasは追加なし |
| C10 | ローカルTOML上書き、全入力捕捉済みprogrammatic catalog、remote／外部値依存catalog | 入力を検証できるcatalogでもC1aのProvider由来宣言元は省略。C1b gate後は対応済み形の使用scriptを維持し編集先不明ならキーを案内しない。remote／未捕捉入力はgraph不採用・両完全性false、lock coverageは維持。影響不明時は全文書へ適用 |
| C11 | buildSrc／build-logicのprecompiled・binary convention pluginを複数consumerで適用 | 同期helper、信頼scope、sourceと実行artifactの対応を確認できるadapterだけ陽性。対応未実証pluginは省略。consumerのplugins blockを返さない |
| C12 | 外部plugin、同名ローカルsourceが存在するが実行artifactと不一致、境界外included build | sourceを取得・推定しない。known部分だけの一覧も出さず、lockスキャンは継続 |
| C13 | 多段apply、root subprojectsで子へ依存追加、日本語・空白パス | 実際の末端追加script／root scriptへ対応。子project所有情報と物理sourceを分離し、パスを正しく正規化 |
| C14 | BOM constraintのみ、platform実依存、project-only経路、直接＋推移的の重なり | constraintをlibraryの宣言元にしない。C1aは非既定shapeのplatformを省略しgraph relationは維持。transitiveへ親scriptを付けず、対応済み直接宣言は全試行を維持 |
| C15 | sourceが評価中／先行task／解決中に更新・削除・生成される、sourceが遅くprepareされる | 既知入力の変更はexport失敗・既存JSON不変。未準備sourceは不完全。buildSrcコンパイル前後の差し替えも検出 |
| C16 | export後に宣言対応表等の専用入力だけ変更／実依存を追加するscript・plugin sourceを変更 | 専用入力対応を実装した場合、前者はdeclared_inだけ省略、relation・origin・coverageを維持。後者は必ずgraph入力不一致としてcontext全体stale。source-only不一致をcoverage欠けにしない |
| C17 | ../、絶対path、symlink、FIFO、境界外、過大ファイル、hash検証不能、捕捉中差し替え | 安全な読取制限を維持し、停止・範囲外読取なし。対応sourceは不完全。捕捉後の元ファイル差し替えは結果に影響しない |
| C18 | 未知schema／adapter version、重複edge・宣言ID、dangling binding、別contextのID、sourceとinventoryのhash矛盾 | schema参照破損は文書無効。明示された未対応adapterは宣言元不完全。無効部分を取り除いて完全扱いにしない |
| C19 | 同じGAVの複数context／複数lockに完全・未登録・stale・context不足を混在 | 宣言元の完全性をAND。入力順に依存せず不完全な一覧を抑制。originが完全ならintroduced_byは残る |
| C20 | 両contextとも完全、sourceの重複・direct/transitive混在、別形式との併合 | 全sourceを重複除去。確定transitiveの空集合は欠けでない。別形式のdirect不明sourceも省略へ伝播 |
| C21 | 大量sourceを多数contextから参照、宣言予算超過、構造／byte上限超過 | source読込はscan内一回。部分一覧なし。宣言予算が後続contextのrelation解析を悪化させず、上限を引き上げない |
| C22 | adapterなしv1、新readerへv1/v2、旧readerへv2、v1 exportモード | 通常lockスキャンと既存出力互換性を維持。source-mapがなくてもdirect／originを失わない |
| C23 | 起動設定disabled／registered-helper-v1／未知値、JSONにだけtrust=acceptedを埋め込む、起動後に環境変数を変更 | disabledはdirectの宣言元省略。未知値は起動を継続しstderr警告・disabled扱い・`declaration_trust_config_invalid`を記録。JSON自己申告では有効化できず、起動後の変更は反映せず3ツールが起動時の同じ設定を使う |
| C24 | 契約hash変更、別project／build／configurationのscope、root閉包や空の祖先nodeの漏れ | 契約入力不一致はgraph stale、scope不一致・topology不備では宣言元を採用しない。別scopeの表明で穴埋めしない |
| C25 | 二つの同値helper追加が実体・edgeで一つに畳まれる／Providerが同一試行を再評価 | 同期追加試行IDは二件保持。ProviderはC1bまで陰性。C1bでは再評価だけで新宣言を増殖させず、異なる結果は不完全 |
| C26 | opaqueな全fingerprint一致、edgeに存在しないendorsement／artifactを既定値で追加、未知shape | 廃止した三者全一致契約で採用しない。独立なedge keyと宣言shapeのみを検証し、非既定／未知shapeは省略 |
| C27 | 同じkeyでartifact／endorsement／transitive／excludes／targetConfigurationだけ違う台帳群 | 一部の既定shapeだけを採用しない。非既定shapeが寄与する群の宣言元は不完全。shapeをkeyから外したことで誤ったsourceの和集合を返さない |
| C28 | declaration_provenanceを欠くreader／複数lockのacceptedとdisabled・missing_assertion混在 | metadataを出せなければdeclared_in省略。完全性ANDで一部一覧を抑制。acceptedを未採用sourceへ伝播させず、introduced_by／coverageは独立 |
| C29 | helper追加後の外部mutationを元へ戻すケース／通常snapshot差が残るケース | 後者は検出しscope不完全。前者を完全自動検出できるとは主張せず、作者契約違反として限界をmetadataと文書へ明記 |
| C30 | 登録adapterの適用あり／なしで同期追加・遅延追加・失敗するProviderを比較 | 元ビルドの評価時刻、呼出し回数、要求／selected、例外を維持。収集目的の早期get・追加通知による実現があればgate失敗 |


3ツール共通の最終応答では、C02・C04・C09・C10・C11・C13・C16・C19・C20・C21・C23・C24・C28の代表ケースを最低限実行する。`dependency_relation`、`introduced_by`とomitted件数、`declared_in`、二つのmetadata完全性flag、`coverage.complete`、`suggest_fix`の更新案内をまとめて確認する。推移的依存だけの確定contextと、宣言が空だが棚卸し未完了のcontextの違いも確認する。

実接続ではC1aは既知の脆弱版を同期helperのliteral・applied script・実証済みconvention plugin経由で追加したprojectをexportし、C1b対応時にcatalog alias／bundleも追加する。起動設定の有効／無効、契約scopeの有無を切り替え、scan_project／scan_java_project／suggest_fixでOSV検出、declared_in、候補版の再照会を確認する。観測可能な未登録実体の追加を陰性対照とし、宣言元だけ省略されることを確認する。未計装の同値追加は自動検出の陰性対照に使わず、作者表明の検証不能性を確認する対照とする。元lock／source不変、MCP中のGradle非起動、追加source・catalog・plugin情報のOSV非送信を確認する。OSVの件数・固定版を将来の固定期待値にはしない。

### 実接続・境界検証

- 既知の脆弱版を直接＋推移的に含むGradle検証projectで、信頼済み環境からexportする。
- 同じ捕捉lock/JSONを使って3ツールの関係情報とOSV検出・修正候補照会を確認する。検証時点のOSV応答を保存し、現在の「固定版」を設計書へ固定しない。
- Gradle-onlyの提案がpom.xmlの編集を案内しないことを確認する。
- スキャン実行中にGradle/Wrapper/JVMが起動されないことを、失敗する偽Wrapperやprocess検査を使って検証する。
- lock/JSON/sourceの差し替え、境界外path、外部included build、重複ID、過大グラフ、capture budget超過で失敗を隠さない。

## 10. 今回の結論

まずStage A/Bの**事前export＋静的取込**を実装するのがよい。これにより、通常のlockスキャンを保ちながらGradle固有の解決結果に基づく関係情報を追加できる。`declared_in`の全面自動取得は別問題として扱い、source-mapのある宣言から段階的に対応する。Groovy/Kotlinの全面静的評価や、MCPでのビルド実行を隠れた依存にしない。


## 11. Stage C1b: Provider登録の公開API実証（2026-10-31）

### 11.1 採用候補と実証の境界

C1bの候補は、元のProviderをそのまま`DependencyHandler.addProvider(configuration, provider, Action)`へ渡し、Gradleが呼ぶActionで依存実体を記録する方式とする。helperによる`get`、`getOrNull`、`isPresent`、追加`map`、`whenObjectAdded`は使用しない。元のconfigure Actionを先に一度実行し、その正常終了後にsnapshotを採る。元Action／supplierの例外は握り潰さず元の処理へ伝播させる。記録側の例外・上限超過だけを不完全性として扱う。

公開APIの根拠は[DependencyHandler.addProvider](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/dsl/DependencyHandler.html)。[Providerの契約](https://docs.gradle.org/current/javadoc/org/gradle/api/provider/Provider.html)は空値・変動値を許すため、コールバックの存在だけからProviderの安定性を推定してはならない。対象版の実際の互換性は下記実行行列で確認する。

今回追加するものはtest-onlyの試作と設計であり、本番adapter・静的readerの対応範囲は変更しない。本番C1aのProviderは引き続き`deferred_registration_not_supported`。catalog alias／bundle、ProviderConvertible、configuration cache、task output由来Provider、並行実行は別の実証gateとする。

### 11.2 helperの入力・処理順序

将来の公開helperは`addProvider(configurationName, originalProvider, sourceHandle, optionalAction)`とし、戻り値は試行IDのopaque handle（依存実体ではない）とする。C1aのsource事前登録、評価前入力捕捉、project／configuration所有、scope継承、immutable-after-add契約を再利用する。

1. helper呼出し時にsource、所有configuration、試行IDを確定。Providerへ問い合わせず、通常の追加APIへ一度だけ委譲する。
2. Gradleのconfigure callbackで元Actionを先に実行。成功した実体のidentity、declaration key、default shapeを採取する。snapshotは「追加呼出し時」ではなく「materialization時」の値である。
3. 同じ試行の再callbackは同じIDのgenerationとして保持する。異なるkey／shapeが観測された場合は不完全。同値の独立した追加は別IDを保持する。
4. 通常の解決後、寄与する各configurationの**自身のdependencies**を確認する。allDependenciesの同値畳込みを使わず、登録所有configurationの実体との対応を検証する。identityを優先し、同値fallbackは所有configuration内で一意かつkey／shape一致の場合だけ候補とする。曖昧な対応・未登録実体・mutationはscope不完全。
5. scope完全性と元のrelation／introduced_by／coverageは別に判定する。非対応のProviderで既存graph情報を失わせない。

### 11.3 信頼契約と完全性

将来のadapter version更新では、C1a既存レコードをmaterializationの証拠へ読み替えない。Providerレコードに`registrationKind: provider`、stableなattempt ID、所有configuration、source ID、callbackCount、boundedなmaterialization世代のkey／shape／最終一致状態を持たせる。実体identityはプロセス内だけに保持し、JSONへは出さない。callbackCountをsupplier評価回数と呼ばない。未知adapter versionはdeclared_inを採用せずgraphを維持する。

| 状態 | 扱い |
| --- | --- |
| materialized | 安定した観測、既定shape、実体対応を確認した候補。これだけではscope完全ではない |
| unobserved | 空・未使用・未実現を区別不能。追加評価せずscopeのdeclared_inを省略 |
| unstable / unmatched / unsupported | 観測差・対応不能・非既定shape。scope不完全 |
| observation_incomplete | 観測予算超過／採取失敗。部分一覧を返さない |
| resolution_failed | 元の失敗を維持し、完全な宣言元を主張しない |

C1bの陽性化には既存作者表明に加え、登録Providerの値／由来と元Actionが対象export中に安定し、記録callbackによる遅延差に依存せず、外部から変更しないという明示契約が必要。全寄与試行の観測・実体照合・入力検証・scope棚卸しが揃った場合のみdeclared_inを採用する。metadataにはC1aの二つの既知限界に加え、`provider_evaluations_outside_materialization_not_observable`と`provider_stability_author_asserted`を必須とする。安定性表明なしでは不完全とする。

具体的には、同一Providerをアプリ側が明示的に再照会すると値が1→2へ変わる一方、登録callbackは1回のままという対照を追加した。観測が1回でも安定性の証明にはならない。試作のmaterializedは観測ラベルであり、信頼契約受理や本番完全性判定の実装ではない。

### 11.4 回帰条件と検証方法

`src/test/gradle/providerRegistration.integration.test.ts`と`src/test/fixtures/gradle-provider-registration.init.gradle`で、Groovy／Kotlin × Gradle 8.11.1／9.2.1を実行する。ローカルMavenのPOMだけを用い、`--offline --no-configuration-cache`で公開APIを実行する。比較する3経路は通常addProvider、通常追加＋解決後棚卸し、登録Action付き追加。helper本体以外の解決・caller queryの操作列は共通とする。

回帰条件は、文字列、ExternalModuleDependency、Property、元configure Action、同一Providerの同値二重追加、親configurationから二consumerへの継承、空値、supplier例外、Action例外、未使用configuration、変動値の外部再照会。評価フェーズとイベント順、supplier／Action回数、要求／selected、失敗とsentinel原因が3経路で等しいことを確認する。「時刻不変」は論理フェーズとイベント順の比較であり、壁時計時刻やゼロ実行コストを保証しない。

継承は一つの登録IDを両consumerで維持し、独立の同値追加は二IDを保持する。空値はcallbackゼロ、未使用Providerはsupplierゼロ。例外ケースは解決の失敗を捕捉して比較するため、検証タスク全体の成功を依存解決成功と取り違えない。callback snapshot自体の上限・採取例外、異なる世代のmutation、configuration cache、catalog／bundleは本番実装時の追加必須回帰であり、今回の成功行列には含めない。

再現コマンド（各Gradle実行ファイルとJDKを指定）:

```bash
env OSV_MCP_TEST_GRADLE=/path/to/gradle/bin/gradle JAVA_HOME=/path/to/jdk GRADLE_USER_HOME=/path/to/cache OSV_MCP_GRADLE_PROVIDER_OUTPUT=/tmp/provider-proof npm test -- src/test/gradle/providerRegistration.integration.test.ts
```

`OSV_MCP_GRADLE_PROVIDER_OUTPUT`を指定すると版・DSL別JSONを保存する。結果とソースhashは`docs/validation/gradle-provider-2026-10-31.json`に保存する。本番adapter＋静的取込、実接続テストはこの設計を実装した後の段階とする。


### 11.5 実測結果

| Gradle | Groovy | Kotlin | 比較結果 |
| --- | --- | --- | --- |
| 8.11.1 | 12回帰条件 | 12回帰条件 | 3経路のイベント列・supplier／Action回数・解決結果／失敗が一致 |
| 9.2.1 | 12回帰条件 | 12回帰条件 | 同上 |

各projectでstable／object／action／propertyのsupplierは各1回、同値二重追加は2回、親configuration由来は二consumerを解決しても1回。空値はsupplier1回／callback0回、未使用はともに0回。元Actionは正常系・失敗系とも各1回で、失敗原因のsentinelを保持した。変動Providerは通常解決で1、明示的caller queryで2を返し、supplier2回／callback1回だった。同値二重追加は二つのID、継承は同じIDを保持した。

以上から、**検証した安定Providerのmaterializationを、元の論理評価時刻・回数・結果を変えずに登録する公開API経路は成立**する。任意Providerの安定性や不在の完全な自動証明は成立しないため、上記の限定された信頼契約と保守的な省略を前提とする。


## 12. Stage C1b 本番adapter・静的取込

§11は公開API実証段階の記録。本節の実装で、安定Providerの明示helperを本番へ追加する。catalog等の別gateは維持する。

- 入力は`addProvider(configurationName, originalProvider, preparedSourceHandle, optionalAction)`。scopeへ任意フィールド`providerPolicy: "stable-during-export"`を追加する。既存contractVersion 1／trust modelを維持し、既存C1a契約にこのフィールドは不要。未知値は拒否する。旧`add(..., Provider, ...)`は互換性のため通常委譲＋未対応を維持する。
- 元Providerを一度だけGradleのaddProviderへ渡す。元Actionの正常終了後にsnapshotし、supplier／Actionの例外を変更しない。収集例外は観測不完全として扱う。Providerの`get`／`isPresent`／`map`は使用しない。Provider用removeは未対応として明示的に拒否する。
- Provider試行のあるcontextだけadapterVersion 3。同期のみは2を維持する。v3の全recordに`registrationKind`（synchronous／provider）、`callbackCount`、`materializations`（snapshot配列、最大128）を追加。Providerの`declarationAtAdd`はnullで、初回materializationを追加呼出し時の証拠へ読み替えない。同期recordはcallbackCount=0／materializations=[]。実体identityはJSONへ出さない。
- 解決後、所有configurationごとにlive実体をsnapshotでindex化する。同値候補の検索で全グラフを試行ごとに走査せず、既存の共有200万work予算を維持。実体対応と状態はcontextごとのローカル値で求め、共有試行recordを書き換えない。
- readerはv2／v3を認識。v3 Providerの表明、callback数と全snapshot数、世代間一致、解決後snapshot一致、既定shape、source／scope／bindingを再検証する。exporterのcompleteだけを信用しない。未観測・不安定・表明不足・観測上限超過は部分一覧を返さず、relation／introduced_by／coverageと分離する。未知adapterはgraphを維持し宣言元を採用しない。
- 表明不足はtrust metadataでmissing_assertion。採用したProviderには二つのProvider固有の既知限界を追記する。consumer trustがdisabledならv3でも宣言元を返さない。

本番回帰はGroovy／Kotlinで同値Provider二重追加、継承する四つのcontext、consumer有効／無効、元Actionによる版変更後のsnapshot、supplier／Action例外を確認する。exporterの既存仕様では解決例外を不完全context（graph_export_failed等）として記録する。厳格な解決をexport前に行った場合は元例外が伝播し、既存JSONが上書きされないことも確認する。Groovy境界回帰は表明不足、空値、外部mutation、非既定shape、対象外configurationの未評価。静的回帰は偽の完全性、callback数不一致、世代差、128件上限、追加時snapshotの偽装、同期recordの偽装、未知adapterを確認する。§11の公開API行列と合わせて実行する。

検証記録は`docs/validation/gradle-c1b-adapter-2026-10-31.json`。OSV実接続・最終3ツールのC1b検証は別段階で、本変更の検証は実Gradle＋ローカルMavenのoffline実行と静的取込まで。


### C1b本番検証結果（2026-10-31）

- Gradle 8.11.1を指定した全体回帰: 74ファイル／1,573テスト成功（本番adapter回帰23件を含む）。
- Gradle 9.2.1: 本番adapter回帰23件＋公開API実証24件、計47件成功。
- 両版でGroovy／KotlinのProvider陽性、版変更Action、supplier／Actionの例外を確認。型チェック・ビルド・diff checkも成功。
- 実行はJDK 21.0.13+9、offline／configuration cache無効。ソースhashと具体的な確認範囲は上記JSONに保存。今回OSVへの実接続は実行していない。


## 13. C1b 3ツール・OSV実接続検証

2026-10-31、revision 7bea3a6でGroovy／Gradle 8.11.1とKotlin／Gradle 9.2.1を実行。Provider由来の既知脆弱版でscan_project／scan_java_project／suggest_fixを、consumer信頼有効・無効・providerPolicyなしの3条件で検証し、18呼出し成功。acceptedだけが完全なdeclared_inとProvider固有の信頼限界を表示し、disabled／missing_assertionでは宣言元を全省略した。安定性表明なしでは契約変更後に同一projectを再exportし、stale hashでの省略と区別した。

全条件でcoverage・relation・introduced_by・検出ID・候補版を維持。全候補がcandidate_check=cleanで、独立OSV再照会24件はHTTP 200・脆弱性0件。元入力のhash不変とMCP中のGradle非起動も確認。詳細はGRADLE_LIVE_VALIDATION.mdのC1b節、機械可読結果はvalidation/gradle-c1b-live-2026-10-31.json、再現はsrc/test/manual/gradleC1bLive.mjs。catalog／bundle、ProviderConvertible、configuration cache、task output、並行実行、convention plugin等のgateを完了した証拠には含めない。


## 14. version catalog alias／bundle・ProviderConvertibleの設計・公開API実証

詳細は[GRADLE_CATALOG_DECLARATIONS.md](GRADLE_CATALOG_DECLARATIONS.md)。元の型付きProvider／ProviderConvertibleを通常APIへ渡し、member Actionで使用scriptを登録する方式を検討した。libraryの再実現世代とbundle memberを別モデルにし、catalog入力の完全性には公開model一覧以外の明示inventory・作者表明・追加信頼契約が必要とする。設定上書きでversion.refの編集先が一意でなくなる対照と、mapによるbundle型喪失の陰性を含む。本番catalog採用を今回有効化したものではない。


## 15. catalog本番adapter・静的取込

GRADLE_CATALOG_DECLARATIONS.md §9のとおり、契約v2・宣言adapter v4・追加catalog信頼を実装した。bundleMembersのmanifestと実TOMLの照合、settings評価前の入力捕捉、group/memberの完全性検証、使用scriptへのdeclared_in、catalog信頼metadataへ対応。alias／bundle／ProviderConvertibleの公開API実証に続く実装段階であり、今回のcatalog 3ツール・OSV実接続は未実施。


### Catalog本番実接続の確認（2026-10-31）

Groovy／Gradle 8.11.1とKotlin／Gradle 9.2.1の脆弱版projectで、local TOML alias／bundleと生成ProviderConvertibleを登録。3ツール×4信頼条件の24呼出しで、declared_in・追加catalog信頼metadata・候補案内の採用／抑制を確認。候補32照会が独立OSV再照会でもHTTP 200・脆弱性0件。GAV／検出ID／relation／introduced_by／coverage／提案版の条件間一致、入力hash不変、MCP中のビルド非起動を確認した。詳細はGRADLE_LIVE_VALIDATION.mdのcatalog節、検証データはvalidation/gradle-catalog-live-2026-10-31.json、再現はsrc/test/manual/gradleCatalogLive.mjs。更新後のビルド互換性や残る独立gateの完了は含めない。


### Convention plugin公開API実証（2026-10-31）

Groovy／Kotlin consumer×Gradle 8.11.1／9.2.1のbuildSrc Java・独立Kotlin binary・独立Groovy precompiledを計12 fixtureで確認。登録／通常のgraph・Action・Provider評価、混在source候補、toolchain分類の実証は成功したが、公開load元と準備済みartifactの対応は陽性条件未達。convention-pluginの本番拒否を維持し、次は変換／loadの契約とprecompiled実体登録を再検討する。[詳細と実証範囲](GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md#10-公開api実証の結果2026-10-31)。

実証レビューの修正では、classpath directoryを記録済み一覧だけでなく現在の全ファイル集合・hashへ照合し、Providerも安定IDと共通application台帳で出自を検証する。未記録resource追加とProvider参照改変の対照を追加。directory照合はビルド後の事後snapshotで、compile中だけの追加・復元された変更は検出できない（未検出を固定する対照を追加）。詳細・更新結果は上記の設計書§10を参照する。


### 2026-10-31: convention pluginのload信頼・precompiled登録の改訂設計

[設計書§11](GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md#11-改訂案-ロード変換の信頼とprecompiled実体登録)へ追加。旧trustを弱めず、新しいloader-attested trust・独立承認profile・全artifact内容照合・boundary内runtime snapshotを組み合わせる案を定義。precompiledはscript thisを渡さないpending登録と、適用後の公開Plugin実体／descriptor照合へ分離する。buildSrc／included／発行済みpluginの区別、完全性AND、CP37〜CP60を追加。今回は設計のみ。次は新policyの公開API実証で、従来の128件／版を新policyの陽性証拠とはしない。本番未採用を維持する。

- load信頼の設計レビュー2件を反映: policy別の必須field・trust・profileを表にし、strictへ不要なloader profileを要求しない。precompiled-pendingの追加trustはload policyとは別に判定する。runtime snapshotをjar／directoryのunionへ分け、directoryの全tree＋内容blob、binary encodingのdigest、atomic保存、境界内再検証を具体化。CP37／38／43を拡充しCP61〜CP68を追加。設計のみで本番未採用・既存実証データは維持。
