// System: platform health, data source freshness, theme and animation settings, about.
import { ATTR } from '../term/screen.mjs';
import { rect, splitH, splitV } from '../ui/layout.mjs';
import { button, gauge, heading, kv, label, panel, segments } from '../ui/widgets.mjs';
import { THEME_IDS, getTheme, severityColor } from '../ui/theme.mjs';
import { fmtAge } from '../data/select.mjs';
import { VERSION } from '../../core.mjs';
import { PaneView } from './base.mjs';

export class SystemView extends PaneView {
  constructor(app) {
    super(app, { id: 'system', label: 'System', paneIds: ['sources', 'problems'], sources: ['health', 'version'] });
  }

  sourceRows() {
    const st = this.store;
    return Object.entries(st.sources).map(([id, src]) => ({ id, src, meta: st.meta[id] }));
  }

  problemRows() {
    const h = this.store.raw.health;
    if (!h || typeof h !== 'object') return [];
    const rows = [];
    for (const [k, v] of Object.entries(h.problems || {})) rows.push({ key: k, kind: 'problem', ...v });
    for (const [k, v] of Object.entries(h.pending || {})) rows.push({ key: k, kind: 'pending', ...(v && typeof v === 'object' ? v : { status: String(v) }) });
    return rows;
  }

  activate(pane) {
    if (pane === 'sources') {
      const row = this.sourceRows()[this.lists.sources.selected];
      if (row) {
        this.store.refresh(row.id, { force: true }).catch(() => {});
        this.app.toast(`refreshing ${row.src.label}`);
      }
    } else super.activate(pane);
  }

  hints() {
    return 'Enter refresh source';
  }

  render(ctx, r) {
    const [left, right] = splitH(r, ['55%', 'fill']);
    const [healthR, sourcesR] = splitV(left, [9, 'fill']);
    const [settingsR, problemsR, aboutR] = splitV(right, [11, 'fill', 7]);
    this.renderHealth(ctx, healthR);
    this.renderSources(ctx, sourcesR);
    this.renderSettings(ctx, settingsR);
    this.renderProblems(ctx, problemsR);
    this.renderAbout(ctx, aboutR);
  }

  renderHealth(ctx, r) {
    const { s, t, now } = ctx;
    const h = this.store.raw.health;
    const v = this.store.raw.version;
    const inner = panel(ctx, r, { title: 'Platform health', right: v?.version ? `platform v${v.version}` : '', badge: h?.status || null, badgeColor: severityColor(t, h?.status) });
    if (!h) {
      label(ctx, inner.x, inner.y, 'loading /api/health?compact=1 …', { fg: t.dim });
      return;
    }
    const sum = h.summary || {};
    const total = sum.total || 1;
    kv(ctx, inner.x, inner.y, 'checks', `${sum.ok ?? 0} ok / ${total}`, inner.w);
    gauge(ctx, inner.x, inner.y + 1, inner.w, (sum.ok || 0) / total, { fg: severityColor(t, h.status) });
    const cells = [
      ['warn', sum.warn, t.warn],
      ['crit', sum.crit, t.bad],
      ['pending', sum.pending, t.info],
      ['stale', sum.staleContent, t.warn],
      ['contained', sum.containedWarn, t.dim],
      ['on-demand warn', sum.onDemandWarn, t.dim],
    ];
    cells.forEach(([k, val, color], i) => {
      const x = inner.x + (i % 3) * Math.floor(inner.w / 3);
      const y = inner.y + 3 + Math.floor(i / 3);
      segments(ctx, x, y, [{ text: `${k} `, fg: t.dim }, { text: String(val ?? 0), fg: val ? color : t.dim, attr: ATTR.BOLD }], Math.floor(inner.w / 3), { bg: t.panel });
    });
    s.text(inner.x, inner.y + inner.h - 1, `checked ${h.checkedAt ? fmtAge(now - Date.parse(h.checkedAt)) : '—'} ago`, { fg: t.dim, bg: t.panel }, inner.w);
  }

  renderSources(ctx, r) {
    const { t, now } = ctx;
    const rows = this.sourceRows();
    const inner = panel(ctx, r, { title: 'Data sources', focused: this.isFocused('sources'), right: this.store.client.baseUrl, onClick: () => this.focusPane('sources') });
    this.lists.sources.draw(
      ctx,
      inner,
      rows,
      ({ id, src, meta }, _i, { width }) => {
        const age = meta.loadedAt ? fmtAge(now - meta.loadedAt) : '—';
        const state = meta.loading ? '⟳' : meta.error ? '✕' : meta.loadedAt ? '✓' : src.lazy && !this.store.wanted.has(id) ? '·' : '…';
        const color = meta.loading ? t.accent : meta.error ? t.bad : meta.loadedAt ? t.good : t.dim;
        const every = `${Math.round(src.every / 60000)}m`;
        const detail = meta.error ? meta.error : `${src.auth === 'session' ? 'session' : 'public'}${src.lazy ? ' · on demand' : ''}`;
        return [
          { text: `${state} `, fg: color, attr: ATTR.BOLD },
          { text: src.label.padEnd(18), fg: t.text },
          { text: `${age.padStart(5)} ago `, fg: t.dim },
          { text: `every ${every.padEnd(4)} `, fg: t.muted },
          { text: detail.slice(0, Math.max(0, width - 44)), fg: meta.error ? t.bad : t.dim },
        ];
      },
      this.listOpts('sources'),
    );
  }

  renderSettings(ctx, r) {
    const { s, t } = ctx;
    const inner = panel(ctx, r, { title: 'Appearance' });
    heading(ctx, inner.x, inner.y, 'theme', inner.w);
    let x = inner.x;
    let y = inner.y + 1;
    for (const id of THEME_IDS) {
      const th = getTheme(id);
      const w = th.label.length + 2;
      if (x + w > inner.x + inner.w) {
        x = inner.x;
        y += 1;
      }
      button(ctx, x, y, th.label, { active: id === this.app.theme.id, activeBg: th.accent, onClick: () => this.app.setTheme(id) });
      x += w + 1;
    }
    y += 2;
    heading(ctx, inner.x, y, 'motion', inner.w);
    button(ctx, inner.x, y + 1, this.app.anim ? 'animations: on' : 'animations: off', { active: this.app.anim, onClick: () => this.app.toggleAnimations() });
    button(ctx, inner.x + 20, y + 1, 'help (?)', { onClick: () => (this.app.help = true) });
    y += 3;
    heading(ctx, inner.x, y, 'player', inner.w);
    const p = this.app.player || {};
    segments(
      ctx,
      inner.x,
      y + 1,
      [
        { text: 'mpv ', fg: t.dim },
        { text: p.mpv ? 'found' : 'missing', fg: p.mpv ? t.good : t.bad },
        { text: '  yt-dlp ', fg: t.dim },
        { text: p.ytdlp ? 'found' : 'missing', fg: p.ytdlp ? t.good : t.warn },
        { text: '  terminal video ', fg: t.dim },
        { text: p.vo || '—', fg: t.accent },
      ],
      inner.w,
      { bg: t.panel },
    );
    void s;
  }

  renderProblems(ctx, r) {
    const { t } = ctx;
    const rows = this.problemRows();
    const inner = panel(ctx, r, { title: 'Health problems', focused: this.isFocused('problems'), right: `${rows.length}`, onClick: () => this.focusPane('problems') });
    this.lists.problems.draw(
      ctx,
      inner,
      rows,
      (p, _i, { width }) => [
        { text: p.kind === 'pending' ? '◌ ' : '▲ ', fg: p.kind === 'pending' ? t.info : t.warn },
        { text: p.key.padEnd(24).slice(0, 24), fg: t.text },
        { text: ` ${String(p.status || '').slice(0, 22).padEnd(23)}`, fg: severityColor(t, p.status) },
        { text: (p.errorCode || (p.seedAgeMin != null ? `seed ${p.seedAgeMin}m` : '')).slice(0, Math.max(0, width - 50)), fg: t.dim },
      ],
      this.listOpts('problems', { empty: 'no problems reported' }),
    );
  }

  renderAbout(ctx, r) {
    const { t } = ctx;
    const inner = panel(ctx, r, { title: 'About' });
    const lines = [
      [{ text: `worldmonitor cli v${VERSION}`, fg: t.text, attr: ATTR.BOLD }],
      [{ text: 'Terminal client for worldmonitor.app · public bootstrap tiers, no key required.', fg: t.dim }],
      [{ text: `worldmonitor web`, fg: t.accent }, { text: ' opens the original web dashboard.', fg: t.dim }],
      [{ text: 'Source: github.com/koala73/worldmonitor (cli/)', fg: t.dim }],
    ];
    lines.slice(0, inner.h).forEach((segs, i) => segments(ctx, inner.x, inner.y + i, segs, inner.w, { bg: t.panel }));
    void rect;
  }
}
