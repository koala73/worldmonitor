type HistoryPoint = { date: string; value: number };

const FREIGHT_SOURCES: Record<string, { source: string; frequency: string; raw: boolean }> = {
  PCU483111483111: { source: 'U.S. Bureau of Labor Statistics via FRED', frequency: 'monthly', raw: true },
  TSIFRGHT: { source: 'U.S. Bureau of Transportation Statistics via FRED', frequency: 'monthly', raw: true },
  SCFI: { source: 'Shanghai Shipping Exchange', frequency: 'weekly', raw: false },
  CCFI: { source: 'Shanghai Shipping Exchange', frequency: 'weekly', raw: false },
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function historyPoints(value: unknown): HistoryPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(point => {
    const p = record(point);
    const v = finite(p.value);
    return typeof p.date === 'string' && v !== null ? [{ date: p.date, value: v }] : [];
  });
}

export function shippingIndexBaseline(history: HistoryPoint[]): {
  zScore: number | null; baselinePoints: number; baselineStart: string | null;
} {
  const baseline = history.slice(0, -1);
  const result = { zScore: null as number | null, baselinePoints: baseline.length, baselineStart: baseline[0]?.date ?? null };
  if (baseline.length < 12) return result;
  const mean = baseline.reduce((sum, p) => sum + p.value, 0) / baseline.length;
  const variance = baseline.reduce((sum, p) => sum + (p.value - mean) ** 2, 0) / baseline.length;
  if (variance > 0) result.zScore = finite((history[history.length - 1]!.value - mean) / Math.sqrt(variance));
  return result;
}

export function projectSupplyChainData(data: Record<string, unknown>): Record<string, unknown> {
  const projected = { ...data };
  if (data['freight-rates'] != null) {
    const payload = record(data['freight-rates']);
    const indices = Array.isArray(payload.indices) ? payload.indices : [];
    projected['freight-rates'] = {
      fetchedAt: typeof payload.fetchedAt === 'string' ? payload.fetchedAt : null,
      indices: indices.flatMap(value => {
        const idx = record(value);
        const id = typeof idx.indexId === 'string' ? idx.indexId : '';
        const source = Object.prototype.hasOwnProperty.call(FREIGHT_SOURCES, id) ? FREIGHT_SOURCES[id] : undefined;
        if (!source) return [];
        const history = historyPoints(idx.history);
        const latest = history[history.length - 1];
        const prior = history[history.length - 2];
        const periodChangePct = source.raw
          ? latest && prior && prior.value !== 0 ? finite((latest.value - prior.value) / Math.abs(prior.value) * 100) : null
          : finite(idx.periodChangePct);
        return [{
          indexId: id, name: idx.name, source: source.source, unit: idx.unit, frequency: source.frequency,
          observationDate: latest?.date ?? null,
          periodChangePct,
          periodChangeBasis: periodChangePct === null ? null : source.raw ? 'derived_from_prior_period_level' : idx.periodChangeBasis ?? null,
          priorPeriodDate: periodChangePct === null ? null : source.raw ? prior?.date ?? null : idx.priorPeriodDate ?? null,
          ...shippingIndexBaseline(history),
          direction: periodChangePct === null ? null : periodChangePct > 0 ? 'up' : periodChangePct < 0 ? 'down' : 'flat',
          ...(source.raw ? { currentValue: finite(idx.currentValue), history } : {}),
        }];
      }),
    };
  }
  if (data.gscpi != null) {
    const series = record(record(data.gscpi).series);
    projected.gscpi = {
      source: 'Federal Reserve Bank of New York',
      sourceUrl: 'https://www.newyorkfed.org/research/policy/gscpi',
      series: {
        series_id: 'GSCPI', title: 'Global Supply Chain Pressure Index',
        units: 'Standard Deviations', frequency: 'Monthly',
        observations: historyPoints(series.observations),
      },
    };
  }
  return projected;
}
