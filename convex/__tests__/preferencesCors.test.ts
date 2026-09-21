import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
afterEach(() => vi.unstubAllEnvs());
const appOrigins = ["", "www.", "app.", "api.", "tech.", "finance.", "commodity.", "happy.", "energy."]
  .map(host => `https://${host}worldmonitor.app`);
const trusted = [...appOrigins,
  "https://worldmonitor-git-test-eliewm.vercel.app",
  "https://worldmonitor-abc123-eliewm.vercel.app",
  "tauri://localhost", "asset://localhost", "http://tauri.localhost",
  "https://tauri.localhost:444", "http://main.tauri.localhost",
  "https://tech.worldmonitor.app.", "https://www-worldmonitor-app.translate.goog",
];
const denied = [
  "https://clerk.worldmonitor.app", "https://abacus.worldmonitor.app",
  "https://unknown.worldmonitor.app", "http://tech.worldmonitor.app",
  "https://worldmonitor.app:8443", "https://worldmonitor.app.evil.test",
  "https://evil.test/worldmonitor.app", "https://worldmonitor.app/path",
  "https://user:pass@tech.worldmonitor.app", "https://tech.worldmonitor.app?query=1",
  "https://worldmonitor-abc-other.vercel.app", "https://evil.vercel.app",
  "https://tauri.localhost.evil.test", "https://localhost:99999",
  "not-an-origin.worldmonitor.app", "null", "", "https://tech.worldmonitor.app#fragment",
  "https://clerk-worldmonitor-app.translate.goog", "https://abacus-worldmonitor-app.translate.goog",
  "https://evil--worldmonitor-app.translate.goog", "https://worldmonitor.app./path",
  "https://user:pass@worldmonitor.app.", "https://worldmonitor.app.:8443",
];

test.each(trusted)("allows supported preference origin %s", async origin => {
  vi.stubEnv("NODE_ENV", "production");
  const response = await convexTest(schema, modules).fetch("/api/user-prefs", {
    method: "OPTIONS", headers: { Origin: origin },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  expect(response.headers.get("Vary")).toBe("Origin");
});

test.each(denied)("does not grant preference CORS to %s", async origin => {
  const t = convexTest(schema, modules);
  for (const method of ["OPTIONS", "POST"] as const) {
    const response = await t.fetch("/api/user-prefs", { method, headers: { Origin: origin } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    if (method === "POST") expect(response.status).toBe(401);
  }
});

test.each(["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:5173"])(
  "allows local development but not production for %s", async origin => {
    for (const environment of ["development", "production"]) {
      vi.stubEnv("NODE_ENV", environment);
      const response = await convexTest(schema, modules).fetch("/api/user-prefs", {
        method: "OPTIONS", headers: { Origin: origin },
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(environment === "development" ? origin : null);
    }
  },
);

test("trusted origin still needs identity; authenticated write retains CORS and persists", async () => {
  const t = convexTest(schema, modules);
  const init = {
    method: "POST" as const,
    headers: { Origin: "https://tech.worldmonitor.app", "Content-Type": "application/json" },
    body: JSON.stringify({ variant: "full", data: { theme: "dark" }, expectedSyncVersion: 0 }),
  };
  expect((await t.fetch("/api/user-prefs", init)).status).toBe(401);
  const response = await t.withIdentity({ subject: "cors-buyer" }).fetch("/api/user-prefs", init);
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(init.headers.Origin);
  expect(await t.run(ctx => ctx.db.query("userPreferences").collect())).toHaveLength(1);
});

test("CORS refusal does not replace explicit bearer identity authorization", async () => {
  const t = convexTest(schema, modules);
  const response = await t.withIdentity({ subject: "cors-buyer" }).fetch("/api/user-prefs", {
    method: "POST",
    headers: { Origin: "https://clerk.worldmonitor.app", "Content-Type": "application/json" },
    body: JSON.stringify({ variant: "full", data: { theme: "dark" }, expectedSyncVersion: 0 }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
});
