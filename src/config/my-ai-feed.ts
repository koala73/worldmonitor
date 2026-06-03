import type { Feed } from '@/types';

// AI Engineer talks — canonical channel id resolved from
// https://www.youtube.com/@aiDotEngineer (page rel="canonical" / browseId).
// Verified 2026-06-02. Re-resolve with:
//   curl -s -A "Mozilla/5.0" https://www.youtube.com/@aiDotEngineer | grep -o 'channel/UC[A-Za-z0-9_-]*'
const AI_ENGINEER_YT_CHANNEL_ID = 'UCLKPca3kwwd-B59HNr-_lvA';

type EnvLike = Record<string, string | undefined>;

// Read Vite env without throwing when import.meta.env is absent (e.g. the tsx
// test runner). Mirrors the guarded pattern in src/config/variant.ts.
function viteEnv(): EnvLike {
  try {
    return (import.meta as unknown as { env?: EnvLike }).env ?? {};
  } catch {
    return {};
  }
}

function splitCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the "My AI Feed" list with RAW target URLs (no proxy wrapping — feeds.ts
 * wraps each url with rss()). Native entries are always present; RSSHub-backed
 * entries appear only when VITE_RSSHUB_BASE is set. Production calls with no
 * argument and reads import.meta.env; tests pass `env` explicitly.
 */
export function buildMyAiFeeds(env: EnvLike = viteEnv()): Feed[] {
  const feeds: Feed[] = [
    { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml' },
    { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
    {
      name: 'AI Engineer',
      url: `https://www.youtube.com/feeds/videos.xml?channel_id=${AI_ENGINEER_YT_CHANNEL_ID}`,
    },
  ];

  const base = (env.VITE_RSSHUB_BASE ?? '').trim().replace(/\/+$/, '');
  if (!base) return feeds;

  // Best-effort RSSHub namespaces; confirm/adjust on your instance (see runbook).
  feeds.push({ name: 'Anthropic Engineering', url: `${base}/anthropic/engineering` });
  feeds.push({ name: 'OpenAI Research', url: `${base}/openai/research` });

  for (const handle of splitCsv(env.VITE_AI_X_HANDLES)) {
    feeds.push({ name: `X · @${handle}`, url: `${base}/twitter/user/${handle}` });
  }
  for (const slug of splitCsv(env.VITE_AI_LINKEDIN_PAGES)) {
    feeds.push({ name: `LinkedIn · ${slug}`, url: `${base}/linkedin/company/${slug}` });
  }

  return feeds;
}
