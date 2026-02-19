import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
export const config = { runtime: 'edge' };

export default async function handler(request) {
  const cors = getCorsHeaders(request);
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }
  try {
    const response = await fetch('https://www.pizzint.watch/api/dashboard-data', {
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
        'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=30',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch PizzINT data', details: error.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}
