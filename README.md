# OSV-Scanner-MCP

[![CI](https://github.com/tedorigawa001/OSV-Scanner-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/tedorigawa001/OSV-Scanner-MCP/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/osv-scanner-mcp)](https://www.npmjs.com/package/osv-scanner-mcp)
[![license](https://img.shields.io/npm/l/osv-scanner-mcp)](LICENSE)
[![node](https://img.shields.io/node/v/osv-scanner-mcp)](package.json)

An MCP server that wraps Google's [OSV-Scanner](https://github.com/google/osv-scanner). Ask an MCP client such as Claude to "check this project for vulnerabilities", and it returns the known vulnerabilities (CVE / GHSA) in your dependencies as a report sorted by severity, together with recommended upgrades.

> **Status**: [Published on npm](https://www.npmjs.com/package/osv-scanner-mcp) (`npx -y osv-scanner-mcp`). Supports lockfiles and manifests for Java (Maven / Gradle), JavaScript (npm / yarn / pnpm / bun), Python (Poetry / uv / Pipenv / PDM / requirements.txt), Go, Rust (`Cargo.lock`), and .NET (NuGet: `packages.lock.json`, `obj/project.assets.json`, `packages.config`, `*.deps.json`, and project files), and PHP (Composer: `composer.lock`), with upgrade recommendations for Maven, npm, PyPI, Go, crates.io, Packagist, and NuGet. Setup instructions are provided for Claude Code, Claude Desktop, Codex CLI, Antigravity, and VS Code (GitHub Copilot).

## Features

- **PHP / Composer (source checkout)**: `scan_project` scans `composer.lock`, including both `packages` and `packages-dev`, as Packagist packages. `suggest_fix` recommends release versions and checks candidates against OSV. Composer and PHP code are never executed. See [Composer support](#composer-support).
- **One-shot multi-language scan**: Pass a project path to `scan_project`, and it detects and scans the Java, JavaScript, Python, Go, Rust, .NET, and PHP lockfiles in the project together. Dependencies that could not be scanned (for example, a manifest without a lockfile or an unpinned requirement) are reported up front in `coverage`
- **Upgrade recommendations**: `suggest_fix` recommends, for each vulnerable package, the upgrade closest to the current release line that addresses its fix targets, for Maven, npm, PyPI, Go, Rust (crates.io), PHP (Packagist), and .NET (NuGet). Known unfixed and informational advisories remain visible. The recommended version is also checked against the OSV database for additional fix-target vulnerabilities
- **Rust without false positives**: For `Cargo.lock`, only crates from crates.io are scanned. Your own workspace crates, git dependencies, and crates from private registries are not looked up as crates.io crates (OSV-Scanner alone would match them by name, and send their names to the OSV API). RustSec notices about unmaintained or unsound crates are labeled `informational` and counted apart from vulnerabilities
- **.NET without guessing versions**: Each project file is matched to its own lockfile or `obj/project.assets.json`. Without one, only its direct `PackageReference` items are scanned, and a `Version="x"` (which means x or higher) is reported as a lower bound. References whose version cannot be known without running MSBuild (properties, conditions, floating versions, `Update` / `Remove`) are listed instead of being looked up: OSV treats an unparsable version as older than every release and would report every vulnerability for it
- **Direct and transitive dependencies**: Packages are marked as direct or transitive dependencies (from `package-lock.json`, `go.mod`, `requirements.txt`, `pom.xml`, `Cargo.lock`, and the .NET files), and update hints are tailored accordingly, for example by naming the direct dependency that pulls in a transitive one
- **Java project scan**: `scan_java_project` scans only the Java (Maven / Gradle) manifests and returns a formatted report
- **JAR/WAR scan**: `scan_java_artifact` detects known vulnerabilities from the metadata inside JAR/WAR archives, for projects without a lockfile or with only shaded/fat JARs (best-effort identification, stated explicitly in `coverage`)
- **SBOM scan**: `scan_sbom` checks the dependencies recorded in a CycloneDX/SPDX JSON SBOM. It states explicitly that the SBOM's completeness and its match with the actual artifacts are not verified
- **Scan history (opt-in)**: With `OSV_MCP_HISTORY=1`, each scan is recorded locally, and `scan_history` lists past runs and shows what changed since the previous run (new and resolved vulnerabilities, version changes, coverage changes)
- **Severity-sorted reports**: Vulnerabilities are grouped by package and sorted by CVSS score, with five severity labels (critical / high / medium / low / unknown) and summary counts
- **Fixed versions**: Each vulnerability includes `fixed_versions`, sorted correctly by Maven version precedence (including non-semver forms such as `2.17.1-RELEASE`), Semantic Versioning precedence for npm, Go, and Rust, PEP 440 for PyPI, Composer ordering for Packagist, and NuGet ordering for NuGet
- **Security first**: No shell execution, a fixed argument allowlist, path normalization and boundary checks, scanning private copies instead of the original files, and timeouts and output size limits are built in

## Composer support

Pass a project directory, `composer.lock`, or `composer.json` to `scan_project` or `suggest_fix`. Direct/transitive dependency analysis (source checkout) uses the companion `composer.json` in the lockfile's own directory. A `composer.json` without a lockfile in the same directory is reported as missing/unconfirmed in `coverage.lockfile_missing` (a project with no scannable files returns `no_manifest_found`). An ancestor's lockfile does not establish coverage for an independent child project. `vendor` directories are not traversed.

The companion's `require` and `require-dev` are direct dependencies. Packages reachable through the locked packages' `require` are transitive; a dependency's own `require-dev`, `suggest`, and `conflict` are not dependency edges. Direct dependencies include their project-relative `composer.json` in `declared_in`. `introduced_by` names each direct root that transitively requires a package (up to 10, with the remainder in `introduced_by_omitted`). A direct dependency also required by another root remains direct and includes that root in `introduced_by`; cycles do not introduce a package through itself. Transitive dependencies do not have `declared_in`, since the root does not declare them directly.

This is name-based graph traversal of the lockfile, not a Composer constraint solver or freshness check. Duplicate installed names, virtual requirements, and references affected by `provide`/`replace` are not guessed; unreachable packages remain `unknown`. Local path and skipped branch entries may connect roots to scanned packages, but their names/metadata are still excluded from scanner input. No path-repository URL or nested package's composer.json is followed. Missing, malformed, symlinked, oversized, or otherwise unreadable companion manifests leave relationships unknown, with a `composer_warnings` note; locked release packages continue to be scanned. The companion is captured safely once (4 MiB per file), shares the Composer 64 MiB input/JSON structure budgets, and traversal/indexing share a 2,000,000-operation budget across all Composer lockfiles. Relationship uncertainty does not itself make dependency scan coverage incomplete.

The server reads each lockfile safely and scans a private sanitized copy containing only package names and release versions. Repository URLs, dist/source commit references, scripts, and credentials are not passed to OSV-Scanner. Both production and development packages are included. JSON is limited to 16 MiB per lockfile and 64 MiB per scan, with structural work limits. Invalid JSON is excluded; invalid entries and unsupported versions are omitted and reported in `skipped_files`, making `coverage.complete` false.

Composer version comparison supports classical numeric releases with one to four components, an optional `v` prefix, and alpha/beta/RC/stable/patch suffixes (including their short forms). Branch/dev versions, aliases, and other formats such as date-based tags are not evaluated. An advisory with unsupported version boundaries cannot establish a verified fix. Upgrade tiers follow the existing cautious 0.x rules; they do not guarantee compatibility with your constraints or PHP runtime. Update the applicable constraints in `composer.json` and regenerate the lockfile in a trusted environment; check PHP and extension requirements first. The server does not run Composer or change project files.

Packages with `dist.type: "path"` are local code: they are excluded before building scanner input, so neither their names nor versions are sent to OSV. They are your own code, so they are counted in `coverage.local_composer_packages` (like `local_crates` and `local_projects`) and do not make `coverage.complete` false; their own dependencies are listed in `composer.lock` and scanned. This applies to both production and development dependencies, even when a local package uses the same name and release version as a public package.

**Privacy:** other private Composer package names and versions are also sent to `api.osv.dev`. A lockfile alone cannot establish whether a non-path package comes from public Packagist; same-name private packages and VCS forks can produce false positives. `coverage.composer_warnings` warns when scanned entries lack the standard `notification-url` (`https://packagist.org/downloads/`); this is a heuristic, not proof of origin. `coverage.complete` describes inspected dependency entries, not the lockfile's freshness or its match with `composer.json`, and does not verify the PHP runtime or extensions.

## Requirements

- Node.js >= 20.19 (development: Node.js 26.12.1, as specified in `.node-version`)
- The [OSV-Scanner](https://google.github.io/osv-scanner/) binary — **no manual installation needed**. If it is not found, a pinned version is downloaded from the official GitHub Releases and verified against a SHA256 checksum embedded in the package before use (cached in `~/.cache/osv-scanner-mcp/`)
  - A manually installed binary (on `PATH` or set with `OSV_SCANNER_PATH`) is used first
  - Set `OSV_MCP_AUTO_DOWNLOAD=0` to disable the automatic download
  - Set `OSV_MCP_PREFER_DOWNLOAD=1` to always use the verified downloaded binary instead of one on `PATH` (recommended for production)
  - The pinned version is osv-scanner 2.7.0. Its binary is cached in `~/.cache/osv-scanner-mcp/v2.7.0/`; directories of earlier versions (such as `v2.4.0/`) are no longer used and can be deleted
- Scans, `suggest_fix`, and `explain_vulnerability` access the network. Vulnerabilities are looked up in the OSV database (`api.osv.dev`), and **scanning `pom.xml` or `requirements.txt` also connects to deps.dev (`api.deps.dev`) to resolve transitive dependencies**. See [Network destinations and privacy](#network-destinations-and-privacy) for details and how to turn this off

## Setup

### Claude Code

```bash
claude mcp add osv-scanner -- npx -y osv-scanner-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

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

### Codex CLI

```bash
codex mcp add osv-scanner -- npx -y osv-scanner-mcp
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.osv-scanner]
command = "npx"
args = ["-y", "osv-scanner-mcp"]
startup_timeout_sec = 60   # allow time for the first npx package download
tool_timeout_sec = 300     # default is 60 seconds; allow for the binary download plus a scan (120 seconds by default)
```

> **Note**: Codex's MCP tool timeout defaults to 60 seconds, while this server's scan timeout defaults to 120 seconds. With the default, Codex may time out first on the first run (which downloads OSV-Scanner) or on larger projects. Raising `tool_timeout_sec` as above is recommended.

### Antigravity

Open **MCP Servers → Manage MCP Servers → View raw config** in the agent panel and add to `mcp_config.json` (same format as Claude Desktop):

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

### VS Code (GitHub Copilot)

```bash
code --add-mcp '{"name":"osv-scanner","command":"npx","args":["-y","osv-scanner-mcp"]}'
```

Or add to the workspace's `.vscode/mcp.json` (also available from **MCP: Add Server** in the Command Palette):

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

### From source

```bash
git clone https://github.com/tedorigawa001/OSV-Scanner-MCP.git
cd OSV-Scanner-MCP
npm install
npm run build
# When registering, use `node /path/to/OSV-Scanner-MCP/dist/index.js` instead of `npx -y osv-scanner-mcp`
```

### Environment variables

| Variable | Description |
|---|---|
| `OSV_SCANNER_PATH` | Explicit path to the osv-scanner binary. If unset, `PATH` is searched, then the binary is downloaded automatically. **If the path is invalid, the server fails instead of falling back** (to avoid running an unintended binary) |
| `OSV_MCP_ALLOWED_ROOT` | If set, scans outside this directory are refused (the boundary against path traversal). **Recommended.** An empty or whitespace-only value is treated as unset |
| `OSV_MCP_REQUIRE_ALLOWED_ROOT` | If `1` or `true`, the server refuses to start when `OSV_MCP_ALLOWED_ROOT` is not set (fail-closed mode for production) |
| `OSV_MCP_MAX_CONCURRENT_SCANS` | Maximum number of concurrent scans (default `2`, maximum `16`). Requests beyond the limit fail immediately instead of waiting |
| `OSV_MCP_AUTO_DOWNLOAD` | `0` or `false` disables the automatic binary download (enabled by default) |
| `OSV_MCP_PREFER_DOWNLOAD` | If `1` or `true`, always use the checksum-verified downloaded binary instead of osv-scanner on `PATH` (protects against a fake binary planted on `PATH`; an explicit `OSV_SCANNER_PATH` still takes precedence) |
| `OSV_MCP_NO_CANDIDATE_CHECK` | If `1` or `true`, `suggest_fix` does not query OSV about recommended versions (`candidate_check` is `disabled`, and recommended versions are not checked for known vulnerabilities that do not affect the current version) |
| `OSV_MCP_NO_REMOTE_RESOLUTION` | If `1` or `true`, transitive dependencies of `pom.xml` and `requirements.txt` are not resolved through deps.dev. **This stops only the requests to deps.dev; package names and versions are still sent to `api.osv.dev` for the vulnerability lookup.** Vulnerabilities in transitive dependencies are then not detected, and responses say so in `dependency_resolution.warning`. See [Network destinations and privacy](#network-destinations-and-privacy) |
| `OSV_MCP_HISTORY` | If `1` or `true`, records each scan in the local scan history (disabled by default). See [`scan_history`](#scan_history) |
| `OSV_MCP_HISTORY_DIR` | Absolute path of the history directory (default `$XDG_STATE_HOME/osv-scanner-mcp/history`, or `~/.local/state/osv-scanner-mcp/history`) |
| `OSV_MCP_HISTORY_MAX_ENTRIES` | Number of runs kept (default `500`, maximum `5000`). Older runs are deleted, and the total size is also capped at 100 MiB |

> **Recommendation**: The server works without `OSV_MCP_ALLOWED_ROOT`, but then any absolute path can be scanned. To prevent malicious instructions (prompt injection) from scanning unintended directories, set it to the root of your projects (for example `~/projects`). Pass it in the client configuration, for example `"env": {"OSV_MCP_ALLOWED_ROOT": "/Users/you/projects"}` (in Codex CLI's TOML, use a `[mcp_servers.osv-scanner.env]` section).

> **Recommended production configuration**: On shared servers, CI, and other production environments, set all three of the following:
> - `OSV_MCP_ALLOWED_ROOT=/root/of/scan/targets` — fixes the scan boundary
> - `OSV_MCP_REQUIRE_ALLOWED_ROOT=1` — refuses to start without a boundary (fail-closed)
> - `OSV_SCANNER_PATH=/absolute/path/owned/by/an/administrator` or `OSV_MCP_PREFER_DOWNLOAD=1` — fixes which binary is run, independent of `PATH`
>
> Check [Network destinations and privacy](#network-destinations-and-privacy) for where dependency information is sent. In every configuration, package names and versions are sent to `api.osv.dev` for the vulnerability lookup.

### Running with restricted permissions

As an additional layer of defense, you can limit what the server can read and write with Node's permission model (`--permission`). This is optional and does not change the default way of starting the server. `--permission` is available in Node 22.13, 23.5, and later (Node 20's experimental `--experimental-permission` has not been tested). Since `npx` cannot pass Node flags, start the server with `node` directly:

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
        "--allow-addons",
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

- Read access: the server itself (the directory containing `dist` and `node_modules`), the scan targets (`OSV_MCP_ALLOWED_ROOT`), the temporary directory, and the osv-scanner binary
- The temporary directory (`os.tmpdir()`, `$TMPDIR` on macOS) needs read access under **both the symlinked and the resolved path** (on macOS, `/var/folders/...` is a symbolic link to `/private/var/folders/...`). Write access is needed on the resolved path
- If you use the automatic download, also allow reading and writing the cache (`$XDG_CACHE_HOME/osv-scanner-mcp`, by default `~/.cache/osv-scanner-mcp`). Otherwise, set `OSV_SCANNER_PATH`
- If you enable the scan history (`OSV_MCP_HISTORY=1`), also allow reading and writing the history directory (`OSV_MCP_HISTORY_DIR`, or the default under `~/.local/state`). The server warns at startup if it is not allowed
- `--allow-child-process` is required to run osv-scanner. **osv-scanner runs as a child process and is not restricted by the permission model** (Node itself warns that this flag weakens the permission model). The impact is limited because osv-scanner only receives verified private copies, but use an OS-level mechanism such as a container if you need stronger isolation
- On macOS and Windows, `--allow-addons` is also required for the trusted Koffi native binding used to verify the path of an open file handle. Native code is outside Node's permission sandbox. On Linux, use `--allow-fs-read=/proc/self/fd` instead; `/proc` must be mounted. If the OS cannot verify the opened object, boundary-protected reads fail closed. Keep OS-level isolation when scanning in a stronger sandbox.
- If a required permission is missing, the server prints a warning to stderr at startup, and scans return `permission_denied` (naming the missing permission and the path)

### Network destinations and privacy

Destinations confirmed with osv-scanner v2.4.0 (2026-10-07) and v2.7.0, the pinned version (2026-10-15):

| Operation | Destinations | Information sent |
|---|---|---|
| Scanning `pom.xml` (`scan_project` / `scan_java_project` / `suggest_fix`) | `api.osv.dev`, **`api.deps.dev`** | Package names and versions. To resolve transitive dependencies, the names and versions of the dependencies declared in `pom.xml` (including internal packages) are sent to deps.dev |
| Scanning `requirements.txt` (`scan_project` / `suggest_fix`) | `api.osv.dev`, **`api.deps.dev`** | As with `pom.xml`, the names and versions of the listed dependencies are sent to deps.dev to resolve transitive dependencies. Package indexes given with `--index-url` and similar options are not contacted |
| Scanning lockfiles (`gradle.lockfile`, npm lockfiles such as `package-lock.json`, Python lockfiles such as `poetry.lock`, `go.mod`, `Cargo.lock`) | `api.osv.dev` | Package names and versions (lockfiles already list every dependency, so nothing is resolved remotely). For `Cargo.lock`, only crates from crates.io are sent: the names of your own crates, git dependencies, and private-registry crates are not sent (confirmed 2026-10-11). **For .NET, packages from private NuGet feeds are sent as well**: lockfiles do not record which feed a package came from, so they cannot be told apart (a `nuget.config` in the scanned directory that lists other sources adds a warning to `coverage.nuget_warnings`). The names of your own projects (`type: project` and so on) are not sent. **Git dependencies in npm lockfiles** (`package-lock.json`, `yarn.lock`, and so on) are looked up by their repository URL (ecosystem `GIT`) and commit, so the host name and path of a private git repository (for example `https://git.example.com/team/repo`) are sent (since osv-scanner 2.6.0) |
| `scan_java_artifact` / `scan_sbom` | `api.osv.dev` | Names and versions of the identified packages |
| `suggest_fix` checking recommended versions | `api.osv.dev` | The names of packages with a recommendation (already sent during the scan) and the candidate versions (published fixed versions). Disable with `OSV_MCP_NO_CANDIDATE_CHECK=1` |
| `explain_vulnerability` | `api.osv.dev` | The vulnerability ID |
| Automatic binary download (first run only) | GitHub (official Releases) | Nothing (downloads the pinned binary) |

Both api.osv.dev and deps.dev are operated by Google. **In every configuration, the names and versions of scanned packages are sent to `api.osv.dev` for the vulnerability lookup** (offline lookup is not supported).

- **To stop sending data to deps.dev**: Set `OSV_MCP_NO_REMOTE_RESOLUTION=1`. Transitive dependencies of `pom.xml` and `requirements.txt` are then not resolved, and only `api.osv.dev` is contacted. This stops only the requests to deps.dev; requests to OSV continue. Only the dependencies written in those files are scanned, so **vulnerabilities in transitive dependencies are missed**. Responses of `scan_project` / `scan_java_project` / `suggest_fix` show this as `transitive_resolution: "disabled"` in `dependency_resolution` with a warning, so it can be told apart from zero findings. To scan transitive dependencies without deps.dev, use lockfiles (`gradle.lockfile`, `poetry.lock`, and so on)
- **Arbitrary repositories are never contacted**: osv-scanner's `--data-source native` mode connects to any URL listed in `<repositories>` of the scanned `pom.xml` (a malicious `pom.xml` could make it contact an attacker's server). This server never uses that mode and sets `deps.dev` explicitly

## Tools

### `scan_project`

Detects the lockfiles and manifests in a project and scans the Java / JavaScript / Python / Go / Rust / .NET / PHP dependencies together. Package managers and builds are never run.

**Input**

| Parameter | Type | Description |
|---|---|---|
| `project_path` | string | Absolute path to the project directory, or to a supported lockfile or manifest (a file given directly is the only file scanned) |

**Supported files**

| Ecosystem | Files |
|---|---|
| Java (Maven) | `pom.xml`, `gradle.lockfile`, `buildscript-gradle.lockfile` |
| JavaScript (npm) | `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock` (text format) |
| Python (PyPI) | `poetry.lock`, `uv.lock`, `Pipfile.lock`, `pdm.lock`, `requirements.txt` (and variants such as `requirements-dev.txt`) |
| Go | `go.mod` |
| Rust (crates.io) | `Cargo.lock` (lockfile versions 1 to 4) |
| .NET (NuGet) | `packages.lock.json` / `packages.<project>.lock.json`, `obj/project.assets.json`, `packages.config` / `packages.<project>.config`, `*.deps.json`, and `*.csproj` / `*.fsproj` / `*.vbproj` (direct references only, when no lockfile matches) |
| PHP (Packagist) | `composer.lock` (`packages` and `packages-dev`; see [Composer support](#composer-support)) |

`.git`, `node_modules`, `target`, `build`, `.idea`, `.vscode`, `.venv`, `venv`, `site-packages`, `__pycache__`, `.tox`, `vendor`, `.cargo`, `bin` and `obj` in a directory that contains a .NET project file (build output of that project), and symbolic links are not searched. Only the detected files are passed to OSV-Scanner, each with its format given explicitly (`coverage.manifests` in the response is exactly the scan scope). The search limits are the same as for `scan_java_project`.

**`requirements.txt` files are not passed to OSV-Scanner as they are.** The server parses them, rewrites only the dependency lines it can interpret into simple forms such as `name==version`, and scans a private temporary copy (deleted after the scan). OSV-Scanner interprets include directives on its own (it even treats `- r ../x.txt`, with a space, as an include and reads files outside the scan scope), so the copy never contains include directives or options. Includes (`-r` / `--requirement`) are expanded by the server, and only when the included file is inside the project directory.

**`Cargo.lock` files are not passed to OSV-Scanner as they are either.** OSV-Scanner (v2.4.0 and v2.7.0) ignores where each package comes from and looks every package up as a crates.io crate, so a workspace crate, a git fork, or a private-registry crate with the same name and version as a vulnerable crates.io crate is reported as vulnerable, and its name is sent to the OSV API. The server parses `Cargo.lock` and scans a private copy that lists only the packages whose source is crates.io (`registry+https://github.com/rust-lang/crates.io-index` or `sparse+https://index.crates.io/`), like `cargo audit`. Packages replaced with `[replace]` are not scanned, because they are not used (the replacement is classified by its own source). The parser accepts only what Cargo writes; if a `Cargo.lock` contains anything else, the whole file is excluded and listed in `skipped_files` instead of being scanned partially. Cargo is never run.

**.NET files are not passed to OSV-Scanner as they are either.** OSV-Scanner (v2.7.0) looks the project's own projects in `*.deps.json` up as NuGet packages, and passes `.csproj` versions such as `$(Version)` or `[1.0,2.0)` to OSV as they are; OSV treats a version it cannot parse as older than every release, so every known vulnerability of the package is reported (confirmed 2026-10-23). The server parses every .NET file and scans a private copy in `packages.lock.json` format that lists only the packages it can look up. Neither `dotnet restore` nor MSBuild is run, and project files are never evaluated.

- **Matching per project file.** For each `*.csproj` / `*.fsproj` / `*.vbproj`, the first source confirmed to belong to it is used: `packages.<project>.lock.json`; `packages.lock.json` only when the directory has a single project file; neither, when the project sets `NuGetLockFilePath`; `packages.<project>.config` or `packages.config` under the same rule; then `obj/project.assets.json`, only when its `project.restore.projectPath` names this project file (projects in one directory share `obj`). A lockfile that cannot be matched to a project is still scanned, but no project counts as covered by it
- **Projects without a matching source** (including projects with no `PackageReference` of their own, since `Directory.Build.props` or the SDK can add references) are scanned from their direct `PackageReference` items only, and listed in `lockfile_missing` with `status: "direct_only"` (or `"unconfirmed"` when a lockfile exists but cannot be matched). Transitive dependencies are not scanned, so `complete` is `false`. Enable `RestorePackagesWithLockFile` to scan them
- **`PackageReference` versions.** `[x]` is looked up as x. `x`, `[x,)`, and `[x,y)` mean x or higher (NuGet prefers the lowest available version, which may be above x), so they are looked up at x and the packages are marked `version_is_lower_bound: true`. A lower bound that is excluded or missing, `$(...)`, `*`, and a missing version (central package management) are not looked up
- **References that might not apply are not looked up**: a `Condition` on the reference, its `ItemGroup`, or its `Version`; references inside `Choose` or `Target`; names that also have `Update` or `Remove` in the file, or in a `Directory.Build.props` / `Directory.Build.targets` in the scanned directory; names included more than once; and `VersionOverride`. They are listed in `unresolved_package_references` with the reason
- **Runtime packs** of self-contained apps in `*.deps.json` are looked up under their package names (the SDK writes them as `runtimepack.<name>`, which OSV does not match)
- **Not looked up from restore results**: entries of an unknown type, and versions that are not plain NuGet versions (listed in `unscannable_nuget_packages`). Your own projects are counted in `local_projects`
- XML (project files, `packages.config`, `nuget.config`) is read by a small parser that rejects `DOCTYPE`, entity declarations, and CDATA. JSON files use the same structural checks as the npm lockfiles (16 MiB per file). Up to 200,000 packages and 1,000 .NET files are looked up per scan; files beyond the limit are listed in `skipped_files`. A character reference that is not a valid character (such as `&#x110000;`) makes the file uninterpretable instead of failing the scan

**`package-lock.json` copies get a `resolved` URL where it is missing.** osv-scanner 2.7.0 treats entries without `resolved` as local packages and does not look them up, which would silently skip bundled dependencies (`inBundle`) and registry packages in lockfiles generated with npm's `omit-lockfile-registry-resolved=true`. The private copy that is scanned gets a public-registry URL for those entries (entries under `node_modules/` that are not links and have a plain version, and aliases such as `npm:lodash@4.17.20` in lockfile version 1), so they are looked up as before; the original file is not changed.

**npm JSON limits:** Normalization of `package-lock.json` and `npm-shrinkwrap.json` is limited to 16 MiB per file and 64 MiB per scan, for both input and output. Before parsing, JSON nesting is limited to 128 levels and structural markers (containers, commas, and colons outside strings) to 1,000,000 per file and 2,000,000 per analysis phase. Changed copies use compact JSON, with their size checked before serialization. A lockfile that exceeds these limits is scanned as it is, without filling in `resolved` (OSV-Scanner parses large lockfiles itself; the limits only bound this server's own parsing and rewriting), and it is listed in `coverage.skipped_files` with the reason, so `complete` is `false`: entries without `resolved` in it may not have been looked up. Workspace membership and dependency-relation lookups use the same structural checks and remain unconfirmed or unknown when limits are reached.

**Reading the output**

```json
{
  "project_dir": "/path/to/project",
  "dependency_resolution": { "transitive_resolution": "enabled" },
  "coverage": {
    "complete": false,
    "warning": "…",
    "manifests": [{ "path": "web/package-lock.json", "ecosystem": "npm", "format": "package-lock.json" }],
    "lockfile_missing": [{ "path": "svc/package.json", "ecosystem": "npm", "status": "missing", "hint": "…" }],
    "unpinned_requirements": [{ "file": "py/requirements.txt", "line": 2, "name": "Jinja2", "specifier": ">=2.0", "kind": "lower_bound" }],
    "unscannable_requirements": [
      { "file": "py/requirements.txt", "line": 4, "text": "-e git+https://…", "reason": "…" },
      { "file": "py/requirements.txt", "line": 5, "text": "-r ../shared/base.txt", "reason": "…" }
    ],
    "local_crates": 2,
    "unscannable_crates": [{ "file": "Cargo.lock", "name": "my-fork", "version": "1.0.0", "reason": "Git dependency: …" }],
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

- **Always check `coverage`.** If `complete` is `false`, some dependencies were not scanned, so zero findings does not mean the project is safe
  - `lockfile_missing`: manifests without a lockfile (`package.json`, `pyproject.toml`, `Pipfile`, `setup.py`, `build.gradle`, `Cargo.toml`, and so on). Not recorded if a lockfile of the same ecosystem is in the same directory. If there is only a lockfile in a parent directory, the manifest is not recorded only when `package-lock.json` (v2 or later) is confirmed to contain that directory (npm workspaces), when `pnpm-lock.yaml` (formats 5.3/5.4/6.0/9.0) contains its exact normalized importer path (pnpm workspaces; source checkout), when PDM locked local identity and captured workspace/path declarations can be confirmed (see below; source checkout), when Poetry locked path-package identity and exported child declarations can be confirmed (see below; source checkout), when uv local workspace identity and manifest membership can be confirmed (source checkout), when `bun.lock` contains its exact normalized workspace path (text formats 0/1/2; source checkout), when Yarn workspace membership and captured declarations can be confirmed (see below; source checkout), or when `Cargo.lock` contains a local crate with the `[package] name` of the `Cargo.toml` and the directory is a member of the workspace according to `members` / `exclude` of the `Cargo.toml` next to `Cargo.lock` (Cargo workspaces; `members` globs with `*` and `?` are supported). A crate with the same name that cannot be confirmed as a member, such as a path dependency outside the workspace, is recorded as `unconfirmed`. Library crates often do not commit `Cargo.lock`, so their `Cargo.toml` is recorded here; generate one with `cargo generate-lockfile`. Otherwise it is recorded with `status: "missing"`, or `status: "unconfirmed"` for formats that cannot be checked (unsupported Yarn layouts, Python lockfiles other than `uv.lock` / `poetry.lock` / `pdm.lock`, and so on). Generate the lockfile as described in `hint` (in a trusted environment) and scan again
  - `unpinned_requirements`: lines in `requirements.txt` that do not pin a version. `kind` is `unpinned` (no version), `range` (`>`, `<`, `!=`, `==1.*`, combined ranges, and so on), or `lower_bound` (`>=`, `~=`). OSV-Scanner does not scan `unpinned` and `range` lines, and scans `lower_bound` lines at the lower bound (those packages are marked `version_is_lower_bound: true` and may differ from the installed version)
  - `unscannable_requirements`: lines that are not scanned, with the reason: `-e`, `name @ URL`, paths, includes that were not expanded (outside the project directory, missing, URLs, or over the limits), constraint files (`-c`, not applied), and options or version specifiers that cannot be interpreted. Lines that cannot be interpreted are recorded here instead of being ignored
  - `local_crates` (only when a `Cargo.lock` was scanned): the number of crates without a source in `Cargo.lock` (workspace members and path dependencies). They are your own code and are not scanned; they do not make `complete` false. A third-party crate vendored as a path dependency is not scanned either (as with `cargo audit`)
  - `unscannable_crates` (only when a `Cargo.lock` was scanned): git dependencies (their versions do not correspond to crates.io releases) and crates from registries other than crates.io (a crate with the same name on crates.io may be a different crate). They are not scanned, so `complete` is false. Source URLs are not included in the response
  - `local_projects`, `unscannable_nuget_packages`, `unresolved_package_references`, `nuget_warnings` (only when a .NET file was found): see the .NET notes above. `nuget_warnings` notes lower bounds, a possibly stale `project.assets.json` (more than a minute older than its project file; smaller differences are ignored because a clone writes files in any order), references that cannot be checked from project files alone (SDK-implicit references and `Directory.Build.*` outside the scanned directory), and package sources other than nuget.org. Entries in `unscannable_nuget_packages` and `unresolved_package_references` make `complete` false
  - `skipped_files`: files excluded from the scan, with the reason (a `Cargo.lock` that cannot be interpreted with certainty, a `requirements.txt` that cannot be read or is larger than 1 MiB, or a `pom.xml` whose parent POM chain references a file outside the allowed root). A `pom.xml` scanned without its parent POM, because the parent could not be read, is also listed here with the reason (see [Parent POMs](#parent-poms))
  - Each list holds up to 200 entries; the number of omitted entries is returned in `omitted_items`
- `ecosystem_breakdown` includes ecosystems with zero findings, to show that they were scanned
- **Informational advisories (Rust)**: RustSec also publishes notices that are not vulnerabilities: `unmaintained` (the crate is no longer maintained), `unsound` (a soundness bug), and `notice`. Most have no fixed version. When every advisory in a group is such a notice (every related ID, including aliases, must have its details available and be a notice of a known kind; otherwise it is treated as a vulnerability), the vulnerability has `informational` set to its kind, is listed after the vulnerabilities of the package, and is counted in `informational_count` (and in `ecosystem_breakdown`) instead of `vulnerability_count`, `severity_breakdown`, and `vulnerable_package_count`. If another database (such as GitHub's) lists the same issue as a vulnerability, it stays a vulnerability. `informational_count` appears only when there is at least one
- `dependency_relation` shows whether a package is a direct (`direct`) or transitive (`transitive`) dependency. OSV-Scanner does not report this, so the server determines it from validated manifest data and scanned copies:
  - `package-lock.json` (v2 or later): dependencies of the root and workspace `package.json` files, resolved with Node's lookup rules (nested `node_modules` first, then parent directories), are direct; everything reachable from them is transitive. Direct dependencies list the `package.json` files that declare them in `declared_in`; transitive dependencies list the direct dependencies that require them in `introduced_by` (up to 10, with the rest counted in `introduced_by_omitted`). A version that is both a direct dependency and required by another dependency is `direct` and also has `introduced_by`
  - `go.mod`: `require` lines without `// indirect` are direct. Modules affected by a `replace` directive are marked `replaced_in_go_mod: true` (OSV-Scanner reports the replacement module and version)
  - `requirements.txt`: dependencies written in the file are direct; dependencies resolved through deps.dev are transitive
  - `pom.xml`: OSV-Scanner reports the dependencies declared in `pom.xml` (and its parent POMs) and the transitive dependencies resolved through deps.dev as separate results (`source.type` `lockfile` / `unknown`), and this split is used (so parent POMs, profiles, properties, and dependency management are interpreted exactly as OSV-Scanner does). `introduced_by` / `declared_in` are not available. This relies on undocumented OSV-Scanner output, so anything unexpected is reported as `unknown`
  - `Cargo.lock`: crates.io dependencies immediately required by a local/workspace/path crate are direct; crates.io dependencies reachable through them (including git and alternate-registry origins) are transitive. `introduced_by` names the first direct dependency on each path. References are resolved by exact name, version, and source where provided; ambiguous references are not guessed. Replacements are followed. `declared_in` lists project-relative Cargo.toml paths only when every declaring crate has a unique matching manifest. Otherwise `declaring_crates` names the unmapped declaring crates (up to 10, with the rest in `declaring_crates_omitted`). Dev/build/target-specific distinctions are unavailable. Traversal over 2,000,000 edges returns `unknown`
  - .NET: `Direct` / `Transitive` in `packages.lock.json`; the dependencies of `project.frameworks` in `project.assets.json`; the dependencies of the project library in `*.deps.json`; and every reference read from a project file are direct. `packages.config` does not say, so it is `unknown`. Origin/declaration enrichment is available in the source checkout as described below.
  - Composer (source checkout): the companion root's `require` / `require-dev` are direct, and locked `require` reachability establishes transitive dependencies. `declared_in` names the companion for direct dependencies; `introduced_by` lists transitively requiring direct roots. See [Composer support](#composer-support) for ambiguity and work limits.
  - `pnpm-lock.yaml` (source checkout): lockfile formats 5.3, 5.4, 6.0 and 9.0 are supported. Importer `dependencies`, `devDependencies` and `optionalDependencies` are direct, with the lockfile's declaring importer `package.json` paths in `declared_in`. Locked dependency and optional-dependency edges establish `introduced_by` and transitive reachability. Workspace importers, npm aliases, scoped packages, multiple origins and peer-context-specific snapshots are supported. A package that is both direct and transitively required remains direct and also lists its origins. Local/Git references, unresolved identities and unreachable packages do not establish relationships; links and source files are never followed. Declaration paths reflect the lockfile, not independently verified current manifests. Workspace coverage (source checkout) uses the exact normalized importer path relative to an ancestor pnpm-lock.yaml: included children are covered, absent importers are `missing`, and unsupported/malformed/ambiguous or analysis-limited importer metadata is `unconfirmed`. Empty importer maps and Unicode/space paths are supported. Importer presence does not prove freshness or agreement with current package.json dependencies. Only lockfiles found inside the selected scan directory are considered. Coverage and vulnerability scanning use the same captured lockfile bytes (16 MiB per file, 64 MiB total); unreadable or oversized inputs are skipped with a reason. Each lockfile is parsed with its own budget sized from its length (1,024 operations per KiB, at least 2,000,000), so files within the size limits are not rejected because other lockfiles were parsed first; importer indexing shares a 2,000,000-operation budget per detection, separate from relationship analysis. The lockfile is read from YAML's syntax tree in linear time (only strings, maps, and sequences; a 28,000-package lockfile takes about a second, a 16 MiB one about 3 seconds). Unsupported/malformed YAML, duplicate keys, anchors, aliases, tags, multi-document files, conservative nesting limits, more than 1,000,000 lines, inputs above 16 MiB, or more than 2,000,000 relationship operations per scan (shared by all pnpm lockfiles) leave relationships unknown; scanning continues. The existing shared relationship input byte limit and 10-origin output limit apply.
  - `yarn.lock` (source checkout): Classic v1 and Berry metadata versions 4/5/6/8 support direct/transitive relations, `introduced_by` and `declared_in`. Classic uses captured root/workspace `package.json` declarations; Berry uses exact locked descriptors and `workspace:` entries. Dependencies and optional dependencies are followed; peers are not independently guessed or installed. Multiple selectors, scoped/npm aliases, cycles, multiple roots and direct/transitive overlap are supported. Local/Git/patch/portal/virtual identities that cannot establish a registry release remain unknown and are never followed to source files.
  - `bun.lock` (source checkout): text formats 0/1/2 support direct/transitive relations, `introduced_by`, `declared_in` and workspace coverage. Locked workspace declarations are direct; dependencies, optional dependencies and installed peers are followed through exact package placement. Nested versions, scoped names, npm aliases, cycles and direct/transitive overlap are supported. Intentionally unresolved optional dependencies are not guessed from another installed package.
  - `uv.lock` (source checkout): version 1, revisions 0–5 support direct/transitive relations, `introduced_by`, `declared_in` and workspace coverage. Captured local workspace packages define roots from normal, optional and development-group dependencies. Registry identities resolve only when their normalized name and any locked version/source constraints identify a unique package. Optional edges are followed only for explicitly requested extras; unknown combinations of differing markers are not joined.
  - `poetry.lock` (source checkout): lock versions 1.1/2.0/2.1 support direct/transitive relations, `introduced_by`, `declared_in` and conservative child coverage. Captured root and confirmed local child `pyproject.toml` declarations establish direct roots; unique locked package names and unconditional string dependency edges establish transitive origins. Modern project dependencies/optional dependencies, Poetry dependency/dev/group tables and standard dependency groups are supported. Ambiguous names, conditional/optional edges requiring a solver, nonregistry releases and unreachable packages remain unknown.
  - `pdm.lock` (source checkout): 4.0–4.4 lock schemas and 4.5.0/4.5.1 support direct/transitive relations, `introduced_by`, `declared_in` and child coverage. Captured project dependencies, optional groups, standard dependency groups (including group includes) and legacy `tool.pdm.dev-dependencies` define roots, selected by `metadata.groups` when present. Explicit extras select exact locked extras identities; ambiguous names/versions/sources are not guessed. PDM-generated editable dev declarations (`-e file:///${PROJECT_ROOT}/...#egg=name`) use the explicit egg identity and exact safe locked local path. Unsupported declarations do not discard other known roots; an unsupported runtime declaration still prevents confirming child coverage.
  - Other formats (`gradle.lockfile` and `Pipfile.lock`), npm lockfile version 1, and entries not reachable from the project are `unknown`. If lockfiles disagree, the value is `mixed`

**PDM origins and child coverage (source checkout):** native `[tool.pdm.workspace].members` patterns (exact paths, `*`, `?`, whole-segment `**`, including dot directories) are checked against exact safe locked `path` identities. Explicit reachable local path dependencies can also establish inclusion. A matching name alone does not cover a child. Captured child name/version and exported runtime/optional declarations must agree with unique locked dependency identities; missing local directories are `missing`, while unreadable, unsupported, ambiguous or unverifiable declarations are `unconfirmed`. Unsupported glob syntax, child development groups and dynamic dependencies/optional-dependencies cannot establish complete child coverage. Other child markers (`setup.py`, `setup.cfg`, `Pipfile`) remain unconfirmed; same-directory locks retain the existing coverage convention. Group presence and membership do not constitute a full freshness check.

`declared_in` names captured root/confirmed-child `pyproject.toml` files. PEP 503 names, PEP 440 release comparison, multiple origins, cycles, direct/transitive overlap and distinct extras identities are supported. Dependency markers are not evaluated; differing expressions on the same traversal path are not joined. No PDM, plugin, build backend or project code runs during a scan. Local/Git/URL identities are not treated as registry releases by relationship analysis; local paths are never followed to read source files. Existing OSV communication and package-origin handling are unchanged. TOML parsing is bounded and locks are captured once for metadata and scanner input (16 MiB per file, 64 MiB total). Captured companions have separate 4 MiB/file, 64 MiB total limits. Coverage and relationships have separate shared 2,000,000-operation budgets; exhausting relationship analysis preserves confirmed membership. Unsupported metadata leaves relationships unknown while vulnerability scanning continues. `pylock.toml`, custom lock filenames and full constraint/environment solving are outside this support.

**Poetry origins and child coverage (source checkout):** Poetry path dependencies are used to check shared-lock monorepos. This does not assume uv-style workspace membership. A child must have an exact safe relative directory source in the ancestor lock, be reachable from captured root declarations, and match a unique locked local name/version. Its runtime/optional declarations must agree with unique locked dependency edges (matching constraint text or exact locked versions); unsupported constraints or source identities remain unconfirmed. A path dependency on another local package (including a sibling such as `../core`) agrees when the locked edge is an unconditional `{path, develop}` table resolving to that package's locked directory inside the lock directory. Child development groups are not exported by path packages and therefore make child coverage unconfirmed. Dynamic `project.dependencies` or `project.optional-dependencies` also leave child coverage unconfirmed because backend-generated declarations cannot be verified from captured TOML. An absent child directory is missing; unreadable/unsupported/ambiguous metadata is unconfirmed. Independent descendants with the same package name do not count as included. Legacy `setup.py`/`setup.cfg`/`Pipfile` children remain unconfirmed. A same-directory lock retains the existing coverage convention.

Root declarations include all supported development/optional groups, because scanning covers the universal lock. Unconditional string edges are followed even when the root or an intermediate package is marked optional; conditional or optional dependency tables still remain unresolved. Names use PEP 503 normalization and versions use PEP 440 comparison. No environment, extras or constraint solver is run; lock freshness is not globally verified. Declared paths come from safely captured companions, not from following arbitrary lockfile source paths. Poetry, plugins and build backends are never executed during scanning. Lock bytes are captured once for coverage, relationships and scanner input (16 MiB/file, 64 MiB total); companions have a separate 4 MiB/file, 64 MiB total budget. TOML preflight and independent shared 2,000,000-operation coverage/relationship budgets bound metadata analysis; exceeding only the relationship budget preserves confirmed coverage. Private-index exclusion is not established by this metadata analysis.

**uv origins and workspace coverage (source checkout):** local `editable`, `virtual` or `directory` paths are matched with `[manifest].members` names to confirm child workspace membership. A unique local root at `.` can be confirmed for single-project locks. A local path dependency alone does not establish workspace membership; a locked local package that is not a confirmed member (such as a path dependency), or missing or ambiguous membership evidence, remains unconfirmed, while a child absent from the lockfile is missing. Unicode/space paths and virtual projects are supported. Only `pyproject.toml` children are confirmed; legacy `setup.py`/`setup.cfg`/`Pipfile` markers remain unconfirmed against ancestor uv locks.

`declared_in` reflects locked workspace `pyproject.toml` paths; current source files and lockfile freshness are not compared. Names use PEP 503 normalization; explicit dependency versions use PEP 440 comparison and source identities are kept separate. No marker, Python-version, platform or package constraint solver is run. Different marker expressions on one path are conservatively left unresolved rather than joined, and unreachable/ambiguous packages remain unknown. Workspace groups and optional declarations are included because scanning covers the universal lockfile, not a selected environment. Local paths may be graph intermediates but are never followed to read or execute source files. uv and build backends are never executed during scanning.

The same safely captured bytes feed membership, relation metadata and the scanner. TOML parsing is bounded at 16 MiB per file / 64 MiB total with a conservative preflight limit of 128 container levels, 128 unquoted dots per line and a per-file structural-character budget sized from its length (1,024 per KiB, at least 2,000,000), so files within the size limits are not rejected for size alone; duplicate keys and unsupported schema are rejected for metadata analysis. Workspace indexing and graph traversal use separate shared 2,000,000-operation budgets, so relationship limits do not invalidate confirmed membership; a root declared by several members with the same extras and marker is traversed once. Unreadable/oversized files are skipped with a reason. Package origin and private index exclusion are not established by relationship analysis; existing OSV communication behavior is unchanged.

**Bun origins and workspace coverage (source checkout):** the exact normalized `workspaces` path in captured `bun.lock` establishes inclusion in an ancestor lockfile, including Unicode/space paths and empty entries. An absent child is `missing`; unsupported/malformed/duplicate/ambiguous or parse-limited data is `unconfirmed`. Declaration paths reflect the lockfile, not a comparison with current `package.json` contents, and do not establish freshness or compatibility. Package paths resolve from the declaring workspace/package toward the locked root while keeping scoped names intact; unsupported local/Git/tarball identities are barriers and are never followed to source files. Bun is not executed by the server.

JSONC parsing allows comments/trailing commas and rejects duplicate keys, syntax errors and nesting beyond 128 levels before constructing oversized structures. Captured lockfiles are limited to 16 MiB each / 64 MiB total. Each lockfile is parsed with its own budget sized from its length (1,024 operations per KiB, at least 2,000,000); workspace indexing and relation traversal have separate shared 2,000,000-operation budgets per scan; relation exhaustion leaves metadata unknown without changing confirmed coverage. Coverage and scanning use the same captured bytes. Unreadable/oversized files are skipped with a reason. Binary `bun.lockb` is unsupported; generate a text lockfile in a trusted environment with `bun install --save-text-lockfile --lockfile-only --ignore-scripts`. Only lockfiles inside the selected scan directory are considered.

**Yarn workspace coverage (source checkout):** Classic does not contain workspace importer records, so a captured private root's `workspaces` array (or `workspaces.packages`) must include the child and its captured dependency descriptors must resolve in the lockfile or to a uniquely named configured local workspace satisfying the requested SemVer range. Berry matches exact normalized `workspace:` resolution paths and checks captured dependency declarations against the locked workspace. Classic children need a nonempty name and usable version; manifests without them are not workspace members. Wildcards do not consume dot-prefixed path segments unless the pattern explicitly starts that segment with a dot. `*`, `?`, whole-segment `**`, exclusion patterns, one trailing `/` (as Yarn strips it), and Unicode/space paths are supported; other empty segments are unconfirmed; brace/extglob/character-class patterns remain unconfirmed. Independent children are missing; unreadable declarations, unresolved/ambiguous entries and analysis limits are unconfirmed. Coverage confirmation does not prove lockfile freshness or platform compatibility.

Yarn lockfiles and manifests are captured once within the selected scan boundary; coverage, relation metadata and scanning use those same inputs. Yarn is never run during a scan, and links, configuration plugins and source paths are not evaluated. Lockfiles are limited to 16 MiB each / 64 MiB total; captured package manifests to 4 MiB each / 64 MiB total with bounded JSON parsing. YAML nesting limits and a 1,000,000-line limit apply. Each lockfile is parsed with its own size-based budget (1,024 operations per KiB, at least 2,000,000); workspace coverage shares one 2,000,000-operation budget per scan, and relationship analysis has a separate 2,000,000-operation budget, so exceeding the relationship limit leaves relations unknown without making confirmed coverage unconfirmed. Unsupported metadata leaves relations unknown and membership unconfirmed; unreadable/oversized lockfiles are skipped with a reason. A selected lockfile alone does not cause child manifests or files outside the selected scan directory to be searched. Berry declaration paths may come from locked workspace entries when companions were not captured.

**NuGet origins and declarations (source checkout):** `introduced_by` follows dependency edges from direct NuGet packages in each locked TFM or assets/deps target separately, then merges origins only for the same package/version in the report. Case-insensitive IDs and equivalent normalized versions match. `packages.lock.json` and assets targets contain a resolved solution, so edges resolve a unique installed name within that target; dependency constraints are not solved again. `deps.json` edges additionally require an exact normalized version match. Multiple origins and cycles are supported; a root does not introduce itself. Duplicate/ambiguous names and unmatched target frameworks are not guessed. Local project nodes can be traversed but are not guessed as direct package origins and remain excluded from OSV input. `introduced_by` retains the existing 10-name limit and omitted count.

`declared_in` is added to direct packages only when the captured source is uniquely associated with a `.csproj`/`.fsproj`/`.vbproj` and that captured project contains an unambiguous, unconditional `PackageReference` for the ID. A missing/property/range/floating version can still identify the reference when the restore result confirms its direct package; version resolution continues to come from restore metadata. Conditional, removed, updated, or duplicated references are not guessed. The field names the reference's project file, not the storage location of its centrally managed version. Direct-only project scans also expose this path and preserve lower-bound/coverage warnings. A standalone selected lockfile/assets file without captured project evidence, an ambiguous shared lockfile, `packages.config`, and a deployed `deps.json` do not imply a project declaration path. Paths embedded in restore/build outputs are not followed to read source files.

Graphs and declarations use already captured, size-limited inputs, without running restore or MSBuild or forwarding graph metadata to OSV. A shared 2,000,000-operation relationship budget bounds indexing/traversal/declaration work across the scan. Exhaustion omits uncertain metadata and adds a NuGet warning; existing vulnerability scanning and direct/transitive classification continue. Neither dependency reachability nor declaration matching proves freshness, constraint satisfaction, or TFM/RID compatibility. Update hints in both tools name a confirmed declaring project or the direct package origins where available.
- `dependency_groups` is the raw dependency group reported by OSV-Scanner (for example `dev`). It is missing or inaccurate for some lockfile formats (absent for pnpm, `optional` for pdm, and so on), so treat it as informational
- Upgrade recommendations (`suggest_fix`) are available for Maven, npm, PyPI, Go, Rust (crates.io), PHP (Packagist), and .NET (NuGet; source checkout).

**NuGet recommendations (source checkout).** `suggest_fix` compares NuGet release versions with one to four numeric components (missing components become zero), including legacy revisions such as `1.2.3.4`. Numeric components must fit a nonnegative 32-bit integer; unsupported formats withhold a recommendation. Prerelease identifiers compare numerically when they fit signed 32-bit integers, and otherwise by ASCII case-insensitive lexical order, matching NuGet VersionRelease; numeric prerelease identifiers with leading zeroes are rejected. Build metadata does not affect ordering. Package IDs match case-insensitively. Recommendations use OSV `ECOSYSTEM` affected ranges and are rechecked against OSV; unsupported or incomplete ranges cannot establish a verified fix. Stable candidates are preferred; prerelease-only fixes are labeled. The existing cautious 0.x upgrade tiers apply.

For direct dependencies, update the `PackageReference` (or `packages.config` in older projects); with central management, update `PackageVersion` in `Directory.Packages.props`. For transitive dependencies, update the parent dependency or explicitly reference a compatible fixed version if NuGet resolution allows it. Runtime packs (`Microsoft.NETCore.App.Runtime.*`, `Microsoft.AspNetCore.App.Runtime.*`, `Microsoft.WindowsDesktop.App.Runtime.*`) generally require an SDK/runtime or target-framework update rather than a new explicit package reference. Check target-framework/RID compatibility and all version constraints, regenerate restore/lockfiles, and rescan. These are suggestions, not edits; `dotnet restore` and MSBuild are not run.

`PackageReference Version="x"` or an inclusive minimum range is scanned at its lower bound, not at a confirmed restored version. Its recommendation retains `version_is_lower_bound: true`, and the note means raising that bound. Coverage still records missing restore/lockfiles and unresolved references. Neither a verified affected-range check nor `candidate_check: "clean"` proves framework compatibility, availability on a private feed, or absence of unknown vulnerabilities.

### `scan_java_project`

Scans a Java (Maven) project and returns a known-vulnerability report.

**Input**

| Parameter | Type | Description |
|---|---|---|
| `project_path` | string | Absolute path to the project directory, or to a `pom.xml` / `gradle.lockfile` |

> **Gradle projects**: Only the **lockfile approach** is supported (running the build would execute arbitrary code in `build.gradle`, so it is not used for security reasons). If there is no `gradle.lockfile`, generate one with `./gradlew dependencies --write-locks` (if dependency locking is not configured, add `dependencyLocking { lockAllConfigurations() }` to `build.gradle`).

> **Scan scope**: For a directory, every `pom.xml` / `gradle.lockfile` / `buildscript-gradle.lockfile` below it is detected regardless of depth, and **only the detected files** are scanned (`manifests` in the response is exactly the scan scope). Non-Java files in the same directories, such as `package-lock.json` and `requirements.txt`, are not scanned. `.git`, `node_modules`, `target`, `build`, `.idea`, `.vscode`, and symbolic links are not searched. If the search visits more than 200,000 entries or finds more than 1,000 manifests, `manifest_search_limit_exceeded` is returned instead of silently truncating the results. When a manifest such as `pom.xml` is given directly, the directory is not searched and **only that file** is scanned (also useful as a workaround when the limits are reached).

#### Parent POMs

OSV-Scanner reads the parent POM referenced by `<parent>` in `pom.xml` (the file at `<relativePath>`, or `../pom.xml` by default as in Maven), follows the chain to its own parents, and includes the dependencies declared there. This is why scanning a submodule alone still detects the dependencies it inherits.

When `OSV_MCP_ALLOWED_ROOT` is set, a `pom.xml` whose parent POM chain references a file **outside the allowed root** at any point is excluded from the scan (so that the contents of files outside the allowed root never reach the results or the lookup services). Excluded files are listed with the reason in `skipped_manifests` (`coverage.skipped_files` in `scan_project`), and `scope_warning` says that zero findings should not be taken as safe. If every manifest is excluded, or such a `pom.xml` is given directly, `path_outside_allowed_root` is returned.

If an existing parent POM cannot be read (larger than 10 MiB, not a regular file such as a named pipe, a symbolic link at the final path component, and so on), the `pom.xml` is scanned without it, and the possibly missing inherited dependencies are reported with the reason in `incomplete_manifests` (`coverage.skipped_files` in `scan_project`, with `coverage.complete` set to `false`). If the child `pom.xml` itself declares no dependencies and the scan ends with `no_packages_found`, the error message includes the same reason. A parent POM that does not exist (for example the default `../pom.xml` of a root `pom.xml`) is not reported, because OSV-Scanner would not read it from the original location either.

- Parent POMs inside the allowed root are still read (scanning submodules inside the allowed root keeps working)
- `<relativePath/>` (empty) does not reference a local parent POM and is ignored
- The parent reference is read the way OSV-Scanner's (Go) XML decoder reads it: elements are matched by local name regardless of namespace prefix (`<m:parent>` counts as a parent), only a `parent` directly under the root element is used, and character references are expanded
- As the XML specification requires, line endings (CRLF and CR) are normalized to LF before parsing
- A `pom.xml` is excluded when the same interpretation cannot be guaranteed: multiple `parent` or `relativePath` elements directly under the root, CDATA, a DOCTYPE, unknown entity references, property references (`${...}`), unclosed tags, content that is not valid UTF-8, or a `relativePath` containing control characters (newlines, tabs, and so on), whitespace other than a regular space, or format characters (regular spaces and non-ASCII directory names are allowed)
- OSV-Scanner does not read a parent whose GAV does not match, but this server does not check the GAV and excludes any existing reference outside the allowed root, to stay on the safe side
- When `OSV_MCP_ALLOWED_ROOT` is not set, any absolute path can be scanned anyway, so this check is not performed

**Output (success)**

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

- `packages` is sorted by the most severe vulnerability, and each `vulnerabilities` list by severity (unknown last)
- `fixed_versions` lists the fixed versions recorded in OSV, in ascending order: by Maven precedence for Maven, Semantic Versioning precedence for npm, Go, and Rust (values that are not valid SemVer come last), PEP 440 for PyPI (in the order listed by OSV up to v0.5.0), Composer ordering for Packagist (since v0.17.0), and NuGet ordering for NuGet (since v0.18.0); other ecosystems keep the order listed by OSV (the order is not guaranteed). Several release lines may be mixed (for example a 2.12 backport and the 2.15 line). Pre-releases (`5.0.0-beta.3`) and Go pseudo-versions (`0.0.0-20180925071336-cf3bd585ca2a`) may be included. An empty array means that OSV lists no fixed version. Up to v0.4.1, this was always empty for packages outside Maven
- Vulnerabilities without a severity score are reported as `null` / `"unknown"`

### `scan_java_artifact`

Scans JAR/WAR archives themselves. This is a separate tool from the manifest-based scans.

```json
{ "artifact_path": "/absolute/path/to/application.war" }
```

`artifact_path` is the absolute path to a JAR/WAR file, or to a directory to search.
A directory search includes `target` and `build`, and excludes `.git`, `node_modules`, `.idea`, `.vscode`, and symbolic links.
The search is limited to a depth of 8, 100 archives, and 10,000 entries. If the search cannot complete within the limits, `artifact_search_limit_exceeded` is returned instead of silently truncating the results; narrow the target and try again.
`OSV_MCP_ALLOWED_ROOT` applies as well.

OSV-Scanner's `java/archive` plugin is used, and nested JARs are also analyzed by the scanner. No Java code is executed and no build is run.
Identification relies on metadata inside the archives, so dependencies whose metadata was removed, and dependencies inside shaded/minimized JARs, may be missed.

**Reading the output:**

- `coverage` comes first, with `jars_found`, `jars_identified`, and `unidentified_jars`. The counts are per outer archive found on the file system (including WARs), not the total number of nested JARs.
- `artifacts[].status` is one of `identified_with_vulnerabilities` / `identified_without_known_vulnerabilities` / `inferred_only` / `unidentified`. "Identified" means that at least one Maven coordinate was found, not that every dependency was identified. `inferred_only` is an archive identified only through inferred coordinates (see below). Even when vulnerabilities are found for it, it is not counted in `jars_identified` and is listed in `unidentified_jars` with a hint (its findings are shown in `identified_vulnerability_count`), because wrong inferred groupIds may hide other vulnerabilities.
- **Inferred coordinates**: For JARs without `pom.properties` (such as the main Spring Framework JARs), OSV-Scanner infers the Maven coordinates from file names and similar clues, and often gets the groupId wrong (for example `spring-beans:spring-beans` instead of `org.springframework:spring-beans`). Vulnerabilities are not matched for wrong coordinates, so **known vulnerabilities are missed** (for example, Spring4Shell (CVE-2022-22965) in spring-beans 5.3.2 inside the zipkin-server 2.23.2 fat JAR is not detected). Coordinates whose groupId contains no `.` are treated as inferred and reported in `coverage.inferred_coordinates` (count, items, and a warning), and the affected packages are marked `coordinates_inferred: true`. Correct old-style coordinates such as `commons-io:commons-io` are included as well (erring on the safe side). Wrong inferences that contain a `.` (such as `com.sun.jna:jna`) cannot be detected. For accurate results, scan the build's lockfile or `pom.xml` with `scan_project`
- `coverage.completeness` is always `incomplete`. `identified_vulnerability_count: 0` does not mean the archives are safe.
- `packages` lists the vulnerable packages that were identified. The same package and vulnerability found in several archives are counted once in the totals.
- If no JAR/WAR is found, `no_scannable_artifacts` is returned. If no archive can be identified, a successful report with a warning is returned.

`suggest_fix` remains manifest-based only. Because this tool uses an experimental plugin, the flags and the JAR/WAR output format must be re-verified whenever the pinned OSV-Scanner version is updated.
Extracting untrusted archives relies on OSV-Scanner's native code. There are timeouts and output limits, but no OS-level memory limit or sandbox is provided.

### `scan_sbom`

Looks up the dependencies recorded in an existing SBOM with OSV-Scanner. It does not generate SBOMs, run builds, or execute JARs.

```json
{ "sbom_path": "/absolute/path/to/release-sbom.json" }
```

- **Supported formats**: UTF-8 JSON CycloneDX 1.4 / 1.5 / 1.6 and SPDX 2.2 / 2.3. XML, SPDX tag-value, and SPDX 3 are not supported.
- **Input**: the absolute path to a local regular file of 16 MiB or less. Any file name is accepted; the format is detected from the content. CycloneDX requires a `components` array and SPDX a `packages` array. Only the format and main structure are checked, not the full JSON Schema.
- **Identification**: Include versioned Package URLs in CycloneDX `components[].purl` or SPDX `packages[].externalRefs`, for example `pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1`. See the [OSV-Scanner documentation](https://github.com/google/osv-scanner/blob/main/docs/scan-source.md) for details.
- **Safe reading**: The allowed root and the size limit (enforced while reading) are checked, and only a private temporary copy is scanned. The original file is never modified, and the copy is deleted on success and failure. If the server is terminated during a scan (SIGTERM/SIGINT/SIGHUP, or the MCP client closing stdin), the copy is deleted and the running OSV-Scanner is stopped before exiting.

`coverage` comes first in the output.

- `identified_package_count`: the number of distinct packages (by name, version, and ecosystem) identified by the scanner, including those without known vulnerabilities.
- `unidentified_packages`: packages present in the scanner output but missing a version or other information. Items the scanner itself skipped cannot be listed, so an empty array does not mean everything was checked.
- `status`: `packages_identified` if anything was identified, otherwise `no_packages_identified`.
- `completeness` / `artifact_match`: both `not_verified`. Whether the SBOM covers every dependency, and whether it matches the actual build, are not verified.

`sbom` returns the original file path, the format, the specification version, and the SHA256 of the bytes that were scanned. `identified_vulnerability_count` and `packages` contain the findings for the identified dependencies. RustSec informational advisories for crates in the SBOM are counted in `informational_count` instead (see `scan_project`). **Zero findings does not mean the software is safe.** To cover JARs without metadata, prepare an accurate SBOM for that build.

Invalid JSON returns `invalid_sbom`, an unsupported format `unsupported_sbom_format`, input over the size limit `sbom_too_large`, and a missing or unreadable file `sbom_not_found`. An empty SBOM, or one with no identifiable packages, returns a successful report with a warning. The same timeout, output limit, and concurrency limit as the other tools apply.

### `suggest_fix`

Runs the same detection and scan as `scan_project` and recommends an **upgrade version** for each vulnerable package. Recommendations are available for Java (Maven / Gradle), JavaScript (npm), Python (PyPI), Go, Rust (crates.io), PHP (Packagist / Composer), and .NET (NuGet; source checkout). Instead of simply taking the highest fixed version, it picks the fixed version closest to the current release line, falling back through three tiers:

| Tier | Meaning |
|---|---|
| `same_minor` | A fixed version in the same release line (the smallest change) |
| `major_internal` | A fixed version within the same major version (a minor upgrade) |
| `cross_major` | A major upgrade is needed (may include breaking changes) |

For npm, Go, PyPI, and Rust, the "same release line" is the range a caret (`^`) treats as compatible (PyPI has no common compatibility rule, but some 0.x packages make breaking changes in minor releases, so the same rule is used; a change of epoch is also `cross_major`). From 1.0.0 the line is major.minor, as for Maven. For 0.x, only the same `0.minor` is the same line, so a minor update (`0.3` → `0.4`) is `cross_major`, and for 0.0.x every update is `cross_major` (SemVer does not guarantee compatibility for 0.x updates).

**Input**: the same as `scan_project` (`project_path`)

**Output (success)**

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
      "dependency_relation": "direct",
      "recommended_upgrade": "2.25.4",
      "upgrade_tier": "major_internal",
      "upgrade_note": "…",
      "update_hint": "…",
      "candidate_check": "clean",
      "per_cve_detail": [
        { "id": "GHSA-jfh8-c2jp-5v3q", "cve": "CVE-2021-44228", "severity": "critical", "fixed_in": "2.15.0", "tier": "major_internal", "recommended_status": "not_affected" }
      ],
      "verification": "verified"
    }
  ]
}
```

- `recommended_upgrade` is chosen from the known fixed versions: the first candidate, in tier order and then ascending version order, that is confirmed to be outside the affected ranges of every vulnerability being fixed. It does not simply take the highest fixed version per CVE, and it excludes candidates that are affected again in another release line. It does not guarantee that the candidate is the smallest among all published versions, or that it has no undetected vulnerabilities.
- The OSV affected ranges (`introduced` / `fixed` / `last_affected` / open-ended) are checked: `ECOSYSTEM` ranges by Maven precedence for Maven, `SEMVER` / `ECOSYSTEM` ranges by Semantic Versioning precedence for npm and Go, and `ECOSYSTEM` ranges by PEP 440 for PyPI (non-canonical forms such as `1.8c1` and `2.8.0-rc0` are normalized). Events are sorted by version before evaluation, as in the OSV specification's evaluation algorithm. Commit-based `GIT` ranges are ignored when the same entry has an `ECOSYSTEM` range. Versions explicitly listed in `versions` are also checked (values that are not versions, such as Git tag names, are ignored, since they can never equal a valid candidate). If the information is incomplete (missing, malformed, or unsupported ranges such as `GIT`, `limit`, or range boundaries that cannot be parsed, such as `19.03.9` in some GHSAs or PyTorch's `2.6.0-cu124`), no candidate is assumed to be safe; if no candidate can be verified, `recommended_upgrade: null` and `verification: "no_verified_candidate"` are returned.
- Pre-releases (`5.0.0-beta.3`, `15.6.0-canary.61`, Go pseudo-versions, PyPI `rc` and `dev` versions; post-releases count as stable) are recommended only when no stable candidate fixes every vulnerability, and are marked `recommended_is_prerelease: true`. A stable version in a higher tier is preferred over a pre-release in a lower tier.
- When a version is recommended, `verification` is `verified`, and each CVE's `recommended_status` is `affected` / `not_affected` / `unknown` (`not_evaluated` when the recommendation is withheld). `per_cve_detail.fixed_in` is the candidate for that CVE alone; see `recommended_status` for the final recommendation.
- CVEs with no fixed version newer than the current one get `tier: "unfixed"` and are left out of the recommendation (the data may be incomplete). They are still evaluated against the recommended version, and the result is shown. If every CVE is unfixed, `recommended_upgrade` is `null` as well. A CVE whose fixed version is listed but cannot be parsed as a version (such as `13.0`, which is not SemVer) gets `tier: "unparseable_fix"`; it is not treated as unfixed but stays in the set to be fixed, so the recommendation is withheld (`no_verified_candidate`).
- Rust uses SemVer (`SEMVER` ranges) and Cargo caret compatibility: 0.x minor updates and 0.0.x patch updates are `cross_major`. `unmaintained` and `notice` advisories, and `unsound` advisories without a newer fixed version, remain in `per_cve_detail` with `tier: "informational"`, their kind, and `recommended_status`, but are not fix targets or counted as unfixed. An `unsound` advisory with a newer fixed version is a version-specific defect, so it is a fix target like a vulnerability (its tier is computed normally and it keeps `informational: "unsound"`). Packages with no fix target left return `verification: "informational_only"` without an upgrade. Unmaintained crates may need replacement; use `explain_vulnerability` for notices.
- Suggestions include an `update_hint`, tailored to whether the package is a direct or transitive dependency:
  - Maven (from `pom.xml`): for a direct dependency, update the `<dependency>` version (or the parent POM, property, or BOM that manages it); for a transitive dependency, override the version in `<dependencyManagement>` or update the direct dependency that requires it
  - npm (including pnpm): for a direct dependency, update the version in the `package.json` listed in `declared_in`; for a transitive dependency, update the direct dependency named in `introduced_by`, or use your package manager's root override configuration. Regenerate the lockfile and rescan.
  - Composer: for direct dependencies, update the constraint in `declared_in`; for transitive dependencies, update the direct roots in `introduced_by` or their constraints, then regenerate the lockfile with dependency updates allowed, scripts and plugins disabled. PHP and dependency compatibility still require verification.
  - Go: `go get <module>@<version>` (also for `// indirect` modules). For a module affected by `replace`, update the version in the `replace` directive instead of `require`. Major versions 2 and later use a different module path (`/v2` and so on) and are separate packages in OSV, so fixes in a newer major line are not included as candidates. If the current version is a pseudo-version (an untagged commit), `upgrade_note` says so
  - PyPI: update the version in `requirements.txt`, `pyproject.toml`, or `Pipfile` and regenerate the lockfile; for a transitive dependency, use a pip constraints file (`-c`) or the override settings of uv or Poetry
  - Rust: where version requirements permit it, `cargo update -p <crate>@<current> --precise <recommended>` updates the lockfile. Otherwise change the direct requirement in the declaring Cargo.toml or update the parent dependency in `introduced_by`. Cross-major upgrades may break compatibility, including 0.x updates. Pre-releases may require explicit `=<version>` requirements and must be allowed by transitive parents. Build metadata is omitted from `--precise`. `[patch.crates-io]` changes a source, not the allowed version range; backports must satisfy parent requirements. Check yanked versions, MSRV, and compiler compatibility. Cargo is never executed by the server
  - When the relation is `unknown` or `mixed`, both cases are described (no hint is given for Maven packages from `gradle.lockfile`)
- **Checking recommended versions against OSV**: Recommendations are verified only against the vulnerabilities found in the scan (those affecting the current version), so a recommended version could be affected by newer vulnerabilities (for example, cryptography 3.2's candidate 49.0.0 is affected by two vulnerabilities introduced in 44.0.0 and fixed in 50.0.0). The server therefore queries `api.osv.dev` about the recommended version, and if it is affected, adds those vulnerabilities to the set to be fixed and chooses again with their fixed versions as candidates (50.0.0 in this example, with the reason in `upgrade_note`). The result is reported in `candidate_check`:
  - `clean`: OSV reports no additional fix-target vulnerabilities after excluding known `unfixed` advisories, known informational advisories that are not fix targets, and new Rust `unmaintained` / `notice` records. These advisories may still apply; check `per_cve_detail[].recommended_status`. Newly discovered `unsound` records are added as fix targets
  - `has_known_vulnerabilities`: no candidate avoids them, so the recommended version has known vulnerabilities (IDs in `recommended_known_vulnerabilities`)
  - `conflict`: OSV reports that a candidate is affected by a vulnerability the scan had evaluated as not affecting it (the range data disagree), and no other candidate is available, so the recommendation is withheld (`recommended_upgrade: null`, `verification: "no_verified_candidate"`)
  - `failed`: the query failed or returned a malformed response (the recommendation, verified against the scanned vulnerabilities, is still returned)
  - `skipped`: the query limit was reached (4 queries per package, 60 per call)
  - `disabled`: disabled with `OSV_MCP_NO_CANDIDATE_CHECK=1`

  Only packages with a recommendation are queried, and only the package name (already sent during the scan) and the candidate version are sent. A candidate on which OSV and the local range data disagree is never recommended. A malformed response (a response or record that is not an object, or a page token that is not a string) is treated as a failure, not as "no vulnerabilities". Vulnerabilities found this way do not affect the current version, so they are not added to `per_cve_detail`.
- Each suggestion carries the same `dependency_relation` as `scan_project` (and `introduced_by` / `declared_in` / `replaced_in_go_mod`).
- `requirements.txt` lines with `>=X` / `~=X` are scanned by OSV-Scanner at the lower bound X. Their suggestions are marked `version_is_lower_bound: true`, and `upgrade_note` explains that the recommendation means raising the lower bound to at least the recommended version (the installed version may differ).
- Ecosystems without recommendation support (such as RubyGems from an SBOM) return `verification: "unsupported_ecosystem"`, and current versions that cannot be parsed (such as npm git or local path dependencies) return `verification: "unparseable_version"`. In both cases each CVE gets `tier: "unsupported"` and is not counted as unfixed (whether a fixed version exists is not evaluated; check `fixed_versions` in `scan_project` or `explain_vulnerability`).
- `coverage` is the same as in `scan_project`. If a manifest has no lockfile or a file was excluded, `complete` is `false`, and those dependencies are not included in the suggestions. The `skipped_manifests` / `scope_warning` fields of v0.4.2 and earlier were merged into `coverage.skipped_files` / `coverage.warning`.

### `scan_history`

Lists past runs of the scan tools (`scan_project`, `suggest_fix`, `scan_java_project`, `scan_java_artifact`, `scan_sbom`) and shows what changed between the last two runs. No scan is run.

**Recording is disabled by default**, because the history keeps package names and paths on disk. Enable it with `OSV_MCP_HISTORY=1` in the server's `env`; runs are recorded from then on. Without it, this tool returns `history_disabled`.

**Input**

| Parameter | Type | Description |
|---|---|---|
| `project_path` | string (optional) | A scanned target (project directory, lockfile, JAR/WAR, or SBOM). Filters the runs and adds `changes` |
| `limit` | number (optional) | Number of runs to list (default 10, maximum 50) |
| `run_id` | string (optional) | An `id` from `runs`. Returns the details of that run instead of the list |

**Output**

- `history`: the directory, `max_entries`, the number of matching runs (`recorded_runs`), and `skipped_records` if some files could not be read or were invalid
- `runs`: newest first, with `id`, `started_at`, `tool`, the target, `status` (`ok` or `error` with `error_kind`), `coverage_complete`, vulnerability counts, and `duration_ms`
- `changes` (with `project_path`): for each kind of scan (`project` for `scan_project` and `suggest_fix`, `java_project`, `artifact`, `sbom`), a comparison of the **last two successful runs**:
  - `new_vulnerabilities` / `resolved_vulnerabilities`: compared per package (ecosystem and name). A vulnerability is the same if its ID or any alias matches, so a change of the primary ID in OSV is not reported as new. A vulnerability that remains after a version change is neither new nor resolved
  - `reason` of a resolved vulnerability: `version_changed` (the package is still reported, at another version: `current_versions`), `package_not_reported` (the package is no longer in the results: it was upgraded to a version without known vulnerabilities, removed, or is no longer scanned; scan results list only vulnerable packages, so these cannot be told apart), or `same_version_not_reported` (same version, no longer reported, for example because the OSV data changed)
  - `version_changes`: packages whose versions changed, with `still_affected` (the vulnerabilities that remain)
  - `coverage_changes`: changes of `coverage.complete` and added or removed manifests
  - `incomplete`: set when the comparison is partial (a run exceeded the record size limit or the findings limit)
- `run` (with `run_id`): the details of one run, including its manifests, coverage gaps, severity breakdown, and the recorded packages and vulnerability IDs (up to 500 packages)

> **Note**: Changes are computed from the OSV data at the time of each scan, so they can also appear when only the vulnerability database changed.

**What is recorded**: one JSON file per run, with the tool, time, server and pinned OSV-Scanner versions, the target paths, coverage, counts, and the packages with their vulnerability IDs and aliases (and, for `suggest_fix`, the recommended versions). Vulnerability summaries, details, and error messages are not recorded. A run whose record would exceed 1 MiB keeps only the summary (`findings_omitted`), and if that is still too large, only part of its manifest list (`manifests_truncated`; manifest changes are then not compared). Target paths longer than 4,096 characters (longer than any path that can exist) are truncated and marked `target_truncated`.

**Storage and safety**:

- The directory is created with mode `0700` and files with `0600`. The server refuses a directory that is a symbolic link or is owned by another user (scans still succeed; a warning is printed to stderr)
- Each run is written to a temporary file and renamed, so concurrent server processes do not corrupt each other's records. Recording failures never fail the scan
- History files are treated as untrusted input: each is read with a size limit, validated, and its strings are sanitized before being returned
- When `OSV_MCP_ALLOWED_ROOT` is set, only runs whose target is inside the allowed root are returned, and a `project_path` outside it is refused with `path_outside_allowed_root`
- To delete the history, remove the directory

### `explain_vulnerability`

Returns the details of a vulnerability, given its GHSA or CVE ID, **fetched directly from the OSV database API (api.osv.dev)** (no scan is run). IDs from the scan results can be passed as they are. This is especially useful for vulnerabilities published after the client LLM's knowledge cutoff.

**Input**

| Parameter | Type | Description |
|---|---|---|
| `vulnerability_id` | string | The vulnerability ID (for example `GHSA-jfh8-c2jp-5v3q` or `CVE-2021-44228`) |

**Output (success)**: `id` / `aliases` / `summary` / `details` (markdown description, up to 4,000 characters) / `severity` (CVSS vectors) / `published` / `modified` / `affected` (affected packages and version ranges) / `references` (URLs of advisories, fix commits, and so on; http/https only, up to 20)

> **Note**: OSV's canonical IDs are GHSA and similar IDs, so a CVE ID may not be found (the error message then suggests querying with the GHSA ID).

**Output (error)** — common to all tools

Returns JSON with a machine-readable `kind`, together with `isError: true`:

```json
{
  "error": {
    "kind": "no_manifest_found",
    "message": "…"
  }
}
```

| kind | Meaning |
|---|---|
| `binary_not_found` | OSV-Scanner was not found (the message includes installation instructions) |
| `project_not_found` | The path does not exist, or is not a directory or a supported file |
| `permission_denied` | Node's permission model (`--permission`) does not allow the read or write (the message names the missing permission and the path; see [Running with restricted permissions](#running-with-restricted-permissions)) |
| `no_manifest_found` | No supported lockfile or manifest was found (for `scan_project`, the message includes how to generate missing lockfiles) |
| `manifest_search_limit_exceeded` | The manifest search reached its limits (200,000 entries or 1,000 manifests). Specify a narrower directory or the manifest itself |
| `no_scannable_artifacts` | No JAR/WAR archive was found (`scan_java_artifact`) |
| `artifact_search_limit_exceeded` | The JAR/WAR search reached its limits (depth 8, 100 archives, 10,000 entries). Narrow the target |
| `scan_input_too_large` | The total size of the files to scan (the copies in the temporary directory) exceeds the limit (2 GiB). Narrow the target |
| `sbom_not_found` | The SBOM file does not exist, is not a regular file, or cannot be read |
| `invalid_sbom` | The SBOM is not valid JSON or lacks the required structure |
| `unsupported_sbom_format` | The SBOM format or version is not supported |
| `sbom_too_large` | The SBOM exceeds the size limit (16 MiB) |
| `binary_download_failed` | The binary download failed (including unsupported platforms) |
| `binary_checksum_mismatch` | The downloaded binary's checksum does not match (possible tampering or corruption) |
| `gradle_lockfile_missing` | A Gradle project without `gradle.lockfile` (`scan_java_project`; the message explains how to generate it) |
| `path_outside_allowed_root` | The path is outside `OSV_MCP_ALLOWED_ROOT` (including when every manifest is excluded because its parent POM references a file outside the allowed root) |
| `no_packages_found` | No packages to scan (for example a `pom.xml` without dependencies) |
| `scan_failed` | OSV-Scanner exited abnormally (an excerpt of stderr is in `detail`) |
| `scan_timeout` | Timeout (120 seconds by default) |
| `too_many_concurrent_scans` | The concurrent scan limit (2 by default) was reached. Try again after the running scans finish |
| `output_too_large` | The output exceeds the size limit (32 MB by default) |
| `invalid_output` | The output could not be parsed as JSON |
| `invalid_vulnerability_id` | The vulnerability ID is malformed |
| `vulnerability_not_found` | No vulnerability with the ID exists in the OSV database |
| `api_request_failed` | The request to the OSV API failed (network, timeout, or a non-2xx response) |
| `history_disabled` | The scan history is disabled (`scan_history`; set `OSV_MCP_HISTORY=1`) |
| `history_unavailable` | The history directory cannot be used (for example a symbolic link or owned by another user) |
| `history_run_not_found` | No recorded run with the given `run_id` (or the ID is malformed) |
| `internal_error` | An unexpected error (no internal details are returned) |

## Security design

The following measures keep the vulnerability scanner itself from becoming an attack vector.

- **Supply chain**: The automatic download is limited to the official GitHub Releases and a pinned version, and is verified against **a SHA256 checksum embedded in the package** (the SHA256SUMS file from the release is not trusted, so tampering on the release side is detected). The binary is not made executable until it passes verification, and cached binaries are verified again on every use. `OSV_MCP_PREFER_DOWNLOAD=1` avoids unverified binaries on `PATH`
- **Command injection**: Commands are run with `spawn` and an argument array, never through a shell. OSV-Scanner receives only a fixed list of arguments, plus verified absolute paths
- **Snapshots (no gap between checking and reading)**: OSV-Scanner never receives the original files. Lockfiles, `pom.xml` (including the parent POM chain), and JAR/WARs are read safely once, copied into a private temporary directory (accessible only by the owner, deleted afterwards), and the copies are both checked and scanned. Replacing the original files or directories after the check has no effect on the results. Parent POMs are copied into the temporary directory at their original relative positions, so OSV-Scanner can follow relative paths but only finds the verified copies (references that climb out of the temporary directory with repeated `..` are excluded). Reads refuse a symbolic link at the final path component and anything that is not a regular file (so named pipes cannot stall the server), and afterwards the path is resolved again to confirm that it is still inside the boundary and is the same file that was opened. The copies are limited to 2 GiB in total (`scan_input_too_large`). When the server is terminated (SIGTERM/SIGINT/SIGHUP, or stdin closing), the temporary directories are deleted and running OSV-Scanner processes are stopped. Directories left behind by an uncatchable termination such as SIGKILL are deleted at a later startup (only directories whose names exactly match this server's prefixes, owned by the current user, not symbolic links, and unmodified for 24 hours or more)
- **Path traversal**: Input paths are resolved with `realpath` (following symbolic links) before the boundary check. Manifest searches do not follow symbolic links. OSV-Scanner never receives a directory, only the detected manifests, each with its format given explicitly (given a directory, OSV-Scanner also reads `requirements.txt` files there and follows their `-r ../x.txt` includes outside the scan scope). `requirements.txt` files are not passed as they are: only the dependency lines the server could interpret are normalized and written to a private copy without any include directives, so even if OSV-Scanner's interpretation of includes differs from the server's, files outside the scope are never read. `Cargo.lock` files are likewise replaced by a copy the server writes, listing only crates.io packages, and every .NET file by a `packages.lock.json` copy listing only packages with a known version. A `pom.xml` whose parent POM chain references a file outside `OSV_MCP_ALLOWED_ROOT` is excluded ([Parent POMs](#parent-poms))
- **Denial of service**: Timeouts and limits on stdout and on the stderr excerpt. Scanner output is parsed defensively and malformed output does not throw. The number of concurrent scans is limited (2 by default) so that parallel requests cannot start unlimited processes. The server's own analysis reads each file once and reuses the result (lockfiles for npm workspace membership, `Cargo.lock` files, shared `requirements.txt` includes, parent POMs), with a limit on the total amount read. Responses do not include the internal affected-range data, which keeps large scans to a fraction of their former size
- **Fail-closed mode**: `OSV_MCP_REQUIRE_ALLOWED_ROOT=1` refuses to start the server when no allowed root is set
- **Restricted permissions (optional)**: The server works under Node's permission model, reports denied access as `permission_denied`, and warns about missing permissions at startup ([Running with restricted permissions](#running-with-restricted-permissions))
- **Fixed and documented network destinations**: Dependency resolution is set to `deps.dev` explicitly, and the mode that connects to arbitrary repositories listed in the scanned `pom.xml` (`--data-source native`) is never used (guaranteed by tests). See [Network destinations and privacy](#network-destinations-and-privacy) for the destinations and for `OSV_MCP_NO_REMOTE_RESOLUTION=1`, which stops sending data to deps.dev
- **Information leakage**: Unexpected exceptions are reduced to `internal_error` without stack traces. Text from external sources (vulnerability summaries and so on) is returned as length-limited, structured data
- **Prompt injection**: Text from the OSV database (summary / details / IDs and so on) and OSV-Scanner's stderr are sanitized before being returned to the LLM client. Control characters (including ANSI escapes), zero-width characters, bidirectional control characters (such as RLO), Unicode tag characters (invisible text smuggling), and line separators (U+2028/2029) are removed, and NFC normalization is applied. All reads of external data go through a single sanitizing boundary, so nothing is missed

## Development

```bash
npm test                  # run the tests (vitest)
npx vitest run --coverage # measure coverage
npm run typecheck         # type check
npm run build             # build into dist/
```

Design notes and open items are in [docs/DESIGN_TODO.md](docs/DESIGN_TODO.md) (in Japanese). Release notes are in [docs/releases](docs/releases).

## Roadmap

- [x] `suggest_fix`: recommends the fix closest to the current release line (three-tier fallback)
- [x] `explain_vulnerability`: vulnerability details (through the OSV API)
- [x] npm package (`npx osv-scanner-mcp`)
- [x] Automatic OSV-Scanner download (with checksum verification)
- [x] Gradle support (lockfile approach)
- [x] `scan_java_artifact`: JAR/WAR scanning (for projects without a lockfile, or with only shaded/fat JARs)
- [x] `scan_project`: scans Java / JavaScript / Python / Go lockfiles together
- [x] `suggest_fix` for JavaScript / Go (SemVer)
- [x] `suggest_fix` for Python (PEP 440)
- [x] Direct and transitive dependencies (npm, Go, `requirements.txt`, `pom.xml`)
- [x] Checking recommended versions against the OSV database
- [x] Flagging inferred coordinates in JAR/WAR scans
- [x] Running under Node's permission model
- [x] English tool descriptions and messages
- [x] `scan_project` for Rust (`Cargo.lock`, crates.io crates only) and RustSec informational advisories
- [x] `suggest_fix` and direct/transitive dependencies for Rust
- [x] Scan history and changes between runs (`scan_history`, opt-in)
- [x] `scan_project` for .NET (NuGet), with per-project matching and lower bounds for project files
- [x] `scan_project` and `suggest_fix` for PHP (Composer `composer.lock`)
- [x] `suggest_fix` for .NET (NuGet; source checkout)
- [ ] Direct and transitive dependencies for `gradle.lockfile` and the YAML/TOML lockfiles

## License

[Apache License 2.0](LICENSE)
