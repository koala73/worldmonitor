import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOdpQuery,
  fetchAllPatents,
  fetchCategoryPatents,
  mapPatentApplication,
} from '../scripts/_defense-patents-source.mjs';
import { validateDefensePatents } from '../scripts/seed-defense-patents.mjs';

const H04B = { code: 'H04B', desc: 'Transmission / Communications' };

function odpRecord({
  applicationNumberText = '19123456',
  applicant = 'Raytheon Company',
  cpc = ['H04B   7/18513', 'H04W  64/00'],
  filingDate = '2026-03-05',
  publicationDate = '2026-07-09',
  publicationNumber = 'US20260197796A1',
  title = 'SATELLITE COMMUNICATION METHOD AND APPARATUS',
} = {}) {
  return {
    applicationNumberText,
    applicationMetaData: {
      applicantBag: [{ applicantNameText: applicant }],
      cpcClassificationBag: cpc,
      earliestPublicationDate: publicationDate,
      earliestPublicationNumber: publicationNumber,
      filingDate,
      firstApplicantName: applicant,
      inventionTitle: title,
    },
  };
}

describe('USPTO ODP defense-patent source', () => {
  it('builds a fielded CPC-prefix and assignee-prefix query', () => {
    const query = buildOdpQuery('H04B');

    assert.match(query, /^applicationMetaData\.cpcClassificationBag:H04B\* AND \(/);
    assert.match(query, /applicationMetaData\.firstApplicantName:Raytheon\*/);
    assert.match(query, /applicationMetaData\.firstApplicantName:Lockheed\*/);
    assert.match(query, / OR /);
    assert.doesNotMatch(query, /_begins|_text_phrase/);
  });

  it('maps ODP application metadata to the existing panel contract', () => {
    assert.deepEqual(mapPatentApplication(odpRecord(), H04B), {
      patentId: 'US20260197796A1',
      title: 'SATELLITE COMMUNICATION METHOD AND APPARATUS',
      date: '2026-03-05',
      assignee: 'Raytheon Company',
      cpcCode: 'H04B',
      cpcDesc: H04B.desc,
      abstract: '',
      url: 'https://patents.google.com/patent/US20260197796A1',
    });
  });

  it('falls back to filing/application data when a publication is not available', () => {
    const mapped = mapPatentApplication(odpRecord({
      applicationNumberText: '19999999',
      publicationDate: null,
      publicationNumber: null,
    }), H04B);

    assert.equal(mapped.patentId, '19999999');
    assert.equal(mapped.date, '2026-03-05');
    assert.equal(
      mapped.url,
      'https://data.uspto.gov/patent-file-wrapper/search/details/19999999/application-data',
    );
  });

  it('sends the API key only in the ODP header and maps the response', async () => {
    let captured;
    const patents = await fetchCategoryPatents(H04B, {
      apiKey: 'test-key',
      fetchFn: async (url, init) => {
        captured = { url: new URL(url), init };
        return new Response(JSON.stringify({ patentFileWrapperDataBag: [odpRecord()] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    assert.equal(captured.url.origin, 'https://api.uspto.gov');
    assert.equal(captured.url.pathname, '/api/v1/patent/applications/search');
    assert.equal(captured.url.searchParams.get('limit'), '20');
    assert.equal(captured.url.searchParams.get('sort'), 'applicationMetaData.filingDate desc');
    assert.equal(captured.url.searchParams.has('api_key'), false);
    assert.equal(captured.init.headers['X-API-KEY'], 'test-key');
    assert.equal(patents.length, 1);
  });

  it('fails closed before making a request when USPTO_API_KEY is missing', async () => {
    let called = false;
    await assert.rejects(
      fetchCategoryPatents(H04B, {
        apiKey: '',
        fetchFn: async () => {
          called = true;
          return new Response('{}');
        },
      }),
      (err) => {
        assert.match(err.message, /USPTO_API_KEY is required/);
        assert.equal(err.nonRetryable, true);
        return true;
      },
    );
    assert.equal(called, false);
  });

  it('treats ODP 404 as an empty category result', async () => {
    const patents = await fetchCategoryPatents(H04B, {
      apiKey: 'test-key',
      fetchFn: async () => new Response('not found', { status: 404 }),
    });
    assert.deepEqual(patents, []);
  });

  it('throws non-retryable on ODP auth failures', async () => {
    await assert.rejects(
      fetchCategoryPatents(H04B, {
        apiKey: 'bad-key',
        fetchFn: async () => new Response('unauthorized', { status: 401 }),
      }),
      (err) => {
        assert.match(err.message, /USPTO ODP HTTP 401/);
        assert.equal(err.status, 401);
        assert.equal(err.nonRetryable, true);
        return true;
      },
    );
  });

  it('throws on other non-OK ODP responses', async () => {
    await assert.rejects(
      fetchCategoryPatents(H04B, {
        apiKey: 'test-key',
        fetchFn: async () => new Response('boom', { status: 500 }),
      }),
      /USPTO ODP HTTP 500/,
    );
  });

  it('keeps successful categories, deduplicates IDs, and sorts newest first', async () => {
    const categories = [H04B, { code: 'H01L', desc: 'Semiconductor devices' }, { code: 'F42B', desc: 'Ammunition / Explosives' }];
    const duplicate = { patentId: 'US1', title: 'one', date: '2026-01-01', assignee: 'A', cpcCode: 'H04B', cpcDesc: '', abstract: '', url: '' };
    const newest = { ...duplicate, patentId: 'US2', date: '2026-02-01' };

    const result = await fetchAllPatents({
      apiKey: 'test-key',
      categories,
      delayMs: 0,
      fetchCategory: async (category) => {
        if (category.code === 'H01L') throw new Error('upstream unavailable');
        return category.code === 'H04B' ? [duplicate] : [newest, duplicate];
      },
      logger: { log() {}, warn() {} },
    });

    assert.deepEqual(result.patents.map((patent) => patent.patentId), ['US2', 'US1']);
    assert.equal(result.total, 2);
    assert.match(result.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('deduplicates identifier variants by application and keeps the preferred publication ID', async () => {
    const applicationOnly = mapPatentApplication(odpRecord({
      applicationNumberText: '19/999,999',
      publicationNumber: null,
    }), H04B);
    const published = mapPatentApplication(odpRecord({
      applicationNumberText: '19999999',
      publicationNumber: '20269999999A1',
    }), { code: 'F42B', desc: 'Ammunition / Explosives' });

    const result = await fetchAllPatents({
      apiKey: 'test-key',
      categories: [H04B, { code: 'F42B', desc: 'Ammunition / Explosives' }],
      delayMs: 0,
      fetchCategory: async (category) => category.code === 'H04B'
        ? [applicationOnly]
        : [published],
      logger: { log() {}, warn() {} },
    });

    assert.equal(result.total, 1);
    assert.equal(result.patents[0].patentId, 'US20269999999A1');
    assert.equal(result.patents[0].url, 'https://patents.google.com/patent/US20269999999A1');
    assert.deepEqual(Object.keys(result.patents[0]), [
      'patentId',
      'title',
      'date',
      'assignee',
      'cpcCode',
      'cpcDesc',
      'abstract',
      'url',
    ]);
  });

  it('hard-fails when every category throws so runSeed takes FETCH FAILED', async () => {
    await assert.rejects(
      fetchAllPatents({
        apiKey: 'test-key',
        categories: [H04B, { code: 'H01L', desc: 'Semiconductor devices' }],
        delayMs: 0,
        fetchCategory: async () => { throw new Error('upstream unavailable'); },
        logger: { log() {}, warn() {} },
      }),
      /all 2 CPC categories failed/,
    );
  });

  it('aborts remaining categories on auth failure instead of soft-empty RETRY', async () => {
    let calls = 0;
    await assert.rejects(
      fetchAllPatents({
        apiKey: 'bad-key',
        categories: [H04B, { code: 'H01L', desc: 'Semiconductor devices' }],
        delayMs: 0,
        fetchCategory: async () => {
          calls += 1;
          const err = new Error('USPTO ODP HTTP 403');
          err.status = 403;
          err.nonRetryable = true;
          throw err;
        },
        logger: { log() {}, warn() {} },
      }),
      /USPTO ODP HTTP 403/,
    );
    assert.equal(calls, 1);
  });

  it('keeps empty-but-successful category results invalid for the seed contract', () => {
    assert.equal(validateDefensePatents({ patents: [], total: 0 }), false);
    assert.equal(validateDefensePatents({ patents: [{ patentId: 'US1' }] }), true);
  });
});

describe('defense-patents deployment wiring', () => {
  it('runs weekly inside the existing static-reference bundle', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', 'scripts', 'seed-bundle-static-ref.mjs'), 'utf8');

    assert.match(source, /label:\s*'Defense-Patents'/);
    assert.match(source, /script:\s*'seed-defense-patents\.mjs'/);
    assert.match(source, /seedMetaKey:\s*'military:defense-patents'/);
    assert.match(source, /canonicalKey:\s*'patents:defense:latest'/);
    assert.match(source, /intervalMs:\s*WEEK/);
    assert.match(source, /requiredEnv:\s*\['USPTO_API_KEY'\]/);

    const registry = JSON.parse(readFileSync(join(here, '..', 'scripts', 'railway-services.json'), 'utf8'));
    const service = registry.find((entry) => entry.service === 'seed-bundle-static-ref');
    assert.deepEqual(service?.requiredEnv, ['USPTO_API_KEY']);
  });

  it('keeps the empty abstract compatibility contract explicit in generated API docs', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, '..');
    const proto = readFileSync(join(root, 'proto/worldmonitor/military/v1/list_defense_patents.proto'), 'utf8');
    const openapi = JSON.parse(readFileSync(join(root, 'docs/api/MilitaryService.openapi.json'), 'utf8'));
    const abstractSchema = openapi.components.schemas.DefensePatentFiling.properties.abstract;
    const responseExample = openapi.paths['/api/military/v1/list-defense-patents']
      .get.responses['200'].content['application/json'].example;

    assert.match(proto, /Always empty because[\s\S]*string abstract = 7/);
    assert.match(abstractSchema.description, /Always empty because/);
    assert.equal(responseExample.patents[0].abstract, '');
  });

  it('does not attribute any app locale to the retired PatentsView source', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const localeDir = join(here, '..', 'src', 'locales');
    const localeFiles = readdirSync(localeDir).filter((file) => file.endsWith('.json'));

    for (const file of localeFiles) {
      assert.doesNotMatch(readFileSync(join(localeDir, file), 'utf8'), /PatentsView/i, file);
    }
  });
});
