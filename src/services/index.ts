// market: not re-exported (#4571) — eager service client; kept tree-shakeable out of main.js
export * from './prediction';
export * from './earthquakes';
export * from './clustering';
export * from './related-assets';
export * from './velocity';
export * from './storage';
export * from './correlation';
export * from './weather';
// economic is NOT re-exported here (#4571): it runs a module-load side effect
// (new EconomicServiceClient() + circuit breakers), so an `export *` re-export
// keeps it un-tree-shakeable in eager main.js. Its consumers import it directly
// (`@/services/economic`) or dynamically (data-loader), so it tree-shakes out.
export * from './infrastructure';
// cyber: not re-exported (#4649) — eager service client; kept tree-shakeable out of main.js
export * from './maritime';
// cable-activity: not re-exported (#4649) — eager service client; kept tree-shakeable out of main.js
export * from './cable-health';
export * from './conflict';
export * from './displacement';
// research: not re-exported (#4649) — eager service client; kept tree-shakeable out of main.js
export * from './wildfires';
export * from './climate';
export * from './unrest';
// aviation: not re-exported (#4571) — eager service client; kept tree-shakeable out of main.js
export * from './military-flights';
export * from './usni-fleet';
export * from './pizzint';
export * from './eonet';
export { analysisWorker } from './analysis-worker';
export { activityTracker } from './activity-tracker';
export * from './geo-convergence';
export * from './country-instability';
export * from './infrastructure-cascade';
export * from './data-freshness';
export * from './usa-spending';
export { generateSummary, translateText } from './summarization';
export * from './cached-theater-posture';
// trade: not re-exported (#4571) — eager service client; kept tree-shakeable out of main.js
// supply-chain: not re-exported (#4571 review) — eager service client; kept tree-shakeable out of main.js
export * from './radiation';
export * from './breaking-news-alerts';
export * from './sanctions-pressure';
export * from './thermal-escalation';
export * from './stock-analysis-history';
export * from './stock-backtest';
export * from './imagery';
