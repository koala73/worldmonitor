import { hasCurrentEntitlementCoverage } from './entitlement-coverage';

interface HistoryEntitlement {
  validUntil: number;
  billingStatus?: string;
  verificationUnavailable?: boolean;
  features: { tier: number; historyDays?: number };
}

const access = new WeakMap<Request, number>();

export function countryHistoryDays(entitlement: HistoryEntitlement | null, now = Date.now()): number {
  if (!hasCurrentEntitlementCoverage(entitlement, now)) return 7;
  const { tier, historyDays } = entitlement.features;
  const ceiling = tier >= 2 ? 365 : tier >= 1 ? 90 : 7;
  return typeof historyDays === 'number' && Number.isInteger(historyDays) && historyDays > 0
    ? Math.min(historyDays, ceiling) : ceiling;
}

// Only the gateway binds this after authentication. Client headers cannot
// create a WeakMap entry, and a direct/local handler read defaults to free.
export function bindCountryHistoryAccess(request: Request, days: number): void {
  access.set(request, days);
}

export function getCountryHistoryAccess(request: Request): number {
  return access.get(request) ?? 7;
}
