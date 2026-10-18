// Every /tools/<slug>/ live data page. The corpus build, the weekly pulse
// freeze and the routing middleware all read this one list.

import { UnpublishableReading } from './common.mjs';
import { crudeOilInventoriesPage } from './crude-oil-inventories.mjs';
import { fearGreedPage } from './fear-greed.mjs';
import { internetOutagesPage } from './internet-outages.mjs';
import { nationalDebtPage } from './national-debt.mjs';
import { predictionMarketsPage } from './prediction-markets.mjs';
import { treasuryYieldCurvePage } from './treasury-yield-curve.mjs';

export const LIVE_TOPIC_PAGES = Object.freeze([
  fearGreedPage,
  internetOutagesPage,
  predictionMarketsPage,
  nationalDebtPage,
  treasuryYieldCurvePage,
  crudeOilInventoriesPage,
]);

const BY_PATH = new Map(LIVE_TOPIC_PAGES.map((page) => [page.path, page]));

export function liveTopicPageForPath(pathname) {
  return BY_PATH.get(pathname) || null;
}

/** RPC path without its query, as the gateway and public-rpc-cache key it. */
export function liveTopicRpcPath(page) {
  return page.statusPath.split('?')[0];
}

/**
 * The reading for a page, or null when the payload cannot be published as
 * current (stale, empty). A null reading renders the "no current reading"
 * section. Any other error is a bug and propagates.
 */
export function liveTopicReading(page, payload, now = Date.now()) {
  try {
    return page.record(payload, now);
  } catch (error) {
    if (error instanceof UnpublishableReading) return null;
    throw error;
  }
}
