import type {
  ServerContext,
  GetSectorDependencyRequest,
  GetSectorDependencyResponse,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { isCallerPremium } from '../../../_shared/premium-check';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const HS2_LABELS: Record<string, string> = {
  '1': 'Live Animals', '2': 'Meat', '3': 'Fish & Seafood', '4': 'Dairy',
  '6': 'Plants & Flowers', '7': 'Vegetables', '8': 'Fruit & Nuts',
  '10': 'Cereals', '11': 'Milling Products', '12': 'Oilseeds', '15': 'Animal & Vegetable Fats',
  '16': 'Meat Preparations', '17': 'Sugar', '18': 'Cocoa', '19': 'Food Preparations',
  '22': 'Beverages & Spirits', '23': 'Residues & Animal Feed', '24': 'Tobacco',
  '25': 'Salt & Cement', '26': 'Ores, Slag & Ash', '27': 'Mineral Fuels & Energy',
  '28': 'Inorganic Chemicals', '29': 'Organic Chemicals', '30': 'Pharmaceuticals',
  '31': 'Fertilizers', '38': 'Chemical Products', '39': 'Plastics',
  '40': 'Rubber', '44': 'Wood', '47': 'Pulp & Paper', '48': 'Paper & Paperboard',
  '52': 'Cotton', '61': 'Clothing (Knitted)', '62': 'Clothing (Woven)',
  '71': 'Precious Metals & Gems', '72': 'Iron & Steel', '73': 'Iron & Steel Articles',
  '74': 'Copper', '76': 'Aluminium', '79': 'Zinc', '80': 'Tin',
  '84': 'Machinery & Mechanical Appliances', '85': 'Electrical & Electronic Equipment',
  '86': 'Railway', '87': 'Vehicles', '88': 'Aircraft', '89': 'Ships & Boats',
  '90': 'Optical & Medical Instruments', '93': 'Arms & Ammunition',
};

export async function getSectorDependency(
  ctx: ServerContext,
  req: GetSectorDependencyRequest,
): Promise<GetSectorDependencyResponse> {
  const isPro = await isCallerPremium(ctx.request);
  const empty: GetSectorDependencyResponse = {
    iso2: req.iso2,
    hs2: req.hs2 || '27',
    hs2Label: HS2_LABELS[req.hs2 || '27'] ?? `HS ${req.hs2}`,
    flags: [],
    primaryExporterIso2: '',
    primaryExporterShare: 0,
    primaryChokepointId: '',
    primaryChokepointExposure: 0,
    hasViableBypass: false,
    fetchedAt: '',
  };
  if (!isPro) return markNoStoreFallbackResponse(ctx.request, empty);

  const iso2 = req.iso2?.trim().toUpperCase();
  const hs2 = req.hs2?.trim().replace(/\D/g, '') || '27';

  if (!/^[A-Z]{2}$/.test(iso2 ?? '') || !/^\d{1,2}$/.test(hs2)) {
    return markNoStoreFallbackResponse(ctx.request, { ...empty, iso2: iso2 ?? '', hs2 });
  }

  // Available Comtrade stores cover selected products, not complete HS2 chapters.
  return markNoStoreFallbackResponse(ctx.request, { ...empty, iso2, hs2, hs2Label: HS2_LABELS[hs2] ?? `HS ${hs2}` });
}
