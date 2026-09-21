/**
 * Live Convo Hotspots news channel — tech/AI digest items that already carry
 * lat/lon, or title→tech-hub inference (same hub index as Tech Hub Activity).
 * Unlocated headlines are omitted (missing ≠ invent).
 */
import { getRpcBaseUrl } from '@/services/rpc-client';
import { NewsServiceClient } from '@/services/generated-rpc-clients';
import { inferHubsFromTitle } from '@/services/tech-hub-index';
import type { NewsItem } from '@/generated/client/worldmonitor/news/v1/service_client';

export type ConvoLiveNewsLocation = {
  lat: number;
  lon: number;
  title: string;
  threatLevel: string;
  timestamp?: Date;
};

const client = new NewsServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

/** Digest category keys that commonly carry AI / product headlines. */
const DIGEST_CATEGORY_KEYS = ['ai', 'tech', 'startups'] as const;

const AI_TITLE_RE =
  /\b(chatgpt|openai|anthropic|claude|gpt-?4|gpt-?4o|llm|llama\s*2|generative\s*ai|artificial\s*intelligence|machine\s*learning|deepseek|mistral|gemini|copilot)\b/i;

function publishedDate(item: NewsItem): Date | undefined {
  const raw = item.publishedAt;
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  // Digests use ms; guard if a feed ever sends seconds.
  const ms = raw < 1e12 ? raw * 1000 : raw;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

function locationFromItem(item: NewsItem): ConvoLiveNewsLocation | null {
  const title = (item.title || '').trim();
  if (!title) return null;
  if (!AI_TITLE_RE.test(title)) return null;

  const threatLevel = item.threat?.level ?? (item.isAlert ? 'high' : 'info');
  const timestamp = publishedDate(item);

  const lat = item.location?.latitude;
  const lon = item.location?.longitude;
  if (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon)
  ) {
    return { lat, lon, title, threatLevel, timestamp };
  }

  const hubs = inferHubsFromTitle(title);
  const best = hubs[0];
  if (!best || best.confidence < 0.5) return null;
  return {
    lat: best.hub.lat,
    lon: best.hub.lon,
    title,
    threatLevel,
    timestamp,
  };
}

/**
 * Fetch tech-variant feed digest and map AI-titled items to Convo news pins.
 * Variant `tech` matches tech.worldmonitor.app category set (ai / tech / …).
 */
export async function fetchConvoLiveNewsLocations(): Promise<ConvoLiveNewsLocation[]> {
  const digest = await client.listFeedDigest({ variant: 'tech', lang: 'en' });
  const seen = new Set<string>();
  const out: ConvoLiveNewsLocation[] = [];

  for (const key of DIGEST_CATEGORY_KEYS) {
    const items = digest.categories[key]?.items ?? [];
    for (const item of items) {
      const loc = locationFromItem(item);
      if (!loc) continue;
      const dedupe = `${loc.lat.toFixed(2)}:${loc.lon.toFixed(2)}:${loc.title.slice(0, 64)}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(loc);
    }
  }

  return out;
}
