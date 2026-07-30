import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

export interface BriefSource {
  title: string;
  source: string;
  url: string;
  publishedAt?: string;
}

export interface BriefSourceCandidate {
  title?: unknown;
  primaryTitle?: unknown;
  source?: unknown;
  primarySource?: unknown;
  url?: unknown;
  link?: unknown;
  primaryLink?: unknown;
  publishedAt?: unknown;
  pubDate?: unknown;
}

const DEFAULT_MAX_SOURCES = 6;
const MAX_TITLE_LEN = 160;
const MAX_SOURCE_LEN = 80;
const BRIEF_SOURCES_METHODOLOGY_HREF = '/docs/methodology/news-digest-and-briefing';

function clipText(value: unknown, maxLen: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trim()}...` : text;
}

export function normalizeBriefSourceUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizePublishedAt(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  return undefined;
}

export function normalizeBriefSource(candidate: BriefSourceCandidate): BriefSource | null {
  const url = normalizeBriefSourceUrl(candidate.url ?? candidate.link ?? candidate.primaryLink);
  if (!url) return null;

  const title = clipText(candidate.title ?? candidate.primaryTitle, MAX_TITLE_LEN);
  const source = clipText(candidate.source ?? candidate.primarySource, MAX_SOURCE_LEN);
  if (!title || !source) return null;

  const publishedAt = normalizePublishedAt(candidate.publishedAt ?? candidate.pubDate);
  return publishedAt ? { title, source, url, publishedAt } : { title, source, url };
}

export function collectBriefSources(
  candidates: BriefSourceCandidate[],
  maxSources = DEFAULT_MAX_SOURCES,
): BriefSource[] {
  const out: BriefSource[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const source = normalizeBriefSource(candidate);
    if (!source || seen.has(source.url)) continue;
    out.push(source);
    seen.add(source.url);
    if (out.length >= maxSources) break;
  }
  return out;
}

export function normalizeCachedBriefSources(
  cacheData: { sources?: BriefSourceCandidate[] } | undefined,
  maxSources = DEFAULT_MAX_SOURCES,
): { sources: BriefSource[]; legacySourceShape: boolean } {
  const legacySourceShape = !cacheData || !Object.prototype.hasOwnProperty.call(cacheData, 'sources');
  return {
    sources: collectBriefSources(cacheData?.sources ?? [], maxSources),
    legacySourceShape,
  };
}

export function buildBriefSourceContextLines(sources: BriefSource[]): string[] {
  return sources.map((source, index) => {
    const payload = source.publishedAt
      ? { title: source.title, source: source.source, url: source.url, publishedAt: source.publishedAt }
      : { title: source.title, source: source.source, url: source.url };
    return `Source [${index + 1}]: ${JSON.stringify(payload)}`;
  });
}

export function renderBriefSourcesFooter(
  sources: BriefSource[] | undefined,
  options: { className?: string; methodologyHref?: string; maxSources?: number } = {},
): string {
  const normalized = collectBriefSources(sources ?? [], options.maxSources ?? DEFAULT_MAX_SOURCES);
  if (normalized.length === 0) return '';

  const className = options.className ?? 'brief-sources';
  const methodologyHref = sanitizeUrl(options.methodologyHref ?? BRIEF_SOURCES_METHODOLOGY_HREF);
  const sourceWord = normalized.length === 1 ? 'source' : 'sources';
  const items = normalized.map((source) => {
    const href = sanitizeUrl(source.url);
    const when = source.publishedAt ? ` <span class="brief-source-date">${escapeHtml(source.publishedAt.slice(0, 10))}</span>` : '';
    return `
      <li>
        <a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a>
        <span class="brief-source-meta">${escapeHtml(source.source)}${when}</span>
      </li>`;
  }).join('');

  const methodology = methodologyHref
    ? ` &middot; <a href="${methodologyHref}" target="_blank" rel="noopener noreferrer">Methodology</a>`
    : '';

  return `
    <details class="${escapeHtml(className)}">
      <summary>Sources (${normalized.length})</summary>
      <div class="brief-sources-note">AI-synthesized from ${normalized.length} ${sourceWord} &middot; may contain errors${methodology}</div>
      <ol>${items}</ol>
    </details>`;
}
