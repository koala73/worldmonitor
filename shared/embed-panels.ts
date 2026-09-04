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

export type EmbedPanelEntitlement = 'public' | 'api-key';

export interface EmbedPanelDefinition {
  id: EmbedPanelId;
  label: string;
  entitlement: EmbedPanelEntitlement;
  aliases: readonly string[];
}

export const EMBEDDABLE_PANELS: readonly EmbedPanelDefinition[] = [
  {
    id: 'map',
    label: 'Live Map',
    entitlement: 'public',
    aliases: ['live-map', 'live_map', 'livemap'],
  },
  {
    id: 'chokepoint-strip',
    label: 'Chokepoint Monitor',
    entitlement: 'api-key',
    aliases: ['chokepoints', 'chokepoint', 'chokepoint-monitor'],
  },
  {
    id: 'fear-greed',
    label: 'Fear & Greed',
    entitlement: 'api-key',
    aliases: ['feargreed', 'fear_greed', 'markets-fear-greed'],
  },
];

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

export function isEmbedPanelId(value: string): value is EmbedPanelId {
  return PANEL_DEF_BY_ID.has(value as EmbedPanelId);
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

export function panelRequiresEmbeddingApiKey(id: EmbedPanelId): boolean {
  return getEmbedPanelDefinition(id).entitlement === 'api-key';
}

export function listEmbeddablePanels(): readonly EmbedPanelDefinition[] {
  return EMBEDDABLE_PANELS;
}
