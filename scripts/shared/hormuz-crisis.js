/**
 * Dating of the 2026 Strait of Hormuz crisis. The browser panel, the edge
 * shock model and the seeders read it from here so every "pre-crisis" and
 * "current flows" figure uses the same months.
 *
 * - HORMUZ_CRISIS_START_DATE: the pinned crisis start (UTC date). The Energy
 *   Risk panel may still override it with VITE_HORMUZ_CRISIS_START_DATE.
 * - PRE_CRISIS_WINDOW: the 12 full calendar months before the crisis month
 *   (2026-02). February 2026 itself is excluded because it straddles the start.
 * - CURRENT_FLOWS_WINDOW: the latest `months` monthly observations, none
 *   earlier than `earliestMonth`, the first full month after the start.
 */
export const HORMUZ_CRISIS_START_DATE = '2026-02-23';

export const PRE_CRISIS_WINDOW = Object.freeze({ startMonth: '2025-02', endMonth: '2026-01' });

export const CURRENT_FLOWS_WINDOW = Object.freeze({ months: 3, earliestMonth: '2026-03' });
