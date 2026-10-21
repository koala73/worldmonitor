export interface ChokepointTransitDay {
  date: string;
  total: number;
}

export interface TrafficAnomaly {
  dropPct: number;
  signal: boolean;
}

export function detectTrafficAnomaly(
  history: readonly ChokepointTransitDay[] | null | undefined,
  threatLevel: string,
): TrafficAnomaly;
