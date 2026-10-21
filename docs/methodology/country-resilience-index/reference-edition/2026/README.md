# Country Resilience Reference Edition 2026

This bundle is the reproducibility artifact for the Country Resilience Index reference edition. It freezes country-sliced Redis inputs used by a sampled production score run and verifies that the checked-in scorer recomputes the pinned reference scores from those inputs without live Redis access. The pinned published values are copied from the production score cache at capture time; generation fails if the frozen input slices do not reproduce those score-cache values within tolerance.

## Contents

- `manifest.json` - frozen country-sliced Redis key/value snapshot, score-cache metadata, sampled countries, sampled dimensions, pinned reference outputs, and tolerances.
- `recompute.mts` - local verifier that recomputes the sampled scores from `manifest.json`.

The 2026 sample covers Norway, the United States, Turkey, Yemen, Switzerland, the United Arab Emirates, India, Syria, Nauru, and Eritrea — chosen to span balanced high-resilience, large economies, GCC/sovereign-wealth, imbalanced conflict states, a greyed microstate, and a low-coverage/high-imputation case. The pinned dimensions cover governance, conflict/border pressure, fiscal space, active reserve adequacy (`liquidReserveAdequacy`), external-debt coverage, and sovereign fiscal buffers. The retired `reserveAdequacy` dimension remains in the production schema for structural continuity, but the active reserve mechanism is `liquidReserveAdequacy`.

## Refresh

Regenerate the manifest from production Redis:

```bash
npx tsx scripts/freeze-resilience-reference-edition.mts --refresh-score-cache
```

The `--refresh-score-cache` flag rewrites the sampled `RESILIENCE_SCORE_CACHE_PREFIX` entries before capture so the authoritative published values and frozen input slices are from the same production input state. Omit it for a read-only audit run; the generator will fail if the existing score cache has drifted from the current inputs.

Verify the committed artifact:

```bash
npx tsx docs/methodology/country-resilience-index/reference-edition/2026/recompute.mts
npx tsx --test tests/resilience-reference-recompute.test.mts
```
