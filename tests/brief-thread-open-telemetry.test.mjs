/**
 * Tests for the U11 brief_thread_open telemetry plumbing.
 *
 * Two surfaces emit `brief-thread-open`:
 *
 *   1. Magazine — `server/_shared/brief-render.js` stamps every story
 *      source-link with `data-thread-open / data-country / data-severity
 *      / data-followed`, and an inline script invokes
 *      `window.umami?.track('brief-thread-open', { … })` on click.
 *
 *   2. Dashboard — `src/components/LatestBriefPanel.ts` fires the same
 *      event from the cover-card click via `trackBriefThreadOpen` in
 *      `src/services/analytics.ts`.
 *
 * The magazine surface is fully testable from Node without jsdom (the
 * renderer is a pure HTML producer; the inline script is a string we
 * eval against a hand-rolled DOM stub). The dashboard surface is
 * exercised through `trackBriefThreadOpen` directly: it short-circuits
 * on missing `window.umami` and forwards the props otherwise. The
 * panel's click-handler-doesn't-throw contract is asserted by the
 * fact that `trackBriefThreadOpen` itself is the only side-effect.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { renderBriefMagazine } from '../server/_shared/brief-render.js';
import { BRIEF_ENVELOPE_VERSION } from '../shared/brief-envelope.js';

// ---------------------------------------------------------------------------
// Envelope fixture (mirrors brief-magazine-render.test.mjs)
// ---------------------------------------------------------------------------

function story(overrides = {}) {
  return {
    clusterId: 'cluster-test-default',
    category: 'Energy',
    country: 'IR',
    threatLevel: 'high',
    headline: 'Iran declares Strait of Hormuz open. Oil drops more than 9%.',
    description: 'Tehran publicly reopened the Strait of Hormuz to commercial shipping today.',
    source: 'Multiple wires',
    sourceUrl: 'https://example.com/hormuz-open',
    whyMatters: 'Hormuz is roughly a fifth of global seaborne oil — a 9% move is a repricing.',
    ...overrides,
  };
}

function envelope(overrides = {}) {
  const data = {
    user: { name: 'Elie', tz: 'UTC' },
    issue: '17.04',
    date: '2026-04-17',
    dateLong: '17 April 2026',
    digest: {
      greeting: 'Good evening.',
      lead: 'The most impactful development today is the reopening of the Strait of Hormuz.',
      numbers: { clusters: 278, multiSource: 21, surfaced: 4 },
      threads: [
        { tag: 'Energy', teaser: 'Iran reopens the Strait of Hormuz.' },
        { tag: 'Diplomacy', teaser: 'Israel–Lebanon ceasefire takes effect.' },
        { tag: 'Maritime', teaser: 'US military expands posture against Iran-linked shipping.' },
        { tag: 'Humanitarian', teaser: 'A record year at sea for Rohingya refugees.' },
      ],
      signals: [
        'Adherence to the Israel–Lebanon ceasefire in the first 72 hours.',
        'Long-term stability of commercial shipping through Hormuz.',
      ],
    },
    stories: [
      story(),
      story({ country: 'IL', category: 'Diplomacy' }),
      story({ country: 'US', category: 'Maritime', threatLevel: 'critical' }),
      story({ country: 'MM', category: 'Humanitarian' }),
    ],
    ...overrides,
  };
  return {
    version: BRIEF_ENVELOPE_VERSION,
    issuedAt: 1_700_000_000_000,
    data,
  };
}

// ---------------------------------------------------------------------------
// Magazine: data-attribute stamping
// ---------------------------------------------------------------------------

/** Pull every source-link anchor and parse its data-* attributes. */
function extractSourceLinks(html) {
  const anchors = [];
  const re = /<a class="source-link"[^>]*?>[^<]*<\/a>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0];
    const attrs = {};
    for (const m of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
      attrs[m[1]] = m[2];
    }
    anchors.push(attrs);
  }
  return anchors;
}

describe('brief-render — U11 source-link stamping', () => {
  it('every source-link carries data-thread-open / data-country / data-severity / data-followed', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: [] });
    const links = extractSourceLinks(html);
    assert.equal(links.length, env.data.stories.length, 'one anchor per story');
    for (const link of links) {
      assert.equal(link['thread-open'], '1');
      assert.ok(link['country'], 'data-country present (single ISO-2 stories)');
      assert.match(link['severity'], /^(critical|high|medium|low)$/);
      assert.match(link['followed'], /^[01]$/);
    }
  });

  it('followedCountries=[] → every story stamps data-followed="0"', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: [] });
    const links = extractSourceLinks(html);
    for (const link of links) {
      assert.equal(link['followed'], '0', `country ${link['country']} should be unfollowed`);
    }
  });

  it('followedCountries match flips data-followed="1" only for the matching country', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: ['US'] });
    const links = extractSourceLinks(html);
    const us = links.find((l) => l['country'] === 'US');
    const ir = links.find((l) => l['country'] === 'IR');
    assert.equal(us['followed'], '1');
    assert.equal(ir['followed'], '0');
  });

  it('followedCountries lookup is case-insensitive (lowercase input matches uppercase story.country)', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: ['us', 'il'] });
    const links = extractSourceLinks(html);
    assert.equal(links.find((l) => l['country'] === 'US')['followed'], '1');
    assert.equal(links.find((l) => l['country'] === 'IL')['followed'], '1');
    assert.equal(links.find((l) => l['country'] === 'IR')['followed'], '0');
  });

  it('composite country "IL / LB": data-followed="1" when any token is followed', () => {
    const env = envelope({
      stories: [
        story({ country: 'IL / LB' }),
        story({ country: 'IL/LB' }),
        story({ country: 'FR / DE' }),
      ],
      digest: {
        ...envelope().data.digest,
        numbers: { clusters: 1, multiSource: 1, surfaced: 3 },
      },
    });
    const html = renderBriefMagazine(env, { followedCountries: ['LB'] });
    const links = extractSourceLinks(html);
    assert.equal(links.length, 3);
    // First two stories tokenize to ['IL', 'LB'] — matched.
    assert.equal(links[0]['followed'], '1');
    assert.equal(links[1]['followed'], '1');
    // Third story tokenizes to ['FR', 'DE'] — not followed.
    assert.equal(links[2]['followed'], '0');
  });

  it('publicMode ignores followedCountries (no recipient identity in the public mirror)', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { publicMode: true, followedCountries: ['US', 'IR', 'IL', 'MM'] });
    const links = extractSourceLinks(html);
    for (const link of links) {
      assert.equal(link['followed'], '0', 'public mirror must always render followed=0');
    }
  });

  it('renderer rejects non-array followedCountries by treating it as empty (defensive parse)', () => {
    const env = envelope();
    // @ts-expect-error — testing the runtime guard
    const html = renderBriefMagazine(env, { followedCountries: 'US' });
    const links = extractSourceLinks(html);
    for (const link of links) {
      assert.equal(link['followed'], '0');
    }
  });

  it('renderer filters non-string entries from followedCountries', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, {
      // @ts-expect-error — testing the runtime guard
      followedCountries: ['US', null, undefined, 42, '', 'IR'],
    });
    const links = extractSourceLinks(html);
    assert.equal(links.find((l) => l['country'] === 'US')['followed'], '1');
    assert.equal(links.find((l) => l['country'] === 'IR')['followed'], '1');
    assert.equal(links.find((l) => l['country'] === 'IL')['followed'], '0');
  });

  it('story.country with no ISO-2 token (free-form text) omits data-country and stays unfollowed', () => {
    const env = envelope({
      stories: [
        story({ country: 'European Union' }),
      ],
      digest: {
        ...envelope().data.digest,
        numbers: { clusters: 1, multiSource: 1, surfaced: 1 },
      },
    });
    const html = renderBriefMagazine(env, { followedCountries: ['US', 'EU'] });
    const links = extractSourceLinks(html);
    assert.equal(links.length, 1);
    assert.equal(links[0]['country'], undefined, 'free-form country yields no ISO-2 token');
    assert.equal(links[0]['followed'], '0');
  });

  it('emits the inline brief-thread-open tracker script in the magazine HTML', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: [] });
    assert.ok(
      html.includes("window.umami.track('brief-thread-open'"),
      'tracker invokes window.umami.track with the brief-thread-open event name',
    );
    assert.ok(
      html.includes("source: 'magazine'"),
      'tracker pins source: magazine',
    );
    assert.ok(
      html.includes('https://abacus.worldmonitor.app/script.js'),
      'umami loader script tag is emitted in the head',
    );
  });
});

// ---------------------------------------------------------------------------
// Magazine: inline tracker script behaviour
// ---------------------------------------------------------------------------

/**
 * Extract the BRIEF_THREAD_OPEN_SCRIPT body from rendered HTML and run
 * it against a hand-rolled DOM stub. Validates the on-click handler:
 *  - reads data-* from the clicked anchor (or its closest ancestor);
 *  - calls window.umami.track('brief-thread-open', { … }) with the
 *    properties baked into the data-attributes;
 *  - never throws when umami is missing or its track method throws.
 */
function makeDomStub() {
  const listeners = [];
  const win = {};
  const doc = {
    addEventListener(type, handler) {
      if (type === 'click') listeners.push(handler);
    },
  };
  return { win, doc, fireClick(target) {
    const ev = { target };
    for (const fn of listeners) fn(ev);
  } };
}

/** Build a minimal element with data-attrs that the script's parent-walk understands. */
function makeElement(dataset = {}, parent = null) {
  return {
    nodeType: 1,
    parentNode: parent,
    dataset,
  };
}

/** Pull the inline tracker script body out of the rendered HTML. */
function extractTrackerScript(html) {
  // The tracker script is the one that contains `brief-thread-open`.
  const scriptRe = /<script>([\s\S]*?brief-thread-open[\s\S]*?)<\/script>/;
  const match = scriptRe.exec(html);
  assert.ok(match, 'tracker script must be present in rendered HTML');
  return match[1];
}

/** Run the tracker script against a DOM/window stub. Returns the stub. */
function runTracker(html, trackImpl) {
  const stub = makeDomStub();
  if (trackImpl) stub.win.umami = { track: trackImpl };
  const script = extractTrackerScript(html);
  // The script is an IIFE referencing `window` and `document` — we
  // rebind both via a local scope.
  const fn = new Function('window', 'document', script);
  fn(stub.win, stub.doc);
  return stub;
}

describe('brief-render — U11 inline tracker', () => {
  it('emits brief-thread-open with country/severity/followed=true on a followed-country click', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: ['US'] });
    const calls = [];
    const stub = runTracker(html, (name, props) => calls.push({ name, props }));
    const link = makeElement({ threadOpen: '1', country: 'US', severity: 'critical', followed: '1' });
    stub.fireClick(link);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'brief-thread-open');
    assert.deepEqual(calls[0].props, {
      country: 'US',
      severity: 'critical',
      followed: true,
      source: 'magazine',
    });
  });

  it('emits followed=false when data-followed="0"', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: [] });
    const calls = [];
    const stub = runTracker(html, (name, props) => calls.push({ name, props }));
    const link = makeElement({ threadOpen: '1', country: 'IR', severity: 'high', followed: '0' });
    stub.fireClick(link);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].props.followed, false);
    assert.equal(calls[0].props.country, 'IR');
    assert.equal(calls[0].props.severity, 'high');
  });

  it('country=null when data-country is absent (free-form story.country)', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: [] });
    const calls = [];
    const stub = runTracker(html, (name, props) => calls.push({ name, props }));
    const link = makeElement({ threadOpen: '1', severity: 'medium', followed: '0' });
    stub.fireClick(link);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].props.country, null);
    assert.equal(calls[0].props.followed, false);
  });

  it('clicks bubble through ancestors: source-link parent walk finds data-thread-open', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: ['US'] });
    const calls = [];
    const stub = runTracker(html, (name, props) => calls.push({ name, props }));
    const anchor = makeElement({ threadOpen: '1', country: 'US', severity: 'critical', followed: '1' });
    const inner = makeElement({}, anchor);
    stub.fireClick(inner);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].props.country, 'US');
  });

  it('clicks outside any source-link are ignored (no track call)', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: ['US'] });
    const calls = [];
    const stub = runTracker(html, (name, props) => calls.push({ name, props }));
    const elsewhere = makeElement({});
    stub.fireClick(elsewhere);
    assert.equal(calls.length, 0);
  });

  it('umami missing → handler is a silent no-op (never throws)', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: ['US'] });
    // No `trackImpl` argument → window.umami is undefined.
    const stub = runTracker(html, null);
    const link = makeElement({ threadOpen: '1', country: 'US', severity: 'critical', followed: '1' });
    assert.doesNotThrow(() => stub.fireClick(link));
  });

  it('umami.track throws → handler swallows and never propagates to the click', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: ['US'] });
    let invocations = 0;
    const stub = runTracker(html, () => {
      invocations += 1;
      throw new Error('umami down');
    });
    const link = makeElement({ threadOpen: '1', country: 'US', severity: 'critical', followed: '1' });
    assert.doesNotThrow(() => stub.fireClick(link));
    assert.equal(invocations, 1, 'track was called and the throw was swallowed');
  });

  it('same source-link clicked twice fires twice (no client-side dedup)', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: [] });
    const calls = [];
    const stub = runTracker(html, (name, props) => calls.push({ name, props }));
    const link = makeElement({ threadOpen: '1', country: 'IR', severity: 'high', followed: '0' });
    stub.fireClick(link);
    stub.fireClick(link);
    assert.equal(calls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Dashboard: trackBriefThreadOpen analytics helper
// ---------------------------------------------------------------------------

/**
 * The dashboard fires `trackBriefThreadOpen({ country: null, followed:
 * false, severity: null, source: 'dashboard' })` from the cover-card
 * click handler. We exercise the helper directly under a mocked
 * `window.umami.track`. The panel's click handler just calls this
 * inside try/catch — its contract is "fire-and-forget; never throw"
 * which is fully captured by `track` itself short-circuiting on a
 * missing `window.umami`.
 */
describe('analytics — trackBriefThreadOpen (dashboard)', () => {
  let _window;
  let svc;

  before(async () => {
    _window = {};
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: _window,
    });
    // Stub other globals analytics.ts touches at module top level.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    svc = await import('../src/services/analytics.ts');
  });

  beforeEach(() => {
    _window.umami = undefined;
  });

  after(() => {
    delete globalThis.window;
    delete globalThis.localStorage;
  });

  it('forwards { country, followed, severity, source } to umami.track', () => {
    const calls = [];
    _window.umami = { track: (name, data) => calls.push({ name, data }) };
    svc.trackBriefThreadOpen({
      country: null,
      followed: false,
      severity: null,
      source: 'dashboard',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'brief-thread-open');
    assert.deepEqual(calls[0].data, {
      country: null,
      followed: false,
      severity: null,
      source: 'dashboard',
    });
  });

  it('passes through magazine-source events with full per-thread props', () => {
    const calls = [];
    _window.umami = { track: (name, data) => calls.push({ name, data }) };
    svc.trackBriefThreadOpen({
      country: 'US',
      followed: true,
      severity: 'critical',
      source: 'magazine',
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].data, {
      country: 'US',
      followed: true,
      severity: 'critical',
      source: 'magazine',
    });
  });

  it('umami absent → silent no-op (no throw)', () => {
    _window.umami = undefined;
    assert.doesNotThrow(() =>
      svc.trackBriefThreadOpen({
        country: null,
        followed: false,
        severity: null,
        source: 'dashboard',
      }),
    );
  });

  it('same event fired twice → both reach umami (no analytics-layer dedup)', () => {
    const calls = [];
    _window.umami = { track: (name, data) => calls.push({ name, data }) };
    const props = { country: 'US', followed: true, severity: 'high', source: 'dashboard' };
    svc.trackBriefThreadOpen(props);
    svc.trackBriefThreadOpen(props);
    assert.equal(calls.length, 2);
  });
});
