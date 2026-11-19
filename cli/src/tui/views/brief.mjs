// Brief view: the AI world brief as an interactive page. The left pane holds
// the brief and its numbered story lines; the right pane shows what the
// selected line is talking about — the sources it cites and related headlines
// from the live news digest — each expandable and openable.
import { wrap } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { rect, splitH, splitV } from '../ui/layout.mjs';
import { pulse, typewriterCount } from '../ui/fx.mjs';
import { heading, label, panel, segments } from '../ui/widgets.mjs';
import { describeItem, isHttpUrl } from '../ui/detail.mjs';
import { ageOf, allHeadlines } from '../data/select.mjs';
import { PaneView, selectedItem } from './base.mjs';

const STOP = new Set('the a an and or of to in on at for with from by as is are was were be been has have had this that these those its their his her over into after before amid says said say report reports reported new amid near more than about between against while during under across through'.split(' '));

export function tokens(text) {
  return [...new Set(String(text || '').toLowerCase().replace(/\[\d+\]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))];
}

export function citations(text) {
  return [...String(text || '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
}

// Related items for a story line: cited sources first, then headlines sharing keywords.
export function relatedFor(line, insights, digest, limit = 14) {
  const out = [];
  const seen = new Set();
  const sources = Array.isArray(insights?.worldBriefSources) ? insights.worldBriefSources : [];
  for (const n of citations(line?.text)) {
    const src = sources[n - 1];
    if (src && !seen.has(src.url || src.title)) {
      seen.add(src.url || src.title);
      out.push({ kind: 'cited', n, title: src.title, source: src.source, link: src.url, publishedAt: src.publishedAt ? Date.parse(src.publishedAt) : 0, snippet: src.snippet || '' });
    }
  }
  const words = tokens(line?.text);
  if (words.length) {
    const scored = [];
    for (const h of allHeadlines(digest, 400)) {
      const key = h.link || h.title;
      if (seen.has(key)) continue;
      const hay = `${h.title || ''} ${h.snippet || ''}`.toLowerCase();
      let score = 0;
      for (const w of words) if (hay.includes(w)) score += w.length >= 7 ? 2 : 1;
      if (score >= 2) scored.push({ score, h });
    }
    scored.sort((a, b) => b.score - a.score || (b.h.publishedAt || 0) - (a.h.publishedAt || 0));
    for (const { score, h } of scored.slice(0, limit)) {
      seen.add(h.link || h.title);
      out.push({ kind: 'related', score, title: h.title, source: h.source, link: h.link, publishedAt: h.publishedAt, snippet: h.snippet, category: h.category, isAlert: h.isAlert, threat: h.threat, item: h });
    }
  }
  for (const st of insights?.topStories || []) {
    const key = st.primaryLink || st.primaryTitle;
    if (seen.has(key)) continue;
    const hay = `${st.primaryTitle || ''} ${(st.memberTitles || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += 1;
    if (score >= 2) {
      seen.add(key);
      out.push({ kind: 'story', score, title: st.primaryTitle, source: `${st.primarySource} +${Math.max(0, (st.sourceCount || 1) - 1)}`, link: st.primaryLink, publishedAt: st.pubDate, item: st });
    }
  }
  return out;
}

export class BriefView extends PaneView {
  constructor(app) {
    super(app, { id: 'brief', label: 'Brief', paneIds: ['lines', 'related'], sources: ['fast', 'digest'] });
    this.briefText = '';
    this.briefStartedAt = 0;
    this.lastLine = null;
  }

  insights() {
    return this.data.insights || {};
  }

  lines() {
    const ins = this.insights();
    const lines = Array.isArray(ins.briefStoryLines) ? ins.briefStoryLines : [];
    if (lines.length) return lines;
    // Fall back to sentences of the brief when the API sends no story lines.
    // Built once per brief so the related cache (keyed on the line) can hit.
    const brief = String(ins.worldBrief || '');
    if (this.fallback?.brief !== brief) {
      const split = brief
        .split(/(?<=[.!?])\s+/)
        .filter(Boolean)
        .map((text, i) => ({ n: i + 1, text }));
      this.fallback = { brief, lines: split };
    }
    return this.fallback.lines;
  }

  related() {
    const line = selectedItem(this.lists.lines, this.lines());
    if (!line) return [];
    // A fast refresh can swap the cited sources and keep the brief text.
    const ins = this.insights();
    const c = this.relCache;
    if (c && c.line === line && c.ins === ins && c.digest === this.store.raw.digest) return c.items;
    const items = relatedFor(line, ins, this.store.raw.digest);
    this.relCache = { line, ins, digest: this.store.raw.digest, items };
    return items;
  }

  items(pane) {
    return pane === 'lines' ? this.lines() : this.related();
  }

  describe(item, pane) {
    if (pane === 'lines') {
      const rel = relatedFor(item, this.insights(), this.store.raw.digest, 20);
      return {
        title: `Story line ${item.n || ''}`.trim(),
        subtitle: 'AI world brief',
        rows: [['Line', String(item.text || '').replace(/\s*\[\d+\]/g, '')], ['Cites', citations(item.text).map((n) => `[${n}]`).join(' ') || 'nothing'], ['Related coverage', `${rel.length} items`], ...rel.slice(0, 12).map((r, i) => [`${i + 1}. ${r.kind}`, `${r.source ? `${r.source}: ` : ''}${r.title}`])],
        body: '',
        url: rel.map((r) => r.link).find(isHttpUrl) || null,
      };
    }
    return describeItem(item.item || item, { title: item.title, subtitle: item.kind === 'cited' ? `cited source [${item.n}]` : item.kind === 'story' ? 'ranked story' : 'related headline', url: item.link });
  }

  selectedUrl() {
    if (this.focusedPane === 'related') {
      const link = selectedItem(this.lists.related, this.related())?.link;
      return isHttpUrl(link) ? link : null;
    }
    return this.related().map((r) => r.link).find(isHttpUrl) || null;
  }

  onKey(ev) {
    if (ev.name === 'enter' && this.focusedPane === 'lines' && this.related().length) {
      this.focusPane('related');
      return true;
    }
    return super.onKey(ev);
  }

  hints() {
    return this.focusedPane === 'lines' ? 'Enter → related coverage  o open first source' : 'Enter expand  o open  ← back to brief';
  }

  render(ctx, r) {
    const wide = r.w >= 100;
    const [left, right] = wide ? splitH(r, ['52%', 'fill']) : splitV(r, ['55%', 'fill']);
    this.renderBrief(ctx, left);
    this.renderRelated(ctx, right);
  }

  renderBrief(ctx, r) {
    const { s, t, now } = ctx;
    const ins = this.insights();
    const text = String(ins.worldBrief || '');
    if (text && text !== this.briefText) {
      this.briefText = text;
      this.briefStartedAt = now;
    }
    const inner = panel(ctx, r, {
      title: 'AI world brief',
      focused: this.isFocused('lines'),
      right: ins.generatedAt ? `${ins.briefModel || ins.briefProvider || 'ai'} · ${ageOf(ins.generatedAt, now)} ago` : '',
      badge: this.app.anim && pulse(now, 1600) > 0.5 ? 'AI' : 'AI',
      badgeColor: t.accent3,
      onClick: () => this.focusPane('lines'),
    });
    if (inner.w < 12 || inner.h < 4) return;
    if (!text) {
      label(ctx, inner.x, inner.y, 'waiting for the brief…', { fg: t.dim });
      return;
    }
    const shown = this.app.anim ? typewriterCount(this.briefStartedAt, now, 5) : Infinity;
    const briefLines = wrap(text.slice(0, shown), inner.w);
    const maxBrief = Math.max(2, Math.min(briefLines.length, Math.floor(inner.h * 0.35)));
    let y = inner.y;
    briefLines.slice(0, maxBrief).forEach((line) => {
      s.text(inner.x, y++, line, { fg: t.text, bg: t.panel, attr: ATTR.BOLD }, inner.w);
    });
    if (shown < text.length) s.put(Math.min(inner.x + inner.w - 1, inner.x + (briefLines[briefLines.length - 1] || '').length), y - 1, '▌', { fg: t.accent, bg: t.panel });
    const stats = `${ins.clusterCount || 0} clusters · ${(ins.worldBriefSources || []).length} cited sources · ${(ins.topStories || []).length} ranked stories`;
    s.text(inner.x, y++, stats, { fg: t.muted, bg: t.panel }, inner.w);
    heading(ctx, inner.x, y++, 'story lines', inner.w);
    const listR = rect(inner.x, y, inner.w, inner.y + inner.h - y);
    const lines = this.lines();
    const rowH = inner.w >= 60 ? 2 : 3;
    this.lists.lines.draw(
      ctx,
      listR,
      lines,
      (line, i, { selected, width }) => {
        const n = `${String(line.n || i + 1).padStart(2)}. `;
        const body = String(line.text || '');
        const cites = citations(body);
        const clean = body.replace(/\s*\[\d+\]/g, '');
        const citeText = cites.length ? `  ${cites.map((c) => `[${c}]`).join('')}` : '';
        const wrapped = wrap(clean, Math.max(10, width - n.length - 1 - citeText.length));
        const rows = [];
        for (let k = 0; k < rowH; k++) {
          const seg = [];
          if (k === 0) seg.push({ text: n, fg: selected ? t.selText : t.accent, attr: ATTR.BOLD });
          else seg.push({ text: ' '.repeat(n.length), fg: t.dim });
          let txt = wrapped[k] || '';
          if (k === rowH - 1 && wrapped.length > rowH) txt = `${txt.slice(0, Math.max(0, width - n.length - 2))}…`;
          seg.push({ text: txt, fg: selected ? t.selText : t.text });
          if (k === 0 && citeText) seg.push({ text: citeText, fg: selected ? t.selText : t.info });
          rows.push(seg);
        }
        return rows;
      },
      this.listOpts('lines', { rowHeight: rowH, empty: 'no story lines yet' }),
    );
  }

  renderRelated(ctx, r) {
    const { s, t, now } = ctx;
    const line = selectedItem(this.lists.lines, this.lines());
    const rel = this.related();
    const inner = panel(ctx, r, {
      title: line ? `What line ${line.n || ''} is about` : 'Related coverage',
      focused: this.isFocused('related'),
      right: rel.length ? `${rel.filter((x) => x.kind === 'cited').length} cited · ${rel.filter((x) => x.kind !== 'cited').length} related` : '',
      onClick: () => this.focusPane('related'),
    });
    if (inner.w < 12 || inner.h < 3) return;
    let y = inner.y;
    if (line) {
      const clean = String(line.text || '').replace(/\s*\[\d+\]/g, '');
      for (const l of wrap(clean, inner.w).slice(0, 3)) s.text(inner.x, y++, l, { fg: t.dim, bg: t.panel }, inner.w);
      y++;
    }
    const listR = rect(inner.x, y, inner.w, Math.max(1, inner.y + inner.h - y));
    const rowH = inner.w >= 50 ? 2 : 3;
    this.lists.related.draw(
      ctx,
      listR,
      rel,
      (it, _i, { selected, width }) => {
        const tag = it.kind === 'cited' ? `[${it.n}]` : it.kind === 'story' ? ' ★ ' : it.isAlert ? ' ⚠ ' : ' › ';
        const tagColor = it.kind === 'cited' ? t.info : it.kind === 'story' ? t.accent2 : it.isAlert ? t.bad : t.accent;
        const meta = `${it.source || ''}${it.publishedAt ? ` · ${ageOf(it.publishedAt, now)}` : ''}`;
        const titleLines = wrap(String(it.title || ''), Math.max(8, width - 4));
        const rows = [[
          { text: `${tag} `, fg: selected ? t.selText : tagColor, attr: ATTR.BOLD },
          { text: titleLines[0] || '', fg: selected ? t.selText : t.text, attr: it.kind === 'cited' ? ATTR.BOLD : 0 },
        ]];
        if (rowH === 3) rows.push([{ text: '    ' }, { text: titleLines[1] || '', fg: selected ? t.selText : t.text }]);
        rows.push([{ text: '    ' }, { text: meta, fg: selected ? t.selText : t.dim }, { text: it.snippet ? `  ${String(it.snippet).slice(0, Math.max(0, width - meta.length - 8))}` : '', fg: selected ? t.selText : t.muted }]);
        return rows;
      },
      this.listOpts('related', { rowHeight: rowH, empty: line ? 'no cited sources or matching headlines for this line' : 'select a story line' }),
    );
    void segments;
  }
}
