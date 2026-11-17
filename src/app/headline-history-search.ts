import type { SearchableSource } from '@/components/search-types';
import type { HistoryHeadline } from '@/services/headline-history';
import { headlineTitleKey } from '@/shared/headline-title-key';

/**
 * Cmd+K source for headlines the dashboard served earlier and no longer
 * holds. The loaded news items are searched in the browser; this asks the
 * server's headline history for the same query and publishes what the loaded
 * items do not already cover.
 *
 * Self-contained on purpose: its own result type (`headline`), its own source
 * registration, no reach into the loaded-news source. It learns the query from
 * the modal's query-change callback and hands results back through `publish`.
 */

/** Payload of a `headline` search result. */
export interface HeadlineHistoryResultData {
  link: string;
  source: string;
  publishedAt: number;
}

export interface HeadlineHistorySearchDeps {
  /** Ask the server. Rejects when the search did not run. */
  fetchHeadlines(query: string, signal: AbortSignal): Promise<HistoryHeadline[]>;
  /** Replace the `headline` source. `refresh` asks the modal to re-run the visible query. */
  publish(items: SearchableSource['items'], refresh: boolean): void;
  /**
   * Whether the loaded-news source returns this title (headlineTitleKey form)
   * for `query`. Loaded is not enough: the browser matches the typed text as
   * one phrase while the server matches its words in any order, so a loaded
   * headline the browser does not match must still be listed from the server.
   */
  isLoadedMatch(titleKey: string, query: string): boolean;
  /**
   * Whether selecting a row with this link can open it (the dashboard's
   * article-opening policy). A row that cannot be opened is not listed.
   */
  isOpenable(link: string): boolean;
  /** "3 hours ago" for a publication time. */
  formatAge(date: Date): string;
  /**
   * Whether an answer for the visible query is still on its way, so the list
   * can say it is loading instead of "no results" in the meantime.
   */
  setPending(pending: boolean): void;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  now(): number;
}

/** Shorter queries match too much of a week of headlines to be worth a request. */
export const HEADLINE_HISTORY_MIN_QUERY_CHARS = 3;
/**
 * Wait after the modal's own 180 ms keystroke debounce before asking the
 * server, so a word typed at normal speed costs one request, not one per letter.
 */
export const HEADLINE_HISTORY_DEBOUNCE_MS = 250;
const ANSWER_TTL_MS = 2 * 60_000;
const MAX_REMEMBERED_ANSWERS = 20;

export class HeadlineHistorySearch {
  /** The query the source currently answers, or is being fetched for. */
  private activeQuery = '';
  private published = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  /** Answers by query, so backspacing to an earlier query needs no second request. */
  private readonly answers = new Map<string, { at: number; headlines: HistoryHeadline[] }>();

  public constructor(private readonly deps: HeadlineHistorySearchDeps) {}

  /**
   * The modal searched `rawInput` (lowercased), or cleared it / closed ('').
   * Safe to call again with the same query: publishing re-runs the modal's
   * search, which must not start a second request.
   */
  public onQueryChange(rawInput: string): void {
    const query = rawInput.toLowerCase().trim();
    if (query === this.activeQuery) return;
    this.stopPending();
    this.activeQuery = query;

    // "flight <callsign>" is the live flight lookup, not a headline search.
    if (query.startsWith('flight ') || headlineTitleKey(query).length < HEADLINE_HISTORY_MIN_QUERY_CHARS) {
      this.clear();
      this.deps.setPending(false);
      return;
    }
    const remembered = this.answers.get(query);
    if (remembered && this.deps.now() - remembered.at < ANSWER_TTL_MS) {
      // Called from inside the modal's own search for this query, which reads
      // the source right after this returns: no extra refresh needed.
      this.publishHeadlines(query, remembered.headlines, false);
      this.deps.setPending(false);
      return;
    }
    // Results fetched for the previous query stay listed only where their
    // title still matches; the modal filters them like any other source.
    this.deps.setPending(true);
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      void this.fetch(query);
    }, HEADLINE_HISTORY_DEBOUNCE_MS);
  }

  /**
   * The loaded news changed (a dashboard refresh). Which server rows are
   * listed depends on it: a title the loaded items cover is left out, so when
   * that item leaves the dashboard its history row has to be listed instead.
   * Lists the answer for the query on screen again; no request and no
   * re-render, the modal reads the source the next time it renders the query.
   */
  public onLoadedNewsChange(): void {
    // Only while the source holds the answer for this query, not mid-fetch.
    if (this.timer !== null || this.inFlight !== null) return;
    const remembered = this.answers.get(this.activeQuery);
    if (remembered) this.publishHeadlines(this.activeQuery, remembered.headlines, false);
  }

  /** Forget everything fetched: the caller's window changed (plan, edition or language). */
  public reset(): void {
    this.stopPending();
    this.answers.clear();
    this.activeQuery = '';
    this.clear();
    this.deps.setPending(false);
  }

  private stopPending(): void {
    if (this.timer !== null) {
      this.deps.clearTimeout(this.timer);
      this.timer = null;
    }
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private clear(): void {
    if (!this.published) return;
    this.published = false;
    this.deps.publish([], false);
  }

  private async fetch(query: string): Promise<void> {
    const controller = new AbortController();
    this.inFlight = controller;
    let headlines: HistoryHeadline[];
    try {
      headlines = await this.deps.fetchHeadlines(query, controller.signal);
    } catch {
      // Optional enrichment: the loaded-news results stand on their own. The
      // failure is not remembered, so typing the query again retries it.
      if (this.inFlight === controller) {
        this.inFlight = null;
        if (this.activeQuery === query) this.activeQuery = '';
        this.deps.setPending(false);
      }
      return;
    }
    if (controller.signal.aborted || this.activeQuery !== query) return;
    this.inFlight = null;
    this.answers.delete(query);
    this.answers.set(query, { at: this.deps.now(), headlines });
    while (this.answers.size > MAX_REMEMBERED_ANSWERS) {
      this.answers.delete(this.answers.keys().next().value as string);
    }
    this.publishHeadlines(query, headlines, true);
    // After publishing: with nothing new to list, this is what turns the
    // loading state into "no results".
    this.deps.setPending(false);
  }

  private publishHeadlines(query: string, headlines: readonly HistoryHeadline[], refresh: boolean): void {
    const items: SearchableSource['items'] = [];
    const seen = new Set<string>();
    for (const headline of headlines) {
      // The server keeps http links too, which API callers can use; the
      // dashboard opens https only, and a row that does nothing is not listed.
      if (!this.deps.isOpenable(headline.link)) continue;
      const titleKey = headlineTitleKey(headline.title);
      // One row per title: where the loaded item is listed too it wins,
      // because selecting it scrolls to the story in its panel.
      if (!titleKey || seen.has(titleKey) || this.deps.isLoadedMatch(titleKey, query)) continue;
      seen.add(titleKey);
      const age = headline.publishedAt > 0 ? this.deps.formatAge(new Date(headline.publishedAt)) : '';
      const data: HeadlineHistoryResultData = {
        link: headline.link,
        source: headline.source,
        publishedAt: headline.publishedAt,
      };
      items.push({
        id: headline.link,
        title: headline.title,
        subtitle: age ? `${headline.source} · ${age}` : headline.source,
        // The server matches words in any order; the modal keeps a row only
        // when its text contains the typed query. Carrying the query here
        // keeps every server match listed for exactly the query it answered.
        searchText: query,
        data,
      });
    }
    if (items.length === 0 && !this.published) return;
    this.published = items.length > 0;
    this.deps.publish(items, refresh);
  }
}
