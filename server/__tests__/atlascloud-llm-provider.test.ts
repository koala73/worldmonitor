// @vitest-environment node

import { afterEach, describe, expect, test } from "vitest";

import { getProviderCredentials } from "../_shared/llm";

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

afterEach(() => {
  restoreEnv();
});

describe("Atlas Cloud LLM provider credentials", () => {
  test("returns null when the API key is not configured", () => {
    delete process.env.ATLASCLOUD_API_KEY;

    expect(getProviderCredentials("atlascloud")).toBeNull();
  });

  test("builds OpenAI-compatible chat credentials with the default model", () => {
    process.env.ATLASCLOUD_API_KEY = "test-atlas-key";

    const credentials = getProviderCredentials("atlascloud");

    expect(credentials).toMatchObject({
      apiUrl: "https://api.atlascloud.ai/v1/chat/completions",
      model: "qwen/qwen3.5-flash",
      headers: {
        Authorization: "Bearer test-atlas-key",
        "Content-Type": "application/json",
      },
    });
  });

  test("honors model and base URL overrides", () => {
    process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
    process.env.ATLASCLOUD_API_BASE = "https://proxy.example.test/custom/v1/";
    process.env.ATLASCLOUD_MODEL = "qwen/custom-model";

    const credentials = getProviderCredentials("atlascloud");

    expect(credentials?.apiUrl).toBe("https://proxy.example.test/custom/v1/chat/completions");
    expect(credentials?.model).toBe("qwen/custom-model");
  });

  test("defaults reasoning profile calls to the Atlas Cloud reasoning model", () => {
    process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
    delete process.env.ATLASCLOUD_MODEL;

    const credentials = getProviderCredentials("atlascloud", { enableReasoning: true });

    expect(credentials?.model).toBe("deepseek-ai/deepseek-v4-pro");
  });
});
