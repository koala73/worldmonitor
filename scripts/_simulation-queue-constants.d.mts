// Declaration file for _simulation-queue-constants.mjs so TS callers don't
// need `// @ts-expect-error`. Kept hand-written (no .d.ts.map) because the
// shim is a flat const export module.

export const SIMULATION_TASK_KEY_PREFIX: string;
export const SIMULATION_TASK_QUEUE_KEY: string;
export const SIMULATION_TASK_TTL_SECONDS: number;

export const SIMULATION_OUTCOME_LATEST_KEY: string;
export const SIMULATION_OUTCOME_BY_RUN_KEY_PREFIX: string;
export const SIMULATION_OUTCOME_BY_RUN_TTL_SECONDS: number;

export const SIMULATION_PACKAGE_LATEST_KEY: string;

export const MAX_QUEUE_DEPTH: number;

export const VALID_RUN_ID_RE: RegExp;

export const SIMULATION_TRIGGER_RATE_LIMIT: Readonly<{ limit: number; window: string }>;

export function pkgFingerprint(pkgKey: string | null | undefined): Promise<string>;
