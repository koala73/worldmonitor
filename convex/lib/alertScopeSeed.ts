import type { MutationCtx, QueryCtx } from "../_generated/server";
import { loadAlertCapabilities } from "./alertCapabilities";
import { isValidIso2 } from "./iso2";

// More followed countries than any plan's cap; only the oldest that fit are used.
const FOLLOWED_READ_LIMIT = 300;

/** The user's followed countries, oldest first, as canonical ISO-2 codes. */
export async function followedCountriesFor(ctx: MutationCtx | QueryCtx, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .query("followedCountries")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(FOLLOWED_READ_LIMIT);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of [...rows].sort((a, b) => a.addedAt - b.addedAt)) {
    const code = String(row.country).trim().toUpperCase();
    if (!isValidIso2(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * The countries an unscoped rule for `variant` takes from the user's followed
 * countries (#10873), within the plan's cap. A paid plan caps each rule. The
 * free ladder caps the union across every enabled rule
 * (freeAccountCountryUnionCount), so a country another enabled rule already
 * lists is free to repeat, and a new one is added only while the union has room.
 */
export async function seedCountriesForRule(
  ctx: MutationCtx | QueryCtx,
  userId: string,
  variant: string,
): Promise<string[]> {
  const caps = await loadAlertCapabilities(ctx, userId);
  const followed = await followedCountriesFor(ctx, userId);
  if (!caps.requireCountryScope) return followed.slice(0, caps.maxCountries);
  const rows = await ctx.db
    .query("alertRules")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const union = new Set<string>();
  for (const row of rows) {
    if (row.variant === variant || row.enabled === false) continue;
    for (const country of row.countries ?? []) union.add(country);
  }
  const out: string[] = [];
  for (const country of followed) {
    if (out.length >= caps.maxCountries) break;
    if (!union.has(country)) {
      if (union.size >= caps.maxCountries) continue;
      union.add(country);
    }
    out.push(country);
  }
  return out;
}
