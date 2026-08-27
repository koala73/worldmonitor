// End-to-end render of the `get_market_data` MCP App shell against the real
// captured tool response.
//
// The Market Radar widget read `it.changePercent` off every quote row
// while every seeder writes `change`, so all 40 change cells rendered the
// em-dash placeholder `pctText(null)` returns — symbols and prices looked
// perfect, which is why nothing noticed. No suite rendered the widget, so the
// only signals were a schema that agreed with the bug and a prompt that
// repeated it.
//
// This drives the genuine emitted shell: the same HTML `resources/read` serves,
// the same postMessage handshake a host performs, and the committed fixture
// captured from the production MCP endpoint. A field-name drift between the
// widget and its producer shows up here as a column of placeholders.

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';

import { MARKET_RADAR_APP_HTML } from '../api/mcp/ui/market-radar-app';
import { buildProducerBackedMarketFixture } from './helpers/mcp-producer-fixtures.mjs';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures', 'jmespath-samples', 'fat-get-market-data.response.json',
);

// The widget's own placeholder for a value it could not read (shell.ts pctText).
const PLACEHOLDER = '—';

let win: any;
let doc: any;

function textOf(selector: string): string[] {
  return [...doc.querySelectorAll(selector)].map((n: any) => String(n.textContent));
}

describe('api/mcp/ui/market-radar-app.ts — renders the captured get_market_data response', () => {
  before(async () => {
    const fixture = buildProducerBackedMarketFixture(JSON.parse(readFileSync(FIXTURE, 'utf8')));

    win = new Window({ url: 'https://worldmonitor.app/' });
    win.document.write(MARKET_RADAR_APP_HTML);
    await win.happyDOM.waitUntilComplete();

    // happy-dom does not execute a <script> introduced by document.write, so
    // run the served script text itself — the real bridge + renderBody, not a
    // reimplementation of them.
    const script = win.document.querySelector('script');
    assert.ok(script && script.textContent.length > 0, 'app shell must ship an inline bridge script');
    win.eval(script.textContent);
    await win.happyDOM.waitUntilComplete();

    // The bridge captures `window.parent` inside its own realm and drops any
    // message whose source is not that object, so the host handshake has to be
    // impersonated with the in-realm reference (the outer handle is a
    // different proxy and would be silently ignored).
    const hostWindow = win.eval('window.parent');
    win.dispatchEvent(new win.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        // Production dispatch sends the JSON payload as content[0].text.
        // Keep this harness on that wire path so structuredContent shortcuts
        // cannot hide a real response-decoding regression.
        params: { result: { content: [{ type: 'text', text: JSON.stringify(fixture) }] } },
      },
      source: hostWindow,
    }));
    await win.happyDOM.waitUntilComplete();
    doc = win.document;
  });

  after(async () => {
    await win?.happyDOM?.close();
  });

  // Guards the harness itself: if the handshake ever stops rendering, the
  // assertions below would pass vacuously over an empty node list.
  it('renders every quote group from the fixture', () => {
    assert.equal(doc.getElementById('card').style.display, 'block', 'card must be revealed on a tool result');
    assert.equal(
      doc.querySelectorAll('.mgroup').length, 5,
      'fixture carries equities, commodities, crypto, Gulf and sectors',
    );
    assert.equal(textOf('.qsym').length, 40, 'fixture renders 40 quote rows across the five groups');
    assert.equal(textOf('.qsym')[0], 'AAPL');
  });

  it('renders a real percent in every change cell (never the null placeholder)', () => {
    const changes = textOf('.qchg');
    assert.ok(changes.length > 0, 'no change cells rendered — harness broken, not a passing assertion');
    const placeholders = changes.filter((t) => t === PLACEHOLDER);
    assert.deepEqual(
      placeholders, [],
      `${placeholders.length} of ${changes.length} change cells rendered "${PLACEHOLDER}". The widget is ` +
      'reading a quote key the seeders do not write (schema and widget once said changePercent; ' +
      'every producer writes change).',
    );
    for (const text of changes) {
      assert.match(
        text, /^[+-]?\d+\.\d{2}%$/,
        `change cell "${text}" is not a signed percent — pctText did not receive a number`,
      );
    }
  });

  it('renders prices and the Fear & Greed composite, proving the whole payload is reachable', () => {
    const groups = [...doc.querySelectorAll('.mgroup')];
    assert.deepEqual(
      groups.map((g: any) => g.querySelector('.sec-label').textContent),
      ['Equities', 'Commodities', 'Crypto', 'Gulf', 'Sectors'],
    );
    // Sector rows are performance-only — the seeder writes {symbol, name,
    // change} with no price, so a placeholder there is the correct render, not
    // drift. Every other group is priced.
    for (const group of groups.slice(0, 4)) {
      const label = group.querySelector('.sec-label').textContent;
      const prices = [...group.querySelectorAll('.qprice')].map((n: any) => String(n.textContent));
      assert.ok(prices.length > 0, `${label} group rendered no rows`);
      assert.deepEqual(prices.filter((t) => t === PLACEHOLDER), [], `every ${label} row must render a price`);
    }
    assert.match(doc.getElementById('fg-score').textContent, /^\d+$/, 'fear-greed composite score must render');
    assert.ok(doc.getElementById('fg-label').textContent.length > 0, 'fear-greed label must render');
  });
});
