// #10863: the analyst's news retrieval matched raw question words against
// headline titles, so "Latin America" found nothing while the digest held a
// whole `latam` bucket, and filler such as "news" matched "- AP News".
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractKeywords,
  flattenDigest,
  selectRelevantArticles,
} from '../server/worldmonitor/intelligence/v1/chat-analyst-context.ts';
import { resolveGeoScope } from '../server/worldmonitor/intelligence/v1/chat-analyst-geo-scope.ts';

const NOW = Date.UTC(2026, 10, 16);

function item(title: string, importanceScore: number, source = 'Wire') {
  return { title, source, publishedAt: NOW, importanceScore };
}

/** Shape and titles of the prod digest on 2026-11-16, trimmed. */
function prodLikeDigest() {
  return {
    categories: {
      latam: {
        items: [
          item('Trump list of US-designated ‘foreign terrorist organizations’ in Latin America grows to 22 - AP News', 64),
          item("Mexico's Sheinbaum says migrant caravan not moving toward US now as Trump threatens tariffs - Reuters", 51),
          item('The Hunger I Found in Venezuela Isn’t for Revenge, but for Rebuilding', 27),
        ],
      },
      politics: {
        items: [
          item('Pope in Peruvian rainforest demands justice for environmental defenders killed for protecting Amazon - AP News', 40),
          item('Robert Pattinson is named the 7th James Bond, taking over the role from Daniel Craig - AP News', 44),
        ],
      },
      europe: {
        items: [
          item("Russia's war on Ukraine: 'Americans want to have a deal whatever the cost for both Ukraine & Europe'", 55),
        ],
      },
      intel: {
        items: [
          item('New tools for troops to gun down drones | Defense News Weekly Full Episode 11.17.26', 55),
        ],
      },
      layoffs: {
        items: [
          item('Tech Companies Cut More Than 206,000 Jobs This Year While Pouring An Estimated $700 Billion Into AI Infrastructure - Latin Times', 13),
        ],
      },
      middleeast: {
        items: [
          item('Gulf states weigh new shipping escorts', 30),
        ],
      },
    },
  };
}

describe('extractKeywords — question filler is not a retrieval term (#10863)', () => {
  it('drops news / recent / latest / headlines', () => {
    assert.deepEqual(extractKeywords('recent news and latest headlines on oil'), ['oil']);
  });
});

describe('resolveGeoScope (#10863)', () => {
  it('reads a region phrase and a country out of the question', () => {
    const scope = resolveGeoScope('what are the recent financial news about brazil and latin america');
    assert.deepEqual(scope.countries.map((c) => c.code), ['BR']);
    assert.deepEqual(scope.regions.map((r) => r.category), ['latam']);
    assert.deepEqual(scope.residualQuery.split(/\s+/).filter(Boolean), ['what', 'are', 'the', 'recent', 'financial', 'news', 'about', 'and']);
  });

  it('resolves multi-word countries and adjective region forms', () => {
    const scope = resolveGeoScope('South Africa and Middle Eastern oil');
    assert.deepEqual(scope.countries.map((c) => c.code), ['ZA']);
    assert.deepEqual(scope.regions.map((r) => r.category), ['middleeast']);
  });

  it('does not read ordinary short words as countries', () => {
    for (const q of ['tell us what you can do', 'are prices up and per barrel', 'how is the market']) {
      const scope = resolveGeoScope(q);
      assert.deepEqual(scope.countries, [], q);
      assert.deepEqual(scope.regions, [], q);
    }
  });

  it('takes uppercase US and UK as countries', () => {
    assert.deepEqual(resolveGeoScope('US and UK tariffs').countries.map((c) => c.code), ['US', 'GB']);
  });
});

describe('selectRelevantArticles — regions and countries (#10863)', () => {
  const query = 'what are the recent financial news about brazil and latin america';

  it('returns the region bucket and member-country headlines, not filler matches', () => {
    const out = selectRelevantArticles(flattenDigest(prodLikeDigest()), query);
    assert.match(out, /Sheinbaum says migrant caravan/);
    assert.match(out, /Hunger I Found in Venezuela/);
    assert.match(out, /Pope in Peruvian rainforest/, 'a member-country demonym outside the bucket still counts');
    assert.doesNotMatch(out, /James Bond/, '"news" must not match the "- AP News" suffix');
    assert.doesNotMatch(out, /Defense News Weekly/);
    assert.doesNotMatch(out, /Americans want to have a deal/);
    assert.doesNotMatch(out, /Latin Times/, 'a source suffix is not a region mention');
  });

  it('Mexico counts as Latin America outside the latam bucket', () => {
    const digest = { categories: { us: { items: [item('Mexican peso hits two-year high', 30)] } } };
    assert.match(selectRelevantArticles(flattenDigest(digest), 'latin america markets'), /Mexican peso/);
  });

  it('a headline naming the region itself is a full mention, not bucket-only', () => {
    const fillers = Array.from({ length: 10 }, (_, i) => item(`Caribbean island story ${i} from Haiti`, 40));
    const digest = {
      categories: {
        latam: { items: [item('Trump list of US-designated terrorist groups in Latin America grows to 22 - AP News', 64), ...fillers] },
        finance: { items: [item('Which Financial Stock Is a Better Buy - The Motley Fool', 90)] },
      },
    };
    const out = selectRelevantArticles(flattenDigest(digest), 'recent financial news about latin america');
    assert.match(out, /in Latin America grows to 22/);
  });

  it('a story filed under several buckets keeps the asked region copy and its coverage', () => {
    const digest = {
      categories: {
        us: { items: [item('Caravan halts at the border', 50)] },
        latam: { items: [item('Caravan halts at the border', 50)] },
      },
    };
    const out = selectRelevantArticles(flattenDigest(digest), 'latin america');
    assert.equal(out.split('\n').length, 1);
    assert.doesNotMatch(out, /Coverage gap/);
  });

  it('Africa covers North Africa, Europe leaves out Central Asia', () => {
    const digest = {
      categories: {
        world: { items: [item('Egyptian pound slides after IMF review', 30), item('Kazakh grain exports hit record', 30)] },
      },
    };
    assert.match(selectRelevantArticles(flattenDigest(digest), 'africa'), /Egyptian pound/);
    const europe = selectRelevantArticles(flattenDigest(digest), 'europe');
    assert.doesNotMatch(europe, /Kazakh/);
  });

  it('places come from the current turn; a turn without one inherits the prior turn', () => {
    const digest = {
      categories: {
        world: {
          items: [
            item('Germany cuts gas tariff', 30),
            item('Brazil soy exports climb', 30),
            item('China refiners buy more crude', 30),
          ],
        },
      },
    };
    const pivot = selectRelevantArticles(flattenDigest(digest), 'What about Germany? and Brazil', 'What about Germany?');
    assert.match(pivot, /Germany cuts gas tariff/);
    assert.doesNotMatch(pivot, /Brazil/, 'the prior turn\'s place neither ranks nor earns a coverage line');

    const followUp = selectRelevantArticles(flattenDigest(digest), 'what about oil prices? what is happening in China', 'what about oil prices?');
    assert.match(followUp, /China refiners/);
  });

  it('places past the cap stay as keywords', () => {
    const scope = resolveGeoScope('France Germany Italy Spain Portugal');
    assert.equal(scope.countries.length, 4);
    assert.match(scope.residualQuery, /Portugal/);
  });

  it('the source-suffix pattern stays linear on a hostile title', () => {
    const digest = { categories: { world: { items: [item(`x - ${'a'.repeat(20_000)}-b`, 10)] } } };
    const started = performance.now();
    selectRelevantArticles(flattenDigest(digest), 'markets');
    assert.ok(performance.now() - started < 200, `took ${performance.now() - started} ms`);
  });

  it('one slot per title when feeds repeat a story', () => {
    const digest = {
      categories: {
        energy: { items: [item('Oil prices reverse gains - WSJ', 30), item('Oil prices reverse gains - WSJ', 30)] },
      },
    };
    assert.equal(selectRelevantArticles(flattenDigest(digest), 'oil prices').split('\n').length, 1);
  });

  it('says so when a named country has no headline', () => {
    const out = selectRelevantArticles(flattenDigest(prodLikeDigest()), query);
    assert.match(out, /^Coverage gap: no headline in the current news digest mentions Brazil\.$/m);
    assert.doesNotMatch(out, /Coverage gap:.*Latin America/);
  });

  it('a country matches its demonym', () => {
    const digest = { categories: { finance: { items: [item('Brazilian real slides as fiscal worries mount', 20)] } } };
    const out = selectRelevantArticles(flattenDigest(digest), 'brazil markets');
    assert.match(out, /Brazilian real slides/);
    assert.doesNotMatch(out, /Coverage gap/);
  });

  it('topic words rank in-scope headlines but do not exclude them', () => {
    const digest = {
      categories: {
        latam: {
          items: [
            item('Mexico peso rallies on rate cut', 10),
            item('Mexico storm floods Acapulco', 60),
          ],
        },
      },
    };
    const lines = selectRelevantArticles(flattenDigest(digest), 'latin america peso').split('\n');
    assert.match(lines[0]!, /peso rallies/);
    assert.match(lines[1]!, /storm floods/);
  });

  it('a headline naming the place outranks one that only sits in the region bucket', () => {
    const digest = {
      categories: {
        middleeast: {
          items: [
            item('Showdown looms between Trump and Democrats over air traffic control', 80),
            item('Israel weighs response to Hezbollah fire', 20),
          ],
        },
      },
    };
    const lines = selectRelevantArticles(flattenDigest(digest), 'what is going on in the middle east').split('\n');
    assert.match(lines[0]!, /Hezbollah fire/);
    assert.match(lines[1]!, /air traffic control/);
  });

  it('headlines naming several of the asked places rank first', () => {
    const digest = {
      categories: {
        world: {
          items: [
            item('US attorney warns senator over inquiry', 90),
            item('US weighs new sanctions on Iran oil exports', 20),
            item('Iran blocks inspector visits', 60),
          ],
        },
      },
    };
    const lines = selectRelevantArticles(flattenDigest(digest), 'US sanctions on Iran').split('\n');
    assert.match(lines[0]!, /new sanctions on Iran/);
  });

  it('keeps room for topic-only headlines when the place fills the block', () => {
    const china = Array.from({ length: 10 }, (_, i) => item(`China AI chip curbs story ${i}`, 80));
    const digest = {
      categories: {
        asia: { items: china },
        energy: { items: [item('Oil prices jump as OPEC trims output', 30)] },
      },
    };
    const lines = selectRelevantArticles(flattenDigest(digest), 'China and oil prices').split('\n');
    assert.equal(lines.length, 8);
    assert.ok(lines.some((l) => /OPEC trims output/.test(l)), lines.join('\n'));
  });

  it('topic-only headlines fill every slot the place leaves empty', () => {
    const digest = {
      categories: {
        energy: { items: Array.from({ length: 5 }, (_, i) => item(`Oil market story ${i}`, 30)) },
        asia: { items: [item('China growth slows', 30)] },
      },
    };
    const lines = selectRelevantArticles(flattenDigest(digest), 'China and oil').split('\n');
    assert.equal(lines.length, 6);
  });

  it('a question with no place keeps keyword ranking unchanged', () => {
    const digest = {
      categories: {
        tech: { items: [item('Taiwan chip toolmakers face export controls', 5), item('Unrelated story', 90)] },
      },
    };
    const out = selectRelevantArticles(flattenDigest(digest), 'chip export controls');
    assert.match(out, /chip toolmakers/);
    assert.doesNotMatch(out, /Unrelated story/);
  });

  it('a source suffix never earns a keyword hit', () => {
    const digest = { categories: { layoffs: { items: [item('Tech job cuts top 206,000 - Latin Times', 13)] } } };
    assert.equal(selectRelevantArticles(flattenDigest(digest), 'times of crisis'), '');
  });
});
