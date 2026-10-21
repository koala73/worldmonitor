/**
 * The privacy policy claims its subprocessor list is complete ("listed in full
 * below"). This asserts that the claim survives contact with the code.
 *
 * #5388 was closed COMPLETED in July 2026 while DebugBear RUM kept loading on
 * every production host and the policy kept not naming it, and the self-hosted
 * Umami collector was never named at all (#6978). Both are disclosed now; this
 * is what stops the next collector from being added silently.
 *
 * The check is deliberately host-shaped, not name-shaped: a collector is
 * whatever the client sends beacons to, so a new script host that nothing in
 * the policy accounts for is the failure — regardless of what it is called.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

// Every file that can inject a third-party or self-hosted telemetry script into
// a production page. Adding a collector anywhere else means adding it here too.
const COLLECTOR_CALL_SITES = [
  'src/bootstrap/debugbear-rum.ts',
  'src/services/analytics.ts',
  'pro-test/src/debugbear-rum.ts',
  'pro-test/welcome.html',
];

// host -> how the privacy policy must account for it.
const DISCLOSED_COLLECTOR_HOSTS = new Map([
  ['cdn.debugbear.com', /DebugBear/],
  ['abacus.worldmonitor.app', /Umami/],
]);

/**
 * Only what a reader sees counts. The first attempt at this file matched the
 * raw file and passed against a policy with DebugBear deleted from the table,
 * because the page's `{/* REVIEW ... *␟/}` note happens to mention DebugBear —
 * an invisible comment is not a disclosure.
 */
function visibleBody(text) {
  return text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

function collectorHosts() {
  const hosts = new Set();
  for (const relativePath of COLLECTOR_CALL_SITES) {
    const text = read(relativePath);
    for (const [, host] of text.matchAll(/https:\/\/([a-z0-9.-]+)\/(?:script\.js|[A-Za-z0-9]+\.js)/g)) {
      hosts.add(host);
    }
  }
  return hosts;
}

describe('privacy policy discloses every live collector', () => {
  const policy = visibleBody(read('docs/privacy.mdx'));
  const zhPolicy = visibleBody(read('docs/zh/privacy.mdx'));
  const subprocessorTable = policy.slice(policy.indexOf('| Provider |'));

  it('finds the collectors the client actually loads', () => {
    const hosts = collectorHosts();
    // Guards the scan itself: a refactor that renames the constants would
    // otherwise leave this file passing against an empty set.
    for (const known of DISCLOSED_COLLECTOR_HOSTS.keys()) {
      assert.ok(hosts.has(known), `expected to find ${known} in the collector call sites`);
    }
  });

  for (const [host, disclosure] of DISCLOSED_COLLECTOR_HOSTS) {
    it(`names the ${host} collector in both policies`, () => {
      assert.match(policy, disclosure, `docs/privacy.mdx must account for ${host} in its visible text`);
      assert.match(zhPolicy, disclosure, `docs/zh/privacy.mdx must account for ${host} in its visible text`);
      assert.match(
        subprocessorTable,
        disclosure,
        `${host} must appear in the subprocessor table, which is what claims to be complete`,
      );
    });
  }

  it('has no undisclosed collector host', () => {
    const undisclosed = [...collectorHosts()].filter((host) => !DISCLOSED_COLLECTOR_HOSTS.has(host));
    assert.deepEqual(
      undisclosed,
      [],
      'a telemetry script host is loaded that the privacy policy does not account for — disclose it and add it here',
    );
  });

  it('states the DebugBear sampling rate the code actually ships', () => {
    const rate = read('src/bootstrap/debugbear-rum.ts').match(/DEBUGBEAR_RUM_SAMPLE_RATE = (\d+)/)?.[1];
    assert.ok(rate, 'could not read the sample rate from the loader');
    assert.match(
      policy,
      new RegExp(`${rate}%`),
      `the policy must state the ${rate}% sample the loader ships, not a stale figure`,
    );
  });
});

/**
 * Server-side subprocessors, by the integration that proves each one is live.
 *
 * The browser-collector sweep above cannot see these: Upstash, Railway and
 * Mintlify never touch the page, they process personal data behind us — an IP
 * inside a rate-limit key, the analytics database, the docs origin that serves
 * this very page. All three were missing from a table that claims to be
 * complete (#6978), which is why the anchor is a code fact rather than a name.
 *
 * Each entry pairs a provider with a grep that is true only while the
 * integration exists, so the table has to change in both directions: adopt the
 * provider and it must be disclosed; drop it and the stale row must go.
 */
const SERVER_SUBPROCESSORS = [
  {
    name: /Upstash/,
    proof: 'server/_shared/rate-limit.ts',
    pattern: /@upstash\/ratelimit/,
    why: 'rate-limit keys are derived from the client IP',
  },
  {
    name: /Railway/,
    proof: 'scripts/railway-services.json',
    pattern: /"service":\s*"umami"/,
    why: 'hosts the analytics service and notification delivery',
  },
  {
    name: /Mintlify/,
    proof: 'vercel.json',
    pattern: /worldmonitor\.mintlify\.dev/,
    why: 'serves worldmonitor.app/docs, including the privacy policy itself',
  },
];

describe('privacy policy discloses the subprocessors behind the page', () => {
  const policy = visibleBody(read('docs/privacy.mdx'));
  const zhPolicy = visibleBody(read('docs/zh/privacy.mdx'));
  const subprocessorTable = policy.slice(policy.indexOf('| Provider |'));

  for (const { name, proof, pattern, why } of SERVER_SUBPROCESSORS) {
    it(`${proof} still proves the integration this row describes`, () => {
      // Guards the guard: if the proof stops matching, the row below is being
      // asserted against nothing and the pairing has to be re-derived.
      assert.match(read(proof), pattern, `${proof} no longer shows the integration — re-check whether the disclosure is still accurate`);
    });

    it(`the table names it (${why})`, () => {
      assert.match(subprocessorTable, name, `docs/privacy.mdx must disclose the provider matched by ${name}`);
      assert.match(zhPolicy, name, `docs/zh/privacy.mdx must disclose the provider matched by ${name}`);
    });
  }

  it('names alert destinations as recipients, not as subprocessors', () => {
    // Telegram/Slack/Discord receive alert content because a user pointed them
    // there. Listing them as subprocessors would be wrong in the other
    // direction, so the policy has to say which they are.
    for (const [label, text] of [['en', policy], ['zh', zhPolicy]]) {
      assert.match(text, /Telegram/, `${label} policy must account for the Telegram channel`);
      assert.match(text, /Slack/, `${label} policy must account for the Slack channel`);
      assert.match(text, /Discord/, `${label} policy must account for the Discord channel`);
    }
    const channelTypes = read('convex/schema.ts');
    for (const channel of ['telegram', 'slack', 'discord', 'webhook', 'web_push', 'email']) {
      assert.match(
        channelTypes,
        new RegExp(`v\\.literal\\("${channel}"\\)`),
        `notificationChannels no longer ships ${channel} — the policy section describing it is stale`,
      );
    }
  });
});
