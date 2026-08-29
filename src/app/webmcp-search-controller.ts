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
  classifySearchMatchEffect,
  isSearchResultEffectHostExecutable,
  searchResultEffectRequiresCancellation,
  type SearchResultEffectClass,
} from '@/app/webmcp-search-effects';
import {
  DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS,
  DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS,
  DASHBOARD_SEARCH_TITLE_MAX_CHARS,
  DASHBOARD_SEARCH_TYPE_MAX_CHARS,
  WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
  raceWebMcpAbort,
  throwIfWebMcpAborted,
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
  effectClass: SearchResultEffectClass;
}

export interface WebMcpSearchControllerBindings {
  waitForIndexReady(): Promise<void>;
  isDestroyed(): boolean;
  refreshIndex(): void;
  getModal(): SearchModal | null | undefined;
  hasPremiumAccess(): boolean;
  fetchLiveFlight(callsign: string, signal?: AbortSignal): Promise<void>;
  getAuthContext(): string;
  getVariant(): string;
  isMatchExecutable(match: SearchMatch): boolean;
  isPanelCurrentlyEnabled(panelId: string): boolean;
  selectMatch(match: SearchMatch, signal?: AbortSignal): Promise<boolean>;
  subscribeAuth(listener: () => void): () => void;
  subscribeEntitlement(listener: () => void): () => void;
  subscribeRuntimeConfig(listener: () => void): () => void;
  subscribeWidgetAccess(listener: () => void): () => void;
  onPremiumAccessChanged(premium: boolean, premiumRestored: boolean): void;
  cancelPendingSelection(): void;
}

interface ActiveOpenOperation {
  epoch: number;
  controller: AbortController;
}

/** Owns WebMCP capability issuance, revocation, and use-time validation. */
export class WebMcpSearchController {
  private securityEpoch = 0;
  private openOperationEpoch = 0;
  private activeOpenOperation: ActiveOpenOperation | null = null;
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
      this.cancelPendingOpen();
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
    this.cancelPendingOpen();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.resultCache.clear();
  }

  /** Cancel renderer-readiness and selection phases of the current result open. */
  public cancelPendingOpen(): void {
    this.openOperationEpoch += 1;
    const active = this.activeOpenOperation;
    this.activeOpenOperation = null;
    active?.controller.abort();
    this.bindings.cancelPendingSelection();
  }

  public async search(
    query: string,
    scope: DashboardSearchScope,
    limit: number,
    signal?: AbortSignal,
  ): Promise<DashboardSearchResponse> {
    await raceWebMcpAbort(this.bindings.waitForIndexReady(), signal);
    throwIfWebMcpAborted(signal);
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
        await raceWebMcpAbort(
          this.bindings.fetchLiveFlight(searchResult.flightCallsign, signal),
          signal,
        );
        throwIfWebMcpAborted(signal);
        if (this.bindings.isDestroyed()) throw new Error('Search manager destroyed');
        this.bindings.refreshIndex();
        searchResult = modal.search(query, scope as SearchScope);
      } catch (error) {
        throwIfWebMcpAborted(signal);
        if (this.bindings.isDestroyed()) throw error;
        // Live enrichment is optional. A failed lookup is an empty result.
      }
    }

    const matches = searchResult.orderedMatches;
    const targetCancellationSupported = Boolean(signal);
    const candidates = matches.slice(0, limit).map((match) => ({
      match,
      descriptor: this.describeMatch(match, targetCancellationSupported),
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
    throwIfWebMcpAborted(signal);
    const results: DashboardSearchDescriptor[] = accepted.map(({ match, descriptor }) => ({
      key: this.resultCache.issue({
        query,
        scope,
        identity: searchMatchIdentity(match),
        authContext,
        securityEpoch: this.securityEpoch,
        variant: this.bindings.getVariant(),
        effectClass: this.classifyMatch(match),
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
    signal?: AbortSignal,
  ): Promise<DashboardSearchOpenResult> {
    throwIfWebMcpAborted(signal);
    // Claim authority before capability validation or renderer readiness. A
    // newer open (including an invalid key) supersedes every phase of the
    // previous operation, not only work that already reached the dispatcher.
    this.cancelPendingOpen();
    const epoch = this.openOperationEpoch;
    const controller = new AbortController();
    this.activeOpenOperation = { epoch, controller };
    const handleCallerAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', handleCallerAbort, { once: true });

    try {
      // Host cancellation capability is the caller's signal. The internal
      // controller is always present so a newer open can supersede this one;
      // it must not make a Chrome-without-signal host look capable.
      const result = await this.openCurrent(
        resultKey,
        waitForMapReady,
        controller.signal,
        Boolean(signal),
      );
      throwIfWebMcpAborted(signal);
      if (!this.isOpenOperationCurrent(epoch, controller)) {
        return this.denied('result_no_longer_executable');
      }
      return result;
    } catch (error) {
      // Caller cancellation remains an exception carrying the caller's exact
      // reason. Human interaction, security invalidation, destroy, and a newer
      // open are internal authority changes and therefore return a denial.
      throwIfWebMcpAborted(signal);
      if (controller.signal.aborted || !this.isOpenOperationCurrent(epoch, controller)) {
        return this.bindings.isDestroyed()
          ? this.denied('search_state_changed')
          : this.denied('result_no_longer_executable');
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', handleCallerAbort);
      if (this.activeOpenOperation?.controller === controller) {
        this.activeOpenOperation = null;
      }
    }
  }

  private async openCurrent(
    resultKey: string,
    waitForMapReady: (() => Promise<void>) | undefined,
    signal: AbortSignal,
    targetCancellationSupported: boolean,
  ): Promise<DashboardSearchOpenResult> {
    throwIfWebMcpAborted(signal);
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
    const cancellationDenied = this.cancellationUnsupportedDenial(
      issued.effectClass,
      liveMatch,
      targetCancellationSupported,
    );
    if (cancellationDenied) return cancellationDenied;

    if (this.requiresMapRenderer(liveMatch) && waitForMapReady) {
      await raceWebMcpAbort(waitForMapReady(), signal);
      throwIfWebMcpAborted(signal);
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
    const cancellationDeniedAfterRefresh = this.cancellationUnsupportedDenial(
      issued.effectClass,
      liveMatch,
      targetCancellationSupported,
    );
    if (cancellationDeniedAfterRefresh) return cancellationDeniedAfterRefresh;

    throwIfWebMcpAborted(signal);
    this.resultCache.delete(resultKey);
    const selected = await this.bindings.selectMatch(liveMatch, signal);
    throwIfWebMcpAborted(signal);
    if (this.bindings.isDestroyed()) return this.denied('search_state_changed');
    if (!selected) {
      return this.denied('result_no_longer_executable');
    }
    this.bindings.getModal()?.closeForProgrammaticSelection();
    return { ok: true, status: 'opened', type: this.matchType(liveMatch) };
  }

  private isOpenOperationCurrent(epoch: number, controller: AbortController): boolean {
    return !controller.signal.aborted
      && epoch === this.openOperationEpoch
      && this.activeOpenOperation?.epoch === epoch
      && this.activeOpenOperation?.controller === controller;
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

  private describeMatch(
    match: SearchMatch,
    targetCancellationSupported: boolean,
  ): Omit<DashboardSearchDescriptor, 'key'> {
    const subtitle = match.kind === 'command' ? match.subtitle : match.result.subtitle;
    const effectClass = this.classifyMatch(match);
    return {
      type: this.matchType(match).slice(0, DASHBOARD_SEARCH_TYPE_MAX_CHARS),
      title: (match.kind === 'command' ? match.title : match.result.title)
        .slice(0, DASHBOARD_SEARCH_TITLE_MAX_CHARS),
      ...(subtitle ? { subtitle: subtitle.slice(0, DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS) } : {}),
      executable: this.bindings.isMatchExecutable(match)
        && isSearchResultEffectHostExecutable(effectClass, targetCancellationSupported),
    };
  }

  private classifyMatch(match: SearchMatch): SearchResultEffectClass {
    return classifySearchMatchEffect(
      match,
      (panelId) => this.bindings.isPanelCurrentlyEnabled(panelId),
    );
  }

  private cancellationUnsupportedDenial(
    boundEffect: SearchResultEffectClass,
    liveMatch: SearchMatch,
    targetCancellationSupported: boolean,
  ): DashboardSearchOpenResult | null {
    const liveEffect = this.classifyMatch(liveMatch);
    if (
      targetCancellationSupported
      || (
        !searchResultEffectRequiresCancellation(boundEffect)
        && !searchResultEffectRequiresCancellation(liveEffect)
      )
    ) {
      return null;
    }
    return this.denied(
      'target_cancellation_unsupported',
      WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
    );
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

  private denied(
    reason: NonNullable<DashboardSearchOpenResult['reason']>,
    message?: string,
  ): DashboardSearchOpenResult {
    return message
      ? { ok: false, status: 'denied', reason, message }
      : { ok: false, status: 'denied', reason };
  }
}
