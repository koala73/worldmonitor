# Dependency security backports

The caller-risk leases from October 2 and PR #8803 are superseded by local security backports. The three matching audit suppressions are removed. Dependabot alerts 347, 348, and 349 remain open until the remediation reaches the default branch and GitHub evaluates its dependency graph.

Both advisories still list no released upstream fix. The private WorldMonitor versions contain code changes. They are not published upstream releases.

| Advisory | Affected projects | Remediation |
| --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Root and Pro | `braces` 3.0.4-worldmonitor.1 limits parser and AST walker depth. Deep braces and parentheses cannot exhaust the stack. |
| [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) | Blog | `http-cache-semantics` 4.2.1-worldmonitor.2 rejects restricted response reuse before `max-stale` and stale extension handling. |

Each project declares the source package from `vendor/` and overrides transitive consumers to that same specification. npm packs the local source into each installation with `install-links=true`. Installs do not depend on lifecycle scripts or another project's node_modules.

[Backport provenance and removal conditions](../../vendor/README.md) identify the upstream source and proposed fixes. Original licenses ship beside the code. These temporary backports must be replaced with compatible upstream fixes when available.

## Verification

`tests/dependency-backports.test.mjs` covers nested strings, directly supplied ASTs, caller attempts to disable depth limits, ordinary brace patterns, restricted cached responses, serialized policies, stale fallback paths, and valid cache hits. `tests/security-audit-baseline.test.mjs` requires these advisories to remain unsuppressed.

Run clean root, Pro, and blog installs. Run the focused tests, production dependency audits, and affected builds. These checks establish dependency behavior and build compatibility. They do not establish merge, deployment, or live production acceptance.
