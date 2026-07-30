import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

const SECTION_HEADERS = ['SITUATION NOW', 'WHAT THIS MEANS FOR', 'KEY RISKS', 'OUTLOOK', 'WATCH ITEMS'];

export interface IntelBriefCitationSource {
  title?: string;
  url?: string;
}

type IntelBriefCitationOptions =
  | { sources: readonly IntelBriefCitationSource[] }
  | { count: number; hrefPrefix: string };

/**
 * Converts structured LLM intel brief text into HTML.
 * Handles the 5-section format (SITUATION NOW / WHAT THIS MEANS FOR / KEY RISKS / OUTLOOK / WATCH ITEMS).
 * Falls back gracefully to paragraph rendering for older prose-format responses.
 *
 * @param text         Raw brief text from LLM
 * @param citationOpts Optional citation link config for source references like [1], [2]
 */
export function formatIntelBrief(
  text: string,
  citationOpts?: IntelBriefCitationOptions,
): string {
  const escaped = escapeHtml(text);
  const lines = escaped.split('\n');
  const out: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader = SECTION_HEADERS.some(h => trimmed.toUpperCase().startsWith(h));

    if (isHeader) {
      if (inSection) out.push('</div>');
      out.push(`<div class="brief-section"><div class="brief-section-header">${trimmed}</div>`);
      inSection = true;
    } else if (trimmed.startsWith('•') || trimmed.startsWith('-')) {
      out.push(`<div class="brief-bullet">${trimmed.replace(/^[•-]\s*/, '')}</div>`);
    } else if (trimmed.startsWith('NEXT ')) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        const label = trimmed.slice(0, colonIdx);
        const body = trimmed.slice(colonIdx + 1).trim();
        out.push(`<div class="brief-outlook-row"><strong class="brief-outlook-label">${label}:</strong> ${body}</div>`);
      } else {
        out.push(`<div class="brief-para">${trimmed}</div>`);
      }
    } else if (trimmed) {
      out.push(`<div class="brief-para">${trimmed.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</div>`);
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
