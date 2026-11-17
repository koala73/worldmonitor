import { NewsServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';

/** One realtime alert delivered to the signed-in account (ListSentAlerts). */
export interface SentAlert {
  title: string;
  source: string;
  link: string;
  eventType: string;
  severity: string;
  /** Unix epoch milliseconds. */
  sentAt: number;
  channels: string[];
}

const SENT_ALERTS_TIMEOUT_MS = 8_000;

let client: InstanceType<typeof NewsServiceClient> | null = null;

/**
 * The alerts delivered to the signed-in Pro account in the last seven days,
 * newest first. Null when the record could not be read (signed out, not Pro,
 * offline, or the server reported it unavailable), which is not the same as
 * an account with no alerts.
 */
export async function fetchSentAlerts(): Promise<SentAlert[] | null> {
  // premiumFetch attaches the Clerk bearer; the server reads the account from it.
  client ??= new NewsServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });
  try {
    const response = await client.listSentAlerts({}, { signal: AbortSignal.timeout(SENT_ALERTS_TIMEOUT_MS) });
    return response.state === 'ok' ? response.alerts : null;
  } catch {
    return null;
  }
}
