import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createMinimalPanelHarness } from './helpers/minimal-panel-harness.mjs';

const harness = await createMinimalPanelHarness();

after(() => {
  harness.cleanup();
});

// Regression: src/components/Panel.ts (showLocked / showGatedCta /
// unlockPanel).
//
// Before the fix, Panel.unlockPanel() called replaceChildren(this.content)
// to clear the lock-state CTA but never restored the subclass UI. Any
// premium-gated subclass whose UI lives only in the constructor (no
// data-driven re-render path) ended up with a permanently empty body
// after the first FREE/anon → PRO auth-state cycle fired by
// panel-layout.ts:updatePanelGating(). Confirmed casualties: ChatAnalystPanel
// (fixed surgically in PR #3797), DeductionPanel (reported as the same
// symptom — header-only, empty body, no input field).
//
// Fix shape: Panel snapshots this.content's child nodes at the moment
// showLocked / showGatedCta replaces them, and unlockPanel re-attaches
// those same node instances. Constructor-only subclasses are repaired
// transparently — no per-subclass override required.

describe('Panel base class — unlockPanel restores pre-lock content', () => {
  it('initial mount renders the constructor-built UI', () => {
    harness.resetConstructorRunCount();
    const panel = harness.createPanel();
    const root = panel.getElement();

    assert.equal(harness.getConstructorRunCount(), 1, 'constructor ran exactly once at mount');
    assert.ok(root.querySelector('.minimal-test-wrapper'), 'wrapper present');
    assert.ok(root.querySelector('.minimal-test-input'), 'input element present');
  });

  it('showGatedCta → unlockPanel restores the original DOM nodes by identity', () => {
    harness.resetConstructorRunCount();
    const panel = harness.createPanel();
    const root = panel.getElement();

    const wrapperBefore = root.querySelector('.minimal-test-wrapper');
    const inputBefore = root.querySelector('.minimal-test-input');
    assert.ok(wrapperBefore, 'wrapper present at mount');
    assert.ok(inputBefore, 'input present at mount');

    // Simulate updatePanelGating() seeing FREE/anon — content is replaced
    // with the locked CTA and Panel._locked flips to true.
    panel.showGatedCta('free_tier', () => {});

    assert.equal(
      root.querySelector('.minimal-test-input'),
      null,
      'input is removed from DOM while locked',
    );
    assert.ok(root.querySelector('.panel-locked-state'), 'locked CTA rendered');

    // Simulate updatePanelGating() seeing PRO on the next auth snapshot.
    panel.unlockPanel();

    const wrapperAfter = root.querySelector('.minimal-test-wrapper');
    const inputAfter = root.querySelector('.minimal-test-input');
    assert.ok(wrapperAfter, 'wrapper restored after unlock');
    assert.ok(inputAfter, 'input restored after unlock');
    assert.equal(
      wrapperAfter,
      wrapperBefore,
      'restored wrapper must be the SAME DOM node instance (identity preserved)',
    );
    assert.equal(
      inputAfter,
      inputBefore,
      'restored input must be the SAME DOM node instance — listeners and ' +
      'subclass references like this.inputEl point at this node',
    );
    assert.equal(
      root.querySelector('.panel-locked-state'),
      null,
      'locked CTA cleared after unlock',
    );
    assert.equal(
      harness.getConstructorRunCount(),
      1,
      'constructor must NOT have re-run — base-class restore reuses original nodes',
    );
  });

  it('showLocked → unlockPanel also restores via the snapshot', () => {
    harness.resetConstructorRunCount();
    const panel = harness.createPanel();
    const root = panel.getElement();

    const inputBefore = root.querySelector('.minimal-test-input');
    assert.ok(inputBefore, 'input present at mount');

    panel.showLocked(['Feature A', 'Feature B']);

    assert.equal(root.querySelector('.minimal-test-input'), null, 'input wiped while locked');
    assert.ok(root.querySelector('.panel-locked-state'), 'lock state rendered');

    panel.unlockPanel();

    const inputAfter = root.querySelector('.minimal-test-input');
    assert.equal(inputAfter, inputBefore, 'input restored by identity from showLocked path too');
  });

  it('repeated lock / unlock cycles continue to restore the same node', () => {
    harness.resetConstructorRunCount();
    const panel = harness.createPanel();
    const root = panel.getElement();
    const inputAtMount = root.querySelector('.minimal-test-input');
    assert.ok(inputAtMount, 'input present at mount');

    for (let i = 0; i < 3; i++) {
      panel.showGatedCta('free_tier', () => {});
      panel.unlockPanel();
      const inputAfter = root.querySelector('.minimal-test-input');
      assert.equal(
        inputAfter,
        inputAtMount,
        `cycle ${i + 1}: input is the same node instance from mount`,
      );
    }

    assert.equal(
      harness.getConstructorRunCount(),
      1,
      'constructor stays at 1 across 3 lock/unlock cycles',
    );
  });

  it('a second showLocked WHILE already locked does not corrupt the snapshot', () => {
    harness.resetConstructorRunCount();
    const panel = harness.createPanel();
    const root = panel.getElement();
    const inputBefore = root.querySelector('.minimal-test-input');

    panel.showGatedCta('free_tier', () => {});
    // Re-entrant lock call — should NOT overwrite the cache with the
    // locked-state CTA, otherwise unlockPanel would "restore" the lock CTA.
    panel.showGatedCta('anonymous', () => {});
    panel.unlockPanel();

    const inputAfter = root.querySelector('.minimal-test-input');
    assert.equal(
      inputAfter,
      inputBefore,
      'snapshot was the pre-lock state, not the first locked CTA',
    );
  });

  it('showGatedCta with an unknown reason is a clean no-op (no half-locked state)', () => {
    // PR #3814 review (Greptile P2): the early-return for PanelGateReason.NONE
    // must run BEFORE any side-effect. If snapshotting / _locked / class-add
    // happened first, the panel would end up visually half-locked (header
    // siblings hidden, panel-is-locked class set, snapshot populated) with
    // no CTA rendered, and an unrelated subsequent unlock would unwind into
    // a confused state.
    harness.resetConstructorRunCount();
    const panel = harness.createPanel();
    const root = panel.getElement();
    const wrapperBefore = root.querySelector('.minimal-test-wrapper');
    const inputBefore = root.querySelector('.minimal-test-input');

    // PanelGateReason.NONE — acknowledged impossible path in the
    // updatePanelGating flow, but the guard must still bail cleanly.
    panel.showGatedCta('none', () => {});

    assert.equal(
      root.querySelector('.minimal-test-wrapper'),
      wrapperBefore,
      'wrapper untouched on unknown-reason showGatedCta',
    );
    assert.equal(
      root.querySelector('.minimal-test-input'),
      inputBefore,
      'input untouched on unknown-reason showGatedCta',
    );
    assert.equal(
      root.querySelector('.panel-locked-state'),
      null,
      'no locked CTA rendered on unknown-reason path',
    );
    assert.equal(
      panel.getElement().classList.contains('panel-is-locked'),
      false,
      'panel-is-locked class must NOT be applied on the early-return path',
    );

    // Sanity: a subsequent real unlock should also be a no-op (since the
    // panel never actually entered the locked state in the first place).
    panel.unlockPanel();
    assert.equal(
      root.querySelector('.minimal-test-input'),
      inputBefore,
      'after unlockPanel, input still the same instance — proves no snapshot was taken',
    );
  });

  it('unlockPanel on a never-locked panel is a no-op (legacy behavior preserved)', () => {
    harness.resetConstructorRunCount();
    const panel = harness.createPanel();
    const root = panel.getElement();
    const wrapperBefore = root.querySelector('.minimal-test-wrapper');

    panel.unlockPanel();

    const wrapperAfter = root.querySelector('.minimal-test-wrapper');
    assert.equal(
      wrapperAfter,
      wrapperBefore,
      'never-locked unlock must leave existing content untouched',
    );
  });
});
