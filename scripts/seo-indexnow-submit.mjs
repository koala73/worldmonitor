#!/usr/bin/env node
/**
 * Submit all worldmonitor.app URLs to IndexNow after deploy.
 * Run once after deploying the IndexNow key file:
 *   node scripts/seo-indexnow-submit.mjs
 */

const KEY = 'a7f3e9d1b2c44e8f9a0b1c2d3e4f5a6b';
const HOST = 'www.worldmonitor.app';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;

const URLS = [
  'https://www.worldmonitor.app/',
  'https://www.worldmonitor.app/pro',
  'https://www.worldmonitor.app/blog/',
  'https://tech.worldmonitor.app/',
  'https://finance.worldmonitor.app/',
  'https://happy.worldmonitor.app/',
  'https://www.worldmonitor.app/blog/posts/what-is-worldmonitor-real-time-global-intelligence/',
  'https://www.worldmonitor.app/blog/posts/five-dashboards-one-platform-worldmonitor-variants/',
  'https://www.worldmonitor.app/blog/posts/track-global-conflicts-in-real-time/',
  'https://www.worldmonitor.app/blog/posts/cyber-threat-intelligence-for-security-teams/',
  'https://www.worldmonitor.app/blog/posts/osint-for-everyone-open-source-intelligence-democratized/',
  'https://www.worldmonitor.app/blog/posts/natural-disaster-monitoring-earthquakes-fires-volcanoes/',
  'https://www.worldmonitor.app/blog/posts/real-time-market-intelligence-for-traders-and-analysts/',
  'https://www.worldmonitor.app/blog/posts/monitor-global-supply-chains-and-commodity-disruptions/',
  'https://www.worldmonitor.app/blog/posts/satellite-imagery-orbital-surveillance/',
  'https://www.worldmonitor.app/blog/posts/live-webcams-from-geopolitical-hotspots/',
  'https://www.worldmonitor.app/blog/posts/prediction-markets-ai-forecasting-geopolitics/',
  'https://www.worldmonitor.app/blog/posts/command-palette-search-everything-instantly/',
  'https://www.worldmonitor.app/blog/posts/worldmonitor-in-21-languages-global-intelligence-for-everyone/',
  'https://www.worldmonitor.app/blog/posts/ai-powered-intelligence-without-the-cloud/',
  'https://www.worldmonitor.app/blog/posts/build-on-worldmonitor-developer-api-open-source/',
  'https://www.worldmonitor.app/blog/posts/worldmonitor-vs-traditional-intelligence-tools/',
  'https://www.worldmonitor.app/blog/posts/tracking-global-trade-routes-chokepoints-freight-costs/',
];

const ENDPOINTS = [
  'https://api.indexnow.org/IndexNow',
  'https://www.bing.com/IndexNow',
  'https://searchadvisor.naver.com/indexnow',
  'https://search.seznam.cz/indexnow',
  'https://yandex.com/indexnow',
];

async function submitBatch(endpoint) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: URLS }),
  });
  return { endpoint, status: res.status, ok: res.ok };
}

const results = await Promise.allSettled(ENDPOINTS.map(submitBatch));
for (const r of results) {
  if (r.status === 'fulfilled') {
    console.log(`${r.value.ok ? '✓' : '✗'} ${r.value.endpoint} → ${r.value.status}`);
  } else {
    console.log(`✗ error: ${r.reason}`);
  }
}
