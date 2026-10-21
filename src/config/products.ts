/**
 * Dodo Payments product IDs for frontend checkout CTAs.
 *
 * AUTO-GENERATED source: src/config/products.generated.ts
 * Canonical source: convex/config/productCatalog.ts
 *
 * This file re-exports from the generated file for backward compatibility.
 * Do not add product IDs here manually.
 */

import {
  DODO_PRODUCTS,
  PLAN_LIMITS,
  DEFAULT_UPGRADE_PRODUCT,
} from './products.generated';

export { DODO_PRODUCTS, PLAN_LIMITS, DEFAULT_UPGRADE_PRODUCT };

/** Dodo product id. Plan keys such as `pro_monthly` are not members. */
export type DodoProductId = (typeof DODO_PRODUCTS)[keyof typeof DODO_PRODUCTS];

const DODO_PRODUCT_ID_VALUES = Object.values(DODO_PRODUCTS);

export function parseDodoProductId(value: string): DodoProductId | null {
  for (const id of DODO_PRODUCT_ID_VALUES) {
    if (id === value) return id;
  }
  return null;
}
