import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Window } from 'happy-dom';
import { NEWS_INTELLIGENCE_APP_HTML } from '../api/mcp/ui/news-intelligence-app.ts';
import { buildStructuredContent } from '../api/mcp/structured-content.ts';
import { summarizeData } from '../api/mcp/filters.ts';
import { buildUiResourceRead, isUiResourceUri, UI_RESOURCE_LIST_RESPONSE } from '../api/mcp/ui/registry.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { mcpHandler } from '../api/mcp.ts';
import { makeProDeps } from './helpers/mcp-pro-deps.mjs';

const currentUri = 'ui://worldmonitor/news-intelligence-v2.html';
const legacyUri = 'ui://worldmonitor/news-intelligence.html';
const story = (index) => ({
  primaryTitle: `Controlled headline ${index + 1}`, primarySource: 'Controlled Example Wire',
  countryCode: 'US', category: 'conflict', isAlert: index === 0,
  sourceProvenance: { risk: 'unknown', type: 'unknown', summary: 'Provenance not yet reviewed — do not treat as independent journalism.' },
});
const envelope = (rows = Array.from({ length: 8 }, (_, index) => story(index))) => ({
  cached_at: '2026-10-04T12:00:00.000Z', stale: true,
  data: { insights: { status: 'degraded', topStories: rows } },
});
const result = (value, reshaped = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: buildStructuredContent(value, { reshaped, rider: null }),
});
async function mount(wire, callback) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  const posted = [];
  let reads = 0;
  try {
    win.document.write(NEWS_INTELLIGENCE_APP_HTML);
    win.eval('window.parent').postMessage = message => posted.push(message);
    win.fetch = async () => { reads++; throw new Error('Unexpected data read'); };
    win.eval(win.document.querySelector('script').textContent);
    const send = value => win.dispatchEvent(new win.MessageEvent('message', {
      source: win.eval('window.parent'),
      data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: value } },
    }));
    send(wire);
    await win.happyDOM.waitUntilComplete();
    await callback(win.document, send);
    assert.equal(reads, 0);
    assert.equal(posted.filter(message => ['tools/call', 'ui/call-tool'].includes(message?.method)).length, 0);
  } finally {
    await win.happyDOM.close();
  }
}
const rows = document => document.querySelectorAll('.story');
const foot = document => document.getElementById('foot').textContent;

describe('News Intelligence accepted projections', () => {
  it('preserves full, direct-data and text controls with original source warnings and supplied snapshots', async () => {
    const full = envelope();
    for (const [wire, hasSnapshot] of [[result(full), true], [result(full.data), false], [{ content: result(full).content }, true]]) {
      await mount(wire, document => {
        assert.equal(rows(document).length, 8);
        assert.match(document.getElementById('list').textContent, /Provenance not yet reviewed/);
        assert.equal(foot(document).includes('Snapshot: 2026-10-04T12:00:00.000Z (stale)'), hasSnapshot);
      });
    }
  });

  it('renders accepted whole-envelope and direct-data projections with retained metadata only where supplied', async () => {
    const full = envelope();
    for (const [wire, hasSnapshot] of [
      [result(full, true), true], [result(full.data, true), false],
    ]) {
      await mount(wire, document => {
        assert.equal(rows(document).length, 8);
        assert.match(document.getElementById('list').textContent, /Provenance not yet reviewed/);
        assert.match(foot(document), /Showing 8 of 8 loaded stories/);
        assert.equal(foot(document).includes('Snapshot: 2026-10-04T12:00:00.000Z (stale)'), hasSnapshot);
        assert.match(foot(document), /Source reports degraded news intelligence/);
      });
    }
  });

  it('renders actual summary shape and discloses its sample without claiming unloaded originals', async () => {
    const full = envelope();
    const summary = { ...full, data: summarizeData(full.data) };
    assert.equal(summary.data.insights.topStories.count, 8);
    assert.equal(summary.data.insights.topStories.sample.length, 3);
    for (const wire of [result(summary, true), { content: result(summary).content }, result(summary.data, true)]) {
      await mount(wire, document => {
        assert.equal(rows(document).length, 3);
        assert.match(foot(document), /Showing 3 sampled stories of 8 reported stories/);
        assert.match(foot(document), /Full list is not loaded/);
        assert.match(document.getElementById('list').textContent, /Provenance not yet reviewed/);
      });
    }
  });

  it('preserves the original 12-row cap and names the actual loaded total', async () => {
    await mount(result(envelope(Array.from({ length: 15 }, (_, index) => story(index))), true), document => {
      assert.equal(rows(document).length, 12);
      assert.match(foot(document), /Showing 12 of 15 loaded stories/);
      assert.doesNotMatch(foot(document), /sampled|not loaded/);
    });
  });

  it('does not turn unknown or contradictory summary counts into an authoritative total', async () => {
    for (const count of [undefined, null, -1, 1.5, 1, '8']) {
      await mount(result(envelope({ count, sample: [story(0), story(1)] }), true), document => {
        assert.equal(rows(document).length, 2);
        assert.match(foot(document), /Showing 2 sampled stories; total unavailable/);
        assert.doesNotMatch(foot(document), /of .* reported stories/);
      });
    }
  });

  it('does not invent absent originals when a summary sample contains every reported story', async () => {
    for (const sample of [[], [story(0)]]) {
      await mount(result(envelope({ count: sample.length, sample }), true), document => {
        assert.equal(rows(document).length, sample.length);
        assert.match(foot(document), /Sample contains all reported stories/);
        assert.doesNotMatch(foot(document), /Full list is not loaded/);
      });
    }
  });

  it('replaces rows, sample limits and old timestamps on empty, unknown and scalar results', async () => {
    await mount(result(envelope(), true), async (document, send) => {
      send(result({ insights: { topStories: [] } }, true));
      assert.equal(rows(document).length, 0);
      assert.equal(document.getElementById('list').textContent, 'No news stories available.');
      assert.match(foot(document), /Showing 0 of 0 loaded stories/);
      assert.doesNotMatch(foot(document), /Snapshot|stale|degraded|sampled/);
      for (const value of [{ insights: null }, { insights: { topStories: null } }, 'headlines', ['headline'], null]) {
        send(result(value, true));
        assert.equal(rows(document).length, 0);
        assert.equal(document.getElementById('list').textContent, 'News intelligence is temporarily unavailable.');
        assert.equal(foot(document), '');
      }
      send(result({ insights: { topStories: [story(7)] } }, true));
      assert.equal(rows(document).length, 1);
      assert.match(foot(document), /Showing 1 of 1 loaded stories/);
      assert.doesNotMatch(foot(document), /Snapshot|sampled|degraded/);
    });
  });

  it('keeps hostile titles, sources and provenance as literal text', async () => {
    const hostile = '<img src=x onerror="globalThis.pwned=true">';
    await mount(result(envelope([{ ...story(0), primaryTitle: hostile, primarySource: hostile, sourceProvenance: { summary: hostile } }]), true), document => {
      assert.equal(rows(document).length, 1);
      assert.match(document.getElementById('list').textContent, /<img src=x onerror=/);
      assert.equal(document.querySelectorAll('#list img, #list script').length, 0);
    });
  });
});

describe('News Intelligence current and private legacy static resource', () => {
  it('advertises one current URI and preserves original reads without changing discovery totals', async () => {
    assert.equal(CACHE_TOOLS.find(tool => tool.name === 'get_news_intelligence')._uiResourceUri, currentUri);
    assert.equal(UI_RESOURCE_LIST_RESPONSE.filter(resource => resource.name === 'News Intelligence (interactive)').length, 1);
    assert.ok(UI_RESOURCE_LIST_RESPONSE.some(resource => resource.uri === currentUri));
    assert.ok(!UI_RESOURCE_LIST_RESPONSE.some(resource => resource.uri === legacyUri));
    for (const uri of [currentUri, legacyUri]) {
      assert.ok(isUiResourceUri(uri));
      const response = await buildUiResourceRead(10, uri, {});
      const body = await response.json();
      assert.equal(body.result.contents[0].uri, uri);
      assert.equal(body.result.contents[0].text, NEWS_INTELLIGENCE_APP_HTML);
      assert.equal(body.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    }
  });

  it('serves both static URIs anonymously without data reads or quota reservations', async () => {
    const originalFetch = globalThis.fetch;
    const { deps, pipe } = makeProDeps();
    let reads = 0;
    try {
      globalThis.fetch = async () => { reads++; throw new Error('Static UI must not read data'); };
      for (const uri of [currentUri, legacyUri]) {
        const response = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } }),
        }), deps);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.result.contents[0].uri, uri);
        assert.equal(body.result.contents[0].text, NEWS_INTELLIGENCE_APP_HTML);
      }
      assert.equal(pipe.count, 0);
      assert.deepEqual(pipe.ops, []);
      assert.equal(reads, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
