import { getCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const cors = getCorsHeaders(req);
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }
  const url = new URL(req.url);
  const pairs = url.searchParams.get('pairs') || 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';
  const dateStart = url.searchParams.get('dateStart');
  const dateEnd = url.searchParams.get('dateEnd');
  const method = url.searchParams.get('method') || 'gpr';

  let targetUrl = `https://www.pizzint.watch/api/gdelt/batch?pairs=${encodeURIComponent(pairs)}&method=${method}`;
  if (dateStart) targetUrl += `&dateStart=${dateStart}`;
  if (dateEnd) targetUrl += `&dateEnd=${dateEnd}`;

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'IntelHQ/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Upstream returned ${response.status}`);
    }

    const data = await response.text();
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch GDELT data', details: error.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}
