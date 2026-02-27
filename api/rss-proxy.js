// Non-sebuf: returns XML/HTML, stays as standalone Vercel function
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

// Fetch with timeout
async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// Allowed RSS feed domains — single source of truth: data/rss-allowed-domains.json
// KEEP IN SYNC with src-tauri/sidecar/local-api-server.mjs (reads the same JSON at build time)
import allowedDomains from '../data/rss-allowed-domains.json';
const ALLOWED_DOMAINS = allowedDomains;

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const requestUrl = new URL(req.url);
  const feedUrl = requestUrl.searchParams.get('url');

  if (!feedUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    const parsedUrl = new URL(feedUrl);

    // Security: Check if domain is allowed
    if (!ALLOWED_DOMAINS.includes(parsedUrl.hostname)) {
      return new Response(JSON.stringify({ error: 'Domain not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Google News is slow - use longer timeout
    const isGoogleNews = feedUrl.includes('news.google.com');
    const timeout = isGoogleNews ? 20000 : 12000;

    const response = await fetchWithTimeout(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'manual',
    }, timeout);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        try {
          const redirectUrl = new URL(location, feedUrl);
          if (!ALLOWED_DOMAINS.includes(redirectUrl.hostname)) {
            return new Response(JSON.stringify({ error: 'Redirect to disallowed domain' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          const redirectResponse = await fetchWithTimeout(redirectUrl.href, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/rss+xml, application/xml, text/xml, */*',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          }, timeout);
          const data = await redirectResponse.text();
          return new Response(data, {
            status: redirectResponse.status,
            headers: {
              'Content-Type': 'application/xml',
              'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=300',
              ...corsHeaders,
            },
          });
        } catch {
          return new Response(JSON.stringify({ error: 'Invalid redirect' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }
    }

    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': 'application/xml',
        'Cache-Control': 'public, max-age=600, s-maxage=600, stale-while-revalidate=300',
        ...corsHeaders,
      },
    });
  } catch (error) {
    const isTimeout = error.name === 'AbortError';
    console.error('RSS proxy error:', feedUrl, error.message);
    return new Response(JSON.stringify({
      error: isTimeout ? 'Feed timeout' : 'Failed to fetch feed',
      details: error.message,
      url: feedUrl
    }), {
      status: isTimeout ? 504 : 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
