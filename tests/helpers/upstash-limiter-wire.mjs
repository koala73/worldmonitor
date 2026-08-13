// Reads the budget a handler actually SENT to Upstash, rather than the one a
// test fixture handed back.
//
// Why this exists: @upstash/ratelimit's sliding-window script returns
// [remaining, limit], and the SDK surfaces that second element verbatim as
// `limit`, which handlers then emit as X-RateLimit-Limit. So a test that mocks
// `[{ result: [-1, 30] }]` and asserts `X-RateLimit-Limit === '30'` is asserting
// its own fixture round-tripping — the handler could be configured with any
// budget at all and the assertion would still pass. The only place the
// CONFIGURED budget is observable in a mocked run is the outgoing request: the
// limiter sends it as the first script argument.
//
// Wire shape (auto-pipelined REST call to /pipeline):
//   [["evalsha", <sha>, <numKeys>, ...keys, <tokens>, <now>, <windowMs>, <incr>]]
// (#6412 review)

/** Parse one auto-pipelined Upstash command body into {keys, args}. */
function parseLimiterCommand(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const command = Array.isArray(parsed?.[0]) ? parsed[0] : parsed;
  if (!Array.isArray(command)) return null;
  const verb = String(command[0] ?? '').toLowerCase();
  if (verb !== 'evalsha' && verb !== 'eval') return null;
  const numKeys = Number(command[2]);
  if (!Number.isInteger(numKeys) || numKeys < 0) return null;
  const rest = command.slice(3);
  return { keys: rest.slice(0, numKeys), args: rest.slice(numKeys) };
}

/**
 * Given the calls recorded by a fetch spy, return the limiter decision the
 * handler actually requested: the configured token budget, the window in ms,
 * and the Redis keys (whose prefix encodes the configured scope).
 * Returns null when no limiter call was made.
 */
export function readLimiterRequest(calls) {
  for (const call of calls) {
    const body = call?.init?.body ?? call?.body;
    if (!body) continue;
    const command = parseLimiterCommand(String(body));
    if (!command) continue;
    const [tokens, , windowMs] = command.args;
    return {
      tokens: Number(tokens),
      windowMs: Number(windowMs),
      keys: command.keys.filter((k) => typeof k === 'string' && k.length > 0),
    };
  }
  return null;
}

/**
 * Assert the handler configured `limit` per `windowSeconds` under `scope`.
 * Goes red if the handler passes a different budget, window, or scope — the
 * mutation the header assertions cannot see.
 */
export function assertLimiterBudget(assert, calls, { limit, windowSeconds, scope }) {
  const sent = readLimiterRequest(calls);
  assert.ok(sent, 'expected the handler to send a rate-limit decision to Upstash');
  assert.equal(
    sent.tokens,
    limit,
    `handler configured ${sent.tokens}/window but the registry declares ${limit} — the response headers echo the mocked reply, so only this assertion catches it`,
  );
  assert.equal(
    sent.windowMs,
    windowSeconds * 1000,
    `handler configured a ${sent.windowMs}ms window but the registry declares ${windowSeconds}s`,
  );
  assert.ok(
    sent.keys.some((k) => k.startsWith(`rl:${scope}:`)),
    `handler used Redis keys ${JSON.stringify(sent.keys)} but the configured scope should prefix them with rl:${scope}: — a missing scope silently shares the global bucket`,
  );
}
