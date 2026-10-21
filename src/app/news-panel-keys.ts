/**
 * Which panel key a generic NewsPanel takes for a CANONICAL_FEEDS category.
 *
 * A feed-category key is not automatically free to use as a panel key. Several
 * categories share a name with a DATA panel registered earlier in the same pass
 * — `markets` (MarketPanel), `commodities` (CommoditiesPanel), `crypto`
 * (CryptoPanel), `economic` (EconomicPanel), `supply-chain` (SupplyChainPanel).
 * The registration dedup guard makes the second claim on a key a silent no-op,
 * so a NewsPanel asking for the colliding key is simply never created. It has to
 * take `${key}-news` instead — which is exactly what the `markets-news` /
 * `crypto-news` / `economic-news` / `commodities-news` entries in the panel
 * catalog are for.
 *
 * That collision used to be an enumerated set in panel-layout
 * (`COLLIDING_NEWS_PANEL_KEYS`) and it omitted `commodities`: the finance
 * variant shipped a "Commodities News" settings toggle and a mission preset
 * (`finCommodities`) that both referenced a panel nothing ever created (#5871).
 * #5376 hit the mirror image of this on the data-resolution side and replaced
 * its constant with a registry derived at registration time; this is the same
 * treatment for the panel-creation side. The caller knows, synchronously,
 * whether something already owns a key — so ask it instead of keeping a
 * hand-maintained list in sync with the panel registry.
 */

/** The `has(key)` surface of a Set or Map — all this module needs from either. */
export interface KeyMembership {
  has: (key: string) => boolean;
}

export interface NewsPanelKeyLookups {
  /** `true` when CANONICAL_FEEDS carries a feed list under this key. */
  isFeedCategory: (key: string) => boolean;
  /** `true` when a NewsPanel has already been registered for this category. */
  hasNewsPanel: (categoryKey: string) => boolean;
  /**
   * `true` when some panel already owns this panel key — created, or registered
   * lazily and not yet loaded. Both count: a lazy registration reserves the key
   * long before `ctx.panels` gains an entry, and that reservation is what makes
   * the second claim a no-op.
   */
  isPanelKeyClaimed: (panelKey: string) => boolean;
  /** `true` when `panelSettings` carries an entry for this panel key. */
  hasPanelSetting: (panelKey: string) => boolean;
}

/**
 * The panel key to register a NewsPanel for `categoryKey` under, or `null` when
 * no NewsPanel should be created for it.
 *
 * `null` covers every reason the pass has to skip a category: it carries no feed
 * list, it already has a NewsPanel, the key it resolves to is already taken (so
 * the registration would be a no-op), or that key has no settings entry — which
 * is how a data-panel collision with no `${key}-news` catalog entry stays
 * invisible rather than spawning a phantom panel under the data panel's own
 * settings entry.
 *
 * Returning the key that will actually be claimed (rather than the key we would
 * *like* to claim) is what makes this answerable in a test: "every `*-news`
 * settings entry is reachable from some feed category" is checkable only if the
 * caller can tell a resolution that lands a panel from one that silently does
 * nothing.
 */
export function newsPanelKeyForCategory(
  categoryKey: string,
  lookups: NewsPanelKeyLookups,
): string | null {
  if (!lookups.isFeedCategory(categoryKey)) return null;
  if (lookups.hasNewsPanel(categoryKey)) return null;

  const panelKey = lookups.isPanelKeyClaimed(categoryKey) ? `${categoryKey}-news` : categoryKey;

  if (lookups.isPanelKeyClaimed(panelKey)) return null;
  if (!lookups.hasPanelSetting(panelKey)) return null;

  return panelKey;
}

/**
 * Whether `panelSettings` carries an entry for `key`.
 *
 * Presence, not truthiness — this is what every panel registration in
 * panel-layout gates on (`shouldCreatePanel`), so the news pass has to ask the
 * same question or it would resolve to a key the registration then refuses.
 */
export function hasPanelSettingEntry(panelSettings: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(panelSettings, key);
}

/**
 * Live registration state the CANONICAL_FEEDS pass reads. Field names mirror the
 * panel-layout members they are fed from.
 */
export interface NewsPanelRegistrationState {
  /** `CANONICAL_FEEDS` — a key with an array value is a feed category. */
  canonicalFeeds: Record<string, unknown>;
  /** `ctx.panels` — panels already created. */
  panels: Record<string, unknown>;
  /** `lazyPanelRegistrations` — keys reserved by a registration that has not loaded yet. */
  lazyPanelRegistrations: KeyMembership;
  /** `ctx.newsCategoryPanelKeys` — categories whose NewsPanel registration was claimed. */
  newsCategoryPanelKeys: KeyMembership;
  /** `ctx.panelSettings` — the effective panel catalog for this session. */
  panelSettings: object;
  /** Keys owned by a panel registered AFTER the pass (`LATE_REGISTERED_PANEL_KEYS`). */
  lateRegisteredPanelKeys: KeyMembership;
}

/**
 * Bind `newsPanelKeyForCategory` to live registration state.
 *
 * This adapter is the half a resolver test could otherwise never reach. The
 * resolver only asks *questions*; whether the answers describe reality is
 * decided here — most load-bearingly that a key counts as claimed when it is
 * merely REGISTERED (`lazyPanelRegistrations`) and not yet created. That is the
 * whole mechanism of #5871: a lazy registration reserves the key long before
 * `ctx.panels` gains an entry, so an adapter that consulted only `ctx.panels`
 * would report `commodities` unclaimed, hand back the data panel's own key, and
 * let the registration no-op exactly as the hardcoded set did. Building it here
 * rather than inline in `createPanels()` is what lets the guard bind it.
 */
export function newsPanelKeyLookupsFor(state: NewsPanelRegistrationState): NewsPanelKeyLookups {
  return {
    isFeedCategory: (key) => Array.isArray(state.canonicalFeeds[key]),
    hasNewsPanel: (categoryKey) => state.newsCategoryPanelKeys.has(categoryKey),
    isPanelKeyClaimed: (panelKey) =>
      state.lateRegisteredPanelKeys.has(panelKey)
      || state.panels[panelKey] != null
      || state.lazyPanelRegistrations.has(panelKey),
    hasPanelSetting: (panelKey) => hasPanelSettingEntry(state.panelSettings, panelKey),
  };
}
