export const WORLD_BANK_RPC_CACHE_PREFIX: 'economic:worldbank:v2';
export const WORLD_BANK_DEFAULT_CACHE_COUNTRY: '__default__';
export const WORLD_BANK_LOOKBACKS: readonly [5, 30];
export const WORLD_BANK_RPC_USER_AGENT: string;
export const WORLD_BANK_TECH_COUNTRIES: readonly string[];
export const WORLD_BANK_CATALOGUE_INDICATORS: readonly string[];

export interface WorldBankCountryRecord {
  countryCode: string;
  /** Provider country.id retained for ISO2 aliases absent from the local table. Seed-only. */
  countryIso2?: string;
  countryName: string;
  indicatorCode: string;
  indicatorName: string;
  year: number;
  value: number;
}

export function worldBankRpcCacheKey(
  indicatorCode: string,
  country: string,
  years: number,
  currentYear: number,
): string;

export function isWorldBankCountryRecord(value: unknown): value is WorldBankCountryRecord;

export function filterWorldBankRecords(
  records: unknown,
  country: string,
  years: number,
  currentYear: number,
): WorldBankCountryRecord[];

export function worldBankRpcPayload(
  records: unknown,
  country: string,
  years: number,
  currentYear: number,
): { data: WorldBankCountryRecord[]; pagination: undefined };

export function worldBankRpcCacheCommands(
  prefix: string,
  indicatorId: string,
  records: unknown,
  currentYear: number,
  ttlSeconds: number,
): string[][];
