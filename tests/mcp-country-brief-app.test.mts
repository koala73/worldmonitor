// The Country Brief MCP App card must not show the generating model id
// (plan KTD7: `model` stays in the API response, leaves every rendered surface).
//
// Drives the genuine emitted shell the same way tests/mcp-world-brief-app-stale.test.mts
// does: the HTML `resources/read` serves plus the host postMessage handshake.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';

import { COUNTRY_BRIEF_APP_HTML } from '../api/mcp/ui/country-brief-app';

async function render(payload: Record<string, unknown>) {
  const win: any = new Window({ url: 'https://worldmonitor.app/' });
  win.document.write(COUNTRY_BRIEF_APP_HTML);
  await win.happyDOM.waitUntilComplete();
  const script = win.document.querySelector('script');
  assert.ok(script && script.textContent.length > 0, 'app shell must ship an inline bridge script');
  win.eval(script.textContent);
  await win.happyDOM.waitUntilComplete();
  const hostWindow = win.eval('window.parent');
  win.dispatchEvent(new win.MessageEvent('message', {
    data: {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } },
    },
    source: hostWindow,
  }));
  await win.happyDOM.waitUntilComplete();
  return win;
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
