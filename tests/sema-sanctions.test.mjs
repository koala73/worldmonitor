import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SEMA_CACHE_KEY,
  SEMA_EMPTY_ERROR,
  SEMA_HOST,
  SEMA_INGEST_ERROR_CODE,
  SEMA_MAX_BYTES,
  SEMA_SOURCE,
  SEMA_XML_URL,
  SANCTIONS_MAX_CONTENT_AGE_MIN,
  SANCTIONS_SOURCE_VERSION,
  buildSanctionsMergeSnapshot,
  fetchSemaXml,
  ingestSemaEntries,
  mergeSanctionEntries,
  ofacRegistrationToIdentifier,
  parseSemaXml,
  programFromSemaCountry,
  sameSanctionIdentity,
  sanctionsListContentMeta,
  sanctionsSemaHealthMeta,
  semaRecordId,
  isWeakNameToken,
} from '../scripts/_sema-sanctions.mjs';

const fixtureXml = readFileSync(
  new URL('./fixtures/sema-lmes-slice.xml', import.meta.url),
  'utf8',
);
const parseSrc = readFileSync(
  new URL('../scripts/_sema-sanctions.mjs', import.meta.url),
  'utf8',
);
const seedSrc = readFileSync(
  new URL('../scripts/seed-sanctions-pressure.mjs', import.meta.url),
  'utf8',
);
const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const railwaySrc = readFileSync(
  new URL('../scripts/railway-services.json', import.meta.url),
  'utf8',
);
const healthSrc = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
const seedHealthSrc = readFileSync(new URL('../api/seed-health.js', import.meta.url), 'utf8');
const panelSrc = readFileSync(
  new URL('../src/components/SanctionsPressurePanel.ts', import.meta.url),
  'utf8',
);
const localeEn = readFileSync(
  new URL('../src/locales/en.json', import.meta.url),
  'utf8',
);
const serviceSrc = readFileSync(
  new URL('../src/services/sanctions-pressure.ts', import.meta.url),
  'utf8',
);

// Global Affairs Canada renamed every SEMA field tag to a bilingual hyphenated
// form. `<record>` still matches, so parseSemaXml finds 5,690 blocks and returns
// ZERO records — every field reads empty, legalName is blank, and every block is
// dropped. Production reported `SEMA fetch failed: SEMA_EMPTY` on every 6-hourly
// run while OFAC carried the whole list (0 of 20,558 entries from Canada).
//
// Every other fixture in this file uses the OLD tags, which is why the suite
// stayed green while the live parse was dead. These blocks are copied verbatim
// from the live feed on 2026-08-25.
const SEMA_BILINGUAL_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<data-set xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<record>
		<Country-Pays>Belarus / Bélarus</Country-Pays>
		<LastName-NomDeFamille>Atabekov</LastName-NomDeFamille>
		<GivenName-Prenom>Khazalbek Bakhtibekovich</GivenName-Prenom>
		<Schedule-Annexe>1, Part 1</Schedule-Annexe>
		<Item-NumeroDarticle>1</Item-NumeroDarticle>
		<DateOfListing-DateDinscription>2020-09-28</DateOfListing-DateDinscription>
	</record>
	<record>
		<Country-Pays>Russia / Russie</Country-Pays>
		<EntityOrShip-EntiteOuNavire>Balitiyskiy III</EntityOrShip-EntiteOuNavire>
		<TitleOrShipType-TitreOuTypeDeNavire>General Cargo/Multi Purpose | Cargo classique/navire polyvalent</TitleOrShipType-TitreOuTypeDeNavire>
		<ShipIMONumber-NumeroOMIDuNavire>7612448</ShipIMONumber-NumeroOMIDuNavire>
		<Schedule-Annexe>1.1</Schedule-Annexe>
		<Item-NumeroDarticle>1</Item-NumeroDarticle>
		<DateOfListing-DateDinscription>2025-02-21</DateOfListing-DateDinscription>
	</record>
	<record>
		<Country-Pays>Belarus / Bélarus</Country-Pays>
		<EntityOrShip-EntiteOuNavire>Belaeronavigatsia Republican Unitary Air Navigation Services Enterprise</EntityOrShip-EntiteOuNavire>
		<Schedule-Annexe>1, Part 2</Schedule-Annexe>
		<Item-NumeroDarticle>1</Item-NumeroDarticle>
		<DateOfListing-DateDinscription>2021-06-17</DateOfListing-DateDinscription>
	</record>
</data-set>`;

describe('SEMA bilingual field tags (Global Affairs Canada 2026-08 rename)', () => {
  it('parses records whose fields carry the hyphenated bilingual tag names', () => {
    const { records } = parseSemaXml(SEMA_BILINGUAL_XML);
    assert.equal(records.length, 3, 'every block must yield a record, not be dropped for a blank name');
  });

  it('reads each renamed field, not just enough of them to survive', () => {
    // A fix that only mapped Country/LastName/GivenName would satisfy the count
    // assertion above while silently dropping schedule, listing date and IMO.
    const { records } = parseSemaXml(SEMA_BILINGUAL_XML);
    const byName = new Map(records.map((r) => [r.name, r]));

    const person = byName.get('Khazalbek Bakhtibekovich Atabekov');
    assert.ok(person, 'GivenName-Prenom + LastName-NomDeFamille compose the legal name');
    assert.equal(person.entityType, 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL');
    assert.match(person.note, /Schedule 1, Part 1/, 'Schedule-Annexe must be read');
    assert.notEqual(person.effectiveAt, '0', 'DateOfListing-DateDinscription must be read');

    const vessel = byName.get('Balitiyskiy III');
    assert.ok(vessel, 'EntityOrShip-EntiteOuNavire must be read');
    assert.equal(vessel.entityType, 'SANCTIONS_ENTITY_TYPE_VESSEL',
      'ShipIMONumber-NumeroOMIDuNavire must be read, or a vessel is typed as an entity');
    assert.ok(vessel._identifiers.includes('imo:7612448'));
    assert.match(vessel.note, /General Cargo/, 'TitleOrShipType-TitreOuTypeDeNavire must be read');

    const entity = byName.get('Belaeronavigatsia Republican Unitary Air Navigation Services Enterprise');
    assert.ok(entity, 'an entity with no IMO and no person name must still parse');
    assert.equal(entity.entityType, 'SANCTIONS_ENTITY_TYPE_ENTITY');
  });

  it('still parses the pre-rename tags', () => {
    // The rename is upstream and could be reverted or served inconsistently;
    // dropping the old names would trade one outage for another.
    const legacy = '<record><Country>Belarus / Bélarus</Country><LastName>One</LastName>'
      + '<GivenName>Person</GivenName><Schedule>1, Part 1</Schedule><Item>1</Item>'
      + '<DateOfListing>2021-06-17</DateOfListing></record>';
    const { records } = parseSemaXml(legacy);
    assert.equal(records.length, 1);
    assert.equal(records[0].name, 'Person One');
  });
});

describe('SEMA fixture parse', () => {
  it('maps individuals, entities, ships, aliases, IMO, and publication dates', () => {
    const { records, publishedAtMs } = parseSemaXml(fixtureXml);
    assert.equal(records.length, 12);
    assert.ok(records.every((row) => row.sourceLists.includes(SEMA_SOURCE)));

    const person = records.find((row) => row.name === 'Aleksey Oleksin');
    assert.ok(person);
    assert.equal(person.entityType, 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL');
    assert.deepEqual(person._aliases, ['Aliaksei Aleksin']);
    assert.deepEqual(person.countryCodes, []);
    assert.equal(person.programs[0], 'SEMA');
    assert.match(person.note, /Belarus/);
    assert.equal(person._regime, 'Belarus');

    const entity = records.find((row) => /Belaeronavigatsia/.test(row.name));
    assert.ok(entity);
    assert.equal(entity.entityType, 'SANCTIONS_ENTITY_TYPE_ENTITY');

    const ship = records.find((row) => row.name === 'Balitiyskiy III');
    assert.ok(ship);
    assert.equal(ship.entityType, 'SANCTIONS_ENTITY_TYPE_VESSEL');
    assert.ok(ship._identifiers.includes('imo:7612448'));

    const newest = records.find((row) => row.name === 'STREIT Group');
    assert.ok(newest);
    assert.equal(newest._publishedAt, '2026-08-06');
    assert.equal(publishedAtMs, Date.UTC(2026, 7, 6));
    assert.equal(String(newest.effectiveAt), String(Date.UTC(2026, 7, 6)));

    const tarasevich = records.find((row) => /TARASEVICH/.test(row.name));
    const mashadziyeu = records.find((row) => /MASHADZIYEU/.test(row.name));
    assert.ok(tarasevich && mashadziyeu);
    assert.notEqual(tarasevich.id, mashadziyeu.id);
    const jvcfor = records.find((row) => row.programs[0] === 'JVCFOR');
    assert.ok(jvcfor);
    assert.equal(jvcfor.programs.includes('SEMA'), false);
    assert.deepEqual(jvcfor.countryCodes, []);
  });

  it('concatenates the fixture without collapsing TARASEVICH, Alliance, or JVCFOR', () => {
    const { records } = parseSemaXml(fixtureXml);
    const merged = mergeSanctionEntries({ sema: records });
    assert.equal(merged.length, records.length);
    assert.ok(merged.some((row) => /TARASEVICH/.test(row.name)));
    assert.ok(merged.some((row) => /MASHADZIYEU/.test(row.name)));
    assert.ok(merged.some((row) => row.name === 'Alliance'));
    assert.ok(merged.some((row) => row.name === 'AI Alliance Russia'));
    assert.ok(merged.some((row) => row.programs[0] === 'JVCFOR' && !row.programs.includes('SEMA')));
  });
});

describe('SEMA ids include Schedule because Item restarts per part', () => {
  it('puts Schedule in the id and keeps same-Item records distinct', () => {
    const { records } = parseSemaXml(fixtureXml);
    const ids = records.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length);
    const person = records.find((row) => row.name === 'Aleksey Oleksin');
    assert.equal(person.id, 'sema-ca:belarus:1-part-1:56');
    const entity = records.find((row) => /Belaeronavigatsia/.test(row.name));
    assert.equal(entity.id, 'sema-ca:belarus:1-part-2:1');
    const colliding = parseSemaXml(`<?xml version="1.0"?>
<data-set>
<record><Country>Belarus / Bélarus</Country><LastName>One</LastName><GivenName>Person</GivenName><Schedule>1, Part 1</Schedule><Item>1</Item><DateOfListing>2021-06-17</DateOfListing></record>
<record><Country>Belarus / Bélarus</Country><LastName>Two</LastName><GivenName>Person</GivenName><Schedule>1, Part 2</Schedule><Item>1</Item><DateOfListing>2021-06-17</DateOfListing></record>
</data-set>`).records;
    assert.equal(colliding.length, 2);
    assert.equal(colliding[0].id, 'sema-ca:belarus:1-part-1:1');
    assert.equal(colliding[1].id, 'sema-ca:belarus:1-part-2:1');
    assert.notEqual(colliding[0].id, colliding[1].id);
    assert.equal(semaRecordId('Belarus / Bélarus', '1, Part 1', '1'), 'sema-ca:belarus:1-part-1:1');
  });
});

describe('OFAC identifier mapping', () => {
  it('maps IMO and vessel-registration numbers and ignores passports', () => {
    assert.equal(ofacRegistrationToIdentifier('Vessel Registration Identification', 'IMO 7612448'), 'imo:7612448');
    assert.equal(ofacRegistrationToIdentifier('IMO', '7612448'), 'imo:7612448');
    assert.equal(ofacRegistrationToIdentifier('Passport', '7612448'), '');
    assert.equal(ofacRegistrationToIdentifier('', 'IMO 7612448'), 'imo:7612448');
  });

  it('parses OFAC IDRegDocument / Feature IMO into _identifiers instead of leaving them empty', () => {
    assert.match(seedSrc, /IDRegDocument/);
    assert.match(seedSrc, /IDRegistrationNo/);
    assert.match(seedSrc, /ofacRegistrationToIdentifier/);
    assert.match(seedSrc, /_identifiers:\s*party\?\.identifiers/);
    assert.doesNotMatch(seedSrc, /_identifiers:\s*\[\],/);
  });
});

describe('dedup identity is not unique-name', () => {
  it('does not merge the same unique name when identifiers conflict', () => {
    const ofac = {
      id: 'SDN:1',
      name: 'Alpha Corp',
      sourceLists: ['SDN'],
      programs: ['SDN'],
      _aliases: [],
      _identifiers: ['imo:1111111'],
    };
    const sema = {
      id: 'sema-ca:alpha:1',
      name: 'Alpha Corp',
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: [],
      _identifiers: ['imo:2222222'],
    };
    assert.equal(sameSanctionIdentity(ofac, sema), false);
    const merged = mergeSanctionEntries({ ofac: [ofac], sema: [sema] });
    assert.equal(merged.length, 2);
  });

  it('merges different unique names that share an alias', () => {
    const ofac = {
      id: 'SDN:2',
      name: 'Acme Shipping',
      sourceLists: ['SDN'],
      programs: ['SDN'],
      _aliases: ['Acme Ltd'],
      _identifiers: [],
    };
    const sema = {
      id: 'sema-ca:acme:1',
      name: 'ACME LTD',
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: [],
      _identifiers: [],
    };
    assert.equal(sameSanctionIdentity(ofac, sema), true);
    const [row] = mergeSanctionEntries({ ofac: [ofac], sema: [sema] });
    assert.ok(row.sourceLists.includes('SDN'));
    assert.ok(row.sourceLists.includes(SEMA_SOURCE));
    assert.equal(row.id, 'SDN:2');
  });

  it('does not let a single-token alias absorb a distinct designation', () => {
    // Live shape: OFAC's Iranian entity "ALLIANCE" vs SEMA's "AI Alliance Russia"
    // (alias "Alliance"). A bare one-word alias is not identity — merging here
    // DELETED the Canadian designation from a legal list.
    const ofac = {
      id: 'SDN:9',
      name: 'ALLIANCE',
      entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY',
      sourceLists: ['SDN'],
      programs: ['IRAN'],
      countryCodes: ['IR'],
      _aliases: [],
      _identifiers: [],
    };
    const sema = {
      id: 'sema-ca:russia:1-part-2:768',
      name: 'AI Alliance Russia',
      entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY',
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: ['Alliance'],
      _identifiers: [],
    };
    const merged = mergeSanctionEntries({ ofac: [ofac], sema: [sema] });
    assert.equal(merged.length, 2);
    assert.ok(merged.some((row) => row.id === 'sema-ca:russia:1-part-2:768'));
    assert.ok(merged.some((row) => row.id === 'SDN:9'));
  });

  it('does not merge across entity types on a shared name', () => {
    const person = {
      id: 'SDN:10',
      name: 'Neptune Maritime',
      entityType: 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL',
      sourceLists: ['SDN'],
      programs: ['SDN'],
      _aliases: [],
      _identifiers: [],
    };
    const vessel = {
      id: 'sema-ca:neptune:1',
      name: 'Neptune Maritime',
      entityType: 'SANCTIONS_ENTITY_TYPE_VESSEL',
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: [],
      _identifiers: [],
    };
    const merged = mergeSanctionEntries({ ofac: [person], sema: [vessel] });
    assert.equal(merged.length, 2);
  });

  it('keeps an absorbed row traceable by name and id after a legitimate merge', () => {
    const ofac = {
      id: 'SDN:11',
      name: 'Acme Shipping',
      entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY',
      sourceLists: ['SDN'],
      programs: ['SDN'],
      _aliases: ['Acme Ltd'],
      _identifiers: [],
    };
    const sema = {
      id: 'sema-ca:acme:2',
      name: 'ACME LTD',
      entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY',
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: [],
      _identifiers: [],
    };
    const merged = mergeSanctionEntries({ ofac: [ofac], sema: [sema] });
    assert.equal(merged.length, 1);
    const [row] = merged;
    assert.ok(row._aliases.some((alias) => normalizeForAssert(alias) === normalizeForAssert('ACME LTD')));
    assert.ok((row.mergedIds || []).includes('sema-ca:acme:2'));
  });

  it('merges different unique names that share an IMO identifier', () => {
    const ofac = {
      id: 'SDN:3',
      name: 'Vessel Foo',
      sourceLists: ['CONSOLIDATED'],
      programs: ['CONSOLIDATED'],
      entityType: 'SANCTIONS_ENTITY_TYPE_VESSEL',
      _aliases: [],
      _identifiers: ['imo:7612448'],
    };
    const { records } = parseSemaXml(fixtureXml);
    const ship = records.find((row) => row._identifiers.includes('imo:7612448'));
    assert.ok(ship);
    assert.notEqual(normalizeForAssert(ofac.name), normalizeForAssert(ship.name));
    assert.equal(sameSanctionIdentity(ofac, ship), true);
    const merged = mergeSanctionEntries({ ofac: [ofac], eu: [], uk: [], sema: [ship] });
    assert.equal(merged.length, 1);
    assert.ok(merged[0].sourceLists.includes(SEMA_SOURCE));
  });

  it('does not collapse SDN and CONS that share a name; SEMA attaches onto the OFAC concat', () => {
    const sdn = {
      id: 'SDN:1',
      name: 'Alpha Corp',
      sourceLists: ['SDN'],
      programs: ['SDN'],
      _aliases: [],
      _identifiers: [],
    };
    const cons = {
      id: 'CONSOLIDATED:1',
      name: 'Alpha Corp',
      sourceLists: ['CONSOLIDATED'],
      programs: ['CONS'],
      _aliases: [],
      _identifiers: [],
    };
    const ofacOnly = mergeSanctionEntries({ ofac: [sdn, cons] });
    assert.equal(ofacOnly.length, 2, 'SDN and CONS must stay concatenated');
    assert.deepEqual(ofacOnly.map((row) => row.id), ['SDN:1', 'CONSOLIDATED:1']);

    const sema = {
      id: 'sema-ca:alpha:1-part-1:1',
      name: 'Alpha Corp',
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: [],
      _identifiers: [],
    };
    const merged = mergeSanctionEntries({ ofac: [sdn, cons], sema: [sema] });
    assert.equal(merged.length, 2);
    assert.ok(merged[0].sourceLists.includes('SDN'));
    assert.ok(merged[0].sourceLists.includes(SEMA_SOURCE));
    assert.ok(merged[1].sourceLists.includes('CONSOLIDATED'));
    assert.equal(merged[1].sourceLists.includes(SEMA_SOURCE), false);
  });

  it('merges thousands of SEMA-only rows in linear time', () => {
    const sema = Array.from({ length: 6000 }, (_, i) => ({
      id: `sema-ca:x:1:${i}`,
      name: `Entity ${i}`,
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: [`Alias ${i}`],
      _identifiers: i % 10 === 0 ? [`imo:${1000000 + i}`] : [],
    }));
    const t0 = Date.now();
    const merged = mergeSanctionEntries({ sema });
    const ms = Date.now() - t0;
    assert.equal(merged.length, 6000);
    assert.ok(ms < 2000, `expected O(n) merge, took ${ms}ms`);
  });
});

function normalizeForAssert(name) {
  return String(name).toLowerCase();
}

describe('one list failing does not empty the panel', () => {
  it('still publishes OFAC when SEMA is missing', () => {
    const ofac = [{ id: 'SDN:9', name: 'Kept', sourceLists: ['SDN'], programs: ['SDN'], _aliases: [], _identifiers: [] }];
    const merged = mergeSanctionEntries({ ofac, sema: null, eu: undefined, uk: [] });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, 'Kept');
  });

  it('still publishes SEMA when OFAC/EU/UK are missing', () => {
    const { records } = parseSemaXml(fixtureXml);
    const merged = mergeSanctionEntries({ ofac: null, eu: [], uk: undefined, sema: records });
    assert.equal(merged.length, records.length);
    assert.ok(merged.every((row) => row.sourceLists.includes(SEMA_SOURCE)));
  });

  it('seeder catches each list independently and only throws when every list failed', () => {
    assert.match(seedSrc, /SEMA fetch failed/);
    assert.match(seedSrc, /all sanctions lists failed/);
    assert.match(seedSrc, /mergeSanctionEntries/);
    assert.match(seedSrc, /ingestSemaEntries/);
    assert.match(seedSrc, /semaError/);
    assert.match(seedSrc, /sanctionsSemaHealthMeta/);
    const fnStart = seedSrc.indexOf('async function fetchSanctionsPressure()');
    const fnEnd = seedSrc.indexOf('\nfunction validate(');
    const body = seedSrc.slice(fnStart, fnEnd);
    assert.match(body, /try \{/);
    assert.match(body, /semaEntries/);
  });
});

describe('byte cap, allowlist, cache key, UA, redirect', () => {
  it('raises the byte cap above the live 1.7 MB list', () => {
    assert.ok(SEMA_MAX_BYTES >= 1.7 * 1024 * 1024, 'cap must cover the ~1.7MB XML');
    assert.ok(SEMA_MAX_BYTES >= 4 * 1024 * 1024);
    assert.ok(SEMA_MAX_BYTES <= 8 * 1024 * 1024);
    assert.match(parseSrc, /SEMA_MAX_BYTES = 8 \* 1024 \* 1024/);
  });

  it('allowlists www.international.gc.ca and uses the XML URL as the cache key', () => {
    assert.equal(SEMA_HOST, 'www.international.gc.ca');
    assert.equal(SEMA_XML_URL, 'https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml');
    assert.equal(SEMA_CACHE_KEY, SEMA_XML_URL);
    assert.match(seedSrc, /SEMA_CACHE_KEY|SEMA_XML_URL|fetchSemaEntries|ingestSemaEntries/);
  });

  it('rejects untrusted hosts and asks fetch to error on redirects', async () => {
    await assert.rejects(
      () => fetchSemaXml('https://evil.example/sema.xml'),
      /UNTRUSTED_SOURCE_HOST/,
    );
    await assert.rejects(
      () => fetchSemaXml('http://www.international.gc.ca/sema.xml'),
      /UNTRUSTED_SOURCE_HOST/,
    );

    let seen;
    const fetchFn = async (url, opts) => {
      seen = { url, opts };
      return {
        ok: true,
        headers: { get: () => null },
        text: async () => fixtureXml,
      };
    };
    await fetchSemaXml(SEMA_XML_URL, { fetchFn });
    assert.equal(seen.opts.redirect, 'error');
    assert.ok(seen.opts.signal);
    assert.match(seen.opts.headers['User-Agent'], /Mozilla/);
    assert.doesNotMatch(parseSrc, /fetch\.bind\(/);
    assert.doesNotMatch(seedSrc, /fetch\.bind\(/);
  });

  it('enforces the byte ceiling', async () => {
    const fetchFn = async () => ({
      ok: true,
      headers: { get: (name) => (name === 'content-length' ? String(SEMA_MAX_BYTES + 1) : null) },
      body: { cancel: async () => {} },
      text: async () => '<data-set/>',
    });
    await assert.rejects(
      () => fetchSemaXml(SEMA_XML_URL, { fetchFn, maxBytes: SEMA_MAX_BYTES }),
      /RESPONSE_TOO_LARGE/,
    );
  });
});

describe('content-age comes from publication date, not Date.now()/fetchedAt', () => {
  it('uses the XML listing/publication date', () => {
    const { publishedAtMs } = parseSemaXml(fixtureXml);
    const meta = sanctionsListContentMeta({ datasetDate: String(publishedAtMs) }, Date.UTC(2026, 7, 14));
    assert.equal(meta.newestItemAt, Date.UTC(2026, 7, 6));
    assert.equal(meta.oldestItemAt, Date.UTC(2026, 7, 6));
  });

  it('does not read Date.now or fetchedAt as the list age', () => {
    assert.doesNotMatch(parseSrc, /datasetDate:\s*String\(Date\.now\(\)\)/);
    assert.doesNotMatch(parseSrc, /publishedAtMs\s*=\s*Date\.now\(\)/);
    assert.match(seedSrc, /sanctionsListContentMeta/);
    assert.match(seedSrc, /SANCTIONS_MAX_CONTENT_AGE_MIN/);
    assert.equal(SANCTIONS_MAX_CONTENT_AGE_MIN, 30 * 24 * 60);
    const meta = sanctionsListContentMeta({ fetchedAt: String(Date.UTC(2026, 7, 14)), datasetDate: '0' }, Date.UTC(2026, 7, 14));
    assert.equal(meta, null);
  });
});

describe('seeder merge, health, railway, no new surface', () => {
  it('does not import the seeder entrypoint from this test file', () => {
    assert.doesNotMatch(testSrc, /from ['\"]\.\.\/scripts\/seed-sanctions-pressure\.mjs['\"]/);
  });

  it('does not add an ais-relay Canada loop or a new panel/proto', () => {
    assert.doesNotMatch(parseSrc, /ais-relay/);
    assert.doesNotMatch(seedSrc, /ais-relay/);
    assert.doesNotMatch(seedSrc, /SanctionsPressurePanel/);
    assert.doesNotMatch(parseSrc, /proto\/worldmonitor/);
    assert.equal(SANCTIONS_SOURCE_VERSION, 'ofac-sls-advanced-xml+sema-ca-v3');
    assert.match(seedSrc, /sourceVersion:\s*SANCTIONS_SOURCE_VERSION/);
  });

  it('reuses the existing sanctions health probe', () => {
    assert.match(healthSrc, /sanctionsPressure:\s*'sanctions:pressure:v1'/);
    assert.doesNotMatch(healthSrc, /sema-ca:pressure/);
    assert.match(seedHealthSrc, /'sanctions:pressure'/);
  });

  it('extends the sanctions Railway service watchPatterns', () => {
    const registry = JSON.parse(railwaySrc);
    const service = registry.find((entry) => entry.service === 'seed-sanctions-pressure');
    assert.ok(service, 'seed-sanctions-pressure must be registry-managed');
    assert.ok(service.watchPatterns.includes('scripts/seed-sanctions-pressure.mjs'));
    assert.ok(service.watchPatterns.includes('scripts/_sema-sanctions.mjs'));
    assert.ok(service.watchPatterns.includes('scripts/_sanctions-source.mjs'));
  });
});

describe('SEMA does not self-merge', () => {
  it('keeps the live TARASEVICH / MASHADZIYEU pair as two people', () => {
    const { records } = parseSemaXml(`<?xml version="1.0"?>
<data-set>
<record><Country>Belarus / Bélarus</Country><LastName>MASHADZIYEU</LastName><GivenName>Ruslan Khikmetavich</GivenName><Aliases>Ruslan Khikmetavich MASHADZEOU, Ruslan Chikmetovič MAŠADZEV, Mashadiyev Ruslan Khikmetovich, Ruslan Khikmetovich MASHADIYEV, Belarusian: Руслан Хiкметовiч МАШАДЗЕЎ, Russian: Руслан Хикметович МАШАДИЕВ</Aliases><Schedule>1, Part 1</Schedule><Item>99</Item><DateOfListing>2021-06-17</DateOfListing></record>
<record><Country>Belarus / Bélarus</Country><LastName>TARASEVICH</LastName><GivenName>Andrei Romanovich</GivenName><Aliases>Andrei Ramanavich TARASEVICH, Belarusian: Андрэй Раманавiч ТАРАСЕВIЧ, Russian: Андрей Романович ТАРАСЕВИЧ</Aliases><Schedule>1, Part 1</Schedule><Item>103</Item><DateOfListing>2021-06-17</DateOfListing></record>
</data-set>`);
    assert.equal(records.length, 2);
    assert.equal(sameSanctionIdentity(records[0], records[1]), false);
    const merged = mergeSanctionEntries({ sema: records });
    assert.equal(merged.length, 2);
    const names = merged.map((row) => row.name).sort();
    assert.deepEqual(names, ['Andrei Romanovich TARASEVICH', 'Ruslan Khikmetavich MASHADZIYEU']);
  });

  it('does not collapse vessel Alliance into AI Alliance Russia', () => {
    const { records } = parseSemaXml(`<?xml version="1.0"?>
<data-set>
<record><Country>Russia / Russie</Country><EntityOrShip>AI Alliance Russia</EntityOrShip><Aliases>Alliance, Ассоциация "Альянс В Сфере ИИ", Альянс</Aliases><Schedule>1, Part 2</Schedule><Item>768</Item><DateOfListing>2023-01-01</DateOfListing></record>
<record><Country>Russia / Russie</Country><EntityOrShip>Alliance</EntityOrShip><Schedule>1.1</Schedule><Item>257</Item><DateOfListing>2025-02-21</DateOfListing></record>
</data-set>`);
    assert.equal(records.length, 2);
    const merged = mergeSanctionEntries({ sema: records });
    assert.equal(merged.length, 2);
    assert.ok(merged.some((row) => row.name === 'Alliance'));
    assert.ok(merged.some((row) => row.name === 'AI Alliance Russia'));
  });

  it('rejects leftover Latin-i alias crumbs as identity tokens', () => {
    assert.equal(isWeakNameToken('i'), true);
    assert.equal(isWeakNameToken('i i'), true);
    assert.equal(isWeakNameToken('ii'), true);
    assert.equal(isWeakNameToken('alliance'), false);
    const left = { name: 'Person A', _aliases: ['I.I.', 'Руслан Хiкметовiч'], _identifiers: [] };
    const right = { name: 'Person B', _aliases: ['Андрэй Раманавiч'], _identifiers: [] };
    assert.equal(sameSanctionIdentity(left, right), false);
  });

  // Previously asserted that the bare alias "Alliance" attached the SEMA row onto
  // the OFAC row. That IS the false-merge: it deleted "AI Alliance Russia" as a
  // findable designation. A one-word alias is no longer identity, so all three
  // designations now survive and none of them silently absorbs another.
  it('keeps all three Alliance designations distinct; a one-word alias never attaches', () => {
    const ofac = {
      id: 'SDN:alliance',
      name: 'Alliance',
      sourceLists: ['SDN'],
      programs: ['SDN'],
      _aliases: [],
      _identifiers: [],
    };
    const first = {
      id: 'sema-ca:russia:1-part-2:768',
      name: 'AI Alliance Russia',
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: ['Alliance'],
      _identifiers: [],
    };
    const second = {
      id: 'sema-ca:russia:1-1:257',
      name: 'Alliance',
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: [],
      _identifiers: [],
    };
    const merged = mergeSanctionEntries({ ofac: [ofac], sema: [first, second] });
    assert.equal(merged.length, 3);
    for (const id of ['SDN:alliance', 'sema-ca:russia:1-part-2:768', 'sema-ca:russia:1-1:257']) {
      assert.ok(merged.some((row) => row.id === id), `${id} must still be findable`);
    }
    const ofacRow = merged.find((row) => row.id === 'SDN:alliance');
    assert.equal(ofacRow.sourceLists.includes(SEMA_SOURCE), false);
    const semaRows = merged.filter((row) => row.sourceLists.includes(SEMA_SOURCE));
    assert.equal(semaRows.length, 2);
    assert.ok(semaRows.every((row) => row.sourceLists.includes('SDN') === false));
  });
});

describe('SEMA Country is regulation, not nationality', () => {
  it('leaves countryCodes empty and stores the regime on the note/program', () => {
    const { records } = parseSemaXml(fixtureXml);
    assert.ok(records.every((row) => row.countryCodes.length === 0));
    assert.ok(records.every((row) => row.countryNames.length === 0));
    const russia = records.find((row) => row.name === 'STREIT Group');
    assert.equal(russia._regime, 'Russia');
    assert.match(russia.note, /^Russia/);
    assert.equal(russia.programs[0], 'SEMA');
  });

  it('tags JVCFOR, Hamas, and Settler as their own programs, not SEMA', () => {
    assert.equal(programFromSemaCountry('Justice for Victims of Corrupt Foreign Officials Regulations (JVCFOR) / Règlement'), 'JVCFOR');
    assert.equal(programFromSemaCountry('Hamas Terrorist Attacks / Attaques terroristes du Hamas'), 'HAMAS');
    assert.equal(programFromSemaCountry('Extremist Settler Violence / Violence extrémiste des colons'), 'SETTLER');
    assert.equal(programFromSemaCountry('Russia / Russie'), 'SEMA');
    const { records } = parseSemaXml(`<?xml version="1.0"?>
<data-set>
<record><Country>Justice for Victims of Corrupt Foreign Officials Regulations (JVCFOR) / Règlement relatif à la justice pour les victimes de dirigeants étrangers corrompus (RJVDEC)</Country><LastName>Example</LastName><GivenName>Official</GivenName><Schedule>1</Schedule><Item>1</Item><DateOfListing>2022-01-01</DateOfListing></record>
<record><Country>Hamas Terrorist Attacks / Attaques terroristes du Hamas</Country><EntityOrShip>Example Hamas Entity</EntityOrShip><Schedule>1</Schedule><Item>1</Item><DateOfListing>2024-01-01</DateOfListing></record>
<record><Country>Extremist Settler Violence / Violence extrémiste des colons</Country><LastName>Settler</LastName><GivenName>Example</GivenName><Schedule>1</Schedule><Item>1</Item><DateOfListing>2024-01-01</DateOfListing></record>
</data-set>`);
    assert.deepEqual(records.map((row) => row.programs[0]), ['JVCFOR', 'HAMAS', 'SETTLER']);
    assert.ok(records.every((row) => !row.programs.includes('SEMA')));
    assert.ok(records.every((row) => row.countryCodes.length === 0));
  });
});

describe('UI and seed surface SEMA beside OFAC', () => {
  it('publishes semaCount on the seed payload', () => {
    assert.match(seedSrc, /semaCount/);
    assert.match(seedSrc, /semaCount: semaEntries\.length|const semaCount = semaEntries\.length/);
  });

  it('shows semaCount and a GAC SEMA source in the panel', () => {
    assert.match(panelSrc, /semaCount/);
    assert.match(panelSrc, /semaError/);
    assert.match(panelSrc, /summary\.sema/);
    assert.match(panelSrc, /sourceLists/);
    assert.match(localeEn, /Source: OFAC · GAC SEMA/);
    assert.match(localeEn, /"sema": "SEMA"/);
    assert.match(serviceSrc, /semaCount/);
    assert.match(serviceSrc, /semaError/);
  });
});

describe('SEMA failure stays visible when OFAC succeeds', () => {
  const ofac = [{
    id: 'SDN:9',
    name: 'Kept',
    sourceLists: ['SDN'],
    programs: ['SDN'],
    _aliases: [],
    _identifiers: [],
  }];

  it('does not mask SEMA throw, 404, or empty-fail behind an OFAC-only snapshot', async () => {
    const thrown = await ingestSemaEntries({
      fetchFn: async () => { throw new Error('ECONNRESET'); },
    });
    assert.match(thrown.error, /ECONNRESET/);
    assert.equal(thrown.records.length, 0);
    const snapThrow = buildSanctionsMergeSnapshot({ ofac, sema: thrown.records, semaError: thrown.error });
    assert.equal(snapThrow.totalCount, 1);
    assert.equal(snapThrow.entries[0].name, 'Kept');
    assert.equal(snapThrow.semaCount, 0);
    assert.ok(snapThrow.semaError);
    assert.equal(snapThrow.sourceState, 'error');
    assert.equal(snapThrow.errorCode, SEMA_INGEST_ERROR_CODE);
    assert.deepEqual(sanctionsSemaHealthMeta(thrown.error), {
      sourceState: 'error',
      errorCode: SEMA_INGEST_ERROR_CODE,
    });

    const notFound = await ingestSemaEntries({
      fetchFn: async () => ({ ok: false, status: 404 }),
    });
    assert.match(notFound.error, /HTTP 404/);
    const snap404 = buildSanctionsMergeSnapshot({ ofac, sema: notFound.records, semaError: notFound.error });
    assert.equal(snap404.totalCount, 1);
    assert.equal(snap404.semaCount, 0);
    assert.match(snap404.semaError, /HTTP 404/);
    assert.equal(snap404.sourceState, 'error');

    const empty = await ingestSemaEntries({
      fetchFn: async () => ({
        ok: true,
        headers: { get: () => null },
        text: async () => '<data-set></data-set>',
      }),
    });
    assert.equal(empty.error, SEMA_EMPTY_ERROR);
    assert.equal(empty.records.length, 0);
    const snapEmpty = buildSanctionsMergeSnapshot({ ofac, sema: empty.records, semaError: empty.error });
    assert.equal(snapEmpty.totalCount, 1);
    assert.equal(snapEmpty.semaCount, 0);
    assert.equal(snapEmpty.semaError, SEMA_EMPTY_ERROR);
    assert.equal(snapEmpty.sourceState, 'error');
    assert.notEqual(snapEmpty.sourceState, 'ok');

    const healthy = await ingestSemaEntries({
      fetchFn: async () => ({
        ok: true,
        headers: { get: () => null },
        text: async () => fixtureXml,
      }),
    });
    assert.equal(healthy.error, null);
    assert.ok(healthy.records.length > 0);
    const snapOk = buildSanctionsMergeSnapshot({ ofac, sema: healthy.records, semaError: healthy.error });
    assert.equal(snapOk.sourceState, 'ok');
    assert.equal(snapOk.semaError, null);
    assert.ok(snapOk.semaCount > 0);
    assert.equal(sanctionsSemaHealthMeta(null), null);

    assert.match(seedSrc, /ingestSemaEntries/);
    assert.match(seedSrc, /semaError/);
    assert.match(seedSrc, /sanctionsSemaHealthMeta/);
    assert.match(seedSrc, /freshnessMetaPatch/);
    assert.match(healthSrc, /sourceDegraded/);
    assert.match(seedHealthSrc, /sourceError/);
    assert.match(panelSrc, /semaError/);
  });
});

describe('SEMA outage must not delete the last-good Canadian cohort', () => {
  // The failure this closes: a SEMA fetch error left semaEntries empty while the
  // OFAC half still succeeded, so the run COMPLETED and overwrote the canonical
  // key with an OFAC-only merge. Every Canadian designation vanished from the
  // published list until GAC recovered. preserveKeys does not help — it is the
  // whole-seed-failure cohort, and this run does not fail.
  //
  // sanctionsSemaHealthMeta already made the failure visible; visibility does not
  // put the entries back. These pin the carry-forward itself.

  it('re-reads the canonical key and keeps the sema-ca entries when SEMA errors', () => {
    // The read has to be of the CANONICAL key, not the state key: the state key
    // holds ids for isNew diffing, not the entries themselves.
    const carryBlock = /if \(semaError\) \{[\s\S]*?\} else \{/.exec(seedSrc);
    assert.ok(carryBlock, 'the SEMA error branch must exist');
    assert.match(carryBlock[0], /verifySeedKey\(CANONICAL_KEY\)/);
    assert.match(carryBlock[0], /sourceLists[\s\S]*?includes\(SEMA_SOURCE\)/);
    assert.match(carryBlock[0], /semaEntries = carried/);
  });

  it('filters the carried cohort by sourceLists, the field that survives publication', () => {
    // _regime is stripped by the public transform, so it cannot identify a
    // carried entry. sourceLists is not stripped — depending on _regime here
    // would silently carry nothing.
    assert.match(seedSrc, /const \{ _aliases, _identifiers, _publishedAt, _regime, \.\.\.publicEntry \}/);
    assert.equal(
      /verifySeedKey\(CANONICAL_KEY\)[\s\S]{0,400}?_regime/.test(seedSrc),
      false,
      'carry-forward must not filter on a field the public transform removes',
    );
  });

  it('keeps the failure loud while carrying data forward', () => {
    // Carrying last-good must not launder the outage into a healthy read. The
    // afterPublish patch still reports sourceState error for the same run.
    assert.match(seedSrc, /sanctionsSemaHealthMeta\(data\.semaError\)/);
    assert.match(seedSrc, /freshnessMetaPatch: semaHealth/);
    const meta = sanctionsSemaHealthMeta('GAC 503');
    assert.equal(meta.sourceState, 'error');
  });

  it('does not carry anything forward on a healthy SEMA run', () => {
    // The carry-forward lives inside the error branch only. If it ran
    // unconditionally, a recovered SEMA list would be unioned with stale
    // entries and delistings would never take effect.
    const elseBlock = /\} else \{\s*console\.log\(`  SEMA:/.exec(seedSrc);
    assert.ok(elseBlock, 'the success branch must remain a plain log');
    assert.equal(
      /else \{[\s\S]{0,200}?verifySeedKey\(CANONICAL_KEY\)/.test(seedSrc),
      false,
      'a successful SEMA fetch must replace the cohort, not union with last-good',
    );
  });
});
