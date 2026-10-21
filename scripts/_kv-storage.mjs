/**
 * Cloudflare Workers KV **write** helper for the bootstrap publisher (#5300 / #5338).
 *
 * WRITE ONLY. KV's fast, edge-local READ path is a binding inside a Cloudflare Worker —
 * never this REST call, which is a centralized API request (fine for a latency-insensitive
 * publisher write, wrong for serving). See the KV serving plan
 * (docs/plans/2026-07-16-001-…): the publisher writes both tier envelopes here; a Worker
 * reads them via binding.
 *
 * Self-contained by requirement: Railway builds seeders from a scripts-only Nixpacks root,
 * so this file must NOT import from ../api, ../src, or ../server — a cross-root import
 * crashes the container at startup (#5268). Only global `fetch` + `Buffer` are used.
 */

/** KV's hard per-value limit. A payload above this is a bug, not a big object (#5311 discipline). */
export const MAX_KV_VALUE_BYTES = 25 * 1024 * 1024; // 25 MiB

/**
 * Resolve KV write config from env, or `null` when unconfigured — so the publisher skips KV
 * gracefully on deploys without the credentials (backward-compatible, flag-by-presence).
 */
export function resolveKvStorageConfig(env = process.env) {
  const accountId = env.KV_BOOTSTRAP_ACCOUNT_ID || env.CLOUDFLARE_R2_ACCOUNT_ID;
  const namespaceId = env.KV_BOOTSTRAP_NAMESPACE_ID;
  const token = env.KV_BOOTSTRAP_WRITE_TOKEN;
  if (!accountId || !namespaceId || !token) return null;
  return { accountId, namespaceId, token };
}

/**
 * Write one JSON value to a KV namespace. Enforces the 25 MiB cap BEFORE the network call and
 * throws on breach — a bloated tier must fail loudly, never truncate silently (the 11.5 MB
 * #5311 lesson). The caller treats KV writes as best-effort and never lets this abort the
 * canonical R2 publish.
 *
 * @returns {Promise<{ key: string, bytes: number }>}
 */
export async function putKvJsonValue(config, key, value, { fetchFn = fetch, timeoutMs = 15_000 } = {}) {
  const body = JSON.stringify(value);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_KV_VALUE_BYTES) {
    throw new Error(
      `KV value for '${key}' is ${bytes} bytes, over the ${MAX_KV_VALUE_BYTES}-byte (25 MiB) cap — refusing to write`,
    );
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}`
    + `/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'WorldMonitor Bootstrap Publisher/1.0',
      },
      body,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`KV write '${key}' failed: HTTP ${resp.status} ${detail.slice(0, 200)}`);
    }
    return { key, bytes };
  } finally {
    clearTimeout(timer);
  }
}
