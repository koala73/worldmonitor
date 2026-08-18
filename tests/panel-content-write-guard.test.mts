import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  DIRECT_WRITE_PATTERNS,
  LEGACY_DIRECT_CONTENT_WRITES,
  MIGRATED_BY_6557,
  MIN_PANEL_SUBCLASS_FILES,
  adviceFor,
  collectClassBases,
  derivesFromPanel,
  directWritesIn,
  scanRepo,
  stripComments,
} from '../scripts/enforce-panel-content-writes.mjs';

// ---------------------------------------------------------------------------
// Why this test exists (#6557)
// ---------------------------------------------------------------------------
//
// The scan itself lives in scripts/enforce-panel-content-writes.mjs so it can
// run from .husky/pre-push on any `src/` change — the edit this guard must
// catch is "someone changed a panel", which touches nothing under tests/, and
// scripts/prepush-changed-tests.sh only selects a test file when that test file
// is itself in the changed set.
//
// This file is the second half: it proves the scanner has TEETH. Every
// assertion below either exercises a pattern against a fixture, or pins a
// property of the inventory that the CLI trusts.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('Panel content-write invariant (#6557)', () => {
  const scan = scanRepo(REPO_ROOT);

  it('sees the whole Panel subclass population', () => {
    // Without this the scan could silently match nothing (a moved directory, a
    // renamed base class) and every assertion below would pass vacuously.
    assert.ok(
      scan.subclassFiles.length >= MIN_PANEL_SUBCLASS_FILES,
      `expected >= ${MIN_PANEL_SUBCLASS_FILES} Panel subclass files (108 at #6557), found ${scan.subclassFiles.length} — the scan or the base-class name has drifted`,
    );
    assert.ok(
      scan.observed.length > 0,
      'the direct-write patterns matched nothing — the patterns have gone stale',
    );
  });

  it('every pattern matches its own probe, and matches only its own', () => {
    // The previous version asserted `re.source.length > 0`, which is a
    // tautology — even `new RegExp('').source` is the 4-char string "(?:)".
    // Four patterns had neither a probe nor any live call site, so a typo in
    // them was invisible to every assertion in the file.
    for (const { label, re, probe } of DIRECT_WRITE_PATTERNS) {
      assert.ok(re.test(probe), `${label} no longer matches its own probe — the pattern has drifted`);
      assert.deepEqual(
        directWritesIn(probe),
        [`${label} x1`],
        `${label} must match exactly one idiom — patterns must stay mutually exclusive`,
      );
    }
  });

  it('counts occurrences, so a second write of a listed idiom is visible', () => {
    // The load-bearing property. A boolean per (file, idiom) could not see a
    // 16th `setTrustedHtml` added to a file that already had 15, which is the
    // most likely way a fresh #6557 latch gets introduced.
    assert.deepEqual(
      directWritesIn('replaceChildren(this.content, a); replaceChildren(this.content, b);'),
      ['replaceChildren(this.content, …) x2'],
    );
    assert.deepEqual(directWritesIn('this.setContentNodes(row); this.setSafeContent(html);'), []);
  });

  it('tolerates optional-chained and non-null-asserted receivers', () => {
    // `this.content?.` is already live in EnergyCrisisPanel; a bare-dot-only
    // pattern would let the same write through unseen.
    assert.deepEqual(directWritesIn('this.content?.appendChild(row);'), [
      'this.content.appendChild(…) x1',
    ]);
    assert.deepEqual(directWritesIn('this.content!.appendChild(row);'), [
      'this.content.appendChild(…) x1',
    ]);
  });

  it('ignores idioms that appear only inside comments', () => {
    // Both directions matter. False-fail: a migrated file that documents the
    // rule would be accused of regressing. Silent-pass: a file whose only real
    // call is gone stays "observed", so the stale check never asks anyone to
    // delete its entry and it survives as a standing permission slip.
    assert.deepEqual(directWritesIn(stripComments('// replaceChildren(this.content, x)')), []);
    assert.deepEqual(
      directWritesIn(stripComments('/* replaceChildren(this.content, x) */')),
      [],
    );
    assert.deepEqual(
      directWritesIn(stripComments('replaceChildren(this.content, a); // and not this one')),
      ['replaceChildren(this.content, …) x1'],
    );
    // Offsets and line count must survive the strip, or reported lines drift.
    const src = 'a\n// replaceChildren(this.content, x)\nb';
    assert.equal(stripComments(src).length, src.length);
    assert.equal(stripComments(src).split('\n').length, src.split('\n').length);
  });

  it('resolves transitive and generic subclasses', () => {
    const bases = collectClassBases('export default class Deep<T> extends CorrelationPanel {}');
    bases.set('CorrelationPanel', 'Panel');
    assert.equal(derivesFromPanel('Deep', bases), true, 'transitive + generic subclass must be in scope');
    assert.equal(derivesFromPanel('Unrelated', bases), false);
  });

  it('gives positional idioms different advice from replace idioms', () => {
    // The sanctioned helpers WIPE. Telling `SupplyChainPanel.prepend` (which
    // runs under a MutationObserver watching the charts it would destroy) to
    // "render through setContentNodes" would walk someone into a regression.
    assert.match(adviceFor('replaceChildren(this.content, …) x1'), /setContentNodes/);
    assert.match(adviceFor('this.content.prepend(…) x1'), /structural change, not a substitution/);
    assert.match(adviceFor('this.content.insertBefore(…) x1'), /structural change, not a substitution/);
  });

  it('no Panel subclass writes this.content outside the recorded legacy set', () => {
    assert.deepEqual(
      scan.unlisted,
      [],
      'These Panel subclasses mutate this.content directly, so a transient showError() ' +
        'latches the header Error chip over correct data (#6557):\n  ' +
        scan.unlisted.map((pair) => `${pair} -- ${adviceFor(pair.split(' :: ')[1])}`).join('\n  '),
    );
  });

  it('the legacy set has no stale entries — it may only shrink', () => {
    assert.deepEqual(
      scan.stale,
      [],
      'These recorded writes no longer match the tree. Update LEGACY_DIRECT_CONTENT_WRITES ' +
        'in scripts/enforce-panel-content-writes.mjs so the inventory keeps matching reality:\n  ' +
        scan.stale.join('\n  '),
    );
  });

  it('the panels migrated by #6557 still render through Panel', () => {
    // Grounded in the live scan, not just the allowlist: a revert that puts a
    // direct write back into one of these files fails here even if nobody
    // touches LEGACY_DIRECT_CONTENT_WRITES.
    assert.deepEqual(
      scan.regressed,
      [],
      `${scan.regressed.join(', ')} — migrated off direct writes by #6557 and must keep ` +
        'rendering through Panel.setContentNodes() / setTrustedContent().',
    );
    assert.deepEqual(
      scan.relisted,
      [],
      `${scan.relisted.join(', ')} — must not be re-added to the legacy inventory to silence the guard.`,
    );
  });

  it('Panel exposes the sanctioned success-write helpers', () => {
    const panelSource = readFileSync(join(REPO_ROOT, 'src/components/Panel.ts'), 'utf8');

    // The escape hatch the guard points people at must exist, must clear the
    // error state, must cancel a pending debounced write, and must respect the
    // lock BEFORE it writes — otherwise the migration it forces is either a
    // no-op or a paywall hole.
    for (const helper of ['setContentNodes', 'setTrustedContent']) {
      // Bounded to the helper's own body. The previous terminator scanned for
      // the next 2-space `}`, so collapsing a helper to one line swallowed the
      // NEXT method — and a gutted setContentNodes passed on setTrustedContent's
      // compliant body.
      const match = panelSource.match(
        new RegExp(
          `\\n  protected ${helper}\\(([\\s\\S]*?)\\n  (?:\\}|/\\*\\*|protected |private |public )`,
        ),
      );
      assert.ok(match, `Panel.${helper} is missing — the guard has nothing to point call sites at`);
      const code = stripComments(match[1]);
      assert.ok(
        !/\n  (?:protected|private|public) /.test(code),
        `Panel.${helper}'s body capture ran past the method — the extraction regex has drifted`,
      );
      assert.match(
        code,
        /this\.clearErrorState\(\)/,
        `Panel.${helper} must clear the error state, or a recovery render still latches the chip`,
      );
      assert.match(
        code,
        /this\.cancelPendingContentWrite\(\)/,
        `Panel.${helper} must cancel a pending debounced write, or a queued setSafeContent overwrites the recovered DOM 150ms later`,
      );
      // #6714: clearErrorState must run before the bail — it paints nothing —
      // and the bail must still precede every write. Order by index so
      // stripped-comment blank lines cannot defeat the pin.
      const clearIdx = code.indexOf('this.clearErrorState()');
      const bailIdx = code.indexOf('if (this._locked) return;');
      const writeIdx = [
        code.indexOf('this.cancelPendingContentWrite()'),
        code.indexOf('this.replaceContent('),
        code.indexOf('setTrustedHtml('),
        code.indexOf('this.pendingContentHtml ='),
      ].filter((i) => i !== -1);
      assert.ok(
        clearIdx !== -1 && bailIdx !== -1 && clearIdx < bailIdx,
        `Panel.${helper} must clear the error state BEFORE it bails on _locked — a bail before the clear strands the error chip and backoff rung on a locked panel (#6714)`,
      );
      assert.ok(
        writeIdx.every((i) => i > bailIdx),
        `Panel.${helper} must bail on _locked BEFORE it writes — a bail after the write still paints premium content over the upgrade CTA`,
      );
    }
  });
});
