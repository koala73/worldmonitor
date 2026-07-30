import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;
const importFetchCalls = [];
let indexNow;

before(async () => {
  globalThis.fetch = async (url, init) => {
    importFetchCalls.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  };
  indexNow = await import(`../scripts/seo-indexnow-submit.mjs?test=${Date.now()}`);
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe('IndexNow submission', () => {
  it('registers the canonical apex MCP endpoint in its own same-host batch', () => {
    assert.equal(importFetchCalls.length, 0, 'importing the module must not submit URLs');

    const batch = indexNow.INDEXNOW_BATCHES.find(({ host }) => host === 'worldmonitor.app');
    assert.equal(batch.host, 'worldmonitor.app');
    assert.equal(batch.keyLocation, `https://worldmonitor.app/${batch.key}.txt`);
    assert.deepEqual(batch.urls, ['https://worldmonitor.app/mcp']);
    const wwwBatch = indexNow.INDEXNOW_BATCHES.find(({ host }) => host === 'www.worldmonitor.app');
    assert.notEqual(batch.key, wwwBatch.key, 'apex and www must use independently verified keys');
    assert.equal(
      readFileSync(new URL(`../public/${batch.key}.txt`, import.meta.url), 'utf8').trim(),
      batch.key,
      'the deployed apex key file must match the configured key',
    );
  });

  it('keeps every submitted URL and key location on the declared host', () => {
    for (const batch of indexNow.INDEXNOW_BATCHES) {
      assert.equal(new URL(batch.keyLocation).hostname, batch.host);
      assert.match(batch.key, /^[a-f0-9]{32}$/);
      assert.equal(new URL(batch.keyLocation).pathname, `/${batch.key}.txt`);
      assert.ok(batch.urls.length > 0, `${batch.host} must submit at least one URL`);
      for (const url of batch.urls) {
        assert.equal(new URL(url).hostname, batch.host, `${url} must match ${batch.host}`);
      }
    }
  });

  it('requires a direct key response with the exact key body', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, {
        status: 301,
        headers: { location: 'https://www.worldmonitor.app/key.txt' },
      });
    };

    await assert.rejects(
      indexNow.verifyIndexNowKey(indexNow.INDEXNOW_BATCHES.find(({ host }) => host === 'worldmonitor.app'), {
        fetchImpl,
      }),
      /direct 200/i,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.redirect, 'manual');
  });

  it('does not notify search engines when host ownership verification fails', async () => {
    const requests = [];
    const apexBatch = indexNow.INDEXNOW_BATCHES.find(({ host }) => host === 'worldmonitor.app');
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, {
        status: 301,
        headers: { location: 'https://www.worldmonitor.app/key.txt' },
      });
    };

    await assert.rejects(
      indexNow.submitIndexNowBatch(apexBatch, {
        endpoints: ['https://api.indexnow.org/IndexNow'],
        fetchImpl,
      }),
      /direct 200/i,
    );
    assert.deepEqual(requests.map(({ url }) => url), [apexBatch.keyLocation]);
  });

  it('does not notify search engines when a direct key response has the wrong body', async () => {
    const requests = [];
    const apexBatch = indexNow.INDEXNOW_BATCHES.find(({ host }) => host === 'worldmonitor.app');
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response('wrong-indexnow-key', { status: 200 });
    };

    await assert.rejects(
      indexNow.submitIndexNowBatch(apexBatch, {
        endpoints: ['https://api.indexnow.org/IndexNow'],
        fetchImpl,
      }),
      /key body does not match/i,
    );
    assert.deepEqual(requests.map(({ url }) => url), [apexBatch.keyLocation]);
  });

  it('submits the apex-specific key and canonical URL after ownership verification', async () => {
    const requests = [];
    const apexBatch = indexNow.INDEXNOW_BATCHES.find(({ host }) => host === 'worldmonitor.app');
    const endpoint = 'https://www.bing.com/IndexNow';
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url) === apexBatch.keyLocation) {
        return new Response(apexBatch.key, { status: 200 });
      }
      return new Response(null, { status: 202 });
    };

    const results = await indexNow.submitIndexNowBatch(apexBatch, {
      endpoints: [endpoint],
      fetchImpl,
    });

    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[0].value.status, 202);
    assert.deepEqual(JSON.parse(requests[1].init.body), {
      host: 'worldmonitor.app',
      key: apexBatch.key,
      keyLocation: apexBatch.keyLocation,
      urlList: ['https://worldmonitor.app/mcp'],
    });
  });

  it('submits the apex batch only after a relevant successful production deployment', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/indexnow-submit.yml', import.meta.url),
      'utf8',
    );

    assert.match(workflow, /^ {2}deployment_status:$/m);
    assert.match(workflow, /^ {2}workflow_dispatch:$/m);
    assert.match(workflow, /github\.event\.deployment_status\.state == 'success'/);
    assert.match(workflow, /github\.event\.deployment\.environment == 'Production'/);
    assert.match(workflow, /github\.event\.deployment\.creator\.login == 'vercel\[bot\]'/);
    assert.match(workflow, /api\/mcp/);
    assert.match(workflow, /public\/mcp-server\\\.md/);
    assert.match(workflow, /INDEXNOW_BATCHES\.find/);
    assert.match(workflow, /grep -Fxq "public\/\$\{APEX_KEY_PATH\}"/);
    assert.match(workflow, /node scripts\/seo-indexnow-submit\.mjs --host worldmonitor\.app/);
  });
});
