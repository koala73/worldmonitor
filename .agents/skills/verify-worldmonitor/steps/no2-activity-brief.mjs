import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { no2ActivityDataset } from '../../../../tests/helpers/no2-activity-fixture.mjs';
import { seedProfile, waitForBoot } from './_profile.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// Country brief "Industrial Activity (NO2)" section: open the shareable deep
// link for a country with a reading and one whose baseline is pending, and
// prove the section renders each state. The route body is the real handler's
// answer for the shared fixture (see no2-activity.mjs for why it runs in a
// tsx child process); the brief's own country_code filter is applied here.
function routeBody(dataset) {
  const code = `
    import { getNo2Activity } from './server/worldmonitor/economic/v1/get-no2-activity.ts';
    const dataset = JSON.parse(process.argv[1]);
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.verify.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'verify';
    globalThis.fetch = async () => Response.json({ result: JSON.stringify(dataset) });
    process.stdout.write(JSON.stringify(await getNo2Activity({}, { countryCode: '', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' })));
  `;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify(dataset)], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.toString());
}

export default async function ({ page, base, shot, log }) {
  const mobile = process.env.WM_VERIFY_MOBILE === '1';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });

  const now = Date.now();
  const dataset = no2ActivityDataset({
    generatedAt: new Date(now - 3_600_000).toISOString(),
    windowEnd: new Date(now - 4 * 86_400_000).toISOString().slice(0, 10),
    changes: { 'country-de': -13.4, 'country-fr': 'pending' },
  });
  const body = routeBody(dataset);
  assert.equal(body.unavailableReason, 'NO2_ACTIVITY_UNAVAILABLE_REASON_UNSPECIFIED', 'the real handler must serve the fixture');

  const requested = [];
  await page.route('**/api/economic/v1/get-no2-activity*', async (route) => {
    const url = new URL(route.request().url());
    requested.push(url.search);
    const code = (url.searchParams.get('country_code') ?? '').toUpperCase();
    const kind = url.searchParams.get('kind');
    const regions = body.regions.filter((r) => (!code || r.countryCode === code) && (!kind || r.kind === kind));
    return route.fulfill({ json: { ...body, regions } });
  });

  for (const [country, expectState, expectText] of [
    ['DE', 'weakening', /Weakening -13\.4% vs the same window in/],
    ['FR', 'pending', /Baseline pending/],
  ]) {
    await seedProfile(page);
    await page.goto(`${base}/dashboard?country=${country}`, { waitUntil: 'domcontentloaded' });
    await waitForBoot(page);
    await page.locator('#country-deep-dive-panel').waitFor({ state: 'attached', timeout: 90_000 });
    // The brief opens on Overview; the section belongs to the Economy topic.
    await page.locator('.cdp-topic-nav button[data-topic="economy"]').click();
    const card = page.locator('#cdp-section-activity');
    await card.waitFor({ state: 'visible', timeout: 90_000 });
    const line = card.locator('.cdp-no2-activity');
    await line.waitFor({ timeout: 30_000 });
    const text = await card.innerText();
    assert.equal(await line.getAttribute('data-no2-state'), expectState, `${country} state`);
    assert.match(text, expectText);
    assert.match(text, /valid days/);
    log(`${country} section`, text.replace(/\s+/g, ' ').slice(0, 300));
    await card.scrollIntoViewIfNeeded();
    await shot(`brief-${country.toLowerCase()}-${expectState}`);
  }
  assert.ok(requested.every((q) => /country_code=(DE|FR)/.test(q) && /kind=NO2_REGION_KIND_COUNTRY/.test(q)), `brief requests only the country region: ${requested.join(' ')}`);
  log('Assertions passed', { requests: requested.length, mobile });
}
