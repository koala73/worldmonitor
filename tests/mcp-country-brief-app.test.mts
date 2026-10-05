// The Country Brief MCP App card must not show the generating model id
// (plan KTD7: `model` stays in the API response, leaves every rendered surface).
//
// Drives the genuine emitted shell the same way tests/mcp-world-brief-app-stale.test.mts
// does: the HTML `resources/read` serves plus the host postMessage handshake.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';

import { COUNTRY_BRIEF_APP_HTML } from '../api/mcp/ui/country-brief-app';

async function render(payload: unknown, projected = false) {
  const win: any = new Window({ url: 'https://worldmonitor.app/' });
  win.document.write(COUNTRY_BRIEF_APP_HTML);
  await win.happyDOM.waitUntilComplete();
  const script = win.document.querySelector('script');
  assert.ok(script && script.textContent.length > 0, 'app shell must ship an inline bridge script');
  win.eval(script.textContent);
  await win.happyDOM.waitUntilComplete();
  const hostWindow = win.eval('window.parent');
  win.__outbound = [];
  win.__reads = 0;
  hostWindow.postMessage = (message: unknown) => win.__outbound.push(message);
  win.fetch = async () => { win.__reads++; throw new Error('Unexpected network read'); };
  send(win, payload, projected);
  await win.happyDOM.waitUntilComplete();
  return win;
}

function send(win: any, payload: unknown, projected = false) {
  const hostWindow = win.eval('window.parent');
  win.dispatchEvent(new win.MessageEvent('message', {
    data: {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        ...(projected ? { structuredContent: { projection: payload } } : {}),
        _meta: { 'worldmonitor/usage': { used: 1, limit: 50, remaining: 49, resetsAt: '2026-10-06T00:00:00Z', unit: 'requests' } },
      } },
    },
    source: hostWindow,
  }));
}

describe('api/mcp/ui/country-brief-app.ts', () => {
  it('renders the brief and generation date without the model id', async () => {
    const win = await render({
      countryCode: 'FI',
      countryName: 'Finland',
      brief: "SITUATION NOW\nFinland's fiscal space scores 28 of 100 in the Country Resilience Index. [E2]",
      model: 'seeded-model-id-xyz',
      generatedAt: Date.UTC(2026, 8, 23),
      sources: [],
    });
    try {
      const body = win.document.body.textContent;
      assert.match(body, /fiscal space scores 28 of 100/);
      assert.match(win.document.getElementById('foot').textContent, /^Generated 2026-09-23/);
      assert.doesNotMatch(body, /seeded-model-id-xyz/);
    } finally {
      await win.happyDOM.close();
    }
  });
  it('resolves [En] markers and lists the cited World Monitor data', async () => {
    const win = await render({
      countryCode: 'FI',
      countryName: 'Finland',
      brief: "SITUATION NOW\nFinland's fiscal space scores 28 of 100 in the Country Resilience Index. [E2]\nUnknown point stays plain [E9].",
      model: 'seeded-model-id-xyz',
      generatedAt: Date.UTC(2026, 8, 23),
      sources: [{ title: 'Helsinki budget talks', url: 'https://example.com/a', source: 'Reuters' }],
      evidence: [
        { id: 'E2', kind: 'resilience', label: 'Fiscal space', value: '28/100', factText: 'x', asOf: '2026-09-01T00:00:00Z', url: 'https://www.worldmonitor.app/country/FI' },
        { id: 'E3', kind: 'resilience', label: 'Hostile link', value: '5', asOf: '2026-09-02', url: 'javascript:alert(1)' },
        { id: 'E4', kind: 'resilience', label: 'Plain http', value: '7', url: 'http://example.com/insecure' },
        null,
        { kind: 'resilience', label: 'No id', value: '1' },
      ],
    });
    try {
      const doc = win.document;
      const ref = doc.querySelector('#brief .ev-ref');
      assert.ok(ref, 'the [E2] marker must render as an evidence reference');
      assert.equal(ref.textContent, 'E2');
      assert.match(ref.getAttribute('title'), /Fiscal space: 28\/100 \(as of 2026-09-01\)/);
      assert.doesNotMatch(doc.getElementById('brief').textContent, /\[E2\]/, 'no bare [E2] token');
      assert.match(doc.getElementById('brief').textContent, /\[E9\]/, 'unknown ids stay plain text');
      assert.equal(doc.querySelectorAll('#brief .ev-ref').length, 1);

      const sec = doc.getElementById('ev-sec');
      assert.ok(sec && sec.style.display !== 'none', 'evidence section must be visible');
      const rows = doc.querySelectorAll('#evidence .ev-row');
      assert.equal(rows.length, 3, 'only well-formed evidence items render');
      assert.match(rows[0].textContent, /E2/);
      assert.match(rows[0].textContent, /Fiscal space: 28\/100/);
      assert.match(rows[0].textContent, /2026-09-01/);
      const links = [...doc.querySelectorAll('#evidence a')].map((a: any) => a.getAttribute('href'));
      assert.deepEqual(links, ['https://www.worldmonitor.app/country/FI']);
      assert.match(rows[1].textContent, /Hostile link: 5/);
      assert.doesNotMatch(doc.getElementById('evidence').innerHTML, /javascript:/);
      assert.match(rows[2].textContent, /Plain http: 7/);

      // Sources render before the World Monitor data list.
      const srcSec = doc.getElementById('src-sec');
      assert.ok(srcSec.compareDocumentPosition(sec) & 4, 'evidence list sits below sources');
      assert.doesNotMatch(doc.body.textContent, /seeded-model-id-xyz/);
    } finally {
      await win.happyDOM.close();
    }
  });
});

const retainedBrief = {
  countryCode: 'US', countryName: 'United States',
  brief: 'Controlled assessment retains cited evidence [E1].',
  generatedAt: Date.UTC(2026, 9, 5, 10),
  sources: [{ title: 'Controlled source', source: 'Reuters', url: 'https://example.com/evidence' }],
  evidence: [{ id: 'E1', label: 'Observed growth', value: '2.3%', asOf: '2026 Q2' }],
  groundingStories: [],
  digestCoverage: {
    state: 'stale', servedStale: true, staleAgeSeconds: 900,
    staleReason: 'feed_timeout', attemptedAt: '2026-10-05T10:00:00.000Z',
  },
};
function assertOriginalBrief(win: any) {
  const doc = win.document;
  assert.equal(doc.getElementById('brief').textContent, 'Controlled assessment retains cited evidenceE1.');
  assert.equal(doc.querySelector('#sources a').href, 'https://example.com/evidence');
  assert.equal(doc.querySelector('#evidence .ev-row').textContent, 'E1Observed growth: 2.3%as of 2026 Q2');
  assert.equal(doc.getElementById('foot').textContent, 'Generated 2026-10-05T10:00:00.000Z');
  assert.match(doc.getElementById('panel-usage').textContent, /49/);
  assert.equal(win.__reads, 0);
  assert.ok(win.__outbound.every((message: any) => ['ui/notifications/size-changed'].includes(message.method)));
}
describe('Country Brief retained digest disclosure', () => {
  for (const projected of [false, true]) {
    it(`shows neutral retained coverage without changing supplied evidence, projection=${projected}`, async () => {
      const win = await render(retainedBrief, projected);
      try {
        const notice = win.document.getElementById('grounding-notice');
        assert.ok(notice && notice.style.display !== 'none', 'retained digest notice must be visible');
        assert.match(notice.textContent, /news digest is retained, not live/);
        assert.match(notice.textContent, /Current news grounding is not confirmed/);
        assert.match(notice.textContent, /Reported snapshot age: 15 minutes/);
        assert.match(notice.textContent, /Last refresh attempt: 2026-10-05T10:00:00.000Z/);
        assert.match(notice.textContent, /feed_timeout/);
        assert.doesNotMatch(notice.textContent, /assessment used|sources used|grounding was used/i);
        assertOriginalBrief(win);
        const retainedText = notice.textContent;
        send(win, { ...retainedBrief, groundingStories: [{ title: 'Opt-in-compatible article' }] }, projected);
        assert.equal(win.document.getElementById('grounding-notice').textContent, retainedText);
        assertOriginalBrief(win);
      } finally { await win.happyDOM.close(); }
    });
  }
  it('recognizes only exact retained flag or state and reports unknown age without clock inference', async () => {
    const win = await render(retainedBrief);
    try {
      for (const coverage of [{ state: 'stale' }, { servedStale: true }, { state: 'stale', staleAgeSeconds: 0 }, { state: 'stale', staleAgeSeconds: -2 }, { state: 'stale', staleAgeSeconds: '900' }, { state: 'stale', staleAgeSeconds: Infinity }]) {
        send(win, { ...retainedBrief, generatedAt: 1, digestCoverage: coverage });
        const notice = win.document.getElementById('grounding-notice');
        assert.notEqual(notice.style.display, 'none');
        assert.match(notice.textContent, /Snapshot age is unknown/);
        assert.doesNotMatch(notice.textContent, /15 minutes|1970|refresh attempt/);
      }
      for (const coverage of [{ state: 'STALE' }, { servedStale: 'true' }, { state: 'ready', servedStale: false }]) {
        send(win, { ...retainedBrief, digestCoverage: coverage });
        assert.equal(win.document.getElementById('grounding-notice').style.display, 'none');
      }
    } finally { await win.happyDOM.close(); }
  });
  it('keeps bounded reason literal and omits invalid or non-UTC refresh attempts', async () => {
    const reason = '<img src=x onerror=alert(1)>' + 'x'.repeat(300);
    const win = await render({ ...retainedBrief, digestCoverage: { ...retainedBrief.digestCoverage, staleReason: reason, attemptedAt: 'invalid' } });
    try {
      const notice = win.document.getElementById('grounding-notice');
      assert.match(notice.textContent, /<img src=x onerror=alert\(1\)>/);
      assert.ok(notice.textContent.endsWith(reason.slice(0, 240)));
      assert.equal(notice.querySelector('img'), null);
      for (const attemptedAt of ['invalid', '2026-02-30T10:00:00.000Z', '2026-10-05T10:00:00+02:00', '2026-10-05']) {
        send(win, { ...retainedBrief, digestCoverage: { ...retainedBrief.digestCoverage, attemptedAt } });
        assert.doesNotMatch(notice.textContent, /refresh attempt/i);
      }
      assertOriginalBrief(win);
    } finally { await win.happyDOM.close(); }
  });
  it('clears all retained text for fresh, absent, malformed, projected-away and invalid replacements', async () => {
    const win = await render(retainedBrief, true);
    try {
      const { digestCoverage, ...withoutCoverage } = retainedBrief;
      for (const replacement of [
        { ...retainedBrief, digestCoverage: { state: 'complete', servedStale: false } },
        withoutCoverage, { ...retainedBrief, digestCoverage: null },
        { ...retainedBrief, digestCoverage: [] }, { ...retainedBrief, digestCoverage: 'stale' },
        null, false, 'bad', [],
      ]) {
        send(win, replacement, true);
        const notice = win.document.getElementById('grounding-notice');
        assert.equal(notice.style.display, 'none');
        assert.equal(notice.textContent, '');
        assert.doesNotMatch(win.document.getElementById('card').textContent, /feed_timeout|Reported snapshot age|Last refresh attempt|digest is live/i);
        send(win, retainedBrief, true);
        assert.match(notice.textContent, /digest is retained/);
        assertOriginalBrief(win);
      }
    } finally { await win.happyDOM.close(); }
  });
});
