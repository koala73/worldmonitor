import type { NewsItem } from '@/types';
import { generateSummary, type SummarizationResult } from '@/services/summarization';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { Panel, type PanelOptions } from './Panel';

export type SportsAnalysisCard = {
  label: string;
  value: string;
  detail?: string;
  tone?: 'sky' | 'emerald' | 'amber' | 'rose';
};

export type SportsAnalysisPoint = {
  label: string;
  text: string;
};

export type SportsAnalysisStory = {
  title: string;
  link: string;
  source: string;
  publishedAt: Date;
  tag?: string;
};

const TONE_STYLES: Record<NonNullable<SportsAnalysisCard['tone']>, { border: string; glow: string; text: string }> = {
  sky: { border: 'rgba(96,165,250,0.30)', glow: 'rgba(59,130,246,0.10)', text: '#bfdbfe' },
  emerald: { border: 'rgba(52,211,153,0.30)', glow: 'rgba(16,185,129,0.10)', text: '#a7f3d0' },
  amber: { border: 'rgba(251,191,36,0.30)', glow: 'rgba(245,158,11,0.10)', text: '#fde68a' },
  rose: { border: 'rgba(251,113,133,0.30)', glow: 'rgba(244,63,94,0.10)', text: '#fecdd3' },
};

export abstract class SportsAnalysisPanelBase<TData> extends Panel {
  protected data: TData | null = null;
  protected aiBrief: SummarizationResult | null = null;
  protected fallbackBrief = '';
  protected aiPending = false;
  private summaryRequestId = 0;
  private summarySignature = '';

  protected constructor(options: PanelOptions) {
    super(options);
  }

  protected requestAiBrief(inputs: string[]): void {
    const cleaned = [...new Set(inputs.map((input) => input.trim()).filter(Boolean))].slice(0, 8);
    const signature = cleaned.join('||');
    if (signature === this.summarySignature && (this.aiPending || !!this.aiBrief?.summary)) {
      return;
    }

    this.summarySignature = signature;
    this.aiBrief = null;

    if (cleaned.length < 2) {
      this.aiPending = false;
      this.renderPanel();
      return;
    }

    const requestId = ++this.summaryRequestId;
    this.aiPending = true;
    this.renderPanel();

    void generateSummary(cleaned, undefined, this.panelId)
      .then((result) => {
        if (requestId !== this.summaryRequestId || signature !== this.summarySignature) return;
        this.aiBrief = result;
      })
      .catch(() => {
        if (requestId !== this.summaryRequestId || signature !== this.summarySignature) return;
        this.aiBrief = null;
      })
      .finally(() => {
        if (requestId !== this.summaryRequestId || signature !== this.summarySignature) return;
        this.aiPending = false;
        this.renderPanel();
      });
  }

  public destroy(): void {
    this.summaryRequestId += 1;
    super.destroy();
  }

  protected abstract renderPanel(): void;
}

export function normalizeLookup(value: string | undefined): string {
  return (value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function dedupeNewsItems(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const deduped: NewsItem[] = [];

  for (const item of items) {
    const key = `${item.link}|${normalizeLookup(item.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

export function countFreshStories(items: NewsItem[], windowHours = 36): number {
  const cutoff = Date.now() - (windowHours * 60 * 60 * 1000);
  return items.filter((item) => item.pubDate.getTime() >= cutoff).length;
}

export function countFreshAnalysisStories(stories: SportsAnalysisStory[], windowHours = 36): number {
  const cutoff = Date.now() - (windowHours * 60 * 60 * 1000);
  return stories.filter((story) => story.publishedAt.getTime() >= cutoff).length;
}

export function formatUpdatedAt(value?: string | number | Date): string {
  if (!value) return 'Live feed';
  const stamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(stamp)) return String(value);
  return new Date(stamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatPublishedAt(value: Date): string {
  return value.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function renderAiBrief(summary: SummarizationResult | null, fallbackBrief: string, isPending: boolean): string {
  const title = summary?.summary ? 'AI Brief' : isPending ? 'AI Brief' : 'Signal Read';
  const body = summary?.summary || fallbackBrief;
  const meta = summary?.summary
    ? (summary.cached ? 'Cached AI brief' : `${summary.provider.toUpperCase()} AI brief`)
    : isPending
      ? 'Generating from the latest story mix and live table context.'
      : 'Deterministic fallback while AI analysis is unavailable.';

  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;background:linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));display:grid;gap:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(title)}</div>
        ${isPending && !summary?.summary ? '<span style="display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:rgba(59,130,246,0.16);color:#bfdbfe;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">Loading</span>' : ''}
      </div>
      <div style="font-size:13px;line-height:1.65;color:rgba(255,255,255,0.88);">${escapeHtml(body || 'Live sports context is building.')}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.48);">${escapeHtml(meta)}</div>
    </section>
  `;
}

export function renderAnalysisCards(cards: SportsAnalysisCard[]): string {
  return `
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:8px;">
      ${cards.map((card) => {
        const tone = card.tone ? TONE_STYLES[card.tone] : null;
        return `
          <article style="border:1px solid ${tone?.border || 'rgba(255,255,255,0.08)'};border-radius:12px;padding:12px;background:linear-gradient(180deg, ${tone?.glow || 'rgba(255,255,255,0.04)'}, rgba(255,255,255,0.02));display:grid;gap:6px;min-width:0;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.46);">${escapeHtml(card.label)}</div>
            <div style="font-size:15px;font-weight:800;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${tone ? `color:${tone.text};` : ''}">${escapeHtml(card.value)}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.56);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(card.detail || '')}</div>
          </article>
        `;
      }).join('')}
    </section>
  `;
}

export function renderAnalysisPoints(title: string, points: SportsAnalysisPoint[]): string {
  if (!points.length) return '';

  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(title)}</div>
      <div style="display:grid;gap:8px;">
        ${points.map((point) => `
          <article style="display:grid;gap:4px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.46);">${escapeHtml(point.label)}</div>
            <div style="font-size:12px;line-height:1.6;color:rgba(255,255,255,0.78);">${escapeHtml(point.text)}</div>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

export function renderDistributionChips(title: string, entries: Array<{ label: string; value: string }>): string {
  if (!entries.length) return '';

  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(title)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${entries.map((entry) => `
          <span style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);font-size:11px;color:rgba(255,255,255,0.78);">
            <span style="font-weight:700;color:#f8fafc;">${escapeHtml(entry.label)}</span>
            <span style="color:rgba(255,255,255,0.54);">${escapeHtml(entry.value)}</span>
          </span>
        `).join('')}
      </div>
    </section>
  `;
}

export function renderAnalysisStories(title: string, stories: SportsAnalysisStory[], emptyText: string): string {
  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;background:rgba(255,255,255,0.02);display:grid;gap:10px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.52);">${escapeHtml(title)}</div>
      ${stories.length ? stories.map((story) => `
        <a href="${sanitizeUrl(story.link)}" target="_blank" rel="noopener" style="display:grid;gap:5px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);text-decoration:none;color:inherit;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
            <div style="font-size:13px;font-weight:700;line-height:1.45;">${escapeHtml(story.title)}</div>
            ${story.tag ? `<span style="display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;background:rgba(59,130,246,0.14);color:#bfdbfe;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;white-space:nowrap;">${escapeHtml(story.tag)}</span>` : ''}
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;color:rgba(255,255,255,0.46);">
            <span>${escapeHtml(story.source)}</span>
            <span>${escapeHtml(formatPublishedAt(story.publishedAt))}</span>
          </div>
        </a>
      `).join('') : `<div style="font-size:12px;color:rgba(255,255,255,0.56);line-height:1.6;">${escapeHtml(emptyText)}</div>`}
    </section>
  `;
}
