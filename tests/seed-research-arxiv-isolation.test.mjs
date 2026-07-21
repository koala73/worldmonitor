import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchArxivPapers,
  fetchArxivCategory,
  ARXIV_TTL,
  RESEARCH_MAX_STALE_MIN,
} from '../scripts/seed-research.mjs';

// #5409: seed-research crashed (exit 1, ZERO_YIELD) and left `researchArxivHnTrending` EMPTY in
// prod because a single arXiv timeout zeroed the primary record set (cs.AI drives declareRecords).
// The last-good key had expired (TTL ≈ cron), so the runner's zero-yield RETRY path could not
// extend it → exit 1 instead of a graceful STALE_SEED. Three fixes are pinned here:
//   (1) per-category isolation — a cs.CL/cs.CR blip must not discard a good cs.AI;
//   (2) retry — a transient primary timeout is retried once before yielding zero;
//   (3) ARXIV_TTL must outlive the health staleness gate so a late tick degrades, not empties.
//
// Importing the seeder must NOT run it: the module guards its top-level runSeed on
// `process.argv[1].endsWith('seed-research.mjs')`. If that guard regresses, this import hangs/exits
// and the whole file fails — which is itself the signal.

const noSleep = async () => {};

const okResp = (xml) => ({ ok: true, status: 200, text: async () => xml });

// Minimal arXiv Atom payload with one entry.
const arxivXml = (id, title) =>
  `<feed><entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title>` +
  '<summary>s</summary><published>2026-07-20T00:00:00Z</published>' +
  `<link rel="alternate" href="https://arxiv.org/abs/${id}"/>` +
  '<author><name>A</name></author><category term="cs.AI"/></entry></feed>';

const catOf = (url) => url.match(/cat:(cs\.\w+)/)[1];

test('a cs.CL timeout does NOT discard a good cs.AI (per-category isolation, #5409)', async () => {
  const fetchFn = async (url) => {
    if (url.includes('cat:cs.CL')) throw new Error('The operation was aborted due to timeout');
    const cat = catOf(url);
    return okResp(arxivXml(`${cat}-1`, `${cat} paper`));
  };

  const results = await fetchArxivPapers({ fetchFn, retries: 0, sleepFn: noSleep });

  // The primary key (cs.AI) must survive the sibling category's failure — this is the exact
  // record set whose absence drove declareRecords to 0 → EMPTY in prod.
  assert.ok(results['research:arxiv:v1:cs.AI::50'], 'cs.AI (primary) must be present');
  assert.equal(results['research:arxiv:v1:cs.AI::50'].papers.length, 1);
  assert.ok(results['research:arxiv:v1:cs.CR::50'], 'cs.CR must be present too');
  assert.ok(!results['research:arxiv:v1:cs.CL::50'], 'cs.CL failed → absent, not fatal');
});

test('a transient cs.AI timeout is retried and recovers (no zero-yield, #5409)', async () => {
  let aiAttempts = 0;
  const fetchFn = async (url) => {
    if (url.includes('cat:cs.AI')) {
      aiAttempts += 1;
      if (aiAttempts === 1) throw new Error('The operation was aborted due to timeout');
    }
    return okResp(arxivXml(`${catOf(url)}-1`, 'paper'));
  };

  const papers = await fetchArxivCategory('cs.AI', { fetchFn, retries: 1, sleepFn: noSleep });

  assert.equal(aiAttempts, 2, 'first attempt threw, the retry fired');
  assert.equal(papers.length, 1, 'the retry recovered the primary papers');
});

test('a total arXiv outage returns {} without throwing (runner keeps the graceful RETRY path, #5409)', async () => {
  const fetchFn = async () => { throw new Error('The operation was aborted due to timeout'); };

  const results = await fetchArxivPapers({ fetchFn, retries: 1, sleepFn: noSleep });

  // Crucially it must NOT throw: fetchAll runs this under Promise.allSettled, and a rejection
  // there (the old behavior) made allData.arxiv=null and was the top of the crash chain.
  assert.deepEqual(results, {}, 'no key written, and no throw');
});

test('ARXIV_TTL outlives the health staleness gate so a late tick is STALE_SEED, not EMPTY (#5409)', () => {
  assert.ok(
    ARXIV_TTL > RESEARCH_MAX_STALE_MIN * 60,
    `ARXIV_TTL (${ARXIV_TTL}s) must exceed the staleness gate ` +
      `(maxStaleMin ${RESEARCH_MAX_STALE_MIN}min = ${RESEARCH_MAX_STALE_MIN * 60}s)`,
  );
});
