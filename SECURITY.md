# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project (OSV-Scanner-MCP), please report it privately through GitHub Security Advisories — **do not open a public issue**:

**https://github.com/tedorigawa001/OSV-Scanner-MCP/security/advisories/new**

Please include as much of the following as you can:

- Affected versions
- Steps to reproduce (a proof of concept)
- The expected impact (what an attacker could do)

## How Reports Are Handled

- Acknowledgement of the report: we aim to respond **within 7 days**
- Fix and release: prioritized by severity; details are kept private until a fixed version is published
- If you would like to be credited, please let us know

## Supported Versions

| Version | Supported |
|---|---|
| Latest release | ✅ |
| Earlier versions | ❌ (please update to the latest version) |

## Scope

This project covers vulnerabilities in **the MCP server itself** (for example command injection, path traversal, bypassing checksum verification, or weaknesses against prompt injection). The following are out of scope; please report them to the respective projects:

- Vulnerabilities in **OSV-Scanner itself** → [google/osv-scanner](https://github.com/google/osv-scanner/security)
- **Errors in vulnerability data** (false positives, disputed severity, and so on) → the [OSV database](https://github.com/google/osv.dev) or the publisher of the advisory

## Security Design of This Project

Implemented measures (see the [README](README.md#security-design) for details):

- Processes are run without a shell, with an argument allowlist
- Input paths are normalized and checked against the boundary (after resolving symbolic links). OSV-Scanner never receives a directory, only the detected manifests, one by one (in v0.3.3 and earlier, an include directive in a `requirements.txt` in the same directory could make it read files outside the scan scope). `requirements.txt` files are not passed as they are; a private copy containing only the dependency lines that could be interpreted is scanned (the copy contains no include directives). A `pom.xml` whose parent POM chain references a file outside `OSV_MCP_ALLOWED_ROOT` is excluded from the scan (in v0.3.4 and earlier, parent POMs outside the scope were read)
- Snapshots: OSV-Scanner never receives the original files. Their contents are read safely once, copied into a private temporary directory, and both the checks and the scan run on the copies, so replacing files after the check has no effect (in v0.4.0 and earlier, replacing a file between the check and the read could make the scanner read content outside the scope). Reads refuse a symbolic link at the final path component and anything that is not a regular file, such as a named pipe (in v0.4.0 and earlier, a parent POM pointing to a named pipe could stall the server), and the path and boundary are checked again after reading. The temporary directories are also deleted when the server is terminated (by a signal or by stdin closing), and running OSV-Scanner processes are stopped (in v0.7.0 and earlier, terminating the server with SIGTERM or similar during a scan left behind a temporary directory containing copies of the original files). The server's own analysis also reads each file only once, with a limit on the total amount read (in v0.4.0 and earlier, the lockfile was parsed repeatedly while checking npm workspace membership)
- The automatically downloaded binary is pinned and verified against an embedded SHA256 checksum (`OSV_MCP_PREFER_DOWNLOAD=1` avoids unverified binaries on `PATH`)
- Timeouts and output size limits (against denial of service); text from external sources is returned as structured, length-limited data
- Text from external sources is sanitized (control characters, zero-width characters, bidirectional control characters, and Unicode tag characters are removed, against invisible prompt injection)
- Optional restricted permissions: the server can run under Node's permission model (`--permission`), reports denied access as `permission_denied`, and warns about missing permissions at startup. osv-scanner runs as a child process and is not restricted by the permission model (see [Running with restricted permissions](README.md#running-with-restricted-permissions))
- Fixed and documented network destinations: scanning `pom.xml` or `requirements.txt` sends the names and versions of the dependencies to deps.dev (`api.deps.dev`) to resolve transitive dependencies. `OSV_MCP_NO_REMOTE_RESOLUTION=1` stops sending data to deps.dev (at the cost of not detecting transitive dependencies; this is stated in `dependency_resolution` in the responses). In every configuration, package names and versions are sent to `api.osv.dev` for the vulnerability lookup. `suggest_fix` checks recommended versions against `api.osv.dev` (sending only package names already queried during the scan and published fixed versions; disable with `OSV_MCP_NO_CANDIDATE_CHECK=1`). The mode that connects to arbitrary repositories specified by the scanned project is never used (see [Network destinations and privacy](README.md#network-destinations-and-privacy))
