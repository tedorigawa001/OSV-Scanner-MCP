# OSV-Scanner-MCP

[![CI](https://github.com/tedorigawa001/OSV-Scanner-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/tedorigawa001/OSV-Scanner-MCP/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/osv-scanner-mcp)](https://www.npmjs.com/package/osv-scanner-mcp)
[![license](https://img.shields.io/npm/l/osv-scanner-mcp)](LICENSE)
[![node](https://img.shields.io/node/v/osv-scanner-mcp)](package.json)

An MCP server that wraps Google's [OSV-Scanner](https://github.com/google/osv-scanner). Ask an MCP client such as Claude to "check this project for vulnerabilities", and it returns the known vulnerabilities (CVE / GHSA) in your dependencies as a report sorted by severity, together with recommended upgrades.

> **Status**: [Published on npm](https://www.npmjs.com/package/osv-scanner-mcp) (`npx -y osv-scanner-mcp`). Supports lockfiles and manifests for Java (Maven / Gradle), JavaScript (npm / yarn / pnpm / bun), Python (Poetry / uv / Pipenv / PDM / requirements.txt), and Go, with upgrade recommendations for all four. Setup instructions are provided for Claude Code, Claude Desktop, Codex CLI, Antigravity, and VS Code (GitHub Copilot).

## Features

- **One-shot multi-language scan**: Pass a project path to `scan_project`, and it detects and scans the Java, JavaScript, Python, and Go lockfiles in the project together. Dependencies that could not be scanned (for example, a manifest without a lockfile or an unpinned requirement) are reported up front in `coverage`
- **Upgrade recommendations**: `suggest_fix` recommends, for each vulnerable package, the upgrade closest to the current release line that fixes all its known vulnerabilities, for Maven, npm, PyPI, and Go. The recommended version is also checked against the OSV database so that it does not introduce other known vulnerabilities
- **Direct and transitive dependencies**: Packages are marked as direct or transitive dependencies (from `package-lock.json`, `go.mod`, `requirements.txt`, and `pom.xml`), and update hints are tailored accordingly, for example by naming the direct dependency that pulls in a transitive one
- **Java project scan**: `scan_java_project` scans only the Java (Maven / Gradle) manifests and returns a formatted report
- **JAR/WAR scan**: `scan_java_artifact` detects known vulnerabilities from the metadata inside JAR/WAR archives, for projects without a lockfile or with only shaded/fat JARs (best-effort identification, stated explicitly in `coverage`)
- **SBOM scan**: `scan_sbom` checks the dependencies recorded in a CycloneDX/SPDX JSON SBOM. It states explicitly that the SBOM's completeness and its match with the actual artifacts are not verified
- **Severity-sorted reports**: Vulnerabilities are grouped by package and sorted by CVSS score, with five severity labels (critical / high / medium / low / unknown) and summary counts
- **Fixed versions**: Each vulnerability includes `fixed_versions`, sorted correctly by Maven version precedence (including non-semver forms such as `2.17.1-RELEASE`), Semantic Versioning precedence for npm and Go, and PEP 440 for PyPI
- **Security first**: No shell execution, a fixed argument allowlist, path normalization and boundary checks, scanning private copies instead of the original files, and timeouts and output size limits are built in

## Requirements

- Node.js >= 20.19
- The [OSV-Scanner](https://google.github.io/osv-scanner/) binary — **no manual installation needed**. If it is not found, a pinned version is downloaded from the official GitHub Releases and verified against a SHA256 checksum embedded in the package before use (cached in `~/.cache/osv-scanner-mcp/`)
  - A manually installed binary (on `PATH` or set with `OSV_SCANNER_PATH`) is used first
  - Set `OSV_MCP_AUTO_DOWNLOAD=0` to disable the automatic download
  - Set `OSV_MCP_PREFER_DOWNLOAD=1` to always use the verified downloaded binary instead of one on `PATH` (recommended for production)
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
- `--allow-child-process` is required to run osv-scanner. **osv-scanner runs as a child process and is not restricted by the permission model** (Node itself warns that this flag weakens the permission model). The impact is limited because osv-scanner only receives verified private copies, but use an OS-level mechanism such as a container if you need stronger isolation
- If a required permission is missing, the server prints a warning to stderr at startup, and scans return `permission_denied` (naming the missing permission and the path)

### Network destinations and privacy

Destinations confirmed with osv-scanner v2.4.0 (2026-10-07):

| Operation | Destinations | Information sent |
|---|---|---|
| Scanning `pom.xml` (`scan_project` / `scan_java_project` / `suggest_fix`) | `api.osv.dev`, **`api.deps.dev`** | Package names and versions. To resolve transitive dependencies, the names and versions of the dependencies declared in `pom.xml` (including internal packages) are sent to deps.dev |
| Scanning `requirements.txt` (`scan_project` / `suggest_fix`) | `api.osv.dev`, **`api.deps.dev`** | As with `pom.xml`, the names and versions of the listed dependencies are sent to deps.dev to resolve transitive dependencies. Package indexes given with `--index-url` and similar options are not contacted |
| Scanning lockfiles (`gradle.lockfile`, npm lockfiles such as `package-lock.json`, Python lockfiles such as `poetry.lock`, `go.mod`) | `api.osv.dev` | Package names and versions (lockfiles already list every dependency, so nothing is resolved remotely) |
| `scan_java_artifact` / `scan_sbom` | `api.osv.dev` | Names and versions of the identified packages |
| `suggest_fix` checking recommended versions | `api.osv.dev` | The names of packages with a recommendation (already sent during the scan) and the candidate versions (published fixed versions). Disable with `OSV_MCP_NO_CANDIDATE_CHECK=1` |
| `explain_vulnerability` | `api.osv.dev` | The vulnerability ID |
| Automatic binary download (first run only) | GitHub (official Releases) | Nothing (downloads the pinned binary) |

Both api.osv.dev and deps.dev are operated by Google. **In every configuration, the names and versions of scanned packages are sent to `api.osv.dev` for the vulnerability lookup** (offline lookup is not supported).

- **To stop sending data to deps.dev**: Set `OSV_MCP_NO_REMOTE_RESOLUTION=1`. Transitive dependencies of `pom.xml` and `requirements.txt` are then not resolved, and only `api.osv.dev` is contacted. This stops only the requests to deps.dev; requests to OSV continue. Only the dependencies written in those files are scanned, so **vulnerabilities in transitive dependencies are missed**. Responses of `scan_project` / `scan_java_project` / `suggest_fix` show this as `transitive_resolution: "disabled"` in `dependency_resolution` with a warning, so it can be told apart from zero findings. To scan transitive dependencies without deps.dev, use lockfiles (`gradle.lockfile`, `poetry.lock`, and so on)
- **Arbitrary repositories are never contacted**: osv-scanner's `--data-source native` mode connects to any URL listed in `<repositories>` of the scanned `pom.xml` (a malicious `pom.xml` could make it contact an attacker's server). This server never uses that mode and sets `deps.dev` explicitly

## Tools

### `scan_project`

Detects the lockfiles and manifests in a project and scans the Java / JavaScript / Python / Go dependencies together. Package managers and builds are never run.

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

`.git`, `node_modules`, `target`, `build`, `.idea`, `.vscode`, `.venv`, `venv`, `site-packages`, `__pycache__`, `.tox`, `vendor`, and symbolic links are not searched. Only the detected files are passed to OSV-Scanner, each with its format given explicitly (`coverage.manifests` in the response is exactly the scan scope). The search limits are the same as for `scan_java_project`.

**`requirements.txt` files are not passed to OSV-Scanner as they are.** The server parses them, rewrites only the dependency lines it can interpret into simple forms such as `name==version`, and scans a private temporary copy (deleted after the scan). OSV-Scanner interprets include directives on its own (it even treats `- r ../x.txt`, with a space, as an include and reads files outside the scan scope), so the copy never contains include directives or options. Includes (`-r` / `--requirement`) are expanded by the server, and only when the included file is inside the project directory.

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
  - `lockfile_missing`: manifests without a lockfile (`package.json`, `pyproject.toml`, `Pipfile`, `setup.py`, `build.gradle`, and so on). Not recorded if a lockfile of the same ecosystem is in the same directory. If there is only a lockfile in a parent directory, the manifest is not recorded only when `package-lock.json` (v2 or later) is confirmed to contain that directory (npm workspaces). Otherwise it is recorded with `status: "missing"`, or `status: "unconfirmed"` for formats that cannot be checked (yarn.lock, Python lockfiles, and so on). Generate the lockfile as described in `hint` (in a trusted environment) and scan again
  - `unpinned_requirements`: lines in `requirements.txt` that do not pin a version. `kind` is `unpinned` (no version), `range` (`>`, `<`, `!=`, `==1.*`, combined ranges, and so on), or `lower_bound` (`>=`, `~=`). OSV-Scanner does not scan `unpinned` and `range` lines, and scans `lower_bound` lines at the lower bound (those packages are marked `version_is_lower_bound: true` and may differ from the installed version)
  - `unscannable_requirements`: lines that are not scanned, with the reason: `-e`, `name @ URL`, paths, includes that were not expanded (outside the project directory, missing, URLs, or over the limits), constraint files (`-c`, not applied), and options or version specifiers that cannot be interpreted. Lines that cannot be interpreted are recorded here instead of being ignored
  - `skipped_files`: files excluded from the scan, with the reason (a `requirements.txt` that cannot be read or is larger than 1 MiB, or a `pom.xml` whose parent POM chain references a file outside the allowed root). A `pom.xml` scanned without its parent POM, because the parent could not be read, is also listed here with the reason (see [Parent POMs](#parent-poms))
  - Each list holds up to 200 entries; the number of omitted entries is returned in `omitted_items`
- `ecosystem_breakdown` includes ecosystems with zero findings, to show that they were scanned
- `dependency_relation` shows whether a package is a direct (`direct`) or transitive (`transitive`) dependency. OSV-Scanner does not report this, so the server determines it by parsing the scanned copies:
  - `package-lock.json` (v2 or later): dependencies of the root and workspace `package.json` files, resolved with Node's lookup rules (nested `node_modules` first, then parent directories), are direct; everything reachable from them is transitive. Direct dependencies list the `package.json` files that declare them in `declared_in`; transitive dependencies list the direct dependencies that require them in `introduced_by` (up to 10, with the rest counted in `introduced_by_omitted`). A version that is both a direct dependency and required by another dependency is `direct` and also has `introduced_by`
  - `go.mod`: `require` lines without `// indirect` are direct. Modules affected by a `replace` directive are marked `replaced_in_go_mod: true` (OSV-Scanner reports the replacement module and version)
  - `requirements.txt`: dependencies written in the file are direct; dependencies resolved through deps.dev are transitive
  - `pom.xml`: OSV-Scanner reports the dependencies declared in `pom.xml` (and its parent POMs) and the transitive dependencies resolved through deps.dev as separate results (`source.type` `lockfile` / `unknown`), and this split is used (so parent POMs, profiles, properties, and dependency management are interpreted exactly as OSV-Scanner does). `introduced_by` / `declared_in` are not available. This relies on undocumented OSV-Scanner output, so anything unexpected is reported as `unknown`
  - Other formats (`gradle.lockfile`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `pdm.lock`), lockfile version 1, and entries not reachable from the project are `unknown`. If lockfiles disagree, the value is `mixed`
- `dependency_groups` is the raw dependency group reported by OSV-Scanner (for example `dev`). It is missing or inaccurate for some lockfile formats (absent for pnpm, `optional` for pdm, and so on), so treat it as informational
- Upgrade recommendations (`suggest_fix`) are available for Java, JavaScript, Python, and Go

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
- `fixed_versions` lists the fixed versions recorded in OSV, in ascending order: by Maven precedence for Maven, Semantic Versioning precedence for npm and Go (values that are not valid SemVer come last), and PEP 440 for PyPI (in the order listed by OSV up to v0.5.0); other ecosystems keep the order listed by OSV (the order is not guaranteed). Several release lines may be mixed (for example a 2.12 backport and the 2.15 line). Pre-releases (`5.0.0-beta.3`) and Go pseudo-versions (`0.0.0-20180925071336-cf3bd585ca2a`) may be included. An empty array means that OSV lists no fixed version. Up to v0.4.1, this was always empty for packages outside Maven
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

OSV-Scanner 2.4.0's `java/archive` plugin is used, and nested JARs are also analyzed by the scanner. No Java code is executed and no build is run.
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

`sbom` returns the original file path, the format, the specification version, and the SHA256 of the bytes that were scanned. `identified_vulnerability_count` and `packages` contain the findings for the identified dependencies. **Zero findings does not mean the software is safe.** To cover JARs without metadata, prepare an accurate SBOM for that build.

Invalid JSON returns `invalid_sbom`, an unsupported format `unsupported_sbom_format`, input over the size limit `sbom_too_large`, and a missing or unreadable file `sbom_not_found`. An empty SBOM, or one with no identifiable packages, returns a successful report with a warning. The same timeout, output limit, and concurrency limit as the other tools apply.

### `suggest_fix`

Runs the same detection and scan as `scan_project` and recommends an **upgrade version** for each vulnerable package. Recommendations are available for Java (Maven / Gradle), JavaScript (npm), Python (PyPI), and Go. Instead of simply taking the highest fixed version, it picks the fixed version closest to the current release line, falling back through three tiers:

| Tier | Meaning |
|---|---|
| `same_minor` | A fixed version in the same release line (the smallest change) |
| `major_internal` | A fixed version within the same major version (a minor upgrade) |
| `cross_major` | A major upgrade is needed (may include breaking changes) |

For npm, Go, and PyPI, the "same release line" is the range npm's caret (`^`) treats as compatible (PyPI has no common compatibility rule, but some 0.x packages make breaking changes in minor releases, so the same rule is used; a change of epoch is also `cross_major`). From 1.0.0 the line is major.minor, as for Maven. For 0.x, only the same `0.minor` is the same line, so a minor update (`0.3` → `0.4`) is `cross_major`, and for 0.0.x every update is `cross_major` (SemVer does not guarantee compatibility for 0.x updates).

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
- Suggestions include an `update_hint`, tailored to whether the package is a direct or transitive dependency:
  - Maven (from `pom.xml`): for a direct dependency, update the `<dependency>` version (or the parent POM, property, or BOM that manages it); for a transitive dependency, override the version in `<dependencyManagement>` or update the direct dependency that requires it
  - npm: for a direct dependency, update the version in the `package.json` listed in `declared_in`; for a transitive dependency, update the direct dependency named in `introduced_by`, or set the version with `overrides` in the root `package.json` (effective only in the root project)
  - Go: `go get <module>@<version>` (also for `// indirect` modules). For a module affected by `replace`, update the version in the `replace` directive instead of `require`. Major versions 2 and later use a different module path (`/v2` and so on) and are separate packages in OSV, so fixes in a newer major line are not included as candidates. If the current version is a pseudo-version (an untagged commit), `upgrade_note` says so
  - PyPI: update the version in `requirements.txt`, `pyproject.toml`, or `Pipfile` and regenerate the lockfile; for a transitive dependency, use a pip constraints file (`-c`) or the override settings of uv or Poetry
  - When the relation is `unknown` or `mixed`, both cases are described (no hint is given for Maven packages from `gradle.lockfile`)
- **Checking recommended versions against OSV**: Recommendations are verified only against the vulnerabilities found in the scan (those affecting the current version), so a recommended version could be affected by newer vulnerabilities (for example, cryptography 3.2's candidate 49.0.0 is affected by two vulnerabilities introduced in 44.0.0 and fixed in 50.0.0). The server therefore queries `api.osv.dev` about the recommended version, and if it is affected, adds those vulnerabilities to the set to be fixed and chooses again with their fixed versions as candidates (50.0.0 in this example, with the reason in `upgrade_note`). The result is reported in `candidate_check`:
  - `clean`: OSV reports no known vulnerabilities for the recommended version
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
| `internal_error` | An unexpected error (no internal details are returned) |

## Security design

The following measures keep the vulnerability scanner itself from becoming an attack vector.

- **Supply chain**: The automatic download is limited to the official GitHub Releases and a pinned version, and is verified against **a SHA256 checksum embedded in the package** (the SHA256SUMS file from the release is not trusted, so tampering on the release side is detected). The binary is not made executable until it passes verification, and cached binaries are verified again on every use. `OSV_MCP_PREFER_DOWNLOAD=1` avoids unverified binaries on `PATH`
- **Command injection**: Commands are run with `spawn` and an argument array, never through a shell. OSV-Scanner receives only a fixed list of arguments, plus verified absolute paths
- **Snapshots (no gap between checking and reading)**: OSV-Scanner never receives the original files. Lockfiles, `pom.xml` (including the parent POM chain), and JAR/WARs are read safely once, copied into a private temporary directory (accessible only by the owner, deleted afterwards), and the copies are both checked and scanned. Replacing the original files or directories after the check has no effect on the results. Parent POMs are copied into the temporary directory at their original relative positions, so OSV-Scanner can follow relative paths but only finds the verified copies (references that climb out of the temporary directory with repeated `..` are excluded). Reads refuse a symbolic link at the final path component and anything that is not a regular file (so named pipes cannot stall the server), and afterwards the path is resolved again to confirm that it is still inside the boundary and is the same file that was opened. The copies are limited to 2 GiB in total (`scan_input_too_large`). When the server is terminated (SIGTERM/SIGINT/SIGHUP, or stdin closing), the temporary directories are deleted and running OSV-Scanner processes are stopped. Directories left behind by an uncatchable termination such as SIGKILL are deleted at a later startup (only directories whose names exactly match this server's prefixes, owned by the current user, not symbolic links, and unmodified for 24 hours or more)
- **Path traversal**: Input paths are resolved with `realpath` (following symbolic links) before the boundary check. Manifest searches do not follow symbolic links. OSV-Scanner never receives a directory, only the detected manifests, each with its format given explicitly (given a directory, OSV-Scanner also reads `requirements.txt` files there and follows their `-r ../x.txt` includes outside the scan scope). `requirements.txt` files are not passed as they are: only the dependency lines the server could interpret are normalized and written to a private copy without any include directives, so even if OSV-Scanner's interpretation of includes differs from the server's, files outside the scope are never read. A `pom.xml` whose parent POM chain references a file outside `OSV_MCP_ALLOWED_ROOT` is excluded ([Parent POMs](#parent-poms))
- **Denial of service**: Timeouts and limits on stdout and on the stderr excerpt. Scanner output is parsed defensively and malformed output does not throw. The number of concurrent scans is limited (2 by default) so that parallel requests cannot start unlimited processes. The server's own analysis reads each file once and reuses the result (lockfiles for npm workspace membership, shared `requirements.txt` includes, parent POMs), with a limit on the total amount read. Responses do not include the internal affected-range data, which keeps large scans to a fraction of their former size
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
- [ ] Direct and transitive dependencies for `gradle.lockfile` and the YAML/TOML lockfiles

## License

[Apache License 2.0](LICENSE)
