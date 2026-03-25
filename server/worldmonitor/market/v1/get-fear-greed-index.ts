import type {
  ServerContext,
  GetFearGreedIndexRequest,
  GetFearGreedIndexResponse,
  FearGreedCategory,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:fear-greed:v1';

export async function getFearGreedIndex(
  _ctx: ServerContext,
  _req: GetFearGreedIndexRequest,
): Promise<GetFearGreedIndexResponse> {
  try {
    const raw = await getCachedJson(SEED_CACHE_KEY, true) as Record<string, unknown> | null;
    if (!raw?.composite) return { compositeScore: 0, compositeLabel: '', unavailable: true } as GetFearGreedIndexResponse;

    const comp = raw.composite as Record<string, unknown>;
    const cats = (raw.categories ?? {}) as Record<string, Record<string, unknown>>;
    const hdr = (raw.headerMetrics ?? {}) as Record<string, Record<string, unknown> | null>;

    const mapCat = (c: Record<string, unknown> | undefined): FearGreedCategory => ({
      score: Number(c?.score ?? 50),
      weight: Number(c?.weight ?? 0),
      contribution: Number(c?.contribution ?? 0),
      degraded: Boolean(c?.degraded),
      inputsJson: JSON.stringify(c?.inputs ?? {}),
    });

    return {
      compositeScore: Number(comp.score ?? 0),
      compositeLabel: String(comp.label ?? ''),
      previousScore: Number(comp.previous ?? 0),
      seededAt: String(raw.timestamp ?? ''),
      sentiment:   mapCat(cats.sentiment),
      volatility:  mapCat(cats.volatility),
      positioning: mapCat(cats.positioning),
      trend:       mapCat(cats.trend),
      breadth:     mapCat(cats.breadth),
      momentum:    mapCat(cats.momentum),
      liquidity:   mapCat(cats.liquidity),
      credit:      mapCat(cats.credit),
      macro:       mapCat(cats.macro),
      crossAsset:  mapCat(cats.crossAsset),
      vix: Number(hdr?.vix?.value ?? 0),
      hySpread: Number(hdr?.hySpread?.value ?? 0),
      yield10y: Number(hdr?.yield10y?.value ?? 0),
      putCallRatio: Number(hdr?.putCall?.value ?? 0),
      pctAbove200d: Number(hdr?.pctAbove200d?.value ?? 0),
      cnnFearGreed: Number(hdr?.cnnFearGreed?.value ?? 0),
      cnnLabel: String(hdr?.cnnFearGreed?.label ?? ''),
      aaiiBull: Number(hdr?.aaiBull?.value ?? 0),
      aaiiBear: Number(hdr?.aaiBear?.value ?? 0),
      fedRate: String(hdr?.fedRate?.value ?? ''),
      unavailable: false,
    };
  } catch {
    return { compositeScore: 0, compositeLabel: '', unavailable: true } as GetFearGreedIndexResponse;
  }
}
