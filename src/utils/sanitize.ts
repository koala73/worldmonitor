const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

declare const safeHtmlBrand: unique symbol;

export interface SafeHtml {
  readonly [safeHtmlBrand]: true;
  toString(): string;
}

export type SafeHtmlInterpolation = SafeHtml | string | number | boolean | null | undefined;

class SafeHtmlValue implements SafeHtml {
  public declare readonly [safeHtmlBrand]: true;

  constructor(private readonly html: string) {}

  public toString(): string {
    return this.html;
  }
}

function isSafeHtml(value: unknown): value is SafeHtml {
  return value instanceof SafeHtmlValue;
}

export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] || char);
}

export function safeHtml(
  strings: TemplateStringsArray,
  ...values: SafeHtmlInterpolation[]
): SafeHtml {
  let html = strings[0] ?? '';

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    html += isSafeHtml(value) ? value.toString() : escapeHtml(String(value ?? ''));
    html += strings[i + 1] ?? '';
  }

  return new SafeHtmlValue(html);
}

export function unsafeRawHtml(html: string, reason: string): SafeHtml {
  if (!reason.trim()) {
    throw new Error('unsafeRawHtml() requires an audit reason');
  }
  return new SafeHtmlValue(String(html));
}

/**
 * Joins already-safe HTML fragments. String separators are treated as text and
 * escaped; pass safeHtml`<br>` or unsafeRawHtml('<br>', reason) for markup.
 */
export function joinSafeHtml(parts: SafeHtml[], separator: SafeHtml | string = ''): SafeHtml {
  const safeSeparator = isSafeHtml(separator) ? separator.toString() : escapeHtml(separator);
  return new SafeHtmlValue(parts.map(safeHtmlToString).join(safeSeparator));
}

export function safeHtmlToString(html: SafeHtml): string {
  return html.toString();
}

export function sanitizeUrl(url: string): string {
  if (!url) return '';
  const trimmed = String(url).trim();
  if (!trimmed) return '';

  const isAllowedProtocol = (protocol: string) => protocol === 'http:' || protocol === 'https:';

  try {
    const parsed = new URL(trimmed);
    if (isAllowedProtocol(parsed.protocol)) {
      return escapeAttr(parsed.toString());
    }
  } catch {
    // Not an absolute URL, continue and validate as relative.
  }

  if (!/^(\/|\.\/|\.\.\/|\?|#)/.test(trimmed)) {
    return '';
  }

  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://example.com';
    const resolved = new URL(trimmed, base);
    if (!isAllowedProtocol(resolved.protocol)) {
      return '';
    }
    return escapeAttr(trimmed);
  } catch {
    return '';
  }
}

export function escapeAttr(str: string): string {
  return escapeHtml(str);
}

export function safeUrlAttr(url: string): SafeHtml {
  // sanitizeUrl() returns an attribute-escaped URL or an empty string.
  return unsafeRawHtml(sanitizeUrl(url), 'URL passed through sanitizeUrl() for HTML attribute interpolation');
}
