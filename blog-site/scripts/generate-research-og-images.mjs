// Operator-run OG-card generator for /research/ report editions. Renders a
// 1200x630 SVG card that shows the report's actual data (not a generic title
// card) and rasterizes it with sharp into the COMMITTED asset the corpus
// template references at /research-assets/<slug>-og.png. Run once per edition:
//
//   cd blog-site && node scripts/generate-research-og-images.mjs
//
// Lives beside generate-og-images.mjs because sharp is a blog-site dependency;
// like the snapshot producer, it is never part of the deterministic site build.

import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const OUT_DIR = join(REPO_ROOT, 'public', 'research-assets');
const WIDTH = 1200;
const HEIGHT = 630;

const { RESEARCH_REPORTS } = await import(
  join(REPO_ROOT, 'shared', 'research-reports', 'index.mjs')
);
// Reuse the site generator's aggregation so the OG card can never disagree
// with the published monthly figures.
const { computeMonthlyAverages } = await import(
  join(REPO_ROOT, 'scripts', 'build-research-reports.mjs')
);

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildCardSvg(report, snapshot) {
  const focus = snapshot.chokepoints[report.focusChokepointId];
  const partialMonth = focus.observationEnd.slice(0, 7);
  const months = computeMonthlyAverages(focus.history, '2025-07', partialMonth);
  const domainMax = 120;
  const chart = { x: 80, y: 300, width: 1040, height: 240 };
  const slot = chart.width / months.length;
  const barWidth = Math.floor(slot) - 10;

  const bars = months.map((row, index) => {
    const height = Math.max((row.avg / domainMax) * chart.height, 3);
    const x = chart.x + index * slot + 5;
    const y = chart.y + chart.height - height;
    const partial = row.month === partialMonth;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth}" height="${height.toFixed(1)}" rx="3" fill="#4ade80"${partial ? ' fill-opacity="0.55"' : ''}/>`;
  }).join('');

  const labels = months.map((row, index) => {
    const x = chart.x + index * slot + 5 + barWidth / 2;
    const [year, month] = row.month.split('-');
    const name = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(month) - 1];
    return `<text x="${x.toFixed(1)}" y="${chart.y + chart.height + 28}" text-anchor="middle" fill="#a8b8ad" font-size="17" font-family="Helvetica, Arial, sans-serif">${name}${month === '01' ? ` ’${year.slice(2)}` : ''}</text>`;
  }).join('');

  const feb = months.find((row) => row.month === '2026-02');
  const jul = months.find((row) => row.month === partialMonth);
  const febX = chart.x + months.indexOf(feb) * slot + 5 + barWidth / 2;
  const febY = chart.y + chart.height - (feb.avg / domainMax) * chart.height;
  const julX = chart.x + months.indexOf(jul) * slot + 5 + barWidth / 2;
  const julY = chart.y + chart.height - (jul.avg / domainMax) * chart.height;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#050807"/>
  <rect x="0" y="0" width="${WIDTH}" height="6" fill="#4ade80"/>
  <text x="80" y="96" fill="#4ade80" font-size="24" font-weight="700" letter-spacing="3" font-family="Helvetica, Arial, sans-serif">WORLD MONITOR RESEARCH</text>
  <text x="80" y="164" fill="#eef8f0" font-size="${report.title.length > 40 ? 44 : 54}" font-weight="700" font-family="Helvetica, Arial, sans-serif">${escapeXml(report.title)}</text>
  <text x="80" y="218" fill="#a8b8ad" font-size="28" font-family="Helvetica, Arial, sans-serif">Average daily transit calls by month — IMF PortWatch data through ${escapeXml(focus.observationEnd)}</text>
  ${bars}
  ${labels}
  <text x="${febX.toFixed(1)}" y="${(febY - 14).toFixed(1)}" text-anchor="middle" fill="#eef8f0" font-size="24" font-weight="700" font-family="Helvetica, Arial, sans-serif">${Math.round(feb.avg)}/day</text>
  <text x="${julX.toFixed(1)}" y="${(julY - 14).toFixed(1)}" text-anchor="middle" fill="#eef8f0" font-size="24" font-weight="700" font-family="Helvetica, Arial, sans-serif">${jul.avg.toFixed(1)}/day</text>
  <text x="1120" y="96" text-anchor="end" fill="#a8b8ad" font-size="22" font-family="Helvetica, Arial, sans-serif">v${escapeXml(report.version)} · ${escapeXml(report.datePublished)}</text>
</svg>`;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const report of RESEARCH_REPORTS) {
  const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, report.snapshotPath), 'utf8'));
  const svg = buildCardSvg(report, snapshot);
  const outPath = join(OUT_DIR, `${report.slug}-og.png`);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}
