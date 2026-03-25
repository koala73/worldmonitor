const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] || char);
}

/**
 * Return true if the hostname resolves to a private / loopback / link-local
 * address range.  Used by {@link sanitizeUrl} to mitigate client-side SSRF.
 */
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.+$/, '');
  let ipCandidate = h.replace(/^\[|\]$/g, '');

  // Loopback
  // eslint-disable-next-line no-restricted-syntax -- intentional: SSRF protection checking hostname values per RFC 6761; not constructing URLs
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;

  if (ipCandidate === '::1' || ipCandidate === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ipCandidate)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/i.test(ipCandidate)) return true; // fe80::/10 link-local

  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ipCandidate);
  if (v4Mapped) {
    ipCandidate = v4Mapped[1] ?? '';
  } else {
    const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipCandidate);
    if (v4MappedHex) {
      const hi = Number.parseInt(v4MappedHex[1] ?? '0', 16);
      const lo = Number.parseInt(v4MappedHex[2] ?? '0', 16);
      ipCandidate = [
        (hi >> 8) & 0xff,
        hi & 0xff,
        (lo >> 8) & 0xff,
        lo & 0xff,
      ].join('.');
    }
  }

  // Numeric IPv4 check
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipCandidate);
  if (ipv4Match) {
    const parts = ipv4Match.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return false;
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 127) return true;                    // 127.0.0.0/8 loopback
    if (a === 10) return true;                     // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;       // 192.168.0.0/16
    if (a === 169 && b === 254) return true;       // 169.254.0.0/16 link-local
    if (a === 0) return true;                      // 0.0.0.0/8
    if (a >= 224) return true;                     // multicast / reserved
  }

  return false;
}

export function sanitizeUrl(url: string): string {
  if (!url) return '';
  const trimmed = String(url).trim();
  if (!trimmed) return '';

  const isAllowedProtocol = (protocol: string) => protocol === 'http:' || protocol === 'https:';

  try {
    const parsed = new URL(trimmed);
    if (isAllowedProtocol(parsed.protocol)) {
      if (isPrivateHostname(parsed.hostname)) return '';
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
