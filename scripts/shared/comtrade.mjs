// Runtime adapter: Node requires JSON attributes; Vercel/Vite require bare JSON imports.
import registry from './comtrade-partners.json' with { type: 'json' };
import standardCodes from './un-to-iso2.json' with { type: 'json' };
import strategic from './comtrade-strategic-products.json' with { type: 'json' };
import commodities from './supply-vulnerability-commodities.json' with { type: 'json' };
import quantityUnits from './comtrade-quantity-units.json' with { type: 'json' };
import { createComtradePartnerNormalizer } from './comtrade-partners.mjs';
import { createComtradeBilateralCatalogue } from './comtrade-bilateral.mjs';

export {
  PREVIEW_MAX_RECORDS, ComtradeResponseError, comtradeFailureState,
  MIN_PARTNER_SHARE, MIN_PARTNERS, MAX_PARTNERS, selectPartners, leadingExporters,
  toCanonicalProduct, toPartnersProduct,
} from './comtrade-bilateral.mjs';

export const { normalizeComtradePartner, normalizeComtradeProducts } = createComtradePartnerNormalizer(registry, standardCodes);
export const { HS4_CODES, HS4_LABELS, MAX_HS4_CODES_PER_BATCH, HS4_BATCHES, parseRecords, groupByProduct, groupWorldExports, quantityUnitAbbr } = createComtradeBilateralCatalogue(strategic, commodities, normalizeComtradePartner, quantityUnits);
