import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listAirportDelays } from '../server/worldmonitor/aviation/v1/list-airport-delays.ts';

test('list-airport-delays rejects unknown query parameters before it builds a response', async () => {
  const request = new Request(
    'https://worldmonitor.app/api/aviation/v1/list-airport-delays?ignored=' + 'x'.repeat(10_000),
  );
  await assert.rejects(
    listAirportDelays({ request } as never, { pageSize: 0, cursor: '', region: '', minSeverity: '' }),
    { statusCode: 400 },
  );
});

for (const query of ['cursor=&cursor=cache-split', 'page_size=0&page_size=999999']) {
  test(`list-airport-delays rejects duplicate query key: ${query}`, async () => {
    const request = new Request(`https://worldmonitor.app/api/aviation/v1/list-airport-delays?${query}`);
    await assert.rejects(
      listAirportDelays({ request } as never, { pageSize: 0, cursor: '', region: '', minSeverity: '' }),
      { statusCode: 400 },
    );
  });
}

for (const query of ['page_size=' + '0'.repeat(10_000), 'page_size=0cache-split']) {
  test('list-airport-delays rejects noncanonical zero page sizes', async () => {
    const request = new Request(`https://worldmonitor.app/api/aviation/v1/list-airport-delays?${query}`);
    await assert.rejects(
      listAirportDelays({ request } as never, { pageSize: 0, cursor: '', region: '', minSeverity: '' }),
      { statusCode: 400 },
    );
  });
}

test('list-airport-delays accepts the Vercel router echo', async () => {
  const request = new Request('https://worldmonitor.app/api/aviation/v1/list-airport-delays?rpc=list-airport-delays');
  const response = await listAirportDelays({ request } as never, { pageSize: 0, cursor: '', region: '', minSeverity: '' });
  assert.ok(response.alerts.length > 0);
});
