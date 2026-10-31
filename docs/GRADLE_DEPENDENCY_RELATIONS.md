# Gradleの依存関係・導入元・宣言元の設計

設計日: 2026-10-31。Stage A/Bのexporter・静的取込・応答拡張を実装。Stage Cの物理宣言元source-map等は未実装。宣言元登録adapterの入出力・完全性・回帰条件は6.6節とStage C1テスト計画へ具体化済み。

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

以下は実装前の契約であり、現行v1 exporterが提供する機能ではない。Stage C1は通常project configurationの明示登録に限定する。buildscript、Android固有モデル、外部included buildの探索拡張はC2以降とし、対応前は従来のunknown／省略を維持する。

#### 6.6.1 宣言元と信頼の意味

`declared_in`は「実依存の追加を記述した物理ファイル」の完全な集合とする。versionの格納先、pluginを適用しただけのconsumer、所有projectのbuild fileは代用しない。行番号・呼出し元stack・ソース文字列検索は証拠にしない。登録adapterはビルド作者の明示的な出所表明であり、悪意のあるビルドが偽のsource-mapを生成することを防ぐ署名機構ではない。MCPが確認するのは契約の整合性・捕捉ファイルの鮮度・対応の完全性である。

公式APIの`DependencyHandler`は依存の追加、`Configuration`は宣言集合・継承を提供するが、任意の宣言オブジェクトから物理ファイルを得る契約ではない。Gradleのpluginはscript／precompiled script／binaryの形を取り得るため、plugin IDからソースパスを推測しない。[DependencyHandler](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/dsl/DependencyHandler.html)、[Configuration](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/Configuration.html)、[pluginの実装形態](https://docs.gradle.org/current/userguide/implementing_gradle_plugins.html)

#### 6.6.2 登録APIの入力・返却値

配布する登録pluginのproject extensionを`osvMcpDeclarations`（API version 1）とする。exporterはこのversionだけを読む。以下は言語非依存の擬似APIで、実装時にはGroovy／Kotlinの型付き入口を同じ意味で提供する。

```text
// 信頼済みinit/settings段階、対象ソースを評価・コンパイルする前
prepareSources(buildId, [rootRelativeSourcePath, ...]) -> SourceHandle[]

// 宣言するその場所で、追加と登録を一つの操作として行う
add(project, configurationName, dependencyNotationOrProvider,
    sourceHandle, optionalCatalogUse) -> RegistrationHandle

// 既存のplugin作者向け。追加済みの「同じ実体」を登録する
register(project, configurationName, actualDependencyObject,
         sourceHandle, optionalCatalogUse) -> RegistrationHandle
```

- `prepareSources`の一覧はビルド評価前の信頼済み設定から供給する。既知build/settings/catalog入力に加えてapplied script、convention pluginの実装ソースとそのローカル構成入力を含める。build scriptからの遅い初回hash取得は認めない。
- `SourceHandle`はbuild ID・正規化したroot相対path・評価前SHA-256を保持するopaque値。登録時のpath文字列をそのままhashしてhandleへ昇格しない。未準備sourceは登録を記録するが不完全理由を付け、宣言元として採用しない。
- `add`は通常の依存追加の結果を変えず、Gradleが対象configurationへ実際に追加したDependency実体を登録する。`Provider`は通常の追加時点に合わせて遅延評価し、情報収集のための早期`get()`をしない。bundleは展開後の各実体へ個別IDを付ける。未実現・対応不能なら不完全とする。
- `register`は同じproject／configurationの宣言集合に所属する実体のidentityを検証する。座標が同じ別インスタンス、copy、未追加オブジェクト、他projectからの流用は対応済みとしない。copyされた依存には新しい登録が必要。
- 返却handleはopaqueな宣言IDとpending／registered状態を持つ。解決済みGAVや`complete=true`を返すAPIにはしない。公開JSONのIDはexport単位で生成し、JVM identity値・絶対パスは出力しない。
- adapterの無効化・未適用でも通常の依存追加は継続する。証拠取得だけに失敗した場合は宣言元を省略する。元のGradle依存追加・解決のエラーは握り潰さない。

#### 6.6.3 JSON v2の出力

v1の厳格parserへ非空`declarationEvidence`を追加しない。v2を明示導入し、新readerはv1/v2を受け付ける。v1は従来どおり宣言元未提供、旧readerにv2を渡した場合はmetadata未対応として通常lockスキャンを継続する。v2利用者向けにv1 exportモードも残す。ファイル名・companion探索境界は変更しない。

v2では各contextの`edges`に一意な`id`と`requestFingerprint`を追加し、`declarations`を追加する。以下はcontext内の追加部分の例であり、graph本体・lock／input hashは省略している。

```json
{
  "declarations": {
    "adapterVersion": 1,
    "inventoryComplete": true,
    "records": [
      {
        "id": "d1",
        "ownerProjectId": "main::app",
        "configuration": "implementation",
        "requested": { "kind": "module", "group": "org.example", "name": "client", "selector": "1.+" },
        "fingerprintAtAdd": {
          "version": 1, "status": "supported", "kind": "module",
          "group": "org.example", "name": "client",
          "versionConstraint": { "required": "1.+", "preferred": "", "strict": "", "rejected": [], "branch": null },
          "attributes": [], "capabilities": [], "artifacts": [], "targetConfiguration": null,
          "endorseStrictVersions": false
        },
        "fingerprintAtResolve": {
          "version": 1, "status": "supported", "kind": "module",
          "group": "org.example", "name": "client",
          "versionConstraint": { "required": "1.+", "preferred": "", "strict": "", "rejected": [], "branch": null },
          "attributes": [], "capabilities": [], "artifacts": [], "targetConfiguration": null,
          "endorseStrictVersions": false
        },
        "source": { "kind": "build-script", "path": "app/build.gradle.kts", "sha256": "<64-hex>" },
        "catalogUses": []
      }
    ],
    "bindings": [
      { "edgeId": "e1", "declarationIds": ["d1"], "complete": true, "reasons": [] }
    ],
    "reasons": []
  }
}
```

- `records`は登録済みのものだけでなく、解決contextへ寄与する全ての直接宣言を含む棚卸し。未登録宣言も独立IDで残し、`source: null`・理由`unregistered_declaration`とする。`source`のkindは`build-script | applied-script | convention-plugin`。複数の物理宣言は複数recordで表す。
- rootの非constraint edgeごとにbindingを一件作る。`declarationIds`はその辺へ寄与した全宣言の集合。空binding・未対応宣言は`complete=false`とする。ID参照はcontext内に閉じる。
- `inventoryComplete`は棚卸し処理の成功を示し、登録済み割合を示さない。全宣言の追加／削除を観測できず重複が消えた可能性がある場合もfalse。未知adapter versionや中断・上限到達をtrueへ丸めない。
- requestedは追加時と解決直前の構造化fingerprintを比較する。通信形式と検証責任は下記の通り固定する。単純な`group:name`一致、opaqueなhashだけ、producerの`complete=true`だけではbindingを採用しない。

**fingerprint v1の通信契約:** 上の二つのfingerprintとedgeの`requestFingerprint`は同一のdiscriminated unionを使う。supported形は全フィールド必須・未知key拒否とし、`version=1`、`status=supported`、`kind=module`を固定する。group/nameは既存のmodule atom、文字列は最大4,096文字、配列は各最大128件。版制約は`required/preferred/strict`（未指定は空文字）、`rejected`（文字列集合）、`branch`（文字列またはnull）。attributesは`{name, type, value}`の集合で、typeは`string | boolean | integer | named`、valueは対応するJSON primitive。namedはGradleのNamed値を`{className, name}`として持ち、型の同一性を保持する。任意オブジェクトのtoString()は許可しない。capabilitiesは`{group, name, version}`（versionは文字列またはnull）の集合、artifactsは`{name, type, extension, classifier, url}`（未指定値はnull）の集合、targetConfigurationは文字列またはnull、endorseStrictVersionsはbooleanとする。URL付きartifactはC1ではsupportedにせず、URL値自体も出力しない。

**正規化:** objectのkey順は意味を持たず、集合配列は全構成フィールドの型付きtupleで辞書順に並べる。重複attribute名、重複capability／artifact tupleは不正として拒否する。rejectedだけは完全一致の重複を除去する。大文字小文字、空白、版文字列、nullと空文字は保持し、GradleやMavenの版比較器による同一視をしない。JSONの数値はsafe integer限定。文字列化による型の同一視や区切り文字連結によるfingerprint化をしない。

**取得不能形:** `{version: 1, status: "unsupported", reason: "unsupported_declaration_selector"}`を宣言・edgeの両方で明示可能とする。公開APIから要求の全フィールドを取得・対応できない場合はこの形を使い、空配列やnullで取得成功を装わない。project／unknown要求、未知の型・capability selector・artifact selectorはC1ではunsupported。fingerprintの欠落・未知version・型違反はschema不正として文書無効、明示unsupportedは該当bindingのみ不完全とする。これは「対応できたsubsetだけを完全扱いする」許可ではない。

**責任分担:** exporterは追加時・解決直前の完全な値を取得し、mutationがあればC1ではbindingを不完全とする。edge側は実際のroot要求の値から独立に構築し、宣言側の値をコピーして穴埋めしない。ResolutionResult等の公開APIが要求のartifact／endorsement等を提供しない形では、独立な対応を実証できる公開API adapterがない限りunsupportedとする。readerは三つのfingerprintの正規化後の完全一致、requestedのgroup/nameとの整合性、root非constraint edgeへの参照、全宣言群と全bindingの被覆、source/hashを再検証する。bindingの宣言ID重複・欠落や、completeを称する未被覆宣言を拒否する。readerはGradleを再実行せず、棚卸しが真実であること自体は既定のproducer信頼範囲に残る。
- `catalogUses`は任意の補助情報であり、`declared_in`へ混ぜない。各要素にcatalog名、library alias、bundle alias（該当時）、ローカルcatalog path/hash、version.ref（該当時）を保持する。リモートcatalogは`location: unknown`として表現し、ローカル更新先を捏造しない。programmatic catalogは下記のgraph入力規則を満たす場合に限り利用可能とする。URL・資格情報は出力しない。
- `source`は共通の評価前source inventoryにも同じpath/hashで存在する必要がある。catalog補助情報も検証済み入力へ結び付ける。必須schema・参照の破損はv2文書を無効化するが、正しく表現されたsource未登録／範囲外／未対応は宣言元だけの不完全性として扱う。

#### 6.6.4 棚卸しと解決edgeの対応手順

1. projectの構成前にadapterを導入し、各宣言configurationと`extendsFrom`の閉包から寄与する依存を収集する。`getAllDependencies()`の最終集合だけでは同一宣言の重複が畳まれる可能性があるため、追加試行と登録handleの履歴も照合する。途中導入、同値依存の未観測追加、defaultDependencies／withDependenciesによる遅延追加を十分観測できない場合は棚卸し不完全とする。
2. configuration解決直前までの追加・削除・置換・mutationを反映し、解決後にも整合性を確認する。削除済み宣言はbindingへ入れず、同じ座標で再追加されても古いsourceを継承しない。解決時のmutationやコピーを追えなければ不完全とする。
3. 継承された同一宣言は同じIDで重複除去し、独立の同座標宣言は別IDのまま保持する。rootからのselected variant／requested／constraint区分へ対応付ける。非公開Gradle実装クラスへの依存や、辺の配列順で対応付けない。
4. Gradle APIから個別オブジェクトとedgeの一対一対応が得られない場合は、完全に同じ対応fingerprintを持つ宣言群と辺群を一単位として検証する。群内全宣言が登録済みで、全てが同じselected GAVへ解決されると確認できた場合だけ全sourceの和集合を採用する。variantごとに宣言を分離できない場合、同名別版、異なるcapability等は曖昧として省略する。
5. force／conflictで版だけ変わる場合もrequestedとselectedを分け、実際に選ばれたGAVへbindingする。module名変更のsubstitution、module→project、project→moduleはC1では`unsupported_substitution_mapping`とし、宣言元を推測しない。グラフのdirect／transitive判定は既存契約を維持する。
6. constraint宣言やBOMのversion制御をlibraryの直接宣言元へ流用しない。`platform(...)`の実依存辺自身は登録可能。project-only経路上のmoduleへappのproject宣言fileを付けない。

**実装着手の判定条件:** 8.11.1／9.2.1の両方で同値依存の重複・遅延追加・copy・mutationの棚卸しとbindingを実証する。公開APIだけで完全性を確認できない構成は不完全を既定値にし、対応済みと広告しない。最終集合に一個しか見えないことを「宣言元は一個」の証明にしない。

#### 6.6.5 sourceの鮮度・読取範囲

- 既存の評価前hash捕捉を維持し、source inventoryも評価／pluginコンパイル前に捕捉する。export task実行時の初回hashでは不十分。buildSrc／included plugin buildのソースを捕捉するには、それらの評価・コンパイルより先の信頼済み起動段階が必要。準備できなければconvention pluginのsourceは未検証とする。
- 登録時、export開始時、解決後・atomic write直前に基準と比較する。既知sourceや既知inputの変更／生成／削除はexport全体を失敗させ、既存JSONを上書きしない。評価前不在のsourceを後から生成して登録しても採用しない。
- MCPは現在のscan boundary内にある列挙済みローカルsourceだけを安全に捕捉する。root相対path、symlink拒否、通常ファイル限定、4 MiB/件・64 MiB/scan、同じbytesをhash照合と案内に使用する。境界外のbuild-logicをJSONを手掛かりに探索しない。
- C1のsource許可種別は`.gradle`／`.gradle.kts`、convention plugin実装の`.kt`／`.java`／`.groovy`。catalog補助入力は`.versions.toml`。任意suffixを許可せず、既存input readerの拡張を明示的に実装する。ファイル本文をOSVへ送らず、snapshotのスキャナー入力にも追加しない。
- グラフ用inputと宣言元専用inputをv2で分離する。依存を追加するscript・plugin実装・使用catalogは解決に影響し得るため必ずgraph入力にも含め、宣言元専用へ格下げしない。宣言元専用は解決へ影響しない登録対応表等に限り、C1でその種別を実装しない場合は空とする。前者が不一致なら従来どおりcontext全体をstaleとする。後者だけ不一致／検証不能ならそのsourceを使うbindingを不完全とし、検証済みgraphのrelation・introduced_by・coverage証拠は保持する。同じファイルが両役割なら厳しいgraph側を優先する。
- catalogのgraph入力は種類別に固定する。ローカルTOMLは実際にimportされた全TOMLとcatalogを構成・上書きするsettings／pluginソースを評価前捕捉し、MCPが同じpath/hashを確認する。programmatic catalogは構築コードと参照したローカル入力の全てを同じ契約で捕捉できた場合のみ対応し、編集先キーだけが不明でもgraphと宣言元を維持できる。環境変数・外部サービス・未捕捉ファイルに依存して内容が決まる場合はC1では検証不能とする。
- v2 contextに必須の`catalogInputs: {inventoryComplete: boolean, entries: [...]}`を設ける。各entryはcontext内一意ID、kind（local-toml／programmatic／remote）、state（verifiable／unverifiable）、graphInputPaths（既存graph入力への参照集合）、reason（nullまたはcatalog_graph_inputs_unverifiable）を持つ。verifiableはremote不可・全参照のpath/hash検証必須。catalog不使用は棚卸し済みの空集合として表す。inventoryComplete=falseは影響不明として全文書を採用不可にする。任意のcatalogUsesを省略しても必須のcatalog入力検査を回避できない。catalogUsesに出す場合はcatalogInputIdで対応するentryへ結び付け、未知IDはschema参照不正とする。
- リモート配布catalogはartifactの同一性と評価前入力をローカルpath/hash契約だけでは確認できないため、C1では`catalog_graph_inputs_unverifiable`とする。未捕捉入力を持つprogrammatic catalogも同じ扱い。該当catalogの使用が確認されたcontextはgraph採用不可としてrelation=unknown、introduced_by／declared_inを省略し、relations_complete／declarations_complete=falseとする。catalog影響contextを列挙できない場合は文書の全contextへ適用する。独立に検証できた別contextの証拠は保持する。これはスキャン範囲の欠けの証拠ではなくmetadataの検証制限なので、lockスキャン由来のcoverageは維持する。編集先が不明なだけの対応済みローカルcatalogと混同しない。
- adapter source-mapの鮮度もビルド全体の再現性は保証しない。binary pluginの実行バイナリとローカルsourceの対応を証明できない場合、同名ソースがあるだけでは採用しない。C1のconvention-plugin対応は同じexport実行で準備済みローカルソースから構築されたことをadapterが確認できる形に限る。

#### 6.6.6 宣言方法ごとの扱い

| 宣言方法 | `declared_in` | 補助情報／省略条件 |
|---|---|---|
| build scriptのliteral／変数 | 実際に追加したbuild script | 変数の定義元やversion保持元は自動推定しない |
| `implementation(libs.client)` | aliasを使用して追加したscript／plugin実装 | catalogは別のversion編集候補。alias未使用なら証拠なし |
| catalog bundle | 使用箇所のscriptを展開後の各依存へ登録 | 同じmoduleを含む複数alias／bundleも全独立宣言を保持 |
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

完全性の単位はまず`(lock, context, selected GAV)`、その後に同GAVの全context／全sourceへANDで併合する。contextの他GAVの未登録宣言だけで、独立に完全性を証明できるGAVまで一律に不完全としない。ただし棚卸し全体が不明な場合は、追加宣言を除外できないためそのcontextの全direct GAVを不完全とする。

| 状態 | `declaredInComplete` | `declared_in`への寄与 |
|---|---|---|
| directで全binding・全宣言の検証成功 | true | 全宣言sourceの重複除去集合（非空必須） |
| directの一件でも未登録／曖昧／source検証不能 | false | 既知部分も最終一覧から省略 |
| graphが完全で確定transitive、直接宣言なし | true | 完全な空集合。親の宣言fileを付けない |
| unknown／context不足／graph予算超過 | false | 宣言元を補完しない |
| v1／adapter未提供 | directはfalse、確定transitiveはtrue | 既存挙動を維持 |

- 解決graph自体が不完全なcontextからdirectの証拠だけ得られる場合も、C1では宣言元の完全性はfalseとする。完全な別contextで穴埋めしない。
- bindingの不完全性はintroducedByCompleteへ伝播しない。逆にorigin探索の失敗時は、独立に完全な宣言bindingを得る実装契約がないC1ではfalse。将来独立計算へ移行する場合も、最終併合の二つのflagは分ける。
- `declarations_complete`は対象lockの全必要contextで全direct GAVの宣言元が完全な場合のみtrue。`relations_complete`とは独立。metadata `status`は現行どおりグラフ関係の状態を保ち、宣言元の不足は専用flagとreasonsで示す。空のcontextもadapter棚卸しが未完了なら宣言元完全とは宣言しない。
- 理由code: `declaration_adapter_missing`、`unsupported_declaration_adapter`、`declaration_inventory_incomplete`、`unregistered_declaration`、`ambiguous_declaration_binding`、`unsupported_declaration_selector`、`unsupported_substitution_mapping`、`declaration_source_unprepared`、`declaration_source_unverifiable`、`stale_declaration_source`、`declaration_budget_exceeded`、`catalog_graph_inputs_unverifiable`。パス・件数の診断は上限付きでsanitizeし、例外全文は出さない。
- source-mapだけの欠如・stale・制限では`coverage.complete`を下げない。graphに基づく既存のスキャン範囲の欠けは維持する。catalog編集情報だけが不明でも、catalogのgraph入力と使用箇所の証拠が完全なら`declared_in`は維持する。catalogのgraph入力自体が検証不能な場合は6.6.5のcontext不採用規則を優先する。
- `suggest_fix`は確定した全宣言元を案内する。catalog等は別の編集候補として扱い、版の実際の管理先が不明なら一般的なGradle制約の確認を促す。`declared_in`にcatalogを混ぜる、POM編集を案内する、source-mapだけで版互換性を保証する、という動作は禁止する。新しい公開catalogフィールドの追加はC1の必須要件にせず、追加する場合は別の応答契約を定義する。

#### 6.6.8 制限と実装順

recordsは10万/context、bindingsはroot非constraint edge数以下（最大20万/context）、source inventoryは1万/document、catalogUsesは各record最大32件を初期上限とする。JSONの既存16 MiB/件・64 MiB/scan制限が先に効く場合も黙って切り詰めない。構造の上限超過は文書無効、対応探索の予算超過は宣言元不完全とし、部分一覧を出さない。

binding索引の構築は既存index共有200万操作、宣言・継承・bindingの走査は既存traversal共有200万操作へ計上する。contextごとの予算リセットや、全宣言×全edgeの総当たりを避ける。source捕捉はscan内キャッシュを共用し、source数×context数の再読込をしない。宣言元処理で予算が尽きても既に確定したrelation／originの結果を破棄しないよう、scan内の全contextの既存解析を先に完了し、その後に残予算で宣言処理を行い、failureを別に保持する。宣言処理が先行して後続contextのorigin予算を奪わない。

順序は、(1)登録と棚卸しのGradle実証、(2)v2 schema・安全なcapture、(3)GAV別完全性と併合、(4)3ツールの案内・実接続、(5)convention pluginのsource/artifact対応を満たすadapter、の順とする。各段階で未対応形を省略し、C1の完了条件に含まれる対応形とC2送りの形を検証記録へ明記する。

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

以下は未実装のテスト計画。parser／binding／captureの単体テスト、実Gradle exporterテスト、3ツールの最終応答テストを分け、合成JSONだけで対応済みとはしない。実Gradleは8.11.1／9.2.1、通常script・applied scriptはGroovy／Kotlinの両DSLを確認する。未対応構成の陰性は全環境で省略を確認する。

| ID | 入力・操作 | 必須の期待結果 |
|---|---|---|
| C01 | literal／変数／versionなしの直接依存をhelperで追加 | 使用scriptだけがdeclared_in。selected GAVと対応し、版変数の定義元を混ぜない |
| C02 | 同じGAVを二つのscript、二つの宣言configurationから追加し、一つのroot edgeへ合流 | 全sourceの和集合。片方だけ未登録にすると一覧全体を省略。追加順・JSON順を逆転しても同じ |
| C03 | 同値のDependencyを複数追加しGradleの集合では一つに見える／adapterを途中導入 | 未登録追加を検知できなければinventory不完全。既知の一件だけを完全として返さない |
| C04 | 同じ座標でattributesの値／型、capabilities、classifier、endorsementだけが異なる宣言・edge。版制約の差、配列順・object key順の差、nullと空文字、未取得フィールド | 三つのfingerprintが正規化後完全一致する場合のみ採用。値／型差やmutationはbinding不完全。順序差だけなら同一。明示unsupportedは省略、欠落・未知versionは文書無効。偽のcomplete=trueでも被覆不足・重複ID・別edgeへの付替えを拒否 |
| C05 | force／conflict後にselected版が変わる／module名変更／project substitution | 版だけの変更は実selected版へ対応。C1の非対応substitutionは宣言元省略、既存relationは保持 |
| C06 | extendsFromのdiamond、同じ宣言の多重継承、独立の同座標宣言 | 同じIDだけ重複除去。元scriptを保持し、独立宣言を潰さない。継承consumerのbuild fileを生成しない |
| C07 | defaultDependencies／withDependencies／Providerの遅延追加、未実現provider | 追加・解決の結果とタイミングを変えず、実体化した全宣言を棚卸し。未観測なら不完全、metadata目的の早期getなし |
| C08 | registerへ同座標別実体／copy／他projectの実体を渡す、削除後の再追加・mutation | 古い登録が新実体へ移らない。未対応mutationは省略。削除した宣言のsourceを返さない |
| C09 | catalog library alias／version.ref／rich version／bundle、重複alias | declared_inは使用script。bundleの全実体を登録し、catalog TOMLを一覧へ入れない。未使用aliasは何も追加しない |
| C10 | catalog版と選択版の差、ローカルTOML上書き、全入力捕捉済みprogrammatic catalog、remote catalog、外部値依存のprogrammatic catalog | 対応済みローカル／programmatic形はselected版・relation・declared_inを維持し、編集先不明ならキーを案内しない。remote／未捕捉入力形は該当contextのrelation=unknown・introduced_byとdeclared_in省略、両完全性flag=false、catalog_graph_inputs_unverifiableを記録。lockのcoverageは維持。影響context不明時は全文書、独立contextの欠けの証拠は保持 |
| C11 | buildSrc／ローカルbuild-logicのprecompiled・binary convention pluginを複数consumerで適用 | 準備済み実装ソースと実行artifactの対応を確認できるときのみplugin実装を返す。consumerのplugins blockを返さない |
| C12 | 外部plugin、同名ローカルsourceが存在するが実行artifactと不一致、境界外included build | sourceを取得・推定しない。known部分だけの一覧も出さず、lockスキャンは継続 |
| C13 | 多段apply、root subprojectsで子へ依存追加、日本語・空白パス | 実際の末端追加script／root scriptへ対応。子project所有情報と物理sourceを分離し、パスを正しく正規化 |
| C14 | BOM constraintのみ、platform実依存、project-only経路、直接＋推移的の重なり | constraintはlibraryの宣言元にならない。platform自身は対応可能。transitiveへ親scriptを付けず、直接宣言は全件維持 |
| C15 | sourceが評価中／先行task／解決中に更新・削除・生成される、sourceが遅くprepareされる | 既知入力の変更はexport失敗・既存JSON不変。未準備sourceは不完全。buildSrcコンパイル前後の差し替えも検出 |
| C16 | export後に宣言対応表等の専用入力だけ変更／実依存を追加するscript・plugin sourceを変更 | 専用入力対応を実装した場合、前者はdeclared_inだけ省略、relation・origin・coverageを維持。後者は必ずgraph入力不一致としてcontext全体stale。source-only不一致をcoverage欠けにしない |
| C17 | ../、絶対path、symlink、FIFO、境界外、過大ファイル、hash検証不能、捕捉中差し替え | 安全な読取制限を維持し、停止・範囲外読取なし。対応sourceは不完全。捕捉後の元ファイル差し替えは結果に影響しない |
| C18 | 未知schema／adapter version、重複edge・宣言ID、dangling binding、別contextのID、sourceとinventoryのhash矛盾 | schema参照破損は文書無効。明示された未対応adapterは宣言元不完全。無効部分を取り除いて完全扱いにしない |
| C19 | 同じGAVの複数context／複数lockに完全・未登録・stale・context不足を混在 | 宣言元の完全性をAND。入力順に依存せず不完全な一覧を抑制。originが完全ならintroduced_byは残る |
| C20 | 両contextとも完全、sourceの重複・direct/transitive混在、別形式との併合 | 全sourceを重複除去。確定transitiveの空集合は欠けでない。別形式のdirect不明sourceも省略へ伝播 |
| C21 | 大量sourceを多数contextから参照、宣言予算超過、構造／byte上限超過 | source読込はscan内一回。部分一覧なし。宣言予算が後続contextのrelation解析を悪化させず、上限を引き上げない |
| C22 | adapterなしv1、新readerへv1/v2、旧readerへv2、v1 exportモード | 通常lockスキャンと既存出力互換性を維持。source-mapがなくてもdirect／originを失わない |

3ツール共通の最終応答では、C02・C04・C09・C10・C11・C13・C16・C19・C20・C21の代表ケースを最低限実行する。`dependency_relation`、`introduced_by`とomitted件数、`declared_in`、二つのmetadata完全性flag、`coverage.complete`、`suggest_fix`の更新案内をまとめて確認する。推移的依存だけの確定contextと、宣言が空だが棚卸し未完了のcontextの違いも確認する。

実接続では既知の脆弱版をliteral・catalog alias・applied script・対応済みconvention plugin経由で追加したprojectをexportし、scan_project／scan_java_project／suggest_fixでOSV検出、declared_in、候補版の再照会を確認する。未登録宣言の追加を陰性対照とし、宣言元だけ省略されることを確認する。元lock／source不変、MCP中のGradle非起動、追加source・catalog・plugin情報のOSV非送信を確認する。OSVの件数・固定版を将来の固定期待値にはしない。

### 実接続・境界検証

- 既知の脆弱版を直接＋推移的に含むGradle検証projectで、信頼済み環境からexportする。
- 同じ捕捉lock/JSONを使って3ツールの関係情報とOSV検出・修正候補照会を確認する。検証時点のOSV応答を保存し、現在の「固定版」を設計書へ固定しない。
- Gradle-onlyの提案がpom.xmlの編集を案内しないことを確認する。
- スキャン実行中にGradle/Wrapper/JVMが起動されないことを、失敗する偽Wrapperやprocess検査を使って検証する。
- lock/JSON/sourceの差し替え、境界外path、外部included build、重複ID、過大グラフ、capture budget超過で失敗を隠さない。

## 10. 今回の結論

まずStage A/Bの**事前export＋静的取込**を実装するのがよい。これにより、通常のlockスキャンを保ちながらGradle固有の解決結果に基づく関係情報を追加できる。`declared_in`の全面自動取得は別問題として扱い、source-mapのある宣言から段階的に対応する。Groovy/Kotlinの全面静的評価や、MCPでのビルド実行を隠れた依存にしない。
