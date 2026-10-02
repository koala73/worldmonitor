import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const EMAIL = "remote-unsubscribe@example.com";

describe("exportProLaunchAudience consent handling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("persists a Resend-confirmed unsubscribe so a later export skips it locally", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("registrations", {
        email: EMAIL,
        normalizedEmail: EMAIL,
        registeredAt: Date.now(),
        appVersion: "test",
      });
    });
    vi.stubEnv("RESEND_API_KEY", "resend_test_key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "contact_already_exists",
        message: "Contact already exists",
      }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        email: EMAIL,
        unsubscribed: true,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await t.action(
      internal.broadcast.audienceExport.exportProLaunchAudience,
      { segmentId: "seg_test", numItems: 10 },
    );

    expect(result).toMatchObject({ unsubscribedSkipped: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const suppressions = await t.run(async (ctx) =>
      await ctx.db.query("emailSuppressions").collect(),
    );
    expect(suppressions).toMatchObject([
      {
        normalizedEmail: EMAIL,
        reason: "unsubscribe",
        source: "resend-contact-read",
      },
    ]);
  });
});
