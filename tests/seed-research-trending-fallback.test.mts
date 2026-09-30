import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fetchTrendingRepos, TRENDING_TTL } from '../scripts/seed-research.mjs';
import { listTrendingRepos } from '../server/worldmonitor/research/v1/list-trending-repos';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

test('an empty OSSInsight result falls through to GitHub search', async () => {
  const hosts: string[] = [];
  globalThis.fetch = async (url) => {
    const { hostname, searchParams } = new URL(String(url));
    hosts.push(hostname);
    if (hostname === 'api.ossinsight.io') return Response.json({ data: { rows: [] } });
    const lang = searchParams.get('q')!.match(/language:(\w+)/)![1];
    return Response.json({ items: [{ full_name: `octo/${lang}`, html_url: `https://github.com/octo/${lang}`, stargazers_count: 9 }] });
  };
  const produced = await fetchTrendingRepos();
  for (const lang of ['python', 'javascript', 'typescript']) {
    assert.deepEqual(produced[`research:trending:v1:${lang}:daily:50`]?.repos.map((repo: { fullName: string }) => repo.fullName), [`octo/${lang}`]);
  }
  assert.equal(hosts.filter((host) => host === 'api.github.com').length, 3);
});

test('trending snapshots outlive at least three hourly seed-research cron ticks', () => {
  assert.ok(TRENDING_TTL >= 3 * 3600, `TRENDING_TTL (${TRENDING_TTL}s) must be at least 3x the hourly cron (10800s)`);
});

test('an omitted (zero) pageSize returns the default page, not one repo', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  const repos = Array.from({ length: 3 }, (_, index) => ({ fullName: `octo/repo-${index}` }));
  globalThis.fetch = async () => Response.json({ result: JSON.stringify({ repos }) });
  const context = { request: new Request('https://worldmonitor.app/research'), headers: {}, pathParams: {} };
  const response = await listTrendingRepos(context, { language: 'python', period: 'daily', pageSize: 0, cursor: '' });
  assert.equal(response.repos.length, 3);
});
