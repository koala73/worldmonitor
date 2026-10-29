/**
 * Oldest price observation the validate and aggregate jobs still use.
 *
 * Scrapes run daily. A product with no observation in two weeks is no longer
 * being refreshed: its pin was rejected, it fell out of discovery, or its
 * page stopped pricing. Its last price is not a current price. Without this
 * window, an observation captured months ago from a since-rejected JioMart URL
 * layout (₹3,700 for 1 kg of sugar) still voted in every cross-retailer
 * median, so every fresh BigBasket price for the same item was held.
 */
export const MAX_OBSERVATION_AGE_DAYS = 14;
