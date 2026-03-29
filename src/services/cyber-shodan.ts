/**
 * Shodan internet-exposure feed — ICS/SCADA systems
 *
 * Fetches internet-exposed industrial control systems from Shodan
 * (Modbus/502, Siemens S7/102, DNP3/20000, EtherNet-IP/44818, BACnet/47808).
 * Results are injected into the cyber threat map as 'high' severity threats.
 *
 * Requires SHODAN_API_KEY. Free-tier accounts can query up to 100 results.
 */
import { getApiBaseUrl } from '@/services/runtime';
import { isFeatureAvailable } from '@/services/runtime-config';
import type { CyberThreat } from '@/types';

export async function fetchShodanExposure(): Promise<CyberThreat[]> {
  if (!isFeatureAvailable('shodanIcsExposure')) return [];
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/shodan-exposure`);
    if (!res.ok) return [];
    return (await res.json()) as CyberThreat[];
  } catch {
    return [];
  }
}
