// The YouTube channels the live video catalog lists, for the audit's channel resolution and the refresh cron.
// A slot opts into refresh by listing a channel entry (youtube.com/channel/UC...); see src/config/live-video-sources.ts.
// Runs under tsx: parseSourceEntry lives in TypeScript.

import { parseSourceEntry } from '../../src/services/live-video/model.ts';

/** One channel page per channel per run: this caps what a catalog edit can add to the proxy bill. */
export const MAX_REFRESH_CHANNELS = 60;

/**
 * Every channel a catalog slot lists, once, in catalog order (webcams, then Live News), with the slots that list it
 * (`webcams/<id>`, `live-news/<id>`). With `includeCanaries`, the audit canaries follow as `canary/<n>`.
 * Throws above MAX_REFRESH_CHANNELS.
 */
export function refreshChannels(catalog, { includeCanaries = false } = {}) {
  const sources = [
    ...Object.entries(catalog.webcams ?? {}).map(([id, entries]) => [`webcams/${id}`, entries]),
    ...Object.entries(catalog.news ?? {}).map(([id, entries]) => [`live-news/${id}`, entries]),
    ...(includeCanaries ? (catalog.canaries ?? []).map((entry, index) => [`canary/${index + 1}`, [entry]]) : []),
  ];
  const byChannel = new Map();
  for (const [slot, entries] of sources) {
    for (const entry of entries) {
      const parsed = parseSourceEntry(entry);
      if (!parsed.ok || parsed.candidate.kind !== 'channel') continue;
      const slots = byChannel.get(parsed.candidate.channelId) ?? [];
      if (!slots.includes(slot)) slots.push(slot);
      byChannel.set(parsed.candidate.channelId, slots);
    }
  }
  if (byChannel.size > MAX_REFRESH_CHANNELS) {
    throw new Error(`the live video catalog lists ${byChannel.size} YouTube channels, more than ${MAX_REFRESH_CHANNELS}; raise MAX_REFRESH_CHANNELS deliberately`);
  }
  return [...byChannel].map(([channelId, slots]) => ({ channelId, slots }));
}
