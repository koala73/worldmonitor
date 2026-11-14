'use strict';

const INDICATORS = {
  internet: { indicatorCode: 'IT.NET.USER.ZS', unit: 'percent', max: 100, weight: 30 },
  mobile: { indicatorCode: 'IT.CEL.SETS.P2', unit: 'per 100 people', max: 150, weight: 15 },
  broadband: { indicatorCode: 'IT.NET.BBND.P2', unit: 'per 100 people', max: 50, weight: 20 },
  rdSpend: { indicatorCode: 'GB.XPD.RSDV.GD.ZS', unit: 'percent of GDP', max: 5, weight: 35 },
};
const MIN_COMPONENTS = 3;

function buildWorldBankTechObservations(valuesByKey) {
  return Object.fromEntries(Object.entries(INDICATORS).map(([key, indicator]) => {
    const observation = valuesByKey?.[key];
    if (observation?.value == null || observation?.year == null) return [key, null];
    const value = Number(observation?.value);
    const year = Number(observation?.year);
    if (!Number.isFinite(value) || !Number.isInteger(year)) return [key, null];
    return [key, {
      value,
      year,
      unit: indicator.unit,
      indicatorCode: indicator.indicatorCode,
      source: 'World Bank',
    }];
  }));
}

function computeWorldBankTechRankings(indicatorData) {
  const countries = new Set(Object.values(indicatorData).flatMap(Object.keys));
  const entries = [];
  for (const country of countries) {
    const valuesByKey = Object.fromEntries(
      Object.keys(INDICATORS).map(key => [key, indicatorData[key]?.[country]]),
    );
    const observations = buildWorldBankTechObservations(valuesByKey);
    const components = {};
    let componentCount = 0;
    let totalWeight = 0;
    let weightedSum = 0;
    for (const [key, { max, weight }] of Object.entries(INDICATORS)) {
      const observation = observations[key];
      components[key] = observation && observation.value >= 0
        ? Math.min(100, (observation.value / max) * 100)
        : null;
      if (components[key] === null) continue;
      componentCount += 1;
      totalWeight += weight;
      weightedSum += components[key] * weight;
    }
    const score = componentCount >= MIN_COMPONENTS
      ? Math.round((weightedSum / totalWeight) * 10) / 10
      : null;
    const countryName = Object.values(valuesByKey).find(value => value?.name)?.name || country;
    entries.push({ country, countryName, score, rank: null, componentCount, components, observations });
  }
  entries.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  entries.forEach((entry, index) => {
    if (entry.score !== null) entry.rank = index + 1;
  });
  return entries;
}

module.exports = { buildWorldBankTechObservations, computeWorldBankTechRankings };
