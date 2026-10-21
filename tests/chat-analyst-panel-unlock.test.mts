import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createChatAnalystPanelHarness } from './helpers/chat-analyst-panel-harness.mjs';

const harness = await createChatAnalystPanelHarness();

after(() => {
  harness.cleanup();
});

// Regression: src/components/ChatAnalystPanel.ts (override unlockPanel).
//
// Bug shape: Panel.unlockPanel() wipes this.content via replaceChildren()
// when a previously-locked panel transitions to unlocked. ChatAnalystPanel
// builds all of its chrome (chips, messages, quick actions, INPUT row) in
// buildUI() during the constructor only, so without an override the body
// stays empty after the FREE→PRO unlock fired by
// panel-layout.ts:updatePanelGating(). Symptom: header + PRO badge render
// but the entire content body is blank — the "field is hidden" report.

describe('ChatAnalystPanel — unlockPanel restores chat surface', () => {
  it('initial mount renders chips, messages, quick actions, and input row', () => {
    const panel = harness.createPanel();
    const root = panel.getElement();

    assert.ok(root.querySelector('.chat-analyst-wrapper'), 'wrapper present after ctor');
    assert.ok(root.querySelector('.chat-analyst-chips'), 'chip bar present');
    assert.ok(root.querySelector('.chat-analyst-messages'), 'messages container present');
    assert.ok(root.querySelector('.chat-analyst-quick'), 'quick actions present');
    assert.ok(root.querySelector('.chat-analyst-input'), 'input textarea present');
    assert.ok(root.querySelector('.chat-analyst-send'), 'send button present');
  });

  it('FREE→PRO unlock path (showGatedCta → unlockPanel) restores the input row', () => {
    const panel = harness.createPanel();
    const root = panel.getElement();

    assert.ok(root.querySelector('.chat-analyst-input'), 'input present before gating');

    // Simulate updatePanelGating() seeing FREE/anon — content is replaced
    // with the locked CTA and Panel._locked flips to true.
    panel.showGatedCta('free_tier', () => {});

    assert.equal(
      root.querySelector('.chat-analyst-input'),
      null,
      'input row is wiped while panel is locked',
    );
    assert.ok(root.querySelector('.panel-locked-state'), 'locked CTA rendered');

    // Simulate updatePanelGating() seeing PRO on the next auth snapshot.
    // Pre-fix this leaves this.content empty (the user-visible bug); the
    // ChatAnalystPanel.unlockPanel override re-runs buildUI() to repaint.
    panel.unlockPanel();

    assert.ok(
      root.querySelector('.chat-analyst-wrapper'),
      'wrapper must come back after unlock',
    );
    assert.ok(
      root.querySelector('.chat-analyst-input'),
      'input row must be restored after FREE→PRO unlock — the "field is hidden" bug',
    );
    assert.ok(root.querySelector('.chat-analyst-chips'), 'chip bar restored');
    assert.ok(root.querySelector('.chat-analyst-messages'), 'messages container restored');
    assert.ok(root.querySelector('.chat-analyst-send'), 'send button restored');
    assert.equal(
      root.querySelector('.panel-locked-state'),
      null,
      'locked CTA cleared after unlock',
    );
  });

  it('repeated showGatedCta → unlockPanel cycles continue to restore the surface', () => {
    const panel = harness.createPanel();
    const root = panel.getElement();

    for (let i = 0; i < 3; i++) {
      panel.showGatedCta('free_tier', () => {});
      panel.unlockPanel();

      assert.ok(
        root.querySelector('.chat-analyst-input'),
        `input row must survive lock/unlock cycle ${i + 1}`,
      );
    }
  });

  it('unlockPanel on an already-unlocked panel does not replace the existing wrapper', () => {
    const panel = harness.createPanel();
    const root = panel.getElement();

    const wrapperBefore = root.querySelector('.chat-analyst-wrapper');
    assert.ok(wrapperBefore, 'wrapper present before idempotent unlock');

    // Panel.unlockPanel() early-returns when not locked. The override must
    // not attempt a rebuild in that case (would briefly thrash the DOM and
    // lose any in-progress conversation state).
    panel.unlockPanel();

    const wrappers = root.querySelectorAll('.chat-analyst-wrapper');
    assert.equal(wrappers.length, 1, 'exactly one wrapper after no-op unlock');
    assert.equal(
      wrappers[0],
      wrapperBefore,
      'no-op unlock must NOT replace the existing wrapper instance',
    );
  });
});
