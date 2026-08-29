#!/usr/bin/env node
/**
 * generate-entitlement-crosswalk — every enforced free-vs-paid rule in this repo,
 * mapped to a user-facing capability or an explicit exclusion reason.
 *
 * WHY THIS EXISTS. A hand-curated list of "what Pro includes" cannot be validated:
 * you cannot tell a missing capability from a deliberate omission. This walks the
 * entitlement sources mechanically, then requires EVERY raw rule to resolve to
 * either a capability id or a documented exclusion. The checksum is
 * `unmappedGates: 0`. When a new gate lands and nobody classifies it, --check fails.
 *
 *   node scripts/generate-entitlement-crosswalk.mjs          # write the JSON
 *   node scripts/generate-entitlement-crosswalk.mjs --check  # exit 1 if unmapped > 0
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';

const OUT = 'docs/generated/entitlement-crosswalk.json';
const missingSources = [];
const R = (p) => { try { return readFileSync(p, 'utf8'); } catch { missingSources.push(p); return ''; } };

// ---------------------------------------------------------------- raw rules
const rules = [];

const add = (source, id, detail) => rules.push({ rule: `${source}:${id}`, source, detail });

// 1. productCatalog — every (plan × gating field) pair
{
  const s = R('convex/config/productCatalog.ts');
  const FIELDS = ['tier','maxDashboards','apiRateLimit','prioritySupport','mcpAccess','dataExport','apiAccess','apiRequestsPerDay','apiBurstRequestsPerMinute','mcpCallsPerDay','mcpBurstRequestsPerMinute','apiDailyAllowance','exportFormats'];
  for (const m of s.matchAll(/const (FREE|PRO|PRO_BUSINESS|API_STARTER|API_BUSINESS|ENTERPRISE)_FEATURES[^=]*=\s*\{([\s\S]*?)\n\};/g)) {
    const [, plan, body] = m;
    for (const f of FIELDS) {
      const arr = body.match(new RegExp(`\\b${f}:\\s*(\\[[^\\]]*\\])`));
      const mm  = arr || body.match(new RegExp(`\\b${f}:\\s*([^,\\n]+)`));
      if (mm) add('catalog', `${plan}.${f}`, mm[1].trim());
    }
  }
}
// 2. premium RPC paths
for (const m of R('src/shared/premium-paths.ts').matchAll(/^\s*'(\/api\/[^']+)',/gm)) add('premiumPath', m[1], 'bearer gate');
// 3. tier-gated endpoints
for (const m of R('server/_shared/entitlement-check.ts').matchAll(/'(\/api\/[^']+)':\s*(\d)/g)) add('tierGated', m[1], `tier>=${m[2]}`);
// 4. pro-fresh paths
for (const m of R('src/shared/pro-fresh-rpc.ts').matchAll(/^\s*'(\/api\/[^']+)',/gm)) add('proFresh', m[1], 'live-browser 30s vs 300s');
// 5. panel premium flags, per variant
{
  const s = R('src/config/panels.ts').split('\n');
  let variant = null;
  for (const ln of s) {
    const v = ln.match(/^const ([A-Z]+)_PANELS: Record<string, PanelConfig>/); if (v) { variant = v[1].toLowerCase(); continue; }
    if (/^\};/.test(ln)) { variant = null; continue; }
    if (!variant) continue;
    const p = ln.match(/^\s*'?([a-zA-Z0-9_-]+)'?:\s*\{\s*name:\s*'([^']+)'/);
    if (!p) continue;
    if (!/premium:/.test(ln)) continue;
    const kind = /premium: 'locked'/.test(ln) ? 'locked' : 'enhanced';
    const desktopOnly = /_desktop &&/.test(ln);
    const enabled = /enabled: true/.test(ln);
    add('panel', `${variant}.${p[1]}`, `${kind}${desktopOnly ? ' (desktop only)' : ''}${enabled ? '' : ' [ships disabled]'} — ${p[2]}`);
  }
}
// 6. map layer premium flags
for (const m of R('src/config/map-layer-definitions.ts').matchAll(/^\s*([a-zA-Z0-9_]+):\s*def\('([^']+)'[^\n]*?,\s*(?:_desktop \? )?'(locked|enhanced)'/gm))
  add('layer', m[2], m[3]);
// 7. FREE_* caps
for (const f of ['src/config/panels.ts','convex/constants.ts','src/services/gates/export-resolver.ts','src/services/followed-countries.ts','api/mcp/upgrade-constants.ts'])
  for (const m of R(f).matchAll(/^export const (FREE_[A-Z_]+)\s*=\s*([^;]+);/gm)) add('cap', m[1], `${m[2].trim()} (${f})`);


// ------------------------------------------------------- code-site gates
const PAT = "features\\.tier\\s*[<>=]|tier\\s*[<>]=?\\s*1|!hasPremiumAccess\\(\\)|features\\.apiAccess|features\\.mcpAccess|features\\.dataExport|requiresPremium|isCallerPremium\\(|!isProUser\\(\\)";
const out = execSync(`grep -rnE "${PAT}" --include="*.ts" --include="*.js" src api convex server 2>/dev/null || true`, { encoding: 'utf8', maxBuffer: 1 << 26 });
const sites = [];
for (const ln of out.split('\n')) {
  if (!ln.trim()) continue;
  const m = ln.match(/^([^:]+):(\d+):(.*)$/); if (!m) continue;
  const [, file, line, text] = m;
  if (/\.test\.|\/generated\//.test(file)) continue;
  const t = text.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;   // comments
  if (/^(import|export type|type |interface )/.test(t)) continue;                 // decls
  sites.push({ rule: `site:${file}:${line}`, source: 'site', file, line: +line, detail: t.slice(0, 130) });
}

// ------------------------------------------------------------- crosswalk
// Ordered crosswalk: first match wins. Each entry -> capability id, or exclude+reason.
const MAP = [
  // ---- catalog: the tier axis itself is not a capability
  [/^catalog:\w+\.tier$/,                    { exclude: 'tier axis, not a capability' }],
  [/^catalog:\w+\.exportFormats$/,           { cap: 'export.data', note: 'format allowlist' }],
  [/^catalog:\w+\.dataExport$/,              { cap: 'export.data' }],
  [/^catalog:\w+\.apiAccess$/,               { cap: 'api.keys' }],
  [/^catalog:\w+\.apiRequestsPerDay$/,       { cap: 'api.rest' }],
  [/^catalog:\w+\.apiRateLimit$/,            { cap: 'api.rest', note: 'rate ceiling' }],
  [/^catalog:\w+\.apiBurstRequestsPerMinute$/,{ cap: 'api.rest', note: 'burst ceiling' }],
  [/^catalog:\w+\.mcpAccess$/,               { cap: 'mcp.access' }],
  [/^catalog:\w+\.mcpCallsPerDay$/,          { cap: 'mcp.access', note: 'daily quota' }],
  [/^catalog:\w+\.mcpBurstRequestsPerMinute$/,{ cap: 'mcp.access', note: 'burst quota' }],
  [/^catalog:\w+\.maxDashboards$/,           { cap: 'limits.dashboards' }],
  [/^catalog:\w+\.prioritySupport$/,         { cap: 'support.priority' }],
  [/^catalog:\w+\.apiDailyAllowance$/,       { cap: 'api.rest', note: 'per-account daily allowance' }],

  // ---- caps
  [/^cap:FREE_MAX_PANELS$/,                  { cap: 'limits.panels' }],
  [/^cap:FREE_MAX_SOURCES$/,                 { cap: 'limits.sources' }],
  [/^cap:FREE_TAB_CAP$/,                     { cap: 'limits.dashboards', note: 'anonymous fallback mirroring FREE_FEATURES.maxDashboards (export-resolver.ts:179)' }],
  [/^cap:FREE_TIER_FOLLOW_LIMIT$/,           { cap: 'limits.followed_countries' }],
  [/^cap:FREE_ACCOUNT_CALLS_PER_DAY$/,       { cap: 'mcp.access', note: 'free promo allowance' }],
  [/^cap:FREE_ACCOUNT_REQUESTS_PER_DAY$/,    { cap: 'mcp.access', note: 'free promo windows' }],
  [/^cap:FREE_ACCOUNT_IDLE_GAP_MS$/,         { exclude: 'window mechanics, not a capability' }],
  [/^cap:FREE_CAP_PROTECTED_SOURCES$/,       { cap: 'limits.sources', note: 'exempt list' }],
  [/^cap:FREE_EMAIL_DOMAINS$/,               { exclude: 'seat-domain validation, not an entitlement' }],

  // ---- freshness
  [/^proFresh:/,                             { cap: 'freshness.market_quotes' }],

  // ---- API surfaces by domain
  [/:(\/api\/market\/v1\/analyze-stock|\/api\/market\/v1\/get-stock-analysis-history)$/, { cap: 'markets.stock_analysis' }],
  [/:(\/api\/market\/v1\/backtest-stock|\/api\/market\/v1\/list-stored-stock-backtests)$/, { cap: 'markets.backtest' }],
  [/:\/api\/intelligence\/v1\/list-market-implications$/, { cap: 'markets.implications' }],
  [/:\/api\/intelligence\/v1\/classify-event$/,           { cap: 'news.classification' }],
  [/:\/api\/intelligence\/v1\/deduct-situation$/,         { cap: 'intel.deduction' }],
  [/:\/api\/intelligence\/v1\/(search-intel-history|get-intel-timeline|get-similar-events)$/, { cap: 'intel.memory' }],
  [/:\/api\/intelligence\/v1\/(get-country-intel-brief|get-regime-history)$/, { cap: 'intel.country_brief' }],
  [/:\/api\/intelligence\/v1\/(get-regional-snapshot|get-regional-brief)$/,   { cap: 'intel.regional' }],
  [/:\/api\/resilience\/v1\//,                            { cap: 'resilience.scores' }],
  [/:\/api\/supply-chain\/v1\/(get-country-chokepoint-index|get-bypass-options)$/, { cap: 'supplychain.chokepoints' }],
  [/:\/api\/supply-chain\/v1\/(get-route-explorer-lane|get-route-impact)$/,        { cap: 'supplychain.routes' }],
  [/:\/api\/supply-chain\/v1\/(get-country-cost-shock|get-multi-sector-cost-shock|get-sector-dependency|get-country-products)$/, { cap: 'supplychain.costshock' }],
  [/:\/api\/trade\/v1\//,                                 { cap: 'trade.flows' }],
  [/:\/api\/economic\/v1\/get-national-debt$/,            { cap: 'economic.debt' }],
  [/:\/api\/economic\/v1\/list-global-tenders$/,          { cap: 'procurement.tenders' }],
  [/:\/api\/sanctions\/v1\//,                             { cap: 'sanctions.pressure' }],
  [/:\/api\/scenario\/v1\//,                              { cap: 'scenario.engine' }],
  [/:\/api\/forecast\/v1\/trigger-simulation$/,           { cap: 'scenario.engine', note: 'simulation trigger' }],
  [/:\/api\/aviation\/v1\//,                              { cap: 'aviation.data' }],
  [/:\/api\/military\/v1\/get-aircraft-details$/,         { cap: 'military.aircraft' }],
  [/:\/api\/v2\/shipping\//,                              { cap: 'shipping.routes' }],
  [/:\/api\/mcp-proxy$/,                                  { cap: 'mcp.access', note: 'outbound proxy' }],
  [/:\/api\/chat-analyst$/,                               { cap: 'analyst.chat' }],

  // ---- layers
  // Effective enforcement only. isLayerEntitled(): 'locked' blocks free users;
  // 'enhanced' is a PRO BADGE ONLY and free users may still toggle the layer.
  [/^layer:resilienceScore$/,                { cap: 'layers.resilience' }],
  [/^layer:ciiChoropleth$/,                  { exclude: "premium:'enhanced' — badge only; isLayerEntitled() returns true for free users" }],
  [/^layer:(iranAttacks|gpsJamming)$/,       { exclude: "desktop-only 'locked'; on web the flag is never set and isPanelEntitled/isLayerEntitled grant access — not an effective paid gate" }],

  // ---- panels (per-panel capability; disabled ones excluded)
  [/^panel:\w+\.(regional-intelligence|deduction)$/, { exclude: 'ships enabled:false — gate guards nothing' }],
  // isPanelEntitled(): a 'locked' panel outside apiKeyPanels returns isDesktopRuntime(),
  // so desktop-only markers grant access on desktop and are absent on web. Not a paid gate.
  [/^panel:\w+\.(forecast|oref-sirens|telegram-intel|x-intel)$/, { exclude: "desktop-only 'locked' — isPanelEntitled returns isDesktopRuntime(); free users are entitled on both surfaces" }],
  [/^panel:\w+\.(cii|strategic-risk|gdelt-intel|supply-chain)$/, { exclude: "desktop-only 'enhanced' — badge only, never blocks a free user" }],
  [/^panel:\w+\.stock-analysis$/,             { cap: 'markets.stock_analysis' }],
  [/^panel:\w+\.stock-backtest$/,             { cap: 'markets.backtest' }],
  [/^panel:\w+\.daily-market-brief$/,         { cap: 'markets.brief' }],
  [/^panel:\w+\.wsb-ticker-scanner$/,         { cap: 'markets.wsb' }],
  [/^panel:\w+\.market-implications$/,        { cap: 'markets.implications' }],
  [/^panel:\w+\.trade-policy$/,               { cap: 'trade.flows' }],
  [/^panel:\w+\.global-procurement$/,         { cap: 'procurement.tenders' }],
  [/^panel:\w+\.chat-analyst$/,               { cap: 'analyst.chat' }],
  [/^panel:\w+\.latest-brief$/,               { cap: 'digest.scheduled', note: 'latest brief panel' }],
  [/^panel:\w+\.forecast$/,                   { cap: 'scenario.engine', note: 'AI forecasts panel' }],
  [/^panel:\w+\.(cii|strategic-risk)$/,       { cap: 'risk.scores' }],
  [/^panel:\w+\.gdelt-intel$/,                { cap: 'intel.live' }],
  [/^panel:\w+\.supply-chain$/,               { cap: 'supplychain.chokepoints', note: 'panel' }],
  [/^panel:\w+\.oref-sirens$/,                { cap: 'alerts.sirens' }],
  [/^panel:\w+\.telegram-intel$/,             { cap: 'intel.telegram' }],
  [/^panel:\w+\.x-intel$/,                   { cap: 'intel.x_accounts' }],
];

const SITE_MAP = [
  // --- capabilities the hand-built ledger never found ---
  [/convex\/companyMonitoring\//,             { cap: 'monitoring.company', note: 'requires planKey!==free && tier>0' }],
  [/_shared\/direct-llm-quota\.ts/,           { cap: 'llm.direct_quota', note: 'entitlement-derived daily LLM ceiling' }],
  [/_shared\/embed-entitlement\.ts/,          { cap: 'embed.panels', note: 'apiAccess-gated embeddable panels' }],
  // --- false positive: data LOD tier, not an entitlement tier ---
  [/list-military-bases\.ts/,                 { exclude: 'meta.tier is a base-importance LOD tier for zoom filtering, NOT an entitlement tier' }],
  // --- server route enforcement points of already-mapped API paths ---
  [/server\/worldmonitor\/supply-chain\/v1\/(get-country-chokepoint-index|get-bypass-options)/, { cap: 'supplychain.chokepoints', note: 'enforcement point' }],
  [/server\/worldmonitor\/supply-chain\/v1\/(get-route-explorer-lane|get-route-impact)/,        { cap: 'supplychain.routes', note: 'enforcement point' }],
  [/server\/worldmonitor\/supply-chain\/v1\//,{ cap: 'supplychain.costshock', note: 'enforcement point' }],
  [/server\/worldmonitor\/trade\/v1\//,      { cap: 'trade.flows', note: 'enforcement point' }],
  [/server\/worldmonitor\/economic\/v1\/get-national-debt/, { cap: 'economic.debt', note: 'enforcement point' }],
  [/api\/me\/entitlement\.ts/,               { exclude: 'entitlement read endpoint — reports state, gates nothing' }],
  [/convex\/notificationChannels\.ts/,        { cap: 'notifications.channels' }],
  [/convex\/alertRules\.ts/,                  { cap: 'alerts.rules' }],
  [/api\/notification-channels\.ts/,          { cap: 'notifications.channels' }],
  [/api\/widget-agent\.ts/,                   { cap: 'widgets.custom' }],
  [/summarize-article\.ts/,                   { cap: 'news.summarization' }],
  [/gates\/playback/,                         { cap: 'playback.historical' }],
  [/convex\/apiKeys\.ts/,                     { cap: 'api.keys' }],
  [/pro-mcp-gate\.ts|mcp-grant|mcp-store|McpConnectModal|McpDataPanel|api\/mcp-proxy\.ts|api\/mcp\//, { cap: 'mcp.access' }],
  [/gates\/export/,                           { cap: 'export.data' }],
  [/analysis-framework-store\.ts/,            { cap: 'analysis.frameworks' }],
  [/correlation-engine\/engine\.ts/,          { cap: 'correlation.llm' }],
  [/followed-countries|followedCountries/,    { cap: 'limits.followed_countries' }],
  [/search-manager\.ts/,                      { cap: 'aviation.data', note: 'callsign search' }],
  [/ChatAnalystPanel|chat-analyst/,           { cap: 'analyst.chat' }],
  [/supply-chain\/index\.ts|RouteExplorer/,   { cap: 'supplychain.routes' }],
  [/services\/scenario\//,                    { cap: 'scenario.engine' }],
  [/sanctions-pressure/,                      { cap: 'sanctions.pressure' }],
  [/global-tenders/,                          { cap: 'procurement.tenders' }],
  [/stock-analysis|stock-backtest|insider-transactions/, { cap: 'markets.stock_analysis' }],
  [/DailyMarketBriefPanel|daily-market-brief/,{ cap: 'markets.brief' }],
  [/MarketImplicationsPanel/,                 { cap: 'markets.implications' }],
  [/LatestBriefPanel/,                        { cap: 'digest.scheduled' }],
  [/DeductionPanel|deduct-situation/,         { cap: 'intel.deduction' }],
  [/RegionalIntelligenceBoard/,               { cap: 'intel.regional' }],
  [/country-intel|CountryBriefPage|CountryDeepDivePanel/, { cap: 'intel.country_brief' }],
  [/services\/economic\//,                    { cap: 'economic.debt' }],
  [/services\/trade\//,                       { cap: 'trade.flows' }],
  [/threat-classifier|classify-gate/,         { cap: 'news.classification' }],
  [/summarization\.ts|summarize-gate/,        { cap: 'news.summarization' }],
  [/panels\.ts|panel-layout|panel-gating|Panel\.ts|PanelTabBar|settings-window|App\.ts|event-handlers/, { cap: 'limits.panels', note: 'cap + gate CTA plumbing' }],
  [/widget-store/,                            { cap: 'widgets.custom' }],
  [/entitlements|entitlement-check|entitlement-watchdog|premium-check|pro-entitlement|premium-fetch|premium-denial|premium-intent|wm-session|runtime\.ts|billing|checkout|payments\//, { exclude: 'entitlement plumbing — resolves/propagates state, gates nothing itself' }],
  [/UnifiedSettings|ProBanner|pro-banner-policy|ProActivation|MapPopup|DeckGLMap|MapContainer|InsightsPanel|follow-button|watchlist-modal|notifications-settings|data-loader|agent-bus-applier|CIIPanel|ResilienceWidget|SupplyChainPanel|WidgetChatModal|stock-analysis-targets|analytics|oauth|http\.ts|schema\.ts|constants\.ts|productCatalog|apiPlanLimitUsage|mcpProTokens|gateway\.ts|shipping/, { exclude: 'consumer of a gate mapped elsewhere — renders or forwards, does not define' }],
];


const all = [...rules, ...sites];
const caps = new Map(); const exclusions = []; const unmapped = [];
for (const r of all) {
  const table = r.source === 'site' ? SITE_MAP : MAP;
  const key   = r.source === 'site' ? r.file : r.rule;
  const hit = table.find(([re]) => re.test(key));
  if (!hit) { unmapped.push(r); continue; }
  const v = hit[1];
  if (v.exclude) { exclusions.push({ rule: r.rule, reason: v.exclude }); continue; }
  if (!caps.has(v.cap)) caps.set(v.cap, { id: v.cap, rules: [] });
  caps.get(v.cap).rules.push({ rule: r.rule, detail: r.detail, note: v.note });
}

const payload = {
  _generated: 'scripts/generate-entitlement-crosswalk.mjs — build artifact; do not edit',
  commit: (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { return null; } })(),
  missingSources,
  totals: { rawRules: all.length, capabilities: caps.size, exclusions: exclusions.length, unmappedGates: unmapped.length },
  capabilities: [...caps.values()].sort((a, b) => a.id.localeCompare(b.id)),
  exclusions,
  unmapped,
};

if (process.argv.includes('--check')) {
  const { rawRules, capabilities, exclusions: ex, unmappedGates } = payload.totals;
  console.log(`raw rules ${rawRules} · capabilities ${capabilities} · exclusions ${ex} · unmappedGates ${unmappedGates}`);
  if (missingSources.length) {
    console.error(`\nMISSING SOURCES (${missingSources.length}) — this tree does not match the generator's expectations:`);
    for (const m of missingSources) console.error(`  ${m}`);
    console.error('Refusing to certify a partial sweep.');
    process.exit(2);
  }
  if (unmappedGates > 0) {
    console.error('\nUNMAPPED GATES — classify each in MAP/SITE_MAP with a capability id or an exclusion reason:');
    for (const u of unmapped) console.error(`  ${u.rule}  ${(u.detail || '').slice(0, 100)}`);
    process.exit(1);
  }
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
console.log(`${OUT}  —  ${payload.totals.rawRules} rules → ${payload.totals.capabilities} capabilities, ${payload.totals.exclusions} excluded, unmappedGates ${payload.totals.unmappedGates}`);
