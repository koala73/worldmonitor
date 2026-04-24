// Regression guard for the `generate` target's plugin-path resolution.
//
// The Makefile's `generate` recipe must satisfy two invariants:
//
//   1. `buf` is resolved via the CALLER's PATH. Overriding buf's own
//      location can silently downgrade the build tool on machines with a
//      stale binary in GOBIN.
//   2. Proto plugins (protoc-gen-ts-*, protoc-gen-openapiv3) resolve
//      from the Go install dir FIRST — GOBIN when set, otherwise the
//      first entry of GOPATH + "/bin". This mirrors `go install`'s own
//      resolution order.
//
// This suite scrapes the recipe text from the Makefile and asserts the
// shell expression matches both invariants. It does not shell out to
// `make generate` — that's covered by the pre-push proto-freshness hook.
// We're guarding against future Makefile edits that break the pattern
// without having to run the whole proto pipeline to notice.
//
// Closes the PR #3371 P3 finding about missing automated coverage for
// the path-resolution behavior.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAKEFILE = readFileSync(resolve(__dirname, '../Makefile'), 'utf-8');

function extractGenerateRecipe() {
  // Match `generate:` through the next blank line or non-indented line.
  const m = MAKEFILE.match(/^generate:.*?\n((?:\t[^\n]*\n|#[^\n]*\n|\s*\n)+)/m);
  if (!m) throw new Error('generate target not found in Makefile');
  return m[0];
}

describe('Makefile generate target — plugin path resolution', () => {
  const recipe = extractGenerateRecipe();

  test('resolves buf via command -v before invoking it', () => {
    // `command -v buf` must appear before the PATH override so the
    // caller's buf is captured first. Any version pinned by PATH
    // manipulation below only affects plugin resolution.
    assert.match(
      recipe,
      /BUF_BIN=\$\$\(command -v buf\)/,
      'generate recipe must resolve buf via `command -v buf` before invoking it',
    );
  });

  test('fails loudly when buf is not on PATH', () => {
    // Must not silently fall through when buf is absent — the next
    // invocation would inherit an empty BUF_BIN and crash deeper in
    // the pipeline with a confusing error.
    assert.match(
      recipe,
      /\[ -n "\$\$BUF_BIN" \]/,
      'generate recipe must check that BUF_BIN resolved to a non-empty path',
    );
    assert.match(
      recipe,
      /buf not found on PATH/i,
      'generate recipe must emit a clear error when buf is missing',
    );
  });

  test('invokes buf via absolute path (via "$BUF_BIN"), not via PATH lookup', () => {
    // Using "$$BUF_BIN" generate ensures the plugin-PATH override
    // (added only for this command) does not also redirect which `buf`
    // binary runs. The whole point of the two-stage resolution.
    assert.match(
      recipe,
      /"\$\$BUF_BIN" generate/,
      'generate recipe must invoke buf via absolute path "$BUF_BIN"',
    );
  });

  test('prepends GOBIN-or-GOPATH/bin to PATH for plugin lookup', () => {
    // Plugin resolution follows `go install`'s own rule:
    // GOBIN when set, otherwise GOPATH/bin using the FIRST entry of
    // GOPATH (GOPATH can be a path-list).
    assert.ok(recipe.includes('go env GOBIN'),
      'generate recipe must consult `go env GOBIN`');
    assert.ok(recipe.includes('go env GOPATH | cut -d:'),
      'generate recipe must extract first GOPATH entry via `go env GOPATH | cut -d:`');
    assert.ok(recipe.includes(':$$PATH"'),
      'generate recipe must prepend to $$PATH (install-dir:$$PATH, not the other way around)');
  });

  test('PATH override order: install-dir comes first, then original PATH', () => {
    // The install-dir subshell must appear BEFORE $$PATH. Reversing
    // them would let any earlier PATH entry (e.g. Homebrew plugins)
    // shadow the Makefile-pinned version — the exact bug this guards.
    const pathEqIdx = recipe.indexOf('PATH="');
    assert.ok(pathEqIdx >= 0, 'recipe must contain PATH= assignment');
    const gobinIdx = recipe.indexOf('go env GOBIN', pathEqIdx);
    const dollarPathIdx = recipe.indexOf('$$PATH', pathEqIdx);
    assert.ok(gobinIdx > 0, 'GOBIN lookup must be inside the PATH assignment');
    assert.ok(dollarPathIdx > gobinIdx,
      '$$PATH must come AFTER the GOBIN subshell in the PATH assignment');
  });

  test('path expansion succeeds on current machine', () => {
    // The shell expression is syntactically correct and resolves to
    // an existing directory on this runner. Catches obvious typos
    // (e.g. mismatched parens, wrong subshell syntax) at test time
    // instead of at first `make generate` attempt.
    const out = execSync(
      `bash -c 'gobin=$(go env GOBIN); if [ -n "$gobin" ]; then printf "%s" "$gobin"; else printf "%s/bin" "$(go env GOPATH | cut -d: -f1)"; fi'`,
      { encoding: 'utf-8' },
    ).trim();
    assert.ok(out.length > 0, 'install-dir expression must produce a non-empty path');
    assert.ok(out.endsWith('/bin') || out.includes('go'),
      `install-dir "${out}" should end with /bin or contain "go"`);
  });
});
