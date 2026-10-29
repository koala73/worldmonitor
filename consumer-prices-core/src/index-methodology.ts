/**
 * methodology_version stamped on essentials_index / value_index rows.
 *
 * '1' rows were written while every basket's baseDate (2025-01-01) predated
 * the first price observation (2026-03), so no item ever had a baseline and
 * every index fell back to exactly 100. '2' measures each item against its
 * first observed price on or after baseDate. Readers compare only '2' rows so
 * the old constant 100s never become a week-over-week or month-over-month base.
 */
export const INDEX_METHODOLOGY_VERSION = '2';
