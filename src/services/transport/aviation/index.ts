import type { CivilFlight } from '../types';
import type { AviationProvider } from './provider';

const providers: AviationProvider[] = [];

export function registerAviationProvider(provider: AviationProvider): void {
  providers.push(provider);
}

export async function listCivilFlights(bounds: {
  neLat: number;
  neLon: number;
  swLat: number;
  swLon: number;
}): Promise<CivilFlight[]> {
  const results = await Promise.allSettled(providers.map((p) => p.listFlights(bounds)));
  return results
    .filter((r): r is PromiseFulfilledResult<CivilFlight[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);
}

