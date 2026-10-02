import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");
const backfillApi = internal.payments.backfillCustomerNormalizedEmail;

test("empty-email backfill reaches zero pending and remains complete on rerun", async () => {
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("customers", {
    userId: "synthetic_empty", email: "", createdAt: 1, updatedAt: 1,
  }));
  expect(await t.query(backfillApi.countPending, {}))
    .toEqual({ total: 1, pending: 1, withEmail: 0 });
  expect(await t.mutation(backfillApi.backfill, {}))
    .toEqual({ read: 1, patched: 1, emptyEmail: 1, done: true });
  expect(await t.query(backfillApi.countPending, {}))
    .toEqual({ total: 1, pending: 0, withEmail: 0 });
  expect(await t.mutation(backfillApi.backfill, {}))
    .toEqual({ read: 0, patched: 0, emptyEmail: 0, done: true });
});

test("pending count matches unprocessed rows across mixed-email batches", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (const [index, fields] of [
      { email: " User@Example.test " },
      { email: "   " },
      { email: "", normalizedEmail: "" },
      { email: "ready@example.test", normalizedEmail: "ready@example.test" },
    ].entries()) {
      await ctx.db.insert("customers", {
        userId: `synthetic_${index}`, createdAt: 1, updatedAt: 1, ...fields,
      });
    }
  });
  expect(await t.query(backfillApi.countPending, {}))
    .toEqual({ total: 4, pending: 2, withEmail: 3 });
  await t.mutation(backfillApi.backfill, { batchSize: 1 });
  expect((await t.query(backfillApi.countPending, {})).pending).toBe(1);
  await t.mutation(backfillApi.backfill, { batchSize: 1 });
  expect(await t.query(backfillApi.countPending, {}))
    .toEqual({ total: 4, pending: 0, withEmail: 3 });
  expect(await t.mutation(backfillApi.backfill, { batchSize: 1 }))
    .toEqual({ read: 0, patched: 0, emptyEmail: 0, done: true });
  const rows = await t.run((ctx) => ctx.db.query("customers").collect());
  expect(rows.map((row) => row.normalizedEmail))
    .toEqual(["user@example.test", "", "", "ready@example.test"]);
});
