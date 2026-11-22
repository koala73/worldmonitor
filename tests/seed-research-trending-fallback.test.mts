import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fetchTrendingRepos, parseGitHubTrendingHtml, TRENDING_TTL } from '../scripts/seed-research.mjs';
import { listTrendingRepos } from '../server/worldmonitor/research/v1/list-trending-repos';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

const trendingFixture = readFileSync(new URL('./fixtures/github-trending-python.html', import.meta.url), 'utf8');
const LANGS = ['python', 'javascript', 'typescript'];
const searchItem = (lang: string) => ({ full_name: `octo/${lang}`, html_url: `https://github.com/octo/${lang}`, stargazers_count: 9 });
const producedNames = (produced: Record<string, { repos: { fullName: string }[] }>, lang: string) =>
  produced[`research:trending:v1:${lang}:daily:50`]?.repos.map((repo) => repo.fullName);

test('a captured github.com/trending page parses into repos with daily star counts', () => {
  assert.deepEqual(parseGitHubTrendingHtml(trendingFixture, 'python'), [
    {
      fullName: 'elementalsouls/Claude-BugHunter',
      description: 'A Claude Code skill bundle for bug hunting and external red-team work - 82 skills, 15 slash commands, 681 disclosed-report patterns curated across 24 core vulnerability classes, plus enterprise identity + infrastructure attack matrices.',
      language: 'Python', stars: 17311, starsToday: 1721, forks: 1935,
      url: 'https://github.com/elementalsouls/Claude-BugHunter',
    },
    {
      fullName: 'HKUDS/CLI-Anything',
      description: '"CLI-Anything: Making ALL Software Agent-Native" -- CLI-Hub: https://clianything.cc/',
      language: 'Python', stars: 62615, starsToday: 687, forks: 5680,
      url: 'https://github.com/HKUDS/CLI-Anything',
    },
  ]);
});

test('the trending page is the primary source and GitHub search is not called', async () => {
  const hosts: string[] = [];
  globalThis.fetch = async (url) => {
    const { hostname, pathname } = new URL(String(url));
    hosts.push(hostname);
    assert.equal(hostname, 'github.com', `unexpected fetch to ${hostname}`);
    assert.match(pathname, /^\/trending\/(python|javascript|typescript)$/);
    return new Response(trendingFixture, { headers: { 'content-type': 'text/html' } });
  };
  const produced = await fetchTrendingRepos();
  for (const lang of LANGS) {
    assert.deepEqual(producedNames(produced, lang), ['elementalsouls/Claude-BugHunter', 'HKUDS/CLI-Anything']);
  }
  assert.deepEqual(hosts, ['github.com', 'github.com', 'github.com']);
});

for (const [label, trendingResponse] of [
  ['an empty trending page', () => new Response('<html><body><div class="Box"></div></body></html>')],
  ['a non-OK trending response', () => new Response('rate limited', { status: 429 })],
  ['a trending page whose star counts no longer parse', () => new Response(trendingFixture.replace(/stars today/g, 'estrellas hoy'))],
] as const) {
  test(`${label} falls through to GitHub search`, async () => {
    const hosts: string[] = [];
    globalThis.fetch = async (url) => {
      const { hostname, searchParams } = new URL(String(url));
      hosts.push(hostname);
      if (hostname === 'github.com') return trendingResponse();
      const lang = searchParams.get('q')!.match(/language:(\w+)/)![1];
      return Response.json({ items: [searchItem(lang)] });
    };
    const produced = await fetchTrendingRepos();
    for (const lang of LANGS) assert.deepEqual(producedNames(produced, lang), [`octo/${lang}`]);
    assert.equal(hosts.filter((host) => host === 'api.github.com').length, 3);
    assert.ok(!hosts.includes('api.ossinsight.io'));
  });
}

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
