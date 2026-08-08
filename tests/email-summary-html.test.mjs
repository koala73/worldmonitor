// Pure-function tests for the email Executive Summary builder.
//
// Regression guard for the 2026-04-25 evening incident where the
// canonical-synthesis refactor (PR #3396) shipped emails containing
// only the magazine pull-quote (one paragraph) instead of the
// pre-refactor 5-paragraph editorial blob. This builder restores
// the rich format by mapping the structured synthesis (lead +
// threads + signals) into a multi-section HTML block.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { injectEmailSummary } from '../scripts/lib/email-summary-html.mjs';

const SLOT = '<div data-ai-summary-slot></div>';
const TEMPLATE = `<html><body>BEFORE${SLOT}AFTER</body></html>`;

describe('injectEmailSummary — null/empty handling', () => {
  it('strips slot when summary is null', () => {
    const out = injectEmailSummary(TEMPLATE, null);
    assert.ok(!out.includes(SLOT));
    assert.ok(!out.includes('Executive Summary'));
    assert.ok(out.includes('BEFOREAFTER'));
  });

  it('strips slot when summary is undefined', () => {
    const out = injectEmailSummary(TEMPLATE, undefined);
    assert.ok(!out.includes(SLOT));
  });

  it('strips slot when summary is empty string', () => {
    const out = injectEmailSummary(TEMPLATE, '');
    assert.ok(!out.includes(SLOT));
  });

  it('strips slot when synthesis object has empty lead', () => {
    const out = injectEmailSummary(TEMPLATE, { lead: '', threads: [], signals: [] });
    assert.ok(!out.includes(SLOT));
    assert.ok(!out.includes('Executive Summary'));
  });

  it('returns html unchanged when html is empty', () => {
    assert.equal(injectEmailSummary('', { lead: 'x' }), '');
    assert.equal(injectEmailSummary(null, { lead: 'x' }), null);
  });
});

describe('injectEmailSummary — string input (legacy / L3 stub path)', () => {
  it('renders a string summary as the lead block only', () => {
    const out = injectEmailSummary(TEMPLATE, 'A simple stub lead.');
    assert.ok(out.includes('Executive Summary'));
    assert.ok(out.includes('A simple stub lead.'));
    // No threads/signals when summary is a flat string.
    assert.ok(!out.includes('Signals to watch'));
  });
});

describe('injectEmailSummary — structured synthesis (the email regression fix)', () => {
  const richSynthesis = {
    lead: 'Pentagon chief Hegseth declared the US blockade on Iran is going global. The escalation raises the risk of direct military confrontation in the Persian Gulf, a critical chokepoint for global energy markets.',
    threads: [
      { tag: 'Energy', teaser: 'Hegseth fired Navy Secretary Phelan amid Iran-policy rift.' },
      { tag: 'Diplomacy', teaser: 'Rising nuclear risks dominate UN headquarters debate.' },
      { tag: 'Africa', teaser: '36 Nigerian military officers face arraignment for alleged coup plot.' },
    ],
    signals: [
      'Watch for direct US-Iran naval engagement in the Strait of Hormuz.',
      'Watch for further details on the Nigerian coup plot.',
    ],
  };

  it('renders lead + threads + signals (matches pre-refactor multi-section richness)', () => {
    const out = injectEmailSummary(TEMPLATE, richSynthesis);
    // Lead present
    assert.ok(out.includes('Pentagon chief Hegseth'));
    // Each thread tag + teaser present
    assert.ok(out.includes('<b style="color:#f2ede4;">Energy</b> — Hegseth fired'));
    assert.ok(out.includes('<b style="color:#f2ede4;">Diplomacy</b> — Rising nuclear'));
    assert.ok(out.includes('<b style="color:#f2ede4;">Africa</b> — 36 Nigerian'));
    // Signals header + each signal present
    assert.ok(out.includes('Signals to watch:'));
    assert.ok(out.includes('• Watch for direct US-Iran naval engagement'));
    assert.ok(out.includes('• Watch for further details on the Nigerian'));
  });

  it('renders lead-only when threads + signals are both empty (graceful degradation)', () => {
    const out = injectEmailSummary(TEMPLATE, {
      lead: 'A long-enough lead about Hormuz tensions that exceeds the validator floor.',
      threads: [],
      signals: [],
    });
    assert.ok(out.includes('Executive Summary'));
    assert.ok(out.includes('A long-enough lead'));
    assert.ok(!out.includes('Signals to watch'));
    // No threads block emitted when threads is empty.
    assert.ok(!out.includes('— '));
  });

  it('renders lead + threads (no signals) when signals is empty', () => {
    const out = injectEmailSummary(TEMPLATE, {
      lead: 'A long-enough lead about Hormuz tensions.',
      threads: [{ tag: 'Energy', teaser: 'Tensions resurface today.' }],
      signals: [],
    });
    assert.ok(out.includes('Energy</b> — Tensions resurface'));
    assert.ok(!out.includes('Signals to watch'));
  });

  it('skips malformed thread entries without rejecting the whole block', () => {
    const out = injectEmailSummary(TEMPLATE, {
      lead: 'A long-enough lead about Hormuz tensions.',
      threads: [
        { tag: 'Energy', teaser: 'Valid teaser.' },
        { tag: '', teaser: 'no tag — drop' },
        { tag: 'Climate' /* missing teaser */ },
        null,
      ],
      signals: [],
    });
    assert.ok(out.includes('Energy</b> — Valid teaser'));
    assert.ok(!out.includes('no tag'));
    assert.ok(!out.includes('Climate</b>'));
  });

  it('HTML-escapes hostile thread tags / teasers / signals', () => {
    const out = injectEmailSummary(TEMPLATE, {
      lead: 'A long-enough lead text for the validator floor.',
      threads: [
        { tag: 'Energy<script>1', teaser: 'Teaser with "quotes" and <em>tags</em>.' },
      ],
      signals: ['<img src=x onerror=alert(1)>'],
    });
    // Raw script/img must NOT appear; entities should be escaped.
    assert.ok(!out.includes('<script>1'));
    assert.ok(!out.includes('<img src=x'));
    assert.ok(out.includes('Energy&lt;script&gt;1'));
    assert.ok(out.includes('&lt;em&gt;tags&lt;/em&gt;'));
    assert.ok(out.includes('&quot;quotes&quot;'));
    assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  it('skips empty / non-string signal entries', () => {
    const out = injectEmailSummary(TEMPLATE, {
      lead: 'A long-enough lead text for the validator floor.',
      threads: [],
      signals: ['Valid signal.', '', 42, null],
    });
    assert.ok(out.includes('• Valid signal'));
    // Header still emitted because at least one signal is valid.
    assert.ok(out.includes('Signals to watch:'));
    // Only one bullet — the malformed entries are skipped.
    const bullets = (out.match(/• /g) ?? []).length;
    assert.equal(bullets, 1);
  });

  it('emits no signals block when all signal entries are non-string or empty', () => {
    // Greptile P2 regression guard: a non-empty signals array where
    // EVERY entry fails the htmlEscape filter (null / number / empty
    // string) must NOT render an orphan "Signals to watch:" header
    // with no bullets beneath it. Pre-fix behaviour: header rendered
    // alone. Post-fix: filter bullets first, omit header when no
    // bullets survive.
    const out = injectEmailSummary(TEMPLATE, {
      lead: 'A long-enough lead text for the validator floor.',
      threads: [],
      signals: [null, 42, ''],
    });
    assert.ok(!out.includes('Signals to watch:'), 'header must not appear when all bullets dropped');
    assert.ok(!out.includes('• '), 'no bullets when all signal entries malformed');
    // Lead block still rendered — only the signals trailer is omitted.
    assert.ok(out.includes('Executive Summary'));
    assert.ok(out.includes('A long-enough lead'));
  });
});
