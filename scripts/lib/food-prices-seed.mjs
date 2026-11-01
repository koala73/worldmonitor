import sources from '../shared/food-price-sources.json' with { type: 'json' };
import { loadEnvFile, readSeedSnapshot, runSeed } from '../_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from '../_upstash-rest.mjs';
import { tokensToContentMeta, DAY_MIN } from '../_content-age-helpers.mjs';
import { collectFoodSource } from './food-prices-fetch.mjs';
import { mergeHistory } from './food-prices.mjs';
import { isMainModule } from './main-module.mjs';

// Fetch-phase time beyond the collection budget, for the last-good snapshot read and the merge.
export const FOOD_FETCH_MARGIN_MS = 15_000;

export function mergeFoodSnapshot(previous, incoming) {
  const latestDate = rows => (rows ?? []).map(row => row.date).sort().at(-1) ?? '';
  if (incoming.observations.length && latestDate(previous?.observations) > latestDate(incoming.observations)) {
    throw new Error('food report regressed; retain last-good prices');
  }
  const oldContexts = new Map((previous?.contexts ?? []).map(context => [context.countryCode, context]));
  return {
    ...incoming,
    observations: incoming.observations.length ? mergeHistory(previous?.observations ?? [], incoming.observations, incoming.refreshedReports) : [],
    contexts: incoming.contexts.map(context => context.fetchFailed && oldContexts.get(context.countryCode)?.referenceDate
      ? { ...oldContexts.get(context.countryCode), fetchFailed: true } : context),
  };
}

export function runFoodPriceSource(id, moduleUrl) {
  if (!isMainModule(moduleUrl, process.argv[1])) return;
  loadEnvFile(moduleUrl);
  const source = sources.find(source => source.id === id);
  if (!source) throw new Error('unknown food-price source');
  const resource = `food-prices-${id}`;
  const key = `economic:food-prices:${id}:v1`;
  const activationKey = `seed-activated:economic:${resource}`;
  const count = data => data.observations.length + data.contexts.filter(context => context.referenceDate).length;
  return runSeed('economic', resource, key, async () => {
    // A failed read must not erase history needed for the exact-week baseline.
    const previous = await readSeedSnapshot(key, { strict: true });
    return mergeFoodSnapshot(previous, await collectFoodSource(id, { budgetMs: source.fetchBudgetMs }));
  }, {
    validateFn: data => count(data) > 0,
    recordCount: count, declareRecords: count,
    ttlSeconds: Math.max(45, source.maxContentAgeDays + 14) * 86400,
    // Cover retried staging/canonical/cleanup and freshness writes after the fetch deadline.
    lockTtlMs: source.fetchBudgetMs + 600_000, fetchPhaseTimeoutMs: source.fetchBudgetMs + FOOD_FETCH_MARGIN_MS,
    sourceVersion: `food-prices-${id}-v1`, schemaVersion: 1,
    maxStaleMin: source.maxFetchAgeDays * DAY_MIN,
    contentMeta: data => tokensToContentMeta([...data.observations.map(row => row.date), ...data.contexts.map(context => context.referenceDate)]),
    maxContentAgeMin: source.maxContentAgeDays * DAY_MIN,
    afterPublish: async () => {
      const creds = getOptionalUpstashCreds();
      if (creds) await upstashCommand(creds, ['SET', activationKey, '1']);
    },
  }).catch(error => { console.error(`FATAL food-prices ${id}:`, error.message); process.exitCode = 1; });
}
