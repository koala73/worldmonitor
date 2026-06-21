import { describe, test, expect } from "@jest/globals";

describe("Protected endpoints reject unauthenticated requests", () => {
  const baseUrl = process.env.CONVEX_HTTP_URL || "http://localhost:3001";
  const endpoint = `${baseUrl}/api/internal-entitlements`;
  
  const unauthenticatedHeaders = [
    { description: "missing secret header", headers: {} },
    { description: "empty secret header", headers: { "x-convex-shared-secret": "" } },
    { description: "malformed secret", headers: { "x-convex-shared-secret": "invalid-secret-123" } },
    { description: "wrong header name", headers: { "authorization": "Bearer fake-token" } },
  ];

  test.each(unauthenticatedHeaders)(
    "rejects request with $description",
    async ({ headers }) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ userId: "test-user-id" }),
      });

      expect([401, 403]).toContain(response.status);
      const body = await response.json();
      expect(body.error).toBe("UNAUTHORIZED");
    }
  );

  test("accepts request with valid secret", async () => {
    const validSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    if (!validSecret) {
      console.warn("Skipping valid auth test - CONVEX_SERVER_SHARED_SECRET not set");
      return;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-convex-shared-secret": validSecret,
      },
      body: JSON.stringify({ userId: "test-user-id" }),
    });

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });
});