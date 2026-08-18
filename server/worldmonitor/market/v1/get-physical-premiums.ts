import type {
  BenchmarkLeg,
  FxSnapshot,
  GetPhysicalPremiumsRequest,
  GetPhysicalPremiumsResponse,
  PhysicalPremium,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { parseStringArray } from './_shared';

const PHYSICAL_PREMIUM_KEY = 'market:physical-premium:v1';
const SUPPORTED_METALS = new Set(['gold', 'silver']);
const TROY_OUNCE_GRAMS = 31.1034768;
const METAL_CONTRACTS = {
  gold: { unit: 'gram', contract: 'SHAU', paperSymbol: 'GC=F' },
  silver: { unit: 'kilogram', contract: 'SHAG', paperSymbol: 'SI=F' },
} as const;

interface RawLeg {
  price?: unknown;
  currency?: unknown;
  unit?: unknown;
  source?: unknown;
  asOf?: unknown;
}

interface RawPremium {
  metal?: unknown;
  physical?: RawLeg;
  paper?: RawLeg;
  premiumUsdPerOz?: unknown;
  premiumPct?: unknown;
  computedAt?: unknown;
}

interface RawFx {
  pair?: unknown;
  rate?: unknown;
  source?: unknown;
  asOf?: unknown;
}

interface RawPayload {
  premiums?: RawPremium[];
  fx?: RawFx;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function string(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isoInstant(value: unknown): value is string {
  return string(value) && Number.isFinite(Date.parse(value));
}

function isoDate(value: unknown): value is string {
  if (!string(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function mapLeg(raw: RawLeg | undefined): BenchmarkLeg | null {
  if (
    !finite(raw?.price)
    || raw.price <= 0
    || !string(raw.currency)
    || !string(raw.unit)
    || !string(raw.source)
    || !string(raw.asOf)
  ) return null;
  return {
    price: raw.price,
    currency: raw.currency,
    unit: raw.unit,
    source: raw.source,
    asOf: raw.asOf,
  };
}

function mapPremium(raw: RawPremium, cnyUsdRate: number): PhysicalPremium | null {
  if (!string(raw.metal) || !SUPPORTED_METALS.has(raw.metal)) return null;
  const metal = raw.metal as keyof typeof METAL_CONTRACTS;
  const expected = METAL_CONTRACTS[metal];
  const physical = mapLeg(raw.physical);
  const rawPaper = raw.paper;
  const paper = mapLeg(rawPaper && {
    ...rawPaper,
    currency: 'USD',
    unit: 'troy ounce',
  });
  if (
    !physical
    || !paper
    || physical.currency !== 'CNY'
    || physical.unit !== expected.unit
    || ![`Shanghai Gold Exchange ${expected.contract} AM benchmark`, `Shanghai Gold Exchange ${expected.contract} PM benchmark`].includes(physical.source)
    || !isoDate(physical.asOf)
    || paper.source !== `COMEX ${expected.paperSymbol} futures snapshot`
    || !isoInstant(paper.asOf)
    || !finite(raw.premiumUsdPerOz)
    || !finite(raw.premiumPct)
    || !isoInstant(raw.computedAt)
  ) return null;
  const gramsPerUnit = expected.unit === 'gram' ? 1 : 1000;
  const physicalUsdPerOz = (physical.price / gramsPerUnit) * cnyUsdRate * TROY_OUNCE_GRAMS;
  const expectedUsd = round(physicalUsdPerOz - paper.price);
  const expectedPct = round(((physicalUsdPerOz - paper.price) / paper.price) * 100);
  if (Math.abs(raw.premiumUsdPerOz - expectedUsd) > 0.0001 || Math.abs(raw.premiumPct - expectedPct) > 0.0001) {
    return null;
  }
  return {
    metal,
    physical,
    paper,
    premiumUsdPerOz: raw.premiumUsdPerOz,
    premiumPct: raw.premiumPct,
    computedAt: raw.computedAt,
  };
}

function mapFx(raw: RawFx | undefined): FxSnapshot | null {
  if (
    raw?.pair !== 'CNY/USD'
    || !finite(raw.rate)
    || raw.rate <= 0
    || raw.source !== 'shared:fx-rates:v1'
    || !isoInstant(raw.asOf)
  ) return null;
  return { pair: raw.pair, rate: raw.rate, source: raw.source, asOf: raw.asOf };
}

export function resolvePhysicalPremiumMetals(rawMetals: string[]): string[] {
  const metals: string[] = [];
  const unsupported: string[] = [];
  for (const raw of rawMetals) {
    const metal = raw.trim().toLowerCase();
    if (!metal || !SUPPORTED_METALS.has(metal)) {
      const label = metal || '<blank>';
      if (!unsupported.includes(label)) unsupported.push(label);
      continue;
    }
    if (!metals.includes(metal)) metals.push(metal);
  }
  if (unsupported.length > 0) {
    throw new ValidationError([{
      field: 'metals',
      description: `Unsupported metal${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}`,
    }]);
  }
  return metals;
}

export async function getPhysicalPremiums(
  _ctx: ServerContext,
  req: GetPhysicalPremiumsRequest,
): Promise<GetPhysicalPremiumsResponse> {
  const metals = resolvePhysicalPremiumMetals(parseStringArray(req.metals));
  try {
    const raw = await getCachedJson(PHYSICAL_PREMIUM_KEY, true) as RawPayload | null;
    const fx = mapFx(raw?.fx);
    if (!fx || !Array.isArray(raw?.premiums)) return { premiums: [] };
    const premiums = raw.premiums.map((premium) => mapPremium(premium, fx.rate))
      .filter((item): item is PhysicalPremium => item !== null);
    if (premiums.length !== 2 || premiums.length !== raw.premiums.length) return { premiums: [] };
    if (new Set(premiums.map((premium) => premium.metal)).size !== 2) return { premiums: [] };
    const wanted = new Set(metals);
    return {
      premiums: metals.length === 0 ? premiums : premiums.filter((item) => wanted.has(item.metal)),
      fx,
    };
  } catch {
    return { premiums: [] };
  }
}
