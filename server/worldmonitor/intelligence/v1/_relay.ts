import { CHROME_UA } from '../../../_shared/constants';

export function getRelayBaseUrl(): string | null {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '');
}

export function getRelayHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
    ...extra,
  };

  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (!relaySecret) return headers;

  const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
  headers[relayHeader] = relaySecret;
  headers.Authorization = `Bearer ${relaySecret}`;
  return headers;
}
