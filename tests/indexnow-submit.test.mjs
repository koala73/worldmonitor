import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { WEB_DASHBOARD_VARIANTS } from '../src/config/variant-dashboard-html.ts';

/**
 * The web-served variant registry, which is what the app actually deploys — not
 * the sitemap, and not the IndexNow config derived from it. Both of those are
 * downstream of this list, so comparing them to each other proves nothing
 * (#6563). Same source and same reason as tests/sentry-allow-urls.test.mts.
 */
const SERVED_VARIANT_HOSTS = WEB_DASHBOARD_VARIANTS
  .map((variant) => `${variant}.worldmonitor.app`)
  .sort();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = resolve(repoRoot, '.github/workflows/indexnow-submit.yml');
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');
const workflowDoc = YAML.parse(workflowSource);
const workflowSteps = workflowDoc.jobs['submit-indexnow'].steps;

function runStep(script, env) {
  return new Promise((resolvePromise) => {
    const child = spawn('bash', ['-e', '-c', script], { cwd: repoRoot, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolvePromise({ stdout, stderr, status }));
  });
}

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
    assert.ok(
      wwwBatch.urls.includes('https://www.worldmonitor.app/blog/authors/elie-habib/'),
      'www batch must submit the canonical Elie Habib author archive',
    );
    assert.notEqual(batch.key, wwwBatch.key, 'apex and www must use independently verified keys');
    assert.equal(
      readFileSync(new URL(`../public/${batch.key}.txt`, import.meta.url), 'utf8').trim(),
      batch.key,
      'the deployed apex key file must match the configured key',
    );
  });

  it('keeps IndexNow coverage aligned with the committed root sitemap and blog corpus', () => {
    const sitemap = readFileSync(new URL('../public/sitemap-main.xml', import.meta.url), 'utf8');
    const sitemapUrls = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
      .map((match) => match[1].trim());
    const wwwSitemapUrls = sitemapUrls.filter((url) => new URL(url).hostname === 'www.worldmonitor.app');
    const apexSitemapUrls = sitemapUrls.filter((url) => new URL(url).hostname === 'worldmonitor.app');
    const wwwBatch = indexNow.INDEXNOW_BATCHES.find(({ host }) => host === 'www.worldmonitor.app');
    const apexBatch = indexNow.INDEXNOW_BATCHES.find(({ host }) => host === 'worldmonitor.app');

    for (const url of wwwSitemapUrls) assert.ok(wwwBatch.urls.includes(url), `${url} must be submitted`);
    for (const url of apexSitemapUrls) assert.ok(apexBatch.urls.includes(url), `${url} must be submitted`);
    for (const url of [
      'https://www.worldmonitor.app/blog/',
      'https://www.worldmonitor.app/blog/glossary/',
      'https://www.worldmonitor.app/blog/glossary/ais/',
      'https://www.worldmonitor.app/blog/authors/elie-habib/',
    ]) {
      assert.ok(wwwBatch.urls.includes(url), `${url} must be submitted`);
    }
    assert.equal(new Set(wwwBatch.urls).size, wwwBatch.urls.length, 'www batch must not contain duplicates');
    assert.equal(new Set(apexBatch.urls).size, apexBatch.urls.length, 'apex batch must not contain duplicates');
  });

  it('submits every web variant the app actually serves', () => {
    // Anchored to the served-variant registry, NOT to the sitemap the batches
    // are derived from — comparing the sitemap to a list built out of it is a
    // tautology with no falsifying input, and would stay green through the very
    // regression #6563 reported (a variant dropped from build-sitemap.mjs).
    assert.ok(SERVED_VARIANT_HOSTS.length >= 5, `expected at least 5 web variant hosts, got ${SERVED_VARIANT_HOSTS.length}`);
    assert.deepEqual(
      [...indexNow.INDEXNOW_VARIANT_HOSTS],
      SERVED_VARIANT_HOSTS,
      'every served variant needs an IndexNow batch, and no other host may acquire one',
    );
  });

  it('submits every canonical URL the sitemap publishes, for every host', () => {
    const sitemap = readFileSync(new URL('../public/sitemap-main.xml', import.meta.url), 'utf8');
    const sitemapUrls = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1].trim());
    assert.ok(sitemapUrls.length > 0, 'sitemap parse produced no URLs');

    for (const url of sitemapUrls) {
      const host = new URL(url).hostname;
      const batch = indexNow.INDEXNOW_BATCHES.find((candidate) => candidate.host === host);
      assert.ok(batch, `${host} appears in public/sitemap-main.xml but has no INDEXNOW_BATCHES entry`);
      assert.ok(
        batch.urls.includes(url),
        `${url} is published in the sitemap but is not in the ${host} batch, so it is never submitted`,
      );
    }
  });

  it('keeps every submitted URL and key location on the declared host', () => {
    for (const batch of indexNow.INDEXNOW_BATCHES) {
      assert.equal(new URL(batch.keyLocation).hostname, batch.host);
      assert.match(batch.key, /^[a-f0-9]{32}$/);
      assert.equal(new URL(batch.keyLocation).pathname, `/${batch.key}.txt`);
      assert.equal(
        readFileSync(new URL(`../public/${batch.key}.txt`, import.meta.url), 'utf8').trim(),
        batch.key,
        `${batch.host}: public/${batch.key}.txt must be committed and match the configured key`,
      );
      assert.ok(batch.urls.length > 0, `${batch.host} must submit at least one URL`);
      for (const url of batch.urls) {
        assert.equal(new URL(url).hostname, batch.host, `${url} must match ${batch.host}`);
      }
    }
  });

  it('bounds every request so one stalled endpoint cannot consume the job', async () => {
    // fetch has no default deadline, and seven hosts are submitted sequentially
    // inside one job — without this, a hung endpoint strands the later hosts.
    const requests = [];
    const apexBatch = indexNow.INDEXNOW_BATCHES.find(({ host }) => host === 'worldmonitor.app');
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url) === apexBatch.keyLocation) return new Response(apexBatch.key, { status: 200 });
      return new Response(null, { status: 202 });
    };

    await indexNow.submitIndexNowBatch(apexBatch, {
      endpoints: ['https://api.indexnow.org/IndexNow'],
      fetchImpl,
    });

    assert.equal(requests.length, 2, 'expected the key verification plus one submission');
    for (const { url, init } of requests) {
      assert.ok(init.signal, `${url} must carry an abort signal`);
      assert.equal(typeof init.signal.aborted, 'boolean', `${url} signal must be an AbortSignal`);
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

  it('submits each host batch only after a relevant successful production deployment', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/indexnow-submit.yml', import.meta.url),
      'utf8',
    );

    assert.match(workflow, /^ {2}deployment_status:$/m);
    assert.match(workflow, /^ {2}workflow_dispatch:$/m);
    assert.match(workflow, /github\.event\.deployment_status\.state == 'success'/);
    assert.match(workflow, /github\.event\.deployment\.environment == 'Production'/);
    assert.match(workflow, /github\.event\.deployment\.creator\.login == 'vercel\[bot\]'/);

  });

  it('isolates concurrency by deployment environment before eligibility filtering', () => {
    assert.equal(workflowDoc.concurrency?.['cancel-in-progress'], false);
    assert.equal(
      workflowDoc.concurrency?.group,
      "indexnow-${{ github.event_name == 'deployment_status' && github.event.deployment.environment || github.event_name }}",
    );
  });
});

describe('IndexNow root-index indirection', () => {
  it('resolves page URLs through the local urlset member, never index-member URLs', async () => {
    const { getRootSitemapUrls, readLocalIndexMember } = await import('../scripts/seo-indexnow-submit.mjs');
    const urls = getRootSitemapUrls();
    assert.ok(urls.length > 0, 'must resolve a non-empty page URL list');
    assert.ok(urls.every((url) => !url.endsWith('sitemap.xml') && !url.endsWith('sitemap-main.xml')));
    assert.ok(urls.some((url) => url === 'https://www.worldmonitor.app/dashboard'));
  });

  it('fails closed when the root index lists no local urlset member', async () => {
    const { readLocalIndexMember } = await import('../scripts/seo-indexnow-submit.mjs');
    assert.throws(
      () => readLocalIndexMember('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://www.worldmonitor.app/blog/sitemap-index.xml</loc></sitemap></sitemapindex>'),
      /no local sitemap-main\.xml member/,
    );
  });
});

describe('IndexNow published inventory (#8071)', () => {
  const origin = 'https://www.worldmonitor.app';
  const flagged = `${origin}/docs/methodology/resilience-indicators`;
  const xml = (kind, urls) => `<${kind}>${urls.map(url => `<${kind === 'urlset' ? 'url' : 'sitemap'}><loc>${url}</loc></${kind === 'urlset' ? 'url' : 'sitemap'}>`).join('')}</${kind}>`;
  function publishedDocuments() {
    return new Map([
      [`${origin}/sitemap.xml`, xml('sitemapindex', [`${origin}/sitemap-main.xml`, `${origin}/blog/sitemap-index.xml`, `${origin}/docs/sitemap.xml`])],
      [`${origin}/sitemap-main.xml`, xml('urlset', [
        ...indexNow.INDEXNOW_BATCHES.flatMap(batch => batch.urls.filter(url => !url.includes('/blog/'))),
        `${origin}/compare/new-comparison/`,
      ])],
      [`${origin}/blog/sitemap-index.xml`, xml('sitemapindex', [`${origin}/blog/sitemap-0.xml`])],
      [`${origin}/blog/sitemap-0.xml`, xml('urlset', [`${origin}/blog/new-published-post/`])],
      [`${origin}/docs/sitemap.xml`, xml('urlset', [flagged, `${origin}/docs/zh/methodology/resilience-indicators`])
        .replace('<urlset>', `<urlset><!-- <url><loc>${origin}/docs/commented-out</loc></url> -->`)],
    ]);
  }

  it('posts published main, nested blog and docs pages, including URLs absent from the checkout', async () => {
    const documents = publishedDocuments();
    const posts = [];
    const fetchImpl = async (url, init) => {
      assert.ok(init.signal);
      assert.ok(init.headers['User-Agent']);
      if (init.method === 'POST') {
        posts.push(JSON.parse(init.body));
        return new Response(null, { status: 200 });
      }
      const config = indexNow.INDEXNOW_BATCHES.find(batch => batch.keyLocation === url);
      return new Response(config?.key ?? documents.get(url), { status: 200 });
    };
    await indexNow.runIndexNowSubmission({ fetchImpl, endpoints: ['https://www.bing.com/IndexNow'], logger: { log() {}, error() {} } });
    assert.deepEqual(posts.map(post => post.host), indexNow.INDEXNOW_BATCHES.map(batch => batch.host));
    const expectedPages = [
      ...indexNow.INDEXNOW_BATCHES.flatMap(batch => batch.urls.filter(url => !url.includes('/blog/'))),
      `${origin}/compare/new-comparison/`, `${origin}/blog/new-published-post/`,
      flagged, `${origin}/docs/zh/methodology/resilience-indicators`,
    ];
    assert.deepEqual(new Set(posts.flatMap(post => post.urlList)), new Set(expectedPages));
    const www = posts.find(post => post.host === 'www.worldmonitor.app');
    for (const url of [flagged, `${origin}/compare/new-comparison/`, `${origin}/accuracy/`, `${origin}/blog/new-published-post/`]) {
      assert.ok(www.urlList.includes(url), `${url} must reach the search engine`);
    }
    assert.ok(!www.urlList.includes(`${origin}/blog/authors/elie-habib/`), 'unpublished checkout URLs must not replace the published inventory');
    assert.ok(!www.urlList.includes(`${origin}/docs/commented-out`), 'comments must not contribute page URLs');
    assert.ok(posts.every(post => post.urlList.every(url => new URL(url).hostname === post.host && !url.endsWith('.xml'))));
  });

  it('attempts every host after an endpoint rejects an earlier host and still fails the run', async () => {
    const hosts = [];
    await assert.rejects(indexNow.runIndexNowSubmission({
      batches: indexNow.INDEXNOW_BATCHES,
      endpoints: ['https://www.bing.com/IndexNow'],
      logger: { log() {}, error() {} },
      fetchImpl: async (url, init) => {
        if (init.method === 'POST') {
          hosts.push(JSON.parse(init.body).host);
          return new Response(null, { status: hosts.length === 1 ? 503 : 200 });
        }
        return new Response(indexNow.INDEXNOW_BATCHES.find(batch => batch.keyLocation === url).key);
      },
    }), /one or more IndexNow submissions failed/);
    assert.deepEqual(hosts, indexNow.INDEXNOW_BATCHES.map(batch => batch.host));
  });

  it('fails before any POST when a child sitemap is unavailable, empty, or untrusted', async () => {
    for (const [broken, expectedError] of [
      [new Response(null, { status: 503 }), /returned 503/],
      [new Response(null, { status: 301 }), /returned 301/],
      [new Response('<urlset></urlset>'), /empty sitemap/],
      [new Response('<html>unavailable</html>'), /invalid sitemap document/],
      [new Response(xml('sitemapindex', ['https://example.com/sitemap.xml'])), /invalid sitemap location/],
      [new Response(xml('sitemapindex', [`${origin}/sitemap.xml`])), /no docs pages/],
      [new Response(xml('urlset', ['https://example.com/page'])), /invalid published page URL/],
      [new Response('<urlset><url><loc>https://www.worldmonitor.app/docs/valid</loc></url><url></url></urlset>'), /one location per sitemap entry/],
    ]) {
      const documents = publishedDocuments();
      let posts = 0;
      await assert.rejects(indexNow.runIndexNowSubmission({
        fetchImpl: async (url, init) => {
          if (init.method === 'POST') posts++;
          if (url === `${origin}/docs/sitemap.xml`) return broken;
          assert.ok(documents.has(url), `unexpected request ${url}`);
          return new Response(documents.get(url));
        },
        logger: { log() {}, error() {} },
      }), expectedError);
      assert.equal(posts, 0);
    }
  });

  it('prints every published host batch from the real CLI without posting in dry-run mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'indexnow-cli-'));
    try {
      const preload = join(dir, 'fetch.mjs');
      writeFileSync(preload, `const documents = new Map(${JSON.stringify([...publishedDocuments()])});
globalThis.fetch = async (url, init) => {
  if (init.method !== 'GET' || !documents.has(url)) throw new Error('unexpected request ' + url);
  return new Response(documents.get(url));
};`);
      const { stdout, stderr, status } = await runStep(
        'node --import "$INDEXNOW_TEST_PRELOAD" scripts/seo-indexnow-submit.mjs --dry-run',
        { ...process.env, INDEXNOW_TEST_PRELOAD: preload },
      );
      assert.equal(status, 0, stderr);
      const batches = JSON.parse(stdout);
      assert.deepEqual(batches.map(batch => batch.host), indexNow.INDEXNOW_BATCHES.map(batch => batch.host));
      const www = batches.find(batch => batch.host === 'www.worldmonitor.app');
      assert.ok(www.urls.includes(flagged));
      assert.ok(www.urls.includes(`${origin}/compare/new-comparison/`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches independently published docs on a scheduled run', async () => {
    assert.ok(workflowDoc.on.schedule?.length, 'docs-only publication needs a catch-up trigger because Vercel can skip docs changes');
    assert.match(workflowDoc.jobs['submit-indexnow'].if, /github.event_name == 'schedule'/);
  });

  it('rejects missing or extra direct root sitemap members before reading children', async () => {
    for (const members of [
      [`${origin}/sitemap-main.xml`, `${origin}/blog/sitemap-index.xml`],
      [`${origin}/sitemap-main.xml`, `${origin}/blog/sitemap-index.xml`, `${origin}/docs/sitemap.xml`, `${origin}/extra.xml`],
    ]) {
      const requests = [];
      await assert.rejects(indexNow.getPublishedBatches({ fetchImpl: async (url) => {
        requests.push(url);
        return new Response(xml('sitemapindex', members));
      } }), /root sitemap members/);
      assert.deepEqual(requests, [`${origin}/sitemap.xml`]);
    }
  });

  it('runs the full published inventory on every eligible trigger without host or file filters', () => {
    const submissions = workflowSteps.filter(step => String(step.run ?? '').includes('node scripts/seo-indexnow-submit.mjs'));
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].run.trim(), 'node scripts/seo-indexnow-submit.mjs');
    assert.equal(submissions[0].if, undefined);
    assert.ok(!workflowSteps.some(step => String(step.run ?? '').includes('diff-tree')));
  });


});
