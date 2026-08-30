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
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

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
  // Predicate kind is part of the identity. Keying on filename alone let a NEW
  // gate of a different kind inside an already-mapped file inherit that file's
  // capability silently — a real blind spot found in review.
  const pred =
      /features\.apiAccess/.test(t)  ? 'apiAccess'
    : /features\.mcpAccess/.test(t)  ? 'mcpAccess'
    : /features\.dataExport/.test(t) ? 'dataExport'
    : /requiresPremium/.test(t)      ? 'requiresPremium'
    : /isCallerPremium\(/.test(t)    ? 'isCallerPremium'
    : /hasPremiumAccess\(\)/.test(t)  ? 'hasPremiumAccess'
    : /isProUser\(\)/.test(t)         ? 'isProUser'
    : /features\.tier|tier\s*[<>]=?\s*1/.test(t) ? 'tier'
    : 'other';
  sites.push({ rule: `site:${file}:${line}`, source: 'site', file, line: +line, pred, detail: t.slice(0, 130) });
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
  [/:\/api\/scorecard\/v1\//,                             { cap: 'resilience.scores', note: 'five-factor scorecards' }],
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
  [/convex\/companyMonitoring\//,             { cap: 'monitoring.company', note: 'requires planKey!==free && tier>0' , preds: ['tier'] }],
  [/_shared\/direct-llm-quota\.ts/,           { cap: 'llm.direct_quota', note: 'entitlement-derived daily LLM ceiling' , preds: ['tier'] }],
  [/_shared\/embed-entitlement\.ts/,          { cap: 'embed.panels', note: 'apiAccess-gated embeddable panels' , preds: ['apiAccess'] }],
  // --- false positive: data LOD tier, not an entitlement tier ---
  [/list-military-bases\.ts/,                 { exclude: 'meta.tier is a base-importance LOD tier for zoom filtering, NOT an entitlement tier' , preds: ['tier'] }],
  // --- server route enforcement points of already-mapped API paths ---
  [/server\/worldmonitor\/supply-chain\/v1\/(get-country-chokepoint-index|get-bypass-options)/, { cap: 'supplychain.chokepoints', note: 'enforcement point' , preds: ['isCallerPremium'] }],
  [/server\/worldmonitor\/supply-chain\/v1\/(get-route-explorer-lane|get-route-impact)/,        { cap: 'supplychain.routes', note: 'enforcement point' , preds: ['isCallerPremium'] }],
  [/server\/worldmonitor\/supply-chain\/v1\//,{ cap: 'supplychain.costshock', note: 'enforcement point' , preds: ['isCallerPremium'] }],
  [/server\/worldmonitor\/trade\/v1\//,      { cap: 'trade.flows', note: 'enforcement point' , preds: ['isCallerPremium'] }],
  [/server\/worldmonitor\/economic\/v1\/get-national-debt/, { cap: 'economic.debt', note: 'enforcement point' , preds: ['isCallerPremium'] }],
  [/api\/me\/entitlement\.ts/,               { exclude: 'entitlement read endpoint — reports state, gates nothing' , preds: ['isCallerPremium'] }],
  [/convex\/notificationChannels\.ts/,        { cap: 'notifications.channels' , preds: ['tier'] }],
  [/convex\/alertRules\.ts/,                  { cap: 'alerts.rules' , preds: ['tier'] }],
  [/api\/notification-channels\.ts/,          { cap: 'notifications.channels' , preds: ['tier'] }],
  [/api\/widget-agent\.ts/,                   { cap: 'widgets.custom' , preds: ['tier'] }],
  [/summarize-article\.ts/,                   { cap: 'news.summarization' , preds: ['requiresPremium'] }],
  [/gates\/playback/,                         { cap: 'playback.historical' }], // NOTE: matches no current gate
  [/convex\/apiKeys\.ts/,                     { cap: 'api.keys' , preds: ['apiAccess'] }],
  [/pro-mcp-gate\.ts|api\/mcp-proxy\.ts|api\/mcp\//, { cap: 'mcp.access' , preds: ['isCallerPremium','mcpAccess','tier'] }],
  [/gates\/export/,                           { cap: 'export.data' , preds: ['dataExport'] }],
  [/analysis-framework-store\.ts/,            { cap: 'analysis.frameworks' , preds: ['hasPremiumAccess'] }],
  [/correlation-engine\/engine\.ts/,          { cap: 'correlation.llm' , preds: ['hasPremiumAccess'] }],
  [/followedCountries/,    { cap: 'limits.followed_countries' , preds: ['tier'] }],
  [/search-manager\.ts/,                      { cap: 'aviation.data', note: 'callsign search' }], // NOTE: matches no current gate
  [/ChatAnalystPanel|chat-analyst/,           { cap: 'analyst.chat' }], // NOTE: matches no current gate
  [/supply-chain\/index\.ts/,   { cap: 'supplychain.routes' , preds: ['hasPremiumAccess'] }],
  [/services\/scenario\//,                    { cap: 'scenario.engine' }], // NOTE: matches no current gate
  [/sanctions-pressure/,                      { cap: 'sanctions.pressure' , preds: ['hasPremiumAccess','isCallerPremium'] }],
  [/global-tenders/,                          { cap: 'procurement.tenders' }], // NOTE: matches no current gate
  [/stock-analysis|stock-backtest|insider-transactions/, { cap: 'markets.stock_analysis' }], // NOTE: matches no current gate
  [/DailyMarketBriefPanel|daily-market-brief/,{ cap: 'markets.brief' }], // NOTE: matches no current gate
  [/MarketImplicationsPanel/,                 { cap: 'markets.implications' }], // NOTE: matches no current gate
  [/LatestBriefPanel/,                        { cap: 'digest.scheduled' }], // NOTE: matches no current gate
  [/deduct-situation/,         { cap: 'intel.deduction' , preds: ['isCallerPremium'] }],
  [/RegionalIntelligenceBoard/,               { cap: 'intel.regional' , preds: ['hasPremiumAccess'] }],
  [/country-intel/, { cap: 'intel.country_brief' , preds: ['isCallerPremium'] }],
  [/services\/economic\//,                    { cap: 'economic.debt' , preds: ['hasPremiumAccess'] }],
  [/services\/trade\//,                       { cap: 'trade.flows' }], // NOTE: matches no current gate
  [/threat-classifier|classify-gate/,         { cap: 'news.classification' }], // NOTE: matches no current gate
  [/summarization\.ts|summarize-gate/,        { cap: 'news.summarization' }], // NOTE: matches no current gate
  [/panel-layout|settings-window|event-handlers/, { cap: 'limits.panels', note: 'cap + gate CTA plumbing' , preds: ['hasPremiumAccess','isProUser'] }],
  [/widget-store/,                            { cap: 'widgets.custom' }], // NOTE: matches no current gate
  [/entitlements|entitlement-check|premium-check|pro-entitlement|billing|payments\//, { exclude: 'entitlement plumbing — resolves/propagates state, gates nothing itself' , preds: ['apiAccess','isCallerPremium','tier'] }],
  [/UnifiedSettings|data-loader|http\.ts|apiPlanLimitUsage|mcpProTokens|gateway\.ts|shipping/, { exclude: 'consumer of a gate mapped elsewhere — renders or forwards, does not define' , preds: ['apiAccess','hasPremiumAccess','isCallerPremium','isProUser','mcpAccess','tier'] }],
];


/**
 * Resolve one raw rule to a capability id or an exclusion.
 *
 * Exported so tests can assert the property that matters: a gate of a DIFFERENT
 * kind, or in a file nobody mapped, must come back unmapped rather than
 * inheriting a neighbour's capability. Keying sites on filename alone used to
 * break that (a synthetic hasPremiumAccess() gate in src/App.ts was silently
 * absorbed into limits.panels); identity is now file + predicate kind.
 */
export function classify(rule) {
  const table = rule.source === 'site' ? SITE_MAP : MAP;
  const key   = rule.source === 'site' ? rule.file : rule.rule;
  const hit = table.find(([re, v]) =>
    re.test(key) && (rule.source !== 'site' || !v.preds || v.preds.includes(rule.pred)));
  return hit ? hit[1] : null;
}

export { MAP, SITE_MAP, SITE_BASELINE };

/**
 * Compare observed (file::predicate) gate counts against the pinned baseline.
 *
 * Pure so the negative test can drive it directly. This is the guard that
 * catches a SECOND gate of the SAME kind in the SAME file — the case (file,
 * predicate) identity alone cannot see, demonstrated in review by adding an
 * unrelated hasPremiumAccess() call to a file already mapped for it.
 */
export function diffSiteCounts(actual, baseline = SITE_BASELINE) {
  const drift = [];
  for (const k of new Set([...Object.keys(baseline), ...Object.keys(actual)])) {
    const was = baseline[k] ?? 0, now = actual[k] ?? 0;
    if (was !== now) drift.push({ key: k, was, now });
  }
  return drift;
}

// Site COUNT baseline. (file, predicate) identity still cannot tell a second
// gate of the same kind in the same file from the first — review demonstrated
// that by adding an unrelated hasPremiumAccess() call to panel-layout.ts and
// watching the sweep stay green. Pinning the expected count closes it: any
// added or removed gate changes a count and must be re-baselined deliberately.
const SITE_BASELINE = {
  "api/mcp-proxy.ts::isCallerPremium": 1,
  "api/mcp/skill-extension/generated.ts::tier": 1,
  "api/me/entitlement.ts::isCallerPremium": 1,
  "api/notification-channels.ts::tier": 1,
  "api/v2/shipping/webhooks/[subscriberId].ts::isCallerPremium": 1,
  "api/v2/shipping/webhooks/[subscriberId]/[action].ts::isCallerPremium": 1,
  "api/widget-agent.ts::tier": 1,
  "convex/alertRules.ts::tier": 1,
  "convex/apiKeys.ts::apiAccess": 1,
  "convex/apiPlanLimitUsage.ts::apiAccess": 1,
  "convex/apiPlanLimitUsage.ts::mcpAccess": 1,
  "convex/apiPlanLimitUsage.ts::tier": 1,
  "convex/companyMonitoring/_shared.ts::tier": 1,
  "convex/companyMonitoring/accounts.ts::tier": 1,
  "convex/followedCountries.ts::tier": 2,
  "convex/http.ts::apiAccess": 1,
  "convex/http.ts::mcpAccess": 1,
  "convex/http.ts::tier": 3,
  "convex/mcpProTokens.ts::tier": 1,
  "convex/notificationChannels.ts::tier": 1,
  "convex/payments/billing.ts::tier": 1,
  "server/_shared/direct-llm-quota.ts::tier": 1,
  "server/_shared/embed-entitlement.ts::apiAccess": 1,
  "server/_shared/entitlement-check.ts::tier": 1,
  "server/_shared/premium-check.ts::apiAccess": 1,
  "server/_shared/premium-check.ts::isCallerPremium": 1,
  "server/_shared/premium-check.ts::tier": 2,
  "server/_shared/pro-entitlement.ts::tier": 1,
  "server/_shared/pro-mcp-gate.ts::mcpAccess": 2,
  "server/_shared/pro-mcp-gate.ts::tier": 1,
  "server/gateway.ts::apiAccess": 3,
  "server/gateway.ts::tier": 5,
  "server/worldmonitor/economic/v1/get-national-debt.ts::isCallerPremium": 1,
  "server/worldmonitor/intelligence/v1/deduct-situation.ts::isCallerPremium": 1,
  "server/worldmonitor/intelligence/v1/get-country-intel-brief.ts::isCallerPremium": 1,
  "server/worldmonitor/military/v1/list-military-bases.ts::tier": 1,
  "server/worldmonitor/news/v1/summarize-article.ts::requiresPremium": 2,
  "server/worldmonitor/sanctions/v1/list-sanctions-pressure.ts::isCallerPremium": 1,
  "server/worldmonitor/supply-chain/v1/get-bypass-options.ts::isCallerPremium": 1,
  "server/worldmonitor/supply-chain/v1/get-country-chokepoint-index.ts::isCallerPremium": 1,
  "server/worldmonitor/supply-chain/v1/get-country-cost-shock.ts::isCallerPremium": 1,
  "server/worldmonitor/supply-chain/v1/get-country-products.ts::isCallerPremium": 1,
  "server/worldmonitor/supply-chain/v1/get-multi-sector-cost-shock.ts::isCallerPremium": 1,
  "server/worldmonitor/supply-chain/v1/get-route-explorer-lane.ts::isCallerPremium": 1,
  "server/worldmonitor/supply-chain/v1/get-route-impact.ts::isCallerPremium": 1,
  "server/worldmonitor/supply-chain/v1/get-sector-dependency.ts::isCallerPremium": 1,
  "server/worldmonitor/trade/v1/get-tariff-trends.ts::isCallerPremium": 1,
  "server/worldmonitor/trade/v1/list-comtrade-flows.ts::isCallerPremium": 1,
  "src/app/data-loader.ts::hasPremiumAccess": 10,
  "src/app/event-handlers.ts::isProUser": 2,
  "src/app/panel-layout.ts::hasPremiumAccess": 1,
  "src/components/RegionalIntelligenceBoard.ts::hasPremiumAccess": 1,
  "src/components/UnifiedSettings.ts::isProUser": 1,
  "src/services/analysis-framework-store.ts::hasPremiumAccess": 1,
  "src/services/correlation-engine/engine.ts::hasPremiumAccess": 1,
  "src/services/economic/index.ts::hasPremiumAccess": 1,
  "src/services/entitlements.ts::tier": 1,
  "src/services/gates/export-resolver.ts::dataExport": 4,
  "src/services/gates/export.ts::dataExport": 1,
  "src/services/sanctions-pressure.ts::hasPremiumAccess": 1,
  "src/services/supply-chain/index.ts::hasPremiumAccess": 8,
  "src/settings-window.ts::isProUser": 1
};

const all = [...rules, ...sites];
const caps = new Map(); const exclusions = []; const unmapped = [];
for (const r of all) {
  const v = classify(r);
  if (!v) { unmapped.push(r); continue; }
  if (v.exclude) { exclusions.push({ rule: r.rule, reason: v.exclude }); continue; }
  if (!caps.has(v.cap)) caps.set(v.cap, { id: v.cap, rules: [] });
  caps.get(v.cap).rules.push({ rule: r.rule, detail: r.detail, note: v.note });
}

const actualCounts = {};
for (const st of sites) { const k = `${st.file}::${st.pred}`; actualCounts[k] = (actualCounts[k] || 0) + 1; }
const countDrift = diffSiteCounts(actualCounts);

const payload = {
  _generated: 'scripts/generate-entitlement-crosswalk.mjs — build artifact; do not edit',
  commit: (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { return null; } })(),
  missingSources,
  countDrift,
  totals: { rawRules: all.length, capabilities: caps.size, exclusions: exclusions.length, unmappedGates: unmapped.length },
  capabilities: [...caps.values()].sort((a, b) => a.id.localeCompare(b.id)),
  exclusions,
  unmapped,
};

// Importing this module must not write files or exit — tests import `classify`.
const isCli = argv[1] && fileURLToPath(import.meta.url) === argv[1];
if (!isCli) { /* imported as a library */ }
else if (process.argv.includes('--check')) {
  const { rawRules, capabilities, exclusions: ex, unmappedGates } = payload.totals;
  console.log(`raw rules ${rawRules} · capabilities ${capabilities} · exclusions ${ex} · unmappedGates ${unmappedGates} · countDrift ${countDrift.length}`);
  if (countDrift.length) {
    console.error('\nGATE COUNT DRIFT — a gate was added or removed. Classify it, then re-baseline with --rebaseline:');
    for (const d of countDrift) console.error(`  ${d.key}: expected ${d.was}, found ${d.now}`);
    process.exit(1);
  }
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

else if (process.argv.includes('--rebaseline')) {
  const counts = {};
  for (const st of sites) { const k = `${st.file}::${st.pred}`; counts[k] = (counts[k] || 0) + 1; }
  const self = fileURLToPath(import.meta.url);
  const body = readFileSync(self, 'utf8');
  const literal = JSON.stringify(counts, Object.keys(counts).sort(), 2);
  writeFileSync(self, body.replace(/const SITE_BASELINE = [\s\S]*?;\n/, `const SITE_BASELINE = ${literal};\n`));
  console.log(`re-baselined ${Object.keys(counts).length} (file, predicate) groups`);
}
else {
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
console.log(`${OUT}  —  ${payload.totals.rawRules} rules → ${payload.totals.capabilities} capabilities, ${payload.totals.exclusions} excluded, unmappedGates ${payload.totals.unmappedGates}`);
}
