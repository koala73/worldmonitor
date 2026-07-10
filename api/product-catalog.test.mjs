import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function importHandler({ relaySecret }) {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  if (relaySecret == null) {
    delete process.env.RELAY_SHARED_SECRET;
  } else {
    process.env.RELAY_SHARED_SECRET = relaySecret;
  }
  const mod = await import(`./product-catalog.js?test=${Date.now()}-${Math.random()}`);
  return mod.default;
}

function deleteRequest(authHeader) {
  const headers = new Headers();
  if (authHeader != null) headers.set('Authorization', authHeader);
  return new Request('https://api.worldmonitor.app/api/product-catalog', {
    method: 'DELETE',
    headers,
  });
}

afterEach(() => {
  restoreEnv();
});

test('DELETE purge accepts only the exact relay bearer secret', async () => {
  const handler = await importHandler({ relaySecret: 'relay-secret-with-distinct-length' });

  const accepted = await handler(deleteRequest('Bearer relay-secret-with-distinct-length'));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { purged: true });

  const prefixOnly = await handler(deleteRequest('Bearer relay-secret-with-distinct'));
  assert.equal(prefixOnly.status, 401);

  const longerMismatch = await handler(deleteRequest('Bearer relay-secret-with-distinct-length-extra'));
  assert.equal(longerMismatch.status, 401);
});

test('DELETE purge fails closed when RELAY_SHARED_SECRET is missing', async () => {
  const handler = await importHandler({ relaySecret: null });

  const missingSecret = await handler(deleteRequest('Bearer '));
  assert.equal(missingSecret.status, 401);

  const noAuth = await handler(deleteRequest(null));
  assert.equal(noAuth.status, 401);
});
