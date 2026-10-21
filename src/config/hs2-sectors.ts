/**
 * Static dictionary of all 99 HS2 chapters.
 *
 * In v1, only HS 27 (Mineral Fuels) has a full energy shock model.
 * All others return null for coverageDays with an explanatory tooltip.
 */
export type HS2Category =
  | 'energy'
  | 'automotive'
  | 'electronics'
  | 'pharma'
  | 'food'
  | 'chemicals'
  | 'metals'
  | 'textiles'
  | 'machinery'
  | 'agriculture'
  | 'other';

export type CargoType = 'tanker' | 'container' | 'bulk' | 'roro' | 'mixed';

export interface HS2Sector {
  hs2: string;
  label: string;
  category: HS2Category;
  /**
   * True only for HS 27 in v1 — the only sector with IEA stock coverage
   * + BDI correlation for cost-shock modeling.
   */
  shockModelSupported: boolean;
  typicalCargoType: CargoType;
}

export const HS2_SECTORS: readonly HS2Sector[] = [
  { hs2: '01', label: 'Live Animals', category: 'agriculture', shockModelSupported: false, typicalCargoType: 'roro' },
  { hs2: '02', label: 'Meat & Edible Offal', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '03', label: 'Fish & Seafood', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '04', label: 'Dairy, Eggs & Honey', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '05', label: 'Other Animal Products', category: 'agriculture', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '06', label: 'Live Plants & Cut Flowers', category: 'agriculture', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '07', label: 'Vegetables', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '08', label: 'Fruit & Nuts', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '09', label: 'Coffee, Tea & Spices', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '10', label: 'Cereals', category: 'food', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '11', label: 'Milling Products', category: 'food', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '12', label: 'Oil Seeds & Oleaginous Fruits', category: 'agriculture', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '13', label: 'Lac, Gums & Resins', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '14', label: 'Vegetable Plaiting Materials', category: 'agriculture', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '15', label: 'Animal & Vegetable Fats & Oils', category: 'food', shockModelSupported: false, typicalCargoType: 'tanker' },
  { hs2: '16', label: 'Meat & Fish Preparations', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '17', label: 'Sugars & Sugar Confectionery', category: 'food', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '18', label: 'Cocoa & Cocoa Preparations', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '19', label: 'Cereal, Flour & Starch Preparations', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '20', label: 'Vegetable & Fruit Preparations', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '21', label: 'Miscellaneous Food Preparations', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '22', label: 'Beverages & Vinegar', category: 'food', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '23', label: 'Food Residues & Animal Feed', category: 'agriculture', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '24', label: 'Tobacco', category: 'agriculture', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '25', label: 'Salt, Sulphur, Earths & Cements', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '26', label: 'Ores, Slag & Ash', category: 'metals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '27', label: 'Mineral Fuels & Oils', category: 'energy', shockModelSupported: true, typicalCargoType: 'tanker' },
  { hs2: '28', label: 'Inorganic Chemicals', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '29', label: 'Organic Chemicals', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'tanker' },
  { hs2: '30', label: 'Pharmaceutical Products', category: 'pharma', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '31', label: 'Fertilisers', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '32', label: 'Dyes, Pigments & Paints', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '33', label: 'Essential Oils & Cosmetics', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '34', label: 'Soaps & Cleaning Preparations', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '35', label: 'Albuminoidal Substances & Glues', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '36', label: 'Explosives & Pyrotechnics', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '37', label: 'Photographic & Cinematographic Goods', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '38', label: 'Miscellaneous Chemical Products', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '39', label: 'Plastics & Articles', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '40', label: 'Rubber & Articles', category: 'chemicals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '41', label: 'Raw Hides, Skins & Leather', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '42', label: 'Leather Articles, Handbags & Saddlery', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '43', label: 'Furskins & Artificial Fur', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '44', label: 'Wood & Articles of Wood', category: 'other', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '45', label: 'Cork & Articles of Cork', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '46', label: 'Plaiting Materials & Basketwork', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '47', label: 'Pulp of Wood & Paper Waste', category: 'other', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '48', label: 'Paper & Paperboard', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '49', label: 'Printed Books, Newspapers & Manuscripts', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '50', label: 'Silk', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '51', label: 'Wool & Fine Animal Hair', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '52', label: 'Cotton', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '53', label: 'Other Vegetable Textile Fibres', category: 'textiles', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '54', label: 'Man-made Filaments', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '55', label: 'Man-made Staple Fibres', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '56', label: 'Wadding, Felt & Nonwovens', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '57', label: 'Carpets & Floor Coverings', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '58', label: 'Special Woven Fabrics', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '59', label: 'Impregnated Textile Fabrics', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '60', label: 'Knitted or Crocheted Fabrics', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '61', label: 'Knitted or Crocheted Clothing', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '62', label: 'Woven Clothing', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '63', label: 'Other Made-up Textile Articles', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '64', label: 'Footwear', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '65', label: 'Headgear', category: 'textiles', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '66', label: 'Umbrellas, Walking Sticks & Whips', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '67', label: 'Prepared Feathers & Artificial Flowers', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '68', label: 'Stone, Plaster & Cement Articles', category: 'other', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '69', label: 'Ceramic Products', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '70', label: 'Glass & Glassware', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '71', label: 'Natural Pearls, Precious Stones & Metals', category: 'metals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '72', label: 'Iron & Steel', category: 'metals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '73', label: 'Articles of Iron or Steel', category: 'metals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '74', label: 'Copper & Articles', category: 'metals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '75', label: 'Nickel & Articles', category: 'metals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '76', label: 'Aluminium & Articles', category: 'metals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '78', label: 'Lead & Articles', category: 'metals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '79', label: 'Zinc & Articles', category: 'metals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '80', label: 'Tin & Articles', category: 'metals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '81', label: 'Other Base Metals & Cermets', category: 'metals', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '82', label: 'Tools, Implements & Cutlery of Base Metal', category: 'metals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '83', label: 'Miscellaneous Base Metal Articles', category: 'metals', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '84', label: 'Nuclear Reactors, Boilers & Machinery', category: 'machinery', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '85', label: 'Electrical Machinery & Electronics', category: 'electronics', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '86', label: 'Railway & Tramway Equipment', category: 'machinery', shockModelSupported: false, typicalCargoType: 'roro' },
  { hs2: '87', label: 'Vehicles (Automotive)', category: 'automotive', shockModelSupported: false, typicalCargoType: 'roro' },
  { hs2: '88', label: 'Aircraft & Spacecraft', category: 'machinery', shockModelSupported: false, typicalCargoType: 'roro' },
  { hs2: '89', label: 'Ships & Boats', category: 'machinery', shockModelSupported: false, typicalCargoType: 'bulk' },
  { hs2: '90', label: 'Optical, Photographic & Medical Instruments', category: 'electronics', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '91', label: 'Clocks & Watches', category: 'electronics', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '92', label: 'Musical Instruments', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '93', label: 'Arms & Ammunition', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '94', label: 'Furniture & Bedding', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '95', label: 'Toys, Games & Sports Equipment', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '96', label: 'Miscellaneous Manufactured Articles', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '97', label: 'Works of Art & Antiques', category: 'other', shockModelSupported: false, typicalCargoType: 'container' },
  { hs2: '98', label: 'Special Classification Provisions', category: 'other', shockModelSupported: false, typicalCargoType: 'mixed' },
  { hs2: '99', label: 'Special Import Provisions', category: 'other', shockModelSupported: false, typicalCargoType: 'mixed' },
];

/** Map from hs2 string → HS2Sector for O(1) lookup. */
export const HS2_SECTOR_MAP = new Map<string, HS2Sector>(
  HS2_SECTORS.map(s => [s.hs2, s]),
);

export function getHS2Sector(hs2: string): HS2Sector | undefined {
  return HS2_SECTOR_MAP.get(hs2.padStart(2, '0'));
}

/** HS2 chapters that are modeled in the energy shock engine (v1: only '27'). */
export const SHOCK_SUPPORTED_HS2 = HS2_SECTORS.filter(s => s.shockModelSupported).map(s => s.hs2);
