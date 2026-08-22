const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeYmd(value: string | undefined): string | undefined {
  if (!value || !YMD_RE.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

export function resolveCalendarRange(
  requestedFrom: string | undefined,
  requestedTo: string | undefined,
  seededFrom: string | undefined,
  seededTo: string | undefined,
): { fromDate: string; toDate: string } {
  return {
    fromDate: normalizeYmd(requestedFrom) ?? normalizeYmd(seededFrom) ?? '',
    toDate: normalizeYmd(requestedTo) ?? normalizeYmd(seededTo) ?? '',
  };
}

export function filterCalendarRange<T>(
  rows: T[],
  range: { fromDate: string; toDate: string },
  getDate: (row: T) => string | undefined,
): T[] {
  return rows.filter((row) => {
    const date = normalizeYmd(getDate(row));
    if (!date) return false;
    if (range.fromDate && date < range.fromDate) return false;
    if (range.toDate && date > range.toDate) return false;
    return true;
  });
}
