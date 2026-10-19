import { resolveCountryFilter } from './_country-args';
import { RpcValidationError, type RpcValidationViolation } from './billing-denial';
import { argNum, argStrList } from './filters';
import { advertisedOutputSchema, schemaAdmitsNotice } from './structured-content';
import type { McpAccessClass, ToolDef } from './types';

const DeprecationNoticeBrand: unique symbol = Symbol('deprecation-notice');

export type LimitMismatch =
  | 'omitted-was-newest-30'
  | 'non-positive-was-full-history'
  | 'row-cap-as-years'
  | 'capped-at-30';

export type DeprecationNotice = {
  readonly alias: string;
  readonly replacement: string;
  readonly message: string;
  readonly limit?: {
    readonly requested: number | null;
    readonly servedAsYears: number;
    readonly mismatch: LimitMismatch;
  };
  readonly moved?: { readonly dataset: 'tariffs'; readonly tool: string };
} & { readonly [DeprecationNoticeBrand]: true };

export type ResolvedCall =
  | { readonly kind: 'registered'; readonly tool: ToolDef }
  | { readonly kind: 'retired'; readonly tool: ToolDef }
  | {
      readonly kind: 'alias';
      readonly tool: ToolDef;
      readonly arguments: Record<string, unknown>;
      readonly notice: DeprecationNotice;
    }
  | { readonly kind: 'invalid'; readonly violations: readonly RpcValidationViolation[] }
  | { readonly kind: 'unknown' };

export type AliasFamily =
  | {
      readonly kind: 'rename';
      readonly name: string;
      readonly target: string;
      readonly translate: 'identity';
    }
  | {
      readonly kind: 'dataset-split';
      readonly name: string;
      readonly param: 'dataset';
      readonly proValue: 'tariffs';
      readonly proTarget: string;
      readonly restTarget: string;
      readonly proTranslate: 'us-mfn-from-limit';
    };

export type AliasOptOut = { readonly name: string; readonly reason: string };

export type SealedAliases = {
  resolve(name: string, args: unknown): ResolvedCall;
  describe(name: string): { readonly replacements: readonly string[]; readonly hint: string } | null;
  aliasNames(): ReadonlySet<string>;
  optOuts(): ReadonlyMap<string, string>;
  targetNames(): ReadonlySet<string>;
  callableNames(): ReadonlySet<string>;
};

const TARIFF_ROUTE = 'GET /api/trade/v1/get-tariff-trends';
const TARIFF_CACHE_PREFIX = 'trade:tariffs:';

const PRODUCTION_FAMILIES: readonly AliasFamily[] = [
  {
    kind: 'dataset-split',
    name: 'get_tariff_trends',
    param: 'dataset',
    proValue: 'tariffs',
    proTarget: 'get_tariff_averages',
    restTarget: 'get_price_and_debt_indicators',
    proTranslate: 'us-mfn-from-limit',
  },
];

const PRODUCTION_OPT_OUTS: readonly AliasOptOut[] = [];

type Translation =
  | {
      readonly ok: true;
      readonly arguments: Record<string, unknown>;
      readonly limit?: DeprecationNotice['limit'];
      readonly moved?: DeprecationNotice['moved'];
    }
  | { readonly ok: false; readonly violations: readonly RpcValidationViolation[] };

type SealedRename = {
  readonly kind: 'rename';
  readonly name: string;
  readonly target: ToolDef;
  readonly replacements: readonly string[];
  readonly hint: string;
};

type SealedDatasetSplit = {
  readonly kind: 'dataset-split';
  readonly name: string;
  readonly pro: ToolDef;
  readonly rest: ToolDef;
  readonly replacements: readonly string[];
  readonly hint: string;
};

type SealedFamily = SealedRename | SealedDatasetSplit;

export function loadToolAliases(
  registry: readonly ToolDef[],
  retired: readonly ToolDef[],
  accessOf: (tool: ToolDef) => McpAccessClass,
): SealedAliases {
  return sealAliases(registry, retired, PRODUCTION_FAMILIES, PRODUCTION_OPT_OUTS, accessOf);
}

export function sealAliases(
  registry: readonly ToolDef[],
  retired: readonly ToolDef[],
  families: readonly AliasFamily[],
  optOuts: readonly AliasOptOut[],
  accessOf: (tool: ToolDef) => McpAccessClass,
): SealedAliases {
  const registryByName = new Map(registry.map((tool) => [tool.name, tool]));
  const retiredByName = new Map(retired.map((tool) => [tool.name, tool]));
  const seenAliases = new Set<string>();
  const sealed: SealedFamily[] = [];
  const aliasForTarget = new Map<string, string>();

  for (const family of families) {
    if (seenAliases.has(family.name)) fail(family.name, 'duplicate alias name');
    seenAliases.add(family.name);
    if (registryByName.has(family.name) || retiredByName.has(family.name)) {
      fail(family.name, 'alias name is already callable');
    }
    if (family.kind === 'rename') {
      const target = registryByName.get(family.target);
      if (!target) fail(family.name, `unregistered target ${family.target}`);
      aliasForTarget.set(target.name, family.name);
      sealed.push({
        kind: 'rename',
        name: family.name,
        target,
        replacements: [target.name],
        hint: `${family.name} now calls ${target.name}.`,
      });
      continue;
    }
    const pro = registryByName.get(family.proTarget);
    if (!pro) fail(family.name, `unregistered target ${family.proTarget}`);
    if (accessOf(pro) !== 'subscription') fail(family.name, `${pro.name} is not subscription`);
    if (!apiPaths(pro).includes(TARIFF_ROUTE)) fail(family.name, `${pro.name} does not list ${TARIFF_ROUTE}`);
    const rest = registryByName.get(family.restTarget);
    if (!rest) fail(family.name, `unregistered target ${family.restTarget}`);
    if (pro.name === rest.name) fail(family.name, 'pro target and rest target are the same');
    if (apiPaths(rest).includes(TARIFF_ROUTE)) fail(family.name, `${rest.name} still lists ${TARIFF_ROUTE}`);
    const tariffKey = cacheKeys(rest).find((key) => key.startsWith(TARIFF_CACHE_PREFIX));
    if (tariffKey) fail(family.name, `${rest.name} cache key ${tariffKey} uses ${TARIFF_CACHE_PREFIX}`);
    aliasForTarget.set(pro.name, family.name);
    aliasForTarget.set(rest.name, family.name);
    sealed.push({
      kind: 'dataset-split',
      name: family.name,
      pro,
      rest,
      replacements: [pro.name, rest.name],
      hint: `${family.name} is not listed. A dataset of ${family.proValue} calls ${pro.name}. Any other dataset calls ${rest.name}.`,
    });
  }

  const optOutMap = new Map<string, string>();
  for (const opt of optOuts) {
    if (opt.reason.trim() === '') throw new Error(`opt-out ${opt.name}: blank reason`);
    if (registryByName.has(opt.name) || retiredByName.has(opt.name)) {
      throw new Error(`opt-out ${opt.name}: names a live or retired tool`);
    }
    if (seenAliases.has(opt.name)) throw new Error(`opt-out ${opt.name}: names an alias`);
    optOutMap.set(opt.name, opt.reason);
  }

  const checked = new Set<string>();
  for (const family of sealed) {
    const targets = family.kind === 'rename' ? [family.target] : [family.pro, family.rest];
    for (const target of targets) {
      if (checked.has(target.name)) continue;
      checked.add(target.name);
      const advertised = advertisedOutputSchema(target.outputSchema, { permitDeprecation: true });
      if (!schemaAdmitsNotice(advertised)) {
        throw new Error(`alias ${aliasForTarget.get(target.name) ?? family.name}: ${target.name} rejects the deprecation notice`);
      }
    }
  }

  const familyByName = new Map(sealed.map((family) => [family.name, family]));
  const aliasNames = new Set(familyByName.keys());
  const targetNames = new Set(checked);
  const callableNames = new Set<string>([...registryByName.keys(), ...aliasNames, ...retiredByName.keys()]);

  return Object.freeze({
    resolve(name: string, args: unknown): ResolvedCall {
      const registered = registryByName.get(name);
      if (registered) return { kind: 'registered', tool: registered };
      const family = familyByName.get(name);
      if (family) return resolveFamily(family, args);
      const retiredTool = retiredByName.get(name);
      if (retiredTool) return { kind: 'retired', tool: retiredTool };
      return { kind: 'unknown' };
    },
    describe(name: string) {
      const family = familyByName.get(name);
      if (!family) return null;
      return { replacements: family.replacements, hint: family.hint };
    },
    aliasNames: () => aliasNames,
    optOuts: () => optOutMap,
    targetNames: () => targetNames,
    callableNames: () => callableNames,
  });
}

export function coverageGap(
  previousNames: readonly string[],
  currentNames: readonly string[],
  aliasNames: ReadonlySet<string>,
  optOutNames: ReadonlySet<string>,
): string[] {
  const current = new Set(currentNames);
  const missing: string[] = [];
  for (const name of previousNames) {
    if (!current.has(name) && !aliasNames.has(name) && !optOutNames.has(name)) missing.push(name);
  }
  return missing;
}

export function deprecationNotice(input: {
  alias: string;
  replacement: string;
  message: string;
  limit?: DeprecationNotice['limit'];
  moved?: DeprecationNotice['moved'];
}): DeprecationNotice {
  const alias = input.alias;
  const replacement = input.replacement;
  const message = input.message;
  if (alias.trim() === '' || replacement.trim() === '' || message.trim() === '') {
    throw new Error('deprecation notice requires alias, replacement, and message');
  }
  if (!message.includes(replacement)) throw new Error('deprecation notice message must name the replacement');
  let limit: DeprecationNotice['limit'];
  if (input.limit !== undefined) {
    const servedAsYears = input.limit.servedAsYears;
    if (!Number.isInteger(servedAsYears) || servedAsYears < 1 || servedAsYears > 30) {
      throw new Error('deprecation notice servedAsYears must be an integer from 1 to 30; years 0 is the route default of 10');
    }
    limit = { requested: input.limit.requested, servedAsYears, mismatch: input.limit.mismatch };
  }
  let moved: DeprecationNotice['moved'];
  if (input.moved !== undefined) {
    moved = { dataset: 'tariffs', tool: input.moved.tool };
    if (moved.tool.trim() === '' || !message.includes(moved.tool)) {
      throw new Error('deprecation notice message must name the moved tool');
    }
  }
  const notice = { alias, replacement, message, ...(limit ? { limit } : {}), ...(moved ? { moved } : {}) };
  return { ...notice, [DeprecationNoticeBrand]: true } as DeprecationNotice;
}

function resolveFamily(family: SealedFamily, args: unknown): ResolvedCall {
  if (family.kind === 'rename') {
    return {
      kind: 'alias',
      tool: family.target,
      arguments: identityArguments(args),
      notice: deprecationNotice({
        alias: family.name,
        replacement: family.target.name,
        message: `${family.name} now calls ${family.target.name}.`,
      }),
    };
  }
  const rawDataset = isPlainObject(args) ? args.dataset : undefined;
  if (!isPrimitive(rawDataset) && !(Array.isArray(rawDataset) && rawDataset.every(isPrimitive))) {
    return { kind: 'invalid', violations: [{ field: 'dataset', description: 'dataset must be a string or an array of strings.' }] };
  }
  const datasets = argStrList(rawDataset);
  const hasTariffs = datasets.includes('tariffs');
  const hasOther = datasets.some((dataset) => dataset !== 'tariffs');
  if (hasTariffs && hasOther) {
    return {
      kind: 'invalid',
      violations: [{
        field: 'dataset',
        description: `dataset mixes tariffs with other series. Call ${family.pro.name} for tariffs and ${family.rest.name} for the rest.`,
      }],
    };
  }
  if (!hasTariffs) {
    return {
      kind: 'alias',
      tool: family.rest,
      arguments: identityArguments(args),
      notice: deprecationNotice({
        alias: family.name,
        replacement: family.rest.name,
        message: `${family.name} now calls ${family.rest.name}. Tariff rates are no longer in this bundle. Call ${family.pro.name} for the US MFN series.`,
        moved: { dataset: 'tariffs', tool: family.pro.name },
      }),
    };
  }
  const translated = translateUsMfn(isPlainObject(args) ? args : {}, family.pro.name);
  if (!translated.ok) return { kind: 'invalid', violations: translated.violations };
  return {
    kind: 'alias',
    tool: family.pro,
    arguments: translated.arguments,
    notice: deprecationNotice({
      alias: family.name,
      replacement: family.pro.name,
      message: `${family.name} with the tariffs dataset now calls ${family.pro.name}. This result is the US MFN series for reporter 840.`,
      limit: translated.limit,
    }),
  };
}

function translateUsMfn(record: Record<string, unknown>, proName: string): Translation {
  let countries: string[];
  try {
    countries = resolveCountryFilter(record.country, 'country');
  } catch (err) {
    if (err instanceof RpcValidationError) return { ok: false, violations: err.violations };
    throw err;
  }
  if (countries.some((code) => code !== 'us')) {
    return {
      ok: false,
      violations: [{
        field: 'country',
        description: `The old series was US-only. Call ${proName} and pass reporter for another country.`,
      }],
    };
  }
  if (!isPrimitive(record.limit)) {
    return { ok: false, violations: [{ field: 'limit', description: 'limit must be a number.' }] };
  }
  const limit = limitFromRowCap(argNum(record.limit));
  return { ok: true, arguments: { reporter: '840', years: limit.servedAsYears }, limit };
}

function limitFromRowCap(requested: number | null): NonNullable<DeprecationNotice['limit']> {
  if (requested === null) return { requested, servedAsYears: 30, mismatch: 'omitted-was-newest-30' };
  if (requested <= 0 || requested > 30) {
    return {
      requested,
      servedAsYears: 30,
      mismatch: requested <= 0 ? 'non-positive-was-full-history' : 'capped-at-30',
    };
  }
  return { requested, servedAsYears: Math.max(1, Math.trunc(requested)), mismatch: 'row-cap-as-years' };
}

function identityArguments(args: unknown): Record<string, unknown> {
  return isPlainObject(args) ? args : {};
}

function apiPaths(tool: ToolDef): readonly string[] {
  return Array.isArray(tool._apiPaths) ? tool._apiPaths : [];
}

function cacheKeys(tool: ToolDef): readonly string[] {
  return '_cacheKeys' in tool && Array.isArray(tool._cacheKeys) ? tool._cacheKeys : [];
}

function isPrimitive(value: unknown): boolean {
  return value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(alias: string, detail: string): never {
  throw new Error(`alias ${alias}: ${detail}`);
}
