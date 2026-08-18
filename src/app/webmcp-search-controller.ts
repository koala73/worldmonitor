import type { SearchModal } from '@/components/SearchModal';
import type { SearchScope } from '@/components/search-scope';
import {
  searchMatchIdentity,
  type SearchMatch,
} from '@/components/search-types';
import { OpaqueResultCache } from '@/services/opaque-result-cache';
import type {
  DashboardSearchDescriptor,
  DashboardSearchOpenResult,
  DashboardSearchResponse,
  DashboardSearchScope,
} from '@/services/webmcp';
import {
  DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS,
  DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS,
  DASHBOARD_SEARCH_TITLE_MAX_CHARS,
  DASHBOARD_SEARCH_TYPE_MAX_CHARS,
} from '@/services/webmcp';

const SEARCH_RESULT_CACHE_MAX_ENTRIES = 64;
const SEARCH_RESULT_CACHE_TTL_MS = 2 * 60 * 1000;

interface IssuedSearchResult {
  query: string;
  scope: DashboardSearchScope;
  identity: string;
  authContext: string;
  securityEpoch: number;
  variant: string;
}

export interface WebMcpSearchControllerBindings {
  waitForIndexReady(): Promise<void>;
  isDestroyed(): boolean;
  refreshIndex(): void;
  getModal(): SearchModal | null | undefined;
  hasPremiumAccess(): boolean;
  fetchLiveFlight(callsign: string): Promise<void>;
  getAuthContext(): string;
  getVariant(): string;
  isMatchExecutable(match: SearchMatch): boolean;
  selectMatch(match: SearchMatch): Promise<boolean>;
  subscribeAuth(listener: () => void): () => void;
  subscribeEntitlement(listener: () => void): () => void;
  subscribeRuntimeConfig(listener: () => void): () => void;
  subscribeWidgetAccess(listener: () => void): () => void;
  onPremiumAccessChanged(premium: boolean, premiumRestored: boolean): void;
  cancelPendingSelection(): void;
}

/** Owns WebMCP capability issuance, revocation, and use-time validation. */
export class WebMcpSearchController {
  private securityEpoch = 0;
  private lastPremiumAccess = false;
  private unsubscribers: Array<() => void> = [];
  private readonly resultCache = new OpaqueResultCache<IssuedSearchResult>({
    maxEntries: SEARCH_RESULT_CACHE_MAX_ENTRIES,
    ttlMs: SEARCH_RESULT_CACHE_TTL_MS,
  });

  public constructor(private readonly bindings: WebMcpSearchControllerBindings) {}

  public observeSecurityContext(): void {
    if (this.unsubscribers.length > 0) return;
    this.lastPremiumAccess = this.bindings.hasPremiumAccess();
    const invalidate = (): void => {
      this.securityEpoch += 1;
      this.resultCache.clear();
      this.bindings.cancelPendingSelection();
      const premium = this.bindings.hasPremiumAccess();
      const premiumRestored = !this.lastPremiumAccess && premium;
      this.lastPremiumAccess = premium;
      this.bindings.onPremiumAccessChanged(premium, premiumRestored);
    };
    this.unsubscribers = [
      this.subscribeAfterInitial(this.bindings.subscribeAuth, invalidate),
      this.subscribeAfterInitial(this.bindings.subscribeEntitlement, invalidate),
      this.bindings.subscribeRuntimeConfig(invalidate),
      this.bindings.subscribeWidgetAccess(invalidate),
    ];
  }

  public destroy(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.resultCache.clear();
  }

  public async search(
    query: string,
    scope: DashboardSearchScope,
    limit: number,
  ): Promise<DashboardSearchResponse> {
    await this.bindings.waitForIndexReady();
    if (this.bindings.isDestroyed()) throw new Error('Search manager destroyed');
    this.bindings.refreshIndex();
    const modal = this.bindings.getModal();
    if (!modal) throw new Error('Search index is not initialised');

    let searchResult = modal.search(query, scope as SearchScope);
    if (
      searchResult.flightCallsign
      && searchResult.orderedMatches.length === 0
      && this.bindings.hasPremiumAccess()
    ) {
      try {
        await this.bindings.fetchLiveFlight(searchResult.flightCallsign);
        if (this.bindings.isDestroyed()) throw new Error('Search manager destroyed');
        this.bindings.refreshIndex();
        searchResult = modal.search(query, scope as SearchScope);
      } catch (error) {
        if (this.bindings.isDestroyed()) throw error;
        // Live enrichment is optional. A failed lookup is an empty result.
      }
    }

    const matches = searchResult.orderedMatches;
    const candidates = matches.slice(0, limit).map((match) => ({
      match,
      descriptor: this.describeMatch(match),
    }));
    const accepted: typeof candidates = [];
    for (const candidate of candidates) {
      const projectedResults = [...accepted, candidate].map(({ descriptor }) => ({
        key: `sr_${'0'.repeat(32)}`,
        ...descriptor,
      }));
      if (JSON.stringify({
        queryLength: query.length,
        results: projectedResults,
        resultCount: projectedResults.length,
        truncated: false,
      }).length > DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS) break;
      accepted.push(candidate);
    }

    const authContext = this.bindings.getAuthContext();
    const results: DashboardSearchDescriptor[] = accepted.map(({ match, descriptor }) => ({
      key: this.resultCache.issue({
        query,
        scope,
        identity: searchMatchIdentity(match),
        authContext,
        securityEpoch: this.securityEpoch,
        variant: this.bindings.getVariant(),
      }),
      ...descriptor,
    }));

    return {
      queryLength: query.length,
      results,
      resultCount: results.length,
      truncated: matches.length > results.length,
    };
  }

  public async open(
    resultKey: string,
    waitForMapReady?: () => Promise<void>,
  ): Promise<DashboardSearchOpenResult> {
    if (this.bindings.isDestroyed()) return this.denied('invalid_or_expired_key');
    const issued = this.resultCache.get(resultKey);
    if (!issued) return this.denied('invalid_or_expired_key');

    if (!this.isIssuedContextCurrent(issued)) {
      this.resultCache.delete(resultKey);
      return this.denied('search_state_changed');
    }

    this.bindings.refreshIndex();
    const modal = this.bindings.getModal();
    if (!modal) {
      this.resultCache.delete(resultKey);
      return this.denied('search_state_changed');
    }
    let liveMatch = this.resolveLiveMatch(modal, issued);
    if (!liveMatch) {
      this.resultCache.delete(resultKey);
      return this.denied('result_no_longer_available');
    }
    if (!this.bindings.isMatchExecutable(liveMatch)) {
      this.resultCache.delete(resultKey);
      return this.denied('result_no_longer_executable');
    }

    if (this.requiresMapRenderer(liveMatch) && waitForMapReady) {
      await waitForMapReady();
      if (this.bindings.isDestroyed() || !this.isIssuedContextCurrent(issued)) {
        this.resultCache.delete(resultKey);
        return this.denied('search_state_changed');
      }
      this.bindings.refreshIndex();
      const refreshedModal = this.bindings.getModal();
      liveMatch = refreshedModal ? this.resolveLiveMatch(refreshedModal, issued) : undefined;
      if (!liveMatch) {
        this.resultCache.delete(resultKey);
        return this.denied('result_no_longer_available');
      }
    }

    if (!this.bindings.isMatchExecutable(liveMatch)) {
      this.resultCache.delete(resultKey);
      return this.denied('result_no_longer_executable');
    }
    if (this.bindings.isDestroyed()) {
      this.resultCache.delete(resultKey);
      return this.denied('search_state_changed');
    }

    this.resultCache.delete(resultKey);
    this.bindings.getModal()?.closeForProgrammaticSelection();
    const selected = await this.bindings.selectMatch(liveMatch);
    if (this.bindings.isDestroyed()) return this.denied('search_state_changed');
    if (!selected) {
      return this.denied('result_no_longer_executable');
    }
    return { ok: true, status: 'opened', type: this.matchType(liveMatch) };
  }

  private subscribeAfterInitial(
    subscribe: (listener: () => void) => () => void,
    listener: () => void,
  ): () => void {
    let subscribing = true;
    const unsubscribe = subscribe(() => {
      if (!subscribing) listener();
    });
    subscribing = false;
    return unsubscribe;
  }

  private describeMatch(match: SearchMatch): Omit<DashboardSearchDescriptor, 'key'> {
    const subtitle = match.kind === 'command' ? match.subtitle : match.result.subtitle;
    return {
      type: this.matchType(match).slice(0, DASHBOARD_SEARCH_TYPE_MAX_CHARS),
      title: (match.kind === 'command' ? match.title : match.result.title)
        .slice(0, DASHBOARD_SEARCH_TITLE_MAX_CHARS),
      ...(subtitle ? { subtitle: subtitle.slice(0, DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS) } : {}),
      executable: this.bindings.isMatchExecutable(match),
    };
  }

  private matchType(match: SearchMatch): string {
    return match.kind === 'command' ? 'command' : match.result.type;
  }

  private requiresMapRenderer(match: SearchMatch): boolean {
    if (match.kind === 'result') {
      return !['country', 'news', 'market', 'prediction'].includes(match.result.type);
    }
    const [category = '', action = ''] = match.command.id.split(':', 2);
    return ['nav', 'country-map', 'layer', 'layers', 'time'].includes(category)
      || (category === 'view' && ['resilience', 'route-explorer'].includes(action));
  }

  private resolveLiveMatch(
    modal: SearchModal,
    issued: IssuedSearchResult,
  ): SearchMatch | undefined {
    return modal.resolveMatchByIdentity(issued.identity)
      ?? modal.search(issued.query, issued.scope as SearchScope).orderedMatches
        .find((match) => searchMatchIdentity(match) === issued.identity);
  }

  private isIssuedContextCurrent(issued: IssuedSearchResult): boolean {
    return issued.variant === this.bindings.getVariant()
      && issued.authContext === this.bindings.getAuthContext()
      && issued.securityEpoch === this.securityEpoch;
  }

  private denied(reason: NonNullable<DashboardSearchOpenResult['reason']>): DashboardSearchOpenResult {
    return { ok: false, status: 'denied', reason };
  }
}
