import type { CivilVessel } from '../types';
import type { MaritimeProvider } from './provider';

const providers: MaritimeProvider[] = [];

export function registerMaritimeProvider(provider: MaritimeProvider): void {
  providers.push(provider);
}

export async function listCivilVessels(): Promise<CivilVessel[]> {
  const results = await Promise.allSettled(providers.map((p) => p.listVessels()));
  return results
    .filter((r): r is PromiseFulfilledResult<CivilVessel[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);
}

