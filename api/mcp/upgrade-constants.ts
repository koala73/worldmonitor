/**
 * Numeric constants for the MCP paid-funnel free-account allowance (#6716).
 * Split from `upgrade.ts` / `free-account-allowance.ts` so the catalog and
 * tests can import the numbers without pulling Redis or denial copy.
 */

/** Absolute tools/call ceiling per UTC day for a free account. */
export const FREE_ACCOUNT_CALLS_PER_DAY = 5;

/** Idle-gap request windows allowed per UTC day. */
export const FREE_ACCOUNT_REQUESTS_PER_DAY = 3;

/**
 * Idle gap that opens a new "request" window. MCP desktop clients initialize
 * once and hold the session across questions — wall-clock gaps are the only
 * honest task boundary.
 */
export const FREE_ACCOUNT_IDLE_GAP_MS = 15 * 60 * 1000;
