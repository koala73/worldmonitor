/**
 * Vercel Edge Middleware — blocks bot/crawler traffic from API routes.
 * Runs on /api/* paths only (configured via matcher below).
 * Social preview bots are allowed on /api/story and /api/og-story.
 */

const BOT_UA =
  /bot|crawl|spider|slurp|archiver|wget|curl\/|python-requests|scrapy|httpclient|go-http|java\/|libwww|perl|ruby|php\/|ahrefsbot|semrushbot|mj12bot|dotbot|baiduspider|yandexbot|sogou|bytespider|petalbot|gptbot|claudebot|ccbot/i;

const SOCIAL_PREVIEW_UA =
  /twitterbot|facebookexternalhit|linkedinbot|slackbot|telegrambot|whatsapp|discordbot|redditbot/i;

const SOCIAL_PREVIEW_PATHS = new Set(['/api/story', '/api/og-story']);

// Slack uses Slack-ImgProxy to fetch OG images — distinct from Slackbot
const SOCIAL_IMAGE_UA =
  /Slack-ImgProxy|Slackbot|twitterbot|facebookexternalhit|linkedinbot|telegrambot|whatsapp|discordbot|redditbot/i;

export default function middleware(request: Request) {
  const ua = request.headers.get('user-agent') ?? '';
  const url = new URL(request.url);
  const path = url.pathname;

  // Allow social preview/image bots on OG image assets (bypasses Vercel Attack Challenge)
  if (path.startsWith('/favico/') || path.endsWith('.png')) {
    if (SOCIAL_IMAGE_UA.test(ua)) {
      return;
    }
  }

  // Allow social preview bots on exact OG routes only
  if (SOCIAL_PREVIEW_UA.test(ua) && SOCIAL_PREVIEW_PATHS.has(path)) {
    return;
  }

  // Block bots from all API routes
  if (BOT_UA.test(ua)) {
    return new Response('{"error":"Forbidden"}', {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // No user-agent or suspiciously short — likely a script
  if (!ua || ua.length < 10) {
    return new Response('{"error":"Forbidden"}', {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const config = {
  matcher: ['/api/:path*', '/favico/:path*'],
};
