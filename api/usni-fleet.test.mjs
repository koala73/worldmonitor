import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler, {
  __testExtractBattleForceSummary,
  __testGetRegionCoords,
  __testParseUSNIArticle,
} from './usni-fleet.js';

const ORIGINAL_FETCH = globalThis.fetch;

const SAMPLE_HTML = `
  <table>
    <tr>
      <td>Battle Force</td>
      <td>Deployed</td>
      <td>Underway</td>
    </tr>
    <tr>
      <td>292 (USS 233, USNS 59)</td>
      <td>101 (USS 72)</td>
      <td>68 (51 Deployed, 17 Local)</td>
    </tr>
  </table>
  <h2>Western Atlantic</h2>
  <p>USS <em>Gerald R. Ford</em> (CVN-78) is deployed and operating with escorts.</p>
  <h3>Carrier Strike Group 12</h3>
  <p>USS <em>Gerald R. Ford</em> (CVN-78) leads the formation.</p>
  <p>USS <em>Mahan</em> (DDG-72) is underway.</p>
  <h2>Eastern Pacific</h2>
  <p>USS <em>Nimitz</em> (CVN-68) is underway in the region.</p>
`;

function makeWpResponse(content = SAMPLE_HTML) {
  return [{
    id: 123,
    link: 'https://news.usni.org/2026/02/17/usni-news-fleet-and-marine-tracker-feb-17-2026',
    date: '2026-02-17T14:04:05',
    title: { rendered: 'USNI News Fleet and Marine Tracker: Feb. 17, 2026' },
    content: { rendered: content },
  }];
}

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test('extracts battle-force summary from label-first table layout', () => {
  const tableHtml = `
    <table>
      <tr><td>Battle Force</td><td>Deployed</td><td>Underway</td></tr>
      <tr><td>292 (USS 233, USNS 59)</td><td>101</td><td>68</td></tr>
    </table>
  `;
  const summary = __testExtractBattleForceSummary(tableHtml);
  assert.deepEqual(summary, { totalShips: 292, deployed: 101, underway: 68 });
});

test('maps recently seen USNI regions to non-zero coordinates', () => {
  const westernAtlantic = __testGetRegionCoords('Western Atlantic');
  const easternPacific = __testGetRegionCoords('Eastern Pacific');
  const antarctic = __testGetRegionCoords('Antarctic');

  assert.deepEqual(westernAtlantic, { lat: 30.0, lon: -60.0 });
  assert.deepEqual(easternPacific, { lat: 18.0, lon: -125.0 });
  assert.deepEqual(antarctic, { lat: -70.0, lon: 20.0 });
});

test('dedupes repeated ship mentions while preserving strike-group enrichment', () => {
  const report = __testParseUSNIArticle(
    SAMPLE_HTML,
    'https://news.usni.org/example',
    '2026-02-17T14:04:05',
    'USNI test report',
  );

  assert.deepEqual(report.battleForceSummary, { totalShips: 292, deployed: 101, underway: 68 });
  assert.equal(report.vessels.length, 3);
  assert.equal(report.parsingWarnings.length, 0);

  const ford = report.vessels.find((v) => v.hullNumber === 'CVN-78');
  assert.ok(ford);
  assert.equal(ford.strikeGroup, 'Carrier Strike Group 12');
  assert.equal(ford.deploymentStatus, 'deployed');

  const strikeGroup = report.strikeGroups.find((sg) => sg.name === 'Carrier Strike Group 12');
  assert.ok(strikeGroup);
  assert.equal(strikeGroup.escorts.filter((escort) => escort.includes('CVN-78')).length, 1);
});

test('handler returns parsed report with fixed summary and no duplicate vessels', async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/wp-json/wp/v2/posts')) {
      return new Response(JSON.stringify(makeWpResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const req = new Request('https://worldmonitor.app/api/usni-fleet', {
    headers: { origin: 'https://worldmonitor.app' },
  });
  const response = await handler(req);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.battleForceSummary, { totalShips: 292, deployed: 101, underway: 68 });
  assert.equal(body.parsingWarnings.length, 0);

  const uniqueByRegionHull = new Set(body.vessels.map((v) => `${v.region}|${v.hullNumber}`));
  assert.equal(uniqueByRegionHull.size, body.vessels.length);

  const easternPacific = body.vessels.find((v) => v.region === 'Eastern Pacific');
  assert.ok(easternPacific);
  assert.notEqual(easternPacific.regionLat, 0);
  assert.notEqual(easternPacific.regionLon, 0);
});
