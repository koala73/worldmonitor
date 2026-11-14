// A reservoir level is beyond its seasonal baseline when its seasonal z-score (see
// seasonalBaseline in scripts/_reservoir-levels.mjs) reaches this magnitude. Shared so the
// seeder's low/high status and the country water signal family use one threshold.
export const SEASONAL_Z_ALERT = 1.5;
