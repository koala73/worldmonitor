// Pin the `education` dimension's normalization transform.
//
// Indicator: SE.SEC.CUAT.UP.FE.ZS — female upper-secondary attainment, 25+.
// Construct: the "Education" section of docs/methodology/country-resilience-index.mdx
//
// The construct contract requires a threshold or saturating transform for
// development-adjacent indicators, so the score rewards functional capacity
// rather than affluence. But the measured distribution does NOT saturate:
// across the 181 covered countries the median is 50.0, the deciles are close
// to uniform, and only 1.7% exceed 95% (against adult literacy's 42%). A log
// or logistic squash would destroy discrimination in the 20-80 band where
// two-thirds of the universe lives.
//
// The resolution is a two-segment piecewise-linear map with a slope drop at
// 85. Decreasing slope is concave, which satisfies the contract, while the
// first segment stays linear across the band that actually holds countries.
// The bend affects 22 of 181 countries (12.2%).
//
// These tests assert the MECHANISM on synthetic inputs. They deliberately do
// not encode "country A outranks country B" — that fits the construct to an
// expected answer rather than testing it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeEducationAttainment,
  scoreEducation,
  EDUCATION_BEND,
  EDUCATION_BEND_SCORE,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.js';
import sovereignStatus from '../scripts/shared/sovereign-status.json';

const EDUCATION_KEY = 'resilience:education-attainment:v1';
const EDUCATION_META_KEY = 'seed-meta:resilience:education-attainment';

function healthyCountries(
  overrides: Record<string, unknown> = {},
  omitted = new Set<string>(),
): Record<string, unknown> {
  const countries = Object.fromEntries(
    sovereignStatus.entries
      .filter((entry) => !omitted.has(entry.iso2))
      .slice(0, 180)
      .map((entry, index) => [entry.iso2, { value: 20 + (index % 75), year: 2024 }]),
  );
  return { ...countries, ...overrides };
}

// Reader factory: healthy seed-meta plus whatever payload the test supplies.
function readerForRawPayload(payload: unknown) {
  return async (key: string): Promise<unknown | null> => {
    if (key === EDUCATION_META_KEY) return { status: 'ok', fetchedAt: Date.now(), rankableRecordCount: 180 };
    if (key === EDUCATION_KEY) return payload;
    return null;
  };
}

function readerFor(countries: Record<string, unknown> | null) {
  return readerForRawPayload(countries == null ? null : { countries: healthyCountries(countries) });
}

function withFlag<T>(value: 'true' | 'false', fn: () => Promise<T>): Promise<T> {
  const prior = process.env.RESILIENCE_EDUCATION_ENABLED;
  process.env.RESILIENCE_EDUCATION_ENABLED = value;
  const restore = () => {
    if (prior == null) delete process.env.RESILIENCE_EDUCATION_ENABLED;
    else process.env.RESILIENCE_EDUCATION_ENABLED = prior;
  };
  return fn().finally(restore);
}

// Both directions are now set EXPLICITLY. Since #6460 the flag defaults to
// true, so a suite that relied on the ambient default to mean "off" would keep
// its name and quietly assert the opposite behavior.
const withFlagOn = <T>(fn: () => Promise<T>) => withFlag('true', fn);
const withFlagOff = <T>(fn: () => Promise<T>) => withFlag('false', fn);

describe('normalizeEducationAttainment — anchors', () => {
  it('maps the goalposts to the full score range', () => {
    assert.equal(normalizeEducationAttainment(0), 0);
    assert.equal(normalizeEducationAttainment(100), 100);
  });

  it('maps the bend to the bend score', () => {
    assert.equal(normalizeEducationAttainment(EDUCATION_BEND), EDUCATION_BEND_SCORE);
  });

  it('places the observed distribution extremes inside the range', () => {
    // Measured min (Niger 1.15) and max (Belarus 98.18). Neither may clip:
    // fixed 0/100 anchors exist so no observed country sits at a goalpost.
    const lo = normalizeEducationAttainment(1.15);
    const hi = normalizeEducationAttainment(98.18);
    assert.ok(lo > 0, 'observed minimum must not floor at 0');
    assert.ok(hi < 100, 'observed maximum must not ceiling at 100');
  });
});

describe('normalizeEducationAttainment — monotonicity', () => {
  it('is strictly increasing across the observed range', () => {
    const samples = [1.15, 5, 12, 20, 35, 50, 65, 76, 85, 90, 95, 98.18];
    for (let i = 1; i < samples.length; i++) {
      const prev = normalizeEducationAttainment(samples[i - 1]);
      const cur = normalizeEducationAttainment(samples[i]);
      assert.ok(cur > prev, `score must increase from ${samples[i - 1]} to ${samples[i]} (${prev} -> ${cur})`);
    }
  });

  it('rewards more schooling at every decile boundary', () => {
    for (let v = 0; v < 100; v += 10) {
      assert.ok(
        normalizeEducationAttainment(v + 10) > normalizeEducationAttainment(v),
        `decile ${v} -> ${v + 10} must increase`,
      );
    }
  });
});

describe('normalizeEducationAttainment — the bend is real', () => {
  it('yields materially less score per point above the bend', () => {
    // Equal 13-point input spans on either side of the bend.
    const below = normalizeEducationAttainment(85) - normalizeEducationAttainment(72);
    const above = normalizeEducationAttainment(98) - normalizeEducationAttainment(85);
    assert.ok(above < below, `top band must compress (${above} vs ${below})`);
    assert.ok(above * 1.5 < below, 'compression must be material, not marginal');
  });

  it('is continuous at the bend — no cliff', () => {
    const justBelow = normalizeEducationAttainment(EDUCATION_BEND - 0.5);
    const at = normalizeEducationAttainment(EDUCATION_BEND);
    const justAbove = normalizeEducationAttainment(EDUCATION_BEND + 0.5);
    assert.ok(at - justBelow <= 2, 'no discontinuity approaching the bend from below');
    assert.ok(justAbove - at <= 2, 'no discontinuity leaving the bend from above');
  });

  it('does not invert or plateau above the bend', () => {
    // Concave must still mean increasing. A flat top would make the 22
    // countries above the bend indistinguishable from each other.
    assert.ok(normalizeEducationAttainment(100) > normalizeEducationAttainment(90));
    assert.ok(normalizeEducationAttainment(90) > normalizeEducationAttainment(86));
  });

  it('keeps discrimination in the 20-80 band where two-thirds of countries sit', () => {
    // A saturating transform would compress this band. The span from p25
    // (19.5) to p75 (76.1) must stay wide.
    const span = normalizeEducationAttainment(76.1) - normalizeEducationAttainment(19.5);
    assert.ok(span > 50, `interquartile span must stay wide, got ${span}`);
  });
});

describe('normalizeEducationAttainment — boundary handling', () => {
  it('clamps out-of-range input rather than extrapolating', () => {
    assert.equal(normalizeEducationAttainment(120), 100);
    assert.equal(normalizeEducationAttainment(-5), 0);
  });

  it('returns null for a missing reading so the blend drops the slot', () => {
    // Returning 0 would score an unsurveyed country as the worst on earth.
    assert.equal(normalizeEducationAttainment(null), null);
    assert.equal(normalizeEducationAttainment(undefined), null);
    assert.equal(normalizeEducationAttainment(Number.NaN), null);
  });

  it('handles the read-path null trap end to end', () => {
    // Number(null) === 0 and is finite, so any accessor that coerces before
    // testing publishes a real 0% for a country with no reading.
    assert.equal(normalizeEducationAttainment(Number(null)), 0, 'coerced null IS a valid 0 score');
    assert.equal(normalizeEducationAttainment(null), null, 'but raw null must stay null');
  });
});

describe('scoreEducation — flag off (the rollback path)', () => {
  it('returns the empty-data shape and contributes no weight', async () => {
    // Explicit `=false` since #6460: the flag now DEFAULTS to true, so this
    // suite would otherwise silently test the flag-ON path while still being
    // named "flag off". This is no longer the shipped state — it is the
    // rollback path documented in the runbook, and it still has to behave.
    const score = await withFlagOff(() =>
      scoreEducation('US', readerFor({ US: { value: 80, year: 2024 } })),
    );
    assert.equal(score.coverage, 0);
    assert.equal(score.observedWeight, 0);
    assert.equal(score.imputedWeight, 0);
    // null, not 'source-failure' — a dark construct is a deliberate state, not
    // an outage. 'source-failure' renders a "Source down" badge on every country.
    assert.equal(score.imputationClass, null);
  });
});

describe('scoreEducation — flag on', () => {
  it('scores an observed country', async () => {
    const score = await withFlagOn(() =>
      scoreEducation('FR', readerFor({ FR: { value: 82.5, year: 2024 } })),
    );
    assert.ok(score.score > 0, `expected a positive score, got ${score.score}`);
    assert.ok(score.coverage > 0);
    assert.equal(score.imputationClass, null, 'observed data must not be tagged imputed');
  });

  it('fails closed below the active rankable-coverage floor', async () => {
    await withFlagOn(() => assert.rejects(
      () => scoreEducation('FR', async (key) => {
        if (key === EDUCATION_META_KEY) {
          return { status: 'ok', fetchedAt: Date.now(), rankableRecordCount: 179 };
        }
        if (key === EDUCATION_KEY) return { countries: { FR: { value: 82.5, year: 2024 } } };
        return null;
      }),
      (err: Error) => /rankable coverage is 179\/180/.test(err.message),
    ));
  });

  it('accepts the existing countrySet transition metadata when it proves the floor', async () => {
    const countrySet = sovereignStatus.entries.slice(0, 180).map((entry) => entry.iso2).join(',');
    const score = await withFlagOn(() => scoreEducation('FR', async (key) => {
      if (key === EDUCATION_META_KEY) return { status: 'ok', fetchedAt: Date.now(), countrySet };
      if (key === EDUCATION_KEY) return { countries: healthyCountries({ FR: { value: 82.5, year: 2024 } }) };
      return null;
    }));
    assert.ok(score.coverage > 0);
  });

  it('rejects metadata that claims the floor when the data payload does not contain it', async () => {
    await withFlagOn(() => assert.rejects(
      () => scoreEducation('FR', readerForRawPayload({
        countries: { FR: { value: 82.5, year: 2024 } },
      })),
      (err: Error) => /data payload has usable rankable coverage 1\/180/.test(err.message),
    ));
  });

  it('rejects a payload with fewer than 180 usable records', async () => {
    const countries = Object.fromEntries(
      sovereignStatus.entries
        .slice(0, 179)
        .map((entry, index) => [entry.iso2, { value: 20 + (index % 75), year: 2024 }]),
    );
    await withFlagOn(() => assert.rejects(
      () => scoreEducation('FR', readerForRawPayload({ countries })),
      (err: Error) => /data payload has usable rankable coverage 179\/180/.test(err.message),
    ));
  });

  it('fails closed on a null value instead of coercing it to 0% attainment', async () => {
    // The trap: Number(null) === 0 is finite, so a naive coercion publishes
    // "worst on earth, fully observed" for a country with no reading. This is
    // the read-side twin of the seeder's own null guard.
    await withFlagOn(() => assert.rejects(
      () => scoreEducation('FR', readerFor({
        FR: { value: null, year: 2023 },
        US: { value: 92.1, year: 2024 },
      })),
      (err: Error) => /malformed record for FR/.test(err.message),
    ));
  });

  it('fails closed on a null year instead of derating it to the oldest bucket', async () => {
    await withFlagOn(() => assert.rejects(
      () => scoreEducation('FR', readerFor({
        FR: { value: 60, year: null },
        US: { value: 92.1, year: 2024 },
      })),
      (err: Error) => /malformed record for FR/.test(err.message),
    ));
  });

  it('fails closed on an out-of-range percentage', async () => {
    await withFlagOn(() => assert.rejects(
      () => scoreEducation('FR', readerFor({
        FR: { value: 145, year: 2024 },
        US: { value: 92.1, year: 2024 },
      })),
      (err: Error) => /malformed record for FR/.test(err.message),
    ));
  });

  it('fails closed on a fractional or implausible observation year', async () => {
    for (const year of [2024.5, 1899, 2201]) {
      await withFlagOn(() => assert.rejects(
        () => scoreEducation('FR', readerFor({
          FR: { value: 82.5, year },
          US: { value: 92.1, year: 2024 },
        })),
        (err: Error) => /malformed record for FR/.test(err.message),
      ));
    }
  });

  it('imputes an absent country as unmonitored, never stable-absence', async () => {
    // stable-absence would hand DPRK and Syria a score near 85 for the crime of
    // not being surveyed. The World Bank does not publish everywhere.
    const countries = healthyCountries({ FR: { value: 82.5, year: 2024 } }, new Set(['KP']));
    const score = await withFlagOn(() => scoreEducation('KP', readerForRawPayload({ countries })));
    assert.equal(score.imputationClass, 'unmonitored');
  });

  for (const [label, payload] of [
    ['null', null],
    ['array', []],
    ['missing countries', { records: {} }],
    ['null countries', { countries: null }],
    ['empty countries', { countries: {} }],
  ] as const) {
    it(`fails closed when the data payload is ${label}`, async () => {
      await withFlagOn(async () => {
        await assert.rejects(
          () => scoreEducation('FR', readerForRawPayload(payload)),
          (err: Error) => /education-attainment/.test(err.message) && /payload/i.test(err.message),
        );
      });
    });
  }

  for (const [label, countries] of [
    ['irrelevant country only', { ZZ: { value: 50, year: 2024 } }],
    ['null recognized record', { FR: null }],
    ['invalid recognized value', { FR: { value: 101, year: 2024 } }],
    ['invalid recognized year', { FR: { value: 50, year: null } }],
  ] as const) {
    it(`fails closed when the non-empty envelope has ${label}`, async () => {
      await withFlagOn(async () => {
        await assert.rejects(
          () => scoreEducation('FR', readerForRawPayload({ countries })),
          (err: Error) => /education-attainment/.test(err.message) && /(payload|malformed record)/i.test(err.message),
        );
      });
    });
  }

  it('fails closed when the seed envelope is missing', async () => {
    // A dead Railway bundle must surface as an operator-visible error, not
    // silently impute all 196 countries to the midpoint.
    await withFlagOn(async () => {
      await assert.rejects(
        () => scoreEducation('FR', async () => null),
        (err: Error) => /education-attainment/.test(err.message),
      );
    });
  });

  it('derates certainty for a decade-stale observation but still scores it', async () => {
    const fresh = await withFlagOn(() =>
      scoreEducation('FR', readerFor({ FR: { value: 80, year: new Date().getUTCFullYear() } })),
    );
    const stale = await withFlagOn(() =>
      scoreEducation('FR', readerFor({ FR: { value: 80, year: 2014 } })),
    );
    assert.equal(stale.score, fresh.score, 'a stale reading keeps its value');
    assert.ok(stale.coverage < fresh.coverage, 'but carries less certainty');
    assert.ok(stale.coverage > 0, 'and is not dropped entirely');
  });
});
