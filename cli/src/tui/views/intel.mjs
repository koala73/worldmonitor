// Intel: GDELT topic feeds, security advisories, sanctions pressure, social
// velocity, government spending and tech events.
import { ATTR } from '../term/screen.mjs';
import { splitH, splitV } from '../ui/layout.mjs';
import { bar, heading, kv, panel, segments } from '../ui/widgets.mjs';
import { severityColor } from '../ui/theme.mjs';
import { ageOf, fmtInt, fmtNum } from '../data/select.mjs';
import { PaneView, selectedItem } from './base.mjs';

export class IntelView extends PaneView {
  constructor(app) {
    super(app, { id: 'intel', label: 'Intel', paneIds: ['topics', 'articles', 'advisories', 'social'], sources: ['fast', 'slow'] });
    this.focus = 1;
  }

  topics() {
    return this.data.gdeltIntel?.topics || [];
  }

  articles() {
    const topic = this.topics()[this.lists.topics.selected];
    return topic ? topic.articles || [] : [];
  }

  advisories() {
    const list = this.data.securityAdvisories?.advisories || [];
    const rank = (l) => (/do-not-travel|extreme/i.test(l) ? 3 : /reconsider|high/i.test(l) ? 2 : /caution|increased/i.test(l) ? 1 : 0);
    return [...list].sort((a, b) => rank(b.level) - rank(a.level) || String(b.pubDate || '').localeCompare(String(a.pubDate || '')));
  }

  social() {
    return [...(this.data.socialVelocity?.posts || [])].sort((a, b) => (b.velocityScore || 0) - (a.velocityScore || 0));
  }

  selectedUrl() {
    switch (this.focusedPane) {
      case 'articles':
        return selectedItem(this.lists.articles, this.articles())?.url || null;
      case 'advisories':
        return selectedItem(this.lists.advisories, this.advisories())?.link || null;
      case 'social':
        return selectedItem(this.lists.social, this.social())?.url || null;
      default:
        return null;
    }
  }

  activate(pane) {
    if (pane === 'topics') this.focus = 1;
    else super.activate(pane);
  }

  onKey(ev) {
    if (this.isFocused('topics') && ['up', 'down', 'j', 'k'].includes(ev.name)) {
      const handled = this.lists.topics.handleKey(ev);
      this.lists.articles.first();
      return handled;
    }
    return super.onKey(ev);
  }

  render(ctx, r) {
    const [left, right] = splitH(r, ['50%', 'fill']);
    const [topicsR, articlesR] = splitH(left, [16, 'fill']);
    this.renderTopics(ctx, topicsR);
    this.renderArticles(ctx, articlesR);
    const [sanctionsR, advisoriesR, socialR] = splitV(right, [9, '42%', 'fill']);
    this.renderSanctions(ctx, sanctionsR);
    this.renderAdvisories(ctx, advisoriesR);
    this.renderSocial(ctx, socialR);
  }

  renderTopics(ctx, r) {
    const { t } = ctx;
    const inner = panel(ctx, r, { title: 'GDELT', focused: this.isFocused('topics'), onClick: () => this.focusPane('topics') });
    this.lists.topics.draw(
      ctx,
      inner,
      this.topics(),
      (tp, _i, { width }) => [{ text: ` ${String(tp.id).slice(0, Math.max(1, width - 5)).padEnd(Math.max(1, width - 4))}`, fg: t.text }, { text: String((tp.articles || []).length).padStart(2), fg: t.dim }],
      this.listOpts('topics', { onSelect: () => this.lists.articles.first(), empty: '…' }),
    );
  }

  renderArticles(ctx, r) {
    const { t, now } = ctx;
    const topic = this.topics()[this.lists.topics.selected];
    const inner = panel(ctx, r, { title: topic ? `${topic.id} intel` : 'Intel articles', focused: this.isFocused('articles'), right: topic?.fetchedAt ? `${ageOf(topic.fetchedAt, now)} ago` : '', onClick: () => this.focusPane('articles') });
    this.lists.articles.draw(
      ctx,
      inner,
      this.articles(),
      (a, _i, { width, selected }) => {
        const src = String(a.source || a.domain || a.sourceCountry || '').slice(0, 14).padEnd(14);
        const age = a.seendate || a.publishedAt ? ageOf(a.publishedAt || a.seendate, now) : '';
        return [
          { text: `${src} `, fg: t.dim },
          { text: String(a.title || '').slice(0, Math.max(10, width - 22)).padEnd(Math.max(10, width - 22)), fg: selected ? t.selText : t.text },
          { text: ` ${age}`, fg: t.dim },
        ];
      },
      this.listOpts('articles', { empty: 'loading GDELT…' }),
    );
  }

  renderSanctions(ctx, r) {
    const { t } = ctx;
    const sp = this.data.sanctionsPressure;
    const inner = panel(ctx, r, { title: 'Sanctions pressure', right: 'OFAC · UK · CA' });
    if (!sp) return;
    kv(ctx, inner.x, inner.y, 'designations', `${fmtInt(sp.totalCount)} total · SDN ${fmtInt(sp.sdnCount)} · vessels ${fmtInt(sp.vesselCount)} · aircraft ${fmtInt(sp.aircraftCount)}${sp.newEntryCount ? ` · +${sp.newEntryCount} new` : ''}`, inner.w);
    const countries = (sp.countries || []).slice(0, 6);
    const max = Math.max(1, ...countries.map((c) => c.entryCount || 0));
    const half = Math.floor(inner.w / 2);
    countries.forEach((c, i) => {
      const y = inner.y + 1 + Math.floor(i / 2);
      const x = inner.x + (i % 2) * half;
      if (y >= inner.y + inner.h) return;
      segments(ctx, x, y, [
        { text: `${String(c.countryName || c.countryCode).slice(0, 12).padEnd(12)} `, fg: t.text },
        { text: bar(c.entryCount, max, Math.max(4, half - 22)), fg: t.accent2 },
        { text: ` ${fmtInt(c.entryCount)}`, fg: t.dim },
      ], half - 1, { bg: t.panel });
    });
    const programs = (sp.programs || []).slice(0, 4).map((p) => `${p.program} ${fmtNum(p.entryCount, 0)}`).join(' · ');
    if (inner.h > 5) ctx.s.text(inner.x, inner.y + inner.h - 1, `programs: ${programs}`, { fg: t.dim, bg: t.panel }, inner.w);
  }

  renderAdvisories(ctx, r) {
    const { t } = ctx;
    const rows = this.advisories();
    const inner = panel(ctx, r, { title: 'Travel & security advisories', focused: this.isFocused('advisories'), right: `${rows.length}`, onClick: () => this.focusPane('advisories') });
    this.lists.advisories.draw(
      ctx,
      inner,
      rows,
      (a, _i, { width }) => [
        { text: `${String(a.level || '').slice(0, 13).padEnd(13)} `, fg: severityColor(t, a.level), attr: ATTR.BOLD },
        { text: `${String(a.country || '').slice(0, 16).padEnd(16)} `, fg: t.text },
        { text: `${String(a.sourceCountry || a.source || '').slice(0, 4).padEnd(4)} `, fg: t.dim },
        { text: String(a.title || '').slice(0, Math.max(0, width - 38)), fg: t.dim },
      ],
      this.listOpts('advisories', { empty: 'loading advisories…' }),
    );
  }

  renderSocial(ctx, r) {
    const { t, now } = ctx;
    const posts = this.social();
    const [socialR, spendR] = splitV(r, ['60%', 'fill']);
    const inner = panel(ctx, socialR, { title: 'Social velocity', focused: this.isFocused('social'), right: 'Reddit', onClick: () => this.focusPane('social') });
    this.lists.social.draw(
      ctx,
      inner,
      posts,
      (p, _i, { width, selected }) => [
        { text: `${String(Math.round(p.velocityScore || 0)).padStart(4)} `, fg: t.accent2, attr: ATTR.BOLD },
        { text: `r/${String(p.subreddit || '').slice(0, 12).padEnd(12)} `, fg: t.dim },
        { text: String(p.title || '').slice(0, Math.max(8, width - 32)).padEnd(Math.max(8, width - 32)), fg: selected ? t.selText : t.text },
        { text: ` ↑${fmtNum(p.score, 0)} ${ageOf(p.createdAt, now)}`, fg: t.dim },
      ],
      this.listOpts('social', { empty: 'loading posts…' }),
    );
    const sp = this.data.spending;
    const ev = this.data.techEvents?.events || [];
    const inner2 = panel(ctx, spendR, { title: 'Spending & events', right: sp ? `US awards ${sp.periodStart}→${sp.periodEnd} $${fmtNum(sp.totalAmount, 0)}` : '' });
    let y = inner2.y;
    for (const a of (sp?.awards || []).slice(0, Math.max(0, Math.floor(inner2.h / 2)))) {
      if (y >= inner2.y + inner2.h) break;
      segments(ctx, inner2.x, y++, [
        { text: `$${fmtNum(a.amount, 0)}`.padStart(9), fg: t.good },
        { text: ` ${String(a.recipientName || '').slice(0, 28).padEnd(28)} `, fg: t.text },
        { text: String(a.agency || '').slice(0, Math.max(0, inner2.w - 40)), fg: t.dim },
      ], inner2.w, { bg: t.panel });
    }
    if (ev.length && y < inner2.y + inner2.h) heading(ctx, inner2.x, y++, 'upcoming tech events', inner2.w);
    for (const e of ev.slice(0, Math.max(0, inner2.y + inner2.h - y))) {
      segments(ctx, inner2.x, y++, [
        { text: `${String(e.startDate || '').slice(0, 10)} `, fg: t.dim },
        { text: `${String(e.title || '').slice(0, 30).padEnd(30)} `, fg: t.text },
        { text: String(e.location || '').slice(0, Math.max(0, inner2.w - 43)), fg: t.dim },
      ], inner2.w, { bg: t.panel });
    }
  }
}
