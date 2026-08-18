import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function workflowStep({ id, name }) {
  const step = workflowSteps.find((candidate) => (id ? candidate.id === id : candidate.name === name));
  assert.ok(step, `indexnow workflow must define the ${id ?? name} step`);
  return step;
}

// Each gate run spawns several short-lived node processes, so the cases are run
// concurrently — serially they dominate this file's runtime.
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

/**
 * Execute the workflow's real relevance-gate script with `git` stubbed to report
 * `changedFiles`, and return the `$GITHUB_OUTPUT` it produced. Running the
 * committed shell — rather than regex-matching it — is what makes the gate's
 * behaviour testable in both directions.
 */
async function runRelevanceGate(changedFiles, eventName = 'deployment_status') {
  const dir = mkdtempSync(join(tmpdir(), 'indexnow-gate-'));
  try {
    const gitStub = join(dir, 'git');
    writeFileSync(
      gitStub,
      [
        '#!/bin/bash',
        '[[ "$1" == "rev-parse" ]] && exit 0',
        `[[ "$1" == "diff-tree" ]] && { printf '%s\\n' ${changedFiles.map((file) => JSON.stringify(file)).join(' ')}; exit 0; }`,
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(gitStub, 0o755);
    const outputFile = join(dir, 'github-output');
    writeFileSync(outputFile, '');

    const { stderr, status } = await runStep(workflowStep({ id: 'relevant' }).run, {
      ...process.env,
      DEPLOYED_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      EVENT_NAME: eventName,
      GITHUB_OUTPUT: outputFile,
      PATH: `${dir}:${process.env.PATH}`,
    });
    assert.equal(status, 0, stderr);

    return Object.fromEntries(
      readFileSync(outputFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Execute the workflow's real variant submit step with `node` stubbed, and
 * report which hosts it actually invoked plus the step's exit status.
 */
async function runVariantSubmitStep(variantHosts, { failingHost = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'indexnow-submit-'));
  try {
    const nodeStub = join(dir, 'node');
    writeFileSync(
      nodeStub,
      [
        '#!/bin/bash',
        // Invocation is `node scripts/seo-indexnow-submit.mjs --host <host>`.
        '[[ "$2" == "--host" ]] || exit 90',
        // Tagged so the step's own ::error:: annotations are not mistaken for
        // submissions — a bare echo would make a failing step look busy.
        'echo "submitted:$3"',
        failingHost ? `[[ "$3" == "${failingHost}" ]] && exit 1` : '',
        'exit 0',
        '',
      ].filter(Boolean).join('\n'),
    );
    chmodSync(nodeStub, 0o755);

    const { stdout, status } = await runStep(
      workflowStep({ name: 'Submit canonical variant dashboard URLs' }).run,
      { ...process.env, PATH: `${dir}:${process.env.PATH}`, VARIANT_HOSTS: variantHosts },
    );
    const hosts = stdout
      .split('\n')
      .filter((line) => line.startsWith('submitted:'))
      .map((line) => line.slice('submitted:'.length));
    return { hosts, status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
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
    const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
    const sitemapUrls = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1].trim());
    assert.ok(sitemapUrls.length > 0, 'sitemap parse produced no URLs');

    for (const url of sitemapUrls) {
      const host = new URL(url).hostname;
      const batch = indexNow.INDEXNOW_BATCHES.find((candidate) => candidate.host === host);
      assert.ok(batch, `${host} appears in public/sitemap.xml but has no INDEXNOW_BATCHES entry`);
      assert.ok(
        batch.urls.includes(url),
        `${url} is published in the sitemap but is not in the ${host} batch, so it is never submitted`,
      );
    }
  });

  it('submits every configured batch host from the deploy workflow', async () => {
    // Three links, each pinned by execution or exact equality rather than a
    // regex over the YAML: the gate emits the derived hosts, the submit step
    // consumes that exact output, and the loop invokes --host for each one.
    const emitted = (await runRelevanceGate(['public/sitemap.xml'])).variant_hosts;
    assert.equal(
      emitted,
      indexNow.INDEXNOW_VARIANT_HOSTS.join(' '),
      'the gate must publish the hosts derived from the sitemap',
    );
    assert.equal(
      workflowStep({ name: 'Submit canonical variant dashboard URLs' }).env.VARIANT_HOSTS,
      '${{ steps.relevant.outputs.variant_hosts }}',
      'the submit step must consume the gate output, not a restated list',
    );
    const { hosts } = await runVariantSubmitStep(emitted);

    // Hosts the workflow names outright (`--host worldmonitor.app`); the variant
    // loop's hosts come from actually running it, so pointing the loop at a
    // different variable drops them here.
    const literalHosts = [...workflowSource.matchAll(/--host ((?:[a-z0-9-]+\.)*worldmonitor\.app)\b/g)]
      .map((match) => match[1]);
    assert.deepEqual(
      new Set([...literalHosts, ...hosts]),
      new Set(indexNow.INDEXNOW_BATCHES.map(({ host }) => host)),
      'every INDEXNOW_BATCHES host must be reachable from a workflow submission step',
    );
  });

  it('attempts every variant host even after one of them fails', async () => {
    const hostList = indexNow.INDEXNOW_VARIANT_HOSTS.join(' ');
    const [failed, healthy] = await Promise.all([
      runVariantSubmitStep(hostList, { failingHost: indexNow.INDEXNOW_VARIANT_HOSTS[0] }),
      runVariantSubmitStep(hostList),
    ]);

    assert.deepEqual(failed.hosts, [...indexNow.INDEXNOW_VARIANT_HOSTS], 'no host may be skipped by an earlier failure');
    assert.notEqual(failed.status, 0, 'a failed host must still fail the step');
    assert.equal(healthy.status, 0, 'an all-healthy run must succeed');
  });

  it('fails the variant step rather than reporting green on zero submissions', async () => {
    // A renamed step output or an emptied host list resolves this env var to ''.
    // Iterating nothing must not be indistinguishable from submitting everything.
    for (const empty of ['', '   ']) {
      const { hosts, status } = await runVariantSubmitStep(empty);
      assert.deepEqual(hosts, [], 'an empty host list must submit nothing');
      assert.notEqual(status, 0, `VARIANT_HOSTS=${JSON.stringify(empty)} must fail the step, not pass it`);
    }
  });

  it('gates variant resubmission on the surfaces that change variant URLs', async () => {
    const variantKeyPath = new URL(
      indexNow.INDEXNOW_BATCHES.find(({ host }) => host === indexNow.INDEXNOW_VARIANT_HOSTS[0]).keyLocation,
    ).pathname.slice(1);
    const resubmits = [
      'public/sitemap.xml',
      'scripts/build-sitemap.mjs',
      'middleware.ts',
      'src/config/variant-meta.ts',
      // Every variant root is rewritten to the welcome page, so its sources
      // change what the submitted root URLs serve. public/pro/ is gitignored
      // since #6898, so the built page can never appear in a commit diff — the
      // pro-test/ subtree stands in for it. prerender.mjs and vite.config.ts are
      // pinned explicitly: they author the served HTML but sit outside
      // pro-test/src/, so a named-file trigger list silently drops them.
      'pro-test/welcome.html',
      'pro-test/prerender.mjs',
      'pro-test/vite.config.ts',
      'pro-test/src/welcome.ts',
      `public/${variantKeyPath}`,
    ];
    const inert = ['blog-site/src/content/blog/a-post.md', 'src/components/SomePanel.tsx'];

    const [resubmitGates, inertGates, dispatchGate] = await Promise.all([
      Promise.all(resubmits.map((changed) => runRelevanceGate([changed]))),
      Promise.all(inert.map((changed) => runRelevanceGate([changed]))),
      runRelevanceGate([], 'workflow_dispatch'),
    ]);

    resubmits.forEach((changed, index) => {
      assert.equal(
        resubmitGates[index].submit_variants,
        'true',
        `${changed} changes variant URLs or their ownership proof, so it must resubmit`,
      );
    });
    inert.forEach((changed, index) => {
      assert.equal(
        inertGates[index].submit_variants,
        'false',
        `${changed} cannot change a variant URL, so it must not resubmit`,
      );
    });
    assert.equal(
      dispatchGate.submit_variants,
      'true',
      'operator-requested recovery must cover the variants too',
    );
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
    assert.match(workflow, /api\/mcp/);
    assert.match(workflow, /public\/mcp-server\\\.md/);
    assert.match(workflow, /public\/sitemap\\\.xml/);
    assert.match(workflow, /scripts\/build-sitemap\\.mjs/);
    assert.match(workflow, /blog-site\/src\/\.\*/);
    assert.match(workflow, /api\/mcp\/\.\*/);
    assert.match(workflow, /INDEXNOW_BATCHES\.find/);
    assert.match(workflow, /grep -Fxq "public\/\$\{APEX_KEY_PATH\}"/);
    assert.match(workflow, /grep -Fxq "public\/\$\{WWW_KEY_PATH\}"/);
    assert.match(workflow, /submit_apex/);
    assert.match(workflow, /submit_www/);
    assert.match(workflow, /node scripts\/seo-indexnow-submit\.mjs --host worldmonitor\.app/);
    assert.match(workflow, /node scripts\/seo-indexnow-submit\.mjs --host www\.worldmonitor\.app/);
  });
});
