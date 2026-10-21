import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { normalizeCompanyImportBatch } from "../../shared/company-monitoring-contract";
import { fingerprint } from "../companyMonitoring/_shared";
import {
  accountFor,
  CM,
  company,
  grant,
  grantProvisioned,
  installCompanyMonitoringTestEnvironment,
  modules,
  NOW,
  OWNER_A,
  OWNER_B,
  schema,
} from "./companyMonitoring.helpers";

installCompanyMonitoringTestEnvironment();

describe("bounded onboarding and replay", () => {
  test("records claim-level discovery and attribution uses for later evidence matching", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const created = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "claim-use-policy",
      company: company("Attribution Ready", "attribution-ready"),
    });
    const account = await accountFor(t, OWNER_A);
    const claims = await t.run(async (ctx) => ctx.db
      .query("companyMonitoringClaims")
      .withIndex("by_account_company", (q) =>
        q.eq("ownerAccountId", account!.logicalAccountId).eq("companyId", created.companyId),
      )
      .collect());

    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "alias",
        value: "Attribution Ready",
        allowedUses: ["attribution", "discovery"],
      }),
      expect.objectContaining({
        type: "domain",
        allowedUses: ["attribution", "discovery"],
      }),
      expect.objectContaining({ type: "location", allowedUses: ["discovery"] }),
      expect.objectContaining({ type: "customer_reference", allowedUses: ["discovery"] }),
    ]));

    await t.mutation(CM.companies.updateCompanyForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      patch: { name: "Attribution Ready Renamed" },
    });
    const renamedClaims = await t.run(async (ctx) => ctx.db
      .query("companyMonitoringClaims")
      .withIndex("by_account_company", (q) =>
        q.eq("ownerAccountId", account!.logicalAccountId).eq("companyId", created.companyId),
      )
      .collect());
    expect(renamedClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "alias",
        value: "Attribution Ready Renamed",
        allowedUses: ["attribution", "discovery"],
      }),
    ]));
  });

  test("concurrent final-slot requests admit exactly one and preserve count parity", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const root = await accountFor(t, OWNER_A);
    await t.run(async (ctx) => {
      for (let i = 0; i < 499; i += 1) {
        await ctx.db.insert("companyMonitoringCompanies", {
          ownerAccountId: root!.logicalAccountId,
          companyId: `cm_company_${String(i).padStart(26, "0")}`,
          name: `Seed ${i}`,
          sortName: `seed ${String(i).padStart(3, "0")}`,
          domicileCountry: "US",
          lifecycle: "active",
          coverageState: "awaiting_first_scan",
          observationState: "unknown",
          snapshotGeneration: 1,
          purgeGeneration: 0,
          purgePhase: "none",
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      await ctx.db.patch(root!._id, { companyCount: 499 });
    });

    const results = await Promise.allSettled([
      t.mutation(CM.companies.createCompanyForOwner, {
        ownerUserId: OWNER_A,
        clientRequestId: "final-slot-a",
        company: company("Final Slot A", "final-slot-a"),
      }),
      t.mutation(CM.companies.createCompanyForOwner, {
        ownerUserId: OWNER_A,
        clientRequestId: "final-slot-b",
        company: company("Final Slot B", "final-slot-b"),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const parity = await t.run(async (ctx) => {
      const account = await ctx.db.get(root!._id);
      const active = await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_lifecycle_sortName", (q) =>
          q.eq("ownerAccountId", root!.logicalAccountId).eq("lifecycle", "active"),
        )
        .collect();
      return { count: account?.companyCount, active: active.length };
    });
    expect(parity).toEqual({ count: 500, active: 500 });

    const rejectedIndex = results.findIndex((result) => result.status === "rejected");
    await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: `cm_company_${String(0).padStart(26, "0")}`,
      state: "removed",
    });
    const retried = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: rejectedIndex === 0 ? "final-slot-a" : "final-slot-b",
      company:
        rejectedIndex === 0
          ? company("Final Slot A", "final-slot-a")
          : company("Final Slot B", "final-slot-b"),
    });
    expect(retried.status).toBe("created");
  });

  test("Convex validators reject unexpected fields at every Company Monitoring write boundary", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);

    await expect(t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "validator-create-extra",
      company: { ...company("Validator Create", "validator-create"), unexpected: "ignored-by-v-any" },
    } as any)).rejects.toThrow();

    const created = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "validator-valid-company",
      company: company("Validator Valid", "validator-valid"),
    });
    await expect(t.mutation(CM.companies.updateCompanyForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      patch: { unexpected: "ignored-by-v-any" },
    } as any)).rejects.toThrow();

    await expect(t.action(CM.imports.importCompaniesForOwner, {
      ownerUserId: OWNER_A,
      rows: [{
        ...company("Validator Import", "validator-import"),
        clientImportId: "validator-import",
        ordinal: 0,
        unexpected: "ignored-by-v-any",
      }],
    } as any)).rejects.toThrow();

    const normalizedRow = {
      contractVersion: "cm-import-v1",
      clientImportId: "validator-internal-import",
      ordinal: 0,
      name: "Validator Internal Import",
      domicileCountry: "US",
      aliases: [],
      domains: [],
      identifiers: [],
      xHandles: [],
      locations: [],
      unexpected: "ignored-by-v-any",
    };
    await expect(t.mutation(CM.imports.importCompanyRowForOwner, {
      ownerUserId: OWNER_A,
      row: normalizedRow,
      rowFingerprint: "validator-fingerprint",
    } as any)).rejects.toThrow();

    expect(await accountFor(t, OWNER_A)).toMatchObject({ companyCount: 1 });
  });

  test("a full 100-row normalized import stays ordered and replay-safe", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const rows = Array.from({ length: 100 }, (_, ordinal) => ({
      ...company(`Batch Company ${ordinal}`, `batch-${ordinal}`),
      name: `  Batch Company ${ordinal}  `,
      domains: [`WWW.BATCH-${ordinal}.EXAMPLE.`],
      clientImportId: "full-normalized-batch",
      ordinal,
    })).reverse();

    const imported = await t.action(CM.imports.importCompaniesForOwner, {
      ownerUserId: OWNER_A,
      rows,
    });
    expect(imported.companyCount).toBe(100);
    expect(imported.results.map((row: any) => row.ordinal)).toEqual(
      Array.from({ length: 100 }, (_, ordinal) => ordinal),
    );
    expect(imported.results.map((row: any) => row.status)).toEqual(
      Array.from({ length: 100 }, () => "created"),
    );

    const root = await accountFor(t, OWNER_A);
    const firstCompanyId = imported.results[0]?.companyId;
    expect(firstCompanyId).toBeDefined();
    const stored = await t.run(async (ctx) => ({
      companies: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) => q.eq("ownerAccountId", root!.logicalAccountId))
        .collect(),
      firstCompanyClaims: await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q
            .eq("ownerAccountId", root!.logicalAccountId)
            .eq("companyId", firstCompanyId!),
        )
        .collect(),
      obligations: await ctx.db
        .query("companyMonitoringScanObligations")
        .withIndex("by_account_company_source", (q) =>
          q.eq("ownerAccountId", root!.logicalAccountId),
        )
        .collect(),
      work: await ctx.db
        .query("companyMonitoringScanWorkItems")
        .withIndex("by_account_state_selectionDueAt", (q) =>
          q.eq("ownerAccountId", root!.logicalAccountId).eq("state", "due"),
        )
        .collect(),
    }));
    expect(stored.companies).toHaveLength(100);
    expect(stored.companies.every((row) =>
      row.name === `Batch Company ${row.importOrdinal}` &&
      row.clientImportId === "full-normalized-batch"
    )).toBe(true);
    expect(stored.firstCompanyClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "domain", value: "batch-0.example" }),
    ]));
    expect(stored.obligations).toHaveLength(200);
    expect(stored.work).toHaveLength(8);

    const replayed = await t.action(CM.imports.importCompaniesForOwner, {
      ownerUserId: OWNER_A,
      rows,
    });
    expect(replayed.companyCount).toBe(100);
    expect(replayed.results.map((row: any) => row.ordinal)).toEqual(
      Array.from({ length: 100 }, (_, ordinal) => ordinal),
    );
    expect(replayed.results.map((row: any) => row.status)).toEqual(
      Array.from({ length: 100 }, () => "replayed"),
    );
    expect(await accountFor(t, OWNER_A)).toMatchObject({ companyCount: 100 });
    expect(await t.run(async (ctx) => ({
      obligations: (await ctx.db.query("companyMonitoringScanObligations").collect()).length,
      work: (await ctx.db.query("companyMonitoringScanWorkItems").collect()).length,
    }))).toEqual({ obligations: 200, work: 8 });
  }, 15_000);

  test("an import retry heals rows committed before scan scheduling without duplicates", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const rows = [0, 1].map((ordinal) => ({
      ...company(`Interrupted Batch ${ordinal}`, `interrupted-${ordinal}`),
      clientImportId: "interrupted-scan-batch",
      ordinal,
    }));
    const normalizedRows = normalizeCompanyImportBatch(rows);
    for (const row of normalizedRows) {
      await t.mutation(CM.imports.importCompanyRowForOwner, {
        ownerUserId: OWNER_A,
        row,
        rowFingerprint: await fingerprint(row),
      });
    }
    expect(await t.run(async (ctx) => ({
      obligations: (await ctx.db.query("companyMonitoringScanObligations").collect()).length,
      work: (await ctx.db.query("companyMonitoringScanWorkItems").collect()).length,
    }))).toEqual({ obligations: 0, work: 0 });

    const retry = await t.action(CM.imports.importCompaniesForOwner, {
      ownerUserId: OWNER_A,
      rows,
    });
    expect(retry.results.map((row: any) => row.status)).toEqual(["replayed", "replayed"]);
    const healed = await t.run(async (ctx) => ({
      obligations: (await ctx.db.query("companyMonitoringScanObligations").collect()).length,
      work: (await ctx.db.query("companyMonitoringScanWorkItems").collect()).length,
    }));
    expect(healed).toEqual({ obligations: 4, work: 2 });

    await t.action(CM.imports.importCompaniesForOwner, { ownerUserId: OWNER_A, rows });
    expect(await t.run(async (ctx) => ({
      obligations: (await ctx.db.query("companyMonitoringScanObligations").collect()).length,
      work: (await ctx.db.query("companyMonitoringScanWorkItems").collect()).length,
    }))).toEqual(healed);
  }, 15_000);

  test("committed direct and import rows replay, changed tuples conflict, and no-ops reevaluate", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);

    const first = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "direct-uncertain-1",
      company: company("Replay Corp", "replay-corp"),
    });
    const replay = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "direct-uncertain-1",
      company: company("Replay Corp", "replay-corp"),
    });
    expect(replay).toMatchObject({ status: "replayed", companyId: first.companyId });
    await expect(
      t.mutation(CM.companies.createCompanyForOwner, {
        ownerUserId: OWNER_A,
        clientRequestId: "direct-uncertain-1",
        company: company("Changed Corp", "replay-corp"),
      }),
    ).rejects.toThrow(/REPLAY_CONFLICT/);

    const rows = [
      { ...company("Replay Corp", "replay-corp"), clientImportId: "csv-1", ordinal: 0 },
      { ...company("Fresh Corp", "fresh-corp"), clientImportId: "csv-1", ordinal: 1 },
    ];
    const imported = await t.action(CM.imports.importCompaniesForOwner, {
      ownerUserId: OWNER_A,
      rows,
    });
    expect(imported.results.map((row: any) => row.status)).toEqual(["noop", "created"]);
    const rootBeforeImportConflict = await accountFor(t, OWNER_A);
    const committedImportRow = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_import_tuple", (q) =>
          q
            .eq("ownerAccountId", rootBeforeImportConflict!.logicalAccountId)
            .eq("clientImportId", "csv-1")
            .eq("importOrdinal", 1),
        )
        .unique()
    );
    const changedTuple = await t.action(CM.imports.importCompaniesForOwner, {
      ownerUserId: OWNER_A,
      rows: [rows[0], { ...rows[1], name: "Changed Fresh Corp" }],
    });
    expect(changedTuple.results.map((row: any) => row.status)).toEqual(["noop", "conflict"]);
    expect(changedTuple.results[1]).toMatchObject({ reason: "REPLAY_CONFLICT" });
    expect(await accountFor(t, OWNER_A)).toMatchObject({
      companyCount: rootBeforeImportConflict?.companyCount,
      snapshotGeneration: rootBeforeImportConflict?.snapshotGeneration,
    });
    expect(await t.run(async (ctx) => ctx.db.get(committedImportRow!._id))).toEqual(
      committedImportRow,
    );

    const replayed = await t.action(CM.imports.importCompaniesForOwner, {
      ownerUserId: OWNER_A,
      rows,
    });
    expect(replayed.results.map((row: any) => row.status)).toEqual(["noop", "replayed"]);

    await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: first.companyId,
      state: "removed",
    });
    const reevaluated = await t.action(CM.imports.importCompaniesForOwner, {
      ownerUserId: OWNER_A,
      rows,
    });
    expect(reevaluated.results.map((row: any) => row.status)).toEqual(["created", "replayed"]);

    await expect(
      t.action(CM.imports.importCompaniesForOwner, {
        ownerUserId: OWNER_A,
        rows: Array.from({ length: 101 }, (_, ordinal) => ({
          ...company(`Too Many ${ordinal}`),
          clientImportId: "oversized",
          ordinal,
        })),
      }),
    ).rejects.toThrow(/100 rows/);
  });

  test("a directly created company can be recreated with the same request after purge", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const request = {
      ownerUserId: OWNER_A,
      clientRequestId: "direct-recreate-after-purge",
      company: company("Direct Purge Corp", "direct-purge-corp"),
    };

    const created = await t.mutation(CM.companies.createCompanyForOwner, request);
    expect(await t.mutation(CM.companies.createCompanyForOwner, request)).toEqual({
      status: "replayed",
      companyId: created.companyId,
    });
    await expect(
      t.mutation(CM.companies.createCompanyForOwner, {
        ...request,
        company: company("Changed Direct Purge Corp", "direct-purge-corp"),
      }),
    ).rejects.toThrow(/REPLAY_CONFLICT/);

    await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "removed",
    });
    const root = await accountFor(t, OWNER_A);
    const removed = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", root!.logicalAccountId).eq("companyId", created.companyId),
        )
        .unique()
    );
    expect(await t.mutation(CM.companies.advanceCompanyPurge, {
      ownerAccountId: root!.logicalAccountId,
      companyId: created.companyId,
      purgeGeneration: removed!.purgeGeneration,
    })).toEqual({ status: "complete" });

    const purged = await t.run(async (ctx) => ctx.db.get(removed!._id));
    expect(purged?.directRequestId).toBeUndefined();
    expect(purged?.directFingerprint).toBeUndefined();
    expect(purged?.clientImportId).toBeUndefined();
    expect(purged?.importOrdinal).toBeUndefined();
    expect(purged?.importFingerprint).toBeUndefined();

    const recreated = await t.mutation(CM.companies.createCompanyForOwner, request);
    expect(recreated.status).toBe("created");
    expect(recreated.companyId).not.toBe(created.companyId);
    expect(await t.query(CM.companies.listCompaniesForOwner, { ownerUserId: OWNER_A })).toEqual([
      expect.objectContaining({ companyId: recreated.companyId, lifecycle: "active" }),
    ]);
  });

  test("an imported company can be recreated with the same tuple after purge", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const row = {
      ...company("Import Purge Corp", "import-purge-corp"),
      clientImportId: "import-recreate-after-purge",
      ordinal: 0,
    };
    const request = { ownerUserId: OWNER_A, rows: [row] };

    const imported = await t.action(CM.imports.importCompaniesForOwner, request);
    const companyId = imported.results[0]!.companyId!;
    expect(imported.results[0]).toMatchObject({ status: "created", companyId });
    expect(await t.action(CM.imports.importCompaniesForOwner, request)).toMatchObject({
      results: [{ status: "replayed", companyId }],
    });
    expect(await t.action(CM.imports.importCompaniesForOwner, {
      ownerUserId: OWNER_A,
      rows: [{ ...row, name: "Changed Import Purge Corp" }],
    })).toMatchObject({
      results: [{ status: "conflict", reason: "REPLAY_CONFLICT" }],
    });

    await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId,
      state: "removed",
    });
    const root = await accountFor(t, OWNER_A);
    const removed = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", root!.logicalAccountId).eq("companyId", companyId),
        )
        .unique()
    );
    expect(await t.mutation(CM.companies.advanceCompanyPurge, {
      ownerAccountId: root!.logicalAccountId,
      companyId,
      purgeGeneration: removed!.purgeGeneration,
    })).toEqual({ status: "complete" });

    const purged = await t.run(async (ctx) => ctx.db.get(removed!._id));
    expect(purged?.directRequestId).toBeUndefined();
    expect(purged?.directFingerprint).toBeUndefined();
    expect(purged?.clientImportId).toBeUndefined();
    expect(purged?.importOrdinal).toBeUndefined();
    expect(purged?.importFingerprint).toBeUndefined();

    const reimported = await t.action(CM.imports.importCompaniesForOwner, request);
    expect(reimported.results[0]?.status).toBe("created");
    expect(reimported.results[0]?.companyId).not.toBe(companyId);
    expect(await t.query(CM.companies.listCompaniesForOwner, { ownerUserId: OWNER_A })).toEqual([
      expect.objectContaining({
        companyId: reimported.results[0]?.companyId,
        lifecycle: "active",
      }),
    ]);
  });

  test("removal is immediately hidden, idempotent, cleans claims, and fences cross-account IDs", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await grantProvisioned(t, OWNER_B);
    const created = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "remove-1",
      company: company("Remove Corp", "remove-corp"),
    });
    const before = await accountFor(t, OWNER_A);

    await expect(
      t.mutation(CM.companies.setCompanyStateForOwner, {
        ownerUserId: OWNER_B,
        companyId: created.companyId,
        state: "removed",
      }),
    ).rejects.toThrow(/NOT_FOUND/);

    const removed = await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "removed",
    });
    expect(removed.status).toBe("removed");
    const again = await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "removed",
    });
    expect(again.status).toBe("already_removed");

    const visible = await t.query(CM.companies.listCompaniesForOwner, { ownerUserId: OWNER_A });
    expect(visible).toEqual([]);
    const after = await accountFor(t, OWNER_A);
    expect(after?.companyCount).toBe(0);
    expect(after?.snapshotGeneration).toBe((before?.snapshotGeneration ?? 0) + 1);
    const removedRow = await t.run(async (ctx) =>
      ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", before!.logicalAccountId).eq("companyId", created.companyId),
        )
        .unique()
    );
    const claims = await t.run(async (ctx) => ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", before!.logicalAccountId).eq("companyId", created.companyId),
        )
        .collect());
    expect(claims).toEqual([]);
    expect(removedRow).toMatchObject({
      lifecycle: "removed",
      purgePhase: "scan",
      name: "Remove Corp",
    });

    const purgeArgs = {
      ownerAccountId: before!.logicalAccountId,
      companyId: created.companyId,
      purgeGeneration: removedRow!.purgeGeneration,
    };
    expect(await t.mutation(CM.companies.advanceCompanyPurge, purgeArgs)).toEqual({
      status: "complete",
    });
    const scrubbed = await t.run(async (ctx) => ctx.db.get(removedRow!._id));
    expect(scrubbed).toMatchObject({
      lifecycle: "removed",
      purgePhase: "complete",
      purgeGeneration: removedRow?.purgeGeneration,
    });
    expect(scrubbed?.name).toBeUndefined();
    expect(scrubbed?.sortName).toBeUndefined();
    expect(scrubbed?.domicileCountry).toBeUndefined();
    expect(scrubbed?.customerReference).toBeUndefined();
    expect(scrubbed?.coverageState).toBeUndefined();
    expect(scrubbed?.observationState).toBeUndefined();
    expect(await t.mutation(CM.companies.advanceCompanyPurge, purgeArgs)).toEqual({
      status: "complete",
    });
    expect(await t.run(async (ctx) => ctx.db.get(removedRow!._id))).toEqual(scrubbed);

    await expect(
      t.mutation(CM.companies.createCompanyForOwner, {
        ownerUserId: OWNER_A,
        clientRequestId: "invalid-domain",
        company: { ...company("Invalid Domain"), domains: ["https://not-a-domain.example/path"] },
      }),
    ).rejects.toThrow(/invalid domain/);
  });

  test("active-paused-active transitions advance snapshots once and self-transitions are no-ops", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    const created = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "state-transitions",
      company: company("State Transition Corp", "state-transition-corp"),
    });
    const root = await accountFor(t, OWNER_A);
    const readState = () => t.run(async (ctx) => ({
      account: await ctx.db.get(root!._id),
      company: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", root!.logicalAccountId).eq("companyId", created.companyId),
        )
        .unique(),
    }));
    const initial = await readState();

    expect(await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "active",
    })).toMatchObject({ status: "unchanged" });
    expect(await readState()).toEqual(initial);

    expect(await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "paused",
    })).toMatchObject({ status: "paused" });
    const paused = await readState();
    expect(paused.account?.snapshotGeneration).toBe((initial.account?.snapshotGeneration ?? 0) + 1);
    expect(paused.company?.snapshotGeneration).toBe((initial.company?.snapshotGeneration ?? 0) + 1);
    expect(paused.company?.lifecycle).toBe("paused");

    expect(await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "paused",
    })).toMatchObject({ status: "unchanged" });
    expect(await readState()).toEqual(paused);

    expect(await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "active",
    })).toMatchObject({ status: "active" });
    const activeAgain = await readState();
    expect(activeAgain.account?.snapshotGeneration).toBe(
      (initial.account?.snapshotGeneration ?? 0) + 2,
    );
    expect(activeAgain.company?.snapshotGeneration).toBe(
      (initial.company?.snapshotGeneration ?? 0) + 2,
    );
    expect(activeAgain.company?.lifecycle).toBe("active");

    expect(await t.mutation(CM.companies.setCompanyStateForOwner, {
      ownerUserId: OWNER_A,
      companyId: created.companyId,
      state: "active",
    })).toMatchObject({ status: "unchanged" });
    expect(await readState()).toEqual(activeAgain);
  });

  test("company updates keep claims account-bound, normalized, and budgeted", async () => {
    const t = convexTest(schema, modules);
    await grantProvisioned(t, OWNER_A);
    await grantProvisioned(t, OWNER_B);
    const createdA = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_A,
      clientRequestId: "update-a",
      company: company("Update Corp", "update-corp"),
    });
    const createdB = await t.mutation(CM.companies.createCompanyForOwner, {
      ownerUserId: OWNER_B,
      clientRequestId: "update-b",
      company: company("Other Corp", "other-corp"),
    });
    const accountA = await accountFor(t, OWNER_A);
    const accountB = await accountFor(t, OWNER_B);
    const claims = await t.run(async (ctx) => ({
      a: await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", accountA!.logicalAccountId).eq("companyId", createdA.companyId),
        )
        .collect(),
      b: await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", accountB!.logicalAccountId).eq("companyId", createdB.companyId),
        )
        .collect(),
    }));

    await expect(
      t.mutation(CM.companies.updateCompanyForOwner, {
        ownerUserId: OWNER_A,
        companyId: createdA.companyId,
        patch: { removeClaimIds: [claims.b[0].claimId] },
      }),
    ).rejects.toThrow(/CLAIM_NOT_FOUND/);
    await expect(
      t.mutation(CM.companies.updateCompanyForOwner, {
        ownerUserId: OWNER_A,
        companyId: createdA.companyId,
        patch: { addClaims: [{ type: "x_account_id", value: "not-numeric" }] },
      }),
    ).rejects.toThrow(/invalid X account ID/);

    const updated = await t.mutation(CM.companies.updateCompanyForOwner, {
      ownerUserId: OWNER_A,
      companyId: createdA.companyId,
      patch: {
        name: "Updated Corporation",
        customerReference: "updated-corp",
        removeClaimIds: [claims.a[0].claimId],
        addClaims: [{ type: "x_account_id", value: "123456" }],
      },
    });
    expect(updated.status).toBe("updated");
    const after = await t.run(async (ctx) => ({
      row: await ctx.db
        .query("companyMonitoringCompanies")
        .withIndex("by_account_companyId", (q) =>
          q.eq("ownerAccountId", accountA!.logicalAccountId).eq("companyId", createdA.companyId),
        )
        .unique(),
      claims: await ctx.db
        .query("companyMonitoringClaims")
        .withIndex("by_account_company", (q) =>
          q.eq("ownerAccountId", accountA!.logicalAccountId).eq("companyId", createdA.companyId),
        )
        .collect(),
    }));
    expect(after.row).toMatchObject({
      name: "Updated Corporation",
      customerReference: "updated-corp",
    });
    expect(after.claims.some((claim) => claim.claimId === claims.a[0].claimId)).toBe(false);
    expect(after.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "x_account_id", value: "123456" }),
      expect.objectContaining({ type: "customer_reference", value: "updated-corp" }),
    ]));

    const snapshot = (await accountFor(t, OWNER_A))!.snapshotGeneration;
    const unchanged = await t.mutation(CM.companies.updateCompanyForOwner, {
      ownerUserId: OWNER_A,
      companyId: createdA.companyId,
      patch: {},
    });
    expect(unchanged.status).toBe("unchanged");
    expect((await accountFor(t, OWNER_A))!.snapshotGeneration).toBe(snapshot);
  });
});
