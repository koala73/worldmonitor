import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

interface RenderSourceLinksOptions {
  limit?: number;
  label?: string;
  containerClass?: string;
  linkClass?: string;
}

function extractSourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

export function renderPopupSourceLinks(sourceUrls: readonly string[] | undefined, options: RenderSourceLinksOptions = {}): string {
  const limit = options.limit ?? 3;
  const label = options.label ?? 'Source';
  const containerClass = options.containerClass ?? 'popup-source-links';
  const linkClass = options.linkClass ?? 'popup-link';
  const links: string[] = [];

  for (const url of sourceUrls ?? []) {
    if (links.length >= limit) break;
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) continue;
    const domain = extractSourceDomain(url) || `${label} ${links.length + 1}`;
    links.push(
      `<a class="${escapeHtml(linkClass)}" href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(domain)} →</a>`,
    );
  }

  return links.length
    ? `<div class="${escapeHtml(containerClass)}">${links.join('')}</div>`
    : '';
}
