import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

const SECTION_HEADERS = ['SITUATION NOW', 'WHAT THIS MEANS FOR', 'KEY RISKS', 'OUTLOOK', 'WATCH ITEMS'];

export interface IntelBriefCitationSource {
  title?: string;
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
 */
export function formatIntelBrief(
  text: string,
  citationOpts?: IntelBriefCitationOptions,
  countryName?: string,
): string {
  const escaped = escapeHtml(text);
  const lines = escaped.split('\n');
  const out: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = unwrapBriefEmphasisLine(line.trim());
    const isHeader = SECTION_HEADERS.some(h => trimmed.toUpperCase().startsWith(h));

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

  if (citationOpts && ('sources' in citationOpts || citationOpts.count > 0)) {
    html = html.replace(/\[(\d{1,2})\]/g, (_match, numStr) => {
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
