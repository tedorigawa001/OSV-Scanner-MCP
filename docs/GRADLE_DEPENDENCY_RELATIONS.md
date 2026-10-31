# Gradleの依存関係・導入元・宣言元の設計

設計日: 2026-10-31。設計案であり、exporter・JSON取込・応答拡張は未実装。

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

- `inputs.files`にはroot相対pathとSHA-256を記録する。settings、build files、catalog、properties、宣言元登録に使ったファイル等を列挙するが、環境変数、外部init script、remote pluginの全影響を網羅したとはしない。
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
- projectを通過する辺でも、公開module起点が存在する場合だけその起点を保持する。公開起点のないproject-only経路に架空のMaven起点を作らない。
- 複数起点、cycle、直接＋推移的の重なりを扱う。起点自身を自分の由来にしない。
- 同じGAVについて必要なcontextの一部が不足・不完全・予算超過なら、既知部分だけを完全な由来一覧のように返さず、一覧全体を省略する。空の一覧は「由来なし」と「不明」を混同しない。
- 確定した複数起点の10件上限・`introduced_by_omitted`は既存仕様を使う。未確定起点をomitted件数へ入れない。
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

### 実接続・境界検証

- 既知の脆弱版を直接＋推移的に含むGradle検証projectで、信頼済み環境からexportする。
- 同じ捕捉lock/JSONを使って3ツールの関係情報とOSV検出・修正候補照会を確認する。検証時点のOSV応答を保存し、現在の「固定版」を設計書へ固定しない。
- Gradle-onlyの提案がpom.xmlの編集を案内しないことを確認する。
- スキャン実行中にGradle/Wrapper/JVMが起動されないことを、失敗する偽Wrapperやprocess検査を使って検証する。
- lock/JSON/sourceの差し替え、境界外path、外部included build、重複ID、過大グラフ、capture budget超過で失敗を隠さない。

## 10. 今回の結論

まずStage A/Bの**事前export＋静的取込**を実装するのがよい。これにより、通常のlockスキャンを保ちながらGradle固有の解決結果に基づく関係情報を追加できる。`declared_in`の全面自動取得は別問題として扱い、source-mapのある宣言から段階的に対応する。Groovy/Kotlinの全面静的評価や、MCPでのビルド実行を隠れた依存にしない。
