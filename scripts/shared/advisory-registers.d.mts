// Types for scripts/shared/advisory-registers.mjs so server/*.ts consumers
// stay covered by `npm run typecheck:api` (tsconfig.api.json includes server/).

export declare const ADVISORY_LEVEL_REGISTERS: readonly ['AU', 'US'];

export declare function isLevelledAdvisoryItem(item: unknown): boolean;

export declare function missingAdvisoryRegisters(items: unknown, registers?: readonly string[]): string[];
