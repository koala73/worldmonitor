// Live: the dashboard's news channels and webcams, played in the terminal
// through mpv (kitty graphics or truecolor cells), in an mpv window, or in the
// browser. Sources per channel come from the generated catalog; YouTube
// channel entries resolve through the liveVideoResolved bootstrap key.
import { ATTR } from '../term/screen.mjs';
import { rect, splitH, splitV } from '../ui/layout.mjs';
import { button, heading, kv, label, panel, segments, tabs } from '../ui/widgets.mjs';
import { streamCandidates } from '../data/select.mjs';
import { openExternal, playInTerminal, playInWindow } from '../video.mjs';
import { PaneView, selectedItem } from './base.mjs';

const WEBCAM_REGION_LABELS = { 'middle-east': 'Middle East', europe: 'Europe', americas: 'Americas', asia: 'Asia-Pacific', space: 'Space' };

export class LiveView extends PaneView {
  constructor(app) {
    super(app, { id: 'live', label: 'Live', paneIds: ['channels', 'webcams'], sources: ['liveVideoResolved'] });
    this.filter = 0; // index into filters()
    this.sourceIndex = 0;
    this.lastPlayed = null;
    this.history = [];
  }

  filters() {
    const regions = this.app.catalog.regions || [];
    return [{ key: 'defaults', label: 'Defaults' }, ...regions.map((r) => ({ key: r.key, label: r.label })), { key: 'all', label: 'All' }];
  }

  channels() {
    const all = (this.app.catalog.channels || []).filter((c) => c.sources.length);
    const f = this.filters()[this.filter] || { key: 'defaults' };
    if (f.key === 'defaults') {
      const ids = this.app.catalog.defaultChannelIds || [];
      return ids.map((id) => all.find((c) => c.id === id)).filter(Boolean);
    }
    if (f.key === 'all') return all;
    return all.filter((c) => c.region === f.key);
  }

  webcams() {
    return (this.app.catalog.webcams || []).filter((w) => w.sources.length);
  }

  current() {
    if (this.focusedPane === 'webcams') {
      const w = selectedItem(this.lists.webcams, this.webcams());
      return w ? { kind: 'webcam', id: w.id, name: `${w.city} webcam`, sub: `${w.country} · ${WEBCAM_REGION_LABELS[w.region] || w.region}`, sources: w.sources } : null;
    }
    const c = selectedItem(this.lists.channels, this.channels());
    return c ? { kind: 'channel', id: c.id, name: c.name, sub: `${c.handle || ''}${c.geo ? ` · available in ${c.geo.join(', ')}` : ''}`, sources: c.sources } : null;
  }

  candidates() {
    const cur = this.current();
    if (!cur) return [];
    return streamCandidates(cur.sources, this.data.liveVideoResolved, this.app.now());
  }

  candidate() {
    const list = this.candidates();
    if (!list.length) return null;
    return list[Math.min(this.sourceIndex, list.length - 1)];
  }

  selectedUrl() {
    return this.candidate()?.url || null;
  }

  setFilter(i) {
    const n = this.filters().length;
    this.filter = ((i % n) + n) % n;
    this.lists.channels.first();
    this.sourceIndex = 0;
  }

  onKey(ev) {
    if (ev.name === '[' || ev.name === ']') {
      this.setFilter(this.filter + (ev.name === ']' ? 1 : -1));
      return true;
    }
    if (ev.name === 's') {
      const n = this.candidates().length;
      if (n) this.sourceIndex = (this.sourceIndex + 1) % n;
      return true;
    }
    if (ev.name === 'w') {
      this.play('window');
      return true;
    }
    if (ev.name === 'b') {
      this.play('browser');
      return true;
    }
    if (ev.name === 'up' || ev.name === 'down' || ev.name === 'j' || ev.name === 'k' || ev.name === 'pageup' || ev.name === 'pagedown') this.sourceIndex = 0;
    return super.onKey(ev);
  }

  activate() {
    this.play('terminal');
  }

  hints() {
    return 'Enter play  w window  b browser  s source  [ ] region';
  }

  async play(mode) {
    const cur = this.current();
    const cand = this.candidate();
    if (!cur || !cand) return this.app.toast('no stream listed for this slot', 2000, 'warn');
    const player = this.app.player || {};
    const title = `World Monitor · ${cur.name}`;
    const note = (text, kind) => this.app.toast(text, 3500, kind);
    if (mode === 'browser' || !player.mpv) {
      if (!player.mpv && mode !== 'browser') note('mpv not found: opening in the browser instead (brew install mpv yt-dlp)', 'warn');
      const url = cand.kind === 'hls' ? `https://www.worldmonitor.app/live-channels.html` : cand.url;
      openExternal(url);
      this.remember(cur, cand, 'browser');
      return;
    }
    if (cand.kind !== 'hls' && !player.ytdlp) note('yt-dlp not found: YouTube streams may fail in mpv', 'warn');
    if (mode === 'window') {
      const res = playInWindow(cand.url, { player, title });
      this.remember(cur, cand, 'window');
      return note(res.ok ? `opened mpv window: ${cur.name}` : `mpv failed: ${res.error}`, res.ok ? 'info' : 'bad');
    }
    this.remember(cur, cand, 'terminal');
    const result = await this.app.suspendFor(async () => {
      process.stdout.write(`\n  ▶ ${cur.name} — ${cand.label} (${cand.kind})\n  mpv --vo=${player.vo} · press q to return to the dashboard\n\n`);
      return playInTerminal(cand.url, { player, title });
    });
    if (result && !result.ok) {
      const n = this.candidates().length;
      if (n > 1) {
        this.sourceIndex = (this.sourceIndex + 1) % n;
        note(`stream failed (exit ${result.code ?? result.signal}); next source selected, press Enter to retry`, 'warn');
      } else note(`stream failed (exit ${result.code ?? result.signal})`, 'bad');
    } else note(`returned from ${cur.name}`);
  }

  remember(cur, cand, mode) {
    this.lastPlayed = { name: cur.name, kind: cand.kind, url: cand.url, mode, at: this.app.now() };
    this.history.unshift(this.lastPlayed);
    this.history = this.history.slice(0, 6);
  }

  render(ctx, r) {
    const [left, right] = splitH(r, ['44%', 'fill']);
    const [channelsR, webcamsR] = splitV(left, ['60%', 'fill']);
    this.renderChannels(ctx, channelsR);
    this.renderWebcams(ctx, webcamsR);
    const [detailR, historyR] = splitV(right, ['fill', Math.min(10, 3 + this.history.length)]);
    this.renderDetail(ctx, detailR);
    this.renderHistory(ctx, historyR);
  }

  renderChannels(ctx, r) {
    const { t } = ctx;
    const inner = panel(ctx, r, { title: 'Live news channels', focused: this.isFocused('channels'), onClick: () => this.focusPane('channels') });
    const filterRow = rect(inner.x, inner.y, inner.w, 1);
    tabs(ctx, filterRow, this.filters(), this.filter, (i) => this.setFilter(i));
    const listR = rect(inner.x, inner.y + 1, inner.w, inner.h - 1);
    const resolved = this.data.liveVideoResolved?.channels || {};
    this.lists.channels.draw(
      ctx,
      listR,
      this.channels(),
      (c, _i, { width }) => {
        const kinds = streamCandidates(c.sources, this.data.liveVideoResolved, ctx.now);
        const hasHls = kinds.some((k) => k.kind === 'hls');
        const hasLive = kinds.some((k) => k.kind === 'youtube' || k.kind === 'youtube-channel');
        const resolvedNow = c.sources.some((sItem) => {
          const m = /channel\/(UC[\w-]+)/.exec(sItem);
          return m && resolved[m[1]]?.videoId;
        });
        return [
          { text: `${hasHls ? '▮' : hasLive ? '▶' : '·'} `, fg: hasHls ? t.good : hasLive ? t.accent : t.dim },
          { text: `${String(c.name).slice(0, 22).padEnd(22)} `, fg: t.text, attr: ATTR.BOLD },
          { text: `${String(c.handle || '').slice(0, 16).padEnd(16)} `, fg: t.dim },
          { text: `${hasHls ? 'HLS ' : ''}${hasLive ? 'YT ' : ''}${resolvedNow ? '● live' : ''}`.slice(0, Math.max(0, width - 42)), fg: resolvedNow ? t.accent2 : t.muted },
        ];
      },
      this.listOpts('channels', { onSelect: () => (this.sourceIndex = 0), empty: 'no channels in this region' }),
    );
  }

  renderWebcams(ctx, r) {
    const { t } = ctx;
    const inner = panel(ctx, r, { title: 'Live webcams', focused: this.isFocused('webcams'), onClick: () => this.focusPane('webcams') });
    this.lists.webcams.draw(
      ctx,
      inner,
      this.webcams(),
      (w, _i, { width }) => [
        { text: '◉ ', fg: t.accent },
        { text: `${String(w.city).slice(0, 18).padEnd(18)} `, fg: t.text, attr: ATTR.BOLD },
        { text: `${String(w.country).slice(0, 14).padEnd(14)} `, fg: t.dim },
        { text: `${WEBCAM_REGION_LABELS[w.region] || w.region}`.slice(0, Math.max(0, width - 36)), fg: t.muted },
      ],
      this.listOpts('webcams', { onSelect: () => (this.sourceIndex = 0) }),
    );
  }

  renderDetail(ctx, r) {
    const { s, t } = ctx;
    const cur = this.current();
    const inner = panel(ctx, r, { title: 'Player', kind: 'double', badge: cur ? cur.kind.toUpperCase() : null });
    if (!cur) {
      label(ctx, inner.x, inner.y, 'select a channel or webcam', { fg: t.dim });
      return;
    }
    const player = this.app.player || {};
    let y = inner.y;
    s.text(inner.x, y++, cur.name, { fg: t.title, bg: t.panel, attr: ATTR.BOLD }, inner.w);
    s.text(inner.x, y++, cur.sub, { fg: t.dim, bg: t.panel }, inner.w);
    y++;
    let x = inner.x;
    x += button(ctx, x, y, '▶ play in terminal', { onClick: () => this.play('terminal'), active: true }) + 1;
    x += button(ctx, x, y, '⧉ mpv window', { onClick: () => this.play('window') }) + 1;
    button(ctx, x, y, '⌂ browser', { onClick: () => this.play('browser') });
    y += 2;
    heading(ctx, inner.x, y++, 'sources  (s to cycle)', inner.w);
    const cands = this.candidates();
    if (!cands.length) s.text(inner.x, y++, 'no playable source listed', { fg: t.warn, bg: t.panel });
    cands.slice(0, Math.max(0, inner.y + inner.h - y - 6)).forEach((c, i) => {
      const active = i === Math.min(this.sourceIndex, cands.length - 1);
      segments(
        ctx,
        inner.x,
        y,
        [
          { text: active ? '▸ ' : '  ', fg: t.accent2 },
          { text: `${c.kind.padEnd(16)} `, fg: c.kind === 'hls' ? t.good : t.accent },
          { text: c.url.slice(0, Math.max(10, inner.w - 20)), fg: active ? t.text : t.dim },
        ],
        inner.w,
        { bg: t.panel },
      );
      ctx.hits.push({ x: inner.x, y, w: inner.w, h: 1, onClick: () => (this.sourceIndex = i) });
      y++;
    });
    y++;
    if (y < inner.y + inner.h - 3) {
      heading(ctx, inner.x, y++, 'playback', inner.w);
      kv(ctx, inner.x, y++, 'mpv', player.mpv || 'not found — brew install mpv', Math.min(inner.w, 60), { fg: player.mpv ? t.good : t.bad });
      kv(ctx, inner.x, y++, 'yt-dlp', player.ytdlp || 'not found — brew install yt-dlp', Math.min(inner.w, 60), { fg: player.ytdlp ? t.good : t.warn });
      kv(ctx, inner.x, y++, 'terminal video', player.vo === 'kitty' ? 'kitty graphics protocol (pixel video)' : 'truecolor cells (tct)', Math.min(inner.w, 60), { fg: t.accent });
    }
    const res = this.data.liveVideoResolved;
    if (res?.resolvedAt && y < inner.y + inner.h) s.text(inner.x, inner.y + inner.h - 1, `channel ids resolved ${res.resolvedAt.slice(0, 16).replace('T', ' ')}Z`, { fg: t.muted, bg: t.panel }, inner.w);
  }

  renderHistory(ctx, r) {
    const { t } = ctx;
    const inner = panel(ctx, r, { title: 'Recently played' });
    if (!this.history.length) {
      label(ctx, inner.x, inner.y, 'nothing yet — press Enter on a channel', { fg: t.dim });
      return;
    }
    this.history.slice(0, inner.h).forEach((h, i) => {
      segments(ctx, inner.x, inner.y + i, [
        { text: `${h.mode.padEnd(8)} `, fg: t.accent3 },
        { text: `${h.name.slice(0, 22).padEnd(22)} `, fg: t.text },
        { text: `${h.kind} `, fg: t.dim },
        { text: h.url.slice(0, Math.max(0, inner.w - 40)), fg: t.muted },
      ], inner.w, { bg: t.panel });
    });
  }
}
