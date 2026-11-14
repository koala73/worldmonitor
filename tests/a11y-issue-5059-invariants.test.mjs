import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getPanelToggleA11yState,
  restoreSettingsToggleFocus,
} from '../src/components/unified-settings-interactions.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(__dirname, '..', ...p), 'utf-8');

const settings = read('src', 'components', 'UnifiedSettings.ts');
const css = read('src', 'styles', 'main.css');

describe('panel toggles are real buttons', () => {
  it('panel-toggle-item renders as a button', () => {
    assert.match(settings, /<button\b[^>]*class="panel-toggle-item/);
    assert.doesNotMatch(settings, /<div\b[^>]*class="panel-toggle-item/);
  });

  it('source-toggle-item renders as a button', () => {
    assert.match(settings, /<button\b[^>]*class="source-toggle-item/);
    assert.doesNotMatch(settings, /<div\b[^>]*class="source-toggle-item/);
  });

  it('panel-toggle-item has type="button"', () => {
    assert.match(settings, /<button\b[^>]*type="button"[^>]*class="panel-toggle-item/);
  });

  it('source-toggle-item has type="button"', () => {
    assert.match(settings, /<button\b[^>]*type="button"[^>]*class="source-toggle-item/);
  });

  it('unlocked panel toggles expose their current pressed state', () => {
    assert.deepEqual(
      getPanelToggleA11yState(false, true, 'Markets'),
      { ariaPressed: 'true', ariaLabel: null },
    );
    assert.deepEqual(
      getPanelToggleA11yState(false, false, 'Markets'),
      { ariaPressed: 'false', ariaLabel: null },
    );
  });

  it('locked Pro panels are upgrade actions rather than false toggles', () => {
    assert.deepEqual(
      getPanelToggleA11yState(true, false, 'Force posture'),
      {
        ariaPressed: null,
        ariaLabel: 'Upgrade to Pro to use Force posture',
      },
    );
    assert.match(
      settings,
      /a11yState\.ariaPressed === null \? '' : `aria-pressed=/,
      'locked controls must omit aria-pressed',
    );
    assert.match(settings, /a11yState\.ariaLabel === null \? '' : `aria-label=/);
  });

  it('source-toggle-item has aria-pressed', () => {
    assert.match(settings, /class="source-toggle-item[\s\S]*?aria-pressed=/);
  });

  it('no aria-pressed remains on a non-button element', () => {
    assert.doesNotMatch(settings, /<div\b[^>]*aria-pressed=/);
  });
});

// Settings is a home list of buttons that drill into pages, not a tablist.
// Keyboard users move with Tab and activate with Enter or Space; the page
// heading takes focus on entry and the originating row takes it back.
describe('settings navigation', () => {
  it('uses plain buttons, not a tablist', () => {
    assert.doesNotMatch(settings, /role="tab(list|panel)?"/);
    assert.match(settings, /<button type="button" class="us-row" data-settings-nav=/);
    assert.match(settings, /<button type="button" class="us-back" data-settings-back hidden aria-label=/);
  });

  it('renders Plan & billing on the account page', () => {
    assert.match(settings, /<div class="billing-settings-intro">\s*<h3>Plan &amp; billing<\/h3>/);
    assert.match(settings, /See your current plan and manage payment details, invoices, or cancellation\./);
  });
});

describe('keyboard — toggle focus continuity', () => {
  it('restores focus to the replacement panel control with the same key', () => {
    const focused = [];
    const controls = [
      { dataset: { panel: 'map' }, focus: () => focused.push('map') },
      { dataset: { panel: 'force-posture' }, focus: () => focused.push('force-posture') },
    ];

    restoreSettingsToggleFocus(true, controls, 'panel', 'force-posture');

    assert.deepEqual(focused, ['force-posture']);
  });

  it('restores focus to the replacement source control with the same key', () => {
    const focused = [];
    const controls = [
      { dataset: { source: 'Reuters' }, focus: () => focused.push('Reuters') },
      { dataset: { source: 'AP' }, focus: () => focused.push('AP') },
    ];

    restoreSettingsToggleFocus(true, controls, 'source', 'AP');

    assert.deepEqual(focused, ['AP']);
  });

  it('does not move focus when the activated control did not own focus', () => {
    let focusCalls = 0;
    restoreSettingsToggleFocus(
      false,
      [{ dataset: { panel: 'map' }, focus: () => { focusCalls += 1; } }],
      'panel',
      'map',
    );
    assert.equal(focusCalls, 0);
  });
});

describe('CSS — focus-visible indicator for toggle items', () => {
  it('.panel-toggle-item:focus-visible rule exists', () => {
    assert.match(css, /\.panel-toggle-item:focus-visible\s*[,{]/);
  });

  it('.source-toggle-item:focus-visible rule exists', () => {
    assert.match(css, /\.source-toggle-item:focus-visible\s*[,{]/);
  });

  it('toggle focus-visible uses a high-contrast color', () => {
    const block = css.match(/\.panel-toggle-item:focus-visible[\s\S]*?\{([\s\S]*?)\}/);
    assert.ok(block, 'panel-toggle-item:focus-visible block must exist');
    assert.match(block[1], /--text/, 'toggle focus ring should use --text for visibility');
  });

  it('toggle focus-visible has a visible outline width', () => {
    const block = css.match(/\.panel-toggle-item:focus-visible[\s\S]*?\{([\s\S]*?)\}/);
    assert.ok(block, 'panel-toggle-item:focus-visible block must exist');
    assert.match(block[1], /outline:\s*2px/, 'toggle focus ring should be at least 2px wide');
  });
});

describe('CSS — focus-visible for preference controls', () => {
  it('.wm-pref-group > summary:focus-visible rule exists', () => {
    assert.match(css, /\.wm-pref-group\s*>\s*summary:focus-visible\s*\{/);
  });

  it('.unified-settings-select:focus-visible rule exists', () => {
    assert.match(css, /\.unified-settings-select:focus-visible\s*[,{]/);
  });

  it('.ai-flow-switch input:focus-visible + .ai-flow-slider rule exists', () => {
    assert.match(css, /\.ai-flow-switch\s+input:focus-visible\s*\+\s*\.ai-flow-slider\s*\{/);
  });
});

describe('decorative children are aria-hidden', () => {
  it('panel-toggle-checkbox has aria-hidden="true"', () => {
    assert.match(settings, /panel-toggle-checkbox[\s\S]*?aria-hidden="true"/);
  });

  it('source-toggle-checkbox has aria-hidden="true"', () => {
    assert.match(settings, /source-toggle-checkbox[\s\S]*?aria-hidden="true"/);
  });
});
