import xPostBudget from '../lib/x-post-budget.cjs';
import { defaultRedisEval } from '../lib/_upstash-pipeline.mjs';

export const JAPAN_X_MAX_TEXT_LENGTH = 16_000;
export const JAPAN_X_ACCOUNT_ID = '864751444586397696';
export const JAPAN_X_POLL_MS = 6 * 60 * 60 * 1000;
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_POSTS = 25;
const MAX_BYTES = 1024 * 1024;
const MODE = 'official_joint_staff_x_review_candidates';

export function parseJapanXPosts(body) {
  if (body?.errors?.length || !Array.isArray(body?.data)
    || !Number.isInteger(body?.meta?.result_count)
    || body.meta.result_count !== body.data.length || body.data.length > MAX_POSTS) {
    throw new Error('JMOD_X_INVALID_RESPONSE');
  }
  if (body.meta.next_token) throw new Error('JMOD_X_COVERAGE_PARTIAL');
  const media = new Map((body.includes?.media ?? []).map(item => [item.media_key, item]));
  const candidates = [];
  for (const post of body.data) {
    if (post.author_id !== JAPAN_X_ACCOUNT_ID || !/^[1-9]\d{0,19}$/.test(post.id)
      || !Number.isFinite(Date.parse(post.created_at))) throw new Error('JMOD_X_INVALID_POST');
    const text = post.note_tweet?.text ?? post.text;
    if (typeof text !== 'string' || !text.trim() || text.length > JAPAN_X_MAX_TEXT_LENGTH) {
      throw new Error('JMOD_X_INVALID_POST');
    }
    // Keep the official account's complete posts for review, including summaries
    // and image-only announcements. Keyword filtering can silently omit releases.
    const images = [];
    for (const key of post.attachments?.media_keys ?? []) {
      const item = media.get(key);
      if (!item) throw new Error('JMOD_X_MISSING_MEDIA');
      if (item.type !== 'photo') continue;
      let url;
      try { url = new URL(item.url); } catch { throw new Error('JMOD_X_INVALID_MEDIA'); }
      if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com'
        || url.port || url.username || url.password || !url.pathname.startsWith('/media/')) {
        throw new Error('JMOD_X_INVALID_MEDIA');
      }
      images.push({ url: url.href, ...(typeof item.alt_text === 'string' ? { altText: item.alt_text.slice(0, 2000) } : {}) });
    }
    candidates.push({
      documentId: `x-${post.id}`,
      sourceUrl: `https://x.com/jointstaffpa/status/${post.id}`,
      publicationDay: new Date(Date.parse(post.created_at) + 9 * 3600000).toISOString().slice(0, 10),
      publicationTime: post.created_at,
      title: text.split('\n')[0].slice(0, 240),
      text,
      images,
      originalLanguage: 'ja',
      admission: 'manual_review_required',
    });
  }
  return candidates.sort((a, b) => Date.parse(b.publicationTime) - Date.parse(a.publicationTime));
}

export async function fetchJapanXOutcome({
  token,
  now = Date.now(),
  previousSource = null,
  maxCandidates = 15,
  fetchFn = globalThis.fetch,
  budget = xPostBudget.createXPostBudget({
    evalCommand: defaultRedisEval,
    dailyCoveragePosts: xPostBudget.DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
  }),
} = {}) {
  const previous = previousSource?.xDiscovery;
  const age = now - Date.parse(previous?.checkedAt);
  const retained = previousSource?.candidates ?? [];
  const base = { transportMode: MODE, transportPath: 'x_api', requestCount: 0,
    candidates: retained, availableDocumentUrls: [], acquiredAt: previousSource?.lastSuccessAt ?? null };
  if (Number.isFinite(age) && age >= 0 && age < JAPAN_X_POLL_MS) {
    return { ...base, ok: previous.ok === true, errorCodes: previous.errorCodes ?? [],
      availableDocumentUrls: retained.map(row => row.sourceUrl), xDiscovery: previous };
  }
  const checkedAt = new Date(now).toISOString();
  const windowStart = new Date(now - WINDOW_MS).toISOString();
  let requestCount = 0;
  try {
    if (!token?.trim()) throw new Error('JMOD_X_AUTH_MISSING');
    const url = new URL(`https://api.x.com/2/users/${JAPAN_X_ACCOUNT_ID}/tweets`);
    url.search = new URLSearchParams({ max_results: String(MAX_POSTS), start_time: windowStart,
      end_time: new Date(now - 10000).toISOString(), exclude: 'retweets',
      'tweet.fields': 'created_at,entities,author_id,note_tweet,attachments',
      expansions: 'attachments.media_keys', 'media.fields': 'url,alt_text,type' }).toString();
    const result = await budget.withReturnedPosts({ consumer: 'japan-mod', operation: 'x-candidate-discovery',
      requestedPosts: MAX_POSTS, execute: async (_, admission) => {
        xPostBudget.assertXPostBudgetAdmission(url, admission);
        requestCount++;
        const response = await fetchFn(url.href, { redirect: 'error',
          headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/json',
            'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)' },
          signal: AbortSignal.timeout(20000) });
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > MAX_BYTES) throw new Error('JMOD_X_RESPONSE_TOO_LARGE');
            chunks.push(Buffer.from(part.value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return { response, body };
      } });
    if (!result.allowed) throw new Error('JMOD_X_BUDGET_UNAVAILABLE');
    if (!result.completed) throw new Error('JMOD_X_BUDGET_UNSETTLED');
    if (!result.result?.response.ok) throw new Error(`JMOD_X_HTTP_${result.result?.response.status ?? 'ERROR'}`);
    const body = result.result.body;
    if (!body.data && body.meta?.result_count === 0 && !body.errors?.length) body.data = [];
    const rows = parseJapanXPosts(body);
    const candidates = [...new Map([...retained, ...rows].map(row => [row.sourceUrl, row])).values()]
      .sort((a, b) => Date.parse(b.publicationTime ?? b.publicationDay) - Date.parse(a.publicationTime ?? a.publicationDay))
      .slice(0, maxCandidates);
    return { ...base, ok: true, requestCount, acquiredAt: checkedAt,
      candidates, availableDocumentUrls: candidates.map(row => row.sourceUrl), errorCodes: [],
      xDiscovery: { checkedAt, ok: true, windowStart, windowEnd: new Date(now - 10000).toISOString(),
        postCount: body.meta.result_count, errorCodes: [] } };
  } catch (error) {
    const code = /^JMOD_X_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'JMOD_X_REQUEST_FAILED';
    return { ...base, ok: false, requestCount, errorCodes: [code],
      xDiscovery: { checkedAt, ok: false, errorCodes: [code] } };
  }
}
