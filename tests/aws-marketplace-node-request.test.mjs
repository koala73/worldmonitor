import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('signed Marketplace body constructs a Node 24 fetch Request without duplex', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wm-aws-marketplace-'));
  try {
    const outfile = join(directory, 'transport.mjs');
    await build({
      entryPoints: [new URL('../server/_shared/aws-marketplace.ts', import.meta.url).pathname],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile,
    });
    const { createAwsMarketplaceCall } = await import(pathToFileURL(outfile).href);
    const payload = { ProductCode: 'product-1', Filter: { LICENSE_ARN: ['arn:aws:license-manager::123456789012:license:l-abc'] } };
    let request;
    const call = createAwsMarketplaceCall({
      AWS_MARKETPLACE_REGION: 'us-east-1',
      AWS_MARKETPLACE_PRODUCT_CODES: 'product-1',
      AWS_MARKETPLACE_DIMENSION_PLAN_MAP: '{"api_access":"pro"}',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE12345678',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      AWS_SESSION_TOKEN: 'test-session',
    }, async (url, init) => {
      request = new Request(url, init);
      return new Response(JSON.stringify({ Entitlements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    assert.deepEqual(await call('entitlement', 'AWSMPEntitlementService.GetEntitlements', payload), { Entitlements: [] });
    assert.equal(await request.text(), JSON.stringify(payload));
    assert.match(request.headers.get('authorization'), /Credential=AKIAEXAMPLE12345678/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
