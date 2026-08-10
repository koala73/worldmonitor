import { monthIndex, monthPeriodEnd } from './jodi-demand-change.mjs';

export const MAX_JODI_CONTENT_AGE_MONTHS = 6;

/**
 * Whole-dataset content budget, in minutes, for the runSeed content-age
 * contract. JODI publishes monthly with a two-to-three month reporting lag, so
 * this is the same six months the per-country assessment allows, measured in
 * 31-day months so a snapshot can never alarm purely because the span it
 * covered happened to cross short ones.
 */
export const MAX_JODI_CONTENT_AGE_MIN = MAX_JODI_CONTENT_AGE_MONTHS * 31 * 24 * 60;

/**
 * How many countries must report a month before it can date the whole file.
 *
 * A JODI file carries a long reporting tail — one country can sit years behind
 * while the leading cohort is current. Taking the plain maximum would let a
 * single fast reporter vouch for a file everyone else had stopped updating, so
 * the dataset's date is the newest month a quorum agrees on. Measured against
 * the live files on 2026-08-10 the leading cohort was 35 of 57 usable gas
 * countries and 43 of 50 oil countries, so a quorum of three has wide margin.
 */
export const MIN_JODI_CONTENT_AGE_COUNTRIES = 3;

function readPath(value, path) {
  return path.split('.').reduce((current, part) => {
    if (current == null || typeof current !== 'object') return undefined;
    return current[part];
  }, value);
}

/**
 * Return true when at least one public-profile measurement is present.
 * Zero is a valid observation; null, undefined, and non-finite values are not.
 */
export function hasFiniteMeasurementAtPaths(value, paths) {
  return paths.some((path) => {
    const measurement = readPath(value, path);
    return typeof measurement === 'number' && Number.isFinite(measurement);
  });
}

/**
 * Report China presence, source month, and usable measurements independently
 * of the seeder fetch timestamp. Zero is a valid measurement.
 *
 * This is a diagnostic, never a publish gate: China stopping does not make the
 * other fifty-plus countries in the same file wrong (issue #6395). Callers
 * record the verdict through {@link buildChinaRowDiagnostic} and publish
 * whatever else parsed.
 */
export function assessChinaJodiCoverage(records, now, hasMeasurements) {
  const china = Array.isArray(records) ? records.find((record) => record?.iso2 === 'CN') : null;
  if (!china) {
    return { ok: false, reason: 'china-missing', dataMonth: null, ageMonths: null };
  }

  const sourceMonth = monthIndex(china.dataMonth);
  const currentMonth = now instanceof Date && Number.isFinite(now.getTime())
    ? now.getUTCFullYear() * 12 + now.getUTCMonth()
    : null;
  if (sourceMonth == null || currentMonth == null || sourceMonth > currentMonth) {
    return { ok: false, reason: 'china-invalid-month', dataMonth: china.dataMonth ?? null, ageMonths: null };
  }

  const ageMonths = currentMonth - sourceMonth;
  if (ageMonths > MAX_JODI_CONTENT_AGE_MONTHS) {
    return { ok: false, reason: 'china-stale', dataMonth: china.dataMonth, ageMonths };
  }
  if (!hasMeasurements(china)) {
    return { ok: false, reason: 'china-no-measurements', dataMonth: china.dataMonth, ageMonths };
  }

  return { ok: true, reason: null, dataMonth: china.dataMonth, ageMonths };
}

/**
 * Newest and oldest usable observation in a JODI snapshot, as epoch
 * milliseconds anchored to the END of each record's data month.
 *
 * With China demoted to a diagnostic, this is what keeps a frozen upstream file
 * from publishing as if it were fresh: the seeder feeds it to runSeed's
 * content-age contract, and /api/health reports STALE_CONTENT once the whole
 * dataset falls behind MAX_JODI_CONTENT_AGE_MIN.
 *
 * Only records that carry a real measurement count. A country row that parsed
 * into nothing but nulls proves the download happened, never that the file
 * still holds current observations. Returns null when no record qualifies,
 * which both runSeed and health read as "content age unknown" — STALE_CONTENT,
 * not OK.
 *
 * Months that have not finished yet are skipped for the same reason
 * `assessChinaJodiCoverage` rejects them: an observation cannot be reported
 * before its period ends, so one mis-dated country must not be able to vouch
 * for the freshness of the whole file. For the same reason the newest month
 * must clear `minCountries` — see MIN_JODI_CONTENT_AGE_COUNTRIES.
 *
 * This reduces with max-over-quorum, NOT the min() that
 * `docs/solutions/design-patterns/multi-source-freshness-clock-must-reduce-with-min.md`
 * requires. That rule governs one canonical key fed by several independently
 * failing UPSTREAMS, where the live one hides the dead one. JODI is a single
 * upstream — one file per fuel — whose countries are series inside it, and
 * whose reporting lag is heterogeneous by design: the live files carry a tail
 * back to 2014-03, so min() would report twelve years stale forever and could
 * never go green. Gating the whole file on one country is also the exact
 * defect issue #6395 removes. The quorum is what keeps max() honest here:
 * a file that stops advancing cannot keep three countries moving, so the
 * doc's own diagnostic — "which single upstream can stop publishing without
 * changing newestItemAt?" — answers "none" at the granularity that has an
 * upstream.
 *
 * @param {unknown} records
 * @param {(record: any) => boolean} hasMeasurements
 * @param {Date} now
 * @param {number} minCountries
 * @returns {{ newestItemAt: number, oldestItemAt: number } | null}
 */
export function jodiDatasetContentMeta(
  records,
  hasMeasurements,
  now = new Date(),
  minCountries = MIN_JODI_CONTENT_AGE_COUNTRIES,
) {
  if (!Array.isArray(records)) return null;
  const nowMs = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : null;
  if (nowMs === null) return null;

  /** @type {Map<number, number>} */
  const countriesByMonthEnd = new Map();
  let oldestItemAt = null;
  for (const record of records) {
    if (!hasMeasurements(record)) continue;
    const periodEnd = monthPeriodEnd(record?.dataMonth);
    if (periodEnd === null) continue;
    const observedAt = Date.parse(periodEnd);
    if (!Number.isFinite(observedAt) || observedAt > nowMs) continue;
    countriesByMonthEnd.set(observedAt, (countriesByMonthEnd.get(observedAt) ?? 0) + 1);
    if (oldestItemAt === null || observedAt < oldestItemAt) oldestItemAt = observedAt;
  }

  let newestItemAt = null;
  for (const [observedAt, countries] of countriesByMonthEnd) {
    if (countries < minCountries) continue;
    if (newestItemAt === null || observedAt > newestItemAt) newestItemAt = observedAt;
  }

  return newestItemAt === null ? null : { newestItemAt, oldestItemAt };
}

/**
 * The bounded, public-safe China record the seeders write into seed-meta.
 *
 * Since an unusable China row no longer withholds the publish, this block is
 * the only live statement of the gap — /api/health relays it verbatim so an
 * operator reads "china-missing since <date>" beside an otherwise healthy
 * dataset instead of inferring it from a generic staleness verdict 40 days
 * later. `unavailableSince` is carried forward from the previous run so the
 * gap reports its true age rather than looking new on every tick. It is
 * best-effort by construction: a run that cannot read the previous seed-meta
 * (Redis blip, first run after deploy) has no evidence the gap is older, so it
 * re-dates to now. Read it as "first run that recorded this gap", never as a
 * measured outage start.
 *
 * @param {{ ok: boolean, reason: string|null, dataMonth: string|null, ageMonths: number|null }} assessment
 * @param {{ ok?: unknown, unavailableSince?: unknown }|null|undefined} previous
 * @param {number} nowMs
 */
export function buildChinaRowDiagnostic(assessment, previous, nowMs) {
  const ok = assessment?.ok === true;
  const diagnostic = {
    ok,
    reason: ok ? null : (assessment?.reason ?? null),
    dataMonth: assessment?.dataMonth ?? null,
    ageMonths: assessment?.ageMonths ?? null,
    unavailableSince: null,
  };
  if (ok) return diagnostic;

  const carried = Number(previous?.unavailableSince);
  diagnostic.unavailableSince = previous?.ok === false && Number.isFinite(carried) && carried > 0
    ? carried
    : nowMs;
  return diagnostic;
}
