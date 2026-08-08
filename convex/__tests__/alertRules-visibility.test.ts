import { describe, expect, test } from "vitest";
import * as alertRules from "../alertRules";

/**
 * Regression guard for GHSA-r649-4cqj-w93h — anonymous cross-tenant read of
 * every user's alert rules via the public Convex query `getByEnabled`.
 *
 * `getByEnabled` scans the `by_enabled` index and returns rows across ALL
 * users with no per-caller scope, so it MUST NEVER be exported with the public
 * `query()` constructor: that surface is reachable by any anonymous client that
 * knows the (non-secret) deployment URL. It has to be `internalQuery`, reachable
 * only via `ctx.runQuery` (the shared-secret `/relay/enabled-rules` HTTP action)
 * or a deploy-key `convex run`.
 *
 * Convex stamps registered functions at module-load time: public builders set
 * `isPublic`, internal builders set `isInternal`
 * (node_modules/convex/dist/esm/server/impl/registration_impl.js). Asserting the
 * marker directly flips this test RED the instant someone re-widens the function
 * back to `query()`.
 */
describe("alertRules query visibility (GHSA-r649-4cqj-w93h)", () => {
  test("getByEnabled is INTERNAL — cross-tenant read must never be public", () => {
    const fn = alertRules.getByEnabled as unknown as {
      isQuery?: boolean;
      isInternal?: boolean;
      isPublic?: boolean;
    };
    expect(fn.isQuery).toBe(true);
    expect(fn.isInternal).toBe(true);
    expect(fn.isPublic).toBeUndefined();
  });

  test("getDigestRules stays internal (sibling cross-tenant scan)", () => {
    const fn = alertRules.getDigestRules as unknown as { isInternal?: boolean };
    expect(fn.isInternal).toBe(true);
  });

  test("getAlertRules stays public but self-scopes to the authenticated caller", () => {
    // Public is safe here ONLY because the handler gates on getUserIdentity()
    // and scopes to the `by_user` index — unlike getByEnabled.
    const fn = alertRules.getAlertRules as unknown as { isPublic?: boolean };
    expect(fn.isPublic).toBe(true);
  });
});
