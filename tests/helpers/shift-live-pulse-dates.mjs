// Coherent date-shifting for crawlable live-pulse snapshots (#7533).
//
// Every clock in a pulse must move by the same delta or downstream validators
// reject it: the chokepoint/CII validators compare each `asOf`/`asOfMs` against
// the pulse's own `capturedAtMs` +/- a skew window, and 6-digit microseconds
// break `Date.parse`. A naive string replace of the date produces four
// unrelated validation failures. This helper shifts the whole document at once:
//
//   - `YYYY-MM-DD` strings -> shifted calendar dates
//   - `YYYY-MM-DDTHH:MM:SS(.mmm)?(Z|±hh:mm)` strings -> shifted instants,
//     re-emitted at millisecond precision in UTC (never microseconds)
//   - numeric epoch-millisecond values -> shifted by the same delta
//   - everything else (prose, month labels like `2026-08`, repo paths,
//     scores) -> untouched
//
// Month labels and prose stay fixed on purpose: they are content, not clocks.
export function shiftLivePulseDates(pulse, deltaDays) {
  const deltaMs = deltaDays * 86_400_000;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const DATETIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;
  // Dates before 2020 are content (founding years, historical references),
  // not epoch milliseconds; the cutoff keeps scores and small counters safe.
  const MS_CUTOFF = Date.UTC(2020, 0, 1);

  // toISOString() is already millisecond-precision UTC; never microseconds.
  const fmtUtcMs = (ms) => new Date(ms).toISOString();
  const shift = (value) => {
    if (Array.isArray(value)) return value.map(shift);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shift(entry)]));
    }
    if (typeof value === 'string') {
      if (DATE.test(value)) return new Date(Date.parse(`${value}T00:00:00Z`) + deltaMs).toISOString().slice(0, 10);
      if (DATETIME.test(value)) return fmtUtcMs(Date.parse(value) + deltaMs);
      return value;
    }
    if ((typeof value === 'number' && Number.isFinite(value)) && value > MS_CUTOFF) {
      return value + deltaMs;
    }
    return value;
  };
  return shift(pulse);
}
