export interface LiveTopicPage {
  readonly slug: string;
  readonly path: string;
  readonly statusPath: string;
  record(payload: unknown, now?: number): object;
  renderSection(reading: object | null, options: { live: boolean }): string;
}

export const LIVE_TOPIC_PAGES: readonly LiveTopicPage[];
export function liveTopicPageForPath(pathname: string): LiveTopicPage | null;
export function liveTopicRpcPath(page: LiveTopicPage): string;
export function liveTopicReading(page: LiveTopicPage, payload: unknown, now?: number): object | null;
