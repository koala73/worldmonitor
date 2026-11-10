export interface NgaBroadcastWarning {
  msgYear: string | number;
  msgNumber: string | number;
  navArea: string | number;
  subregion: string | number;
  text: string;
  issueDate: string;
  authority: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNumber(value: unknown): string | number {
  return typeof value === 'string' || typeof value === 'number' ? value : '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseNgaBroadcastWarnings(data: unknown): NgaBroadcastWarning[] | null {
  const rawWarnings = Array.isArray(data)
    ? data
    : isRecord(data)
      ? data['broadcast-warn'] ?? data.broadcast_warn ?? data.warnings
      : null;

  if (!Array.isArray(rawWarnings) || rawWarnings.some((warning) => !isRecord(warning))) {
    return null;
  }

  return rawWarnings.map((warning) => ({
    msgYear: stringOrNumber(warning.msgYear),
    msgNumber: stringOrNumber(warning.msgNumber),
    navArea: stringOrNumber(warning.navArea),
    subregion: stringOrNumber(warning.subregion),
    text: stringValue(warning.text),
    issueDate: stringValue(warning.issueDate),
    authority: stringValue(warning.authority),
  }));
}

export const NGA_BROADCAST_WARN_URL = 'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A';

// During MSI portal maintenance every /api/publications path returns a 503
// apology page, but that page still serves the daily in-force memoranda for
// the same five areas the broadcast-warn API covers.
const NGA_DAILY_MEMOS = [
  { file: 'DailyMemIV.txt', navArea: '4', authority: 'NAVAREA IV' },
  { file: 'DailyMemXII.txt', navArea: '12', authority: 'NAVAREA XII' },
  { file: 'DailyMemLAN.txt', navArea: 'A', authority: 'HYDROLANT' },
  { file: 'DailyMemPAC.txt', navArea: 'P', authority: 'HYDROPAC' },
  { file: 'DailyMemARC.txt', navArea: 'C', authority: 'HYDROARC' },
] as const;
// A line that opens a memo notice in any configured area: its bare authority,
// a warning id, a date-time group, or a legacy MSGID preamble.
const MEMO_NOTICE_START_RE = new RegExp(
  `^(?:(?:${NGA_DAILY_MEMOS.map(({ authority }) => authority).join('|')})(?: \\d+/\\d{2}(?:\\(\\w+\\))?\\.?)?|MSGID/.*)$`,
);

function startsMemoNotice(line: string): boolean {
  const trimmed = line.trim();
  return MEMO_NOTICE_START_RE.test(trimmed) || parseDtg(trimmed) !== null;
}

export const NGA_DAILY_MEMO_URLS =NGA_DAILY_MEMOS.map(({ file }) => `https://msi.nga.mil/apology_objects/${file}`);

// NGA republishes the memoranda on weekdays; four days spans a weekend without
// presenting a frozen outage snapshot as the current in-force list.
export const NGA_DAILY_MEMO_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};
const DTG_RE = /^(\d{2})(\d{2})(\d{2})Z ([A-Z]{3}) (\d{2})$/;

function parseDtg(value: string): { ms: number; issueDate: string } | null {
  const m = value.match(DTG_RE);
  const month = m ? MONTHS[m[4]!] : undefined;
  if (!m || month === undefined) return null;
  const year = 2000 + Number(m[5]);
  const ms = Date.UTC(year, month, Number(m[1]), Number(m[2]), Number(m[3]));
  // Same "DDHHMMZ MON YYYY" shape the broadcast-warn API returns.
  return Number.isNaN(ms) ? null : { ms, issueDate: `${m[1]}${m[2]}${m[3]}Z ${m[4]} ${year}` };
}

/**
 * Parse one NGA daily in-force memorandum into broadcast-warn records.
 * Returns null unless the text is the expected area's memo, as of `nowMs`
 * minus at most NGA_DAILY_MEMO_MAX_AGE_MS.
 */
export function parseNgaDailyMemo(
  text: string,
  navArea: string,
  authority: string,
  nowMs: number = Date.now(),
): NgaBroadcastWarning[] | null {
  const lines = text.replace(/\r/g, '').split('\n');
  const headerIndex = lines.findIndex((line) => line.trim() !== '');
  const header = lines[headerIndex]?.trim().match(/^(.+) IN FORCE AS OF (\d{6}Z [A-Z]{3} \d{2})\.$/);
  const asOf = header ? parseDtg(header[2]!) : null;
  if (!header || header[1] !== authority || !asOf) return null;
  if (asOf.ms > nowMs + 60 * 60 * 1000 || nowMs - asOf.ms > NGA_DAILY_MEMO_MAX_AGE_MS) return null;

  const idRe = new RegExp(`^${authority} (\\d+)/(\\d{2})(?:\\((\\w+)\\))?\\.?$`);
  const inForceSummaryRe = new RegExp(`^1\\. ${authority} WARNINGS IN FORCE AS OF \\d{6}Z [A-Z]{3}\\.?$`);
  const warnings: NgaBroadcastWarning[] = [];
  const blocks = lines.slice(headerIndex + 1).join('\n').split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const blockLines = block.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
    if (blockLines.length === 0 || /^To receive Broadcast Warning messages/.test(blockLines[0]!)) continue;
    // A warning names itself within its first three lines: after a date-time
    // group, or after the MSGID/RMKS preamble on undated legacy notices.
    // The area's own in-force summary (Sentry WORLDMONITOR-1C4): a dated
    // block whose id line is the bare authority and whose body indexes the
    // warning numbers already listed. It names no hazard, so skip it; any
    // other bare-authority block still fails the memo below. A line that
    // starts another notice inside the summary (a date-time group, a legacy
    // MSGID preamble, or any area's bare authority or warning id) means its
    // blank separator is missing; skipping the block would drop that notice,
    // so the memo fails instead.
    const bareIndex = blockLines.slice(0, 2).findIndex((line) => line.trim() === authority);
    if (bareIndex >= 0 && inForceSummaryRe.test(blockLines[bareIndex + 1]?.trim() ?? '')) {
      if (blockLines.slice(bareIndex + 1).some(startsMemoNotice)) return null;
      continue;
    }
    const idIndex = blockLines.slice(0, 3).findIndex((line) => idRe.test(line.trim()));
    // An unrecognized block means the format changed or the file is
    // truncated; a partial list would read as fewer hazards.
    if (idIndex < 0) return null;
    const id = blockLines[idIndex]!.trim().match(idRe)!;
    const dtg = idIndex > 0 ? parseDtg(blockLines[idIndex - 1]!.trim()) : null;
    warnings.push({
      msgYear: 2000 + Number(id[2]),
      msgNumber: Number(id[1]),
      navArea,
      subregion: id[3] ?? '',
      text: blockLines.slice(idIndex + 1).join('\n'),
      issueDate: dtg?.issueDate ?? '',
      authority: '',
    });
  }
  // Every area carries standing notices, so an empty memo is a broken read.
  return warnings.length > 0 ? warnings : null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function fetchText(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<string | null> {
  try {
    const res = await fetchImpl(url, init);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * Active NGA broadcast warnings from the broadcast-warn API, or from the daily
 * memoranda when the API is down. Null when neither yields a complete set:
 * a partial set would report areas it never read as quiet.
 */
export async function fetchNgaBroadcastWarnings(options: {
  userAgent: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  nowMs?: number;
}): Promise<NgaBroadcastWarning[] | null> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  // timeoutMs bounds the whole call, so callers' outer deadlines still hold.
  // The API gets half of it, leaving the memoranda time after an API hang.
  const deadline = AbortSignal.timeout(options.timeoutMs);
  try {
    const res = await fetchImpl(NGA_BROADCAST_WARN_URL, {
      headers: { Accept: 'application/json', 'User-Agent': options.userAgent },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(Math.floor(options.timeoutMs / 2))]),
    });
    if (res.ok) {
      const parsed = parseNgaBroadcastWarnings(await res.json());
      if (parsed !== null) return parsed;
    }
  } catch {
    // Fall through to the memoranda.
  }

  const init = { headers: { Accept: 'text/plain', 'User-Agent': options.userAgent }, signal: deadline };
  const texts = await Promise.all(NGA_DAILY_MEMO_URLS.map((url) => fetchText(fetchImpl, url, init)));
  const warnings: NgaBroadcastWarning[] = [];
  for (const [index, memo] of NGA_DAILY_MEMOS.entries()) {
    const text = texts[index];
    const parsed = text == null ? null : parseNgaDailyMemo(text, memo.navArea, memo.authority, options.nowMs);
    if (parsed === null) return null;
    warnings.push(...parsed);
  }
  console.warn(`[nga] broadcast-warn API unavailable; using daily memoranda (${warnings.length} warnings)`);
  return warnings;
}
