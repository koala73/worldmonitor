// Pure selectors and formatters over the store's data. Kept free of terminal
// concerns so they can be unit-tested with fixture payloads.

export function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

export function ageOf(ts, now = Date.now()) {
  const t = typeof ts === 'string' ? Date.parse(ts) : Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '—';
  return fmtAge(now - (t < 1e12 ? t * 1000 : t));
}

export function fmtNum(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: digits });
  return n.toFixed(digits);
}

export function fmtPrice(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (abs >= 1) return n.toFixed(2);
  if (abs >= 0.01) return n.toFixed(4);
  return n.toPrecision(3);
}

export function fmtPct(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
}

export function enumLabel(value) {
  if (!value) return '';
  const s = String(value);
  // THREAT_LEVEL_HIGH → high, UCDP_VIOLENCE_TYPE_ONE_SIDED → one sided
  const parts = s.split('_');
  const tail = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    tail.unshift(parts[i]);
    if (['LEVEL', 'TYPE', 'STATUS', 'DIRECTION', 'PHASE', 'OPERATOR'].includes(parts[i - 1] || '')) break;
  }
  const words = (tail.length ? tail : parts).map((w) => w.toLowerCase());
  return words.join(' ').replace(/^unspecified$/, '').trim();
}

export function threatRank(level) {
  const l = String(level || '').toUpperCase();
  if (l.includes('CRITICAL')) return 4;
  if (l.includes('HIGH')) return 3;
  if (l.includes('MEDIUM') || l.includes('ELEVATED')) return 2;
  if (l.includes('LOW')) return 1;
  return 0;
}

// --- news ------------------------------------------------------------------------

export const NEWS_CATEGORY_LABELS = {
  politics: 'World',
  us: 'United States',
  europe: 'Europe',
  middleeast: 'Middle East',
  africa: 'Africa',
  latam: 'Latin America',
  asia: 'Asia-Pacific',
  energy: 'Energy',
  gov: 'Government',
  thinktanks: 'Think Tanks',
  tech: 'Technology',
  ai: 'AI / ML',
  finance: 'Finance',
  commodities: 'Commodities',
  crisis: 'Crisis',
  layoffs: 'Layoffs',
  science: 'Science',
  intel: 'Intel',
};

const NEWS_ORDER = Object.keys(NEWS_CATEGORY_LABELS);

export function newsCategories(digest) {
  const cats = digest && digest.categories ? digest.categories : {};
  return Object.keys(cats)
    .filter((k) => Array.isArray(cats[k]?.items) && cats[k].items.length)
    .sort((a, b) => {
      const ia = NEWS_ORDER.indexOf(a);
      const ib = NEWS_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    })
    .map((id) => ({ id, label: NEWS_CATEGORY_LABELS[id] || id, items: cats[id].items }));
}

export function allHeadlines(digest, limit = 60) {
  const out = [];
  for (const cat of newsCategories(digest)) for (const item of cat.items) out.push({ ...item, category: cat.id });
  out.sort((a, b) => (b.importanceScore || 0) - (a.importanceScore || 0) || (b.publishedAt || 0) - (a.publishedAt || 0));
  return out.slice(0, limit);
}

// --- markets ---------------------------------------------------------------------

export function quoteGroups(data) {
  const q = (key, field = 'quotes') => (data[key] && Array.isArray(data[key][field]) ? data[key][field] : []);
  return {
    indices: q('marketQuotes'),
    commodities: q('commodityQuotes'),
    crypto: q('cryptoQuotes'),
    gulf: q('gulfQuotes'),
    sectors: q('sectors', 'sectors'),
    defi: q('defiTokens', 'tokens'),
    ai: q('aiTokens', 'tokens'),
    other: q('otherTokens', 'tokens'),
  };
}

// --- map blips -------------------------------------------------------------------

export function mapBlips(data, t, { max = 400 } = {}) {
  const blips = [];
  const push = (lat, lon, ch, fg, weight = 1, bold = false) => {
    if (Number.isFinite(lat) && Number.isFinite(lon)) blips.push({ lat, lon, ch, fg, weight, bold });
  };
  for (const e of data.earthquakes?.earthquakes || []) {
    const mag = e.magnitude || 0;
    push(e.location?.latitude, e.location?.longitude, mag >= 6 ? '◉' : mag >= 5 ? '●' : '•', mag >= 6 ? t.bad : t.warn, mag);
  }
  for (const e of data.ucdpEvents?.events || []) push(e.location?.latitude, e.location?.longitude, '✕', t.bad, 2 + (e.deathsBest || 0) / 10, true);
  for (const e of data.unrestEvents?.events || []) push(e.latitude ?? e.location?.latitude, e.longitude ?? e.location?.longitude, '▲', t.accent2, 1.5);
  for (const e of (data.wildfires?.fireDetections || []).slice(0, 120)) push(e.location?.latitude, e.location?.longitude, '🔥'.length > 1 ? '*' : '*', t.warn, 0.5);
  for (const e of data.naturalEvents?.events || []) push(e.lat, e.lon, '◍', t.info, 2.5, true);
  for (const e of data.cyberThreats?.threats || []) {
    const lat = e.location?.latitude ?? e.latitude;
    const lon = e.location?.longitude ?? e.longitude;
    push(lat, lon, '¤', t.accent3, 0.4);
  }
  for (const e of data.outages?.outages || []) push(e.location?.latitude ?? e.latitude, e.location?.longitude ?? e.longitude, '◌', t.dim, 1);
  blips.sort((a, b) => a.weight - b.weight);
  return blips.slice(-max);
}

export function flightBlips(flights, t) {
  return (flights?.flights || []).map((f) => ({
    lat: f.location?.latitude,
    lon: f.location?.longitude,
    ch: '✈',
    fg: t.accent,
    weight: 3,
  }));
}

// --- ticker ----------------------------------------------------------------------

export function tickerSegments(data, digest, t) {
  const segs = [];
  const sep = { text: '   ◆   ', fg: t.muted };
  for (const q of (data.marketQuotes?.quotes || []).slice(0, 10)) {
    const ch = Number(q.change) || 0;
    segs.push({ text: `${q.display || q.symbol} `, fg: t.tickerText, attr: 1 });
    segs.push({ text: `${fmtPrice(q.price)} `, fg: t.text });
    segs.push({ text: `${ch > 0 ? '▲' : ch < 0 ? '▼' : '■'}${fmtPct(ch)}`, fg: ch > 0 ? t.good : ch < 0 ? t.bad : t.dim });
    segs.push(sep);
  }
  for (const q of (data.cryptoQuotes?.quotes || []).slice(0, 4)) {
    const ch = Number(q.change) || 0;
    segs.push({ text: `${q.symbol} `, fg: t.tickerText, attr: 1 });
    segs.push({ text: `${fmtPrice(q.price)} `, fg: t.text });
    segs.push({ text: `${ch > 0 ? '▲' : ch < 0 ? '▼' : '■'}${fmtPct(ch)}`, fg: ch > 0 ? t.good : ch < 0 ? t.bad : t.dim });
    segs.push(sep);
  }
  for (const h of allHeadlines(digest, 12)) {
    segs.push({ text: h.isAlert ? '⚠ ' : '› ', fg: h.isAlert ? t.bad : t.accent });
    segs.push({ text: `${h.source}: `, fg: t.dim });
    segs.push({ text: h.title, fg: t.tickerText });
    segs.push(sep);
  }
  return segs;
}

// --- conflict / risk -------------------------------------------------------------

export function ciiRanking(data, limit = 40) {
  const scores = data.riskScores?.ciiScores || [];
  return [...scores].sort((a, b) => (b.combinedScore || 0) - (a.combinedScore || 0)).slice(0, limit);
}

export function trendArrow(trend) {
  const s = String(trend || '').toUpperCase();
  if (s.includes('RISING') || s.includes('UP') || s.includes('ESCALAT')) return '↗';
  if (s.includes('FALLING') || s.includes('DOWN') || s.includes('DE-ESCALAT') || s.includes('DEESCALAT')) return '↘';
  return '→';
}

// --- live video ------------------------------------------------------------------

export function youtubeChannelId(url) {
  const m = /youtube\.com\/channel\/(UC[\w-]{20,})/i.exec(url || '');
  return m ? m[1] : null;
}

export function youtubeVideoId(entry) {
  if (!entry) return null;
  if (/^[\w-]{11}$/.test(entry)) return entry;
  const m = /(?:v=|youtu\.be\/|\/live\/|\/embed\/)([\w-]{11})/.exec(entry);
  return m ? m[1] : null;
}

// Playable candidates for a catalog slot: HLS first, then YouTube videos, then
// resolved channel videos, then the channel's /live page for yt-dlp.
export function streamCandidates(sources, resolved, now = Date.now()) {
  const out = [];
  const seen = new Set();
  const add = (c) => {
    if (!seen.has(c.url)) {
      seen.add(c.url);
      out.push(c);
    }
  };
  const channels = resolved?.channels || {};
  for (const entry of sources || []) {
    if (/\.m3u8/i.test(entry)) {
      add({ kind: 'hls', url: entry, label: new URL(entry).hostname });
      continue;
    }
    const channelId = youtubeChannelId(entry);
    if (channelId) {
      const r = channels[channelId];
      const at = r?.resolvedAt ? Date.parse(r.resolvedAt) : 0;
      if (r?.videoId && now - at < 36 * 3600 * 1000) {
        add({ kind: 'youtube', url: `https://www.youtube.com/watch?v=${r.videoId}`, label: `resolved live ${r.videoId}` });
      }
      add({ kind: 'youtube-channel', url: `https://www.youtube.com/channel/${channelId}/live`, label: `channel live` });
      continue;
    }
    const vid = youtubeVideoId(entry);
    if (vid) add({ kind: 'youtube', url: `https://www.youtube.com/watch?v=${vid}`, label: `youtube ${vid}` });
  }
  return out;
}
