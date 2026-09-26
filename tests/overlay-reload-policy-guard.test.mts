import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DECLARATION_RE,
  EXCLUDED_FILES,
  MIN_SITE_COUNT,
  RELOAD_GUARD_EXEMPT,
  SITE_PATTERNS_BY_CLAUSE,
  adviceFor,
  declarationsIn,
  safeDeclarationsIn,
  scanRepo,
  sitesIn,
  unguardedReloadsIn,
  violationsIn,
} from '../scripts/enforce-overlay-reload-policy.mjs';
import { stripComments } from '../scripts/lib/source-scan.mjs';
import { MODAL_SELECTORS } from '../src/utils/open-modal.ts';

// ---------------------------------------------------------------------------
// Why this test exists
// ---------------------------------------------------------------------------
//
// The scan lives in scripts/enforce-overlay-reload-policy.mjs so it can run
// from .husky/pre-push on any `src/` change: the edit it must catch is
// "someone added an overlay", which touches nothing under tests/. This file is
// the second half. It proves the scanner has TEETH: every assertion either
// exercises a pattern against a fixture, or pins a property of the inventory
// the CLI trusts.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('overlay reload-contract gate', () => {
  const scan = scanRepo(REPO_ROOT);

  it('sees the whole overlay population', () => {
    // Without this a moved directory or a renamed idiom makes every other
    // assertion pass vacuously.
    assert.ok(
      scan.sites.length >= MIN_SITE_COUNT,
      `expected >= ${MIN_SITE_COUNT} overlay creation sites, found ${scan.sites.length}: the scan has drifted`,
    );
    assert.deepEqual(scan.unparsable, [], 'every scanned file must parse, or the gate scans less than it claims');
  });

  it('covers every MODAL_SELECTORS clause and no other', () => {
    // The derivation test in open-modal.test.mts keeps the two selector
    // strings in step; this extends the same guarantee to the gate.
    assert.deepEqual(Object.keys(SITE_PATTERNS_BY_CLAUSE), [...MODAL_SELECTORS]);
  });

  it('every pattern matches its own probe and rejects its negative probe', () => {
    // The negative probes are the live selector-string shapes in
    // src/utils/utm.ts and src/components/RouteExplorer/RouteExplorer.ts, and
    // the embed-modal-overlay class token, none of which creates an overlay.
    for (const [clause, pattern] of Object.entries(SITE_PATTERNS_BY_CLAUSE)) {
      if (pattern.kind === 'third-party') continue;
      const re = new RegExp(pattern.re.source, pattern.re.flags);
      assert.ok(re.test(pattern.probe), `${clause} no longer matches its own probe`);
      re.lastIndex = 0;
      assert.ok(!re.test(pattern.negativeProbe), `${clause} matches its negative probe: ${pattern.negativeProbe}`);
    }
  });

  it('the third-party clause has no creation form', () => {
    // Clerk DOM stays undeclared, and undeclared blocks.
    const clerk = SITE_PATTERNS_BY_CLAUSE['.cl-modalBackdrop'];
    assert.equal(clerk.kind, 'third-party');
    assert.equal(clerk.re, null);
  });

  it('companion hits never stand alone in the live tree', () => {
    // The assumption the site count rests on: every aria-modal hit in src/ is
    // within the cluster radius of a role="dialog" hit. A lone one would be an
    // overlay the guard sees and this gate cannot attribute.
    assert.deepEqual(scan.loneCompanions, []);
  });

  it('sees the non-ARIA idioms: a role with no aria-modal, and an id with no class', () => {
    // KeyboardHelp sets role="dialog" and never aria-modal; AviationCommandBar
    // has no class at all, only an id. Both are real overlays the selector
    // matches, and both must be counted rather than assumed.
    const at = (file: string) => scan.sites.filter((s) => s.file === file).map((s) => s.receiver);
    assert.deepEqual(at('src/components/RouteExplorer/KeyboardHelp.ts'), ['this.element']);
    assert.deepEqual(at('src/components/AviationCommandBar.ts'), ['this.overlay']);
  });

  it('role plus className on one element is one site', () => {
    // The UnifiedSettings shape.
    const fixture = [
      "this.overlay = document.createElement('div');",
      "this.overlay.className = 'modal-overlay';",
      "this.overlay.id = 'unifiedSettingsModal';",
      "this.overlay.setAttribute('role', 'dialog');",
      "this.overlay.setAttribute('aria-modal', 'true');",
    ].join('\n');
    const sites = sitesIn(fixture);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.receiver, 'this.overlay');
  });

  it('born-visible overlays are sites: identity, not reveal idiom, is the key', () => {
    // `className = 'modal-overlay active'` then append, never touching
    // classList. A gate keyed on classList.add('active') rates this clean
    // while it is exactly the wedge shape.
    const fixture = [
      "overlay = document.createElement('div');",
      "overlay.className = 'modal-overlay active';",
      'document.body.appendChild(overlay);',
    ].join('\n');
    assert.equal(sitesIn(fixture).length, 1);
  });

  it('two receivers within the cluster radius are two sites', () => {
    const fixture = [
      "outer.setAttribute('role', 'dialog');",
      "inner.setAttribute('role', 'dialog');",
    ].join('\n');
    assert.deepEqual(sitesIn(fixture).map((s) => s.receiver), ['outer', 'inner']);
  });

  it('a site whose file never declares is a violation', () => {
    const fixture = "const overlay = document.createElement('div');\noverlay.setAttribute('role', 'dialog');";
    const violations = violationsIn('src/x.ts', fixture);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.reason, 'no-declaration');
    assert.equal(violations[0]?.site.line, 2);
    assert.match(adviceFor(violations[0]!), /src\/x\.ts:2 {2}overlay\.setAttribute\('role', 'dialog'\)/);
    assert.match(adviceFor(violations[0]!), /declareOverlay\(overlay, \.\.\.\)/);
  });

  it('a declaration on a different receiver does not satisfy the site', () => {
    // The wrong-element mistake a per-file count alone would let through.
    const fixture = [
      "overlay.setAttribute('role', 'dialog');",
      "declareOverlay(modal, { reload: 'blocking' });",
    ].join('\n');
    const violations = violationsIn('src/x.ts', fixture);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.reason, 'receiver-mismatch');
    assert.match(adviceFor(violations[0]!), /not on overlay/);
  });

  it('two sites on distinct receivers need two declarations', () => {
    // The event-handlers shape: popover and embed dialog in one file.
    const one = [
      "popover.setAttribute('role', 'dialog');",
      "declareOverlay(popover, { reload: 'safe' });",
      '',
      '',
      '',
      "dialog.setAttribute('role', 'dialog');",
      "dialog.setAttribute('aria-modal', 'true');",
    ].join('\n');
    assert.equal(violationsIn('src/x.ts', one).length, 1);
    assert.equal(violationsIn('src/x.ts', `${one}\ndeclareOverlay(dialog, { reload: 'safe' });`).length, 0);
  });

  it('a template role="dialog" is a site satisfied by any declaration in the file', () => {
    // The preferences-content shape: markup in a template literal, declared
    // after mount through a querySelector the regex cannot name.
    const fixture = [
      'html += `<div class="fw-import-modal" role="dialog" aria-modal="true" aria-label="Import framework">`;',
      "const el = root.querySelector('.fw-import-modal');",
      "if (el) declareOverlay(el, { reload: 'blocking' });",
    ].join('\n');
    const sites = sitesIn(fixture);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.receiver, null);
    assert.deepEqual(violationsIn('src/x.ts', fixture), []);
  });

  it('per-open re-declaration is not a violation', () => {
    const fixture = [
      "this.element.setAttribute('role', 'dialog');",
      "show() { declareOverlay(this.element, { reload: 'safe' }); }",
      "showSignal() { declareOverlay(this.element, { reload: 'blocking' }); }",
      "showAlert() { declareOverlay(this.element, { reload: 'blocking' }); }",
    ].join('\n');
    assert.deepEqual(violationsIn('src/x.ts', fixture), []);
    assert.equal(declarationsIn(fixture).length, 3);
  });

  it('a declaration inside a comment does not count', () => {
    const fixture = stripComments([
      "overlay.setAttribute('role', 'dialog');",
      "// declareOverlay(overlay, { reload: 'safe' })",
    ].join('\n'));
    assert.equal(violationsIn('src/x.ts', fixture).length, 1);
    assert.deepEqual(declarationsIn(fixture), []);
  });

  it('DECLARATION_RE captures identifier-path receivers and nothing for other forms', () => {
    assert.deepEqual(declarationsIn("declareOverlay(this.overlay, { reload: 'blocking' })").map((d) => d.receiver), ['this.overlay']);
    assert.deepEqual(declarationsIn("declareOverlay(root.querySelector('.x')!, { reload: 'safe' })").map((d) => d.receiver), ['root.querySelector']);
    assert.equal(DECLARATION_RE.flags.includes('g'), true);
  });

  it('a file that does not parse fails the gate rather than scanning less', () => {
    const root = mkdtempSync(join(tmpdir(), 'overlay-gate-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'bad.ts'), "const = ;\noverlay.setAttribute('role', 'dialog');\n");
      writeFileSync(join(root, 'src', 'good.ts'), "overlay.setAttribute('role', 'dialog');\ndeclareOverlay(overlay, { reload: 'safe' });\n");
      const result = scanRepo(root);
      assert.deepEqual(result.unparsable, ['src/bad.ts']);
      assert.deepEqual(result.sites.map((s) => s.file), ['src/good.ts']);
      assert.deepEqual(result.violations, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes exactly the vocabulary module', () => {
    // That file contains the selector strings and must not be read as
    // creation sites; nothing else may hide there.
    assert.deepEqual(EXCLUDED_FILES, new Set(['src/utils/open-modal.ts']));
  });

  it('the live tree has zero violations', () => {
    assert.deepEqual(
      scan.violations,
      [],
      `Overlays without a reload contract:\n${scan.violations.map((v) => adviceFor(v)).join('\n\n')}`,
    );
  });

  it('the declared-safe set is exactly the reviewed read-only surfaces', () => {
    // 'safe' is the dangerous direction: a wrong 'safe' on a form destroys
    // typed work. Widening this set is a review event, not a silent change.
    // Each entry was verified read-only: no user-entered state, nothing a
    // reload cannot rebuild.
    assert.deepEqual(scan.safeDeclarations, [
      'src/app/event-handlers.ts :: dialog',
      'src/app/event-handlers.ts :: popover',
      'src/components/IntelligenceGapBadge.ts :: overlay',
      'src/components/MobileWarningModal.ts :: this.element',
      'src/components/RouteExplorer/KeyboardHelp.ts :: this.element',
      'src/components/SignalModal.ts :: this.element',
      'src/components/StoryModal.ts :: modalEl',
      'src/components/market-chart-modal.ts :: modalEl',
    ]);
    assert.deepEqual(safeDeclarationsIn("declareOverlay(el, { reload: 'blocking' })"), []);
    assert.deepEqual(safeDeclarationsIn("declareOverlay(root.querySelector('.x')!, { reload: 'safe' })"), ["root.querySelector('.x')!"]);
  });

  // --- reload lockstep ---------------------------------------------------------

  it('flags a bootstrap installer that reloads without consulting the guard', () => {
    // The #8577 shape: a consumer with no modal probe at all.
    const fixture = [
      'export function installFooReload(options = {}) {',
      '  const reload = options.reload ?? (() => window.location.reload());',
      "  window.addEventListener('foo', () => {",
      '    reload();',
      '  });',
      '}',
    ].join('\n');
    // Line 2 is the injectable default's own definition, not a trigger; it runs
    // only when a caller invokes `reload()`, and line 4 is that caller.
    assert.deepEqual(unguardedReloadsIn(fixture).map((h) => [h.line, h.text]), [
      [4, 'reload()'],
    ]);
  });

  it('accepts the sw-update shape: guard in the same body, click marked', () => {
    const fixture = [
      'export function installSw(options = {}) {',
      '  const reload = options.reload ?? (() => window.location.reload());',
      '  const onHidden = () => {',
      '    if (findReloadBlockingModal(document) !== null) return;',
      '    reload();',
      '  };',
      "  toast.addEventListener('click', () => {",
      '    // reload:user-initiated',
      '    reload();',
      '  });',
      '}',
    ].join('\n');
    assert.deepEqual(unguardedReloadsIn(fixture), []);
  });

  it('flags a second reload the guard does not cover, on another branch (#8663 review)', () => {
    // The hole the outermost-function rule left: the installer DOES consult the
    // guard, so "somewhere in this function" passed. A guard reached later
    // cannot protect a reload that already happened.
    const fixture = [
      'export function installStale(options = {}) {',
      '  const reload = options.reload ?? (() => window.location.reload());',
      '  const reloadOrDefer = () => {',
      '    if (findReloadBlockingModal(document) !== null) return;',
      '    reload();',
      '  };',
      '  const onGiveUp = () => {',
      '    reload();',
      '  };',
      '}',
    ].join('\n');
    assert.deepEqual(unguardedReloadsIn(fixture).map((h) => [h.line, h.text]), [
      [8, 'reload()'],
    ]);
  });

  it('does not let a marker on an ancestor cover an unguarded reload', () => {
    // Marking the handler rather than the statement would re-open the hole.
    const fixture = [
      'export function installSw(options = {}) {',
      '  const reload = options.reload ?? (() => window.location.reload());',
      '  // reload:user-initiated',
      "  toast.addEventListener('click', () => {",
      '    reload();',
      '  });',
      '}',
    ].join('\n');
    assert.deepEqual(unguardedReloadsIn(fixture).map((h) => [h.line, h.text]), [
      [5, 'reload()'],
    ]);
  });

  it('a comment mentioning reload is not a call', () => {
    const fixture = [
      'export function installNothing() {',
      '  // reload() happens elsewhere',
      '  return 1;',
      '}',
    ].join('\n');
    assert.deepEqual(unguardedReloadsIn(fixture), []);
  });

  it('both reload consumers are in the scanned population and guarded', () => {
    // Without this the lockstep rule could pass by scanning nothing.
    for (const consumer of ['src/bootstrap/stale-bundle-check.ts', 'src/bootstrap/sw-update.ts']) {
      assert.ok(scan.reloadConsumers.includes(consumer), `${consumer} must be seen as a reload consumer`);
    }
    assert.deepEqual(
      scan.unguardedReloads,
      [],
      `automatic reloads outside the guard:\n${scan.unguardedReloads.map((r) => `${r.file}:${r.line} ${r.text}`).join('\n')}`,
    );
  });

  it('the exemption list is exactly chunk-reload, and it still has the unguarded call it excuses', () => {
    assert.deepEqual([...RELOAD_GUARD_EXEMPT.keys()], ['src/bootstrap/chunk-reload.ts']);
    assert.deepEqual(scan.staleExemptions, [], 'an exemption that no longer matches an unguarded reload must be deleted');
  });
});
