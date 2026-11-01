import { XMLParser } from 'fast-xml-parser';
import { decodeHtmlEntities } from './_html-entities.mjs';
import { recordTenderBucket, readTenderBody } from './_global-tender-receipts.mjs';
import { dedupeTenders, isOpenOpportunity, normalizePublicTender, safeOfficialUrl } from './_global-tenders.mjs';

const DAY = 86_400_000;
const MAX_RECORDS = 100;
const MAX_DETAILS = 20;
const text = (value) => typeof value === 'string' ? value.trim() : '';
const isoDay = (now) => new Date(now).toISOString().slice(0, 10);

function rows(value, field) {
  if (!Array.isArray(value)) throw new Error(`Procurement response missing ${field}`);
  return value;
}

function requireRow(valid, source) {
  if (!valid) throw new Error(`${source} response contains malformed notices`);
}

function reader(fetchFn, timeoutMs = 15_000) {
  const expiresAt = Date.now() + 75_000;
  return (url, options = {}) => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) throw new Error('Procurement source exceeded its 75s request budget');
    return fetchFn(url, { maxRetries: 0, retry429: false, ...options, timeoutMs: Math.min(options.timeoutMs ?? timeoutMs, remaining) });
  };
}

function finish(source, records, now) {
  const open = dedupeTenders(records).filter((record) => isOpenOpportunity(record, now)).slice(0, MAX_RECORDS);
  const fetchedAt = new Date(now).toISOString();
  return { records: open, status: { source, state: 'ok', recordCount: open.length, fetchedAt,
    lastSuccessfulAt: fetchedAt, stale: false } };
}

function localDate(value, timeZone) {
  const raw = text(value).replace(' ', 'T');
  if (!raw) return '';
  if (/(Z|[+-]\d{2}:\d{2})$/.test(raw)) return raw;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (!match) throw new Error('Procurement response contains an invalid local timestamp');
  const parts = match.slice(1).map((part) => Number(part || 0));
  const utc = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  const checked = new Date(utc);
  if (checked.getUTCFullYear() !== parts[0] || checked.getUTCMonth() + 1 !== parts[1]
    || checked.getUTCDate() !== parts[2] || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) {
    throw new Error('Procurement response contains an invalid local timestamp');
  }
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let adjusted = utc;
  for (let iteration = 0; iteration < 2; iteration++) {
    const zoned = Object.fromEntries(formatter.formatToParts(adjusted).map(({ type, value: part }) => [type, Number(part)]));
    adjusted += utc - Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  }
  return new Date(adjusted).toISOString();
}

function urlWithParams(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

function ocdsRecords(releases, { source, countryCode, region, noticeUrl }) {
  const latest = new Map();
  for (const release of releases) {
    requireRow(text(release?.ocid) && Number.isFinite(Date.parse(release?.date)), source);
    const previous = latest.get(release.ocid);
    if (!previous || Date.parse(release.date) >= Date.parse(previous.date)) latest.set(release.ocid, release);
  }
  return [...latest.values()].flatMap((release) => {
    const tender = release.tender;
    if (tender?.status && tender.status !== 'active') return [];
    if (!tender?.status && (release.awards?.length || release.contracts?.length)) return [];
    requireRow(text(tender?.title) && text(String(tender?.id ?? '')), source);
    const lots = Array.isArray(tender.lots) && tender.lots.length ? tender.lots : [null];
    return lots.filter((lot) => !lot?.status || lot.status === 'active').map((lot) => normalizePublicTender({
      source, sourceNoticeId: `${release.ocid}${lot ? `:${lot.id}` : ''}`, countryCode, region,
      officialUrl: noticeUrl(release), title: text(lot?.title) || tender.title,
      description: text(lot?.description) || tender.description, buyer: text(release.buyer?.name) || tender.procuringEntity?.name,
      publishedAt: release.date, updatedAt: release.date, deadline: lot?.tenderPeriod?.endDate || tender.tenderPeriod?.endDate,
      status: 'open', noticeType: Array.isArray(release.tag) ? release.tag.join(', ') : '',
      moneyAmount: (lot?.value || tender.value)?.amount, currency: (lot?.value || tender.value)?.currency,
      categoryCodes: [tender.classification?.id, ...(tender.items || []).map((item) => item?.classification?.id)],
      sectors: tender.mainProcurementCategory,
    }));
  });
}

async function detailsInBatches(items, readDetail) {
  const results = [];
  for (let offset = 0; offset < Math.min(items.length, MAX_DETAILS); offset += 4) {
    const settled = await Promise.allSettled(items.slice(offset, offset + 4).map(readDetail));
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    results.push(...settled.map(result => result.value));
  }
  return results.flat();
}

export async function fetchColombia({ now = Date.now(), fetchJsonFn } = {}) {
  const source = 'colombia-secop';
  const read = reader(fetchJsonFn);
  const payload = rows(await read(urlWithParams('https://www.datos.gov.co/resource/p6dx-8zbt.json', {
    $limit: MAX_RECORDS, $order: 'fecha_de_recepcion_de ASC',
    $where: `fecha_de_recepcion_de > '${new Date(now - 5 * 3_600_000).toISOString().slice(0, 19)}' AND estado_del_procedimiento = 'Publicado'`,
    $select: 'distinct id_del_proceso,nombre_del_procedimiento,descripci_n_del_procedimiento,entidad,fecha_de_publicacion_del,fecha_de_ultima_publicaci,fecha_de_recepcion_de,urlproceso,precio_base,codigo_principal_de_categoria,estado_del_procedimiento',
  })), 'processes');
  const records = payload.map((raw) => {
    requireRow(text(raw?.id_del_proceso) && text(raw?.nombre_del_procedimiento) && text(raw?.fecha_de_recepcion_de), source);
    requireRow(safeOfficialUrl(raw.urlproceso?.url, source), source);
    return normalizePublicTender({ source, sourceNoticeId: raw.id_del_proceso, officialUrl: raw.urlproceso.url,
      countryCode: 'CO', region: 'South America', title: raw.nombre_del_procedimiento,
      description: raw.descripci_n_del_procedimiento, buyer: raw.entidad,
      publishedAt: localDate(raw.fecha_de_publicacion_del, 'America/Bogota'),
      updatedAt: localDate(raw.fecha_de_ultima_publicaci, 'America/Bogota'),
      deadline: localDate(raw.fecha_de_recepcion_de, 'America/Bogota'),
      status: raw.estado_del_procedimiento === 'Publicado' ? 'open' : 'closed',
      moneyAmount: raw.precio_base, currency: 'COP', categoryCodes: raw.codigo_principal_de_categoria });
  });
  return finish(source, records, now);
}

export async function fetchKenya({ now = Date.now(), fetchJsonFn } = {}) {
  const source = 'kenya-ppip';
  const read = reader(fetchJsonFn);
  const payload = await read(urlWithParams('https://tenders.go.ke/api/active-tenders', { perpage: MAX_RECORDS, page: 1 }));
  const records = rows(payload?.data, 'data').map((raw) => {
    requireRow(Number.isSafeInteger(raw?.id) && text(raw?.title) && text(raw?.close_at), source);
    return normalizePublicTender({ source, sourceNoticeId: String(raw.id), officialUrl: `https://tenders.go.ke/tenders/${raw.id}`,
      countryCode: 'KE', region: 'Africa', title: raw.title, buyer: raw.pe?.name,
      publishedAt: localDate(raw.published_at, 'Africa/Nairobi'), updatedAt: raw.updated_at,
      deadline: localDate(raw.close_at, 'Africa/Nairobi'),
      status: raw.status_id === 1 && raw.published === 1 && raw.terminated === 0 ? 'open' : 'closed',
      sectors: raw.procurement_category?.title, noticeType: raw.procurement_method?.title });
  });
  return finish(source, records, now);
}

export async function fetchSouthAfrica({ now = Date.now(), fetchJsonFn } = {}) {
  const source = 'south-africa-etenders';
  const read = reader(fetchJsonFn);
  const payload = await read(urlWithParams('https://ocds-api.etenders.gov.za/api/OCDSReleases', {
    PageNumber: 1, PageSize: 20, dateFrom: isoDay(now - DAY), dateTo: isoDay(now),
  }));
  return finish(source, ocdsRecords(rows(payload?.releases, 'releases'), { source, countryCode: 'ZA', region: 'Africa',
    noticeUrl: (release) => `https://www.etenders.gov.za/home/AdvertDetails/${encodeURIComponent(release.tender.id)}` }), now);
}

export async function fetchChile({ now = Date.now(), fetchJsonFn } = {}) {
  const source = 'chile-mercado-publico';
  const read = reader(fetchJsonFn);
  const month = new Date(now);
  const url = `https://api.mercadopublico.cl/APISOCDS/OCDS/listaOCDSAgnoMes/${month.getUTCFullYear()}/${month.getUTCMonth() + 1}/0/${MAX_DETAILS}`;
  const payload = await read(url);
  const releases = await detailsInBatches(rows(payload?.data, 'data'), async (row) => {
    requireRow(/^ocds-70d2nz-[\w-]+$/.test(text(row?.ocid)), source);
    const id = row.ocid.slice('ocds-70d2nz-'.length);
    const detail = await read(`https://api.mercadopublico.cl/APISOCDS/OCDS/tender/${encodeURIComponent(id)}`);
    return rows(detail?.releases, 'releases');
  });
  return finish(source, ocdsRecords(releases, { source, countryCode: 'CL', region: 'South America',
    noticeUrl: (release) => `https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=${encodeURIComponent(release.tender.id)}` }), now);
}

export async function fetchBrazil({ now = Date.now(), fetchJsonFn } = {}) {
  const source = 'brazil-pncp';
  const read = reader(fetchJsonFn, 30_000);
  const payload = await read(urlWithParams('https://pncp.gov.br/api/consulta/v1/contratacoes/proposta', {
    dataFinal: isoDay(now + 30 * DAY).replaceAll('-', ''), pagina: 1, tamanhoPagina: 10,
  }));
  const records = rows(payload?.data, 'data').map((raw) => {
    requireRow(text(raw?.numeroControlePNCP) && text(raw?.objetoCompra) && text(raw?.dataEncerramentoProposta)
      && /^\d{14}$/.test(text(raw?.orgaoEntidade?.cnpj)) && Number.isSafeInteger(raw?.anoCompra)
      && Number.isSafeInteger(raw?.sequencialCompra), source);
    return normalizePublicTender({ source, sourceNoticeId: raw.numeroControlePNCP,
      officialUrl: `https://pncp.gov.br/app/editais/${raw.orgaoEntidade.cnpj}/${raw.anoCompra}/${raw.sequencialCompra}`,
      countryCode: 'BR', region: 'South America', title: raw.objetoCompra, buyer: raw.orgaoEntidade.razaoSocial,
      publishedAt: localDate(raw.dataPublicacaoPncp, 'America/Sao_Paulo'),
      updatedAt: localDate(raw.dataAtualizacaoGlobal, 'America/Sao_Paulo'),
      deadline: localDate(raw.dataEncerramentoProposta, 'America/Sao_Paulo'),
      status: raw.situacaoCompraId === 1 ? 'open' : 'closed', noticeType: raw.modalidadeNome,
      moneyAmount: raw.valorTotalEstimado, currency: 'BRL' });
  });
  return finish(source, records, now);
}

export async function fetchUkraine({ now = Date.now(), fetchJsonFn } = {}) {
  const source = 'ukraine-prozorro';
  const read = reader(fetchJsonFn);
  const payload = await read(urlWithParams('https://public-api.prozorro.gov.ua/api/2.5/tenders', { descending: 1, limit: MAX_DETAILS }));
  const records = await detailsInBatches(rows(payload?.data, 'data'), async (row) => {
    requireRow(/^[\w-]+$/.test(text(row?.id)), source);
    const detail = await read(`https://public-api.prozorro.gov.ua/api/2.5/tenders/${encodeURIComponent(row.id)}`);
    const raw = detail?.data;
    requireRow(raw?.id === row.id && text(raw?.title) && text(raw?.status), source);
    if (raw.status !== 'active.tendering') return [];
    return [normalizePublicTender({ source, sourceNoticeId: raw.id,
      officialUrl: `https://prozorro.gov.ua/tender/${encodeURIComponent(text(raw.tenderID) || raw.id)}`,
      countryCode: 'UA', region: 'Europe', title: raw.title, description: raw.description, buyer: raw.procuringEntity?.name,
      publishedAt: raw.dateCreated, updatedAt: raw.dateModified, deadline: raw.tenderPeriod?.endDate,
      status: 'open', moneyAmount: raw.value?.amount, currency: raw.value?.currency,
      categoryCodes: (raw.items || []).map((item) => item?.classification?.id), sectors: raw.mainProcurementCategory })];
  });
  return finish(source, records, now);
}

export async function fetchBulgaria({ now = Date.now(), fetchJsonFn, fetchTextFn } = {}) {
  const source = 'bulgaria-eop';
  const read = reader(fetchJsonFn);
  const readText = reader(fetchTextFn);
  // Day D's bucket appears around 06:00 UTC on D+1 and answers 403 until then,
  // so the early-UTC runs read the day before instead of failing.
  const bucket = { requestedDate: isoDay(now - DAY), attemptedDates: [isoDay(now - DAY)], selectedDate: null, fallbackStatus: null };
  recordTenderBucket(bucket);
  let base = `https://storage.eop.bg/open-data-${bucket.requestedDate}/`;
  let listingXml;
  try {
    listingXml = await readText(base);
  } catch (error) {
    if (![403, 404].includes(error?.status)) throw error;
    bucket.fallbackStatus = error.status;
    bucket.attemptedDates.push(isoDay(now - 2 * DAY));
    recordTenderBucket(bucket);
    base = `https://storage.eop.bg/open-data-${isoDay(now - 2 * DAY)}/`;
    listingXml = await readText(base);
  }
  const listing = new XMLParser().parse(listingXml);
  const contents = listing?.ListBucketResult?.Contents;
  const files = contents ? (Array.isArray(contents) ? contents : [contents]) : [];
  const key = files.map((entry) => entry.Key).find((name) => typeof name === 'string' && name.includes('OCDS') && name.endsWith('.json'));
  requireRow(key, source);
  const payload = await read(`${base}${encodeURIComponent(key)}`);
  const result = finish(source, ocdsRecords(rows(payload?.releases, 'releases'), { source, countryCode: 'BG', region: 'Europe',
    noticeUrl: (release) => `https://app.eop.bg/today/${encodeURIComponent(release.tender.id)}` }), now);
  bucket.selectedDate = bucket.attemptedDates.at(-1);
  recordTenderBucket(bucket);
  return result;
}

export async function fetchLatvia({ now = Date.now(), fetchJsonFn } = {}) {
  const source = 'latvia-iub';
  const read = reader(fetchJsonFn);
  const [year, month, day] = isoDay(now - DAY).split('-');
  const payload = rows(await read(`https://open.iub.gov.lv/data/notice/${year}/${month}/${day}-${month}-${year}.json`), 'notices');
  const records = payload.flatMap((raw) => {
    requireRow(text(raw?.identifier) && text(raw?.name) && text(raw?.formType), source);
    if (raw.formType !== 'competition') return [];
    return rows(raw.lots, 'lots').map((lot) => {
      const process = lot?.tenderingProcess;
      const date = text(process?.deadlineReceiptTendersEndDate).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      const time = text(process?.deadlineReceiptTendersEndTime);
      if (!date || !/^\d{2}:\d{2}$/.test(time)) return null;
      return normalizePublicTender({ source, sourceNoticeId: `${raw.identifier}:${lot.id}`,
        officialUrl: raw.tenderingProcess?.documentsURL, countryCode: 'LV', region: 'Europe',
        title: text(lot.name) || raw.name, description: lot.description, buyer: raw.organizationData?.name,
        deadline: localDate(`${date[3]}-${date[2]}-${date[1]}T${time}:00`, 'Europe/Riga'),
        status: 'open', noticeType: raw.noticeType, categoryCodes: raw.cpvType, sectors: raw.procurementProject?.mainNatureType });
    });
  });
  return finish(source, records, now);
}

export async function fetchPoland({ now = Date.now(), fetchJsonFn } = {}) {
  const source = 'poland-bzp';
  const read = reader(fetchJsonFn);
  const payload = rows(await read(urlWithParams('https://ezamowienia.gov.pl/mo-board/api/v1/Board/Search', {
    PageSize: MAX_RECORDS, PageNumber: 1, NoticeType: 'ContractNotice',
    PublicationDateFrom: isoDay(now - DAY), PublicationDateTo: isoDay(now),
  })), 'notices');
  const records = payload.map((raw) => {
    requireRow(text(raw?.objectId) && text(raw?.orderObject) && text(raw?.noticeType), source);
    return normalizePublicTender({ source, sourceNoticeId: raw.objectId,
      officialUrl: `https://ezamowienia.gov.pl/mo-board/bzp/notice-details/id/${encodeURIComponent(raw.objectId)}`,
      countryCode: 'PL', region: 'Europe', title: raw.orderObject, buyer: raw.organizationName,
      publishedAt: raw.publicationDate, deadline: raw.submittingOffersDate,
      status: raw.outdated === false && raw.noticeType === 'ContractNotice' ? 'open' : 'closed',
      categoryCodes: text(raw.cpvCode).split(','), sectors: raw.orderType });
  });
  return finish(source, records, now);
}

function htmlText(value) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tableRows(html) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) => ({
    html: row,
    cells: [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(([, cell]) => cell),
  }));
}

function europeanDate(value, separator, timeZone) {
  const escaped = separator === '.' ? '\\.' : separator;
  const match = text(value).match(new RegExp(`^(\\d{2})${escaped}(\\d{2})${escaped}(\\d{4}) (\\d{2}):(\\d{2})$`));
  if (!match) throw new Error('Procurement response missing a complete closing timestamp');
  return localDate(`${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00`, timeZone);
}

function pakistanDate(value) {
  const match = text(value).match(/^(?:[A-Za-z]+, )?([A-Za-z]+) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/);
  const month = match && ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(match[1]) + 1;
  if (!match || !month || Number(match[4]) < 1 || Number(match[4]) > 12) throw new Error('EPADS response contains an invalid closing timestamp');
  const hour = Number(match[4]) % 12 + (match[6] === 'PM' ? 12 : 0);
  return localDate(`${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}T${String(hour).padStart(2, '0')}:${match[5]}:00`, 'Asia/Karachi');
}

function sessionReader(fetchResponseFn) {
  const cookies = new Map();
  let origin;
  const read = reader(fetchResponseFn);
  return async (url, options = {}) => {
    for (let hop = 0; hop <= 3; hop++) {
      const target = new URL(url);
      origin ??= target.origin;
      if (target.origin !== origin) throw new Error('Procurement session cannot change publisher origin');
      const response = await read(target.href, {
        ...options, redirect: 'manual',
        headers: { Accept: 'text/html', ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}), ...options.headers },
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0];
        const equals = pair.indexOf('=');
        if (equals > 0) cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
      }
      const body = await readTenderBody(response, 'text');
      if (![301, 302, 303, 307, 308].includes(response.status)) return body;
      const location = response.headers.get('Location');
      if (!location || hop === 3) throw new Error('Procurement session redirect limit or missing location');
      url = new URL(location, target).href;
      if (response.status === 303 || ([301, 302].includes(response.status) && options.method === 'POST')) {
        options = { ...options, method: 'GET', body: undefined };
      }
    }
  };
}

export async function fetchPakistanEpads({ now = Date.now(), fetchTextFn } = {}) {
  const source = 'pakistan-epads';
  const read = reader((url, options) => fetchTextFn(url, { ...options, redirect: 'error' }));
  const html = await read('https://epads.gov.pk/', { headers: { Accept: 'text/html' } });
  requireRow(/Procurement Title/.test(html) && /table-border-bottom-0/.test(html), source);
  const tenderRows = tableRows(html).filter(({ html: row }) => /\/opportunities\/federal\/procurements\//.test(row));
  if (!tenderRows.length && !/No (?:procurements|records|opportunities) found/i.test(html)) throw new Error('EPADS response missing tender rows');
  const records = await detailsInBatches(tenderRows, async ({ cells }) => {
    const link = cells[1]?.match(/href="(\/opportunities\/federal\/procurements\/(\d+))"/);
    const labels = [...(cells[1] || '').matchAll(/<span\b[^>]*title="([^"]+)"[^>]*>/gi)].map(([, value]) => htmlText(value));
    const dates = htmlText(cells[2] || '').match(/Published On:\s*(.*?)\s*Closing On:\s*(.*)$/);
    requireRow(cells.length === 5 && link && labels.length >= 2 && dates, source);
    const officialUrl = `https://epads.gov.pk${link[1]}`;
    let deadline;
    if (/^(?:\d+[dhms]\s*)+Left$/.test(dates[2])) {
      const detail = await read(officialUrl, { headers: { Accept: 'text/html' } });
      const timestamp = detail.match(/showBiddingTimer\("(\d{10})",\s*"0"\)/)?.[1];
      requireRow(timestamp, source);
      deadline = new Date(Number(timestamp) * 1000).toISOString();
    } else {
      deadline = pakistanDate(dates[2]);
    }
    return [normalizePublicTender({ source, sourceNoticeId: link[2], officialUrl,
      countryCode: 'PK', region: 'Asia', title: labels[0], buyer: labels[1],
      publishedAt: pakistanDate(dates[1]), deadline, status: 'open', noticeType: htmlText(cells[3]) })];
  });
  return finish(source, records, now);
}

export async function fetchGeorgia({ now = Date.now(), fetchResponseFn } = {}) {
  const source = 'georgia-spa';
  const read = sessionReader(fetchResponseFn);
  const base = 'https://tenders.procurement.gov.ge/public/';
  await read(`${base}?lang=en`);
  const html = await read(`${base}library/controller.php?action=search_app&search=1&app_status=10&app_t=0`);
  requireRow(/id="list_apps_by_subject"/.test(html), source);
  const notices = [...html.matchAll(/ShowApp\((\d+),'[^']*',\d+,'([a-f0-9]+)'\)/g)];
  if (!notices.length && !/0\s+Record\(s\)/.test(html)) throw new Error('Georgia response missing tender rows');
  const records = await detailsInBatches(notices, async ([, id, key]) => {
    const detail = await read(`${base}library/controller.php?action=app_main&app_id=${id}&key=${key}`);
    const fields = Object.fromEntries(tableRows(detail).filter(({ cells }) => cells.length === 2)
      .map(({ cells }) => cells.map(htmlText)));
    requireRow(fields['Announcment number'] && fields['Procurement proceeding status'], source);
    if (!['Tender announced', 'Bidding commenced'].includes(fields['Procurement proceeding status'])) return [];
    const category = fields['Procuring category'];
    const title = detail.match(/<div\b[^>]*class="blabla"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    requireRow(category && fields['Procuring entities'], source);
    const amount = fields['Estimated value of procurement']?.match(/^([\d`.,]+)\s+GEL$/);
    return [normalizePublicTender({ source, sourceNoticeId: fields['Announcment number'],
      officialUrl: `${base}?go=${id}&lang=en`, countryCode: 'GE', region: 'Asia',
      title: title ? htmlText(title) : category, buyer: fields['Procuring entities'],
      publishedAt: europeanDate(fields['Procurement announcment date'], '.', 'Asia/Tbilisi'),
      deadline: europeanDate(fields['Deadline for bid submission'], '.', 'Asia/Tbilisi'), status: 'open',
      noticeType: fields['Procurement type'], categoryCodes: category.match(/\b\d{8}\b/g) || [],
      moneyAmount: amount ? amount[1].replace(/[` ,]/g, '') : undefined, currency: amount ? 'GEL' : '' })];
  });
  return finish(source, records, now);
}

export async function fetchArmenia({ now = Date.now(), fetchResponseFn } = {}) {
  const source = 'armenia-armeps';
  const read = sessionReader(fetchResponseFn);
  const base = 'https://www.armeps.am';
  await read(`${base}/epps/home.do`);
  await read(`${base}/epps/changeLanguage.do?language=en&url=`);
  const html = await read(`${base}/epps/viewCFTSAction.do`, { timeoutMs: 50_000, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ status: 'cft.status.tender.submission', title: '', uniqueId: '', contractAuthority: '', contractType: '', procedure: '' }).toString() });
  requireRow(/Search results/.test(html) && /CfT Title:/.test(html), source);
  requireRow(/name="status"\s+value="cft\.status\.tender\.submission"/.test(html), source);
  const notices = [...html.matchAll(/href="(\/epps\/cft\/prepareViewCfTWS\.do\?resourceId=(\d+))"/g)];
  if (!notices.length && !/0\s+results in total/.test(html)) throw new Error('Armenia response missing tender rows');
  const records = await detailsInBatches(notices.slice(0, 10), async ([, path, id]) => {
    const detail = await read(`${base}${path}`);
    const fields = Object.fromEntries([...detail.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)]
      .map(([, label, value]) => [htmlText(label).replace(/\s*:\s*$/, ''), htmlText(value)]));
    requireRow(fields['CfT Id'] && fields['Title'] && fields['Name of Contracting Authority'], source);
    if (fields['Date of Awarding']) return [];
    const deadline = europeanDate(fields['Time-limit for receipt of tenders or requests to participate'], '/', 'Asia/Yerevan');
    const amount = fields['Estimated value (AMD)'];
    return [normalizePublicTender({ source, sourceNoticeId: id, officialUrl: `${base}${path}`,
      countryCode: 'AM', region: 'Asia', title: fields['Title (EN)'] || fields.Title,
      buyer: fields['Name of Contracting Authority'], publishedAt: europeanDate(fields['Date of Publication/Invitation'], '/', 'Asia/Yerevan'),
      deadline, status: 'open', noticeType: fields.Procedure, categoryCodes: fields['CPV Codes']?.match(/\b\d{8}\b/g) || [],
      moneyAmount: amount && /^[\d,.\s]+$/.test(amount) ? amount.replace(/[,\s]/g, '') : undefined,
      currency: amount ? 'AMD' : '' })];
  });
  return finish(source, records, now);
}

export async function fetchPakistan({ now = Date.now(), fetchTextFn } = {}) {
  const source = 'pakistan-ppra';
  const read = reader(fetchTextFn);
  const html = await read('https://epms.ppra.gov.pk/public/tenders/active-tenders', { headers: { Accept: 'text/html' } });
  const mainRows = [...html.matchAll(/<tr\b[^>]*class="cb-rt-main"[^>]*>([\s\S]*?)<\/tr>/gi)];
  const details = new Map([...html.matchAll(/<tr\b[^>]*id="cb-rt-detail-([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(([, id, row]) => [id, row]));
  if (!mainRows.length) throw new Error('Pakistan response missing tender rows');
  const records = mainRows.slice(0, MAX_RECORDS).map(([, row]) => {
    const cells = Object.fromEntries([...row.matchAll(/<td\b[^>]*data-label="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(([, label, content]) => [label, content]));
    const link = cells.Actions?.match(/href="(\/public\/tenders\/tender-details\/[\w-]+)"/);
    const title = cells['Tender Details']?.match(/<strong>([\s\S]*?)<\/strong>/i);
    const detailId = row.match(/<button\b[^>]*data-id="([^"]+)"/)?.[1];
    const buyer = details.get(detailId)?.match(/>Organization<\/span>\s*<span\b[^>]*>\s*<strong>([\s\S]*?)<\/strong>/i)?.[1];
    const closing = cells.Closing && htmlText(cells.Closing);
    const match = closing?.match(/^([A-Za-z]{3}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/);
    requireRow(link && title && match, source);
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1]) + 1;
    requireRow(month, source);
    const hour = Number(match[4]) % 12 + (match[6] === 'PM' ? 12 : 0);
    return normalizePublicTender({ source, sourceNoticeId: link[1].split('/').pop(),
      officialUrl: `https://epms.ppra.gov.pk${link[1]}`, countryCode: 'PK', region: 'Asia', title: htmlText(title[1]),
      buyer: buyer ? htmlText(buyer) : '',
      deadline: localDate(`${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}T${String(hour).padStart(2, '0')}:${match[5]}:00`, 'Asia/Karachi'),
      status: /Published/.test(htmlText(cells.Status || '')) ? 'open' : 'closed' });
  });
  return finish(source, records, now);
}

export const ADDITIONAL_TENDER_ADAPTERS = [
  ['colombia-secop', fetchColombia], ['kenya-ppip', fetchKenya], ['south-africa-etenders', fetchSouthAfrica],
  ['chile-mercado-publico', fetchChile], ['brazil-pncp', fetchBrazil], ['ukraine-prozorro', fetchUkraine],
  ['bulgaria-eop', fetchBulgaria], ['latvia-iub', fetchLatvia], ['poland-bzp', fetchPoland], ['pakistan-ppra', fetchPakistan],
  ['pakistan-epads', fetchPakistanEpads], ['georgia-spa', fetchGeorgia], ['armenia-armeps', fetchArmenia],
];
