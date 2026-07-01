import { defineConfig, loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import type { OutputBundle } from 'rollup';
import { resolve, dirname, extname } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { brotliCompress } from 'zlib';
import { promisify } from 'util';
import pkg from './package.json';
import { VARIANT_META, type VariantMeta } from './src/config/variant-meta';

// Env-dependent constants moved inside defineConfig function


const brotliCompressAsync = promisify(brotliCompress);
const BROTLI_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.xml', '.wasm']);
const STATIC_SCRIPT_NONCE = 'wm-static-bootstrap';

// @clerk/clerk-js is loaded as a UMD bundle from the Clerk Frontend API at
// runtime (src/services/clerk.ts), not bundled. Resolve the version from
// package.json so the runtime SDK matches the @clerk/clerk-js types we compile
// against, and inject it via `define` (__CLERK_JS_VERSION__). Fall back to
// devDependencies in case the (types-only) dep is moved there, and fail the
// build loudly if it can't be resolved — an empty version yields a `.../@/dist`
// URL that 404s and silently breaks auth in production.
const CLERK_DEPS = pkg.dependencies as Record<string, string>;
const CLERK_DEV_DEPS = (pkg.devDependencies ?? {}) as Record<string, string>;
const CLERK_JS_VERSION = (CLERK_DEPS['@clerk/clerk-js'] || CLERK_DEV_DEPS['@clerk/clerk-js'] || '')
  .replace(/^[\^~>=<\s]*/, '');
if (!CLERK_JS_VERSION) {
  throw new Error('[vite] @clerk/clerk-js not found in package.json — __CLERK_JS_VERSION__ would be empty and 404 the Clerk Frontend API script URL.');
}
// @clerk/ui (the runtime UI controller, pinned by CLERK_UI_VERSION in
// src/services/clerk.ts) is major 1, which pairs with @clerk/clerk-js major 6.
// Fail the build if the SDK major drifts so the pairing is updated deliberately
// rather than loading an incompatible UI controller and breaking auth at runtime.
if (CLERK_JS_VERSION.split('.')[0] !== '6') {
  throw new Error(`[vite] @clerk/clerk-js major is ${CLERK_JS_VERSION.split('.')[0]}, expected 6 — update CLERK_UI_VERSION in src/services/clerk.ts to the paired @clerk/ui major, then bump this guard.`);
}

const PANEL_CHUNK_NAMES = [
  'panels-markets',
  'panels-energy',
  'panels-defense',
  'panels-news',
  'panels-economy',
  'panels-intel',
  'panels-risk',
] as const;
type PanelChunkName = typeof PANEL_CHUNK_NAMES[number];
const PANEL_SUPPORT_CHUNK_NAMES = ['panel-support'] as const;
type PanelSupportChunkName = typeof PANEL_SUPPORT_CHUNK_NAMES[number];
type PanelManualChunkName = PanelChunkName | PanelSupportChunkName;

// Single source of truth for chunk names that must NOT be hoisted into the
// entry HTML's modulepreload list. Used by both `manualChunks` (return values
// must literally match these strings) and `modulePreload.resolveDependencies`
// (filter regex is built from this list). Keeping them tied prevents the
// silent-breakage failure mode where renaming a chunk in `manualChunks`
// re-eagerises the WebGL stack without any build-time error.
//   - maplibre, deck-stack, protomaps: heavy WebGL deps, only reachable via MapContainer
//   - MapContainer: the dynamic-import target itself
//   - panels-*: panel domain chunks; keep them out of the entry HTML preload
//   - UnifiedSettings, settings-window, checkout: secondary interaction flows;
//     first paint only needs their header buttons and cheap event wiring
const LAZY_HTML_PRELOAD_CHUNKS = [
  'maplibre',
  'deck-stack',
  'protomaps',
  'h3-js',
  'MapContainer',
  'UnifiedSettings',
  'settings-window',
  'checkout',
  ...PANEL_CHUNK_NAMES,
  ...PANEL_SUPPORT_CHUNK_NAMES,
] as const;
const LAZY_HTML_PRELOAD_RE = new RegExp(
  `/(?:${LAZY_HTML_PRELOAD_CHUNKS.join('|')}|rpc-client-[A-Za-z0-9_-]+)-[A-Za-z0-9_-]+\\.js$`,
);

// Panel-cluster manualChunks map. Splits the previously monolithic ~2.3MB
// `panels` chunk into per-domain chunks so cache invalidation is local to
// the cluster a panel lives in and per-variant builds can prune unused
// clusters. New panel files must be assigned here before the build can split
// them; otherwise they would silently fall back into an eager catch-all chunk.
const PANEL_CLUSTER: Record<string, PanelChunkName> = {
  // Markets / equities / crypto positioning
  AAIISentiment: 'panels-markets', CotPositioning: 'panels-markets',
  ETFFlows: 'panels-markets', EarningsCalendar: 'panels-markets',
  EconomicCalendar: 'panels-markets', FearGreed: 'panels-markets',
  GoldIntelligence: 'panels-markets', LiquidityShifts: 'panels-markets',
  MacroSignals: 'panels-markets', Market: 'panels-markets',
  MarketBreadth: 'panels-markets', MarketImplications: 'panels-markets',
  Positioning: 'panels-markets', Stablecoin: 'panels-markets',
  StockAnalysis: 'panels-markets', StockBacktest: 'panels-markets',
  WsbTickerScanner: 'panels-markets', YieldCurve: 'panels-markets',
  // Energy / commodities / supply infra
  ChokepointStrip: 'panels-energy', EnergyComplex: 'panels-energy',
  EnergyCrisis: 'panels-energy', EnergyDisruptions: 'panels-energy',
  EnergyRiskOverview: 'panels-energy', FuelPrices: 'panels-energy',
  FuelShortage: 'panels-energy', Hormuz: 'panels-energy',
  OilInventories: 'panels-energy', PipelineStatus: 'panels-energy',
  StorageFacilityMap: 'panels-energy', RenewableEnergy: 'panels-energy',
  // Defense / military / aviation
  AirlineIntel: 'panels-defense', DefensePatents: 'panels-defense',
  OrefSirens: 'panels-defense', StrategicPosture: 'panels-defense',
  StrategicRisk: 'panels-defense', ThermalEscalation: 'panels-defense',
  UcdpEvents: 'panels-defense',
  // News / feeds / briefs
  BreakthroughsTicker: 'panels-news', ClimateNews: 'panels-news',
  DailyMarketBrief: 'panels-news', GdeltIntel: 'panels-news',
  GoodThingsDigest: 'panels-news', LatestBrief: 'panels-news',
  LiveNews: 'panels-news', News: 'panels-news',
  PositiveNewsFeed: 'panels-news', TelegramIntel: 'panels-news',
  // Macro / prices / trade
  BigMac: 'panels-economy', ConsumerPrices: 'panels-economy',
  Economic: 'panels-economy',
  FaoFoodPriceIndex: 'panels-economy', FSI: 'panels-economy',
  GroceryBasket: 'panels-economy', GulfEconomies: 'panels-economy',
  Investments: 'panels-economy', MacroTiles: 'panels-economy',
  NationalDebt: 'panels-economy', SanctionsPressure: 'panels-economy',
  SupplyChain: 'panels-economy', TradePolicy: 'panels-economy',
  // Country briefs / signals / monitors / agent surfaces.
  // CorrelationPanel base lives here, so all *Correlation consumers MUST stay
  // in this cluster — splitting them across clusters caused TDZ on init.
  ChatAnalyst: 'panels-intel', CII: 'panels-intel',
  Cascade: 'panels-intel', Correlation: 'panels-intel',
  CountryBrief: 'panels-intel', CountryBriefPage: 'panels-intel',
  CountryDeepDive: 'panels-intel',
  CrossSourceSignals: 'panels-intel', CustomWidget: 'panels-intel',
  Deduction: 'panels-intel',
  DisasterCorrelation: 'panels-intel',
  EconomicCorrelation: 'panels-intel',
  EscalationCorrelation: 'panels-intel',
  MilitaryCorrelation: 'panels-intel',
  Forecast: 'panels-intel',
  HeroSpotlight: 'panels-intel', Insights: 'panels-intel',
  LiveWebcams: 'panels-intel', McpData: 'panels-intel',
  Monitor: 'panels-intel', PinnedWebcams: 'panels-intel',
  Prediction: 'panels-intel', ProgressCharts: 'panels-intel',
  RegionalIntelligenceBoard: 'panels-intel',
  Regulation: 'panels-intel',
  // Disasters / climate / connectivity / society
  ClimateAnomaly: 'panels-risk', Counters: 'panels-risk',
  DiseaseOutbreaks: 'panels-risk',
  Displacement: 'panels-risk', GeoHubs: 'panels-risk',
  Giving: 'panels-risk', InternetDisruptions: 'panels-risk',
  PopulationExposure: 'panels-risk', RadiationWatch: 'panels-risk',
  RuntimeConfig: 'panels-risk', SatelliteFires: 'panels-risk',
  SecurityAdvisories: 'panels-risk', ServiceStatus: 'panels-risk',
  SocialVelocity: 'panels-risk', SpeciesComeback: 'panels-risk',
  TechEvents: 'panels-risk',
  ThreatTimeline: 'panels-risk',
  TechHubs: 'panels-risk', TechReadiness: 'panels-risk',
  WorldClock: 'panels-risk',
};

const PANEL_SUPPORT_CLUSTER: Record<string, PanelSupportChunkName> = {
  Status: 'panel-support',
};

function panelKeyForComponentId(id: string): string | null {
  if (!id.includes('/src/components/') || !id.endsWith('.ts')) return null;
  const match = id.match(/\/([^/]+)\.ts$/);
  if (!match) return null;
  const fileBase = match[1];
  if (fileBase === 'Panel') return null;
  if (fileBase === 'CountryBriefPage' || fileBase === 'RegionalIntelligenceBoard') return fileBase;
  if (fileBase.endsWith('Panel')) return fileBase.slice(0, -'Panel'.length);
  return null;
}

function panelChunkForComponentId(id: string): PanelManualChunkName | null {
  const panelKey = panelKeyForComponentId(id);
  if (!panelKey) return null;
  const chunkName = PANEL_SUPPORT_CLUSTER[panelKey] ?? PANEL_CLUSTER[panelKey];
  if (chunkName) return chunkName;
  throw new Error(`[manualChunks] Unassigned panel component ${panelKey}. Add it to PANEL_CLUSTER or PANEL_SUPPORT_CLUSTER in vite.config.ts.`);
}

function brotliPrecompressPlugin(): Plugin {
  return {
    name: 'brotli-precompress',
    apply: 'build',
    async writeBundle(outputOptions, bundle) {
      const outDir = outputOptions.dir;
      if (!outDir) return;

      await Promise.all(Object.keys(bundle).map(async (fileName) => {
        const extension = extname(fileName).toLowerCase();
        if (!BROTLI_EXTENSIONS.has(extension)) return;

        const sourcePath = resolve(outDir, fileName);
        const compressedPath = `${sourcePath}.br`;
        const sourceBuffer = await readFile(sourcePath);
        if (sourceBuffer.length < 1024) return;

        const compressedBuffer = await brotliCompressAsync(sourceBuffer);
        await mkdir(dirname(compressedPath), { recursive: true });
        await writeFile(compressedPath, compressedBuffer);
      }));
    },
  };
}

function htmlVariantPlugin(activeMeta: VariantMeta, activeVariant: string, isDesktopBuild: boolean): Plugin {
  return {
    name: 'html-variant',
    transformIndexHtml(html) {
      let result = html
        .replace(/<title>.*?<\/title>/, `<title>${activeMeta.title}</title>`)
        .replace(/<meta name="title" content=".*?" \/>/, `<meta name="title" content="${activeMeta.title}" />`)
        .replace(/<meta name="description" content=".*?" \/>/, `<meta name="description" content="${activeMeta.description}" />`)
        .replace(/<meta name="keywords" content=".*?" \/>/, `<meta name="keywords" content="${activeMeta.keywords}" />`)
        .replace(/<link rel="canonical" href=".*?" \/>/, `<link rel="canonical" href="${activeMeta.url}" />`)
        .replace(/<meta name="application-name" content=".*?" \/>/, `<meta name="application-name" content="${activeMeta.siteName}" />`)
        .replace(/<meta property="og:url" content=".*?" \/>/, `<meta property="og:url" content="${activeMeta.url}" />`)
        .replace(/<meta property="og:title" content=".*?" \/>/, `<meta property="og:title" content="${activeMeta.title}" />`)
        .replace(/<meta property="og:description" content=".*?" \/>/, `<meta property="og:description" content="${activeMeta.description}" />`)
        .replace(/<meta property="og:site_name" content=".*?" \/>/, `<meta property="og:site_name" content="${activeMeta.siteName}" />`)
        .replace(/<meta name="subject" content=".*?" \/>/, `<meta name="subject" content="${activeMeta.subject}" />`)
        .replace(/<meta name="classification" content=".*?" \/>/, `<meta name="classification" content="${activeMeta.classification}" />`)
        .replace(/<meta name="twitter:url" content=".*?" \/>/, `<meta name="twitter:url" content="${activeMeta.url}" />`)
        .replace(/<meta name="twitter:title" content=".*?" \/>/, `<meta name="twitter:title" content="${activeMeta.title}" />`)
        .replace(/<meta name="twitter:description" content=".*?" \/>/, `<meta name="twitter:description" content="${activeMeta.description}" />`)
        .replace(/"name": "World Monitor"/, `"name": "${activeMeta.siteName}"`)
        .replace(/"alternateName": "WorldMonitor"/, `"alternateName": "${activeMeta.siteName.replace(' ', '')}"`)
        .replace(/"url": "https:\/\/worldmonitor\.app\/"/, `"url": "${activeMeta.url}"`)
        .replace(/"description": "Real-time global intelligence dashboard with live news, markets, military tracking, infrastructure monitoring, and geopolitical data."/, `"description": "${activeMeta.description}"`)
        .replace(/"featureList": \[[\s\S]*?\]/, `"featureList": ${JSON.stringify(activeMeta.features, null, 8).replace(/\n/g, '\n      ')}`);

      // Theme-color meta — warm cream for happy variant
      if (activeVariant === 'happy') {
        result = result.replace(
          /<meta name="theme-color" content=".*?" \/>/,
          '<meta name="theme-color" content="#FAFAF5" />'
        );
      }

      // Desktop builds: inject build-time variant into the inline script so data-variant is set
      // before CSS loads. Web builds always use 'full' — runtime hostname detection handles variants.
      if (activeVariant !== 'full') {
        result = result.replace(
          /if\(v\)document\.documentElement\.dataset\.variant=v;/,
          `v='${activeVariant}';document.documentElement.dataset.variant=v;`
        );
      }

      // Desktop CSP: inject localhost wildcard for dynamic sidecar port.
      // Web builds intentionally exclude localhost to avoid exposing attack surface.
      if (isDesktopBuild) {
        result = result
          .replace(
            /connect-src 'self' https: http:\/\/localhost:5173/,
            "connect-src 'self' https: http://localhost:5173 http://127.0.0.1:*"
          )
          .replace(
            /frame-src 'self'/,
            "frame-src 'self' http://127.0.0.1:*"
          );
      }

      // Desktop builds: replace favicon paths with variant-specific subdirectory.
      // Web builds use 'full' favicons in HTML; runtime JS swaps them per hostname.
      if (activeVariant !== 'full') {
        result = result
          .replace(/\/favico\/favicon/g, `/favico/${activeVariant}/favicon`)
          .replace(/\/favico\/apple-touch-icon/g, `/favico/${activeVariant}/apple-touch-icon`)
          .replace(/\/favico\/android-chrome/g, `/favico/${activeVariant}/android-chrome`)
          .replace(/\/favico\/og-image/g, `/favico/${activeVariant}/og-image`);
      }

      return result;
    },
  };
}

function dashboardHtmlOutputPlugin(): Plugin {
  return {
    name: 'wm-dashboard-html-output',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const dashboardEntry = Object.entries(bundle).find(([, output]) =>
        output.type === 'asset' && output.fileName === 'index.html'
      );
      if (!dashboardEntry) {
        throw new Error('[vite] expected dashboard HTML entry index.html before renaming it to dashboard.html');
      }

      const [bundleKey, dashboardHtml] = dashboardEntry;
      delete bundle[bundleKey];
      dashboardHtml.fileName = 'dashboard.html';
      if (typeof dashboardHtml.source === 'string') {
        dashboardHtml.source = deferDashboardStylesheetLinks(dashboardHtml.source, bundle);
      }
      bundle['dashboard.html'] = dashboardHtml;
    },
  };
}

function shouldDeferDashboardStylesheet(tag: string, bundle: OutputBundle): boolean {
  const href = tag.match(/\bhref=["']([^"']+\.css)["']/i)?.[1];
  if (!href) return false;

  const bundleKey = href.replace(/^\//, '');
  const asset = bundle[bundleKey];
  if (!asset || asset.type !== 'asset') return false;

  const sourceLength = typeof asset.source === 'string'
    ? Buffer.byteLength(asset.source)
    : asset.source.byteLength;
  return sourceLength >= 100 * 1024;
}

// Rewrite large render-blocking dashboard <link rel=stylesheet> tags into a
// deferred form (media="print" + data-wm-deferred-style="dashboard") plus a
// <noscript> copy of the original blocking link, so the ~492KB app CSS no
// longer blocks first paint. src/main.ts activateDeferredDashboardStyles()
// flips media -> "all" at startup; the attribute name + values written here MUST
// stay in lockstep with that runtime selector. Only assets >=100KB are deferred
// (shouldDeferDashboardStylesheet) so small stylesheets stay blocking; links
// that already set media= (an intentionally print/screen-scoped sheet) or are
// already deferred are skipped. NOTE: during the defer window only the UNLAYERED
// inline critical CSS in index.html applies (the bundle is @layer base), so any
// future *unconditional* inline rule will beat the bundle (see PR #4346) — keep
// inline rules scoped to a transient/closed state.
function deferDashboardStylesheetLinks(html: string, bundle: OutputBundle): string {
  return html.replace(/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["'][^"']+\.css["'])[^>]*>/gi, (tag) => {
    if (/\bdata-wm-deferred-style=/.test(tag) || /\bmedia=/.test(tag)) return tag;
    if (!shouldDeferDashboardStylesheet(tag, bundle)) return tag;
    const deferredTag = tag.replace(/\s*\/?>$/, ' media="print" data-wm-deferred-style="dashboard">');
    return `${deferredTag}\n    <noscript>${tag}</noscript>`;
  });
}

function polymarketPlugin(): Plugin {
  const GAMMA_BASE = 'https://gamma-api.polymarket.com';
  const ALLOWED_ORDER = ['volume', 'liquidity', 'startDate', 'endDate', 'spread'];

  return {
    name: 'polymarket-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/polymarket')) return next();

        const url = new URL(req.url, 'http://localhost');
        const endpoint = url.searchParams.get('endpoint') || 'markets';
        const closed = ['true', 'false'].includes(url.searchParams.get('closed') ?? '') ? url.searchParams.get('closed') : 'false';
        const order = ALLOWED_ORDER.includes(url.searchParams.get('order') ?? '') ? url.searchParams.get('order') : 'volume';
        const ascending = ['true', 'false'].includes(url.searchParams.get('ascending') ?? '') ? url.searchParams.get('ascending') : 'false';
        const rawLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
        const limit = isNaN(rawLimit) ? 50 : Math.max(1, Math.min(100, rawLimit));

        const params = new URLSearchParams({ closed: closed!, order: order!, ascending: ascending!, limit: String(limit) });
        if (endpoint === 'events') {
          const tag = (url.searchParams.get('tag') ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 100);
          if (tag) params.set('tag_slug', tag);
        }

        const gammaUrl = `${GAMMA_BASE}/${endpoint === 'events' ? 'events' : 'markets'}?${params}`;

        res.setHeader('Content-Type', 'application/json');
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const resp = await fetch(gammaUrl, { headers: { Accept: 'application/json' }, signal: controller.signal });
          clearTimeout(timer);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.text();
          res.setHeader('Cache-Control', 'public, max-age=120');
          res.setHeader('X-Polymarket-Source', 'gamma');
          res.end(data);
        } catch {
          // Expected: Cloudflare JA3 blocks server-side TLS — return empty array
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.end('[]');
        }
      });
    },
  };
}

/**
 * Vite dev server plugin for sebuf API routes.
 *
 * Intercepts requests matching /api/{domain}/v1/* and routes them through
 * the same handler pipeline as the Vercel catch-all gateway. Other /api/*
 * paths fall through to existing proxy rules.
 */
function sebufApiPlugin(): Plugin {
  // Cache router across requests (H-13 fix). Invalidated by Vite's module graph on HMR.
  let cachedRouter: Awaited<ReturnType<typeof buildRouter>> | null = null;
  let cachedCorsMod: any = null;

  async function buildRouter() {
    const [
      routerMod, corsMod, errorMod,
      seismologyServerMod, seismologyHandlerMod,
      wildfireServerMod, wildfireHandlerMod,
      climateServerMod, climateHandlerMod,
      predictionServerMod, predictionHandlerMod,
      displacementServerMod, displacementHandlerMod,
      aviationServerMod, aviationHandlerMod,
      researchServerMod, researchHandlerMod,
      unrestServerMod, unrestHandlerMod,
      conflictServerMod, conflictHandlerMod,
      maritimeServerMod, maritimeHandlerMod,
      cyberServerMod, cyberHandlerMod,
      economicServerMod, economicHandlerMod,
      infrastructureServerMod, infrastructureHandlerMod,
      marketServerMod, marketHandlerMod,
      newsServerMod, newsHandlerMod,
      intelligenceServerMod, intelligenceHandlerMod,
      militaryServerMod, militaryHandlerMod,
      positiveEventsServerMod, positiveEventsHandlerMod,
      givingServerMod, givingHandlerMod,
      tradeServerMod, tradeHandlerMod,
      supplyChainServerMod, supplyChainHandlerMod,
      naturalServerMod, naturalHandlerMod,
      resilienceServerMod, resilienceHandlerMod,
      leadsServerMod, leadsHandlerMod,
      scenarioServerMod, scenarioHandlerMod,
      shippingV2ServerMod, shippingV2HandlerMod,
    ] = await Promise.all([
        import('./server/router'),
        import('./server/cors'),
        import('./server/error-mapper'),
        import('./src/generated/server/worldmonitor/seismology/v1/service_server'),
        import('./server/worldmonitor/seismology/v1/handler'),
        import('./src/generated/server/worldmonitor/wildfire/v1/service_server'),
        import('./server/worldmonitor/wildfire/v1/handler'),
        import('./src/generated/server/worldmonitor/climate/v1/service_server'),
        import('./server/worldmonitor/climate/v1/handler'),
        import('./src/generated/server/worldmonitor/prediction/v1/service_server'),
        import('./server/worldmonitor/prediction/v1/handler'),
        import('./src/generated/server/worldmonitor/displacement/v1/service_server'),
        import('./server/worldmonitor/displacement/v1/handler'),
        import('./src/generated/server/worldmonitor/aviation/v1/service_server'),
        import('./server/worldmonitor/aviation/v1/handler'),
        import('./src/generated/server/worldmonitor/research/v1/service_server'),
        import('./server/worldmonitor/research/v1/handler'),
        import('./src/generated/server/worldmonitor/unrest/v1/service_server'),
        import('./server/worldmonitor/unrest/v1/handler'),
        import('./src/generated/server/worldmonitor/conflict/v1/service_server'),
        import('./server/worldmonitor/conflict/v1/handler'),
        import('./src/generated/server/worldmonitor/maritime/v1/service_server'),
        import('./server/worldmonitor/maritime/v1/handler'),
        import('./src/generated/server/worldmonitor/cyber/v1/service_server'),
        import('./server/worldmonitor/cyber/v1/handler'),
        import('./src/generated/server/worldmonitor/economic/v1/service_server'),
        import('./server/worldmonitor/economic/v1/handler'),
        import('./src/generated/server/worldmonitor/infrastructure/v1/service_server'),
        import('./server/worldmonitor/infrastructure/v1/handler'),
        import('./src/generated/server/worldmonitor/market/v1/service_server'),
        import('./server/worldmonitor/market/v1/handler'),
        import('./src/generated/server/worldmonitor/news/v1/service_server'),
        import('./server/worldmonitor/news/v1/handler'),
        import('./src/generated/server/worldmonitor/intelligence/v1/service_server'),
        import('./server/worldmonitor/intelligence/v1/handler'),
        import('./src/generated/server/worldmonitor/military/v1/service_server'),
        import('./server/worldmonitor/military/v1/handler'),
        import('./src/generated/server/worldmonitor/positive_events/v1/service_server'),
        import('./server/worldmonitor/positive-events/v1/handler'),
        import('./src/generated/server/worldmonitor/giving/v1/service_server'),
        import('./server/worldmonitor/giving/v1/handler'),
        import('./src/generated/server/worldmonitor/trade/v1/service_server'),
        import('./server/worldmonitor/trade/v1/handler'),
        import('./src/generated/server/worldmonitor/supply_chain/v1/service_server'),
        import('./server/worldmonitor/supply-chain/v1/handler'),
        import('./src/generated/server/worldmonitor/natural/v1/service_server'),
        import('./server/worldmonitor/natural/v1/handler'),
        import('./src/generated/server/worldmonitor/resilience/v1/service_server'),
        import('./server/worldmonitor/resilience/v1/handler'),
        import('./src/generated/server/worldmonitor/leads/v1/service_server'),
        import('./server/worldmonitor/leads/v1/handler'),
        import('./src/generated/server/worldmonitor/scenario/v1/service_server'),
        import('./server/worldmonitor/scenario/v1/handler'),
        import('./src/generated/server/worldmonitor/shipping/v2/service_server'),
        import('./server/worldmonitor/shipping/v2/handler'),
      ]);

    const serverOptions = { onError: errorMod.mapErrorToResponse };
    const allRoutes = [
      ...seismologyServerMod.createSeismologyServiceRoutes(seismologyHandlerMod.seismologyHandler, serverOptions),
      ...wildfireServerMod.createWildfireServiceRoutes(wildfireHandlerMod.wildfireHandler, serverOptions),
      ...climateServerMod.createClimateServiceRoutes(climateHandlerMod.climateHandler, serverOptions),
      ...predictionServerMod.createPredictionServiceRoutes(predictionHandlerMod.predictionHandler, serverOptions),
      ...displacementServerMod.createDisplacementServiceRoutes(displacementHandlerMod.displacementHandler, serverOptions),
      ...aviationServerMod.createAviationServiceRoutes(aviationHandlerMod.aviationHandler, serverOptions),
      ...researchServerMod.createResearchServiceRoutes(researchHandlerMod.researchHandler, serverOptions),
      ...unrestServerMod.createUnrestServiceRoutes(unrestHandlerMod.unrestHandler, serverOptions),
      ...conflictServerMod.createConflictServiceRoutes(conflictHandlerMod.conflictHandler, serverOptions),
      ...maritimeServerMod.createMaritimeServiceRoutes(maritimeHandlerMod.maritimeHandler, serverOptions),
      ...cyberServerMod.createCyberServiceRoutes(cyberHandlerMod.cyberHandler, serverOptions),
      ...economicServerMod.createEconomicServiceRoutes(economicHandlerMod.economicHandler, serverOptions),
      ...infrastructureServerMod.createInfrastructureServiceRoutes(infrastructureHandlerMod.infrastructureHandler, serverOptions),
      ...marketServerMod.createMarketServiceRoutes(marketHandlerMod.marketHandler, serverOptions),
      ...newsServerMod.createNewsServiceRoutes(newsHandlerMod.newsHandler, serverOptions),
      ...intelligenceServerMod.createIntelligenceServiceRoutes(intelligenceHandlerMod.intelligenceHandler, serverOptions),
      ...militaryServerMod.createMilitaryServiceRoutes(militaryHandlerMod.militaryHandler, serverOptions),
      ...positiveEventsServerMod.createPositiveEventsServiceRoutes(positiveEventsHandlerMod.positiveEventsHandler, serverOptions),
      ...givingServerMod.createGivingServiceRoutes(givingHandlerMod.givingHandler, serverOptions),
      ...tradeServerMod.createTradeServiceRoutes(tradeHandlerMod.tradeHandler, serverOptions),
      ...supplyChainServerMod.createSupplyChainServiceRoutes(supplyChainHandlerMod.supplyChainHandler, serverOptions),
      ...naturalServerMod.createNaturalServiceRoutes(naturalHandlerMod.naturalHandler, serverOptions),
      ...resilienceServerMod.createResilienceServiceRoutes(resilienceHandlerMod.resilienceHandler, serverOptions),
      ...leadsServerMod.createLeadsServiceRoutes(leadsHandlerMod.leadsHandler, serverOptions),
      ...scenarioServerMod.createScenarioServiceRoutes(scenarioHandlerMod.scenarioHandler, serverOptions),
      ...shippingV2ServerMod.createShippingV2ServiceRoutes(shippingV2HandlerMod.shippingV2Handler, serverOptions),
    ];
    cachedCorsMod = corsMod;
    return routerMod.createRouter(allRoutes);
  }

  return {
    name: 'sebuf-api',
    configureServer(server) {
      // Invalidate cached router on HMR updates to server/ files
      server.watcher.on('change', (file) => {
        if (file.includes('/server/') || file.includes('/src/generated/server/')) {
          cachedRouter = null;
        }
      });

      // Legacy v1 URL aliases → new sebuf RPC paths (mirror of the alias files
      // in api/scenario/v1/ + api/supply-chain/v1/). Vercel serves the alias
      // files directly; vite dev has no file-based routing for api/, so we
      // rewrite the pathname here before the router lookup.
      const V1_ALIASES: Record<string, string> = {
        '/api/scenario/v1/run': '/api/scenario/v1/run-scenario',
        '/api/scenario/v1/status': '/api/scenario/v1/get-scenario-status',
        '/api/scenario/v1/templates': '/api/scenario/v1/list-scenario-templates',
        '/api/supply-chain/v1/country-products': '/api/supply-chain/v1/get-country-products',
        '/api/supply-chain/v1/multi-sector-cost-shock': '/api/supply-chain/v1/get-multi-sector-cost-shock',
      };

      server.middlewares.use(async (req, res, next) => {
        // Intercept sebuf routes in two forms:
        //  - standard /api/{domain}/v{N}/* (domain-first, e.g. /api/market/v1/...)
        //  - partner-URL-preservation /api/v{N}/{domain}/* (version-first, e.g.
        //    /api/v2/shipping/...). Only the second form applies when the
        //    external contract already uses a reversed layout.
        if (!req.url || !/^\/api\/(?:[a-z][a-z0-9-]*\/v\d+|v\d+\/[a-z][a-z0-9-]*)\//.test(req.url)) {
          return next();
        }

        // Rewrite documented v1 URL → new sebuf path if this is an alias.
        const [pathOnly, queryOnly] = req.url.split('?', 2);
        const aliasTarget = pathOnly ? V1_ALIASES[pathOnly] : undefined;
        if (aliasTarget) {
          req.url = queryOnly ? `${aliasTarget}?${queryOnly}` : aliasTarget;
        }

        try {
          // Build router once, reuse across requests (H-13 fix)
          if (!cachedRouter) {
            cachedRouter = await buildRouter();
          }
          const router = cachedRouter;
          const corsMod = cachedCorsMod;

          // Convert Connect IncomingMessage to Web Standard Request
          const port = server.config.server.port || 3000;
          const url = new URL(req.url, `http://localhost:${port}`);

          // Read body for POST requests
          let body: string | undefined;
          if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }
            body = Buffer.concat(chunks).toString();
          }

          // Extract headers from IncomingMessage
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') {
              headers[key] = value;
            } else if (Array.isArray(value)) {
              headers[key] = value.join(', ');
            }
          }

          const webRequest = new Request(url.toString(), {
            method: req.method,
            headers,
            body: body || undefined,
          });

          const corsHeaders = corsMod.getCorsHeaders(webRequest);

          // OPTIONS preflight
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end();
            return;
          }

          // Origin check
          if (corsMod.isDisallowedOrigin(webRequest)) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end(JSON.stringify({ error: 'Origin not allowed' }));
            return;
          }

          // Route matching
          const matchedHandler = router.match(webRequest);
          if (!matchedHandler) {
            const allowed = router.allowedMethods(new URL(webRequest.url).pathname);
            if (allowed.length > 0) {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Allow', allowed.join(', '));
            } else {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
            }
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end(JSON.stringify({ error: res.statusCode === 405 ? 'Method not allowed' : 'Not found' }));
            return;
          }

          // Execute handler
          const response = await matchedHandler(webRequest);

          // Write response
          res.statusCode = response.status;
          response.headers.forEach((value, key) => {
            res.setHeader(key, value);
          });
          for (const [key, value] of Object.entries(corsHeaders)) {
            res.setHeader(key, value);
          }
          res.end(await response.text());
        } catch (err) {
          console.error('[sebuf-api] Error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    },
  };
}

// RSS proxy allowlist — duplicated from api/rss-proxy.js for dev mode.
// Keep in sync when adding new domains.
const RSS_PROXY_ALLOWED_DOMAINS = new Set([
  'feeds.bbci.co.uk', 'www.theguardian.com', 'feeds.npr.org', 'news.google.com',
  'www.aljazeera.com', 'rss.cnn.com', 'hnrss.org', 'feeds.arstechnica.com',
  'www.theverge.com', 'www.cnbc.com', 'feeds.marketwatch.com', 'www.defenseone.com',
  'breakingdefense.com', 'www.bellingcat.com', 'techcrunch.com', 'huggingface.co',
  'www.technologyreview.com', 'rss.arxiv.org', 'export.arxiv.org',
  'www.federalreserve.gov', 'www.sec.gov', 'www.whitehouse.gov', 'www.state.gov',
  'www.defense.gov', 'home.treasury.gov', 'www.justice.gov', 'tools.cdc.gov',
  'www.fema.gov', 'www.dhs.gov', 'www.thedrive.com', 'krebsonsecurity.com',
  'finance.yahoo.com', 'thediplomat.com', 'venturebeat.com', 'foreignpolicy.com',
  'www.ft.com', 'openai.com', 'www.reutersagency.com', 'feeds.reuters.com',
  'asia.nikkei.com', 'www.cfr.org', 'www.csis.org', 'www.politico.com',
  'www.brookings.edu', 'layoffs.fyi', 'www.defensenews.com', 'www.militarytimes.com',
  'taskandpurpose.com', 'news.usni.org', 'www.oryxspioenkop.com',
  'www.smartraveller.gov.au', 'www.gov.uk',
  'www.foreignaffairs.com', 'www.atlanticcouncil.org',
  // Tech variant
  'www.zdnet.com', 'www.techmeme.com', 'www.darkreading.com', 'www.schneier.com',
  'rss.politico.com', 'www.anandtech.com', 'www.tomshardware.com', 'www.semianalysis.com',
  'feed.infoq.com', 'thenewstack.io', 'devops.com', 'dev.to', 'lobste.rs', 'changelog.com',
  'seekingalpha.com', 'news.crunchbase.com', 'www.saastr.com', 'feeds.feedburner.com',
  'www.producthunt.com', 'www.axios.com', 'api.axios.com', 'github.blog', 'githubnext.com',
  'mshibanami.github.io', 'www.engadget.com', 'news.mit.edu', 'dev.events',
  'www.ycombinator.com', 'a16z.com', 'review.firstround.com', 'www.sequoiacap.com',
  'www.nfx.com', 'www.aaronsw.com', 'bothsidesofthetable.com', 'www.lennysnewsletter.com',
  'stratechery.com', 'www.eu-startups.com', 'tech.eu', 'sifted.eu', 'www.techinasia.com',
  'kr-asia.com', 'techcabal.com', 'disrupt-africa.com', 'lavca.org', 'contxto.com',
  'inc42.com', 'yourstory.com', 'pitchbook.com', 'www.cbinsights.com', 'www.techstars.com',
  // Regional & international
  'english.alarabiya.net', 'www.arabnews.com', 'www.timesofisrael.com', 'www.haaretz.com',
  'www.scmp.com', 'kyivindependent.com', 'www.themoscowtimes.com', 'feeds.24.com',
  'feeds.capi24.com', 'www.france24.com', 'www.euronews.com', 'www.lemonde.fr',
  'rss.dw.com', 'www.africanews.com', 'www.lasillavacia.com', 'www.channelnewsasia.com',
  'www.thehindu.com', 'news.un.org', 'www.iaea.org', 'www.who.int', 'www.cisa.gov',
  'www.crisisgroup.org',
  // Think tanks
  'rusi.org', 'warontherocks.com', 'www.aei.org', 'responsiblestatecraft.org',
  'www.fpri.org', 'jamestown.org', 'www.chathamhouse.org', 'ecfr.eu', 'www.gmfus.org',
  'www.wilsoncenter.org', 'www.lowyinstitute.org', 'www.mei.edu', 'www.stimson.org',
  'www.cnas.org', 'carnegieendowment.org', 'www.rand.org', 'fas.org',
  'www.armscontrol.org', 'www.nti.org', 'thebulletin.org', 'www.iss.europa.eu',
  // Economic & Food Security
  'www.fao.org', 'worldbank.org', 'www.imf.org',
  // Regional locale feeds
  'www.hurriyet.com.tr', 'tvn24.pl', 'www.polsatnews.pl', 'www.rp.pl', 'meduza.io',
  'novayagazeta.eu', 'www.bangkokpost.com', 'vnexpress.net', 'www.abc.net.au',
  'news.ycombinator.com',
  // Hindi / India feeds
  'www.aajtak.in', 'www.amarujala.com',
  // Hungarian / Central European feeds
  'telex.hu', 'index.hu', 'hvg.hu', '444.hu', '24.hu', 'hirado.hu', 'portfolio.hu', 'www.portfolio.hu', 'www.atv.hu',
  // Investigative journalism sources
  'www.occrp.org', 'dfrlab.org', 'www.lighthousereports.com', 'thesentry.org', 'globalinitiative.net', 'vsquare.org', 'correctiv.org',
  // Croatian feeds
  'n1info.hr', 'www.index.hr', 'www.jutarnji.hr', 'balkaninsight.com',
  // Finance variant
  'www.coindesk.com', 'cointelegraph.com',
  // Happy variant — positive news sources
  'www.goodnewsnetwork.org', 'www.positive.news', 'reasonstobecheerful.world',
  'www.optimistdaily.com', 'www.sunnyskyz.com', 'www.huffpost.com',
  'www.sciencedaily.com', 'feeds.nature.com', 'www.livescience.com', 'www.newscientist.com',
  // Feed-registry coverage (PR fix/feed-validation-unblock — kept sync with shared/rss-allowed-domains.json)
  'abcnews.go.com', 'abcnews.com', 'www.corriere.it', 'www.rt.com', 'www.alarabiya.net', 'tuoitrenews.vn',
  'www.yonhapnewstv.co.kr', 'www.chosun.com', 'rss.libsyn.com', 'feeds.megaphone.fm', 'rss.art19.com',
  'idp.nature.com',
]);

function rssProxyPlugin(): Plugin {
  return {
    name: 'rss-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/rss-proxy')) {
          return next();
        }

        const url = new URL(req.url, 'http://localhost');
        const feedUrl = url.searchParams.get('url');
        if (!feedUrl) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing url parameter' }));
          return;
        }

        try {
          const parsed = new URL(feedUrl);
          if (!RSS_PROXY_ALLOWED_DOMAINS.has(parsed.hostname)) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Domain not allowed: ${parsed.hostname}` }));
            return;
          }

          const controller = new AbortController();
          const timeout = feedUrl.includes('news.google.com') ? 20000 : 12000;
          const timer = setTimeout(() => controller.abort(), timeout);

          const response = await fetch(feedUrl, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            },
            redirect: 'follow',
          });
          clearTimeout(timer);

          const data = await response.text();
          res.statusCode = response.status;
          res.setHeader('Content-Type', 'application/xml');
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(data);
        } catch (error: any) {
          console.error('[rss-proxy]', feedUrl, error.message);
          res.statusCode = error.name === 'AbortError' ? 504 : 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error.name === 'AbortError' ? 'Feed timeout' : 'Failed to fetch feed' }));
        }
      });
    },
  };
}

function youtubeLivePlugin(): Plugin {
  return {
    name: 'youtube-live',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/youtube/live')) {
          return next();
        }

        const url = new URL(req.url, 'http://localhost');
        const channel = url.searchParams.get('channel');

        if (!channel) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing channel parameter' }));
          return;
        }

        try {
          const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
          const liveUrl = `https://www.youtube.com/${channelHandle}/live`;

          const ytRes = await fetch(liveUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            redirect: 'follow',
          });

          if (!ytRes.ok) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.end(JSON.stringify({ videoId: null, channel }));
            return;
          }

          const html = await ytRes.text();

          // Scope both fields to the same videoDetails block so we don't
          // combine a videoId from one object with isLive from another.
          let videoId: string | null = null;
          const detailsIdx = html.indexOf('"videoDetails"');
          if (detailsIdx !== -1) {
            const block = html.substring(detailsIdx, detailsIdx + 5000);
            const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
            const liveMatch = block.match(/"isLive"\s*:\s*true/);
            if (vidMatch && liveMatch) {
              videoId = vidMatch[1];
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.end(JSON.stringify({ videoId, isLive: videoId !== null, channel }));
        } catch (error) {
          console.error(`[YouTube Live] Error:`, error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Failed to fetch', videoId: null }));
        }
      });
    },
  };
}

function gpsjamDevPlugin(): Plugin {
  return {
    name: 'gpsjam-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/api/gpsjam' && !req.url?.startsWith('/api/gpsjam?')) {
          return next();
        }

        try {
          const data = await readFile(resolve(__dirname, 'scripts/data/gpsjam-latest.json'), 'utf8');
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(data);
        } catch {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(JSON.stringify({ error: 'No GPS jam data. Run: node scripts/fetch-gpsjam.mjs' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Inject environment variables from .env files into process.env.
  // This ensures that API keys and other secrets in .env.local are
  // available to the dev server plugins and server-side handlers.
  Object.assign(process.env, env);

  const isE2E = process.env.VITE_E2E === '1';
  const isDesktopBuild = process.env.VITE_DESKTOP_RUNTIME === '1';
  const activeVariant = process.env.VITE_VARIANT || 'full';
  const activeMeta = VARIANT_META[activeVariant] || VARIANT_META.full;

  return {
    html: {
      cspNonce: STATIC_SCRIPT_NONCE,
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // Resolved + build-time validated above (devDependencies fallback +
      // non-empty + major-pairing guards).
      __CLERK_JS_VERSION__: JSON.stringify(CLERK_JS_VERSION),
      // Vercel sets VERCEL_GIT_COMMIT_SHA on production + preview builds.
      // Local `vite build` falls back to 'dev' — installStaleBundleCheck
      // detects the marker and skips the comparison so dev tabs don't
      // reload on every focus.
      __BUILD_HASH__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev'),
    },
    plugins: [
      // Emit dist/build-hash.txt with the deployed SHA so the running bundle
      // can fetch /build-hash.txt at tab-focus time and force-reload itself
      // if it's running an older bundle (see src/bootstrap/stale-bundle-check.ts).
      // Same-origin static asset, NOT under /api/* — installWebApiRedirect
      // doesn't touch it, so the comparison reflects the web deployment.
      {
        name: 'wm-emit-build-hash',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'build-hash.txt',
            source: process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev',
          });
        },
      },
      htmlVariantPlugin(activeMeta, activeVariant, isDesktopBuild),
      !isDesktopBuild && dashboardHtmlOutputPlugin(),
      polymarketPlugin(),
      rssProxyPlugin(),
      youtubeLivePlugin(),
      gpsjamDevPlugin(),
      sebufApiPlugin(),
      brotliPrecompressPlugin(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false,

        includeAssets: [
          'favico/favicon.ico',
          'favico/apple-touch-icon.png',
          'favico/favicon-32x32.png',
        ],
        // Manifest install icons stay advertised in manifest.webmanifest, but
        // they are fetched on demand instead of forced into first-visit SW
        // precache with the rest of the dashboard shell.
        includeManifestIcons: false,

        manifest: {
          name: `${activeMeta.siteName} - ${activeMeta.subject}`,
          short_name: activeMeta.shortName,
          description: activeMeta.description,
          start_url: '/dashboard',
          scope: '/',
          display: 'standalone',
          orientation: 'any',
          theme_color: '#0a0f0a',
          background_color: '#0a0f0a',
          categories: activeMeta.categories,
          icons: [
            { src: '/favico/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/favico/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: '/favico/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },

        workbox: {
          globPatterns: ['**/*.{js,css,ico,png,svg,woff2}'],
          globIgnores: [
            '**/ml*.js',
            '**/onnx*.wasm',
            '**/locale-*.js',
            '**/clerk-*.js',
            // Keep off-page/static-heavy public assets out of the dashboard's
            // first-visit precache. The small root favicons above remain
            // explicit includeAssets entries.
            'pro/**',
            'favico/**',
            'textures/**',
          ],
          // globe.gl + three.js grows main bundle past the 2 MiB default limit
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          navigateFallback: null,
          skipWaiting: true,
          clientsClaim: true,
          cleanupOutdatedCaches: true,
          // Web Push handler (Phase 6). importScripts runs in the SW
          // context; /push-handler.js is a static file copied from
          // public/ and attaches 'push' + 'notificationclick' listeners.
          importScripts: ['/push-handler.js'],

          runtimeCaching: [
            {
              urlPattern: ({ request }: { request: Request }) => request.mode === 'navigate',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'html-navigation',
                networkTimeoutSeconds: 5,
                cacheableResponse: { statuses: [200] },
              },
            },
            {
              urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin && /^\/api\//.test(url.pathname),
              handler: 'NetworkOnly',
              method: 'GET',
            },
            {
              urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin && /^\/api\//.test(url.pathname),
              handler: 'NetworkOnly',
              method: 'POST',
            },
            {
              urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin && /^\/rss\//.test(url.pathname),
              handler: 'NetworkOnly',
              method: 'GET',
            },
            {
              urlPattern: ({ url }: { url: URL }) =>
                url.pathname.endsWith('.pmtiles') ||
                url.hostname.endsWith('.r2.dev') ||
                url.hostname === 'build.protomaps.com',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'pmtiles-ranges',
                expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/protomaps\.github\.io\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'protomaps-assets',
                expiration: { maxEntries: 100, maxAgeSeconds: 365 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /\/assets\/locale-.*\.js$/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'locale-files',
                expiration: { maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/i,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'images',
                expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 },
              },
            },
          ],
        },

        devOptions: {
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        child_process: resolve(__dirname, 'src/shims/child-process.ts'),
        'node:child_process': resolve(__dirname, 'src/shims/child-process.ts'),
        '@loaders.gl/worker-utils/dist/lib/process-utils/child-process-proxy.js': resolve(
          __dirname,
          'src/shims/child-process-proxy.ts'
        ),
      },
    },
    worker: {
      format: 'es',
    },
    build: {
      // Geospatial bundles (maplibre/deck) are expected to be large even when split.
      // Raise warning threshold to reduce noisy false alarms in CI.
      chunkSizeWarningLimit: 1200,
      // Vite 6 hoists every dynamic chunk's STATIC deps into the entry HTML's
      // modulepreload list to avoid latency on the first dynamic import. For the
      // map stack that defeats the whole point of dynamic-importing MapContainer:
      // ~3MB of WebGL deps would still download at parse time. Strip them here so
      // they only load when MapContainer's `await import(...)` actually fires
      // (still preloaded in parallel via __vitePreload at that moment).
      modulePreload: {
        resolveDependencies: (_filename, deps, { hostType }) => {
          if (hostType !== 'html') return deps;
          return deps.filter(d => !LAZY_HTML_PRELOAD_RE.test(d));
        },
      },
      rollupOptions: {
        onwarn(warning, warn) {
          // onnxruntime-web ships a minified browser bundle that intentionally uses eval.
          // Keep build logs focused by filtering this known third-party warning only.
          if (
            warning.code === 'EVAL'
            && typeof warning.id === 'string'
            && warning.id.includes('/onnxruntime-web/dist/ort-web.min.js')
          ) {
            return;
          }

          warn(warning);
        },
        input: {
          main: resolve(__dirname, 'index.html'),
          embed: resolve(__dirname, 'embed.html'),
          settings: resolve(__dirname, 'settings.html'),
          liveChannels: resolve(__dirname, 'live-channels.html'),
          mcpGrant: resolve(__dirname, 'mcp-grant.html'),
        },
        output: {
          // onlyExplicitManualChunks keeps the panel clusters from forming
          // cross-chunk cycles. Its side effect: a manual chunk's unmatched
          // static deps get pulled into the importer chunk — which created a
          // circular DeckGLMap -> deck-stack -> DeckGLMap chunk (runtime TDZ
          // "Cannot access 'X' before initialization" that crashed the WebGL map
          // into the SVG fallback). Fixed by co-locating the DeckGLMap renderer
          // into the 'deck-stack' chunk below so deck deps never split across the
          // DeckGLMap boundary.
          onlyExplicitManualChunks: true,
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('/@xenova/transformers/')) {
                return 'transformers';
              }
              if (id.includes('/onnxruntime-web/')) {
                return 'onnxruntime';
              }
              // NOTE: chunk names below MUST match entries in LAZY_HTML_PRELOAD_CHUNKS
              // (top of file). The resolveDependencies filter relies on this string
              // identity; renaming here without updating the constant silently
              // re-eagerises the WebGL stack into the entry HTML's modulepreload list.
              if (id.includes('/maplibre-gl/')) {
                return 'maplibre';
              }
              if (id.includes('/pmtiles/') || id.includes('/@protomaps/basemaps/')) {
                return 'protomaps';
              }
              if (id.includes('/h3-js/')) {
                return 'h3-js';
              }
              if (
                id.includes('/@deck.gl/')
                || id.includes('/@luma.gl/')
                || id.includes('/@loaders.gl/')
                || id.includes('/@math.gl/')
              ) {
                return 'deck-stack';
              }
              if (id.includes('/d3/')) {
                return 'd3';
              }
              if (id.includes('/topojson-client/')) {
                return 'topojson';
              }
              if (id.includes('/i18next')) {
                return 'i18n';
              }
              if (id.includes('/@sentry/') || id.includes('/@sentry-internal/')) {
                return 'sentry';
              }
              if (id.includes('/@clerk/clerk-js/')) {
                // Clerk remains a runtime dynamic import; the stable chunk name
                // lets Workbox keep the large auth SDK out of precache.
                return 'clerk';
              }
            }
            // Large static config DATA TABLE (~62KB) with only lazy consumers
            // (search/map/globe/tech-hub services). Isolating it keeps it off the
            // eager entry now that the @/config barrel no longer re-exports its
            // values and data-loader lazy-loads the tech-activity chain. Pure
            // data (type-only imports) → no unmatched-static-dep circular risk. (#4404)
            if (id.endsWith('/src/config/tech-geo.ts')) {
              return 'tech-geo-data';
            }
            // airports table (~14KB) — only consumer is the lazy AviationCommandBar
            // (imports directly); kept off the eager @/config barrel above. (#4404)
            if (id.endsWith('/src/config/airports.ts')) {
              return 'airports-data';
            }
            // ai-datacenters table (~86KB) — consumers (map/globe/search) import
            // directly and are lazy; related-assets lazy-imports it. Kept off the
            // eager @/config barrel above. (#4404)
            if (id.endsWith('/src/config/ai-datacenters.ts')) {
              return 'ai-datacenters-data';
            }
            // geo-map table bulk (~150KB: UNDERSEA_CABLES + NUCLEAR_FACILITIES +
            // ECONOMIC_CENTERS/SPACEPORTS/CRITICAL_MINERALS/SANCTIONED_*/MAP_URLS).
            // Map/globe/search consumers import directly (lazy); the eager
            // related-assets/infrastructure-cascade/cable-activity chains
            // lazy-cache it. Kept off the eager @/config barrel above. (#4404)
            if (id.endsWith('/src/config/geo-map.ts')) {
              return 'geo-map-data';
            }
            // Military-bases bulk (~48KB MILITARY_BASES_EXPANDED + merged
            // MILITARY_BASES). geo.ts no longer imports it; eager consumers
            // (country-intel, related-assets, data-loader→military-surge)
            // lazy-load it via dynamic import. Kept off the eager @/config
            // barrel. Co-chunk both files so the merged list and its raw data
            // ship together off the entry chunk. (#4478)
            if (id.endsWith('/src/config/military-bases.ts') || id.endsWith('/src/config/bases-expanded.ts')) {
              return 'military-bases-data';
            }
            // Correlation engine (engine + 4 adapters) is dynamic-imported at its
            // post-loadAllData run site in App.ts (#4486), so it already forms a lazy
            // chunk; this rule only gives that chunk a STABLE name — the dir-index
            // would otherwise emit an ambiguous `index-*.js` the eager-chunk guard
            // can't pin. Naming only; the deferral is the call-site import().
            if (id.includes('/src/services/correlation-engine/')) {
              return 'correlation-engine';
            }
            // Post-paint service tail split (#4487). These files are dynamic-imported
            // from data-loader/country-intel/SignalModal; stable names let the
            // dist guard prove they stay out of main rather than merely grepping src.
            if (id.endsWith('/src/services/rss.ts')) {
              return 'rss';
            }
            if (id.endsWith('/src/services/trending-keywords.ts')) {
              return 'trending-keywords';
            }
            if (id.endsWith('/src/services/daily-market-brief.ts')) {
              return 'daily-market-brief';
            }
            if (id.endsWith('/src/services/signal-aggregator.ts')) {
              return 'signal-aggregator';
            }
            if (id.endsWith('/src/services/military-vessels.ts')) {
              return 'military-vessels';
            }
            if (id.endsWith('/src/services/cross-module-integration.ts')) {
              return 'cross-module-integration';
            }
            // Generated protobuf/RPC client modules are loaded through
            // src/services/generated-rpc-clients.ts so real constructors parse only
            // on first RPC use. Stable names let the eager-chunk guard prove they
            // stay out of the dashboard entry and HTML modulepreload list. (#4493)
            const rpcClientMatch = id.match(/\/src\/generated\/client\/worldmonitor\/(.+)\/service_client\.ts$/);
            if (rpcClientMatch) {
              return `rpc-client-${rpcClientMatch[1].replace(/_/g, '-').replace(/\//g, '-')}`;
            }
            // Co-locate the deck.gl renderer with the deck vendor chunk so
            // onlyExplicitManualChunks cannot split deck's transitive deps
            // across the DeckGLMap boundary (which formed a circular chunk →
            // runtime TDZ that crashed the WebGL map into the SVG fallback).
            if (id.endsWith('/src/components/DeckGLMap.ts')) {
              return 'deck-stack';
            }
            if (id.includes('/src/components/') && id.endsWith('.ts')) {
              const panelChunk = panelChunkForComponentId(id);
              if (panelChunk) return panelChunk;
            }
            // Give lazy-loaded locale chunks a recognizable prefix so the
            // service worker can exclude them from precache (en.json is
            // statically imported into the main bundle).
            const localeMatch = id.match(/\/locales\/(\w+)\.json$/);
            if (localeMatch && localeMatch[1] !== 'en') {
              return `locale-${localeMatch[1]}`;
            }
            return undefined;
          },
        },
      },
    },
    server: {
      port: 3000,
      open: !isE2E,
      hmr: isE2E ? false : undefined,
      watch: {
        ignored: [
          '**/test-results/**',
          '**/playwright-report/**',
          '**/.playwright-mcp/**',
        ],
      },
      proxy: {
        // Widget agent — forward to Railway relay for SSE streaming
        '/widget-agent': {
          target: 'https://proxy.worldmonitor.app',
          changeOrigin: true,
        },
        // Yahoo Finance API
        '/api/yahoo': {
          target: 'https://query1.finance.yahoo.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        },
        // Polymarket handled by polymarketPlugin() — no prod proxy needed
        // USGS Earthquake API
        '/api/earthquake': {
          target: 'https://earthquake.usgs.gov',
          changeOrigin: true,
          timeout: 30000,
          rewrite: (path) => path.replace(/^\/api\/earthquake/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('Earthquake proxy error:', err.message);
            });
          },
        },
        // PizzINT - Pentagon Pizza Index
        '/api/pizzint': {
          target: 'https://www.pizzint.watch',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/pizzint/, '/api'),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('PizzINT proxy error:', err.message);
            });
          },
        },
        // FRED Economic Data - handled by Vercel serverless function in prod
        // In dev, we proxy to the API directly with the key from .env
        '/api/fred-data': {
          target: 'https://api.stlouisfed.org',
          changeOrigin: true,
          rewrite: (path) => {
            const url = new URL(path, 'http://localhost');
            const seriesId = url.searchParams.get('series_id');
            const start = url.searchParams.get('observation_start');
            const end = url.searchParams.get('observation_end');
            const apiKey = process.env.FRED_API_KEY || '';
            return `/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=10${start ? `&observation_start=${start}` : ''}${end ? `&observation_end=${end}` : ''}`;
          },
        },
        // RSS Feeds - BBC
        '/rss/bbc': {
          target: 'https://feeds.bbci.co.uk',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/bbc/, ''),
        },
        // RSS Feeds - Guardian
        '/rss/guardian': {
          target: 'https://www.theguardian.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/guardian/, ''),
        },
        // RSS Feeds - NPR
        '/rss/npr': {
          target: 'https://feeds.npr.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/npr/, ''),
        },
        // RSS Feeds - Al Jazeera
        '/rss/aljazeera': {
          target: 'https://www.aljazeera.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/aljazeera/, ''),
        },
        // RSS Feeds - CNN
        '/rss/cnn': {
          target: 'http://rss.cnn.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cnn/, ''),
        },
        // RSS Feeds - Hacker News
        '/rss/hn': {
          target: 'https://hnrss.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/hn/, ''),
        },
        // RSS Feeds - Ars Technica
        '/rss/arstechnica': {
          target: 'https://feeds.arstechnica.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/arstechnica/, ''),
        },
        // RSS Feeds - The Verge
        '/rss/verge': {
          target: 'https://www.theverge.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/verge/, ''),
        },
        // RSS Feeds - CNBC
        '/rss/cnbc': {
          target: 'https://www.cnbc.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cnbc/, ''),
        },
        // RSS Feeds - MarketWatch
        '/rss/marketwatch': {
          target: 'https://feeds.marketwatch.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/marketwatch/, ''),
        },
        // RSS Feeds - Defense/Intel sources
        '/rss/defenseone': {
          target: 'https://www.defenseone.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/defenseone/, ''),
        },
        '/rss/warontherocks': {
          target: 'https://warontherocks.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/warontherocks/, ''),
        },
        '/rss/breakingdefense': {
          target: 'https://breakingdefense.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/breakingdefense/, ''),
        },
        '/rss/bellingcat': {
          target: 'https://www.bellingcat.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/bellingcat/, ''),
        },
        // RSS Feeds - TechCrunch (layoffs)
        '/rss/techcrunch': {
          target: 'https://techcrunch.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/techcrunch/, ''),
        },
        // Google News RSS
        '/rss/googlenews': {
          target: 'https://news.google.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/googlenews/, ''),
        },
        // AI Company Blogs
        '/rss/openai': {
          target: 'https://openai.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/openai/, ''),
        },
        '/rss/anthropic': {
          target: 'https://www.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/anthropic/, ''),
        },
        '/rss/googleai': {
          target: 'https://blog.google',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/googleai/, ''),
        },
        '/rss/deepmind': {
          target: 'https://deepmind.google',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/deepmind/, ''),
        },
        '/rss/huggingface': {
          target: 'https://huggingface.co',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/huggingface/, ''),
        },
        '/rss/techreview': {
          target: 'https://www.technologyreview.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/techreview/, ''),
        },
        '/rss/arxiv': {
          target: 'https://rss.arxiv.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/arxiv/, ''),
        },
        // Government
        '/rss/whitehouse': {
          target: 'https://www.whitehouse.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/whitehouse/, ''),
        },
        '/rss/statedept': {
          target: 'https://www.state.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/statedept/, ''),
        },
        '/rss/state': {
          target: 'https://www.state.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/state/, ''),
        },
        '/rss/defense': {
          target: 'https://www.defense.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/defense/, ''),
        },
        '/rss/justice': {
          target: 'https://www.justice.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/justice/, ''),
        },
        '/rss/cdc': {
          target: 'https://tools.cdc.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cdc/, ''),
        },
        '/rss/fema': {
          target: 'https://www.fema.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/fema/, ''),
        },
        '/rss/dhs': {
          target: 'https://www.dhs.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/dhs/, ''),
        },
        '/rss/fedreserve': {
          target: 'https://www.federalreserve.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/fedreserve/, ''),
        },
        '/rss/sec': {
          target: 'https://www.sec.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/sec/, ''),
        },
        '/rss/treasury': {
          target: 'https://home.treasury.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/treasury/, ''),
        },
        '/rss/cisa': {
          target: 'https://www.cisa.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cisa/, ''),
        },
        // Think Tanks
        '/rss/brookings': {
          target: 'https://www.brookings.edu',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/brookings/, ''),
        },
        '/rss/cfr': {
          target: 'https://www.cfr.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cfr/, ''),
        },
        '/rss/csis': {
          target: 'https://www.csis.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/csis/, ''),
        },
        // Defense
        '/rss/warzone': {
          target: 'https://www.thedrive.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/warzone/, ''),
        },
        '/rss/defensegov': {
          target: 'https://www.defense.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/defensegov/, ''),
        },
        // Security
        '/rss/krebs': {
          target: 'https://krebsonsecurity.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/krebs/, ''),
        },
        // Finance
        '/rss/yahoonews': {
          target: 'https://finance.yahoo.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/yahoonews/, ''),
        },
        // Diplomat
        '/rss/diplomat': {
          target: 'https://thediplomat.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/diplomat/, ''),
        },
        // VentureBeat
        '/rss/venturebeat': {
          target: 'https://venturebeat.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/venturebeat/, ''),
        },
        // Foreign Policy
        '/rss/foreignpolicy': {
          target: 'https://foreignpolicy.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/foreignpolicy/, ''),
        },
        // Financial Times
        '/rss/ft': {
          target: 'https://www.ft.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/ft/, ''),
        },
        // Reuters
        '/rss/reuters': {
          target: 'https://www.reutersagency.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/reuters/, ''),
        },
        // Cloudflare Radar - Internet outages
        '/api/cloudflare-radar': {
          target: 'https://api.cloudflare.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/cloudflare-radar/, ''),
        },
        // NGA Maritime Safety Information - Navigation Warnings
        '/api/nga-msi': {
          target: 'https://msi.nga.mil',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/nga-msi/, ''),
        },
        // GDELT GEO 2.0 API - Global event data
        '/api/gdelt': {
          target: 'https://api.gdeltproject.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/gdelt/, ''),
        },
        // AISStream WebSocket proxy for live vessel tracking
        '/ws/aisstream': {
          target: 'wss://stream.aisstream.io',
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/ws\/aisstream/, ''),
        },
        // FAA NASSTATUS - Airport delays and closures
        '/api/faa': {
          target: 'https://nasstatus.faa.gov',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/faa/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('FAA NASSTATUS proxy error:', err.message);
            });
          },
        },
        // OpenSky Network - Aircraft tracking (military flight detection)
        '/api/opensky': {
          target: 'https://opensky-network.org/api',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/opensky/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('OpenSky proxy error:', err.message);
            });
          },
        },
        // ADS-B Exchange - Military aircraft tracking (backup/supplement)
        '/api/adsb-exchange': {
          target: 'https://adsbexchange.com/api',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/adsb-exchange/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('ADS-B Exchange proxy error:', err.message);
            });
          },
        },
      },
    },
  };
});
