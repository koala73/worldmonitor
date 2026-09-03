import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { xFetchJson } = require('../scripts/lib/x-news-accounts.cjs');
const approved = new Map([
  ['scripts/lib/company-monitoring-x-provider.mjs', {
    endpoints: ['/2/tweets', '/2/tweets/search/recent'],
    wrappers: [
      /const xResponse = async[\s\S]{0,300}assertXPostBudgetAdmission\(/,
      /trackedUrl[\s\S]{0,1200}xPostsJson\(trackedUrl/,
      /new URL\('\/2\/tweets\/search\/recent'[\s\S]{0,1200}xPostsJson\(url/,
    ],
  }],
  ['scripts/lib/x-news-accounts.cjs', {
    endpoints: ['/2/users/${encodeURIComponent(id)}/tweets', '/2/tweets'],
    wrappers: [
      /async function xFetchJson[\s\S]{0,300}assertXPostBudgetAdmission\(/,
      /buildUserTimelineUrl\([\s\S]{0,1200}executePostRead\(\{/,
      /buildTweetsLookupUrl\([\s\S]{0,1200}executePostRead\(\{/,
    ],
  }],
  ['scripts/verify-x-accounts.mjs', {
    endpoints: ['/2/users/${account.accountId}/tweets'],
    wrappers: [
      /async function apiGet[\s\S]{0,300}assertXPostBudgetAdmission\(/,
      /postBudget\.withReturnedPosts\([\s\S]{0,800}execute: \([^)]*postBudgetAdmission[^)]*\) => apiGet\(/,
    ],
  }],
]);
const runtimeExtension = /\.(?:cjs|js|mjs|rs|ts|tsx)$/;
const postEndpoint = /\/2\/tweets\/search\/recent|\/2\/tweets|\/2\/users\/[^\s'"`]+\/tweets/g;

function endpointLiterals(source) {
  return [...source.matchAll(postEndpoint)].map((match) => match[0]);
}

describe('X Post-returning endpoint inventory', () => {
  it('keeps every runtime Post endpoint behind the shared returned-Post budget', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root })
      .toString('utf8')
      .split('\0')
      .filter((file) => runtimeExtension.test(file) && !file.startsWith('tests/'));
    const matches = files
      .map((file) => ({ file, source: readFileSync(resolve(root, file), 'utf8') }))
      .map((entry) => ({ ...entry, endpoints: endpointLiterals(entry.source) }))
      .filter(({ endpoints }) => endpoints.length > 0);

    assert.deepEqual(new Set(matches.map(({ file }) => file)), new Set(approved.keys()));
    for (const { file, source, endpoints } of matches) {
      const contract = approved.get(file);
      assert.deepEqual(endpoints, contract.endpoints, `${file} endpoint call-site inventory changed`);
      for (const wrapper of contract.wrappers) {
        assert.match(source, wrapper, `${file} must route each Post call site through its budget wrapper`);
      }
    }
  });

  it('rejects an uncapped Post call at the X transport boundary', async () => {
    let fetches = 0;
    await assert.rejects(
      () => xFetchJson(async () => {
        fetches += 1;
        return Response.json({ data: [] });
      }, new URL('https://api.x.com/2/users/123/tweets'), 'token'),
      /requires unused shared budget admission/,
    );
    assert.equal(fetches, 0);
  });
});
