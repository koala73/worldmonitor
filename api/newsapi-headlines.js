import { getCorsHeaders } from './_cors.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'NEWSAPI_KEY not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const reqUrl = new URL(req.url);
  const q = reqUrl.searchParams.get('q') ?? 'geopolitics world news';
  const rawPageSize = parseInt(reqUrl.searchParams.get('pageSize') ?? '10', 10);
  const pageSize = Math.min(20, isNaN(rawPageSize) ? 10 : rawPageSize);

  try {
    const params = new URLSearchParams({ q, pageSize: String(pageSize), language: 'en', sortBy: 'publishedAt', apiKey });
    const resp = await fetch(`https://newsapi.org/v2/everything?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0' },
    });
    if (!resp.ok) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120', ...corsHeaders },
      });
    }
    const data = await resp.json();
    const articles = Array.isArray(data?.articles) ? data.articles : [];
    const items = articles.map((a, i) => ({
      id: `newsapi-${i}`,
      source: a.source?.name ?? 'NewsAPI',
      title: a.title ?? '',
      link: a.url ?? '',
      pubDate: a.publishedAt ?? new Date().toISOString(),
      description: a.description ?? '',
      imageUrl: a.urlToImage ?? undefined,
    }));
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120, s-maxage=300', ...corsHeaders },
    });
  } catch (error) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
