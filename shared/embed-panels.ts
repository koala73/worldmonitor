/**
 * Partner-embed panel allowlist.
 *
 * `/embed?panel=` may only render these ids. Keep this module free of browser
 * and server imports so both the embed entry (`src/embed/`) and the
 * entitlement edge handler (`api/embed/entitlement.ts`) share one contract.
 *
 * X / tweet bodies are intentionally absent: embed partners receive derived
 * facts plus permalinks only. Do not add an X panel that dumps post text.
 */

export const EMBED_PANEL_IDS = ['map', 'chokepoint-strip', 'fear-greed'] as const;

export type EmbedPanelId = (typeof EMBED_PANEL_IDS)[number];

/**
 * Every layer a partner embed may request.
 *
 * Lives here, beside the free-tier policy that names a subset of it, rather
 * than in `src/embed/embed-url.ts` — that module pairs each id with a
 * `keyof MapLayers`, so it imports the app's DOM-facing types and cannot be
 * read from the edge. `embed-url.ts` derives its ids from this list, so the
 * two cannot drift.
 */
export const EMBED_LAYER_IDS = [
  'conflicts',
  'earthquakes',
  'protests',
  'weather',
  'cables',
  'pipelines',
  'waterways',
  'tradeRoutes',
  'economic',
  'stockExchanges',
  'financialCenters',
  'centralBanks',
  'commodityHubs',
  'gulfInvestments',
] as const;

export type EmbedLayerId = (typeof EMBED_LAYER_IDS)[number];

/** Keyless embeds refresh hourly; a keyed embed keeps the ten-minute cadence. */
export const EMBED_FREE_REFRESH_MS = 60 * 60 * 1000;
export const EMBED_KEYED_REFRESH_MS = 10 * 60 * 1000;

/**
 * What a panel costs.
 *
 * `paid-only` has no keyless rendering. A `tiered` panel serves a reduced,
 * slower version to a keyless embed — a deliberate growth surface, not a
 * degraded error state — and its `free` policy is the ONLY definition of what
 * that reduced version contains, so consumers ask the registry instead of
 * re-listing layers at their own call sites.
 *
 * `rpcPaths` names the gateway routes a paid-only panel reads with its embed
 * key, and is the ONLY thing that widens the gateway's `wme_` surface
 * (`EMBED_KEY_RPC_PATHS` below). A tiered panel has none by construction: it
 * polls the composed `/api/embed/map-frame`, which authenticates a `wmg_`
 * grant rather than a key. Moving a paid panel onto that endpoint is how this
 * field goes away.
 *
 * This replaced a `'public' | 'api-key'` field, which could not express that
 * `map` is both: free for three layers at an hourly cadence, paid for all
 * fourteen at ten minutes.
 */
export type EmbedPanelAccess =
  | { kind: 'paid-only'; rpcPaths: readonly string[] }
  | { kind: 'tiered'; free: { layers: readonly EmbedLayerId[]; refreshMs: number } };

export interface EmbedPanelDefinition {
  id: EmbedPanelId;
  label: string;
  access: EmbedPanelAccess;
  aliases: readonly string[];
}

export const EMBEDDABLE_PANELS: readonly EmbedPanelDefinition[] = [
  {
    id: 'map',
    label: 'Live Map',
    access: {
      kind: 'tiered',
      free: {
        layers: ['conflicts', 'earthquakes', 'weather'],
        refreshMs: EMBED_FREE_REFRESH_MS,
      },
    },
    aliases: ['live-map', 'live_map', 'livemap'],
  },
  {
    id: 'chokepoint-strip',
    label: 'Chokepoint Monitor',
    access: { kind: 'paid-only', rpcPaths: ['/api/supply-chain/v1/get-chokepoint-status'] },
    aliases: ['chokepoints', 'chokepoint', 'chokepoint-monitor'],
  },
  {
    id: 'fear-greed',
    label: 'Fear & Greed',
    access: { kind: 'paid-only', rpcPaths: ['/api/market/v1/get-fear-greed-index'] },
    aliases: ['feargreed', 'fear_greed', 'markets-fear-greed'],
  },
];

/**
 * Every gateway route an embed key may authenticate, derived from the panels
 * that declare one. Read by `server/gateway.ts`.
 *
 * Derived rather than hand-listed so the gateway surface cannot grow without a
 * panel owning the path. Both entries today are routes that already answer an
 * anonymous `wms_` session token — neither is tier-gated nor in
 * `PREMIUM_RPC_PATHS` — so accepting `wme_` here adds no reachable data; it
 * gives a frame that has no session a credential shape the gateway
 * understands, in place of the `wm_` key it is being migrated off.
 */
export const EMBED_KEY_RPC_PATHS: ReadonlySet<string> = new Set(
  EMBEDDABLE_PANELS.flatMap((panel) =>
    panel.access.kind === 'paid-only' ? [...panel.access.rpcPaths] : [],
  ),
);

export const DEFAULT_EMBED_PANEL_ID: EmbedPanelId = 'map';

const PANEL_BY_TOKEN = new Map<string, EmbedPanelId>();
for (const panel of EMBEDDABLE_PANELS) {
  PANEL_BY_TOKEN.set(panel.id, panel.id);
  for (const alias of panel.aliases) {
    PANEL_BY_TOKEN.set(alias.toLowerCase(), panel.id);
  }
}

const PANEL_DEF_BY_ID = new Map<EmbedPanelId, EmbedPanelDefinition>(
  EMBEDDABLE_PANELS.map((panel) => [panel.id, panel]),
);

const EMBED_LAYER_ID_SET: ReadonlySet<string> = new Set(EMBED_LAYER_IDS);

export function isEmbedPanelId(value: string): value is EmbedPanelId {
  return PANEL_DEF_BY_ID.has(value as EmbedPanelId);
}

export function isEmbedLayerId(value: string): value is EmbedLayerId {
  return EMBED_LAYER_ID_SET.has(value);
}

export function parseEmbedPanelId(value: string | null | undefined): EmbedPanelId | null {
  if (value == null) return DEFAULT_EMBED_PANEL_ID;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_EMBED_PANEL_ID;
  return PANEL_BY_TOKEN.get(trimmed.toLowerCase()) ?? null;
}

export function getEmbedPanelDefinition(id: EmbedPanelId): EmbedPanelDefinition {
  const def = PANEL_DEF_BY_ID.get(id);
  if (!def) throw new Error(`Unknown embed panel: ${id}`);
  return def;
}

export function getEmbedPanelAccess(id: EmbedPanelId): EmbedPanelAccess {
  return getEmbedPanelDefinition(id).access;
}

/**
 * The panel's keyless policy, or null when it has none.
 *
 * Null is the "a credential is mandatory here" answer every caller needs, so
 * asking for the free tier and asking whether the panel is paid-only are one
 * question with one answer — there is no second predicate to keep in sync.
 */
export function getEmbedPanelFreeTier(
  id: EmbedPanelId,
): { layers: readonly EmbedLayerId[]; refreshMs: number } | null {
  const access = getEmbedPanelAccess(id);
  return access.kind === 'tiered' ? access.free : null;
}

export function listEmbeddablePanels(): readonly EmbedPanelDefinition[] {
  return EMBEDDABLE_PANELS;
}
