/**
 * Days since a scrape last priced a product before validate and aggregate
 * stop using its latest observation.
 *
 * Scrapes run daily. A product no scrape has priced in two weeks is no longer
 * being refreshed: its pin was rejected, it fell out of discovery, or its
 * page stopped pricing. Its last price is not a current price. Without this
 * window, an observation captured months ago from a since-rejected JioMart URL
 * layout (₹3,700 for 1 kg of sugar) still voted in every cross-retailer
 * median, so every fresh BigBasket price for the same item was held.
 *
 * Measured on `retailer_products.last_seen_at`, which every successful scrape
 * bumps. `price_observations.observed_at` cannot stand in for it: an unchanged
 * payload reuses its existing observation row, so a stable price keeps its
 * first observation date while the scrape keeps confirming it.
 */
export const MAX_OBSERVATION_AGE_DAYS = 14;
