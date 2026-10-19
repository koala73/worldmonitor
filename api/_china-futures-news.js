import { readJsonFromUpstashWithStatus } from './_upstash-json.js';
import { CACHE_KEY, SOURCE_NAME, SOURCE_URL, MAX_STALE_MIN, MAX_CONTENT_AGE_MIN, validateSnapshot, contentMeta } from './_china-futures-contract.js';

function xml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Also used by the original news digest. No loopback HTTP or official-host dependency.
export async function readChinaFuturesRss(now = Date.now()) {
  if (process.env.CHINA_FUTURES_NEWS_ENABLED !== '1') return null;
  const { status, value } = await readJsonFromUpstashWithStatus(CACHE_KEY, 3000, true);
  if (status !== 'hit' || !validateSnapshot(value, now)
    || now - value.fetchedAt > MAX_STALE_MIN * 60_000
    || now - contentMeta(value).newestItemAt > MAX_CONTENT_AGE_MIN * 60_000) return null;
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>${SOURCE_NAME}</title><link>${SOURCE_URL}</link><language>zh-CN</language>
<description>Official SHFE notices. Publication times have Asia/Shanghai calendar-day precision.</description>
${value.items.map((item) => `<item><title>${xml(item.title)}</title><link>${xml(item.sourceUrl)}</link><guid isPermaLink="false">${xml(item.documentId)}</guid><pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate><source url="${SOURCE_URL}">${SOURCE_NAME}</source></item>`).join('\n')}
</channel></rss>`;
}
