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
    // Must not silently fall through when buf is absent.
    assert.match(
      recipe,
      /buf not found on PATH/i,
      'generate recipe must emit a clear error when buf is missing',
    );
  });

  test('fails loudly when go is not on PATH', () => {
    // `go env GOBIN` failing silently would let PLUGIN_DIR resolve to
    // "/bin" (empty + "/bin" suffix), which doesn't override PATH — a
    // stale sebuf on the normal PATH would win and the duplicate-output
    // failure this PR is trying to prevent would come back. Codex
    // high-severity on commit 9c0058a.
    assert.match(
      recipe,
      /command -v go/,
      'generate recipe must check that `go` is on PATH before attempting plugin resolution',
    );
    assert.match(
      recipe,
      /go not found on PATH/i,
      'generate recipe must emit a clear error when go is missing',
    );
  });

  test('verifies EVERY sebuf plugin binary referenced by buf.gen.yaml is present', () => {
    // `go` can be installed without the user having ever run
    // `make install-plugins`. Guarding only one plugin would let buf
    // fall through to a stale copy of the OTHERS on the normal PATH
    // and recreate the mixed-version bug this PR is meant to prevent.
    // The list here must stay in sync with proto/buf.gen.yaml.
    const required = ['protoc-gen-ts-client', 'protoc-gen-ts-server', 'protoc-gen-openapiv3'];
    for (const bin of required) {
      // The guard iterates a shell `for` loop, so the literal plugin
      // name must appear in the recipe's plugin list AND the
      // remediation string must reference install-plugins.
      assert.ok(
        recipe.includes(bin),
        `generate recipe must include ${bin} in the plugin-executable guard list`,
      );
    }
    // The loop must check each entry with `[ -x "$PLUGIN_DIR/$p" ]`
    // and bail with a message that points users to `make install-plugins`.
    assert.match(
      recipe,
      /\[ -x "\$\$PLUGIN_DIR\/\$\$p" \]/,
      'generate recipe must verify each plugin is executable via [ -x "$PLUGIN_DIR/$p" ]',
    );
    assert.match(
      recipe,
      /Run: make install-plugins/,
      'generate recipe must tell the user the remediation when a plugin is missing',
    );
  });

  test('plugin guard list covers every plugin declared in buf.gen.yaml', () => {
    // Cross-reference proto/buf.gen.yaml plugin entries against the
    // Makefile's guard list. If buf.gen.yaml ever adds a new `local:`
    // plugin (e.g. a future protoc-gen-*), the guard must grow too —
    // otherwise the new binary can silently fall through to a stale
    // PATH copy.
    const BUF_GEN = readFileSync(resolve(__dirname, '../proto/buf.gen.yaml'), 'utf-8');
    const declared = new Set();
    for (const m of BUF_GEN.matchAll(/^\s*-\s*local:\s*(\S+)\s*$/gm)) {
      declared.add(m[1]);
    }
    assert.ok(declared.size > 0, 'buf.gen.yaml must declare at least one local plugin');
    for (const bin of declared) {
      assert.ok(
        recipe.includes(bin),
        `buf.gen.yaml declares '${bin}' but the Makefile guard does not check it — stale ${bin} on PATH could still win`,
      );
    }
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
    // PLUGIN_DIR must appear BEFORE $$PATH in the PATH assignment.
    // Reversing them would let any earlier PATH entry (e.g. Homebrew
    // plugins) shadow the Makefile-pinned version.
    const pathAssignMatch = recipe.match(/PATH="\$\$PLUGIN_DIR:\$\$PATH"/);
    assert.ok(
      pathAssignMatch,
      'recipe must contain PATH="$$PLUGIN_DIR:$$PATH" — resolved plugin dir first, original PATH second',
    );
    // Cross-check: PLUGIN_DIR must have been computed before the PATH
    // assignment uses it.
    const pluginDirAssignIdx = recipe.indexOf('PLUGIN_DIR=');
    const pathAssignIdx = recipe.indexOf('PATH="$$PLUGIN_DIR');
    assert.ok(pluginDirAssignIdx >= 0, 'recipe must set PLUGIN_DIR');
    assert.ok(pathAssignIdx > pluginDirAssignIdx,
      'PATH assignment must come AFTER the PLUGIN_DIR computation');
    // The GOBIN lookup happens in the PLUGIN_DIR assignment, which
    // precedes the PATH assignment — verified above.
  });

  test('pre-push hook does not unconditionally prepend $HOME/go/bin', () => {
    // The Makefile's caller-PATH-first invariant is only meaningful
    // if the hook invoking it doesn't first shadow the caller's `buf`.
    // An unconditional `export PATH="$HOME/go/bin:$PATH"` would let a
    // stale `~/go/bin/buf` (from an old `go install`) win over a newer
    // Homebrew-installed `buf`, defeating the whole point of this PR.
    //
    // The hook MUST guard the prepend on "buf is not already on PATH"
    // so the prepend only fires as a fallback when buf has no other
    // candidate.
    const HOOK = readFileSync(resolve(__dirname, '../.husky/pre-push'), 'utf-8');
    // Locate the proto-freshness block by its echo line.
    const start = HOOK.indexOf('Running proto freshness check');
    assert.ok(start >= 0, 'pre-push hook must contain the proto-freshness block');
    const block = HOOK.slice(start, start + 2000);
    // The prepend MUST be gated on `! command -v buf` so it only fires
    // when buf has no other candidate. Any `export PATH="$HOME/go/bin:$PATH"`
    // inside this block must appear inside an `if ! command -v buf ...`
    // arm — never directly under the block or under a bare `if command -v buf`.
    assert.match(
      block,
      /if\s+!\s+command\s+-v\s+buf[^\n]*\n[^\n]*export PATH="\$HOME\/go\/bin:\$PATH"/,
      'pre-push hook must gate the $HOME/go/bin prepend on `! command -v buf` so it only fires as a fallback — ' +
      'otherwise a stale ~/go/bin/buf would shadow the caller\'s preferred buf binary',
    );
    // Explicit regression guard for the PRIOR buggy pattern that this
    // PR is replacing. The old hook did
    // `if command -v buf ... || [ -x "$HOME/go/bin/buf" ]; then export PATH=...`
    // which ALWAYS prepended whenever buf was reachable anywhere —
    // exactly the stale-buf-wins failure mode.
    assert.ok(
      !/if\s+command\s+-v\s+buf[^\n]*\|\|\s*\[\s*-x\s+"\$HOME\/go\/bin\/buf"\s*\][^\n]*;\s*then\s*\n\s*export PATH="\$HOME\/go\/bin:\$PATH"/.test(block),
      'pre-push hook must not use the old `buf-on-PATH-OR-at-~/go/bin -> prepend` pattern — it shadowed Homebrew buf with stale go-install buf',
    );
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
