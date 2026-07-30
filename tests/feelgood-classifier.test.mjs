// Unit tests for the feel-good / lifestyle classifier.
//
// classifyFeelGood is the single shared classifier — imported by the
// ingest path (list-feed-digest.ts, stamps `isFeelGood` on the
// story:track:v1 row) and the read path (buildDigest, re-classifies
// residue). Sibling to classifyOpinion. The brief is event-driven
// intelligence; a vintage-warplane veterans' reunion in Peru, Illinois
// (population 9,800) is not an event. See
// docs/plans/2026-05-17-001-fix-feelgood-lifestyle-filter-plan.md.
//
// Design notes the test suite is locking in:
//   - HARD-NEWS VETO (R3a) runs FIRST and overrides every other path
//   - Threshold is 3 distinct group names (raised from 2 per adv-R2-003)
//   - Distinct-token identity is the alternation-group label, NOT the
//     raw matched substring (per adv-R2-002) — reunite/reunited/reuniting
//     all collapse into reunite_group
//   - /local/, /photos/, /photo/, /travel/, /style/ are CORROBORATING,
//     not STRONG (per M5 + adv-R2-001 — hard news lives under those
//     segments at major outlets)
//   - URL match uses parsed pathname (try/catch), NOT raw .includes()
//     (per C3 / adv-002 — closes tracking-param injection vector)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFeelGood } from '../server/_shared/feelgood-classifier.js';

describe('classifyFeelGood — STRONG URL pathname segments (R1, sufficient alone subject to veto)', () => {
  it('T1: /lifestyle/ → feel-good', () => {
    assert.equal(
      classifyFeelGood({ title: 'X', link: 'https://example.com/lifestyle/holiday-recipes' }),
      true,
    );
  });

  it('T2: /features/ → feel-good', () => {
    assert.equal(
      classifyFeelGood({ title: 'X', link: 'https://example.com/features/local-hero' }),
      true,
    );
  });

  it('T3: /in-pictures/ → feel-good', () => {
    assert.equal(
      classifyFeelGood({ title: 'X', link: 'https://example.com/in-pictures/snow' }),
      true,
    );
  });

  it('STRONG variants all classify', () => {
    for (const seg of ['/lifestyle/', '/lifestyles/', '/feature/', '/features/', '/gallery/', '/in-pictures/', '/oddities/', '/human-interest/', '/community/']) {
      assert.equal(
        classifyFeelGood({ title: 'X', link: `https://example.com${seg}article` }),
        true,
        `${seg} should classify as feel-good`,
      );
    }
  });
});

describe('classifyFeelGood — STRONG headline prefix (R2, sufficient alone subject to veto)', () => {
  it('T4: "Photos:" → feel-good', () => {
    assert.equal(
      classifyFeelGood({ title: 'Photos: Snowfall blankets Vermont', link: '' }),
      true,
    );
  });

  it('T5: "Gallery:" → feel-good', () => {
    assert.equal(
      classifyFeelGood({ title: 'Gallery: Award-winning photography of 2026', link: '' }),
      true,
    );
  });

  it('STRONG prefix variants all classify', () => {
    for (const prefix of ['Photos:', 'Photo:', 'Gallery:', 'In Pictures:']) {
      assert.equal(
        classifyFeelGood({ title: `${prefix} Snowfall in Vermont`, link: '' }),
        true,
        `"${prefix}" prefix should classify as feel-good`,
      );
    }
  });

  it('T6: "Watch:" is NOT a STRONG prefix (regression — CBS news-video pattern)', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Watch: tornadoes swirl through Oklahoma',
        link: '',
        description: 'Severe weather hit three counties.',
      }),
      false,
    );
  });
});

describe('classifyFeelGood — slash-delimited URL segments only (PR #3690 lesson)', () => {
  it('T7: /world/lifestyle-of-the-rich-and-famous is NOT a STRONG match', () => {
    // The slug merely contains `lifestyle-` as a substring; not a
    // `/lifestyle/` path segment.
    assert.equal(
      classifyFeelGood({
        title: 'X',
        link: 'https://example.com/world/lifestyle-of-the-rich-and-famous',
      }),
      false,
    );
  });

  it('T8: /local-elections-coverage is NOT a STRONG match (and /local/ is no longer STRONG anyway)', () => {
    assert.equal(
      classifyFeelGood({ title: 'X', link: 'https://example.com/local-elections-coverage' }),
      false,
    );
  });
});

describe('classifyFeelGood — URL match uses parsed pathname (C3 / adv-002)', () => {
  it('T7b: tracking param containing /local/ does NOT trigger STRONG', () => {
    assert.equal(
      classifyFeelGood({
        title: 'X',
        link: 'https://example.com/world/news?utm_campaign=/local/promo',
      }),
      false,
    );
  });

  it('T7c: URL fragment containing /community/ does NOT trigger STRONG', () => {
    assert.equal(
      classifyFeelGood({
        title: 'X',
        link: 'https://example.com/world/news#/community/footer',
      }),
      false,
    );
  });

  it('T7d: malformed URL handled defensively (no throw)', () => {
    assert.equal(
      classifyFeelGood({ title: 'X', link: 'not a valid URL' }),
      false,
    );
  });
});

describe('classifyFeelGood — CORROBORATING 3-distinct-token threshold', () => {
  it('T9: Veterans anchor case — three+ distinct group names → feel-good', () => {
    // The verbatim May 17 0802 brief story. Distinct groups across
    // title + description:
    //   reunite_group (title "reunite" + description "reunited" dedup)
    //   vintage (title + description dedup)
    //   memories_group (description "memories")
    //   evoking_memories (description "evoking powerful memories")
    //   powerful_connections (description "powerful connections")
    // = 5 ≥ 3. Anchor case from the May 17 brief.
    assert.equal(
      classifyFeelGood({
        title: 'Veterans reunite with their vintage war planes',
        link: 'https://news.google.com/rss/articles/CBM',
        description: 'In Peru, Illinois, military veterans recently reunited with the vintage warplanes they once piloted, evoking powerful memories and connections.',
      }),
      true,
    );
  });

  it('T9-dedup: morphological echoes count ONCE per group (adv-R2-002)', () => {
    // Three reunite-family inflections (reunite / reunited / reuniting)
    // all collapse into reunite_group. Plus vintage. Distinct = 2 < 3.
    // Without group-label dedup, raw-substring counting would give 4
    // distinct strings and trip the threshold incorrectly.
    assert.equal(
      classifyFeelGood({
        title: 'Veterans reunite at airshow',
        link: '',
        description: 'The pilots reunited with their vintage planes and reuniting was tearful.',
      }),
      false,
    );
  });
});

describe('classifyFeelGood — HARD-NEWS VETO (R3a) overrides every classification path', () => {
  it('T9b: Hostages reunite + Gaza ceasefire — veto fires (ceasefire / hostages)', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Hostages reunite with families after Gaza ceasefire',
        link: '',
        description: 'Three hostages reunited with their families in Tel Aviv hours after the ceasefire took effect.',
      }),
      false,
    );
  });

  it('T9c: Refugees reunite — veto fires (refugees)', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Refugees reunite with families they had not seen in years',
        link: '',
        description: 'UN brokered the meeting.',
      }),
      false,
    );
  });

  it('T9d: Tribute + decades later + testify + tribunal — veto fires (testify, tribunal)', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Tribute to unsung witnesses who decades later testify against Milosevic',
        link: '',
        description: 'The tribunal heard from three survivors.',
      }),
      false,
    );
  });

  it('T9e: Restored Klimt — `restored` removed, threshold backs it off (1 distinct)', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Restored Klimt painting returned to family decades later',
        link: '',
        description: 'Found in attic by descendants of original owners.',
      }),
      false,
    );
  });

  it('T9f: US officials meet the Russian delegation — `meet the` removed (adv-R2-004)', () => {
    // Without `meet the`, distinct = {memories_group, decades_later} = 2 < 3.
    // Pre-fix, the function-word bigram `meet the` would have added
    // a third distinct token and triggered the false positive.
    assert.equal(
      classifyFeelGood({
        title: 'US officials meet the Russian delegation in Geneva',
        link: '',
        description: 'Both sides aim to revive memories of detente from decades later in the talks.',
      }),
      false,
    );
  });

  it('T9g: Iran retaliates after strike kills six — expanded veto morphology (adv-R2-003)', () => {
    // Pre-fix the veto only matched \bairstrike\b and \bkilled\b. The
    // natural news prose "strike kills" would not have vetoed. Expanded
    // morphology catches strike, kills, AND attack.
    assert.equal(
      classifyFeelGood({
        title: 'Iran retaliates after strike kills six near Hormuz',
        link: '',
        description: 'Tehran vowed years later to remember the attack; memories of past Gulf war remain bitter.',
      }),
      false,
    );
  });

  it('T9h: Halabja massacre — veto fires (massacre, attack)', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Survivors recount decades later their memories of the Halabja massacre',
        link: '',
        description: 'Three witnesses describe the chemical attack on the Kurdish village.',
      }),
      false,
    );
  });

  it('T9i: militants/bombed/casualties/wounded — veto fires on any one', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Three militants bombed by drone near border',
        link: '',
        description: 'Casualties unclear; villagers wounded in crossfire.',
      }),
      false,
    );
  });
});

describe('classifyFeelGood — single corroborating signal does NOT trip the threshold', () => {
  it('T10: Veterans painful memories Iraq War + testimony — veto fires (testimony)', () => {
    assert.equal(
      classifyFeelGood({
        title: "Veterans' painful memories of Iraq War surface in new testimony",
        link: '',
        description: 'Witnesses spoke before the Senate committee.',
      }),
      false,
    );
  });

  it('T11: Tribute to fallen soldiers — single distinct token (tribute_group) < 3', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Tribute to fallen soldiers held at Arlington',
        link: '',
        description: 'The defense secretary spoke at the ceremony.',
      }),
      false,
    );
  });
});

describe('classifyFeelGood — STRONG signal alone classifies, but veto still overrides', () => {
  it('T12: hard-news headline + STRONG /lifestyle/ URL (no veto) → feel-good', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Hard news headline with no soft tokens',
        link: 'https://example.com/lifestyle/topic',
        description: 'Body without any soft tokens.',
      }),
      true,
    );
  });

  it('T12b: airstrike kills + STRONG /lifestyle/ URL → veto overrides STRONG URL', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Airstrike kills six in southern Lebanon',
        link: 'https://example.com/lifestyle/topic',
      }),
      false,
    );
  });

  it('T12-strong-prefix-veto: "Photos:" + strike → veto overrides STRONG headline prefix', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Photos: aftermath of strike on civilian convoy',
        link: '',
      }),
      false,
    );
  });
});

describe('classifyFeelGood — /travel/, /style/, /local/, /photos/ are CORROBORATING only (M5 + adv-R2-001)', () => {
  it('T12c: /travel/ alone (1 distinct) → not feel-good', () => {
    assert.equal(
      classifyFeelGood({
        title: 'X',
        link: 'https://example.com/travel/border-closure-update',
      }),
      false,
    );
  });

  it('T12d: /travel/ + vintage + reunites + powerful connections → feel-good (4 distinct)', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Visit Vienna: vintage tram tour reunites old friends and evokes powerful connections',
        link: 'https://example.com/travel/article',
      }),
      true,
    );
  });

  it('T12e: /local/ + dead (breaking local news) → veto overrides', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Building collapse leaves three dead in Cleveland',
        link: 'https://news.example.com/local/breaking-collapse-cleveland',
      }),
      false,
    );
  });

  it('T12f: /photos/ + strike (wire-photo desk hard news) → veto overrides', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Aftermath of strike on Tel Aviv',
        link: 'https://reuters.com/photos/tel-aviv-strike-aftermath',
      }),
      false,
    );
  });

  it('T12g: /local/ + heartwarming + vintage + reunites → feel-good (4 distinct)', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Heartwarming vintage car parade reunites old neighborhood',
        link: 'https://news.example.com/local/feature',
      }),
      true,
    );
  });
});

describe('classifyFeelGood — 3-distinct-token threshold boundary (adv-R2-003)', () => {
  it('T-threshold-2: vintage + memories (2 distinct) → not feel-good', () => {
    // Under the prior 2-threshold this would have classified.
    assert.equal(
      classifyFeelGood({
        title: 'Vintage car show in Brooklyn',
        link: '',
        description: 'Memories of the 1960s flood Park Slope.',
      }),
      false,
    );
  });

  it('T-threshold-3: vintage + reunite + memories (3 distinct) → feel-good', () => {
    assert.equal(
      classifyFeelGood({
        title: 'Vintage car show reunites Brooklyn neighbors',
        link: '',
        description: 'Memories of the 1960s flood Park Slope.',
      }),
      true,
    );
  });
});

describe('classifyFeelGood — input safety (defensive)', () => {
  it('T13: handles missing / non-string fields without throwing', () => {
    assert.equal(classifyFeelGood({}), false);
    assert.equal(classifyFeelGood({ title: 42, link: null, description: undefined }), false);
    assert.doesNotThrow(() => classifyFeelGood(null));
    assert.equal(classifyFeelGood(undefined), false);
  });
});
