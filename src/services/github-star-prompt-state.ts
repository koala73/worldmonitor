/**
 * Ask-once GitHub star prompt: storage and the eligibility decision.
 *
 * Modelled on T3 Code's `GitHubStarPrompt` (MIT). The rules:
 *   - Ask only from the 3rd distinct local day the dashboard is opened.
 *   - Ask at most once per page life, and only once the user has gone idle.
 *   - Any close (Star, ×) is permanent. A browser that cannot keep that record
 *     is never asked, because it could not keep the "never again" promise.
 *   - Never ask paying users or inside an iframe.
 *
 * This module is eager and tiny on purpose: it decides whether the controller
 * chunk is worth fetching at all.
 */

export const GITHUB_STAR_REPO_URL = 'https://github.com/koala73/worldmonitor';

// Separate keys so a visit count written by another tab can never undo a dismissal.
export const STAR_PROMPT_VISITS_KEY = 'wm-github-star-prompt:visits';
export const STAR_PROMPT_DISMISSED_KEY = 'wm-github-star-prompt:dismissed';
// Scratch key for the write probe; removed straight after.
export const STAR_PROMPT_PROBE_KEY = 'wm-github-star-prompt:probe';

export const VISIT_DAYS_BEFORE_ASKING = 3;
export const STAR_PROMPT_IDLE_MS = 30_000;

export type StarPromptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage, or null when the browser withholds it (null or throwing getter). */
export function starPromptStorage(): StarPromptStorage | null {
  try {
    return typeof localStorage !== 'undefined' && localStorage ? localStorage : null;
  } catch {
    return null;
  }
}

/** Local calendar day, YYYY-MM-DD. A visit at 23:59 and 00:01 counts as two days. */
export function localDayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

interface VisitLedger {
  days: number;
  lastDay: string;
}

function readLedger(storage: StarPromptStorage): VisitLedger | null {
  const raw = storage.getItem(STAR_PROMPT_VISITS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VisitLedger>;
    if (typeof parsed.days !== 'number' || !Number.isFinite(parsed.days) || parsed.days < 0) return null;
    if (typeof parsed.lastDay !== 'string') return null;
    return { days: Math.floor(parsed.days), lastDay: parsed.lastDay };
  } catch {
    return null;
  }
}

/**
 * Count today as a visit day if it is not already counted, and return the total.
 * Returns null when storage cannot be read, written, or read back.
 */
export function recordVisitDay(storage: StarPromptStorage | null, today: string): number | null {
  if (!storage) return null;
  try {
    const ledger = readLedger(storage);
    const next: VisitLedger = ledger?.lastDay === today
      ? ledger
      : { days: (ledger?.days ?? 0) + 1, lastDay: today };
    // Write even on a same-day visit: a browser that can still read an old
    // ledger but can no longer write (quota, blocked site data) could not keep
    // a dismissal either, so it must not be asked.
    storage.setItem(STAR_PROMPT_VISITS_KEY, JSON.stringify(next));
    // Some browsers accept writes they drop (quota 0, blocked site data).
    return readLedger(storage)?.lastDay === today ? next.days : null;
  } catch {
    return null;
  }
}

/** True/false from storage; null when storage cannot be read. */
export function readStarPromptDismissed(storage: StarPromptStorage | null): boolean | null {
  if (!storage) return null;
  try {
    return storage.getItem(STAR_PROMPT_DISMISSED_KEY) === '1';
  } catch {
    return null;
  }
}

/**
 * True when a NEW key can be written and read back, so a dismissal will stick.
 *
 * Rewriting the existing visit ledger is not proof: at the storage quota an
 * overwrite of an existing key can succeed while adding a key throws, and the
 * dismissal key does not exist yet. Probe with a scratch key so the user's
 * own records are never overwritten.
 */
export function canPersistStarPromptDismissal(storage: StarPromptStorage | null): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STAR_PROMPT_PROBE_KEY, '1');
    const ok = storage.getItem(STAR_PROMPT_PROBE_KEY) === '1';
    storage.removeItem(STAR_PROMPT_PROBE_KEY);
    return ok;
  } catch {
    return false;
  }
}

export function markStarPromptDismissed(storage: StarPromptStorage | null): void {
  try {
    storage?.setItem(STAR_PROMPT_DISMISSED_KEY, '1');
  } catch {
    /* best effort: the controller probes canPersistStarPromptDismissal before asking */
  }
}

export type StarPromptDecision =
  | 'ask'
  | 'in-iframe'
  | 'storage-unavailable'
  | 'dismissed'
  | 'too-early'
  | 'premium';

export interface StarPromptDecisionInput {
  inIframe: boolean;
  /** From `readStarPromptDismissed`; null = unreadable storage. */
  dismissed: boolean | null;
  /** From `recordVisitDay`; null = storage could not keep the count. */
  visitDays: number | null;
  /** Paying, or holding a premium key. Unknown at boot counts as false. */
  premium: boolean;
}

export function decideStarPrompt(input: StarPromptDecisionInput): StarPromptDecision {
  if (input.inIframe) return 'in-iframe';
  if (input.dismissed === null || input.visitDays === null) return 'storage-unavailable';
  if (input.dismissed) return 'dismissed';
  if (input.visitDays < VISIT_DAYS_BEFORE_ASKING) return 'too-early';
  if (input.premium) return 'premium';
  return 'ask';
}
