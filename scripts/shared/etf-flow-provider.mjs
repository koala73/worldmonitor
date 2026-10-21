/**
 * Pure ETF-flow normalization shared by the Railway seeder and contract tests.
 */

/**
 * @param {{ ticker: string; issuer: string; price: number; priceChange: number; volume: number; avgVolume?: number; volumeRatio?: number }} input
 */
export function toSeedEtfFlow({
  ticker,
  issuer,
  price,
  priceChange,
  volume,
  avgVolume = 0,
  volumeRatio = 0,
}) {
  const direction = priceChange > 0.1 ? 'inflow' : priceChange < -0.1 ? 'outflow' : 'neutral';
  const estFlow = Math.round(volume * price * (priceChange > 0 ? 1 : -1) * 0.1);
  return {
    ticker,
    issuer,
    price: +price.toFixed(2),
    priceChange: +priceChange.toFixed(2),
    volume,
    avgVolume: Math.round(avgVolume),
    volumeRatio: +volumeRatio.toFixed(2),
    direction,
    estFlow,
  };
}

export function parseEtfChartData(chart, ticker, issuer) {
  const result = chart?.chart?.result?.[0];
  if (!result) return null;

  const quote = result.indicators?.quote?.[0];
  const closes = quote?.close || [];
  const volumes = quote?.volume || [];

  // Filter closes and volumes TOGETHER so price and volume always come from
  // the same bar — Yahoo routinely nulls one but not the other, and pairing
  // today's volume with yesterday's close fabricated false flows.
  const alignedBars = closes
    .map((p, i) => ({ p, v: volumes[i] }))
    .filter(({ p, v }) => p != null && v != null);
  const validCloses = alignedBars.map(({ p }) => p);
  const validVolumes = alignedBars.map(({ v }) => v);

  if (validCloses.length < 2) return null;

  const latestPrice = validCloses[validCloses.length - 1];
  const prevPrice = validCloses[validCloses.length - 2];
  const priceChange = prevPrice ? ((latestPrice - prevPrice) / prevPrice) * 100 : 0;

  const latestVolume = validVolumes.length > 0 ? validVolumes[validVolumes.length - 1] : 0;
  const avgVolume =
    validVolumes.length > 1
      ? validVolumes.slice(0, -1).reduce((a, b) => a + b, 0) / (validVolumes.length - 1)
      : latestVolume;

  const volumeRatio = avgVolume > 0 ? latestVolume / avgVolume : 1;
  return toSeedEtfFlow({
    ticker,
    issuer,
    price: latestPrice,
    priceChange,
    volume: latestVolume,
    avgVolume,
    volumeRatio,
  });
}
