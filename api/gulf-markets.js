export const config = { runtime: 'edge' };

// Gulf Cooperation Council (GCC) stock market indices - Yahoo Finance symbols
const GULF_SYMBOLS = [
  // Stock indices
  { symbol: '^TASI',    name: 'Saudi TASI',     country: 'Saudi Arabia', flag: '🇸🇦', type: 'index' },
  { symbol: '^DFMGI',   name: 'Dubai DFM',      country: 'UAE',          flag: '🇦🇪', type: 'index' },
  { symbol: '^FTFADGI', name: 'Abu Dhabi ADX',  country: 'UAE',          flag: '🇦🇪', type: 'index' },
  { symbol: '^QSI',     name: 'Qatar QSE',      country: 'Qatar',        flag: '🇶🇦', type: 'index' },
  { symbol: '^KW15',    name: 'Kuwait KW15',    country: 'Kuwait',       flag: '🇰🇼', type: 'index' },
  { symbol: '^BAX',     name: 'Bahrain BAX',    country: 'Bahrain',      flag: '🇧🇭', type: 'index' },
  { symbol: '^MSM',     name: 'Oman MSM30',     country: 'Oman',         flag: '🇴🇲', type: 'index' },
  // Currencies vs USD
  { symbol: 'SARUSD=X', name: 'SAR/USD',        country: 'Saudi Arabia', flag: '🇸🇦', type: 'currency' },
  { symbol: 'AEDUSD=X', name: 'AED/USD',        country: 'UAE',          flag: '🇦🇪', type: 'currency' },
  { symbol: 'QARUSD=X', name: 'QAR/USD',        country: 'Qatar',        flag: '🇶🇦', type: 'currency' },
  { symbol: 'KWDUSD=X', name: 'KWD/USD',        country: 'Kuwait',       flag: '🇰🇼', type: 'currency' },
  { symbol: 'BHDUSD=X', name: 'BHD/USD',        country: 'Bahrain',      flag: '🇧🇭', type: 'currency' },
  { symbol: 'OMRUSD=X', name: 'OMR/USD',        country: 'Oman',         flag: '🇴🇲', type: 'currency' },
  // Oil (core of Gulf economies)
  { symbol: 'CL=F',     name: 'WTI Crude',      country: 'Global',       flag: '🛢️', type: 'oil' },
  { symbol: 'BZ=F',     name: 'Brent Crude',    country: 'Global',       flag: '🛢️', type: 'oil' },
];

async function fetchSymbol(symbol, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

    // Build sparkline from last 20 closing prices
    const closes = result.indicators?.quote?.[0]?.close;
    const sparkline = closes
      ? closes.filter(v => v != null).slice(-20)
      : [];

    return { price, change, sparkline };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Fetch all symbols in parallel
    const results = await Promise.all(
      GULF_SYMBOLS.map(async (info) => {
        const quote = await fetchSymbol(info.symbol);
        return {
          symbol: info.symbol,
          name: info.name,
          country: info.country,
          flag: info.flag,
          type: info.type,
          price: quote?.price ?? null,
          change: quote?.change ?? null,
          sparkline: quote?.sparkline ?? [],
        };
      })
    );

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch Gulf market data' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
