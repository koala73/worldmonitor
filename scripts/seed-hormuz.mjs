#!/usr/bin/env node
// seed-hormuz.mjs — Strait of Hormuz Trade Tracker
//
// Scrapes the WTO DataLab Hormuz Trade Tracker page (daily AXSMarine data)
// and writes key insights + time-series charts to Redis.
//
// Source: WTO DataLab / AXSMarine
//   https://datalab.wto.org/Strait-of-Hormuz-Trade-Tracker
//
// Redis key: supply_chain:hormuz_tracker:v1
// Cron: every 24 hours (0 6 * * *)
// TTL: 108000s (30h — daily + 6h buffer)
// Chart window: last 30 days

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'supply_chain:hormuz_tracker:v1';
const CACHE_TTL = 108000; // 30h
const WTO_URL = 'https://datalab.wto.org/Strait-of-Hormuz-Trade-Tracker';

// Power BI public report (no auth — public report)
const WABI_BASE = 'https://wabi-europe-north-b-api.analysis.windows.net';
const REPORT_UUID = '29f48db4-4a50-4386-bba1-bd9aef2809ae';

const CHART_CONFIGS = [
  { label: 'crude_oil_outbound',  title: 'Crude Oil Outbound Shipments',  containerIndex: 0, projections: [1, 2, 3, 0] },
  { label: 'lng_outbound',        title: 'LNG Outbound Shipments',        containerIndex: 1, projections: [0, 1, 2, 3] },
  { label: 'fertilizer_outbound', title: 'Fertilizer Outbound Shipments', containerIndex: 2, projections: [1, 2, 3, 0] },
  { label: 'agriculture_inbound', title: 'Agriculture Inbound Shipments', containerIndex: 3, projections: [0, 1, 2, 3] },
];

// DSR (Delta Serialization) format decoder.
// R is a bitmask — bit N set means col N carries over from the previous row.
// Remaining values come from C[] in order.
function decodeDsr(dsr, nCols) {
  const rows = [];
  let prev = Array(nCols).fill(null);
  const dm = dsr?.DS?.[0]?.PH?.[0]?.DM0 ?? [];
  for (const record of dm) {
    const mask = record.R ?? 0;
    const cv = [...(record.C ?? [])];
    const row = [];
    let ci = 0;
    for (let col = 0; col < nCols; col++) {
      row.push(mask & (1 << col) ? prev[col] : (cv[ci++] ?? null));
    }
    prev = [...row];
    rows.push(row);
  }
  return rows;
}

async function pbiJson(url, init = {}) {
  const resp = await fetch(url, {
    ...init,
    headers: {
      'X-PowerBI-ResourceKey': REPORT_UUID,
      'Content-Type': 'application/json',
      'User-Agent': CHROME_UA,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Power BI ${resp.status} at ${url}`);
  return resp.json();
}

async function fetchPbiCharts() {
  console.log('  Fetching Power BI model schema...');

  const modelData = await pbiJson(
    `${WABI_BASE}/public/reports/${REPORT_UUID}/modelsAndExploration?preferReadOnlySession=true`,
  );

  const exploration = modelData?.exploration;
  const sections = exploration?.sections ?? [];
  const allContainers = [];
  for (const section of sections) {
    allContainers.push(...(section.visualContainers ?? []));
  }

  const modelId = modelData?.models?.[0]?.id;
  if (!modelId) throw new Error('Could not find Power BI modelId');
  console.log(`  Model ID: ${modelId}, containers: ${allContainers.length}`);

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const charts = [];

  for (const cfg of CHART_CONFIGS) {
    const container = allContainers[cfg.containerIndex];
    if (!container) {
      console.warn(`  No container at index ${cfg.containerIndex} for ${cfg.label}`);
      charts.push({ label: cfg.label, title: cfg.title, series: [] });
      continue;
    }

    let prototypeQuery;
    try {
      const configObj = typeof container.config === 'string'
        ? JSON.parse(container.config)
        : container.config;
      prototypeQuery = configObj?.singleVisual?.prototypeQuery;
    } catch {
      prototypeQuery = null;
    }

    if (!prototypeQuery) {
      console.warn(`  No prototypeQuery for ${cfg.label}`);
      charts.push({ label: cfg.label, title: cfg.title, series: [] });
      continue;
    }

    const queryPayload = {
      version: '1.0.0',
      queries: [
        {
          Query: {
            Commands: [
              {
                SemanticQueryDataShapeCommand: {
                  Query: prototypeQuery,
                  Binding: {
                    Primary: { Groupings: [{ Projections: cfg.projections }] },
                    DataReduction: { DataVolume: 4, Primary: { BinnedLineSample: {} } },
                    Version: 1,
                  },
                },
              },
            ],
          },
          QueryId: '',
          ApplicationContext: {
            DatasetId: '',
            Sources: [{ ReportId: REPORT_UUID, VisualId: container.name ?? '' }],
          },
        },
      ],
      cancelQueries: [],
      modelId,
    };

    console.log(`  Querying ${cfg.label}...`);
    let result;
    try {
      result = await pbiJson(
        `${WABI_BASE}/public/reports/querydata?synchronous=true`,
        { method: 'POST', body: JSON.stringify(queryPayload) },
      );
    } catch (e) {
      console.warn(`  Query failed for ${cfg.label}: ${e.message}`);
      charts.push({ label: cfg.label, title: cfg.title, series: [] });
      continue;
    }

    const dsr = result?.results?.[0]?.result?.data?.dsr;
    const rows = decodeDsr(dsr, 4); // [Year, Month, Day, Value] always 4 cols after projection

    const series = rows
      .map(row => {
        const [yr, mo, dy, val] = row;
        if (!yr || !mo || !dy) return null;
        const dateStr = `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
        const d = new Date(dateStr);
        if (isNaN(d.getTime()) || d < cutoff) return null;
        return { date: dateStr, value: typeof val === 'number' ? val : (Number(val) || 0) };
      })
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));

    console.log(`  ${cfg.label}: ${series.length} points (last 30d)`);
    charts.push({ label: cfg.label, title: cfg.title, series });
  }

  return charts;
}

// Decode common HTML entities in scraped text.
function decodeHtmlEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8220;/g, '\u201c')
    .replace(/&#8221;/g, '\u201d');
}

function stripTags(s) {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function deriveStatus(text) {
  const lc = text.toLowerCase();
  if (/\bclosed\b|\bclosure\b/.test(lc)) return 'closed';
  if (/disrupted|disruption|halt|standstill/.test(lc)) return 'disrupted';
  if (/restricted|congested|tension|heightened/.test(lc)) return 'restricted';
  return 'open';
}

async function scrapeWtoPage() {
  console.log(`  Fetching ${WTO_URL}`);

  const resp = await fetch(WTO_URL, {
    headers: {
      'User-Agent': CHROME_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching WTO Hormuz page`);
  const html = await resp.text();

  // --- Date of latest insights ---
  const dateM = html.match(/<time[^>]*>(.*?)<\/time>/);
  const updatedDate = dateM ? stripTags(dateM[1]) : null;

  // --- "Latest insights" summary blurb (above "See key insights" link) ---
  const liM = html.match(/Latest insights([\s\S]*?)See key insights/);
  let summary = null;
  if (liM) {
    const chunk = liM[1];
    const afterTime = chunk.includes('</time>') ? chunk.slice(chunk.indexOf('</time>') + 7) : chunk;
    const text = stripTags(afterTime);
    summary = text || null;
  }

  // --- Title of latest strategic insight (bold text) ---
  const titleM = html.match(/<strong[^>]*>(Strategic Trade Insight:[\s\S]*?)<\/strong>/);
  const title = titleM ? stripTags(titleM[1]) : null;

  // --- Full body paragraphs of the insight ---
  const paragraphs = [];
  if (title) {
    const startIdx = html.indexOf('Strategic Trade Insight:');
    const chunk = html.slice(startIdx);
    const paraRe = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = paraRe.exec(chunk)) !== null && paragraphs.length < 5) {
      const text = stripTags(m[1]);
      if (text.length > 30 && !text.startsWith('* AIS')) {
        paragraphs.push(text);
      }
    }
  }

  const combined = [title, summary, ...paragraphs].filter(Boolean).join(' ');
  const status = deriveStatus(combined);

  if (!updatedDate && !summary && !title) {
    throw new Error('No content parsed from WTO Hormuz page — possible structure change');
  }

  console.log(`  Date: ${updatedDate}`);
  console.log(`  Status: ${status}`);
  console.log(`  Title: ${title?.slice(0, 80)}...`);

  return { updatedDate, title, summary, paragraphs, status };
}

async function buildPayload() {
  const [page, charts] = await Promise.all([
    scrapeWtoPage(),
    fetchPbiCharts().catch(e => {
      console.warn(`  Power BI charts failed (non-fatal): ${e.message}`);
      return [];
    }),
  ]);

  return {
    fetchedAt: Date.now(),
    updatedDate: page.updatedDate,
    title: page.title,
    summary: page.summary,
    paragraphs: page.paragraphs,
    status: page.status,
    charts,
    attribution: {
      source: 'WTO DataLab / AXSMarine',
      url: WTO_URL,
    },
  };
}

await runSeed('supply_chain', 'hormuz_tracker', CANONICAL_KEY, buildPayload, {
  ttlSeconds: CACHE_TTL,
  validateFn: (d) => !!(d?.updatedDate || d?.summary || d?.title) && d?.charts?.some(c => (c.series?.length ?? 0) > 0),
});
