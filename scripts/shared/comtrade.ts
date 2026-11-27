// Runtime adapter: Node requires JSON attributes; Vercel/Vite require bare JSON imports.
import registry from './comtrade-partners.json';
import standardCodes from './un-to-iso2.json';
import strategic from './comtrade-strategic-products.json';
import commodities from './supply-vulnerability-commodities.json';
import quantityUnits from './comtrade-quantity-units.json';
import extended from './comtrade-extended-products.json';
import { createComtradePartnerNormalizer } from './comtrade-partners.mjs';
import { createComtradeBilateralCatalogue } from './comtrade-bilateral.mjs';

export {
  PREVIEW_MAX_RECORDS, ComtradeResponseError, comtradeFailureState,
  MIN_PARTNER_SHARE, MIN_PARTNERS, MAX_PARTNERS, selectPartners, leadingExporters,
  toCanonicalProduct, toPartnersProduct,
} from './comtrade-bilateral.mjs';

export const { normalizeComtradePartner, normalizeComtradeProducts } = createComtradePartnerNormalizer(registry, standardCodes);
export const { HS4_CODES, HS4_LABELS, MAX_HS4_CODES_PER_BATCH, HS4_BATCHES, parseRecords, groupByProduct, groupWorldExports, quantityUnitAbbr } = createComtradeBilateralCatalogue(strategic, commodities, normalizeComtradePartner, quantityUnits);

// Extended headings (rubber, cocoa, fish, processed food, oleochemicals),
// seeded by their own monthly job into keys apart from the core catalogue so
// the all-country bulk readers of the core keys do not grow. One batch of at
// most 20 codes, and no code may also be a core heading: a reader resolves a
// heading to exactly one key family.
const extendedCatalogue = createComtradeBilateralCatalogue(extended, { commodities: [] }, normalizeComtradePartner, quantityUnits);
if (extendedCatalogue.HS4_BATCHES.length !== 1) throw new Error('Extended bilateral catalogue must fit one request');
if (extendedCatalogue.HS4_CODES.some(code => HS4_CODES.includes(code))) throw new Error('Extended bilateral catalogue overlaps the core catalogue');
export const EXT_HS4_CODES = extendedCatalogue.HS4_CODES;
export const EXT_HS4_LABELS = extendedCatalogue.HS4_LABELS;
export const EXT_HS4_BATCH = extendedCatalogue.HS4_BATCHES[0];
export const groupExtByProduct = extendedCatalogue.groupByProduct;
