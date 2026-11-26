/**
 * Synced dashboard tabs (#11141): convex/userPreferences.ts
 * `listDashboardTabs` / `syncDashboardTabs` and the record validator.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { USER_PREFS_WRITE_RATE_LIMIT } from "../constants";
import {
  MAX_DASHBOARD_TAB_CHANGES_PER_CALL,
  MAX_DASHBOARD_TAB_TOMBSTONES,
  MAX_SYNCED_DASHBOARD_TABS,
  type DashboardTabRecord,
} from "../../shared/dashboard-tab-sync";

const modules = import.meta.glob("../**/*.ts");

const USER_A = { subject: "user_tabs_a", tokenIdentifier: "clerk|user_tabs_a" };
const USER_B = { subject: "user_tabs_b", tokenIdentifier: "clerk|user_tabs_b" };

const RECORD: DashboardTabRecord = {
  name: "Markets",
  panels: [
    { key: "markets", on: true },
    { key: "live-news", on: false, bottom: true },
    { key: "cw-abc123", on: true },
  ],
};

const tabId = (n: number) => `tab-k${n.toString(36)}-x${n.toString(36)}`;

function setup() {
  const t = convexTest(schema, modules);
  const as = (user: typeof USER_A) => t.withIdentity(user);
  const sync = (user: typeof USER_A, changes: Array<{ tabId: string; baseVersion?: number; record: DashboardTabRecord | null }>, expectedUserId = user.subject) =>
    as(user).mutation(api.userPreferences.syncDashboardTabs, { variant: "full", expectedUserId, changes });
  const list = (user: typeof USER_A, variant: "full" | "tech" = "full") =>
    as(user).query(api.userPreferences.listDashboardTabs, { variant });
  return { t, sync, list };
}

describe("dashboard tab record validation", () => {
  test("accepts a valid record and refuses out-of-bounds ones", async () => {
    const { sync } = setup();
    expect(await sync(USER_A, [{ tabId: tabId(1), record: RECORD }])).toMatchObject({ ok: true });

    const bad: Array<[string, Partial<DashboardTabRecord> | { tabId: string }]> = [
      ["empty name", { name: "" }],
      ["41-char name", { name: "x".repeat(41) }],
      ["padded name", { name: " Markets" }],
      ["duplicate panel key", { panels: [{ key: "markets", on: true }, { key: "markets", on: false }] }],
      ["bad panel key", { panels: [{ key: "../etc", on: true }] }],
      ["invalid scope", { scope: { countries: ["zz", "us"] } }],
      ["non-integer team version", { team: { id: "dash1", version: 1.5 } }],
    ];
    for (const [label, patch] of bad) {
      await expect(sync(USER_A, [{ tabId: tabId(2), record: { ...RECORD, ...patch } as DashboardTabRecord }]), label)
        .rejects.toThrow();
    }
    await expect(sync(USER_A, [{ tabId: "Markets", record: RECORD }])).rejects.toThrow(/INVALID_TAB/);
  });
});

describe("listDashboardTabs / syncDashboardTabs", () => {
  test("signed-out callers list nothing and cannot write", async () => {
    const { t } = setup();
    expect(await t.query(api.userPreferences.listDashboardTabs, { variant: "full" })).toEqual([]);
    await expect(t.mutation(api.userPreferences.syncDashboardTabs, {
      variant: "full", expectedUserId: USER_A.subject, changes: [],
    })).rejects.toThrow(/UNAUTHENTICATED/);
  });

  test("create, compare-and-set update, delete and resurrect", async () => {
    const { sync, list } = setup();
    const id = tabId(1);
    expect(await sync(USER_A, [{ tabId: id, record: RECORD }]))
      .toEqual({ ok: true, results: [{ tabId: id, ok: true, version: 1 }] });
    expect(await list(USER_A)).toMatchObject([{ tabId: id, version: 1, deleted: false, record: RECORD }]);

    // A stale base writes nothing and returns the current row.
    const stale = await sync(USER_A, [{ tabId: id, baseVersion: 0, record: { ...RECORD, name: "Stale" } }]);
    expect(stale).toMatchObject({ ok: true, results: [{ tabId: id, ok: false, reason: "CONFLICT", row: { version: 1, record: RECORD } }] });
    // A create for a tab the server already has is also a conflict.
    expect(await sync(USER_A, [{ tabId: id, record: RECORD }]))
      .toMatchObject({ ok: true, results: [{ ok: false, reason: "CONFLICT" }] });

    expect(await sync(USER_A, [{ tabId: id, baseVersion: 1, record: { ...RECORD, name: "Renamed" } }]))
      .toEqual({ ok: true, results: [{ tabId: id, ok: true, version: 2 }] });

    expect(await sync(USER_A, [{ tabId: id, baseVersion: 2, record: null }]))
      .toEqual({ ok: true, results: [{ tabId: id, ok: true, version: 3 }] });
    const [tombstone] = await list(USER_A);
    expect(tombstone).toMatchObject({ tabId: id, version: 3, deleted: true });
    expect(tombstone!.record).toBeUndefined();

    expect(await sync(USER_A, [{ tabId: id, baseVersion: 3, record: RECORD }]))
      .toEqual({ ok: true, results: [{ tabId: id, ok: true, version: 4 }] });
    expect(await list(USER_A)).toMatchObject([{ tabId: id, version: 4, deleted: false, record: RECORD }]);
  });

  test("rows are per account and per variant", async () => {
    const { sync, list } = setup();
    await sync(USER_A, [{ tabId: tabId(1), record: RECORD }]);
    expect(await list(USER_B)).toEqual([]);
    expect(await list(USER_A, "tech")).toEqual([]);
    // B creating the same tab id gets its own row, not A's.
    expect(await sync(USER_B, [{ tabId: tabId(1), record: RECORD }]))
      .toMatchObject({ ok: true, results: [{ ok: true, version: 1 }] });
  });

  test("a batch built for another account is refused whole before spending rate limit", async () => {
    const { t, sync, list } = setup();
    expect(await sync(USER_B, [{ tabId: tabId(1), record: RECORD }], USER_A.subject))
      .toEqual({ ok: false, reason: "WRONG_ACCOUNT" });
    expect(await list(USER_B)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("userPreferenceWriteRateLimits").collect())).toEqual([]);
  });

  test("refuses an unknown variant", async () => {
    const { t } = setup();
    await expect(t.withIdentity(USER_A).mutation(api.userPreferences.syncDashboardTabs, {
      variant: "nope" as "full", expectedUserId: USER_A.subject, changes: [],
    })).rejects.toThrow();
  });

  test("caps live tabs per account and variant", async () => {
    const { sync } = setup();
    const changes = Array.from({ length: MAX_SYNCED_DASHBOARD_TABS }, (_, i) => ({ tabId: tabId(i + 1), record: RECORD }));
    const first = await sync(USER_A, changes);
    expect(first.ok && first.results.every((r) => r.ok)).toBe(true);
    expect(await sync(USER_A, [{ tabId: tabId(999), record: RECORD }])).toEqual({
      ok: true,
      results: [{ tabId: tabId(999), ok: false, reason: "TAB_LIMIT", limit: MAX_SYNCED_DASHBOARD_TABS }],
    });
    // Deleting one frees its slot.
    await sync(USER_A, [{ tabId: tabId(1), baseVersion: 1, record: null }]);
    expect(await sync(USER_A, [{ tabId: tabId(999), record: RECORD }]))
      .toMatchObject({ ok: true, results: [{ ok: true, version: 1 }] });
  });

  test("a deleted tab brought back counts against the cap", async () => {
    const { sync } = setup();
    const changes = Array.from({ length: MAX_SYNCED_DASHBOARD_TABS }, (_, i) => ({ tabId: tabId(i + 1), record: RECORD }));
    await sync(USER_A, changes);
    await sync(USER_A, [{ tabId: tabId(1), baseVersion: 1, record: null }]);
    await sync(USER_A, [{ tabId: tabId(999), record: RECORD }]);
    expect(await sync(USER_A, [{ tabId: tabId(1), baseVersion: 2, record: RECORD }])).toEqual({
      ok: true,
      results: [{ tabId: tabId(1), ok: false, reason: "TAB_LIMIT", limit: MAX_SYNCED_DASHBOARD_TABS }],
    });
  });

  test("refuses an oversized batch and a tab listed twice", async () => {
    const { sync } = setup();
    const tooMany = Array.from({ length: MAX_DASHBOARD_TAB_CHANGES_PER_CALL + 1 }, (_, i) => ({ tabId: tabId(i + 1), record: RECORD }));
    await expect(sync(USER_A, tooMany)).rejects.toThrow(/INVALID_TAB/);
    await expect(sync(USER_A, [{ tabId: tabId(1), record: RECORD }, { tabId: tabId(1), record: RECORD }]))
      .rejects.toThrow(/INVALID_TAB/);
  });

  test("deleting a tab the server never had is a no-op, and a stale delete conflicts", async () => {
    const { sync, list } = setup();
    expect(await sync(USER_A, [{ tabId: tabId(7), record: null }]))
      .toEqual({ ok: true, results: [{ tabId: tabId(7), ok: true, version: 0 }] });
    expect(await list(USER_A)).toEqual([]);
    await sync(USER_A, [{ tabId: tabId(8), record: RECORD }]);
    await sync(USER_A, [{ tabId: tabId(8), baseVersion: 1, record: { ...RECORD, name: "Two" } }]);
    expect(await sync(USER_A, [{ tabId: tabId(8), baseVersion: 1, record: null }]))
      .toMatchObject({ ok: true, results: [{ tabId: tabId(8), ok: false, reason: "CONFLICT", row: { version: 2 } }] });
  });

  test("keeps only the newest tombstones", async () => {
    const { t, list } = setup();
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_DASHBOARD_TAB_TOMBSTONES; i += 1) {
        await ctx.db.insert("userDashboardTabs", {
          userId: USER_A.subject, variant: "full", tabId: tabId(i + 1), version: 2, deleted: true,
          createdAt: now - 10_000, updatedAt: now - 10_000 + i,
        });
      }
      await ctx.db.insert("userDashboardTabs", {
        userId: USER_A.subject, variant: "full", tabId: tabId(500), version: 1, deleted: false,
        record: RECORD, createdAt: now, updatedAt: now,
      });
    });
    await t.withIdentity(USER_A).mutation(api.userPreferences.syncDashboardTabs, {
      variant: "full", expectedUserId: USER_A.subject, changes: [{ tabId: tabId(500), baseVersion: 1, record: null }],
    });
    const rows = await list(USER_A);
    const tombstones = rows.filter((r) => r.deleted);
    expect(tombstones).toHaveLength(MAX_DASHBOARD_TAB_TOMBSTONES);
    // The oldest (tabId(1)) went; the one just deleted stayed.
    expect(tombstones.some((r) => r.tabId === tabId(1))).toBe(false);
    expect(tombstones.some((r) => r.tabId === tabId(500))).toBe(true);
  });

  test("prunes tombstones by the time they were last written", async () => {
    const { t, list } = setup();
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_DASHBOARD_TAB_TOMBSTONES; i += 1) {
        await ctx.db.insert("userDashboardTabs", {
          userId: USER_A.subject, variant: "full", tabId: tabId(i + 1), version: 2, deleted: true,
          createdAt: now - 10_000, updatedAt: now - 10_000 + i,
        });
      }
      await ctx.db.insert("userDashboardTabs", {
        userId: USER_A.subject, variant: "full", tabId: tabId(500), version: 1, deleted: false,
        record: RECORD, createdAt: now, updatedAt: now,
      });
    });
    // Delete the oldest marker again (refreshing it), then a live tab.
    await t.withIdentity(USER_A).mutation(api.userPreferences.syncDashboardTabs, {
      variant: "full", expectedUserId: USER_A.subject, changes: [
        { tabId: tabId(1), baseVersion: 2, record: null },
        { tabId: tabId(500), baseVersion: 1, record: null },
      ],
    });
    const tombstones = (await list(USER_A)).filter((r) => r.deleted);
    expect(tombstones).toHaveLength(MAX_DASHBOARD_TAB_TOMBSTONES);
    expect(tombstones.some((r) => r.tabId === tabId(1))).toBe(true);
    expect(tombstones.some((r) => r.tabId === tabId(2))).toBe(false);
  });

  test("shares the preference write rate limit", async () => {
    // One clock reading for the whole test: every attempt lands in one window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T10:00:30.000Z"));
    try {
      const { t, sync } = setup();
      // A preference save and tab writes spend the same budget.
      await t.withIdentity(USER_A).mutation(api.userPreferences.setPreferences, {
        variant: "full", data: { theme: "dark" }, expectedSyncVersion: 0,
      });
      for (let i = 1; i < USER_PREFS_WRITE_RATE_LIMIT; i += 1) {
        expect(await sync(USER_A, [])).toMatchObject({ ok: true });
      }
      expect(await sync(USER_A, [{ tabId: tabId(1), record: RECORD }])).toMatchObject({ ok: false, reason: "RATE_LIMITED" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a tab recreated after its tombstone was pruned cannot be deleted with the old version", async () => {
    const { t, sync } = setup();
    const now = Date.now();
    const recreated = tabId(700);
    await t.run(async (ctx) => {
      // The oldest tombstone, next to go; a device still holds version 1 of it.
      await ctx.db.insert("userDashboardTabs", {
        userId: USER_A.subject, variant: "full", tabId: recreated, version: 5, deleted: true,
        createdAt: now - 20_000, updatedAt: now - 20_000,
      });
      for (let i = 1; i < MAX_DASHBOARD_TAB_TOMBSTONES; i += 1) {
        await ctx.db.insert("userDashboardTabs", {
          userId: USER_A.subject, variant: "full", tabId: tabId(i), version: 2, deleted: true,
          createdAt: now - 10_000, updatedAt: now - 10_000 + i,
        });
      }
      await ctx.db.insert("userDashboardTabs", {
        userId: USER_A.subject, variant: "full", tabId: tabId(500), version: 1, deleted: false,
        record: RECORD, createdAt: now, updatedAt: now,
      });
    });
    // One more delete prunes the oldest tombstone.
    expect(await sync(USER_A, [{ tabId: tabId(500), baseVersion: 1, record: null }])).toMatchObject({ ok: true });
    const created = await sync(USER_A, [{ tabId: recreated, record: RECORD }]);
    expect(created).toMatchObject({ ok: true, results: [{ tabId: recreated, ok: true, version: 6 }] });
    expect(await sync(USER_A, [{ tabId: recreated, baseVersion: 1, record: null }])).toMatchObject({
      ok: true, results: [{ tabId: recreated, ok: false, reason: "CONFLICT" }],
    });
    expect(await sync(USER_A, [{ tabId: recreated, baseVersion: 6, record: { ...RECORD, name: "Edited" } }])).toMatchObject({
      ok: true, results: [{ tabId: recreated, ok: true, version: 7 }],
    });
  });

  test("an account being deleted cannot write tabs", async () => {
    const { t, sync } = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("accountDeletions", {
        userId: USER_A.subject,
        userIdHash: "a".repeat(64),
        source: "self",
        status: "pending",
        step: "personal",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await expect(sync(USER_A, [{ tabId: tabId(1), record: RECORD }])).rejects.toThrow(/ACCOUNT_DELETION_IN_PROGRESS/);
  });
});
