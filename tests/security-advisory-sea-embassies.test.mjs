import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchAll } from '../scripts/seed-security-advisories.mjs';
import { sourceProviderDisplayName } from '../scripts/crawlable-sources-page.mjs';

const SEA_EMBASSIES = [
  { host: 'vn.usembassy.gov', code: 'VN', source: 'US Embassy Vietnam', page: 'U.S. Embassy & Consulates in Vietnam' },
  { host: 'id.usembassy.gov', code: 'ID', source: 'US Embassy Indonesia', page: 'U.S. Embassy & Consulates in Indonesia' },
  { host: 'ph.usembassy.gov', code: 'PH', source: 'US Embassy Philippines', page: 'U.S. Embassy & Consulates in the Philippines' },
  { host: 'my.usembassy.gov', code: 'MY', source: 'US Embassy Malaysia', page: 'U.S. Embassy & Consulates in Malaysia' },
  { host: 'sg.usembassy.gov', code: 'SG', source: 'US Embassy Singapore', page: 'U.S. Embassy & Consulates in Singapore' },
  { host: 'kh.usembassy.gov', code: 'KH', source: 'US Embassy Cambodia', page: 'U.S. Embassy & Consulates in Cambodia' },
];

function alertFeed(host) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><item>`
    + `<title>Demonstration Alert from ${host}</title>`
    + `<link>https://${host}/demonstration-alert/</link>`
    + `<pubDate>Tue, 10 Nov 2026 02:09:55 +0000</pubDate>`
    + `</item></channel></rss>`;
}

describe('Southeast Asia US embassy alert feeds', () => {
  it('fetches each embassy through the RSS relay and tags its alerts with the host country', async () => {
    const requestedFeeds = new Set();
    const doFetch = async (url) => {
      const relay = new URL(url);
      const target = relay.searchParams.get('url');
      const host = target ? new URL(target).hostname : '';
      if (relay.pathname === '/rss' && SEA_EMBASSIES.some((e) => e.host === host)) {
        requestedFeeds.add(target);
        return new Response(alertFeed(host), { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    const report = await fetchAll({ doFetch });

    for (const embassy of SEA_EMBASSIES) {
      assert.ok(
        requestedFeeds.has(`https://${embassy.host}/category/alert/feed/`),
        `${embassy.host} alert feed requested through the relay allowlist`,
      );
      const alert = report.advisories.find((a) => a.source === embassy.source);
      assert.ok(alert, `${embassy.source} alert stored`);
      assert.equal(alert.country, embassy.code);
      assert.equal(alert.sourceCountry, 'US');
    }
  });

  it('names each embassy host on the sources page', () => {
    for (const embassy of SEA_EMBASSIES) {
      assert.equal(sourceProviderDisplayName(embassy.host, [embassy.host]), embassy.page);
    }
  });
});
