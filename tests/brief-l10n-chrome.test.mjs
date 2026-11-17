import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { renderDigestEmailHtml, injectBriefCta } from '../scripts/lib/digest-email-html.mjs';
import { injectEmailSummary } from '../scripts/lib/email-summary-html.mjs';
import { subjectForBrief } from '../scripts/lib/digest-orchestration-helpers.mjs';
import { buildDigestWebhookPayload } from '../scripts/lib/digest-corroboration.mjs';
import { briefPlural, briefT } from '../shared/brief-strings.js';

const require = createRequire(import.meta.url);
const { buildTeamsDigestPayload } = require('../scripts/lib/notification-teams.cjs');

const NOW = Date.UTC(2026, 10, 17, 7, 0, 0);
const stories = [
  { title: 'Story one', severity: 'critical', sources: ['Reuters'], link: 'https://news.example/1' },
  { title: 'Story two', severity: 'high', sources: ['AP'], link: 'https://news.example/2' },
];
const synthesis = { lead: 'Lead text.', threads: [{ tag: 'Energy', teaser: 'Oil' }], signals: ['Watch this'] };

describe('localized email chrome', () => {
  it('renders French labels and keeps English as the default', () => {
    const fr = renderDigestEmailHtml({ stories, nowMs: NOW, synthesis, magazineUrl: 'https://worldmonitor.app/brief/x', lang: 'fr' }).html;
    for (const label of [briefT('fr', 'email.execSummary'), briefT('fr', 'email.signalsToWatch'), briefT('fr', 'email.openDashboard'), '17 novembre 2026', briefT('fr', 'threat.critical')]) {
      assert.ok(fr.includes(label), label);
    }
    assert.ok(fr.includes('WorldMonitor Brief'));
    const en = renderDigestEmailHtml({ stories, nowMs: NOW, synthesis, magazineUrl: 'https://worldmonitor.app/brief/x' }).html;
    for (const label of ['Executive Summary', 'Signals to watch:', 'Open Dashboard', 'November 17, 2026', 'Open your WorldMonitor Brief →']) {
      assert.ok(en.includes(label), label);
    }
  });

  it('escapes translated strings in HTML', () => {
    const html = injectBriefCta('<div data-brief-cta-slot></div>', 'https://worldmonitor.app/b', 'fr');
    assert.ok(!/>[^<]*'[^<]*</.test(html), 'apostrophes in translated chrome are entity-escaped');
    assert.ok(injectEmailSummary('<div data-ai-summary-slot></div>', 'x', 'en').includes('Executive Summary'));
  });

  it('localizes the truncation notice', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...stories[1], title: `Story ${i} ${'x'.repeat(400)}` }));
    const { html, truncated } = renderDigestEmailHtml({ stories: many, nowMs: NOW, magazineUrl: 'https://worldmonitor.app/b', maxBytes: 12_000, lang: 'de' });
    assert.equal(truncated, true);
    assert.ok(html.includes(briefT('de', 'email.shortened')));
    assert.ok(html.includes(briefT('de', 'email.readFullBrief')));
  });
});

describe('localized subjects', () => {
  it('keeps English byte-identical and translates the rest', () => {
    assert.equal(subjectForBrief({ briefLead: 'x', synthesisLevel: 1, shortDate: 'Nov 17' }), 'WorldMonitor Intelligence Brief — Nov 17');
    assert.equal(subjectForBrief({ briefLead: null, synthesisLevel: 3, shortDate: 'Nov 17' }), 'WorldMonitor Digest — Nov 17');
    const fr = subjectForBrief({ briefLead: 'x', synthesisLevel: 1, shortDate: '17 nov.', lang: 'fr' });
    assert.ok(fr.startsWith('WorldMonitor') && fr.endsWith('17 nov.') && fr !== 'WorldMonitor Intelligence Brief — 17 nov.');
  });
});

describe('Teams digest labels', () => {
  const texts = (payload) => JSON.stringify(payload);
  it('defaults to English and accepts localized labels', () => {
    const en = texts(buildTeamsDigestPayload({ title: 't', summary: 's', stories, briefUrl: 'https://worldmonitor.app/b' }));
    for (const label of ['Open your WorldMonitor Brief', 'Open dashboard', 'Executive summary', '2 stories']) assert.ok(en.includes(label), label);
    const fr = texts(buildTeamsDigestPayload({
      title: 't', summary: 's', stories, briefUrl: 'https://worldmonitor.app/b',
      labels: {
        openBrief: briefT('fr', 'teams.openBrief'),
        openDashboard: briefT('fr', 'teams.openDashboard'),
        execSummary: briefT('fr', 'teams.execSummary'),
        stories: (n) => briefPlural('fr', 'teams.stories', n),
        more: (n) => briefT('fr', 'teams.more', { n }),
      },
    }));
    assert.ok(fr.includes(briefT('fr', 'teams.execSummary')));
    assert.ok(fr.includes(briefPlural('fr', 'teams.stories', 2)));
    assert.ok(!fr.includes('Executive summary'));
  });
});

describe('digest webhook payload', () => {
  it('reports lang "en" and carries the canonical stories', () => {
    const payload = buildDigestWebhookPayload(stories, 'English lead');
    assert.deepEqual(Object.keys(payload), ['version', 'eventType', 'lang', 'stories', 'summary', 'storyCount']);
    assert.equal(payload.lang, 'en');
    assert.equal(payload.summary, 'English lead');
    assert.equal(payload.storyCount, 2);
    assert.equal(buildDigestWebhookPayload([], undefined).summary, null);
  });
});
