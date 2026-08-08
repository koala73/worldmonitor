// Pure state-building logic for EnergyRiskOverviewPanel. Extracted from the
// panel class so it can be imported under node:test without pulling in the
// Vite-only modules the panel transitively depends on (i18n's import.meta.glob,
// etc). Keep this file dep-free apart from generated types.

export interface TileState<T> {
  status: 'fulfilled' | 'rejected' | 'pending';
  value?: T;
  fetchedAt?: number;
}

export interface OverviewState {
  hormuz: TileState<{ status: string }>;
  euGas: TileState<{ fillPct: number; fillPctChange1d: number }>;
  brent: TileState<{ price: number; change: number }>;
  activeDisruptions: TileState<{ count: number }>;
}

// Minimal shapes — only the fields the state builder reads. Loose enough that
// tests can pass plain objects without importing the full generated types.
interface HormuzMin { status?: string }
interface EuGasMin { unavailable?: boolean; fillPct?: number; fillPctChange1d?: number }
interface BrentResultMin { data?: Array<{ price: number | null; change?: number | null }> }
interface DisruptionsMin {
  upstreamUnavailable?: boolean;
  events?: Array<{ endAt?: string | null }>;
}

/**
 * Build an OverviewState from the four allSettled results. Pure: no I/O,
 * no Date.now() unless the caller passes a clock. Each tile resolves to
 * 'fulfilled' or 'rejected' independently — one source failing CANNOT
 * cascade into the others. This is the core degraded-mode contract the
 * panel guarantees.
 */
export function buildOverviewState(
  hormuz: PromiseSettledResult<HormuzMin | null | undefined>,
  euGas: PromiseSettledResult<EuGasMin | null | undefined>,
  brent: PromiseSettledResult<BrentResultMin | null | undefined>,
  disruptions: PromiseSettledResult<DisruptionsMin | null | undefined>,
  now: number,
): OverviewState {
  return {
    hormuz: hormuz.status === 'fulfilled' && hormuz.value && hormuz.value.status
      ? { status: 'fulfilled', value: { status: hormuz.value.status }, fetchedAt: now }
      : { status: 'rejected' },
    euGas: euGas.status === 'fulfilled' && euGas.value && !euGas.value.unavailable && (euGas.value.fillPct ?? 0) > 0
      ? {
          status: 'fulfilled',
          value: {
            fillPct: euGas.value.fillPct as number,
            fillPctChange1d: euGas.value.fillPctChange1d ?? 0,
          },
          fetchedAt: now,
        }
      : { status: 'rejected' },
    brent: (() => {
      if (brent.status !== 'fulfilled' || !brent.value || !brent.value.data || brent.value.data.length === 0) {
        return { status: 'rejected' as const };
      }
      const q = brent.value.data[0];
      if (!q || q.price === null) return { status: 'rejected' as const };
      return {
        status: 'fulfilled' as const,
        value: { price: q.price, change: q.change ?? 0 },
        fetchedAt: now,
      };
    })(),
    activeDisruptions: disruptions.status === 'fulfilled' && disruptions.value && !disruptions.value.upstreamUnavailable
      ? {
          status: 'fulfilled',
          value: { count: (disruptions.value.events ?? []).filter((e) => !e.endAt).length },
          fetchedAt: now,
        }
      : { status: 'rejected' },
  };
}

/**
 * Convenience for tests: count tiles that are in degraded ('rejected') state.
 */
export function countDegradedTiles(state: OverviewState): number {
  return Object.values(state).filter((t) => t.status === 'rejected').length;
}
