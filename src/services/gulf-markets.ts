export interface GulfMarketItem {
  symbol: string;
  name: string;
  country: string;
  flag: string;
  type: 'index' | 'currency' | 'oil';
  price: number | null;
  change: number | null;
  sparkline: number[];
}

let lastSuccessful: GulfMarketItem[] = [];

export async function fetchGulfMarkets(): Promise<GulfMarketItem[]> {
  try {
    const res = await fetch('/api/gulf-markets');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: GulfMarketItem[] = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      lastSuccessful = data;
    }
    return lastSuccessful;
  } catch (err) {
    console.error('[GulfMarkets] fetch failed:', err);
    return lastSuccessful;
  }
}
