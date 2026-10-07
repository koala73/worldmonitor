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

const currentUri = 'ui://worldmonitor/news-intelligence-v3.html';
const previousUri = 'ui://worldmonitor/news-intelligence-v2.html';
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
    const navigations = [];
    win.open = (...args) => { navigations.push(args); return null; };
    win.eval(win.document.querySelector('script').textContent);
    const send = value => win.dispatchEvent(new win.MessageEvent('message', {
      source: win.eval('window.parent'),
      data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result: value } },
    }));
    send(wire);
    await win.happyDOM.waitUntilComplete();
    const reply = (data, source = win.eval('window.parent')) => win.dispatchEvent(new win.MessageEvent('message', {
      source, data: { jsonrpc: '2.0', ...data },
    }));
    await callback(win.document, send, { win, posted, reply });
    assert.equal(reads, 0);
    assert.equal(navigations.length, 0);
    assert.equal(posted.filter(message => ['tools/call', 'ui/call-tool'].includes(message?.method)).length, 0);
  } finally {
    await win.happyDOM.close();
  }
}
const rows = document => document.querySelectorAll('.story');
const foot = document => document.getElementById('foot').textContent;

describe('Shared shell original source host actions', () => {
  const url = 'https://www.bbc.co.uk/news/articles/crly09gz7ew4o?at_medium=RSS&at_campaign=rss';
  const wire = { ...result(envelope([{ ...story(0), primaryLink: url }]), true),
    _meta: { 'worldmonitor/usage': { unit: 'requests', limit: 50, remaining: 41, resetsAt: '2026-10-07T00:00:00Z' } },
  };
  const click = (document, win, target = document.querySelector('.story-title')) => {
    const event = new win.Event('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const links = posted => posted.filter(message => message.method === 'ui/open-link');
  const status = document => document.getElementById('source-link-status')?.textContent ?? '';
  const clock = win => {
    const timers = [];
    const set = win.setTimeout.bind(win), clear = win.clearTimeout.bind(win);
    win.setTimeout = (callback, delay, ...args) => {
      if (delay !== 30_000) return set(callback, delay, ...args);
      const timer = { callback, cleared: false }; timers.push(timer); return timer;
    };
    win.clearTimeout = timer => {
      if (timers.includes(timer)) timer.cleared = true;
      else clear(timer);
    };
    return timers;
  };

  it('sends the original nested citation to the advertised host and retains loaded observations', async () => {
    await mount(wire, (document, send, { win, posted, reply }) => {
      reply({ id: 1, result: { hostCapabilities: { openLinks: {} } } });
      const before = document.getElementById('list').textContent;
      const footer = foot(document);
      const usage = document.getElementById('panel-usage').textContent;
      const anchor = document.querySelector('.story-title');
      const nested = document.createElement('span'); anchor.append(nested);
      const event = click(document, win, nested);
      assert.equal(links(posted).length, 1, 'the original citation must request the host open-link action');
      assert.equal(event.defaultPrevented, true);
      assert.equal(links(posted)[0].params.url, url);
      assert.equal(anchor.getAttribute('href'), url);
      const request = links(posted)[0];
      assert.notEqual(request.id, 1);
      assert.equal(document.getElementById('source-link-status').getAttribute('role'), 'status');
      click(document, win);
      assert.equal(links(posted).length, 1, 'repeated clicks cannot accumulate pending requests');
      for (const [data, source] of [
        [{ id: request.id, result: {} }, {}],
        [{ id: request.id, result: {}, jsonrpc: '1.0' }, win.eval('window.parent')],
        [{ id: 'unrelated-id', result: {} }, win.eval('window.parent')],
      ]) {
        reply(data, source);
        assert.equal(status(document), 'Requesting this source link from the host.');
      }
      reply({ id: request.id, result: {} });
      assert.equal(status(document), '');
      assert.equal(document.getElementById('list').textContent, before);
      assert.equal(foot(document), footer);
      assert.equal(document.getElementById('panel-usage').textContent, usage);
      click(document, win);
      assert.equal(links(posted).length, 2);
      assert.notEqual(links(posted)[1].id, request.id);
      reply({ id: links(posted)[1].id, result: {} });
    });
  });

  it('prevents silent navigation before initialization and in an unsupported host', async () => {
    await mount(wire, (document, send, { win, posted, reply }) => {
      for (const capabilities of [null, {}, { openLinks: false }, { openLinks: true }, { openLinks: 'yes' }, { openLinks: [] }, { openLinks: null }]) {
        if (capabilities !== null) reply({ id: 1, result: { hostCapabilities: capabilities } });
        assert.equal(click(document, win).defaultPrevented, true);
        assert.equal(links(posted).length, 0);
        assert.equal(status(document), 'Opening source links is unavailable in this host.');
        assert.notEqual(document.getElementById('card').style.display, 'none');
      }
    });
  });

  it('reports host errors and malformed results without erasing source data, then permits retry', async () => {
    await mount(wire, (document, send, { win, posted, reply }) => {
      reply({ id: 1, result: { hostCapabilities: { openLinks: {} } } });
      const before = document.getElementById('list').textContent;
      const usage = document.getElementById('panel-usage').textContent;
      for (const outcome of [{ error: { code: -32603, message: 'Controlled failure' } }, { result: { isError: true } }, { result: null }, { result: 'invalid' }, { result: [] }, {}, { error: { code: -32603, message: 'Controlled failure' }, result: {} }]) {
        click(document, win);
        const request = links(posted).at(-1);
        assert.ok(request, 'source-link errors require a correlated host request');
        reply({ id: request.id, ...outcome });
        assert.equal(status(document), 'The host could not open this source link.');
        assert.equal(document.getElementById('list').textContent, before);
        assert.equal(document.getElementById('panel-usage').textContent, usage);
        assert.equal(document.getElementById('source-link-status').getAttribute('role'), 'status');
        assert.notEqual(document.getElementById('card').style.display, 'none');
      }
    });
  });

  it('reports a missing host response and failed transport without silent fallback', async () => {
    await mount(wire, (document, send, { win, posted, reply }) => {
      reply({ id: 1, result: { hostCapabilities: { openLinks: {} } } });
      const before = document.getElementById('list').textContent;
      const usage = document.getElementById('panel-usage').textContent;
      const timers = clock(win);
      click(document, win);
      assert.equal(timers.length, 1, 'an unanswered source action must have a bounded host deadline');
      timers[0].callback();
      assert.equal(timers[0].cleared, true);
      assert.equal(status(document), 'The host did not respond to this source link.');
      win.eval('window.parent').postMessage = () => { throw new Error('Controlled transport failure'); };
      click(document, win);
      assert.equal(status(document), 'The host could not open this source link.');
      assert.equal(timers[1].cleared, true);
      assert.equal(document.getElementById('list').textContent, before);
      assert.equal(document.getElementById('panel-usage').textContent, usage);
      assert.notEqual(document.getElementById('card').style.display, 'none');
    });
  });

  it('ignores notification-only and stale replies, clears actual timers and cleans up on pagehide', async () => {
    await mount(wire, (document, send, { win, posted, reply }) => {
      reply({ id: 1, result: { hostCapabilities: { openLinks: {} } } });
      const timers = clock(win);
      click(document, win);
      const first = links(posted)[0];
      assert.ok(first);
      reply({ id: first.id, method: 'ui/notifications/size-changed', params: {} });
      assert.equal(status(document), 'Requesting this source link from the host.');
      assert.equal(timers[0].cleared, false);
      reply({ id: first.id, result: {} });
      assert.equal(timers[0].cleared, true);
      click(document, win);
      const second = links(posted)[1];
      assert.notEqual(first.id, second.id);
      reply({ id: first.id, error: { code: -32603, message: 'Stale error' } });
      timers[0].callback();
      assert.equal(status(document), 'Requesting this source link from the host.');
      assert.equal(timers[1].cleared, false);
      win.dispatchEvent(new win.Event('pagehide'));
      assert.equal(timers[1].cleared, true);
      reply({ id: second.id, error: { code: -32603, message: 'Closed view' } });
      assert.notEqual(status(document), 'The host could not open this source link.');
    });
  });

  it('accepts a synchronous host acknowledgement after pending state is established', async () => {
    await mount(wire, (document, send, { win, posted, reply }) => {
      reply({ id: 1, result: { hostCapabilities: { openLinks: {} } } });
      const timers = clock(win);
      win.eval('window.parent').postMessage = message => {
        posted.push(message);
        if (message.method === 'ui/open-link') reply({ id: message.id, result: {} });
      };
      for (let iterationIndex = 0; iterationIndex < 2; iterationIndex++) {
        assert.equal(click(document, win).defaultPrevented, true);
        assert.equal(status(document), '');
        assert.equal(timers[iterationIndex].cleared, true);
      }
      assert.equal(links(posted).length, 2);
      assert.notEqual(links(posted)[0].id, links(posted)[1].id);
    });
  });

  it('keeps non HTTP titles and non-anchor controls outside the host-link action', async () => {
    for (const invalid of ['javascript:alert(1)', '/relative-article']) await mount(result(envelope([{ ...story(0), primaryLink: invalid }])), (document, send, { win, posted, reply }) => {
      reply({ id: 1, result: { hostCapabilities: { openLinks: {} } } });
      assert.equal(document.querySelector('.story-title[href]'), null);
      assert.equal(click(document, win).defaultPrevented, false);
      assert.equal(links(posted).length, 0);
      assert.equal(status(document), '');
    });
  });
});

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
    assert.ok(!UI_RESOURCE_LIST_RESPONSE.some(resource => resource.uri === previousUri));
    for (const uri of [currentUri, previousUri, legacyUri]) {
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
      for (const uri of [currentUri, previousUri, legacyUri]) {
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


describe('News Intelligence supplied story details', () => {
  const detailed = () => ({ ...story(0), primaryLink: 'https://example.com/original', pubDate: '2026-10-02T12:34:56.000Z', threatLevel: 'high', publishers: [{ name: 'Literal Wire', tier: 1 }, { name: 'Undeclared Publisher', tier: null }], publishersUnlisted: 2 });

  it('keeps the safe original link, supplied publication time, threat level and contributing publishers', async () => {
    await mount(result(envelope([detailed()])), document => {
      const row = rows(document)[0];
      const anchor = row.querySelector('a.story-title');
      assert.equal(anchor?.href, 'https://example.com/original');
      assert.equal(anchor?.target, '_blank');
      assert.equal(anchor?.rel, 'noopener noreferrer');
      assert.equal(anchor?.textContent, 'Controlled headline 1');
      assert.equal(row.querySelector('time')?.dateTime, '2026-10-02T12:34:56.000Z');
      assert.match(row.textContent, /Published: 2026-10-02T12:34:56.000Z/);
      assert.match(row.textContent, /Threat: high/);
      assert.match(row.textContent, /conflict/);
      assert.match(row.textContent, /Alert/);
      assert.match(row.textContent, /Literal Wire \(declared tier 1\)/);
      assert.match(row.textContent, /Undeclared Publisher \(tier undeclared\)/);
      assert.match(row.textContent, /2 counted publishers not listed/);
      assert.match(row.textContent, /Provenance not yet reviewed/);
      assert.match(foot(document), /Snapshot: 2026-10-04T12:00:00.000Z/);
    });
  });

  it('keeps unsafe or missing original URLs as literal plain headlines', async () => {
    for (const primaryLink of ['javascript:alert(1)', 'data:text/html,unsafe', '//example.com/original', '', null]) {
      await mount(result(envelope([{...detailed(), primaryLink, primaryTitle: '<img src=x onerror=alert(1)>'}])), document => {
        assert.equal(rows(document)[0].querySelector('a'), null);
        assert.match(rows(document)[0].textContent, /<img src=x onerror=alert\(1\)>/);
        assert.equal(rows(document)[0].querySelector('img'), null);
      });
    }
  });

  it('distinguishes unavailable publication and roster fields and clears details on replacement', async () => {
    await mount(result(envelope([detailed()])), async (document,send) => {
      for (const pubDate of [null, '', 'invalid-date']) {
        send(result(envelope([{...story(0), pubDate}]),true));
        await new Promise(resolve => setTimeout(resolve,0));
        const row=rows(document)[0];
        assert.equal(row.querySelector('a'),null);
        assert.equal(row.querySelector('time'),null);
        assert.match(row.textContent,/Publication time unavailable/);
        assert.match(row.textContent,/Publisher roster unavailable/);
        assert.doesNotMatch(row.textContent,/Threat: high|Literal Wire|2026-10-02/);
      }
      send(result(envelope([{...story(0),publishers:[],publishersUnlisted:0}])));
      await new Promise(resolve=>setTimeout(resolve,0));
      assert.match(rows(document)[0].textContent,/No contributing publishers listed/);
      assert.doesNotMatch(rows(document)[0].textContent,/Publisher roster unavailable/);
      send(result(envelope([detailed()]))); await new Promise(resolve=>setTimeout(resolve,0));
      assert.equal(rows(document)[0].querySelector('a')?.href,'https://example.com/original');
    });
  });

  it('discloses the local publisher cap and unknown unlisted counts without inventing a tier', async () => {
    const publishers=Array.from({length:14},(_,index)=>({name:'Publisher '+index,tier:index===0?0:1}));
    await mount(result(envelope([{...detailed(),publishers,publishersUnlisted:null}])),document=>{
      const row=rows(document)[0];
      assert.match(row.textContent,/Publisher 0 \(tier undeclared\)/);
      assert.match(row.textContent,/Publisher 11/);
      assert.doesNotMatch(row.textContent,/Publisher 12|Publisher 13/);
      assert.match(row.textContent,/Showing 12 of 14 supplied publishers/);
      assert.match(row.textContent,/Unlisted publisher count unavailable/);
      assert.doesNotMatch(row.textContent,/declared tier 0/);
    });
  });

  it('fills the publisher cap with valid names after invalid roster entries', async () => {
    const invalid=Array.from({length:12},(_,index)=>index%2?{name:'   '}:null);
    const valid=Array.from({length:14},(_,index)=>({name:'Valid Publisher '+index,tier:1}));
    await mount(result(envelope([{...detailed(),publishers:[...invalid,...valid],publishersUnlisted:0}])),document=>{
      const row=rows(document)[0];
      assert.match(row.textContent,/Valid Publisher 0 \(declared tier 1\)/);
      assert.match(row.textContent,/Valid Publisher 11 \(declared tier 1\)/);
      assert.doesNotMatch(row.textContent,/Valid Publisher 12|Valid Publisher 13|No contributing publishers listed/);
      assert.match(row.textContent,/Showing 12 of 26 supplied publishers/);
    });
  });
});


describe('News Intelligence supplied reliability and selection coverage', () => {
  const supplied = () => ({
    ...envelope([{ ...story(0), credibilityScore: 77, sourceTier: 2,
      corroboration: { state: 'single-publisher', publishers: 1 } },
    { ...story(1), credibilityScore: 89, sourceTier: 2,
      corroboration: { state: 'corroborated', publishers: 4 } }]),
  });

  it('preserves supplied reliability, source tiers, corroboration and selection drops across accepted shapes', async () => {
    const original = supplied();
    original.data.insights.provenance = { selectionDrops: { admissibility: 0, sourceCap: 3, overflow: 168 } };
    const summary = { ...original, data: summarizeData(original.data) };
    for (const wire of [result(original), result(original.data), { content: result(original).content },
      result(original, true), result(original.data, true), result(summary, true)]) {
      await mount(wire, document => {
        assert.match(rows(document)[0].textContent, /Source reliability: 77\/100/);
        assert.match(rows(document)[0].textContent, /Declared source tier: 2/);
        assert.match(rows(document)[0].textContent, /Corroboration coverage: single-publisher/);
        assert.match(rows(document)[0].textContent, /Reported publishers: 1/);
        assert.match(rows(document)[1].textContent, /Source reliability: 89\/100/);
        assert.match(rows(document)[1].textContent, /Corroboration coverage: corroborated/);
        assert.match(rows(document)[1].textContent, /Reported publishers: 4/);
        assert.match(foot(document), /Selection exclusions: admissibility 0; source cap 3; overflow 168/);
        assert.doesNotMatch(foot(document), /170 (?:loaded|reported) stories/);
      });
    }
  });

  it('keeps supplied selection drops separate from partial summary coverage', async () => {
    const value = supplied();
    value.data.insights.topStories.push(story(2), story(3));
    value.data.insights.provenance = { selectionDrops: { overflow: 168 } };
    await mount(result({ ...value, data: summarizeData(value.data) }, true), document => {
      assert.equal(rows(document).length, 3);
      assert.match(rows(document)[0].textContent, /Source reliability: 77\/100/);
      assert.match(foot(document), /Showing 3 sampled stories of 4 reported stories/);
      assert.match(foot(document), /Full list is not loaded/);
      assert.match(foot(document), /admissibility unavailable; source cap unavailable; overflow 168/);
      assert.doesNotMatch(foot(document), /172 reported stories/);
    });
  });

  it('preserves measured zero and finite reliability without rounding or count inference', async () => {
    for (const credibilityScore of [0, 77.5, 100]) {
      const value = envelope([{ ...story(0), credibilityScore, sourceTier: 4,
        sourceCount: 99, corroboration: { state: 'unknown', publishers: 0 } }]);
      value.data.insights.provenance = { selectionDrops: { admissibility: 0, sourceCap: 0, overflow: 0 } };
      await mount(result(value), document => {
        assert.ok(rows(document)[0].textContent.includes('Source reliability: ' + credibilityScore + '/100'));
        assert.match(rows(document)[0].textContent, /Declared source tier: 4/);
        assert.match(rows(document)[0].textContent, /Corroboration coverage: unknown/);
        assert.match(rows(document)[0].textContent, /Reported publishers: 0/);
        assert.doesNotMatch(rows(document)[0].textContent, /Reported publishers: 99/);
        assert.match(foot(document), /Selection exclusions: admissibility 0; source cap 0; overflow 0/);
      });
    }
  });

  it('rejects malformed selection-drop containers without inventing measured zeros', async () => {
    for (const selectionDrops of [0, false, '', 'invalid', 7, null, [], [0, 0, 0]]) {
      const value = supplied();
      value.data.insights.provenance = { selectionDrops };
      for (const wire of [result(value), result(value.data, true), { content: result(value).content }]) {
        await mount(wire, (document, send) => {
          assert.match(foot(document), /Selection exclusions: admissibility unavailable; source cap unavailable; overflow unavailable/);
          assert.doesNotMatch(foot(document), /admissibility 0|source cap 0|overflow 0/);
          value.data.insights.provenance.selectionDrops = { admissibility: 0, sourceCap: 0, overflow: 0 };
          send(result(value));
          assert.match(foot(document), /Selection exclusions: admissibility 0; source cap 0; overflow 0/);
          value.data.insights.provenance.selectionDrops = selectionDrops;
          send(result(value));
          assert.match(foot(document), /Selection exclusions: admissibility unavailable; source cap unavailable; overflow unavailable/);
        });
      }
    }
  });

  it('keeps invalid or absent values unavailable without accepting incorrect fixture paths', async () => {
    for (const invalid of [undefined, null, '', '2', true, -1, Infinity]) {
      const value = envelope([{ ...story(0), credibilityScore: invalid, sourceTier: invalid,
        corroboration: { state: '<img src=x onerror=alert(1)>', publishers: invalid, publisherCount: 9 } }]);
      value.data.insights.selectionDrops = { admissibility: 9, sourceCap: 9, overflow: 9 };
      value.data.insights.provenance = { selectionDrops: { admissibility: invalid, sourceCap: invalid, overflow: invalid } };
      await mount(result(value), document => {
        assert.match(rows(document)[0].textContent, /Source reliability unavailable/);
        assert.match(rows(document)[0].textContent, /Declared source tier unavailable/);
        assert.match(rows(document)[0].textContent, /Corroboration coverage unavailable/);
        assert.match(rows(document)[0].textContent, /Reported publisher count unavailable/);
        assert.match(foot(document), /Selection exclusions: admissibility unavailable; source cap unavailable; overflow unavailable/);
        assert.equal(document.querySelectorAll('#list img, #list script').length, 0);
      });
    }
  });

  it('rejects out-of-range reliability, undeclared tiers and fractional counts independently', async () => {
    for (const [credibilityScore, sourceTier, publishers] of [[101, 5, 1.5], [-0.1, 0, -1], [NaN, 2.5, '4']]) {
      const value = envelope([{ ...story(0), credibilityScore, sourceTier,
        corroboration: { state: 'tier4-only', publishers } }]);
      value.data.insights.provenance = { selectionDrops: { admissibility: 1.5, sourceCap: -1, overflow: '168' } };
      await mount(result(value), document => {
        assert.match(rows(document)[0].textContent, /Source reliability unavailable/);
        assert.match(rows(document)[0].textContent, /Declared source tier unavailable/);
        assert.match(rows(document)[0].textContent, /Corroboration coverage: tier4-only/);
        assert.match(rows(document)[0].textContent, /Reported publisher count unavailable/);
        assert.match(foot(document), /admissibility unavailable; source cap unavailable; overflow unavailable/);
      });
    }
    await mount(result(envelope([{ ...story(0), sourceTier: 1 }])), document => {
      assert.match(rows(document)[0].textContent, /Declared source tier: 1/);
    });
  });

  it('clears old supplied fields on replacement and preserves partial drop coverage', async () => {
    await mount(result(supplied()), (document, send) => {
      send(result({ insights: { topStories: [story(0)], provenance: { selectionDrops: { overflow: 168 } } } }, true));
      assert.match(rows(document)[0].textContent, /Source reliability unavailable/);
      assert.match(rows(document)[0].textContent, /Declared source tier unavailable/);
      assert.match(rows(document)[0].textContent, /Reported publisher count unavailable/);
      assert.doesNotMatch(rows(document)[0].textContent, /77\/100|single-publisher|Reported publishers: 1/);
      assert.match(foot(document), /admissibility unavailable; source cap unavailable; overflow 168/);
      assert.match(foot(document), /Showing 1 of 1 loaded stories/);
      assert.doesNotMatch(foot(document), /Snapshot|stale|degraded/);
    });
  });
});

describe('News Intelligence publication timestamp wire types', () => {
  it('renders finite epoch milliseconds, including zero, separately from the cache snapshot', async () => {
    for (const [pubDate,expected] of [[1791279480000,'2026-10-06T09:38:00.000Z'],[0,'1970-01-01T00:00:00.000Z'],['2026-10-06T09:38:00.000Z','2026-10-06T09:38:00.000Z']]) {
      await mount(result(envelope([{...story(0),pubDate}])),document=>{
        assert.equal(rows(document)[0].querySelector('time')?.dateTime,expected);
        assert.ok(rows(document)[0].textContent.includes('Published: '+expected));
        assert.match(foot(document),/Snapshot: 2026-10-04T12:00:00.000Z/);
      });
    }
  });

  it('keeps invalid, missing, boolean, nonfinite and out-of-range times unavailable', async () => {
    for (const pubDate of [undefined,null,'','   ','invalid-date',true,false,NaN,Infinity,-Infinity,8640000000000001,-8640000000000001]) {
      await mount(result(envelope([{...story(0),pubDate}])),document=>{
        assert.equal(rows(document)[0].querySelector('time'),null);
        assert.match(rows(document)[0].textContent,/Publication time unavailable/);
        assert.match(foot(document),/Snapshot: 2026-10-04T12:00:00.000Z/);
      });
    }
  });
});
