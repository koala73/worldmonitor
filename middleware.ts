const BOT_UA =
  /bot|crawl|spider|slurp|archiver|wget|curl\/|python-requests|scrapy|httpclient|go-http|java\/|libwww|perl|ruby|php\/|ahrefsbot|semrushbot|mj12bot|dotbot|baiduspider|yandexbot|sogou|bytespider|petalbot|gptbot|claudebot|ccbot/i;

const SOCIAL_PREVIEW_UA =
  /twitterbot|facebookexternalhit|linkedinbot|slackbot|telegrambot|whatsapp|discordbot|redditbot/i;

// AI crawlers / AEO scanners: serve a variant-aware static stub on subdomain
// roots so each variant (tech / finance / commodity / happy / energy) is
// indexed under its own identity rather than inheriting the 'full' SPA HTML.
const AI_CRAWLER_UA =
  /gptbot|claudebot|ccbot|google-extended|perplexitybot|anthropic-ai|bytespider|cohere-ai|youbot|applebot-extended|amazonbot/i;

const SOCIAL_PREVIEW_PATHS = new Set(['/api/story', '/api/og-story']);
const LEGACY_DASHBOARD_ROOT_QUERY_KEYS = ['lat', 'lon', 'zoom', 'view', 'timeRange', 'layers'] as const;

// Paths that bypass bot/script UA filtering below. Each must carry its own
// auth (API key, shared secret, or intentionally-public semantics) because
// this list disables the middleware's generic bot gate.
// - /api/version, /api/health: intentionally public, monitoring-friendly.
// - /api/seed-contract-probe: requires RELAY_SHARED_SECRET header; called by
//   UptimeRobot + ops curl. Was blocked by the curl/bot UA regex before this
//   exception landed (Vercel log 2026-04-15: "Middleware 403 Forbidden" on
//   /api/seed-contract-probe).
// - /api/internal/brief-why-matters: requires RELAY_SHARED_SECRET Bearer
//   (subtle-crypto HMAC timing-safe compare in server/_shared/internal-auth.ts).
//   Called from the Railway digest-notifications cron whose fetch() uses the
//   Node undici default UA, which is short enough to trip the "no UA or
//   suspiciously short" 403 below (Railway log 2026-04-21 post-#3248 merge:
//   every cron call returned 403 and silently fell back to legacy Gemini).
const PUBLIC_API_PATHS = new Set([
  '/api/version',
  '/api/health',
  '/api/seed-contract-probe',
  '/api/internal/brief-why-matters',
]);

const SOCIAL_IMAGE_UA =
  /Slack-ImgProxy|Slackbot|twitterbot|facebookexternalhit|linkedinbot|telegrambot|whatsapp|discordbot|redditbot/i;

// Must match the exact route shape enforced by
// api/brief/carousel/[userId]/[issueDate]/[page].ts:
//   /api/brief/carousel/<userId>/YYYY-MM-DD-HHMM/<0|1|2>
// The issueDate segment is a per-run slot (date + HHMM in the user's
// tz) so same-day digests produce distinct carousel URLs.
// pageFromIndex() in brief-carousel-render.ts accepts only 0/1/2, so
// the trailing segment is tightly bounded.
const BRIEF_CAROUSEL_PATH_RE =
  /^\/api\/brief\/carousel\/[^/]+\/\d{4}-\d{2}-\d{2}-\d{4}\/[0-2]\/?$/;

const VARIANT_HOST_MAP: Record<string, string> = {
  'tech.worldmonitor.app': 'tech',
  'finance.worldmonitor.app': 'finance',
  'commodity.worldmonitor.app': 'commodity',
  'happy.worldmonitor.app': 'happy',
  'energy.worldmonitor.app': 'energy',
};

// Source of truth: src/config/variant-meta.ts — keep in sync when variant metadata changes.
// `name` is the short brand for JSON-LD `WebApplication.name`; `title` is the full
// page <title>. They are split fields (not derived via title.split(' - ')) so a
// future title format change cannot silently corrupt the JSON-LD name.
const VARIANT_OG: Record<string, { name: string; title: string; description: string; image: string; url: string }> = {
  tech: {
    name: 'Tech Monitor',
    title: 'Tech Monitor - Real-Time AI & Tech Industry Dashboard',
    description: 'Real-time AI and tech industry dashboard tracking tech giants, AI labs, startup ecosystems, funding rounds, and tech events worldwide.',
    image: 'https://tech.worldmonitor.app/favico/tech/og-image.png',
    url: 'https://tech.worldmonitor.app/dashboard',
  },
  finance: {
    name: 'Finance Monitor',
    title: 'Finance Monitor - Real-Time Markets & Trading Dashboard',
    description: 'Real-time finance and trading dashboard tracking global markets, stock exchanges, central banks, commodities, forex, crypto, and economic indicators worldwide.',
    image: 'https://finance.worldmonitor.app/favico/finance/og-image.png',
    url: 'https://finance.worldmonitor.app/dashboard',
  },
  commodity: {
    name: 'Commodity Monitor',
    title: 'Commodity Monitor - Real-Time Commodity Markets & Supply Chain Dashboard',
    description: 'Real-time commodity markets dashboard tracking mining sites, processing plants, commodity ports, supply chains, and global commodity trade flows.',
    image: 'https://commodity.worldmonitor.app/favico/commodity/og-image.png',
    url: 'https://commodity.worldmonitor.app/dashboard',
  },
  happy: {
    name: 'Happy Monitor',
    title: 'Happy Monitor - Good News & Global Progress',
    description: 'Curated positive news, progress data, and uplifting stories from around the world.',
    image: 'https://happy.worldmonitor.app/favico/happy/og-image.png',
    url: 'https://happy.worldmonitor.app/dashboard',
  },
  energy: {
    name: 'Energy Atlas',
    title: 'Energy Atlas - Real-Time Global Energy Intelligence Dashboard',
    description: 'Real-time global energy atlas tracking oil and gas pipelines, storage facilities, chokepoints, fuel shortages, tanker flows, and disruption events worldwide.',
    image: 'https://energy.worldmonitor.app/favico/energy/og-image.png',
    url: 'https://energy.worldmonitor.app/dashboard',
  },
};

const ALLOWED_HOSTS = new Set([
  'worldmonitor.app',
  ...Object.keys(VARIANT_HOST_MAP),
]);
const VERCEL_PREVIEW_RE = /^[a-z0-9-]+-[a-z0-9]{8,}\.vercel\.app$/;

function normalizeHost(raw: string): string {
  return raw.toLowerCase().replace(/:\d+$/, '');
}

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.has(host) || VERCEL_PREVIEW_RE.test(host);
}

function hasLegacyDashboardRootState(searchParams: URLSearchParams): boolean {
  return LEGACY_DASHBOARD_ROOT_QUERY_KEYS.some((key) => searchParams.has(key));
}

// HTML-escape a string for safe interpolation into BOTH text content and
// double-quoted attribute values. Required because VARIANT_OG values are
// hand-edited prose and a future double-quote, ampersand, or angle bracket
// would otherwise close the attribute early or corrupt the document.
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const ua = request.headers.get('user-agent') ?? '';
  const path = url.pathname;
  const host = normalizeHost(request.headers.get('host') ?? url.hostname);

  if (path === '/' && hasLegacyDashboardRootState(url.searchParams)) {
    const dashboardUrl = new URL(request.url);
    dashboardUrl.pathname = '/dashboard';
    return Response.redirect(dashboardUrl.toString(), 308);
  }

  // Variant-aware crawlable stub for social preview bots AND AI crawlers
  // (GPTBot, ClaudeBot, PerplexityBot, etc.) when hitting variant subdomain
  // roots. Social bots get OG-only; AI crawlers additionally get JSON-LD
  // WebApplication + a body with internal links and external citations so
  // each variant is indexed under its own identity.
  if (path === '/') {
    const isSocial = SOCIAL_PREVIEW_UA.test(ua);
    const isAI = AI_CRAWLER_UA.test(ua);
    if (isSocial || isAI) {
      const variant = VARIANT_HOST_MAP[host];
      if (variant && isAllowedHost(host)) {
        const og = VARIANT_OG[variant as keyof typeof VARIANT_OG];
        if (og) {
          // Pre-escape every VARIANT_OG field used in the template. JSON-LD is
          // safe via JSON.stringify, but the OG/Twitter/canonical attributes
          // and the visible <h1>/<p> body need explicit HTML escaping.
          const eTitle = escHtml(og.title);
          const eDesc = escHtml(og.description);
          const eImage = escHtml(og.image);
          const eUrl = escHtml(og.url);
          const jsonLd = isAI ? `\n<script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: og.name,
            url: og.url,
            description: og.description,
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web, Windows, macOS, Linux',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            screenshot: og.image,
            isPartOf: {
              '@type': 'WebSite',
              name: 'World Monitor',
              url: 'https://www.worldmonitor.app/',
            },
            sameAs: [
              'https://github.com/koala73/worldmonitor',
              'https://x.com/worldmonitorai',
            ],
          })}</script>` : '';
          const aiBody = isAI ? `
<h1>${eTitle}</h1>
<p>${eDesc}</p>
<h2>Explore the platform</h2>
<ul>
<li><a href="https://www.worldmonitor.app/dashboard">World Monitor — geopolitics &amp; intelligence</a></li>
<li><a href="https://tech.worldmonitor.app/dashboard">Tech Monitor</a></li>
<li><a href="https://finance.worldmonitor.app/dashboard">Finance Monitor</a></li>
<li><a href="https://commodity.worldmonitor.app/dashboard">Commodity Monitor</a></li>
<li><a href="https://happy.worldmonitor.app/dashboard">Happy Monitor</a></li>
<li><a href="https://www.worldmonitor.app/pro">World Monitor Pro</a></li>
<li><a href="https://www.worldmonitor.app/blog/">Blog</a></li>
<li><a href="https://github.com/koala73/worldmonitor">Open source on GitHub</a></li>
</ul>
<h2>Sources</h2>
<p>Data ingested live from <a href="https://acleddata.com/">ACLED</a>, <a href="https://ucdp.uu.se/">UCDP</a>, <a href="https://firms.modaps.eosdis.nasa.gov/">NASA FIRMS</a>, <a href="https://earthquake.usgs.gov/">USGS</a>, <a href="https://opensky-network.org/">OpenSky</a>, <a href="https://aisstream.io/">AISStream</a>, <a href="https://fred.stlouisfed.org/">FRED</a>, <a href="https://www.imf.org/en/Data">IMF</a>, and <a href="https://www.bis.org/">BIS</a>.</p>` : '';
          const html = `<!DOCTYPE html><html lang="en"><head>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${eTitle}"/>
<meta property="og:description" content="${eDesc}"/>
<meta property="og:image" content="${eImage}"/>
<meta property="og:url" content="${eUrl}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${eTitle}"/>
<meta name="twitter:description" content="${eDesc}"/>
<meta name="twitter:image" content="${eImage}"/>
<link rel="canonical" href="${eUrl}"/>
<title>${eTitle}</title>${jsonLd}
</head><body>${aiBody}</body></html>`;
          return new Response(html, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Vary': 'User-Agent, Host',
            },
          });
        }
      }
    }
  }

  // Only apply bot filtering to /api/* and /favico/* paths
  if (!path.startsWith('/api/') && !path.startsWith('/favico/')) {
    return;
  }

  // Allow social preview/image bots on OG image assets.
  //
  // Image-returning API routes that don't end in `.png` also need
  // an explicit carve-out — otherwise server-side fetches from
  // Slack / Telegram / Discord / LinkedIn / WhatsApp / Facebook /
  // Twitter / Reddit all trip the BOT_UA gate below. Telegram
  // surfaces it as error 400 "WEBPAGE_CURL_FAILED" on sendMediaGroup;
  // the others silently drop the preview image.
  //
  // Only the brief carousel route shape is allowlisted — a strict
  // regex (same shape enforced by the handler) prevents a future
  // /api/brief/carousel/admin or similar sibling from accidentally
  // inheriting this bypass. HMAC token in the URL is the real auth;
  // this allowlist is defence-in-depth for any well-shaped request
  // whose UA happens to be in SOCIAL_IMAGE_UA.
  if (
    path.startsWith('/favico/') ||
    path.endsWith('.png') ||
    BRIEF_CAROUSEL_PATH_RE.test(path)
  ) {
    if (SOCIAL_IMAGE_UA.test(ua)) {
      return;
    }
  }

  // Allow social preview bots on exact OG routes only
  if (SOCIAL_PREVIEW_UA.test(ua) && SOCIAL_PREVIEW_PATHS.has(path)) {
    return;
  }

  // Public endpoints bypass all bot filtering
  if (PUBLIC_API_PATHS.has(path)) {
    return;
  }

  // Authenticated Pro API clients bypass UA filtering. This is a cheap
  // edge heuristic, not auth — real validation (SHA-256 hash vs Convex
  // userApiKeys + entitlement) happens in server/gateway.ts. To keep the
  // bot-UA shield meaningful, require the exact key shape emitted by
  // src/services/api-keys.ts:generateKey: `wm_` + 40 lowercase hex chars.
  // A random scraper would have to guess a specific 43-char format, and
  // spoofed-but-well-shaped keys still 401 at the gateway.
  const WM_KEY_SHAPE = /^wm_[a-f0-9]{40}$/;
  const apiKey =
    request.headers.get('x-worldmonitor-key') ??
    request.headers.get('x-api-key') ??
    '';
  if (WM_KEY_SHAPE.test(apiKey)) {
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
  matcher: ['/', '/api/:path*', '/favico/:path*'],
};
