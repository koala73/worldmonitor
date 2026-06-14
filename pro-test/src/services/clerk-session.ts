function safeDecodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function hasLikelyLiveClerkSession(cookieHeader: string): boolean {
  if (/(?:^|;\s*)__session=[^;]+/.test(cookieHeader)) return true;

  const clientUat = cookieHeader.match(/(?:^|;\s*)__client_uat=([^;]*)/);
  if (!clientUat) return false;

  const value = safeDecodeCookieValue(clientUat[1]).trim();
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0;
}
