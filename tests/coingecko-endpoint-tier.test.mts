import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { coingeckoEndpoint as seedCoingeckoEndpoint } from "../scripts/_seed-utils.mjs";
import { coingeckoEndpoint as serverCoingeckoEndpoint } from "../server/worldmonitor/market/v1/_shared.ts";

type Endpoint = {
  baseUrl: string;
  headers: Record<string, string>;
  tier?: "pro" | "demo" | "keyless";
};

const ORIGINAL_PRO_KEY = process.env.COINGECKO_API_KEY;
const ORIGINAL_DEMO_KEY = process.env.COINGECKO_DEMO_API_KEY;

function setCoinGeckoEnv({ proKey, demoKey }: { proKey?: string; demoKey?: string }) {
  if (proKey === undefined) {
    delete process.env.COINGECKO_API_KEY;
  } else {
    process.env.COINGECKO_API_KEY = proKey;
  }

  if (demoKey === undefined) {
    delete process.env.COINGECKO_DEMO_API_KEY;
  } else {
    process.env.COINGECKO_DEMO_API_KEY = demoKey;
  }
}

function restoreCoinGeckoEnv() {
  if (ORIGINAL_PRO_KEY === undefined) {
    delete process.env.COINGECKO_API_KEY;
  } else {
    process.env.COINGECKO_API_KEY = ORIGINAL_PRO_KEY;
  }

  if (ORIGINAL_DEMO_KEY === undefined) {
    delete process.env.COINGECKO_DEMO_API_KEY;
  } else {
    process.env.COINGECKO_DEMO_API_KEY = ORIGINAL_DEMO_KEY;
  }
}

const helpers: Array<{
  name: string;
  resolve: () => Endpoint;
  exposesTier: boolean;
}> = [
  { name: "seed helper", resolve: () => seedCoingeckoEndpoint(), exposesTier: true },
  { name: "server helper", resolve: () => serverCoingeckoEndpoint(), exposesTier: true },
];

afterEach(() => {
  restoreCoinGeckoEnv();
});

for (const helper of helpers) {
  describe(helper.name, () => {
    it("uses the Pro host and Pro auth header when COINGECKO_API_KEY is set", () => {
      setCoinGeckoEnv({ proKey: "pro-key", demoKey: undefined });

      const endpoint = helper.resolve();

      assert.equal(endpoint.baseUrl, "https://pro-api.coingecko.com/api/v3");
      assert.equal(endpoint.headers["x-cg-pro-api-key"], "pro-key");
      assert.equal(endpoint.headers["x-cg-demo-api-key"], undefined);
      if (helper.exposesTier) assert.equal(endpoint.tier, "pro");
    });

    it("uses the public host and Demo auth header when only COINGECKO_DEMO_API_KEY is set", () => {
      setCoinGeckoEnv({ proKey: undefined, demoKey: "demo-key" });

      const endpoint = helper.resolve();

      assert.equal(endpoint.baseUrl, "https://api.coingecko.com/api/v3");
      assert.equal(endpoint.headers["x-cg-demo-api-key"], "demo-key");
      assert.equal(endpoint.headers["x-cg-pro-api-key"], undefined);
      if (helper.exposesTier) assert.equal(endpoint.tier, "demo");
    });

    it("prefers the Pro host and Pro auth header when both env vars are set", () => {
      setCoinGeckoEnv({ proKey: "pro-key", demoKey: "demo-key" });

      const endpoint = helper.resolve();

      assert.equal(endpoint.baseUrl, "https://pro-api.coingecko.com/api/v3");
      assert.equal(endpoint.headers["x-cg-pro-api-key"], "pro-key");
      assert.equal(endpoint.headers["x-cg-demo-api-key"], undefined);
      if (helper.exposesTier) assert.equal(endpoint.tier, "pro");
    });

    it("uses the keyless public endpoint when no CoinGecko key is configured", () => {
      setCoinGeckoEnv({ proKey: undefined, demoKey: undefined });

      const endpoint = helper.resolve();

      assert.equal(endpoint.baseUrl, "https://api.coingecko.com/api/v3");
      assert.equal(endpoint.headers["x-cg-pro-api-key"], undefined);
      assert.equal(endpoint.headers["x-cg-demo-api-key"], undefined);
      if (helper.exposesTier) assert.equal(endpoint.tier, "keyless");
    });
  });
}

describe("seed helper extra headers", () => {
  it("preserves caller-provided headers while applying CoinGecko auth", () => {
    setCoinGeckoEnv({ proKey: undefined, demoKey: "demo-key" });

    const endpoint = seedCoingeckoEndpoint({ "x-test-header": "present" });

    assert.equal(endpoint.headers["x-test-header"], "present");
    assert.equal(endpoint.headers["x-cg-demo-api-key"], "demo-key");
  });
});
