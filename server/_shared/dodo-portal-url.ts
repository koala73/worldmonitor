export function safeDodoPortalRedirectUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host !== 'dodopayments.com' && !host.endsWith('.dodopayments.com')) {
      return null;
    }
    const path = url.pathname || '/';
    return `https://${host}${path}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
