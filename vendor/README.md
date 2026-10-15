# Temporary dependency security backports

These packages retain the upstream names and CommonJS APIs. Their private versions identify WorldMonitor security backports, not published upstream releases.

The root and Pro projects use `braces` 3.0.4-worldmonitor.1. The blog uses `http-cache-semantics` 4.2.1-worldmonitor.2. Each project declares the local source directly and uses an npm `$` override to select it for every transitive consumer. `install-links=true` makes npm copy the package into each installation. Pro does not need the root installation to resolve `fill-range`.

## Source and changes

`braces` starts from the npm 3.0.3 package, with its MIT license. `index.js` and `lib/utils.js` remain unchanged. The parser limits combined brace and parenthesis nesting to 100. The compile, expand, and stringify walkers enforce the same limit for ASTs supplied directly. A caller can reduce the limit but cannot disable or raise the security ceiling. This follows the approach in [upstream PR 72](https://github.com/micromatch/braces/pull/72), with parser depth derived from the existing stack.

`http-cache-semantics` starts from the npm 4.2.0 package, with its BSD-2-Clause license. The backport distinguishes a response that requires validation from a normally expired response. Private, no-store, no-cache, shared cookie, proxy-revalidate, and wildcard-Vary restrictions apply before request `max-stale` can allow reuse. Those restrictions also disable stale error fallback, stale-while-revalidate, and retention extensions. Wildcard Vary fields retain their restriction with whitespace or additional fields. Vary comparison rejects inherited object properties, following the upstream [header-matching fix](https://github.com/kornelski/http-cache-semantics/commit/9fb520be70eff3ff502fe965d9c3265ca2c64e26). Ordinary fresh responses, public stale responses, and private-cache cookie responses retain their existing behavior. The reuse restriction follows [upstream PR 58](https://github.com/kornelski/http-cache-semantics/pull/58), with stale extension checks informed by [upstream PR 60](https://github.com/kornelski/http-cache-semantics/pull/60).

Connection and Vary fields use literal comma splitting and per-field trimming to avoid quadratic regular-expression backtracking on hostile whitespace.

Neither backport has an install script. The committed source is the installed artifact, including when lifecycle scripts are disabled.

`stream-json` starts from the npm 1.9.1 package, with its BSD-3-Clause license. Root and Pro select the private 1.9.2-worldmonitor.1 backport. Only `Assembler.js` changes. Both value assignment paths create an own data property for `__proto__`, following the [upstream fix](https://github.com/uhop/stream-json/commit/2f2d35bbb547306991ded6487a279154d865a358). The backport preserves the CommonJS import paths and streaming API used by `jayson`; upstream 3.6.0 changes those contracts. Its package manifest removes lifecycle scripts and development dependencies. The other upstream files remain unchanged. The 1.x package has no JSONC parser or verifier.

Run `node --test tests/dependency-security-regression.test.mjs tests/dependency-backports.test.mjs` after a clean install. The regressions exercise the installed `jayson` stream parser, nested and primitive prototype keys, identity and deleting revivers, consecutive JSON values, and KaTeX trust options. Replace the stream-json backport when `jayson` supports a patched upstream version or upstream publishes a compatible 1.x fix.

## Verification and removal

Run `node --test tests/dependency-backports.test.mjs tests/security-audit-baseline.test.mjs` after clean root and blog installs. Verify a separate Pro install and build. The tests exercise hostile input, directly supplied ASTs, restored cache policies, restricted stale reuse, and allowed cache responses.

Bump the private package version and regenerate all affected lockfiles whenever its source changes. The root dependency cache also hashes the vendored source. Docker builders set the install-links option explicitly because credential-safe build contexts exclude npm configuration files.

When upstream publishes compatible fixes, replace the direct local dependencies with the upstream versions and remove their `$` overrides. Run these regressions and the affected builds before removing the matching vendor directory. Remove the install-links settings when no local package needs them. Do not restore the advisory suppressions.
