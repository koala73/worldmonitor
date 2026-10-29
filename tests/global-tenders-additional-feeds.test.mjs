import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchColombia, fetchKenya, fetchSouthAfrica, fetchChile, fetchBrazil,
  fetchUkraine, fetchBulgaria, fetchLatvia, fetchPoland, fetchPakistan,
  ADDITIONAL_TENDER_ADAPTERS,
} from '../scripts/_global-tender-feeds.mjs';
import { mergeTenderSourceResults, safeOfficialUrl } from '../scripts/_global-tenders.mjs';
import { __testing__ as seeder } from '../scripts/seed-global-tenders.mjs';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const END = '2026-11-09T10:00:00Z';
const release = (overrides = {}) => ({
  ocid: 'ocds-test-1', id: 'release-1', date: '2026-10-28T12:00:00Z',
  buyer: { name: 'Public agency' }, tag: ['tender'],
  tender: { id: '1', title: 'Water supply', status: 'active', tenderPeriod: { endDate: END },
    value: { amount: 42, currency: 'EUR' }, items: [{ classification: { id: '45232100' } }] },
  ...overrides,
});

test('Colombia uses a bounded published-process query and preserves local closing time', async () => {
  let url;
  const result = await fetchColombia({ now: NOW, fetchJsonFn: async (u) => {
    url = new URL(u);
    return [{ id_del_proceso: 'CO1.REQ.1', nombre_del_procedimiento: 'Water supply', entidad: 'Public agency',
      estado_del_procedimiento: 'Publicado', fecha_de_recepcion_de: '2026-11-09T10:00:00.000',
      urlproceso: { url: 'https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?noticeUID=CO1.NTC.1' },
      precio_base: '42', codigo_principal_de_categoria: 'V1.45232100' }];
  } });
  assert.equal(url.searchParams.get('$limit'), '100');
  assert.match(url.searchParams.get('$where'), /Publicado/);
  assert.match(url.searchParams.get('$where'), /2026-10-29T07:00:00/);
  assert.match(url.searchParams.get('$select'), /^distinct /);
  assert.ok(url.searchParams.get('$select'), 'request only the public fields needed by the panel');
  assert.equal(result.records[0].deadline, '2026-11-09T15:00:00.000Z');
  assert.equal(result.records[0].countryCode, 'CO');
  assert.deepEqual(result.records[0].money, { amount: 42, currency: 'COP' });
});

test('Kenya requests one active page without 429 retries and drops staff and bidder data', async () => {
  let request;
  const result = await fetchKenya({ now: NOW, fetchJsonFn: async (url, options) => {
    request = { url: new URL(url), options };
    return { data: [{ id: 1, title: 'Water supply', status_id: 1, terminated: 0, published: 1,
      close_at: '2026-11-09 10:00:00', pe: { name: 'Public agency', telephone: 'private-phone' },
      created_by: { name: 'private-person', id_number: 'private-id', phone: 'private-phone' },
      tenderers: [{ name: 'private-bidder' }] }] };
  } });
  assert.equal(request.url.pathname, '/api/active-tenders');
  assert.equal(request.options.retry429, false);
  assert.equal(request.options.maxRetries, 0);
  assert.equal(result.records[0].deadline, '2026-11-09T07:00:00.000Z');
  assert.equal(result.records[0].buyer, 'Public agency');
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test('South Africa reads OCDS and excludes expired and cancelled notices', async () => {
  const result = await fetchSouthAfrica({ now: NOW, fetchJsonFn: async () => ({ releases: [
    release(), release({ ocid: 'cancelled', tender: { ...release().tender, status: 'cancelled' } }),
    release({ ocid: 'expired', tender: { ...release().tender, tenderPeriod: { endDate: '2026-10-01T00:00:00Z' } } }),
  ] }) });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].countryCode, 'ZA');
  assert.equal(result.records[0].sourceNoticeId, 'ocds-test-1');
  assert.match(result.records[0].officialUrl, /^https:\/\/www.etenders.gov.za\//);
});

test('a later OCDS cancellation suppresses an earlier active process in either response order', async () => {
  const active = release();
  const cancelled = { ocid: active.ocid, date: '2026-10-29T11:00:00Z', tender: { status: 'cancelled' } };
  for (const releases of [[active, cancelled], [cancelled, active]]) {
    const result = await fetchSouthAfrica({ now: NOW, fetchJsonFn: async () => ({ releases }) });
    assert.equal(result.records.length, 0);
    assert.equal(result.status.state, 'ok');
  }
});

test('an active OCDS tender cannot reopen its cancelled or unsuccessful lots', async () => {
  const result = await fetchBulgaria({ now: NOW,
    fetchTextFn: async () => '<ListBucketResult><Contents><Key>OCDS.json</Key></Contents></ListBucketResult>',
    fetchJsonFn: async () => ({ releases: [release({ tender: { ...release().tender, lots: [
      { id: 'open', status: 'active' }, { id: 'cancelled', status: 'cancelled' },
      { id: 'unsuccessful', status: 'unsuccessful' },
    ] } })] }),
  });
  assert.deepEqual(result.records.map((record) => record.sourceNoticeId), ['ocds-test-1:open']);
});

test('source publication activates health without a TTL only after both status writes succeed', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const commands = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://redis.example.test');
    commands.push(JSON.parse(options.body));
    return Response.json({ result: 'OK' });
  };
  await seeder.writeSourceStatus({ source: 'kenya-ppip', state: 'ok', recordCount: 0,
    fetchedAt: new Date(NOW).toISOString(), lastSuccessfulAt: new Date(NOW).toISOString() });
  assert.equal(commands.length, 3);
  assert.match(commands[0][1], /:source:kenya-ppip$/);
  assert.match(commands[1][1], /^seed-meta:/);
  assert.deepEqual(commands[2], ['SET', 'seed-activated:economic:global-tenders:kenya-ppip', '1']);
  commands.length = 0;
  await seeder.writeSourceStatus({ source: 'kenya-ppip', state: 'error', recordCount: 0 });
  assert.equal(commands.length, 2, 'a failed source cannot activate health');
  commands.length = 0;
  globalThis.fetch = async (_url, options) => {
    commands.push(JSON.parse(options.body));
    return commands.length === 1 ? Response.json({ result: 'OK' }) : new Response('denied', { status: 403 });
  };
  await assert.rejects(seeder.writeSourceStatus({ source: 'kenya-ppip', state: 'ok', recordCount: 0 }), /403/);
  assert.equal(commands.length, 2, 'a failed metadata write cannot activate health');
});

test('Chile follows only the fixed official detail API and rejects incomplete detail windows', async () => {
  const calls = [];
  const result = await fetchChile({ now: NOW, fetchJsonFn: async (url) => {
    calls.push(String(url));
    return calls.length === 1 ? { data: [{ ocid: 'ocds-70d2nz-123-LE26', urlTender: 'http://untrusted.example/private' }] }
      : { releases: [release({ tender: { ...release().tender, id: '123-LE26' } })] };
  } });
  assert.equal(calls[1], 'https://api.mercadopublico.cl/APISOCDS/OCDS/tender/123-LE26');
  assert.equal(result.records[0].countryCode, 'CL');
  await assert.rejects(fetchChile({ now: NOW, fetchJsonFn: async (url) => String(url).includes('listaOCDS')
    ? { data: [{ ocid: 'ocds-70d2nz-123-LE26' }] } : { error: 'changed' } }), /releases/);
});

test('Brazil reads active proposals across modalities and builds an official PNCP link', async () => {
  let requested;
  const result = await fetchBrazil({ now: NOW, fetchJsonFn: async (url) => {
    requested = new URL(url);
    return { data: [{ numeroControlePNCP: '12345678000190-1-000001/2026', objetoCompra: 'Water supply',
      orgaoEntidade: { cnpj: '12345678000190', razaoSocial: 'Public agency' }, anoCompra: 2026, sequencialCompra: 1,
      situacaoCompraId: 1, dataEncerramentoProposta: '2026-11-09T10:00:00', valorTotalEstimado: 0 }] };
  } });
  assert.equal(requested.pathname, '/api/consulta/v1/contratacoes/proposta');
  assert.equal(requested.searchParams.has('codigoModalidadeContratacao'), false);
  assert.equal(requested.searchParams.get('tamanhoPagina'), '10');
  assert.equal(result.records[0].officialUrl, 'https://pncp.gov.br/app/editais/12345678000190/2026/1');
  assert.deepEqual(result.records[0].money, { amount: 0, currency: 'BRL' });
  assert.equal(result.records[0].deadline, '2026-11-09T13:00:00.000Z');
});

test('Ukraine requires the bidding stage and never treats qualification as open', async () => {
  const result = await fetchUkraine({ now: NOW, fetchJsonFn: async (url) => String(url).includes('?')
    ? { data: [{ id: 'one' }, { id: 'two' }] }
    : { data: { id: String(url).endsWith('one') ? 'one' : 'two', title: 'Water supply',
      status: String(url).endsWith('one') ? 'active.tendering' : 'active.qualification',
      tenderPeriod: { endDate: END }, procuringEntity: { name: 'Public agency' } } } });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].countryCode, 'UA');
  assert.equal(result.records[0].officialUrl, 'https://prozorro.gov.ua/tender/one');
});

test('Bulgaria reads the previous daily OCDS file and keeps lot deadlines separate', async () => {
  const calls = [];
  const result = await fetchBulgaria({ now: NOW, fetchTextFn: async (url) => {
    calls.push(String(url));
    return '<ListBucketResult><Contents><Key>notices OCDS.json</Key></Contents></ListBucketResult>';
  }, fetchJsonFn: async (url) => {
    calls.push(String(url));
    return { releases: [release({ tender: { id: '1', title: 'Water supply', status: 'active', lots: [
      { id: 'LOT-1', tenderPeriod: { endDate: END } },
      { id: 'LOT-2', tenderPeriod: { endDate: '2026-10-01T00:00:00Z' } },
    ] } })] };
  } });
  assert.match(calls[0], /open-data-2026-10-28\/$/);
  assert.match(calls[1], /notices%20OCDS.json$/);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].deadline, '2026-11-09T10:00:00.000Z');
});

test('Latvia keeps competition lots, resolves Riga winter time, and drops contact points', async () => {
  const result = await fetchLatvia({ now: NOW, fetchJsonFn: async () => [{
    identifier: 'notice-1', name: 'Water supply', formType: 'competition',
    organizationData: { name: 'Public agency' }, contactPoint: { name: 'private-person' },
    tenderingProcess: { documentsURL: 'https://www.eis.gov.lv/EKEIS/Supplier/Procurement/1' },
    lots: [{ id: 1, name: 'Water pipes', tenderingProcess: {
      deadlineReceiptTendersEndDate: '09/11/2026', deadlineReceiptTendersEndTime: '10:00',
    } }],
  }] });
  assert.equal(result.records[0].deadline, '2026-11-09T08:00:00.000Z');
  assert.equal(result.records[0].countryCode, 'LV');
  assert.doesNotMatch(JSON.stringify(result), /private-person/);
});

test('Poland reads current contract notices and excludes outdated notices', async () => {
  let url;
  const row = { objectId: 'notice-1', noticeType: 'ContractNotice', orderObject: 'Water supply',
    submittingOffersDate: END, organizationName: 'Public agency', publicationDate: '2026-10-28T12:00:00Z', outdated: false };
  const result = await fetchPoland({ now: NOW, fetchJsonFn: async (u) => {
    url = new URL(u); return [row, { ...row, objectId: 'old', outdated: true }];
  } });
  assert.equal(url.searchParams.get('NoticeType'), 'ContractNotice');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].countryCode, 'PL');
});

test('Pakistan parses public rows with a closing time and rejects a drifted HTML page', async () => {
  const html = '<table><tbody><tr class="cb-rt-main"><td data-label="Tender No">TS1</td>'
    + '<td data-label="Tender Details"><strong>Water supply</strong></td>'
    + '<td data-label="Status">Published</td><td data-label="Advertised">Oct 28, 2026</td>'
    + '<td data-label="Closing"><strong>Nov 09, 2026</strong><small>10:30 AM</small></td>'
    + '<td data-label="Actions"><a href="/public/tenders/tender-details/TS1">View</a></td></tr></tbody></table>';
  const result = await fetchPakistan({ now: NOW, fetchTextFn: async () => html });
  assert.equal(result.records[0].deadline, '2026-11-09T05:30:00.000Z');
  assert.equal(result.records[0].title, 'Water supply');
  assert.equal(result.records[0].countryCode, 'PK');
  await assert.rejects(fetchPakistan({ now: NOW, fetchTextFn: async () => '<html>Login</html>' }), /tender rows/);
});

test('JSON adapters reject schema drift and malformed rows instead of clearing last-good data', async () => {
  for (const fetchSource of [fetchColombia, fetchKenya, fetchSouthAfrica, fetchChile, fetchBrazil, fetchUkraine, fetchLatvia, fetchPoland]) {
    await assert.rejects(fetchSource({ now: NOW, fetchJsonFn: async () => ({ message: 'changed' }) }));
    await assert.rejects(fetchSource({ now: NOW, fetchJsonFn: async () => {
      if ([fetchColombia, fetchLatvia, fetchPoland].includes(fetchSource)) return [{}];
      if (fetchSource === fetchSouthAfrica) return { releases: [{}] };
      return { data: [{}] };
    } }));
  }
});

test('each added source accepts valid empty responses and has a strict official URL scope', async () => {
  for (const [source, fetchSource] of ADDITIONAL_TENDER_ADAPTERS.filter(([, fn]) => ![fetchBulgaria, fetchPakistan].includes(fn))) {
    const result = await fetchSource({ now: NOW, fetchJsonFn: async () => [fetchColombia, fetchLatvia, fetchPoland].includes(fetchSource)
      ? [] : fetchSource === fetchSouthAfrica ? { releases: [] } : { data: [] } });
    assert.equal(result.status.state, 'ok', source);
    assert.deepEqual(result.records, [], source);
    assert.equal(safeOfficialUrl('https://attacker.example/notice', source), '');
  }
});

test('added sources retain last-good records only within their own three-hour success clock', async () => {
  const record = (await fetchKenya({ now: NOW, fetchJsonFn: async () => ({ data: [{ id: 1, title: 'Water supply',
    status_id: 1, terminated: 0, published: 1, close_at: '2026-11-09 10:00:00' }] }) })).records[0];
  const prior = { fetchedAt: NOW, dataAvailable: true, tenders: [record], sourceStatuses: [{
    source: 'kenya-ppip', state: 'ok', fetchedAt: new Date(NOW).toISOString(), lastSuccessfulAt: new Date(NOW).toISOString(), recordCount: 1,
  }] };
  const failed = (now, previousSnapshot) => mergeTenderSourceResults({ sourceNames: ['kenya-ppip'], previousSnapshot,
    settled: [{ status: 'rejected', reason: new Error('HTTP 429') }], attemptedAt: new Date(now).toISOString() });
  const retained = failed(NOW + 60_000, prior);
  assert.equal(retained.sourceStatuses[0].state, 'stale');
  const expired = failed(NOW + 180 * 60_000, retained);
  assert.equal(expired.tenders.length, 0);
  assert.equal(expired.sourceStatuses[0].state, 'error');
  assert.equal(expired.sourceStatuses[0].lastSuccessfulAt, new Date(NOW).toISOString());
});
