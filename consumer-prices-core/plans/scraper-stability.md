# Consumer Prices Scraper Stability Plan (Rev 3 — Final)

## Problems being solved

| # | Problem | Impact |
|---|---------|--------|
| 1 | Exa re-discovers different product URLs each run | Spread/index volatility, no stable WoW |
| 2 | BigBasket: all observations in_stock=false | IN market completely dark |
| 3 | Disabled retailers stay active=true in DB | Pollutes health view |
| 4 | Spread computed on 1-2 overlapping categories | US spread 134.8% from single pair |
| 5 | Tamimi SA: 0 products | SA market dark |
| 6 | Naivas KE: disabled but shown in frontend MARKETS | KE shown as active with no data |

---

## Core: product pinning with soft-disable

product_matches rows are NEVER deleted. Stale pins set pin_disabled_at.
ALL analytics queries that read product_matches must filter pin_disabled_at IS NULL.
Exa rediscovery of the same URL clears pin_disabled_at to reactivate.

Flow:
  check product_matches for active pin (pin_disabled_at IS NULL)
    pin exists -> Firecrawl(pinned url) directly
      success + in_stock      -> reset counters (consecutive_out_of_stock=0, pin_error_count=0)
      success + out_of_stock  -> increment consecutive_out_of_stock; if >=3: soft-disable
      zero products (no throw) -> increment pin_error_count; if >=3: soft-disable
      exception (throw)        -> increment pin_error_count; if >=3: soft-disable
    no active pin -> Exa(search) -> Firecrawl -> upsertProductMatch (which clears pin_disabled_at)

---

## Task 1 — Migration 007

File: migrations/007_pinning_columns.sql

ALTER TABLE product_matches
  ADD COLUMN IF NOT EXISTS pin_disabled_at TIMESTAMPTZ;

ALTER TABLE retailer_products
  ADD COLUMN IF NOT EXISTS consecutive_out_of_stock INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_error_count INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pm_basket_active_pin
  ON product_matches(basket_item_id, retailer_product_id)
  WHERE pin_disabled_at IS NULL AND match_status IN ('auto', 'approved');

Note: non-concurrent index; brief write lock acceptable at current scale.
      Run a row count check before relying on integrity claims: verify product_matches
      count and basket_items count in a pre-deploy preflight.

---

## Task 2 — getPinnedUrlsForRetailer

Joins through retailer_products.retailer_id — no new column on product_matches.

SELECT DISTINCT ON (pm.basket_item_id)
  cp.canonical_name,
  b.slug AS basket_slug,
  rp.source_url,
  rp.id AS product_id,
  pm.id AS match_id              -- carry matchId for precise soft-disable updates
FROM product_matches pm
JOIN retailer_products rp ON rp.id = pm.retailer_product_id
JOIN basket_items bi ON bi.id = pm.basket_item_id
JOIN baskets b ON b.id = bi.basket_id
JOIN canonical_products cp ON cp.id = bi.canonical_product_id
WHERE rp.retailer_id = $1
  AND pm.match_status IN ('auto', 'approved')
  AND pm.pin_disabled_at IS NULL
  AND rp.consecutive_out_of_stock < 3
  AND rp.pin_error_count < 3
ORDER BY pm.basket_item_id, pm.match_score DESC

Returns Map<"basketSlug:canonicalName", { sourceUrl, productId, matchId }>.
Compound key prevents collisions if multi-basket-per-market ever exists.

---

## Task 3 — AdapterContext types

Add retailerId and pinnedUrls to AdapterContext interface.

---

## Task 4 — scrape.ts changes

### 4a — getOrCreateRetailer: write active + call before early return

scrapeAll() MUST iterate loadAllRetailerConfigs() WITHOUT .filter((c) => c.enabled).
All configs (enabled AND disabled) are passed to scrapeRetailer workers.
scrapeRetailer() upserts active first, then returns early for disabled ones.

async function getOrCreateRetailer(slug, config):
  INSERT INTO retailers (..., active)
  VALUES (..., $7)
  ON CONFLICT (slug) DO UPDATE SET
    name=..., adapter_key=..., base_url=..., active=EXCLUDED.active, updated_at=NOW()
  RETURNING id
  -- $7 = config.enabled

In scrapeRetailer():
  const retailerId = await getOrCreateRetailer(slug, config);  // MOVED BEFORE GUARD
  if (!config.enabled) { logger.info('disabled, skipping'); return; }
  // rest unchanged

In scrapeAll():
  const configs = await loadAllRetailerConfigs();  // NO .filter((c) => c.enabled)
  await Promise.allSettled(configs.map((c) => scrapeRetailer(c, runId)));

This fixes:

- Batch scrape (scrapeAll): disabled retailers still get DB sync
- Single-retailer CLI (scrapeRetailer via main)
- No separate syncRetailersFromConfig needed

### 4b — Load pins before discoverTargets

const pinnedUrls = await getPinnedUrlsForRetailer(retailerId);
logger.info(`${slug}: ${pinnedUrls.size} pins loaded`);
const ctx = { config, runId, logger, retailerId, pinnedUrls };

### 4c — Stale-pin maintenance

Two failure modes tracked separately:

After observation insert (direct targets):
  if (inStock) -> reset both counters to 0
  if (!inStock) -> increment consecutive_out_of_stock; if >=3: soft-disable via matchId

After zero-products (products.length === 0, no throw) for direct targets:
  call handlePinError(productId, matchId, target.id, logger)

In catch block for direct targets:
  call handlePinError(productId, matchId, target.id, logger)

handlePinError:
  UPDATE retailer_products SET pin_error_count = pin_error_count + 1 WHERE id = $productId
  RETURNING pin_error_count
  if >= 3: UPDATE product_matches SET pin_disabled_at = NOW() WHERE id = $matchId

Soft-disable uses matchId from pinned target metadata for precision.
On next run: no active pin found -> Exa re-discovery triggered automatically.

### 4d — Skip upsertProductMatch for direct targets

Existing match already present; creating a new one is wrong.
Guard: if (!target.metadata?.direct && adapter === 'search' && ...) { upsertMatch }

---

## Task 5 — upsertProductMatch: clear pin_disabled_at on upsert

When Exa rediscovers a URL and calls upsertProductMatch, reactivate the pin.

UPDATE product_matches SET
  basket_item_id = EXCLUDED.basket_item_id,
  match_score    = EXCLUDED.match_score,
  match_status   = EXCLUDED.match_status,
  pin_disabled_at = NULL              -- reactivate on fresh discovery
WHERE ...

Also reset counters on retailer_products when a match is successfully upserted:
  UPDATE retailer_products SET consecutive_out_of_stock=0, pin_error_count=0 WHERE id=$productId

---

## Task 6 — ALL analytics: add pin_disabled_at IS NULL filter

Files to update:

- src/jobs/aggregate.ts: getBasketRows query — add AND pm.pin_disabled_at IS NULL
- src/jobs/aggregate.ts: getBaselinePrices query — add BOTH AND pm.match_status IN ('auto', 'approved') [MISSING entirely today] AND pm.pin_disabled_at IS NULL
- src/snapshots/worldmonitor.ts: retailer spread query — add AND pm.pin_disabled_at IS NULL
- src/jobs/validate.ts: match-reading query — add AND pm.pin_disabled_at IS NULL

Without this, soft-disabled matches (stale products) still skew indices, baselines,
spread calculations, and validation results.

Note: getBaselinePrices currently has NO match_status guard at all. Adding both filters
is required. Without match_status IN ('auto','approved'), rejected/pending matches
can corrupt index baselines.

---

## Task 7 — SearchAdapter: pin branch + direct path

### discoverTargets:

For each basket item, look up ctx.pinnedUrls with compound key "basketSlug:canonicalName".
Validate pinned URL with isAllowedHost(url, domain) before using.

If valid pin: return target with metadata { direct: true, pinnedProductId, matchId }
Else: return search target (Exa path, unchanged)

### fetchTarget:

Extract Firecrawl logic into _extractFromUrl(ctx, url, canonicalName, currency).
For direct targets: validate isAllowedHost + http/https scheme, call _extractFromUrl.
For Exa targets: existing Exa -> _extractFromUrl flow.
Log when a stored pin is rejected by isAllowedHost.

---

## Task 8 — BigBasket: inStockFromPrice flag

Add inStockFromPrice: boolean to SearchConfigSchema (default false).
In _extractFromUrl: if inStockFromPrice && price > 0: set inStock=true + log override.
Add to bigbasket_in.yaml: inStockFromPrice: true

---

## Task 9 — Spread: minimum coverage + explicit 0 sentinel

aggregate.ts:
  if (commonItemIds.length >= 4) { compute spread }
  else { write retailer_spread_pct = 0 }  // explicit 0 prevents stale value persisting

snapshots/worldmonitor.ts buildRetailerSpreadSnapshot:
  apply same MIN_SPREAD_ITEMS=4 threshold; return spreadPct=0 when below.

---

## Task 10 — Tamimi SA query tweak

Change queryTemplate to: "{canonicalName} tamimi markets"
Add urlPathContains: /product
Disable with dated comment if still 0 after one run.

---

## Task 11 — Cross-repo: remove KE from frontend MARKETS

In worldmonitor repo: src/services/consumer-prices/index.ts
Remove ke from MARKETS array until a working KE retailer is validated.
KE basket data stays in DB.
Note: publish.ts already only includes markets with enabled retailers, so
this is a UI-layer cleanup, not a data concern.

---

## Task 12 — Tests (vitest)

tests/unit/pinning.test.ts:

- getPinnedUrlsForRetailer excludes pin_disabled_at IS NOT NULL
- getPinnedUrlsForRetailer excludes consecutive_out_of_stock >= 3 and pin_error_count >= 3
- discoverTargets returns direct=true when valid pin and isAllowedHost passes
- discoverTargets returns direct=false when no pin, invalid host, or non-http(s) scheme
- fetchTarget skips Exa for direct=true targets
- Reactivation: upsertProductMatch clears pin_disabled_at on same URL rediscovery
- Soft-disable via matchId: OOS path (3x) sets pin_disabled_at; match row NOT deleted
- Soft-disable via matchId: error path (3x) sets pin_disabled_at; match row NOT deleted
- Zero-products for direct target: triggers handlePinError same as exception path
- getBasketRows excludes rows where pm.pin_disabled_at IS NOT NULL
- getBaselinePrices excludes rows where pm.pin_disabled_at IS NOT NULL
- getBaselinePrices excludes rows where pm.match_status NOT IN ('auto','approved')
- scrapeAll passes disabled configs to scrapeRetailer (no enabled filter)
- scrapeRetailer calls getOrCreateRetailer before early-return for disabled configs

tests/unit/in-stock-from-price.test.ts:

- inStockFromPrice=true + price>0: inStock=true + log message
- inStockFromPrice=true + price=0: inStock unchanged
- inStockFromPrice=false: inStock unchanged

tests/unit/spread-threshold.test.ts:

- aggregateBasket writes spread=0 explicitly when commonItems < 4
- aggregateBasket writes computed spread when commonItems >= 4
- buildRetailerSpreadSnapshot returns spreadPct=0 below threshold

tests/unit/retailer-sync.test.ts:

- getOrCreateRetailer writes active=false for disabled config (via ON CONFLICT UPDATE)
- getOrCreateRetailer writes active=true for enabled config
- scrapeRetailer calls getOrCreateRetailer before early-return for disabled configs

---

## Immediate SQL hotfix

The getOrCreateRetailer fix supersedes manual hotfixes once deployed.
For now, run this to fix DB state immediately:

UPDATE retailers SET active = false WHERE slug IN (
  'coop_ch', 'migros_ch', 'sainsburys_gb',
  'naivas_ke', 'wholefoods_us', 'adcoop_ae'
);

(All six slugs whose YAML has enabled: false)

---

## Execution order

 1. SQL hotfix on Railway DB (all 6 disabled slugs)
 2. git checkout -b fix/scraper-stability origin/main (consumer-prices-core repo)
 3. Task 1  — migration 007
 4. Task 8  — inStockFromPrice
 5. Task 9  — spread threshold + sentinel
 6. Task 10 — tamimi SA query tweak
 7. Task 2  — getPinnedUrlsForRetailer
 8. Task 3  — AdapterContext types
 9. Task 4a — getOrCreateRetailer with active sync (call before early return)
10. Task 4b — pin loading in scrapeRetailer
11. Task 4c/4d — stale-pin maintenance + match guard
12. Task 5  — upsertProductMatch clears pin_disabled_at + resets counters
13. Task 6  — add pin_disabled_at IS NULL to all analytics queries
14. Task 7  — discoverTargets + fetchTarget direct path
15. Task 12 — tests
16. npm run migrate
17. npm run jobs:scrape
18. Verify: bigbasket_in in_stock counts, no product_matches rows deleted, disabled retailers active=false
19. npm run jobs:aggregate && npm run jobs:publish
20. PR in consumer-prices-core repo
21. Separate PR in worldmonitor repo: remove ke from MARKETS (Task 11)

---

## Expected outcomes

| Market | Before | After |
|--------|--------|-------|
| AE | Spread volatile | Stable (pinned SKUs every run) |
| IN | 0 in-stock | 12 items covered via inStockFromPrice |
| GB | 1/12 drifting | Pinned Tesco URLs reused |
| US | Spread 134.8% noise | Spread = 0 until >= 4 categories overlap |
| SA | 0 products | Better Exa query; disable if still 0 |
| KE | disabled but shown | Removed from frontend MARKETS |
| Historical matches | intact | Still intact (soft-disable only, never deleted) |
| Disabled retailers | active=true in DB | active=false via getOrCreateRetailer upsert |
| WoW | 0 everywhere | Appears March 29+ with stable index data |
