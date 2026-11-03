// News: digest categories, ranked headlines, and a detail pane.
import { wrap } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { splitH, splitV } from '../ui/layout.mjs';
import { heading, kv, label, panel, segments } from '../ui/widgets.mjs';
import { ageOf, enumLabel, newsCategories, threatRank } from '../data/select.mjs';
import { severityColor } from '../ui/theme.mjs';
import { PaneView, selectedItem } from './base.mjs';

export class NewsView extends PaneView {
  constructor(app) {
    super(app, { id: 'news', label: 'News', paneIds: ['cats', 'items'], sources: ['digest'] });
    this.focus = 1;
  }

  categories() {
    return newsCategories(this.store.raw.digest);
  }

  currentItems() {
    const cats = this.categories();
    const cat = cats[Math.min(this.lists.cats.selected, Math.max(0, cats.length - 1))];
    return cat ? cat.items : [];
  }

  selected() {
    return selectedItem(this.lists.items, this.currentItems());
  }

  selectedUrl() {
    const it = this.selected();
    return it ? it.link : null;
  }

  activate(pane) {
    if (pane === 'cats') this.focus = 1;
    else super.activate(pane);
  }

  onKey(ev) {
    if (this.isFocused('cats') && (ev.name === 'up' || ev.name === 'down' || ev.name === 'j' || ev.name === 'k')) {
      const handled = this.lists.cats.handleKey(ev);
      this.lists.items.first();
      return handled;
    }
    if (ev.name === '[' || ev.name === ']') {
      this.lists.cats.move(ev.name === ']' ? 1 : -1);
      this.lists.items.first();
      return true;
    }
    return super.onKey(ev);
  }

  hints() {
    return '[ ] category  Enter expand  o open';
  }

  render(ctx, r) {
    const { t, now } = ctx;
    const cats = this.categories();
    const wide = r.w >= 120;
    const [catsR, rest] = splitH(r, [Math.min(22, Math.max(16, Math.floor(r.w * 0.16))), 'fill']);
    const [itemsR, detailR] = wide ? splitH(rest, ['fill', Math.min(60, Math.floor(rest.w * 0.38))]) : splitV(rest, ['fill', 9]);
    const digest = this.store.raw.digest;
    const innerCats = panel(ctx, catsR, { title: 'Sections', focused: this.isFocused('cats'), onClick: () => this.focusPane('cats') });
    this.lists.cats.draw(
      ctx,
      innerCats,
      cats,
      (c, _i, { width }) => {
        const alerts = c.items.filter((x) => x.isAlert).length;
        return [
          { text: ` ${c.label}`.padEnd(width - 5), fg: t.text },
          { text: alerts ? String(alerts).padStart(3) : '', fg: t.bad, attr: ATTR.BOLD },
        ];
      },
      this.listOpts('cats', {
        onSelect: () => this.lists.items.first(),
        empty: 'loading digest…',
      }),
    );
    const items = this.currentItems();
    const cat = cats[this.lists.cats.selected];
    const innerItems = panel(ctx, itemsR, {
      title: cat ? cat.label : 'Headlines',
      focused: this.isFocused('items'),
      right: digest?.generatedAt ? `digest ${ageOf(digest.generatedAt, now)} ago` : '',
      onClick: () => this.focusPane('items'),
    });
    this.lists.items.draw(
      ctx,
      innerItems,
      items,
      (it, _i, { selected, width }) => {
        const rank = threatRank(it.threat?.level);
        const flag = it.isAlert ? '⚠' : rank >= 3 ? '▲' : rank === 2 ? '△' : '·';
        const flagColor = it.isAlert || rank >= 3 ? t.bad : rank === 2 ? t.warn : t.dim;
        const age = ageOf(it.publishedAt, now).padStart(4);
        const src = String(it.source || '').slice(0, 14).padEnd(14);
        const score = it.importanceScore != null ? String(Math.round(it.importanceScore)).padStart(3) : '   ';
        const titleW = Math.max(10, width - 2 - 15 - 5 - 4 - 2);
        return [
          { text: `${flag} `, fg: flagColor, attr: ATTR.BOLD },
          { text: `${src} `, fg: t.dim },
          { text: String(it.title || '').slice(0, titleW).padEnd(titleW), fg: selected ? t.selText : t.text, attr: it.isAlert ? ATTR.BOLD : 0 },
          { text: ` ${score}`, fg: t.accent3 },
          { text: ` ${age}`, fg: t.dim },
        ];
      },
      this.listOpts('items', { empty: 'no headlines in this section' }),
    );
    this.renderDetail(ctx, detailR);
  }

  renderDetail(ctx, r) {
    const { s, t, now } = ctx;
    const it = this.selected();
    const inner = panel(ctx, r, { title: 'Story', kind: 'round' });
    if (!it) {
      label(ctx, inner.x, inner.y, 'select a headline', { fg: t.dim });
      return;
    }
    let y = inner.y;
    const titleLines = wrap(it.title || '', inner.w);
    titleLines.slice(0, 3).forEach((line) => s.text(inner.x, y++, line, { fg: t.text, bg: t.panel, attr: ATTR.BOLD }, inner.w));
    const level = it.threat?.level ? enumLabel(it.threat.level) : '';
    segments(
      ctx,
      inner.x,
      y++,
      [
        { text: `${it.source || ''}`, fg: t.accent },
        { text: ` · ${ageOf(it.publishedAt, now)} ago`, fg: t.dim },
        { text: level ? `  threat ${level}` : '', fg: severityColor(t, level) },
        { text: it.isAlert ? '  ALERT' : '', fg: t.bad, attr: ATTR.BOLD },
      ],
      inner.w,
      { bg: t.panel },
    );
    y++;
    const facts = [
      ['importance', it.importanceScore != null ? Math.round(it.importanceScore) : '—'],
      ['credibility', it.credibilityScore != null ? Math.round(it.credibilityScore) : '—'],
      ['corroboration', it.corroborationCount ?? '—'],
      ['story phase', it.storyMeta?.phase ? enumLabel(it.storyMeta.phase) : '—'],
      ['mentions', it.storyMeta?.mentionCount ?? '—'],
    ];
    for (const [k, v] of facts) {
      if (y >= inner.y + inner.h) return;
      kv(ctx, inner.x, y++, k, v, Math.min(inner.w, 34));
    }
    y++;
    if (it.snippet && y < inner.y + inner.h) {
      heading(ctx, inner.x, y++, 'summary', inner.w);
      for (const line of wrap(it.snippet, inner.w)) {
        if (y >= inner.y + inner.h - 1) break;
        s.text(inner.x, y++, line, { fg: t.text, bg: t.panel }, inner.w);
      }
    }
    if (it.link && y < inner.y + inner.h) {
      s.text(inner.x, inner.y + inner.h - 1, it.link, { fg: t.info, bg: t.panel, attr: ATTR.UNDERLINE }, inner.w);
    }
  }
}
