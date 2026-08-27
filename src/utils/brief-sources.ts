import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import {
  collectInsightSources,
  normalizeInsightSource,
  normalizeInsightSourceUrl,
} from '../../shared/insights-snapshot.js';

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
const BRIEF_SOURCES_METHODOLOGY_HREF = '/docs/methodology/news-digest-and-briefing';

export function normalizeBriefSourceUrl(value: unknown): string {
  return normalizeInsightSourceUrl(value);
}

export function normalizeBriefSource(candidate: BriefSourceCandidate): BriefSource | null {
  return normalizeInsightSource(candidate);
}

export function collectBriefSources(
  candidates: BriefSourceCandidate[],
  maxSources = DEFAULT_MAX_SOURCES,
): BriefSource[] {
  return collectInsightSources(candidates, maxSources);
}

/**
 * Preserve the producer's positional citation slots. The seeded World Brief
 * assigns source n to citation [n], including an empty-url fallback when a
 * story has no usable link. Citation rendering must retain those slots even
 * when the footer later filters sources for display.
 */
export function collectBriefCitationSources(
  candidates: BriefSourceCandidate[],
  maxSources = DEFAULT_MAX_SOURCES,
): BriefSource[] {
  return candidates.slice(0, Math.max(0, maxSources)).map((candidate) =>
    normalizeInsightSource(candidate, { allowEmptyUrl: true }) ?? { title: '', source: '', url: '' },
  );
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
