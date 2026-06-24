/**
 * LiveNewsPanel instantiation guard — regression tests
 *
 * Guards against:
 *   1. Happy-variant crash: DEFAULT_LIVE_CHANNELS is [] on happy, so
 *      LiveNewsPanel must not be instantiated without saved channels —
 *      otherwise this.channels[0]! is undefined → constructor crash.
 *   2. Fallback-repopulation: the guard must not fall back to
 *      FULL_LIVE_CHANNELS, which would override an intentionally empty
 *      channel set persisted by the user.
 *   3. Guard completeness: panel-layout.ts must check both
 *      getDefaultLiveChannels() AND loadChannelsFromStorage() so users
 *      with custom-saved channels can still use the panel on happy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function src(relPath: string): string {
  return readFileSync(resolve(root, relPath), 'utf-8');
}

describe('LiveNewsPanel instantiation guard', () => {
  // -------------------------------------------------------------------------
  // 1. Happy variant: DEFAULT_LIVE_CHANNELS is empty
  // -------------------------------------------------------------------------

  it('DEFAULT_LIVE_CHANNELS is [] on happy variant (crash source)', () => {
    const liveNews = src('src/components/LiveNewsPanel.ts');
    const match = liveNews.match(/DEFAULT_LIVE_CHANNELS\s*=\s*SITE_VARIANT\s*===\s*['"]tech['"]\s*\?[^:]+:\s*SITE_VARIANT\s*===\s*['"]happy['"]\s*\?\s*(\[[^\]]*\])/);
    assert.ok(match, 'DEFAULT_LIVE_CHANNELS assignment not found');
    assert.equal(match[1].replace(/\s/g, ''), '[]', 'happy variant DEFAULT_LIVE_CHANNELS must be []');
  });

  // -------------------------------------------------------------------------
  // 2. Constructor must NOT have a FULL_LIVE_CHANNELS fallback
  //    (would override intentionally empty stored channel sets)
  // -------------------------------------------------------------------------

  it('constructor does not fall back to FULL_LIVE_CHANNELS after getDefaultLiveChannels()', () => {
    const liveNews = src('src/components/LiveNewsPanel.ts');
    // Extract the region between the two channel-init lines to check for an
    // unwanted third fallback. We anchor on the lines that must exist.
    const afterDefaults = liveNews.slice(liveNews.indexOf('if (this.channels.length === 0) this.channels = getDefaultLiveChannels();'));
    // The next statement after the defaults fallback must NOT be another
    // this.channels = [...FULL_LIVE_CHANNELS] assignment.
    const nextAssignment = afterDefaults.match(/\n\s*(this\.channels\s*=[^;\n]+)/);
    assert.ok(nextAssignment, 'no line after getDefaultLiveChannels fallback found');
    assert.ok(
      !nextAssignment[1].includes('FULL_LIVE_CHANNELS'),
      `constructor must not immediately fall back to FULL_LIVE_CHANNELS:\n  ${nextAssignment[1]}`,
    );
  });

  it('refreshChannelsFromStorage does not fall back to FULL_LIVE_CHANNELS', () => {
    const liveNews = src('src/components/LiveNewsPanel.ts');
    const refreshBlock = liveNews.match(/refreshChannelsFromStorage[^}]+loadChannelsFromStorage[^}]+getDefaultLiveChannels[^}]+(this\.channels\s*=\s*\[\.\.\.FULL_LIVE_CHANNELS\])?/s);
    assert.ok(refreshBlock, 'refreshChannelsFromStorage block not found');
    assert.ok(
      !refreshBlock[1],
      'refreshChannelsFromStorage must not fall back to FULL_LIVE_CHANNELS',
    );
  });

  // -------------------------------------------------------------------------
  // 3. panel-layout.ts guard must check BOTH default channels AND saved channels
  //    so that users with persisted custom channels on happy can still use the panel
  // -------------------------------------------------------------------------

  it('panel-layout.ts live-news guard checks getDefaultLiveChannels()', () => {
    const layout = src('src/app/panel-layout.ts');
    const guardBlock = layout.match(/this\.lazyPanel\('live-news'[\s\S]*?getDefaultLiveChannels\(\)\.length === 0[\s\S]*?return null;/s);
    assert.ok(
      guardBlock,
      "panel-layout.ts must guard 'live-news' with getDefaultLiveChannels().length > 0",
    );
  });

  it('panel-layout.ts live-news guard also checks loadChannelsFromStorage()', () => {
    const layout = src('src/app/panel-layout.ts');
    const guardBlock = layout.match(/this\.lazyPanel\('live-news'[\s\S]*?loadChannelsFromStorage\(\)\.length === 0[\s\S]*?return null;/s);
    assert.ok(
      guardBlock,
      "panel-layout.ts must also check loadChannelsFromStorage().length > 0 so users with saved channels can use the panel on happy variant",
    );
  });

  it('panel-layout.ts imports both getDefaultLiveChannels and loadChannelsFromStorage', () => {
    const layout = src('src/app/panel-layout.ts');
    assert.ok(
      layout.includes('getDefaultLiveChannels'),
      'panel-layout.ts must import getDefaultLiveChannels',
    );
    assert.ok(
      layout.includes('loadChannelsFromStorage'),
      'panel-layout.ts must import loadChannelsFromStorage',
    );
  });

  // -------------------------------------------------------------------------
  // 4. Mid-session lazy instantiation path
  //    When a happy-variant user adds channels after page load, the panel
  //    must be mountable without a full reload.
  // -------------------------------------------------------------------------

  it('panel-layout.ts exposes mountLiveNewsIfReady() for mid-session instantiation', () => {
    const layout = src('src/app/panel-layout.ts');
    assert.ok(
      layout.includes('mountLiveNewsIfReady'),
      'panel-layout.ts must expose mountLiveNewsIfReady() so channels added mid-session can trigger panel creation',
    );
  });

  it('event-handlers.ts calls mountLiveNewsIfReady when liveChannels changes and panel is missing', () => {
    const handlers = src('src/app/event-handlers.ts');
    // The liveChannels branch must have an else clause that calls mountLiveNewsIfReady
    const liveChannelsBlock = handlers.match(/liveChannels.*?(?=if \(e\.key)/s);
    assert.ok(liveChannelsBlock, 'liveChannels storage handler not found');
    assert.ok(
      handlers.includes('mountLiveNewsIfReady'),
      'event-handlers.ts must call mountLiveNewsIfReady when liveChannels fires and panel does not exist',
    );
  });

  it('App.ts wires mountLiveNewsIfReady callback to panelLayout', () => {
    const app = src('src/App.ts');
    assert.ok(
      app.includes('mountLiveNewsIfReady'),
      'App.ts must wire mountLiveNewsIfReady callback so EventHandlerManager can trigger lazy panel creation',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 'live-news' must NOT be shadowed by a generic RSS NewsPanel
//    Regression: #4382 (perf: split panel chunks by domain) flipped the
//    live-news video panel from an EAGER assignment (ctx.panels['live-news'] =
//    new LiveNewsPanel(), set BEFORE the CANONICAL_FEEDS loop) to a LAZY
//    registration AFTER the loop, and swapped the collision guard from the
//    dynamic `this.ctx.panels[key]` to a static `COLLIDING_NEWS_PANEL_KEYS`
//    set that omits 'live-news'. Result: the loop creates a generic NewsPanel
//    for the 'live-news' key (fed by CANONICAL_FEEDS['live-news'], the energy
//    headlines block), which registers first and — via lazyPanel's dedup
//    guard — BLOCKS the real LiveNewsPanel video registration. The live site
//    rendered "LIVE NEWS … No items in the last 7 days" instead of the 24/7
//    video streams. The loop must exclude 'live-news' so the dedicated video
//    panel owns the key.
// ---------------------------------------------------------------------------

describe("live-news must not be shadowed by a generic NewsPanel (regression #4382)", () => {
  it("CANONICAL_FEEDS defines a 'live-news' key (the latent landmine)", () => {
    const feeds = src('src/config/feeds.ts');
    assert.match(
      feeds,
      /['"]live-news['"]\s*:/,
      "expected a 'live-news' entry in feeds.ts (energy headlines) — this is what lets the CANONICAL_FEEDS loop spawn a NewsPanel that shadows the video panel",
    );
  });

  it("CANONICAL_FEEDS loop in panel-layout.ts must NOT create a generic NewsPanel for 'live-news'", () => {
    const layout = src('src/app/panel-layout.ts');
    const loopStart = layout.indexOf('for (const key of Object.keys(CANONICAL_FEEDS))');
    assert.ok(loopStart !== -1, 'CANONICAL_FEEDS key loop not found in panel-layout.ts');
    const createCall = layout.indexOf('createNewsPanelWithLabel(panelKey', loopStart);
    assert.ok(createCall !== -1, 'createNewsPanelWithLabel call not found inside the loop');
    const loopRegion = layout.slice(loopStart, createCall + 200);

    const skipsLiveNews = /key\s*===\s*['"]live-news['"]/.test(loopRegion);
    const collidesLiveNews = /COLLIDING_NEWS_PANEL_KEYS\s*=\s*new Set\(\[[^\]]*['"]live-news['"]/.test(layout);

    assert.ok(
      skipsLiveNews || collidesLiveNews,
      "panel-layout.ts must exclude 'live-news' from the CANONICAL_FEEDS NewsPanel loop " +
        "(it is the dedicated LiveNewsPanel video key). Without this, the generic NewsPanel " +
        "shadows the video panel and lazyPanel's dedup guard blocks the real one (regression #4382).",
    );
  });
});
