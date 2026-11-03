// Headless App tests: render frames into the cell buffer with fixture data and
// drive keys, mouse clicks and wheel events through the real dispatch paths.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { App } from '../src/tui/app.mjs';
import { createClient } from '../src/tui/data/client.mjs';
import { Store } from '../src/tui/data/store.mjs';
import { loadCatalog } from '../src/tui/index.mjs';
import { createViews } from '../src/tui/views/index.mjs';
import { THEME_IDS, getTheme } from '../src/tui/ui/theme.mjs';

const bootstrap = JSON.parse(readFileSync(new URL('./fixtures/bootstrap.json', import.meta.url), 'utf8'));
const digest = JSON.parse(readFileSync(new URL('./fixtures/digest.json', import.meta.url), 'utf8'));
const catalog = loadCatalog();

function makeApp({ cols = 160, rows = 45, anim = true } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const store = new Store(createClient({ fetch: async () => ({ ok: true, status: 200, text: async () => '{}', headers: new Map() }) }), { now: () => clock.t });
  Object.assign(store.data, bootstrap.data);
  store.raw.digest = digest;
  store.raw.health = { status: 'WARNING', summary: { total: 10, ok: 9, warn: 1 }, checkedAt: new Date(clock.t).toISOString(), problems: { pizzint: { status: 'STALE_SEED', seedAgeMin: 99 } } };
  store.raw.version = { version: '2.11.0' };
  for (const id of Object.keys(store.sources)) store.meta[id].loadedAt = clock.t;
  const saved = [];
  const app = new App({
    store,
    catalog,
    prefs: { theme: 'neon', animations: anim, view: 'overview' },
    savePrefs: (p) => saved.push({ ...p }),
    out: () => {},
    cols,
    rows,
    createViews,
    now: () => clock.t,
    player: { mpv: null, ytdlp: null, vo: 'tct' },
  });
  // Skip the boot sequence for most tests.
  app.boot.done = true;
  app.view.mount();
  const show = (i) => {
    app.switchView(typeof i === 'string' ? app.views.findIndex((v) => v.id === i) : i);
    clock.t += 500; // past the tab wipe transition
  };
  return { app, store, clock, saved, show };
}

const text = (app) => app.screen.toLines().join('\n');

describe('App frames', () => {
  it('renders the boot sequence and finishes once progress reaches 1', () => {
    const { app, clock } = makeApp();
    app.boot.done = false;
    app.boot.startedAt = clock.t;
    app.render();
    assert.match(text(app), /I N T E L L I G E N C E/);
    app.boot.progress = 1;
    clock.t += 3000;
    app.render();
    assert.equal(app.boot.done, true);
    clock.t += 1000;
    app.render();
    assert.match(text(app), /1:Overview/);
  });
  it('renders every view without errors at desktop and narrow sizes', () => {
    for (const size of [{ cols: 160, rows: 45 }, { cols: 100, rows: 30 }, { cols: 80, rows: 24 }]) {
      const { app, clock } = makeApp(size);
      for (let i = 0; i < app.views.length; i++) {
        app.switchView(i);
        clock.t += 500;
        app.render();
        const frame = text(app);
        assert.ok(!/view error/.test(frame), `${app.view.id} at ${size.cols}x${size.rows}: ${frame.split('\n').find((l) => /view error/.test(l))}`);
        assert.equal(app.screen.toLines().length, size.rows);
      }
    }
  });
  it('shows live data from the fixtures', () => {
    const { app, show } = makeApp();
    app.render();
    const frame = text(app);
    assert.match(frame, /GLOBAL SITUATION/);
    assert.match(frame, /AI WORLD BRIEF/);
    assert.match(frame, /SPX/);
    show('news');
    app.render();
    assert.match(text(app), /SECTIONS/);
    assert.match(text(app), new RegExp(digest.categories.politics.items[0].title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
  it('emits only a diff on the second identical frame', () => {
    const { app } = makeApp({ anim: false });
    const first = app.render();
    assert.ok(first.length > 1000);
    const second = app.render();
    assert.ok(second.length < 400, `second frame should be small, got ${second.length}`);
  });
});

describe('App input', () => {
  it('switches views with Tab, numbers and tab clicks', () => {
    const { app, saved } = makeApp();
    app.render();
    app.handleEvent({ type: 'key', name: 'tab' });
    assert.equal(app.view.id, 'map');
    app.handleEvent({ type: 'key', name: 'tab', shift: true });
    assert.equal(app.view.id, 'overview');
    app.handleEvent({ type: 'key', name: '9', ch: '9' });
    assert.equal(app.view.id, 'climate');
    app.handleEvent({ type: 'key', name: '0', ch: '0' });
    assert.equal(app.view.id, 'predict');
    assert.equal(saved[saved.length - 1].view, 'predict');
    app.render();
    const tabRow = app.screen.toLines()[1];
    const x = tabRow.indexOf('5:Markets');
    app.handleEvent({ type: 'mouse', kind: 'down', button: 0, x: x + 1, y: 1 });
    assert.equal(app.view.id, 'markets');
  });
  it('reaches the views past the tenth with Alt+digit, and 0 still jumps from the map', () => {
    const { app, show } = makeApp();
    app.handleEvent({ type: 'key', name: '1', ch: '1', alt: true });
    assert.equal(app.view.id, app.views[10].id);
    app.handleEvent({ type: 'key', name: '3', ch: '3', alt: true });
    assert.equal(app.view.id, app.views[12].id);
    const wide = makeApp({ cols: 260 }).app;
    wide.render();
    assert.ok(wide.screen.toLines()[1].includes(`A-1:${wide.views[10].label}`), 'tab bar shows the Alt hotkey');
    show('map');
    app.render();
    app.handleEvent({ type: 'key', name: '0', ch: '0' });
    assert.equal(app.view.id, app.views[9].id, '0 is the tenth view, not a map shortcut');
  });
  it('moves list selection with keys, wheel and clicks, and opens on second click', () => {
    const { app, show } = makeApp();
    show('news');
    app.render();
    const items = app.view.lists.items;
    assert.equal(items.selected, 0);
    app.handleEvent({ type: 'key', name: 'down' });
    app.handleEvent({ type: 'key', name: 'j' });
    assert.equal(items.selected, 2);
    app.handleEvent({ type: 'key', name: 'home' });
    assert.equal(items.selected, 0);
    app.render();
    // find a headline row and click it
    const lines = app.screen.toLines();
    const title = digest.categories.politics.items[1].title.slice(0, 15);
    const y = lines.findIndex((l) => l.includes(title));
    assert.ok(y > 2, 'headline row is on screen');
    const x = lines[y].indexOf(title);
    app.handleEvent({ type: 'mouse', kind: 'down', button: 0, x, y });
    assert.equal(items.selected, 1);
    // wheel over the list scrolls (count is small, so selection stays visible)
    app.render();
    app.handleEvent({ type: 'mouse', kind: 'wheeldown', button: -1, x, y });
    assert.ok(items.scroll >= 0);
    assert.equal(app.view.selectedUrl(), digest.categories.politics.items[1].link);
  });
  it('cycles panes with arrows and categories with brackets in News', () => {
    const { app, show } = makeApp();
    show('news');
    app.render();
    assert.equal(app.view.focusedPane, 'items');
    app.handleEvent({ type: 'key', name: 'left' });
    assert.equal(app.view.focusedPane, 'cats');
    app.handleEvent({ type: 'key', name: 'down' });
    assert.equal(app.view.lists.cats.selected, 1);
    app.handleEvent({ type: 'key', name: ']' });
    assert.equal(app.view.lists.cats.selected, 2);
  });
  it('cycles and picks themes, persisting the choice', () => {
    const { app, saved } = makeApp();
    app.render();
    app.handleEvent({ type: 'key', name: 't', ch: 't' });
    assert.equal(app.theme.id, THEME_IDS[1]);
    assert.equal(saved[saved.length - 1].theme, THEME_IDS[1]);
    app.handleEvent({ type: 'key', name: 'T', ch: 'T', shift: true });
    assert.equal(app.themePicker, true);
    app.render();
    assert.match(text(app), /THEMES/);
    app.handleEvent({ type: 'key', name: 'down' });
    app.handleEvent({ type: 'key', name: 'enter' });
    assert.equal(app.themePicker, false);
    assert.equal(app.theme.id, THEME_IDS[2]);
    // click the theme name in the header cycles too
    app.render();
    const header = app.screen.toLines()[0];
    const x = header.indexOf(app.theme.label);
    app.handleEvent({ type: 'mouse', kind: 'down', button: 0, x: x + 1, y: 0 });
    assert.equal(app.theme.id, THEME_IDS[3]);
  });
  it('shows each theme tagline in full beside its colour swatches', () => {
    const { app } = makeApp();
    app.handleEvent({ type: 'key', name: 'T', ch: 'T', shift: true });
    app.render();
    const frame = text(app);
    for (const id of THEME_IDS) assert.ok(frame.includes(getTheme(id).tagline), `tagline for ${id} is cut off`);
  });
  it('previews themes without saving them and restores the original on Esc', () => {
    const { app, saved } = makeApp();
    app.render();
    const original = app.theme.id;
    app.handleEvent({ type: 'key', name: 'T', ch: 'T', shift: true });
    app.handleEvent({ type: 'key', name: 'down' });
    app.handleEvent({ type: 'key', name: 'down' });
    assert.equal(app.theme.id, THEME_IDS[2], 'live preview applies');
    assert.equal(saved.length, 0, 'previews are not persisted');
    app.handleEvent({ type: 'key', name: 'escape' });
    assert.equal(app.themePicker, false);
    assert.equal(app.theme.id, original);
    assert.equal(saved.length, 0);
    assert.equal(app.prefs.theme, original);
  });
  it('expands the selected row on Enter, carrying its link, and closes on Escape', () => {
    const { app, show } = makeApp();
    show('climate');
    app.render();
    assert.match(app.view.selectedUrl(), /^https:\/\/earthquake\.usgs\.gov\//);
    app.handleEvent({ type: 'key', name: 'enter' });
    assert.ok(app.detail, 'Enter expands the row into the detail overlay');
    assert.match(app.detail.spec.url, /^https:\/\/earthquake\.usgs\.gov\//);
    app.render();
    assert.match(text(app), /Magnitude/);
    app.handleEvent({ type: 'key', name: 'escape' });
    assert.equal(app.detail, null);
  });
  it('toggles animations and help, and quits on q', () => {
    const { app, saved } = makeApp();
    app.render();
    app.handleEvent({ type: 'key', name: 'a', ch: 'a' });
    assert.equal(app.anim, false);
    assert.equal(saved[saved.length - 1].animations, false);
    app.handleEvent({ type: 'key', name: '?', ch: '?' });
    app.render();
    assert.match(text(app), /KEYS/);
    app.handleEvent({ type: 'key', name: 'escape' });
    assert.equal(app.help, false);
    let quit = 0;
    app.onQuit = () => quit++;
    app.handleEvent({ type: 'key', name: 'q', ch: 'q' });
    assert.equal(quit, 1);
    app.handleEvent({ type: 'key', name: 'c', ctrl: true });
    assert.equal(quit, 2);
  });
  it('requests lazy sources while Air & Sea is open and releases them after', () => {
    const { app, store, show } = makeApp();
    show('airsea');
    assert.ok(store.wanted.has('flights'));
    assert.ok(store.wanted.has('vessels'));
    app.switchView(0);
    assert.ok(!store.wanted.has('flights'));
  });
  it('Live view lists default channels, cycles sources and falls back to the browser without mpv', () => {
    const { app, show } = makeApp();
    const live = app.views.find((v) => v.id === 'live');
    show('live');
    app.render();
    assert.match(text(app), /Bloomberg/);
    assert.equal(live.current().name, 'Bloomberg');
    const n = live.candidates().length;
    assert.ok(n >= 2);
    app.handleEvent({ type: 'key', name: 's', ch: 's' });
    assert.equal(live.sourceIndex, 1);
    app.handleEvent({ type: 'key', name: ']' });
    assert.equal(live.filter, 1);
    assert.ok(live.channels().every((c) => c.region === catalog.regions[0].key));
  });
});

describe('Narrow layouts', () => {
  it('keeps the Overview stories list on screen at 80x24', () => {
    const { app } = makeApp({ cols: 80, rows: 24 });
    app.render();
    const frame = text(app);
    assert.match(frame, /TOP STORIES/);
    const first = app.view.topStories()[0];
    assert.ok(first, 'fixture has stories');
    assert.ok(frame.includes(String(first.primaryTitle || first.title).slice(0, 12)), 'first story row is visible');
  });
  it('cycles focus only through the panes the layout draws', () => {
    const { app, show } = makeApp({ cols: 100, rows: 30 });
    const cycle = () => {
      const seen = new Set();
      for (let i = 0; i < 6; i++) {
        app.handleEvent({ type: 'key', name: 'right' });
        app.render();
        seen.add(app.view.focusedPane);
      }
      return [...seen].sort();
    };
    show('climate');
    app.render();
    assert.deepEqual(cycle(), ['hazards', 'quakes', 'weather']);
    show('conflict');
    app.render();
    assert.deepEqual(cycle(), ['cii', 'ucdp', 'unrest']);
    show('markets');
    app.render();
    assert.deepEqual(cycle(), ['crypto', 'quotes']);
  });
  it('moves focus off a pane that a resize hides', () => {
    const { app, show } = makeApp({ cols: 160, rows: 45 });
    show('climate');
    app.render();
    app.view.focusPane('anomalies');
    app.resize(100, 30);
    app.render();
    assert.notEqual(app.view.focusedPane, 'anomalies');
  });
});
