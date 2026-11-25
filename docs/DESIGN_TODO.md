# OSV-Scanner-MCP 設計メモ / 残課題

最終更新: 2026-10-07(対象エコシステム拡大の詳細設計メモを追加。現行版の不具合3件をPhase 0として記載)

## 決定済み事項

- **プロジェクト名**: `OSV-Scanner-MCP`
- **役割**: MCPサーバーとして動作し、Claude等のMCPクライアントから「Javaプロジェクトの脆弱性チェック」を自然言語ワンショットで呼び出せるようにする
- **スキャンエンジン**: Google製 OSV-Scanner をラップして利用(自前でCVE照合ロジックは持たない)
- **開発方針**: スモールスタート。MVPはMaven(pom.xml)のみ対応、Gradleは後回し
- **実装場所**: ローカル(Claude Code等)で行う。このチャットは設計・方針決定用
- **開発環境**: Go 1.26.4(brewで更新済み)。本家OSV-Scannerを`go build ./cmd/osv-scanner`でビルド済み、動作確認完了(`osv-scanner version: 2.4.0`)
- **動作確認用ダミープロジェクト**: `pom.xml`(log4j-core 2.14.1 / commons-collections 3.2.1 / jackson-databind 2.17.0)で実スキャン済み。Log4Shell含む既知CVEの検出を確認済み

## ディレクトリ構成(たたき台)

```
OSV-Scanner-MCP/
├── src/
│   ├── index.ts
│   ├── tools/
│   │   ├── scanJavaProject.ts
│   │   ├── explainVulnerability.ts
│   │   └── suggestFix.ts
│   ├── osv/
│   │   ├── runner.ts
│   │   └── binaryManager.ts
│   └── utils/
│       └── projectDetector.ts
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
└── .gitignore
```

## OSV-Scanner JSON出力構造の調査結果(2026-07-04 実機確認済み)

`osv-scanner scan source -r . --format json` の実行結果を解析した知見。`runner.ts`のパース設計はこれを前提にする。

### 構造の概要

```
{
  "results": [
    {
      "source": { "path": ".../pom.xml", "type": "lockfile" },
      "packages": [
        {
          "package": { "name": "...", "version": "...", "ecosystem": "Maven" },
          "groups": [
            { "ids": ["GHSA-xxxx"], "aliases": ["CVE-xxxx", "GHSA-xxxx"], "max_severity": "5.3" }
          ],
          "vulnerabilities": [ /* affected範囲・fixed versionなどの詳細 */ ]
        }
      ]
    }
  ],
  "experimental_config": { ... }
}
```

### 重要な発見

1. **パッケージ単位のグルーピングは既にOSV-Scanner側でやってくれている**
   `packages[].groups[]`が「1エントリ=1脆弱性」の単位になっており、MCPサーバー側で独自にグルーピングロジックを組む必要はない。`group.ids`(GHSA-ID)、`group.aliases`(CVE-ID含む)、`group.max_severity`をそのまま使える

2. **`max_severity`が空文字列になるケースがある**
   実機確認で `commons-collections` の1件(`GHSA-6hgm-866r-3cjv`, CVE-2015-6420)が`max_severity=""`だった。深刻度でソート・フィルタする処理は空文字/null相当を安全に扱う必要がある(例外を投げない、Unknown扱いにする等)

3. **`fixed_version`は複数のリリース系統が混在する**
   log4j-coreの例では `2.12.2〜2.12.4`(2.12系バックポート)、`2.15.0〜2.17.1`(2.1x系)、`2.25.3〜2.25.4`(2.25系)のように**異なるメジャー系統への修正版が同時に列挙される**。単純に最大バージョンを取ると現在使用中の系統と無関係なジャンプになりうる
   - [x] **要設計判断**: `suggest_fix`では「単純な最大バージョン」を出すか、「現在のバージョンに最も近い系統内の修正版」を優先するか決める → 3段階Tier方式で確定(下記セクション参照)

4. **同一`source`(pom.xml)が複数の`results`エントリに分かれることがある**
   実機確認では`jackson-core`が別の`results[]`エントリとして出力された。パース時は「pathでグルーピングする」のではなく、**全`results[].packages[]`をフラットに集約してから整形する**方が安全

### 反映が必要な設計項目

- [x] `scan_java_project`の出力スキーマは、独自グルーピングを持たず`groups`をそのまま活用する形に修正
- [x] `max_severity`の空文字ハンドリングをパース処理に組み込む
- [x] `suggest_fix`のバージョン選定ロジック → 下記「fixed_versionの選定ロジック」で確定

## fixed_versionの選定ロジック(確定: 2026-07-04)

### 背景

同一パッケージに複数の`fixed_version`が並ぶのは、「表記ゆれ」ではなく**複数のサポートブランチ(major.minor系統)に個別のバックポート修正が存在するため**。log4jの実例では`2.12.x`系(Java 7向けLTS)、`2.3.x`系(さらに古いLTS)、`2.15.0〜2.25.4`(メインライン)に修正が分散しており、現在使用中の`2.14.1`系統向けの修正版は1つも存在しないケースが確認された。これは仕様として扱う。

### 粒度: major.minor単位で「系統」を定義

（例: `2.14.1` の系統は `2.14`）

### アルゴリズム: 3段階のTierフォールバック

CVEごとに以下の優先順で修正版を探索する。

1. **Tier 1(`same_minor`)**: `major.minor`が現在バージョンと一致し、かつ現在より大きい修正版があれば採用(最小の変更で済む)
2. **Tier 2(`major_internal`)**: Tier 1が無ければ、`major`のみ一致する修正版のうち最小のものを採用(マイナーバージョンアップが必要)
3. **Tier 3(`cross_major`)**: Tier 2も無ければ、全体最小の修正版を採用し「メジャーアップグレード(破壊的変更の可能性あり)」と明示

パッケージ全体の推奨バージョン(`recommended_upgrade`)は、既知の修正版候補を全修正対象CVEの影響範囲と照合し、検証できた候補をTier順・バージョン昇順で選ぶ(2026-09-11改訂)。旧方式の「各CVEの修正版の最大値」では、別系統で再導入された脆弱性を見落とすため廃止。範囲情報が不十分なら推奨を保留する。修正版候補のないCVEは別表示し、推奨先での判定も返す。全公開版の最小性を保証するものではない。

### 出力イメージ

```json
{
  "package": "org.apache.logging.log4j:log4j-core",
  "current_version": "2.14.1",
  "recommended_upgrade": "2.25.4",
  "upgrade_tier": "major_internal",
  "upgrade_note": "2.14系統向けの修正版は存在しない。同一メジャー(2.x)内では2.25.4が全7件のCVEを解消する最小版",
  "per_cve_detail": [
    { "cve": "CVE-2021-44228", "fixed_in": "2.15.0", "tier": "major_internal" },
    { "cve": "CVE-2021-45046", "fixed_in": "2.16.0", "tier": "major_internal" }
  ]
}
```

### 実装上の技術的な壁(要着手優先度: 高)

- [x] **Maven形式に対応した独自バージョンコンパレータが必要** → `src/utils/mavenVersion.ts`に実装済み(2026-07-04)。Maven本家`ComparableVersion`のアルゴリズムを移植し、本家テストコーパス+log4j実例でテスト済み(`compareMavenVersions` / 系統抽出用`mavenVersionSeries`をエクスポート)
- [x] `fixed_version`が存在しないCVE(修正版が今後も出ない"unfixed"扱い)のハンドリングを設計する
  - スキャン出力側: `fixed_versions: []`として表現(実データで確認: jackson-databindのCVE-2026-54515がunfixed)
  - `suggest_fix`側: 推奨バージョン計算から除外し、`tier: "unfixed"`+upgrade_noteで「このアップグレードでは解消されない」と明示(2026-07-04実装)。「現在より新しい修正版が無い」(別ブランチ向けバックポートのみ)ケースも同様にunfixed扱い

## 残課題(未決定・要検討)

### 1. OSV-Scannerバイナリの扱い方 【最優先】
- [x] MVPでは「存在チェック→なければ案内メッセージ」方式(方式C)で開始 → `src/osv/binaryManager.ts`に実装済み(2026-07-04)。探索順: 環境変数`OSV_SCANNER_PATH`(無効時はPATHにフォールバックしない)→ PATH。未検出時はインストール案内付き`binary_not_found`エラー
- [x] 将来的に自動ダウンロード(方式B)へ移行するか判断 → 実装済み(2026-07-04)。`src/osv/binaryDownloader.ts`。解決順: OSV_SCANNER_PATH → PATH → キャッシュ(毎回再検証)→ 自動ダウンロード。`OSV_MCP_AUTO_DOWNLOAD=0`でオプトアウト(その場合は方式Cの案内)。実ダウンロード検証済み(52MB/約5秒、darwin_arm64)
- [x] バイナリのハッシュ検証をどう組み込むか → バージョンをv2.4.0にピン留めし、公式SHA256SUMSの値を**ソースコードに埋め込んで**照合(配布元改ざんにも耐性)。検証合格まで実行権限を付与せず、一時ファイル→検証→chmod→アトミックrenameの順で配置

### 2. Tool定義の確定
- [x] `scan_java_project` の**出力**スキーマを最終化 → `src/osv/scanReport.ts`に実装済み(2026-07-04)。`groups`ベースの`ScanReport`型(パッケージ→脆弱性の2階層+severity_breakdown集計)。実機スキャン出力(14件/4パッケージ)でパース検証済み
- [x] `scan_java_project` の**入力**スキーマを確定 → `src/index.ts`で実装済み(2026-07-04)。パラメータは`project_path`(ディレクトリまたはpom.xmlの絶対パス)のみ。環境変数`OSV_MCP_ALLOWED_ROOT`でスキャン範囲を制限可能。MCPプロトコル経由(initialize→tools/list→tools/call)の実機スキャンで動作確認済み
- [x] `explain_vulnerability` の要否判断 → **実装する**で確定し実装済み(2026-07-04)。判断理由: 実スキャンで検出14件中5件が2026年採番CVEで、クライアントLLMの知識カットオフ以降の脆弱性説明に必須。`src/osv/osvApi.ts`(OSV APIクライアント: ID厳格検証・タイムアウト・サイズ上限)+`src/osv/vulnerabilityExplanation.ts`(整形)+`src/tools/explainVulnerability.ts`。CVE-IDはOSVで解決できない場合があるため404時にGHSA-IDでの照会を案内
- [x] `suggest_fix` ツールを実装 → `src/osv/suggestFix.ts`(3段階Tierロジック)+`src/tools/suggestFix.ts`(2026-07-04)。実機スキャンで設計メモの想定例(log4j 2.14.1→2.25.4/major_internal)と一致することを確認済み
- [x] `suggest_fix`のfixed_version選定ロジック → 3段階Tier方式で確定(詳細は上記セクション参照)
- [x] エラー時のレスポンス形式 → `src/tools/scanJavaProject.ts`で確定(2026-07-04)。`isError: true`+`{"error": {"kind", "message", "detail?"}}`のJSONテキスト。予期しない例外は内部情報を漏らさず`internal_error`に丸める
  - 内部エラー型: `src/errors.ts`の`ScanToolError`(kind: binary_not_found / project_not_found / no_pom_found / path_outside_allowed_root / no_packages_found / scan_failed / scan_timeout / output_too_large / invalid_output)
  - OSV-Scanner 2.4.0の終了コードを実機確認: 0=脆弱性なし / 1=脆弱性あり(どちらも正常) / 128=対象パッケージなし(依存ゼロのpom.xmlも128になる)

### 3. キャッシュ戦略
- [x] オフラインDB更新の強制終了からの復旧（2026-11-25）。固定ファイルへのOSロックを更新中に保持し、終了後の次回更新で空の`update.lock`と途中保存を回収する。旧版の通常ファイルと内容のあるlockディレクトリは保持して更新を拒否。ダウンロード途中・manifest公開直前・公開直後の実CLIをSIGKILLし、競合CLIの取得前拒否、停止時に選択されていたDBの継続読取、次回更新の成功をmacOS／Linux arm64で確認した。Windowsの実機はレビュー修正後のCIで確認した（後述）。[再現と検証結果](OFFLINE_VALIDATION.md#interrupted-cache-update-recovery-2026-11-25)レビュー修正で、公開後に`update.lock`を片付けられない場合は公開済みと明示し、更新失敗時は元の理由を保ち、既に無いmarkerは成功とした。実OSのロック（`exclusiveFileLock.test.ts`）と復旧のCLI回帰をCIのNative file boundaryジョブ（Windows・macOS・Linux）に加えた（結果は後述）。最初のCI（`ad56821`）では、`run-tests.mjs`がWindowsの`\`区切りのパスでテスト用fixtureを製品外と判定し、ロックのテストは実行されなかった。区切りを`/`にそろえ、macOSでの`--list`が前後で一致し、Windows形式の区切りを模した実行でも同じ振り分け（製品136・研究193）になることを確認した。`695a7f8`のCI（実行45537081083）では、Windows Server 2025 x64のNode 22.23.5／26.13.1で、復旧のCLI回帰3件とロックのテスト4件が通過した（symlinkの1件は権限が要るため省略）。`offline.test.ts`はWindowsでは実行していない。
- [x] リアルタイム診断記録の注記の訂正（2026-11-25）。C3b-3／C3b-4の`dependencyRemeasurements`のv0.24.3の項目は、前の項目から写した「更新前も観測結果は一致」という注記のままだった。実際は、更新前の手元の2回（負荷平均約11）は各4件が失敗し、観測結果も一致していない。注記を事実に直し、元の注記と理由を`noteCorrection`に残した。指紋・観測結果・更新後の3回通過は変えていない
- [x] 公式npm DB 2世代で索引構築の有無を対照計測（2026-11-25）。通信禁止下の3組で全件読取と応答を照合した。初回の読取中ピークの中央値は索引あり268.3 MiB、なし206.2 MiB。世代切替では索引ありの読取中ピークが全3組で17.5〜72.2 MiB高かった。照会全体で256 MiBを超えた通常2回・対照1回は、いずれも切替開始時点ですでに超過していた。初回構築の増分と切替前から持ち越されるRSSが、256 MiBへの別々の課題として残る。[再現と検証結果](OFFLINE_NPM_VALIDATION.md#full-read-and-index-build-rss-controls-on-the-current-reader-2026-11-25)
- [x] オフラインDBのSHA-256照合で読取バッファを再利用（2026-11-25）。1回の照合で64 KiBのバッファを使い回し、サイズとdigest照合を維持した。通信禁止下の公式npm DB 2世代・前後3組では、索引再利用時の照合区間の開始時からのピーク増分が7.81〜38.91 MiBから0.00〜0.02 MiBに下がった。世代切替開始時のRSSは2組で低下し、1組で上昇した。変更後の12照会中7照会で256 MiBを超えた。[再現と検証結果](OFFLINE_NPM_VALIDATION.md#reusable-zip-hash-read-buffer-2026-11-25)
- [x] オフラインDB世代切替の段階別RSS計測（2026-11-25）。通信禁止下で公式npm DB 2世代を3プロセスで測定した。256 MiBを超えた2回は切替開始時点ですでに超過していた。全体ピークの開始時からの増分は0.03〜0.34 MiBで、全件読取・索引構築のピークは全3回で切替開始時より低かった。次は索引再利用時のSHA-256照合と、そこから切替開始時に持ち越されるRSSを優先する。[再現と検証結果](OFFLINE_NPM_VALIDATION.md#generation-replacement-rss-by-operation-2026-11-25)
- [x] オフライン索引再利用時の段階別RSS計測（2026-11-24）。通信禁止下で公式npm DB 2世代を3プロセス・6索引照会で測定した。私有ZIPのSHA-256照合中にRSSが19.2〜63.3 MiB増え、256 MiBを超えた3照会ではいずれも照合中に最初の超過を観測した。GC後にArrayBuffer使用量は照会開始時に近い値へ戻ったが、RSSは6.2〜64.7 MiB高かった。次は照合の読取バッファ再利用を単独比較する。[再現と検証結果](OFFLINE_NPM_VALIDATION.md#indexed-lookup-rss-by-operation-2026-11-24)
- [x] 世代切替時の旧索引の早期解放（2026-11-24）。検証済みsnapshotで構築を開始する直前に旧索引へのキャッシュ参照を外す。旧索引で進行中の照会、snapshot取得失敗・置換構築失敗、旧世代の再構築を回帰テストで確認した。レビュー修正で重複区間のRSS欠測を差分集計から除外し、旧診断モードを現行実装でも利用可能にした。公式npm DB 2世代を通信禁止下で前後3組再測定し、変更後は逐次照会でキャッシュと構築中の索引が重なる区間がなくなった。世代切替のピークRSSは1組で低下し、2組で上昇した。変更後の12照会中7照会で256 MiBを超えた。[再現と検証結果](OFFLINE_NPM_VALIDATION.md#early-release-of-the-previous-index-2026-11-24)
- [x] オフライン詳細照会の索引の小型化（2026-11-24）。レコード位置を固定長のページに保存し、ID・別名から行番号で参照する。公式npm DB 2世代を通信禁止下で前後3組測定し、初回照会後のGC後ヒープとArrayBufferの増分は中央値44.1から29.2 MiBへ減少した。世代切替のピークRSSは全3組で減少し、組ごとの削減量の中央値は33.7 MiBだった。変更後の12照会中11照会で256 MiBを超え、新旧索引の重複は残る。[再現と検証結果](OFFLINE_NPM_VALIDATION.md#compact-record-location-index-2026-11-24)
- [x] 単一ZIPのレコード検証とダイジェスト生成の分離（2026-11-24）。全レコードの深さ・非有限数・元期限を検査し、競合判定用のキー整列とSHA-256は複数ZIPで行う。同じ公式npm DB 2世代を通信禁止下で前後3組測定し、初回構築と世代切替は全組で短縮した。ピークRSSの削減は確認できず、変更後の12照会中11照会が256 MiBを超えた。索引の構築・保持と世代切替の重複は残る。[再現と検証結果](OFFLINE_NPM_VALIDATION.md#single-zip-record-validation-without-canonical-digests-2026-11-24)
- [x] 展開レコードの単一バッファ化（2026-11-22）。宣言サイズ内で直接組み立て、サイズ・CRC・UTF-8・元期限を確認する。レビュー修正で期限到達後の書き込みと後続チャンクの取得を検出し、集計時にリーダー内の許可外差分を拒否した。同じ公式npm DB 2世代を通信禁止下で前後3組再測定した結果、ピークRSSは変更後も初回構築287.5〜300.0 MiB、世代切替342.7〜366.2 MiBで、全12照会で256 MiBを超えた。[再現と検証結果](OFFLINE_NPM_VALIDATION.md#bounded-record-buffer-comparison-2026-11-22)
- [x] 単一ZIPでのID別ダイジェスト表の省略（2026-11-22）。ZIP内の重複検出と全レコード検証、複数ZIP間の競合検出を維持した。レビュー修正で実パス照合と、DB・ビルド・応答・読取件数を照合して集計するコマンドを追加した。別名パスを使い公式npm DB 2世代を通信禁止下で再測定した3組では、応答が一致し、組ごとのピークRSS削減量の中央値は初回構築で21.9 MiB、世代切替で43.5 MiBだった。いずれもRSSが増えた組があり、変更後の全試行で256 MiBを超えた。[再現と検証結果](OFFLINE_NPM_VALIDATION.md#single-zip-digest-table-comparison-2026-11-22)
- [x] オフライン詳細照会のピークRSS分解（2026-11-22）。公式npm DBの同じ2世代を使い、通信禁止下で現行・全件読取のみ・旧索引参照を先に解放する条件を各3回実測した。全件読取のみの初回は236.4〜264.3 MiB、現行の初回は269.6〜327.5 MiB、世代切替は311.1〜354.8 MiB。早期解放で切替の読取ループは24.0〜43.9 MiB下がったが、照会全体は308.4〜325.7 MiBだった。256 MiBを目指す場合は、全件読取の一時領域と索引構築時の割当てを優先する。[再現と削減候補](OFFLINE_NPM_VALIDATION.md#reader-index-build-and-generation-overlap-rss-2026-11-22)
- [x] `explain_vulnerability`の索引メモリ実測（2026-11-22）。異なるSHA-256の公式npm DB 2世代を使い、通信禁止下で3プロセスを順次測定した。世代更新時に新旧索引の重なりを確認し、その区間のピークRSSは331.2〜377.7 MiB、照会後のGC後ヒープ増分は約44 MiBだった。メモリ枠256 MiBでは、索引単体に加えて全件読取・世代切替時のピーク削減が課題になる。[計測結果と再現手順](OFFLINE_NPM_VALIDATION.md#index-memory-with-two-official-npm-db-generations-2026-11-22)
- [x] `explain_vulnerability`の世代別索引（2026-11-21）。全DBの検証後に、取得日時・ecosystem・SHA-256で束縛したID／別名の索引をプロセス内に保持する。毎回、私有ZIPのSHA-256と期限を確認する。レビュー修正でZIPの終了待ちと私有コピー削除待ちに元期限を適用し、`scan_timeout`でスキャン枠・索引構築枠を解放する。比較の途中停止は新しいrun ID・試行・段階とともに記録する。公式npm DBを使った通信禁止下の再測定では10組の応答が一致し、期限切れ・同サイズ破損は8件すべて拒否した。索引構築後は各3回の中央値が24.837〜32.078秒から0.378〜0.701秒に短縮した。[検証記録と再現手順](OFFLINE_NPM_VALIDATION.md#indexed-explanation-comparison)
- [x] オンラインを既定のまま維持し、明示的なオフライン／事前DBキャッシュを追加（2026-11-16、ソース実装）。`OSV_MCP_OFFLINE=1`で全scan系・suggest_fixのスキャンをローカルDBへ切り替え、`node dist/index.js cache --ecosystems ...`で公式ecosystem ZIPを事前取得する。選択manifestのatomic更新、SHA-256・取得時刻／期限・容量・私有コピーの照合と、DB不成立時の失敗を実装。API・deps.dev・バイナリ自動取得へfallbackしない。推奨先の追加照会は未実施を明示し、詳細説明は未対応として拒否する。実OS network-denyでGo DBによるスキャン・修正提案・SBOMと欠落／期限切れ／破損の拒否を確認。詳細は[検証記録](OFFLINE_VALIDATION.md)。
- [x] オフラインDBキャッシュのオブジェクト回収（2026-11-16）：更新開始時にlock下で、選択中manifestが参照しない旧世代・失敗した更新の残骸と中断した`.download-*`を削除し、選択世代＋新世代だけを保持する。未知のentryは削除せず拒否を維持。回帰3件（修正前2失敗＋対照1）を追加。ネイティブ記録は4b99361時点のsource hashのまま再生成していない（Go DBの再取得と遮断下の再実行が必要）。
- [x] テスト範囲の分離（2026-11-16、v0.23.0）：研究の検証記録72件がpackage.json／package-lock.jsonの全bytesと、検証コード自体（テスト・fixture・checker・vitest.config.ts）をhashで束縛しており、版上げ・依存更新のたびに研究テスト59件・checker 45本が不一致になる。約20件は再生成手段（当時の実Gradle／native環境）がなく、照合コードの修正も自己束縛で記録を壊すため、記録・研究ファイルは変更しない。`npm test`（prepublishOnly）は製品範囲だけを流し、研究範囲は`npm run test:research`へ分けた。判定は`scripts/run-tests.mjs`が動的に行い、src/index.tsから到達しないmoduleをimportするか、検証記録（docs/validation・check-／analyze-／audit-）を読むか、scripts/の研究harnessを起動するテストを研究とする（v0.23.0公開後の修正で製品129／研究187 files。HB1／HB2のscripts/run-cwc-hb*.mjs起動テストが当初の判定から漏れ、CIのNode 22で研究側のhb2_bootstrap_attributes失敗として出たため）。研究記録は計測したcommitで検証する証拠とし、HEADでの不一致は版上げ後の既知事項とする。今後の研究checkerはpackage.json／package-lock.json全体ではなく使う依存のentryをpinする。
- [x] HB1／HB2のNode 22対応（2026-11-16）：Node 22.20以降のvm `ModuleRequest`は`{specifier,attributes}`だけで`phase`を持たず、HB1／HB2 bootstrapのimport検査（`phase==='evaluation'`必須）がCIのNode 22で`hb2_bootstrap_attributes`として失敗した。Node 22はsource phase importを構文として受け付けないため、`phase`が無い要求はevaluation importとして扱い、`phase`がある場合は`evaluation`、attributesは空objectを必須とする（attributes欠落は従来のTypeErrorでなく検査コードで拒否）。`scripts/run-cwc-hb-module-requests.mjs`でrequestの形を差し替える回帰5件（HBM01／02、修正前2失敗）を追加。両bootstrapを束縛するHB1／HB2・E2-P0の記録は再生成せず、計測したcommitの証拠として残す（テスト範囲分離の方針どおり）。
- [x] オフラインの修正候補再確認（2026-11-18、ソース実装）：私有の単一component SBOMをnative matcherで再scanし、初回と同じDB digest／取得時刻・前後の期限・候補識別／詳細の完全性を照合する。ローカル照会のclean／新規脆弱性による再選定／has_known_vulnerabilities／conflictと、query予算・明示的opt-outを既存アルゴリズムへ接続。APIへfallbackせず、DB不正／世代変更・未識別／不完全出力はtool全体を拒否する。詳細と実DB記録は[検証記録](OFFLINE_VALIDATION.md#local-candidate-rechecks-2026-11-18)。
- [x] 候補確認の別名レビュー修正（2026-11-18）：各照会の既知ID集合を処理前で固定し、同一応答内の新規GO／GHSAを初回・前回照会の既知対象との矛盾にしない。両レコードの全範囲を保持し、順序による修正版情報の欠落も修正。ローカル6条件（修正前3失敗＋対照3）とオンライン4条件を追加し、関連638テストを確認。通信禁止下で実scanner＋4つの合成Go DBによる未修正対象保持・全範囲での再選定・真のconflict、公式Go DBの既存対照・28拒否・fetch 0を再検証し、[記録](validation/offline-candidates-2026-11-18.json)を更新した。他ecosystem／platformのnative実証へは拡張しない。
- [x] 公式npm DBでのローカル説明の実測と別名検査の修正（2026-11-18）：221,682,569 B・232,645 entry・展開393,280,543 B・最大1,148,610 Bで検索上限内。4件のrecordがOSV ID形式でない別名（末尾カンマ付き・64文字超のSNYK ID）を持ち、全recordの別名に厳密なID形式を課していたため、npm DBを用意すると他ecosystemのIDや未収録を含む全説明が`scan_failed`になっていた。別名は文字列であることだけを要求し、照会IDは事前検証済みのため不正形式の別名は一致に使われない。回帰3件（修正前は3件失敗）。修正後はID・別名一致・未収録が正しく返り、1回約24秒・最大RSS約325 MB（macOS arm64、通信禁止なしの直接測定で、source束縛の記録ではない）。
- [x] npm実DBの正式な通信禁止下検証（2026-11-18）：同じ公式完全ZIP 221,682,569 BをCLIで新規取得し、scan_project／scan_sbomでlodash 4.17.20の同じ4件を検出。候補照会無効の対照4.18.0を実DBが別のGHSA-f23m-r3pf-42rhで拒否し、有効時は4.18.1へ再選定・local clean・実native再照会0件。GHSA／CVE同一詳細、完全検索後の未収録、非OSV別名4 recordを許容した全entry読取、40 DB拒否＋入力／件数予算2拒否、EPERM・fetch0・入力DB不変を確認。ハーネス・lockfile fixture・判定41回帰と関連836テスト、106 source／138 artifactを[新記録](OFFLINE_NPM_VALIDATION.md)へ束縛。既存上限・本番処理は変更せず、macOS arm64／Node26の単一npm DB実証に限定する。
- [x] `explain_vulnerability`のローカルDB対応（2026-11-18、ソース実装）：準備済み全DBの私有copyを、固定yauzl 3.4.0でZIP／ZIP64逐次読取し、ID・直接aliasを検索。直接ID優先・残りはID順、関連記録・検索元metadata・ローカル未収録の区別、CRC／全record／容量・時間・freshnessの照合、同一IDの全内容不一致の拒否と共有scan容量への読取前予約を実装。レビュー修正17件を含む64回帰と関連702テスト、通信禁止下の公式Go DBによるGO／CVE／GHSA取得・未収録・35 DB拒否＋構造不正ZIP／件数枯渇を[記録](validation/offline-explanations-2026-11-18.json)へ保存。別名に一致しない同一ID copyも全内容digestで照合し、ZIP／ZIP64の過少countとcount＋sizeによる未読entryの隠蔽をdirectory全bytes・終端境界で拒否する。公式Go ZIPのfooter変更4拒否・正常ZIP64変換1成功、合成Go／PyPIのcopy順2拒否も再検証。説明取得ではバイナリ・APIを使わず、過去段階の記録は上書きしない。
- [x] Maven実DBのオフライン検証（2026-11-18）：公式完全ZIP 10,541,344 Bを事前取得し、OS通信禁止下のscan_project／scan_java_projectでLog4j Core 2.14.1の同じ8件を検出。suggest_fixの2.25.4推奨・ローカルcandidate cleanと実SBOM再照会0件、GHSA ID／CVE別名の同一詳細、未収録・8不正DB条件×5経路の40拒否、fetch0・EPERMを確認。7,258 entry／展開26,385,148 B／最大48,673 Bで既存容量内。再現harness・POM・判定回帰55件と関連757テスト、source／built artifactを[記録](validation/offline-maven-2026-11-18.json)へ束縛する。本番処理・上限は変更せず、POM推移解決・Linux／Windows・archive／全packageへの実証拡張とはしない。
- [x] 不要DB回収を含む現行sourceの実DB再検証（2026-11-18）：公式Go ZIPを事前取得し、macOSの通信禁止下でscan_project／suggest_fix／scan_sbomを再実行。不要object・中断downloadの回収は取得済み実ZIPのlocal replayで確認し、選択DB・既存私有copyのdigestを保持。7種の不正DB×3 toolの21拒否、fetch 0・EPERM、関連591テストを[新検証記録](validation/offline-2026-11-18.json)へ保存した。旧記録は保持し、他ecosystem／platform・候補再照会への実証拡張とはしない。

### 4. 配布方法
- [x] Linux arm64のオフライン配布検証（2026-11-25）。公開版`0.25.0`と現行チェックアウトのtarballを別々に準備し、Debian 12の隔離環境でNode 22.13.0／24.18.0／26.12.1の空導入先へオフライン導入。公式Maven DBで計36 MCP呼び出し、Log4jの8件、2.25.4のローカル再確認、ID／別名の詳細一致を確認した。IPv4／IPv6は`EPERM`、元7領域は`EACCES`、Node 20.19.6は`EBADENGINE`。Node 26.12.1用に対象OSへ`libatomic1`を事前配置した。Windows／Linux x64の配布物検証は未実施。[検証結果と再現手順](OFFLINE_PACKAGE_VALIDATION.md#linux-arm64-package-validation-2026-11-25)
- [x] 配布物検証の記録からマシンのパスを除去（2026-11-18）：`denied_original_reads`に読取拒否を確かめた7件の絶対パス（ユーザー名を含む）が入っていたため、領域名（checkout／npm-cache／scanner-cache／node-install／kit／maven-db／node22-download）に置き換えた。当初の記録は測定値・測定時runner hashを保持した。runnerは`--denied-path <domain>=<絶対パス>`を受け取り、記録には領域名と結果だけを書く。現行runnerでの再測定は次項へ記録する。
- [x] 絶対パスを出力しない現行runnerで配布物を再検証（2026-11-18）：既存kit全入力と現ビルド144 fileを照合し、通信禁止下でrunnerだけを更新した新kitを別pathへ転送。元7 domainと旧kit・通信を拒否したまま、22.13.0／24.22.1／26.12.1の空導入先install・native FD path・18 tool call・欠落依存／空cache拒否、20.19.6のEBADENGINEを再確認。7 read／4 TCP probeは全てEPERM。新記録はrunnerが領域名のみを直接出力し、事後置換なし・絶対パス0・現行source hash不一致0。35判定／関連795テストと型・build・構文検査を確認し、[記録](OFFLINE_PACKAGE_VALIDATION.md#path-free-runner-revalidation-2026-11-18)を更新。配布物・runtime・依存・DBのbytesとDB取得時刻を維持し、Linux／Windows等へ範囲を拡張しない。
- [x] 配布物のオフライン導入・Node互換検証（2026-11-18）：現checkoutのnpm pack・実行時lock／npm cache・npm・Node・scanner・Maven DBを転送用一式に保存し、別pathへcopy後、通信と元repo／npm cache／scanner／Node／kit／DB等7 domainへのreadをOSで拒否。22.13.0／24.22.1／26.12.1で空の導入先へ`npm ci --offline --omit=dev --ignore-scripts --engine-strict`し、144配布fileの同一性・native FD path・5 tool種6 call×3 runtimeを確認。各8件・2.25.4 local clean・GHSA／CVE同一詳細、空cache／依存欠落の拒否と20.19.6のEBADENGINEを記録。新規判定30件・関連790テストと[検証記録](OFFLINE_PACKAGE_VALIDATION.md)を追加。最低engine設定は変更せず、registry公開版との同一性・全Node patch／Linux／Windows・別UIDを実証したとはしない。
- [x] npmパッケージ化(`npx osv-scanner-mcp`)→ 配布準備完了(2026-07-04)。パッケージ名の空きを確認済み。`files: ["dist"]`でテスト除外(tsconfig.build.json)、`prepack`で自動ビルド、`prepublishOnly`でtypecheck+test実行。tarballを隔離環境にインストールしてbin起動・3ツール・実スキャンまで検証済み。**v0.1.0として公開済み(2026-07-04)**: https://www.npmjs.com/package/osv-scanner-mcp
- [x] Claude Desktop設定ファイルへの登録手順をREADMEに明記 → README.md作成時に記載(2026-07-04)。Claude Code(`claude mcp add`)の手順も併記

### 5. Gradle対応(MVP後)
- [x] build.gradle / build.gradle.kts の検出ロジック → `projectDetector.ts`で対応(2026-07-04)。gradle.lockfile / buildscript-gradle.lockfileをマニフェストとして検出。build.gradle系はあるがlockfileが無い場合は`gradle_lockfile_missing`エラーで生成手順(`./gradlew dependencies --write-locks`)を案内
- [x] lockfile方式 vs ビルド実行方式の比較 → **lockfile方式で確定**。ビルド実行方式はbuild.gradle自体が任意コードとして実行されるため、信頼できない入力パスを扱うMCPサーバーのセキュリティ設計と相容れない。OSV-Scanner 2.4.0がgradle.lockfileをネイティブ解釈し、ecosystemも同じ「Maven」のためレポート整形・suggest_fixは無変更で動作(実機確認済み)。エラーkindは`no_pom_found`→`no_manifest_found`にリネーム(npm公開前のため互換性影響なし)

## セキュリティ考慮事項 【重要・継続確認】

MCPサーバーは「外部プロセス実行」「ファイルシステムアクセス」を伴うため、脆弱性診断ツール自体が攻撃経路にならないよう以下を設計・実装の各段階でチェックする。

### コマンドインジェクション対策
- [x] `project_path` などユーザー入力・LLM由来の値をシェル経由で結合しない → `src/osv/runner.ts`で`spawn(..., { shell: false })`+引数配列を使用(2026-07-04)
- [x] OSV-Scannerへの引数はホワイトリスト化されたオプションのみ許可 → 固定引数リスト`FIXED_SCAN_ARGS`のみ。可変部は検証済み絶対パス1つだけ

### パストラバーサル対策
- [x] `project_path` の正規化・境界チェック → `src/utils/projectDetector.ts`で`realpath`解決後、`allowedRoot`オプション指定時は配下チェック(2026-07-04)
- [x] シンボリックリンク経由での想定外アクセスも考慮 → 境界チェックはリンク解決後の実体パスで実施。pom.xml探索ではシンボリックリンクのディレクトリを辿らない

### 供給網(サプライチェーン)の信頼性
- [x] 自動ダウンロードする場合、OSV-Scannerバイナリの取得元は公式GitHub Releasesに限定 → URLは`github.com/google/osv-scanner/releases/download/`固定(2026-07-04)
- [x] チェックサム/署名検証を行い、改ざんされたバイナリの実行を防ぐ → ピン留めバージョンのSHA256をソースに埋め込み。キャッシュも使用のたびに再検証
- [x] npm依存パッケージ自体も定期的に(このMCPサーバー自身に対しても)脆弱性スキャンをかける(自己言及的だが重要) → GitHub Actions等でのCI/CD定期スキャン設定完了

### 出力・リソースの安全性
- [x] OSV-Scannerの出力(JSON)をパースする際、不正な形式や巨大出力に対するタイムアウト・サイズ上限を設定 → `runner.ts`でタイムアウト(デフォルト120秒)・stdout上限(32MB)・stderr抜粋上限(8KB)を実装。不正JSONは`invalid_output`エラー(2026-07-04)
- [x] スキャン結果に含まれる外部由来の文字列(パッケージ名、説明文など)をLLMにそのまま渡す際のプロンプトインジェクション耐性も考慮(結果はあくまで「データ」として扱われるよう構造化する) → `utils/externalText.ts`のサニタイザで制御文字(ANSI含む)・ゼロ幅文字・双方向制御文字・Unicodeタグ文字・行区切りを除去+NFC正規化。`unknownJson.ts`のアクセサ(全外部JSON文字列の読み取り経路)と`toolResult.ts`のエラー出力(stderr経路)を単一境界として組み込み(2026-07-05)

### 権限の最小化
- [x] MCPサーバープロセスに必要以上のファイルシステム権限を与えない → v0.10.0でNodeの権限モデル(`--permission`)での動作に対応(任意の多層防御。下記「B3 詳細設計メモ」)
- [x] ネットワークアクセスはOSV-Scannerの照会先(OSV API等)に限定されることを明示し、README等でユーザーに透明性を提供 → v0.3.3でREADMEに通信先の一覧を追加(現在は「Network destinations and privacy」節)。2026-10-07の実機確認でpom.xml/requirements.txtのスキャンはdeps.devにも接続すると判明。バックログB1で対応

### 運用面
- [x] 依存パッケージの自動更新(Dependabot等)をリポジトリに設定 → `.github/dependabot.yml`(npm週次、devDependenciesはグループ化)(2026-07-04)。OSV-Scannerのピン留めバージョンは対象外のため手動更新(binaryDownloader.tsのコメントに手順記載)
- [x] リアルタイム診断記録の依存更新後の再測定（2026-11-18）：CIの`Real-time process diagnostics`がC3b-3／C3b-4記録の`package.json`／`package-lock.json`の指紋不一致だけで失敗していた（記録された過程観測は一致）。指紋を現行へ更新し、旧値は各記録の`dependencyRemeasurements[].previousSourceSha256`へ保持（既存の`before*`互換記録は変更しない）。更新後に`OSV_REALTIME_PROCESS=1`で同project（3 file／8 test）をmacOS arm64・Node 26.12.1で3回実行し全件通過。過程観測・他の全source指紋・採用flagは不変。同じ旧lockfile指紋を持つ他の研究記録は対象外。v0.24.0の版上げ後も同じ手順で再測定し（同環境で3回・8 test全件通過）、記録は`dependencyRemeasurements`の配列に2件目として追記した。v0.24.1の版上げ後（2026-11-20）も同じ手順で再測定し（同環境で3回・8 test全件通過）、3件目として追記した。v0.24.2の版上げ後（2026-11-20）も同様に再測定し（同環境で3回・8 test全件通過）、4件目として追記した。koffi 3.3.8への依存更新（Dependabot #27）の後も同様に再測定し（同環境で3回・8 test全件通過）、5件目として追記した。v0.24.3の版上げ後（2026-11-20）も同様に再測定し（同環境で3回・8 test全件通過）、6件目として追記した。直前に別プロセスの負荷（load average約11）がある状態で2回実行した際は、実時間のlease超過（`current_control_grant_revoked`）で4件が失敗し、負荷が下がった後の3回はすべて通過した。v0.25.0の版上げ後（2026-11-21）も同様に再測定し（同環境で3回・8 test全件通過）、7件目として追記した。vitest 5.1.1への開発依存更新（Dependabot #28）の後も同様に再測定し（`package-lock.json`の指紋だけ。同環境で3回・8 test全件通過）、8件目として追記した。
- [x] 自己スキャンの期限付き除外を削除（2026-11-19）。Vitest経由の開発依存 `picomatch` 4.0.7 に対する [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) が11月18日に撤回されたため、`osv-scanner.toml` から12月18日期限の除外を削除した。`CVE-2026-112366` はCVE登録元で公開状態を確認。除外削除後、ローカルのOSV-Scanner 2.7.0でCIと同じ `package-lock.json` を照合し、217パッケージで検出0件、終了コード0を確認した。
- [x] 脆弱性報告用の`SECURITY.md`を早期に用意 → 作成済み(2026-07-04)。GitHubプライベート脆弱性報告(Security Advisories)を窓口とする。(設定有効化済み)

## JAR実体スキャン(v0.2.0候補)設計メモ(2026-07-15)

lockfileが無い・shaded JARしか手元に無いプロジェクトへの対応。Trivy的な「アーティファクト実体スキャン」を既存のピン留めバイナリだけで実現する。

### 実機確認結果(2026-07-15、osv-scanner v2.4.0)

- `osv-scanner scan source --experimental-plugins java/archive <path>` で **JAR内の `META-INF/maven/<g>/<a>/pom.properties` からGAVを復元してスキャンできる**ことを確認(合成JAR: log4j-core 2.14.1 → Log4Shell含む7件検出)
- 中身はOSV-SCALIBRの `java/archive` 抽出器。Spring Boot fat JAR(`BOOT-INF/lib`)・WARのネストJARも再帰展開する
- **重要な発見: 同定不能JARは出力から無言で消える**。メタデータなしJAR単体では `"results": []`(エラーでも警告でもない)。混在ディレクトリでは同定できたJARだけが `results[]` に載り、不能JARは存在の痕跡すらない。**カバレッジ追跡はMCP側の責務**
- 検出限界: pom.properties が手がかりのすべて。maven-shade-plugin はデフォルトで依存のpom.propertiesを同梱したままにするので通常のshaded JARは拾えるが、`minimizeJar`/フィルタでメタデータ除去済みのJARは同定不能(偽陰性)。Trivyはここを SHA1→GAV の事前構築DB(trivy-java-db、数百MB級)で埋めるが、同梱は非現実的。Maven Central Search APIへのハッシュ照会は「照会先はapi.osv.devのみ」という現行のプライバシー特性を崩すため採用しない(注: 2026-10-07の実機確認で、pom.xmlのスキャンは既にdeps.devにも接続していると判明。バックログB1参照)

### ツール設計方針

- **`scan_java_project` とは別ツール(`scan_java_artifact`)として新設する**。lockfile方式=依存グラフが完全、実体スキャン=ベストエフォート同定で精度の意味論が違うため、既存ツールのスキーマは変更しない
- 実装コスト: 固定引数リストに `--experimental-plugins java/archive` を追加+入力パス許可拡張(`.jar`/`.war`)が本体。zip展開はosv-scanner(Go)側で行われるため、Node側にzipパースの攻撃面は増えない
- experimentalフラグのため、ピン留めバージョン更新時にフラグ名の変更有無を確認する(binaryDownloader.tsの更新手順に追記すること)

### 同定不能の扱い(論点3、2026-07-15議論で確定)

脅威モデル: 下流のLLMが `vulnerability_count: 0` を見て「安全です」と誤要約すること。

- **JARごとの状態は3値**: 同定済み・脆弱性あり / 同定済み・既知脆弱性なし / 同定不能。同定不能の検知は、Node側で `*.jar`/`*.war` を列挙(pom.xml探索と同じシンボリックリンク非追従の走査を再利用)し、`results[].source.path` との差分を取る
- **「同定済み」も完全ではない**(40依存中25個分しかメタデータが無いshaded JARでは15個が静かに欠落)。部分欠落はヒューリスティックでも確実に検知できないため、per-JARの推定はせず**レポート全体に completeness を明示**する(CycloneDX SBOMのcomposition completenessが先例)
- **出力スキーマの誤要約対策3点**:
  1. `coverage` オブジェクト(`jars_found` / `jars_identified` / `unidentified_jars[]` / `completeness: "incomplete"`)を**JSONの先頭**に置く(LLMは逐次的に読む)
  2. フィールド名に意味論を焼き込む: `vulnerability_count` ではなく `identified_vulnerability_count`
  3. `unidentified_jars[].hint` は固定文字列(「shaded/minimizedの可能性。ビルド元プロジェクトのlockfileスキャンを推奨」)。`path` はスキャン対象由来のファイル名なので `sanitizeExternalText` を通す(単一境界ポリシーの適用対象)
- **エラーとresultの線引き**: JARが1つも見つからない → 新エラー種別 `no_scannable_artifacts`(`manifest_not_found` と対称)。**全JARが同定不能 → エラーではなく成功レスポンス**(`jars_identified: 0` + completeness警告)。「一部だけ不能」との連続性を保つ

### 残タスク

- [x] `scan_java_artifact` の入力Zodスキーマとcoverage先頭の出力を実装(2026-09-15)。WARを含む外側アーカイブ単位の3状態を返し、全体のcompletenessは常にincomplete
- [x] runner.tsのプラグイン引数対応+上限付きJAR/WAR列挙を実装。列挙済み絶対パスだけを渡し、default pluginsを無効化、`--all-packages`で既知脆弱性のないパッケージも取得。`unknown:unknown`等は同定不能として扱う
- [x] suggest_fixは今回の実装では既存のマニフェスト方式専用を維持。アーティファクトへの拡張は別途検討
- [x] 実プロジェクトのfat JAR(Spring Boot等)・shaded JARでの実機検証 → 2026-10-08に実施(下記「B3 詳細設計メモ」の検証結果)

実装時の検証: ピン留め済み2.4.0で合成JAR、WAR内の`WEB-INF/lib`、Boot形式の`BOOT-INF/lib`、同定済み・既知脆弱性なし、メタデータなしの5ファイルをMCP経由で確認。`--all-packages`では同定不能のプレースホルダーも出力されるため、source.pathの存在だけでなくMaven座標の有効性を確認する。実プロジェクト由来の成果物での検証は上記のとおり未完了。

## SBOM入力スキャン(2026-09-26)

- `scan_sbom`を新設。CycloneDX 1.4/1.5/1.6およびSPDX 2.2/2.3のJSONファイルを受け付ける。XML/tag-value/SPDX 3は対象外
- 許可ルート検証、通常ファイル確認、16MiB上限の読み込み後、専用一時ディレクトリの標準名ファイルへコピー。`sbom`プラグインのみで正確なコピーをスキャンし、成功・失敗ともに削除する
- レポート先頭のcoverageで識別範囲を示し、網羅性・元成果物との一致は未検証と明示。スキャナーが返した空バージョン等はunidentified_packagesへ分離し、識別済み依存の結果を失わない
- 入力SHA256は監査用であり、JARとの一致やSBOM生成元の真正性を証明するものではない
- SBOM生成やビルド実行は含めない。BookmapのJARを補完するには対応ビルドのSBOMが別途必要
- 外部の`osv-scanner-dummy-project`でCycloneDX Maven plugin 2.9.3によるSBOM生成とMaven Shade 3.6.2によるfat JAR生成を検証。7依存の元JAR SHA-256がSBOMと一致し、5,683クラスのバイト列がfat JARと一致。両入力のMCPスキャンで17件の脆弱性識別子・対象パッケージが一致した(件数は照会時点のOSVデータに依存)
- この照合はアプリケーションクラスやrelocation/minimizeのないテスト用成果物に限定。署名・モジュール記述子・その他リソースは対象外で、製品のcoverage保証は変更しない。外部検証スクリプトはnpm配布物に含めない

## 対象エコシステム拡大(JavaScript / Python / Go)詳細設計メモ(2026-10-07)

バックログB2の詳細設計。確定方針(汎用`scan_project`の新設・既存ツール維持・lockfile方式・requirements.txtは欠けを明示して受け付ける)を前提とする。

### 非目標

- パッケージマネージャー・ビルドツールの実行(`npm install` / `pip install` / `uv lock` / `go build`等)。いずれも任意コード実行や外部取得を伴う。lockfileの生成は利用者が信頼できる環境で行う
- Goの呼び出し解析(govulncheck相当。Goツールチェーンとモジュール取得が必要)
- オフラインの脆弱性DB照会、言語別ツールの増設

### 実機確認結果(2026-10-07、osv-scanner v2.4.0)

**読み込めるファイル**(最小構成のフィクスチャで確認):

| エコシステム | ファイル | 開発用依存の区別(`dependency_groups`) |
|---|---|---|
| npm | `package-lock.json` | あり(`dev`) |
| npm | `npm-shrinkwrap.json` | 未確認(パッケージは読める) |
| npm | `yarn.lock`(v1) | なし(形式に情報がない) |
| npm | `pnpm-lock.yaml`(v9) | **なし**(devDependenciesに書いたパッケージも区別されない) |
| npm | `bun.lock`(テキスト形式) | なし |
| PyPI | `poetry.lock` | あり(`dev`) |
| PyPI | `Pipfile.lock` | あり(`develop`→`dev`) |
| PyPI | `uv.lock` | なし |
| PyPI | `pdm.lock` | **不正確**(groups未記載のパッケージが`optional`になる) |
| PyPI | `requirements.txt` | なし |
| Go | `go.mod` | なし(`// indirect`も出力に現れない) |

- `dependency_groups`は形式によって欠落・不正確なため、**生の値として表示するだけにし、優先度判定には使わない**
- lockfileが無い場合: `package.json`だけ・`pyproject.toml`だけのディレクトリはexit 128(パッケージなし)。検出側で案内する必要がある
- `go.mod`は`toolchain`指定があっても標準ライブラリ(stdlib)を報告しない
- `-r`は`node_modules`配下のlockfileを拾わない
- `--lockfile <形式>:<パス>`で、ファイルごとに解析形式を明示して個別にスキャンできる(pom.xmlも可。推移的依存の解決も`-r`と同じく行われる)
- 通信先: lockfileはapi.osv.devのみ。`requirements.txt`はpom.xmlと同じくapi.deps.devで推移的依存を解決する(`--no-resolve`で止まる)。`--index-url` / `--extra-index-url`に書いた任意のURLへは接続しない(deps.devモード)
- OSVの影響範囲の型: npmは`SEMVER`(一部`ECOSYSTEM`)、Goは`SEMVER`のみ、PyPIは`ECOSYSTEM`+`GIT`。パッケージ名はPyPIも小文字に正規化されて返り、OSVレコード側の名前と完全一致した(lodashのアドバイザリにはlodash-es等の別パッケージも並ぶため、名前の完全一致での絞り込みは必須)
- `requirements.txt`: バージョン未固定の行は出力から消え、`>=2.0`は下限`2.0`を使用中バージョンとみなす。**`-r`による取り込みをたどり、相対パスならスキャン対象ディレクトリの外のファイルも読む**(絶対パスの取り込みはたどらない)

**現行版(v0.3.3)の不具合**(上記の確認中に判明):

1. **スキャン範囲の境界の迂回**: Java用ツールは`-r <ディレクトリ>`でスキャンするため、ディレクトリ内の`requirements.txt`も読む。`-r ../../outside/x.txt`を書いた`requirements.txt`を置くと、`OSV_MCP_ALLOWED_ROOT`の外のファイルが読まれ、`名前==バージョン`として解析できた行が結果に含まれ、api.osv.devへ送られる(MCP経由で再現)
2. **suggest_fixの誤表示**: Javaプロジェクトにnpmのlockfileが同居すると、npmパッケージも結果に含まれる。修正版の抽出がMaven専用のため、修正版のあるnpmの脆弱性(lodash: 4.17.21で修正)を「現在より新しい修正版がない(unfixed)」と返す
3. **範囲の不一致**: `manifests`(検出は深さ3まで)と実際のスキャン範囲(`-r`、深さ無制限・全エコシステム)が一致しない。B1のレビュー指摘(深い階層のpom.xml)と同根

### 中核の設計判断: 検出したファイルだけを個別に渡す

`-r <ディレクトリ>`をやめ、検出側(Node)が列挙したファイルだけを`--lockfile <形式>:<絶対パス>`で渡す。JAR実体スキャン(列挙済みの絶対パスだけを渡す)と同じ考え方で、**検出結果を唯一のスキャン範囲にする**。

- 応答の`manifests`と実際のスキャン範囲が常に一致する(不具合3の根本解決)
- Java用ツールは`pom.xml`と`gradle.lockfile`だけを渡すため、`requirements.txt`やnpmのlockfileはスキャンされない(不具合1・2はJava用ツールでは発生しなくなる)
- 解析形式を明示するため、ファイル名からの推測に依存しない
- 代わりに検出側の探索上限が実質的なスキャン範囲になる。深さ3では深い階層のMavenマルチモジュールを取りこぼすため上限を見直し、**上限に達したら黙って打ち切らずエラーにする**(`artifact_search_limit_exceeded`と同様)。実装時の判断(Phase 0): Javaのソースツリー(`src/main/java/com/...`)は深いため、深さ8程度で打ち切るとエラーになるプロジェクトが続出する。そこで深さでは実質打ち切らず(安全弁として64)、上限は探索エントリ総数(20万)とマニフェスト数(1,000)で設け、超過時は`manifest_search_limit_exceeded`。従来の`-r`も全体を走査していたため、処理量は同等

### 検出(`projectDetector`の一般化)

- 対象: 上表のファイル+既存のpom.xml/gradle.lockfile。同じディレクトリに複数のnpm系lockfileがあればすべて渡す(実際に使われているものを推測しない)
- 除外ディレクトリ: 既存(`.git`、`node_modules`等)に加え、`.venv`、`venv`、`site-packages`、`__pycache__`、`.tox`、`vendor`
- lockfileが無いマニフェスト(`package.json`、`pyproject.toml`、`Pipfile`): そのディレクトリをcoverageの`lockfile_missing`に記録し、生成コマンドを案内する(`npm install --package-lock-only --ignore-scripts`等。生成は利用者が信頼できる環境で行う旨を明記)
- エラーと結果の線引き(JAR実体スキャンと同じ): 対応ファイルが1つも無ければエラー(`no_manifest_found`を流用)。一部だけ欠ける場合は成功レスポンスにcoverageで示す

### requirements.txtの扱い

Node側で各行を分類してから渡す(pipは使わない。サイズ上限付きの単純な行解析):

- `名前==バージョン`: スキャン対象
- 未固定・範囲指定(`>=`等): coverageの`unpinned_requirements`に記録。`>=`の行はosv-scannerが下限を使用中バージョンとみなすため、該当パッケージに`version_is_lower_bound: true`を付ける
- `-e`・URL・VCS参照: スキャンできない依存としてcoverageに記録
- **取り込み(`-r` / `--requirement` / `-c` / `--constraint`)**: 取り込み先を取り込み元からの相対パスとして解決し、realpath後に**プロジェクトディレクトリ内**であることを検証する(`OSV_MCP_ALLOWED_ROOT`未設定でも適用)。外を指す・存在しない・シンボリックリンク経由の場合は、そのrequirements.txtをスキャン対象から外し、coverageに理由を記録する。取り込みの連鎖も同様に検証し、深さとファイル数に上限を設ける
- 推移的依存の解決(deps.dev)はpom.xmlと同じ扱い。`dependency_resolution`の警告文は「pom.xml / requirements.txt」に一般化する

### suggest_fixの言語対応

- バージョン比較をエコシステム別に差し替える。インターフェース: 比較・系統(major.minor)の抽出・破壊的変更の判定
  - Maven: 既存の`mavenVersion.ts`
  - npm・Go: Semantic Versioning 2.0.0の優先順位(プレリリースの扱い、ビルドメタデータは無視)。Goは`v`なしで返る版、疑似バージョン(`0.0.0-20190101-abcdef`)、`+incompatible`に対応
  - PyPI: PEP 440(epoch、プレ/ポスト/開発版、ローカル版、正規化)。テストは公開されている参照実装のテストケースを移植する(移植前にライセンスを確認)
- `affectedVersions.ts`: `SEMVER`型の範囲を検証対象に加える。`GIT`型はコミット単位でリリース版と無関係のため、同じaffectedエントリに`ECOSYSTEM`/`SEMVER`型があれば無視する(`GIT`型しか無ければ情報不足のまま)
- `extractFixedVersions`: Maven限定の条件を外し、エコシステム別の比較で並べる
- パッケージ名の照合: PyPIは防御的にPEP 503の正規化(小文字化、`-_.`の連続を`-`)で比較する
- 破壊的変更の扱い: npm・Goでは0.x系のマイナー更新(`0.3`→`0.4`)も`cross_major`として扱う。Goのv2以上はモジュールパス自体が変わる(OSV上も別パッケージ)ため、その旨を注記に含める
- 未対応エコシステム: `verification: "unsupported_ecosystem"`を返し、CVEを`unfixed`に数えない(不具合2の再発防止)
- 直接/推移的依存の区別(v0.6.0): osv-scannerの出力には無い。独自解析が必要なため、JSON(package-lock.json)と行形式(go.mod、requirements.txt)に限定し、YAML/TOMLのパーサー追加は見送る。推移的依存への推奨は「親パッケージの更新」とし、npmの`overrides`はルートプロジェクトでのみ有効な点を推奨文に含める

### 応答スキーマ(`scan_project`)

誤要約対策の原則(JAR実体スキャン)を踏襲し、件数より前に範囲情報を置く:

- `dependency_resolution`(B1と同じ)
- `coverage`: `manifests`(ファイルごとのエコシステムと形式)、`lockfile_missing[]`、`unpinned_requirements[]`、`skipped_files[]`(取り込み先の検証失敗等、理由付き)。ファイル名・行内容は`sanitizeExternalText`を通す
- `ecosystem_breakdown`: エコシステム別の件数
- `packages[]`: 既存の項目に`dependency_groups`(生の値)、`version_is_lower_bound`を追加

### 段階計画と完了条件

- **Phase 0(v0.3.4、修正リリース)**: 既存ツールを「検出したファイルだけを個別に渡す」方式へ切り替え、探索上限の引き上げと上限到達時のエラー化。suggest_fixで非Mavenを`unsupported_ecosystem`にする。完了条件: 上記の不具合1〜3の再現手順を回帰テスト化し、MCP経由で解消を確認
- **v0.4.0**: `scan_project`(全形式の検出、requirements.txtの行分類と取り込み検証、coverage、エコシステム別集計)。suggest_fixはJava以外を`unsupported_ecosystem`のまま
- **v0.5.0**: suggest_fixのnpm/Go対応(semver比較、`SEMVER`範囲、0.x規則)
- **v0.6.0**: suggest_fixのPyPI対応(PEP 440、`GIT`範囲の扱い)、直接/推移的依存の区別
- **以降**: Goバイナリスキャン(ビルド情報からstdlibの版も取得できる)

### テスト方針

- 上表の各形式の最小フィクスチャ(正常系)と、lockfile欠如・取り込みの境界外・未固定行などの異常系
- バージョン比較は各仕様の参照テストケース(semver仕様の例、Goの`golang.org/x/mod/semver`、PEP 440の参照実装)
- MCP経由のE2Eと、接続先の記録(CONNECTプロキシでの確認手順をB1から再利用。npm配布物には含めない)

### 未確認事項

- `npm-shrinkwrap.json`の開発用依存の扱い、旧形式`bun.lockb`(バイナリ)の対応可否、yarn v2以降(berry)のlockfile
- 取り込みの検証で外したrequirements.txtの、取り込み以外の行をスキャンすべきか(部分スキャンを許すか)
- `--lockfile`で個別に渡したpom.xmlが、親POMやモジュールを`-r`の場合と同じく解決するか(マルチモジュールの実プロジェクトで確認)

## suggest_fix npm/Go対応(v0.5.0)詳細設計メモ(2026-10-07)

### 実データの調査結果(2026-10-07、api.osv.dev)

利用者の多いnpm 43パッケージ(脆弱性550件)とGo 27モジュール(947件)のOSVレコードを取得し、対象パッケージの`affected`エントリを集計した。

| 項目 | npm | Go |
|---|---|---|
| 範囲の型 | SEMVER 877 / ECOSYSTEM 1 / 範囲なし 1 | SEMVER 1166 / ECOSYSTEM 6 |
| GIT型 | 0 | 0 |
| `last_affected` | 18 | 24 |
| 同じパッケージに複数の`affected`エントリ | 186 | 118 |
| プレリリースの修正版(`fixed`) | 16(`5.0.0-beta.3`、`15.6.0-canary.61`等) | 118(ほぼ疑似バージョン `0.0.0-20180925071336-cf3bd585ca2a`) |
| ビルドメタデータ | 0 | 34(`20.10.14+incompatible`) |
| SemVerとして解釈できない値 | 1(next: `introduced: "13.0"`) | 7(docker/dockerのGHSA: `19.03.9`、`17.06.0-ce`) |

結論:
- 比較器はSemantic Versioning 2.0.0の優先順位(ビルドメタデータは無視)で足りる。npm・GoともECOSYSTEM型の順序もSemVerと同じため、両方の型を受け付ける
- GIT型は対象のエコシステムに現れないため、無視の規則はv0.6.0(PyPI)で扱う。現れた場合は従来どおり情報不足とする
- SemVerとして解釈できない値を含むレコードは情報不足として扱う(推奨を保留する安全側)。docker/dockerはGO-のレコードが正しくてもGHSA側の`19.03.9`で保留になる。既知の制限として記録し、別名レコードの選び方は実例が増えてから検討する
- プレリリース・疑似バージョンの修正版が候補に普通に混じる。そのまま「最小の検証済み候補」を選ぶとcanary版を推奨してしまう

### 実装中の不具合(公開中のv0.4.0・v0.4.1)

`scan_project`の`fixed_versions`がnpm・Go・PyPIで常に空になる。`extractFixedVersions`がMavenのECOSYSTEM型だけを集めているため(Javaのみの時代の名残)。READMEは「空配列は修正版が存在しないことを意味する」と説明しているため、lodash 4.17.20(4.17.21で修正)を「修正版なし」と読ませてしまう(実機で確認)。suggest_fixはMaven以外を`unsupported_ecosystem`にしているため影響しない。

### 段階計画(2026-10-07 確定: v0.4.2を先に出す)

- **v0.4.2(修正リリース)**: `fixed_versions`の不具合修正
  - SemVer比較器(`src/utils/semverVersion.ts`)を追加し、エコシステムごとの比較を`src/osv/versionScheme.ts`にまとめる(Maven: `mavenVersion.ts`、npm・Go: SemVer、その他: 比較なし)
  - `extractFixedVersions`: Maven・npm・GoはECOSYSTEM/SEMVER型の`fixed`を集めて比較器で昇順に並べる。PyPI等の比較器がないエコシステムはECOSYSTEM型の`fixed`を重複除去してOSVの記載順のまま返す(並び順は保証しない旨をREADMEに書く)。GIT型(コミットハッシュ)は集めない
  - READMEの`fixed_versions`の説明を修正する(空配列の意味、並び順を保証する範囲)
  - 完了条件: lodash・minimist・golang.org/x/textの修正版が`scan_project`の応答に入ることをMCP経由で確認する
- **v0.5.0**: suggest_fixのnpm/Go対応(以下)

### バージョン比較(`versionScheme.ts`)

エコシステムごとに次の操作を提供する: `parse`(解釈できなければnull)、`compare`、`series`(系統)、`isPrerelease`。

- SemVer: `MAJOR.MINOR.PATCH[-pre][+build]`を厳密に解釈する。数値部の先頭ゼロは不正。優先順位はsemver.org 11節のとおり(数値の識別子は数値で比較、英数字は辞書順、数値の識別子は英数字より小さい、識別子が多いほうが大きい)。ビルドメタデータは比較で無視するため、`20.10.14+incompatible`と`20.10.14`は等しい
- 先頭の`v`は防御的に1文字だけ受け付ける(osv-scannerとOSVはGoの版を`v`なしで返すが、念のため)
- Goの疑似バージョン(`0.0.0-20190101120000-abcdef`、`1.3.1-0.20190301021747-ccb9e902956d`)はSemVerのプレリリースとして正しく並ぶため、特別扱いは表示(注記)だけにする
- テスト: semver.org仕様の例と、Goの`golang.org/x/mod/semver`・node-semverのテストケース(移植前にライセンスを確認し、出典を明記)

### 影響範囲の検証(`affectedVersions.ts`)

- 比較を`versionScheme`経由にする。受け付ける範囲の型: MavenはECOSYSTEM、npm・GoはSEMVERとECOSYSTEM。それ以外はこれまでどおり情報不足(`complete: false`)
- `introduced`・`fixed`・`last_affected`・`limit`・`versions[]`のいずれかが解釈できない場合は情報不足とし、その区間は判定に使わない(候補を「影響なし」と言えなくなるだけで、誤って安全と判定する方向には倒れない)

### 推奨の選び方(`suggestFix.ts`)

- 系統の判定をエコシステム別にする。npm・Go(SemVer)では、npmの`^`(キャレット)が互換とみなす範囲を「同じ系統」とする:
  - 1.0.0以上: 従来どおり(`same_minor` / `major_internal` / `cross_major`)
  - 0.x(0.1以上): 同じ`0.minor`内なら`same_minor`。マイナーが変わる更新は`cross_major`(破壊的変更の可能性)。`major_internal`は発生しない
  - 0.0.x: どの変更も`cross_major`
  - 実データでの例: golang.org/x/text 0.3.0は、3件が0.3.8(`same_minor`)で直るが、GO-2026-5970は0.39.0でしか直らないため、推奨は0.39.0(`cross_major`)になる
- **プレリリースの扱い**(2026-10-07 推奨案で確定): 候補の順位を「正式版 → Tier順 → 版の昇順」とし、正式版の候補で全件を解消できない場合だけプレリリース・疑似バージョンを推奨して`recommended_is_prerelease: true`を付ける。同じTierのプレリリースより、上のTierの正式版を優先する(canary版より正式版のメジャー更新を勧める)
- 現在の版を解釈できない場合(npmのgit依存・`file:`依存など)は推奨を出さず、新しい`verification: "unparseable_version"`を返す。CVEは`unfixed`に数えない
- 注記の追加:
  - Go: v2以上は別のモジュールパス(`/v2`等)でOSV上も別パッケージになるため、新しいメジャー系列の修正版は候補に含まれない。修正版候補がない(unfixed)場合とcross_majorの場合に付ける
  - Go: 現在が疑似バージョン(タグのないコミット)である旨
  - 推移的依存の場合: npmは直接依存の更新か`overrides`(ルートの`package.json`でのみ有効)、Goは`go get <module>@<version>`で直接requireに加える。直接/推移的の区別はv0.6.0のため、v0.5.0では条件付きの一般的な注記にとどめる
- PyPIは`unsupported_ecosystem`のまま(v0.6.0)

### suggest_fixの検出範囲と応答(2026-10-07 推奨案で確定)

- 検出を`detectJavaProject`から`scan_project`と同じ`detectProject`に切り替え、スナップショット経由のスキャン(`scanFromSnapshot`)を共有する。Java専用ツール(`scan_java_project`)は変更しない
- 応答: 既存の`project_dir`・`manifests`・`dependency_resolution`・件数・`suggestions`は維持し、`scan_project`と同じ`coverage`を件数より前に追加する。`skipped_manifests`と`scope_warning`は`coverage.skipped_files`と`coverage.warning`に統合して廃止する
- 利用者から見た変更: Javaプロジェクトに同居するnpm・Go・Pythonのlockfileもsuggest_fixの対象になる(PyPIは`unsupported_ecosystem`として表示)
- ツールの説明文(suggest_fix・scan_project)とREADMEの「Javaのみ」を更新する
- 実装時に確認: Gradleのビルドファイル(`build.gradle`)を直接指定した場合の扱いが`detectProject`と`detectJavaProject`で同じか

### 完了条件とテスト

- 単体: SemVer比較器、0.x・0.0.xの系統判定、プレリリースの順位、解釈できない値での情報不足、Goの`+incompatible`
- 実データの期待値(MCP経由、実バイナリ):
  - lodash 4.17.20 → 4.18.0(`major_internal`。4.17.21・4.17.23では4.18.0で直る2件が残る)
  - minimist 1.2.5 → 1.2.6(`same_minor`。0.2.4の区間は現在より古いため候補外)
  - golang.org/x/text 0.3.0 → 0.39.0(`cross_major`、0.x規則)
  - npmのcanary版が修正版に含まれるパッケージ(next等)で正式版が推奨されること
  - Mavenの既存の期待値(log4j 2.14.1 → 2.25.4)が変わらないこと

## suggest_fix PyPI対応・直接/推移的依存の区別(v0.6.0)詳細設計メモ(2026-10-07)

### 実データの調査結果(2026-10-07、api.osv.dev・osv-scanner v2.4.0)

利用者の多いPyPI 49パッケージ(脆弱性3,356件。PYSEC 1,693 / GHSA 1,660)のOSVレコードを取得し、対象パッケージの`affected`エントリを集計した。

| 項目 | 件数 |
|---|---|
| 範囲の型: ECOSYSTEMのみ | 4,357 |
| 範囲の型: ECOSYSTEM + GIT | 402(約8.5%) |
| 範囲の型: GITのみ / 範囲なし | 3 / 4 |
| `versions[]`あり | 4,736(ほぼ全件) |
| `last_affected` | 154 |
| プレリリースの`fixed` / `introduced` | 207 / 313(`3.2a1`等) |
| post版 / epoch | 2 / 0 |
| 正規形でないがPEP 440として正しい値 | 21(Djangoの`1.8c1`、TensorFlowの`2.8.0-rc0`) |
| PEP 440として不正な範囲の値 | 13(PyTorchの`last_affected: "2.6.0-cu124"`、`"2.6.0-NA"`) |

- `versions[]`には`v2.5.2`(先頭の`v`)のほか、GitリポジトリのタグがそのままPEP 440でない値として入る(`0.9-doduo`、`ciflow/periodic/317eeb8`、`nightly-binary`等)。ECOSYSTEM+GITのエントリは全件`versions[]`を持つ
- osv-scannerはPyPIの名前を小文字に正規化して返し(`Jinja2`→`jinja2`、`PyYAML`→`pyyaml`)、OSVレコード側の名前と一致した
- **osv-scannerの出力には直接/推移的の区別がない**(パッケージごとの項目は`name`・`version`・`ecosystem`と`groups`・`vulnerabilities`のみ)。区別するには本サーバーがlockfile・マニフェストを解析する必要がある

### 段階計画(2026-10-07 推奨案で確定)

独立した2つの機能のため分けてリリースする。

- **v0.6.0**: suggest_fixのPyPI対応(PEP 440、GIT範囲の扱い、`versions[]`の扱い、下限スキャンの注記)
- **v0.7.0**: 直接/推移的依存の区別(`scan_project`・`suggest_fix`の両方)

### PEP 440の比較(`src/utils/pep440Version.ts`)

- PEP 440の正規化に従って解釈する: 大文字小文字の無視、先頭の`v`、epoch(`1!`)、リリース番号(末尾のゼロは比較で無視: `1.0` = `1.0.0`)、プレリリース(`a`/`b`/`rc`と別表記`alpha`/`beta`/`c`/`pre`/`preview`、区切り文字`.`/`-`/`_`の省略・番号の省略)、post版(`.post1`、`-1`、`rev`/`r`)、dev版(`.dev1`)、ローカル版(`+cu124`)
- 優先順位: epoch → リリース番号 → `1.0.dev1` < `1.0a1.dev1` < `1.0a1` < `1.0a1.post1` < `1.0b1` < `1.0rc1` < `1.0` < `1.0.post1.dev1` < `1.0.post1`。ローカル版は同じ公開版より後で、区切りごとに数値は数値として、英字は辞書順で比べ、数値は英字より大きい
- プレリリースの判定: プレリリース・dev版を持つ版(post版は正式版扱い)。v0.5.0と同じく、正式版で解消できない場合だけ推奨して`recommended_is_prerelease`を付ける
- 解釈できない値(`2.6.0-cu124`、`0.9-doduo`)はnull
- テスト: PyPA `packaging`(Apache-2.0 または BSD-2-Clause。本プロジェクトはApache-2.0)のバージョン比較テストのケースを移植し、出典を明記する

### Tierの判定(2026-10-07 推奨案で確定)

npm・Goと同じ規則(1.0以上はmajor.minor、0.xのマイナー更新と0.0.xの更新は`cross_major`)を使う。PyPIにはnpmのキャレットのような共通の互換規則はないが、0.x系でマイナー更新が破壊的変更になるパッケージが実在する(FastAPI等)ため、破壊的変更の可能性を少なく見積もらない側に倒す。epochが変わる更新も`cross_major`。日付ベースの版(certifiの`2023.7.22`→`2024.2.2`)は年が変わると`cross_major`になる(安全側)。

### 影響範囲の扱い(`affectedVersions.ts`)

- PyPIのECOSYSTEM範囲をPEP 440で比較する
- **GIT範囲**: 同じaffectedエントリにECOSYSTEM範囲があればGIT範囲は無視する(コミット単位の範囲で、リリース版の判定はECOSYSTEM範囲と`versions[]`が担う)。GIT範囲しかないエントリは従来どおり情報不足
- **`versions[]`の解釈できない値は無視する**(2026-10-07 確定): `versions[]`は「この版は影響を受ける」という等価判定にだけ使う。PEP 440として解釈できない文字列(Gitのタグ名等)は、解釈できる候補と等しくなりえないため、無視しても候補の判定は変わらない。現行(v0.5.0)の規則はこれを情報不足として扱うため、そのままPyPIに適用すると`versions[]`にタグ名が混じるレコードの推奨がすべて保留になる。npm・Goにも同じ規則を適用する(結果が保留から推奨に変わりうるのは、`versions[]`に不正値がある場合だけ)
- 範囲の境界(`introduced`・`fixed`・`last_affected`)の解釈できない値は従来どおり情報不足(PyTorchの`2.6.0-cu124`のレコードは推奨保留。既知の制限)
- 名前の照合はPEP 503の正規化(小文字化、`-`・`_`・`.`の連続を`-`)で比較する(実データでは完全一致したが防御的に)

### 推奨の選び方

- 現行の順位(正式版 → Tier → 版 → ビルドメタデータ)をそのまま使う。PEP 440のローカル版(`+cu124`)はビルドメタデータと同じ扱い(現在の版と有無が同じものを優先)
- **下限でスキャンした依存**: requirements.txtの`>=X`・`~=X`の行は、osv-scannerが下限Xを使用中の版とみなしてスキャンしている(`version_is_lower_bound`)。この場合の推奨は「下限をY以上に引き上げる」意味になるため、`upgrade_note`にその旨を明記する(実際にインストールされる版は異なる可能性がある)
- `update_hint`(PyPI): requirements.txtの版の指定、またはpyproject.toml・Pipfileの指定を更新してlockfileを再生成する。推移的依存は`pip`の制約ファイル(`-c`)や、uv・Poetryの上書き設定で版を指定する

### 直接/推移的依存の区別(v0.7.0、2026-10-07 推奨案で確定)

- osv-scannerの出力にないため、本サーバーがスナップショットのコピーを解析する(新しい外部依存は追加しない)
- 対象: JSONと行形式のみ。YAML・TOMLのパーサーは追加しない
  - `package-lock.json`(v2以降): ルートとworkspaceの`dependencies`等に書かれた名前で、`node_modules/<名前>`の版と一致するものを直接依存とする。推移的依存には、Nodeの解決規則(入れ子の`node_modules`から上位へ探す)で依存関係をたどり、それを要求している直接依存の名前(`introduced_by`、件数上限付き)を付ける
  - `go.mod`: `require`のうち`// indirect`のないものが直接依存
  - `requirements.txt`: 本サーバーが書いたコピーの行が直接依存。それ以外(deps.devで解決された依存)は推移的
  - `pom.xml`: 当面は対象外(候補: `<dependencies>`の名前で判定できるが、親POM・BOMの依存管理を含めて別途検討)
  - それ以外(yarn.lock、pnpm-lock.yaml、bun.lock、poetry.lock、uv.lock、Pipfile.lock、pdm.lock、gradle.lockfile): `unknown`
- 出力: パッケージごとに`dependency_relation`(`direct` / `transitive` / `mixed`(lockfileによって異なる) / `unknown`)。npmの推移的依存には`introduced_by`。`update_hint`は区別に応じて具体化する
- 同じ名前・版が複数のlockfileに現れるため、スキャン結果のパッケージにスキャン元のファイルを保持する(現行は`source_files`をレポート全体でしか持たない)
- 解析は同じファイルを1回だけ、上限付きで行う(`LockfileKeyCache`と同じ考え方)

### 完了条件とテスト(v0.6.0)

- 単体: PEP 440の正規化と比較(`packaging`のテストケース)、Tier、GIT範囲の無視、`versions[]`の不正値の無視、下限スキャンの注記
- 実データの期待値(MCP経由、実バイナリ): requests 2.19.0・urllib3 1.23・jinja2 2.10・django 3.2.0の推奨と、各CVEの`recommended_status`。PyTorchのような不正な境界値は保留
- Maven・npm・Goの既存の期待値が変わらないこと(`versions[]`の規則変更で変わるものは理由を確認する)

## 直接/推移的依存の区別(v0.7.0)詳細設計メモ(2026-10-07)

v0.6.0の設計メモ(上記)で確定した方針(JSONと行形式のみ解析、pom.xmlは当面対象外)の詳細。

### 実データの確認結果(2026-10-07、npm 11・osv-scanner v2.4.0)

`npm install --package-lock-only --ignore-scripts`で、workspace・別名・入れ子を含むpackage-lock.json(v3)を生成してスキャンした。

- ルートの`packages[""]`に`dependencies`・`devDependencies`・`workspaces`。workspaceは`packages/sub`(本体)と`node_modules/sub`(`link: true`、`resolved: "packages/sub"`)の2つのキー
- 別名(`"old-lodash": "npm:lodash@4.17.15"`)は`node_modules/old-lodash`に`name: "lodash"`。osv-scannerは本来の名前で`lodash 4.17.15`と報告する
- 同じ名前の別の版は入れ子に置かれる(`node_modules/qs` 6.7.0はexpress経由、`packages/sub/node_modules/qs` 6.5.2はworkspaceの直接依存)。osv-scannerは名前と版の組ごとに1件で報告する
- osv-scannerは開発用依存に`dependency_groups: ["dev"]`を付ける(既存の出力のまま)
- go.mod: `// indirect`の付いたrequireも報告される。`replace`は適用後の版で報告され(`golang.org/x/text`→`0.3.5`)、パスを変える`replace`は置換先のパスで報告される(`golang.org/x/text => github.com/golang/text`は`github.com/golang/text 0.3.2`)
- requirements.txt: deps.devで解決された依存(`requests==2.19.0`に対する`idna`・`urllib3`)はファイルに書かれていない名前として報告される。`--no-resolve`では書いた依存だけ

### 判定の規則

ファイル(スナップショットのコピー)ごとに、名前と版の組の関係を判定する。

- **package-lock.json(v2以降)**
  - 起点: ルート(`""`)とworkspace(`node_modules/`で始まらないキー)。起点の`dependencies`・`devDependencies`・`optionalDependencies`・`peerDependencies`を、Nodeの解決規則(`<起点>/node_modules/<名前>`から上位の`node_modules`へ順に探す。`link: true`は`resolved`のworkspaceへ)で解決したエントリが**直接依存**
  - 直接依存から`dependencies`・`optionalDependencies`・`peerDependencies`をたどって到達するエントリが**推移的依存**。経由した直接依存の名前を`introduced_by`に集める(別名は依存のキー名ではなく本来の名前)
  - エントリの名前は`name`があればそれ、なければキーの最後の`node_modules/`以降(`@scope/name`を含む)
  - 同じ名前と版のエントリが直接依存でもあり推移的にも到達する場合は`direct`とし、`introduced_by`も付ける(直接依存を更新しても、他の経路の同じ版が残りうるため)
  - どの起点からも到達しないエントリ(extraneous)は`unknown`
  - lockfileVersion 1(依存の木だけでルートの直接依存の一覧がない)は`unknown`
- **go.mod**: `require`のうち`// indirect`の付かないものが`direct`、付くものが`transitive`。`replace`で置換されたモジュールは置換先のパスにも同じ関係を当てる(osv-scannerは置換先のパスで報告する)。`introduced_by`はgo.modだけでは分からないため付けない
- **requirements.txt**: 本サーバーが書いたコピーの行(取り込みを展開した行を含む)の名前が`direct`(PEP 503で照合)、それ以外の名前(deps.devで解決された依存)が`transitive`
- **それ以外の形式**(pom.xml、gradle.lockfile、yarn.lock、pnpm-lock.yaml、bun.lock、poetry.lock、uv.lock、Pipfile.lock、pdm.lock): `unknown`

### スキャン結果との対応付け

- osv-scannerの`results[].source.path`(スナップショットのコピーのパス)とパッケージの組を、パッケージごとに保持する。現行の`parseOsvScanOutput`はファイルをまたいで集約するため、応答に出ない形(シンボルのキー)でパッケージごとのスキャン元を残す(`scan_java_project`等の既存の応答は変えない)
- 複数のファイルに現れるパッケージは、ファイルごとの判定がすべて同じならその値、異なれば`mixed`。`introduced_by`はファイルをまたいで合わせる

### 出力(2026-10-07 推奨案で確定)

`scan_project`の`packages[]`と`suggest_fix`の`suggestions[]`に次を加える。`scan_java_project`・`scan_sbom`・`scan_java_artifact`は変えない。

- `dependency_relation`: `direct` / `transitive` / `mixed` / `unknown`(すべてのパッケージに付ける。値がないと「直接依存」と誤読されうるため、判定できない形式も`unknown`と明示)
- `introduced_by`(npmのみ): その版を推移的に要求している直接依存の名前。最大10件、超えた分は`introduced_by_omitted`に件数
- `declared_in`(npmの直接依存のみ): 直接依存として宣言しているpackage.json(`package.json`、`packages/sub/package.json`)。workspaceの直接依存をどこで更新すればよいかを示す
- `update_hint`(suggest_fix)を関係に応じて具体化する:
  - npmの直接依存: `declared_in`の指定を更新
  - npmの推移的依存: `introduced_by`の直接依存を更新する。直らない場合はルートのpackage.jsonの`overrides`(ルートのプロジェクトでのみ有効)
  - Goの`// indirect`: `go get <module>@<version>`(go.modの`// indirect`のrequireが更新される)。`replace`で置換されている場合は`replace`の版を更新する
  - PyPIの推移的依存: 制約ファイル(`-c`)、またはuv・Poetryの上書き設定
  - `unknown`・`mixed`: 現行の一般的な案内(直接・推移的の両方を記載)

### 上限と安全性

- 解析対象はスナップショットのコピー(検証済み・サイズ上限内)だけ。元のファイルは読まない
- package-lock.jsonは1ファイル1回だけ解析し、解析する合計サイズに上限を設ける(`LockfileKeyCache`と同じ256MiB)。上限を超えたファイルは`unknown`にする(スキャン自体は続ける)
- 依存のたどりは訪問済みのエントリを記録して循環で止める。たどる辺の総数にも上限を設け(例: 200万)、超えたら`unknown`
- 出力する名前・パスは`sanitizeExternalText`を通す

### 完了条件とテスト

- 単体: Nodeの解決規則(入れ子・上位への探索・scope付き名前・link)、別名、workspace、直接かつ推移的、extraneous、lockfileVersion 1、循環、上限、go.modの`// indirect`・`replace`(パスの変更を含む)・単一行と括弧のrequire、requirements.txtの取り込み展開、複数ファイルでの`mixed`
- 実データ(上記のlockfile、MCP経由、実バイナリ): express・lodash(両方の版)・minimist・node-fetch・qs 6.5.2が`direct`(`declared_in`付き)、qs 6.7.0・body-parser・cookie・path-to-regexp・send・serve-staticが`transitive`で`introduced_by: ["express"]`。go.modとrequirements.txtも上記の期待値どおり
- `scan_java_project`等の既存の応答が変わらないこと

## 推奨先のOSV照会(v0.8.0候補)詳細設計メモ(2026-10-08)

### 背景

suggest_fixの推奨は、スキャンで分かった脆弱性(現在の版に該当するもの)の影響範囲だけで検証している。推奨先に、現在の版には該当しない新しい脆弱性があっても分からない。実例: cryptography 3.2の推奨49.0.0は、44.0.0で混入し50.0.0で修正された2件(GHSA-g6cj-pr64-35w5、PYSEC-2026-3552)に該当する(v0.6.0の検証で判明)。

### 実データの確認(2026-10-08、api.osv.dev)

- `POST /v1/query`(パッケージと版)は、その版に該当する脆弱性の**完全なレコード**を返す。既存の影響範囲の検証(`extractAffectedVersions`)と修正版の抽出をそのまま使える
- 版の表記: Goは`v`の有無どちらでも同じ結果。`+incompatible`、Mavenの`group:artifact`、PyPIの大文字・`3.2`と`3.2.0`の違いも受け付けた
- 応答: 脆弱性の多い版でも約300KB・1秒程度(jackson-databind 2.9.8で59件・313KB)。推奨先は脆弱性が少ないため小さい。`next_page_token`(続きのページ)は今回の照会では出なかった
- **試作での検証**(既存のビルド済みモジュールと実APIで、下記のアルゴリズムを実装して実行): 4構成・23パッケージで照会24回。cryptography 3.2は49.0.0(2件該当)→50.0.0(0件)に変わり、他の22件は推奨が変わらず照会1回(推奨先の既知の脆弱性0件)

### アルゴリズム

パッケージごとに、現行の推奨(スキャンした脆弱性の範囲外と確認できた候補)を起点にする。

1. 推奨先をOSVに照会する
2. 該当する脆弱性がなければ確定(`candidate_check: "clean"`)
3. 該当する脆弱性があれば、
   - スキャンで既に知っている脆弱性(IDまたは別名が一致)なのに該当と返った場合は、手元の範囲情報とOSVの判定が食い違っている。安全側に倒し、その候補を除外する
   - 新しい脆弱性は修正対象に加え(影響範囲と修正版を取り込む)、修正版を候補に加える(例: 50.0.0)
4. 候補を選び直して1へ。選び直しは現行と同じ順位(正式版 → Tier → 版 → ビルドメタデータ)で、修正対象(スキャンした脆弱性+照会で見つかった脆弱性)の範囲外と確認できるもの
5. 選び直せる候補がない(新しい脆弱性に修正版がない等)、または照会の上限に達した場合は、最後に照会した推奨を返し、該当する脆弱性のIDを示す(`candidate_check: "has_known_vulnerabilities"`)

照会は推奨を出したパッケージだけに行う(推奨保留・未対応・`unparseable_version`は照会しない)。

### 上限と失敗時の扱い(2026-10-08 推奨案で確定)

- 1パッケージあたり照会4回まで、1回のツール呼び出しで合計60回まで、同時4件まで。1回の照会は15秒・4MiBまで(`explain_vulnerability`と同じ)。続きのページがあれば5ページまでたどり、超えたら失敗扱い
- **照会に失敗しても推奨は出す**(スキャンした脆弱性に対する検証は済んでいるため)。`candidate_check: "failed"`と注記で「推奨先の既知の脆弱性は確認できていない」と示す。上限で照会しなかったものは`"skipped"`
- 照会の失敗でツール全体をエラーにしない

### 送信内容と設定(2026-10-08 推奨案で確定)

- 送信先はapi.osv.devだけ(スキャンと同じ)。送るのは、スキャンで既に照会したパッケージの名前と、推奨候補の版(公開されている修正版)。社内パッケージの名前を新たに送ることはない(osv-scannerがスキャン時に全パッケージの名前と版を照会済み)
- 既定で有効にし、`OSV_MCP_NO_CANDIDATE_CHECK=1`で無効化できるようにする(照会の時間を省きたい場合)。無効時は`candidate_check: "disabled"`

### 出力(suggest_fix)

- `candidate_check`: `clean` / `has_known_vulnerabilities` / `failed` / `skipped` / `disabled`(推奨がない場合は出さない)
- `recommended_known_vulnerabilities`: 推奨先に該当する脆弱性のID(`has_known_vulnerabilities`の場合だけ)
- 照会で推奨が変わった場合は`upgrade_note`に理由を加える(例:「49.0.0は2件の既知の脆弱性に該当するため、50.0.0を推奨」)。`upgrade_tier`・`per_cve_detail`は最終的な推奨に対するもの。照会で見つかった脆弱性は`per_cve_detail`に加えない(現在の版の脆弱性ではないため)が、件数と最初に推奨しかけた版を注記に残す
- 照会で得た外部由来のテキスト(IDのみ出力)は`sanitizeExternalText`を通す

### 実装

- `src/osv/osvApi.ts`に`queryOsvPackageVersion(ecosystem, name, version, options)`を追加(`fetchOsvRecord`と同じくfetchの差し替え・タイムアウト・応答サイズ上限・`readResponseBytes`)
- `src/osv/suggestFix.ts`の候補選定を「修正対象の一覧を受け取って候補を返す」関数に切り出し、照会の繰り返しから再利用する(現行の推奨はこの関数の1回目の結果と一致させる)
- 照会は`handleSuggestFix`(ツール層)で行い、`suggestUpgradeForPackage`は同期・純粋なまま残す(テスト容易性)
- テスト: fetchを差し替えた単体テスト(新しい脆弱性→修正版への切り替え、既知の脆弱性の食い違い、修正版のない新しい脆弱性、失敗・タイムアウト・上限・ページ、無効化)と、実APIでのMCP経由の確認(cryptography 3.2→50.0.0、他の推奨は不変)

## pom.xmlの直接/推移的依存の区別 詳細設計メモ(2026-10-08)

v0.7.0では、親POM・BOM・プロファイル・プロパティの解釈を自前で行うと osv-scanner の解釈とずれる(v0.4.0の親POMの境界の迂回と同じ型の問題)ため、pom.xmlを`unknown`にしていた。

### 実データの確認(2026-10-08、osv-scanner v2.4.0、`--data-source deps.dev`)

親POM(`<dependencies>`と`<dependencyManagement>`)、プロパティ参照のgroupId、testスコープ、optional、`activeByDefault`のプロファイル、版を書かず依存管理から版を得る依存を含むpom.xmlを`--all-packages`でスキャンした。

- **osv-scannerは同じpom.xmlを2つの`results[]`に分けて報告し、`source.type`で区別できる**
  - `type: "lockfile"`: pom.xml(と親POM)に**宣言された依存**。親POMの`<dependencies>`(commons-collections)、プロパティを展開したgroupId(log4j-core)、testスコープ(`dependency_groups: ["test"]`)、optional、`activeByDefault`のプロファイルの依存(commons-text。版は親の`<dependencyManagement>`から)を含む。`<dependencyManagement>`にあるだけの依存は含まない
  - `type: "unknown"`: deps.devで解決された**推移的依存**(jackson-annotations、commons-lang3、log4j-api)
- 宣言もされ、推移的にも要求される依存(jackson-core)は`"lockfile"`の側だけに現れる(重複しない)
- `--no-resolve`では`"lockfile"`の側だけになる(宣言された依存だけをスキャンするため正しい)
- requirements.txtも同じ形(書いた`requests`が`"lockfile"`、deps.devで解決された`certifi`・`chardet`・`idna`・`urllib3`が`"unknown"`)。v0.7.0の自前の判定(コピーに書いた行)と一致する
- osv-scannerの出力には、推移的依存を要求している直接依存(依存グラフ)も、宣言した場所(子か親POMか)も含まれない

### 方針(2026-10-08 推奨案で確定)

**osv-scannerの`source.type`で判定する**(pom.xmlを自前では解析しない)。

- 直接依存の範囲が osv-scanner の解釈(親POM・プロファイル・プロパティ・依存管理)と常に一致する。自前で解釈すると、v0.4.0の親POMの件と同じく解釈のずれが判定の誤りになる
- 文書化された仕様ではないため、osv-scannerのピン留めを更新するときに再確認する(B5の監査と同じ扱い。`binaryDownloader.ts`の注記に追記)。想定外の形(pom.xmlの結果に`"lockfile"`・`"unknown"`以外の`type`がある等)のときは`unknown`にする(誤って直接依存と言わない)
- 代替案(採らない): pom.xmlの`<dependencies>`を自前で解析する。親POMの連鎖・プロファイルの有効化条件・プロパティ展開・BOMを osv-scanner と同じに再現する必要があり、ずれの余地が大きい

### 判定の規則

- pom.xmlのスキャン元(スナップショットのコピー)について、`type: "lockfile"`の結果に現れたパッケージは`direct`、`type: "unknown"`の結果だけに現れたパッケージは`transitive`
- 同じpom.xmlの両方に現れた場合は`direct`(実データでは重複しないが、防御的に)
- それ以外の`type`、`type`がない場合は`unknown`
- requirements.txtはv0.7.0の自前の判定のまま(実データで`source.type`と一致することを確認済み。判定の根拠を増やさない)
- gradle.lockfileは解決済みの全依存の一覧で直接/推移的の情報がないため`unknown`のまま

### 対応付け

- `parseOsvScanOutput`がパッケージごとに保持するスキャン元(`packageSources`、応答には出さない)を、パスだけでなく`source.type`も持つ形にする
- 関係の判定(`RelationLookup`)にスキャン元の`type`を渡し、pom.xmlの判定はそれだけで行う(ファイルは読まない)

### 出力とupdate_hint

- `dependency_relation`をMavenのパッケージ(pom.xml由来)にも付ける。`introduced_by`・`declared_in`は付けない(osv-scannerの出力から分からない)
- `update_hint`(Maven、suggest_fix):
  - 直接依存: pom.xmlの`<dependency>`の版を更新する。版を親POMの`<dependencyManagement>`・プロパティ・BOMで管理している場合は、そちらを更新する
  - 推移的依存: `<dependencyManagement>`で版を指定して上書きする(Mavenの依存の調停で優先される)か、それを要求している直接依存を更新する
  - `unknown`(gradle.lockfile等): 現行の一般的な案内
- 現行のMavenの`update_hint`は無い(npm・Go・PyPIだけ)。Mavenにも付ける

### 完了条件とテスト

- 単体: `source.type`ごとの判定、両方に現れる場合、想定外の`type`、requirements.txt・package-lock.json等の既存の判定が変わらないこと
- 実バイナリ(MCP経由): 上記の構成で、jackson-databind・jackson-core・commons-collections・commons-text・log4j-core・snakeyamlが`direct`、jackson-annotations・commons-lang3・log4j-apiが`transitive`。`--no-resolve`でも宣言された依存が`direct`
- `scan_java_project`の応答は変えない(v0.7.0と同じく`scan_project`・`suggest_fix`だけ)

**実装済み(2026-10-08)**: `parseOsvScanOutput`がスキャン元を`{path, type}`で保持し(応答には出さない)、`pomRelations`が`source.type`で判定。同じファイルの複数の結果は、ファイルごとに直接依存を優先して1つにまとめる(要らない`mixed`を出さない)。Mavenの`update_hint`を追加(`unknown`では付けない)。`binaryDownloader.ts`のピン留めの注記に再確認の対象として追記。実バイナリでMCP経由の確認: 上記の構成で期待値どおり(解決あり・なし)。npm・Go・PyPIとMavenの推奨はv0.8.0と出力のハッシュが一致(5構成)、`scan_java_project`の応答は不変

## B3 詳細設計メモ(2026-10-08)

B3は2項目: (1) JAR/WAR実体スキャン(`scan_java_artifact`)の実物での検証、(2) サーバープロセスの権限の最小化。

### (1) 実物のfat JAR・shaded JAR・WARでの検証

#### 目的

これまでの検証は合成JAR(pom.propertiesを手で入れたもの)だけ。実物の成果物で次を確かめる。

- 同定率: 同梱されたライブラリのうち、osv-scannerが名前と版を復元できる割合(BOOT-INF/lib・WEB-INF/libのネストJARと、shadedで再配置された依存)
- 既知の脆弱性の検出: 古い版の成果物で、同梱ライブラリの既知の脆弱性が実際に検出されるか(陽性対照)
- 応答の正しさ: `coverage`(`jars_found`・`jars_identified`・`unidentified_jars`)と`completeness: "incomplete"`が実態と食い違わないか。特にfat JARの中の同定できないネストJARは、外側のアーカイブ単位の`coverage`には現れない(現行設計の限界)ため、その量を測る
- 性能: 100MB級のfat JARでの所要時間・スナップショットへのコピー(合計2GiBの上限)・出力サイズの上限に収まるか

#### 検証対象(2026-10-08 ダウンロードの許可を得た)

公開リポジトリの成果物をスクラッチ領域にダウンロードし、**実行はせず**スキャンだけ行う。取得後に公開されているチェックサム(Maven Centralの`.sha1`、Jenkinsの`.sha256`)と照合する。

| 種類 | 成果物 | サイズ | 取得元 |
|---|---|---|---|
| Spring Boot fat JAR(新) | io.zipkin:zipkin-server:3.6.1 `-exec.jar` | 135.3MB | Maven Central |
| Spring Boot fat JAR(旧、陽性対照) | io.zipkin:zipkin-server:2.23.2 `-exec.jar`(2021年) | 62.0MB | Maven Central |
| WAR(新) | jenkins.war 2.580.1(最新LTS) | 54.0MB | get.jenkins.io(ミラーへリダイレクト) |
| WAR(旧、陽性対照) | jenkins.war 2.303.3(2021年のLTS) | 72.3MB | get.jenkins.io |
| shaded(依存を再配置) | io.grpc:grpc-netty-shaded:1.84.1 | 10.9MB | Maven Central |
| shaded(旧、陽性対照) | io.grpc:grpc-netty-shaded:1.30.0(2020年、旧nettyを同梱) | 7.1MB | Maven Central |
| shaded | org.apache.calcite.avatica:avatica:1.29.0 | 8.0MB | Maven Central |
| shaded(大規模) | org.apache.hadoop:hadoop-client-runtime:3.5.0 | 30.1MB | Maven Central |

合計約380MB。

#### 正解データの作り方

- ネストJARの一覧: Python標準の`zipfile`で、外側のアーカイブの`BOOT-INF/lib/*.jar`・`WEB-INF/lib/*.jar`と、それぞれの`META-INF/maven/*/*/pom.properties`の有無を列挙する(検証用のスクリプトだけで使い、サーバーにzip解析は入れない)
- shaded JAR: 外側の`META-INF/maven/*/*/pom.properties`の一覧(残っている依存のメタデータ)と、再配置されたパッケージ(例: `io/grpc/netty/shaded/io/netty/`)の有無を比べ、メタデータの残っていない同梱依存を数える
- 陽性対照: 旧版の同梱ライブラリの版をOSV APIで照会し、既知の脆弱性がある同梱ライブラリの一覧を作って、スキャン結果と突き合わせる

#### 結果に応じた対応(検証後に判断)

- 同定できないネストJARが多い場合: 応答に外側のアーカイブごとの「ネストJARの数・同定できた数」を出す案を検討する。ただしNode側でzipを解析することになり攻撃面が増える(現行設計はzip展開をosv-scannerに任せている)ため、上限付きの中央ディレクトリの読み取りだけにする等、別途設計する
- shadedで再配置された依存が同定できない場合: 既知の限界としてREADMEに具体例付きで明記する(SHA1→GAVのDBは採用しない方針のまま)
- 性能・上限の問題があれば修正する

#### 検証結果(2026-10-08、osv-scanner v2.4.0、8成果物はチェックサム照合済み)

| 成果物 | ネストJAR(pom.propertiesなし) | osv-scannerの報告 | うちpom.properties由来 / それ以外から推測 | 応答 |
|---|---|---|---|---|
| zipkin-server 3.6.1 exec | 157(63) | 150件 | 85 / 65 | 19パッケージ・86件、3.5秒 |
| zipkin-server 2.23.2 exec | 111(53) | 112件 | 58 / 54 | 19パッケージ・111件、2.8秒 |
| jenkins.war 2.580.1 | 78(21) | 118件 | 70 / 48 | 1パッケージ・1件、1.9秒 |
| jenkins.war 2.303.3 | 107(32) | 198件 | 98 / 100 | 31パッケージ・119件、3.6秒 |
| grpc-netty-shaded 1.30.0 | -(外側にnettyのpom.properties 14件) | 14件 | 14 / 0 | 7パッケージ・48件 |
| grpc-netty-shaded 1.84.1 | -(pom.propertiesなし) | 1件 | 0 / 1(`jar:grpc-netty-shaded`) | 0件 |
| avatica 1.29.0 | -(pom.propertiesなし、protobuf・jackson等を再配置) | 1件 | 0 / 1(`avatica:avatica`) | 0件 |
| hadoop-client-runtime 3.5.0 | -(外側にpom.properties 68件) | 68件 | 68 / 0 | 7パッケージ・24件 |

- **pom.propertiesがあれば取りこぼしはない**(全成果物で、pom.propertiesのGAVはすべて検出)。shadedでもメタデータを残していれば(grpc-netty-shaded 1.30.0、hadoop-client-runtime)同梱依存を同定できる
- **重大な発見: pom.propertiesのないJARは、osv-scannerがファイル名等からMaven座標を推測し、groupIdを誤る**。例: `spring-beans:spring-beans@5.3.2`(正しくは`org.springframework:spring-beans`)、`armeria:armeria`(`com.linecorp.armeria`)、`bcprov:bcprov-jdk15on`(`org.bouncycastle`)、`jar:grpc-netty-shaded`、`avatica:avatica`、`all:opentelemetry-api`。誤った座標はOSVで照会しても0件になり、**既知の脆弱性を黙って取りこぼす**。実例: zipkin-server 2.23.2のspring-beans 5.3.2はSpring4Shell(CVE-2022-22965)を含む2件に該当するが検出されない。bcprov-jdk15on 1.68(5件)、armeria 1.3.0(1件)も同様。Spring Frameworkの本体JAR(Gradleでビルドされpom.propertiesを含まない)はこの形で一律に取りこぼす
- **現行の`coverage`はこれを「同定済み」と数える**: grpc-netty-shaded 1.84.1・avaticaは推測の座標1件だけで`identified_without_known_vulnerabilities`になり、「同定でき、既知の脆弱性なし」と誤読させる。fat JAR・WARでもネストJARの単位の状況は応答に現れない
- **応答の肥大**: 応答の93%が`affected_versions`(suggest_fixの推奨の検証に使う内部の影響範囲データ。READMEに記載なし)。jenkins.war 2.303.3で555KB中517KB。全スキャンツールの応答に含まれ、LLMの文脈を大きく消費する
- 性能: 135MBのfat JARでも3.5秒。スナップショットのコピー・出力の上限には余裕がある

#### 対応方針(2026-10-08 推奨案で確定。権限の最小化と合わせてv0.10.0)


1. **`affected_versions`を応答から外す**(全スキャンツール)。内部では保持し(パッケージのスキャン元と同じくWeakMap等)、suggest_fixの検証は従来どおり行う。応答は数分の一になる
2. **推測された座標を区別する**: osv-scannerの出力には座標の出所(pom.propertiesか推測か)がない。Node側でzipを解析しない方針は維持し、座標の形で判定する: groupIdに`.`がなく、artifactIdと同じかartifactIdの接頭辞であるもの(`spring-beans:spring-beans`、`armeria:armeria-brave`、`jar:…`)を`coordinates_inferred: true`とする。`commons-io:commons-io`・`junit:junit`のような古い形式の正しい座標も含まれる(安全側の誤検知)
   - `scan_java_artifact`の`coverage`に`inferred_coordinates`(件数と一覧、上限付き)と警告(「groupIdを推測した可能性があり、既知の脆弱性を照合できていない可能性がある。ビルド元のlockfile/pom.xmlのスキャンを推奨」)を追加
   - アーカイブの状態: 推測の座標だけで同定したもの(grpc-netty-shaded 1.84.1、avatica)は`identified_without_known_vulnerabilities`ではなく、新しい状態`inferred_only`にし、`jars_identified`に数えない
   - 座標の補正(Maven Centralやdeps.devでの正しいgroupIdの照会)は、送信先・送信内容が増えるため行わない
3. **READMEに実例付きで限界を明記**: Spring Frameworkの本体JARなどpom.propertiesを含まないJARは、groupIdの推測により脆弱性を取りこぼしうる。正確な結果にはビルド元のlockfile/pom.xmlのスキャン(`scan_project`)を使う

### (2) 権限の最小化

#### 実機確認(2026-10-08、Node 24.18、macOS)

Nodeの権限モデル(`--permission`)でサーバーを起動し、スナップショット方式のスキャンが動くか確認した。

- `--allow-fs-read`(サーバー本体のディレクトリ・スキャン対象・一時ディレクトリ)、`--allow-fs-write`(一時ディレクトリ)、`--allow-child-process`で、検出→スナップショット→スキャン→削除まで動作した
- **一時ディレクトリはsymlinkの解決前・解決後の両方の読み取り許可が必要**(macOSの`/var/folders/...`は`/private/var/folders/...`へのsymlink。`ScanSnapshot.create`の`realpath(os.tmpdir())`が解決前のパスを読む)。片方だけでは`ERR_ACCESS_DENIED`で失敗し、ツールの応答は`internal_error`になる
- 許可外のパスを指定すると、権限モデルの拒否が`project_not_found`(「指定されたパスが存在しません」)と表示される(原因が分かりにくい)
- **`--allow-child-process`が必須で、子プロセスのosv-scannerは権限モデルの制限を受けない**(Node自身もこのフラグは権限モデルを無効にしうると警告する)。osv-scannerには検証済みのコピーだけを渡しているため実害は限定的だが、多層防御としては不完全
- バイナリの自動ダウンロードを使う場合は、キャッシュディレクトリ(`$XDG_CACHE_HOME/osv-scanner-mcp`、既定は`~/.cache/osv-scanner-mcp`)への書き込み許可も必要

#### 方針(2026-10-08 推奨案で確定)

**任意の多層防御として文書化し、権限モデル下で正しく動くようにする**。既定の起動方法は変えない。

- READMEに「権限を絞って起動する」節を追加し、MCPクライアントの設定例(`node --permission --allow-fs-read=... ...`)と、子プロセス(osv-scanner)は制限を受けないことを明記する。OSレベルの隔離(コンテナ、macOSのsandbox-exec等)はさらに強いが、環境依存のため例示にとどめる
- コード側の対応:
  - 権限モデルの拒否(`ERR_ACCESS_DENIED`)を`project_not_found`ではなく専用のエラー(例: `permission_denied`、「Nodeの権限モデルで読み取りが許可されていません」)にする
  - 一時ディレクトリの解決で、解決前のパスの読み取りが拒否された場合の案内(エラーメッセージで両方の許可が必要と示す)
  - 起動時に権限モデルが有効かを`process.permission`で検出し、スキャン対象(`OSV_MCP_ALLOWED_ROOT`)・一時ディレクトリ・キャッシュの読み書きが許可されていなければ、stderrに警告する(fail-closedの起動拒否にはしない)
- テスト: 権限モデル下でサーバーを起動するE2Eテスト(許可内のスキャンが成功、許可外が`permission_denied`)

#### 採らない案

- 既定で権限モデルを有効にする(`npx`での起動ではNodeのフラグを渡せず、クライアント設定の互換性が崩れる)
- osv-scannerをサンドボックスで包む(OSごとの仕組みが必要で保守できない)

### 段階計画(案)

1. (1)の検証(ダウンロードの許可を得てから)。結果をこのメモに記録し、対応が必要なら別途設計
2. (2)のコード対応とREADME(v0.10.0候補)

## Rust(crates.io)対応 詳細設計メモ(2026-10-11)

`scan_project`・`suggest_fix`の対象にRust(`Cargo.lock`)を加える。既存の方針(lockfile方式・検出したファイルだけを個別に渡す・スナップショットのコピーをスキャン・ビルドツールを実行しない)を前提とする。

### 非目標

- `cargo`の実行(`cargo generate-lockfile` / `cargo metadata` / `cargo audit`等)。レジストリ・gitの取得や`.cargo/config.toml`の設定を伴う。lockfileの生成は利用者が信頼できる環境で行う
- Rustバイナリ(cargo-auditable)のスキャン、関数単位の到達性の解析(`affects.functions`の活用)
- crates.ioのAPI照会(yanked版の確認等)。通信先を増やさない

### 実機確認結果(2026-10-11、osv-scanner v2.4.0・api.osv.dev)

手書きの最小フィクスチャ(workspace・pathの依存・gitの依存・別レジストリ・同名の複数版)で確認:

- `--lockfile Cargo.lock:<パス>`で読める。エコシステムは`crates.io`、`source.type`は`lockfile`、`dependency_groups`は出ない。lockfileの形式はv1(`[metadata]`のchecksum・`"名前 版 (source)"`形式の依存)・v3・v4のいずれも読める。`[[patch.unused]]`は無視される。`sparse+https://index.crates.io/`も通常どおり
- `Cargo.toml`は解析形式として指定できない(exit 127「could not determine extractor」)。`Cargo.toml`だけのディレクトリはスキャンできない
- **sourceを見ずに全パッケージをcrates.ioとして照会する**: workspaceのメンバー・pathの依存(`source`なし)、gitの依存(`git+...`)、別レジストリの依存(`registry+https://my-company.example/index`)も`crates.io`として照会され、同名・同版のcrates.ioのアドバイザリが付く。ローカルのcrateを`failure 0.1.8`、gitのforkを`smallvec 1.6.0`、別レジストリのcrateを`atty 0.2.14`にすると、いずれもcrates.ioの脆弱性が報告された(誤検知)。あわせて**社内crateの名前がapi.osv.devへ送られる**。cargo-auditはcrates.io由来のパッケージだけを照合するため挙動が異なる
- OSVのレコード(代表的な50 crateの360件): 範囲の型は`SEMVER`のみ(`GIT`・`ECOSYSTEM`なし)。IDは`RUSTSEC-*`と`GHSA-*`。`introduced: "0.13.0-0"`のようにプレリリースの最小値を下限にする記法が多い。`fixed`のない範囲が15件、`last_affected`が4件、`versions[]`の列挙が20件。ビルドメタデータ付きの版(`openssl-src`の`111.25.0+1.1.1t`等)はこの範囲の境界には現れなかった
- **RustSecの情報提供アドバイザリ**: `affected[].database_specific.informational`が`unmaintained`(保守終了)・`unsound`(健全性の欠陥)・`notice`のレコードがある(上記360件中で`unsound` 21件、`unmaintained` 7件)。osv-scannerの出力にもそのまま含まれ、通常の脆弱性と区別されない。多くは`introduced: "0.0.0-0"`だけで修正版がない(例: `atty`のRUSTSEC-2024-0375)。一方、GHSAが同じ欠陥を脆弱性として登録していると同じグループにまとまる(`failure`: unsoundのRUSTSEC-2019-0036・unmaintainedのRUSTSEC-2020-0036・GHSA 2件が1グループでCVSS 9.8)。cargo-auditは情報提供を既定で警告として別扱いにする

### 中核の設計判断1: スキャンするのはcrates.io由来のパッケージだけ(コピーを生成する)

requirements.txtと同じく、元の`Cargo.lock`はosv-scannerに渡さず、**本サーバーが解析した結果からcrates.io由来のパッケージだけを書いたコピー**をスキャンする。

- 対象: `source`が`registry+https://github.com/rust-lang/crates.io-index`または`sparse+https://index.crates.io/`のパッケージ
- `[replace]`で置換されたパッケージ(`replace = "名前 版 (source)"`を持つもの)は使われないためスキャンしない。置換先は別の`[[package]]`として記載され、そのsourceで分類する(cargo 1.98で確認: pathへの置換は`replace = "anyhow 1.0.102"`とsourceなしの置換先)。置換先を解釈できない・記載が無い場合はファイル全体を除外する(レビュー指摘、2026-10-11: `replace`をchecksumと同様に読み飛ばすと、置換元のcrates.ioのcrateが残り、使っていない版の脆弱性を報告する)
- `source`なし(workspaceのメンバー・pathの依存): 利用者自身のコードとしてスキャンしない。coverageには数だけ示す(`local_crates`)。完全性(`complete`)には影響させない
- `local_crates`・`unscannable_crates`は、Cargo.lockをスキャンした場合だけcoverageに付ける(従来の応答を変えない)
- gitの依存・別レジストリの依存: スキャンしない。第三者のコードが未検査なので、`coverage.unscannable_crates[]`に名前・版・理由(git: 版がcrates.ioのリリースと対応しない / 別レジストリ: crates.ioと同名でも別物で、名前を外部に送らない)を記録し、`complete: false`にする。sourceのURLは応答に出さない(認証情報やホスト名を含み得る)
- コピーの形式: `version = 3`と、各パッケージの`name`・`version`・`source`だけの`[[package]]`。osv-scannerが読む内容は常に本サーバーが生成したものになる(解析の食い違いによる取りこぼし・境界外の読み込みが起きない)
- 解析器(`src/utils/cargoLock.ts`): cargoが生成する範囲のTOMLだけを受け付ける厳格な行解析(TOMLの汎用パーサーは追加しない)。受け付ける行: コメント・空行、先頭の`version = 整数`、`[[package]]`、`[[patch.unused]]`(読み飛ばす)、`[metadata]`(v1。読み飛ばす)、`キー = "文字列"`、`dependencies = [`〜`]`の各行の`"..."`。文字列のエスケープは`\"` `\\` `\uXXXX`程度。**想定外の行が1つでもあればファイル全体をスキャン対象から外し**、`skipped_files`に理由を記録する(部分的に読んで取りこぼしを隠さない)。サイズ・パッケージ数の上限は既存の読み込みの上限を共用
- 同じパッケージの重複(name・version・sourceが同じ)はコピーで1つにまとめる

### 中核の設計判断2: 情報提供アドバイザリを脆弱性と区別して示す

保守終了・健全性の欠陥を「脆弱性」として件数に含めると、LLMが重大度を誤って要約する。一方で隠すと保守終了のcrateを見落とす。

- 判定: グループに関連する**すべてのID**(グループの`ids`・`aliases`と、各レコードの`aliases`)について詳細のレコードがあり、そのすべてが、そのパッケージの`affected[]`のすべてに`database_specific.informational`(既知の種類)を持つ場合だけ、そのグループを情報提供とする。GHSA等が脆弱性として登録していれば(1件でも`informational`なし)従来どおり脆弱性(上の`failure`は脆弱性のまま)。**詳細の欠けたID・未知の種類があれば分類を確かめられないため脆弱性として扱う**(レビュー指摘、2026-10-11: 「取得できたレコードのすべて」では、RustSecの情報提供レコードだけ詳細があり、aliasesにだけ現れるGHSAの詳細が欠けた場合に脆弱性から外してしまう)。実データ(情報提供のレコード36件)では10件がGHSA・CVEのaliasesを持ち、通常はGHSAも`ids`に詳細付きで含まれる
- 出力: 該当グループの`ScanReportVulnerability`に`informational: "unmaintained" | "unsound" | "notice"`(複数の種類なら`unsound` > `unmaintained` > `notice`の順で1つ)を付ける。`packages[]`には残す
- 件数: 情報提供のグループは`vulnerability_count`・`severity_breakdown`・`vulnerable_package_count`に数えず、`informational_count`(新設)に数える。実装時の判断: `informational_count`は1件以上の場合だけ付ける(scan_java_project等は報告をそのまま展開するため、常に付けると従来の応答が変わる)。scan_project・scan_sbom・`ecosystem_breakdown`も同じ。suggest_fixの`vulnerable_package_count`も情報提供だけのパッケージを数えない情報提供だけのパッケージも`packages[]`に含め、並び順は脆弱性のあるパッケージの後ろ
- 既存のエコシステムへの影響: `informational`はRustSec由来のレコードだけが持つため、Maven・npm・PyPI・Goの応答は変わらない(回帰テストで確認)

### 検出(`manifestDetector.ts`)

- `Cargo.lock` → エコシステム`crates.io`。解析形式`Cargo.lock`を`MANIFEST_FORMATS`に追加(osv-scannerにはコピーだけを渡す)
- `Cargo.toml`(lockfileなし) → `lockfile_missing`。案内は「信頼できる環境で`cargo generate-lockfile`を実行してから再スキャン(依存の取得を伴う)」。ライブラリのcrateはCargo.lockをコミットしない慣習が長かったため、ここに記録されるケースが多い旨をREADMEに書く
- workspace: メンバーの`Cargo.toml`はサブディレクトリにあり、`Cargo.lock`はworkspaceのルートにだけある。上位の`Cargo.lock`に、メンバーの`[package] name`と同名の`source`なしパッケージがあり、**かつ`Cargo.lock`と同じディレクトリの`Cargo.toml`の`[workspace]`の`members`・`exclude`で所属を確認できた場合だけ**充足とする(レビュー指摘、2026-10-11: 名前だけでは、ルートの`app@0.1.0`と独立したサブプロジェクトの`app@0.2.0`を区別できず、サブ側の欠落を隠す)。所属の規則はcargo 1.98で確認: `members`はglob(`*`・`?`のみ対応。`**`・`[...]`等は判定できない)で展開し、`exclude`はパスの前方一致で除くが、`members`に文字どおり書かれたパスの配下は`exclude`より優先する。Cargo.tomlは文字列・配列の外で始まる行だけを見出し・キーとして読む(レビュー指摘、2026-10-11: 行ごとに判定すると、`description = """`の複数行文字列の中の`[workspace]` / `members = ["sub"]`を本物の設定と誤認し、独立した`sub`の欠落を再び見逃す。`[package] name`の読み取りも同様)。閉じない文字列・括弧の不整合、読み落としの可能性がある書き方(引用符付きのキー、ルートのテーブルの`workspace.`のドット付きのキー、配列内の複数行文字列)は解釈できないものとしてnull。同名があっても所属を確認できなければ`unconfirmed`(workspace外のpathの依存は収録されているが、同名の独立crateと区別できないため。ルートに`[workspace]`の無いプロジェクトのpathの依存も`unconfirmed`になり`complete: false`になる。依存元のCargo.tomlの`path = "..."`との照合は今後の改善)。同名のパッケージが無ければ`status: "missing"`(workspaceのメンバーでもpathの依存でもないため、そのcrateは別のlockfileを使う)。`name`は`[package]`テーブルの`name = "..."`だけを行解析で読み、読めなければ(virtual manifest・`name.workspace`等)`status: "unconfirmed"`
- 除外ディレクトリ: `target`は既存。`.cargo`(レジストリのキャッシュ等)を追加。`vendor`は既存(`cargo vendor`の出力を含む)

### 直接/推移的依存の区別(Cargo.lockから)

- `source`なしのパッケージ(workspaceのメンバー・pathの依存)を起点とし、その`dependencies`にあるパッケージを**直接**、それ以外の到達できるパッケージを**推移的**とする。推移的依存には、起点からたどって最初に通る直接依存を`introduced_by`(最大10件、npmと同じ)に付ける
- `dependencies`の要素は`"名前"`・`"名前 版"`・`"名前 版 (source)"`の3形式。名前だけで複数版がある等で一意に決まらなければ、そのパッケージは`unknown`
- Cargo.lockには開発用・ビルド用・対象OS限定の依存の区別がない(`[dev-dependencies]`・`[build-dependencies]`・`[target.'cfg(windows)'.dependencies]`もすべて含まれる)。直接/推移的の区別だけを示し、本番で使われるかは判定しない旨をREADMEに書く
- gitの依存の配下にあるcrates.ioの依存も推移的として扱う(`introduced_by`はgitのcrate名)

### suggest_fix

- バージョン比較: `crates.io`をSemVerのエコシステムに加える(`versionScheme.ts`)。Cargoのキャレット(`^`、既定の要求)はnpmと同じ規則(1.0以上はメジャーが同じなら互換、0.xはマイナーまで、0.0.xは完全一致)のため、`classifyCaret`をそのまま使う。すなわち正式版の推奨で`cross_major`でなければ、Cargo.tomlの既定の要求の範囲内で更新できる(プレリリースの推奨は例外。下記`update_hint`)
- 情報提供のグループは修正版の推奨の対象にしない(`unmaintained`は版を上げても解消しない)。`per_cve_detail`に`informational`を付けて残し、`unfixed`の件数に数えない。注記に「保守終了のcrateは代替への移行を検討」を含める
- 推奨先のOSV照会(`candidateCheck.ts`): 候補に該当するレコードのうち、`unmaintained`・`notice`の情報提供はcrate全体の状態で版の選択に関係しないため無視する。`unsound`は版ごとの欠陥のため従来どおり既知の脆弱性として扱う
- `update_hint`(直接/推移的とTierで分ける):
  - 直接・`cross_major`以外: `cargo update -p <name>@<現在の版> --precise <推奨版>`でCargo.lockだけを更新できる(Cargo.tomlの要求が`=`や`~`で固定されていれば要求を変更)
  - 直接・`cross_major`: 依存元のcrate(`source`なしのパッケージ名)のCargo.tomlの要求を変更する
  - 推移的・`cross_major`以外: 同じく`cargo update -p <name>@<現在の版> --precise <推奨版>`(依存元の要求が許す範囲なら、Cargo.tomlを変えずに更新できる)
  - 推移的・`cross_major`: `introduced_by`の直接依存を、推奨版を許す要求の版へ更新する必要がある。`[patch.crates-io]`は要求範囲を強制的に変える仕組みではなく、同じcrateを別のソース(修正を取り込んだforkやバックポート)に差し替える仕組みで、差し替え先の版も依存元の版要求を満たす必要がある(Cargo公式文書「Overriding Dependencies」)。そのため案内は「依存元の要求の範囲内の修正版(バックポート)を`[patch.crates-io]`で使う」場合に限定し、メジャー更新の代替としては示さない(レビュー指摘、2026-10-11)
  - **プレリリースの推奨**(`recommended_is_prerelease`): Cargoの要求(`"1.2"`等の既定のキャレット)は、要求自体にプレリリースを書かない限りプレリリース版に一致しない(Cargo公式文書「Specifying Dependencies」)。`cross_major`でなくても`cargo update --precise`だけでは更新できないことがあるため、直接依存なら要求をプレリリース版に変更し(`"=1.3.0-rc.1"`等)、推移的依存なら依存元の要求がその版を許す必要がある旨を案内する(レビュー指摘、2026-10-11)。上の「`cross_major`でなければ既定の要求の範囲内」は正式版の推奨に限る
  - `<name>@<版>`の指定は、同じcrateの複数版がCargo.lockにある場合に対象を一意にするため

### 段階計画(推奨案)

- **v0.12.0**: `scan_project`のCargo.lock対応(解析器・crates.io由来だけのコピー・`local_crates`/`unscannable_crates`・`lockfile_missing`とworkspaceの確認)と、情報提供アドバイザリの区別(`informational`・`informational_count`)。suggest_fixはcrates.ioを`unsupported_ecosystem`のまま
- **v0.13.0**: suggest_fixのcrates.io対応(SemVer比較・情報提供の扱い・候補照会での除外)と、Cargo.lockからの直接/推移的依存の区別・`update_hint`

### 完了条件とテスト

- 解析器: v1/v3/v4、`[[patch.unused]]`、`[metadata]`、同名の複数版、依存の3形式、エスケープ、想定外の行・壊れた入力でファイル全体を除外、サイズ上限
- 誤検知の回帰テスト: ローカル・git・別レジストリのcrateに同名のcrates.ioの脆弱性がある場合に、報告されず`unscannable_crates`・`local_crates`に示されること(偽スキャナーでコピーの内容を検証し、実バイナリでMCP経由でも確認)
- 情報提供: 情報提供だけのグループ・GHSAと混在するグループ・詳細の欠けたaliases・件数の分離・既存エコシステムの応答の不変(v0.11.0のworktreeとの出力ハッシュの比較)
- v0.13.0の`update_hint`: プレリリースの推奨(要求の変更が必要な旨)、推移的依存の`cross_major`(依存元の更新。`[patch.crates-io]`をメジャー更新の代替として示さない)
- 実バイナリでMCP経由の確認(複数言語の混在を含む)と、接続先がapi.osv.devだけであること

### v0.12.0の実装結果(2026-10-11)

- 実装: `src/utils/cargoLock.ts`(解析・分類・コピーの生成・Cargo.tomlのname)、`manifestDetector.ts`(`CargoLockCache`で解析を1回にし、workspaceの確認とスキャン対象の生成で共用)、`scanProject.ts`(コピーの書き込み・coverage)、`scanReport.ts`(`informational`・`informational_count`・`hasVulnerability`)
- osv-scannerは`--lockfile Cargo.lock:<生成したコピー>`(拡張子`.txt`)でも読むことを実機で確認
- 実バイナリでMCP経由の確認: 誤検知のフィクスチャ(ローカルの`failure`・gitの`smallvec`・別レジストリの`atty`)で、crates.io由来の`time`だけが報告され、3件は`local_crates`・`unscannable_crates`に出た。workspaceのフィクスチャで`atty`のunmaintainedが情報提供になり、GHSAと混在するunsoundは脆弱性のまま。Cargo.lockだけのスキャンの接続先はapi.osv.devだけ(CONNECTプロキシで確認)。5エコシステム混在でも件数が分かれる
- 回帰: npm・Go・PyPI・Gradleの混在プロジェクトで、scan_project・suggest_fixの応答がv0.11.0とバイト単位で一致(候補照会は無効にして比較)
- 変異確認: 全crateをスキャン対象にする変更・情報提供の判定を外す変更・aliasesを判定に含めない変更・`[replace]`の置換元を除かない変更・名前だけでworkspaceの所属を判定する変更・Cargo.tomlを行ごとに判定する変更で、それぞれ追加したテストが失敗する
- cargoで生成したlockfile(`--offline`、ダウンロードなし)での確認: `[replace]`でpathに置換した`anyhow`はスキャンされない(osv-scanner単体では置換元をスキャンする)。members・exclude・globのworkspaceで、非メンバーと除外したcrateは`missing`

### 未確認事項

- 実プロジェクト(大きなworkspace、cargo vendor・source置換を使うもの)のCargo.lockでの解析の成否と所要時間。生成済みのCargo.lockの取得はダウンロードを伴うため、実施時に許可を得る
- `cargo update --precise`の実機確認(レジストリの取得を伴う)
- osv-scannerの将来の版で、sourceによる絞り込みや`informational`の扱いが変わるか(2.6.0へのピン更新時に再確認)

## suggest_fixのRust対応・Cargo.lockの直接/推移的依存(v0.13.0)詳細設計メモ(2026-10-13)

上の「Rust(crates.io)対応 詳細設計メモ」のv0.13.0部分の詳細。v0.12.0の`Cargo.lock`解析・crates.io由来だけのコピー・`informational`を前提とする。

### 設計中に見つかった公開中の不具合(v0.8.0〜v0.12.0、全エコシステム)

**推奨先のOSV照会が、修正版のない既知の脆弱性を「判定の食い違い」と誤認して推奨を保留する。** `candidateCheck.ts`は、照会で返ったレコードのIDがスキャンで既に知っている脆弱性なら、無条件に「手元の範囲情報とOSVの判定が食い違っている」とみなして候補を除外する。しかし修正版のない脆弱性(`tier: "unfixed"`)は修正対象ではなく、推奨先にも該当するのが正しい(手元の判定も`recommended_status: "affected"`)。そのため、修正できる脆弱性と修正版のない脆弱性を併せ持つパッケージでは、照会を有効にすると(既定)推奨が必ず保留になる。

- 実データでの再現(2026-10-13、v0.12.0): PyPIの`ecdsa==0.13`。照会なし(`OSV_MCP_NO_CANDIDATE_CHECK=1`)では`0.19.2`を推奨(`verified`、PYSEC-2026-1325は`unfixed`で推奨先でも`affected`)。照会ありでは`candidate_check: "conflict"`・`recommended_upgrade: null`になり、注記は「範囲情報が食い違う」と誤った説明をする
- 単体でも再現: 修正版あり(`0`〜`1.5.0`)と修正版なし(`0`〜)の2件を持つnpmパッケージで、照会が修正版なしの脆弱性を返すと`conflict`
- Rustでは、全版に該当する`unmaintained`(例: `atty`のRUSTSEC-2024-0375)が同じ形になるため、v0.13.0の前提としても修正が要る

**修正(v0.12.1として先に出すことを推奨)**: 既知のIDのレコードは、その脆弱性が**修正対象**(`tier`が`unfixed`以外。推奨は全修正対象の範囲外と確認済み)の場合だけ食い違いとして扱う。修正対象でない既知の脆弱性(`unfixed`。v0.13.0では情報提供も)のレコードは、手元の判定と矛盾しないため無視する(修正対象にも加えない)。推奨先に該当することは`per_cve_detail[].recommended_status`で既に示している。`candidate_check: "clean"`の意味は「スキャンで示した脆弱性のほかに、推奨先に該当する既知の脆弱性はない」と明記する(README・ツールの説明)。

**v0.12.1の実装結果(2026-10-13)**: `candidateCheck.ts`で、`unfixed`の脆弱性のIDと別名だけに一致するレコードを照会結果から除く(別名が修正対象の脆弱性とも重なる場合は修正対象を優先し、従来どおり食い違いとして扱う。照会で新しく見つかった脆弱性は除かない)。回帰テスト4件(主ID・別名、新しい脆弱性との混在、修正対象と重なる別名、ecdsaの形)は修正を外すと失敗する。実データでMCP経由: `ecdsa==0.13`は`0.19.2`(`clean`・`verified`、PYSEC-2026-1325は`affected`)。npm・Go・PyPI・Gradleの16パッケージで照会ありの応答をv0.12.0と比較し、変わったのは`ecdsa`だけ

### 実データの確認(2026-10-13、api.osv.dev・cargo 1.98)

**推奨の成否**: 既知の脆弱性を持つ実在の38パッケージ(44 crateから)の`Cargo.lock`で、`versionScheme`だけcrates.ioを有効にした一時ビルド(照会なし)を実行:

- 33件が`verified`。`same_minor`(`smallvec 1.6.0→1.6.1`、`openssl 0.10.30→0.10.79`等)、`major_internal`(`tokio 1.8.0→1.38.2`)、`cross_major`(`time 0.1.43→0.2.23`、`idna 0.2.3→1.0.0`等)
- 4件(`failure`・`atty`・`ansi_term`・`yaml-rust`)は修正版のない情報提供・unsoundだけ → 下記の情報提供の扱いで整理する
- `rustls 0.20.0`は`no_verified_candidate`: GHSA-6g7w-8wpp-frhjの`affected[]`に`versions: ["0.20"]`(SemVerでない)だけのエントリがあり、未記載の版が非該当と言えないため保留(既存の安全側の扱いで正しい。データの不備)
- `borsh 0.9.0→1.0.0-alpha.1`(プレリリースの推奨): GHSAが`0`〜`1.0.0-alpha.1`を該当とするため、0.10.4では解消しない。プレリリースの案内(下記)が必要な実例
- ビルドメタデータ: `openssl-src 111.10.0+1.1.1g→111.25.0`、`libgit2-sys 0.12.0+1.1.0→0.16.2`。OSVの修正版はメタデータなしで、実際の版は`111.25.0+1.1.1t`等。cargoでは`--precise 0.7.5`(メタデータなし)も`-p toml_datetime@0.7.5+spec-1.1.0`(あり)も通る(cargo 1.98で確認)ため、推奨版をそのまま案内に使える

**Cargo.lockの依存の記法**(cargo 1.98で生成): 同名のパッケージが1つなら`"名前"`、複数の版があれば`"名前 版"`(`"anstream 0.6.21"`・`"anstream 1.0.0"`)。同名・同版でsourceが異なる場合だけ`"名前 版 (source)"`。v1形式は常に`"名前 版 (source)"`

**`cargo update --precise`**(`--offline`、ダウンロードなし): 
- 直接依存・要求の範囲内(`anyhow = "1.0.102"`で`--precise 1.0.103`): Cargo.lockだけが更新される
- 同名の複数版がある場合、`-p anstyle-parse`は拒否され(`anstyle-parse@0.2.7`等の指定を求める)、`-p anstyle-parse@0.2.7 --precise 0.2.6`は推移的依存でも通る
- 要求の範囲外(`anstream = "=0.6.21"`に`--precise 1.0.0`): 失敗する(Cargo.tomlの変更が必要)

### バージョン比較・Tier

- `versionScheme.ts`の`SEMVER_ECOSYSTEMS`に`crates.io`を加える(範囲の型は`SEMVER`。実データは`SEMVER`のみ)。Tierはnpmと同じキャレットの規則(`classifyCaret`)
- パッケージ名は完全一致で照合する(OSVの名前とCargo.lockの名前は同じ表記。crates.ioは`-`と`_`の違いだけの名前の重複を禁止しているが、表記は公開時のまま)

### 情報提供のアドバイザリ(suggest_fix)

- `informational`のグループは修正対象にしない(候補の検証にも使わない)。`per_cve_detail`には`tier: "informational"`(新設)と`informational`(種類)を付けて残し、`recommended_status`(推奨先での判定)も示す。`unfixed_vulnerability_count`には数えない
- 情報提供だけのパッケージ: 推奨は出さず、`verification: "informational_only"`(新設)。注記は種類別(`unmaintained`: 版を上げても解消しないため代替crateへの移行を検討 / `unsound`: 修正版があれば`fixed_versions`を確認 / `notice`: 内容を`explain_vulnerability`で確認)
- 推奨先の照会: 既知の情報提供は上の修正で無視される。照会で新しく見つかったレコードのうち、`unmaintained`・`notice`(`recordInformationalKind`で判定)はcrate全体の状態で版の選択に関係しないため無視し、`unsound`は版ごとの欠陥のため新しい脆弱性として修正対象に加える(設計メモ「Rust(crates.io)対応」のとおり)

### Cargo.lockの直接/推移的依存(`dependencyRelations.ts`に`cargoLockRelations`)

- 入力: 検出時に解析済みの全パッケージ(`CargoLockCache`の結果に保持する。コピーには依存を書かないため、スナップショットのコピーは読まない。requirements.txtと同じく検出時の検証済みデータを渡す)
- 依存の解決: `"名前"`は同名のパッケージが1つの場合だけ、`"名前 版"`は同名・同版が1つの場合だけ、`"名前 版 (source)"`は完全一致で解決する。解決先が`replace`を持てば置換先へたどる。解決できない参照があれば、その参照元から先は判定しない(到達できないパッケージは`unknown`)
- 起点: sourceなしのパッケージ(workspaceのメンバー・pathの依存。置換先のpathのcrateを含む)。起点の依存にあるcrates.io由来のパッケージが**直接**、直接依存(gitの依存・別レジストリのcrateを含む)から到達できるものが**推移的**。推移的依存には、到達経路の最初の直接依存を`introduced_by`(最大10件、npmと同じ)に付ける。直接依存が他の依存からも要求される場合は`direct`のまま`introduced_by`も付ける(npmと同じ)
- 開発用・ビルド用・対象OS限定の依存の区別はできない(Cargo.lockに情報がない)
- `declared_in`: 直接依存を宣言しているローカルのcrateのCargo.toml(プロジェクトからの相対パス)。検出時に見つけたCargo.tomlの`[package] name`(`cargoTomlPackageName`)と名前で対応付け、依存元のすべてのcrateを一意に対応付けられた場合だけ付ける(同名のCargo.tomlが複数・プロジェクト外のpathの依存等で対応できなければ付けず、案内文にcrate名を示す)。Cargo.tomlの読み込みは既存の上限(1件1MiB、合計の上限)の範囲
- 上限: 依存の辺の数はnpmと同じ上限(`MAX_DEPENDENCY_EDGES`)。超えたら`unknown`
- スキャン結果との対応: osv-scannerの結果のパッケージ(名前・版)を、そのCargo.lockのcrates.io由来のパッケージと対応付ける(コピーには同名・同版が1つしかない)

### `update_hint`(crates.io)

推奨版・現在の版・crate名を埋め込む。crate名は解析時に文字の範囲を検証済み、推奨版はOSV由来の外部データのため`^[0-9A-Za-z.+-]{1,64}$`に一致する場合だけ埋め込み、一致しなければ一般的な文にする。

| 依存 | Tier | 案内 |
|---|---|---|
| 直接 | `cross_major`以外 | `cargo update -p <name>@<現在の版> --precise <推奨版>`。Cargo.tomlの要求が許す場合(既定のキャレットなら許す)はCargo.lockだけが更新される。`=`や`~`で固定していれば、`declared_in`のCargo.tomlの要求を変更する |
| 直接 | `cross_major` | `declared_in`のCargo.tomlの要求を推奨版に変更する(破壊的変更の可能性。0.xはマイナー更新も含む) |
| 推移的 | `cross_major`以外 | 同じ`cargo update -p ... --precise ...`。依存元(`introduced_by`)の要求が許す範囲ならCargo.tomlを変えずに更新できる。要求を満たせないと報告されたら依存元を更新する |
| 推移的 | `cross_major` | 依存元(`introduced_by`)を、推奨版以上を要求する版へ更新する。`[patch.crates-io]`は要求範囲を変える仕組みではなく、依存元の要求を満たす版の修正(バックポート)を別ソースから使う場合に限る |
| 不明・混在 | - | 上の直接・推移的の両方の方法を示す |

- プレリリースの推奨(`recommended_is_prerelease`)では全行に追記: Cargoの要求は要求自体にプレリリースを書かない限りプレリリースに一致しないため、`--precise`だけでは更新できないことがある。直接依存なら要求を`"=<推奨版>"`に変更し、推移的依存なら依存元の要求がその版を許す必要がある
- `-p <name>@<現在の版>`は、同名の複数版がCargo.lockにある場合に対象を一意にするため常に付ける

### 段階計画(推奨案)

- **v0.12.1(修正リリース)**: 推奨先の照会の誤った`conflict`の修正。回帰テスト(修正版なしの既知の脆弱性が推奨先に該当しても推奨を保留しない・修正対象の脆弱性が該当と返れば従来どおり`conflict`)と、実データ(`ecdsa==0.13`)でMCP経由の確認。既存の推奨の不変(照会なしの出力がv0.12.0と一致)
- **v0.13.0**: crates.ioの推奨(SemVer・情報提供の扱い・照会で新しい`unmaintained`/`notice`を無視)、Cargo.lockの直接/推移的依存・`declared_in`、`update_hint`

### 完了条件とテスト(v0.13.0)

- 依存の解決: 3つの記法、同名の複数版、`replace`の置換先、gitの依存の配下、解決できない参照、辺の上限。cargoで生成したlockfile(上記の`anstream`の2版・`[replace]`)をフィクスチャにする
- 情報提供: 情報提供だけのパッケージ(`informational_only`)、修正可能な脆弱性と`unmaintained`を併せ持つパッケージ(推奨が出て、照会で`unmaintained`が`conflict`にならない)、照会で新しく見つかった`unmaintained`(無視)と`unsound`(修正対象に追加)
- `update_hint`: 上表の各行、プレリリース、推奨版の文字の範囲外(埋め込まない)
- 実データでMCP経由: 上の38パッケージ(照会あり)、`borsh`(プレリリース)、`openssl-src`(ビルドメタデータ)、他エコシステムの応答の不変(v0.12.1との比較)

### v0.13.0の実装とレビューでの修正(2026-10-13)

- **設計の誤り(修正版のあるunsound)**: 上の「情報提供のアドバイザリ」では情報提供をすべて修正対象から外したが、`unsound`は版ごとの欠陥で修正版を持つものが多い。実データ(照会あり)で`lru 0.6.0`に`0.7.1`(RUSTSEC-2026-0253は`0.18.2`で修正)、`git2 0.13.0`に`0.20.4`(RUSTSEC-2026-0183/0184は`0.21.0`)を推奨し、推奨先でも該当し、`fixed_in`も`null`になっていた。修正: 修正対象から外すのは`unmaintained`・`notice`と、現在より新しい修正版のない`unsound`だけ。修正版のある`unsound`は通常の脆弱性と同じくTierを求めて修正対象にし、`informational: "unsound"`を残す。修正対象が1件も残らない場合だけ`informational_only`。修正後は`lru→0.18.2`・`git2→0.21.0`
- `introduced_by`にローカルのcrate(pathの依存)が入っていた(`app`→`mylib`→`tokio`で`tokio`に`introduced_by: ["mylib"]`)。ローカルのcrateはそれ自体が起点でその依存は直接依存のため、推移的依存の探索の起点から外した
- 推奨がない場合の`update_hint`が「推奨を許すなら`cargo update ...`」と書いていた。推奨がなければコマンドを示さず、直接/推移的依存の方向だけを示す
- `[patch.crates-io]`の注意を全ての案内に付けていたため、推移的依存の`cross_major`だけにした。プレリリースの案内の`=<version>`は推奨版を埋め込む(ビルドメタデータは除く)
- 実装時の追加(設計に無かったもの): `declared_in`を一意に対応付けられない場合は`declaring_crates`(crate名、最大10件)を返す。案内の`--precise`はビルドメタデータを除いた版にする
- 確認: 実際の`Cargo.lock`(gix 420件・cargo-audit 399件、ローカルのレジストリのソースに同梱のもの)で関係の判定は2〜4ms、crates.io由来で`unknown`なし。38パッケージ(照会あり)で`verified` 33・`informational_only` 2・保留3、照会は33件とも`clean`

### 未確認事項

- プレリリースへの`cargo update --precise`の実機確認(キャッシュに依存元の揃ったプレリリースのcrateが無い)。案内はCargo公式文書の要求の規則に基づく
- crates.ioでyankされた版を推奨する可能性(OSVはyankを知らない。crates.ioのAPI照会は通信先を増やすため行わない。注記で触れる)

## osv-scannerのピン留め更新(2.4.0 → 2.7.0)詳細設計メモ(2026-10-15)

本サーバーの境界の検証・関係の判定・出力の解釈は、ピン留めした版の実挙動に合わせている(`binaryDownloader.ts`の注記)。更新は版を書き換えるだけでなく、実バイナリでの再監査を伴う。

### 対象の版(2026-10-15 確認)

リリース: 2.5.0(08-07)、2.5.1(08-17)、2.6.0(09-14)、**2.7.0(10-12、最新)**。当初は2.6.0を想定していたが、2.7.0が出ている。

**推奨: 2.7.0を対象にする。** 再監査(B5・親POM・requirements.txt・source.type・Cargo)は版ごとに必要で、2.6.0で行ってもすぐ2.7.0でやり直しになる。2.7.0にはプライバシー上の改善(下表の「ローカルのnpmパッケージを照会しない」)と、Mavenのgroup IDの修正も含まれる。ただし公開から3日のため、**公開から2週間(2026-10-26以降)経ち、重大な不具合の報告や2.7.xの修正版がないことを確認してからリリースする**(検証は先に進める)。2.7.1が出た場合はそれを対象にし直す。

### 変更点と本サーバーへの影響(リリースノートより)

| 版 | 変更 | 影響・確認事項 |
|---|---|---|
| 2.5.0 | スキャン・絞り込み・照合を**osv-scalibrのパイプラインに全面移行** | 出力の構造・`source.type`・グループ化・エラー時の終了コードとstderrが変わり得る。全項目の再確認の主因 |
| 2.5.0 | requirements.txt抽出器の正規表現の修正(名前・要求ごとのオプション) | 本サーバーは正規化した行(`名前==版`・`>=`・`~=`)だけを書くが、下限を使用中の版とみなす挙動(`version_is_lower_bound`)の再確認 |
| 2.5.0 / 2.5.1 | PURLの型の対応付け、照会時の名前空間(npmのscope等)の保持 | npmのscope付きパッケージ・Mavenの照会結果の比較 |
| 2.6.0 | **JSのlockfileのgitの依存からリポジトリURLを抽出し、OSVのタグと照合**。JS・Cargoのgitの依存に`pkg:git`を付けて、レジストリのパッケージとの誤検知を避ける | osv-scalibrのソース(`osvutil.go`)では、エコシステム`GIT`の照会でリポジトリURLを名前に使う。**package-lock.json等の社内gitリポジトリのURLがapi.osv.devへ送られる可能性**(新しい送信内容)。Cargoのgitの依存は本サーバーがコピーから除いているため送られない |
| 2.6.0 | tar爆弾による展開時のOOM・ディスク枯渇の防止 | JAR/WARのスキャン(`scan_java_artifact`)に有利。同定の結果が変わらないことを確認 |
| 2.6.0 | `--allow-no-lockfiles`で`results`が`null`でなく`[]` | 本サーバーは使っていない。パーサーはどちらも受け付ける |
| 2.7.0 | **Mavenの依存の版のプロパティの事前展開**(best-effort)、Maven解決のキャッシュ | 親POM・プロパティの解釈が変わる。`${env.X}`等の展開で**環境変数の値が版としてdeps.dev・OSVに送られないか**、範囲外のファイルを読まないかを確認 |
| 2.7.0 | ローカルのnpmパッケージ(`file:`・workspace・ローカルのtarball)をOSVに照会しない | 社内パッケージ名の送信が減る(改善)。npmの関係の判定・件数への影響を確認 |
| 2.7.0 | JSON出力にpurlを含める | パーサーは未知のフィールドを無視する。応答には出さない |
| 2.7.0 | Mavenのgroup IDの保持(CycloneDX)、Goのモジュールの名前空間を大文字小文字を区別せず照合 | SBOM・Goの結果の比較 |
| 2.7.0 | `--experimental-`のフラグを`--x-`に改名し、旧名は非推奨 | 本サーバーは`--experimental-plugins java/archive`を使う。**旧名が引き続き動くこと**を確認し、警告が出るなら新名に移る(固定の引数リストとテストを更新) |

### チェックサムの取得(供給網)

従来は公式リリースの`osv-scanner_SHA256SUMS`から転記した。今回は3つの経路で照合してから埋め込む:

1. GitHub APIのリリース資産の`digest`(2026-10-15に取得済み。darwin_arm64は`d4926ef8…f70b`等)
2. `osv-scanner_SHA256SUMS`(554バイト)
3. ダウンロードしたdarwin_arm64の実体のSHA-256(検証用に使う1件だけ)

対象は従来と同じ5種(darwin amd64/arm64、linux amd64/arm64、windows amd64)。windows arm64は従来どおり対象外。

### 実バイナリでの再確認(陽性対照つき。2.4.0と2.7.0を同じ時刻に並べて実行し、OSVのデータの更新と版の違いを分ける)

1. **B5の再監査**: 各形式のローカル参照で範囲外を読まないこと(既存のフィクスチャを再利用)。**陽性対照**(requirements.txtの`-r`、親POMの範囲外)が引き続き検出できることも確認する
2. **親POM**: `<relativePath>`・既定の`../pom.xml`・`<packaging>pom</packaging>`の条件、B4の回帰ケース(重複した`<parent>`、名前空間付き、CRの改行)の解釈がGoのXMLデコーダーと一致したままか
3. **Mavenのプロパティの展開(2.7.0)**: `${env.HOME}`・`${user.home}`・未定義のプロパティ・親POMのプロパティ・`${project.version}`を版に書いたpom.xmlで、送信される版・範囲外の読み込みを確認する
4. **requirements.txt**: 正規化したコピーの`==`・`>=`・`~=`の扱いと、`version_is_lower_bound`の前提
5. **pom.xmlの`source.type`の分離**(`lockfile` / `unknown`): `pomRelations`の前提
6. **Cargo.lock**: gitの依存・ローカルのcrate・別レジストリのcrateの扱い(sourceで絞り込むようになったか)、`informational`が出力に残るか。いずれにしてもコピー方式は維持する(社内crateの名前を送らないため)
7. **JSのlockfileのgitの依存**: `--all-packages`で、gitの依存がエコシステム`GIT`・リポジトリURLで照会されるかを確認する。送られる場合の対処は下記
8. **JAR/WAR**: 合成JAR(pom.properties入り)・ネストしたJAR・同定不能のJARで、同定・`inferred_only`の判定(groupIdに`.`がない座標)・終了コードが変わらないこと。実物のfat/shaded JARでの確認はダウンロードを伴うため、必要なら別途許可を得る
9. **SBOM**: CycloneDX・SPDXの既存フィクスチャ
10. **出力と終了コード**: 脆弱性あり(1)・なし(0)・パッケージなし(128)・解析失敗、stderrの形式(`runner.ts`の扱い)、`--experimental-plugins`の警告
11. **接続先**: lockfileはapi.osv.devだけ、pom.xml・requirements.txtはdeps.devも(CONNECTプロキシで記録)
12. **回帰の比較**: 混在プロジェクト(npm・Go・PyPI・Gradle・Rust)と`ecdsa`等の実データで、`scan_project`・`suggest_fix`の応答をv0.13.0(2.4.0)と比較し、差分を1件ずつ説明できること

### JSのlockfileのgitの依存のURL(確認7で送られると分かった場合)

- 推奨: v0.14.0では**READMEの通信先の表に明記**し(「package-lock.json等のgitの依存は、リポジトリURLとコミットがapi.osv.devに送られる」)、ツールの説明にも1文加える。Cargo.lockと同様にコピーから除く方式は、package-lock.json・yarn.lock・pnpm-lock.yaml・bun.lockの書き換えが必要で影響が大きいため、要望があれば別途検討する(バックログに記録)
- 代替: 該当する依存があるとき応答の`coverage`に「送信した」旨の注意を出す(lockfileの解析が必要)

### 変更するもの

- `binaryDownloader.ts`: `PINNED_OSV_SCANNER_VERSION`・`ASSET_CHECKSUMS`・注記(取得日と照合の経路)
- 実挙動の違いに応じた修正(確認の結果次第。2.4.0の挙動を前提にした注記・テストの更新)
- README: 通信先の表の確認日と版、gitの依存の送信内容、要件の記載
- キャッシュ: 新しい版は`~/.cache/osv-scanner-mcp/v2.7.0/`に入る。旧版のディレクトリは削除しない(READMEに手動削除の案内)
- リリースは**v0.14.0**(スキャン結果・送信内容が変わり得るため、修正版ではなくマイナー版)

### 実バイナリでの確認結果(2026-10-15、2.4.0と2.7.0を並べて実行)

**チェックサム**: 6種(darwin amd64/arm64、linux amd64/arm64、windows amd64/arm64。設計時に「windows arm64は対象外」と書いたのは誤りで、従来から6種を埋め込んでいる)とも、GitHub APIの`digest`と`osv-scanner_SHA256SUMS`が一致。darwin_arm64はダウンロードした実体のSHA-256(`d4926ef8da134332543be276dff157e4c170f99ad91fc48e89448a8816bdf70b`)とも一致。`--version`は`osv-scanner version: 2.7.0`(`osv-scalibr version: 0.5.3`)

**変わらなかったもの**:
- B5の再監査(package-lock.json・yarn.lock・pnpm-lock.yaml・poetry.lock・go.mod・pom.xmlの`<modules>`とBOMの`import`、resolveあり・`--no-resolve`): 範囲外の読み込みなし。陽性対照のrequirements.txtの`-r`は2.7.0でも範囲外を読み、親POMの`<relativePath>`も範囲外を読む(本サーバーの対策は引き続き必要)
- Mavenのプロパティ: `${env.X}`・`${user.home}`・未定義のプロパティは両版とも展開されず、その依存は出力から消える(環境変数の値は送られない)。`${project.version}`・親POMのプロパティは両版とも展開される
- pom.xmlの`source.type`の分離(宣言=`lockfile`、deps.devで解決=`unknown`)、requirements.txtの`==`・`>=`(下限)・`~=`・`===`の扱い、終了コード(脆弱性あり1・なし0・パッケージなし128・解析失敗127)とstderrの形式
- Cargo.lock: 2.7.0でもsourceを見ずに、ローカル・gitの依存・別レジストリのcrateをcrates.ioとして照会し、同名のアドバイザリが付く(2.6.0の`pkg:git`の変更は`--lockfile Cargo.lock:`の経路では効いていない)。コピー方式は引き続き必要。`informational`は出力に残る
- 接続先: lockfile・Cargo.lock・JAR/WARはapi.osv.devだけ、pom.xml・requirements.txtはapi.deps.devも(CONNECTプロキシで記録)
- MCP経由の応答: npm(`resolved`付き)・Go・PyPI・Gradle・pom.xml(親POMあり)・Rustの混在プロジェクトで、`scan_project`(26パッケージ・249件)と`suggest_fix`(26件)がv0.13.0+2.4.0と**完全に一致**。`scan_java_artifact`(合成JAR・fat JAR・WAR・同定不能のJAR)と`scan_sbom`(CycloneDX・SPDX)も完全に一致
- pnpm-lock.yaml・bun.lock・yarn.lockのレジストリのパッケージは両版とも照会される

**変わったもの(要判断)**:
1. **package-lock.jsonで`resolved`の無いエントリを照会しない(2.7.0、偽陰性)**: osv-scalibrの`DeterminePackageSource`は、`resolved`がnpmを含むhttp(s)のURLなら公開レジストリ、その他のhttp・gitなら「その他」、**それ以外(空を含む)はローカル**とみなし、ローカルは照会しない。`lodash 4.17.20`で、`resolved`なし・`inBundle: true`(バンドルされた依存)・`file:`は2.4.0では5件、2.7.0では0件。`file:`は正しくローカルだが、**バンドルされた依存と、npmの`omit-lockfile-registry-resolved=true`で生成したlockfile(レジストリのパッケージに`resolved`を書かない)は、実際のレジストリのコードなのに黙って照会されなくなる**。`resolved`がyarnpkg・社内のレジストリのURLでも照会は続く
2. **gitの依存がリポジトリURLで照会される(2.6.0〜、送信内容の変化)**: package-lock.json・yarn.lockの`git+ssh://git@git.mycompany.example/team/priv.git#<commit>`は、2.4.0では`npm:priv@1.2.3`(+commit)として照会されたが、2.7.0では**エコシステム`GIT`・名前`https://git.mycompany.example/team/priv`**で照会される。社内のgitホスト名とリポジトリのパスがapi.osv.devへ送られる
3. **`--experimental-`のフラグの非推奨**: 2.7.0は`--experimental-plugins`・`--experimental-no-default-plugins`を受け付けるが、stderrに非推奨の警告を出す。新名`--x-plugins`等は**2.4.0では未定義でexit 127**。`OSV_SCANNER_PATH`やPATH上の古い版を使う利用者がいるため、旧名を使い続ける(警告はstderrのため応答に影響しない)

### 判断(推奨案)

- 1(`resolved`なし): **package-lock.json(npm-shrinkwrap.jsonを含む)のスナップショットのコピーで、`resolved`の無いエントリに公開レジストリの形のURLを補い、2.4.0と同じく照会させる**。対象は、キーが`node_modules/`を含み、`link`でなく、`resolved`が無いエントリだけ(ローカルのディレクトリの依存は`link: true`とキーが`node_modules/`を含まない対象のエントリ、tarballは`resolved: "file:..."`のため対象外)。送信される名前は2.4.0と同じで、新たな送信はない。補った件数は応答に出さない(スキャンの範囲は2.4.0と同じになるため)。JSONの解析・再出力は本サーバーで行い、重複したキー等で解析できない場合は元のコピーをそのまま渡す(2.7.0の挙動になる。従来どおり`coverage`の範囲は変えない)
- 2(gitのURL): v0.14.0では**READMEの通信先の表とツールの説明に明記**する。コピーから除く・`resolved`を外して照会させない等の対処は、gitの依存の公開リポジトリでの正しい検出(OSVのGITの範囲)を失うため、要望があれば別途検討する(バックログ)
- 3(フラグ): 旧名を維持。テストに「2.4.0と2.7.0の両方で動く引数」である旨の注記を加える

### v0.14.0の実装(2026-10-15)

- `binaryDownloader.ts`: 2.7.0と6種のチェックサム(取得日・照合の経路を注記)
- `npmLockCopy.ts`(新規)・`scanProject.ts`: スナップショットのpackage-lock.jsonのコピーで`resolved`を補う(v2以降の`packages`と、v1の`dependencies`の入れ子の両方)。補うエントリが無ければコピーを書き換えない。単体テスト・統合テスト(コピーだけが変わり元のファイルは変えない)を追加し、補完を外すと統合テストが失敗することを確認
- 実機(MCP経由、検証済みのキャッシュの2.7.0): `resolved`なし・`inBundle`・v1の`lodash 4.17.20`が、補完なしの0件から検出されるようになった(グループ単位で3件)
- (レビュー指摘)v1の別名の依存(`"version": "npm:lodash@4.17.20"`、スコープ付きの`npm:@babel/traverse@7.22.0`)は版の文字種の確認で対象外になり補われなかった(`filled: 0`)。osv-scannerはこの表記を実際の名前と版で照会し、`resolved`が無いと2.7.0では照会しない(2.4.0では`lodash` 5件・`@babel/traverse` 1件、2.7.0では0件)。実際の名前と版を取り出して補う。MCP経由で`lodash`・`@babel/traverse`とも検出されることを確認
- 回帰: 5エコシステムの混在プロジェクトで、`scan_project`・`suggest_fix`の応答がv0.13.0+2.4.0と**バイト単位で一致**
- `--experimental-`のフラグは維持(`runner.ts`に理由を注記)。README・SECURITY.md・ツールの説明にgitの依存のURLの送信、READMEに`resolved`の補完と旧版のキャッシュの削除を記載。2.4.0を前提にしたコードの注記に2.7.0での確認を追記
- リリースは2.7.0の公開から2週間後(2026-10-26以降)、重大な不具合の報告と2.7.xの修正版がないことを確認してから

### Cargo.tomlのworkspaceのglob照合の計算量(v0.12.0〜v0.13.0の不具合、v0.14.0で修正、2026-10-22)

- **ReDoS**: `workspaceIncludes`の`members`のglobを正規表現(`*`→`[^/]*`)に変換して照合していたため、`*a*a…*b`のようなパターンで指数的なバックトラックが起きた(28文字の入力で454ms、長さに対して指数的に増える)。攻撃者が用意したリポジトリのルートのCargo.tomlで、スキャンを止められる
- 修正(利用者が実装): セグメントごとの動的計画法(パターン長×セグメント長)に置き換え、1回の判定の計算量に上限(100万セル)を設け、超えたら判定できない(null、`unconfirmed`)
- **残っていた問題(レビュー指摘)**: 上限が`workspaceIncludes`の呼び出し(メンバーのCargo.tomlごと)で戻るため、同名のcrateを名乗るCargo.tomlを大量に置くと計算量が積み上がる(2,000件で`detectProject`が4.6秒の同期処理、走査の上限20万エントリでは数分)。修正: 検出全体で共有する上限(`GlobWorkBudget`、1,000万セル、`CargoLockCache`が持つ)を設け、使い切った後のglobの判定はnull
- 共有の上限を入れたところ、メンバーを文字どおりに列挙した大きなworkspace(1,000件)で、文字どおりの比較の分も上限に数えたため714件が誤って`unconfirmed`になった。workspaceごとに1回だけパターンを前処理し(`WeakMap`)、文字どおりのメンバーは集合で引き、`exclude`・文字どおりのメンバーの前方一致は祖先のパスを集合で引く。上限に数えるのはglobの照合だけ。上限を使い切ったら残りのglobを見ない(大量のパターン×メンバーの空回りを防ぐ)
- 確認: 1,000件の文字どおりのworkspaceは0.3〜0.5秒で全件収録済み。2,000件の重いglobと、25,000パターン×5,000件のglobは、それぞれ1〜2秒で`unconfirmed`(globの照合は58ms、残りはファイルの読み込み)。MCP経由の`scan_project`も同じ。変異確認: 共有の上限から引かない・使い切っても残りのglobを見る・文字どおりのメンバーも上限に数える、の各変更で追加したテストが失敗する
- **宣言元のCargo.tomlの対応付け(v0.13.0〜、v0.14.0で修正、2026-10-22)**: 検出時にプロジェクトの全Cargo.tomlの`[package] name`を集め、(1) 同名の集約で配列を毎回コピーしていた(同名の数の2乗、利用者が`string | null`の印に変更して線形に)、(2) Cargo.lockごとに**全crate名**をたどって`path.relative`し、Cargo.lockごとに全件のMapを作っていた(Cargo.lockの数×crate名の数の処理とメモリ)。(2)は`declared_in`に使うそのCargo.lockのローカルのcrate名だけを引くよう修正。実測(小さいCargo.lock 900件と名前が一意なCargo.toml 2万件の`detectProject`): 修正前はCPU 53秒・ヒープ3.6GB・Mapの合計1,800万件、修正後はCPU 20秒・20MB・0件。残る時間はファイル2万件の安全な読み込み(1件約1msの`realpath`等の確認)で、件数に比例する
- **go.modのreplaceの照合(v0.7.0〜v0.13.0、v0.14.0で修正、2026-10-22)**: 直接/推移的依存の判定(`goModRelations`)が、requireごとにreplaceの一覧を`find`で走査していた(require数×replace数)。1.6MBのgo.mod(requireとreplaceを各2万行)で2.81秒、関係の判定の読み込みの上限(合計256MiB)まで大きいgo.modを置くと数分になりうる。修正(利用者が実装): replaceをモジュールのパス→版(版の限定なしはnull)の索引にし、版の一致を優先・各版で最初の宣言を採るという従来の規則のまま定数時間で引く。同じ入力で0.02秒
- **Cargo.lockの解析のメモリの増幅(v0.12.0〜v0.13.0、v0.14.0で修正、2026-10-22)**: `parseCargoLock`がファイル全体を行の配列に分割し、行数・依存の要素数・文字列の長さに上限がなかった。60MBの空行だけのCargo.lockで解析に1.36GB(最大常駐)、読み込みの合計の上限(256MiB)まで置くと数GB。修正(利用者が実装): 行の配列を作らず1行ずつ読み、検出全体で共有する上限(行100万・依存の要素20万・文字列の文字数1件65,536・合計16Mi)を設ける。超えたファイルは理由付きで除外し、以降のファイルも同じ理由で除外。同じ入力で0.01秒・241MB(大半はファイルの内容)。実在のlockfile(約400パッケージ)は各上限の0.4〜0.7%で、同程度のlockfileが約140件を超えるリポジトリでは以降が除外される
- **上限の端数(2026-10-22、修正は利用者)**: 「上限を使い切ったら残りのglobを見ない」は残りが0以下の場合だけ効いていた。どのパターンの準備のコスト(パターン長+対象の長さ+1)にも満たない正の端数が残ると、各globの照合が何も引かずにnullを返し、残りが0にならないため、以降のメンバーごとに全パターンを空回りした。実測: 端数7で2,000件×10万パターンが0.75秒(ルートのCargo.toml 1MiBで約10万パターン、走査の上限約20万エントリまで増やすと数十秒以上)。修正: 準備のコストが残りを超えたら残りを0にして打ち切る(DPの表の確保だけが足りない場合は残りを保ち、安いglobの照合は続ける)。同じ入力で0.02秒
- **`[replace]`の置換先の確認(v0.12.0〜v0.13.0、v0.14.0で修正、2026-10-22)**: `parseCargoLock`は置換を持つパッケージごとに、全パッケージを走査して置換先を探していた(パッケージ数の2乗)。上限の5万パッケージ(2.5万件の置換)の4.6MBのCargo.lockで1.88秒、読み込みの合計の上限(256MiB)まで複数のCargo.lockを置くと数十秒〜数分の同期処理になりえた。修正(利用者が実装): 全パッケージの同一性(name・version・source)の個数を1回だけ数え、置換先の個数が自分自身を除いて1以上かで判定する(従来と同じ規則)。同じ入力で0.10秒。テストは再走査しないこと・上限いっぱいで全置換が末尾を指す場合・別の重複と自己参照の区別・連鎖と循環を確認

### requirements.txtの取り込みの再展開による資源の枯渇(v0.4.0〜v0.13.0の不具合、v0.14.0で修正、2026-10-22)

- **事象**: 取り込み先のファイル(`-r shared.txt`)は1回だけ読んでキャッシュするが、取り込むrequirements.txtごとに解析し直し、正規化した行を各コピーに書いていた。読む量の上限(64MiB)はキャッシュ済みの再展開に効かないため、大きな共通ファイルを多数のrequirements.txtから取り込むと、処理時間・メモリ・コピーの行数が取り込み元の数に比例して増える。実測(950KB・80,000行の共通ファイルを200件から取り込み): 修正前7.8秒・ヒープ1,027MB・コピー1,600万行。1,000件では約5GBとなり、メモリ不足でサーバーが落ちうる
- 修正(利用者が実装): 1回のスキャンで共有する上限を追加。展開する量(64MiB、キャッシュ済みの再展開も数える)と論理行数(10万行)。超えたら、ルートのrequirements.txtは`skipped_files`(理由付き)、取り込みの途中なら`unscannable_requirements`(その取り込みは途中まで展開)に記録し、`complete: false`
- 確認: 同じ入力で修正後0.07秒・22MB・コピー99,998行、198件を理由付きで除外。MCP経由の`scan_project`も同じ(全体20秒の大半はosv-scannerによる約10万件の照会)

### npmのlockfileのJSONの解析による資源の枯渇(v0.4.0〜v0.13.0の不具合、v0.14.0で修正、2026-10-22)

- **事象**: npm workspacesの収録確認(`LockfileKeyCache`、v0.4.0〜)と直接/推移的依存の判定(v0.7.0〜)が、package-lock.jsonを`JSON.parse`で丸ごと解析していた。上限はサイズ(1件64MiB・合計256MiB)だけで、構造の量は無制限。実測(修正前のコード): 空のオブジェクト2,000万個の60MBのlockfile1件で、workspaceの確認だけでメモリ2.45GB(最大常駐)。数件でメモリ不足になりうる。v0.14.0で追加した`resolved`の補完(未公開)も同じ解析と、インデント付きの再出力(深い入れ子で出力が膨らむ)を行っていた
- 修正(利用者が実装): `parseNpmLock`で、`JSON.parse`の前に入れ子の深さ(128)と構造の記号の数(1件100万・解析の段階ごとに200万)を数え、入力・出力を1件16MiB・スキャン全体64MiBに制限。補完したコピーは詰めたJSONで、出力の大きさを作る前に見積もる。workspaceの確認・関係の判定は上限超過で`unconfirmed`・`unknown`
- **レビュー指摘**: 補完の段階だけは上限超過でスキャン全体を`scan_input_too_large`で止めていたため、正当な大きいlockfile(4万パッケージ・17.2MB、補う必要のないもの)で、他のエコシステムを含むスキャン全体が失敗した(修正前は正常にスキャン)。実在のlockfileは1パッケージあたり約500バイト・構造の記号約22個で、1件の上限は約3.3万パッケージに当たる。修正: 補完の上限を超えたlockfileは補わずにそのまま渡し(osv-scannerは大きなlockfileも解析できる。上限は本サーバー自身の解析・再出力のためのもの)、`coverage.skipped_files`に理由を出す(`complete: false`)。補う必要のない(書き換えない)コピーは出力の上限に数えない
- 確認: 4万パッケージのlockfileはMCP経由でスキャンでき(`lodash`を検出、`complete: false`と理由)、5,000段の入れ子のlockfileは1秒で終わる。60MBの攻撃的なlockfileのworkspaceの確認は0秒・51MB。変異確認: 補完の上限超過で再びスキャンを止めると、追加したテスト8件が失敗する

### 必要なダウンロード(実施前に許可を得る)

- `osv-scanner_darwin_arm64`(v2.7.0、55,336,530バイト)と`osv-scanner_SHA256SUMS`(554バイト)。公式のGitHub Releases(google/osv-scanner)。本サーバーの自動ダウンロードと同じ経路・同じ検証で取得できる

## スキャンの実行履歴(v0.15.0候補)詳細設計メモ(2026-10-23)

利用者の要望: 実行の記録(いつ・何を・どの範囲でスキャンしたか)と、前回からの変化(新たに見つかった・解消した脆弱性)の両方を確認したい。現状のサーバーは呼び出しの間で何も保存しない(結果はMCPクライアントに返すだけ)。

### 非目標

- 結果の全文の保存(大きく、社内のパッケージ名・パスを広く残す)。保存するのは要約と、差分に必要な識別子だけ
- 別のマシン・利用者との共有、外部への送信。履歴はローカルのファイルだけ
- MCPのresources(対応していないクライアントがある)。ツールで返す

### 有効化と保存先

- **既定は無効**。`OSV_MCP_HISTORY=1`(`true`・`yes`)の場合だけ記録する(社内のパッケージ名・パスをディスクに残すため、明示的に選んだ場合だけ)
- 保存先: `$XDG_STATE_HOME/osv-scanner-mcp/history/`(未設定なら`~/.local/state/osv-scanner-mcp/history/`)。履歴は作り直せるキャッシュではないため、`~/.cache`ではなく状態の置き場所(XDG Base Directory)。`OSV_MCP_HISTORY_DIR`で変更できる(絶対パスのみ)
- ディレクトリは0700・ファイルは0600。作成・読み込みの前に、ディレクトリがシンボリックリンクでなく所有者が自分であることを確かめる(起動時の残骸の掃除と同じ確認)。満たさなければ記録しない(stderrに警告)

### 記録の単位と形式

- **1回のツール呼び出し=1ファイル**(`<UTC時刻>-<乱数>.json`)。一時ファイルに書いてから`rename`する。1つのファイルに追記する方式(JSON Lines)は、複数のクライアントが同時にサーバーを動かすと行が混ざりうるため採らない。ファイル名の先頭の時刻で並べる
- 対象のツール: `scan_project`・`suggest_fix`・`scan_java_project`・`scan_java_artifact`・`scan_sbom`(`explain_vulnerability`はスキャンでないため記録しない)
- 記録の内容(`schema: 1`):
  - 共通: `id`、`started_at`(UTC)、`duration_ms`、`tool`、`server_version`、`osv_scanner_version`(ピン留め・PATH・OSV_SCANNER_PATHの別を含む)、`target`(入力のパスと解決後のプロジェクトのディレクトリ)、`allowed_root_set`
  - 結果: `status`(`ok` / `error`)、失敗時は`error_kind`だけ(メッセージは残さない)
  - 範囲: `coverage.complete`、スキャンしたマニフェストの一覧(パス・エコシステム・形式)、欠け(`lockfile_missing`等)の件数
  - 件数: 脆弱性・情報提供・深刻度別、脆弱なパッケージの数
  - **差分用の識別子**(`findings`): パッケージごとに`ecosystem`・`name`・`version`と、脆弱性のIDと別名の一覧(情報提供は種類も)。`suggest_fix`では推奨版・Tier・`verification`も。上限(例: 1万件)を超えたら打ち切り、`findings_truncated: true`を付ける(差分は「不完全」と示す)
- 1件の上限(例: 1MiB)。超える場合は`findings`を省いて要約だけ記録する
- 記録の失敗はスキャンを失敗させない(stderrに警告。応答には影響しない)

### 保持

- 既定で最新500件(`OSV_MCP_HISTORY_MAX_ENTRIES`で変更、上限あり)。書き込みのたびに古いものから削除する(削除の競合は無視する)
- 合計サイズの上限(例: 100MiB)も設け、超えたら古いものから削除する

### 閲覧: 新しいツール`scan_history`

- 入力: `project_path`(省略可)、`limit`(既定10、最大50)、`run_id`(省略可。指定するとその回の詳細)
- 出力:
  - `runs`: 新しい順の要約(時刻・ツール・対象・`status`・件数・`coverage.complete`)。`project_path`を指定すると、その対象の回だけ
  - `changes`(`project_path`指定時): 同じ対象・同じ種類のスキャン(プロジェクト / Javaプロジェクト / JAR・WAR / SBOM)の、直近の成功した2回の比較。`suggest_fix`と`scan_project`は検出が同じため同じ種類として比べる
    - `new_vulnerabilities`: 今回あって前回なかった(パッケージ・版と脆弱性の組。IDか別名が重なれば同じ脆弱性とみなす。OSVの代表IDが入れ替わっても誤検知しない)
    - `resolved_vulnerabilities`: 前回あって今回ない。理由を分ける: `upgraded`(同じパッケージの版が変わった)、`removed`(パッケージが無くなった)、`no_longer_reported`(同じ版のまま報告されなくなった。OSVのデータの更新等)。※実装では名前と比べ方を変更(下の「実装メモ」)
    - `version_changes`: パッケージの版の変化
    - `coverage_changes`: `complete`の変化、マニフェストの増減
    - 注意書き: 差分はスキャンの時点のOSVのデータに依存する(コードを変えていなくても、データの更新で増減する)。`findings_truncated`の回が含まれる場合は不完全と示す
- 履歴が無効なら`history_disabled`(有効化の方法を案内)。エラーにせず空の結果にすると「履歴がない」と誤読されるため

### 安全性

- **許可ルート**: `OSV_MCP_ALLOWED_ROOT`設定時は、対象が許可ルートの内側の回だけを返す(許可ルートを狭めて起動し直した場合に、範囲外の過去の情報を返さない)。`project_path`も従来どおり検証する
- 外部由来の文字列(パッケージ名・パス・ID)は、読み出し時にも`sanitizeExternalText`を通す(ファイルの改ざん・プロンプトインジェクション対策)。記録を読むときはサイズの上限付きで安全に読み、解釈できないファイルは無視する(件数を`skipped_records`に示す)
- 履歴のファイルは本サーバー以外も書き換えられる前提で扱う(信頼しない入力)
- Nodeの権限モデル(`--permission`)で起動した場合、履歴が有効で保存先に書き込めなければ起動時に警告する(既存の`permissionModelWarnings`に追加)

### 段階計画(推奨案)

- **v0.15.0**: 記録(全スキャンツール)と`scan_history`(一覧・詳細・直近2回の差分)
- 以降(要望があれば): 任意の2回の比較、履歴の書き出し(CSV等)

### 完了条件とテスト

- 記録: 有効・無効、保存先の検証(シンボリックリンク・所有者・権限)、一時ファイルとrename、記録の失敗でスキャンが失敗しないこと、上限(件数・サイズ・findings)と打ち切りの表示、同時に複数のプロセスが書く場合
- 差分: 新規・解消(upgraded・removed・no_longer_reported)、別名での同一視、代表IDの入れ替わり、範囲の変化、打ち切りを含む場合
- 閲覧: 許可ルートの外の回を返さない、改ざん・壊れたファイルの無視、外部由来の文字列の無害化、`history_disabled`
- 実バイナリでMCP経由: 同じプロジェクトを依存を変えて2回スキャンし、差分が期待どおりになること。履歴を無効にした場合に何も書かないこと

### 実装メモ(設計からの変更点)

- **差分はパッケージ(エコシステムと名前)単位で比べる**: 当初の「パッケージ・版と脆弱性の組」で比べると、版を上げても残る脆弱性(例: lodash 4.17.20→4.17.21で残る3件)が新規にも解消にも数えられた(MCP経由の確認で判明)。版が変わっても残る脆弱性はどちらにも数えず、`version_changes`の`still_affected`に件数を示す
- **解消の理由の名前を変更**: `upgraded`→`version_changed`、`removed`→`package_not_reported`、`no_longer_reported`→`same_version_not_reported`。スキャン結果には脆弱なパッケージしか載らないため、結果から消えたパッケージが「更新された」(既知の脆弱性のない版へ)のか「削除された」のか「範囲外になった」のかは区別できない。断定する名前を避け、観測できる事実だけを示す。`version_changed`には今回の版(`current_versions`)を付ける
- 比較は失敗した回(`status: "error"`)を飛ばし、同じ種類の直近の成功した2回を使う。2回未満なら種類ごとに`note`で示す
- `suggest_fix`の件数は、記録した`findings`から情報提供を除いて数え直す(応答に`vulnerability_count`がないため)
- 上限: `findings`は5,000パッケージ・合計2万件の脆弱性・別名は各20件・文字列は512文字。1件の記録が1MiBを超えたら`findings`を省く(`findings_omitted`)。それでも超えれば(長いパスのマニフェストが多い場合)マニフェストの一覧を半分ずつ減らし、最後は一覧を省く(`manifests_truncated`。マニフェストの増減は比べず`incomplete`に示す)。深刻度別の件数のキーは16個まで。対象のパス(`target.input`・`target.resolved`)は他の文字列の512文字の上限では照合に使えないため、4,096文字(LinuxのPATH_MAX。これより長いパスは実在せずスキャンは失敗する)で切り詰め`target_truncated`を付ける(非常に長い入力パスで失敗した回の記録が上限を超えた。レビューで指摘)。それでも収まらない記録は書かずに例外にし、記録側が警告する。これで残りの項目は大きさに上限があり、保存したものは読み出しの上限(同じ1MiB)で必ず読み戻せる。`scan_history`で1回に読む量は合計64MiB、`run_id`の詳細は500パッケージまで、差分の各一覧は500件まで(超えたら`incomplete`)
- 対象の照合: `project_path`は実パスで解決し、解決できなければ(削除済みのプロジェクト)絶対パスのまま照合する。記録の`target.resolved`(応答の`project_dir`、なければ入力の実パス)か入力のパスと一致する回を選ぶ
- 保存先は作成・確認の後の実パスで読み書きする(安全な読み込みの境界の確認が実パスで行われるため。macOSの`/var`→`/private/var`等)
- 差分の照合はパッケージごとにIDと別名の集合を作って行う(件数に比例する時間)。相手側の全件を走査する方式では、上限内の2万件同士で数秒〜十数秒、同期処理でサーバーが止まった(レビューで指摘)
- 文字列の無害化は二重: 記録を解釈するとき(`unknownJson`の取り出し)と、応答を返す直前(`sanitizeDeep`)。どちらか一方が漏れても他方で止まる

## .NET(NuGet)対応(v0.16.0候補)詳細設計メモ(2026-10-23)

利用者の要望: .NETのプロジェクトも`scan_project`でスキャンしたい。v0.16.0はスキャン(検出・範囲・直接/推移的の区別)まで、`suggest_fix`のNuGet対応はv0.17.0(Rustと同じ二段階)。

### 非目標

- `dotnet restore`・MSBuildの実行や評価(プロパティ・条件・`<Import>`の解決)。ビルドは実行しない方針(既存と同じ)
- ユーザー単位・マシン単位の`NuGet.Config`(`~/.nuget/NuGet/NuGet.Config`等)の読み込み。スキャン範囲の外を読まない
- 中央パッケージ管理(`Directory.Packages.props`)の版の解決(lockfileへの誘導で対応。下の「中央パッケージ管理」)
- `suggest_fix`のNuGet対応(v0.17.0)。v0.16.0では既存どおり`verification: "unsupported_ecosystem"`

### 実機確認(osv-scanner 2.7.0、2026-10-23)

Newtonsoft.Json 12.0.1(GHSA-5crp-9r3c-p9vr、13.0.1で修正)で確認。

| 形式 | osv-scannerの挙動 | 判断 |
|---|---|---|
| `packages.lock.json`(`RestorePackagesWithLockFile`) | 直接・推移的の全パッケージを確定版で照会。`type: Project`は照会しない | 主対象 |
| `packages.config`(.NET Framework) | 確定版で照会(推移的も平坦に列挙される形式) | 対象 |
| `*.deps.json`(ビルド出力) | `type: project`(自分のプロジェクト)も**NuGetのパッケージとして照会する**(公開パッケージと同名なら誤検知、社内名はapi.osv.devに送られる。Cargo.lockのローカルcrateと同じ問題) | コピーで除外して対象 |
| `.csproj` | `Version="$(Prop)"`・範囲`[12.0.1,13.0.0)`を**そのまま版の文字列として照会する** | そのままは渡さない |
| `Directory.Packages.props`・Versionの無い`PackageReference` | 読まない(エラー) | 範囲外として示す |

- **解釈できない版の文字列はOSVで「全ての版より前」とみなされる**: api.osv.devに`$(NJ)`・`[12.0.1,13.0.0)`・`garbage`を送ると、どれも12.0.1と同じ脆弱性が返る(13.0.1は0件)。未解決の版を送ると、修正済みでも脆弱と報告される(誤検知)。**確定版と確認できたものだけを送る**
- `.csproj`の`<Import Project="../...">`・`Directory.Build.props`はたどらない(範囲外のローカル参照は起きない)。ただし下の方針により、元のファイルはosv-scannerに渡さないため、そもそも依存しない
- 複数のターゲットフレームワーク(`net48`・`net8.0`・`net8.0/linux-x64`)で版が違う場合、各版を照会する
- 自己完結型アプリのランタイムパック(`Microsoft.NETCore.App.Runtime.linux-x64` 8.0.0)は脆弱性12件。照会対象に含める
- サーバーが書く正規化した`packages.lock.json`を`--lockfile packages.lock.json:<絶対パス>`で渡すと、2.7.0・2.4.0とも同じ結果(フレームワーク名は任意の文字列でよい)

### 方針: 全形式をサーバーが解析し、正規化したコピーだけを渡す

- `packages.lock.json`・`packages.config`・`*.deps.json`・`obj/project.assets.json`・`.csproj`を、サーバーが読んで(`readRegularFile`、サイズ上限つき)解析し、**照会してよいパッケージだけを書いた`packages.lock.json`形式のコピー**をスナップショットに書く。元のファイルはosv-scannerに渡さない(Cargo.lock・requirements.txtと同じ。解釈の食い違いによる範囲外読み込み・誤照会を構造的に防ぐ)
- `MANIFEST_FORMATS`に`packages.lock.json`を追加するが、渡すのはコピーだけ(Cargo.lockと同じ扱い。テストで元のファイルを渡さないことを確かめる)
- コピーは(名前, 版)ごとに1件。同じ名前の別の版は別のフレームワークのグループに分けて書く(JSONのキーの重複を避ける)。応答のパスは元のファイルに戻す(既存のコピーの対応付けを使う)

### 検出とプロジェクトごとの対応付け

**単位はプロジェクトのファイル**(`*.csproj`・`*.fsproj`・`*.vbproj`)。ディレクトリ単位にしない: 同じディレクトリに複数のプロジェクトがある場合、1つのlockfileを全プロジェクトの完全な情報とみなせない(レビュー指摘)。プロジェクトごとに、**そのプロジェクトのものと確認できた**情報源を次の順で探し、最初に見つかったものを使う。

1. **lockfile**(NuGetの公式の説明: 既定はプロジェクトのディレクトリの`packages.lock.json`、同じディレクトリに複数のプロジェクトがある場合は`packages.<プロジェクト名>.lock.json`、`NuGetLockFilePath`で別の場所も指定できる)
   - `packages.<プロジェクト名>.lock.json`(プロジェクトのファイル名から拡張子を除いた名前。大文字小文字を区別しない) → そのプロジェクトのものと確認できる
   - `packages.lock.json` → **そのディレクトリのプロジェクトのファイルが1つだけの場合に限り**、そのプロジェクトのものとする
   - プロジェクトのファイルに`NuGetLockFilePath`がある場合(値は評価しない) → 既定の名前のlockfileがあっても対応付けを確認できないため、確認済みとはしない
2. **`obj/project.assets.json`**(`dotnet restore`の生成物。lockfileは既定で無効のため、これが無いと多くのプロジェクトで推移的依存を見られない) → ファイルの`project.restore.projectPath`(または`projectName`)が**そのプロジェクトのファイルと一致する場合だけ**使う(同じディレクトリの複数のプロジェクトは`obj`を共有して上書きし合うため、名前で確かめる)。プロジェクトのファイルより古い場合は「古い可能性」を`coverage.warning`に示す(更新日時の比較)。`BaseIntermediateOutputPath`等で`obj`の場所を変えている場合は見つからず、3になる
3. **プロジェクトのファイルの`PackageReference`** → 直接依存だけ(下の「`.csproj`の読み方」)。`lockfile_missing`に`status: "direct_only"`(新しい値)で載せ、`RestorePackagesWithLockFile`の有効化を案内する

対応付けを確認できない場合:
- どのプロジェクトのものか確認できないlockfile(複数のプロジェクトがあるディレクトリの`packages.lock.json`等)も、**載っているパッケージは実在するためスキャンする**。ただし、どのプロジェクトも確認済みにしない
- 確認済みの情報源の無いプロジェクトは、3(直接依存だけ)で扱い、`lockfile_missing`には`status: "unconfirmed"`(既存の値)で「lockfileはあるが、このプロジェクトのものと確認できない」と示す。`coverage.complete`は`false`

その他:
- `packages.config`(.NET Framework。全ての依存が確定版で列挙される: NuGetの公式の説明) → 完全。プロジェクト別の`packages.<プロジェクト名>.config`も同じ規則で対応付ける。`developmentDependency="true"`は`dependency_groups: ["dev"]`
- `*.deps.json` → 直接指定された場合と、プロジェクトのディレクトリの`bin/`・`obj/`の外で見つかった場合(配置済みのアプリ等)。`bin/`・`obj/`の中は同じプロジェクトの重複になるため走査しない(走査関数に「プロジェクトのファイルがあるディレクトリの`bin`・`obj`を飛ばす」判定を追加。名前だけで飛ばすと他のエコシステムの`bin`まで飛ばすため)。`obj/project.assets.json`は走査ではなくプロジェクトのディレクトリから直接読む
- `project_path`にファイルを直接指定した場合はその形式だけ(既存と同じ)

### 各形式で照会するもの・しないもの

| 形式 | 照会する | 自分のプロジェクト(数だけ数える: `local_projects`) | その他(`unscannable_nuget_packages`に理由つき) |
|---|---|---|---|
| `packages.lock.json` | `type`が`Direct`・`Transitive`・`CentralTransitive` | `Project` | 未知の`type`、確定版でない`resolved` |
| `project.assets.json` | `libraries`の`type: package` | `project` | その他の`type` |
| `*.deps.json` | `libraries`の`type`が`package`・`runtimepack` | `project`・`reference` | その他の`type` |
| `packages.config` | `package`の`id`・`version` | — | 確定版でない`version` |

- **確定版**(復元の結果の形式で使う: lockfileの`resolved`・`project.assets.json`・`*.deps.json`・`packages.config`の`version`): NuGetの版の形式(`^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)。それ以外の文字列は照会しない(解釈できない版はOSVで全ての脆弱性に一致するため)
- **名前**: NuGetのIDは大文字小文字を区別しないため、比較は小文字化して行い、最初の表記を使う。使える文字(`^[A-Za-z0-9_.-]{1,100}$`)以外は照会しない

### `.csproj`の読み方(直接依存だけの場合)

**版の指定は確定版ではない**(レビュー指摘。NuGetの公式の説明: `Version="3.6.0"`は「3.6.0以上で最も低い版を優先」、完全一致は`[3.6.0]`。指定の版が無ければ、それより上の最も近い版に解決される):

| 指定 | 扱い |
|---|---|
| `[x]`(完全一致) | 確定版xとして照会 |
| `x`・`[x,)`・`[x,y)`・`[x,y]`(下限を含む) | **下限xとして照会**し、`version_is_lower_bound: true`を付ける(requirements.txtの`>=`と同じ扱い)。実際に復元される版はxより上でありうる(OSVの結果は下限の版のもの)ことを`coverage.warning`に示す |
| `(x,)`・`(,y]`・`(x,y)`等(下限を含まない・下限が無い) | 照会しない(理由`range`) |
| `$(...)`を含む | 照会しない(理由`property`) |
| `*`を含む(フローティング) | 照会しない(理由`floating`) |
| 版が無い(中央パッケージ管理) | 照会しない(理由`central_package_management`) |

**評価しないため、使われるか確かめられない参照は照会しない**(レビュー指摘。NuGetの公式の説明: `PackageReference`と`ItemGroup`のどちらにも`Condition`を付けられる):

- 照会するのは、`<Project>`の直下の`<ItemGroup>`の直下にある、**`Condition`の無い**`<PackageReference Include="...">`だけ。`PackageReference`自身・親の`ItemGroup`・子の`<Version>`のどれかに`Condition`がある場合、`<Choose>`/`<When>`/`<Otherwise>`の中、`<Target>`の中は照会しない(理由`conditional`)
- `Update=`・`Remove=`で同じ名前を扱う要素がファイル内にある場合、**その名前の`Include`も全て照会しない**(理由`updated`/`removed`。`Update`だけ未解決にすると、先行する`Include`の古い版を照会してしまうため)
- 同じ名前の`Include`が複数ある場合は照会しない(理由`duplicate`)
- `VersionOverride`がある場合は照会しない(理由`central_package_management`)
- プロジェクトのディレクトリからスキャン対象のディレクトリまでの`Directory.Build.props`・`Directory.Build.targets`(暗黙に読み込まれる)に`PackageReference`(`Include`・`Update`・`Remove`)がある場合、その名前も照会しない(理由`updated`)。スキャン対象の外の同名のファイルは確かめられないことを`coverage.warning`に示す
- `.NET SDK`が暗黙に追加する参照(NuGetの公式の説明)はファイルに無いため含まれない。直接依存だけの場合は、そもそも`coverage.complete: false`

### 直接/推移的の区別

- `packages.lock.json`: `Direct` / `Transitive`(`CentralTransitive`も推移的)
- `project.assets.json`: `project.frameworks.*.dependencies`に載るものが直接
- `*.deps.json`: `type: project`のライブラリの`dependencies`に載るものが直接
- `packages.config`: 区別できない(`unknown`)。`.csproj`(直接依存だけの場合): 全て直接
- `introduced_by`(どの直接依存が持ち込んだか)と`declared_in`はv0.17.0(`suggest_fix`と合わせて。Rustと同じ順序)

### 中央パッケージ管理(`Directory.Packages.props`)

- lockfile・`project.assets.json`があれば版は確定しているため問題ない
- どちらも無い場合、版は`Directory.Packages.props`(上位のディレクトリをたどる・`<Import>`・条件を持てる)にあり、正しく解決するにはMSBuildの評価が要る。v0.16.0では解決せず、`unresolved_package_references`(理由`central_package_management`)にして、lockfileの有効化を案内する

### 非公開フィード

- lockfile等にはパッケージの取得元が記録されないため、非公開フィードのパッケージを見分けられない(Rustの`source`のような手がかりが無い)。**その名前もapi.osv.devに送られる**ことをREADME・SECURITY.md・ツールの説明に明記する
- プロジェクトのディレクトリから`scan_project`の対象ディレクトリまでの`nuget.config`(大文字小文字を区別しない)に、nuget.org(`api.nuget.org`)以外の`packageSources`があれば、`coverage.warning`で「非公開フィードのパッケージ名も送られる」と示す(読むのはスキャン範囲の中だけ)
- `packageSourceMapping`による非公開パッケージの除外は以降の候補

### 上限と安全性

- XML(`.csproj`・`packages.config`)は専用の小さな走査で読む(外部のライブラリは使わない)。`DOCTYPE`・`ENTITY`・CDATAは扱わず、そのファイルを`skipped_files`にする(エンティティ展開による資源枯渇を避ける。`pomParent.ts`と同じ考え方)。1件4MiB
- JSON(`packages.lock.json`・`project.assets.json`・`*.deps.json`)は`npmLockCopy.ts`の事前検査(入れ子の深さ・構造の数)を共用し、1件16MiB・スキャン全体64MiB。上限を超えたファイルは`skipped_files`に理由つきで示す(スキャンは止めない)
- 照会するパッケージの数はスキャン全体で上限を設ける(例: 20万件。超えた分は`skipped_files`)
- 名前の一覧の照合はMap・Setで行う(件数に比例する時間。過去の二乗時間の指摘を踏まえる)

### 応答の変更

- `coverage`: `local_projects`(数)、`unscannable_nuget_packages`、`unresolved_package_references`を追加。`lockfile_missing`の`status`に`direct_only`を追加。`ecosystem_breakdown`に`NuGet`
- `.csproj`の下限の指定から照会したパッケージには、requirements.txtの下限と同じ`version_is_lower_bound: true`を付ける(`scan_project`・`suggest_fix`の既存のフィールド)
- 履歴: 範囲の欠けの件数に新しい一覧を加える(`historyRecord.ts`のGAP_FIELDS)
- README・ツールの説明(`scan_project`のエコシステムの一覧)・SECURITY.md(送信先)を更新

### 段階計画(推奨案)

- **v0.16.0**: 上記のスキャン(`packages.lock.json`・`project.assets.json`・`packages.config`・`*.deps.json`・`.csproj`の直接依存)と直接/推移的の区別、非公開フィードの警告
- **v0.17.0**: `suggest_fix`のNuGet対応(NuGetの版の順序: 4つ目の数・プレリリースの大文字小文字を区別しない比較・`1.0`=`1.0.0`の正規化)、`introduced_by`・`declared_in`、`dotnet add package X --version Y`の案内
- 以降(要望があれば): 中央パッケージ管理の版の解決、`packageSourceMapping`による除外

### 完了条件とテスト

- 各形式の解析: 照会する・自分のプロジェクト・照会しないものの分類、確定版の判定(`$(...)`・範囲・`*`・`[x]`・4つ目の数・プレリリース)、名前の大文字小文字、複数のフレームワークの版
- 対応付け: `packages.<名前>.lock.json`、1つのディレクトリに1つ・複数のプロジェクトがある場合の`packages.lock.json`、`NuGetLockFilePath`、`project.assets.json`の`projectPath`の一致・不一致、確認できないプロジェクトの`unconfirmed`と`complete: false`。確認できないlockfileもスキャンすること
- 優先順位: 確認済みのlockfileがあれば`project.assets.json`・`.csproj`を使わない、`project.assets.json`の古さの警告、`direct_only`
- `.csproj`: 版の指定の各形(完全一致・下限・下限を含まない範囲・`$(...)`・`*`・版なし)、`Condition`(参照・`ItemGroup`・子の`Version`)、`Choose`・`Target`の中、`Update`・`Remove`が先にも後にもある場合、重複、`VersionOverride`、`Directory.Build.props`/`.targets`の`PackageReference`
- 走査: プロジェクトのディレクトリの`bin`・`obj`は飛ばし、他のエコシステムの`bin`は飛ばさない
- 安全性: 元のファイルをosv-scannerに渡さない、XMLの`DOCTYPE`・`ENTITY`の拒否、JSON・XML・件数の上限、`nuget.config`はスキャン範囲の中だけ読む
- 実バイナリでMCP経由: 各形式で既知の脆弱性を検出し、`type: project`の同名パッケージ・未解決の版を照会しないこと。2.4.0でも同じ結果
- **実物のファイルでの確認**: 手元に.NET SDKが無いため、`dotnet restore`で生成した実物(`packages.lock.json`・`project.assets.json`・`*.deps.json`)は公開リポジトリから入手するか、利用者に用意してもらう(ダウンロードは許可を得てから)

### 実装メモ(設計からの変更点、2026-10-23)

- 構成: 各形式の解析・XMLの走査・コピー・関係は`src/utils/nugetFiles.ts`、プロジェクトとの対応付けは`src/utils/nugetProject.ts`。検出(`manifestDetector.ts`)は走査で.NETのファイルを振り分け、`analyzeNuget`の結果を`DetectedProject`の`nugetCopies`等に入れる。`scanProject.ts`がコピーを`packages.lock.json`形式で渡す
- 注意の文言は`coverage.warning`(範囲の欠けの定型文)とは別の`coverage.nuget_warnings`(配列)にした。下限・`project.assets.json`の古さ・直接依存だけの場合の確かめられない参照・非公開フィードを並べる。非公開フィードと古さは`complete`を変えない(範囲の欠けではないため)
- `nuget.config`は、プロジェクトのディレクトリから上をたどる代わりに、スキャン対象の中の全ての`nuget.config`を確かめる(注意を示す側に広い)。解釈できない`nuget.config`も注意の対象
- `Directory.Build.props`/`.targets`は、プロジェクトのディレクトリかその上(スキャン対象の中)にある全てのものの名前を使う(MSBuildが自動で読むのは最も近い1つだが、それが上位を読み込むことがあるため広く取る)。解釈できないものは`skipped_files`にし、その下の全ての参照を照会しない
- 直接の`PackageReference`が無いプロジェクトも、確認済みの情報源が無ければ`lockfile_missing`(`direct_only`)に残す(当初は雑音を避けて無視していたが、`Directory.Build.props`やSDKが参照を加える構成で欠落を隠し、別のエコシステムのlockfileが同居すると`complete: true`になった。レビュー指摘)
- **脆弱性チェック(2026-10-24)での修正**:
  - XMLの文字参照の展開(`pomParent.ts`の`decodeEntities`、.NETのXMLの走査と共用)は、Unicodeの範囲外・サロゲートの文字参照(`&#x110000;`・巨大な10進数等)を`String.fromCodePoint`にそのまま渡して例外にしていた。1つの`pom.xml`(親POMの`relativePath`)・`.csproj`等で**スキャン全体が`internal_error`**になり、同じプロジェクトの他のエコシステムも結果を返さない(リポジトリにファイルを1つ置くだけでスキャンを妨げられる)。v0.4.0〜v0.15.0の`pom.xml`に該当。範囲外は解釈できない(`undefined`)として、そのファイルだけを除外する。定義済み実体の照合を`in`から`Object.hasOwn`にし、`&constructor;`等がプロトタイプのプロパティとして展開されないようにした
  - osv-scannerに渡す.NETのコピーは1,000件まで(走査のマニフェストの上限と同じ)。コピーごとに`--lockfile`の引数になり、9,000件で引数の長さの上限(macOSのARG_MAX 1MiB)を超えてスキャン全体が`internal_error`になっていた。超えた分は`skipped_files`(マニフェストにも数えない)
  - `project.assets.json`の「古い可能性」の注意は、プロジェクトごとではなく1件にまとめる(名前は5件まで、残りは件数)。応答が際限なく大きくならないように
  - 依存: `body-parser` 2.4.0(GHSA-27r3-jxmh-p828)・`fast-uri` 3.1.9(4件)にロックファイルだけ更新(MCP SDK経由。配布物にロックファイルは含まれない)
- `*.deps.json`のランタイムパックは、SDKがライブラリ名に`runtimepack.`を付ける(`runtimepack.Microsoft.NETCore.App.Runtime.linux-x64/8.0.0`)。接頭辞を除いて照会する(付けたままではOSVで0件、正しい名前で12件。当初のテストの入力は接頭辞の無い形で、実際の形と違っていた。レビュー指摘)
- `NuGetLockFilePath`のあるプロジェクトは、既定の名前・名前付き(`packages.<名前>.lock.json`)のどちらのlockfileとも対応付けない(当初は名前付きの判定で先に返し、別の保存先を指定したプロジェクトが古い名前付きlockfileで確認済みになっていた。レビュー指摘)
- `.csproj`を直接指定した場合は、他のマーカー(`package.json`等)と同じく、そのディレクトリを走査する
- `packages.config`の`developmentDependency`による`dependency_groups: ["dev"]`は見送り(`dependency_groups`はosv-scannerの出力をそのまま返す項目で、本サーバーが付ける仕組みが無い)
- 下限の印: 同じ名前・版を別のファイルで確定版として照会した場合は付けない(確定版の結果が実在を示すため)
- 名前に`;`区切りの複数の指定(`Include="A;B"`)を扱う。`$(...)`・ワイルドカードを含む名前は照会せず(理由`property`)、`Update`・`Remove`の名前にあれば全ての名前を照会しない
- 確認: 単体・統合のテスト(70件)、変異確認(対応付けの各規則・Conditionの親・Update・下限・deps.jsonのproject・DOCTYPE・bin/objの除外・下限の表示・関係の直接優先・非公開フィード・別の版の別グループの13通りと、レビュー指摘の修正3件(`runtimepack.`の接頭辞・名前付きlockfileの`NuGetLockFilePath`・参照の無いプロジェクトの欠け)で、追加したテストが失敗する)。MCP経由で実バイナリ(2.7.0)に複数の形式を混ぜた構成を渡し、対応付け・未解決の理由・`bin`の除外が設計どおりであることを確認
- **実物での確認(2026-10-23)**: 公開リポジトリの実物7件(Project-MONAI/monai-deploy-informatics-gatewayの`packages.lock.json`と`.csproj`、EasyPost/easypost-csharpの`packages.lock.json`(6つのフレームワーク)と`.csproj`、Tophness/StickyMouseの`obj/project.assets.json`と`.csproj`、bitmono-project/BitMonoの`*.deps.json`。利用者の許可を得てダウンロード、作業用の領域のみ)で確認。コピーのパッケージは、osv-scannerが元のファイルから読む全パッケージ(`--all-packages`)から自分のプロジェクトだけを除いたものと一致した(MONAI: 43件中`Project`の1件、BitMono: 16件中`type: project`の4件(`Echo`等。osv-scannerだけではNuGetとして照会される))。StickyMouseの`projectPath`(Windowsのパス)で対応付けできた
- 実物の確認で判明: ダウンロード(`git clone`も同じ)はファイルを任意の順に書くため、更新日時のわずかな差で`project.assets.json`を古いと誤って示した。差が60秒を超える場合だけ示す

## NuGetの修正提案(2026-10-26、ソース実装)

- `nugetVersion.ts`と`versionScheme.ts`でNuGet VersionReleaseの比較を追加。1〜4個の数値部、ゼロ埋めによる正規化、4つ目のrevision、プレリリースの大文字小文字を区別しない比較、メタデータの無視。純数字のプレリリース識別子の先頭ゼロや解釈できない境界は推奨の根拠にしない。IDの照合は大文字小文字を区別しない。
- `suggest_fix`は既存の影響範囲検証・候補のOSV再照会を利用する。NuGetの範囲はECOSYSTEM型。情報不足なら保留し、修正版なし・照会失敗・conflictは既存の区別を維持する。
- 更新案内は直接/推移的依存・中央管理とランタイムパックで分ける。`.csproj`の下限から検査した場合は`version_is_lower_bound`を維持し、requirements.txtではなくPackageReferenceの下限であると示す。互換性・制約の充足や実際の復元版は保証せず、dotnet/MSBuildを実行しない。
- MCPと実際のOSV-Scanner 2.7.0で、lockfile・assets・packages.config・deps.json・直接参照のみ・不正XML混在・ランタイムパックの7ケースを確認。Newtonsoft.Json 12.0.1 → 13.0.1、Microsoft.NETCore.App.Runtime.linux-x64 8.0.0 → 8.0.32。候補のOSV再照会はいずれもclean。検証用ファイルは不変。
- `introduced_by`/`declared_in`の拡張と復元の実行はこの実装に含めない。パッケージの推奨版はNuGetフィードでの存在確認や対象TFM/RIDでの復元を代替しない。リリース番号は変更しない。

## Composerの依存関係(2026-10-26、ソース実装)

- lockfileと同じディレクトリのcomposer.jsonを安全に一度読み、require/require-devを直接依存とする。lockfileの各パッケージのrequireをたどり、到達する依存にintroduced_byを付ける。依存パッケージのrequire-dev/suggest/conflictはたどらない。直接宣言はプロジェクト相対のcomposer.jsonをdeclared_inに示す(推移的依存に直接宣言は付けない)。同じ依存が直接かつ別ルート由来ならdirectとintroduced_byを併記。
- 名前の重複、provide/replaceにより曖昧な参照、仮想依存、到達できない依存は推測しない。制約の充足やlockfileの鮮度を検証するソルバーではない。循環は訪問済み集合で止め、全Composerファイルで共有する2,000,000操作の予算を超えた解析はunknown。introduced_byは既存の10件/省略数の上限に従う。
- path/branch依存はグラフの中継点にはなるが、スキャナー入力には引き続き含めない。pathのURLや依存パッケージの実ファイルをたどらない。composer.jsonは4MiBまでで、入力・JSON予算をComposer全体で共有する。無い/読めない/解釈できない場合は関係だけunknownとし、lockfileの検査は継続する。
- scan_project/suggest_fixとも同じ捕捉済みグラフを使う。Composerの更新案内は直接依存のdeclared_in、推移的依存のintroduced_byに合わせる。
- MCPとOSV-Scanner 2.7.0で、symfony/http-kernel v5.4.0(直接) → symfony/http-foundation v5.4.0(推移的)、開発依存のsymfony/process v5.4.0(直接)を確認。修正提案は順に5.4.20/5.4.50/5.4.51、候補照会は全てclean。検証用ファイルは不変。

## NuGetの導入元・宣言元(2026-10-27、ソース実装)

- packages.lock.jsonはTFM/RIDごとのdependencies、project.assets.json/deps.jsonはtargetsごとのグラフを保存し、DirectなNuGet依存から到達するパッケージへintroduced_byを付ける。deps.jsonは依存先の正規化した確定版も照合する。ターゲット間で辺をつなげず、報告する同じ名前・版ごとに導入元をまとめる。循環、複数ルート、大文字小文字、4桁・メタデータ等の版の正規化を扱い、曖昧な名前や不正な根は推測しない。
- declared_inは既存の安全な読み取り・プロジェクト対応付けで所有者が一意に決まり、捕捉済みプロジェクトに無条件・重複なし・除去/上書きなしのPackageReferenceがある直接依存だけに付ける。復元結果のある参照ではproperty/range/floating/central managementの版でも名前を確認できれば宣言元は示せる。バージョンの格納先やMSBuild評価の結果までは示さない。
- packages.configや単独のビルド成果物から宣言元を推測しない。復元情報中のprojectPathをたどって外部ファイルを読まない。直接参照のみの検査ではdeclared_inと下限の注記/coverageを維持する。中央管理の版や条件付き参照の解決、ProjectReferenceの導入元判定は行わない。
- 関係解析は全NuGetファイルで2,000,000操作の予算を共有し、上限時は不確実な導入元/宣言元を省略して警告する。既存の検査対象・直接/推移的判定は維持し、graphsはosv-scanner用コピーに書かない。suggest_fixは宣言元ファイル/導入元パッケージを更新案内に使う。
- 実際のOSV-Scanner 2.7.0とMCPでlock/assets/deps/直接参照のみの4プロジェクト×2ツールを確認。Newtonsoft.Json.Bson → Newtonsoft.Json 12.0.1の導入元、System.Net.Http 4.3.0の宣言元を表示し、修正提案13.0.1/4.3.4の候補照会はいずれもclean。depsでは宣言元を省略し、直接参照のみのcoverage=falseを維持。検証用ファイルは不変。

## pnpmの依存関係(2026-10-27、ソース実装)

- `pnpmRelations.ts`でlockfile形式5.3/5.4/6.0/9.0を解析。5.x/6.xのpackages、9.0のsnapshotsを別々の確定ノードとして扱い、peerコンテキストを省略して辺をつながない。importers(旧形式の単独ルートも対応)のdependencies/devDependencies/optionalDependenciesが直接依存、dependencies/optionalDependenciesの到達先が推移的依存。別名・scope付きID・循環・複数ルートを扱い、同じ名前/版は直接優先で統合する。
- declared_inはlockfile内のimporterが宣言するpackage.jsonの相対パス(現在の実ファイルの内容との照合ではない)。introduced_byは到達元の直接依存名で、既存の10件/省略数制限を使う。ローカルリンクやGit参照をたどらず、未解決・曖昧な参照・未到達ノードはunknown。workspaceのlock収録確認は今回拡張せず、既存のunconfirmed/coverageを維持。
- YAML依存を追加。捕捉済みコピーだけを最大16MiB、既存の関係解析全体の読み取り予算内で読む。行数20万、インデント256、flow入れ子128の保守的な事前制限。重複キー・alias展開・複数文書・未知の形式は解析しない。ノード/辺/起点走査・結果統合に1ファイル200万操作の上限を設け、上限時は関係全体をunknownにして脆弱性スキャンを継続する。
- 両ツールで宣言元・導入元を付加し、npmの更新案内はpnpmでも誤ったoverride配置を指示しないよう、利用するパッケージマネージャーのルートoverride設定を案内する。pnpmや依存スクリプトはスキャン時に実行しない。
- **脆弱性チェック(2026-10-27)での修正**: yamlの`parseDocument`は大きなマップの組み立てが二次時間で(新しいキーごとに既存のキーを線形に探す)、0.4MiBで128ms、1.6MiBで1.3秒、上限内の5.5MiB(28,000パッケージ)で11秒、同期的にサーバーが止まった。大きなmonorepoの実際のlockfileでも数秒止まりうる。構文木(`Parser`。線形時間)から文字列・マップ・配列だけを原型の無いオブジェクトに変換するようにした(5.5MiBで0.9秒)。anchor・alias・tag・ディレクティブ・複数文書は字句の段階で拒否し、重複キー・解釈できない構文はnull。従来は`!!str`等のタグを受け入れていた。作業量の上限はスキャン全体で共有する(従来は1ファイルごと)
- pnpm 7.33.7/8.15.9/9.15.9自身が生成した形式5.4/6.0/9.0のworkspaceプロジェクトで、OSV-Scanner 2.7.0をMCP経由で実行(3形式×2ツール)。express 4.17.1/lodash 4.17.20はpackage.json、開発依存minimist 1.2.5はapps/web/package.jsonをdeclared_inに表示。qs 6.7.0はtransitive、introduced_by=[express]。修正候補express 4.20.0/lodash 4.18.0/minimist 1.2.6/qs 6.16.0のOSV再照会はいずれもclean。ロックファイル不変、coverage.complete=false(workspaceの収録未確認)を維持。

## pnpm workspaceの収録確認(2026-10-27、ソース実装)

- 形式5.3/5.4/6.0/9.0のimportersを、上位lockfileの位置から見た子package.jsonのディレクトリと完全一致で照合。日本語/空白・空のimporterも収録とし、確認済みはlockfile_missingから外す。未収録はmissing、形式不明/解析不能/重複や曖昧なパス/予算超過はunconfirmed。importerの配下全体や同名packageによる推測はしない。5.xの単独プロジェクト形式は子を収録しない。
- PnpmLockCacheで1件16MiB/合計64MiB、安全な読み込みと既存の線形時間YAML解析を共有。解析/索引に全pnpmファイル共有200万操作の予算を使い、同じlockfileの読み込みと収録解析は1回。収録確認に使った元の内容をpnpmCopiesへ保持し、両ツールとも同じ捕捉済みの内容をスキャンする。読めない/サイズ超過のlockfileは理由付きでskipped_filesへ。スキャン範囲の外の上位lockfileやworkspace設定を探しに行かず、pnpmや依存コードを実行しない。
- importerの存在はlockfileへの収録の根拠であり、現在のpackage.jsonとの一致や鮮度、pnpm-workspace.yamlの再評価ではない。他の欠落があればcoverage.complete=falseを維持する。
- 実接続: pnpm 7/8/9が生成した既知の脆弱性を含むworkspaceの3形式×2ツールでcoverage.complete=trueを確認。子importerだけを外した構成×2ツールではapps/web/package.jsonがmissingでcomplete=false。lodash/minimist/qs等の脆弱性検出と修正候補のOSV再照会(clean)を維持し、検証用lockfileは不変。未収録/解析不能/範囲外/正規化後の重複/読み込み・作業予算/捕捉後の変更は自動テストでも確認。

## Yarnの依存関係・workspace収録確認(2026-10-27、ソース実装)

- Classic v1は専用の行解析、Berryは既存の線形時間・予算付きYAML走査を共用(__metadata.version 4/5/6/8)。descriptorを完全一致で解決し、dependencies/optionalDependenciesをたどる。root/workspaceの直接依存を起点とし、introduced_byとdeclared_inを既存の応答へ反映。複数selector・scope/npm alias・循環・複数起点・直接優先を扱う。ローカル/Git/patch/portal/virtual等の未対応IDを同名レジストリ版として推測しない。
- Classicはlockfileにworkspace一覧が無いため、捕捉したprivateルートpackage.jsonのworkspaces配列/object.packagesと子の依存descriptorの収録を確認。ローカルworkspaceは名前が一意で設定内にあり、捕捉した版が要求範囲を満たす場合だけ確認(semverを依存追加)。Berryはworkspace:の正規化したパスを照合し、捕捉した宣言とも照合。未収録はmissing、不明・曖昧・予算超過はunconfirmed。*, ?, セグメント単位**、除外、日本語/空白のパスに対応し、brace/extglob/文字クラス等は推測しない。
- YarnLockCacheでlockfileとpackage.jsonを1回捕捉し、coverage・関係解析・スキャンの入力を一致させる。lockfile 16MiB/件・64MiB合計、manifest 4MiB/件・64MiB合計とJSON構造予算。全Yarnファイルでparse/graph/glob等の200万操作の予算を共有する。対象外のパスやlockfile内の参照をたどらず、Yarn・依存スクリプト・plugin・設定を実行しない。構文/形式/制約を扱えなければ関係unknown・収録unconfirmed、読み込み失敗/サイズ超過は理由付きでskipped_files。
- Berryの宣言元はlockfileのworkspaceエントリから示せる。Classicの直接指定lockfileで子manifestを捕捉していない場合、その子の関係は推測しない。peer依存のインストールやconstraints/resolutionsの再評価、lockfileの鮮度・互換性の保証はしない。
- レビュー修正(2026-10-27): 関係の解析(直接依存の数×パッケージ数で増える)と収録確認が同じ予算で、5,000パッケージ×直接依存500(1MB)で予算を超えると収録まで全てunconfirmedになっていた。解析・収録確認と関係の解析の予算を分け(各200万、スキャン全体で共有)、関係の予算超過では関係だけunknownにし、確認済みの収録を保つ。workspacesの末尾の/はYarnと同じく1つ取り除き(以前はmissing)、他の空セグメントはunconfirmed。
- 実接続: Yarn 1.22.22/4.9.2自身が生成した既知の脆弱性を含むworkspaceでOSV-Scanner 2.7.0をMCP経由で実行。両形式で収録済み/未収録/確認不能の3構成×2ツール(計12回)を確認し、complete=true/missing(false)/unconfirmed(false)を検証。express 4.17.1とlodash 4.17.20はpackage.json、minimist 1.2.5はapps/日本語 app/package.jsonの直接依存。qs 6.7.0はexpress由来の推移的依存。修正候補4.20.0/4.18.0/1.2.6/6.16.0はいずれもOSV再照会clean。検証用lockfile不変。

## Bunの依存関係・workspace収録確認(2026-10-28、ソース実装)

- テキストbun.lockのJSONC形式0/1/2に対応。jsonc-parserのvisitorでコメント/末尾カンマを扱い、構文エラー・重複キー・深さ128超過を値の構築中に拒否。1件16MiB・合計64MiB。構文/索引/関係ごとに全Bunファイルで共有する200万操作の予算を使い、関係の上限で確認済みのcoverageをunconfirmedにしない。
- 捕捉済みworkspacesのdependencies/devDependencies/optionalDependencies/インストール済みpeerを直接依存とし、packagesの配置を親へたどって依存先を解決。scope付きの名前を1単位として扱い、入れ子の複数版とnpm aliasを区別。INFOのdependencies/optionalDependencies/配置のあるpeerをたどってintroduced_byを付加し、直接依存はlocked workspaceのpackage.jsonをdeclared_inに表示。直接優先・複数ルート・循環を扱う。optionalの同名上書きとunresolvedを尊重し、ローカル/Git/tarballの実ファイルを読まず同名公開版へフォールバックしない。
- workspaceはlockfileからの正規化した相対パスを完全一致で照合。収録済みはlockfile_missingから外し、未収録はmissing、不正/未知/解析上限はunconfirmed。日本語/空白・空のworkspaceにも対応。BunLockCacheで1回捕捉した内容をcoverage・関係解析・両ツールのスキャンに共用し、元ファイルの差し替えの影響を防ぐ。読み込み不可/サイズ超過は理由付きでskipped_files。Bun/依存コードはスキャン時に実行せず、bun.lockb・現在のpackage.jsonとの一致/鮮度検証は対象外。
- レビュー修正(2026-10-28、pnpm/Yarn/Bun共通): 解析の予算(200万操作)をスキャン全体で共有していたため、pnpm/Yarn Berryは合計約7.5MiB(262/254操作/KiB)、Bunは約13.6MiB(143操作/KiB)で尽き、読み込み上限(1件16MiB・合計64MiB)の範囲のlockfileでも収録がunconfirmed・関係unknownになっていた(複数プロジェクトを含むディレクトリのスキャンで後のlockfileほど影響)。解析は入力に比例し読み込み上限で有界なので、lockfileごとに大きさに応じた予算(1,024操作/KiB、最低200万。密なpnpmで実測441操作/KiB)を使う(`createParseBudget`)。収録の索引・関係の走査は従来どおりスキャン全体で共有。pnpm/Yarnの20万行の事前制限も約6MiBで16MiBより先に効いていたため100万行に上げた。15.8MiBのpnpmで解析3.2秒、15.5MiBのYarn Berryで2.9秒、15.9MiBのBunで0.3秒(いずれも収録確認済み)。pnpmは収録確認と関係の解析で同じlockfileを2回解析する(今後の改善候補)。
- 今後の改善候補: 関係の走査は直接依存ごとに到達先をたどるため、1万パッケージ×直接依存200程度で関係の予算を超えunknownになる(pnpm/Yarn/Bun共通、収録には影響しない)。到達先の再利用で改善できる。
- Bun 1.4.4(形式2)と1.2.23(形式1)自身が生成した既知の脆弱性を含むworkspaceで、OSV-Scanner 2.7.0をMCP経由で実行。収録済み2形式・未収録・確認不能の4構成×2ツールを確認。express 4.17.1/lodash 4.17.20はpackage.json、minimist 1.2.5はapps/日本語 app/package.jsonの直接依存、qs 6.7.0はexpress由来の推移的依存。修正候補4.20.0/4.18.0/1.2.6/6.16.1はいずれもOSV再照会clean。complete=true/missing(false)/unconfirmed(false)を検証し、検証用lockfile不変。

## uvの依存関係・workspace収録確認(2026-10-28、ソース実装)

- uv.lock version=1/revision=0〜5をTOML解析。捕捉済みeditable/virtual/directoryパッケージとmanifest.membersからworkspaceを対応付け、ローカルrootの通常/optional/dev依存を直接依存にする。declared_inはlocked pathのpyproject.toml。名前はPEP 503、依存参照の明示版はPEP 440で比較し、版/取得元で一意に特定できない参照は推測しない。
- introduced_byは直接依存からの到達元。optional edgeは要求されたextraだけをたどり、レジストリ依存のdevグループをたどらない。同一経路で異なるmarker式を結合せず、解決できない条件はunknown。Python/OS/環境の評価や依存ソルバーは実行しない。ワークスペースの全optional/dev宣言はuniversal lockfileのスキャン範囲として扱う。ローカルpathは中継できるが実ファイルは読まず、workspace外の同名path依存で収録を推測しない。
- 子pyproject.tomlが収録済みならlockfile_missingから除外、未収録はmissing、名前/パスの曖昧さやmanifest未記録等はunconfirmed。legacy setup.py/setup.cfg/Pipfileをuvのworkspaceと推測しない。現在のpyprojectとの一致/鮮度確認は対象外。UvLockCacheで安全に1回捕捉した内容をcoverage・関係・スキャンへ共用し、uvやbuild backendをスキャン時に実行しない。
- smol-tomlを追加し、パーサーの前に文字列/コメントを区別して深さ128・行中の引用外dot128・構造記号100万で制限。1件16MiB/合計64MiB。workspace索引と関係の予算200万をそれぞれ全uvファイルで共有し、関係の上限で確認済みcoverageを崩さない。未知/構文不明は関係unknown/収録unconfirmed、読み込み不可/サイズ超過はskipped_files。
- 実接続: uv 0.12.23自身が--no-build/--no-python-downloadsで生成したworkspaceで、OSV-Scanner 2.7.0をMCP経由で実行。収録済み/未収録/確認不能×2ツール(計6回)を確認。requests 2.25.0はpyproject.toml、jinja2 3.1.4はapps/日本語 app/pyproject.tomlの直接依存(開発グループ)、urllib3 1.26.20はrequests由来の推移的依存。候補requests 2.33.0/jinja2 3.1.6/urllib3 2.8.0はいずれもOSV再照会clean。complete=true/missing(false)/unconfirmed(false)、lockfile不変を検証。
- レビュー修正(2026-10-28): (1) 複数メンバーが同じ依存を同じextra/markerで宣言すると起点ごとに同じ到達先を再走査し、2,000パッケージ×共通直接依存30でメンバー5件から関係の予算(200万)を超えunknownになっていた。起点を(パッケージ, extra, marker)で一意にして1回だけたどる(declared_inは宣言ファイルごとに維持)。(2) 構造記号の上限が固定100万で、依存の密な約7MiBのlockfileを解析せず収録unconfirmed・関係unknownになっていた。他形式と同じくファイルごとの予算(createParseBudget、1KiBあたり1,024・最低200万)にした。(3) manifest.membersにないローカルパッケージ(path依存など)をmissingとしていた。lockfileに記録され実行時依存はスキャンされるため、Cargoのpath依存と同じくunconfirmedにする。lockfileにない子は従来どおりmissing。

## Poetryの依存関係・子プロジェクトの収録確認(2026-10-28、ソース実装)

- poetry.lock lock-version 1.1/2.0/2.1をboundedToml(uvと共通の事前制限+smol-toml)で解析。Poetryにはworkspaceがないため、root pyproject.tomlから到達できるpath依存(source.type=directory、lockのディレクトリ内の安全な相対パス)を子として対応付ける。子は名前/版の一意一致、動的dependenciesなし、開発グループなし(path依存では書き出されない)、宣言がすべてlockのedgeと一致する場合だけ収録済み。lockにない子はmissing、曖昧/確認不能はunconfirmed。
- 直接依存はrootの通常/optional/dev/group/PEP 735グループと、収録済みの子の実行時宣言。introduced_byは無条件の文字列edgeだけをたどり、markers/extras/optionalのテーブルはソルバーが要るため未解決(unknown)。名前はPEP 503、版はPEP 440。Poetry・プラグイン・build backendは実行しない。lockは1回捕捉してcoverage・関係・スキャンに共用(1件16MiB/合計64MiB)、companionのpyproject.tomlは別枠(1件4MiB/合計64MiB)。収録と関係の予算(各200万)は別で、関係の上限で確認済みの収録を崩さない。
- 挙動の変化: 16MiBを超えるpoetry.lockはskipped_files。path依存でない入れ子のpyproject.toml(例やテスト用など)はunconfirmedからmissingになる。
- レビュー修正(2026-10-28): Poetryはpath依存のedgeを常にテーブル({path, develop})で書くため、文字列edgeだけを受け付ける判定で、兄弟の子へのpath依存(../core)を持つ子が収録unconfirmedになり、その宣言も直接依存にならなかった(ローカルパスの比較が到達不能)。宣言のパスを子のディレクトリから解決してlockのディレクトリ内に収め、無条件の{path, develop}テーブルで同じ場所を指すedgeを一致とする。markers等の付いたedgeや別の場所は従来どおりunconfirmed。
- 実接続: 手書きのroot+libs/core(path依存)のPoetryプロジェクトで、OSV-Scanner 2.7.0をMCP経由で実行。complete=true、requests 2.25.0はpyproject.toml、jinja2 3.1.4はlibs/core/pyproject.tomlの直接依存、urllib3 1.26.4はrequests由来の推移的依存。

## PDMの依存関係・子プロジェクトの収録確認(2026-10-28、ソース実装)

- pdm.lock lock_version 4.0〜4.4・4.5.0/4.5.1をboundedTomlで解析。子は`[tool.pdm.workspace].members`のパターン(完全一致・*・?・セグメント全体の**)、またはrootから到達できる明示的なpath依存(`file:///${PROJECT_ROOT}/...`、PDMが書くeditableの`-e ...#egg=name`)で、lockの安全な`path`と一致する場合だけ対象。名前だけでは収録としない。子の名前/版、実行時/optional宣言がlockの一意な依存と一致し、開発グループ・動的dependenciesがない場合だけ収録済み。lockにない子はmissing、曖昧/確認不能はunconfirmed。
- 直接依存はmetadata.groupsで選ばれたrootのグループ(通常/optional/PEP 735/tool.pdm.dev-dependencies、include-group展開)と収録済みの子の実行時宣言。extrasは別の同一性として厳密に扱い、markerは評価せず同一経路で異なる式を結合しない。PDM・プラグイン・build backendは実行しない。lockは1回捕捉(1件16MiB/合計64MiB)、companionは別枠(1件4MiB/合計64MiB)。収録と関係の予算(各200万)は別。
- 挙動の変化: 16MiBを超えるpdm.lockはskipped_files。含まれない入れ子のpyproject.tomlはunconfirmedからmissingになる。
- レビュー修正(2026-10-28): PDMはlockにローカルパッケージの依存をpackaging経由で書くため、指定子は並べ替え(`<1.27,>=1.21.1`)、markerは二重引用符になる。子の宣言との比較が文字列の完全一致で、範囲指定やプラットフォーム条件を持つ子が収録unconfirmedになっていた。解析時に指定子を並べ替え、markerの引用符を二重引用符に揃え、引用外の空白を除いて比較する。論理式の書き換え(and/orの順序等)は解かずunconfirmedのまま。PDM自身が生成したlockでの確認はPDM未導入のため未実施。
- 実接続: 手書きのroot+packages/api(path依存)のPDMプロジェクトで、OSV-Scanner 2.7.0をMCP経由で実行。complete=true、requests 2.25.0はpyproject.toml、jinja2 3.1.4はpackages/api/pyproject.tomlの直接依存、urllib3 1.26.4はrequests由来の推移的依存。

- marker正規化のレビュー修正(2026-10-28): 引用符を一律に置換すると、引用符・andを含む単一リテラルが複合条件と衝突し、子の収録や推移的依存の経路を誤って一致とした。リテラル・識別子・演算子を型付きトークン列としてJSON化し、リテラル内容とトークン境界を保持する。引用符の種類と引用外の空白だけを同一視し、閉じていない引用符は未確認とする。収録判定・経路の結合・両ツールのcoverageに回帰テストを追加。

## Pipenvの依存関係・子プロジェクトの収録確認(2026-10-31、ソース実装)

- Pipfile.lock spec 6と捕捉したPipfileを照合。packages/default・dev-packages/develop・カスタムカテゴリの直接依存をdeclared_in=Pipfileとして示す。確認済みpath依存の子pyproject.tomlの実行時宣言も直接依存。カテゴリの宣言が全て収録されていれば残りのレジストリ版は推移的依存。lockがフラットで依存辺を持たないため、introduced_byは有効な直接ルートが一意のカテゴリだけで確定し、複数候補は推測しない。
- 子は宣言とlockの安全な相対path・名前が一致し、静的実行時依存が同一カテゴリの固定版で満たされる場合のみ収録済み。未収録はmissing、動的依存・開発グループ・未対応制約・markers/extras・旧backend宣言等はunconfirmed。子Pipfileはpath依存からexportされず、独立した環境としてunconfirmed。lockの鮮度・ローカル版・backend生成メタデータの同一性は保証しない。
- JSONは重複キー/深さ/作業量を制限。lock捕捉16MiB/件・64MiB/scan、companion4MiB/件・別枠64MiB。coverage/関係の作業量は各200万。Pipenv/Python/backendはスキャン時に実行しない。
- OSV-Scanner 2.7.0はカスタムカテゴリを直接読まないことを実接続で確認。カテゴリを別のdefaultカテゴリ一時コピーにして照会する(元のファイルは変更せず、別枠64MiB/200コピーまで)。上限超過・解釈できないカスタム情報はskipped_filesとしてcoverage不完全。
- 実接続: Pipenv 2026.10.4生成のroot+日本語名path依存。requests 2.25.0はPipfile、jinja2 3.1.4は子pyproject.tomlの直接依存。urllib3 1.26.20はrequests由来の推移的依存。scan_project/suggest_fix、候補のOSV再照会cleanを確認。未収録/未対応メタデータ/子の開発グループ/カスタムカテゴリも確認。空白を含むeditableパスではPipenv自身のlock生成が失敗したため、実接続は空白なしの日本語パスで実施し、空白・日本語の解析は回帰テストで確認。

- Pipenvレビュー修正(2026-10-31): 子のPoetry形式のgroup.*.dependencies/旧dev-dependencies/include-groupsも検出し、上位lockでは開発用依存が収録されたと確認できないためunconfirmedとする。空のdevテーブルは依存なしとして扱う。カスタムカテゴリの一時コピーには元カテゴリ名を保持し、既存のscannerグループと併合してscan_project/suggest_fixのdependency_groupsに戻す。両ツールに回帰テストを追加。

- Pipenv introduced_byのレビュー修正(2026-10-31): 同じ名前・版の結果をカテゴリ間で併合する際、根が一意のカテゴリの由来だけが残り、別カテゴリ(根が複数・宣言が不完全)の未確定の由来が欠けたまま一意に見えた(default: requests由来、develop: pytest/botocoreの2根でintroduced_by=[requests]、suggest_fixのhintもrequestsの更新を案内)。宣言せずに収録するカテゴリのいずれかで由来を一意に決められなければintroduced_byを出さない。全カテゴリで同じ一意の根なら保持、直接依存との重なり(直接+一意の由来)は従来どおり。両ツールに回帰テストを追加。

## ファイル間のintroduced_byの併合(2026-10-31)

- 同じ名前・版のパッケージを複数のlockfileで検出した場合、`combineRelations`が各ファイルのintroducedByの和集合をとり、由来を示せないファイル(推移的で由来未確定・解析不能のunknown)の欠けが失われていた。例: root Pipfile.lockはrequests由来、svc/Pipfile.lockは2根で由来未確定でも`introduced_by: ["requests"]`。片方が読めない(unknown)場合も`mixed`で同じ一覧。
- 直接依存以外で由来を示せないファイルが1つでもあればintroduced_by(・omitted)を出さない。直接依存の由来なしは欠けとしない。dependency_relation(mixed含む)は従来どおり。npm系・Python lockfile全般に適用され、由来を出さないpom.xml・go.mod単独の出力は変わらない。両ツールに入力順を入れ替えた回帰テストを追加。
- declared_inの併合も修正(2026-10-31): Gradleフラグの有無に依存せず全形式へ適用する。directで宣言元が未提供／空、unknown、明示的なdeclaredInComplete=false、Cargoの未対応declaringCratesのいずれかがあれば一覧全体を省略する。確定したtransitiveの宣言元なしは「直接宣言なし」なので欠けにしない。由来の完全性とは独立に判定する。
- sourceごとにpathをproject相対へ直してから併合し、同一ファイルの複数結果でも完全性はANDで保持する。relationのdirect優先でunknownの欠けを消さない。完全なpathは重複除去・ソートして保持する。脆弱性coverageとdependency_relationは従来どおり。

### 既存形式の宣言元一覧の扱い

完全性は、既存の各形式の解析が返す宣言元情報に基づく。新たなDSL解析や宣言元の取得機能を追加する変更ではない。既定の更新先ファイル名と、全宣言元を確認した一覧を区別する。

| 形式 | 宣言元の根拠・未提供の意味 |
|---|---|
| npm v2+／pnpm／Yarn／Bun | lockのroot/importer/workspaceと対応するpackage.json。既存解析が返すdirectの非空集合は保持し、v1／非対応／解析不能はunknownとして一覧を抑制 |
| uv／Poetry／PDM／Pipenv | 対応可能な宣言・メンバーとの照合で得たpyproject.toml／Pipfile。declared_inを返さないdirect／unknownを、他ファイルの既知pathで埋めない |
| Composer | companion composer.jsonのrequire／require-dev。対応できないsourceの既定ファイル名を補完しない |
| Cargo | 全declaring crateをCargo.tomlへ一意に対応付けられる場合のみ完全。未対応crateがあれば全pathを抑制し、declaring_cratesは未対応crateの診断として保持。修正案内は「全宣言元ファイル（未対応crateを含む）」とし、未対応crateだけを全更新対象に見せない |
| NuGet | sourceの所有projectとの一意な対応とPackageReferenceの確認に基づく。未対応lock／deps／曖昧な所有元は、単にprojectファイルがありそうという理由で補完しない |
| Maven POM | directでも親POM・profile等の物理宣言元を確定していないため一覧未提供。root pom.xmlを宣言元と推測しない |
| requirements.txt | includeを展開したコピーに物理的な行の出所を保持していないため、directでも一覧未提供。取り込み元requirements.txtを全宣言の場所と推測しない |
| go.mod | 既定の更新先は既知だが、現行APIではdeclared_inを提供しない。directの一覧未提供を「宣言なしの完全な空集合」とは扱わず、Goの既存更新案内を維持 |
| Gradle Stage B | directの物理宣言元は未提供として不完全。確定したtransitiveは直接宣言なし。既存の明示的な不完全性フラグも保持 |

- 回帰テスト: Rustの一部未対応／NuGetの所有元未確認／uvと取り込みrequirementsの併合／npmの完全・推移的・unknown混在をscan_projectとsuggest_fixで確認。入力順逆転、同一ファイルのdirect優先、完全な和集合・重複除去、明示的な不完全性、introduced_byとの独立性、coverage維持も確認する。
- 検証結果: Gradle 8.11.1の実export回帰9件を含め、全67ファイル・1,430テストが通過。typecheck・buildも成功。

## 正規表現の後戻りによる停止の修正(2026-11-20、脆弱性チェック)

- スキャン対象の値で、正規表現の後戻りが二乗・三乗に増え、サーバーのイベントループを止めていた。正規表現は途中で止められないため、スキャンのタイムアウトも効かず、その間は他のツール呼び出しにも応答しない。悪意のあるリポジトリを1つスキャンさせるだけで起きる(情報の漏えい・コードの実行は無い)
- 原因は2種類:
  - `pom.xml`の`<relativePath>`の前後の空白の除去(`/^[ \t\n]+|[ \t\n]+$/g`)が、空白の連続の各位置から照合し直していた。100 KBで約4秒、上限の10 MiBでは数時間。位置を数えるループにした(結果は同じ)
  - 行を`\n`だけで分けるため、行の途中に単独の`\r`やU+2028/U+2029が残り、`.`がそれらに一致しないことで`.*$`の照合が失敗するたびに後戻りしていた。`requirements.txt`(100 KBの1行で数秒、上限の1 MiBでは数分)、`go.mod`の`require`/`replace`、`Cargo.lock`/`Cargo.toml`のキーと値、`yarn.lock`(Classic)の値、`pdm.lock`の要求(`-e`の形は三乗で、4,000文字で約12秒)
- 修正:
  - `requirements.txt`は`.*`を含む正規表現にsフラグを付けた。Goの`.`と同じく改行以外のすべての文字に一致する。単独の`\r`の後ろもコメントとして除くようになった(以前は除かずに「解釈できない行」になっていた)。それらの文字は名前・版の検証を通らないため、コピーには書かれない
  - `go.mod`・`Cargo`・`yarn.lock`は`(?=(\s*))\N`で空白を後戻りしない形で読む。一致する入力と取り出す値は変わらない
  - `pdm.lock`は、改行・単独の`\r`・U+2028/U+2029を含む要求を解釈しない(PDMはこれらを書かない)
- 回帰テスト`src/test/utils/regexBacktracking.test.ts`(13件)。修正前のコードでは、縮小した入力でも7件が失敗した(各4秒前後)。`pdm.lock`は3,000文字で4.4秒
- 他の約25の正規表現(版・名前・pnpmのキー・yarnの記述子・NuGetの範囲等)は、同じ形の入力で2 ms以下だった
- Gradleの実時間診断を修正後の `a6f5d2a` で再測定（2026-11-20）。C3b-3／C3b-4の両記録で `cargoLock.ts`・`dependencyRelations.ts` のSHA-256を更新し、旧値と検証結果を `sourceRemeasurements` に追記した。macOS arm64・Node v26.12.1で実行時の観測結果が既存記録と一致し、実時間診断は3ファイル・8件すべて通過した。[C3b-3の記録](validation/gradle-independent-currentness-c3b3-2026-11-04.json)、[C3b-4の記録](validation/gradle-independent-currentness-c3b4-2026-11-04.json)

## 軽微な指摘の修正(2026-11-20、脆弱性チェック)

- **読めないディレクトリ**: 走査(`projectWalk.ts`)はOSの権限不足等で読めないディレクトリを黙って飛ばし、配下のマニフェストが欠けても`coverage.complete: true`になっていた(展開したアーカイブの権限0のディレクトリに脆弱なlockfileを置くと、0件・範囲完全と応答する)。走査は続け、`scan_project`は`skipped_files`、`scan_java_project`は`skipped_manifests`に、ディレクトリと理由を並べる。マニフェストが1件も無い場合は`no_manifest_found`の理由に含める。Nodeの権限モデルの拒否は従来どおりエラー
- **巨大なディレクトリ**: 一覧全体(`readdir`)をメモリに読み込んでからエントリ数の上限を確かめていた。`opendir`で1件ずつ読み、読みながら上限を確かめる。検出結果の順序が変わらないよう、名前のバイト順に並べる(`readdir`と同じ)
- **勧告の文字列の長さ**: `explain_vulnerability`はsummary・details以外の文字列(別名・パッケージ名・版・日時・CVSS・参照の種類)に256文字の上限、参照URLは2,048文字を超えるものを除く(切り詰めたURLは別の場所を指しうる)。レコードの`id`はOSVのIDの形式に合わなければ照会したIDを返す(オンラインでは検証していなかった)。`suggest_fix`の`recommended_known_vulnerabilities`と注記のIDは20件・128文字まで(超えた件数は`(N more)`)、256文字を超える修正版は候補にしない
- **不可視の文字**: 異体字セレクタ(U+FE00〜FE0F、U+E0100〜E01EF。見える文字の後ろに並べて任意のバイト列を不可視に埋め込める)、表示されない埋め字(U+034F・U+115F・U+1160・U+3164・U+FFA0)、行間注釈(U+FFF9〜FFFB)も除く。絵文字の表示形式の指定(U+FE0F)も消える
- **PATHの相対パスの要素**: `osv-scanner`をPATHから探す際、相対パスの要素(`.`等)はサーバーの作業ディレクトリ次第で別の場所を指すため探さない
- **CIのActions**: 書き換えられるタグではなくコミットのSHAで固定した(`actions/checkout`・`actions/setup-node` v4.4.0、`google/osv-scanner-action` v2.3.8)。更新を受け取るため、Dependabotに`github-actions`を追加
- テスト: `src/test/utils/projectWalk.test.ts`(読めないディレクトリはroot・Windowsでは省略)、`src/test/osv/adversarialAdvisory.test.ts`、PATHの相対パスの要素(`runner.test.ts`)
- Gradleの実時間診断を修正後の `8f29513` で再測定(2026-11-20)。C3b-3/C3b-4の両記録で `externalText.ts`・`projectWalk.ts` のSHA-256を更新し、旧値と検証結果を `sourceRemeasurements` に追記した。更新前は同じ2つの指紋だけが不一致で、記録した観測結果は一致していた。macOS arm64・Node v26.12.1で3回実行し、3ファイル・8件すべて通過

## Gradle依存関係対応の実装方式設計(2026-10-31)

- [詳細設計](GRADLE_DEPENDENCY_RELATIONS.md): 信頼済み環境でResolutionResultをcontext/variant別JSONへ事前exportし、MCPは捕捉lockとhash・収録内容を照合して静的取込する。MCPからGradle/Wrapperを実行しない。
- direct/transitive・introduced_byは実依存辺から取得し、BOM/lockのconstraint辺を由来にしない。物理宣言元は標準APIだけでは確定できないため、ownerBuildFileをdeclared_inに代用せず、明示的source-mapのある宣言から対応する。
- Stage A/Bを実装: 明示実行のexporter、捕捉lock/inputのhash照合、variant別の関係解析、由来の完全性伝播、coverage診断、3ツールへの共通取込、Gradle向け修正案内。古い／不正なJSONだけではcoverageを下げない。物理宣言元source-map等のStage Cは未実装。実exportとOSV接続の結果は[検証記録](GRADLE_LIVE_VALIDATION.md)を参照。

## Gradle Stage Bのレビュー修正(2026-10-31)

- project依存経由の由来: 公開module起点だけから由来を集めるため、root→:lib→bの経路が欠けたまま`introducedByComplete: true`となっていた(a→bと:lib→bでintroduced_by=["g:a"]、:lib→bだけでも完全な空集合)。rootのproject依存から到達するmoduleは由来を不完全とする。単体・3ツールの回帰テストを追加。
- 未存在の入力: exporterは評価前に存在しなかった候補を内部で保持していたが、JSONへは存在するファイルだけを出力していたため、後から作成されたbuild fileでstaleにならなかった。`inputs.files`に`{ path, absent: true }`を追加し、取込時に存在すればstale_input_hashとする。実Gradle 8.11.1・9.2.1の回帰(各9件)でabsent記録を確認。
- 導入元探索を効率化(2026-10-31): 多数の起点が共有するvariantグラフを反復型SCCへ縮約し、疎な32起点wordをDAG上で伝播する。少数起点・共有のない木は軽い探索を維持し、由来を出せない不完全contextでは探索を省略する。scan共有200万予算は増やさず、結果展開も計上して超過時は部分一覧を返さない。200起点/1,200 module/3 contextの同一入力で、旧2,421,540→新844,302操作となり、通常予算で完全なcontextが2→3へ改善。中央値129.356→31.549ms。[性能比較・再現手順](GRADLE_LIVE_VALIDATION.md)と生データを記録。
- 低共有グラフのレビュー修正: 共有先の有無だけでSCCへ移行せず、個別探索で実際の起点間再訪と重複queue処理の両方が到達variant数を超えた場合だけ切り替える。probeの作業も同じ予算へ計上し、部分結果は破棄。400起点/6,000 module/24 contextの共有辺1本ケースで、レビュー時2,256,552→修正後432,408操作、完全contextは21→24。回帰テストと性能比較へ追加。
- Stage C1設計を具体化(2026-10-31、未実装): 宣言元登録adapter API、評価前source準備、v2宣言棚卸し／edge binding、GAV別完全性と併合、catalogと物理宣言元の分離、convention plugin／applied script、予算と安全な取込、22群の回帰条件を[設計書6.6節](GRADLE_DEPENDENCY_RELATIONS.md#66-stage-c-宣言元adapterの確定契約実装予定)へ追加。公開APIで重複・遅延宣言の完全性を実証できない形は未対応として省略する。
- Stage C1設計レビューの2件を反映: catalogの種類別graph入力と検証不能時のcontext不採用を統一。宣言追加時／解決直前／edge要求のfingerprint v1、型付き正規化、exporterとreaderの検証責任を定義し、C04・C10と3ツールの回帰条件を拡充（設計のみ、未実装）。
- Stage C1公開API実証(2026-10-31): Gradle 8.11.1／9.2.1各5テストを追加。重複追加は集合／通知／edgeで1件へ畳まれ、whenObjectAddedがProviderを早期評価し、edge selectorからartifact／endorsementの全fingerprintを取得できないことを確認。現在の実装開始条件は未充足。本番adapter／v2 readerは未実装のまま維持し、明示helperの信頼契約とfingerprintの責任分離の設計判断が先行課題。詳細は設計書6.6.4直後の実証結果を参照。
- Stage C1の信頼契約を改訂設計（未実装）: registered-helper-v1を利用者が明示採用し、全追加試行・追加後immutableの作者表明とhelper台帳を検証する方式。自動検出不能な同値追加／元に戻したmutationの限界を応答metadataへ必ず表示。三者全fingerprint一致を解決要求keyと宣言専用shapeへ分離し、C1aは同期・既定shape、Provider／bundleはC1bの別gateとした。C23〜C30を追加し、既存C01〜C22・実接続条件も改訂。旧公開API実証は新gateの達成証拠へ読み替えない。
- Stage C1a同期helperの核を実証(2026-10-31): テスト専用の試作と回帰テストを追加し、Groovy／Kotlin × Gradle 8.11.1／9.2.1の4構成で各13件・計52件が通過。同値2試行・両source保持、継承diamondの重複除去、mutation／未登録／copy／scope不足での一覧抑制、forceの対応、通常追加経路とのgraph一致、無関係Providerの未評価を確認。作者表明依存の検出不能ケースも確認。詳細は設計書の実証結果とdocs/validation/gradle-c1a-2026-10-31.json。本番v2 reader・起動設定・安全なcapture・完全性併合・配布APIは未実装であり、次はそれらの実装。C1bは未実証。
- Stage C1a本番adapter・静的取込を実装（未リリース）: register-declarations.init.gradle、exporter v2／v1互換、信頼設定とsource／契約hash捕捉、独立した宣言予算、binding/key/shape検証、完全性併合・3ツールのdeclared_in／信頼metadata／更新案内へ接続。初期契約は明示的なcatalogPolicy=noneが必須。C1b・convention-plugin由来の証明・型付き独立plugin配布は引き続き未対応。詳細は設計書の本番adapter節とREADMEを参照。
- C1aレビュー2件を修正: configurationごとのidentity集合で同値継承と未登録実体を照合。trust採用をcontextごとに固定し、provenanceは優先順位付きで順序非依存に集約、context別の状態も応答へ追加。別GAVの検証済み宣言元を維持し、同GAVの不完全contextはAND併合で抑制。両DSLの実Gradle継承回帰と、単体／3ツールのcontext順序逆転回帰を追加。
- C1aのOSV実接続を検証(2026-10-31): Groovy／Gradle 8.11.1とKotlin／9.2.1の脆弱版projectで、信頼あり／なし×3ツールの12呼出しが成功。異なるconfigurationのLog4j同値追加の両宣言元、Jacksonのapplied-script宣言元、trust/context別metadata、候補4packageのclean判定を確認。候補は独立したPOST /v1/queryでも計8照会すべてHTTP 200・0件。元入力hash不変、スキャン中のGradle／Java／Wrapper非起動も確認。[実接続記録](GRADLE_LIVE_VALIDATION.md)・docs/validation/gradle-c1a-live-2026-10-31.jsonと手動再現ハーネスを追加。提案版は検証時点の情報で固定期待値にしない。
- 信頼契約レビュー(2026-10-31): `OSV_MCP_GRADLE_DECLARATION_TRUST`はサーバー起動時に一度だけ読み固定(scanごとに読まない)。未知値は起動を止めずstderr警告・disabled扱い・`declaration_trust_config_invalid`(宣言元は採用しない側)。C23を更新。公開API実証にC1aが依存する`ComponentSelector.getCapabilitySelectors()`の存在確認を追加(8.11.1／9.2.1で存在、shape用のgetArtifacts／getTargetConfiguration／isEndorsingStrictVersions／isTransitive／getExcludeRulesもModuleDependencyに存在)。
- C1a実装レビュー修正(2026-10-31): 実装は未知値でprocess.exit(1)し(誤記で全ツールが使えなくなる)、設定をscanごとのcache生成時に読んでいたため、合意済みの6.6.2/C23と矛盾していた。起動時に一度だけ読んで固定し、未知値は起動継続・stderr警告・disabled・`declaration_trust_config_invalid`(全Gradle lock)とする。`invalid_configuration`エラー種別を削除。ビルドしたサーバーの起動テストと3ツールの回帰テスト、起動後の環境変更を無視するテストを追加。README: C1aはmodule宣言のみで、project依存を含むscopeは宣言元を省略することを明記。
- C1a実接続記録のレビュー修正(2026-10-31): 記録の版・4ソースとハーネスのhashがコミットと一致することを確認。公開文書の実行例から個人環境の`bdo`を除き(GRADLE_LIVE_VALIDATION・設計書の計3箇所)、端末固有の一時pathを削除。コミットした証跡JSONはハーネス出力の要約で形式が異なることを明記。
- C1b実接続記録のレビュー修正(2026-10-31): 証跡の版(7bea3a6)・4ソース・ハーネスのhashが一致。e7ba01cで除いた個人環境の`bdo`が直後の文書コミットで再混入した(計3箇所)ため戻し、README・docs配下のMarkdownでコマンド行が`bdo`で始まると失敗する回帰テストを追加。
- Stage C1設計レビュー(2回目、2026-10-31): 宣言元処理はrelationの残予算ではなく専用予算とする(無関係なsubproject追加でdeclared_inが消える・lockfile単位captureの二段階化を避ける。6.6.8)。C22の前提として、v1 readerが自schemaの新しい整数versionを`unsupported_schema_version`として破損文書と区別するよう先行実装(他schema・0・非整数・不正v1は従来どおりinvalid、重複key/深さ検査が先)。3ツールでlockスキャン継続・coverage維持・relation unknownを回帰テスト。

## バックログ(2026-10-07)

着手順: B1(v0.3.3) → B2の設計メモ作成 → B2の段階実装。

### B1. ネットワーク通信先の透明化(v0.3.3、最優先)

**背景(2026-10-07 実機確認、osv-scanner v2.4.0)**: ログ用のCONNECTプロキシ経由で接続先ホスト名を記録した(TLSの中身は見ていない)。READMEの「照会先はOSVデータベースのみ」は**公開中の版でも事実と異なる**。

| スキャン対象 | 接続先 | 推移的依存の補完 |
|---|---|---|
| `pom.xml`(現行の`scan_java_project`。MCP経由でも確認) | `api.osv.dev` + `api.deps.dev` | あり |
| `requirements.txt` | `api.osv.dev` + `api.deps.dev` | あり |
| `gradle.lockfile` / `package-lock.json` / `go.mod` | `api.osv.dev` のみ | なし |
| `pom.xml` + `--no-resolve` | `api.osv.dev` のみ | なし(直接依存のみ) |
| `pom.xml` + `--data-source native` | `api.osv.dev` + `repo.maven.apache.org` + **pom.xmlの`<repositories>`に書かれた任意のURL** | あり |

- 推移的依存の解決のため、宣言された依存の名前・バージョン(社内パッケージ名を含む)がdeps.devへ送られると考えられる(通信内容は暗号化のため推定)
- `--data-source native` はスキャン対象が指定した任意ホストへ接続する(SSRF相当)。**採用禁止**
- `--no-resolve` は通信先をOSVのみにできるが、pom.xmlでは推移的依存がすべて欠落し検出漏れが大きく増える

**タスク**:
- [x] README・SECURITY.mdのネットワーク記述を事実どおりに修正(pom.xml/requirements.txtではdeps.devへ依存の名前とバージョンが送られる。lockfile方式なら送られない) → READMEに「通信先とプライバシー」節を新設。JAR/WAR・SBOMスキャンはapi.osv.devのみと実機確認(2026-10-07)
- [x] 環境変数(案: `OSV_MCP_NO_REMOTE_RESOLUTION=1`)で `--no-resolve` を付与。既定は現行動作(互換性維持)。検出漏れとのトレードオフと、社内パッケージ名を出したくない場合はlockfile方式を使う回避策をREADMEに記載 → projectモードのみに付与(artifact/sbomは外部解決をしないため)。MCP経由で接続先がapi.osv.devのみになり、推移的依存(jackson-core)が抜けることを確認
- [x] 固定引数に `--data-source native` が含まれないことをテストで保証 → 既定値の変更に備え `--data-source deps.dev` も明示指定
- [x] (レビュー指摘)`OSV_MCP_NO_REMOTE_RESOLUTION` が止めるのはdeps.devへの送信だけで、OSVへのパッケージ名・バージョン送信は続くことを明記
- [x] (レビュー指摘)推移的依存を省略したことを応答に反映。`scan_java_project` / `suggest_fix` の先頭付近に `dependency_resolution`(`transitive_resolution: enabled/disabled`、無効時は警告)を追加。無効化の判断はツール側で1回だけ行い、スキャナー引数と応答の両方に同じ値を使う(伝播をテストで確認)
- [x] (レビュー指摘)当初は警告をマニフェスト一覧にpom.xmlがある場合だけ付けていたが、一覧の探索は深さ3まででosv-scannerの`-r`(深さ無制限)と範囲が一致せず、深い階層のpom.xmlで警告が漏れた。無効時は「マニフェストからの推移的依存の解決を省略。lockfileに記録された依存は対象」という条件付きの警告を常に返すよう変更し、直下gradle.lockfile+`a/b/c/pom.xml`構成の回帰テストを両ツールに追加

### B2. 対象エコシステムの拡大(JavaScript / Python / Go)

**確定した方針(2026-10-07)**:
- ツール構成: 汎用の `scan_project`(lockfileを自動判別し、Java含む全エコシステムを一括スキャン)を新設。既存の `scan_java_project` 等は互換性のため維持。言語別ツールの増設はしない
- 検出はlockfile方式で統一(`npm install`/`pip install`は任意コード実行を伴うため採用しない。Gradleと同じ判断)
- `requirements.txt` は受け付けるが、バージョン未固定・範囲指定の行をcoverageで明示する

**実機確認で判明した前提(2026-10-07、osv-scanner v2.4.0)**:
- スキャン自体は現行のまま3言語とも動作する(エコシステム名は `npm` / `PyPI` / `Go`)。Java固有なのは検出(`projectDetector.ts`)とバージョン比較・推奨(`mavenVersion.ts` / `affectedVersions.ts` / `suggestFix.ts`)
- OSVの影響範囲の型: npmは`SEMVER`(一部`ECOSYSTEM`)、Goは`SEMVER`のみ、PyPIは`ECOSYSTEM`+`GIT`。**現行の`affectedVersions.ts`は`ECOSYSTEM`以外を情報不足とみなすため、3言語ともsuggest_fixが全件推奨保留になる**
- `requirements.txt`: バージョン未固定の行(`flask`)は出力から無言で消える。`Jinja2>=2.0`は下限`2.0`を使用中バージョンとみなす(誤検知の原因)
- npmの開発用依存には `dependency_groups: ["dev"]` が付く
- Goは`v`なしの版で返る。`go.mod`のスキャンでは標準ライブラリ(stdlib)が報告されない

**段階計画**:
- [x] 詳細設計メモの作成(B1完了後) → 上記「対象エコシステム拡大 詳細設計メモ」節(2026-10-07)
- [x] **Phase 0(v0.3.4)**: 現行版の不具合3件(requirements.txtの取り込みによるスキャン範囲の境界の迂回、suggest_fixのnpm誤表示、manifestsとスキャン範囲の不一致)の修正。検出したファイルだけを`--lockfile`で個別に渡す方式へ切り替える → 実装済み(2026-10-07)。`runOsvScan`は検出済みマニフェストの絶対パスを受け取り、許可した3形式以外は渡さない。suggest_fixはMaven以外を`unsupported_ecosystem`(CVEは`tier: "unsupported"`、unfixedに数えない)。3件の再現手順を回帰テスト化し、実バイナリでMCP経由の解消を確認。利用者から見た変更: Java用ツールは同じディレクトリのJava以外のlockfile(npm・PyPI等)をスキャンしなくなる(v0.4.0の`scan_project`で扱う)
  - (レビュー指摘)上限エラーで「マニフェストを直接指定」と案内していたが、直接指定でも親ディレクトリ全体を再探索しており回避できなかった。マニフェストの直接指定は境界検証後にそのファイル1件だけを返すよう分岐(Gradleビルドファイルの指定は従来どおりディレクトリを探索)。pom.xml+child/pom.xml構成の回帰テストを追加。v0.3.3以前は直接指定でもディレクトリ全体(`-r`)をスキャンしていたため、これも利用者から見た変更
- [x] v0.4.0: `scan_project`(3言語の検出、`.venv`/`site-packages`/`vendor`の除外、lockfile欠如時の案内エラー、requirements.txtのcoverage明示、エコシステム別集計・dev依存表示)。suggest_fixはJava以外を「未対応」と明示的に返す → 実装済み(2026-10-07)。実装時の判断:
  - 走査・境界検証を`projectWalk.ts`に切り出し、Java用と共有。osv-scannerに渡す単位を「パス+形式」(`ManifestTarget`)にし、許可する形式は`manifestFormats.ts`の一覧に限定
  - lockfile欠如: 同じディレクトリに同じエコシステムのlockfileがあれば記録しない。gradleのビルドファイルはgradle.lockfileでのみ満たされる(pom.xmlでは満たさない)。対応ファイルが1つも無ければ案内を含む`no_manifest_found`
  - requirements.txtの対象名は`requirements.txt`・`requirements-*.txt`・`*-requirements.txt`等。分類は実機確認(`==`/`===`は固定、`>=`/`~=`は下限、それ以外の指定は範囲)に合わせ、`>=`/`~=`の行に該当するパッケージには`version_is_lower_bound`を付ける
  - 応答: `coverage`(complete・warning・各一覧、各200件まで+`omitted_items`)を件数より前に置き、`ecosystem_breakdown`は脆弱性0件のエコシステムも含める。スキャン対象由来の文字列はすべて`sanitizeExternalText`を通す
  - 既存ツールへの影響: `dependency_groups`はosv-scannerが値を返した場合だけ出力するため、Mavenの出力は変わらない
  - (レビュー指摘P1)当初は事前解析で取り込み先を検証してから元のrequirements.txtを渡していたが、osv-scannerは`- r ../x.txt`(空白入り)も取り込みとしてたどる一方、事前解析は未知のオプションとして無視しており、範囲外の内容が結果に入りcompleteにもなった。**解釈のずれがそのまま迂回になる構造**のため、元ファイルを渡すのをやめ、解釈できた依存の行だけを`名前==版`等に正規化して専用の一時ディレクトリ(`mkdtemp`、`0600`・`wx`、成功・失敗とも削除)に書いたコピーをスキャンする方式に変更(`scan_sbom`と同じ考え方)。コピーには取り込み・オプションを含めないため、osv-scannerがたどれる参照が存在しない。解釈できないオプション・版は無視せず`unscannable_requirements`に理由付きで記録
  - (レビュー指摘P2)osv-scanner 2.4.0は`--requirement`と`-c`をたどらない(実機確認。たどるのは`-r`系のみ)。取り込みは本サーバーがプロジェクト内のものだけ展開してコピーに含める(`--requirement`も確実にスキャンされる)。外・存在しない・URL・深さ5超・50ファイル超の取り込みと制約ファイル(`-c`、適用しない)は、ファイルごと外さず該当行を`unscannable_requirements`に記録し、残りはスキャンする(コピーに取り込み指定が無いため安全)。`skipped_files`は元ファイル自体が読めない・1MiB超の場合のみ
  - (レビュー指摘P3)当初は上位に同じエコシステムのlockfileがあれば充足扱いにしていたが、workspace設定の無いルートのlockfileで独立した子の欠落を隠していた。上位のlockfileだけの場合は、package-lock.json(v2以降)の`packages`に子のディレクトリが収録されていることを確認できたときだけ充足とし、未収録なら`status: "missing"`、確認できない形式(yarn.lock、Python系、gradle等)なら`status: "unconfirmed"`で報告
- [x] v0.4.2: `scan_project`の`fixed_versions`がnpm・Go・PyPIで常に空になる不具合の修正(上記「suggest_fix npm/Go対応(v0.5.0)詳細設計メモ」参照) → 実装済み(2026-10-07)。`semverVersion.ts`(SemVer 2.0.0の厳密な解釈と優先順位)と`versionScheme.ts`(エコシステム別の範囲の型と並べ替え)を追加し、`extractFixedVersions`を一般化。同じ`parseOsvScanOutput`を使う`scan_sbom`(npm・PyPI等のSBOM)も同じく直る。実バイナリでMCP経由の確認: lodash `[4.17.21, 4.18.0]`、golang.org/x/text `[0.39.0]`等が入り、Mavenの`fixed_versions`とsuggest_fixの出力はv0.4.1と同一
  - (レビュー指摘、v0.4.2に同梱)存在する親POMをスナップショットへコピーできない場合(10MiB超・FIFO・末尾のシンボリックリンク等)に、子のpom.xmlを黙って完全扱いにしていた(v0.4.1で混入)。子はスキャンし、`incomplete_manifests`(scan_projectは`coverage.skipped_files`、complete=false)で欠落の可能性を示す。子に依存が無く`no_packages_found`になる場合もエラーに理由を含める(実バイナリで確認)。親POMが存在しない(ENOENT)場合は元の配置でも読まれないため報告しない
  - (レビュー指摘)コピーの書き込みで`bytesWritten`を確認せず、部分書き込みで欠損しうる → 書き切るまで繰り返す。SemVerの数値のプレリリース識別子を`Number`にしていたため2^53超で同値になる → `BigInt`で比較
  - (検証中に発見)スキャナーのエラーの`detail`(stderr)に一時ディレクトリのパスが出ていた → 元のパスに戻す
- [x] v0.5.0: suggest_fixのnpm/Go対応(semver比較、`SEMVER`範囲の検証、0.x系のマイナー更新を破壊的変更として扱う、Goのv2以上はモジュールパス変更を注記) → 実装済み(2026-10-07)。実装時の判断:
  - `versionScheme.ts`にエコシステム別の操作(`isValid`・`compare`・`isPrerelease`・`classify`・`seriesLabel`)をまとめ、`affectedVersions.ts`と`suggestFix.ts`はそれ経由で比較する。Mavenは`isPrerelease`を常にfalseにして従来の推奨を変えない(v0.4.2と出力のハッシュが一致)
  - 解釈できない版を含む区間は判定に使わず情報不足にする。`candidateStatus`はエコシステムを引数で受ける(`affected_versions`は応答に出るため、証拠にフィールドを足さない)
  - 候補の順位: 正式版 → Tier → 版の昇順 → ビルドメタデータの有無が現在と同じもの。実データでGoの修正版に`23.0.3`と`23.0.3+incompatible`が並び、優先順位が等しいため、`/vN`の無いモジュールで使えない形を推奨しうることが判明して追加
  - 現在の版を解釈できない場合は`verification: "unparseable_version"`(CVEは`tier: "unsupported"`)。npm・Goには`update_hint`(overrides・`go get`・`/vN`の注記)を付け、Mavenの出力は変えない
  - (レビュー指摘)当初は解釈できない修正版しか無いCVEを`unfixed`にして修正対象から外していたため、別CVEの修正版だけで`verified`の推奨を出しえた(現在1.0.0、CVE-Aの修正版`13.0`、CVE-Bの修正版`1.0.1`で1.0.1を推奨)。「修正版の記載がない・現在以下」(`unfixed`)と「修正版を解釈できない」(`unparseable_fix`)を区別し、後者は修正対象に残して推奨を保留する。両方が混在する回帰テストを追加
  - suggest_fixの検出・スキャンを`scan_project`と共通化(`scanFromSnapshot`・`buildCoverage`を共有)。`skipped_manifests`/`scope_warning`は`coverage`に統合。requirements.txtも対象になるため、deps.devへの送信はscan_projectと同じ
  - 実バイナリでMCP経由の確認: lodash 4.17.20→4.18.0(major_internal)、minimist→1.2.6、golang.org/x/text 0.3.0→0.39.0(cross_major)、golang.org/x/netの疑似バージョン→0.56.0(注記付き)、next 15.5.0→15.5.24(canaryではなく正式版)、express→4.20.0、jwt/v4→4.5.2。docker/dockerは不完全な範囲を含むため保留(既知の制限どおり)。log4j 2.14.1→2.25.4は不変
- [x] v0.6.0: suggest_fixのPython対応(PEP 440比較、`ECOSYSTEM`範囲がある場合の`GIT`範囲の無視) → 実装済み(2026-10-07)。実装時の判断:
  - `pep440Version.ts`: PyPA `packaging`と同じ正規化・比較。packagingのテストの順序一覧を移植し、さらにpipに同梱のpackaging 26.2と乱数で生成した1,500件・20,000組の比較で差分ゼロを確認
  - Tierはnpm・Goと共通の`classifyCaret`(epochの変更もcross_major)。`samePackageName`でPyPIの名前をPEP 503で照合(`fixed_versions`の抽出と影響範囲の両方)
  - **実データの検証で判明**: PYSECのレコードは1つの範囲に複数の区間を版の順でなく並べる(`introduced 2.0.0 → fixed 2.0.6, introduced 0 → fixed 1.26.17`)。v0.5.0までの検証は記載順を前提に「前の終点より小さい始点」を不正として情報不足にしていたため、DjangoやUrllib3の推奨がすべて保留になった。OSVの仕様(Evaluationの`sorted(range.events)`、並び順は推奨のみ)に合わせ、eventsを版の順に並べてから区間にする。同じ版では終点を始点より前に置き(その版を影響ありとみなす安全側)、並べても始点と終点が交互にならない範囲(重なり・始点のない終点)は曖昧なため情報不足のまま。全エコシステムに適用し、Maven・npm・Goの既存の期待値(3構成)はv0.5.0と出力のハッシュが一致
  - suggest_fixでも`markLowerBounds`を適用し、下限でスキャンした依存に`version_is_lower_bound`と注記を付ける
  - 実バイナリでMCP経由の確認(requirements.txt、`--no-resolve`): requests 2.19.0→2.33.0、urllib3 1.23→2.8.0、jinja2 2.10→3.1.6、django 3.2.0→5.2.17、pillow 8.0.0→12.3.0、fastapi 0.65.0→0.109.1(0.x規則でcross_major)、torch 2.5.0→2.13.0、flask>=1.0→3.1.3(下限の注記)。推奨先をOSV APIに直接照会し、8件は既知の脆弱性0件
- [x] (v0.6.0の検証で判明)推奨先に、現在の版には該当しない新しい脆弱性がありうる。例: cryptography 3.2→49.0.0(cross_major)は、44.0.0で混入し50.0.0で修正された2件(GHSA-g6cj-pr64-35w5等)に該当する。スキャンは現在の版の脆弱性しか知らないため検出できない(「未検出の脆弱性がないことは保証しない」の具体例)。対策案: 推奨候補をapi.osv.devに照会し、既知の脆弱性がある候補を避ける(送信先・送信内容はスキャンと同じ。公開版の名前と版のみ)。照会回数の上限と、照会失敗時の扱いを決めて実装する → 詳細設計メモ作成済み(上記「推奨先のOSV照会(v0.8.0候補)詳細設計メモ」、2026-10-08) → 実装済み(2026-10-08)。`osvApi.ts`に`queryOsvPackageVersion`(`/v1/query`、続きのページは5ページまで)、`candidateCheck.ts`で照会と選び直し。`suggestUpgradeForPackage`は同期・純粋のまま、照会で見つかった脆弱性(`extraTargets`)と除外する候補(`excluded`)を受け取って選び直す(contextなしの結果が従来の推奨)。実APIでMCP経由の確認: cryptography 3.2→50.0.0(49.0.0の2件を注記)、他の5構成の推奨はv0.7.0と同一。1回の呼び出しの所要時間は2〜4秒
  - (レビュー指摘)食い違い(スキャン済みの脆弱性に該当とOSVが返す)で候補を除外しても、他に候補がない場合に元の推奨を`verified`のまま返していた。新しい脆弱性に修正版がない場合(`has_known_vulnerabilities`、推奨は残す)と区別し、食い違いの場合は`candidate_check: "conflict"`で推奨を保留する(`no_verified_candidate`)
  - (レビュー指摘)JSONのnull・文字列・配列の応答や`{"vulns":[null]}`を空の結果として`clean`にしていた。応答のルート・各レコード・ページトークンの型を検証し、不正なら失敗(`failed`)にする
- [x] v0.7.0: 直接/推移的依存の区別(npmの`overrides`はルートプロジェクトでのみ有効な点を推奨文に反映)。v0.6.0から分離(2026-10-07) → 詳細設計メモ作成済み(上記「直接/推移的依存の区別(v0.7.0)詳細設計メモ」) → 実装済み(2026-10-07)。実装時の判断:
  - パッケージごとのスキャン元は`WeakMap`で保持し(`packageSources`)、応答のJSONに出さない。`scan_java_project`等の応答は不変(パッケージのキーが変わらないことを確認)
  - 判定は`scanFromSnapshot`内で、スナップショットを消す前にコピーを読んで行う。package-lock.jsonの解析は合計256MiBまで、たどる辺は200万まで。超えた・解析できないファイルは`unknown`(スキャンは続ける)
  - Goは`replace`の置換元・置換先に`replaced_in_go_mod`を付け、`update_hint`でreplaceの版の更新を案内する(requireの版を変えても効かないため)。コメントが`indirect`だけか`indirect;`で始まる場合だけ間接依存(Goと同じ)
  - (レビュー指摘)当初はreplaceを名前だけで照合し、版を限定したreplace(`replace a v1.0.0 => b v1.0.1`)をrequireの版(v1.2.0)が一致しなくても適用扱いにしていた。osv-scanner 2.4.0で、版を限定したreplaceはrequireの版が一致する場合だけ適用されることを確認し(一致しなければ元の版で報告)、Goと同じ規則(版を限定したものが優先、限定しないものは全版)で適用されたreplaceだけを判定するよう修正。`replaced_in_go_mod`は置換先の名前と版(ローカルディレクトリへの置換は置換元の名前)に付ける
  - (レビュー指摘)判定用のlockfileを全体読み込みの後で予算と比較していたため、予算を超えて解析しないファイルもメモリに載せていた。`readRegularFile`で残りの予算を上限にし、読み込み前のサイズ確認と読み込み途中の打ち切りを行う(go.modも同じ予算に含める)
  - 実バイナリでMCP経由の確認: 設計メモの期待値どおり(express・lodash 2版・minimist・node-fetch・qs 6.5.2が`direct`で`declared_in`付き、qs 6.7.0・body-parser・cookie・path-to-regexp・send・serve-staticが`transitive`で`introduced_by: ["express"]`、go.modの`// indirect`と`replace`、requirements.txtのidna・urllib3が`transitive`)。suggest_fixの推奨・注記・CVEごとの詳細は4構成でv0.6.0と出力のハッシュが一致 → 詳細設計メモ作成済み(2026-10-07、上記「suggest_fix PyPI対応・直接/推移的依存の区別(v0.6.0)詳細設計メモ」)
- [ ] 以降: Goバイナリスキャン(ビルド情報からstdlibの版も取得でき、go.modで拾えないstdlibの脆弱性を補える)

### B4. pom.xmlの親POM(`<parent><relativePath>`)によるスキャン範囲外の読み込み(v0.4.0で対応)

**背景(2026-10-07 実機確認、osv-scanner v2.4.0)**: v0.4.0のレビュー対応中、requirements.txtの取り込みと同じ種類の問題を確認した。

- `<parent>`の`<relativePath>`がスキャン範囲の外(例: `../outside/pom.xml`)を指すと、osv-scannerはその親POMを読み、そこに書かれた依存が結果に入る(`--no-resolve`でも同じ)
- `relativePath`を省略した場合もMavenの既定値`../pom.xml`を参照し、親のGAVが一致すれば読む(一致しなければ読まない)
- 影響: `scan_java_project` / `suggest_fix`(公開中のv0.3.4を含む)と`scan_project`。`OSV_MCP_ALLOWED_ROOT`の外にあるpom.xmlの依存情報が結果に入り、照会先に送られうる
- 同種の確認: `go.mod`の`replace`によるローカルパスは読まない(パス名がパッケージ名として出るだけ)

**設計上の論点**: サブモジュールだけをスキャンしたときに親POMを読むのはMavenとして正当な動作で、requirements.txtのように「プロジェクトディレクトリ外は読まない」とすると正当な利用を壊す。境界を`OSV_MCP_ALLOWED_ROOT`にするか、親POMを読ませない(`<relativePath/>`を明示した検証済みコピーをスキャンし、親はリポジトリから解決させる)か、範囲外の親を指すpom.xmlをスキャン対象から外して報告するか、を決める必要がある。

- [x] 方針決定と実装 → **境界を`OSV_MCP_ALLOWED_ROOT`とする案で確定**(2026-10-07)。v0.4.0に含めてリリース
  - 追加の実機確認: 親の親もたどる(連鎖の途中が外でも読む)、`<relativePath/>`(空)はローカルを参照しない、ディレクトリを指す場合はその中のpom.xml、GAV不一致なら読まない
  - `src/utils/pomParent.ts`: 親POMの連鎖を最大10段たどり、参照先が実在して許可ルートの外ならpom.xmlを除外理由付きで返す。GAVの一致は確認せず安全側に除外。プロパティ参照等で評価できないrelativePathも除外。許可ルート未設定時は検証しない(任意のパスをスキャンできる状態のため)
  - `scan_java_project` / `suggest_fix`: 外したpom.xmlを`skipped_manifests`と`scope_warning`で件数より前に返す(外したものが無ければ出力しない=既存の出力は不変)。全件除外・直接指定は`path_outside_allowed_root`
  - `scan_project`: `coverage.skipped_files`に記録(completeはfalse)
  - 実バイナリでMCP経由で確認: 許可ルート内の親を持つサブモジュールは従来どおり親の依存を検出し、外を指す親のpom.xmlは除外され範囲外の依存が混入しない
  - (レビュー指摘P1)当初は正規表現で「最初の`<parent>`」を探していたが、`<m:parent>`を親なしと判断し、osv-scannerは範囲外の親POMを読んだ(complete=trueにもなった)。追加の実機確認で、osv-scanner(Goのencoding/xml)は要素を**名前空間・接頭辞に関係なくローカル名で照合**し(`<m:parent>`、別名前空間の`<x:parent>`、`<parent xmlns="別">`、`<m:relativePath>`も読む)、**ルート直下の`parent`だけ**を対象にし(入れ子のおとりは無視)、**重複すると後のものが有効**、文字参照・CDATAは展開、前後の空白は除去、大文字の`<Parent>`は読まないことを確認。正規表現をやめ、先頭から順に読む小さなXMLパーサーに置き換えてGoの解釈に合わせた。外部のXMLパーサーは使わない(重複・CDATAの扱いが別のずれを生みうるため)。同じ解釈を保証できない構文(ルート直下のparent・relativePathの重複、CDATA・DOCTYPE、未知の実体参照、プロパティ参照、閉じていないタグ、UTF-8以外)は除外。11通りの書き方すべてで、実バイナリでもMCP経由で範囲外の依存が混入しないことを確認
  - (レビュー指摘P1)自作パーサーがXML 1.0の行末処理(解析前にCRLF・CRをLFへ正規化)をしておらず、`relativePath`にCRを書くと、検査側は`a\rb`を探して「参照先なし」と判断し、osv-scannerは`a\nb`(改行を含む名前の許可ルート外のディレクトリ)の親POMを読んだ。解析前の正規化を追加。あわせて、文字の正規化や前後の空白の除去の細部(JSの`trim`とGoで扱いが異なる: U+FEFF・U+0085等)で参照先がずれる余地を残さないよう、`relativePath`に制御文字・通常の空白以外の空白・書式文字が含まれる場合は解釈できないものとして除外(通常の空白・日本語のディレクトリ名は許可)。実バイナリでMCP経由の解消と、CRLFで書かれた正当なpom.xmlが従来どおりスキャンされることを確認

### 許可ルート未設定時の親POMのスナップショット外参照(v0.4.1〜v0.13.0の不具合、v0.14.0で修正、2026-10-22)

- **事象**: `snapshotPom`は、親の参照がスナップショットの外に出る場合・解釈できない場合・連鎖が上限を超える場合を、許可ルート設定時だけ除外し、未設定時はそのまま(または欠落の注記付きで)スキャンしていた。osv-scannerは、余分な`../`でルートを越えると親を読まないが、**スナップショット内のコピーの位置からちょうどルートに届く数の`../`+絶対パス**なら本物のファイルを読む(2.4.0・2.7.0で確認)。コピーの深さは「一時ディレクトリの実パスの深さ+3(snap・tree・_)+元の深さ」
- 再現(HEAD、許可ルートなし、MCP経由、2.7.0): `../`×17+元の外のpom.xmlの絶対パスで、検証もコピーもしていない外の親POMの`log4j-core`が結果に出た。「osv-scannerには元のファイルを渡さない」というスナップショットの保証(差し替え・名前付きパイプへの対策)が、許可ルート未設定時に崩れていた
- 修正(利用者が実装、作業ツリー): 許可ルートの有無に関係なく、スナップショットの外に出る参照・解釈できない参照・上限超過を除外する。全ファイルのコピー後に、osv-scannerが見る連鎖をコピーだけでたどり直して検証する(`validateCopiedPom`。完成したコピーだけを親として扱う)
- 除外の種類: 許可ルート未設定時は`unreadable`にし、全件が除外されたときのエラーを`no_manifest_found`にする(当初は`outside_allowed_root`で、未設定なのに`path_outside_allowed_root`と示していた)。許可ルート設定時は従来どおり`outside_allowed_root`・`path_outside_allowed_root`

### 親POMの空のrelativePath(v0.4.0〜v0.13.0の不具合、v0.14.0で修正、2026-10-22)

- **事象**: `<relativePath/>`・`<relativePath></relativePath>`・空白だけの値を、Mavenの仕様どおり「ローカルの親を参照しない」と解釈していた(`pomParent.ts`の注記は2026-10-07の2.4.0の実機確認としていたが、2026-10-22の再確認では2.4.0・2.7.0とも既定の`../pom.xml`を読む)
- 影響: v0.4.0(元のファイルをスキャン)では許可ルートの検証をすり抜け、許可ルートの直下の`pom.xml`の空のrelativePathで、許可ルートの1つ上の親POMをosv-scannerが読んだ(v0.4.0のタグでMCP経由で再現: `log4j-core`が結果に出る)。v0.4.1以降はスナップショットのコピーだけを渡すため読まれないが、親をコピーしないため継承した依存が黙って欠け(`complete: true`のまま)、許可ルートの検証も行われなかった
- 修正: 空・空白だけの値を既定の`../pom.xml`として扱う(`parentRelativePath`)。親が許可ルート内ならコピーし、外なら他の親POMと同じく除外する。MCP経由(2.7.0): 許可ルートなしで`log4j-core`を検出、許可ルートが子のディレクトリなら`path_outside_allowed_root`
- 同時に確認した他の参照(2.4.0・2.7.0): 既定の`../pom.xml`に親が無い場合に上の階層をたどらない、relativePathの参照先が無い場合に`../pom.xml`へ戻らない、絶対パスのrelativePathは読まない(GoのJoinで連結される)。いずれもスナップショットの外を読む経路はない
- Security Advisory 2の影響範囲を`< 0.4.0`から`< 0.4.1`に訂正(文案)

### B5. ローカル参照によるスキャン範囲外の読み込みの監査(2026-10-07、osv-scanner v2.4.0)

requirements.txtの取り込み・親POMと同じ種類の問題(osv-scannerがファイル内のローカル参照をたどり、範囲外を読む)が他の形式にないか、v0.4.0の公開前に実機で監査した。範囲外のディレクトリに各形式のマニフェスト(npm: `lodash@4.17.20`、Python: `Jinja2==2.0`、Maven: `log4j-core@2.14.1`)を置き、それが結果に現れるかで判定(`--data-source deps.dev`の既定と`--no-resolve`の両方)。

| 形式 | ローカル参照 | 範囲外の読み込み |
|---|---|---|
| package-lock.json | `link: true`、`file:`(resolved) | なし |
| yarn.lock | `file:`、`link:` | なし |
| pnpm-lock.yaml | `link:`、`file:`(directory)、範囲外のimporter | なし |
| bun.lock | `file:`、範囲外のworkspace | なし |
| poetry.lock | `source.type = "directory"` | なし |
| uv.lock | `directory`、`editable` | なし |
| Pipfile.lock | `path`、`editable` | なし |
| pdm.lock | `path` | なし |
| go.mod | `replace => ../path` | なし(パス名がパッケージ名として出るだけ) |
| pom.xml | `<modules>`、`file://`のリポジトリ(Maven構成を配置)、BOMの`scope=import` | なし |
| requirements.txt | `-r`(相対パス) | **あり**(v0.3.4で元ファイルを渡さない方式、v0.4.0で専用コピー方式で対処) |
| pom.xml | `<parent><relativePath>` | **あり**(v0.4.0で許可ルートの検証で対処。`<packaging>pom</packaging>`の親だけが読まれる) |

- 陽性対照: 同じ判定方法で、requirements.txtの`-r`と親POMの範囲外の読み込みを検出できることを確認
- 限界: 結果に影響しない読み込み(読んだが使わない)は検出できない(ファイル単位の監視は管理者権限が必要なため未実施)
- **osv-scannerのピン留めバージョンを更新するときは、この監査と、requirements.txtの取り込み・親POMの解釈(名前空間・重複・改行等)の実機確認をやり直すこと**

### B6. 検査と読み込みの不一致・繰り返し解析・名前付きパイプ(v0.4.1、2026-10-07)

**指摘(v0.4.0公開後)**:
1. 検査と読み込みの間にファイルを差し替えると、範囲外の内容を返せる(本サーバーは検査するだけで、osv-scannerには元のファイルを渡していた。lockfile・pom.xmlと親POM・JAR/WAR。requirements.txtの解析とSBOMもパスの解決と読み込みの間に隙があった)
2. workspaceの収録確認で、package.jsonの数だけ同じlockfile(最大64MiB)を読み直して解析していた(キャッシュも合計の上限も無し)
3. 親POMが名前付きパイプ(FIFO)を参照すると、`stat`の後の`readFile`で処理が止まる(requirements.txtの取り込み先も同じ)

**対応(スナップショット方式)**:
- `src/utils/safeRead.ts`: `O_NOFOLLOW`・`O_NONBLOCK`で開いて`fstat`で通常のファイルか確認、上限付きで読み、読み終えた後にパスを解決し直して境界の内側かつ開いた実体と同じ(dev・inode一致)かを確認。大きなJAR/WAR向けにストリーミングのコピーも提供。requirements.txtの解析・workspaceの収録確認・SBOMの読み込みもこれに統一
- `src/utils/scanSnapshot.ts`: osv-scannerには元のファイルを一切渡さず、安全に読んだ内容を専用の一時ディレクトリ(0700、終了時に削除)へコピーしてスキャンする。検査(親POMの検証)もコピーに対して行う。親POMは元の配置を一時ディレクトリ内に再現(`tree/<ルート>/<元の絶対パス>`)してコピーするため、osv-scannerが相対パスで親をたどっても見つかるのはコピーだけ。**解析がosv-scannerと多少ずれても範囲外は読まれず、最悪でも親が見つからないだけ**になり、レビュー指摘が続いた「解析の不一致が迂回になる」構造を解消
- 設計時に判明した追加の論点: 一時ディレクトリ内の配置は元より深いため、`..`を重ねた参照は一時ディレクトリを抜けて本物のファイルシステムに届く(コピーではなく元のファイルが読まれ、差し替えの隙が戻る)。参照先をGoの`filepath.Join`と同じ規則(Nodeの`path.join`)で一時ディレクトリ内で解決し、外に出る場合は除外
- 解析の繰り返し: workspaceの収録確認はlockfileごとに1回だけ解析して使い回し(合計256MiBまで)、requirements.txtは共通の取り込み先を1回だけ読む(合計64MiBまで)、親POMの解析もファイルごとに1回。コピーの合計は2GiBまで(超えると`scan_input_too_large`)
- 応答には一時ディレクトリのパスを出さない(`source_files`・JAR/WARのパスは元のファイルに戻す)
- 回帰テスト: FIFOで止まらないこと(時間制限付き)、差し替えの検出(dev・inodeの不一致)、途中のディレクトリのシンボリックリンク、`..`による一時ディレクトリの外への参照、合計サイズの上限、ツール単位で「起動時に元のファイルを範囲外の内容に差し替える偽スキャナー」でも結果に影響しないこと、lockfileを1回だけ解析すること(約10.4MBのlockfileと1500件のpackage.jsonで356ms。修正前は1500回の解析)
- 実バイナリでMCP経由の確認: 許可ルート内の親POMを持つサブモジュールは、一時ディレクトリ内に再現した親から依存を引き継いで従来どおり検出。範囲外の親は除外。複数言語・JAR/WAR・suggest_fixも従来どおり。実行後に一時ディレクトリが残らない

### B7. 強制終了時に一時ディレクトリ(元のファイルのコピー)が残る(2026-10-08)

**事象(2026-10-07 実機確認)**: scan_projectの実行中にサーバーへSIGTERM(`child.kill()`)を送ると、package-lock.json・go.mod・生成したrequirementsのコピーを含む`osv-mcp-snap-*`が一時ディレクトリに残った。スナップショットの削除は`finally`だけで、シグナルハンドラが無かった(シグナルの既定動作で即終了し`finally`は実行されない)。osv-scannerの子プロセスも親の終了後に残り得た。MCPクライアントはstdinを閉じるかSIGTERMでサーバーを止めることが多い。

**対応(`src/utils/processCleanup.ts`)**:
- [x] 作成中の一時ディレクトリ(`osv-mcp-snap-*`・`osv-mcp-sbom-*`)と実行中のosv-scannerを登録し、終了時に同期的に片付ける(`fs.rmSync`・子プロセスへSIGKILL)。登録は`mkdtemp`/`spawn`の直後の同じ同期処理内で行うため、その間にシグナルの処理は割り込まない
- [x] SIGTERM/SIGINT/SIGHUP: 後始末して128+シグナル番号(143/130/129)で終了。stdinの`end`/`close`(クライアントがトランスポートを閉じた): 後始末して0で終了(応答の送り先が無いため実行中のスキャンは待たない)。`process.exit`・未捕捉例外は`exit`イベントで後始末
- [x] 起動時に前回の異常終了(SIGKILL・電源断等)の残骸を削除。対象は「名前が`osv-mcp-(snap|sbom)-`+mkdtempの6文字に完全一致」「`lstat`で実体のディレクトリ(シンボリックリンクはたどらない)」「所有者が自分」「最終更新から24時間以上」をすべて満たすものだけ。24時間は別のサーバープロセス(複数クライアント・スリープ明け)が使用中のものを消さないための余裕(消すと親POMが欠けたまま黙ってスキャンされ得る)。getuidの無いWindowsでは行わない。起動は待たない
- [x] テスト: 単体(登録・削除・SIGKILL、残骸の判定条件・シンボリックリンク・所有者)と、ビルドしたサーバーを起動し遅いスキャナーでscan_project中にSIGTERM/SIGINT/SIGHUP・stdin終了を送ってスナップショットとスキャナーが残らないことの確認(`src/test/server/shutdown.test.ts`。ハンドラを外すと全件失敗することを確認済み)

**残課題**:
- [ ] SIGKILL・OOM killer等の捕捉できない終了では残る(次回起動時の掃除まで、最長24時間+次の起動まで)。一時ディレクトリ自体は0700のため他ユーザーからは読めない
- [ ] Windowsではシグナルの扱いが異なり(SIGTERMは捕捉不可)、起動時の掃除も行わない。Windowsでの実機確認は未実施
- [x] テストの後始末漏れ: `src/test/osv/binaryDownloader.test.ts`の`osv-mcp-dl-404-*`・`osv-mcp-dl-net-*`がテスト実行ごとに一時ディレクトリへ残る(2026-10-08時点で各114件。サーバー本体ではなくテストの問題) → 修正済み(2026-10-08)。HTTPエラー・ネットワークエラーのテストのキャッシュを、afterAllで削除する共有のcacheDir配下に作る。残っていた312件(空のv2.4.0ディレクトリのみ)を削除

### B8. 英語化(2026-10-08)

- [x] README・ツールの説明・応答の文言(注記・案内・警告・エラーメッセージ・stderr)を英語にした。応答のフィールド名・列挙値は従来から英語。コードのコメント・設計メモ(このファイル)・テスト名は日本語のまま
- 文中に埋め込む読み込み失敗の理由(safeReadのMESSAGES)は小文字で始め、単独の理由として示すときだけ先頭を大文字にする(`capitalizeReason`)

### B3. 既存の未完了項目

- [x] JAR実体スキャン: 実プロジェクトのfat JAR・shaded JARでの実機検証(上記「JAR実体スキャン」節の残タスク) → 検証済み(上記「B3 詳細設計メモ」、2026-10-08)。推測の座標の区別と、`affected_versions`の応答からの除外を実装(v0.10.0)
- [x] 権限の最小化: MCPサーバープロセスに必要以上のファイルシステム権限を与えない(上記「セキュリティ考慮事項」節) → 実装済み(上記「B3 詳細設計メモ」、v0.10.0)。Nodeの権限モデルでの動作、`permission_denied`、起動時の警告、READMEの「権限を絞って起動する」。E2Eテスト(`src/test/server/permission.test.ts`)で、許可内のスキャンの成功・許可外のパスとOSV_SCANNER_PATHの拒否の表示・欠けた許可の警告を確認。実装中に、OSV_SCANNER_PATHの読み取りの拒否が`binary_not_found`になる箇所も見つけて修正
  - (レビュー指摘)`scan_java_artifact`・`scan_sbom`の入力パスの解決とSBOMの読み込みで、権限モデルの拒否を`project_not_found`・`sbom_not_found`に変換していた。各所で拒否を保持して`permission_denied`にし、E2Eの回帰テストを追加。あわせて、ディレクトリ探索で権限モデルに拒否されたディレクトリを黙って飛ばしていた箇所もエラーにした
  - (レビュー指摘)推測の座標だけのアーカイブでも、脆弱性が見つかると`identified_with_vulnerabilities`になり`jars_identified`に数えていた。同定の確度と検出件数を分け、脆弱性の有無に関係なく`inferred_only`にする(件数は`identified_vulnerability_count`に示す)


### 2026-10-31: Gradle C1b Provider公開API実証

- `GRADLE_DEPENDENCY_RELATIONS.md` §11に、元Providerを追加評価せずaddProviderのconfigure Actionで登録する設計、試行ID／materialization世代、安定性の作者表明、未観測時の不完全性を具体化。
- Groovy／Kotlin × Gradle 8.11.1／9.2.1のtest-only公開API回帰と機械可読結果を追加。通常追加・棚卸しのみ・登録付きのイベント列、評価回数、解決結果、例外を比較する。
- Providerを外部から再照会した変動はcallbackで捕捉できない対照を含め、安定性を自動検証済みとは扱わない。
- 次は本番C1b adapter／静的取込とtrust metadata。catalog／bundle、configuration cache等のgateは残る。本番C1aのProvider対応範囲は今回変更しない。


### 2026-10-31: Gradle C1b 本番adapter・静的取込

- 明示`addProvider`とscopeの`providerPolicy: stable-during-export`を追加。Provider入りcontextをadapter v3で出力し、readerが全観測と信頼契約を再検証する。同期C1aのv2互換性を維持。
- 空値・表明不足・非既定shape・mutation・観測不完全ではscopeのdeclared_inを省略し、relation／introduced_by／coverageを保持。未使用configurationを追加実現しない。元Actionによる版変更・例外を含む本番回帰を追加。
- 次の実接続課題はC1b入り検証projectでscan_project／scan_java_project／suggest_fixの宣言元・信頼metadata・候補再照会を確認すること。catalog／bundle、ProviderConvertible、configuration cache、task output、convention-pluginのgateは残る。


### 2026-10-31: Gradle C1b 3ツール・OSV実接続検証完了

- Groovy／Gradle 8.11.1、Kotlin／Gradle 9.2.1のProvider由来log4j／Jackson依存で、3ツール×信頼有効・無効・安定性表明なし、計18呼出しを検証。
- declared_in・信頼metadata・候補案内の採用／抑制を確認し、GAV・検出ID・relation・introduced_by・coverage・提案版は条件間で維持。24候補照会が独立OSV再照会でもHTTP 200・脆弱性0件。
- 検証記録／データ／手動再現ハーネスを追加。次はversion catalog alias／bundle・ProviderConvertibleの独立設計／公開API実証。configuration cache、task output、並行実行、convention pluginのsource-artifact対応、buildscript／composite／Android等は引き続き残課題。


### 2026-10-31: Gradle catalog alias／bundle・ProviderConvertibleの設計・公開API実証

- GRADLE_CATALOG_DECLARATIONS.mdへ使用script／bundle group-memberの対応、catalog入力inventoryと鮮度、設定上書き時の編集案内、追加信頼契約・次版schema案を具体化。
- 通常APIと登録Actionの比較、元bundleの型保持、生成／明示ProviderConvertible、同値member・独立追加、例外・strict版、設定上書き、評価／先行task中の入力変更の公開API回帰を追加。
- 今回は設計・test-only実証。本番catalog adapter／静的取込、厳格なinput manifest、信頼metadataと3ツール・OSV実接続は次段階。公開APIだけでcatalog構築入力やbundleの内部supplier回数を自動証明したとは扱わない。


### 2026-10-31: Gradle catalog本番adapter・静的取込

- 契約v2／宣言adapter v4でalias・bundle・ProviderConvertibleを登録し、bundle group/memberを分離。使用scriptへのdeclared_inと完全性・追加catalog信頼metadataに対応。
- manifestのbundleMembersと安全に読んだ実TOMLを照合。設定評価前の入力捕捉・custom TOML・version上書き・不在入力の鮮度、scopeとmemberの完全性を確認。入力・解析のcache／byte・work予算を維持。
- 次は既知脆弱版でcatalogのscan_project／scan_java_project／suggest_fix実接続。programmatic／remote、module・bundle構築の上書き、configuration cache、task output、並行実行、convention plugin等の独立gateは残る。

- レビュー修正: catalog検証と追加信頼の要否を作者契約から判定し、空entries・入力参照欠落・旧adapterへの変更による迂回を拒否。72組合せと不正契約等の回帰を追加し、通常全体1,594件、実Gradle両版の対象各7件が成功。


### 2026-10-31: Gradle catalog 3ツール・OSV実接続検証

- レビュー修正後のlocal TOML alias／bundle・生成ProviderConvertibleをGroovy／Gradle 8.11.1、Kotlin／Gradle 9.2.1で検証。両信頼有効・helper信頼なし・catalog信頼なし・安定性表明なし×3ツールの24呼出しを確認。
- declared_inと信頼metadataの採用／抑制、GAV・検出ID・relation・introduced_by・coverage・提案版の条件間一致を確認。独立OSV候補再照会32件はHTTP 200・0件。入力hash不変、MCP中のビルド非起動も確認。
- 検証記録・データ・再現ハーネスを追加。次の候補はconvention pluginのsource-artifact対応の設計。configuration cache、task出力Provider、並行実行、remote／programmatic catalog、構築のmodule／bundle上書き、buildscript／composite／Android等も引き続き独立課題。


### 2026-10-31: Gradle convention plugin宣言元の拡張設計

- [設計書](GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md)を追加。buildSrcのprecompiled／binary、included build-logic、境界内の独立checkoutと、外部配布済みpluginを区別。consumerのplugins blockを物理declared_inへ代用しない。
- 作者manifest・plugin／source handle・build receipt・application／bindingの入出力、契約v3／graph v3／adapter v5の提案、追加plugin信頼、固定manifestによる検証要否判定を整理。既存helper／catalog信頼の意味を変更しない。
- 全producerの評価・compile前捕捉、同一export invocationでの構築と実行artifact対応、source／artifactの安全な静的取込と予算、完全性AND・部分一覧抑制・graph／coverageとの分離を定義。公開APIでloaded originを確認できない形は作者表明だけで陽性化しない。
- CP01〜CP36を追加。次はGroovy／Kotlin×Gradle 8.11.1／9.2.1の公開API実証。今回は設計のみで、本番実装・API実証・pluginのOSV実接続は未実施。configuration cache、task-output Provider、並行実行、settings plugin、remote pluginのsource取得は別gate。

- convention plugin設計レビューの2件を反映: trusted-toolchainをconsumer起動時承認profile＋準備側の有界streaming検証へ分離し、plugin固有source／artifactの境界・4 MiB/件・64 MiB/scanを維持。script／plugin／unverifiedのorigin union、参照の必須／禁止、source役割とapplication台帳の双方向検証を定義。CP31〜CP36に大容量標準toolchain・分類偽装・予算・通常script混在・origin変更による信頼迂回の条件を追加。設計のみで、本番実装・公開API実証は未実施。


### 2026-10-31: Gradle convention pluginの公開API実証

- Groovy／Kotlin consumer×Gradle 8.11.1／9.2.1で、buildSrc binary Java・独立build-logic binary Kotlin・独立precompiled Groovyの計12 fixtureを実行。各版72件のnative回帰とsynthetic診断12件を追加。
- 起動前baseline、build間identity／invocation、通常／棚卸し／登録のgraph・Action・Provider評価一致、script／pluginの同値試行保持とscript単独scope、toolchainの別予算分類・改変対照を確認。
- 実行source-artifactの陽性gateは未成立。binary pluginは公開load元が境界外のGradle cache JAR、precompiledは登録側thisとPlugin実体も不一致。class hash一致だけで採用せず、混在declaredInを省略する。次はload／変換の信頼契約とprecompiled実体の登録方法の再検討・追加実証。本番採用・reader実装・OSV実接続へ進んだ記録ではない。詳細は[設計書§10](GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md#10-公開api実証の結果2026-10-31)、データはvalidation/gradle-convention-plugin-2026-10-31.json。

- convention plugin実証レビューの2件を修正: classpath directoryの現在ファイル集合・hashを制限付きで捕捉し、未記録追加／削除／変更を拒否。Providerに安定IDを付けて同期追加と共通のapplication台帳・出自・双方向被覆を検証。実GroovyCompile前のresource追加、Provider origin／ID／参照の書換え・削除の回帰を4構成で再検証し、検証JSONを更新した。各Gradle版128件、通常全体1,631件が成功。実行artifact対応の陽性gateと本番採用は引き続き未成立。
- 6d9b1e5レビュー対応: classpath directory照合はGradle終了後の事後snapshotで、compile中だけ存在したファイルや復元された変更は検出できない制限（plugin_classpath_transient_changes_not_detectable）を明記。compileGroovyのdoFirstで追加しdoLastで削除する未検出固定の対照を4構成に追加し、synthetic回帰は拒否理由まで検証する。各Gradle版130件（policy込み162件）が成功。task開始時点のsnapshotは未実装。


### 2026-10-31: convention pluginのload信頼・precompiled登録の改訂設計

[設計書§11](GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md#11-改訂案-ロード変換の信頼とprecompiled実体登録)へ追加。旧trustを弱めず、新しいloader-attested trust・独立承認profile・全artifact内容照合・boundary内runtime snapshotを組み合わせる案を定義。precompiledはscript thisを渡さないpending登録と、適用後の公開Plugin実体／descriptor照合へ分離する。buildSrc／included／発行済みpluginの区別、完全性AND、CP37〜CP60を追加。今回は設計のみ。次は新policyの公開API実証で、従来の128件／版を新policyの陽性証拠とはしない。本番未採用を維持する。

- load信頼の設計レビュー2件を反映: policy別の必須field・trust・profileを表にし、strictへ不要なloader profileを要求しない。precompiled-pendingの追加trustはload policyとは別に判定する。runtime snapshotをjar／directoryのunionへ分け、directoryの全tree＋内容blob、binary encodingのdigest、atomic保存、境界内再検証を具体化。CP37／38／43を拡充しCP61〜CP68を追加。設計のみで本番未採用・既存実証データは維持。


### 2026-10-31: 改訂load信頼・precompiled二段階登録の公開API実証

[設計書§12](GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md#12-改訂したload信頼二段階登録の公開api実証2026-10-31)に結果を追加。buildSrc／独立plugin、Groovy／Kotlin consumer、Gradle 8.11.1／9.2.1の32 fixtureで、明示承認loader-attested policyの採用候補とstrict実runtimeの拒否を分離した。precompiled Groovyのpending→適用後実Plugin／descriptor照合、JAR全内容照合、実directory CodeSourceのatomic snapshot保存・境界内再検証を確認。実Gradle各200件、単体52件、通常全体1,683件が成功した。

本番は未採用。実行class bytesの独立観測ではなく追加信頼契約による候補化で、compile中だけのclasspath変更は引き続き検出不能。precompiled Kotlin／標準kotlin-dslは未検証。次は実証レビュー、成立範囲の本番schema・adapter・reader、続いて3ツール／OSV実接続。機械可読結果はvalidation/gradle-plugin-load-2026-10-31.json。

- 実証レビュー修正: 同じentrypointの重複beginを先行・後続sessionとも不完全に固定し、終了後の再開始も拒否。load元観測とJAR snapshotはverification-task、directory snapshotはpost-buildという実際のphaseを記録する。両Gradle版のnative回帰へ重複2条件・phase確認を追加（各280件）。本番未採用と追加信頼の限界は維持。
- 06aa8f3レビュー修正: directory artifactはload元が準備済み出力と同じpathで、事後に同じ実体を比較していたため、`same-path-origin`として内容一致と区別し、事後snapshot・比較なしのlimitationを付ける。比較種別をartifact種別へ束縛し、snapshot単体回帰は対象の検査（順序・blob size）へ届く対照と拒否理由の検証に改めた。strict不採用は変換不明の前提による結果と明記。実Gradle各280件、単体60件が成功。


### 2026-11-01: convention pluginの本番adapter・静的取込

contract v3／graph v3／adapter v5で、policy別の承認toolchain／loader profile、binaryとprecompiledの二段階登録、JAR／directory snapshotのatomic保存・現在bytesの再検証、originの双方向被覆、declared_in完全性と信頼metadataを実装した。旧helper／catalog信頼の意味は維持し、scope・contextをまたいだ部分一覧を返さない。手順と対応範囲は[利用手順](GRADLE_CONVENTION_PLUGIN_USAGE.md)、詳細と回帰は[設計書§13](GRADLE_CONVENTION_PLUGIN_DECLARATIONS.md#13-本番adapter静的取込2026-11-01)。次は本番変更のレビュー、続いて3ツール／OSV実接続。未検証gateを今回完了した扱いにはしない。

検証: 本番native各280件、既存adapter native各44件、通常全体1,763件、plugin static単体72件が成功。typecheck・build・配布dry-runを確認済み。観測46件とsource hashはvalidation/gradle-plugin-production-2026-11-01.jsonへ保存。3ツール／OSV実接続は未実施。

- 本番レビュー修正: receiptをtask自身の出力へ限定し、前回artifactが残る同一projectの再exportを誤失効させない。ProcessResourcesの独立記録でresource鮮度を維持。directoryのsame-path-origin／distinct-path-originを本番schemaへ持ち、comparisonと必須limitationsをmetadataへ引き継ぐ。再export・同一／別path・不正なkind組合せの回帰と検証データを更新する。

- 再検証: 両Gradle版各328件、通常全体1,770件、plugin static単体79件が成功。40件の同一project再exportでsource・artifactの変更と採用を確認し、initial／reexport計86観測を保存。directory 32観測でsame-path-originと必須limitationsを確認した。先行native各44件は今回未再実行、3ツール／OSV実接続も未実施。

- 4e01d11レビュー修正: toolchain／loader profileの未承認は宣言元だけを省略し（plugin_toolchain_not_approved／plugin_loader_not_approved）、検証済みrelation／introduced_byを保持する。既定の未設定状態でもrelationを失わない。profile構造・receipt・hashの不一致とloader profileの指定不一致（plugin_loader_profile_mismatch）は従来どおりgraphを不採用にする。
- 同レビューで、Gradle buildを伴う再export等の本番native回帰4件が既定30秒のtimeoutで負荷時に間欠失敗したため、fixture exportと同じ210秒を明示した。


### 2026-11-01: convention plugin本番adapterの3ツール／OSV実接続

- Groovy／Gradle 8.11.1のbuildSrc binary Java JAR、Kotlin／9.2.1のincluded precompiled Groovy directoryで、各project 8条件×3ツール、2 project合計48呼出しを確認（対象b5edea7）。declared_inの完全な混在一覧、信頼metadata、introduced_by、候補版を検証した。
- helper／plugin信頼無効、toolchain／loader profile未承認、nativeでendPluginを省いた未終了登録では宣言元を全体省略。同一projectのsource変更・再export後の採用と、JAR／directory snapshot改変時のgraph拒否も確認。
- 4候補×16回の独立OSV再照会64件がHTTP 200・脆弱性0件。MCP中の列挙入力hash不変と通常build launcherの非実行を確認した。scan_project／suggest_fixは独立producerのlock不足をcoverage警告として維持する。
- [検証記録](GRADLE_LIVE_VALIDATION.md#convention-plugin本番adapterの実接続検証2026-11-01)・validation/gradle-plugin-live-2026-11-01.json・src/test/manual/gradlePluginLive.mjsを追加。本番コードの変更なし。実接続matrix外の組合せ、precompiled Kotlin／標準kotlin-dsl、発行済みplugin、plugin ID alias、producer子project、plugin内部catalog／bundle、configuration cache／並行export等のgateは残る。
- 7ef3922レビュー修正: 対象revisionをb5edea7へ訂正し、directoryの実接続負例がmanifest破損でありblob内容改変はoffline回帰で確認することを明記。ハーネスの事前条件にGRADLE_USER_HOMEを追加（実接続は再実行せず、JSONのpostReviewRevisionに新hashを記録）。


### 2026-11-01: precompiled Kotlin／標準kotlin-dslの設計・公開API実証

- [設計書](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md)を追加。物理source→生成adapter→標準Kotlin compile→descriptor→公開Plugin／CodeSource元のJAR対応、構築pipelineとloader信頼の責任分離、本番schema／完全性・回帰条件を整理。
- buildSrc／included root project、Groovy／Kotlin consumer、binary Kotlin／precompiled Kotlinの8構成を各Gradle版で実行。8.11.1／9.2.1とも144件成功。元source＋scriptの宣言元候補、未終了／failed／重複登録の省略、Action／Provider評価一致、JAR改変拒否を確認した。
- 通常回帰はnativeと同時実行時の時間依存3件失敗を記録し、単独再実行で1,784件成功／1,027件skip。stage単体12件、typecheck・build成功。観測16件とhashはvalidation/gradle-kotlin-plugin-2026-11-01.json。
- 今回はtest-only実証。生成manifestの限定した整合性とloader契約下の候補化であり、派生classpath snapshotの全対応、本番helper／exporter／静的取込、新pipeline信頼設定、3ツール／OSV実接続は未実装・未実施。directory、compiler daemon、cache／並行実行等も別課題。

- Kotlin実証レビュー2件を修正: compile出力全file→package入力→JAR entryとclass集合を照合し、descriptor実装classをロード元hashへ結んだ。cache／JDK／agentのpathをrealpathへ統一。両Gradle版各188件が成功し、正常16＋実class差し替え4の20観測へ更新。8.11.1ではcache・JDK alias指定も確認した。旧144件／版の集計は検証JSONのpreReviewへ保持する。本番未対応と追加pipeline信頼・派生入力の未完了は維持する。
- 同修正後の通常回帰は1,788件成功／1,071件skip、stage単体16件、build・typecheck成功。設計・実証・2件のレビュー修正を一括して記録する。
- 6e1d969レビュー修正: stage単体とnative観測改変で期待する拒否理由を確認し、adapter生成順の対照をgeneratorだけの移動に独立化。compile重複・package artifact不一致・余分なclassの単体対照を追加（22件）。native両版188件・通常回帰1,794件成功を再確認。基準revisionをcc40e4cへ訂正し、JARの非class entryが未束縛である限界と本番要件、path alias確認の指定方法を設計書へ追記。


### 2026-11-01: Kotlin構築pipelineの信頼契約・入力manifest具体化（設計のみ）

- [設計書§9](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#9-kotlin構築pipelineの信頼契約入力manifest具体案)へ追補。contract v4／graph v4／adapter v6、独立pipeline trust／profile、作者manifest・stage／cohort／package inventory、判定順と拒否理由を定義した。
- 派生snapshotは公開collectionとlibrariesの明示aggregate対応とし、個別JAR由来と混同しない。集合取得不能やTask.inputsの未知の残りは不採用。観測済み約18 MiBのsnapshotに対し、toolchain-onlyに限定した64 MiB/file・共有256 MiBのchunk streaming経路を提案し、mixed／plugin入力の予算迂回を禁止した。
- class以外のdescriptor／resource／kotlin_moduleを生成stage→copy→packageへ結び、MANIFESTは事前固定profile literalだけを初期許可。自己参照の生成元証拠、未束縛entry、任意merge／filtering／署名等を拒否する。
- KP01〜KP36の回帰条件を追加。新recipe、派生collection、全非class被覆と非干渉の公開API実証は次工程。本番コード・既存実証コード・検証JSONを変更せず、過去の成功件数を新設計の成立証拠へ流用しない。

- Kotlin pipeline設計レビュー2件を反映: 一時MANIFESTのpackage-literal-file型を定義し、固定literal・保存file・JAR entryの三者照合と、自己stageの生成edgeにしない規則を追加。v4 Kotlin分岐のmappingは省略／not-assertedを有効な未表明とし、入力検証後に宣言元だけを省略する。旧schemaの必須条件や参照・hash検証は維持する。専用拒否理由とKP37〜KP44を追加（合計44条件）。設計のみで実証・本番コード・観測JSONは変更しない。
- 9fbd9edレビュー3件を反映: 9.2.1 precompiledのcompilePluginsBlocksにある派生入力20件へplugins-block-classpath cohortを定義（recipe未成立なら当該4構成を初期対象外、KP01は正常12構成）。全観測のNO-SOURCE compileJavaをnon-contributing-java-compileとして閉じた条件で許可。export時の取得不能とMCP読取時の保存blob不整合を分け、kotlin_pipeline_snapshot_storage_mismatchを全file型共通に追加。KP45〜KP47を追加（合計47条件）。設計のみ。


### 2026-11-01: 具体化したKotlin pipeline契約の公開API実証

- [設計書§9.12](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#912-具体化した契約の公開api実証2026-11-01)に取得可能性と採用条件を分けて記録。公開KotlinCompileのlibraries／snapshot collection、選択PluginのCodeSource、実設定、streaming保存・再検証、一時MANIFESTのpublic slotと固定literal、全JAR entryの対応、mapping assertion specimenを追加した。
- **現recipeは不採用。** 両Gradle版でpublic getter読み取りによりlibraries supplierがcompile後に追加評価された（3回→4回）。依存Providerの旧対照が一致しても、この非干渉不足は解消しない。9.2.1 precompiledにはplugins-block用の役割付き公開collection recipe不足も残る。
- 本番adapter／reader／schema／信頼設定は未変更。新契約の採用を0件として保存し、旧helper／loaderの候補を流用しない。KP01〜KP47の全達成を主張せず、実測・部分対照・未実装を設計書とvalidation/gradle-kotlin-pipeline-2026-11-01.jsonで区別する。
- 次は追加評価を起こさない取得契約の再設計・公開API実証とplugins-block recipeの検討。そのレビュー後、成立した範囲だけ本番v4／v6を実装し、最後に3ツール／OSV実接続へ進む。

- 最終確認: 両版native各284件＋supplier各1件、静的specimen29件、通常全体1,823件が成功（native opt-in等1,072件skip）。型チェック・build成功。正常16＋実class差し替え4観測を保存した。


### 2026-11-01: Kotlin pipeline公開API実証レビュー2件の修正

- baselineのresource・生成descriptor・compile出力・必須MANIFESTから期待entryを組み立て、コピー出力／Jar入力／entryが同時に欠けても拒否する。両Gradle版・両consumer DSLの正常16観測に計96件の欠落対照を保存した。
- supplier観測をv2へ更新。実Gradle版・run UUID・observe設定・観測時collector hash・fixture hash、run前後のharness／verifier source hashを保存・照合する。nativeと集約で共有verifierを使い、別版・古いsource・不正phase・任意の異なるtrace・旧形式を拒否する。集約時のコードhashで過去の結果を再ラベルしない。
- 両Gradle版のmatrix各332件、supplierのGroovy／Kotlin consumer各版2件が成功。8.11.1の最初の実行は終了処理10秒timeout（機能検査332件は通過）のため成功へ計上せず、制限を延ばした単独再実行の成功を採用した。初回実証の要約は検証JSONのpreReviewに保持する。
- 4組のsupplier対照はいずれも3回→4回。新pipeline契約は引き続き不成立・採用0件。mappingは限定したassertion specimenで、本番v4 parser・context併合等の未実装範囲は変わらない。詳細は[設計書§9.13](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#913-公開api実証レビュー2件の修正再検証2026-11-01)。

- 最終確認: 静的回帰56件、通常全体1,850件成功・native opt-in等1,073件skip。型チェック・build成功。


### 2026-11-01: 340facdレビュー修正

- supplier対照が実observerの読み取りの一部（libraries／snapshot collection）だけを再現していることを明記した。「3回→4回」は下限で、次の再設計では実observerと同じ読み取りで非干渉を確認する。
- 期待entry欠落のnative回帰は、固定理由ではなく実際の`complete`／`reasons`を保存する。集約ハーネスは実際の拒否結果を要求し、リポジトリrootを自身の位置から解決する。
- consumer DSLがfixtureの構成fileから判定されること、`preReview.recordSha256`が未コミットの記録を指すことを設計書に記した。
- Gradleは再実行せず、保存済み正常16観測から96対照を静的に再計算し、検証JSONの`postReviewRevision`へ追記した。詳細は[設計書§9.14](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#914-340facdレビュー修正2026-11-01)。


### 2026-11-01: Kotlin構築pipelineの全observer非干渉方式の再設計・公開API実証

- [設計書§9.15](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#915-全observerを対象とする入力取得方式の再設計2026-11-01)を追加。observerからの事後固定化を禁止し、producerが最初の自然な読取で値を固定する追加契約を提案。固定化なし／producer固定化／未固定入力混在を比較し、元buildへの透過対応とは区別する。
- Task.inputs.files／outputs、libraries／snapshot、compilerClasspath、plugins、Jarのmanifest／archive／入力、descriptor／resources等を読む同じreaderで対照。thread-local context stackとworker数1でphaseを計測し、実版・source hash・run UUID・fixture hashを照合する。実行時の内部API利用はない。
- 両Gradle×両consumer DSL×3条件、計12対照・24 native buildを実行。各版native8件、静的28件、通常全体1,881件が成功（native opt-in等1,081件skip）。型チェック・build成功。結果はvalidation/gradle-kotlin-observer-2026-11-01.json。
- ownedの4組は計測用supplier／callback traceとJAR entry内容が一致。rawとtaintedの8組は追加評価を検出。raw controlのlibraries3回に対してowned controlは1回なので、既存build無変更の透過的保証ではない。登録完全性・全内部supplierの独立観測も未成立で、本番採用0件を維持する。
- producerはincluded rootのbinary Kotlin／標準kotlin-dslに限定。追加producer契約のレビュー、nonempty・入れ子／treeの制限、buildSrc／precompiledとplugins-block recipe、完全登録adapter・追加信頼profile、本番v4／v6、snapshot保存・静的取込と3ツール／OSVのgateは残る。既存の§9.14の修正・旧主観測は保持し、新しい実証を別のJSONへ保存した。


### 2026-11-01: producer固定化実証レビュー2件の修正

- compilerClasspathを含む全7 factoryを登録区間で囲み、登録中の評価を共有verifierで拒否する。実GradleでfinalizeValue()を意図的に使う負例を両DSL・両版へ追加し、同じtraceでも早期評価を受理しない。
- pre-check・compileJava・descriptor・resources・実行条件・Jar metadataまで全receiptを必須化。通常12対照で23種類ずつ、計276件の欠落拒否を記録し、集約でも再計算する。
- v2観測へ更新。両版native各10件、通常12対照＋早期評価4負例の計32 buildが成功。負例は実際の登録時評価による拒否であり、schema不正による失敗を計上しない。初回v1の要約はpreReviewへ保存。
- ownedの条件付き候補4組と、本番採用0件・既存buildへの透過対応未成立の判断を維持。詳細は[設計書§9.16](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#916-producer固定化実証レビュー2件の修正再検証2026-11-01)。

- 最終確認: 静的76件、通常全体1,929件成功・native opt-in等1,083件skip。型チェック・build成功。


### 2026-11-01: 2f232c9レビュー修正

- producer固定化の方針は試験用init scriptが注入しており、producer sourceにない。KGPのlibraries／snapshot collectionへの`finalizeValueOnRead()`は既存collectionへの事後固定化で、§9.15の作成時登録契約の範囲外。ownedの条件付き候補4組をこの制限付きとし、次は方針をproducer sourceへ置いてhashを結ぶ。
- §9.15のJar source回数を版別に訂正した（8.11.1は4回→5回、9.2.1は3回→4回）。
- archive hashはobserver報告値どうしの照合にとどまることを明記。ハーネス側のarchive hash記録と、欠落対照一覧の共有verifierへの移動は、次のnative再取得で行う。
- Gradleは再実行せず、検証JSONに`postReviewRevision`を追記した。詳細は[設計書§9.17](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#917-2f232c9レビュー修正2026-11-01)。


### 2026-11-01: producer所有入力の登録契約・完全性判定（設計のみ）

- [設計書§9.18](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#918-producer所有入力の登録契約完全性判定設計2026-11-01)へ、producer sourceに結ぶ作成時helper、opaque handleとattachment、seal lifecycle、concrete-files-v1の許可範囲を追加。
- KGP所有collectionへの事後固定化は不許可。追加collectionの登録だけでaggregateを完全とせず、未成立のtoolchain recipeが残ればgetterを読まずunavailableにする。読取前の完全性は作者表明と承認profileに依存し、未知supplierの独立発見とは区別する。
- 独立した追加信頼、read plan／全slot被覆、export証拠・MCP判定・必須limitations、OI01〜OI16の未実施回帰条件を定義。次は設計レビュー、producer source＋非空入力のhelper実証とKGP未対応時のno-read拒否。archive hashのハーネス独立照合と欠落対象一覧の共有化も次回nativeへ含める。
- 設計書のみ変更。実装・native再実行・検証JSON更新は行わず、本番採用0件を維持する。

- §9.18レビュー修正: handle単位のnot-evaluated／evaluating／ready／failedと、seal後の通常buildによる自然評価正常完了をcapture前提へ追加。全read planの準備をledgerだけで確認し、一つでも未準備なら全対象getterを呼ばずunavailable。失敗の回復・別handle／invocation成功による迂回を禁止。toolchainには独立した準備recipeを要求し、OI02／OI05／OI10へ対応条件を追加。設計のみでnative未実施・採用0件は維持。

- 061ed46レビュー修正（§9.18.7）: 早期評価は記録のみでbuildを失敗させずcapture unavailableに統一。helper所有collectionはsealで`disallowChanges()`を適用し、seal後変更を`owned_input_late_mutation`として変更箇所で失敗させる。toolchain／aggregateへのseal後変更は作者表明に依存。実行必須でないstageへの接続は`owned_input_stage_not_executed`で登録gateが拒否。OI04／OI05／OI06／OI10を更新。設計のみ。


### 2026-11-01: producer所有helper・capture準備条件の公開API実証

- [設計書§9.19](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#919-producer所有helpercapture準備条件の公開api実証2026-11-01)へtest-only helperと再現手順を追加。producer build sourceから適用scriptを呼び、両source hashを入力へ結ぶ。作成時固定化と実TaskProviderへの接続・sealを行い、非空2 fileを自然評価内で検査・copyする。
- 未評価／評価中の再入／評価失敗後のcaptureは、全owned getterを呼ばず拒否。KGP未対応は全owned handleがreadyでもread前に拒否する。実KGP公開getterのclosureは評価せずcounter 0を確認する。
- Groovy／Kotlinの同DSL consumer・producer組合せとGradle 8.11.1／9.2.1を対象とし、全交差・buildSrc／precompiledは未検証。OI02／OI05／OI10の準備条件部分に限定し、全observer・本番完全登録・追加信頼・静的取込は未達。本番採用0件を維持する。

- 最終検証: native両版各10件成功、8 build・20条件対照（正常helper4、no-read拒否16）をvalidation/gradle-owned-inputs-2026-11-01.jsonへ保存。静的15件、通常全体1,944件成功／1,093件skip、typecheck・build成功。全pipeline候補0件・本番採用0件を維持。


### 2026-11-01: producer所有helper実証レビュー2件の修正

- [設計書§9.20](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#920-producer所有helperの読取計測必須event検証の修正2026-11-01)へ追記。owned／KGP readerを共通化し、getter eventとcounter・phase・gateとの順序を照合。実際にreadyなmainをgate前に読むnative負例を追加した。
- 登録4境界・seal・Action開始／終了を全条件・全runで必須化。欠落対象を共有定義へ集約し、native／集約で同じ拒否対照を実行する。v2へ更新し、旧v1要約はpreReviewへ保持する。
- 所有helper限定の実証とKGP unsupportedのno-read拒否を維持。全pipeline候補・本番採用0件の判断は変えない。

- 再検証: native両版各14件成功、12 buildを保存。通常20条件対照に加え、gate前の実読取4負例と必須event欠落280対照をすべて拒否し集約で再検証。静的64件成功。本番採用0件を維持。

最終確認: 通常全体1,993件成功・native opt-in等1,097件skip。型チェック・build・差分チェックも成功。今回の変更はtest-onlyの実証・検証器・記録で、本番採用0件を維持する。


### 2026-11-01: 38d0b2aレビュー修正・v3再検証

- KGP readerを呼ぶ到達しない行を削除し、gate前にKGPの公開librariesを実際に呼ぶnative故障`preGateKgpRead`を追加。両DSL・両版の4 buildでkgp-getter 1件・counter 1を記録し、getter-before-gateで拒否した。偽の故障・承認不一致も静的回帰で拒否する。
- sealでhelper所有collectionへ`disallowChanges()`を適用し、`changesDisallowed`を必須化。late mutationのnative負例（OI06）と診断は未実装。
- 集約値を検証済みmatrixから計算するよう変更し、置き換えた記録を`preReviews`配列へ要約として残す（v1は照合不能、v2は38d0b2aのコミット記録と照合可能）。
- 再検証: native両版各16件成功、16 build（通常8・故障8）、静的68件。全pipeline候補・本番採用0件を維持。詳細は[設計書§9.21](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#921-38d0b2aレビュー修正v3再検証2026-11-01)。


### 2026-11-01: KGP所有入力のcapture準備契約（設計のみ）

- [設計書§9.22](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#922-kgp所有入力のcapture準備契約設計2026-11-01)へlibraries／classpath snapshot／compilerClasspath／Task.inputsのslot別binding・準備根拠・不足条件を追加。
- 優先方式は自然消費時に所有者が渡す具体列receipt。限定候補の安定再読取には公開保証と非評価のruntime witnessを要求する。既存KGPにhookが存在するとは仮定せず、task成功／RESOLVED／既存fileをreadyへ昇格させない。全slot preflight未完了はreadyな他slotも含めてgetter 0で拒否する。
- token lifecycle、独立した承認recipe/profile、export証拠・metadata・拒否／省略判定、未実施のKI01〜KI22を定義。両Gradle版の公開interfaceシグネチャは確認したが、native実証・既存v3検証JSON・本番コードは変更せず、全slot既定unsupportedと全pipeline候補／本番採用0件を維持する。


- KGP準備契約レビュー修正（§9.22.8）: completeSlotへcontentBindingsを追加。自然消費時点のsize／SHA-256と、保存bytesまたは自然時に再検証したbaseline参照をreadyの必須条件にした。全体gate中に内容証拠を生成せず、最初のcaptureから元証拠との照合を要求する。KI07／KI18を拡充し、証拠欠落・baseline流用・receipt後capture前の実派生file改変・保存中変更のKI23〜KI26を追加（全26条件、未実施）。設計のみで既存v3実証・本番未採用の判断は維持。

- 6e1ac6cレビュー修正（§9.22.9）: §9.22.8の結果を理由表へ反映（内容証拠の合法な未取得はunavailable、矛盾はgraph拒否、staleはslot型ごとに`kotlin_pipeline_inputs_stale`／`kotlin_derived_snapshot_stale`、保存blob不一致はgraph拒否）。javapで確認したgradle-core-api JARのhash・interface別digestを記録。owner-materializedの読取範囲の表現を統一し、KI25／KI26を隔離cacheで行う条件にした。設計のみ。


### 2026-11-01: KGP所有4入力の取得可能性調査・公開API診断

- [設計書§9.23](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#923-kgp所有4入力の取得可能性調査公開api診断2026-11-01)に、対象KGP実artifactのCodeSource／hash、14 public型のsignature・snapshot注釈調査と、両Gradle／両DSLの通常12＋故障4 native buildを記録。
- libraries／compilerClasspath／Task.inputsは通常compile後の診断getterで各sensorが+1評価。snapshotは順序付き診断でdelta 0だったが、準備witness・自然時内容束縛は未成立。全4 slotをunsupportedのまま16診断・16 no-read拒否を保存した。control／unsupportedの自然traceと全modeのJAR entry内容を照合した。
- 元collectionの事後固定化を行わず、取得可能性と採用可否を分離。限定surveyで公開hookを確立できなかった結果であり、API不存在の網羅的証明とは扱わない。次は実証レビュー、snapshot限定の公開安定性・binding／witness調査、または自然消費値を渡す具体hookの特定。本番採用0件を維持する。

- 最終確認: native両版各14件成功、16 build・16診断・16 no-read拒否・実snapshot読取負例4件を保存。静的31件、通常全体2,028件成功／1,113件skip、typecheck・build成功。検証JSONはvalidation/gradle-kgp-availability-2026-11-01.json。


### 2026-11-01: KGP取得診断レビュー2件の修正

- [設計書§9.24](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#924-kgp取得診断レビュー修正api-bindingと故障trace2026-11-01)に追記。nativeのTaskInputs／KotlinCompileTool実CodeSourceとdigestをAPI調査へ束縛し、Gradle runtime候補の別実体を拒否。KGP APIのcache候補選択も廃止した。
- slot／getter開始・終了とphaseを検証し、getter区間の全supplierからdeltaを再計算。故障traceも全証拠を検査してから期待したno-read違反を認定する。14種類の改変対照をnative／集約で共有し、不正phase・区間外移動・artifact欠落等を拒否する。
- v2へ更新し、旧未コミットv1は要約としてのみ保持。初回の厳密化で通常task graph準備を過剰拒否した点は、登録後・最初のtask前に限定して許可する回帰で修正した。本番採用・全pipeline候補0件を維持する。

- 最終確認: native両版各18件成功、最終16 buildを保存。故障trace改変56件・記録済みbindingを交換した静的API対照4件・実Gradle版違いdirectory対照2件を拒否して集約で再計算。静的56件、通常全体2,053件成功／1,117件skip、typecheck・build成功。v2のsourceとAPI artifact hash一致を確認した。


### 2026-11-01: 5149117レビュー修正・記録pathの可搬化

- KGP取得診断の検証JSONに残っていた端末固有の絶対path（82か所）を、`$GRADLE_USER_HOME`／`$GRADLE_RUNTIME`のtokenへ置換。集約は絶対pathで再検証した後に置換し、残存pathがあれば書き出さない。tokenの解決は環境変数の絶対pathに限定し、`..`等を拒否する。
- Gradleは再実行せず、保存済みv2 native出力を再集約。置換以外の内容は一致し、観測時の`recordedAt`／`baselineRevision`を保持して再集約時点を別記した。静的回帰3件を追加（修正前の記録で失敗を確認）。
- §9.24の「native別API対照」を、記録済みbindingを交換した静的対照と訂正。採否と本番採用0件は不変。詳細は[設計書§9.25](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#925-5149117レビュー修正記録pathの可搬化2026-11-01)。


### 2026-11-01: snapshot限定のbinding・実行完了witness実証

- [設計書§9.26](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#926-snapshot限定の実参照binding実行完了witness2026-11-01)へtest-only実証を追加。producer settings sourceからKGP構成前にhelperを登録し、実Task／nested property参照・API digest・実行完了ledgerを非評価で確認する。plugins適用後のsensor追加は既に変更禁止だったため解除せず、事前登録へ切り替えた。
- 両DSL・両Gradle版の4組でsnapshot再読取の追加sensor評価0を確認。実行途中・実decoy Task／libraries property・skip・live sourceは値を読まず分類拒否。変更禁止の診断は別buildで実施し、isFinalized照会やdeep immutabilityの証明とは扱わない。
- 条件付きwitness 4組に限定し、承認済みrecipe・全pipeline候補・本番採用は0。自然時内容receipt・全observer・未変更build baseline・残り3入力等は未成立。検証データはvalidation/gradle-snapshot-readiness-2026-11-01.json。

- 最終確認: native両版各16件、20 buildが成功。条件付きwitness4組、no-read分類拒否20件、変更試行の拒否4件を保存。静的29件、通常全体2,085件成功／1,133件skip、typecheck・build成功。記録はpath tokenを使い、API／source hashを再検証した。


### 2026-11-01: snapshot witnessレビュー2件の修正

- [設計書§9.27](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#927-snapshot-witnessレビュー修正cached-preflight読取とtaskstate2026-11-01)へ追記。分類器へ実Task／FileCollectionを渡さず、型を検証したimmutableなprimitive factsだけを渡す。値読取をbrokerへ集約し、拒否前の実cached読取を区間event・counterで検出する故障buildを追加した。
- TaskState全7fieldを必須booleanとし、正常完了をflags＋Action境界から再計算。noSource／skippedの欠落・不正型・boolean不整合80条件をnative／集約で共有する。v2へ更新し、旧v1は未コミットの要約として保持。
- 条件付きwitness4組と承認済みrecipe・本番採用0件の区別、自然時bytes束縛等の未成立範囲は維持する。

- snapshot witnessレビュー修正の最終再検証（§9.27）: 両DSL・両Gradle版、各版20テスト／計24 native build成功。cached preflight読取の拒否4件・TaskState改変の拒否320件を集約で再検証。静的132件・全体2,188件成功（1,137件skip）、typecheck／build成功。承認済みrecipe・本番採用0は維持。


### 2026-11-01: 48055fdレビュー修正（snapshot公開記録の再検証）

- snapshot readinessの検証JSONを通常の静的テストで再検証するようにした。source／検証source／API参照記録のhash、判定・TaskState拒否・故障観測・scopeを現在の検証器で照合し、絶対pathを拒否する。負例6件を追加し、修正前の記録で失敗することを確認した。
- 故障proofと通常caseの対応（故障以外のrun・case identityの一致、故障run IDの区別）を集約と静的テストで共通に必須化。再集約時は観測時の`recordedAt`／`baselineRevision`を保持し、JAR内容の算出sourceもhashへ結んだ。
- Gradleは再実行せず保存済みv2 native出力を再集約。内容・採否・本番採用0件は不変。詳細は[設計書§9.28](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#928-48055fdレビュー修正公開記録の静的再検証2026-11-01)。


### 2026-11-01: snapshot境界内容束縛・最初のcapture鮮度の設計と公開API実証

- [設計書§9.29](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#929-snapshot内容束縛capture鮮度の公開api境界実証2026-11-01)へ、自然消費receiptの採用要件とTask.doFirst境界候補の差、保存bytes／内容アドレスblob、具体pathだけを使う最初のcapture照合を追加。
- 隔離cacheの実派生fileをcompile完了後に同size書換え・増加・削除してstaleを確認し、保存bytes破損・receipt未取得も別に拒否する。全必須event／stage／bindingとsupplier trace、JAR全entryを共有verifierで照合する。
- doFirstはKGP消費hookではなく、両端一致でも消費時bytesや途中変更／復元は証明しない。自然消費時内容束縛・承認済みrecipe・本番採用0は維持。次は所有者の自然消費hookまたは消費中不変を拘束できるproducer／toolchain契約の具体化。

- 最終再検証（§9.29）: 両DSL・両Gradle版で各版16テスト、28 build成功。境界候補4組、実file改変拒否12件・保存bytes破損拒否4件・receipt未取得no-read拒否4件・記録改変拒否108件を保存・再生。静的／保存記録63テスト・通常全体2,258件成功（1,153件skip）、typecheck／build／差分検査成功。自然消費時内容束縛・承認済みrecipe・本番採用0は維持。


### 2026-11-01: snapshot内容実証レビュー・cached読取とsupplier区間の修正

- [設計書§9.30](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#930-snapshot内容実証のレビュー修正cached読取とsupplier区間2026-11-01)へ、共通reader、capture／no-receiptの実cached読取故障、全証拠確認後の期待拒否、phaseと位置の独立検証を追加。
- 3 phase×5 observer位置の15対照と、controlも同時に移動するcase対照3件を共用。故障runの通常modeへの対応・別run ID・保存blob復元も検証する。v2へ更新し旧v1は未コミット履歴の要約として保持。
- Task境界候補とKGP自然消費bytesの対応を未成立とする判定は維持し、自然消費内容束縛・承認済みrecipe・本番採用0は変えない。

- 再検証（§9.30）: 両DSL・両Gradle版で各版20テスト、通常28＋故障8＝36 build成功。実cached読取拒否8件・記録改変拒否168件・同時trace移動拒否12件をnative／集約で確認。静的・公開記録再生106テスト成功。自然消費内容束縛・承認済みrecipe・本番採用0は維持。

- 通常全体2,301件成功（1,157件skip）、typecheck／build／差分検査も成功。


### 2026-11-01: 503f25cレビュー修正（snapshot内容記録の保存bytes縮小）

- snapshot内容実証の検証JSONが全boundary bytes（gzip blob 42件、11.3MB）を収録していたため、公開記録で保持するbytesを保存bytes破損の証拠だけに絞った。verifierへnative／published storage modeを追加し、全bytesの照合はnativeと集約時に行う。改変対象は最小の非空fileへ変更し、verifierで照合する。
- 再集約時の観測時点保持、判定理由からのscope集計、公開記録の改ざん負例6件を追加した。
- nativeを取り直し（各版20テスト、36 build）、記録をv3へ更新（789KB、保持blob 1件）。v2は503f25cの原本hash付き要約として保持。自然消費内容束縛・承認済みrecipe・本番採用0は不変。詳細は[設計書§9.31](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#931-503f25cレビュー修正公開記録の保存bytes縮小2026-11-01)。


### 2026-11-01: snapshot自然消費hook調査とproducer所有契約

- [設計書§9.32](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#932-snapshot自然消費hookの調査producer所有契約と打切り条件2026-11-01)へ、既存KGPのhook・Task完了・transform・compiler plugin・BTAを比較し、Aの実consumer receiptとBのsealed offered inputsを分離した登録・内容・完了・信頼契約、SO01〜SO10、採用／打切り条件を追加。
- 両tupleで公式tag sourceと実bytecodeを照合。getClasspathChangesはprivateでcompiler環境構築のincremental分岐内。既存の非incremental Task境界実証をcompiler消費証拠へ昇格させない。
- BTA公開parameterはmutable Listをaliasし、callerの防御的copy＋unmodifiable Listで列を固定できることをstandaloneで実測。File列の固定とbytes不変・自然消費は別条件。利用可能なBTA artifactを既存KGPの選択済み実装と扱わない。
- 14型×2 tuple、公式source 2件、公開constructor probe 2件を新規記録。新Gradle build／compiler実行／DSL matrixは0。現対象の既存KGP透過recipeはunsupportedとして打切り、上流API／対象tuple／明示owner integrationが変わる場合に再開。新BTA owner driverは別工程で、自然消費内容束縛・承認recipe・本番採用0は維持。

- 最終確認（§9.32）: 14型×2 tuple・公開constructor probe 2件を保存・静的再検証。通常全体2,339件成功（1,157件skip）、typecheck／build／差分検査成功。新Gradle build／compiler実行は0。次は新BTA owner driverの限定実証を別工程で扱い、自然消費hook／保証が成立しなければoffered-inputs-onlyを維持する。


### 2026-11-01: snapshot owner調査レビュー・guardとartifact証拠の束縛

- [設計書§9.33](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#933-owner調査レビュー修正guard範囲とartifact別の固定期待値2026-11-01)へ追記。guard call／ifeq／read／false targetの順序、method別の命令offsetの単調増加を要求し、guard前への移動を拒否。
- 実JARから取り直したclass／signature／bytecode digestをartifact別の期待表へ固定。collectorは期待表を更新せず、自己hashを一緒に更新した改変や別class digestも拒否する。期待表をsource hashへ含め、experiment v2へ更新。
- 旧v1は未コミット履歴の要約として保持。両対象版の調査・standalone公開API実証を再実行し、自然消費hook未成立・既存KGP unsupported／打切り・承認recipe／本番採用0の判断を維持する。

- 両対象版の14型×2組・BTA公開constructor probe 2件を再実行してv2記録へ更新。固定期待値28型とsource 8 fileのhash一致、旧v1履歴要約1件、回帰41テスト成功を確認。新Gradle build／Kotlin compiler実行は0（probe用javac／javaは別）。

- 通常全体2,353件成功（1,157件skip）、typecheck／build／差分検査も成功。unsupported／打切りと本番採用0の判断は不変。


### 2026-11-01: 96f7da8レビュー修正（owner調査のJDK profile束縛とsource抜粋化）

- 固定期待表へjava／javac／javapの版とhash（JDK 21.0.13+9）を固定し、調査記録の`jdkTools`との一致を必須にした。
- KotlinCompile.ktのtag source全文の収録をやめ、全文digest・取得元・Apache-2.0とLICENSEへのURL・原著作権表示と、判定に使う3か所の行番号付き抜粋だけを保持する。抜粋digestをtuple別に固定し、verifierは抜粋から判定を再計算する。
- §9.32.3の防御的copyの記述を訂正（BTAで観測したのはaliasと可変性のみ）。再収集時の観測時点保持と改ざん負例7件を追加。
- Gradle build・Kotlin compiler実行0のまま再収集し記録をv3（105KB）へ更新、v2は96f7da8の原本hash付き要約として保持。unsupported／打切り・本番採用0は不変。詳細は[設計書§9.34](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#934-96f7da8レビュー修正jdk-profileの束縛とsource抜粋化2026-11-01)。


### 2026-11-02: producer所有BTA driverの限定実証

- [設計書§9.35](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#935-producer所有bta-driverの限定実証2026-11-02)へtest-onlyのJava driver・Gradle adapterを追加。正規snapshotを自作library.jarと同版stdlibから生成し、private staging／evidenceへ保存。実BTAでlibrary・warm・更新consumerをcompileし、出力programを実行する。
- 固定runtime manifestと実CodeSource、source／JAR entry／snapshot／引数／全出力を照合。consumer前後の改変、保存evidence破損、owned Providerの実追加評価を別に拒否し、controlとobserverを比較する。
- Groovy／Kotlinのproject wrapperから共通Groovy adapter・Java driverを呼ぶ実証。既存KGPの透過対応・自然消費receipt・全writer排除・本番採用は未成立。提供入力の証拠と自然消費bytesの区別を維持する。

- 最終native（§9.35）: 両DSL・両Gradle版で各版16テスト、24 build・実compileJvm 64回・正規snapshot 48個。提供入力候補8件、stale拒否8件・保存破損拒否4件・実追加評価拒否4件、記録改変拒否84件を保存・再生。control／observeのsupplierは3回で一致（故障は4回）、具体列selectionは1回。静的／公開記録30テスト成功。Gradle側・BTA child側JVMを固定JDKへ結び、source hashも一致。自然消費receipt・承認recipe・本番採用0は維持。

- 通常全体2,391件成功（1,173件skip）、typecheck／build／差分検査も成功。


### 2026-11-02: BTA configuration／snapshot parameterの束縛補強

- [設計書§9.36](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#936-bta-configurationsnapshot-parameterの実参照束縛2026-11-02)へ、実configuration・公開IC parameter・期待Bindingの参照照合と一回限りの使用を追加。独立した報告用snapshot列から実consumerへの対応を推定しない。
- 既定・未登録IC・同値の別登録configurationを最終consumerへ渡すnative負例を追加。両DSL・Gradle 8.11.1／9.2.1の12件すべてで最終BTA呼出し前に拒否し、warm出力を最終成功と扱わない。
- 両版各28テスト、36 build・実compileJvm 88回・snapshot 72個を再実行。記録改変116件と静的回帰44件が成功。v2記録へ更新し、旧v1は参考履歴に限定。自然消費receipt・承認recipe・本番採用0は維持。


### 2026-11-02: fd66e03レビュー修正（BTA公開記録v3）

- [設計書§9.36.1](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#9361-fd66e03レビュー修正公開記録v32026-11-02)へ、snapshot descriptorがsealed-by-pathであること、再使用・context・path不一致の拒否がnative未実証であることを明記し、記録の`bindingSemantics`で固定。
- private IC cacheを要約して公開し（1.74MB→1.21MB）、native viewで元verifierと記録改変対照を再生。観測digestが同じ再集約では観測時点を保持。native再実行0、静的テスト55件。


### 2026-11-02: producer所有BTA driverの採用範囲・信頼契約（設計）

- [設計書§9.37](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#937-producer所有driverの提供入力証拠採用範囲と信頼契約設計2026-11-02)へ、helperの登録／実参照binding／一回限りの使用／完了契約、envelope必須証拠と保存bytes・鮮度確認を具体化。
- 診断専用のoffered-inputs-onlyとし、自然消費ready・declared_in補完・coverage改善への利用を禁止。追加信頼（既定無効）と独立承認profile、固定limitations、読取前gate・未対応と構造／integrity拒否の区別を設計。
- OO01〜OO14の回帰条件を追加。本番helper／schema／設定は未実装、現test profileは未承認。新規native実行・自然消費receipt・承認recipe・本番採用0。次は状態機械／envelopeの限定実証と未実施staging条件の検証。


### 2026-11-02: BTA採用契約のレビュー修正

- §9.37のenvelopeをcompleted／failed／unavailableの状態別unionへ具体化。phase別の必須証拠・未到達証拠の省略・禁止項目とreaderのimportStatusを分離し、OO02／OO13を拡充。
- completedをBTA呼出しと前後検査の完了に限定。内部no-opの判別は未成立のためbta-call-only／compilerWorkStatus=unknownを必須とし、実コンパイル確認へ昇格しない。変更なしの実BTA再呼出しをOO09のnative条件に追加。
- 設計変更のみ。新規native実行・実装・profile承認は行わず、自然消費receipt・本番採用0を維持。


### 2026-11-02: 16c101dレビュー修正（BTA採用契約の拒否分類と状態）

- §9.37.5の理由をproducer記録（unavailableReason／failureReason）とreader判定（importStatus）へ分離。producerが自ら検出した拒否はproducer_failedとして受理しgraphを拒否せず、graph拒否は表明と再照合の矛盾に限定。信頼無効・profile未承認・envelope欠落はreader側のunavailableへ移動。
- completedを予定capture全件の完了後の終端状態とし、postcheck後は中間状態postchecked。completed→failedの遷移を廃止。
- test記録の`observationKind`と本envelopeの`consumptionStatus`／`observationKind`の対応を明記。parameterのpath列不一致をfailed記録のbinding拒否とし、OO06でnative負例を必須化。OO13を拡充。
- 設計変更のみ。実装・native実行・profile承認0、自然消費receipt・本番採用0を維持。


### 2026-11-02: producer所有helper・状態別envelopeの限定実証

- [設計書§9.38](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#938-producer所有helper状態別envelopeの限定実証2026-11-02)へtest-onlyのJava brokerと静的reader、native／公開記録再生ハーネスを追加。実configuration／parameter／project、登録締切・一回限り使用・再入・失敗後再使用、状態別phase／証拠の契約を限定実証。
- 両DSL・両Gradle版で各版24テスト、4 build・BTA呼出し16回、snapshot 8個。completed 4／failed 32／unavailable 4、handle拒否24・integrity拒否24を記録。信頼無効・profile未承認時のreader読取0、静的／公開記録再生50テストを確認。
- 完全な構築／入力manifest、本番取込・承認profile、storage全故障・全observer計測、OO09の変更なし再呼出しは未実施。bta-call-only／compilerWorkStatus=unknownを維持し、自然消費receipt・本番採用0。次はno-op対照とstaging条件の拡充。


### 2026-11-02: 状態別envelopeのレビュー修正

- [設計書§9.39](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#939-状態別envelopeのレビュー修正call結果とcase別期待値2026-11-02)へ、成功・未知call failure resultの拒否と、case別期待状態／phase／理由の照合を追加。failed→unavailableへ記録・判定を同時変更する回帰対照を追加。
- probe-v2のlibrary実行／snapshot生成証拠と、検証済み状態・call event・拒否auditから件数を算出し、報告counterとの不一致を拒否。実証記録をv2へ更新し旧v1は参考要約に限定。
- 両DSL・両Gradle版を再実行して各版24テスト、静的／公開記録62テスト成功。最終4 build・BTA呼出し16回、snapshot 8個、completed 4／failed 32／unavailable 4。本番採用・自然消費receipt0と既存の未実施範囲を維持。


### 2026-11-02: a6d5409レビュー修正（offer readerのproducer記録拒否とcapture計画）

- [設計書§9.40](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#940-a6d5409レビュー修正producer記録拒否とcapture計画2026-11-02)へ、producer記録のfailedを`producer_failed`として受理しgraphを拒否しない判定へ修正。staleはgate後の再読取で不一致を確認した場合だけ受理し、一致すれば`claim_mismatch`。理由のphase固定、`producerReason`とreader理由の分離。
- `plannedCaptures`と中間状態pendingを追加し、completedを終端化。unavailableはbinding以前に限定。nativeにcapture-failed／foreign-pathsを追加。
- 両DSL・両版を再実行して各版30テスト。4 build・BTA呼出し20回、completed 4／failed 40／unavailable 4、producer記録拒否32件・reader graph拒否0件。記録v3、静的83テスト。本番採用・自然消費receipt0を維持。


### 2026-11-02: OO09・変更なしBTA再呼出しとTask skip／cache対照

- [設計書§9.41](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#941-oo09変更なしbta再呼出しと実task-skipcache対照2026-11-02)へ、同じsource・snapshot・IC・projectを新Handle／configuration／parameterで再呼出しするnative対照を追加。Knownのmodified／removedは空、結果はbta-call-only／unknownを維持。
- project専用local cacheでseed→実SKIPPED→出力削除→実FROM-CACHEの3 buildを両DSL・両版で検証。fresh TaskState／executionIdとcache外action logを照合し、残存／復元reportを今回の成功へ採用しない。
- 両版各36テスト、最終12 build・変更なし再呼出し4件・BTA呼出し24回・snapshot 8個。公開記録v4、静的103テスト。内部no-op判別・自然消費receipt・本番採用0は維持。次はstaging／保存証拠のnative拡充。


### 2026-11-02: OO09レビュー修正（IC内容束縛・readerの実行gate）

- [設計書§9.42](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#942-oo09レビュー修正ic内容束縛と取込入口の実行gate2026-11-02)へ、先行成功後のIC inventory・size／digest・実体の保存とpre-call照合を追加。独立したseedからの削除・改変・再初期化12件をBTA retry前に拒否。
- readOwnedOfferにfresh witnessと期待executionIdを必須化。実SKIPPED／FROM-CACHEへ成功envelopeを渡す8件をfile reader 0で拒否し、実行済みwitnessでも古いenvelopeのIDを採用しない。
- 両版各42テスト、静的121テスト。最終12 build・BTA呼出し36回・正常終了32回、completed 20／failed 52／unavailable 4。公開記録v5へ更新し旧未コミットv4は参考要約に保持。内部no-opはunknown、自然消費receipt・本番採用0を維持。


### 2026-11-02: c555f4fレビュー修正（実行gateの理由と公開IC記録）

- [設計書§9.43](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#943-c555f4fレビュー修正実行gateの理由と公開ic記録2026-11-02)へ、実行witnessの真正性が呼出側依存であることを明記。未実行を`owned_offer_action_not_executed`、実行済みでのID不一致を`claim_mismatch`とし、§9.37.5の表へ追加。未実行の戻り値も共通形にした。
- IC記録のfileKeyをrun内tokenへ置換し、icChecksの基準複写を除去（1.49MB→1.13MB）。sameIcContentsの順序依存を解消。
- 両DSL・両版を再実行して各版42テスト、件数は§9.42と同じ。記録v6、静的126テスト。本番採用・自然消費receipt0を維持。


### 2026-11-02: staging・保存証拠の境界native実証

- [設計書§9.44](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#944-staging保存証拠の境界検証とcapture前後の改変拒否2026-11-02)へ、staging／evidenceのancestor・root・file実体、flat inventory、size／digestと容量のseal・前後検査を追加。最初のledgerを固定しrepeatへ継承。
- 両側のsymlink・同bytes置換・未記録file・容量超過、実保存write失敗、capture処理前後の改変をnativeで拒否。追加20 case、両版各82テスト。保存領域拒否96件、最終12 build・BTA呼出し60回・正常終了56回、公開記録v7・静的158テスト。
- 公開証拠はledger一式と成功時のdigest、拒否時の必要metadataに限定。新規検証器で欠落・改変・自己hash更新を含む対照を拒否。自然消費receipt・本番採用0、全writer排除や全observer計測は未成立。次は完全な構築・入力manifest／汎用静的取込の契約と実証。


### 2026-11-02: 保存境界レビュー修正（write前gate・bounded列挙）

- [設計書§9.45](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#945-保存境界レビュー修正書込前symlink拒否と列挙上限2026-11-02)へ、source読取前と各write直前の両保存先・祖先検証を追加。root／共通祖先symlinkの12件で保存write試行・保存byte・領域外の保存書込0を確認。
- source listingの計数とlimitをsortより前へ移動。202-file directoryの8件で17 entry（上限16＋1）に停止し、全listingの上限も検証。
- 両版各96テスト、静的177テスト。最終12 build・BTA呼出し60回、保存領域拒否116。公開記録v8へ更新し旧未コミットv7は参考要約へ。内部no-opはunknown、自然消費receipt・本番採用0を維持。


### 2026-11-02: a5be821レビュー修正（取込み時のbounded readerと理由表）

- [設計書§9.46](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#946-a5be821レビュー修正取込み時のbounded readerと理由表2026-11-02)へ、取込み時の`boundedOfferReader`（各componentのsymlink拒否、O_NOFOLLOWと実体照合、登録名との一覧一致）を追加し、nativeハーネスの全読取を置換。completed後のsymlink化・root逸脱・登録外fileを両DSL・両版で取込み拒否（12件）。
- §9.37.5の理由表を実装へ合わせ、producerの`path_invalid`とreaderの`owned_offer_path_invalid`を区別。保存境界の拒否はreaderが再確認しないことを明記。
- Java producerは無変更。各版104テスト、記録v9、静的189テスト。祖先列の共有化は効果が小さいため見送り。本番採用・自然消費receipt0を維持。


### 2026-11-02: producer所有driverの構築・入力manifest契約（設計）

- [設計書§9.47](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#947-producer所有driverの構築入力manifest契約設計2026-11-02)へ、owned-recipe-inputsの完全性domain、必須role、bundle／ref DAGと循環hash回避、canonical bytes、source→構築output→実行artifact→snapshot／offerの対応を具体化。
- 独立承認profile・toolchain image・loader／executorの信頼と、readerの現在内容照合・caller witnessを分離。seal時刻、保存bytes、全inventory・budget・no-read gate、producer失敗とreader拒否の分類を設計。
- BM01〜BM20の回帰条件と静的contract→所有構築recipe→実BTA入力閉包の実証順を追加。設計のみで新規native実行・承認profile・自然消費receipt・本番採用0。


### 2026-11-02: 構築・入力manifest設計のレビュー修正

- §9.47.2のbundleをproducerState／completedThrough／failureStage・blockedStage別のunionへ具体化。成功refの累積prefixと未到達refの禁止、独立したfailure／unavailable証拠、解決前のprofile digest省略、index保存失敗の扱いを追加。
- §9.47.4へ新規・空の専用driver output root、作成時とcompiler直前の空判定・実体照合、入力rootとの非alias、失敗後のroot再利用禁止を追加。共有driver artifactとOO09のconsumer／IC再利用とは分離。
- BM02／BM06／BM17に状態別ref、古い内側class・resource混入、部分output・失敗prefix・再試行の回帰条件を拡充。設計のみで新規native実行・本番採用0を維持。


### 2026-11-02: 13af673レビュー修正（manifest設計の参照の向きと分類）

- [設計書§9.48](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#948-13af673レビュー修正参照の向きreader理由欠落時の分類2026-11-02)へ、envelopeはbundleを参照せず`ownedOfferBundles`のdigestの組で結ぶ参照の向きを追加し、offer receiptとenvelopeを分離。
- §9.37.5のreader理由へ`owned_offer_content_mismatch`を追加し、claim_mismatchとの違いを明記。bundle・index欠落時のreader分類を§9.47.6へ追加。
- canonical JSONのescape規則を具体化し、既存`BtaOwnedDriver.json()`の流用を禁止。BM01を拡充。設計のみで実装・native実行・本番採用0。

### 2026-11-02: manifestのschema・canonical digest・状態別refの静的contract

- [設計書§9.49](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#949-manifestの静的contract実装2026-11-02)とtest用validatorを追加。bundleの状態／連続prefix別の必須・禁止ref、独立したprofile／recipe・binding、envelopeとのdigestの組、indexの閉包・循環・自己参照・未知fieldを検証する。
- BM01／BM02／BM03／BM17の104テストを追加。親refも再hashしたcontext／build／invocation・状態claimの交換を拒否。独立Java encoderとNodeで12 vector（正常6・拒否6）を比較し、36行の静的ケース・source fingerprint・JDK／probeのhashを[検証データ](validation/gradle-owned-manifest-contract-2026-11-02.json)へ保存。再現ハーネスと再生テストを追加。
- 型検査・build・全体テスト成功（90 files、2,709 tests、19 files／1,289 tests skipped）。追加Gradle native／実driver構築／BTA呼出し0。canonical oracleのみjavac／java各1回。
- 最小stage metadataの静的contractに限定。全入力role／実output・artifact・snapshotのschema拡張と実内容・鮮度の実証は次段階。structure_verifiedから診断採用・declared_in・coverageへ昇格せず、本番profile承認・自然消費receipt・本番採用0を維持。


### 2026-11-02: 451b629レビュー修正（manifest静的contractの抜け道）

- §9.49へ修正の小節を追加。approvalStatusとunavailable理由を対応させ（未解決はprofile_unapprovedのみ、解決済みでは禁止）、field名を印字可能ASCIIに限定し（encoder・parser・Java oracle）、bundle・envelope・coreGraphにもcanonical bytesを要求。
- 再生テストでJDK hashを照合し、記録をv2（recordedAt／baselineRevision、v1はpreReviews）へ更新。静的126テスト、canonical 16 vector一致。Gradle・BTA実行0、本番採用0を維持。

### 2026-11-02: 所有javac recipeの構築manifest・fresh output・実行artifactの限定実証

- [設計書§9.50](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#950-所有javac-recipeの構築manifest新規output実行artifactの限定実証2026-11-02)へ、具体source／引数／env・空classpath／sourcepathを持つ構築manifest、元sealとの前後比較、新規・空rootの2点検査、全class inventoryとJARの出自対応を追加。JARからouter／inner classを実ロード・実行する。
- sourceの変更・追加・欠落、未登録source・processor／implicit source／argfile／generator、既存root・symlink・alias・未記録entry・root置換、余分／欠落classと不正JARを拒否。削除sourceの旧内側classが新rootへ混入せず旧outputが不変であること、compiler失敗時のGood.classを隔離し旧root再試行を拒否、新root再試行が成功することを実証。
- Groovy／Kotlin × Gradle 8.11.1／9.2.1で各39 case、各版78 nativeテスト。最終4 build・156 case、実javac呼出し76・JAR実行20・正常構築12・拒否144。保存失敗前に実行済みの8回も実行件数に含める。BTA呼出し・自然消費receipt・本番採用0。
- [検証データ](validation/gradle-owned-javac-construction-2026-11-02.json)と再現ハーネスを追加し、BM04〜BM07・BM17の静的210テストでsource fingerprint・API／JDK pins・状態別必須証拠・実entry・元seal・実行件数を再生。型検査・build成功、全体91 files／2,941 tests成功（20 files／1,367 tests skipped）。
- 構築scopeのbuildState完了に限定し、本番offer完了や入力closure全体の採用へ昇格しない。JDK／Node image全体・loader／executorの独立承認、host script評価bytes・全observer・任意writer排除、実BTA runtime／library／snapshot／offer閉包と鮮度、本番取込は次段階。


### 2026-11-02: cd2b982レビュー修正（所有javac executorの環境とinventory順序）

- §9.50へ修正の小節を追加。Gradle recipeがexecutor（Node）の環境を消して`TZ=UTC`だけを渡し、ハーネスが渡す`NODE_OPTIONS` preloadが実行されないことをnativeで記録・検証。OSが加える変数は名前だけを記録。
- inventoryをcode unit順にし、verifierで順序を必須化。javac診断のtoken置換順と出力encodingを修正。記録の重複縮小は見送り。
- 両DSL・両版を再実行（各78テスト）。記録proof-v2、静的217テスト、件数不変、BTA 0、本番採用0を維持。

### 2026-11-02: 所有javac driver→実BTAのmanifest閉包・鮮度実証

- [設計書§9.51](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#951-所有javac-driverと実btaのmanifest接続鮮度の限定実証2026-11-02)へ、所有source／fresh output／driver JAR→固定runtime→library cohort→実snapshot生成→configuration／parameter→offerの対応を追加。test用canonical proof bundleのrole・digest・byteLengthと閉包も検証する。
- runtime／cohortの順序・重複を保持。staging・保存bytes・library・sourceの改変、snapshot／generation／configuration／parameter／project／引数交換と旧snapshot流用を拒否。BTA後・capture前の改変と、最初のNode reader captureまで検証。library全JAR entryとcompiler outputを結ぶ。
- Groovy／Kotlin × Gradle 8.11.1／9.2.1で最終4 build、各版48 nativeテスト。javac 4・driver child 4、実BTA呼出し24（library 8／consumer 16）・snapshot生成24。offer 76（completed 8／failed 68）、runtime起動前拒否16を含む拒否84。自然消費receipt・本番採用0。
- [検証データ](validation/gradle-owned-bta-manifest-2026-11-02.json)・再現collector・静的133テストを追加。元source・runtime profile・binding・到達済み証拠・reader観測・bundle交換と件数改変を拒否。型検査・build成功、全体92 files／3,081 tests成功（21 files／1,415 tests skipped）。
- proof専用schemaに限定。本番manifest／coreGraph／envelope／追加信頼gateへの統合、JDK／Node imageとloader／executorの独立承認、全observer・host評価bytes・任意writer排除は次段階。compilerWorkStatus=unknown、自然消費receipt・declared_in／coverageへの昇格なしを維持。


### 2026-11-02: 9c978e1レビュー修正（BTA manifestの実体tokenと注入対照）

- §9.51へ修正の小節を追加。output rootの実体tokenをrun内の`entity-N`へ置換（修正前はinode等のsaltなしhash）。nativeハーネスに`NODE_OPTIONS` preloadの対照を追加し、起動形を`node -- producer`へ統一。
- tupleごとの件数を検証済み証拠から算出し、再現例のpathを`<output-prefix>`へ置換。両DSL・両版を再実行（各48テスト）、記録proof-v2、静的137テスト、件数不変、本番採用0を維持。

### 2026-11-02: 所有BTA manifestの本番採用契約（設計）

- [設計書§9.52](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#952-所有bta-manifestの本番採用契約profile読取前gate設計2026-11-02)へ、追加trust／独立profile registry・JDK／Node／platform image・executor／loaderの必須証拠と責任分離を追加。現在hash・CodeSource・producerのtrue表明だけでは採用しない。
- caller-owned broker／別authority storeの隔離・session／lease・状態別witness、graph v4 wrapper・coreGraphDigest・envelope v2・本番bundleと終端receipt／indexの非循環対応を具体化。shared build／generationは同一session内のtyped use receiptへ限定する。
- G0〜G4の判定順・閉鎖時のowned読取0、producer failed／unavailableとreader拒否の理由・stage／phase許可表、現在／拒否時保存bytesの照合、budget／cacheとdiagnostic-only metadataを定義。
- AP01〜AP32の回帰条件を追加（すべて未実施）。本番profile承認・本番producer／reader実装・authority／imageのnative実証・全observer・3 tool実接続は後続。今回は設計のみ、新規native／BTA実行・本番採用0。


### 2026-11-02: be8ec20レビュー修正（graph拒否の範囲と理由の対応）

- [設計書§9.53](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#953-be8ec20レビュー修正graph拒否の範囲理由の対応2026-11-02)へ、「graph拒否」はowned診断を出さないことであり、coreGraphの採否は既存の検証だけで決めると定義。trust disabled時のG0違反は警告に限定し、G0のprofile参照を設定・registryが有効な場合に限った。
- reader理由に`envelope_missing`を追加し、§9.51のnative理由から本番の許可表への対応を明記。設計のみで実装・native実行・本番採用0。

### 2026-11-02: G0の本番transport・状態／pair／閉包contract

- [設計書§9.54](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#954-g0本番transport状態pair閉包contractの実装2026-11-02)と本番utilityを追加し、GradleGraphCacheがv4 wrapperのcoreGraphを既存v1〜v3経路で検証するよう接続。owned内部の不正をcoreのdeclared_in／relation／introduced_by・coverageへ波及させない。
- bundle v1・envelope v2・object／ref／evidence union、canonical bytes／digest、state prefix・理由表、pair・index閉包・循環／orphan・未知field、phase／BTA binding／captureをG0で検証。外部sidecar／artifactは開かず、正常でもcapability_unsupported／診断採用falseを維持。
- 新規176テスト＋cache／宣言／plugin 6件＋3 toolのmock回帰2件。固定Java／Node canonical vectorとの一致、core freshness維持とowned source非読取も確認。型検査・build成功、全体93 files／3,269 tests成功（21 files／1,415 tests skipped）。新規native／外部スキャナー実接続0。
- G1の設定・独立承認registry、G2のauthority／session／witness、共有use receipt、profile固有の全証拠・G3／G4、producer・本番診断採用は未実装。G0 verifiedをinput completeness／current content／実行真正性へ昇格しない。


### 2026-11-02: ed8def5レビュー修正（v4 wrapper追加に伴う既存経路の変化）

- §9.54へ修正の小節を追加。64MiB上限をv4 wrapperに限定し、v1〜v3 companionは16MiB上限・`metadata_too_large`・予算返却を維持。v4の非wrapperは`invalid_graph_wrapper`、root sliceのUnknown tokenは拒否。
- READMEのGradle節に、v4 wrapper・`owned_manifest`・owned理由がcoverage等を変えないことを追記。cacheテスト4件追加。nativeの再実行なし。

### 2026-11-02: G1 consumer設定・独立profile registry

- [設計書§9.55](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#955-g1-consumer信頼設定と独立profile-registry2026-11-02)に沿って、追加trust／digest集合の起動時固定・警告、strict profileと独立specification pin／recipe registryの閉包・digest・stage検証を実装。既定registryは空、graphからの自己承認・path／URL読込なし。
- G0 invalidを優先し、G1の設定不正／信頼無効／profile・recipe未承認／既知claim不一致を分離。coreのrelation・introduced_by・declared_in・coverageを保持する。G1成功もwitness_unavailableで停止し入力読取0を維持。
- AP01／AP02／AP09／AP10／AP31の静的部分を回帰化。G2 authority・session・witness、G3／G4の実体証拠・内容照合、本番producer・profile承認・native／実接続は残る。子pinは仕様hashでありimageやloaderの今回の実体証明ではない。

検証結果: G1 policy 60件・cache追加3件の回帰を追加。型検査・build成功、全体94 files／3,336 tests成功、21 files／1,415 tests skipped。新規native／OSV実行・承認profile・診断採用は0。

### 2026-11-02: G2 session・authority lookup・実行witnessの静的contract

- [設計書§9.56](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#956-g2-独立callerのsession実行witness-contractと読取前gate2026-11-02)へ、current session／scope／root世代／authority、Task・Action・broker、process／lease、coreGraph／最終pair／状態／captureの照合を実装。lookupの未取得・未実行・中断・不正を分離し、API不正を未取得へ隠さない。
- G0／G1閉鎖時はlookup 0、G2正常もG3 capability_unsupportedで停止。executionWitnessを分離し、coreの依存情報・coverageとowned読取0を維持。同じcacheで再captureしてもwitness判定は再照会し、欠落／失効を反映する。
- 通常起動はbackend unsupported／独立profile registry空のまま。isolationEvidenceRefの形式検証は隔離の認証ではなく、test adapterは実authority採用に数えない。次は隔離backend・session発行／保存の設計と実証、その後G3／G4・本番producer・profile承認・native／3ツール実接続。共有use receiptも残る。

検証結果: G2 contract 134件＋cache追加3件、計137件を追加。型検査・build成功。全体95 files／3,473 tests成功、21 files／1,415 tests skipped。新規Gradle／BTA native・OSV実接続・実authority採用・本番profile承認・診断採用は0。


### 2026-11-02: 199d16cレビュー修正（G2 caller APIと分類）

- §9.56へ修正の小節を追加。caller adapterをplain objectに限る方針を型と文書に明記し、class adapterの拒否をテストで固定。lookupの例外を`witness_unavailable`へ、profileとsessionのauthority不一致を`configuration_invalid`へ変更。nativeの再実行なし。

### 2026-11-02: G2隔離authority backendの具体設計

- [設計書§9.57](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#957-g2隔離authority-backend-信頼境界session-lifecycle保存取得失効契約設計2026-11-02)へ、operator／caller／authority／broker／buildの権限、Task等のfield別観測責任、独立設定と認証wire、session lifecycle・current CAS・一回実行とretry、terminalのdurable保存・独立rollback checkpointを追加。
- 保存先認証とTask事実の観測を分離し、同一UID別directory・afterTask・自己署名・hash chainだけでは採用しない。同期G2へのasync snapshot取得段、失効とlookup／将来のread grant・finalValidateの線形化点、開始済みreadとgate前読取0の区別を具体化。
- 実証A（protocol／store）・B（実隔離／IPC）・C（独立Task対応）とAB01〜AB36の未実施回帰条件を追加。両DSL×両Gradle版でも未成立cellをunsupportedに保持する。今回は設計変更のみ。backend・session発行／保存・認証IPC・Task observer・permitの実装／native実証、本番profile承認・診断採用は未実施。

今回の文書検証: 公開文書のcommand例・既存G2 contractの計138テスト成功、diff整形検査成功。新節の10小節とAB01〜AB36の欠落・重複なしを確認。AB条件の新規テスト実装・backend／native実行は行っていない。

### 2026-11-02: G2隔離backend設計レビュー2件の反映

- §9.57のbind-coreへ実canonical coreのmetadata snapshot、seal-scopeへ対象scopeの完全G0 wrapperと全carrier閉包を必須化。authority発行uploadId・有界chunk転送・freeze・不変ref・保存／検証順と、最終複数scope exportへの併合を具体化し、sidecar／artifactでの補完を禁止した。
- sessionにsealingを置かず、scopeのplanned→registered→executing→sealing→terminalと、全scope terminal時だけのsession committedを分離。A commit後のB継続／成功／abort、scope単独とsession全体の失効、独立revisionを定義。
- AB18／AB33を拡充、AB37〜AB42を追加（すべて未実施条件）。今回は設計修正のみ。実backend・snapshot upload／freeze・新schema・回帰テスト実装／native実証・本番profile承認／診断採用は未実施。

レビュー修正後の文書検証: 公開文書・既存G2 contractの138テスト成功、diff整形検査成功。AB01〜AB42の欠落・重複と表の連続性、完全metadata受渡し・scope／session分離・TODO更新を確認。AB37〜AB42は条件の追加のみで、backend／新規回帰テスト／native実証は未実施。


### 2026-11-02: cf3bc07レビュー修正（authority backend設計の数値上限）

- [設計書§9.58](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#958-cf3bc07レビュー修正seal容量待機期限仮の時間上限2026-11-02)へ、seal projectionのcoreを`coreMetadataRef`の参照にしてcoreを1回だけ数える予算へ修正（scope上限との矛盾を解消）。待機期限をchunk要求ごとと明記し、session 10分・permit 30秒を仮の値として期限切れ時のunavailable停止を定義。設計のみで実装・native実行・本番採用0。

### 2026-11-02: 段階A1の参照contract実装

- [設計書§9.59](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#959-段階a1-sessionscopemetadata-uploadfreezeg0-sealの参照contract実装2026-11-02)へ、in-memory logical transactionを持つsession／scope状態機械、core snapshot・chunk upload／freeze、core参照付きseal projection、G0専用入口とG2 metadata照合、current CAS／失効・idempotent retryを実装。
- 13 MiB超のcoreを6 scopeで共有する容量対照、chunkごとの期限、各prefix・scope独立進行・metadata故障等のlogical回帰を追加。principalはharness用でありOS認証ではなく、terminalはstructure-verifiedに限定。通常起動のbackend unsupported／profile空・診断採用false／owned読取0を保持。
- 段階A全体は未完了。次はA2のdurable保存／crash復旧／独立checkpoint・fault injection。Bの隔離・IPC、CのTask観測、lease管理・async取得・permit、G3／G4・本番producer／profile承認・native／OSV実接続も残る。§9.58の未コミット設計修正を取り込み、本番採用へ昇格しない。

A1検証結果: 新規71テスト成功。型検査・build成功、全体96 files／3,547 tests成功、21 files／1,415 tests skipped。13 MiB超core×6 scopeのraw予算、期限・prefix・権限・metadata拒否・scope独立進行を含む。durable store／IPC／Gradle・BTA native／OSV実接続・本番backend／profile承認・診断採用は0。

### 2026-11-02: A1レビュー指摘2件の修正

- terminal scopeの未完了uploadをcancelledにしてpending枠を解放。abort・skip等の後も他scopeを登録でき、保持partial bytesの予約予算は維持し、cancelled uploadの新規writeは拒否する。
- lookupは終了時刻のexpiryを適用して結果を再計算。期限切れ後・途中到達ともsession-unavailableを返し、古いterminalを返さない。変異操作の期限検査・rollbackと、本番backend未対応／読取0は維持する。
- 修正前の失敗を確認した上で13回帰を追加。A1は84テストへ増加。実証は引き続きメモリ内contractのみで、durable store／crash復旧・隔離／IPC・native・本番採用は未実施。

A1レビュー修正後の検証結果: A1 84件成功（追加13件）。型検査・build成功、全体96 files／3,560 tests成功、21 files／1,415 tests skipped。diff整形検査成功。新規native／OSV実行・durable／隔離backend採用・本番profile承認・診断採用は0。


### 2026-11-02: 9ef598eレビュー修正（A1 kernelの置き場所と状態分類）

- §9.59へ修正の小節を追加。認証なしのA1 kernelを`src/test/fixtures`へ移してbuild・公開packageから除外。期限切れ・abort・revoke・supersedeのvalidityを区別し、scope abortで観測済みのTask例外を`execution-aborted`として保持。verified以外のsealの占位claimを明記し、G3到達を拒否。authorityテスト87件。nativeの再実行なし。


### 2026-11-02: A2保存層の参照実装・実ファイル復旧

- §9.60へHMAC認証journal、chunk・commit内index、独立checkpoint、immutable保存・fsync・ack順序、復旧とrollback拒否を追加。すべてtest fixtureであり公開buildから除外する。
- 新規42件（memory 27／実ファイル15）。実SIGKILL後の再openを3地点で確認。保存障害、改変・欠落・巻戻し、checkpoint失敗、symlink／hardlink／root交換、容量・列挙上限を含む。実行profileはmacOS arm64／Node 26.12.1。A1のrole改変負例も、乱数依存の並び順で変更前後が同じroleにならないよう修正。
- A2全体は未完了。次はA1 transactionへの保存接続、launch前reservation、restart失効、writer排他・運用quota、publish直後のnlink=2の隔離復旧。Bの実隔離・認証IPC・checkpoint保護、CのTask観測、G3／G4・本番採用は引き続き未実施。今回の別root／別keyを独立principalの実証と数えない。

A2保存層の検証結果: 新規42件成功。型検査・build成功。全体98 files／3,605 tests成功、21 files／1,415 tests skipped。diff整形検査成功。build後のdistにA1／A2 fixtureが含まれないことを確認した。上記範囲以外の本番backend採用・隔離・Gradle／BTA native・OSV実接続は0。


### 2026-11-02: A2レビュー修正（checkpoint再同期の保存境界）

- §9.60へ公開後のdirectory同期失敗と再同期の契約を追記。checkpoint全chainの認証後に同じbytesを再同期し、成功するまでhead／historical ackを返さない。既存同値fileのputもfile／directoryの再同期を必須とする。
- 回帰3件追加（memory・実ファイルの再open／retry拒否、保存障害matrixの同期前境界）。修正前の誤成功を確認し、同期失敗継続中は拒否、成功後だけ同revisionのackを返すことを検証。実媒体エラー・電源断を模した実証ではなく、A2の残課題・本番採用範囲は変えない。

A2レビュー修正後の検証結果: A2は42件から45件へ増加（memory 28／実ファイル17）、全件成功。型検査・build成功。全体98 files／3,608 tests成功、21 files／1,415 tests skipped。diff整形検査成功、distにA1／A2 fixtureが含まれないことを再確認。実SIGKILL 3ケースも再実行した。新規Gradle／BTA native・OSV実接続・本番backend採用は0。


### 2026-11-02: 102c7a0レビュー修正（A2 journalの書込み前拒否）

- §9.60へ修正の小節を追加。`revision_conflict`／`operation_conflict`／書込み前の`budget_exceeded`ではinstanceを止めず、書込み開始後と復旧処理の失敗だけを停止対象とした。回帰2件。操作ごとの全store再検証を性能上の限界として明記。nativeの再実行なし。


### 2026-11-02: A1 operationとA2保存層の接続

- §9.61へoptional journal／dispatchDurableを追加。A1状態変更をmanifest・metadata・ledger・terminal・index・resultに保存し、checkpoint完了後だけackする。action-startと同じcommitの予約をlaunch前の境界とし、生capabilityを保存しない。
- busy中の参照／操作／provisioningを拒否。保存障害時は停止。同操作retryは保存receiptを再検証しcommitを増やさない。期限到達を保存し、最後のawait後にも期限を再確認する。
- 回帰23件（実ファイル経由1件を含む）。G0 seal、partial／freeze、複数scope、abort／revoke／expire／supersede、保存故障・期限境界を対象とする。実brokerのlaunch・実隔離・Gradle／BTA native・OSV実接続は未実施。
- 次は履歴から未完了sessionを失効させて新sessionを受け付けるrestart処理。現時点ではrestart_unsupportedとしてlive復元を拒否する。snapshotの差分化・quota／retention／compaction・writer排他、publish中断の隔離復旧、B／C・G3／G4・本番採用も残る。

A1–A2接続の検証結果: 新規23件成功。型検査・build成功。全体99 files／3,633 tests成功、21 files／1,415 tests skipped。既存A2のSIGKILL 3ケースも成功。diff整形検査成功、distにauthority／journal fixtureが含まれないことを確認した。通常起動のbackend・本番profile・診断採用は有効化していない。


### 2026-11-02: e0d73d6レビュー修正（durable kernelの容量上限での停止）

- §9.61へ、1 commitのsnapshotが64 MiB未満・4,096 records以下という保存の目安と、最大scopeが保存できないこと、256 commitsが数session分で尽きうることを明記。store上限ではjournalは利用可能なままでも、kernelは`recovery_required`で停止し、新しいjournal・authorityでしか再開できないことを記載し、回帰1件を追加。nativeの再実行なし。


### 2026-11-02: 再起動時の旧session失効・新session受付

- §9.62へasync restart factoryとsnapshot decoderを追加。A2全履歴検証に加え、latest snapshotのschema・canonical表現・metadata／ledger／terminal／予約・参照閉包を照合し、旧currentを失効させたcommitとcheckpointが完了してから新kernelを返す。
- 旧actor・capability・ack cache・実行許可・clock原点を復元しない。旧kernelはheadの世代変更で停止。旧成功terminal・raw metadata・operation digestは履歴として保持し、currentなlookupは返さない。新bootには新しいsession枠を与え、全体のA2容量上限は維持する。
- 新規27回帰（実ファイル再openと、失効commit直後の子process実SIGKILL各1件を含む）。保存失敗・公開checkpointの同期失敗中は受付0、復旧後は二重失効なしで新sessionをactivateする。既存G0 sealテストにも再起動後の確認を追加。
- 次はwriter排他／lease・容量管理／retention／compaction・limits移行・publish中断の隔離復旧。Bの実隔離／認証IPC／checkpoint保護、CのTask観測と実broker／permit、G3／G4・本番採用・各環境のnative／実接続も残る。今回の世代照合は実process停止や既に配達済みの実行許可を取り消すbackendの実証ではない。

再起動処理の検証結果: 新規27件成功。型検査・build成功。全体100 files／3,661 tests成功、21 files／1,415 tests skipped。既存A2のSIGKILL 3ケースと、新規のrestart失効commit直後の実SIGKILL 1ケースを再実行した。diff整形検査成功、distにauthority／journal／snapshot fixtureが含まれないことを確認。実行環境はmacOS arm64／Node v26.12.1。本番backend・profile・診断採用は無効のまま。


### 2026-11-02: 5eee209レビュー修正（restart失効のvalidity）

- §9.62へ修正の小節を追加。restartで閉じたsessionのvalidityを`restarted`とし、時間切れの`expired`と区別。snapshot decoderの照合にも追加し、restart前に時間切れだったsessionは`expired`のまま保持することを回帰で固定。nativeの再実行なし。


### 2026-11-02: 保存運用第1段（writer排他・publish中断の認証復旧）

- §9.63へ2 rootを専有するOwnedJournalDiskを追加。nonblocking flockをdescriptor終了まで保持し、両root取得前は保存しない。別adapterのputも同じlockへ従い、競合writerを拒否。transaction／IO実行中のcloseを拒否する。
- 同じroot内のtemp＋finalの正確なnlink=2 pairのみ、全A2認証後にbytes／inodeを再照合してtempを除去・fsyncする。認証不正・曖昧なlink・未知file・同期失敗では受付を開かず、不正dataを削除して成功へ見せない。
- 新規23回帰。実別processの排他と、ownerをcommit publish直後にSIGKILLしてからの専有再取得・認証復旧を含む。A1 restartとの実ファイル接続も確認。macOS arm64／Node 26.12.1のみの参照実証であり、本番backendは無効。
- 次は容量／retention・compaction／checkpoint世代移行と上限後の再開、差分snapshot／incremental検証・性能比較。実行lease・既配達許可の取消し、Bの隔離／認証IPC、C以降の実broker／Task／G3／G4・本番採用は残る。

保存運用第1段の検証結果: 新規23件成功。型検査・build成功。全体101 files／3,685 tests成功、21 files／1,415 tests skipped。実別processの競合拒否と、ownerのafter-publish SIGKILL後の専有再取得・認証復旧が成功。既存restartのSIGKILLも再実行した。diff整形検査成功、distにauthority／journal fixtureが含まれないことを確認。macOS arm64／Node 26.12.1のみの参照実証で、本番backend・profile・診断採用は無効のまま。


### 2026-11-02: 保存容量・履歴保持の契約設計

- §9.64へ独立retention policy、既定manual／explicit-release、archive／hold／時刻証拠、full→release-pending→retiredと最低tombstoneを追加。closedやmtimeだけで削除せず、現v1 chainから直接blobを抜かない。
- 2 root・temp・予約・移行ピークを別計数し、通常admissionと保守予約を分離。最後の8 commits／64 MiB／1,024 entries等は候補値に限定し、将来closureの実size・追加record上界が不足するsessionはbeginから拒否する契約にした。
- retryの一回性、history-prunedの明示、archiveからのcurrent性復活禁止、独立holdの削除CASとの直列化、time originをまたぐage判定、planの入出力・認可とcompactionへ渡す条件、hard full時の停止・再開条件を定義。
- RC01〜RC28は未実装の回帰条件。今回は設計のみ。次は認証付きcompaction／checkpoint世代移行の具体schema・phase・保存／crash復旧、その後の実装・native実証。quota／削除／archive／保持期限・移行を有効化していない。性能改善・B／C以降の本番採用も残る。

保存容量・履歴保持契約の文書検証: 公開文書command例と既存A1–A2／disk owner／restartの計123テスト成功。§9.64の10小節とRC01〜RC28の欠落・重複なし、diff整形検査成功を確認した。RC28件は未実装の条件であり、新しいquota／retention／compactionの実装・native実証は0。既存のnative対照は再実行したが、新契約の成立証明へ数えない。


### 2026-11-02: 7b2e418レビュー修正（移行開始予約とtombstoneの数え方）

- [設計書§9.65](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#965-7b2e418レビュー修正移行開始予約とtombstoneの数え方2026-11-02)へ、保守予約をrestartで使えない移行開始予約と残りのrestart予約へ分け、restart連打で移行が始められなくなる経路を閉じた。sourceへ書くのは受付停止・失効だけで保守controlは別領域と統一し、RC25を拡充。retired sessionはsnapshotからtombstoneへ移し、256／4,096の上限を別に数えると明記。設計のみ。


### 2026-11-02: 認証付きcompaction・checkpoint世代移行の具体設計

- §9.66へ独立LineageRegistry、5 root／役割、strict control schema、source freezeからtarget構築・検証・選択・GC・finalizationまでのphase別必須証拠を追加。sourceへは移行開始予約による停止・全session失効だけを追記する。
- digest依存をintent→plan→release認可→tombstone core→base→ready→activation→GC→retire receipt→finalizationの順に分離し、未来の認可／headをbaseへ入れる循環を避けた。最低tombstoneはcoreと外側receipt・control閉包の合成として完成する。
- source選択中とtarget選択後を独立CASで分離し、後者のsource fallbackを禁止。holdの最終barrier、有限inventory／write-ahead GC batch、部分削除・CAS reply紛失を含むcrash復旧表、再開条件を具体化。
- MC01〜MC36は未実装の回帰条件。M0 schema／閉包、M1 registry状態機械、M2 freeze／base／ready、M3 native切替／GC、M4実backend接続の順で実装する。今回は設計のみで、compaction・移行・削除・独立registry・本番採用を有効化していない。

世代移行契約の文書検証: 公開文書command例と既存A1–A2／disk owner／restartの計123テスト成功。§9.66の11小節とMC01〜MC36の欠落・重複なし、diff整形検査成功を確認した。MC36件およびM0〜M4は未実装で、新規v2 schema／registry／compaction／GCの実装・native実証・本番採用は0。既存native対照の再実行を新protocolの成立証明へ数えない。


### 2026-11-02: a3daabcレビュー修正（移行freezeのvalidity）

- [設計書§9.67](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#967-a3daabcレビュー修正移行freezeのvalidity2026-11-02)へ、移行freezeで閉じるsessionを`restarted`ではなく専用の`migration-frozen`とし、restart・時間切れ・既存close理由と区別。MC07を拡充し、v1 kernel／snapshot decoderへのenum追加をv1 source freeze実装時の条件として明記。設計のみ。


### 2026-11-02: 保存性能の設計・基準計測

- §9.68へ全snapshot再生成・record再hash・checkpoint再同期の費用を分けた性能改善設計を追加。まずPO1の1回の検証内content memoとhead-only API、PO2のdirty追跡を行い、PO3のv2差分形式、PO4の独立immutable providerが必要なprefix cacheへ段階化する。
- 現nativeのstat／hash名／flockだけでcross-requestのread／同期を省かない。公開checkpointの同期失敗・owner終了・期限・世代変更の拒否を維持し、cacheと原本・認可・予約を分離する。
- opt-in baseline harnessとJSONを追加。memory／file protocol／native、A1–A2、payload／history／scope／churn別の54 rows、各warmup 1＋測定5回とboundary counters・native sync回数・31 source hashを記録。最適化版・speedupは未測定。
- PF01〜PF28は最適化の未実装回帰条件。今回は設計と基準計測のみで、最適化・delta・provider・本番採用は有効化していない。次はPO1の安全な局所最適化とreference比較、M0以降の世代移行schema実装との接続。

保存性能設計・基準計測の検証結果: opt-in baseline 1件成功（54 rows／270測定samples＋54 warmups、31 source fingerprint一致）。既存関連・文書123件成功、通常実行時の新benchmark 1件skip。型検査・build・diff整形検査成功。§9.68の10小節・PF01〜PF28の欠落／重複なしを確認した。PO1〜PO4とPF最適化側は未実装であり、測定値はbefore／after速度改善ではない。本番backend・profile・診断採用を有効化していない。


### 2026-11-02: 943dc1cレビュー修正（baseline記録の保護と照合）

- [設計書§9.69](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#969-943dc1cレビュー修正baseline記録の保護と照合2026-11-02)へ、再現commandの出力先を`<output-path>`にして公開baselineの上書きを避けることと、baseline記録の構造・§9.68.3の表の値を照合する静的テストの追加を記録。nativeの再実行なし。


### 2026-11-02: PO1・検証内content memo／head-only API

- §9.70へ実装・回帰・比較結果を追加。1 recover内で成功したcontent proofだけを、有界key（4,096 entries／8 MiB）で再使用する。全blobをprivate copyして検証し、schema／role／index／MAC／chain／checkpointは省略しない。request間のcacheは作らない。
- `verifyHead(expectedHead?)`を追加し、A1の世代確認・lookupで捨てていたrecord出力を省略。restartのbytes取得、owner・期限・世代・checkpoint同期のgateを維持する。
- 新規20回帰と比較記録の静的照合2件。実際の7e00ee4の31 source fingerprintを照合してcompileした版と、66 rows／660測定samples＋132 warmupsで交互比較。結果・I/O・同期の同等性を照合し、改善の乏しいchurn／small kernelも記録した。公開baselineを変更しない。
- 次はPO2のdirty追跡・full形式record再使用の設計具体化と実装・比較。PO3／PO4、M0以降のcompaction・世代移行、隔離authority backend／認証IPC・Task／broker・G3／G4・本番採用は残る。PO1はtest fixture内の参照実装で、新規Gradle／BTA／OSV実接続は行っていない。

PO1の検証結果: 新規22静的／回帰テストとopt-in比較1件成功。全体104 files／3,709 tests成功、23 files／1,417 tests skipped。型検査・build成功。固定8 MiB・履歴64件のwarm lookupは205.98→13.83 ms、native 8 MiB・履歴8件は42.47→19.10 ms。churn 1 MiBは10.40→12.01 msで遅くなった。macOS arm64／Node 26.12.1上の参照実証であり、本番backend・profile・診断採用は無効のまま。


### 2026-11-02: PO2・dirty追跡とfull形式record再使用

- §9.71へroot version、session／scope／upload／event列のcopy-on-write、slotを含むsession fragmentのinvalidations、journal所有private sealとfull snapshotの再使用を実装。lookup／retryの変化なし判定を全snapshotのserialize／hashからversion比較へ置き換えた。
- checkpoint完了後だけdurableVersion・commit済みrecord列を更新。論理失敗は旧rootへ戻し、expiryは独立保存し、保存障害時は停止する。全履歴・全blob・独立checkpoint・owner／期限／世代gateは維持する。
- 同じkernelの同じstate・ID／nonceからreference full builderを作り、変更時と変化なし経路のrecord順・ID・role・bytesを照合。nonempty metadata・partial／freeze・rollback・slot共有・event／terminal・close／expire／restartとsealの出自・aliasを検証する。disk owner終了の注入先も実保存経路commitSealedへ移し、保存完了直後のack拒否を維持した。
- PO1実commit 16bf69fとの18 rows／180測定samples＋36 warmupsで、public outcomeとread／write／checkpoint／native syncの同等性を確認。1 session／64 scopesの登録は14.36→7.86 ms、4 sessions／4 scopesは28.25→12.51 ms。native lookupは20.10→21.02 msで改善しなかった。peak process memoryは未測定。
- 次はPO3とM0以降を連携したv2差分schema／materializer・認証付きcompaction／世代移行。PO4の独立immutable storage provider、隔離authority backend／認証IPC・実Task／broker・G3／G4・本番採用も残る。PO2はtest fixture内のfull形式互換の実装で、差分形式やGCを有効化していない。

PO2の最終検証: 新規24回帰と比較記録の静的照合2件、opt-in比較1件成功。型検査・build成功。全体106 files／3,736 tests成功、24 files／1,418 tests skipped。既存のnative writer排他・SIGKILL／restart・保存障害・checkpoint再同期・owner終了後のack拒否・期限／世代変更を含めて再実行した。owner終了注入はcommitSealed完了直後へ移し、注入が1回実行されたことも検査する。公開baseline／PO1比較記録は変更していない。diff整形検査と、distにauthority／journal・test fixtureが含まれないことを確認した。


### 2026-11-03: 931fdf8レビューでの追記（PO2の変更時の注意）

- §9.71.2の末尾へ、snapshot再使用の正しさがstateを直接書き換えない規律に依存すること、取りこぼしを検出するreference照合はtest fixtureでのみ有効であること、新しい操作・fieldを加えるときの必須事項（新しいobjectの作成と`verifySnapshotReuse:true`の回帰）を追記。文書のみ。


### 2026-11-03: PO3/P0・v2 full／delta静的contractとreplay

- §9.72へ独立v2 schema／HMAC envelope、型付きkey、full／delta strict union、exact old ref・from/to／namespace／index／budget roots、外側base／checkpoint pin、全履歴replayを追加。v1の欠落を暗黙継承せず、既存writer／readerは変更しない。
- payload・返却値をcopyし、過去に必要なbytesも保持・課金する。terminal／reservation／tombstone／controlの削除・置換をfull経由でも拒否する。M0のretirement/control閉包が未実装のため物理削除・本番採用を許可しない。
- 24 delta prefixのreference比較と、実A1のpartial／freeze・binding・ledger／terminal・retry／expiry／restart snapshotの全bytes／decoder照合を追加。承認baseとcheckpointはfixture呼出し側のpinで、独立registry接続の実証ではない。
- 次はM0のtyped maintenance/control schema・ref閉包、M1の独立LineageRegistryと、P1以降のv2 durable writer／checkpoint／A1接続。persistent tree／delta更新の性能・native crash・quota／移行／GC・PO4・本番採用は残る。PO3全体の完了ではなく、静的な最初の実装単位である。

PO3/P0の検証結果: 新規71回帰成功（24 delta prefix比較と実A1 snapshotのaudit対照を含む）。全体107 files／3,807 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。distにv2／authority／journal・test fixtureが含まれないことを確認した。既存native保存・SIGKILL・checkpoint／owner・期限境界も全体で再実行したが、v2 native保存や独立registryの成立証明へ数えない。新規の本番backend・profile・診断採用、移行・GC、Gradle／BTA／OSV実接続は0。


### 2026-11-03: 2ec7f7bレビュー修正（v2 audit modeの履歴検査）

- [設計書§9.73](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#973-2ec7f7bレビュー修正audit-modeの履歴検査2026-11-03)へ、audit modeで全stateをdecodeして前後を比較し、freeze済みupload・bind後のsession固定値・closed session・ledgerの追記のみ・scope terminalの不変性を`journal_v2_history_mutation`で拒否する変更を記録。§9.72.3／9.72.4の保証範囲を更新。回帰5件、nativeの再実行なし。


### 2026-11-03: PO4/Q0・immutable provider／prefix proof契約の具体設計

- §9.74へ独立providerの主体・Enrollment・SealedSnapshot／inventory／Acquire／Completeの入出力、fresh challenge・reader boot／peer・prefix／root bindingを追加。現flock／hash名やmemory Mapを不変性の証明としない。
- serviceのseal／namespace／writer fence、registry read pinとfreeze／cutover／GCの順序、結果引渡しまでのpin・最終authority gateの協調、失効・応答紛失・再起動の条件を具体化。timestampだけで分散した現在性を保証しない。
- 初期cacheでもcheckpoint全認証・file／directory再同期を維持し、provider不在と認証不正・unavailable・通常missを区別。cache資源・比較counterとIP01〜IP28の未実装回帰条件を追加。
- 次はQ1のstrict schema／fresh challenge・pin状態機械・publish gateのmemory contract実証。その後Q2の隔離service／認証IPC／native、Q3の実cache・suffix比較、Q4の独立profile／authority・PO3／M0接続。今回は設計のみで、原本read省略・provider・承認profile・本番採用を有効化していない。

PO4/Q0の文書検証: 公開command例と既存A1–A2／disk／restart／v2 auditの計182テスト成功。§9.74の8小節とIP01〜IP28の欠落・重複なし、diff整形検査成功を確認した。IP28件とQ1以降は未実装で、今回の新規provider・原本read省略・認証IPC・native隔離・性能測定・本番採用は0。既存native対照の再実行をprovider成立の証拠には数えない。


### 2026-11-03: 3e9ee00レビュー修正（grantの自然な期限切れとsuffix上限）

- [設計書§9.75](GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md#975-3e9ee00レビュー修正grantの自然な期限切れとsuffix上限2026-11-03)へ、grantの自然な期限切れを失効・世代変更と分けて同じboot・世代のprefix proofを保持し取り直せるようにし、grantあたりのsuffix上限を超える場合は最初からfull modeを選ぶことを記録。IP15／IP23を拡充。設計のみ。あわせて、後続節の表を拾って3e9ee00以降失敗していたPO2記録照合テストの読取範囲を§9.71内へ区切った。


### 2026-11-03: PO4/Q1・fresh grant／read pin／公開gateのmemory contract

- §9.76とtest fixtureへstrict wire／HMAC・fresh challenge／reader boot・全identity binding、private proof／handle、Acquire／Complete再送、read pinのphaseと最終公開gateを実装。陽性はwouldReusePrefixという診断だけで、常にbackendEligible／diagnosticEligible=false・originalReadsSkipped=0。
- 自然な期限切れは旧proofを保持して新grantへ、失効・context変更は旧proofを拒否。suffix上限超過は陽性grantを出さずfull-required。checkpoint不明時もgrantを出さない。pinを結果引渡しまで保持し、公開準備後にもdeadline／gateを再確認する。
- sourceとcandidateは毎回v2全履歴replayを行う。authority-audit modeは実decoder／履歴検査まで実行。新source公開時の完全prefix照合でcacheなしの署名済みforkも拒否する。use終了後のpayload参照を解放し、evict後もpinが持つproofを予算へ計上する。
- 新規98件。native provider／IPC／独立registry／実durability・実read省略・性能改善・本番採用は未実施。次はQ2の隔離service／認証IPC・seal／boot／writer fence／handoffのnative実証、その後Q3実cache・suffix比較、Q4独立profile／authority・PO3／M0接続。

PO4/Q1の検証結果: 新規98回帰成功。全体108 files／3,910 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。既存のnative保存／SIGKILL・checkpoint／owner・期限境界も全体で再実行したが、providerのnative成立証明へ数えない。distにprefix／authority／journalのtest fixtureが含まれないことを確認した。実原本read省略・実checkpoint同期の置換・独立registry／認証IPC・性能計測・本番採用の追加は0。


### 2026-11-03: M0/A・migration control schemaとlocal参照閉包

- §9.77へ34 control types／10 phase selector、roleに固定したissuer pinとcanonical認証envelope、exactなbyte ref閉包・循環／orphan／重複拒否を実装。全bytes・records・refs／nodesを有界にし、共有refの最長経路を明示stackで検証する。
- 保持分類・intent／import map、base祖先root／budget／genesis、ready／activation、typed batch planでページ化したGC scopeとPrepared／Done／completionの単一連鎖、retire receipts／finalizationの局所整合性を照合する。署名・全refが正しくても不整合なbodyを拒否する。
- 新規97件。実source／target bytes・archive／sync・独立registryの現在性を検証したものではなく、全採用・実行権限はfalse。既存tombstone／過去controlの持越しはcarry_unsupportedとし、黙って省かない。既存v1／v2／providerや本番readerは変更していない。
- 次はM0/Bのcarried evidence／origin／issuer閉包、その後M1独立registryのphase／CAS、M2 freeze／plan／base／ready構築、M3 native cutover／GC・crash、M4実backend接続。v2 durable writer／checkpoint、PO4/Q2以降・本番採用も残る。

M0/Aの検証結果: 新規97回帰成功。8,192-entryの合成inventory／128 inventory pages／128 batch plans・Doneを含め、全体109 files／4,007 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。34 control typesと§9.77の6小節を確認し、distにmigration／authority／provider fixtureが含まれないことを確認した。既存のnative保存・SIGKILL等の再実行をM0の実移行／削除・独立registry・target artifact／同期の証明へ数えない。今回の新規file操作・GC・current admission・本番採用は0。

### 2026-11-03: af6d00dレビュー修正・M0/Aの関係検査

- §9.77.7へ、unfrozen abortのhead＝beforeHead、activation≥freeze request／GC barrier≥activationのregistry revision順序、inventoryの(device, inode)一意性、plan control予算の祖先閉包計数を追加。selector phaseで同じplanの判定が変わらない。
- 新規5件。registryの現在性・実file identity・実bytesの検証ではない。M0/B以降の残りは変更なし。

af6d00dレビュー修正の検証結果: migration回帰102件成功（新規5件）。全体109 files／4,012 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。distにmigration fixtureが含まれないことを確認した。


### 2026-11-03: PO4/Q2/A・native認証IPCの限定実証

- §9.78に実AF_UNIX・別provider process・kernel peer UID/GID・匿名pipe bootstrap・nonce／boot／role／sequenceを束縛した認証IPCを追加。相互認証、再送・再起動前の要求／hello、権限変更・MAC・frame不正・UID不一致・実期限の拒否を検証する。
- 同UIDの別processによる一時fixtureの鍵読取・読取専用fileのchmod／書換を否定対照で確認。現環境は独立principalではないため常にprovider_unsupported。Q1・本番readerには接続せず、grant・原本read省略・backend／profile採用は0。
- 15 nativeケースとsource hash／保存記録の検査1件。記録はdocs/validation/gradle-prefix-native-ipc-2026-11-03.json。macOS 27.2 arm64／Python 3.14.10の実行証拠で、Linux対応分岐の実証ではない。
- 次はQ2/Bの独立principalを事前配備した環境での全書込経路拒否、durable seal・inventory／generation／writer fence・pin drain／handoff／restart復旧。Q2全体、Q3・Q4・本番採用は未完了。

PO4/Q2/Aの検証結果: 新規16件（実socketの15 nativeケース＋保存記録source照合1件）、関連115件成功。全体110 files／4,028 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。distにnative／prefix／migrationのtest fixtureがないことを確認した。独立principalの隔離・durable seal・writer fence・保存復旧・Q1接続・実原本read省略・承認profile／本番採用は未成立であり、Q2全体の完了とはしない。

### 2026-11-03: b62e339レビュー修正・Q2/A clientのprovider pinと応答照合

- §9.78.5へ、clientの期待provider UID照合（hello前）、応答本文・連番の完全照合、`compare_digest`、`assert`の明示的例外化を追加。nativeケースwrong-provider／response-replayを追加し、保存記録を17ケースで再生成。
- push後にCI（ubuntu）でLinux分岐の初実行を確認し、結果を§9.78へ記録する。失敗時はLinux側の扱いを判断する。

b62e339レビュー修正の検証結果: native回帰18件成功（新規2件）。全体110 files／4,030 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。distにtest fixtureがないことを確認した。


### 2026-11-03: PO4/Q2/B・独立principalの配備／起動／権限分離の具体設計

- §9.79へ専用Linux VM／system serviceを基準候補としたprincipal／権限表、root／endpoint／実行closureの配備条件、起動順・canonical内容読取前gate・非置換socket公開・停止／再起動条件を追加。実版／image／実UID／補助group／capabilityを固定し、同UID・既存FD漏洩・管理権限迂回を拒否する。
- provider署名鍵とclient credentialを分離し、両端kernel UID pin、role・boot・要求／応答binding、FD転送拒否・絶対deadline・quotaを具体化。独立controllerの証拠と許可対照を必要とし、自己申告・未実行・tool欠落を陽性へ数えない。
- QB01〜QB32の未実装回帰条件とB1（配備／IPC隔離）・B2（保存／fence）・B3（pin／handoff）の到達点を分離。macOS／Linux未実証配置はunsupported、B1単独でgrant・原本read省略・profile／本番採用を開かない。
- 次はB1aの配備manifest／preflight診断schema・runner静的contract、その後B1bのunit／固定launcher／VM fixture、B1cの別UID native攻撃対照。今回は設計のみでaccount作成・service配備・新規native隔離実行は0。既存Q2/Aの実証範囲は拡張しない。

Q2/B設計の検証結果: 公開command例・既存Q2/A native・Q1 memory contractの関連117件成功。§9.79の8小節とQB01〜QB32の欠落／重複なしを確認し、diff整形検査成功。今回の変更は文書のみで、QB回帰の実装・独立UIDでの実行・配備・保存／pin実装・採用flag変更は0。既存Q2/Aの再実行をQ2/B隔離成立の証拠へ数えない。


### 2026-11-03: Q2/B設計レビュー修正・exec前gate／manager-owned listener

- §9.79.9と既存§9.79.3〜7を更新。managerが最初のlauncher／runtimeのexec前に環境を許可リストから構築し、fixed argv／closureを確認する。provider内の注入検出は二次確認で、preload前の保護と数えない。QB08へ注入コード実行0・秘密／canonical内容読取0、stage別exec数と無防備fixture対照を追加。
- directoryの名前別ACLという前提を撤回し、root-owned socket unitでmanagerが3 roleのlistenerを事前作成。providerへdirectory writeを与えず、保護されたlaunch inventoryと実socket情報／cookieで検証したFDだけを継承させる。QB04へ任意名作成／隣接leaf削除、QB17へFD差替え／不足／余分／非listener・旧socket回収／世代変更の条件を追加。
- manager listenerのSO_PEERCREDとproviderのSCM_CREDENTIALSを別pinとして両端認証へ束縛し、QB09／QB10も整合。今回も設計のみで、unit／launcher／FD gate／QB回帰実装・配備・新規native実行は0。

Q2/B設計レビュー修正の検証結果: 公開command例・既存Q2/A native・Q1 memory contractの関連117件成功。§9.79.1〜9の9小節、QB01〜QB32の一意性、QB04／QB08／QB17と両端credential条件の追記、旧filename別ACL前提の撤回を確認。diff整形検査成功。文書のみの変更であり、QB回帰は未実装、Q2/B配備・native隔離の新規実証・採用flag変更は0。

### 2026-11-03: 920bf01レビュー修正・Q2/BのSO_PASSCRED時点とqueued接続

- §9.79.10へ、socket unitの`PassCredentials=yes`とlistener inventoryでのSO_PASSCRED照合、clientのconnect前設定、overflow UID／pid 0の資格欠落判定、ready前queued接続の扱い（ready後acceptのみ・challenge前dataで切断・server-first）を追加。QB09／QB10／QB17へ負例を追記し、§9.79.6の理由分類（`evidence_incomplete`だけrunner固有）を明確化。
- 設計のみ。実装・配備・native実行は0。

920bf01レビュー修正の検証結果: §9.79の10小節・QB01〜QB32の一意性・追記箇所を確認。全体110 files／4,030 tests成功、24 files／1,418 tests skipped。diff整形検査成功。


### 2026-11-03: Q2/B1a・配備manifest／preflight診断／静的検証runner

- 追加レビュー修正は既存commit 7588213に記録済みで、重複commitせず着手。§9.80とtest fixtureへ独立manifest pin／canonical schema・artifact全ref／bytes閉包を追加。固定principal／root／endpoint／execution plan・資源上限を照合し、native採用には接続しない。
- manager launch inventoryとcontroller diagnosticを別Ed25519鍵・roleで検証。run／case／manifest／launch digest、listener cookie／custodian／PassCredentials・bootstrap、phase別観測と完全event列、独立case期待値を照合する。exec数・verified数は検証済み記録から導出する。
- 新規119回帰と実テスト結果からの記録docs/validation/gradle-q2b-b1a-static-2026-11-03.jsonを追加。禁止read eventの検査を外した故障対照で回帰が失敗し、復元後に成功することを確認。
- 次はB1bの固定launcher／unit／manager gate／VM fixture、その後B1cの実別UID攻撃・外側controller実証。今回はsynthetic data-only contractで、process・FD・filesystem・account・systemd操作／native隔離実証は0。QB native条件・B2／B3・Q3／Q4・本番採用は未完了。

B1aの検証結果: 新規119回帰成功。全体111 files／4,149 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。保存記録の119 case名／status・source SHA-256、§9.80の6小節を照合し、distにB1a fixture／Python test harnessが含まれないことを確認した。trace検査除去の故障対照でsecret-read回帰が失敗し、復元後の検証も成功。新規Q2/B native隔離・OS配備・grant／原本read省略・profile／本番採用は0。


### 2026-11-03: B1aレビュー修正・listener GID／全principal資格の完全性

- §9.80.7とlistener schemaにownerGidを追加し、manager inventoryはendpoint.groupGid、各phaseのFD観測はmanager inventoryへ照合する。root custodian GIDとleaf GIDを分離し、欠落・不一致を拒否する。
- 全6 principalの観測UID/GIDを必須real／effective／saved三つ組へ変更し、全要素を独立manifestへ照合する。field／要素の欠落・旧scalar形式・root等の不一致を拒否する。
- 新規57件・B1a合計176件。旧不完全記録が修正前に受理されるREDを確認し、全phaseの不一致／欠落と再署名・socket世代／boot／launch digest・参照更新後の拒否を検証。検証JSONを現sourceと実テスト結果で更新する。native隔離・配備・本番採用は引き続き未成立。

B1aレビュー修正の検証結果: 新規57件・B1a合計176回帰成功。全体111 files／4,206 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。現sourceでのtrace検査除去RED／復元GREENも再確認した。検証JSONの176 case名／status・実装／回帰／canonical utilityのSHA-256一致、distにB1a fixtureが含まれないことを確認した。正しい再署名と実際に変更したlaunch digest・参照更新後でも不一致／欠落を拒否する。Q2/Bの新規native隔離・配備・採用flag変更は0。

### 2026-11-03: 09ac3a8レビュー修正・B1aのFD名／memfd bootstrap／記録照合

- §9.80.8へ、bootstrapを固定launcherのsealed read-only memfd（fd 6）とし`LISTEN_FDS=3`を維持、endpointの`fileDescriptorName`をmanifestへ必須化して`LISTEN_FDNAMES`を照合、manager phaseではbootstrap不在・以後はprovider UID所有／seal／read-onlyを要求する変更を追加。保存記録の自動照合testと、manager phaseの資格の意味を明記。
- 新規13件・B1a合計189件。launcher作成のbootstrap recordとmanager署名launch digestの対応はB1bで統一する。

09ac3a8レビュー修正の検証結果: B1a回帰189件成功（新規13件）。全体111 files／4,219 tests成功、24 files／1,418 tests skipped（未commitのB1b launcher testを除く）。型検査・build・diff整形検査成功。


### 2026-11-03: Q2/B1b・固定launcher／unit／VM配備fixture

- §9.81とsrc/test/fixtures/q2bへ、静的Linux manager／launcher、固定isolated Python、offline rootfs／unit／sysusers／tmpfiles生成、VM手順を追加。環境・argv・FD・root／artifact／ACLを検査し、read-only sealed memfd／cookieを束縛して同PIDで権限降下・runtime execする。providerは診断のみでaccept・鍵読取・grantなし。
- root-owned listenerを3 roleのsocket unitで事前作成し、pre-bind guardが既存leafを削除せず拒否する。service／targetの停止と残存leafの扱いを明示し、任意path／commandの特権installerや自動cleanupを追加しない。
- Linux一時containerで30 native startup controls（正常2／manager拒否25／prebind3）と、systemd 255.4で5 unitの構文・参照検証を実行。source／static ELF・runtime／image hashと結果をdocs/validation/gradle-q2b-b1b-startup-2026-11-03.jsonへ保存。通常Vitestは新規37件でDockerを起動せず、offline生成・記録を検証する。
- 次はB1cの実systemd VM・全principalの攻撃／許可対照・認証transport・独立署名controller／B1a連携・lifecycle証拠。今回の結果は起動機構だけで、VM boot／native隔離／承認profile／本番採用は未成立。B2／B3・Q3／Q4も残る。

B1bの検証結果: 新規37 Vitest回帰とLinux起動30 controls、systemd 255.4で5 unitの構文・参照検証が成功。全体112 files／4,251 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。記録の30 case閉包・source hash・同一static ELF hash・§9.81の5小節を照合し、distに新fixtureが含まれないことを確認した。実systemd VM boot・B1c独立隔離／署名controller・本番採用は未成立。別途進行中のB1a変更を保持し、その追加件数をB1b新規37件には算入していない。


### 2026-11-03: B1bレビュー修正・標準FD／fixture祖先の安全性

- §9.81.6へ標準FDの実体・mode・root peer／logging先の検査を追加。検証前はstderrにも書かずexit 78とし、runtimeの再検証も維持する。socket prepareのstreamもunitで明示した。
- fixtureは全branchと最終targetをnofollowで検査してからrelative／exclusive mkdirし、既存親をchmodしない。dangling symlink・未知ACL・unsafe ancestorを拒否し、拒否時のdirectory FDも解放する。
- 修正前のstdio受理／領域外変更のREDと、修正後のcanary不変を確認。root file・pipe・peer差替え11件、path拒否／既存mode保持16件、別pinのentry witness対照1件を追加。guardを外した変異版もentry witnessで検出した。Linux native計58・通常B1bテスト計65件へ更新。VM boot／独立隔離・本番採用は未成立のまま。

B1bレビュー修正の検証結果: 追加28 native controlsで計58件、通常B1bテストは追加28件で計65件成功。全体112 files／4,284 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。5 unitの構文再検証・同一static ELF hash、58 case閉包・source hash・§9.81の6小節、本番buildへのfixture非収録を確認した。修正前のstdio／親symlinkのREDと、launcher guard変異版をentry witnessで検出する対照も成功。既存の別変更は保持し、B1b追加件数へ算入しない。実VM boot／独立隔離／本番採用は未成立のまま。

### 2026-11-03: 155fa89レビュー修正・B1a bootstrapの作成主体訂正

- §9.80.9で、§9.80.8のbootstrap前提（launcher作成・provider所有・manager phase不在）をB1bの実装どおり「root managerが資格降下前に作るsealed read-only memfd、全phaseでFD 6にroot所有で存在」へ訂正。mechanismを`manager-memfd`とし、`launcher-memfd`／`open-file`を拒否。
- B1a合計190件。bootstrap本文とlaunch digestの対応はB1c（§9.81.5）で統一する。

155fa89レビュー修正の検証結果: B1a回帰190件成功。全体112 files／4,285 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。

### 2026-11-03: B1c最初の実VM検証・systemd起動／6 principalのDAC対照

- §9.82とtest-only q2b_b1c fixtureへ、固定imageのQEMU TCG boot、独立SSH host key、固定path配備・bundle pin検証、外側controllerと6 principalの攻撃／許可対照を追加。新規VMを一から作る再現runnerも実行し、Ubuntu kernel 6.8.0-147-generic／systemd 255.4の実serviceで確認した。外側tools containerのkernelは6.10.14-linuxkitであり、container内startupだけの結果ではない。
- 実systemdとの差分としてメモリ監視環境変数の明示除去・8 MiB runtime上限・managerの3 capability明示をB1c診断variantだけへ追加。B1a／B1bは変更せず、最終providerの5 capability集合0・補助groupなし・UID/GID全値をcontroller側から照合する。
- native142件（許可16／拒否126）、別保存のcontroller公開pin／bundle inventoryと署名記録を追加。canary read／write-open・socket操作・proc FD／mem・signal 0・role connectを検証する。これは完全なptrace／signal配送／認証の実証ではない。新規26回帰で署名・独立pin・case閉包・資格・期待値・未成立scopeを照合し、正しく再署名した不正記録も拒否する。
- **B1c全体は未完了。** 次は認証transport／両端kernel資格／FD転送対策、manager署名launchとbootstrap digest、外側exec phase観測・B1a bridge、queued接続・credential保護、coordinated restart／leak drain。QB01〜QB19／QB30〜QB32の完了へ先取りせず、B2／B3・Q3／Q4も残す。systemdBootVerifiedだけtrue、nativeIsolationVerified／profileApproved／backendEligible=false・originalReadsSkipped=0を維持する。

B1c VM部分の検証結果: 新規26 Vitest回帰・実VM142 native controls成功。全体113 files／4,311 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。errno照合を外した故障版で再署名済みunexpected-errno回帰が失敗し、復元後に成功した。公開記録の独立pin／signature・配備inventory digest・実source hashを照合し、本番buildにVM fixture／verifierが含まれないことを確認した。VM外controller署名は収集記録の出自だけを表し、manager署名や完全なexec監査の代用ではない。

### 2026-11-03: B2／B3のlocal保存・Q1 pin連携contract

- §9.83とSealedPrefixStore／SealedPrefixCoordinatorを追加。A2の実disk journal・別checkpointへnamespace予約／seal／選択とuse digestを保存し、完全inventory・byte検証・同期／readback・単調generation／fence・opaque writer handleを接続した。source write前に容量予約を保存し、candidate／quarantined／retiredも課金したまま再起動で復元する。
- B3では全read pin phaseでwriter公開を止め、Completeのidempotent保存後もhandoff・releaseまでpinを保持する。最後のawait後のexpiry／freeze／owner終了を再判定し、歴史的decisionをlive権限へ戻さない。in-flight保存中のbarrier完了も拒否する。
- 未知entry／tail／symlink／hardlink／root交換、marker同期障害、quota・列挙上限＋1、stale boot／head、全pin phase、切断・再送・失効、checkpoint公開後の再open／再同期、rollback、2つの実SIGKILLを検証。53件のdomain回帰と記録照合1件を追加し、実結果・source closure／lockfile hashをdocs/validation/gradle-q2b-b2-b3-storage-2026-11-03.jsonへ保存する。旧viewの最終再検証不足とbarrier早期完了は修正前のREDを確認して修正した。
- **B2／B3の独立UID service実証は未完了。** 今回はlocal POSIX diskと同principalのprocess／child、memory admission fixtureの連携であり、新規VM・認証IPC・独立registry currentness・分散barrierを実証していない。provider ledger checkpointとsource authority checkpointを区別し、sourceの独立fresh issuer／authority gateも未接続とする。B1c残件との接続、実VM故障・power-loss条件、Q3のread省略／性能・Q4の承認profile・物理GC／quota回収が残る。nativeIsolationVerified／independentRegistryVerified／profileApproved／backendEligible=false・originalReadsSkipped=0を維持する。

B2／B3 local contractの検証結果: 新規54回帰成功（53 domainケース＋保存記録照合1件）、実SIGKILL2ケースでchildの到達phase／bootを直接観測して復旧後の非再使用を照合した。全体114 files／4,365 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。実行結果に基づくcase閉包・29 sourceのSHA-256とlockfile hashを照合し、prod buildへのfixture非収録を確認した。VM／別UID service・B1c認証IPC・独立registry／source checkpoint issuerの新規実証、原本read省略・物理削除・本番採用は0。

### 2026-11-03: B1c追加・認証IPC／manager署名・B1a native連携／再起動・FD回収

- §9.84とq2b_b1ctの別fixtureを追加。新規systemd VMで別roleのEd25519・SO_PEERCRED／全fragmentのSCM_CREDENTIALS・絶対deadline／厳格frameを検証した。同UID転送を許可対照にし、別UIDへのFD転送・途中fragment変更、wrong custodian／実sender、ready前queued data・再送・malformed入力を拒否する。
- root managerが実listener inventoryを署名し、232-byte sealed bootstrapへmanifest／signed launch digestを束縛。独立controllerがptrace／pidfd_getfdで3 phase・2 exec／bootを観測し、B1aの新native専用入口で照合する。旧synthetic contract・4 MiB上限・190回帰を維持し、native binaryはcontroller attestationとarchiveでの局所再読取なしを区別する。
- 実SIGKILL・旧接続EOF・service-only restartのexit 78拒否を確認。旧listenerを持つ別reader processが存在する間は回収せず、既知FD参照終了・identity照合後だけ3 leafを回収する。新boot／cookieで旧proof・応答を拒否し、2つ目の正常起動・認証も確認した。Type=simpleの要求戻り値、未読stream切断のECONNRESET、inactive socket unitのunloadを誤判定しないよう実測で修正した。
- 実VM28ケース・2 native launch binding・新規40回帰を追加。公開署名記録と独立pinはdocs/validation/gradle-q2b-b1ct-transport-2026-11-03.json／同名.bindings.json、再現手順はfixture READMEへ保存した。再署名・整合更新した改変の拒否と、bootstrap guard除去RED／復元GREENを確認した。
- **残件**は全B1隔離攻撃・runtime closure承認／配備履歴、B2／B3の別UID native保存service接続、fresh source checkpoint issuer／独立registry／分散barrier・fencing、実VM保存故障／power-loss、Q3 read省略／性能・Q4採用。今回のFD走査は制御actorの有界snapshotであり、任意の並行FD移動／mmap／mount aliasの原子的drainではない。nativeIsolationVerified／profileApproved／backendEligible=false・originalReadsSkipped=0を維持する。

B1ctの検証結果: 全体115 files／4,411 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。2署名主体・独立pin・16 sourceの不変receipt、実VM28ケース／診断操作13・成功client5、2つのboot／新cookieとFD回収を照合した。秘密鍵・seed・credential archiveは検証資料へ含めず、本番採用・原本read省略は0。

### Q3a／Q4a・診断cache・採用拒否gate（2026-11-03）

- §9.85、診断用private byte cache、独立pin付きB1ct記録の採用範囲判定と読取前拒否gateを追加。Q2の未完了条件を残したまま、本番read省略を有効にしないという選択に沿う。
- cold／hit／追加suffixをfull referenceと比較。全履歴MAC／chain／中間state検証を毎回維持し、suffix-only検証・native性能とはしない。入力計数2,067→0／追加2,016 bytesはmemory fixtureの分類で、実file read削減ではない。実装fingerprint付き比較recordを通常回帰で再計算する。
- source8個／合計64 MiB、cache最大64 MiB、pending16個／入力換算64 MiBを制限。checkpoint異常・失効・改変・rollback・逆順completion・evictionを検証。独立pin不一致や自己申告approvalを拒否し、本番gateは常に閉じる。
- 新規31件、全体117 files／4,443 tests成功、24 files／1,418 tests skipped。型検査・build成功。native再実行・checkpoint同期実証・独立registry・承認profile・本番採用・原本read省略は0。
- **残件**: Q2の別UID native保存service／全隔離経路／fresh issuer・独立registry／分散fencing／実保存故障、Q3bのlive pin・完全inventory・checkpoint同期に結んだsuffix-only verifier／authority audit／各budget・large history／native性能、Q4bの独立承認profile・authority／PO3／M0接続。Q3／Q4全体を完了扱いにしない。

### 別UID保存serviceと認証IPCの限定native接続（2026-11-03）

- §9.86とq2b_storageを追加。固定B1ct manager／launcher・Ed25519 IPCへ、別UIDのext4保存primitiveを接続した。単一snapshot／generation 1／最大512 bytesであり、TS SealedPrefixStoreのwire format・複数generation・authority復元のbridgeではない。
- file／directory fsync・readback後だけseal成功を返す。controllerが保存した成功seal digestを外側anchorとしてSIGKILL後に再検証・再同期する。独立fresh checkpoint issuer・authority ackには数えない。正しく署名された不正body型を読取前に拒否するgateも保存variantへ追加した。
- 新規VMで24起動・31保存response（成功14／拒否17）・57 protected events、5 principal×13操作の拒否と5許可対照、旧要求再送／不正body拒否、8保存障害・3改変復旧拒否を実行。23 source receipt・独立pin・各署名・部分inventory・実failed状態を公開recordと照合した。全体期限だけ30分とし、IPCの2秒期限は維持した。
- 新規Vitest54件成功（別processの保存層22ケースを含む）。fsync除去mutantはcounterが8／5のままでも実呼出し0で拒否された。全体118 files／4,499 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功、dist混入なし。公開recordとbindings以外はexportせず、専用コンテナの秘密鍵・seed・ディスクは削除済み。
- **残件**: TSの複数namespace／generation／inventory・Q1 pin／writer fenceとのnative bridge、全FD／mmap／mount alias経路とruntime closure承認、fresh checkpoint issuer・独立registry／分散barrier、実VM再boot／power-loss、Q3b／Q4b。今回の限定接続をQ2全体の完了にしない。nativeIsolationVerified／independentRegistryVerified／profileApproved／backendEligible=false、originalReadsSkipped=0を維持する。

### 2026-11-03: bce3aa6レビュー修正・B1c pinの独立性と拒否理由

- §9.82.6へ、controller pinが記録と同じcommitで追加されリポジトリ上は同時差替えを防げないこと、以後はpinを別commit／リポジトリ外へ先に固定する運用を明記。
- VM verifierのparse／schema失敗を`q2b_vm_schema`へ統一し、拒否回帰23件の期待値を完全一致の理由へ具体化。§9.82挿入でずれたB1b検証結果行を§9.81.6へ戻した。

bce3aa6レビュー修正の検証結果: VM回帰26件成功。全体113 files／4,311 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。

### 2026-11-03: 9bc56adレビュー修正・B2の書込み前拒否とuse ledger容量

- §9.83.8へ、状態変更前の明示的な拒否（汚れ・再使用root、上限、古いcandidate、use衝突／容量到達、未選択）ではstoreを停止しないよう変更し、選択時の呼出し側検査を同期なしの検証へ前倒し。保存・put後の失敗と整合性の失敗はfail-stopのまま。
- use ledgerの64件上限を明記し、到達後の新規Completeは`uses_exhausted`でstore／coordinatorを停止せずに拒否。同値再送は継続可能。rotation／compactionは未実装。§9.82.6を§9.83の前へ戻した。

9bc56adレビュー修正の検証結果: B2/B3回帰60件成功（新規6件）。全体114 files／4,371 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。

### 2026-11-03: 095bbecレビュー修正・B1ct pin・拒否理由・EOF分類

- §9.84.7へ、`.bindings.json`が記録と同じcommitで追加され§9.82.6の運用を満たしていないことを明記。次のnative記録からpinを先に別commitで固定する。
- transport verifierのparse／schema失敗を`q2b_transport_schema`へ統一し、拒否回帰の期待値を完全一致の理由へ具体化。manager署名の検証に実際に到達する負例を追加。
- `auth.py`がEOFを`credential-missing`として拒否する点を既知の制約として記録（次の実VM実行で修正）。§9.83.8を§9.84の前へ戻した。

095bbecレビュー修正の検証結果: transport回帰41件成功。全体115 files／4,412 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。

### 2026-11-03: 9037db7レビュー修正・公開文書の個人環境commandと配置

- §9.85.2の再現commandに混入していた個人環境のcommand proxy接頭辞を除き、インラインコード内の接頭辞付きcommandとdocs配下JSONの接頭辞付きcommandも検出する回帰を追加（既存回帰は行頭だけを検出していた）。
- §9.85の挿入でずれたB1ct検証結果行と§9.84.7を§9.85の前へ戻した（4回目）。Q4aのschema拒否を`prefix_adoption_schema`へ統一し、拒否回帰の期待値を具体化。保存記録はsource fingerprintだけ更新。

9037db7レビュー修正の検証結果: Q3a／Q4a回帰31件・文書回帰3件成功。全体117 files／4,445 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。

### 独立checkpoint issuer・registry current pin・失効／handoff／fencingの設計（2026-11-03）

- 残課題2を設計・実装手順・回帰条件から進める選択に沿い、§9.87の11小節を追加。今回は文書だけで、issuer／registry／Anchor実装・native配備・採用flag変更は0。
- operatorのprovisioning→genesis prepare→activationを定義し、初回writer／checkpoint取得の循環を回避。issuerのprepareとregistryのselected snapshot＋checkpoint採用を分離し、独立ControlAnchorのdurable CAS／fresh readを現在値の確定点にした。同じ復元単位のsigned fileを独立rollback防止に数えない。
- transactionのcontrolRevisionとselected viewのselectionRevisionを区別し、複数readerで健全なpinを失効させない。read pinの引渡しまでの保持、exclusive writer予約と新read閉鎖、revocation／barrier／participant fencing、遅延packetと確定済みeffect、restart後の明示ResumeServingを具体化した。
- 既存coordinatorの読取前gate・local先行選択をそのままRPC化せず、candidate準備→issuer prepare→registry一括選択→非権威的local mirrorへ改めるC2手順を記載。C0 contract→C1保存／Anchor→C2 TS／authority bridge→C3別UID IPC native→C4採用審査の順とした。
- IC01〜IC44はすべて未実装の回帰条件。文書構造・配置確認と既存5 files／286テスト成功を、新ICの成立やnative実証へ読み替えない。§9.85.5が§9.86の後ろへずれていた配置も戻し、新しい§9.87は末尾に追加した。
- **次の着手点はC0**のstrict schema・状態機械・故障schedule。live独立service・適合Anchor・runtime承認・TS複数generation bridge・Q3b／Q4bは残る。backendEligible／profileApproved／independentRegistryVerified=false、originalReadsSkipped=0を維持する。

### §9.87レビュー修正：API認可と後続transaction後のCAS再試行（2026-11-03）

- writer／managerを独立roleへ追加し、全20 APIのclient／server credential・Enrollment permission・対象範囲・目的・委譲を具体化。writerとbroker、managerとoperatorの鍵／権限を混用せず、participant自己confirmとmanagerの管理対象fencingを区別する。
- registryのCheckLiveBindingを明示し、tokenのoffline検証だけで参加者の権限を増やさない。barrierの必須参加者はEnrollmentと最新ledgerから導出し、callerの省略で完了させない。
- CAS応答紛失後に正当な後続Rが確定しても、完全な祖先chainとlatest operation ledgerで元commitを解決する。logical operationとAnchor attemptを区別し、semantic resultのapplied revisionとcurrent revisionを別fieldで返す。hash循環・新規Rによる二重実行・期限／use数の増加を防ぐ。
- historical照会と元API retryによる同じ既存pin／fenceのlive確認を分離。IC14／IC36／IC41を更新し、認可・委譲・祖先証拠不備・conflict／unknownの分類をIC45〜IC48へ追加した。全48条件は未実装のまま。
- 文書11小節・20 API・48条件の閉包と配置、既存5 files／286テスト成功を確認。検証JSONのsource fingerprintを更新し、新service実装・native試験・本番採用は追加していない。次は引き続きC0。

### 2026-11-03: 8d65e5bレビュー修正・明示取消API・full mode・Anchor enum

- §9.87.12へ、pin／writerの明示取消API（CancelWriter／ReleaseReadPin）と権限・phase制約、IC49〜IC51を追加。「有界full mode」をcurrent性を主張しない全検証経路として定義し、handoff・live actionへ使わないことを明記。Anchor APIのmessage typeを別のclosed enumに分離した。
- 5236ba8の`.bindings.json`も記録と同時commitで追加されたことを§9.86へ注記。5236ba8の本体は未レビュー。

8d65e5bレビュー修正の検証結果: §9.87の12小節・22 API・IC01〜IC51を確認。全体118 files／4,499 tests成功、24 files／1,418 tests skipped。diff整形検査成功。文書のみ。


### C0：strict schema・API認可・状態機械・故障schedule（2026-11-03）

- §9.88へメモリ内contractの実装範囲を追記。19 service／registry＋3 Anchor API、実Ed25519署名・opaque actor認可、v2原本replay、prepare／atomic selection、pin／handoff／barrier、取消APIを追加。
- CAS応答紛失後の後続transaction・並行retry、applied／current分離、同pinの期限延長／二重CAS防止、競合・pending／unknown、入口履歴確認と巻戻し拒否を回帰化。故障schedule・容量・独立reader時計を含む131テストと再現scenario・source fingerprintを記録。
- C0のみ。sync・停止証拠・Anchorは協調メモリモデル。全IC01〜IC51のnative成立とはしない。次はC1のdurable issuer／registry・独立ControlAnchor保存と復旧。C2 production bridge、C3別UID IPC、C4承認も未完了。採用flagはすべてfalse、originalReadsSkipped=0。

C0最終検証: 追加回帰131件成功。全体119 files／4,630 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功、test fixtureのdist混入なし。最初の制限環境では既存native socket試験17件がbind時のEPERMで失敗し、local socketを利用可能にした再実行で全体成功。新C0のnative実証は0。


### C0レビュー修正：handoff認可・issuer並行容量（2026-11-03）

- registry確定点・CAS直前・応答署名前でcaller権限を再検査。途中取消しで未確定decisionを採用せず、確定後は記録を保持したまま成功応答を拒否する。
- issuerの未完了prepare／operation枠をawait前に予約。保存時に保持数へ移し、未使用分はfinallyで解放する。保存後のcancelを未保存扱いにして枠を過少計上しない。
- 追加回帰7件・C0計138件、予約判定を外す失敗対照を追加。実証は引き続きメモリ内contract限定。次段階はC1のまま。

C0レビュー修正の最終検証: 回帰138件、全体119 files／4,637 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。記録のscenario／source fingerprintを通常回帰で再照合した。新C0のnative実証0・採用flag false・originalReadsSkipped=0を維持。

### 2026-11-03: 2812a54レビュー修正・C0の書込み前容量拒否

- §9.88.5へ、registry record保存前の容量拒否ではregistryを停止しないよう`#commit`を修正（作成したsemantic-result objectも除去）。保存境界の注入障害とrecord保存後の失敗はfail-stopのまま。
- `request()`の組立不能な要求を`current_control_schema_invalid`／`budget_exceeded`へ揃え、§9.88の見出し階層を`###`／`####`へ直した。

2812a54レビュー修正の検証結果: C0回帰142件成功（新規4件）。全体119 files／4,641 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。


### C1：ローカル永続化・再起動復旧（2026-11-03）

- §9.89、CurrentPersistence strict imageとOwnedCurrentDiskを追加。issuer／registry／Anchorの3 owner、6 root／6鍵とA2の認証journal・equal-put再同期・排他・公開途中復旧をC0確定点へ接続。
- Anchor-selected Rの参照閉包・署名・source／prepare・保持容量を復元し、新incarnation／失効を保存してから受付を返す。旧actor／pin／writer・unknown effectの扱いと元frozenの維持を回帰化。
- CAS前後とregistry commit公開直後の実SIGKILLを検証対象に追加。外部floor・同期障害／再同期拒否・巻戻し・schema・排他も検査する。C0の追加レビュー修正4件は保持する。
- 診断用の同UID POSIX adapterで、外部Anchorの独立復元境界・native隔離・本番client採用は未成立。image 8 MiBの限定経路。次はC2 bridge、外部Anchor適合／C3配備とC4採用審査。採用flag false、originalReadsSkipped=0を維持。

C1最終検証: C1回帰29件・C0回帰142件成功。全体120 files／4,670 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功、test fixtureのdist混入なし。実SIGKILL 3件（CAS前／CAS後／registry commit公開直後）を再実行し、通常回帰で観測・source fingerprintを照合した。Anchor floor・startup失効・C1 single-flightを外す対照は各対応回帰で失敗する。独立UID／rollback domain・電源断耐性・本番採用は未成立。


### C1レビュー修正：保留応答のowner寿命・原本読取前再認可（2026-11-03）

- ownerの同期assertOpenをcontrolのgate・認可・応答受理へ結合。IO外pause中にcloseした旧controlの応答、close前に署名した保留応答、保存障害後のlive応答を拒否する。storage IO中はcloseをbusyで拒否する。
- persistence.verify後・execute直前・issuer検証／保存pause後に再認可する。権限取消し後の3 APIの原本read／bytes／replay増分0、issuer自身のpause後の読取拒否を回帰化。
- 回帰8件を追加（C1計37件）。修正前の7件の失敗を確認。C0互換scenarioとC1 native 3観測の範囲を維持し、source fingerprintを更新する。

C1レビュー修正の最終検証: 追加8件・C1計37件・C0計142件成功。全体120 files／4,678 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。実SIGKILL 3件とscenario／source fingerprintを通常回帰で再照合した。権限取消し3 APIの原本read／bytes／replay増分0と、終了／停止ownerの旧応答拒否を確認。ローカル協調adapterの実証範囲・採用flag false・originalReadsSkipped=0を維持。

### 2026-11-03: 762be6eレビュー修正・C1保存層の書込み前拒否

- §9.89.6へ、Anchor image保存前の呼出し側入力による`cas`拒否（binding_mismatch／receipt_invalid／idempotency_conflict）ではdisk ownerを停止しないよう修正。保存済みimageの整合性・署名の不一致と保存後の失敗はfail-stopのまま。
- registry record・Anchor履歴・A2 commitの256件上限から、生涯の状態遷移が約256回（read換算で数十回）に限られることを明記。GC／compactionはC2以降。

762be6eレビュー修正の検証結果: C1回帰39件・C0回帰142件成功。全体120 files／4,680 tests成功、24 files／1,418 tests skipped。型検査・build・diff整形検査成功。

### C2：本番用client・Gradle readerの明示接続（2026-11-03）

- §9.90へclient／provider／authority境界を追加。共有schema・full v2 replay・authority snapshot decoderをutilsへ移し、fixture側は互換re-export。本番moduleにprincipal発行を入れない。
- 実GradleGraphCacheへroot applicationによるbridge注入経路を追加。fresh pin・issuer検証・原本namespace全検証からG0/G2・live authority照会・handoff・use保存・consumer ACKへ接続。注入経路でcompanion／cached callerへfallbackしない。
- registry採用をlocal mirror更新より先にし、registry modeのlegacy select／readSelectedを拒否。C1保存ownerとの接続、CAS再試行、mirror修復、失効／改変拒否をC2回帰21件と3つの失敗対照で検査する。
- C3の独立wire認証・別UID／外部Anchor配備、C4承認と長期運用向けGC／compactionは残る。transportは自動配備せず既定readerを維持。採用flag false・originalReadsSkipped=0のまま。

最終検証: C2回帰21件、C0回帰142件成功。全体は`npm test -- --maxWorkers=1`で121 files／4,701 tests成功、24 files／1,418 tests skipped（235.00秒）。初回の既定並行実行は既存C1復旧試験1件が30秒でtimeoutし、単独再実行は15.93秒で成功。試験内容・timeoutは変更せず全体を再検証した。型検査・build・diff整形検査成功。本番配布moduleにfixture import／principal発行がないことも確認。

C2レビュー修正: 初回予約の送信前にintent／要求ID／payloadを保持し、BeginEnrollment・ReserveWriter・AcquireReadPin（通常read／mirror）の応答紛失を同一要求で再試行する。元grantのlive確認、期限切れ時の新規予約拒否、保留intent差替え拒否を8件追加（合計29件）。別UID認証IPC・本番承認等の未成立範囲は維持。

C2初回予約レビュー修正の最終検証: C2回帰29件成功。全体は`npm test -- --maxWorkers=1`で121 files／4,709 tests成功、24 files／1,418 tests skipped（243.48秒）。型検査・build・diff整形検査成功。元の全体検証結果はvalidationのpreReviewVerificationとして保持する。

### 2026-11-03: 7aa8512レビュー修正・C2保留予約によるbridge停止

- 応答紛失した初回予約がlease失効後も単一slotに残り、別file・mirror修復・公開が`binding_mismatch`で永久に不能になる問題を修正（§9.90.6）。保留はintentごとの上限8件、結果不明だけ保持、確定拒否・selection変更で破棄。
- deliverReadのhandoff前live確認失敗では当該readだけを失敗させ、bridgeを止めない。
- 期限切れ再試行テストの素の`toThrow()`を正確な理由に改め、回帰を追加（C2計32件）。

7aa8512レビュー修正の検証結果: C2回帰32件、全体4,712 tests成功（1,418 skipped）。型検査・build成功。

### C3接続契約・実装手順の具体化（設計）

- §9.91にprocess別の所有root／鍵／role、固定launcher・manager作成listener／sealed bootstrap、読取前gate・全fragment認証を具体化。
- C2のcontext／namespace／source／authority proof／use保存を認証APIへ対応付けた。WeakMap handleをwireへ渡さず、brokerのfull検証とlive authority・結果bytes照合を必須とする。
- 同一要求retry・期限／失効・保存／ACK・mirror順序、authority失効とhandoffの予約protocol、独立Anchorとrun前pin固定を明記。
- 実装順はC3a strict schema／runner→C3b process別service／adapter→C3c固定VM配備→C3d native故障検証→C4独立採用審査。**次はC3a**。
- CN01〜CN40は新規の未実装回帰条件。今回の変更は設計のみで、新規配備・native実行・schema実装は0。採用flag false・originalReadsSkipped=0、長期運用向けGC／compactionの残課題を維持。

C3設計の検証結果: §9.91.1〜9の9小節とCN01〜CN40の順序・一意性・欠落なし、末尾への配置を確認。既存current control／C2 bridge／deployment／native storage記録検証の4 files・418 tests成功（35.67秒）。diff整形検査成功。今回の変更は文書のみで、CN回帰の実装・新service配備・native実行・採用flag変更は0。次はC3aのstrict schema／permission／静的検証runner。

C3設計レビュー修正: §9.91.10へcandidate-genesis／candidate-advance／selectedの証拠strict unionを追加し、採用前issuer readと採用済みreader readを分離。root manager／controllerと権限降下後processのprincipal・取得phase別権限条件を具体化。CN02／CN12／CN13を正常対照・混用拒否・phase偽装／残存権限拒否へ更新。文書のみで、C3a schema実装・新規native実行は未着手。

C3設計レビュー修正の検証結果: §9.91.1〜10の10小節・CN01〜CN40の一意性と順序、mode／phase別条件の配置を確認。既存current control／C2 bridge／deployment／native storage記録検証の4 files・418 tests成功（36.15秒）。diff整形検査成功。文書のみの変更で、CN02／CN12／CN13を含む新schema・回帰実装・native実証は未実施。

### 2026-11-03: 8a8e82fレビュー修正・C3とC2保留契約の整合

- §9.91.1／§9.91.4／CN23を§9.90.6（8c6c567）の保留契約へ揃えた。intentごとの有界表、結果不明だけ保持、別intentは阻まない、確定拒否後は新ID。基準をC2 32回帰に更新した。
- 失効したgenesis provisionが`provisioning`のまま残り、BeginEnrollmentが永久に`control_conflict`になる問題への対応として、提案API AbandonEnrollmentとCN41を§9.91.11に追加した。
- 1 read pin（5秒）内の全工程について時間予算表とclosure上限をC3aで固定する条件と、CN42を追加した。C3aの終了条件にも反映した。

8a8e82fレビュー修正の検証結果: §9.91.1〜11・CN01〜CN42の一意性と順序を確認。文書のみの変更で、提案APIとCN41／CN42の実装・native実証は未実施。

### C3a：追加API・phase別配備証拠の静的contract

- §9.92に7追加APIのstrict request／reply・署名domain・static grant認可と、candidate-genesis／candidate-advance／selectedの証拠分離を実装した範囲を記載。
- 独立manifest／profile pin、manager／controller署名、phase別資格・listener GID、循環しないbootstrap束縛とcase期待値照合のsynthetic runnerを追加。新規165回帰と2つの検査除去対照を実行。
- 今回は静的contractのみ。nonce replay state・live pin・full転送／G0/G2・service別保存／ACK・独立AnchorはC3b、事前pinとVM配備はC3c、native故障検証はC3d。採用flag false・originalReadsSkipped=0を維持。

C3aの検証結果: 新規2 files／165 tests成功。全体は`npm test -- --maxWorkers=1`で123 files／4,877 tests成功、24 files／1,418 tests skipped（240.68秒）。型検査・build・diff整形検査成功。検査除去対照はselected head 1件・残存capability 5件が失敗し、復元後に成功。source fingerprint一致とtest runner／秘密署名処理のdist不混入を確認。新規native実行・本番採用は0。

C3aレビュー修正: AuxiliaryPinに署名identity全体と方向を必須化し、request peer／reply serverへ照合。role／instance／boot別のendpoint全inventoryからlistenerDigestを再計算してphase／bootstrapへ束縛。回帰19件を追加（合計184件）、うち11件の修正前失敗を確認。旧pinと旧listener digestを拒否し、正規更新は許可。実証範囲は静的contractのみを維持。

C3aレビュー修正の最終検証: 対象2 files／184 tests成功。全体は`npm test -- --maxWorkers=1`で123 files／4,896 tests成功、24 files／1,418 tests skipped（255.12秒）。型検査・build・diff整形検査成功。source fingerprint一致と、test runner／秘密署名処理がproduction distへ混入していないことを確認。新規native実行・本番採用は0。

### 2026-11-03: e4577c0レビュー修正・ReadContextの観測化とCN41／CN42

- ReadContextのreplyがrequestの全bindingとの完全一致を要求していたため、新しいselection・失効・再起動を観測できず、初回readも組み立てられなかった。requestはlineage 6項目だけを束縛し、変化する値を観測して、任意のfloorで巻戻しを拒否するよう改めた（§9.92.5）。
- C3aの終了条件（§9.91.8）に残っていたAbandonEnrollmentの静的contractと読取時間予算profileを実装し、runnerがCN41／CN42を受理するようにした。
- 回帰41件を追加（C3a計225件）。runtime検査（失効確認・durable保存・実測）はC3b／C3dに残る。

e4577c0レビュー修正の検証結果: 対象225件、全体4,937 tests成功（1,418 skipped）。型検査・build成功。

### C3b service分離・認証sessionの実装単位（設計）

- §9.93へrole固有OwnerConfig／Signer／OwnedStore・公開credential registry・明示client portを具体化。C1全owner／全private key表とC0共有pending表を本番serviceへ持ち込まない。
- server所有challenge／client私有pending reply、session／sequence／一回消費・durable operation retryの分離、runtime認可／live view／in-flight追跡を規定。
- control-readyと復旧専用portにより起動の相互待ちを解消し、Anchorがissuer private rootを開かない責任分離を明記。AbandonEnrollment・5秒予算／request残枠・authority予約／ACKの接続も後続unitへ割当て。
- 実装順はC3b-0 port／schema→1 session二者process→2 registry／単一role store→3 provider／issuer→4 authority失効／handoff→5 C2接続・use／ACK。**次はC3b-0**。
- CB01〜CB44は設計条件・未実装。今回のservice配備・新規native実行・採用flag変更は0。C3c／C3d／C4と長期運用向けGC／compactionは残る。

C3b実装単位設計の検証結果: §9.93.1〜10の10小節、C3b-0〜5の順序、CB01〜CB44の一意性・欠落なしと末尾配置を確認。既存C0 control／C2 bridge／C3a auxiliary・deploymentの4 files／399 tests成功（41.99秒）。diff整形検査成功。今回は設計書・TODOのみの変更で、CB回帰実装・新service／認証sessionの実装・配備・native実行・採用flag変更は0。

C3b設計レビュー修正: §9.93.11で業務K／Dと保存stageのtransition key／digest・expectedHead・前stage receiptを分離。同じPrepareHandoffの2段階保存と、後続head前進後の旧stage再送を区別する。§9.93.12で応答紛失時の旧channel終了→同bootの新session→元業務要求retryを規定し、sequence欠番許容による回復を禁止。CB15／CB18／CB20／CB34／CB39を更新し、回復コスト・回数上限を予算へ課金。今回は設計のみ。

C3b設計レビュー修正の検証結果: §9.93.1〜12の12小節、C3b-0〜5の順序、CB01〜CB44の一意性・欠落なしを確認。既存C0 control／C2 bridge／C3a auxiliary・deploymentの4 files／399 tests成功（47.38秒）。diff整形検査成功。文書のみの変更で、stage保存・session回復・追加回帰条件のruntime実装とnative実証は未実施。

### 2026-11-04: 153a867レビュー修正・stage再送の解決順とcontext floor

- §9.93.11の保存stageは`transitionDigest`に`expectedHead`／`nextImage`を含むため、head前進後の再送を現在状態から組み立て直すと`idempotency conflict`になり、元結果へ収束しなかった。業務ledgerをK／Dで先に引いて保存済みreceiptを返し、StageCommitRequestは未保存stageでだけ組み立てる解決順を§9.93.13に定め、CB45を追加した。
- ReadContextの`floor`（§9.92.5）を、新session回復・server boot変更・incarnation変更の後も保持する条件とCB46を追加した。
- C3b-0の予算計画を、C3a `read-budget.v1`を拡張する新version（v2）として定義することを明記した。

153a867レビュー修正の検証結果: §9.93.1〜13・CB01〜CB46の一意性と順序を確認。文書のみの変更。

### C3b-0：role固有port・session／stage／回復・v2予算の静的contract（2026-11-04）

- §9.94に5 ownerのstrict config・公開credential registry、私有plan／port／signing intent、状態遷移検査を追加。Signer／OwnedStore callbackを呼ばず静的組立を検査する。
- 両端boot／key epoch／registry digest付き署名transcript、challenge／channel・復旧API・outcome schema、保存stageとledger優先のpure解決、session回復・context floorを実装。
- v2は10経路handshake・issuer最大8 prepared source・chunk／request／署名／9stageを保守的に課金。計画のみで、実quota消費・native throughputやcall graph成立を主張しない。
- 新規240回帰、4つの検査除去対照、検証記録とsource閉包照合を追加。CB01〜CB46の静的な一部のみ。新規native実行・本番採用は0。
- **次はC3b-1**：独立session client/server・pending／nonce／sequence・atomic予約・二者child-process対照。C3b-2以降の実store・Anchor・原本・authority／ACK、C3c／C3d／C4は残る。

C3b-0の最終検証: 新規4 files／240 tests成功。全体は`npm test -- --maxWorkers=1`で127 files／5,177 tests成功、24 files／1,418 tests skipped（242.60秒）。型検査・build・diff整形検査成功。4つの検査除去対照で各1件が失敗し、復元後に成功。14 source閉包fingerprintの一致と、test fixture／秘密署名処理がproduction distへ混入していないことを確認。新規native実行・本番採用は0。

C3b-0コミット前の依存更新互換確認: 既存のkoffi 3.3.5／MCP SDK 1.32.2更新（9997f4eまで）を維持し、validationのpackage fingerprintを更新。対象240件、全体5,177件成功（1,418 skipped、並行数1、265.15秒）、型検査・build成功。更新前の検証結果・package fingerprintは履歴として記録内へ保持した。

### 2026-11-04: b6bb2f8レビュー修正・C3b-0予算の過大計上

- v2予算がchunkごとにissuerの8 prepared全体を計上していたため、受理できるclosureが最大40,960 bytesで、C2 fixtureのsource（41,452 bytes）も拒否されていた。選択sourceだけを計上する`selected-source-read-v1`に改め、上限をrole別要求上限から導出した（126 chunk、§9.94.6）。64 MiBまで広げるにはC3b-3のtransfer設計が必要。
- session回復に、handshakeと残り工程の時間が両期限内に残ることの確認を加えた。challengeの権限照合にpurpose・lineage・委譲先を加えた。
- 回帰6件を追加（C3b-0計245件）。


b6bb2f8レビュー修正の検証結果: 対象245件、全体5,182 tests成功（1,418 skipped）。型検査・build成功。


### C3b-1：認証session runtime・二者child-process対照（2026-11-04）

- §9.95に独立鍵ownerのSessionClient／SessionServer、pending・nonce・sequence・atomic予約、期限・失効・容量、応答紛失後の同boot新session回復を追加。今回はread-only `recovery.GetRecoveryStatus`だけをdispatchする。
- 単体29件と別process suite 4件を追加。child各1個の秘密鍵、公開鍵のみの交換、4 transcript・4 dispatch・3回復・7要求を照合。旧hello／旧結果の拒否、失効・期限によるdispatch 0を確認する。
- 診断cacheは同bootのメモリ内限定。durable ledger・保存ACK・原本読取・native隔離・本番採用は未成立、全採用flag false／originalReadsSkipped 0を維持。
- 次はC3b-2：OwnedStore／stage ledger／Anchorの実接続。C3b-3原本transfer、C3b-4 authority、C3b-5 C2業務経路、その後C3c／C3d／C4が残る。

C3b-1の最終検証: 新規2 files／33 tests成功（単体29件・別process suite 4件）。全体129 files／5,215 tests成功、24 files／1,418 tests skipped（233.43秒）。型検査・build成功。内側署名検査を除去すると署名改変の回帰が失敗し、検査を復元した。production runtimeにtest fixture import／鍵生成処理がないことを確認。source閉包14 filesを検証記録と照合する。新規の別UID隔離・本番採用は0。

### 2026-11-04: e69babbレビュー修正・session runtimeの枠解放と署名API

- 実行後のhandleが`#pending`に残り、失敗が上限に達するとclientが再起動まで使えなくなる問題を修正した。期限切れの未実行handleも解放する（§9.95.4）。
- serverの診断cacheが失敗と完了を起動中ずっと保持していた問題を修正した。失敗は保持せず、完了は最初のchallengeの期限後に解放する。C3b-2のdurable ledgerには持ち込まない。
- 公開の汎用署名`signed`／`sign`と`config.privateKey`を廃止し、署名を検査付きのモジュール内関数に限定した。RoleSignerへの接続はC3b-2に残る。
- 回復の時間判定を`recoveryTimeFits`へ統一し、clientのsession寿命をtransport open前から数える。記録のパスを修正した。

e69babbレビュー修正の検証結果: 単体40件・別process 4件、全体5,226 tests成功（1,418 skipped）。型検査・build成功。


### C3b-2：own-role保存・署名／registry・Anchorの接続（2026-11-04）

- §9.96に単一ownerのStageStore／RoleSigner、RegistryOwner／AnchorOwner／AnchorClientとstrictな公開R・command・状態schemaを追加。C1 primitiveを本番向けに切り出し、既存fixtureは比較対照として維持する。
- 認証sessionの私有受付handle、durable stage／業務ledger、公開Rの保存→exact CAS→adoption、応答紛失後の元attempt解決、起動時の全履歴照合→旧grant失効保存→受付開始に対応する。
- ReadContext、pin／writer、genesis／advance、AbandonEnrollment、協調drain証拠を注入したbarrier／freezeの回帰を追加。issuer full検証・実participant drainの成立とは分ける。
- registry／Anchor別childでown鍵・own rootだけを渡し、応答紛失・実SIGKILL・保存障害・再起動後のhistorical結果を検証する。native隔離・本番採用は未成立、全採用flag false／originalReadsSkipped 0を維持する。
- 次はC3b-3のprovider／issuer・原本transfer／mirror。その後C3b-4 authority、C3b-5 C2／RecordUse／ACK／shutdown、C3c／C3d／C4、Q3b／Q4b、長期運用GC／compactionが残る。

C3b-2の追加境界検査: ReadContextのfloorをclientで自動観測し、server boot変更後も保持する。original deadline・回復枠・unknown状態をboot quotaへ束縛し、別handleによる再生成を拒否する。検査除去対照はledger優先1件・Anchor応答鮮度1件・業務予算2件で期待どおり失敗し、復元した。

C3b-2の最終検証: 新規3 files／51 tests（StageStore 19件・RegistryOwner 28件・別process suite 4件）。全体は`npm test -- --maxWorkers=1`で132 files／5,277 tests成功、24 files／1,418 tests skipped（359.64秒）。型検査・build・diff整形検査成功。3種類の検査除去対照で計4件が期待どおり失敗し、検査を復元して全体を再確認した。56 source閉包とC3b-0／1の互換receiptを照合し、production distにtest fixture／全actor factory／鍵生成がないことを確認。全採用flag false、originalReadsSkipped=0。

### 2026-11-04: acacac7レビュー修正・registryの容量到達と呼出し元の失敗

- pin取得・解放の3往復でregistryが止まり再起動もできなかった問題を修正した。`anchor.cas`の署名上限を揃え、stage数と要求の大きさを保存前に確認して`capacity_exhausted`で拒否する。通常業務は16 stage／20,000 bytesを再起動とbarrierのために残す（§9.96.8）。
- imageをstageごとのrecordだけにし、検証を線形にして、全ファイルの再同期を起動時だけにした。実際の上限で20往復、書込み最大約2.1秒（1回の計測）。
- 保存後は呼出し元の失敗でregistryを止めない。`CheckLiveBinding`の`await`漏れとprovision対象の拒否を修正した。同時要求を到着順の直列処理にした。
- GC／compaction未実装のため、容量に達した系統は再開できない。実運用の前に必要。

acacac7レビュー修正の検証結果: RegistryOwner 46件、全体5,295 tests成功（1,418 skipped）。型検査・build成功。


### C3b-3：provider／issuer・原本転送・mirror（2026-11-04）

- §9.97にrole別Source owner factory・strict source schema／明示client portsを追加。own signer／store以外のprivate key・filesystemを渡さず、登録data MAC materialをservice鍵と分離する。
- namespace reserved／sealed、全inventoryの有界chunk組立、source full replay／advance prefix、issuerのdurable prepare、registry採用・exact selected read／pin-bound witness、fresh mirror修復を接続した。
- origin／delegate／snapshot付きlive check、読取前／応答前gate、失効・barrier・provider不能時の拒否、boot保存と同boot再open拒否に対応。既定MCP／C2 routeは変更しない。
- 実disk回帰と4 owner child-process対照、応答紛失／保存障害、3つの検査除去対照・source receiptを追加。通常native対照は小さい正規authority snapshotで、大きい実行snapshotの5秒以内完了は未成立（期限到達は拒否）。
- 次はC3b-4のauthority・実行予約／失効・実drain。C3b-5のC2／outcome／RecordUse／ACK／全工程予算／shutdown、C3c／C3d／C4、Q3b／Q4b、有限stage／snapshot容量を解決するGC／compactionが残る。

e6d405fレビュー修正（§9.97.8）: 3件を修正した。

- mirror／witnessの16 stage枠とboot用の予約枠を追加し、同じ事実の再保存を廃止した。
- 予約は入力検証後に保存する。
- `CheckLiveBinding`をboot予算から外し、issuerの転送前残枠確認と診断を追加した。

process回帰はvitestの別projectで単独実行する。GC／compaction、`ReadForCheckpoint`等のboot枠、180 KB sourceが5秒fenceに収まらない点は残る。

### C3b-4：read-only authority・handoff・runtime drain

- §9.98。AuthorityOwnerのfull原本／G0/G2、署名witness・scope／consumer／result照合、own予約／revoking／revoked、旧terminal拒否を実装。
- rootがA1 producerと同じ原点のauthority clockを登録するlocal profileを追加。期限・原点不明・巻戻しを拒否し、fresh pinでauthority lifetimeを延長しない。別host／時計条件未確認は未対応。
- registryへ2段階handoffとbarrier順序を接続。completingの途中停止をpendingとして保持し、再起動・TTLで決定を捏造しない。
- 新規受付・実session／保留RPCを閉じるruntime drain、gate別のregistry照合による不明予約解決、reader／writerの同boot再使用拒否を追加。旧注入証拠とruntime証拠を区別する。
- 5 ownerのlocal process接続と、実SIGKILL後に予約を不明として復元することを検証（settle以降は未実行）。別UID／kernel FD隔離・独立rollback・本番採用は未成立、originalReadsSkipped=0。
- 検証件数と実行範囲は`docs/validation/gradle-independent-currentness-c3b4-2026-11-04.json`へ記録する。
- 次はC3b-5：C2／authenticated outcome／RecordUse／consumer ACK・結果転送・全工程予算・全service復旧／shutdown。C3c／C3d／C4、Q3b／Q4b、GC／compaction・性能検証も残る。

6f6602bレビュー修正（§9.98.6）:

- 全予約の決着後は新bootのbrokerが受付を再開する。旧gate・旧予約の再送は拒否する。
- 旧providerのseal、拒否されたsettle、`QueryOperation`のpending、既存barrier中の失効、revoking中の保存済みgate、`ServiceDrain`のresource不足を修正した。
- authority processテストをvitestの実時間projectへ移した。
- 実測上限: prepareは1 bootあたり14回、handoffはbarrierを挟まず8回。GC／compactionなしでは、再開は1周1予約で約10周までである（計算値）。C3b-5の前に優先度を判断する。

### C3b-5：consumer-only業務接続・outcome・use／ACK・協調復旧

- 実装：明示注入のC2 consumer bridge、broker本人のhandoff／delivery／durable RecordUse、bounded結果bytesの照合、reader本人ACK、予約完了。旧既定経路は維持。
- 実装：署名付きrefused／unknownとprivate intent（unknown確定後の同一ID再試行は`recovery_required`で止まりbarrierへ送る）、read-plan.v3の全工程費用とpin取得前admission。正常readはAnchorを含む15保存stage。
- 実装：barrier／全participant drain／実停止、fresh bootstrap、own履歴を検証した5ownerの署名付き復旧報告、exact roots／epoch／run／barrier／bootとregistry digestへ結んだ再開gate。
- 契約正常系・応答紛失・保存障害・期限・barrier・偽造復旧報告の回帰と、同UID5childの期限拒否→全service再起動／再開を検証する。別UID隔離・本番採用の証拠ではない。
- 同UID native正常readは最終コードで3,876ms／15stage／本人ACK／公開1、全停止・復旧報告5件・再開を確認。負荷時は4,502msで公開0の期限拒否も観測。**残件は最大入力・継続負荷の性能と独立した実速度profileの承認**。転送・反復履歴検証の改善は引き続き候補。
- 続いてC3c固定配備、C3d native故障・権限分離、C4採用審査、Q3b／Q4b、GC／compaction・大容量性能が残る。全採用flag false／originalReadsSkipped=0。
- レビュー修正：GCなしの上限を契約テストで固定。公開は1 registry履歴あたり2 readまでで、3回目はpin・handoff後に`capacity_exhausted`となりbarrierが必要。実時間の5 processでは、初回4／8、直後の2回目0／2、再開後0／4（修正前のコード）で、期限内の連続利用は未成立。**C3cの前にGC／compactionと履歴検証の費用を判断する**。admission viewを実カウンタから作る実装も未着手。

### C3b GC／compaction・service世代移行の具体設計（§9.100）

- 設計のみ。5ownerの一括offline移行を対象に、service世代とproducer source世代を分離。現在の2 read上限・連続利用の性能・GC未実装という制約は未解消。
- registry／Anchorを含む移行を承認する独立ServiceGenerationAuthorityを必須化。source／target 20 root＋control 2 root、role別鍵／IO、目的別API認可、全工程の容量予約・実counter admissionを定義。
- freeze時のuse／ACK／broker予約の解決、保持・historical・retire分類、旧receipt／署名bytes・選択sourceの新rootへのimport対応、revocation／budgetの持越しを具体化。
- StageStore.v2 base＋delta、新registry／Anchor base、current outcomeのpage化で、単なるjournal切詰めや次の2 readでの再膨張を避ける。hash順序、phase別の必須証拠、bootstrapと読取前gateを定義。
- exact cutover／応答紛失／再起動、holdとGC batch予約の順序、有限inventoryのunlink／sync／再試行、source削除後の起動、上限到達時の拒否を具体化。
- 実装順はCGP（5秒の内訳・page化試作・時間予算・目標read回数）→CG0（strict schema・閉包・射影・状態／認可の純粋contract）→CG1（SGA／予約）→CG2（gate／freeze）→CG3（base／import／page）→CG4（cutover／completed／復旧）→CG5（completed後のGC）→CG6（連続利用・性能）。CG01〜CG52は未実装の回帰条件。
- **次の着手点はCGP。** SGAの独立backend、GC・移行runtime、新format reader、native故障・性能実証は未成立。C3c／C3d／C4、Q3b／Q4bも引き続き残る。
- 文書の検証範囲とsource fingerprintは`docs/validation/gradle-c3b-compaction-design-2026-11-04.json`へ記録する。設計条件の列挙・整形検査を、runtime回帰の通過と数えない。

§9.100レビュー修正：

- 生成前のServiceGenerationId／OwnerProvisionVectorと、構築後のOwnerVector／ServiceSelection・採用receiptを分離。template・import core・genesis checkpointから未来vectorへの循環を禁止し、registry→Anchor baseの生成順も明示した。
- GC開始・再開前の5target完全再検証、fresh gcRun／challenge、TargetRevalidationSetと継続read-only custody、実行permitの失効・限定resume認可を具体化。Readyだけではunlinkを許可せず、target runtimeの書込はGC完了後に限定した。
- CG30は正常な非循環生成と未来refの負例、CG32はReady後／cutover後のtarget改変、CG33は再検証後・予約後・Prepared後の停止／再起動と旧permit拒否を追加。設計のみで、runtime回帰条件は引き続き未実装。

§9.100第2次レビュー修正：

- source GCを`completed`後の別工程（`sourceRetention`）へ分離し、§9.66の順序をC3bでは置換。target起動を確かめてから削除でき、hold・GC非対応・paused中も通常受付を止めない。上記「target runtimeの書込はGC完了後に限定」は取消し。
- 通常受付前の起動不良に`target-rejected`を追加。同じFrozenSetから新generationをplanでき、sourceの通常再開はしない。
- GC再検証を、稼働中ownerによる不変閉包＋delta連鎖の検証へ変更。読取専用custodyは廃止。
- control record式を定義し、移行可能量をbatchが揃う場合の最大20,480 entriesへ修正。未GC世代の上限は2。
- CGPを追加。fresh SGA確認を1 read 6境界の候補に限定し、5秒に収まる見込みと`readsPerGeneration`が示せなければCG3以降へ進まない。page化要件を5ownerへ拡張。
- CG49〜CG52を追加。いずれも設計のみで、runtime回帰条件は未実装。

### CGP：実時間read計測・registry page限定試作（§9.101）

- 3回の5owner bootstrapでcall／owner／phase・process CPU／stage／disk／署名検証を計測。レビュー修正後の反復は初回3/3成功（3.879〜3.942秒）、成功後の2回目0/3で明示的な期限切れによる拒否（その他の拒否0件）。拒否の公開差分0を確認。
- registry childの別2rootで、実状態遷移からsynthetic IDを付けたfull／page snapshotを3 pair比較。pageはCAS要求最大4,530 Bで8 read分を保存できたが、全履歴検証費用が残り、同一prefixで一貫した速度改善はない。本番registry／Anchorにpage formatを接続した実測ではない。
- `readsPerGeneration=8`を容量上の候補として設定。5ownerの旧stage費用を仮定したregistry余力は保守込み59/64。新formatの実容量・request予約は未成立。
- SGAは未実装のため認証付きReadContext 18回をlatency proxyとして使用。6境界＋phase envelope＋回復・余裕＋page試作追加費用のwhat-ifは約8.88秒。これは実paged readの測定や性能上限ではない。
- **CGPの時間面は未達、CG3以降のgateは閉鎖。** 次はCGP内で1 read 238回の`readCommitted`の呼び出し元を分解して回数を減らし、変更のないpageの再利用とownership／鮮度を維持したbounded再使用・incremental検証の限定試作と再計測を行う。CG0へはCGP成立まで進まない。
- 再現ハーネス・回帰・性能比較・rawとsummary記録を追加。独立SGA、本番format、GC／移行、native隔離、Q3b／Q4bは未成立。全採用flag false／originalReadsSkipped=0。

§9.101レビュー修正：

- 追加時間は同じ更新ごとの非負差を計算してから最大値へ集約。full／pageの最大値の位置が違っても相殺しない回帰を追加した。
- 明示的なrequest_expiredだけを期限拒否とし、容量拒否とother-refusedを分離。権限・復旧・汎用予算・未知エラーを期限扱いせず、native runnerはother-refusedがあれば失敗。記録検証もreasonとの不一致を拒否する。
- 修正後コードで5process native計測を再実行し、raw・source receipt・同一prefix比較・6境界の時間予算を更新。SGAは代用計測、8 readsは容量候補、CG3保留を維持する。

§9.101再レビュー修正：

- 公開文書の実行例から個人環境のproxy接頭辞を除去。全体suite未実行で`commandExamples`の失敗を見逃していた。
- what-ifを上限・保守的と読める表現を削除。連続readの伸び（1.62〜1.66倍）とcall回数（`readCommitted`計238回）がモデル外であることを派生記録へ追加。
- page試作が変更のないpageも再保存すること（最終commitは30 objectのうち変更6）を記録し、速度比較が再利用の評価ではないと明記。
- 拒否分類の改変テストは成功sampleだけを変えており、分類検査を除去しても通っていた。失敗sampleで理由まで確認するよう修正。
- CGP記録を`measuredAtCommit=426ab84`へ固定し、現在のsourceとの一致を要求しない。rawは書き換えない。
- Anchorの容量予測を保守込み58/64へ修正。「約25 MB」を実測の28.4〜28.6 MBへ修正。分析scriptの再生成で手書き節が消えないよう修正。
- 判断：§9.100.13どおりCGPに留まり、CG0へ進まない。

§9.101証拠処理の修正（`0bc84c3`後のレビュー）：

- owner接頭辞付きの期限・容量拒否を、既知の5 ownerに限って同じ分類にした。
- native runnerの例外時に、収集済みの証拠を`osv-mcp.cgp.measurements.partial.v0`として残す。検証と分析は受理しない。
- 検査条件の変異テストを110件中25件検出から110件すべての検出へ。到達できない2検査は削除。計算式、`cgp_child.mjs`、native runner自体は対象外。
- 分析scriptは比較できないsampleを理由つきで除外し、要約全体を止めない。完了readが0件のrunは拒否する。
- 5 process fixtureの起動失敗時に、一時ディレクトリの削除とownerの停止を行う。


### CGP工程1：caller分解と履歴row内の重複解析削減（§9.102）

- API・直接caller・owner・reader phase別のreadCommitted観測を追加。RPC spanと件数を照合し、並行RPCの出自を分離する。完了例238回はすべて別RPCで、同一RPC内の二重呼出しは0。
- 独立したfresh検証を省略せず、StageStoreのimage比較で重複するcanonical decodeをrowごとに3→2回へ削減。異内容・非canonical image拒否と、controlled-clockで238回・verified完了を維持する回帰を追加。
- 同じ修正済みobserverのnative前後比較を各3 bootstrapで再実施。前後とも初回3/3成功・2回目0/3成功。初回の観測時間は変更後の方が短いが因果的速度改善は未実証。失敗は期限拒否・公開0で、途中のcall件数の大小を削減率としない。
- 工程1の調査と限定最適化を実施したが、fresh readCommittedの回数削減は未達。call graph変更の設計、page再利用・incremental検証と継続計測が残る。CGP成立扱いにせずCG0／CG3は保留、原本読取省略0。

§9.102レビュー修正：

- eventId連番・eventCount・owner counterとRPC側historyEventIdsの完全一致を検証。総件数を変えない重複／欠落、再採番・別RPCへの付替え、manifest欠落を拒否する。
- source閉包は前後キーの和集合で比較し、追加／削除／observer変更を拒否。StageStoreは両方に存在する内容変更だけを許可する。
- 修正後の同じobserverでnative前後を再実行し、比較と検証記録を更新。旧rawはpre-reviewとしてそのまま保存し、IDを補って現在のcheckerを通すことはしない。CGP成立・速度承認にはしない。


### CGPのcall graph統合設計（§9.103、実装前）

- 候補Aは同一callのimmutableな署名／parse事実をopaque handleで共有する限定実証。現認可・deadline・IO前後のfresh検証は別に残し、238回の削減とはしない。
- 候補Bは同一snapshotのdataを単一fresh bundle取得から切り出すReadSourceRanges。1〜4range・合計4096 Bを候補とし、現行reply／frame上限をexact wireで検査。inventory／descriptor、issuer構築、use／ACKは対象外。
- 各batchのpre／post live確認、ownerごとのfresh保存検証、readerとbrokerの独立source pass、handoff・use・ACK・finishを維持。別RPC／batch・await・別ownerへlive成功を持ち越さない。
- 取消しの粒度は明記した。preで拒否した場合は取得0、pre後の取消しは既入場取得の可能性を記録してpostで応答0。remote取消しACK以後の瞬時全物理IO停止を保証するprofileは、別の排他／drain実証までunsupported。
- CGI01〜CGI32の未実装回帰条件とCGP-I0〜I4、S_refのbridgeと共通P_exp内のS*／A*／B*／AB*の比較計画を追加。kind別実計数・source閉包・元deadline・初期履歴深さを揃え、rawと失敗を残す。
- source要求削減deltaを実証できた場合だけ238−5×deltaで件数を照合する。時間短縮や8回連続成立の保証ではない。次はCGP-H0（§9.103レビュー修正を参照）。CG0／CG3は保留。


§9.103レビュー修正：

- Kは認証済み論理identity／API／operationId等、Dは全range・byte budget等のsemantic payloadへ責任分離。boundedなR[K]でD・元deadline／counterを保持し、同K別Dは追加予約／source取得0。現SessionBootQuotaだけでは新契約を満たさないことを明記した。
- CGI17にrange／budget等を変えた同ID、exact retry、reconnect・unknown・late retry、slot満杯／別bootを追加。Kへのpayload混入・予約evictionによる再受理を禁止。
- 旧S_refは参照／bridgeに分離し、primaryは同一binary・共通P_expでS*／A*／B*／AB*を比較。schema／algorithm／mode manifestの意図した差と固定policy／上限を対応表化した。
- CGI28に正規mode tupleの受理と、profile／schema取り違え・追加権限・producer policy／上限の変更の拒否を追加。bridge未成立ならlegacyに対する改善は未実証とする。
- 設計のみ。runtime contract／回帰条件・native比較は未実行、CG0／CG3の保留を維持。


§9.103 intent guard適用範囲のレビュー修正：

- 共通G_expのintent guardをprimary全modeのdata／inventory／serving descriptor・namespace観測へ両端で適用。v1 wireのK／Dは書き換えず、内部K_guard／D_guardと区別する。
- 同じper-operation slot／deadline／retention規則を固定し、新K+1・exact/conflict等+0とtransport消費を分離。実要求数が異なるmode間でread全体のentry総数を同じとは仮定しない。
- bridgeの「全拒否不変」を取り消し、同ID別payload／late retry／容量拒否等の意図した強化を別cohortと費用で測定。legacy guard counterはN/A。primary guard-offやmode別の上限緩和は不採用。
- CGI17／CGI28をmode別の両端拒否・slot消費・guard policy比較へ更新。新RPCが増える場合はS*の実counterを再基準化。設計のみでruntime／native採用は未成立。


§9.103 工程順序と容量のレビュー修正：

- CGP-H0を先頭に追加。§9.102のrawでは1回目→2回目でReadSealedSourceのspan平均が約47ms→約81msへ増え、delta=10の削減は約470〜810msの概算にとどまる。read順序ごとの増大を分解し、候補Bの上限と比較してからCGP-I1以降の順序を決める。期限延長で成功扱いにしない。
- R[K]のslot分割と枠数をCGP-I0の決定事項にした。全peer共有の256枠ではS*が8 read分の約296件を確保できず、B*だけ通過して比較が歪むため、枠不足の拒否は速度比較から分離する。回収なしの運用上の制約もprofileに明記する。
- 未割当だったCGI21・26・27・29〜32をCGP-I3／I4へ割り当てた。
- 検証記録のchecksは作成時の手動確認であり再実行手段がないことを明記し、基準ハッシュが`eb2f257`時点の値であることを記録した。設計のみ。runtime／native未実行、CG0／CG3は保留。

§9.102後の全体テスト修正（`72c8abe`）：

- `eb2f257`で失敗していたc3b2〜c3b5の照合テスト4件を、旧ハッシュを残す既存の作法で修正。c3b5の観測は再測定していない。
- history検査を1実装へ集約し条件ごとの回帰を追加。記録項目は再生成で保持する。全体suiteは失敗0、修正前に出た名前不明の失敗3件は原因不明。初回readの成否は実行ごとに変わり、load average平均値だけでは説明できない。


§9.104 CGP-I0 fixture contract：

- strict schema／API認可／共通intent guard／mode manifest／range planner／exact signed wire見積りとCGI01〜06・17・23・28の静的回帰を追加。
- owner共有512 retained slotsを全primaryで固定。容量拒否は比較から分離する。模擬context・固定wire layoutの限定検証であり、本番／native採用0。
- 次はCGP-H0の履歴増大分解と順序判断。I1のopaque facts＋live gate接続、I2の単一fresh取得・pre/post・実session wire、I3／I4のnative比較は未実施。CG0／CG3保留。


§9.104レビュー修正：現在のsession期限をretry／完了時にも適用し、元期限・予算を保持する。完全なstrict response（snapshot／inventoryDigest／transferIdを含む）でwire見積り・packing・署名／context照合を行い、再署名後の交換・欠落も拒否する。追加40件を含む68件の限定回帰を確認。本番／native採用0、CGP-H0以降の残課題は継続。

§9.104再レビュー修正：session終了後もunknown／ended／retireを記録できるようにし、切断後のexact retryを復旧。range commandは検証済みinventoryから再計画したplanのhandleがある場合だけ認可し、全replyとentry digestの照合後にだけ返す。37は実測値だったため、workload上限を9 entry・41,460 Bに固定し、算出値43×8=344件が512枠以内であることをbootstrapで検査する。主要な検査62か所の除去で61か所を検出（残る1か所は別検査で同結果）。本番／native採用0、次はCGP-H0、CG0／CG3保留。


### CGP-H0：履歴深さ別のfresh再生費用と順序判断（§9.105）

- 専用fixtureで3 bootstrap×5 processの実時間計測。5秒lease／500ms margin維持、初回3/3完了・2回目0/3（期限拒否、公開0）。本番source・既存CGP observerは変更しない。
- read順／owner／call別に行数・論理record bytes・IO返却bytesとexclusive phaseを記録。固定深さ3回の診断は論理状態を進めず、checkpoint再同期も維持する。読取前後の診断をread成功に加算しない。
- scalar data 16→理想batch下限11／pass、2 passで最大10要求の楽観的削減は約0.58〜0.60秒。完了状態の深さ0→1の再生work増加は中央値で約1.67〜1.78秒で、全3 bootstrapが上回る。拒否後の深さは進行量が揃わないので判定に使わない。実latency差や因果的速度改善ではない。
- 次はCGP-S0：Anchor／registryの列挙・読取・decodeを中心に、page再利用／incremental検証の成立条件と限定実証を先行。fresh認可／取消し／期限／保存完了・checkpoint同期を維持し、成立後にI1〜I4の順序を再判断する。I0は完了、I1〜I4・実batch・独立SGA・8 read成立は残る。CG0／CG3保留、原本読取省略0。
- レビュー修正：深さ2の表、判定条件（全組一致・中央値・未決定）、閉包漏れ2 file、チェッカー負例（42か所中15→41か所検出）、`--check`の照合を直し、再計測した。


### CGP-S0：保存履歴再利用の安全契約（§9.106、設計のみ）

- S0-F（full）、M（fresh bytesに対するpure parse／stage-prefix再利用）、D（call内の既存checkpoint再同期batch）、P（typed page表現）、X（独立provider付き跨call IO省略）を分離。mutable local IOでstat／flock／同digestだけを根拠にIOを省略しない。
- owner／boot／root pair／key／schema／policy／generationに束縛したprivate handle、ordered prefixと集約状態、append／改変／rollback／再起動／失敗の状態遷移を具体化。現在の認可・pin・期限・取消し・保存／ACK条件はcache対象外。
- checkpointは全chain認証・genesisを含むexact再読取・file＋directory同期を維持。Dは新規作成や修復を許さず、各batch前後と完了前の完全inventory検査を要求。再fsync省略は別契約まで不可。
- Anchorが保持するwhole signed registry wireとpage imageの差を明記し、compact recordは別schema／profile／両owner・verifier対応を要求。page化だけでsuffix IOやGC／世代選択を承認しない。
- SR01〜SR42を定義。runtime／native回帰は全て未実施。次はCGP-S0aのstrict fixture・fresh bytes／pure prefixから限定実証し、S0b列挙／同期、S0c page、S0d比較へ進む。I1〜I4の順序は実証後に再判断。CG0／CG3保留、原本読取省略0。
- レビュー修正：cacheによるrollback検出は保証ではないと明記。S0-M／Dの理想上限は全bootstrapで2 readまで（8 read目7.7〜8.4秒、算術で実測ではない）なので、8 readを進行条件にせず、停止条件を追加。whole wireのAnchor対照は候補上限に深さ2〜5までしか収まらない。S0-Dは復旧完了後の通常readに限定。


### CGP-S0a：fresh IO＋pure stage-prefixの限定実証（§9.107）

- test-only strict profile・固定F/M slot catalog、private context／own-call、exact row bytes照合・suffix stage再生を実装。元期限・attempt・current callback、全journal認証／原本IO／checkpoint同期を維持。production sourceは変更なし。
- production StageStoreと実Anchor／registry historyの同値、改変／巻戻し／root交換・偽造handle・同期障害／復旧・期限／最終取消し、prefix exact照合とsuffix stage検証の負例等の78回帰を追加。SR01〜18・SR38の限定部分であり、全SR条件成立とはしない。
- 3 cohort×3固定深さ×2 role、6 pair交互順の実disk比較を実施。全108 pairでreference digest・全IO／同期counterが一致、stageの再解析のみ削減。全深さで中央値は改善したが、pair単位の逆転は残る。H0の呼出し回数へ換算したAnchor＋registryの増加は深さごとに約1.65〜1.71秒→約1.24〜1.28秒（削減22〜27%、算術）で、理想上限（616〜706 ms）に届かない。単一process・warm比較で、本番speedup／8 graph read成立は未実証。
- 次はS0b：checkpointの既存file再同期batchによる重複inventory列挙削減のfixture。generic parse／MAC cache・実session接続／peak RSS・S0c page・S0d 5owner比較・S0x独立providerも残る。CG0／CG3保留、原本読取省略0。
- レビュー修正：openへstoreを含む全file再同期・tail拒否・stage再生を追加。journal完了後の期限・取消しは要求単位の拒否に変更（journal内はjournal自身のfail-stopのまま）。中核検査の負例を追加し再計測。`designSection`の空行の欠陥で§9.106の照合testが失敗していたのを修正。


### CGP-S0b：checkpoint既存file再同期batch（§9.108）
- [x] test-only F／D fixture。全bytes認証・再読取、各file／directory同期を維持し、batch前後・最終inventoryと同FD／名前対応を検査する。既存file専用で修復fallbackなし。
- [x] 84 unit・44証拠checker回帰と保存証拠の再照合。容量・列挙上限・改変・同期故障・期限／取消し・再open・pending linkの復旧、forkと本番の一致を確認。
- [x] 実disk、3cohort × 5file数 × 6pair＝90pair比較と本番対照90読取。64fileは本番約69 ms、F約75 ms、D約25 ms。本番と比べると1・8 fileではDが遅く、32 file以上で速い。全bytes・同期の計数は両mode同じ。
- [x] 規則3の判定：M＋Dの8 read目は約6.5秒（算術）で使える時間1.4〜1.9秒を超え、最大予算内は2 readまで。S0-M／S0-Dは製品統合しない。
- 次はS0c compact recordとCGP-I1の呼出し回数削減の見積り。scratch／RSS、S0d 5owner比較、S0x独立storageも残る。CG0／CG3保留、原本読取省略0。単独checkpoint fixtureの結果を本番speedupへ換算しない。


### CGP-S0c：compact record・typed pageの限定試作（§9.109）
- [x] test-only F／W／P。新しいcompact署名／profileと旧registry・Anchor reader拒否、typed root／directory／page／liveness、全保持catalogと参照閉包を実装。
- [x] materializer 53件＋個別検査87件＋disk境界18件。64 KiB／16 row／bucket・8 MiB／4,096 objects、過去版保持・未記録object、再hash／再署名後の構造不正を検査。
- [x] 実owner履歴を使う3cohort×7深さ（2〜42record）×12roundでF／W／P 612読取、本番対照252読取。owner copy込みのPは本番image比で2recordが124%、10recordが84〜88%、42recordが45〜46%。F・Wは34recordで容量超過。Pは元wireと`transaction`を持たず同じ内容の比較ではない。本番での速度改善は未成立。
- typed delta／incremental materializer・元wireと`transaction`の保持・本番owner／新CAS接続、S0d 5owner比較、cold／churn／復旧・RSS、S0x独立storageも残る。単独表現fixtureから8read成立を主張しない。CG0／CG3保留、原本読取省略0。

§9.109レビュー修正：parentをcatalogの直前同owner refへ束縛し、W／P・両ownerの4負例を追加。disk容量検査をIO前へ移し、件数・合計bytes・role別上限の8負例で列挙／読取0を確認。owner copy集計は検証済みround由来とし、warm-up／round間計数の不一致5件を拒否する。216読取を再計測し、速度改善未成立・CG0／CG3保留・原本読取省略0を維持する。

§9.109 2回目のレビュー修正：元record検証を本番verifierへ揃え、比較基準をFから本番imageへ変更。本番対照を加えて42recordまで再計測。検査を外す確認は130か所中113か所を検出し、残る17か所を分類。CG0／CG3保留、原本読取省略0を維持する。


### CGP-I1：同一callの検証事実共有・削減効果（§9.110）
- [x] test-only SessionRuntime fork＋opaque VerifiedRequestFacts。exact wire／call／peer／server／policyを束縛し、deep-frozen envelopeだけを共有する。owner payload validation・current gate・pre／post・元guard期限を維持。
- [x] 112回帰。偽造／別call／policy変更／Buffer alias、10境界の取消し・期限、remote取消し、unknown／definite retry、元期限・予算・slot、並行入場、broker origin・3種source kindを確認。
- [x] 実署名付きin-process sessionで3cohort×2role×3identifier×6pair＝108pair／216要求。対象envelope parse 3→1、署名2→1。factsの生成・再照合費用を分離した。fork内ではA*が短いが、1要求あたり1 ms未満で本番の速度改善は未成立。
- [x] H0 traceの34対象要求へ算術換算し、parse68回・署名34回削減、readCommitted削減0を記録。238回を実行／削減したとはしない。
- 次はI2の取得batch候補の効果見積り。本番factory／SourceOwner接続・追加API coverage・実pin／保存／外側session故障、I3／I4・S0d 5owner・S0x／SGA・RSSは残る。I1本番採用・CG0／CG3保留、原本読取省略0。

§9.110レビュー修正：guardの元期限をsession待機にも適用し、両modeの待機終了・遅配拒否2件を追加。独立承認manifest全体との一致で、digest更新後も未承認値・予算不足等9件を拒否。追加11件のRED→GREEN、108pair／216要求の再計測・表・検証記録を更新。速度改善・本番採用・8 readは未成立。

§9.110レビュー修正2：本番にないregistry全体digest（gate計20回＋facts 2回）がwallの約2/3とfacts費用の約9割を占めていたため、構築時のdeep-freezeと同一性照合へ置換した。再計測で18条件中18条件がA*優位、換算は1 readあたり約3〜11 ms。不採用の理由を効果の小ささへ改めた。client元期限台帳は重複のため削除し、元期限・偽造peer・registry差替え・verifier差分・checkerの回帰を追加した。本番採用・8 read・CG0／CG3は未成立のまま。

### CGP-I2：取得batch化・単一fresh取得（§9.111）
- [x] test-only S*／B*。元の署名・現認可・元期限・共通guardを維持し、単一snapshotからpartsを生成。独立pre／post、実session用lineage／live=false応答、実wire／work予算を検証。本番APIは未登録。
- [x] runtime106件＋fork差分5件＋checker33件。10境界の取消し／期限／policy、遅配、signed part改変、source改変／再取得、予算・上限、repin後の未承認manifest、event閉包等を検証。
- [x] 216 pair／432転送。H0同サイズで片経路16→11要求、両経路34→24の算術。dispatchは短縮したがplanner費用を含む総時間は全36条件で悪化し、速度改善未成立。繰返しfixtureの期限拒否は別診断で保持（確定sourceでは再現せず、原因は未確定）。
- 次はplannerの費用分解と改善余地の見積り。本番SourceOwner／実storage接続・I1併用・I3／I4／S0d 5process・S0x／SGA・cold／churn／復旧・RSSは残る。限定fixtureから8 readを主張せず、CG0／CG3保留・原本読取省略0・実readCommitted削減0を維持。

§9.111レビュー修正：全entry再構成・結果digest作成後の最終認可／policy／元期限gateを追加。両modeの最終期限到達・取消し・policy変更6件と、計画／転送の過小計上・未計上wall5件をRED→GREENで確認。共有境界時刻と単一終了時刻で総時間を完全分割し、計時誤差0.01 msで双方向照合する。修正sourceで216 pair／432転送を再計測して検証記録を更新。

§9.111レビュー修正2：`--check`の照合先を計測source閉包の`src/test/`全体へ広げ、I0 plannerの変更も検出する。snapshot隔離・全entry検査・拒否時のguard状態・S*／B*応答改ざん・checker条件の回帰を追加し、重複した元期限台帳を削除した。診断の原因を未確定へ改め、`sealPlan`による計画2回実行、serverのplan共有、256 operation上限を明記した。修正sourceで216 pair／432転送を再計測。

### CGP-I2P：planner費用分解・最大サイズ優先（§9.112）
- [x] historical I0／I2を維持したtest-only fork。最大lengthをexact wireへ先に通し、失敗時は元のbinaryへfallback。2回の計画とseal全体一致、全認可・元期限・完全性・予算を維持。
- [x] 80専用回帰＋現I2 runtime150件の再適用、fork4件・checker43件。plan／実signed wireとworkの一致、計画中の取消し・期限、fallback・cap・seal改変、snapshot／再試行／最終gate等を確認。
- [x] 216組・864転送の4構成比較。未変更B-refで計測器bridgeも分離。probeは2回合計small170→24、H0サイズ444→60、大entry310→54。計画込みでbinaryより全36条件で短縮。scalarより速いのはsmall12条件のみで、大きい24条件ではまだ遅い。
- 次はprovider側の独立計画再現とSourceOwner／実storage接続の契約・費用見積り。共有planのfixtureから本番効果を主張しない。I1併用・5process・S0x／SGA・復旧／RSSは残り、本番採用・継続8 read・CG0／CG3は保留。原本省略・実readCommitted削減0。

§9.112レビュー修正：planごとに候補commandDigestの重複を拒否。総件数・連番・cost／RPC counterを維持した重複／欠落8件と、sealによる同候補の独立再計算を許可する正常系1件を追加。checker43件に更新し、source閉包の整合性を保つ216組／864転送の再計測と検証記録の更新を行った。

§9.112レビュー修正2：元I0との一致を計画値全体（wireBytes・workUnitsを含む）へ広げ、最終全command検査の件数・順序・digestを固定。probe内の非wire失敗をfallbackへ変換しない4件と、計画同値・cost partition境界のchecker負例3件を追加（専用84・checker46）。mutationは13／21→19／21。fork・計測source閉包は不変のため再計測なし。rawの無インデント保存は次の実験から。

### CGP-provider：独立計画再現・実storage接続契約（§9.113、設計のみ）
- [x] provider自身のreceipt／seal／fresh inventoryから、各batchで全計画を独立再現する方式を定義。共有client map・handle・cross-RPC cacheを禁止し、単一fresh load・pre/post・最終gateを維持する。
- [x] 再現用seed／batch位置を含むv3 strict wire、非循環planCore、K／D_wire／D_guardとsemantic spec／実装variantの責任分離を具体化。実sessionの共通codec-bound layout、転送前の全体予算・attempt／recovery会計を定義。
- [x] SourceOwner／SourceBindingPort／OwnedStoreの不足点を明示し、ReadScopeとscoped local/remote storage adapterのIO前後gate・no-read拒否・元期限伝達・失効／fail-stopを設計。provider各RPCの再計画費用を含む比較・計測器bridgeも定義。
- [ ] CPR-A〜Dを順に実装・実証。回帰CPR01〜CPR48は全て未実施。まずstrict schema／spec／実codecのwire-bound contractから進める。実storage・独立UID・5process・継続8 read・本番採用・CG0／CG3は未成立。原本省略・実readCommitted削減0。

§9.113設計レビュー修正：IO前の限定AdmissionLease／ReadScopeと、計画照合後のDispatchPermitへ型・状態を分離。昇格の全条件・原子的遷移、同じrow／K/D／元期限／attempt／spentの保持、未昇格・計画不一致・unknown／retiredとretryの扱いを具体化し、CPR08／14／30／34を更新。I2Pはclient2／provider0、新方式はclient2／provider N（合計2＋N）と計画回数を訂正。設計のみ、実装・実接続・48条件の回帰は未実施。

§9.113設計レビュー修正2：provider毎batch再現の着手前停止判定（I2P summaryから再計算、H0で1回の計画が上限の10.58〜11.65倍）を追加し、CPR-Aにlayout上界の算術packing、CPR-Bに実測の採用見送り条件を追加。T_Bへclientのseal／inventory取得を加え、inventory 4096 Bを新規制約と明記。client seal再計画の理由を追記し、設計記録の照合テストを追加。設計のみ。


### CPR-A：v3静的contract・算術packing（§9.114）
- [x] test-only strict v3 command/result・非循環planCore・K/D、限定入場から許可への昇格、元期限・attempt・spent／残予算保持を実装。
- [x] 実codecの算術上界によるpacking。探索中のcommand／認可見積り／owner wire／frame生成0、最終N commandの全codec検査、低速referenceとの比較、16構成の署名付き静的記録を追加。
- [ ] CPR-Bの実session・独立authority／provider接続と再計画込み性能比較。続いてCPR-CのSourceOwner／実storage、CPR-Dの独立UID／5process。CPR01〜48全体・本番採用・継続8 read・CG0／CG3は未成立。原本省略・実readCommitted削減0。


§9.114レビュー修正：取得・計画・完了の保守work計222515をIO前に要求し、取得前／計画前も残量を確認する。計画156978は実行前に消費し、例外・不一致・元期限切れでも保持。同attemptの再計画を禁止し、新callのexact retryでもspentを保持する。専用11件・記録改変2件を追加し、16構成の静的記録を再生成。実session・実storage・本番採用は引き続き未成立。

§9.114レビュー修正2：finishはpost・署名の前に返信予約と完了1を再検査し、post失敗・残量不足では確定拒否で終了する。取得中の失敗も計画失敗と同じく消費を保持して確定拒否で終了し、exact retryを許可する（`admitted`のまま止まってcall終了後に`unknown`へ固定される問題を修正）。専用5件を追加し、記録を再生成。


### CPR-B：独立authority・実署名session・比較（§9.115）
- [x] clientの署名RPC inventory／2回の計画・private mapと、providerの模擬Saved／fresh snapshot／各batch独立計画を分離。v3対応の限定SessionRuntime forkを追加し、実call・認可・元期限・pre/post・K/D・予算保持を検証。
- [x] 96組／192 primary転送＋96 plan-event bridge・32 warm-upを保存。descriptor／inventory取得・seal・provider計画・全entry再構成込みの総時間を比較。default／smallは限定判定通過、H0同サイズ・大entryは計画費用が許容額を超えCPR-C見送り。
- [ ] 採用範囲の限定、または毎batch計画費用をさらに削減する契約・比較を検討。効果不足のworkloadへCPR-Cを先行接続しない。CPR-C実storage、CPR-D隔離／復旧・5process、本番採用・8 read・CG0／CG3は未成立。原本省略・実readCommitted削減0。


§9.115レビュー修正：descriptor／inventory／scalar本文を成功確定前に検査し、検査後も元期限・認可を確認。最終digestとwire集計を最終gate・計時内へ移し、境界timestampとfinalizationを保存して過小計上を拒否。runtime20件・checker4件を追加し、96 pair／288転送＋32 warm-upを修正sourceで再実行。default／smallは限定判定通過、H0／大entryのCPR-C見送りを維持。本番採用・実storage・隔離の成立は主張しない。

§9.115レビュー修正2：H0同サイズ・大entryでBが遅かったのは48 pair中47（「すべて」を訂正。残る1件はSの外れ値）。許容額の判定は各pairで総時間比較と同値であること、provider計画時間に試行ごとの認可gateを含むことを追記。表と本文をsummaryから再計算して照合するテストを追加。計測は変更なし。

実時間process診断の分離：Source／Authority／Consumerのprocessテストは、固定の5秒leaseとホスト負荷に左右される（並列5本では15回すべてが準備段階の`grant_revoked`で失敗、CIのNode 26で`service_unavailable`）。`OSV_REALTIME_PROCESS=1`のときだけ実行し、CIは専用ジョブ（Node 26）で単独実行する。成功の契約は偽の時計のテストが担う。`npm publish`の事前テストからは外れる。偽の時計で動く`gradleOwnedCurrentDisk.test.ts`は単独でも1件5〜10秒かかり、負荷のある全件実行で既定の30秒を超えたため、このファイルだけ上限を120秒にした（時間は結果に影響しない）。


### CPR-BP：毎batch計画費用の分解・削減（§9.116）
- [x] test-onlyのreference／最大サイズ優先／完全検査1回／combinedを実装。plan値・全command・boundの一致、caller／command間のコピー独立性、最終全codec検査と元期限・認可・予約・fresh取得を維持。
- [x] 7分類のexclusive／inclusive・other、actor／call／request／batchを記録。288 primary＋96元CPR-B bridge＋64診断対照＋64 warm-upを実行し、観測付き費用と未観測primaryの総時間を分離。
- [x] combinedは更新後の今回11条件でreferenceより中央値を短縮したが、H0／大entryはscalarと計画許容額の条件を満たさずCPR-C見送りを維持。
- [ ] 残る全command codec・canonical処理の費用削減、または限定採用の適用／拒否条件を設計。CPR-C実storage、CPR-D独立UID／5process、本番採用・継続8 read・CG0／CG3は未成立。原本省略・実readCommitted削減0。


§9.116レビュー修正：provider traceを対応owner plan時間へ、client initial／sealを各外側実測へ照合し、partitionを保った過大計上を拒否。3 actorの拒否3件・0.01 ms許容幅の境界3件を追加。現在sourceで全512転送を再実行し、変動を含む今回の性能表・summaryを更新。H0／大entryのCPR-C見送りを維持する。

§9.116.5の診断例の補足：H0同サイズ・readerの例は件数削減を示すもので、provider trace wallはreference 80.7→combined 152.6 msと長い。8組中combinedが長いのはこの組とdefault・readerの2組だけと明記し、文書照合テストで値と組を記録から導くようにした。測定・判定は変更なし。


### CWC：owner／auth codec・canonical処理の削減契約（§9.117、設計のみ）
- [x] 閉じたfamilyのPlanLayout／canonical fact、actor別のprivate root・client seal child寿命、共有／非共有境界、実codec bytes照合、読取前承認・current gate・予算／失効を具体化。
- [x] CWC-A〜Dの出口、CWC01〜40の回帰条件、scalar／共通reference／composed＋BP bridge・oracle対照、計画込み総時間とpaired許容額の責任を設計。
- [x] CWC-Aのstrict helper／fact contractをfixtureへ実装（§9.118）。actor／call／domain・private copy・child移管・current gate・寿命／失効・事前予算と非返還をCWA01〜41で検証。同一scopeのroot発行前再入を拒否し、initial証拠と同じ親readへ結んだseal一致確認をchild移管の条件へ追加。模擬owner scopeのみ、全N reference codecを維持し、composition／閉じたfamily proof・実session接続・性能改善は未成立。
- [x] CWC-B：閉じたASCII family tree／length proof、14 canonical domainの独立oracle照合・実署名・境界／改変拒否を限定実証（§9.119）。6 workload（CPR-BPのh0Sizes・singleLargeを含む）×2 role×通常／最大IDの全24 sample・全commandを照合し、既存実sessionへの診断observerも対照。全N oracleを維持し、optimized primary・性能改善・adapter接続は未成立。
- [x] CWC-C：独立pin／署名の実装source承認契約、実AuthenticatedSessionCall／private ReadScope／fresh SourceSnapshotへA root／fact・B proofを接続（§9.120）。1 MiB以内の論理共存予約と既存構造work156978の一回限りの前払いticketを検証し、最終owner/auth wire生成をproofへ置換。12 sampleの実session正当性／予約比較・回帰を記録。本番・native配備／外部承認service・RSS／速度改善は未成立。
- [x] CWC-D：共通source承認／current gate・memory条件のscalar／reference／composedで、計画込み総時間と観測費用・完了率を比較するハーネスを追加（§9.121）。旧CPR-BPは別bridge、warm-upと観測あり／なしを分離し、paired差と計画許容額・失敗を含む完了率を保存する。
- [ ] CWC-Dの採用条件を満たすまでCPR-Cへ進まない。次はcomposedのroot／fact／gate・診断記録を含む追加費用を分解し、共有可能な事実と再確認必須の境界を維持した削減余地を検討する。本番採用・実storage・隔離・8 read・CG0／CG3の保留を維持する。

§9.118 2回目のレビュー修正：CWC-Aのprivate bytesと返却コピーが`Buffer.from`の共有poolに載り、返却コピーの`.buffer`全体の書換えがprivate factへ波及していた。`Buffer.alloc`の専用領域へ変更し、CWA07・CWA18でArrayBuffer全体の書換えを検査する。

§9.119レビュー修正：CWC-B matrixの`h0`がCPR-BPの`h0Sizes`と別workloadだったため`mid-2048`へ改名し、CPR-BPの`h0Sizes`・`singleLarge`を追加（16→24 sample）。計画中の生成数4項目が常に0の固定値だったため削除し、`planProof`中のowner／frames／exact／result／layout／ownedSha256呼出しをspyで実測（全0）、oracle側owner 2N回を陽性対照とした。

§9.120 2回目のレビュー修正：CWC-C05・C23が通常の`npm test`で実時間の4500 ms期限に依存していたため固定clockへ変更。記録runner（`CWC_C_EVIDENCE_PATH`）と`OSV_REALTIME_PROCESS=1`のときだけ実clockにし、記録は各sampleの`clock: real`を必須とする。

§9.121 CWC-D実測：384転送（warm-up 96、測定288＝primary216＋旧BP bridge72）が全て4500 ms以内に完了。quiet総時間中央値はscalar 27.4〜72.5 ms、composed 52.7〜547.6 ms（CLB-1接続後のsourceで再測定）。composedはscalarの1.9〜8.5倍、旧BP bridgeの2.5〜4.7倍。全12 workload／roleで採用をdeferし、CPR-Cの見送りを維持した。観測あり／なしの差とpaired差・計画許容額はrawと同じ検証記録に保存し、負の観測差も除去しない。referenceからの短縮をscalar優位へ読み替えない。

§9.121レビュー修正：時間内訳をtimestamp差へ照合し、initial＋seal／provider計画をsetup／転送前半の実測区間に制限した。duration・timestamp・trace時間の非有限値・負値を拒否するCWD12〜15を追加（修正前の失敗を確認）。384転送を再実行し全て期限内に完了、全12条件の採用見送りを維持。差分指標の負値は保持し、CPR-C／本番採用の保留を解除しない。

§9.121 2回目のレビュー修正：CWD01の実clock依存を記録runner／`OSV_REALTIME_PROCESS=1`だけに限定し、検証テストを単独実行可能にした。runnerの本節hashを後続節に依存しない切り出しへ変更。9.121.1に12条件の結果表を追加し、runnerがsummaryから照合する。

### CWC-DP：composedの費用分解と診断省略の限定対照（§9.122）
- [x] 実関数へcall-throughするtest専用observerでroot／fact、JSコピー入口、公開gate、canonical-hash export、診断getter、B proofを分解。exclusive合計＋otherと外側Tを照合し、計数・category閉包と実work rowを再検証する。
- [x] scalar／composed／profiled／codec診断省略／同profiledを6 workload×2 roleで比較。240転送が元期限内に完了、全12条件で診断省略版もscalarに届かずdefer。計測追加費用と設置費用を別保存し、診断省略だけの速度改善は確立しない。
- [ ] 次は不変なprivate contextの再hashと、現在callback入力の検査を区別する契約・call-site帰属を具体化する。constructor時の完全照合、所有権・actor／root／call束縛とmutation／reentry拒否を先に定義し、現在認可・取消し・元期限・callback／IO／署名前後のgateは維持する。共有・cacheは今回未実装。

費用の最大categoryは全12条件でcanonical-hash。categoryは計測器管理費用が親exclusive／otherへ入る観測値であり、純粋CPUや削減可能額ではない。native／実storage・RSS・本番採用・継続8 read・CG0／CG3の保留を維持する。

CWC-DP計測値（各条件3 roundの中央値範囲、ms、CLB-1接続後のsourceで再測定）：root-fact 6.1〜86.3、copy 4.0〜65.7、gate 3.6〜68.5、canonical-hash 28.7〜413.5、診断getter 0.022〜0.094。計測追加費用のpaired差は4.0〜87.1 ms、診断省略のpaired差は-20.5〜10.1 msと変動し、速度改善を確立しない。元の認可・取消し・元期限・完全性確認は維持した。

§9.122レビュー修正：非再入の診断getterとBuffer操作のinclusive合計をobserver wall以内に制限し、件数・exclusive・partitionを維持した過大計上6件と境界値をCDP13／14で検証。修正前の失敗を確認し、240転送の実時間比較を再実行。全転送が期限内に完了し、全12条件deferを維持した。

§9.122 2回目のレビュー修正：runnerの本節hashを後続節に依存しない切り出しへ変更。9.122.1に12条件の結果表を追加し、runnerがsummaryから照合する。DESIGN_TODOの§9.121の倍率を再測定値（1.8〜8.6倍・2.5〜4.9倍）へ更新。

### CWC-Sites：private context／current／command・内容検証の位置別費用（§9.123）
- [x] 元のhelperを変更しないcall-through observerでJSON・schema・copy・source入口の呼出し位置を採取。実行版class／hash／本文とcolumnを照合し、current.hashとprivate-context.rehashを分離。source承認・認可・取消し・元期限・完全性は元の処理を実行する。
- [x] 6 workload×2 role×scalar／composed／位置計測の144転送が元期限内に完了。位置取得の追加費用はpaired T差で別保存し、費用から差し引いた仮想値では採用しない。CST01〜08で位置・実行版・件数・partition・境界拒否を検証。
- [ ] 次はprivateな自己contextのfingerprintをconstructor時に固定できる条件と、現在callback入力を毎回検査する条件を具体化する。今回cacheやhash省略は未実装。位置計測の追加費用が大きいため、観測値をそのまま改善見積りに使わない。

位置別計測ではprivate/contextの2 hash呼出し数が各126〜1316回／転送で一致した。純粋CPU費用や全面的なcaller解析ではなく、10 frameと列挙したexport入口に限定する。既存CWC-DPの採用見送りを維持する。本番・実storage・隔離・RSS・継続8 read・CPR-C／CG0／CG3の保留は維持する。

§9.123レビュー修正：CST09／10の修正前の失敗を確認し、直近祖先＋呼出しごとの分類tagで共通helperの吸収を解消。constructor/preflightの実行位置とclass内の相対行でowner行を拘束した。CST11でcurrentコピー数とowner検査数、CST12でgate配下の分類境界を検証。12テスト・144転送の実時間比較を再実行し、全転送が期限内に完了した。旧分類値は置き換え、cache未実装・本番採用保留を維持する。
修正後の各条件中央値の範囲（ms、計測負荷を含む観測値、CLB-1接続後のsourceで再測定）：private-context.rehash 3.7〜38.6、current.hash 3.6〜39.3、current.input 16.5〜194.4、command.validation 11.2〜195.0、content.validation 2.0〜8.6、gate.validation 68.1〜1185.0。祖先による分類漏れを修正した値であり、過去の分類値と性能改善として比較しない。

§9.123 2回目のレビュー修正：位置計測の負担（1回4.21〜4.86 µs）が呼出し数に比例してgroupへ入るため、較正値と推定計測負担を記録し、9.123.1に表と解釈を追加（gate.validationはexclusiveの45〜50%、private-context.rehashは14〜17%が推定負担。推定は実測増加の44〜50%しか説明しない下限）。記録をインデントなし・class証跡1回保持にして37 MB→約19 MB。

### CWC-FP：constructor所有contextの固定fingerprint契約（§9.124、設計のみ）
- [x] private copy／完全parse／deep-freeze／F生成と実grant・承認の照合、actor／owner／scope／root／callの束縛、毎回のcurrent取得・copy・schema・hash／live gateを分離。
- [x] grant単位の初期化claim、ownerの再入・generation／terminal状態、callback中のclose／失効・元期限到達、予算と非返還、CFP01〜28とCFP-0〜3の採用gateを具体化。
- [x] CFP10を観測済み不一致・記録済み失効・検査前に変更と復元が完了した未観測の一時変更へ分離。最後のケースの検出は保証せず、全live検査成功時の継続を両比較modeで許容する。履歴検出を要求するadapterは独立した失効記録の証拠なしではunsupported。
- [ ] CFP-0のstrict fixture contractを実装する。§9.125の優先順位変更により接続費用の調査・削減契約を先行する。今回runtime・hash省略・cacheは未実装。grant側hash、command／内容検査、source承認／認可・取消し・元期限の省略は認めない。

### CWC-Gate：接続費用の軽量分解（§9.125）
- [x] CWC-FPの単一自己hash置換より、CWC-Dで旧BPとの大きな差になった接続費用の調査を優先。scope／grant／ledgerから実call検査へ至る増幅経路を整理した。
- [x] stack取得を使わないcall-through observer、件数のみ対照、scalar／composed／旧BP bridgeを比較する再現ハーネスとCWG01〜09を追加。現認可・取消し・元期限・完全性の検査は変更しない。
- [x] 実clockで240転送を再検証し全完了。h0Sizes／singleLargeの実call検査16979／19457回とgate内canonical・wire hash・identityコピーの反復を記録。費用・計測追加費用は診断値として保存し、削減可能額や採用成立へ読み替えない。
- [x] レビュー3件を修正。旧BPのbatch同値性、wrapper入口の独立計数とSHA／clone／permission件数関係、非再入SHAのwall上限・leaf性を検査。CWG10〜12の修正前失敗を確認し、CWG13〜15の共通欠落・witness不備・上限境界も追加。15件の回帰を通したsourceで実時間比較を再実行し240転送が全完了。表・記録を更新し、診断限定・採用保留を維持。
- [x] 接続費用の測定結果に沿って、session所有の不変な実call／wire bindingと毎回のlive検査を分ける削減契約を§9.126へ具体化。実証・採用は別工程。CFP-0・CPR-C／本番・実storage・隔離・8 read・CG0／CG3の保留を維持。

### CWC-LB：session所有bindingとlive検査の分離（§9.126設計、§9.127 CLB-0）
- [x] private Bの捕捉・固定identityの所有権、非公開begin／seal／live／read／release API、owner／scope／実call／generationへの束縛、Draftとterminal状態・session最終読取までの寿命を定義。
- [x] permission／credential／source承認・取消し・元期限を毎回検査し、内部G／S／P frameと外部再入を区別する条件、既存予約・独立profile承認、拒否理由、CLB01〜36・CLB-0〜3の出口を具体化。mutable identity／bytesを固定digestだけで適格化しない。
- [x] レビュー2件を反映。currentPurpose＝issuedPurpose＝binding／projectionの照合を必須化。timeoutはdispatchのfinallyと分離して失効・lookup除去を先行し、private reader排出後のB回収・byte予約解放、後着結果の拒否と未完了dispatchの隔離枠を定義。CLB15／19／20・設計整合性テスト・記録を更新。runtime実装・36回帰の実行は未実施。
- [x] CLB-0の共通fixture contractを実装。私有wire／identity、claim／Draft・scope束縛、予算・再入拒否、purpose照合、timeoutのlookup除去・reader排出・B回収・後着拒否を36回帰で検証。2 mode×2 role×3 APIの12正常例と13証拠を保存し、9件の記録検査を追加。両modeとも完全検証を維持。
- [x] CLB-0のレビュー2件を修正。TypedArrayの実slot・brandと信頼するコピー処理を使い、Bufferのcopy差し替え・SAB／metadata偽装をコピー前に拒否。receiveの共通再入guardを受付済み判定より先に適用。LB033〜036の修正前失敗を確認し、両modeのcallback／alias流出・危険入力の追加copy・外側の発行／公開0と回収を検証。LBR09と保存記録を更新。
- [x] CLB-1：既存CwcCProvider／ReadScope・CWC root／fact／実ledgerへbindingをopt-in接続（§9.128）。追加署名profileと参照閉包を必須にし、ready後のbound-liveだけ追加wire比較hash・固定identityのcopy／projection一致を省略。認可・purpose・取消し・元期限・署名・command／独立計画・source内容検証は維持。正規の内部frameと外部再入を区別し、既存1 MiB・構造work内の共存を検査。28回帰・7記録検査、正常12例・拒否30例を追加。レビュー修正としてsource返却値の正規化中とowner／codecの直接時計callbackにも再入guardを適用し、両modeで内側例外を捕捉しても返信・公開が0となることを確認。
- [x] CLB-2：既存SessionServer／Clientの実handshake・challengeへbindingを接続し、全batch転送・全entry再構成・fresh scope／snapshot／root、取消し・close・応答紛失・元期限・transport最終検証前後の寿命・早期B回収／後着拒否を確認（§9.129）。元の署名付きrefused／unknownと、再構成sourceから実AuthorityOwner・durable provider use／正しいACKへの対照も検証。固定clock・同一process・1 business RPC/channelの限定adapterで、元のscalar source取得の省略、外部storage／native隔離・本番採用は未成立。14回帰・8記録検査、正常6転送・26証拠を保存。レビュー修正として複数commitの区分を保持し、実採用済み更新snapshotを全転送・再構成。実予約履歴・入力サイズ・試行前／捕捉後／drain後の残高を対応付け、両modeで非負値への消費減額・整合するcopy／履歴改変・試行間resetを拒否。
- [x] CLB-3：共通の独立source／binding承認・認可・元期限・1 MiB共存・既存work／wire予算でscalar／full-reference／bound-liveを実時間比較（§9.130）。構築前からcleanup・drain・observer復元後までの総時間、全entry再構成、handshake／capture、quiet／counts／timed、失敗を含む完了率を保存。動的fs読込rootの収録漏れを修正し、16回帰・11記録検査と216試行を再実行。全6条件defer・本番採用見送り。
- [x] CLB-3Pで共通batch経路の費用を分解し、実call検査・wire検証・live gate・公開codec・canonical/hash・copy・planner残余を観測（§9.131）。18回帰（記録runnerでは全実行、通常は実時間比較1件をskip）・12記録検査と216試行を保存。TTL桁数だけのwire差を実署名sessionで再現し、実wire予算を保った比較契約を追加。
- [x] 不変のchallenge／channel／owner検証事実と、毎回必要なlive検査を分離する削減契約を§9.132へ具体化した（設計のみ）。CLB-3時点ではsmallでもbound-liveはscalarより約2.6倍遅く、追加wire／identity検査の省略だけでは不足した。h0／single-largeの4.5秒期限内完了を新たな出口にし、停止までの作業量と毎batchの計画／実call検査を調査する。期限・認可・完全性・予算を緩和せず、期限停止時刻の差を改善量にしない。性能改善・全36条件・CWC-FP・CPR-C／CG0／CG3等の保留を維持。

§9.127レビュー修正：CLB-0の`dispatch`で、期限内に届いた結果が最終検証で拒否された場合まで後着（`late`／`late-reject`）として記録していたため、call終了後に届いた結果だけを後着と数えるよう分離。LB028に回帰を追加（修正前の失敗を確認）。

§9.128レビュー修正：CLB-1で`gradleOwnedCwcC.ts`・`gradleOwnedCwcCProvider.ts`を変更したことで、CWC-A／B／C／D／DP／Sites／Gateの7記録の照合が失敗していた。A／B／Cを再実行、D／DP／Sites／Gateを実時計で再測定し、各表・範囲を更新（判定は不変）。Sitesの分類規則に`#checkGate`を追加し、gate.validationからotherへの7444回の誤分類を解消。

§9.130 CLB-3実時間比較：warm-up込み216試行中120件、実測162試行中90件完了。scalarは54/54、full-reference／bound-liveは各18/54で、大きい2条件の両batch方式は全72件request_expired。smallのquiet総時間はscalar 394.6〜400.7 ms、full-reference 1046.5〜1049.4 ms、bound-live 1035.6〜1053.0 ms。成功条件のtimed−quiet中央値は9.0〜48.2 msで、期限停止条件の差は計測費用推定に使わない。同一process・1 RPC/channelの限定実証であり、外部storage・native隔離・継続8 readの成立は未確認。

§9.130レビュー修正：失敗試行を含め6予算値の必須・非負整数・上限を検査し、構築inclusiveを実際の構築phaseへ制限。再構成／setup／dispatchを対応時刻差へ、client-initial／seal・providerの計画時間を開始／終了区間の合計と包含関係へ照合する。v2記録に改訂し、providerは純粋なplanner CPUではなく既存phase marker間の時間を保存。LB312〜314の修正前失敗を確認し、LB315／316・LBR309〜311を追加。16回帰・11記録検査と216試行の再実行後も全6条件deferを維持。767区間中、未完了provider区間96件を保持し、失敗を成功・完了作業へ読み替えない。

§9.129レビュー修正：CLB-2の重いLB202／LB213／LB214（単独で約64／42／12秒、並行負荷下でLB213が60秒timeout）を通常の`npm test`から外し、記録runnerと`OSV_CWC_HEAVY=1`のときだけ実行。通常のテストは約142秒→15秒。保存記録の検証は毎回実行。

§9.130 2回目のレビュー修正：runnerの再開用ファイルをOSの一時ディレクトリへ移動、LB310を`it.runIf`へ変更、総時間の大部分が各gateの完全検証（smallのbatch 1転送で1157回）であることを内訳として追記。216試行を再測定し全6条件deferを維持、本文の範囲を更新。

### CLB-3P：共通batch経路の費用分解（§9.131）
- [x] call-through observerと独立source pinを追加し、入口／完了・actor／owner別witness・method本文hash・区間／予算を照合。既存の認可・元期限・完全性・署名・budgetは省略しない。
- [x] レビュー修正後の216試行（実測162）のうち117件（実測87件）が完了。実測はscalar 51/54、full-reference 18/54、bound-live 18/54で全6条件defer。全18 cohortのexclusive中央値でwire-verificationが最大。小規模batchでwire検証643〜726 ms、canonical/hash 266〜313 ms、live gate 91〜111 ms、実call API単独2.5〜2.7 ms。18回帰・12記録検査を再実行。
- [x] 私有wireに束縛した不変の認証事実とlive検査の分離契約を§9.132へ設計した。runtime・別実証は未着手。今回の観測値を削減可能時間や純粋CPUへ読み替えない。planner残余には未観測constructor等もあり、分類を完全なsource call-site解析とはしない。CPR-C／本番・実storage・native隔離・継続8 read・CG0／CG3の保留を維持。

§9.131レビュー修正：完了経路の実call検査件数をbinding fullChecksと照合し、成功したcounts／timed間では追加operation・contextの全件数も一致させる。actor別exclusive合計を同actorのpack inclusiveと外側plan区間へ照合。LBP17／18・LBPR10〜12で、片側／両側の件数削減と、operation合計・partitionを保つactor間の費用移動を拒否する。

### CLB-VF：私有requestの検証事実とlive検査の分離（§9.132、設計のみ）
- [x] 独立した追加承認profile、private storage／call／association／owner／scope／generationへの実参照束縛、初回capture・ready時seal、5つの非公開helperと状態機械を具体化。
- [x] 静的predicateとlive入力を分類し、実SessionServer／Lb2Linkの一般inspect・現在性検査、初回・transport最終・CLB finishの完全検証を維持。各旧liveノードを位置・回数とも1対1で引き継ぎ、実purpose返値の照合と実sessionの読取前lifecycle guardを共通採用前提にする。再入・失効・改変・流用・後着・早期回収の拒否を定義。
- [x] 既存call 98304 B・binding 8192 Bの内側で、metadata候補4096 Bとcommand／frame workspaceの重複保持・二重予約を禁止。予算不足は実行前拒否。CVF01〜48・VF-0〜3とscalar／batch×2 modeの同条件比較を定義。48件は未実行の回帰条件で、今回の確認は設計整合性だけ。
- [x] VF-0のstrict standalone fixtureとpredicate／live呼出し対応表を実装し、私有storage・診断association・fact状態・generation・claim／再入・予算・認可revision／同期公開を限定実証した（§9.133）。実sessionの検証省略・速度改善・本番採用は未成立。
- [x] VF-1のprovider／ReadScope接続とVF-2の実session／fresh snapshot接続は限定実証済み。VF-3の元期限・計測追加費用込み比較は§9.136へ記録する。実storage・native隔離・5process・8 read・CFP-0／CPR-C／CG0／CG3の保留を維持。

§9.132レビュー修正：最後のclock／権限callback後は、信頼するAuthorityOwnerのowner epoch・単調な認可revision vectorをprivateに再確認する。全mutation経路の通知・alias除去を採用前提にし、control generationが不変でも変更を拒否。最終clock intrinsic・revision／generation確認から公開までforeign callbackのない同期fenceを共通化し、未通知closure／async authorityはunsupported。CVF22／24を拡充。

対照armの期限停止と候補の適格性を分離し、候補B/fact-liveの全9測定完了、対照3 armのcomplete／正当な元期限打切り／invalid分類、保守的な時間下限による5%判定と独立機能oracleを要求する。対照の打切りだけでは一律deferにせず、成功中央値・正確な倍率へ流用しない。CVF46／47とVFD01〜08の設計例・検証記録を更新。§9.132設計時点ではruntime・48回帰・288試行は未着手。VF-0時点の限定実行範囲は次節へ記載する。後続VF-1／2の対象回帰とVF-3の288試行は§9.134〜136へ別記し、設計上の48条件を単一の48テストとして数えない。

### VF-0：strict standalone fixture・認可revision・同期公開（§9.133）
- [x] 追加source承認と私有storage／fact／call／owner／scope／generation束縛、固定内部呼出しと外部再入、epoch復元拒否、最終callback後のprivate clock／認可fence、lookup除去・reader drain・scratch／slotの回収を実装。既存CLB・実SessionServer・MCP／本番readerは変更しない。
- [x] 19行の静的／live／追加fence対応表、phase別entry／finallyと実validator spyの照合を追加。正常12例の完全検証はfull-verify 11回／fact-live 4回＋fact 7回、liveは両modeで14回。35 fixture回帰・224証拠（成功16・拒否208）・事前拒否38例・12記録検査を保存。
- [x] レビュー3件を修正。seal同期commit前のfinishと追加B読取・公開、初期authority viewの不正型／値、総件数を保つchallenge検査のphase移動を両modeで拒否。seal後のscope.close→finishは維持（VF034／035・VFR12、2026-11-11再検証）。
- [x] VF-1で既存provider／ReadScope・CWC root／fact／ledger接続と、実入口のlive node 1対1／予算共存を限定実証（§9.134）。VF-0は固定clock・1 authority・standaloneのみ。実call／operation row・fresh source／全entry・transport／outcome／use／ACK、複数authority vector・native隔離・288試行の比較・速度改善・本番採用は未成立。

### VF-1：provider／ReadScope・CWC root／fact・ledger接続（§9.134）
- [x] 追加source承認・owned authority／clock・private factを既存sessionのopt-inへ接続。provider／scope／planner／root／fact／ledgerの本文は維持し、ready後の私有request検証だけを省略する。一般inspect・初回・ready・finishは完全検証。
- [x] 正常12例・legacy対照6例でlive callback全順序／件数・実入口・出力・row・memoryを照合。descriptor／scalar／rangesの完全検証は50／56／536→13回、liveは53／59／539回で同じ。memory最大1034970／1043712 B、両modeで4096論理gateを維持。
- [x] 19 runtime回帰・18記録検査・拒否96例・constructor入場拒否6例。権限／取消し／元期限／内容・計画・row改変・予算・再入・scope回収を確認し、source変更の影響がある既存記録もrunnerから再実行する。固定clock・1 authority・同一processでの限定接続。
- [x] VF-2で実SessionServer／Client・fresh snapshot接続を限定実証（§9.135）。全batch／全entry・複数commit・retry・transport最終検証・outcome／use／ACK・実sessionの読取前guardと後着／回収を両modeで確認。
- [x] VF-3の4 arm・288試行比較と採用判断を§9.136へ記録。速度改善・本番採用、外部storage・native隔離・継続8 read・CFP-0／CPR-C／CG0／CG3は保留。

VF-1追加後の既存profile再検証（2026-11-11）：CWC-A／B／C・CLB-0／1／2・VF-0と設計記録を再実行。CWC-D 384転送・DP 240転送・Sites 144転送・Gate 240転送は全完了。CLB-3／3Pはそれぞれ216試行中120完了（実測90/162）、scalar 54/54・各batch 18/54で全6条件defer。旧profileの再測定であり、VF-1の速度改善や本番採用の証拠にはしない。最新値は各節の表・JSONを参照する。

VF-1レビュー修正（2026-11-11）：environmentのgetter／Proxyを評価前に拒否し、constructor入力を一度だけ捕捉・凍結する。grant／codecの固定前払い156978・row222515へ照合し、legacyを含む協調減額を拒否する。拒否時は実reserve・wire・case別phase／論理件数と到達stageから必要消費を求め、budget／after／rowを0にした記録も拒否する。row改変試験はload-afterに実到達するようcall-throughを修正し、改変前の消費も照合する。実session・native・性能改善・本番採用の追加証拠には数えない。

VF-1レビュー修正後の検証：19 runtime回帰・18記録検査、正常12例・legacy対照6例・拒否96例・constructor入場拒否6例を再検証。関連CLB-0／1・VF-0のruntime99件と各記録、CWC-A／B／Cと設計記録も再生成した。旧profile比較はD 384／DP 240／Sites 144／Gate 240転送が全完了、CLB-3／3Pはそれぞれ216試行中120完了（実測90/162）・全6条件defer。source hashだけの付替えは行わず各runnerから再実行し、本文の表・数値も更新する。CWC-D／Sitesの初回runnerは非成功となり一時reportが削除されたため個別理由を回収できなかったが、reportを保持した単独再実行（15件／12件）とrunnerの再生成で成功を確認した。Sites runnerには失敗test名・理由を削除前に出力する診断を追加した。旧profile再測定をVF-1の性能証拠へ転用しない。

VF-1レビュー修正の最終照合：対象37件（runtime19・記録18）、関連runtime99件・各記録、影響する16 runnerの--check、文書例3件、型検査・buildが成功した。拒否時の最大同時予約も初期保持量・成功した予約から再計算し、peak／memory上限の協調減額を拒否する。新規VF-1の実session／外部storage・native隔離・性能・本番採用の成立範囲は拡大しない。

### VF-2：実session／fresh snapshot接続（§9.135）

- [x] 非公開実call controlと所有authority／clockの束縛、hash前後のlive検査、取消し・元期限・再入のsticky失効。
- [x] Client自身の実検証receiptを一回だけ消費してからCLB finish／公開。応答紛失の初回公開0、retry消費・元期限保持。
- [x] 全batch／全entry・2 commit、fresh取得時の非要求entry改変、実authority use／ACK、早期回収・reader drain・後着no-readを両modeで確認。
- [x] runtime29・記録28、正常8例・その他102例。署名／source承認・phase／live件数・予約とstage別消費・Client検証前公開・後着処理の記録改変を拒否。固定clock・同一process・1 RPC/channelの限定証拠。
- [x] VF-3の共通4 arm比較で初期化〜cleanup総時間、計測追加費用、失敗込み完了率と期限停止時の候補判定を検証した（§9.136）。実storage／native隔離・継続8 read・速度改善・本番採用は未成立。

VF-2検証（2026-11-11）：専用runnerのruntime29・記録28、正常8例・その他102例が成功。関連CPR-B／BP 11 files・409回帰、型検査・build・差分検査も成功した。共有Sessionのopt-in追加は明示patchを通して従来I2との完全差分照合を維持する。旧CPR-B 288転送＋32 warm-up、BP 288 primary＋96 bridge＋64診断＋64 warm-up、D 384／DP 240／Sites 144／Gate 240転送を再実行。CLB-3／3Pは各216試行中120完了（実測90/162）で全6条件defer。source hashだけを付け替えず、本文の表とpaired差も最新summaryへ更新した。旧文書テストに固定されていた偶然の遅延pair数・診断の遅い組は、再測定したrawから導く照合へ修正した。これらは旧profileの再検証で、VF-2の性能比較・本番採用の証拠へ転用しない。

VF-2レビュー修正：実Clientのreceiptを検証済みsession／transcript／challenge／sequenceへ束縛し、閉じた旧callの未消費receiptで別callを公開する操作を拒否する。拒否時の件数・消費は閉じたreader recipe／fault別の独立frontierへ照合する。両modeで旧receipt流用、予約・残高・複製counterと実Session件数の協調的減額、総件数を保つsite移動を回帰に追加。新しいsamples／validation v2の記録へ更新する。

VF-2レビュー修正後の確認結果（2026-11-11）：runtime29・記録28が全件成功し、正常8例・その他102例をsamples／validation v2へ再生成した。receiptCallBound・failureConsumptionIndependentを検証済みsummaryへ保存する。関連CPR-B／BP 11 files・409回帰、旧記録21系列の照合、型検査・buildも成功。共有Sessionのsource変更へ届く旧比較を各runnerから再実行し、本文の中央値・paired差・採用見送りの判定も再測定値へ更新した。旧profileの再測定を今回の速度改善や本番採用の証拠には扱わない。

### VF-3：実時間clock・4方式の共通比較（§9.136）

- [x] 所有monotonic clockと独立した実時間profile、共通承認・認可・元期限4500 ms・memory／work／wire予算を実装。scalar／batch×full-verify／fact-liveで全entry・内容検証・各batchの独立計画・実Client receiptとcleanupを維持。
- [x] 288試行（warm-up72・測定216）を再測定し192/288・144/216完了。測定の方式別完了数はscalar/full 53/54、scalar/fact 54/54、batch/full 18/54、batch/fact 19/54。元期限打切り・失敗も保持し、全6条件でdefer・本番採用見送り。
- [x] runtime18・記録検査16と固定clock oracle24転送を照合（レビュー修正後v2）。途中のlive／outcome検査frontier、同一時刻による未完了plan snapshot、ticket返却前の実debit保持、TTL桁数だけのwire正規化を検証。source変更に届く既存記録は別runnerから再生成する。
- [ ] 次はbatch側に残る独立計画・共通検証の費用を、実時間の失敗も含めて調査し、認可・元期限・完全性・予算を維持できる次の削減契約を検討する。今回の結果を本番採用や実storage／native隔離・5 process・継続8 readの成立へ読み替えず、CFP-0／CPR-C／CG0／CG3を保留する。

VF-3初回v1の最終照合（2026-11-11）：対象・関連442テスト、23系列の記録照合、型検査・build・差分検査が成功。共有sourceへ届く旧profileは別runnerから再測定し本文も更新。旧Sitesは143/144（1元期限停止）、旧CLB-3／3Pは各120/216（測定90/162）完了・全6条件defer。これらをVF-3の性能証拠へ混ぜず、288試行のraw・承認source・機能oracleとの対応を維持する。

VF-3レビュー修正：拒否callでも実Session inspectとlogicalを途中検査の1件差まで照合し、実reserve成功時のprivate検査work累積値をbudgetKey付きgateReceiptへ固定する。予約・live／full／fact件数とworkを協調的に1件または複数件減らす操作を両modeで拒否する。provider計画時間は完了・未完了windowの実測合計、clientの計画時間は完了windowの合計へ照合する。両modeの完了計画の0／半減と未完了provider計画の0化を回帰へ追加し、測定・検証schemaをv2へ更新した（§9.136.5）。旧v1のsource hashを付け替えず、288試行を現sourceで再測定した。v2は192/288・測定144/216完了、全6条件defer・本番採用見送り。

VF-3レビュー修正後v2の最終確認（2026-11-11）：runtime18・記録16を含む446テスト、23系列の記録照合、型検査・build・差分検査が成功。修正前の失敗を確認した協調減額・計画時間過小計上の回帰は両modeで成功し、現sourceで再測定した288試行は192完了・測定144/216完了。全6条件deferと同一process／1 RPC/channelの限定証拠を維持する。

### VF-3P：現在のbatch経路の費用・期限停止進捗（§9.137）

- [x] 既存VF-3 v2の本体を変更せず、独立したprofile承認・source／実行method hashを照合。認可・purpose・取消し・元期限4500 ms・内容検証・独立計画・applicationのmemory／work／wire予算を維持。
- [x] 同期packをactor別に捕捉し、実Session検査・wire検証・live gate・codec・canonical/hash・copyをexclusiveで分解。独立inspection witness・元plan span・operation／contextへ照合し、deadline前後を別集計。
- [x] レビュー修正v2で再構成と試行全体の成否を分離。再構成後のcleanup期限停止はreconstructed=true・status=failedを保持し、全coverage・digest・機能oracleを照合。
- [x] 元transport検証が成功した応答wireを捕捉し、元Client受理成功後の進捗へ束縛。元callのreplyDigest／応答長から各partを独立に再構成し、長さの減額・未受理entry差替え・証拠の欠落／改変を拒否。
- [x] 最終sourceで固定clock oracle24転送と実時間288試行を再実行。199/288・測定149/216完了、67元期限停止・invalid 0。全6条件defer。追加費用は完了pairだけを集計し、不完了pairのattempt差も保持。
- [x] runtime24・記録21の回帰で両modeの再構成後期限停止・part改変を確認。v1のprogress／measurementを拒否し、旧sourceの記録を現行証拠へ流用しない。
- [x] live gate内部の反復する不変入力検証・canonical／コピーの削減契約を§9.138へ設計。現在認可・purpose・取消し・pin／generation・元期限・残予算の毎回確認を統合対象にせず、途中観測を削減可能な費用へ直接換算しない。
- [ ] 速度改善・本番採用、実storage・独立UID／5 process・継続8 read・CPR-C／CG0／CG3は引き続き保留。

VF-3Pレビュー修正v2検証（2026-11-12）：大入力fact-liveの期限前live gate中央値2083.7〜2099.8 ms、canonical/hash 1406.4〜1416.6 ms、copy 543.5〜547.2 ms。pack包含3729.8〜3771.8 msに対し子処理を除くplanner分類は15.0〜15.7 msで、計画中のlive gate側を次の調査対象とする。full-verifyではwire検証が最大。いずれも共通wire証拠と計測器込みの観測で、期限停止から完了転送の速度比を作らない。旧VF-3のsource・記録は変更せず、今回の全110 source・実行method・元raw digestを束縛した新しい記録へ更新する。

VF-3Pレビュー修正v2の最終確認：runtime24・記録21を含む497テスト、24系列の記録照合、型検査・build・差分検査が成功。旧sourceのhashを付け替えず、保存回帰の選定を修正した最終sourceで288試行を再取得した。再構成後の期限停止を両modeで受理し、part長の減額・未受理entry差替えを元transport応答への照合で拒否する。


### CWC-LG：所有live入力の正規化と毎回認可の分離（§9.138、設計のみ）

- [x] readyなprovider／scopeのpermission copy／schema／lineage canonicalだけをcaptureへ移す追加profileを設計。raw callback／callerのvalid flagを認可factへ昇格せず、元hook・row順序・同じsome述語と毎gateの認可を維持。
- [x] AuthorityOwnerの所有immutable view、private projection・実call／scope／channel／世代／view／budgetへの束縛、登録締切・capture／seal・mutation先行失効・再入・timeout／reader drainと後着拒否を具体化。
- [x] 追加arena候補4096 B・初期化work4096 unitsを元上限内で事前予約する契約、全64 row・raw32768 B・lineage pool1024 Bの上限、shadow captureと完全layout証明を採用条件へ明記。観測brokerの空き4864 Bを全入力の保証にしない。
- [x] CLG01〜48の回帰条件とLG-0〜3、scalar／batch×full-verify／fact-live×full-input／owned-inputのprimary576試行（測定432）・旧VF-3Pとの別bridge144試行を計画。元期限4500 ms・全候補9試行完了・quiet各round／中央値5%と打切り対照の保守下限を要求。
- [x] レビュー修正：正常scope終了はLG handle／局所世代／frame／lookup／追加ticketだけを終了し、実call・channel・最終wireを保持して固定full-input最終検証へ進む契約を明記。fatalは実callへ先行伝播し、正常finallyで上書きしない。CLG32／33へ正常成功と競合・後着拒否の両条件を追加。
- [x] レビュー修正：primary→新workerのbridgeの順、cohort／round／observation・group回転、隣接対のAB／BA、720予定rowのdigest／ordinalと照合keyを固定。CLG44／46へ集合不変の順序交換・実開始witness不一致・phase混在の拒否を追加。予定順序モデルを実測や実時系列witness検証の成立と数えない。
- [x] LG-0のstandalone helper・owner／port／immutable view・claim／capture／seal／世代／再入拒否を§9.139へ実装。正常LG-local releaseとfatal call失効、初期化4096 units保持・追加4096 Bを既存の実予算内で検証。実providerへの正規化省略・48条件全体・新しい性能測定は未実装／未実行。
- [ ] LG-0の最大入力layout gateを解決する。通常の両role／両mode・2試行は収まるが、全cid／epochをschema最大にした4例はcapture前に容量不足で拒否。最大fieldの共存条件が未成立なのでLG-0出口・LG-1採用を通さない。§9.140で容量を分解し、§9.141で同時4参照を確認した。§9.142で所有・expected比較契約を具体化済み。次はCCO-0のfixtureで新方式を実証する。
- [ ] LG-1のprovider／ReadScope接続、LG-2の実Session／fresh snapshot接続、LG-3の共通条件比較はLG-0通過後に進める。CFP-0の単一自己hash置換は別工程のまま。本番・実storage・独立UID／5 process・8 read・CPR-C／CG0／CG3は保留。

文書・source binding・planned条件はdocs/validation/gradle-cwc-lg-design-2026-11-12.jsonへ保存する。設計整合性テストの通過をLG runtime・速度改善の成立として数えない。

CWC-LG設計レビュー修正検証（2026-11-12）：LG20件を含む文書整合性42テスト・4系列の設計記録照合・既存VF-3P記録21件・型検査・差分検査が成功。作用表と予定順序のcontractを検査し、順序交換・ordinal補修・pair／phase／型改変・欠落を拒否、キー挿入順変更を受理。48 runtime条件とLG-0〜3・新primary576／別bridge144はplannedのままで、実時系列witness検証も未実装。次の作業はLG-0のfixture実証である。

### LG-0：基礎helper・状態機械・実予算の限定実証（§9.139）

- [x] 追加source承認／独立pinと固定port、data-only ownership・strict schema・deep freeze・private handleを実装。caller入力・診断copyへの変更と、偽handle／scope／association・capture／seal再使用を拒否。
- [x] mutationの先行失効と失敗時のupdating保持、例外を捕捉した外部再入、元期限・正常scope終了／call全体失効の分離、未完了dispatchのdrain・LG領域の一度だけ解放を検証。
- [x] full-inputも同じshadow capture・初期化4096 unitsを前払い。旧VF4096はcall内の既存metadataへ占有済みとして計上し、LG4096を別ticketへ予約。通常reader1039066 B・broker1047808 B、2逐次試行でwork＋初期化151554 unitsとなる。
- [x] runtime／record改変拒否、mode×role×9 caseの36証拠とschema最大4拒否、source閉包・署名承認・method・元設計recordを新規検証recordへ保存。過去VF-3Pのsource／実測記録は変更しない。
- [ ] 最大contextの全領域共存証明と採用範囲の整理。現状は4例とも元1 MiBに収まらずunsupported。上限拡大・旧領域の重複利用・入力縮小による有利な比較は行わず、LG-0出口とLG-1への進行は保留。
- [ ] LG-1の実provider／ReadScope・CWC root／fact／ledger接続、LG-2の実Session・fresh snapshot・署名／outcome／use／ACK、LG-3のprimary576＋bridge144は後続。実storage・独立UID／5 process・8 read・本番採用は未成立。

LG-0検証（2026-11-12）：runtime29・record12と関連113の154テスト、4系列の設計記録照合・既存VF-3P記録21件・型・差分検査が成功。通常28ケースは8成功／20拒否、最大context4例は容量超過で拒否。基礎fixtureの実装と回帰記録は完了したが、最大入力layoutのLG-0出口は未成立。次はこの容量gateの整理で、LG-1接続や性能比較へ自動で進めない。

LG-0レビュー修正v2（2026-11-12）：未capture／未sealのscope cleanupをabortとし、seal本体・post fence成功と正常releaseを確認したcallだけがfinalizeできるよう修正。両modeの未capture／未sealで成功公開・署名・use／ACKが0となる回帰を追加した。最大contextには実constructor相当のstrict schema・role／origin・binding照合と全最大化対象field検査を適用し、両mode・両roleでdigest更新済みの不正記録も拒否する。runtime30・record14と関連113の157テスト、設計4系列・既存VF-3P記録21件・型・差分検査が成功。新v2記録は36例（8成功／28拒否）＋最大context4拒否。最大layoutの出口とLG-1への進行は引き続き保留。

### LG-M0：最大contextの容量監査とcommand保持window候補（§9.140）

- [x] 現行CWC-C上界をcodec・3 core・3 context・command families・source／call／binding／LGへ分解し、sourceの保持箇所・寿命・既存解放を束縛した。context共有だけでは不足し、全command配列とcanonical fact bytesの二重保持を削減対象とした。
- [x] 既存最大例に加えてref byteLength65536／head revision256のschema-upperを監査。旧共存上界はreader1119501／broker1138377 B。1 MiBや最大19 command・4 range・sourceサイズは増減しない。
- [x] 4 slot＋metadata2048 Bはbrokerで53 B超過して拒否。3 slot＋別metadata4096 Bはreader1031760／broker1042485 Bとなる条件付き計算を検証。scope内のcodec／3 core／3 context／旧source領域は減額せず、既存f.q解放も新たな削減と数えない。
- [x] mode×role×3境界×3 recipeの36行と実Lb0Budgetの合成予約・2 attempt・失敗消費保持を保存。保持sourceの行番号・hash、旧LG-0 record、未実行CLM01〜20を新記録に束縛した。既存のLG-0拒否と実consumerの予約は変更していない。
- [ ] 3 slot上界・追加metadata4096 Bとworkの共存を証明する。§9.141で現方式の3 slot仮説を不採用とし、§9.142で所有・expected比較の新契約を具体化した。次はCCO-0〜2で実参照・全領域・workの適合を実証する。
- [ ] 成立した場合だけ新source profileでCWC-A／B／plannerとclient initial／sealへ接続し、全19 ordinalのcanonical bytes・bound・work／wireを元oracleと比較してLG-0の最大条件を再検証する。3 slot仮説・合成予約はLG-0出口、LG-1／実Session／性能／本番採用の成立とは数えない。

LG-M0検証（2026-11-12）：容量監査12・record10と関連157の179テスト、既存LG-0記録・設計4系列・VF-3P記録21件・型・差分検査が成功。36行で合成予約26完了／10拒否を記録した。3 slot＋metadata4096のbroker余裕6091 Bは条件付き算術であり、実consumerのslot追跡・追加workは未実証。次の課題は固定consumerのstream生成／parse／copy上界の実証で、LG-0出口とLG-1への進行は保留。

### LG-M1：実A／B consumerの参照追跡・3 slot仮説の拒否（§9.141）

- [x] 元A／B・実schema・実connected grantでcopy／parse／expected構築を観測。入力・私有q・raw expected・expected parse結果の4 distinct objectが同時に生存する負例を得た。
- [x] 3 slotは第4 parse実行前に拒否。観測用8 slot対照は全19 command・456 oracle照合に成功。2 role×3境界×2要求label×2容量×2 attemptの48実行を保存。要求labelはLG両mode runtime接続の証拠とは数えない。
- [x] 失敗・再入・元期限・権限取消し、予約不足、親ledgerの消費保持・第3 attempt拒否、observer復元と記録の改変拒否を追加した。実copyの下界であり、全allocation・metadata4096・追加work・全領域共存の上界証明とは扱わない。
- [x] §9.142でcommand所有・expected比較のphase分割契約を設計。candidate canonical familyを先に構築し、入力の全frame復帰・消費後にexpected生成へ進む。完全schema・独立expected・全bytes／B検証・元live siteを維持し、metadata・scratch・追加workの未被覆を拒否する契約とCCO01〜40を追加した。
- [ ] 新profileのCWC／initial・sealへの接続とLG-0最大入力の再検証。現行3 slot候補は不採用、LG-0出口・LG-1〜3・実Session・性能／本番採用は引き続き未成立。

LG-M1検証（2026-11-12）：実consumer6・記録8と既存179の193テスト、LG-M0／LG-0記録・設計4系列・既存VF-3P記録21件の照合、型・差分検査が成功。観測48 attemptのうち24対照で456 commandを照合し、3 slotの24 attemptはexpected parse前に拒否した。LG-0出口と新profile採用を保留し、次は4実体の重なりを減らす契約改訂を行う。

LG-M1の記録レビュー修正（2026-11-12）：grant IDを実scope番号・actorから独立再導出し、静的入口とfresh比較の両引数で照合する。一意性を保ちdigestを更新したattempt間のscope／call ID交換を拒否するLMR29／30を追加した。両回帰は修正前の失敗を確認済み。実consumer6・記録10と関連179の195テスト、LG-M0／LG-0記録・設計4系列・既存VF-3P記録21件の照合、型・差分検査が成功。48 attemptを再実行し、24対照の456 command一致と3 slotの24拒否を再確認した。LG-0出口・次段階／本番採用は保留のまま。

### CWC-CO：command所有・expected比較のphase分割契約（§9.142、設計のみ）

- [x] 新profile cwc.owned-command-window.v2／recipe cwc.command-owned-phases.v1を提案。全build gateの順序を保って私有candidate bytesを構築し、decode／normalize childの全参照除去後に独立expected生成・全内容比較・B proofへ進む契約を具体化した。
- [x] WindowHandleだけをcallerへ渡すhelperの入出力、root／call／scope／actor／generation・元期限／budgetへの束縛、candidate→factの条件、initial／sealの別root・別slabと全件比較を定義した。
- [x] slot以外のcanonical／hash一時値も別regionへ計上し、metadata4096のlayout候補・固定参照table・scratch非重複・追加workの独立承認／事前予約・失敗時の消費保持を明記した。原上限と単位を変えず、残5424 unitsやbroker余裕6091 Bを統合適合の証明に使わない。
- [x] CCO01〜40の回帰条件とCCO-0〜2の出口を追加。元live site・最後のcallback後の同期fence・fatal先行失効・drain／後着拒否を維持する。
- [x] CCO-0a（§9.143）：strict fixture recipe・独立source pin・所有cell／candidate slab・packed metadata・phase／lease／retire・独立expected比較を実装。24ケース・684 commandと未予約scratch／第4lease・再入／期限・消費保持・後着拒否を検証する。成功はstorage比較までで、B proof／fact採用を生成しない。
- [x] CCO-0b調査（§9.144）：元sourceを変更せずschema／hash・canonicalの実呼出しを観測。normalizeでは3 full command＋1 shallow preimageの4 distinct rootをsource holder／future useへ対応付け、現recipeの3 slot仮定を不採用とした。expectedの4参照はobserverがraw寿命を延ばす保守的frame観測で、同じ強参照下界とは数えない。metadata＋traceの明示buffer266240 Bも4096 Bを超える。12対照・342 command・24拒否と、source別保持箇所・primitive量・回帰／fresh照合を記録する。
- [x] CCO-0出口の契約再設計（§9.145）：提案v3の所有producer／有界consumer・固定hash projection、S2 token indexを含む3 slot、chunk4096とcodec overlay16384、binary metadata3072＋JS bridge charge1024、48実参照／8 handleを具体化。client4 coreとcaller残存graphを計上し、元予算の成立条件・棄却条件・原単位cost被覆・CCR01〜48を設計した。算術fitは採用証明ではなく、新runtimeと回帰条件は未実行。
- [x] CCO-Rレビュー修正：CoreHandleを各actorの既存windowと同一実体の役割aliasにし、追加handle／refを0、lookup／generation／stateを共通化。予約19×Wと実処理n=batchCountを分離し、CCR26／27・CCR08／20へ反映。欠落・重複・n超過と別CoreHandle発行の拒否、14整合性チェック・元plannerの2 batch対照・検証記録を追加した。
- [x] CCO-R0限定実証（§9.146）：所有packed core・有界parser・stream projection／encoder・別storageの独立expectedを実装。24例・378 commandと元完全schema／canonical oracle、nested差分corpus、同一CoreHandle・19×W予約／実n=2／19・管理frame／借用の寿命を照合する。全source holderを棚卸しし、native／JS bridge／全work上界は未成立としてR1へ残す。実A／Bへは未接続。
- [x] CCO-R0レビュー修正：例外診断より先にownerを失効し、message getter／文字列変換を呼ばず回収・元throw値・消費を保持する。parserは正常解析後の入力拒否でも旧token／sourceをclearする。追加10拒否・記録改変1条件とfresh再現を検証し、R1／R2の実証範囲を拡大しない。
- [x] CCO-R1契約具体化（§9.147）：construct-private／internal-moveとscope shell、15領域・26 source群の未被覆、bridge／overlay／native候補、原単位cost・全実親子ledgerのhold／commit／retry、copy／IO前の拒否条件を設計。R1C01〜48とR1-O／M／W／Gの4手順、原本24行・未知を保持する算術・設計検証記録を追加した。runtimeの移管／予約／拒否は未実装。
- [x] CCO-R1設計レビュー修正：source停止・lifetime pin／旧borrow終了を最後の完全検証前へ置き、同じ排他的leaseでbind／公開まで更新・zeroを禁止する。R1C05／06へ捕捉済みcallback・例外捕捉・値の復元でもfatal解除／公開を拒否する条件を追加。R1D19／20と記録を更新し、runtime実証へ昇格しない。
- [x] R1-O限定実装（§9.148）：閉じた所有producer、登録／同一scope shell、実buffer／borrow、source停止・borrow終了・排他的完全検証・同一store／memory ticketのbind／公開を実装。捕捉済みcallbackの更新／zero・例外捕捉／復元・再入・期限を公開前に拒否する。36正常／42拒否のmatrixとruntime／record回帰を新記録へ束縛する。固定clock・同一process・合成callでの所有移管だけであり、oracleの一時領域・native hash・診断tableは未被覆。
- [x] R1-Oレビュー修正：私有factory発行のbudget／balanceと固定操作だけを受理し、派生型・外部base owner・操作の値／getter差し替えを評価前に拒否する。hookの非同期戻り値は成功公開前に拒否し、通常native Promiseのsettleまでbuffer／予約を保持する。constructor3・操作差し替え16・Promise12の拒否証拠とR1OT21〜28／R1OR11〜12を追加。独自thenableや本番の非同期lifecycle対応へ昇格しない。
- [x] R1-M全領域台帳の具体化（§9.149）：初回は15領域を43行・76 source anchorへ対応付け、実owner／holder・生成／最終利用／clear／残存終端・view量／未被覆を保存した。R1-O drain後のCall／handle／trace／digest、未完了Promise、R0 pooled context、canonical一時値・module／generic native経路・caller exportを明示。24 inventory／8 recordチェックとR0 24・R1-O 36・pending12のfresh観測を追加した。レビュー修正で45行・79 anchorへ拡張する。全allocationの検出やJS／native上界の証明ではない。
- [x] R1-Mレビュー修正：base／追加量を明示的なlower／upper区間へ分け、上限だけの値を既知下限へ足さない。M44／45と3 source anchorでruntime.#hook／closure捕捉graphを台帳化し、drain後も残る2 MiBのfixture graphを3 actor・各2 callで到達確認する。R1M25〜30／R1MR09〜11、5算術例のdigest／fresh検査を追加。台帳は45行・79 anchorとし、一般capture上限・JS／native charge・R1-M出口の未成立を維持する。
- [x] R1-H保持契約の具体化（§9.150、設計のみ）：任意hook／捕捉graphを受け入れず、閉じた所有portを要求する。G／R／W／T／D／C／Fの7 ownerへregistry・48 role・8 handle／attemptと16 identity／read・wrapper／frame・固定summaryの上限／寿命／回収条件を対応付けた。正常local closeとfatalのlookup除去・quarantineを分離し、ACK／timeout／GCによる早期解放を禁止する。19旧台帳行・RHC01〜48と設計整合性記録を追加し、charge／実予約／runtime採用は未成立のまま。
- [x] R1-H設計レビュー修正：第2 attemptで残るbinary／48参照table／containerを落とさず、完全なW×2を事前予約する。16 identityはその内側で一度だけ計上し、T containerだけを別加算する。条件付き保持例は5376→9216 B（3840 Bの漏れ修正）とし、actual attempt数／回収flagで減額しない。RHC14をn=1算術・不完全inventoryの拒否とn=2／19の正常runtime条件に分離し、RHC21／27・R1HD25〜28と検証記録へ反映した。runtime条件は引き続き未実行。
- [x] R1-H0の限定lifecycle実装（§9.151）：閉じた所有port・容量1〜4の固定registry・権限キーとcleanup用identity・正常window終了／read失効／managed回収を実装した。2組の専用binary（計6144 B）・96参照位置・16 identityを保持し、第1 attemptの実借用を残した第2 attempt、再入の内側例外捕捉・後着・早期回収・partial zero失敗を両fixture modeで検証する。40 runtime／10 recordテスト、正常8・公開拒否28・cleanup4の有限観測を追加。実CWC・全charge・本番profileの成立とは数えない。
- [x] R1-HBの採用境界・charge証拠契約（§9.152、設計のみ）：observer／faultとcoreのartifact分離、reader／controllerのrole発行、load前bootstrapとcurrent承認revisionの検査、18 regionと7 lifetime class・typed certificateを具体化した。descriptor literal114評価・persistent array5、guard前closure生成をsourceへ対応付け、再利用領域とepoch allocation debtを分離する。候補R4／Q64／E256／D64・元単位／親namespaceの分離、HBC01〜40・HB-1〜4と設計整合性記録を追加し、runtime／charge／本番採用は未成立のまま。
- [x] R1-Sの有界summary配送（§9.153、限定fixture）：固定256 B×2、sender512＋transfer256＋receiver512 B、ACKとconsumer解放の分離、immutable再送／copy前dedup、cancel・期限・再入・encode unavailableと回収を両modeで実装する。counter／digestとmain outcomeは合成モデルで、実CWC・認証IPC・独立recipient承認・全charge／元親適合とは数えない。
- [x] HB-1のartifact／reader境界の限定実装（§9.154）：候補core・readonly port／scalar-readerとcontroller・observer／故障programを別artifactへ分離した。固定外部fixture pin・controlled ES module linker、readerだけのexport・null-prototypeの固定操作、constructor／static／factory／禁止module経由の拒否を両modeで確認した。診断artifactのcounterを候補のchargeへ流用せず、独立deployment issuer・認証隔離・全charge／元親適合は未成立のまま。
- [x] HB-2aの保持台帳・entry／epoch quotaの限定実装（§9.155）：分離後artifactを18 region／source anchorへ対応付け、Pの固定metadata64・global R4／Q64／D64、G発行4・通常240／cleanup16を実装した。失敗／retry／新G／bootstrap再loadでも消費を戻さず、D飽和後のcleanupとcleanup枯渇時のquarantineを両modeで検証した。payload／entryは元byte／workへ換算せず、全charge・durable restartは未成立のまま。
- [x] HB-2の独立charge・単位／寿命証拠契約の具体化（§9.156、設計のみ）：18領域ごとに6共通＋2専門bundle、取得method・owner／subresource・単位／実親・capture／native／caller・release／reuseの必須証拠と拒否を設計した。公開metrics／snapshotと上界proofを分離し、A証拠・B実予約・C解放の循環回避、metadata cap・HBEC01〜48／ED-1〜4を追加した。collector／certificate／元unit mapping・runtime採用は未成立のまま。
- [x] ED-1の18領域ごとの実取得可能性調査（§9.157）：現Node image／flagsと候補artifactを固定し、両modeのbootstrap前後・保持中・drain後の公開統計、heap snapshot／queryObjects、Inspector sampling、OS tool取得を5 fresh processで検証した。source／subject照合の入力・現時点の診断と独立上界証明の範囲を分離し、全18領域を現取得routeではunsupported、upperはnull・credit0とした。proof providerの網羅的探索やproduction collectorの採用ではなく、ED-2〜4の独立証明・lifetime・実親gateは残る。
- [x] ED-2の対象・取得方式・最小実証／棄却条件の具体化（§9.158、設計のみ）：review commit ec9348aのHB-1／HB-2修正と承認pin・4記録のsource／baseline／設計節を再照合した。旧7 pathは整理済み（HB2Caseはnet changeなし）。HB06 payloadとHB12 kernel stepの部分claimを初回対象にし、固定native recipe候補・Cモデルと実objectの対応・独立method／unit承認を分離した。E2-P0〜4、32 planned条件・48 planned native case、未知unit／未被覆・拒否／費用保持を追加。cbmc等は未導入でproof／kernel／本番採用は未成立。
- [x] ED-2の記録レビュー修正：採取／再照合の両入口でcommandとsummary全体を共通validatorへ通し、期待source件数・5 probe／8 toolの順序／全件・結果をpin確認済みED-1 baselineから導く。stdout hash／bytesを更新してもcommand交換・件数減額・probe／tool欠落等を拒否する。新規20記録回帰（修正前12失敗）と正常対照、設計書・再採取記録を追加し、独立attestation／proofではない限界を維持。
- [x] E2-P0の取得・独立承認・workspace契約の具体化（§9.159、設計のみ）：CBMC 6.8.0／組込みMiniSat・Clang21.1.8／Linux amd64 image候補、全source／tool／依存lock、固定argv／環境・全loop／property、8 roleの権限分離と未割当key／registry、8 GiB runner・2 GiB job disk・4 slot／8 GiB store・600秒期限とclock換算／watchdog・controller枠を定義。実digest・実主体・全予約／enforcement未取得なら8理由でunsupportedとする。46 planned回帰条件・設計46テスト（レビュー修正含む）・診断記録を追加し、取得／build／proof／承認／配備完了とは数えない。
- [x] E2-P0のgate順序レビュー修正：全予約後のpre-copy live gateをcandidate読取前へ置き、copy後・exec前も再照合する。予約中失効は読取／copy／exec／公開0。結果検証／drain／seal後は元job／lease／approval期限・停止latch・epoch／予約fenceを公開transactionで再検査し、期限同値とkill猶予内／終了時も公開0とする。P0C41〜46と12 planned例、強化既存3＋追加6の設計チェックを追加し、実controller検証とは分離する。
- [x] E2-P0記録のレビュー修正：P0 checkerの保存観測差を `p0_saved_<key>` と差異field path（tool名単位・値なし）で報告し、PATH差・tool導入・compiler／Node更新を区別できるようにした。clang不在時はcompiler診断nullをP0D02で受理する。ED-2記録の再生成に必要な2権限domain監査と `--audits` の手順、旧7 path変更時は別記録とする条件を§9.159へ追記し、P0記録を再生成した。
- [x] E2-P0の取得lock・承認envelope・preflight静的contract（§9.160）：wire-only strict schema、8群の不足／不正／失効／容量拒否、独立pinとEd25519署名・role／subject／profile・job／予約／元期限の束縛を実装。P0S01〜47（172件、レビュー修正26件を含む）と記録6件を追加し、全出力permit0・実操作0。fixture署名claimの整合確認であり、実tool／独立authority／enforcement・実IO gate採用は未成立。
- [x] E2-P0 gate／phase対応のレビュー修正（§9.160）：pre-copy gateが後段phaseのpreflightを受理していた欠陥を直し、各gateは自stage（reserved／copied／sealed）だけを受理する。pre-publishはphase照合を先に行い、未sealedはinvalidとする。P0S48（15件、修正前6失敗）を追加し、P0S35／P0S46を自gate受理へ改めた（修正前4失敗）。metadata187・記録6へ更新し、記録を再生成した。
- [x] E2-P0のmetadata取得・preflight runner／独立backend接続口（§9.161）：operator rootと3 ownerの両端署名Unix IPC、前後のlive確認、固定期限／wire予算・再送／後着拒否、CLIと回帰・native記録を追加。未配備／未取得はunsupported、完全fixtureでもenforcement未検証のためpermit0。別UID／実tool本体取得・独立容量強制は未成立。
- [x] E2-P0公開文書のcommand表記修正（§9.160／§9.161）：operator向けcommandから作業環境固有のprefixを除き、runner checkerの§9.160照合を件数表記＋prefix除去の厳密置換へ広げた（P0V02で残存prefixを拒否）。契約記録→runner記録の順に再生成した。
- [x] E2-P0 backendのjob認可・永続保存・boot／current pin契約の具体化（§9.162、設計のみ）：v2のjob grant／API・purpose、独立bootstrap／epoch anchor、durable ACK・headとselectionの分離、再送台帳・失敗債務、取消しbarrier・旧epoch失効を保存する復旧順を定義。5＋1＋2 RPC ticket・保存／cleanup事前予約、PB0〜PB5とEB01〜48のplanned条件・設計整合性テスト・検証記録を追加。実grant／store／anchor／boot証拠はnull、permit0を維持する。
- [x] E2-P0 backend設計レビュー修正（§9.162）：管理用control K／Dとjob／realm subject、query自身とoriginを分離し、後続transaction後の元receipt照会・再CAS禁止を具体化した。BeginWorkflow 1＋初回origin query 1をinit-controlへ事前予約し、metadata 8と合わせた最大10 RPCをwire親8 MiB・t0起点期限内で計上する。EB14／15／22／28、追加6件の設計整合性回帰と記録を更新し、runtime未成立を維持する。
- [x] E2-P0 backend設計の第2レビュー修正（§9.162）：BeginWorkflowは事前確保済みinit admissionの計上だけとし、response-may-have-escapedを別durable段としてgate順序へ追加、metadata-read K／Dのdomain・profileDigest・K digest、ControlDebtRecord field、origin tombstone前の未実行応答禁止を定義した。EBD13強化＋EBD31〜35（修正前5失敗）を追加し、記録を再生成した。
- [x] E2-P0 backend PB0の静的fixture contract（§9.163）：strict request／13管理API payload、read／control K／Dとquery origin、認可・new CAS／historical解決、4状態機械と23 recordのDAG、実Beginとdescriptor／D sealのbindingを実装。実Ed25519／canonical UTF-8／4 B headerのcodecとinit-control 2＋metadata 8の予算fixture、レビュー修正を含む73テスト・再現checker・記録を追加。current authority・実parent予約・永続保存・native v2接続・物理上界は未成立、unsupported・permit0を維持する。
- [x] PB0レビュー修正（§9.163）：新規mutationでRevokeJob／RevokeReaderGrantのexpectedAuthRevisionとPublishCurrentPinのexpectedSelectionを照合し、historical照会には再CASを要求しない。単一bundleでinit descriptor／seal・同jobのinitId・Begin Kとworkflowの一意性、ticketの排他的所有、grant上限を検査する。全依存hash更新・node順反転、descriptor alias、正常な独立allocation／同一workflowへの通常参照を含む14回帰を追加（修正前10失敗＋4正常対照→修正後14成功）。実parent／別bundle・再起動をまたぐquotaの証明へ昇格しない。
- [x] PB0第2レビュー修正（§9.163）：応答紛失RegisterJobを現在のjob-absent状態で照会可能にし、予算fixtureのmetadata readを確立済みworkflow（committed Beginまたは有界init queryのhistorical ref）に限定、retry／init query／auditを紛失・未解決の元試行に限定した。PBC20・PBW15・PBW16・PBR07（修正前4失敗）を追加し、PBW06の10 call順を正当な紛失経路へ改め、記録を再生成した。
- [x] E2-P0 backend PB1のsingle-owner保存（§9.164）：認証journal／checkpoint・独立anchor接続口、別local adoption journal、origin tombstone、別durable escape段、exact stage再試行を追加。4領域の同期／再同期失敗・anchor応答紛失・後続transaction・巻戻し・再起動と4境界の実SIGKILLを実diskで検証。レビュー修正後の59回帰＋記録6件と再現checkerを追加。anchor fixtureはsame UID、認可はtrusted port、全配備／親予約・physical／work証明は未成立、unsupported・permit0を維持する。
- [x] PB1レビュー修正（§9.164）：auditのrealm／owner照合を履歴読取前へ追加し、commit／auditの再入検出をパース前の共通guardへ移した。PBD30〜32の7例（修正前1成功／6失敗→修正後7成功）で、不一致時の履歴・file内容読取／anchor呼出し0、不正JSON再入の例外捕捉後も外側ACK0、保存効果の保持／再open復旧、通常入力不正の非fatal拒否を確認し、記録・case件数照合を更新する。
- [x] PB1第2レビュー修正（§9.164）：`failed-or-unknown`のcleanup段を元deadline・通常認可ではなくrecovery grantで判定し、期限切れ／失効後も記録可能にした。本体journal書込前の検証・認可拒否は`PB1Rejection`として非fatalにし、書込後の失敗と再入だけをblockedにする。PBD33・PBD34の7例（修正前0成功／7失敗→修正後7成功）を追加し、PBD30の前提を調整して記録を再生成した。
- [ ] E2-P0 backend PB2〜PB5：次はPB2 job authorizer／immutable descriptor／atomic workflow ticket・実全親予約。続いてPB3再送・全owner債務・失効／新boot復旧、PB4 v2 native IPC、PB5独立owner／anchor配備を実証する。PB0の合成policy／refやPB1のlocal disk／署名portを、runtime認可・独立巻戻し防止・実行許可へ昇格しない。
- [ ] E2-P0の実provision・独立backendの実配備／artifact取得：独立custodian／method・environment authority／registry／controller／storeの実principal・key・ACL、取得image／solver組込みlock・有界bootstrap／全workspace・watchdog／quota証拠を取得し、実行前gateとP0C01〜46を検証する。未取得時はunsupportedを残し、E2-P1のsource準備を証明成功へ昇格しない。
- [x] HB-1〜ED-1レビュー修正：HB-1／HB-2a coreのattempt0で `bodies[-1]` がArray.prototypeへ委譲し、consumerのgetterからrow／registry／portが漏れて未開始attemptの公開・閉じたreadの復活が成立した欠陥を、添字参照前のattempt検査で塞いだ。HB1T06の既存witnessとHB2T19のfresh childへ負添字getter攻撃を加え、candidate pinと4記録を依存順に再生成した。ED-1のEPERM／255／66は制限付き実行環境の非再現な失敗で、再測定（3 toolともexit 0）とpreviewのpath／PID秘匿、fresh tool結果・余分keyの照合を追加した。route helperはretention-entry→元work／logical-byteをcharge-unit-mismatchへ分類し、HB-2a oracleの拒否範囲（中間段階はfresh再実行で拒否）・HBC部分対応集合・記録pathの記述を実装へ合わせた。
- [ ] HB-2の残り：新台帳のunknownを保ったまま、全wrapper／closure／module・loader／Error・caller／native領域の独立charge・unit mapping・allocator release／reuse証拠を取得する。local quotaを独立承認profile・実namespace／durable fencingへ接続し、元親ledgerと全処理costの被覆を証明する。
- [ ] HB-1の配備採用条件：fixture issuer／外部pinを独立bootstrap・署名registry・実deploymentのrole発行／loader witnessへ接続する。敵対host／別UID隔離、実認証call／scope／lineage、controller／診断の実容量境界を証明し、HB-3の読取前gateと合わせて採用判定する。
- [ ] R1-Hの残り：HB-2aのlocal quotaを独立承認へ束縛し、HB-2で全holder／closure／wrapperの独立charge・unit mapping・元単位の全entry／epoch cost・再利用／未回収debt証拠、HB-3で有界bootstrap／loaderと実全親gate、HB-4で統合を実証する。R1-Sの合成summary配送を実CWC receipt・独立recipient／認証IPCへ接続し、caller graphと全wrapperの保持・元単位chargeを実証する。R1-H0の2 body slot holdを実親ledgerの予約へ昇格せず、完全なW本体×2・16 identity全寿命・512 B summary＋wrapper等を旧bridge1024に無条件で含めない。RHC01〜48／HBC01〜40のfull contract、最大role／contextと実接続・両mode・2 attemptは未成立。n=1の算術確認を正常runtimeの実証へ昇格しない。
- [ ] R1-Mの実装・証明：全bridge／wrapper／closure／診断保持のcharge、有界codec scratchと全ownerのresidency DAG、固定arena hashまたは独立native証拠を実装・取得する。45行のunknownを0にせず、現R1-Oの診断ticketやfinite buffer量から1 MiB共存を認めない。§9.149.6の4実装単位と§9.150の保持契約へ分けて進める。
- [ ] CCO-R1 runtimeの残り：次はR1-Mの全bridge charge・codec overlay／native領域。その後R1-Wの原単位cost被覆・実owner／全親子ledgerとR1-Gの独立承認／copy・IO前gateを実装・検証する。R1-Oの診断ticket196608 B／initialization4096／work4096を全予算成立へ昇格しない。CCO-0aのopaque処理・traceを新recipeへ流用しない。
- [ ] CCO-R2：改訂fixtureの最大入力・両role／両mode・2 attemptで全領域／消費保持とCCR01〜48／元CCO01〜40を検証し、CCO-0出口を判定する。元1 MiB／work枠に収まらない、または検証・認可を弱めないと成立しない場合は3 slot案を棄却し、CCO-1へ進めない。
- [ ] CCO-1：新source承認の実A／B・固定consumer、独立initial／seal・provider計画へ接続し、全canonical bytes・live site・元oracleと消費を照合する。
- [ ] CCO-2：最大入力・両role／両LG mode・2 attemptの全領域／親子ledger共存を実証し、LG-0最大layoutを再判定する。新profile・3 slot・metadata／work・LG-0出口・LG-1〜3・実Session／性能／本番採用は未成立。

CWC-CO設計確認（2026-11-12）：CCO01〜40・9 helper・3段階の文書構造とmetadata4096／row64 Bの算術を確認。既存195テスト、LG-M1／LG-0／LG-M0記録・設計4系列の照合、差分検査が成功した。新runtimeと40条件は未実行で、既存source・実参照／性能記録のhashを更新して新方式の証拠へ流用していない。

CCO-0b調査検証（2026-11-12）：runtime13・record12と既存223の248テスト、12対照・342 command・24 guard拒否、型・差分・既存CCO-0a記録の照合が成功した。20 source anchorと225 source／artifactを新記録へ束縛し、normalizeの4 rootとexpectedの保守的raw保持を区別する。source代入上のclient保持は3 context・4 coreで、既存3 core枠へ自動で重ねない。physical heap／全参照／scratch／総追加workの上界は未成立。現recipeとCCO-0出口を不採用とし、次は所有consumer・bridge／scratch／cost契約の見直しで、CCO-1へ先行しない。

CCO-R設計検証・レビュー修正（2026-11-12）：CRD14件と既存248の262テスト、型・差分・CCO-0bのfresh照合が成功。CoreHandle aliasで8 handle内に収める契約、n=1／2／19の予約／完了算術と元plannerの5 entry／5 B→2 commandを確認した。48条件／3段階と新producer／consumerはplanned・未実行。6境界の条件付き算術では最大brokerのprovider余裕1995 B、caller core1追加時のclientは8821 B超過となる。binary3072＋bridge charge1024という候補と全原単位cost被覆の実装証拠は未成立で、算術fitからCCO-0出口や本番採用を認めない。次はCCO-R0の所有producer／有界consumer限定実証である。

CCO-R0限定実証（2026-11-12）：runtime30・record10と関連既存149の189テスト、型・差分と旧設計／CCO-0b記録のfresh照合が成功。24例・378 command、差分4372件を元完全schema／canonical oracleへ照合し、最大76 rangeの追加対照、同一CoreHandle、19×W予約／実n=2／19、管理3 slot・frame退出／実buffer zeroを確認した。241 source／artifactと全source holderの棚卸しを新記録へ束縛する。次はCCO-R1で、bootstrap／native hash・JS bridge／全参照charge・全work・実ledger共存を具体化し、未被覆なら入場を拒否する。R2・CCO-0出口・実A／B／Session・本番採用へは進めない。

CCO-R0レビュー修正検証（2026-11-13）：message getter／toString／Symbol.toPrimitiveが失敗する6ケースと、正常解析後に入力検査で拒否する4ケースの修正前失敗・修正後成功を確認。runtime40・record11と関連既存149の200テスト、型・差分・旧記録照合が成功した。getter／変換評価0、ownerの失効・実buffer zero／memory回収・消費保持、旧token／source保持0と再解析を確認し、review証拠と242 source／artifactを記録へ束縛した。次のCCO-R1と未成立の範囲は変えない。

CCO-R1契約具体化検証（2026-11-13）：設計整合性18件と関連既存200の218テスト、型・差分・R0／旧設計記録の照合が成功。15領域・26 source群と原本buffer24行、246 source／artifactへ新記録を束縛した。work／memoryの未知はnullで保持し、全11証拠と実owner／ledgerが揃うまでcopy／IO前に拒否する契約を具体化した。48回帰条件・4実装手順は未実行で、R1 runtime・R2・本番採用は未成立。次はR1-Oの所有登録／scope shellの限定実装である。

CCO-R1設計レビュー修正検証（2026-11-13）：sourceの新規利用停止・既存borrow終了を最後の完全検証前へ移し、lifetime pinと同じ排他的leaseをbind／公開まで維持する契約へ修正した。R1C05／06へ検証後の更新・zero・lease失効、捕捉済みcallback／例外捕捉／値の復元でも公開不可となる条件を追加。R1D19／20の修正前失敗・修正後成功、設計20件を含む関連220テスト・型・差分・旧記録照合が成功した。記録は246 source／artifactへ束縛し、runtime拒否実証とは数えない。

R1-O限定実装検証（2026-11-13）：runtime23・record10と関連既存220の253テスト、型・差分検査、R1設計／R0／CCO-R設計記録の照合が成功した。正常36例・拒否42例をfresh再現し、253 source／artifact・12 anchor・Node binary・新節へ記録を束縛する。source停止→既存borrow終了→排他的完全検証→同期bind／公開、検証後の更新／zero・捕捉済みcallbackの拒否、同じstore／ticketの移管とdrain後の実zeroを確認した。次はR1-Mであり、R1-W／G・R2・本番採用は未成立。

R1-Oレビュー修正検証（2026-11-13）：R1OT21〜23の7ケースは修正前に失敗し、修正後は追加対照を含むruntime35・record12と既存220の267テスト、型・差分検査、旧記録照合が成功した。constructor3・操作差し替え16・非同期Promise12の31拒否をfresh再現し、pending時の2 buffer／196608 B保持、settle後のzero／memory回収と消費保持、差し替え操作・callback書込／公開0を確認する。更新記録は254 source／artifact・16 anchorへ束縛する。外部ledger・独自thenableのlifecycle・native並行性を採用せず、次のR1-M／W／Gと本番採用の未成立を維持する。

R1-M台帳具体化検証（2026-11-13）：inventory24・record8と関連既存267の299テスト、型・差分検査、旧R0／R1設計／R1-O記録の照合が成功した。15領域・43行・19 fileの76 source anchor、R0 24例・R1-O 36例・pending12例と268 source／artifactを新記録へ束縛する。R1-O drain後のCall／shell／handle／trace／bound digest保持、pool共有view、汎用canonical／schema graph、全native経路、診断export／terminal同居を明示し、JS／native upperはnullとした。次は§9.149.6の保持構造／charge、有界scratchとresidency DAG、hash backendの実装・証明であり、R1-M全体・R1-W／G・R2・本番採用は未成立。

R1-Mレビュー修正検証（2026-11-13）：R1M25〜30の6回帰の修正前失敗・修正後成功、inventory30・record11と関連既存267の308テスト、型・差分・旧記録照合を確認した。更新記録は45行・79 anchor・268 source／artifactと5 interval算術例・3 hook保持例を束縛する。upper-only値はlowerを増やさず、base upper未確定も保持し、既知lower超過とupper枠超過を分ける。M44／45はruntime.#hookと任意の捕捉graphのowner／残存寿命・上限nullを明記し、drain後の別callから2 MiB viewとcontext／core markerへ到達できることを確認した。一般capture上限・GC解放・R1-M出口・本番採用は未成立。

R1-H保持契約の設計検証（2026-11-13）：設計整合性24件とsource閉包内の関連242件、合計266テスト・型検査が成功した。7 owner・48 role・19旧台帳行、48件のplanned条件と272 source／artifactを新節・旧R1-M baseline・実Node binaryへ束縛する。8 handle／attemptと16 identity／read、core／summaryの保持分離、upper-only／unknownを保持する条件付き算術を照合した。hook環境の列挙・実registry／port／退役処理・diagnostic配送・独立charge・実親予約・RHC01〜48のruntime拒否は未実装／未実行であり、1 MiB共存・physical heap上界・R1-M／R1出口・性能／本番採用は未成立。次はR1-Hの閉じた所有portと固定registry／retirementの限定実装、続いて独立charge・全領域共存の実証である。

R1-H設計レビュー修正検証（2026-11-13）：R1HD25〜28の4回帰の修正前失敗・修正後成功を確認し、設計28・関連242の合計270テスト、型・差分・旧R1設計記録の照合が成功した。新記録は272 source／artifactと完全なW×2・重複しない16 identityの条件付き算術、両role×n=1／2／19の6算術例・case分類を束縛する。保持例のupperは5376→9216 B、追加upperは1280→5120 Bで、旧windowのbinary／参照／container3840 Bの漏れを修正した。actual attempt数・旧W回収flagによる予約減額を認めない。n=1は算術と不完全inventory拒否の計画、n=2／19は完全schema／全range被覆を要求する正常runtimeの計画へ分離する。48 runtime条件・実charge・元予算の成立・R1-M出口・本番採用は引き続き未成立。

R1-H0限定lifecycle検証（2026-11-13）：runtime40・record10と関連既存270の合計320テスト、型・差分・新記録のfresh照合・旧R1-H設計記録の照合が成功した。正常8・公開拒否28・cleanup4の有限観測、12 source anchor・279 source／artifactと実Node binaryへ記録を束縛する。固定registry・閉じた所有port、2組の実binary6144 B／96参照位置／16 identity、権限キーの先行除去とcleanup alias、実借用／transport中の保持、再入例外捕捉後の公開0、partial zero失敗のquarantineと再試行を両fixture modeで確認した。leaseは各attemptでborrow／transport各1回の限定契約で、同identityの再発行・旧completionによる新債務解除を拒否する。copying observer・caller graph・全wrapper chargeは未被覆であり、実CWC／Session・summary配送・元予算の適合・R1-M出口・本番採用は未成立。次は保持構造の独立chargeとowned port／observerの採用境界を具体化・実証する。

R1-HB採用境界・charge証拠の設計検証（2026-11-13）：設計24・関連既存320の合計344テスト、型・差分・旧R1-H0記録の照合が成功した。18 region・6 source site・283 source／artifactと実Node binaryへ新記録を束縛する。同artifactのobserver／fault、descriptor literal114評価とpersistent array5、guard前closure生成をsourceへ対応付けた。reader／controllerと実artifactの分離、current承認revision、独立unit mapping・epoch debt・候補Q64／E256（通常240／cleanup16）／D64、bootstrap前予約と4実装段階を具体化する。806912／1069056は仮定上のlogical-byte算術で、full read／physical／work fitではない。宣言topologyの受理も実load閉包やrole権限を証明しない。40回帰条件・source分離・独立charge・runtime採用gateは未実装／未実行であり、次はHB-1のcore／diagnostic分離とreader-role発行の限定実装である。


R1-S有界summary配送の限定検証（2026-11-14）：runtime40・record10と関連既存344の計394テスト（20ファイル）、型・差分・旧R1-H0／R1-HB記録照合が成功した。正常8・拒否16・cancel4・unavailable2、9 source anchor・291 source／artifact・実Node image・§9.153を束縛する。固定256 B×2、送信512＋転送256＋受信512 B、ACK／transfer／consumerの別終端、同時borrowとslot別zero、copy前dedupと同一bytes再送、再入／期限／recipient失効時の保持・回収を確認した。counter・digest・main outcomeは合成モデルであり、実CWC receipt・認証IPC・独立承認・全wrapper／caller graph・元単位charge・実全親予約・R1-H／R1-M出口と本番採用は未成立のまま。


HB-1 artifact／reader境界の限定検証（2026-11-14）：新規runtime40・record10と関連既存394の計444テスト（22ファイル）、型・差分・旧R1-H0／R1-HB／R1-S記録の照合が成功した。9 source anchor・305 source／artifact、実Node image／child flagsと§9.154を束縛する。候補coreのexportをreaderのみにし、readonly port／scalar-reader・controller・診断programを別artifactへ分離した。正常8・診断拒否28・現認可拒否12・cleanup2・公開面2・source拒否10、readerのconstructor／static／factory／禁止import経路、拒否例外経由のhost参照取得と未定義identityによるclosing変更の拒否を両modeで検証した。診断artifactの保持・counterを候補のchargeへ流用せず、host同居量を0にしない。fixture発行／固定pinでの有限検証であり、独立配備issuer／署名registry／production loader／OS隔離・実認証call／scope・全領域charge／元親ledgerと本番採用は未成立。次はHB-2の独立charge・unit mapping・entry／epoch quota／debt、HB-3の実bootstrap／全親gateへ接続する。


HB-2a分離後台帳・entry／epoch quotaの限定検証（2026-11-14）：runtime48・record12と関連既存444の計504テスト（24ファイル）、型・差分・旧HB-1／R1-S記録の照合が成功した。18新台帳anchor・323 source／artifact・44 native caseの実Node image／flags、§9.155・旧baselineを束縛する。通常240＋cleanup16、P共有R4／Q64／D64・G4、失敗／retry／partial zero／再入・新G／bootstrap再loadでの消費保持を検証した。D飽和後も予約済みcleanupの失敗／回収を認め、cleanup枯渇時は実borrow／body／slotを保持する。entryとpayload、固定64 metadataとcaller-held debtを別unitで残し、zero／drainをallocator解放へ換算しない。台帳のbyte upperはnull、独立charge・元work／全親ledger・実認証call・durable epoch／restart fencing・全native allocation・本番採用は未成立。次はHB-2の独立unit mapping／lifetime・charge証拠、HB-3の独立bootstrap／実全親gateへの接続である。


HB-2独立charge・単位／寿命証拠の設計検証（2026-11-14）：設計整合性32・関連既存504の計536テスト（25ファイル）、型・差分・旧HB-2a記録の照合が成功した。18領域・8 bundle／region、108 route例、48 planned runtime条件・4段階と327 source／artifactを§9.156・旧baseline・実Node checkerへ束縛する。wrapper／capture／native／caller保持、元unit／実親・生成前template／予約と生成後identity、同一resource外部holderのrelease禁止・独立allocator receipt／reuse条件を具体化した。metrics／snapshot／OS容量policyはdiagnostic／補助として区別し、すべての独立上界はnull、実credit／permitは0／falseを維持する。collector取得・証明／署名／actual parent検証とHBEC01〜48は未実行であり、次はED-1の実取得可能性とunsupportedの固定、ED-2〜4の独立証拠・lifetime・実gate接続である。


HB-2 ED-1実取得可能性検証（2026-11-14）：新規40・関連既存536の計576テスト（26ファイル）、型検査・旧HB-2証拠設計記録の照合が成功した。18領域・334 source／artifactと実Node v26.12.1／V8／macOS arm64・flagsを束縛する。5 fresh childで両modeの公開memory／heap／space／code／CppHeap統計、候補を保持したsnapshot・queryObjects、自己Inspector sampling、ps／vmmap／footprintの取得結果を記録した。heap／leaks／dockerは存在のみ、prlimit／systemd-run・cgroupは現環境になく、存在・失敗・未実行を区別する。raw heapは破棄し、現node集計やsamplingから全allocation／capture／native／caller上界へ昇格しない。source hashは後続の独立承認済subject照合の入力に限り、独立unit map・all-holder／allocator receipt・実親予約は未成立。stream cap／old-space指定はsnapshot生成前workspaceや全processの物理上界ではない。ED-2では独立engine／bounded recipeのlayout・work証明と承認、ED-3ではcaller／allocator／durable寿命証拠、ED-4では実親gateが必要で、HB-2全体・HB-3・本番採用は引き続き未成立。


HB-2 ED-2取得計画の設計検証（2026-11-14）：新規設計整合性32・関連既存576の計608テスト（27ファイル）、型・差分・記録照合が成功した。339 source／artifactと新節、HB-1→HB-2a→evidence-design→ED-1の305／323／327／334 pin・baseline／documentの不一致0、旧7 pathの解決状態を保存する。制限付きED-1再照合のtool outcome相違拒否と、保存記録と同domainでの40回帰を伴う成功を分離して保存した。初回HB06の6144 payloadとHB12の中間stepは部分対象で、wrapper／native stack・全operation／元unit・残る16領域を無料にしない。Clangの存在はproof取得・image／method承認ではなく、cbmc／goto-cc／frama-c／z3は未導入。次はE2-P0の独立tool／method／workspaceを取得するか、未取得のままE2-P1のモデル専用候補を準備する。Cモデル成功だけでは実objectへ採用せず、E2C01〜32・予定48 native case・独立上界・ED-3／4・HB-2全体と本番採用は未成立。


HB-2 ED-2記録レビュー修正検証（2026-11-14）：新規20記録回帰・設計整合性32・関連既存576の計628テスト（28ファイル）、型・差分・記録照合が成功した。342 source／artifact、baseline由来の完全な期待command／summaryと2権限条件の再採取を更新記録へ束縛する。実 --checkへの記録入力だけを一時差替えし、hash／bytes更新後のcommand交換・sourceBindings減額・probe／toolの欠落／同数重複・tool flags／schema改変をvalidator固有理由で拒否した。修正前の追加12回帰は誤受理で失敗した。旧4記録とcandidate artifactは変更せず、stderr hashは本文なしでは形式確認のみ、実行の独立attestation・予定48 native kernel case・ED-2独立証明／全unit／実親・本番採用は未成立のままとする。


HB-2 E2-P0契約の設計検証（2026-11-14）：新規40・関連既存628の計668テスト（29ファイル）、型・差分・旧ED-2記録の52チェックが成功した。346 source／artifactと新節・baseline・実Node image／tool探索を束縛する。現Apple Clangの存在をLinux Clang／CBMC／solverの承認へ流用せず、版候補と未取得digest・8 roleと未割当identity・候補capと未強制を分離した。独立検証ownerのjob予約とMCP元callのunit／実親・HB14 gateは別で、job資源を元1 MiB／workへ換算しない。tool-lock／solver／method／environment／registry／workspace／enforcement／bootstrapの8不足を明示しunsupported・permit0を保持する。tool download／image build／proof／kernel compile・P0C01〜40実deployment・独立承認／workspace強制・厳密physical上界・本番採用は未成立。


HB-2 E2-P0 gate順序レビュー修正検証（2026-11-14）：設計整合性46・関連既存628の計674テスト（29ファイル）、型・差分・旧ED-2の52チェック照合が成功した。346 source／artifactと本節、予約後copy前／copy後exec前のfresh gate、drain／seal後の元期限・current承認・停止／失効／epoch／予約fence付き公開gate、46 planned条件と12 planned例を更新記録へ束縛する。修正前の9設計失敗を確認し、予約中失効のcandidate読取／copy0と、後処理中の期限到達・kill猶予での公開0を期待条件として固定した。実IO／controller race／proof・独立承認／workspace強制は未実行で、8不足理由・unsupported・permit0を維持する。

E2-P0静的contract検証（2026-11-14）：metadata回帰146・記録6・関連既存674の計826テスト（31ファイル）、型・差分検査、旧ED-2／P0の52／46チェックと新記録152件再照合が成功した。351 source／artifact、旧346 source・baselineと新§9.160・実Node imageを固定。key別表記／40桁commitの2失敗→成功も確認した。証拠不足8群と実状態nullを保持し、実provision／独立IPC・IO gate／enforcement、job permit・本番採用は未成立。

E2-P0静的contractのレビュー修正：負の換算期限はeffectiveDeadline null・revoked-or-expiredでstrictに返しinstanceを失効する。preflight schemaでphaseごとのresult／drain／sealの必須・禁止を検査し、failed／unknownを全phase・全gateで拒否する。P0S43〜47の26回帰を追加し、負期限2件・失敗phase10件の修正前失敗と修正後成功、未来証拠／必須欠落8件・正常5 phase・不正形状1件を確認する。172 metadata＋6記録へ更新し、旧346 source／baseline・実状態null・permit0とnative未成立は維持する。

E2-P0レビュー修正の検証（2026-11-14）：26追加回帰を含むmetadata172・記録6・関連既存674の計852テスト（31ファイル）、型・空白検査、旧ED-2／P0の52／46チェックが成功。178件・351 sourceの新記録を再照合し、旧346 source／baseline不一致0。実provision・native条件・本番採用は未成立、unsupported・permit0を維持する。

E2-P0 metadata取得／preflight runner検証（2026-11-14）：新規66（51 protocol／runner・9 native／CLI・6記録）＋既存867の計933テスト（34ファイル）、型・差分検査、旧ED-2／P0設計52／46・静的contract193件再照合が成功した。365 sourceと旧351 source、Node／TypeScript compiler・CLI artifactを新記録へ束縛。前のlive失効後のcontroller読取抑止、CLI alias起動の各修正前1失敗→成功を確認した。152件の再実行手順は追加gate修正後の現行193件へ訂正し、178件は履歴と区別する。実socket制限下の初回EPERM 5失敗／3成功と、許可条件のnative9成功を分ける。未配備／未取得はunsupported、完全fixtureでも実enforcement未検証でpermit0。artifact本体取得・独立backend実配備／永続fence・実quota／全実親gateは残る。

E2-P0 runnerレビュー修正：結果schema整形後と同期cleanup後の元期限／close epoch guardを追加し、失敗時staticMetadataVerified false・消費保持を検証する。operator fileは通常fileの事前検査・nonblocking/no-follow open・FDと名前側identity／nanosecond鮮度・読取前後のcanonical pathを照合し、FIFO待ち・同内容path置換を拒否する。P0B32の修正前4失敗→成功、config／keyのFIFO・非通常file・path置換16件の修正前10失敗／6正常対照→16成功、実socket／別CLIのfinal guard4件を追加し、90回帰（55＋29＋6）と検証記録を更新する。故障preloadはtest artifactに分離し、candidate操作0・permit0と実独立配備／quota未成立を維持する。

E2-P0 runnerレビュー修正検証（2026-11-14）：追加24を含む90回帰（55 protocol／runner・29 native／CLI・6記録）＋既存867の計957テスト（34ファイル）、型・差分・旧ED-2／P0設計52／46と静的193の照合が成功した。366 source／artifactとtest-only故障artifactを更新記録へ束縛。最後の検証／同期cleanup後の期限・closeで未検証を返し、FIFOを待たず拒否し、FD／名前側の置換は読取前後に拒否、key拒否buffer zeroも実観測した。実独立backend・tool本体取得・enforcement・元親ledgerとjob permitは未成立のまま。

E2-P0 backend契約の設計検証（2026-11-15）：設計整合性24件＋関連既存957件の計981テスト（35ファイル）と型検査を確認した。新記録は基準commit 7f32ab1のrunner記録／366 sourceを変更せず、370 source／artifact・§9.162・実Node binaryへ束縛する。v2 job grant／API／purpose、durable intent／ACK、headとcurrent selectionの分離、失敗債務・監査用再送照会、revoking／local fence／drain、旧epoch失効を保存する復旧順、8 RPC・保存／cleanupの候補上限を照合した。EB01〜48はplanned・runtime実行0、実grant／store／anchor／boot証拠はnullであり、次はPB0のstrict fixture contract。永続実装・独立配備・元単位charge・実行許可の成立とは数えない。

E2-P0 backend設計レビュー修正検証（2026-11-15）：EBD25〜30の追加6件は修正前6失敗→修正後6成功、現行設計30件＋関連既存957件の計987テスト（35ファイル）と型検査を確認した。管理用K／D・API別subject／期待状態、query自身／origin、後続transaction後の旧CAS再実行禁止、init-control 2＋metadata 8 RPCの分離、163,856＋6,553,664＝6,717,520 Bの算術とwire親8 MiB、予約前t0起点の期限・消費保持を照合する。記録は370 source／artifactへ更新し、旧366 source／基準記録を変更しない。48件のEB条件は引き続きplanned・実行0、独立配備・実work／保持量上界・実行許可は未成立である。

PB0静的contractの限定実装検証（2026-11-15）：新規59件（contract29・graph10・codec14・記録6）＋関連既存992件の計1,051テスト（39ファイル）、型検査・一時build・記録照合を確認した。380 source／artifactと旧370 source不変、実Node／compiler・5 artifact・依存entry pinを新記録へ束縛する。read／control K／D・query／originの分離、13 APIの認可と委譲／ownedService、4状態機械、23 recordの閉包・型／hash・init seal binding、実署名codecと10 RPCの会計・loss／失敗の保持を検証した。実wire38,320 B・最悪保持6,717,520 B／8 MiB、最大reply frame1,048,580 Bと1 B超過拒否を確認する。別instance／boot間の実quota持続・live authority・durable保存・native v2 IPC・独立charge／実行許可は未成立。次はPB1の実disk保存／同期・anchor portと故障試験である。

PB0レビュー修正検証（2026-11-15）：追加14件は修正前10失敗＋4正常対照→修正後14成功。現行73件（contract35・graph18・codec14・記録6）＋関連既存992件の計1,065テスト（39ファイル）、型・一時build・空白・記録照合を確認した。API固有のpayload CASは新規mutationだけで比較し、元receiptのhistorical解決を維持。bundle全体のinit／Begin／workflow／ticket所有とgrant上限をhash更新・順序反転後も検査し、独立allocationと通常参照の正常対照を保持する。更新記録は380 source／artifactと旧370 source／設計記録不変、review group／case件数・before／afterへ束縛する。実codec値・元wire親8 MiB・元期限・消費保持、work／memory upper null、EB全48条件runtime完了0・unsupported／permit0とPB1以降の未成立を維持した。
