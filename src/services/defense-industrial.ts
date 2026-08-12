import type {
  GetDefenseIndustrialBaseResponse,
  MilitaryServiceClient,
} from '@/generated/client/worldmonitor/military/v1/service_client';
import { ensureHydrated } from '@/services/bootstrap';
import {
  buildDefenseIndustrialResponse,
  hasCompleteDefenseIndustrialHydration,
  type StoredIndustrialSnapshot,
  type StoredSupplierSnapshot,
} from '../../shared/defense-industrial-response';

export async function getCountryDefenseIndustrialBase(
  countryCode: string,
  client: Pick<MilitaryServiceClient, 'getDefenseIndustrialBase'>,
): Promise<GetDefenseIndustrialBaseResponse> {
  const [industrial, suppliers] = await Promise.all([
    ensureHydrated('defenseIndustrialBase'),
    ensureHydrated('armsSuppliers'),
  ]);
  const hydrated = buildDefenseIndustrialResponse(
    countryCode,
    (industrial as StoredIndustrialSnapshot | undefined) || null,
    (suppliers as StoredSupplierSnapshot | undefined) || null,
  );
  // A one-key bootstrap success is a partial response. Use the RPC for that
  // case so a transient on-demand miss does not hide an available source.
  if (hasCompleteDefenseIndustrialHydration(industrial, suppliers)) return hydrated;
  return client.getDefenseIndustrialBase({ countryCode });
}
