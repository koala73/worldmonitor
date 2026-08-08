// Types for scripts/shared/comtrade-period.mjs so server/*.ts consumers stay
// covered by `npm run typecheck:api` (tsconfig.api.json includes server/).
// Mirrors the scripts/_simulation-queue-constants.d.mts precedent.

export declare function recentPeriod(now?: Date, lag?: number): string;
export declare function candidatePeriods(now?: Date): string[];
export declare function periodWindow(
  now?: Date,
  opts?: { from?: number; to?: number },
): string;
