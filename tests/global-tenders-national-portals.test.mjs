import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPakistanEpads, fetchGeorgia, fetchArmenia, fetchPakistan, fetchAlbania, fetchDominicanRepublic, fetchMalaysia } from '../scripts/_global-tender-feeds.mjs';
import { tracksTenderFreshness, safeOfficialUrl } from '../scripts/_global-tenders.mjs';
import { createTenderReceipt, observeTenderSource, observeTenderRequest } from '../scripts/_global-tender-receipts.mjs';
import { __testing__ as seeder } from '../scripts/seed-global-tenders.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const epads = (closing = 'Tuesday, November 10, 2026 10:30 AM') => `<table><thead><th>Procurement Title</th></thead><tbody class="table-border-bottom-0"><tr>
  <td>1</td><td><a href="/opportunities/federal/procurements/123"><span title="Cloud &amp; data platform">Cloud...</span></a><span title="Public Agency">Public Agency</span></td>
  <td>Published On: Friday, October 30, 2026 12:00 AM Closing On: ${closing}</td><td>Supplies Single Stage</td><td>View</td>
  </tr></tbody></table>`;
const georgiaList = `<table id="list_apps_by_subject"><tr onclick="ShowApp(123,'',0,'abc123')"><td>1</td></tr></table>`;
const georgia = (fields = {}) => `<div id="app_main"><table>${Object.entries({
  'Announcment number': 'NAT26000123', 'Procurement proceeding status': 'Tender announced',
  'Procuring entities': 'Public Agency', 'Procuring category': '45200000 - Infrastructure works',
  'Procurement announcment date': '30.10.2026 12:00', 'Deadline for bid submission': '10.11.2026 14:00',
  'Estimated value of procurement': '160`000.00 GEL', 'Procurement type': 'NAT', ...fields,
}).map(([key, value]) => `<tr><td>${key}</td><td>${value}</td></tr>`).join('')}</table><div class="blabla">Water infrastructure works</div></div>`;
const armeniaList = `<h3>Search results</h3>CfT Title:<input name="status" value="cft.status.tender.submission"><a href="/epps/cft/prepareViewCfTWS.do?resourceId=456">Water infrastructure works</a>`;
const armenia = (fields = {}) => `<dl>${Object.entries({
  'CfT Id': 'AM-123', 'Title': 'Տեղական վերնագիր', 'Title (EN)': 'Water infrastructure works',
  'Name of Contracting Authority': 'Public Agency', 'CPV Codes': '45200000 - Infrastructure works',
  'Date of Publication/Invitation': '30/10/2026 12:00',
  'Time-limit for receipt of tenders or requests to participate': '10/11/2026 10:00',
  'Date of Awarding': '', 'Estimated value (AMD)': '', Procedure: 'Open', ...fields,
}).map(([key, value]) => `<dt>${key}:</dt><dd>${value}</dd>`).join('')}</dl>`;

function sessionTransport(list, detail) {
  const requests = [];
  const fetchResponseFn = async (url, options) => {
    const target = new URL(url);
    requests.push({ url: target, options });
    assert.equal(options.redirect, 'manual');
    if (requests.length === 1) return new Response('<html>Home</html>', { headers: { 'Set-Cookie': 'anonymous=one; Path=/; HttpOnly' } });
    assert.equal(options.headers.Cookie, 'anonymous=one');
    assert.equal(options.maxRetries, 0);
    assert.equal(options.retry429, false);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 75_000);
    if (target.pathname.endsWith('changeLanguage.do')) return new Response('<html lang="en"></html>');
    if (target.searchParams.get('action') === 'app_main' || target.pathname.includes('prepareViewCfTWS')) return new Response(detail);
    return new Response(list);
  };
  return { requests, fetchResponseFn };
}

test('EPADS projects complete title, buyer and actual Pakistan timestamps from one public list', async () => {
  let count = 0;
  const result = await fetchPakistanEpads({ now: NOW, fetchTextFn: async (url, options) => {
    count++;
    assert.equal(url, 'https://epads.gov.pk/');
    assert.equal(options.maxRetries, 0);
    return epads() + '<script>const privateContact = "private-phone";</script>';
  } });
  assert.equal(count, 1);
  assert.equal(result.records[0].title, 'Cloud & data platform');
  assert.equal(result.records[0].buyer, 'Public Agency');
  assert.equal(result.records[0].countryCode, 'PK');
  assert.equal(result.records[0].deadline, '2026-11-10T05:30:00.000Z');
  assert.equal(result.records[0].publishedAt, '2026-10-29T19:00:00.000Z');
  assert.equal(result.records[0].officialUrl, 'https://epads.gov.pk/opportunities/federal/procurements/123');
  assert.doesNotMatch(JSON.stringify(result), /private-phone|anonymous/);
});

test('EPADS resolves countdown deadlines from the official detail timer without estimating them', async () => {
  const result = await fetchPakistanEpads({ now: NOW, fetchTextFn: async (url) => url === 'https://epads.gov.pk/'
    ? epads('12h 20m Left') : '<script>showBiddingTimer("1794299400", "0");</script>' });
  assert.equal(result.records[0].deadline, new Date(1794299400 * 1000).toISOString());
  await assert.rejects(fetchPakistanEpads({ now: NOW, fetchTextFn: async (url) => url === 'https://epads.gov.pk/'
    ? epads('12h 20m Left') : '<html>Login</html>' }));
});

test('EPADS excludes expired tenders and rejects malformed or missing closing times', async () => {
  const expired = await fetchPakistanEpads({ now: NOW, fetchTextFn: async () => epads('Friday, October 30, 2026 10:30 AM') });
  assert.deepEqual(expired.records, []);
  for (const closing of ['November 10, 2026', 'November 31, 2026 10:30 AM', 'November 10, 2026 10:99 AM', 'November 10, 2026 13:00 PM']) {
    await assert.rejects(fetchPakistanEpads({ now: NOW, fetchTextFn: async () => epads(closing) }));
  }
  await assert.rejects(fetchPakistanEpads({ now: NOW, fetchTextFn: async () => '<html>Login</html>' }));
});

test('Georgia uses an anonymous session and detail closing time rather than the list date', async () => {
  const transport = sessionTransport(georgiaList, georgia());
  const result = await fetchGeorgia({ now: NOW, ...transport });
  assert.equal(transport.requests.length, 3);
  assert.equal(transport.requests[1].url.searchParams.get('app_status'), '10');
  assert.equal(result.records[0].countryCode, 'GE');
  assert.equal(result.records[0].deadline, '2026-11-10T10:00:00.000Z');
  assert.equal(result.records[0].title, 'Water infrastructure works');
  assert.deepEqual(result.records[0].money, { amount: 160000, currency: 'GEL' });
  assert.equal(result.records[0].officialUrl, 'https://tenders.procurement.gov.ge/public/?go=123&lang=en');
  assert.deepEqual(result.records[0].categoryCodes, ['45200000']);
  assert.doesNotMatch(JSON.stringify(result), /abc123|anonymous/);
});

test('publisher sessions follow bounded same-origin redirects without requesting other origins', async () => {
  for (const destination of ['http://127.0.0.1/private', 'http://169.254.169.254/', 'https://attacker.example/']) {
    let calls = 0;
    await assert.rejects(fetchGeorgia({ now: NOW, fetchResponseFn: async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      return new Response('', { status: 302, headers: { Location: destination } });
    } }), /publisher origin/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(fetchGeorgia({ now: NOW, fetchResponseFn: async () => {
    calls++;
    return new Response('', { status: 302, headers: { Location: '?loop=1' } });
  } }), /redirect limit/);
  assert.equal(calls, 4);
  const transport = sessionTransport(armeniaList, armenia());
  const result = await fetchArmenia({ now: NOW, fetchResponseFn: async (url, options) => {
    if (new URL(url).pathname.endsWith('changeLanguage.do')) {
      assert.equal(options.redirect, 'manual');
      return new Response('', { status: 302, headers: { Location: '/epps/english.do' } });
    }
    if (new URL(url).pathname.endsWith('english.do')) return new Response('<html lang="en"></html>');
    return transport.fetchResponseFn(url, options);
  } });
  assert.equal(result.records.length, 1);
});

test('the seed transport exposes redirects only to explicit manual callers', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response('', { status: 302, headers: { Location: '/home' } });
  });
  const response = await seeder.fetchResponse('https://www.armeps.am/epps/changeLanguage.do', { redirect: 'manual', maxRetries: 0 });
  assert.equal(response.status, 302);
});

test('Georgia excludes later-stage and cancelled notices and rejects incomplete detail responses', async () => {
  for (const status of ['Cancelled', 'Contract awarded', 'Bidding completed']) {
    const result = await fetchGeorgia({ now: NOW, ...sessionTransport(georgiaList, georgia({ 'Procurement proceeding status': status })) });
    assert.deepEqual(result.records, []);
  }
  await assert.rejects(fetchGeorgia({ now: NOW, ...sessionTransport(georgiaList, georgia({ 'Deadline for bid submission': '10.11.2026' })) }));
  await assert.rejects(fetchGeorgia({ now: NOW, ...sessionTransport(georgiaList, '<html>Login</html>') }));
});

test('Armenia requests the submission-stage search and keeps absent estimated value absent', async () => {
  const transport = sessionTransport(armeniaList, armenia());
  const result = await fetchArmenia({ now: NOW, ...transport });
  assert.equal(transport.requests.length, 4);
  const search = transport.requests[2];
  assert.equal(search.options.method, 'POST');
  assert.equal(new URLSearchParams(search.options.body).get('status'), 'cft.status.tender.submission');
  assert.equal(result.records[0].deadline, '2026-11-10T06:00:00.000Z');
  assert.equal(result.records[0].money, undefined);
  assert.equal(result.records[0].countryCode, 'AM');
  assert.deepEqual(result.records[0].categoryCodes, ['45200000']);
});

test('Armenia rejects ignored active filters and incomplete deadlines and excludes awarded notices', async () => {
  await assert.rejects(fetchArmenia({ now: NOW, ...sessionTransport(armeniaList.replace('cft.status.tender.submission', 'cft.status.award'), armenia()) }));
  await assert.rejects(fetchArmenia({ now: NOW, ...sessionTransport(armeniaList, armenia({ 'Time-limit for receipt of tenders or requests to participate': '' })) }));
  const result = await fetchArmenia({ now: NOW, ...sessionTransport(armeniaList, armenia({ 'Date of Awarding': '31/10/2026 12:00' })) });
  assert.deepEqual(result.records, []);
});

test('new portals accept verified empty lists, reject shells and track their own freshness', async () => {
  const emptyEpads = '<th>Procurement Title</th><tbody class="table-border-bottom-0">No procurements found</tbody>';
  const cases = [
    ['pakistan-epads', fetchPakistanEpads, emptyEpads],
    ['georgia-spa', fetchGeorgia, '<table id="list_apps_by_subject"></table>0 Record(s)'],
    ['armenia-armeps', fetchArmenia, 'Search results CfT Title:<input name="status" value="cft.status.tender.submission">0 results in total'],
  ];
  for (const [source, fetchSource, list] of cases) {
    const result = await fetchSource({ now: NOW, fetchTextFn: async () => list, ...sessionTransport(list, '') });
    assert.deepEqual(result.records, []);
    assert.equal(result.status.state, 'ok');
    assert.equal(tracksTenderFreshness(source), true);
    assert.equal(safeOfficialUrl('https://attacker.example/tender', source), '');
    await assert.rejects(fetchSource({ now: NOW, fetchTextFn: async () => '<html>Login</html>', ...sessionTransport('<html>Login</html>', '') }));
  }
});

test('session requests preserve source receipts without persisting cookies or query keys', async () => {
  const receipt = createTenderReceipt(NOW);
  const transport = sessionTransport(georgiaList, georgia());
  await observeTenderSource('georgia-spa', fetchGeorgia, { now: NOW,
    fetchResponseFn: (url, options) => observeTenderRequest(url, options, transport.fetchResponseFn),
  }, receipt);
  assert.equal(receipt.sources[0].requestCount, 3);
  assert.ok(receipt.sources[0].requests.every((request) => request.phase === 'complete'));
  assert.doesNotMatch(JSON.stringify(receipt), /anonymous|abc123|Cookie/);
});

test('PPRA projects its organization from the matching expandable row for EPADS deduplication', async () => {
  const html = `<tr class="cb-rt-main"><td><button data-id="1"></button></td>
    <td data-label="Tender Details"><strong>Cloud platform</strong></td><td data-label="Status">Published</td>
    <td data-label="Closing">Nov 10, 2026 10:30 AM</td><td data-label="Actions"><a href="/public/tenders/tender-details/TS1">View</a></td></tr>
    <tr class="cb-rt-detail" id="cb-rt-detail-1"><td><span>Organization</span><span><strong><i></i>Public Agency</strong><small>private-contact</small></span></td></tr>`;
  const result = await fetchPakistan({ now: NOW, fetchTextFn: async () => html });
  assert.equal(result.records[0].buyer, 'Public Agency');
  assert.doesNotMatch(JSON.stringify(result), /private-contact/);
});

const ALBANIA_HEADER = 'Autoriteti_kontraktues,Numri_i_references,Objekti_i_prokurimit,Lloji_i_procedures,Tipi_i_kontrates,Lloji_i_marreveshjes_kuader,Fondi_limit,Data_e_publikimit,Data_e_hapjes,Data_e_mbylljes,Anulluar,Arsyeja_e_anullimit,Pezulluar,Fituesi,NIPT_i_fituesit,Vlera_e_fituesit,Vlera_e_fituesit_ne_lidhjen_e_kontrates,Lidhja_e_kontrates_me_TVSH,Numri_i_ofertave_te_dorezuara,Numri_i_ofertave_te_kualifikuara,Kodet_CPV';
const albaniaRow = (overrides = {}) => {
  const row = { Autoriteti_kontraktues: 'Operatori i Sistemit te Transmetimit OST', Numri_i_references: 'REF-06784-10-29-2026',
    Objekti_i_prokurimit: '"Ndërtimi i nënstacionit të ri 220/110 kV Traktora, faza e dytë"', Lloji_i_procedures: 'Open INT',
    Tipi_i_kontrates: 'Works', Lloji_i_marreveshjes_kuader: '', Fondi_limit: '"744,983,908.00"', Data_e_publikimit: '30.10.2026',
    Data_e_hapjes: '30.10.2026', Data_e_mbylljes: '03.12.2026', Anulluar: 'Jo', Arsyeja_e_anullimit: '', Pezulluar: 'Jo', Fituesi: '',
    NIPT_i_fituesit: '', Vlera_e_fituesit: '', Vlera_e_fituesit_ne_lidhjen_e_kontrates: '', Lidhja_e_kontrates_me_TVSH: 'Jo',
    Numri_i_ofertave_te_dorezuara: '', Numri_i_ofertave_te_kualifikuara: '', Kodet_CPV: '" 45232221-7 Nënstacion transformator, 09100000-0 Karburante"', ...overrides };
  return Object.values(row).join(',');
};
const albaniaCsv = (...rowsCsv) => `\uFEFF${[ALBANIA_HEADER, ...rowsCsv].join('\r\n')}\r\n`;
const dominican = (overrides = {}) => ({ codigo_proceso: 'EDENORTE-CCC-PEIN-2026-0031', unidad_compra: 'Empresa de Distribución Eléctrica del Norte',
  modalidad: 'Comparación de Precios', titulo: 'Rehabilitación de redes de distribución', descripcion: 'Rehabilitación de redes de distribución en Santiago',
  estado_proceso: 'Proceso publicado', divisa: 'DOP', monto_estimado: 5775550.44, fecha_publicacion: '2026-10-30T18:00:03.12Z',
  fecha_fin_recepcion_ofertas: '2026-11-06T09:00:00Z', objeto_proceso: 'Obras', numero_proveedores_notificados: '14276',
  url: 'https://comunidad.comprasdominicana.gob.do//Public/Tendering/OpportunityDetail/Index?noticeUID=DO1.NTC.1793560', ...overrides });
const malaysiaCard = ({ id = '832780', invited = '03/11/2026', closing = '24/11/2026', price = 'RM 1,800,000.00', codes = '050101, 220601', title = 'TAWARAN BAGI PERKHIDMATAN NAIK TARAF PERKAKASAN &amp; PERISIAN' } = {}) => `
  <div x-data="{ selected: false, open: true }" class="card"><button x-on:click="selected = !selected; $dispatch('select-procurement', { id: ${id} })"></button>
  <div class="mx-4"> Tarikh Pelawaan: ${invited} </div><div><span class="font-bold">No. Tender</span>: T/1503/11/2026(7) </div>
  <div class="uppercase"><a href="https://myprocurement.treasury.gov.my/advertisements/tender/40bd270a9c31949e9484f194c3dbbf19">${title}</a></div>
  <div class="w-full sm:w-1/3 font-bold align-top">Kementerian:</div><div class="w-full sm:w-2/3 uppercase">KEMENTERIAN PENDIDIKAN TINGGI</div>
  <div class="w-full sm:w-1/3 font-bold align-top">Agensi:</div><div class="w-full sm:w-2/3 uppercase">PUSAT PERUBATAN UNIVERSITI MALAYA (PPUM)</div>
  <div class="w-full sm:w-1/3 font-bold align-top">Kategori Perolehan:</div><div class="w-full sm:w-2/3 uppercase">Perkhidmatan Bukan Perunding</div>
  <div class="w-full sm:w-1/3 font-bold align-top">Kod Bidang:</div><div class="w-full sm:w-2/3 uppercase">${codes}</div>
  <div class="w-full sm:w-1/3 font-bold align-top">Tarikh Tutup Pelawaan:</div><div class="w-full sm:w-2/3 uppercase">${closing}</div>
  <div class="w-full sm:w-1/3 font-bold align-top">Harga Indikatif Jabatan:</div><div class="w-full sm:w-2/3 uppercase">${price}</div></div>`;
const malaysia = (cards = [malaysiaCard()], total = cards.length) => ({ html: `<div>${cards.join('')}</div>`, truncated: false, total, page: 1, lastPage: 1 });

test('Albania reads the current-year CSV export and keeps only uncancelled procedures still open', async () => {
  const requests = [];
  const result = await fetchAlbania({ now: NOW, fetchTextFn: async (url, options) => {
    requests.push({ url, options });
    return albaniaCsv(albaniaRow(), albaniaRow({ Numri_i_references: 'REF-00001-10-29-2026', Anulluar: 'Po' }),
      albaniaRow({ Numri_i_references: 'REF-00002-10-29-2026', Pezulluar: 'Po' }),
      albaniaRow({ Numri_i_references: 'REF-00003-10-29-2026', Fituesi: 'WINNER SHPK', NIPT_i_fituesit: 'K73527402G' }),
      albaniaRow({ Numri_i_references: 'REF-00004-10-29-2026', Data_e_mbylljes: '' }),
      albaniaRow({ Numri_i_references: 'REF-00005-10-29-2026', Data_e_mbylljes: '01.11.2026' }),
      albaniaRow({ Numri_i_references: 'REF-00006-10-29-2026', Fondi_limit: '' }),
      albaniaRow({ Numri_i_references: 'REF-00007-10-29-2026', Fondi_limit: '0.00' }));
  } });
  assert.deepEqual(requests.map(({ url }) => url), ['https://www.app.gov.al/GetData/ExportDocument?year=2026']);
  assert.equal(requests[0].options.timeoutMs, 70_000);
  assert.equal(requests[0].options.maxRetries, 0);
  assert.deepEqual(result.records.map((record) => record.sourceNoticeId), ['REF-06784-10-29-2026', 'REF-00006-10-29-2026', 'REF-00007-10-29-2026']);
  const [record, unpriced, zeroFund] = result.records;
  assert.equal(record.countryCode, 'AL');
  assert.equal(record.title, 'Ndërtimi i nënstacionit të ri 220/110 kV Traktora, faza e dytë');
  assert.equal(record.buyer, 'Operatori i Sistemit te Transmetimit OST');
  assert.equal(record.deadline, '2026-12-02T23:00:00.000Z');
  assert.equal(record.publishedAt, '2026-10-29T23:00:00.000Z');
  assert.deepEqual(record.money, { amount: 744983908, currency: 'ALL' });
  assert.deepEqual(record.categoryCodes, ['45232221', '09100000']);
  assert.equal(record.officialUrl, 'https://www.app.gov.al/eksportimi-i-procedurave-te-publikuara/');
  assert.equal(unpriced.money, undefined);
  assert.equal(zeroFund.money, undefined);
  assert.doesNotMatch(JSON.stringify(result), /WINNER SHPK|K73527402G/);
});

test('Albania also reads the previous year through March and rejects header drift or malformed rows', async () => {
  for (const [when, expectedYears] of [['2027-01-05', ['2026', '2027']], ['2027-03-31', ['2026', '2027']], ['2027-04-01', ['2027']]]) {
    const years = [];
    const result = await fetchAlbania({ now: Date.parse(`${when}T12:00:00Z`), fetchTextFn: async (url) => {
      years.push(new URL(url).searchParams.get('year'));
      return albaniaCsv(albaniaRow({ Data_e_mbylljes: '20.04.2027' }));
    } });
    assert.deepEqual(years.sort(), expectedYears, when);
    assert.equal(result.records.length, 1, when);
  }
  await assert.rejects(fetchAlbania({ now: NOW, fetchTextFn: async () => albaniaCsv(albaniaRow()).replace('Data_e_mbylljes', 'Data_mbylljes') }));
  await assert.rejects(fetchAlbania({ now: NOW, fetchTextFn: async () => albaniaCsv(albaniaRow({ Numri_i_references: 'not-a-ref' })) }));
  await assert.rejects(fetchAlbania({ now: NOW, fetchTextFn: async () => albaniaCsv(albaniaRow({ Data_e_mbylljes: '2026-12-03' })) }));
  await assert.rejects(fetchAlbania({ now: NOW, fetchTextFn: async () => albaniaCsv(albaniaRow({ Fondi_limit: 'n/a' })) }));
  await assert.rejects(fetchAlbania({ now: NOW, fetchTextFn: async () => '<html>Login</html>' }));
});

test('Dominican Republic pages the newest processes and keeps only published ones with an official link', async () => {
  const pages = [];
  const result = await fetchDominicanRepublic({ now: NOW, fetchJsonFn: async (url) => {
    const target = new URL(url);
    pages.push(target.searchParams.get('page'));
    assert.equal(target.searchParams.get('limit'), '200');
    return { code: 200, hasError: false, payload: { content: [dominican(),
      dominican({ codigo_proceso: 'X-2026-0002', estado_proceso: 'Proceso adjudicado y celebrado' }),
      dominican({ codigo_proceso: 'X-2026-0003', estado_proceso: 'Cancelado' }),
      dominican({ codigo_proceso: 'X-2026-0004', fecha_fin_recepcion_ofertas: '2026-10-31T09:00:00Z' })] } };
  } });
  assert.deepEqual(pages, ['1']);
  assert.equal(result.records.length, 1);
  const [record] = result.records;
  assert.equal(record.countryCode, 'DO');
  assert.equal(record.buyer, 'Empresa de Distribución Eléctrica del Norte');
  assert.equal(record.deadline, '2026-11-06T09:00:00.000Z');
  assert.equal(record.publishedAt, '2026-10-30T18:00:03.120Z');
  assert.deepEqual(record.money, { amount: 5775550.44, currency: 'DOP' });
  assert.equal(record.noticeType, 'Comparación de Precios');
  assert.equal(record.officialUrl, 'https://comunidad.comprasdominicana.gob.do//Public/Tendering/OpportunityDetail/Index?noticeUID=DO1.NTC.1793560');
  assert.doesNotMatch(JSON.stringify(result), /14276/);
});

test('Dominican Republic reads a second full page only while the open sample is short and rejects drift', async () => {
  let calls = 0;
  const full = Array.from({ length: 200 }, (_, index) => dominican({ codigo_proceso: `X-2026-${index}`,
    estado_proceso: index % 4 ? 'Proceso con etapa cerrada' : 'Proceso publicado' }));
  const result = await fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => {
    calls++;
    return { hasError: false, payload: { content: calls === 1 ? full : [dominican({ codigo_proceso: 'LAST' })] } };
  } });
  assert.equal(calls, 2);
  assert.equal(result.records.length, 51);
  assert.equal(result.records.at(-1).sourceNoticeId, 'LAST');
  calls = 0;
  const saturated = await fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => {
    calls++;
    return { hasError: false, payload: { content: full.map((row) => ({ ...row, estado_proceso: 'Proceso publicado' })) } };
  } });
  assert.equal(calls, 1);
  assert.equal(saturated.records.length, 100);
  await assert.rejects(fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => ({ hasError: true, payload: { content: [] } }) }));
  // A page of published processes whose deadlines already passed must not stop the read.
  calls = 0;
  const expired = Array.from({ length: 200 }, (_, index) => dominican({ codigo_proceso: `OLD-${index}`, fecha_fin_recepcion_ofertas: '2026-10-01T09:00:00Z' }));
  const second = await fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => {
    calls++;
    return { hasError: false, payload: { content: calls === 1 ? expired : [dominican({ codigo_proceso: 'LATE-OPEN' })] } };
  } });
  assert.equal(calls, 2);
  assert.deepEqual(second.records.map((record) => record.sourceNoticeId), ['LATE-OPEN']);
  // Awarded rows missing a title are skipped, not treated as a malformed page.
  const awarded = await fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => ({ hasError: false, payload: { content: [
    dominican({ codigo_proceso: 'AWARDED', estado_proceso: 'Proceso adjudicado y celebrado', titulo: '', fecha_publicacion: null }), dominican()] } }) });
  assert.deepEqual(awarded.records.map((record) => record.sourceNoticeId), ['EDENORTE-CCC-PEIN-2026-0031']);
  await assert.rejects(fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => ({ hasError: false, payload: { content: [dominican({ estado_proceso: '' })] } }) }));
  // Repeated rows of one process count once, so page two is still read.
  calls = 0;
  const repeated = Array.from({ length: 200 }, () => dominican({ codigo_proceso: 'SAME' }));
  const distinct = await fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => {
    calls++;
    return { hasError: false, payload: { content: calls === 1 ? repeated : [dominican({ codigo_proceso: 'OTHER' })] } };
  } });
  assert.equal(calls, 2);
  assert.deepEqual(distinct.records.map((record) => record.sourceNoticeId), ['SAME', 'OTHER']);
  // An expired published row with an empty title is skipped before field validation.
  const staleTitle = await fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => ({ hasError: false, payload: { content: [
    dominican({ codigo_proceso: 'STALE', titulo: '', fecha_fin_recepcion_ofertas: '2026-10-01T09:00:00Z' }), dominican()] } }) });
  assert.deepEqual(staleTitle.records.map((record) => record.sourceNoticeId), ['EDENORTE-CCC-PEIN-2026-0031']);
  await assert.rejects(fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => ({ hasError: false, payload: { content: [dominican({ fecha_fin_recepcion_ofertas: '' })] } }) }));
  await assert.rejects(fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => ({ hasError: false, payload: { content: [dominican({ url: 'https://attacker.example/notice' })] } }) }));
  await assert.rejects(fetchDominicanRepublic({ now: NOW, fetchJsonFn: async () => ({ hasError: false, payload: { content: [dominican({ titulo: '' })] } }) }));
});

test('Malaysia parses the JSON-wrapped advert cards without a session cookie or CSRF token', async () => {
  let request;
  const result = await fetchMalaysia({ now: NOW, fetchJsonFn: async (url, options) => {
    request = { url: new URL(url), options };
    return malaysia([malaysiaCard(), malaysiaCard({ id: '832771', price: 'Tiada Maklumat', codes: '050301', closing: '01/11/2026' })]);
  } });
  assert.equal(request.url.pathname, '/procurements/fetch');
  assert.equal(request.url.searchParams.get('category'), 'tender');
  assert.equal(request.url.searchParams.get('itemsPerPage'), '100');
  assert.equal(request.options.headers, undefined);
  assert.equal(result.records.length, 1);
  const [record] = result.records;
  assert.equal(record.countryCode, 'MY');
  assert.equal(record.title, 'TAWARAN BAGI PERKHIDMATAN NAIK TARAF PERKAKASAN & PERISIAN');
  assert.equal(record.buyer, 'PUSAT PERUBATAN UNIVERSITI MALAYA (PPUM)');
  assert.equal(record.noticeType, 'KEMENTERIAN PENDIDIKAN TINGGI');
  assert.equal(record.description, 'No. Tender: T/1503/11/2026(7)');
  assert.equal(record.deadline, '2026-11-23T16:00:00.000Z');
  assert.equal(record.publishedAt, '2026-11-02T16:00:00.000Z');
  assert.deepEqual(record.money, { amount: 1800000, currency: 'MYR' });
  assert.deepEqual(record.categoryCodes, ['050101', '220601']);
  assert.equal(record.officialUrl, 'https://myprocurement.treasury.gov.my/advertisements/tender/40bd270a9c31949e9484f194c3dbbf19');
});

test('Malaysia rejects shells, cards without a closing date and totals that do not match an empty page', async () => {
  await assert.rejects(fetchMalaysia({ now: NOW, fetchJsonFn: async () => ({ html: '<html>Login</html>', total: 967, page: 1, lastPage: 10 }) }), /missing tender cards/);
  // Fewer rendered cards than the publisher's own total is a partial page, not a smaller catalogue.
  await assert.rejects(fetchMalaysia({ now: NOW, fetchJsonFn: async () => malaysia([malaysiaCard()], 967) }), /missing tender cards/);
  await assert.rejects(fetchMalaysia({ now: NOW, fetchJsonFn: async () => malaysia([malaysiaCard(), malaysiaCard({ id: '1' })], 1) }), /missing tender cards/);
  const small = await fetchMalaysia({ now: NOW, fetchJsonFn: async () => malaysia([malaysiaCard(), malaysiaCard({ id: '832771' })], 2) });
  assert.equal(small.records.length, 2);
  await assert.rejects(fetchMalaysia({ now: NOW, fetchJsonFn: async () => '<html>Login</html>' }));
  await assert.rejects(fetchMalaysia({ now: NOW, fetchJsonFn: async () => malaysia([malaysiaCard({ closing: '24 Nov 2026' })]) }));
  await assert.rejects(fetchMalaysia({ now: NOW, fetchJsonFn: async () => malaysia([malaysiaCard().replace('Tarikh Tutup Pelawaan:', 'Tarikh Tutup:')]) }));
  await assert.rejects(fetchMalaysia({ now: NOW, fetchJsonFn: async () => malaysia([malaysiaCard().replace(/<a href="[^"]+">/, '<a href="https://attacker.example/t">')]) }));
});

test('the batch-3 portals accept verified empty results, reject shells and track their own freshness', async () => {
  const cases = [
    ['albania-app', fetchAlbania, { fetchTextFn: async () => albaniaCsv() }, { fetchTextFn: async () => '<html>Login</html>' }],
    ['dominican-republic-dgcp', fetchDominicanRepublic, { fetchJsonFn: async () => ({ hasError: false, payload: { content: [] } }) }, { fetchJsonFn: async () => ({ data: [] }) }],
    ['malaysia-myprocurement', fetchMalaysia, { fetchJsonFn: async () => malaysia([]) }, { fetchJsonFn: async () => ({ html: '<html>Login</html>' }) }],
  ];
  for (const [source, fetchSource, empty, shell] of cases) {
    const result = await fetchSource({ now: NOW, ...empty });
    assert.deepEqual(result.records, [], source);
    assert.equal(result.status.state, 'ok', source);
    assert.equal(tracksTenderFreshness(source), true, source);
    assert.equal(safeOfficialUrl('https://attacker.example/tender', source), '', source);
    await assert.rejects(fetchSource({ now: NOW, ...shell }), undefined, source);
  }
});
