'use strict';

const INDICATORS = {
  internet: { indicatorCode: 'IT.NET.USER.ZS', unit: 'percent' },
  mobile: { indicatorCode: 'IT.CEL.SETS.P2', unit: 'per 100 people' },
  broadband: { indicatorCode: 'IT.NET.BBND.P2', unit: 'per 100 people' },
  rdSpend: { indicatorCode: 'GB.XPD.RSDV.GD.ZS', unit: 'percent of GDP' },
};

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

module.exports = { buildWorldBankTechObservations };
