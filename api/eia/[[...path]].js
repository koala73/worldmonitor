// EIA (Energy Information Administration) API proxy
// Keeps API key server-side
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace('/api/eia', '');

  const apiKey = process.env.EIA_API_KEY;

  if (!apiKey) {
    return Response.json({
      error: 'EIA API not configured',
      configured: false,
      message: 'Get a free API key at https://www.eia.gov/opendata/',
    }, {
      status: 503,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  // Health check
  if (path === '/health' || path === '') {
    return Response.json({ configured: true }, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Petroleum data endpoint
  if (path === '/petroleum') {
    try {
      const series = {
        wti: 'PET.RWTC.W',
        brent: 'PET.RBRTE.W',
        production: 'PET.WCRFPUS2.W',
        inventory: 'PET.WCESTUS1.W',
      };

      const results = {};

      // Fetch all series in parallel
      const fetchPromises = Object.entries(series).map(async ([key, seriesId]) => {
        try {
          const response = await fetch(
            `https://api.eia.gov/v2/seriesid/${seriesId}?api_key=${apiKey}&num=2`,
            { headers: { 'Accept': 'application/json' } }
          );

          if (!response.ok) return null;

          const data = await response.json();
          const values = data?.response?.data || [];

          if (values.length >= 1) {
            return {
              key,
              data: {
                current: values[0]?.value,
                previous: values[1]?.value || values[0]?.value,
                date: values[0]?.period,
                unit: values[0]?.unit,
              }
            };
          }
        } catch (e) {
          console.error(`[EIA] Failed to fetch ${key}:`, e.message);
        }
        return null;
      });

      const fetchResults = await Promise.all(fetchPromises);

      for (const result of fetchResults) {
        if (result) {
          results[result.key] = result.data;
        }
      }

      return Response.json(results, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=1800', // 30 min cache
        },
      });
    } catch (error) {
      return Response.json({
        error: `EIA fetch failed: ${error.message}`,
      }, {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  return Response.json({ error: 'Not found' }, {
    status: 404,
    headers: { 'Access-Control-Allow-Origin': '*' },
  });
}
