export const config = { runtime: 'edge' };

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

// Fetch trending GitHub repositories
// Uses unofficial GitHub trending scraper API
export default async function handler(request) {
  const cors = getCorsHeaders(request);
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors });
  }
  try {
    const { searchParams } = new URL(request.url);
    const language = searchParams.get('language') || 'python'; // python, javascript, typescript, etc.
    const since = searchParams.get('since') || 'daily'; // daily, weekly, monthly
    const spoken_language = searchParams.get('spoken_language') || ''; // en, zh, etc.

    // Using GitHub trending API (unofficial)
    // Alternative: https://gh-trending-api.herokuapp.com/repositories
    const baseUrl = 'https://api.gitterapp.com/repositories';
    const queryParams = new URLSearchParams({
      language: language,
      since: since,
    });

    if (spoken_language) {
      queryParams.append('spoken_language_code', spoken_language);
    }

    const apiUrl = `${baseUrl}?${queryParams.toString()}`;

    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'IntelHQ/1.0 (Tech Tracker)',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      // Fallback: try alternative API
      const fallbackUrl = `https://gh-trending-api.herokuapp.com/repositories/${language}?since=${since}`;
      const fallbackResponse = await fetch(fallbackUrl, {
        headers: {
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!fallbackResponse.ok) {
        throw new Error(`GitHub trending API returned ${fallbackResponse.status}`);
      }

      const data = await fallbackResponse.json();
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...cors,
          'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=300', // 30 min cache
        },
      });
    }

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
        'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=300', // 30 min cache
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch GitHub trending data',
        message: error.message
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...cors,
        },
      }
    );
  }
}
