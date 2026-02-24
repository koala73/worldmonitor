// Non-sebuf: returns XML/HTML, stays as standalone Vercel function
/**
 * Dynamic OG Image Generator for Story Sharing
 * Returns an SVG image (1200x630) — rich intelligence card for social previews.
 */

const COUNTRY_NAMES = {
  UA: 'Ukraine', RU: 'Russia', CN: 'China', US: 'United States',
  IR: 'Iran', IL: 'Israel', TW: 'Taiwan', KP: 'North Korea',
  SA: 'Saudi Arabia', TR: 'Turkey', PL: 'Poland', DE: 'Germany',
  FR: 'France', GB: 'United Kingdom', IN: 'India', PK: 'Pakistan',
  SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
};

const LEVEL_COLORS = {
  critical: '#ef4444', high: '#f97316', elevated: '#eab308',
  normal: '#22c55e', low: '#3b82f6',
};

const LEVEL_LABELS = {
  critical: 'CRITICAL INSTABILITY',
  high: 'HIGH INSTABILITY',
  elevated: 'ELEVATED INSTABILITY',
  normal: 'STABLE',
  low: 'LOW RISK',
};

function normalizeLevel(rawLevel) {
  const level = String(rawLevel || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_COLORS, level) ? level : 'normal';
}

export default function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const countryCode = (url.searchParams.get('c') || '').toUpperCase();
  const type = url.searchParams.get('t') || 'ciianalysis';
  const score = url.searchParams.get('s');
  const level = normalizeLevel(url.searchParams.get('l'));

  const countryName = COUNTRY_NAMES[countryCode] || countryCode || 'Global';
  const levelColor = LEVEL_COLORS[level] || '#eab308';
  const levelLabel = LEVEL_LABELS[level] || 'MONITORING';
  const parsedScore = score ? Number.parseInt(score, 10) : Number.NaN;
  const scoreNum = Number.isFinite(parsedScore)
    ? Math.max(0, Math.min(100, parsedScore))
    : null;
  const dateStr = new Date().toISOString().slice(0, 10);

  // Score arc (semicircle gauge)
  const arcRadius = 90;
  const arcCx = 960;
  const arcCy = 340;
  const scoreAngle = scoreNum !== null ? (scoreNum / 100) * Math.PI : 0;
  const arcEndX = arcCx - arcRadius * Math.cos(scoreAngle);
  const arcEndY = arcCy - arcRadius * Math.sin(scoreAngle);
  const largeArc = scoreNum > 50 ? 1 : 0;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0c0c18"/>
      <stop offset="100%" stop-color="#0a0a12"/>
    </linearGradient>
    <linearGradient id="sidebar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${levelColor}"/>
      <stop offset="100%" stop-color="${levelColor}88"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- Left accent sidebar -->
  <rect x="0" y="0" width="8" height="630" fill="url(#sidebar)"/>

  <!-- Top accent line -->
  <rect x="8" y="0" width="1192" height="3" fill="${levelColor}" opacity="0.4"/>

  <!-- Subtle grid -->
  <g opacity="0.03">
    ${Array.from({length: 30}, (_, i) => `<line x1="${i*40}" y1="0" x2="${i*40}" y2="630" stroke="#fff" stroke-width="1"/>`).join('\n    ')}
    ${Array.from({length: 16}, (_, i) => `<line x1="0" y1="${i*40}" x2="1200" y2="${i*40}" stroke="#fff" stroke-width="1"/>`).join('\n    ')}
  </g>

  <!-- WORLDMONITOR brand -->
  <text x="60" y="56" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="700" fill="${levelColor}" letter-spacing="6"
    >WORLDMONITOR</text>

  <!-- Status pill -->
  <rect x="290" y="38" width="${levelLabel.length * 9 + 24}" height="26" rx="13" fill="${levelColor}" opacity="0.15"/>
  <text x="${290 + (levelLabel.length * 9 + 24) / 2}" y="56" font-family="system-ui, sans-serif" font-size="13" font-weight="700" fill="${levelColor}" text-anchor="middle"
    >${levelLabel}</text>

  <!-- Date -->
  <text x="1140" y="56" font-family="system-ui, sans-serif" font-size="16" fill="#666" text-anchor="end"
    >${dateStr}</text>

  <!-- Separator -->
  <line x1="60" y1="76" x2="1140" y2="76" stroke="#222" stroke-width="1"/>

  <!-- Country name (large) -->
  <text x="60" y="160" font-family="system-ui, -apple-system, sans-serif" font-size="82" font-weight="800" fill="#ffffff" letter-spacing="-1"
    >${escapeXml(countryName.toUpperCase())}</text>

  <!-- Country code badge -->
  <rect x="1060" y="120" width="80" height="44" rx="8" fill="rgba(255,255,255,0.08)" stroke="${levelColor}" stroke-width="1" stroke-opacity="0.3"/>
  <text x="1100" y="150" font-family="system-ui, sans-serif" font-size="24" font-weight="700" fill="#aaa" text-anchor="middle"
    >${escapeXml(countryCode)}</text>

  <!-- Subtitle -->
  <text x="60" y="200" font-family="system-ui, sans-serif" font-size="22" fill="#666" letter-spacing="3"
    >INTELLIGENCE BRIEF</text>

  ${scoreNum !== null ? `
  <!-- LEFT COLUMN: Data cards -->
  <!-- CII Score large display -->
  <text x="60" y="310" font-family="system-ui, -apple-system, sans-serif" font-size="120" font-weight="800" fill="${levelColor}"
    >${scoreNum}</text>
  <text x="${60 + String(scoreNum).length * 68}" y="310" font-family="system-ui, sans-serif" font-size="48" fill="#555"
    >/100</text>
  <text x="60" y="345" font-family="system-ui, sans-serif" font-size="18" fill="#777" letter-spacing="4"
    >INSTABILITY INDEX</text>

  <!-- Score bar (full width left column) -->
  <rect x="60" y="370" width="560" height="12" rx="6" fill="#1a1a2e"/>
  <rect x="60" y="370" width="${Math.min(scoreNum, 100) * 5.6}" height="12" rx="6" fill="${levelColor}"/>

  <!-- Tick marks -->
  <line x1="200" y1="370" x2="200" y2="382" stroke="#333" stroke-width="1"/>
  <line x1="340" y1="370" x2="340" y2="382" stroke="#333" stroke-width="1"/>
  <line x1="480" y1="370" x2="480" y2="382" stroke="#333" stroke-width="1"/>
  <text x="60" y="402" font-family="system-ui, sans-serif" font-size="12" fill="#555">0</text>
  <text x="197" y="402" font-family="system-ui, sans-serif" font-size="12" fill="#555">25</text>
  <text x="334" y="402" font-family="system-ui, sans-serif" font-size="12" fill="#555">50</text>
  <text x="474" y="402" font-family="system-ui, sans-serif" font-size="12" fill="#555">75</text>
  <text x="600" y="402" font-family="system-ui, sans-serif" font-size="12" fill="#555">100</text>

  <!-- RIGHT COLUMN: Score arc gauge -->
  <!-- Arc background -->
  <path d="M ${arcCx - arcRadius},${arcCy} A ${arcRadius} ${arcRadius} 0 1 1 ${arcCx + arcRadius},${arcCy}"
    fill="none" stroke="#1a1a2e" stroke-width="16" stroke-linecap="round"/>
  <!-- Arc fill -->
  ${scoreNum > 0 ? `<path d="M ${arcCx + arcRadius},${arcCy} A ${arcRadius} ${arcRadius} 0 ${largeArc} 0 ${arcEndX.toFixed(1)},${arcEndY.toFixed(1)}"
    fill="none" stroke="${levelColor}" stroke-width="16" stroke-linecap="round"/>` : ''}
  <!-- Score in center of arc -->
  <text x="${arcCx}" y="${arcCy - 20}" font-family="system-ui, -apple-system, sans-serif" font-size="52" font-weight="800" fill="${levelColor}" text-anchor="middle"
    >${scoreNum}</text>
  <text x="${arcCx}" y="${arcCy + 10}" font-family="system-ui, sans-serif" font-size="18" fill="#888" text-anchor="middle"
    >/100</text>

  <!-- Level badge under arc -->
  <rect x="${arcCx - (level.length * 10 + 20) / 2}" y="${arcCy + 24}" width="${level.length * 10 + 20}" height="30" rx="6" fill="${levelColor}"/>
  <text x="${arcCx}" y="${arcCy + 45}" font-family="system-ui, sans-serif" font-size="16" font-weight="700" fill="#fff" text-anchor="middle"
    >${level.toUpperCase()}</text>

  <!-- Data indicators row -->
  <line x1="60" y1="430" x2="1140" y2="430" stroke="#222" stroke-width="1"/>

  <rect x="60" y="448" width="10" height="10" rx="2" fill="#ef4444"/>
  <text x="80" y="458" font-family="system-ui, sans-serif" font-size="15" fill="#aaa">Threat Classification</text>

  <rect x="260" y="448" width="10" height="10" rx="2" fill="#f97316"/>
  <text x="280" y="458" font-family="system-ui, sans-serif" font-size="15" fill="#aaa">Military Posture</text>

  <rect x="440" y="448" width="10" height="10" rx="2" fill="#eab308"/>
  <text x="460" y="458" font-family="system-ui, sans-serif" font-size="15" fill="#aaa">Prediction Markets</text>

  <rect x="650" y="448" width="10" height="10" rx="2" fill="#8b5cf6"/>
  <text x="670" y="458" font-family="system-ui, sans-serif" font-size="15" fill="#aaa">Signal Convergence</text>

  <rect x="860" y="448" width="10" height="10" rx="2" fill="#3b82f6"/>
  <text x="880" y="458" font-family="system-ui, sans-serif" font-size="15" fill="#aaa">Active Signals</text>

  ` : `
  <!-- No score available — show feature overview -->
  <text x="60" y="290" font-family="system-ui, -apple-system, sans-serif" font-size="40" fill="#ddd" font-weight="600"
    >Real-time intelligence analysis</text>

  <line x1="60" y1="320" x2="1140" y2="320" stroke="#222" stroke-width="1"/>

  <!-- Feature cards -->
  <rect x="60" y="345" width="250" height="80" rx="8" fill="#111" stroke="#222" stroke-width="1"/>
  <text x="80" y="375" font-family="system-ui, sans-serif" font-size="16" fill="${levelColor}" font-weight="700">Instability Index</text>
  <text x="80" y="400" font-family="system-ui, sans-serif" font-size="13" fill="#888">20 countries monitored</text>

  <rect x="330" y="345" width="250" height="80" rx="8" fill="#111" stroke="#222" stroke-width="1"/>
  <text x="350" y="375" font-family="system-ui, sans-serif" font-size="16" fill="#f97316" font-weight="700">Military Tracking</text>
  <text x="350" y="400" font-family="system-ui, sans-serif" font-size="13" fill="#888">Live flights &amp; vessels</text>

  <rect x="600" y="345" width="250" height="80" rx="8" fill="#111" stroke="#222" stroke-width="1"/>
  <text x="620" y="375" font-family="system-ui, sans-serif" font-size="16" fill="#eab308" font-weight="700">Prediction Markets</text>
  <text x="620" y="400" font-family="system-ui, sans-serif" font-size="13" fill="#888">Polymarket integration</text>

  <rect x="870" y="345" width="270" height="80" rx="8" fill="#111" stroke="#222" stroke-width="1"/>
  <text x="890" y="375" font-family="system-ui, sans-serif" font-size="16" fill="#8b5cf6" font-weight="700">Signal Convergence</text>
  <text x="890" y="400" font-family="system-ui, sans-serif" font-size="13" fill="#888">Multi-source correlation</text>
  `}

  <!-- Bottom bar -->
  <rect x="0" y="490" width="1200" height="140" fill="#080810"/>
  <line x1="0" y1="490" x2="1200" y2="490" stroke="#222" stroke-width="1"/>

  <!-- Logo area -->
  <circle cx="92" cy="545" r="24" fill="none" stroke="${levelColor}" stroke-width="2"/>
  <text x="92" y="551" font-family="system-ui, sans-serif" font-size="18" font-weight="800" fill="${levelColor}" text-anchor="middle"
    >W</text>

  <text x="130" y="538" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="700" fill="#ddd" letter-spacing="3"
    >WORLDMONITOR</text>
  <text x="130" y="562" font-family="system-ui, sans-serif" font-size="15" fill="#777"
    >Real-time global intelligence monitoring</text>

  <!-- CTA -->
  <rect x="920" y="524" width="220" height="42" rx="21" fill="${levelColor}"/>
  <text x="1030" y="551" font-family="system-ui, sans-serif" font-size="16" font-weight="700" fill="#fff" text-anchor="middle"
    >VIEW FULL BRIEF →</text>

  <!-- URL + date -->
  <text x="60" y="610" font-family="system-ui, sans-serif" font-size="14" fill="#555"
    >worldmonitor.app · ${dateStr} · Free &amp; open source</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600');
  res.status(200).send(svg);
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
