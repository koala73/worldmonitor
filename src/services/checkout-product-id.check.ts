import type { DODO_PRODUCTS, DodoProductId } from '@/config/products';
import type { startCheckout } from './checkout';

type Expect<T extends true> = T;
type ProductArg = Parameters<typeof startCheckout>[0];

export const checkoutProductIdChecks = {
  planKeyRejected: true as Expect<'pro_monthly' extends ProductArg ? false : true>,
  proMonthlyAccepted: true as Expect<(typeof DODO_PRODUCTS)['PRO_MONTHLY'] extends ProductArg ? true : false>,
  parameterIsCatalogId: true as Expect<ProductArg extends DodoProductId ? true : false>,
};
