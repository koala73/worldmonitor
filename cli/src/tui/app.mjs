// The application: owns the screen, theme, store, views, overlays and the
// frame loop. Terminal I/O is injected so the app can run headless in tests.
import { SEQ, mix, setTitle, strWidth, truncate } from './term/ansi.mjs';
import { InputDecoder } from './term/input.mjs';
import { ATTR, Screen } from './term/screen.mjs';
import { rect, splitV } from './ui/layout.mjs';
import { THEME_IDS, getTheme, nextThemeId } from './ui/theme.mjs';
import { bootScreen, overlay, pulse, wipe } from './ui/fx.mjs';
import { hit, tabs, ticker } from './ui/widgets.mjs';
import { tickerSegments } from './data/select.mjs';
import { drawDetail } from './ui/detail.mjs';
import { openExternal } from './video.mjs';

const HELP_LINES = [
  'Tab / Shift+Tab   next / previous view        1..9, 0   jump to a view (Alt+1.. after the tenth)',
  '← →  or  h l      move between panes          ↑ ↓ j k   move in a list',
  'PgUp PgDn g G     page / first / last         Enter     expand the selected item',
  'o                 open selected link in browser',
  't / T             next theme / theme picker   a         toggle animations',
  'r                 refresh this view now       W         open the web dashboard',
  '?                 this help                   q         quit',
  '',
  'Mouse: click tabs, rows and buttons · wheel scrolls · click a selected row to expand it',
  'Map: drag pan · wheel zoom · hover highlights a layer · click pins · Enter details',
  '     g globe/flat · s satellite · i imagery · d day/night · L layers · / search · z reset',
  'Brief: ↑↓ story lines · → related sources & news · Enter expand · o open',
  'Live view: Enter plays in the terminal (mpv), w opens an mpv window, b the browser',
];

// Tab-bar hotkey label for the view at index i (see the digit handling in onKey).
function hotkeyFor(i) {
  if (i < 9) return String(i + 1);
  if (i === 9) return '0';
  return i < 19 ? `A-${i - 9}` : '';
}

export class App {
  constructor({ store, catalog, prefs, savePrefs, env = {}, out, cols, rows, depth = 24, now = () => Date.now(), createViews, player, apiKeyPresent = false, fetchImpl = null }) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.detail = null;
    this.catalog = catalog;
    this.prefs = prefs;
    this.savePrefs = savePrefs || (() => {});
    this.env = env;
    this.out = out;
    this.now = now;
    this.player = player;
    this.apiKeyPresent = apiKeyPresent;
    this.depth = depth;
    this.screen = new Screen(cols, rows, { depth });
    this.prev = null;
    this.theme = getTheme(prefs.theme);
    this.anim = prefs.animations !== false;
    this.views = createViews(this);
    const startView = Math.max(0, this.views.findIndex((v) => v.id === prefs.view));
    this.viewIndex = startView;
    this.boot = { startedAt: now(), progress: 0, done: false, skipped: false, stage: '' };
    this.help = false;
    this.themePicker = false;
    this.themePickerIndex = THEME_IDS.indexOf(this.theme.id);
    this.toastState = null;
    this.tabSwitchedAt = 0;
    this.tickerStart = now();
    this.dirty = true;
    this.quitRequested = false;
    this.decoder = new InputDecoder();
    this.hits = [];
    this.frame = 0;
    this.suspended = false;
    this.onQuit = null;
    this.onSuspend = null;
    this.onResume = null;
    store.on('update', () => this.markDirty());
    store.on('error', () => this.markDirty());
  }

  get view() {
    return this.views[this.viewIndex];
  }

  markDirty() {
    this.dirty = true;
  }

  toast(text, ms = 2500, kind = 'info') {
    this.toastState = { text, until: this.now() + ms, kind };
    this.markDirty();
  }

  // `persist: false` previews a theme without writing it to the prefs file.
  setTheme(id, { persist = true } = {}) {
    this.theme = getTheme(id);
    if (persist) {
      this.prefs.theme = this.theme.id;
      this.savePrefs(this.prefs);
    }
    this.prev = null;
    this.markDirty();
  }

  cycleTheme(step = 1) {
    this.setTheme(nextThemeId(this.theme.id, step));
    this.toast(`theme: ${this.theme.label}`);
  }

  toggleAnimations() {
    this.anim = !this.anim;
    this.prefs.animations = this.anim;
    this.savePrefs(this.prefs);
    this.toast(this.anim ? 'animations on' : 'animations off');
  }

  switchView(index) {
    const n = this.views.length;
    const next = ((index % n) + n) % n;
    if (next === this.viewIndex) return;
    if (this.view.unmount) this.view.unmount();
    this.viewIndex = next;
    this.prefs.view = this.view.id;
    this.savePrefs(this.prefs);
    if (this.view.mount) this.view.mount();
    this.tabSwitchedAt = this.now();
    this.markDirty();
  }

  resize(cols, rows) {
    this.screen = new Screen(cols, rows, { depth: this.depth });
    this.prev = null;
    this.markDirty();
  }

  // Open the detail overlay for any record (see ui/detail.mjs).
  openDetail(spec) {
    if (!spec) return;
    this.detail = { spec, scroll: 0 };
    this.markDirty();
  }

  closeDetail() {
    this.detail = null;
    this.markDirty();
  }

  handleDetailKey(ev) {
    const d = this.detail;
    switch (ev.name) {
      case 'escape':
      case 'q':
      case 'enter':
      case 'backspace':
        return this.closeDetail();
      case 'up':
      case 'k':
        d.scroll = Math.max(0, d.scroll - 1);
        return;
      case 'down':
      case 'j':
        d.scroll = Math.min(d.maxScroll ?? Infinity, d.scroll + 1);
        return;
      case 'pageup':
        d.scroll = Math.max(0, d.scroll - 10);
        return;
      case 'pagedown':
        d.scroll = Math.min(d.maxScroll ?? Infinity, d.scroll + 10);
        return;
      case 'home':
      case 'g':
        d.scroll = 0;
        return;
      case 'end':
      case 'G':
        d.scroll = d.maxScroll ?? 0;
        return;
      case 'o':
        if (d.spec.url) {
          openExternal(d.spec.url);
          this.toast(`opening ${truncate(d.spec.url, 60)}`);
        } else this.toast('no link for this item', 1500, 'warn');
        return;
      case 'm':
        if (d.spec.onCenter) {
          this.closeDetail();
          this.switchView(this.views.findIndex((v) => v.id === 'map'));
          d.spec.onCenter();
        }
        return;
      default:
        return;
    }
  }

  // Needs a frame soon: during boot, wipes, toasts, or when the view animates.
  animating() {
    if (!this.boot.done) return true;
    if (this.toastState) return true;
    if (!this.anim) return false;
    if (this.now() - this.tabSwitchedAt < 300) return true;
    return true; // ticker and map sweep run continuously while animations are on
  }

  // --- input -------------------------------------------------------------------

  feed(chunk) {
    for (const ev of this.decoder.push(chunk)) this.handleEvent(ev);
  }

  flushInput() {
    for (const ev of this.decoder.flush()) this.handleEvent(ev);
  }

  handleEvent(ev) {
    // Pointer motion redraws only when a view says so (map hover, drag), so the
    // any-event mouse stream neither forces frames nor cancels a pending one.
    const motion = ev.type === 'mouse' && (ev.kind === 'move' || ev.kind === 'drag' || ev.kind === 'up');
    if (!motion) this.markDirty();
    if (!this.boot.done) {
      if (ev.type === 'key' && (ev.name === 'q' || (ev.ctrl && ev.name === 'c'))) return this.quit();
      if (this.boot.progress >= 1 || ev.name === 'escape' || ev.name === 'enter' || ev.name === 'space') this.boot.skipped = true;
      return;
    }
    if (ev.type === 'mouse') return this.handleMouse(ev);
    if (ev.type !== 'key') return;
    if (ev.ctrl && ev.name === 'c') return this.quit();
    if (this.detail) return this.handleDetailKey(ev);
    if (this.themePicker) return this.handleThemePickerKey(ev);
    if (this.help) {
      if (['escape', '?', 'q', 'enter'].includes(ev.name)) this.help = false;
      return;
    }
    if (this.view.onKey && this.view.onKey(ev)) return;
    switch (ev.name) {
      case 'q':
        return this.quit();
      case '?':
        this.help = true;
        return;
      case 'tab':
        return this.switchView(this.viewIndex + (ev.shift ? -1 : 1));
      case 't':
        return this.cycleTheme(ev.shift ? -1 : 1);
      case 'T':
        this.themePicker = true;
        this.themeBeforePicker = this.theme.id;
        this.themePickerIndex = THEME_IDS.indexOf(this.theme.id);
        return;
      case 'a':
        return this.toggleAnimations();
      case 'r':
        return this.refreshView();
      case 'W':
        openExternal('https://www.worldmonitor.app/dashboard');
        return this.toast('opening the web dashboard');
      case 'o':
        return this.openSelected();
      case 'escape':
        return;
      default:
        break;
    }
    if (/^[0-9]$/.test(ev.name) && ev.ch) {
      // 1..9, 0 reach the first ten views; Alt+1..9 the ones after.
      const n = Number(ev.name);
      const idx = ev.alt ? (n ? 9 + n : -1) : n === 0 ? 9 : n - 1;
      if (idx < 0) return;
      if (idx < this.views.length) this.switchView(idx);
    }
  }

  // Open the selected item's link in the browser (the `o` key and Enter).
  openSelected() {
    const url = this.view.selectedUrl && this.view.selectedUrl();
    if (url) {
      openExternal(url);
      this.toast(`opening ${truncate(url, 60)}`);
    } else this.toast('nothing to open here', 1500, 'warn');
  }

  handleThemePickerKey(ev) {
    const n = THEME_IDS.length;
    const before = this.themePickerIndex;
    if (ev.name === 'escape' || ev.name === 'T' || ev.name === 'q') {
      // Cancel: drop the preview and go back to the theme the picker opened on.
      this.themePicker = false;
      this.setTheme(this.themeBeforePicker || this.prefs.theme, { persist: false });
      return;
    }
    if (ev.name === 'up' || ev.name === 'k') this.themePickerIndex = (this.themePickerIndex + n - 1) % n;
    else if (ev.name === 'down' || ev.name === 'j') this.themePickerIndex = (this.themePickerIndex + 1) % n;
    else if (ev.name === 'enter' || ev.name === 'space') {
      this.setTheme(THEME_IDS[this.themePickerIndex]);
      this.themePicker = false;
      this.toast(`theme: ${this.theme.label}`);
      return;
    }
    if (this.themePickerIndex !== before) this.setTheme(THEME_IDS[this.themePickerIndex], { persist: false }); // live preview
  }

  handleMouse(ev) {
    // Hover / drag go to the view first (the map uses them); nothing else needs motion.
    if (ev.kind === 'move' || ev.kind === 'drag' || ev.kind === 'up') {
      if (this.detail || this.help || this.themePicker) return;
      if (this.view.onMouse) this.view.onMouse(ev);
      return;
    }
    if (this.detail && ev.kind === 'down') {
      // Clicks inside the overlay hit its buttons; outside closes it.
      for (let i = this.hits.length - 1; i >= 0; i--) {
        const h = this.hits[i];
        if (h.onClick && h.detail && ev.x >= h.x && ev.y >= h.y && ev.x < h.x + h.w && ev.y < h.y + h.h) {
          h.onClick(ev);
          return;
        }
      }
      const box = this.detail.box;
      if (!box || ev.x < box.x || ev.y < box.y || ev.x >= box.x + box.w || ev.y >= box.y + box.h) this.closeDetail();
      return;
    }
    if (this.detail && (ev.kind === 'wheelup' || ev.kind === 'wheeldown')) {
      const d = this.detail;
      d.scroll = Math.max(0, Math.min(d.maxScroll ?? Infinity, d.scroll + (ev.kind === 'wheelup' ? -3 : 3)));
      return;
    }
    const overlay = this.help || this.themePicker;
    if (!overlay && this.view.onMouse && (ev.kind === 'down' || ev.kind === 'wheelup' || ev.kind === 'wheeldown') && this.view.onMouse(ev)) return;
    if (ev.kind === 'wheelup' || ev.kind === 'wheeldown') {
      const dir = ev.kind === 'wheelup' ? -1 : 1;
      for (let i = this.hits.length - 1; i >= 0; i--) {
        const h = this.hits[i];
        if (h.onWheel && ev.x >= h.x && ev.y >= h.y && ev.x < h.x + h.w && ev.y < h.y + h.h) {
          h.onWheel(dir, ev);
          return;
        }
      }
      return;
    }
    if (ev.kind !== 'down' || ev.button !== 0) return;
    if (this.help) {
      this.help = false;
      return;
    }
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (h.onClick && ev.x >= h.x && ev.y >= h.y && ev.x < h.x + h.w && ev.y < h.y + h.h) {
        h.onClick(ev);
        return;
      }
    }
  }

  refreshView() {
    const ids = (this.view.sources && this.view.sources()) || ['fast'];
    for (const id of ids) this.store.refresh(id, { force: true }).catch(() => {});
    this.toast(`refreshing ${ids.join(', ')}`);
  }

  quit() {
    this.quitRequested = true;
    for (const v of this.views) v.dispose?.();
    if (this.onQuit) this.onQuit();
  }

  // Hand the terminal to another program (mpv) and take it back afterwards.
  async suspendFor(fn) {
    if (this.suspended) return;
    this.suspended = true;
    if (this.onSuspend) this.onSuspend();
    try {
      return await fn();
    } finally {
      this.suspended = false;
      this.prev = null;
      this.markDirty();
      if (this.onResume) this.onResume();
    }
  }

  // --- rendering -----------------------------------------------------------------

  ctx() {
    return { s: this.screen, t: this.theme, hits: this.hits, now: this.now(), anim: this.anim, app: this };
  }

  render() {
    const now = this.now();
    this.hits = [];
    const s = this.screen;
    const t = this.theme;
    const full = rect(0, 0, s.cols, s.rows);
    s.clear(t.bg);
    const ctx = this.ctx();
    if (!this.boot.done) {
      const finished = bootScreen(ctx, full, this.boot.startedAt, now, this.boot.progress);
      if ((finished && (this.anim ? now - this.boot.startedAt > 2600 : true)) || (this.boot.skipped && this.boot.progress >= 1)) {
        this.boot.done = true;
        this.tabSwitchedAt = now;
        if (this.view.mount) this.view.mount();
      } else if (this.boot.skipped && this.boot.progress < 1) {
        // Skipping only hides the sequence once the data that views need exists.
      }
      this.frame += 1;
      return this.flush();
    }
    const [header, tabBar, body, tick, status] = splitV(full, [1, 1, 'fill', 1, 1]);
    this.drawHeader(ctx, header);
    tabs(
      ctx,
      tabBar,
      this.views.map((v, i) => ({ label: v.label, hotkey: hotkeyFor(i) })),
      this.viewIndex,
      (i) => this.switchView(i),
    );
    s.pushClip(body);
    try {
      this.view.beginFrame?.();
      this.view.render(ctx, body);
      this.view.endFrame?.();
    } catch (err) {
      s.fill(body, ' ', { bg: t.bg });
      s.text(body.x + 2, body.y + 1, `view error: ${err.message}`, { fg: t.bad, bg: t.bg });
      s.text(body.x + 2, body.y + 2, String(err.stack || '').split('\n')[1] || '', { fg: t.dim, bg: t.bg }, body.w - 4);
    }
    s.popClip();
    if (this.anim && now - this.tabSwitchedAt < 260) wipe(ctx, body, (now - this.tabSwitchedAt) / 260);
    this.drawTicker(ctx, tick);
    this.drawStatus(ctx, status);
    if (this.help) overlay(ctx, full, 'KEYS', HELP_LINES);
    if (this.themePicker) this.drawThemePicker(ctx, full);
    if (this.detail) this.drawDetail(ctx, full);
    this.frame += 1;
    return this.flush();
  }

  drawDetail(ctx, full) {
    const d = this.detail;
    const before = this.hits.length;
    d.onOpen = () => this.handleDetailKey({ name: 'o' });
    d.onCenter = () => this.handleDetailKey({ name: 'm' });
    d.onClose = () => this.closeDetail();
    d.box = drawDetail(ctx, full, d.spec, d);
    for (let i = before; i < this.hits.length; i++) this.hits[i].detail = true;
  }

  flush() {
    const outStr = this.screen.diff(this.prev);
    this.prev = this.screen.clone();
    this.dirty = false;
    if (outStr && this.out) this.out(outStr);
    return outStr;
  }

  drawHeader(ctx, r) {
    const { s, t } = ctx;
    const now = this.now();
    s.fill(r, ' ', { bg: t.bg });
    const glow = this.anim ? mix(t.glow[0], t.glow[1], pulse(now, 2400)) : t.accent;
    s.text(r.x + 1, r.y, '◢', { fg: glow, bg: t.bg });
    s.text(r.x + 3, r.y, 'WORLD MONITOR', { fg: t.text, bg: t.bg, attr: ATTR.BOLD });
    s.text(r.x + 17, r.y, '// terminal', { fg: t.dim, bg: t.bg });
    const d = new Date(now);
    const clock = `${d.toISOString().slice(11, 19)}Z`;
    const st = this.store.status();
    const key = this.apiKeyPresent ? 'KEY' : 'ANON';
    const live = this.anim && Math.floor(now / 700) % 2 === 0 ? '●' : '○';
    const right = [
      { text: `${live} LIVE `, fg: st.errors.length ? t.warn : t.good },
      { text: `${st.loaded}/${st.total} feeds `, fg: t.dim },
      { text: `${key} `, fg: this.apiKeyPresent ? t.good : t.dim },
      { text: `${this.theme.label} `, fg: t.accent, onClick: () => this.cycleTheme() },
      { text: clock, fg: t.text, attr: ATTR.BOLD },
    ];
    let x = r.x + r.w - 1 - right.reduce((a, b) => a + strWidth(b.text) + 1, 0);
    for (const seg of right) {
      s.text(x, r.y, seg.text, { fg: seg.fg, bg: t.bg, attr: seg.attr || 0 });
      if (seg.onClick) hit(ctx, rect(x, r.y, strWidth(seg.text), 1), { onClick: seg.onClick });
      x += strWidth(seg.text) + 1;
    }
    if (st.loading.length && this.anim) {
      const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(now / 80) % 10];
      s.text(r.x + 30, r.y, `${spin} ${st.loading[0]}`, { fg: t.dim, bg: t.bg });
    }
  }

  drawTicker(ctx, r) {
    const t = this.theme;
    const segs = tickerSegments(this.store.data, this.store.raw.digest, t);
    const offset = this.anim ? Math.floor((this.now() - this.tickerStart) / 90) : 0;
    ticker(ctx, r, segs.length ? segs : [{ text: 'waiting for market and news data…', fg: t.dim }], offset);
    hit(ctx, r, { onClick: () => this.switchView(this.views.findIndex((v) => v.id === 'news')) });
  }

  drawStatus(ctx, r) {
    const { s, t } = ctx;
    s.fill(r, ' ', { bg: t.panel });
    const now = this.now();
    if (this.toastState && this.toastState.until < now) this.toastState = null;
    const hints = (this.view.hints && this.view.hints()) || '';
    const base = `${hints}${hints ? '  ' : ''}Tab views  ←→ panes  ↑↓ move  Enter open  t theme  ? help  q quit`;
    if (this.toastState) {
      const fg = this.toastState.kind === 'warn' ? t.warn : this.toastState.kind === 'bad' ? t.bad : t.good;
      s.text(r.x + 1, r.y, `▮ ${this.toastState.text}`, { fg, bg: t.panel, attr: ATTR.BOLD }, r.w - 2);
    } else {
      s.text(r.x + 1, r.y, base, { fg: t.dim, bg: t.panel }, r.w - 2);
    }
    const errs = this.store.status().errors;
    if (errs.length) {
      const msg = ` ${errs.length} source error${errs.length > 1 ? 's' : ''} `;
      s.text(r.x + r.w - strWidth(msg) - 1, r.y, msg, { fg: t.bad, bg: t.panel });
    }
  }

  drawThemePicker(ctx, full) {
    const { s, t } = ctx;
    const lines = THEME_IDS.map((id) => {
      const th = getTheme(id);
      return `${id === this.theme.id ? '▸' : ' '} ${th.label.padEnd(14)} ${th.tagline}`;
    });
    // Pad each line so the box leaves room for the colour swatches drawn at its
    // right edge, and clip the text before them.
    const SWATCH_GAP = 9;
    const box = overlay(ctx, full, 'THEMES  (↑↓ preview · Enter keep · Esc back)', lines.map((l) => l + ' '.repeat(SWATCH_GAP)));
    THEME_IDS.forEach((id, i) => {
      const th = getTheme(id);
      const y = box.y + 2 + i;
      if (y >= box.y + box.h - 1) return;
      s.text(box.x + 2, y, lines[i].padEnd(box.w - 4 - SWATCH_GAP), { fg: i === this.themePickerIndex ? t.selText : t.text, bg: i === this.themePickerIndex ? t.borderFocus : t.sel }, box.w - 4 - SWATCH_GAP);
      ['bg', 'accent', 'accent2', 'good', 'warn', 'bad'].forEach((k, j) => s.put(box.x + box.w - 10 + j, y, '█', { fg: th[k], bg: t.sel }));
      hit(ctx, rect(box.x, y, box.w, 1), {
        onClick: () => {
          this.themePickerIndex = i;
          this.setTheme(id);
          this.themePicker = false;
          this.toast(`theme: ${th.label}`);
        },
      });
    });
  }

  title() {
    return setTitle('World Monitor');
  }
}

export { SEQ };
