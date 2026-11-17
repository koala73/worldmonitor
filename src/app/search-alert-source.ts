import type { SearchableSource } from '@/components/search-types';
import type { SentAlert } from '@/services/sent-alerts';

// The Cmd+K "Alerts sent to you" source. The dashboard indexes only the news
// it has loaded, so a headline from an alert email or push could not be found
// once it aged out. This source lists what the relay delivered to the account,
// whether or not the dashboard still holds the story.

/** How long one answer is reused before search asks again. */
export const SENT_ALERTS_REFRESH_MS = 60_000;

/** Payload of an `alert` search result. */
export interface SentAlertSearchData {
  title: string;
  source: string;
  link: string;
  sentAt: number;
}

export function isOpenableAlertLink(link: string): boolean {
  if (!link) return false;
  try {
    const { protocol } = new URL(link);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function linkHost(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Search rows for delivered alerts, in the order given (the server lists them
 * newest first). `describe` supplies the publisher and sent-time text, so this
 * stays free of locale and clock state. A headline delivered twice with the
 * same link keeps its newest row.
 */
export function sentAlertSearchItems(
  alerts: readonly SentAlert[],
  describe: (alert: SentAlert) => string,
): SearchableSource['items'] {
  const seen = new Set<string>();
  const items: SearchableSource['items'] = [];
  for (const alert of alerts) {
    const link = isOpenableAlertLink(alert.link) ? alert.link : '';
    const identity = `${alert.title}\u0000${link}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const host = linkHost(link);
    const data: SentAlertSearchData = { title: alert.title, source: alert.source, link, sentAt: alert.sentAt };
    items.push({
      id: `${alert.sentAt}:${link || alert.title}`,
      title: alert.title,
      subtitle: host ? `${describe(alert)} · ${host}` : describe(alert),
      data,
    });
  }
  return items;
}

interface SentAlertSearchSourceDeps {
  /** The signed-in Pro account, or null when there is none to read for. */
  getAccountKey(): string | null;
  /** Null when the record could not be read. */
  fetchAlerts(): Promise<readonly SentAlert[] | null>;
  publish(items: SearchableSource['items']): void;
  describe(alert: SentAlert): string;
  now?(): number;
}

export class SentAlertSearchSource {
  private accountKey: string | null = null;
  private requestedAt = Number.NEGATIVE_INFINITY;
  // Bumped whenever the account changes, so an answer for the previous
  // account is discarded when it arrives.
  private generation = 0;

  constructor(private readonly deps: SentAlertSearchSourceDeps) {}

  /** Called when search opens. Fetches at most once per interval per account. */
  async refresh(): Promise<void> {
    const accountKey = this.deps.getAccountKey();
    if (accountKey !== this.accountKey) this.reset(accountKey);
    if (!accountKey) return;

    const now = this.deps.now?.() ?? Date.now();
    if (now - this.requestedAt < SENT_ALERTS_REFRESH_MS) return;
    this.requestedAt = now;
    const generation = this.generation;

    let alerts: readonly SentAlert[] | null;
    try {
      alerts = await this.deps.fetchAlerts();
    } catch {
      alerts = null;
    }
    if (generation !== this.generation) return;
    if (alerts === null) {
      // Keep what is indexed and ask again on the next open.
      this.requestedAt = Number.NEGATIVE_INFINITY;
      return;
    }
    this.deps.publish(sentAlertSearchItems(alerts, this.deps.describe));
  }

  /** Drop the indexed alerts, for example when Pro access ends. */
  clear(): void {
    this.reset(null);
  }

  private reset(accountKey: string | null): void {
    const hadAccount = this.accountKey !== null;
    this.accountKey = accountKey;
    this.generation += 1;
    this.requestedAt = Number.NEGATIVE_INFINITY;
    if (hadAccount) this.deps.publish([]);
  }
}
