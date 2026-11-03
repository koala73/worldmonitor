import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

const FIXED_SECTION_HEADERS = new Set(['SITUATION NOW', 'KEY RISKS', 'OUTLOOK', 'WATCH ITEMS']);

// Whole heading lines only: a claim that merely starts "Outlook for..." or
// "Key risks include..." stays body text.
function isSectionHeader(line: string): boolean {
  const heading = line.replace(/:$/, '').trim();
  if (FIXED_SECTION_HEADERS.has(heading.toUpperCase())) return true;
  return /^WHAT THIS MEANS FOR \S/.test(heading) && heading === heading.toUpperCase();
}

export interface IntelBriefCitationSource {
  title?: string;
  url?: string;
}

/** A World Monitor data point a claim cites as `[En]` (proto BriefEvidence). */
export interface IntelBriefEvidence {
  id: string;
  label?: string;
  value?: string;
  asOf?: string;
  url?: string;
}

type IntelBriefCitationOptions =
  | { sources: readonly IntelBriefCitationSource[] }
  | { count: number; hrefPrefix: string };

function unwrapBriefEmphasisLine(line: string): string {
  let current = line.trim();
  for (let i = 0; i < 4; i++) {
    const next = current
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\*\*(.*)\*\*$/, '$1')
      .trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

function applyBriefEmphasis(escaped: string): string {
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*\*/g, '');
}

function describeEvidence(item: IntelBriefEvidence): string {
  const asOf = item.asOf ? ` (as of ${item.asOf.slice(0, 10)})` : '';
  return `${item.label || item.id}: ${item.value ?? ''}${asOf}`;
}

function displayBriefHeader(line: string, countryName?: string): string {
  if (countryName && /^WHAT THIS MEANS FOR\b/i.test(line)) {
    return `What this means for ${escapeHtml(countryName)}`;
  }
  return applyBriefEmphasis(line);
}

/**
 * Converts structured LLM intel brief text into HTML.
 * Handles the 5-section format (SITUATION NOW / WHAT THIS MEANS FOR / KEY RISKS / OUTLOOK / WATCH ITEMS).
 * Falls back gracefully to paragraph rendering for older prose-format responses.
 *
 * @param text         Raw brief text from LLM
 * @param citationOpts Optional citation link config for source references like [1], [2]
 * @param countryName  Display name used to replace ISO-code "WHAT THIS MEANS FOR XX" titles
 * @param evidence     Evidence items that `[En]` markers cite; unknown ids stay plain text
 */
export function formatIntelBrief(
  text: string,
  citationOpts?: IntelBriefCitationOptions,
  countryName?: string,
  evidence?: readonly IntelBriefEvidence[],
): string {
  const escaped = escapeHtml(text);
  const lines = escaped.split('\n');
  const out: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = unwrapBriefEmphasisLine(line.trim());
    const isHeader = isSectionHeader(trimmed);

    if (isHeader) {
      if (inSection) out.push('</div>');
      out.push(`<div class="brief-section"><div class="brief-section-header">${displayBriefHeader(trimmed, countryName)}</div>`);
      inSection = true;
    } else if (/^(?:[•\-]\s*|\*\s+)/.test(trimmed)) {
      out.push(`<div class="brief-bullet">${applyBriefEmphasis(trimmed.replace(/^(?:[•\-]\s*|\*\s+)/, ''))}</div>`);
    } else if (trimmed.startsWith('NEXT ')) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        const label = applyBriefEmphasis(trimmed.slice(0, colonIdx));
        const body = applyBriefEmphasis(trimmed.slice(colonIdx + 1).trim());
        out.push(`<div class="brief-outlook-row"><strong class="brief-outlook-label">${label}:</strong> ${body}</div>`);
      } else {
        out.push(`<div class="brief-para">${applyBriefEmphasis(trimmed)}</div>`);
      }
    } else if (trimmed) {
      out.push(`<div class="brief-para">${applyBriefEmphasis(trimmed)}</div>`);
    }
  }

  if (inSection) out.push('</div>');
  let html = out.join('') || `<p>${escaped.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;

  const hasSourceCitations = !!citationOpts && ('sources' in citationOpts || citationOpts.count > 0);
  const evidenceById = new Map((evidence ?? []).map((item) => [item.id, item]));
  if (hasSourceCitations || evidenceById.size > 0) {
    // One pass over both marker kinds, so a title attribute written for one
    // citation is never rescanned for the other.
    html = html.replace(/\[(E?)(\d{1,2})\]/g, (match, evidencePrefix, numStr) => {
      if (evidencePrefix) {
        const item = evidenceById.get(`E${numStr}`);
        if (!item) return match;
        const title = escapeHtml(describeEvidence(item));
        const href = sanitizeUrl(item.url ?? '');
        return href
          ? `<a href="${href}" target="_blank" rel="noopener noreferrer" class="cb-citation cb-evidence-citation" title="${title}">${match}</a>`
          : `<span class="cb-evidence-citation" title="${title}">${match}</span>`;
      }
      if (!citationOpts || !hasSourceCitations) return match;
      const n = parseInt(numStr, 10);
      if ('sources' in citationOpts) {
        const source = citationOpts.sources[n - 1];
        const href = sanitizeUrl(source?.url ?? '');
        return href
          ? `<a href="${href}" target="_blank" rel="noopener noreferrer" class="cb-citation" title="${escapeHtml(source?.title ?? `Source ${n}`)}">[${n}]</a>`
          : `[${numStr}]`;
      }

      const { count, hrefPrefix } = citationOpts;
      return n >= 1 && n <= count
        ? `<a href="${hrefPrefix}${n}" class="cb-citation">[${n}]</a>`
        : `[${numStr}]`;
    });
  }

  return html;
}

/**
 * Lists the World Monitor data points a brief cites, styled like the sources
 * footer. Links go through sanitizeUrl; everything else is escaped text.
 */
export function renderBriefEvidenceFooter(
  evidence: readonly IntelBriefEvidence[] | undefined,
  options: { className?: string } = {},
): string {
  const items = (evidence ?? []).filter((item) => item && typeof item.id === 'string' && item.id);
  if (items.length === 0) return '';
  const rows = items.map((item) => {
    const href = sanitizeUrl(item.url ?? '');
    const label = escapeHtml(item.label || item.id);
    const name = href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    const when = item.asOf ? ` <span class="brief-source-date">${escapeHtml(item.asOf.slice(0, 10))}</span>` : '';
    return `
      <li>
        ${name}
        <span class="brief-source-meta">[${escapeHtml(item.id)}] ${escapeHtml(item.value ?? '')}${when}</span>
      </li>`;
  }).join('');
  return `
    <details class="${escapeHtml(options.className ?? 'brief-sources')}">
      <summary>World Monitor data (${items.length})</summary>
      <ol>${rows}</ol>
    </details>`;
}
