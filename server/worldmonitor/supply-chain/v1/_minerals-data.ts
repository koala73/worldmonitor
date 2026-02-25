export interface MineralProductionEntry {
  mineral: string;
  country: string;
  countryCode: string;
  productionTonnes: number;
  unit: string;
}

export const MINERAL_PRODUCTION_2024: MineralProductionEntry[] = [
  // Lithium (tonnes LCE)
  { mineral: 'Lithium', country: 'Australia', countryCode: 'AU', productionTonnes: 86000, unit: 'tonnes LCE' },
  { mineral: 'Lithium', country: 'Chile', countryCode: 'CL', productionTonnes: 44000, unit: 'tonnes LCE' },
  { mineral: 'Lithium', country: 'China', countryCode: 'CN', productionTonnes: 33000, unit: 'tonnes LCE' },
  { mineral: 'Lithium', country: 'Argentina', countryCode: 'AR', productionTonnes: 9600, unit: 'tonnes LCE' },

  // Cobalt (tonnes)
  { mineral: 'Cobalt', country: 'DRC', countryCode: 'CD', productionTonnes: 130000, unit: 'tonnes' },
  { mineral: 'Cobalt', country: 'Indonesia', countryCode: 'ID', productionTonnes: 17000, unit: 'tonnes' },
  { mineral: 'Cobalt', country: 'Russia', countryCode: 'RU', productionTonnes: 8900, unit: 'tonnes' },
  { mineral: 'Cobalt', country: 'Australia', countryCode: 'AU', productionTonnes: 5600, unit: 'tonnes' },

  // Rare Earths (tonnes REO)
  { mineral: 'Rare Earths', country: 'China', countryCode: 'CN', productionTonnes: 240000, unit: 'tonnes REO' },
  { mineral: 'Rare Earths', country: 'Myanmar', countryCode: 'MM', productionTonnes: 38000, unit: 'tonnes REO' },
  { mineral: 'Rare Earths', country: 'USA', countryCode: 'US', productionTonnes: 43000, unit: 'tonnes REO' },
  { mineral: 'Rare Earths', country: 'Australia', countryCode: 'AU', productionTonnes: 18000, unit: 'tonnes REO' },

  // Nickel (tonnes)
  { mineral: 'Nickel', country: 'Indonesia', countryCode: 'ID', productionTonnes: 1800000, unit: 'tonnes' },
  { mineral: 'Nickel', country: 'Philippines', countryCode: 'PH', productionTonnes: 330000, unit: 'tonnes' },
  { mineral: 'Nickel', country: 'Russia', countryCode: 'RU', productionTonnes: 220000, unit: 'tonnes' },
  { mineral: 'Nickel', country: 'New Caledonia', countryCode: 'NC', productionTonnes: 190000, unit: 'tonnes' },

  // Copper (tonnes)
  { mineral: 'Copper', country: 'Chile', countryCode: 'CL', productionTonnes: 5300000, unit: 'tonnes' },
  { mineral: 'Copper', country: 'DRC', countryCode: 'CD', productionTonnes: 2500000, unit: 'tonnes' },
  { mineral: 'Copper', country: 'Peru', countryCode: 'PE', productionTonnes: 2200000, unit: 'tonnes' },
  { mineral: 'Copper', country: 'China', countryCode: 'CN', productionTonnes: 1900000, unit: 'tonnes' },

  // Gallium (tonnes)
  { mineral: 'Gallium', country: 'China', countryCode: 'CN', productionTonnes: 600, unit: 'tonnes' },
  { mineral: 'Gallium', country: 'Japan', countryCode: 'JP', productionTonnes: 10, unit: 'tonnes' },
  { mineral: 'Gallium', country: 'South Korea', countryCode: 'KR', productionTonnes: 8, unit: 'tonnes' },
  { mineral: 'Gallium', country: 'Russia', countryCode: 'RU', productionTonnes: 5, unit: 'tonnes' },

  // Germanium (tonnes)
  { mineral: 'Germanium', country: 'China', countryCode: 'CN', productionTonnes: 95, unit: 'tonnes' },
  { mineral: 'Germanium', country: 'Belgium', countryCode: 'BE', productionTonnes: 15, unit: 'tonnes' },
  { mineral: 'Germanium', country: 'Canada', countryCode: 'CA', productionTonnes: 9, unit: 'tonnes' },
  { mineral: 'Germanium', country: 'Russia', countryCode: 'RU', productionTonnes: 5, unit: 'tonnes' },
];
