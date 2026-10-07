# OSV-Scanner-MCP

[![CI](https://github.com/tedorigawa001/OSV-Scanner-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/tedorigawa001/OSV-Scanner-MCP/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/osv-scanner-mcp)](https://www.npmjs.com/package/osv-scanner-mcp)
[![license](https://img.shields.io/npm/l/osv-scanner-mcp)](LICENSE)
[![node](https://img.shields.io/node/v/osv-scanner-mcp)](package.json)

Google製 [OSV-Scanner](https://github.com/google/osv-scanner) をラップするMCPサーバーです。Claude等のMCPクライアントから「このプロジェクトの脆弱性をチェックして」と自然言語で依頼するだけで、依存ライブラリの既知の脆弱性(CVE / GHSA)を深刻度順のレポートで取得できます。

> **ステータス**: [npmで公開中](https://www.npmjs.com/package/osv-scanner-mcp)(`npx -y osv-scanner-mcp`)。Java(Maven / Gradle)、JavaScript(npm / yarn / pnpm / bun)、Python(Poetry / uv / Pipenv / PDM / requirements.txt)、Go のlockfileに対応しています(修正版の推奨も4言語に対応)。MCPクライアントは Claude Code / Claude Desktop / Codex CLI / Antigravity / VS Code(GitHub Copilot)での利用手順を用意しています。

## 特徴

- **複数言語のワンショットスキャン**: `scan_project` ツールにプロジェクトパスを渡すだけで、Java・JavaScript・Python・Goのlockfileを検出してまとめてスキャンします。lockfileが無い・バージョンが未固定などでスキャンできなかった依存は、応答先頭の `coverage` で明示します
- **Javaプロジェクトのスキャン**: `scan_java_project` ツールでJava(Maven / Gradle)のマニフェストだけを対象に、検出→スキャン→整形済みレポートまで一気に返します
- **JAR/WAR実体スキャン**: `scan_java_artifact` ツールで、lockfileが無い・shaded/fat JARしか手元にないプロジェクトでもアーカイブ内メタデータから既知の脆弱性を検出します(ベストエフォート同定であることを明示するcoverage情報付き)
- **SBOM入力スキャン**: `scan_sbom` ツールでCycloneDX/SPDXのJSON SBOMに記録された依存を検査します。SBOMの網羅性や実成果物との一致は未検証であることを明示します
- **深刻度順のレポート**: パッケージごとに脆弱性をCVSSスコア順に整理し、5段階の深刻度ラベル(critical / high / medium / low / unknown)とサマリ集計付きで返します
- **修正版の提示**: 各脆弱性の `fixed_versions` を含めます。MavenはMavenバージョン優先順位規則(`2.17.1-RELEASE` のようなsemver非対応の表記にも対応)、npm・GoはSemantic Versioningの優先順位で正しくソートします
- **セキュリティ第一の設計**: シェル非経由の実行・引数ホワイトリスト・パス正規化と境界チェック・タイムアウト/出力サイズ上限を実装段階から組み込んでいます

## 動作要件

- Node.js >= 20.19
- [OSV-Scanner](https://google.github.io/osv-scanner/) バイナリ — **手動インストールは不要です**。見つからない場合、公式GitHub Releasesからピン留めバージョンを自動ダウンロードし、パッケージに埋め込まれたSHA256チェックサムで検証してから使用します(`~/.cache/osv-scanner-mcp/` にキャッシュ)
  - 手動インストール済みのバイナリ(PATH上または `OSV_SCANNER_PATH` 指定)があればそちらを優先します
  - 自動ダウンロードを無効化する場合は `OSV_MCP_AUTO_DOWNLOAD=0`
  - PATH上のバイナリを使わず常に検証済み自動ダウンロードを使う場合は `OSV_MCP_PREFER_DOWNLOAD=1`(運用環境向け)
- スキャン時と `explain_vulnerability` 実行時にネットワークアクセスが発生します。照会先はOSVデータベース(`api.osv.dev`)ですが、**`pom.xml` のスキャンでは推移的依存を解決するため deps.dev(`api.deps.dev`)にも接続します**。詳細と無効化の方法は[通信先とプライバシー](#通信先とプライバシー)を参照してください

## セットアップ

### Claude Code への登録

```bash
claude mcp add osv-scanner -- npx -y osv-scanner-mcp
```

### Claude Desktop への登録

`claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "osv-scanner": {
      "command": "npx",
      "args": ["-y", "osv-scanner-mcp"]
    }
  }
}
```

### Codex CLI への登録

```bash
codex mcp add osv-scanner -- npx -y osv-scanner-mcp
```

または `~/.codex/config.toml` に追加:

```toml
[mcp_servers.osv-scanner]
command = "npx"
args = ["-y", "osv-scanner-mcp"]
startup_timeout_sec = 60   # 初回のnpxパッケージ取得に備えて延長
tool_timeout_sec = 300     # 既定60秒。バイナリ自動ダウンロード+スキャン(既定120秒)を見込んで延長
```

> **注意**: CodexのMCPツール実行タイムアウトは既定60秒です。本サーバーはスキャンのタイムアウトが既定120秒のため、初回のOSV-Scanner自動ダウンロードや大きめのプロジェクトのスキャンでは既定値のままだとCodex側が先にタイムアウトします。上記のように `tool_timeout_sec` の延長を推奨します。

### Antigravity への登録

エージェントパネルの **MCP Servers → Manage MCP Servers → View raw config** で開く `mcp_config.json` に追加(Claude Desktopと同じ形式):

```json
{
  "mcpServers": {
    "osv-scanner": {
      "command": "npx",
      "args": ["-y", "osv-scanner-mcp"]
    }
  }
}
```

### VS Code(GitHub Copilot)への登録

```bash
code --add-mcp '{"name":"osv-scanner","command":"npx","args":["-y","osv-scanner-mcp"]}'
```

またはワークスペースの `.vscode/mcp.json` に追加(コマンドパレットの **MCP: Add Server** からも設定可能):

```json
{
  "servers": {
    "osv-scanner": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "osv-scanner-mcp"]
    }
  }
}
```

### ソースから使う場合

```bash
git clone https://github.com/tedorigawa001/OSV-Scanner-MCP.git
cd OSV-Scanner-MCP
npm install
npm run build
# 登録時は `npx -y osv-scanner-mcp` の代わりに `node /path/to/OSV-Scanner-MCP/dist/index.js` を指定
```

### 環境変数

| 変数 | 説明 |
|---|---|
| `OSV_SCANNER_PATH` | 使用するosv-scannerバイナリの明示指定。省略時はPATH→自動ダウンロードの順で解決。**指定が無効な場合はフォールバックせずエラーになります**(意図しないバイナリの実行防止) |
| `OSV_MCP_ALLOWED_ROOT` | 指定時、このディレクトリ配下以外のスキャンを拒否します(パストラバーサル対策の境界)。**設定を推奨**。空文字・空白のみは未設定として扱います |
| `OSV_MCP_REQUIRE_ALLOWED_ROOT` | `1` または `true` 指定時、`OSV_MCP_ALLOWED_ROOT` が未設定ならサーバーの起動自体を拒否します(運用環境向けのfail-closedモード) |
| `OSV_MCP_MAX_CONCURRENT_SCANS` | 同時実行できるスキャン数の上限(デフォルト `2`、最大 `16`)。超過したリクエストは待たずに即時エラーになります |
| `OSV_MCP_AUTO_DOWNLOAD` | `0` または `false` でバイナリの自動ダウンロードを無効化(デフォルト有効) |
| `OSV_MCP_PREFER_DOWNLOAD` | `1` または `true` 指定時、PATH上のosv-scannerを使わず、チェックサム検証済みの自動ダウンロードバイナリを常に使用します(PATH汚染による偽バイナリ実行の防止。`OSV_SCANNER_PATH` の明示指定は引き続き最優先) |
| `OSV_MCP_NO_CANDIDATE_CHECK` | `1` または `true` 指定時、`suggest_fix` の推奨先のOSV照会を行いません(応答の `candidate_check` は `disabled`。推奨先に、現在の版には該当しない既知の脆弱性がないことは確認されません) |
| `OSV_MCP_NO_REMOTE_RESOLUTION` | `1` または `true` 指定時、`pom.xml` と `requirements.txt` の推移的依存を deps.dev で解決しません。**止まるのは deps.dev への送信だけで、脆弱性照会のためパッケージの名前とバージョンは引き続き `api.osv.dev` に送られます**。推移的依存の脆弱性は検出できなくなり、その旨が応答の `dependency_resolution.warning` に示されます。詳細は[通信先とプライバシー](#通信先とプライバシー) |

> **推奨**: `OSV_MCP_ALLOWED_ROOT` は未設定でも動作しますが、その場合は任意の絶対パスをスキャンできてしまいます。悪意ある指示(プロンプトインジェクション)経由で意図しないディレクトリをスキャンさせられる経路を塞ぐため、プロジェクト置き場のルート(例: `~/projects`)を設定しておくことを推奨します。各クライアントの設定で `"env": {"OSV_MCP_ALLOWED_ROOT": "/Users/you/projects"}` のように渡せます(Codex CLIのTOMLでは `[mcp_servers.osv-scanner.env]` セクション)。

> **本番運用の推奨構成**: 共有サーバーやCI等の運用環境では、次の3つをセットで設定してください。
> - `OSV_MCP_ALLOWED_ROOT=/スキャン対象のルート` — スキャン範囲の境界を固定
> - `OSV_MCP_REQUIRE_ALLOWED_ROOT=1` — 境界未設定なら起動を拒否(fail-closed)
> - `OSV_SCANNER_PATH=/管理者所有の絶対パス` または `OSV_MCP_PREFER_DOWNLOAD=1` — PATH解決に依存せず、実行するバイナリを固定
>
> 依存の情報をどこに送るかは[通信先とプライバシー](#通信先とプライバシー)を確認してください。どの設定でも、脆弱性照会のためパッケージの名前とバージョンは `api.osv.dev` に送られます。

### 権限を絞って起動する

多層防御として、Nodeの権限モデル(`--permission`)でサーバーが読み書きできる範囲を絞れます(任意。既定の起動方法は変わりません)。`npx` ではNodeのフラグを渡せないため、`node` で直接起動します。

```json
{
  "mcpServers": {
    "osv-scanner": {
      "command": "node",
      "args": [
        "--permission",
        "--allow-fs-read=/path/to/OSV-Scanner-MCP",
        "--allow-fs-read=/Users/you/projects",
        "--allow-fs-read=/var/folders/xx/yyyy/T",
        "--allow-fs-read=/private/var/folders/xx/yyyy/T",
        "--allow-fs-write=/private/var/folders/xx/yyyy/T",
        "--allow-fs-read=/opt/homebrew/bin/osv-scanner",
        "--allow-child-process",
        "/path/to/OSV-Scanner-MCP/dist/index.js"
      ],
      "env": {
        "OSV_MCP_ALLOWED_ROOT": "/Users/you/projects",
        "OSV_SCANNER_PATH": "/opt/homebrew/bin/osv-scanner"
      }
    }
  }
}
```

- 読み取り: サーバー本体(`dist` と `node_modules` を含むディレクトリ)、スキャン対象(`OSV_MCP_ALLOWED_ROOT`)、一時ディレクトリ、osv-scannerのバイナリ
- 一時ディレクトリ(`os.tmpdir()`、macOSでは `$TMPDIR`)は、**シンボリックリンクの解決前と解決後の両方のパス**に読み取りの許可が必要です(macOSの `/var/folders/...` は `/private/var/folders/...` へのリンク)。書き込みは解決後のパスに許可します
- 自動ダウンロードを使う場合は、キャッシュ(`$XDG_CACHE_HOME/osv-scanner-mcp`、既定は `~/.cache/osv-scanner-mcp`)の読み書きも許可します。使わない場合は `OSV_SCANNER_PATH` を指定します
- osv-scannerを起動するため `--allow-child-process` が必要です。**子プロセスのosv-scannerは権限モデルの制限を受けません**(Node自身もこのフラグは権限モデルを弱めると警告します)。osv-scannerには検証済みのコピーだけを渡しているため影響は限定的ですが、より強い隔離が必要ならコンテナ等のOSレベルの仕組みを併用してください
- 必要な許可が欠けている場合は起動時に標準エラー出力へ警告し、スキャン時は `permission_denied`(不足している許可と対象のパス)を返します

### 通信先とプライバシー

osv-scanner v2.4.0 で接続先を実機確認した結果です(2026-10-07)。

| 操作 | 接続先 | 送られる情報 |
|---|---|---|
| `pom.xml` のスキャン(`scan_project` / `scan_java_project` / `suggest_fix`) | `api.osv.dev`、**`api.deps.dev`** | パッケージの名前とバージョン。deps.dev には推移的依存の解決のため、`pom.xml` に宣言された依存(社内パッケージを含む)の名前とバージョンが送られます |
| `requirements.txt` のスキャン(`scan_project` / `suggest_fix`) | `api.osv.dev`、**`api.deps.dev`** | `pom.xml` と同じく、推移的依存の解決のため記載された依存の名前とバージョンが deps.dev に送られます。`--index-url` 等に書かれた取得先へは接続しません |
| lockfileのスキャン(`gradle.lockfile`、`package-lock.json` 等のnpm系、`poetry.lock` 等のPython系、`go.mod`) | `api.osv.dev` | パッケージの名前とバージョン(lockfileに全依存が記載済みのため、解決のための外部接続はしません) |
| `scan_java_artifact` / `scan_sbom` | `api.osv.dev` | 同定できたパッケージの名前とバージョン |
| `suggest_fix` の推奨先の照会 | `api.osv.dev` | 推奨を出したパッケージの名前(スキャンで照会済みのもの)と、推奨候補の版(公開されている修正版)。`OSV_MCP_NO_CANDIDATE_CHECK=1` で無効化できます |
| `explain_vulnerability` | `api.osv.dev` | 指定した脆弱性ID |
| バイナリの自動ダウンロード(初回のみ) | GitHub(公式Releases) | なし(ピン留めしたバージョンのバイナリを取得) |

api.osv.dev と deps.dev はどちらも Google が運営するサービスです。**どの設定でも、スキャンしたパッケージの名前とバージョンは脆弱性照会のため `api.osv.dev` に送られます**(オフラインでの照会には対応していません)。

- **deps.dev への送信を止めたい場合**: `OSV_MCP_NO_REMOTE_RESOLUTION=1` を設定すると、`pom.xml` と `requirements.txt` の推移的依存を解決しなくなり、接続先は `api.osv.dev` だけになります。止まるのは deps.dev への送信だけで、OSV への送信は続きます。また直接書いた依存しかスキャンされず、**推移的依存の脆弱性を見落とします**。この状態は `scan_project` / `scan_java_project` / `suggest_fix` の応答の `dependency_resolution` に `transitive_resolution: "disabled"` と警告で示されるので、検出0件と区別できます。推移的依存も含めて deps.dev を使わずにスキャンするには、lockfile方式(`gradle.lockfile`、`poetry.lock` 等)を使ってください
- **任意の取得先には接続しません**: osv-scanner の `--data-source native` モードは、スキャン対象の `pom.xml` の `<repositories>` に書かれた任意のURLへ接続します(悪意あるpom.xmlで攻撃者のサーバーへ通信させられる)。本サーバーはこのモードを使わず、`deps.dev` を明示指定しています

## 提供ツール

### `scan_project`

プロジェクト内のlockfile・マニフェストを検出し、Java / JavaScript / Python / Go の依存をまとめてスキャンします。パッケージマネージャーやビルドは実行しません。

**入力**

| パラメータ | 型 | 説明 |
|---|---|---|
| `project_path` | string | スキャン対象のプロジェクトディレクトリ、または対応するlockfile・マニフェストの絶対パス(直接指定したファイルはそれ1件だけをスキャン) |

**対応ファイル**

| エコシステム | ファイル |
|---|---|
| Java(Maven) | `pom.xml`、`gradle.lockfile`、`buildscript-gradle.lockfile` |
| JavaScript(npm) | `package-lock.json`、`npm-shrinkwrap.json`、`yarn.lock`、`pnpm-lock.yaml`、`bun.lock`(テキスト形式) |
| Python(PyPI) | `poetry.lock`、`uv.lock`、`Pipfile.lock`、`pdm.lock`、`requirements.txt`(`requirements-dev.txt` 等も) |
| Go | `go.mod` |

`.git`、`node_modules`、`target`、`build`、`.venv`、`venv`、`site-packages`、`__pycache__`、`.tox`、`vendor` とシンボリックリンクは探索しません。検出したファイルだけを形式を明示してOSV-Scannerに渡します(応答の `coverage.manifests` がそのままスキャン範囲です)。探索上限は `scan_java_project` と同じです。

**requirements.txtは元のファイルをOSV-Scannerに渡しません**。本サーバーが解析し、解釈できた依存の行だけを `名前==版` 等の単純な形に直して専用の一時コピーに書き、それをスキャンします(スキャン後に削除)。OSV-Scannerは取り込み指定を独自に解釈してたどる(`- r ../x.txt` のような空白入りも取り込みとみなし、スキャン範囲の外のファイルを読む)ため、コピーには取り込み指定やオプションを一切含めません。取り込み(`-r` / `--requirement`)は、プロジェクトディレクトリ内の取り込み先だけを本サーバーが展開してコピーに含めます。

**出力の読み方**

```json
{
  "project_dir": "/path/to/project",
  "dependency_resolution": { "transitive_resolution": "enabled" },
  "coverage": {
    "complete": false,
    "warning": "一部の依存はスキャンされていないか、版を推測してスキャンしています(…)",
    "manifests": [{ "path": "web/package-lock.json", "ecosystem": "npm", "format": "package-lock.json" }],
    "lockfile_missing": [{ "path": "svc/package.json", "ecosystem": "npm", "status": "missing", "hint": "lockfileがありません。…" }],
    "unpinned_requirements": [{ "file": "py/requirements.txt", "line": 2, "name": "Jinja2", "specifier": ">=2.0", "kind": "lower_bound" }],
    "unscannable_requirements": [
      { "file": "py/requirements.txt", "line": 4, "text": "-e git+https://…", "reason": "編集可能インストール(-e)はスキャンされません" },
      { "file": "py/requirements.txt", "line": 5, "text": "-r ../shared/base.txt", "reason": "取り込み先がプロジェクトディレクトリの外のため展開しません" }
    ],
    "skipped_files": []
  },
  "ecosystem_breakdown": { "npm": { "manifests": 1, "vulnerable_package_count": 2, "vulnerability_count": 4 } },
  "vulnerable_package_count": 2,
  "vulnerability_count": 4,
  "severity_breakdown": { "critical": 0, "high": 2, "medium": 2, "low": 0, "unknown": 0 },
  "packages": [
    { "name": "minimist", "version": "1.2.5", "ecosystem": "npm", "dependency_groups": ["dev"], "dependency_relation": "direct", "declared_in": ["package.json"], "vulnerabilities": [] },
    { "name": "qs", "version": "6.7.0", "ecosystem": "npm", "dependency_relation": "transitive", "introduced_by": ["express"], "vulnerabilities": [] }
  ]
}
```

- **`coverage` を必ず確認してください**。`complete: false` の場合、一部の依存はスキャンされていないため、検出0件でも安全とは言えません
  - `lockfile_missing`: lockfileの無いマニフェスト(`package.json`、`pyproject.toml`、`Pipfile`、`setup.py`、`build.gradle` 等)。同じディレクトリに同じエコシステムのlockfileがあれば記録しません。上位のディレクトリのlockfileだけがある場合は、`package-lock.json`(v2以降)にそのディレクトリが収録されていることを確認できたときだけ記録しません(npm workspaces)。収録されていなければ `status: "missing"`、確認できない形式(yarn.lock、Python系等)なら `status: "unconfirmed"` として記録します。`hint` の手順でlockfileを生成してから再スキャンしてください(生成は信頼できる環境で)
  - `unpinned_requirements`: requirements.txtのうち、版を固定していない行。`kind` は `unpinned`(版の指定なし)・`range`(`>`、`<`、`!=`、`==1.*`、範囲の組み合わせ等)・`lower_bound`(`>=`、`~=`)。`unpinned` と `range` の行はOSV-Scannerがスキャンせず、`lower_bound` の行は下限の版を使用中の版とみなしてスキャンします(該当パッケージには `version_is_lower_bound: true` が付き、実際の版とは異なる可能性があります)
  - `unscannable_requirements`: スキャンされない行と理由。`-e`、`name @ URL`、パス指定、展開しなかった取り込み(プロジェクトディレクトリの外・存在しない・URL・上限超過)、制約ファイル(`-c`、適用しません)、解釈できないオプションや版の指定。解釈できない行は無視せず、ここに記録します
  - `skipped_files`: スキャン対象から外したファイルと理由(requirements.txt自体が読めない・1MiBを超える場合、`pom.xml` の親POMが許可ルートの外を参照する場合)。親POMを読めず、親POMを含めずにスキャンした `pom.xml` もここに理由付きで示します([親POMの扱い](#親pomの扱い)を参照)
  - 各一覧は200件までで、超えた分の件数を `omitted_items` に返します
- `ecosystem_breakdown` は、脆弱性0件のエコシステムも含めて「スキャンした」ことを示します
- `dependency_relation` は直接依存(`direct`)か推移的依存(`transitive`)かを示します。OSV-Scannerの出力にはこの区別がないため、本サーバーがスキャンしたファイルのコピーを解析して判定します:
  - `package-lock.json`(v2以降): ルートとworkspaceのpackage.jsonの依存を、Nodeの解決規則(入れ子の `node_modules` から上位へ)で解決したものが直接依存、そこからたどれるものが推移的依存です。直接依存には宣言しているpackage.jsonを `declared_in` に、推移的依存にはそれを要求している直接依存の名前を `introduced_by`(最大10件、超えた分は `introduced_by_omitted`)に示します。直接依存でもあり他の依存からも要求される版は `direct` とし、`introduced_by` も付けます
  - `go.mod`: `// indirect` の無い `require` が直接依存です。`replace` で置き換えているモジュールには `replaced_in_go_mod: true` を付けます(OSV-Scannerは置換先のパスと版で報告します)
  - `requirements.txt`: ファイルに書かれた依存が直接依存、deps.devで解決された依存が推移的依存です
  - `pom.xml`: OSV-Scannerは、`pom.xml`(と親POM)に宣言された依存と、deps.devで解決された推移的依存を別々の結果(`source.type` が `lockfile` / `unknown`)に分けて報告するため、それで判定します(親POM・プロファイル・プロパティ・依存管理の解釈はOSV-Scannerと同じになります)。`introduced_by` / `declared_in` は付きません。この判定はOSV-Scannerの文書化されていない出力の形に依存するため、想定外の形の場合は `unknown` にします
  - 上記以外の形式(`gradle.lockfile`、`yarn.lock`、`pnpm-lock.yaml`、`bun.lock`、`poetry.lock`、`uv.lock`、`Pipfile.lock`、`pdm.lock`)と、lockfileVersion 1・どこからも要求されていないエントリは `unknown` です。複数のlockfileで判定が異なる場合は `mixed` です
- `dependency_groups` はOSV-Scannerが付けた依存グループ(例: `dev`)の生の値です。lockfileの形式によって欠落・不正確なため(pnpmでは付かず、pdmでは `optional` になる等)、参考情報として扱ってください
- 修正版の推奨(`suggest_fix`)はJava・JavaScript・Python・Goに対応しています

### `scan_java_project`

Java(Maven)プロジェクトをスキャンし、既知の脆弱性レポートを返します。

**入力**

| パラメータ | 型 | 説明 |
|---|---|---|
| `project_path` | string | スキャン対象のプロジェクトディレクトリ、または pom.xml / gradle.lockfile の絶対パス |

> **Gradleプロジェクトについて**: 本ツールは**lockfile方式**のみ対応です(ビルド実行方式は build.gradle の任意コード実行を伴うため、セキュリティ上の理由から採用していません)。`gradle.lockfile` が無い場合は `./gradlew dependencies --write-locks` で生成してください(依存ロック未設定の場合は `build.gradle` に `dependencyLocking { lockAllConfigurations() }` の追加が必要です)。

> **スキャン範囲**: ディレクトリを指定すると、配下の `pom.xml` / `gradle.lockfile` / `buildscript-gradle.lockfile` を深さに関係なく検出し、**検出したファイルだけ**をスキャンします(応答の `manifests` がそのままスキャン範囲です)。同じディレクトリにある `package-lock.json` や `requirements.txt` などJava以外のファイルはスキャンしません。`.git`、`node_modules`、`target`、`build`、`.idea`、`.vscode` とシンボリックリンクは探索しません。探索するエントリが20万件、またはマニフェストが1,000件を超える場合は、結果を黙って省略せず `manifest_search_limit_exceeded` を返します。`pom.xml` などのマニフェストを直接指定した場合は、ディレクトリを探索せず**そのファイルだけ**をスキャンします(上限に達した場合の回避手段としても使えます)。

#### 親POMの扱い

OSV-Scannerは `pom.xml` の `<parent>` が参照する親POM(`<relativePath>` の指すファイル。省略時はMavenの既定どおり `../pom.xml`)を読み、親の親もたどって、そこに書かれた依存を結果に含めます。サブモジュールだけをスキャンしても親から引き継いだ依存を検出できるのはこのためです。

`OSV_MCP_ALLOWED_ROOT` を設定している場合、親POMの連鎖のどこかが**許可ルートの外**のファイルを参照する `pom.xml` は、スキャン対象から外します(許可ルート外のファイルの内容を結果や照会先に出さないため)。外したファイルは応答の `skipped_manifests`(`scan_project` では `coverage.skipped_files`)に理由付きで示し、`scope_warning` で「検出0件でも安全とは判断しない」旨を伝えます。全件が外れた場合や、該当する `pom.xml` を直接指定した場合は `path_outside_allowed_root` を返します。

存在する親POMを読めない場合(10MiBを超える、名前付きパイプ等の通常のファイルでない、末尾がシンボリックリンク等)は、その `pom.xml` を親POMを含めずにスキャンし、親から継承する依存が欠ける可能性を応答の `incomplete_manifests`(`scan_project` では `coverage.skipped_files`、`coverage.complete` は `false`)に理由付きで示します。子の `pom.xml` に依存が無く `no_packages_found` になる場合も、エラーのメッセージに同じ理由を含めます。親POMが存在しない場合(ルートの `pom.xml` で既定の `../pom.xml` が無い等)は、元の配置でもOSV-Scannerは親を読まないため欠落として扱いません。

- 許可ルート内の親POMは従来どおり読みます(サブモジュールのスキャンは許可ルート内なら引き続き使えます)
- `<relativePath/>`(空)はローカルの親POMを参照しないため対象外です
- 親POMの指定は、OSV-Scanner(Go)のXMLの解釈に合わせて読みます。要素は名前空間の接頭辞に関係なく要素名で照合し(`<m:parent>` も親として扱う)、ルート要素の直下の `parent` だけを対象にし、文字参照を展開します
- XMLの仕様どおり、解析前に改行(CRLF・CR)をLFに正規化します
- 同じ解釈を保証できない場合は除外します: ルート直下の `parent` や `relativePath` が複数ある、CDATA・DOCTYPE・未知の実体参照・プロパティ参照(`${...}`)がある、タグが閉じていない、UTF-8として読めない、`relativePath` に制御文字(改行・タブ等)・通常の空白以外の空白・書式文字が含まれる(通常の空白や日本語のディレクトリ名は使えます)
- 親のGAVが一致しなければOSV-Scannerは読みませんが、本サーバーはGAVを確認せず、許可ルートの外に参照先のファイルがあれば安全側に除外します
- `OSV_MCP_ALLOWED_ROOT` が未設定の場合は任意の絶対パスをスキャンできる状態のため、この検証は行いません

**出力(成功時)**

```json
{
  "project_dir": "/path/to/project",
  "manifests": ["pom.xml"],
  "dependency_resolution": { "transitive_resolution": "enabled" },
  "source_files": ["/path/to/project/pom.xml"],
  "vulnerable_package_count": 4,
  "vulnerability_count": 14,
  "severity_breakdown": { "critical": 3, "high": 3, "medium": 7, "low": 0, "unknown": 1 },
  "packages": [
    {
      "name": "org.apache.logging.log4j:log4j-core",
      "version": "2.14.1",
      "ecosystem": "Maven",
      "vulnerabilities": [
        {
          "id": "GHSA-jfh8-c2jp-5v3q",
          "cve": "CVE-2021-44228",
          "aliases": ["CVE-2021-44228"],
          "severity_score": 10,
          "severity": "critical",
          "summary": "Remote code injection in Log4j",
          "fixed_versions": ["2.3.1", "2.12.2", "2.15.0"]
        }
      ]
    }
  ]
}
```

- `packages` は最も深刻な脆弱性を持つ順、各 `vulnerabilities` は深刻度順(unknownは末尾)
- `fixed_versions` はOSVに記載された修正版です。MavenはMaven優先順位、npm・GoはSemantic Versioningの優先順位で昇順(SemVerとして解釈できない表記は末尾)、PyPIはPEP 440の優先順位で昇順(v0.5.0以前は記載順)、その他のエコシステムはOSVの記載順のまま(並び順は保証しません)。複数のリリース系統(例: 2.12系バックポートと2.15系)が混在することがあります。プレリリース版(`5.0.0-beta.3`)やGoの疑似バージョン(`0.0.0-20180925071336-cf3bd585ca2a`)が含まれることもあります。空配列は「OSVに修正版の記載がない」ことを意味します。v0.4.1以前はMaven以外のパッケージで常に空配列を返していました
- `severity_score` が取得できない脆弱性は `null` / `"unknown"` として扱います

### `scan_java_artifact`

JAR/WARファイルの実体をスキャンします。既存のマニフェスト方式とは別ツールです。

```json
{ "artifact_path": "/absolute/path/to/application.war" }
```

`artifact_path` はJAR/WARファイル、または探索するディレクトリの絶対パスです。
ディレクトリ指定では `target` や `build` も探索します。`.git`、`node_modules`、`.idea`、`.vscode` と探索中のシンボリックリンクは除外します。
探索上限は深さ8・100ファイル・10,000エントリです。上限に達して探索を完了できない場合は、結果を黙って省略せず `artifact_search_limit_exceeded` を返します。対象を絞って再実行してください。
`OSV_MCP_ALLOWED_ROOT` による制限も適用されます。

OSV-Scanner 2.4.0の `java/archive` プラグインを使用し、ネストJARもスキャナー側で解析します。Javaコードやビルドは実行しません。
識別にはアーカイブ内メタデータを用いるため、除去済みメタデータやshaded/minimized JAR内の依存を見落とす場合があります。

**出力の読み方:**

- 先頭の `coverage` に `jars_found`、`jars_identified`、`unidentified_jars` を返します。件数はWARも含む、ファイルシステム上で列挙した外側のアーカイブ単位です。ネストJARの総数ではありません。
- `artifacts[].status` は `identified_with_vulnerabilities` / `identified_without_known_vulnerabilities` / `inferred_only` / `unidentified` の4値です。「同定済み」は少なくとも1件のMaven座標を取得できた意味であり、全依存の同定ではありません。`inferred_only` は推測した座標(下記)だけで同定したアーカイブで、脆弱性が見つかった場合も含め `jars_identified` に数えず、`unidentified_jars` に理由付きで示します(検出件数は `identified_vulnerability_count` に示します。推測の誤ったgroupIdで他の脆弱性を取りこぼしている可能性があるため)。
- **推測した座標**: `pom.properties` を含まないJAR(Spring Frameworkの本体JARなど)について、OSV-Scannerはファイル名等からMaven座標を推測し、groupIdを誤ることがあります(例: `spring-beans:spring-beans`。正しくは `org.springframework:spring-beans`)。誤った座標はOSVで照合されず、**既知の脆弱性を取りこぼします**(実例: zipkin-server 2.23.2 のfat JARに含まれる spring-beans 5.3.2 のSpring4Shell(CVE-2022-22965)は検出されません)。groupIdに `.` を含まない座標を推測とみなし、`coverage.inferred_coordinates`(件数・一覧・警告)と、該当パッケージの `coordinates_inferred: true` で示します。`commons-io:commons-io` のような古い形式の正しい座標も含まれます(安全側)。`.` を含む誤った推測(`com.sun.jna:jna` 等)は区別できません。正確な結果には、ビルド元のlockfile・`pom.xml` を `scan_project` でスキャンしてください
- `coverage.completeness` は常に `incomplete`。`identified_vulnerability_count: 0` は安全性の保証ではありません。
- `packages` は同定できた脆弱なパッケージの詳細です。複数アーカイブに含まれる同一パッケージ・脆弱性は全体集計では重複排除します。
- JAR/WARが無い場合は `no_scannable_artifacts`、全件同定不能の場合は警告を含む成功レポートです。

`suggest_fix` は引き続きマニフェスト方式専用です。experimentalプラグインを使うため、OSV-Scannerのピン留めバージョン更新時には、フラグとJAR/WARの出力形式も再検証してください。
信頼できないアーカイブの展開はOSV-Scannerのネイティブ処理に依存します。タイムアウト・出力上限はありますが、OSレベルのメモリ制限やサンドボックスを提供するものではありません。

### `scan_sbom`

既存のSBOMに記録された依存をOSV-Scannerで照会します。SBOMの生成、ビルド、JARの実行は行いません。

```json
{ "sbom_path": "/absolute/path/to/release-sbom.json" }
```

- **対応形式**: UTF-8 JSONのCycloneDX 1.4 / 1.5 / 1.6、SPDX 2.2 / 2.3。XML、SPDX tag-value、SPDX 3は未対応です。
- **入力**: 16MiB以下のローカル通常ファイルの絶対パス。ファイル名は任意で、内容から形式を判別します。CycloneDXは`components`、SPDXは`packages`配列が必要です。形式・主要構造の確認であり、仕様全体のJSON Schema検証ではありません。
- **識別情報**: CycloneDXの`components[].purl`、SPDXの`packages[].externalRefs`にバージョン付きPackage URLを含めてください。例: `pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1`。詳細は[OSV-Scanner公式ドキュメント](https://github.com/google/osv-scanner/blob/main/docs/scan-source.md)を参照してください。
- **安全な読み込み**: 許可ルートと読み込み中のサイズ上限を確認し、権限制限付きの一時コピーだけをスキャンします。元ファイルは変更せず、一時コピーは成功・失敗ともに削除します。スキャン中にサーバーが終了した場合(SIGTERM/SIGINT/SIGHUP、MCPクライアントがstdinを閉じた場合)も、一時コピーを削除し実行中のOSV-Scannerを止めてから終了します。

出力の先頭に`coverage`を返します。

- `identified_package_count`: スキャナーが識別した、名前・バージョン・エコシステムの重複を除いたパッケージ数。既知脆弱性がないものも含みます。
- `unidentified_packages`: スキャナー出力に存在したものの、バージョン等が不足しているパッケージ。スキャナー自体が読み飛ばした項目は列挙できないため、この配列が空でも全件検査を意味しません。
- `status`: 識別できたものがあれば`packages_identified`、なければ`no_packages_identified`。
- `completeness` / `artifact_match`: ともに`not_verified`。SBOMの依存網羅性や、実際のJARと同一ビルドのものかは自動検証しません。

`sbom`には元ファイルのパス・形式・仕様バージョン・スキャンに用いた入力バイト列のSHA256を返します。`identified_vulnerability_count`と`packages`には識別できた依存の検出結果を返します。**検出0件は「安全」の保証ではありません。** メタデータのないJARを補完するには、そのビルドに対応する正確なSBOMを別途用意してください。

不正JSONは`invalid_sbom`、未対応形式は`unsupported_sbom_format`、入力上限超過は`sbom_too_large`、存在しない・読み取れないファイルは`sbom_not_found`です。空のSBOMや識別できるパッケージがないSBOMは、警告付きの成功レポートになります。既存ツールと同じタイムアウト・出力上限・同時実行枠を使用します。

### `suggest_fix`

`scan_project` と同じ検出・スキャンを実行し、脆弱なパッケージごとに**推奨アップグレードバージョン**を提案します。推奨はJava(Maven / Gradle)・JavaScript(npm)・Python(PyPI)・Goに対応しています。単純な最大バージョンではなく、現在のバージョンに最も近いリリース系統の修正版を3段階フォールバックで選定します:

| Tier | 意味 |
|---|---|
| `same_minor` | 現在と同じ系統内の修正版(最小の変更で済む) |
| `major_internal` | 同一メジャー内の修正版(マイナーバージョンアップが必要) |
| `cross_major` | メジャーアップグレードが必要(破壊的変更の可能性あり) |

npm・Go・PyPIの「同じ系統」は、npmの `^`(キャレット)が互換とみなす範囲です(PyPIには共通の互換規則がありませんが、0.x系でマイナー更新が破壊的変更になるパッケージがあるため同じ規則で扱います。epochが変わる更新も `cross_major`)。1.0.0以上は Maven と同じく major.minor 単位ですが、0.x では同じ `0.minor` 内だけを同じ系統とし、マイナー更新(`0.3` → `0.4`)は `cross_major`、0.0.x ではどの更新も `cross_major` として扱います(SemVerでは0.xの更新は互換を保証しないため)。

**入力**: `scan_project` と同じ(`project_path`)

**出力(成功時)**

```json
{
  "project_dir": "/path/to/project",
  "manifests": ["pom.xml", "web/package-lock.json"],
  "dependency_resolution": { "transitive_resolution": "enabled" },
  "coverage": { "complete": true, "manifests": [ ... ], "lockfile_missing": [], "unpinned_requirements": [], "unscannable_requirements": [], "skipped_files": [] },
  "vulnerable_package_count": 4,
  "unfixed_vulnerability_count": 1,
  "suggestions": [
    {
      "package": "org.apache.logging.log4j:log4j-core",
      "current_version": "2.14.1",
      "ecosystem": "Maven",
      "recommended_upgrade": "2.25.4",
      "upgrade_tier": "major_internal",
      "verification": "verified",
      "upgrade_note": "取得済みの影響範囲に基づき修正対象CVEの範囲外と確認した候補です",
      "per_cve_detail": [
        { "id": "GHSA-jfh8-c2jp-5v3q", "cve": "CVE-2021-44228", "severity": "critical", "fixed_in": "2.15.0", "tier": "major_internal" }
      ]
    }
  ]
}
```

- `recommended_upgrade` は既知の修正版を候補に、修正対象の全CVEの影響範囲外と確認できたものを3段階Tier順・バージョン昇順で選びます。CVEごとの修正版の最大値を単純に採用せず、別系統で再び影響を受ける候補も除外します。全公開版の中での最小性や未検出の脆弱性がないことは保証しません。
- OSVの影響範囲(`introduced` / `fixed` / `last_affected` / 上限なし)を照合します。MavenはMavenの優先順位で `ECOSYSTEM` 範囲を、npm・GoはSemantic Versioningの優先順位で `SEMVER` / `ECOSYSTEM` 範囲を、PyPIはPEP 440の優先順位(`1.8c1` や `2.8.0-rc0` のような正規形でない表記も正規化)で `ECOSYSTEM` 範囲を使います。同じエントリに `ECOSYSTEM` 範囲があれば、コミット単位の `GIT` 範囲は無視します。`versions` に明示された影響も確認します(Gitのタグ名など版として解釈できない値は、解釈できる候補と一致しえないため無視します)。範囲欠落・不正・未対応形式(`GIT` 等)・`limit` による不完全な情報や、範囲の境界に解釈できない版(一部のGHSAに残る `19.03.9`、PyTorchの `2.6.0-cu124` のような表記)を含む場合は安全と推定せず、候補を検証できなければ `recommended_upgrade: null`、`verification: "no_verified_candidate"` を返します。
- プレリリース版(`5.0.0-beta.3`、`15.6.0-canary.61`、Goの疑似バージョン、PyPIの `rc`・`dev` 版。post版は正式版扱い)は、正式版の候補では全CVEを解消できない場合だけ推奨し、`recommended_is_prerelease: true` を付けます。同じTierのプレリリースより、上のTierの正式版を優先します。
- 推奨時は `verification: "verified"`、CVEごとの `recommended_status` は `affected` / `not_affected` / `unknown` です。推奨保留時は `not_evaluated` になります。`per_cve_detail.fixed_in` は各CVE単独の候補であり、最終推奨先の判定は `recommended_status` を参照してください。
- 現在より新しい修正版候補がないCVEは `tier: "unfixed"` として推奨の修正対象から除外します(情報欠落を含む場合があります)。除外したCVEも推奨先で判定し、その状態を表示します。全CVEがunfixedの場合も `recommended_upgrade` は `null` です。修正版の記載はあるがバージョンとして解釈できないCVE(SemVerでない `13.0` 等)は `tier: "unparseable_fix"` とし、修正版が無いとは扱わず修正対象に残すため、推奨は保留(`no_verified_candidate`)になります。
- npm・Go・PyPIの提案には更新方法の `update_hint` を付けます。PyPIでは、requirements.txtやpyproject.toml・Pipfileの指定を更新してlockfileを再生成し、推移的依存はpipの制約ファイル(`-c`)やuv・Poetryの上書き設定で版を指定します。Maven(`pom.xml` 由来)では、直接依存は `<dependency>` の版(親POM・プロパティ・BOMで管理していればそちら)、推移的依存は `<dependencyManagement>` での上書きを案内します。推移的依存の場合、npmでは要求している直接依存の更新か、ルートの `package.json` の `overrides`(ルートのプロジェクトでのみ有効)で版を指定します。Goでは `go get <module>@<version>` で更新できます。Goのv2以上のメジャーは別のモジュールパス(`/v2` 等)としてOSV上も別パッケージになるため、新しいメジャー系列の修正版は候補に含まれません。現在の版が疑似バージョン(タグのないコミット)の場合は `upgrade_note` に示します。
- **推奨先のOSV照会**: 推奨はスキャンで分かった脆弱性(現在の版に該当するもの)の範囲だけで検証しているため、推奨先に現在の版には該当しない新しい脆弱性がありえます(例: cryptography 3.2 の推奨候補 49.0.0 は、44.0.0 で混入し 50.0.0 で修正された2件に該当)。そこで推奨先を `api.osv.dev` に照会し、該当する脆弱性があれば、それも避けるよう修正版を候補に加えて選び直します(この例では 50.0.0 を推奨し、`upgrade_note` に理由を示します)。結果は `candidate_check` に示します:
  - `clean`: 推奨先に該当する既知の脆弱性はありません
  - `has_known_vulnerabilities`: 避けられる修正版の候補が見つからず、推奨先が既知の脆弱性に該当します(`recommended_known_vulnerabilities` にID)
  - `conflict`: OSVが、スキャンした脆弱性に候補が該当すると返しました(手元の範囲情報との食い違い)。他に候補がないため推奨を保留します(`recommended_upgrade: null`、`verification: "no_verified_candidate"`)
  - `failed`: 照会に失敗したか、応答の形式が不正でした(推奨はスキャンした脆弱性に対して検証済みのまま返します)
  - `skipped`: 照会回数の上限(1パッケージ4回、1回の呼び出しで合計60回)のため照会していません
  - `disabled`: `OSV_MCP_NO_CANDIDATE_CHECK=1` で無効化されています
  
  照会するのは推奨を出したパッケージだけで、送るのはスキャンで既に照会したパッケージの名前と、推奨候補の版です。OSVの判定が手元の範囲情報と食い違う候補(スキャンした脆弱性に該当と返る候補)は推奨しません。不正な応答(オブジェクトでない応答・レコード、文字列でないページトークン)は「該当なし」とは扱わず失敗とします。照会で見つかった脆弱性は現在の版の脆弱性ではないため、`per_cve_detail` には含めません。
- 各提案には `scan_project` と同じ `dependency_relation`(と `introduced_by` / `declared_in` / `replaced_in_go_mod`)を付け、`update_hint` を直接/推移的依存の別に応じて具体化します(npmの推移的依存なら `introduced_by` の直接依存の更新と `overrides`、Goの `replace` ならreplaceの版の更新、等)。`unknown` / `mixed` の場合は両方の場合を案内します。
- requirements.txtの `>=X` / `~=X` の行は、OSV-Scannerが下限Xを使用中の版とみなしてスキャンしています。この依存の提案には `version_is_lower_bound: true` を付け、推奨は「下限を推奨版以上に引き上げる」意味であること(実際にインストールされる版とは異なりうること)を `upgrade_note` に示します。
- 推奨に未対応のエコシステム(SBOM由来のRubyGems等)は `verification: "unsupported_ecosystem"`、現在の版をバージョンとして解釈できない場合(npmのgit・ローカルパス依存等)は `verification: "unparseable_version"` を返し、どちらもCVEごとの `tier: "unsupported"` として `unfixed` には数えません(修正版の有無は判定していないため。修正版は `scan_project` の `fixed_versions` や `explain_vulnerability` で確認できます)。
- 応答の `coverage` は `scan_project` と同じです。lockfileの無いマニフェストや外したファイルがあれば `complete: false` になり、それらの依存は提案に含まれません。v0.4.2以前の `skipped_manifests` / `scope_warning` は `coverage.skipped_files` / `coverage.warning` に統合しました。

### `explain_vulnerability`

指定したGHSA-ID / CVE-IDの脆弱性の詳細を**OSVデータベースAPI(api.osv.dev)から直接取得**して返します(スキャンは実行しません)。スキャン結果の `id` をそのまま渡せます。クライアントLLMの知識カットオフ以降に公開された脆弱性の説明に特に有効です。

**入力**

| パラメータ | 型 | 説明 |
|---|---|---|
| `vulnerability_id` | string | 脆弱性のID(例: `GHSA-jfh8-c2jp-5v3q`、`CVE-2021-44228`) |

**出力(成功時)**: `id` / `aliases` / `summary` / `details`(説明markdown、4,000字上限)/ `severity`(CVSSベクトル)/ `published` / `modified` / `affected`(影響パッケージとバージョン範囲)/ `references`(アドバイザリ・修正コミット等のURL、http/httpsのみ・20件上限)

> **注意**: OSVの正規IDはGHSA等のため、CVE-IDでは見つからない場合があります(その場合はエラーメッセージでGHSA-IDでの照会を案内します)。

**出力(エラー時)** — 全ツール共通

`isError: true` とともに、機械判読可能な `kind` を含むJSONを返します:

```json
{
  "error": {
    "kind": "no_manifest_found",
    "message": "対応マニフェスト(pom.xml / gradle.lockfile)が見つかりません: /path/to/project"
  }
}
```

| kind | 意味 |
|---|---|
| `binary_not_found` | OSV-Scannerが見つからない(インストール案内をmessageに含む) |
| `project_not_found` | 指定パスが存在しない・ディレクトリ/pom.xmlでない |
| `permission_denied` | Nodeの権限モデル(`--permission`)でファイルの読み書きが許可されていない(メッセージに不足している許可と対象のパスを示します。[権限を絞って起動する](#権限を絞って起動する)を参照) |
| `no_manifest_found` | 対応マニフェスト(pom.xml / gradle.lockfile)が見つからない |
| `scan_input_too_large` | スキャン対象ファイル(一時ディレクトリへのコピー)の合計サイズが上限(2GiB)を超えた。対象を絞って再実行する |
| `manifest_search_limit_exceeded` | マニフェスト探索が上限(20万エントリ・1,000マニフェスト)に達した。より狭いディレクトリかマニフェストを直接指定する |
| `binary_download_failed` | バイナリのダウンロード失敗(未対応プラットフォーム含む) |
| `binary_checksum_mismatch` | ダウンロードしたバイナリのチェックサム不一致(改ざん/破損の可能性) |
| `gradle_lockfile_missing` | Gradleプロジェクトだがgradle.lockfileが無い(生成手順をmessageで案内) |
| `path_outside_allowed_root` | `OSV_MCP_ALLOWED_ROOT` の外を指している(マニフェストの親POMが許可ルートの外を参照し、スキャンできるマニフェストが残らない場合を含む) |
| `no_packages_found` | スキャン対象パッケージなし(依存関係が未定義のpom.xml等) |
| `scan_failed` | OSV-Scannerが異常終了(stderr抜粋を`detail`に含む) |
| `scan_timeout` | タイムアウト(デフォルト120秒) |
| `too_many_concurrent_scans` | 同時実行スキャン数が上限(デフォルト2)に達している。完了を待って再試行 |
| `output_too_large` | 出力がサイズ上限(デフォルト32MB)を超過 |
| `invalid_output` | 出力がJSONとして解釈できない |
| `invalid_vulnerability_id` | 脆弱性IDの形式が不正 |
| `vulnerability_not_found` | 指定IDの脆弱性がOSVデータベースに存在しない |
| `api_request_failed` | OSV APIへのリクエスト失敗(ネットワーク・タイムアウト・非2xx) |
| `internal_error` | 想定外のエラー(内部情報は返しません) |

## セキュリティ設計

脆弱性診断ツール自体が攻撃経路にならないよう、以下を実装しています。

- **サプライチェーン対策**: バイナリの自動ダウンロードは公式GitHub Releasesに限定し、バージョンをピン留め。**パッケージに埋め込まれたSHA256チェックサム**で検証します(配布元のSHA256SUMSファイルは信用しないため、リリース側が改ざんされても検出可能)。検証合格まで実行権限を与えず、キャッシュ済みバイナリも使用のたびに再検証します。`OSV_MCP_PREFER_DOWNLOAD=1` でPATH上の未検証バイナリを使わない運用も選べます
- **コマンドインジェクション対策**: シェルを経由しない `spawn` + 引数配列で実行。OSV-Scannerへの引数は固定リストのみで、可変部は検証済み絶対パス1つだけ
- **スナップショット方式(検査と読み込みの不一致の防止)**: OSV-Scannerには元のファイルを一切渡しません。lockfile・`pom.xml`(親POMの連鎖を含む)・JAR/WARは、本サーバーが安全に1回だけ読んだ内容を専用の一時ディレクトリ(所有者のみアクセス可、終了時に削除)へコピーしてスキャンし、検査もそのコピーに対して行います。検査の後で元のファイルやディレクトリを差し替えても結果には影響しません。親POMは元の配置を一時ディレクトリ内に再現してコピーするため、OSV-Scannerが相対パスで親をたどっても、見つかるのは検証してコピーしたファイルだけです(`..` を重ねて一時ディレクトリの外に届く参照は除外)。読み込みは末尾のシンボリックリンクをたどらず、名前付きパイプ等の通常のファイル以外は読まず(処理が止まらない)、読み終えた後にパスを解決し直して境界の内側かつ開いた実体と同じファイルかを確認します。コピーの合計サイズは2GiBまでです(超えると `scan_input_too_large`)。SIGKILL等の捕捉できない終了で残った一時ディレクトリは、次回以降の起動時に削除します(名前が本サーバーの接頭辞に完全一致し、自分が所有する実体のディレクトリで、最終更新から24時間以上経過したものだけ。シンボリックリンクはたどりません)
- **パストラバーサル対策**: 入力パスは `realpath` でシンボリックリンク解決後に境界チェック。pom.xml探索ではシンボリックリンクを辿りません。OSV-Scannerにはディレクトリを渡さず、検出したマニフェストだけを形式を明示して個別に渡します(ディレクトリを渡すと、OSV-Scannerが同じディレクトリの `requirements.txt` も読み、その取り込み指定 `-r ../x.txt` でスキャン範囲の外のファイルを読むため)。`scan_project` でrequirements.txtをスキャンする場合は元ファイルを渡さず、解釈できた依存の行だけを正規化して書いた専用コピーをスキャンします。コピーには取り込み指定を含めないため、OSV-Scannerの取り込みの解釈と本サーバーの解析がずれても、範囲外のファイルは読まれません。`pom.xml` の親POMの連鎖が `OSV_MCP_ALLOWED_ROOT` の外を参照する場合は、その `pom.xml` をスキャン対象から外します([親POMの扱い](#親pomの扱い))
- **DoS対策**: タイムアウト・stdout上限・stderr抜粋上限を設定。スキャン結果は防御的にパースし、形式不正でも例外を投げません。同時実行スキャン数も上限(デフォルト2)を設け、並列リクエストによるプロセスの無制限起動を防ぎます。本サーバー自身の解析も、同じファイルは1回だけ読んで結果を使い回し(workspaceの収録確認でのlockfile、requirements.txtの共通の取り込み先、親POM)、読む量の合計に上限を設けます
- **fail-closedな運用モード**: `OSV_MCP_REQUIRE_ALLOWED_ROOT=1` で、スキャン許可ルート未設定時にサーバーの起動自体を拒否できます
- **通信先の固定と明示**: osv-scannerの依存解決先は `deps.dev` を明示指定し、スキャン対象のpom.xmlが指定する任意のリポジトリへ接続するモード(`--data-source native`)は使いません(テストで保証)。通信先の一覧と、deps.devへの送信を止める `OSV_MCP_NO_REMOTE_RESOLUTION=1` は[通信先とプライバシー](#通信先とプライバシー)を参照
- **情報漏えい対策**: 想定外の例外はスタックトレース等を含めず `internal_error` に丸めます。外部由来のテキスト(脆弱性summary等)は長さ上限付きの「データ」として構造化して返します
- **プロンプトインジェクション対策**: OSVデータベース由来のテキスト(summary / details / ID等)とOSV-Scannerのstderrは、LLMクライアントへ返す前にサニタイズします。制御文字(ANSIエスケープ含む)・ゼロ幅文字・双方向制御文字(RLO等)・Unicodeタグ文字(不可視のテキスト密輸)・行区切り(U+2028/2029)を除去し、NFC正規化を適用。外部データの読み取りアクセサを単一のサニタイズ境界にすることで適用漏れを防いでいます

## 開発

```bash
npm test                  # テスト実行(vitest)
npx vitest run --coverage # カバレッジ計測
npm run typecheck         # 型チェック
npm run build             # dist/ へビルド
```

設計メモ・残課題は [docs/DESIGN_TODO.md](docs/DESIGN_TODO.md) を参照してください。

## ロードマップ

- [x] `suggest_fix` ツール: 現在のバージョンに最も近い系統の修正版を提案(3段階Tierフォールバック)
- [x] `explain_vulnerability` ツール: 脆弱性の詳細説明(OSV API経由)
- [x] npmパッケージ化(`npx osv-scanner-mcp`)
- [x] OSV-Scannerバイナリの自動ダウンロード(チェックサム検証付き)
- [x] Gradle対応(lockfile方式)
- [x] `scan_java_artifact` ツール: JAR/WAR実体スキャン(lockfileが無い・shaded/fat JARのみのプロジェクト向け)
- [x] `scan_project` ツール: Java / JavaScript / Python / Go のlockfileをまとめてスキャン
- [x] `suggest_fix` のJavaScript / Go対応(semver)
- [x] `suggest_fix` のPython対応(PEP 440)
- [x] 直接/推移的依存の区別(npm・Go・requirements.txt)

## ライセンス

[Apache License 2.0](LICENSE)
