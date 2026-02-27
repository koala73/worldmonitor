/**
 * Celebration Service
 *
 * Wraps canvas-confetti with milestone detection for species recovery
 * announcements, renewable energy records, and similar positive breakthroughs.
 *
 * Design: "Warm, not birthday party" -- moderate particle counts (40-80),
 * nature-inspired colors (greens, golds, blues), session-level deduplication
 * so celebrations feel special, not repetitive.
 *
 * Respects prefers-reduced-motion: no animations when that media query matches.
 *
 * Loads confetti at runtime via CDN when the canvas-confetti package is not
 * in node_modules (e.g. after clone without npm install). Uses a single cached
 * promise so only one script tag is ever appended even when celebrate() is
 * called multiple times in quick succession (e.g. record type calls run() twice).
 */

// ---- Types ----

type ConfettiFn = (opts: {
  particleCount: number;
  spread: number;
  origin: { y: number };
  colors: string[];
  disableForReducedMotion: boolean;
}) => void;

export interface MilestoneData {
  speciesRecoveries?: Array<{ name: string; status: string }>;
  renewablePercent?: number;
  newSpeciesCount?: number;
}

// ---- Constants ----

/** Checked once at module load -- if user prefers reduced motion, skip all celebrations. */
const REDUCED_MOTION = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

/** Nature-inspired warm palette matching the happy theme. */
const WARM_COLORS = ['#6B8F5E', '#C4A35A', '#7BA5C4', '#8BAF7A', '#E8B96E', '#7FC4C4'];

/** Session-level dedup set. Stores milestone keys that have already been celebrated this session. */
const celebrated = new Set<string>();

/** Cached promise for loading confetti from CDN so we never append more than one script tag. */
let confettiLoadPromise: Promise<ConfettiFn | null> | null = null;

/**
 * Load confetti from CDN at runtime. Returns the same promise for every call so
 * multiple celebrate() calls (e.g. record type with two bursts 300ms apart) share
 * one script load and only one script tag is appended.
 */
function loadConfetti(): Promise<ConfettiFn | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const w = window as Window & { confetti?: ConfettiFn };
  if (typeof w.confetti === 'function') return Promise.resolve(w.confetti);
  if (confettiLoadPromise !== null) return confettiLoadPromise;
  confettiLoadPromise = new Promise<ConfettiFn | null>((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.4/dist/canvas-confetti.min.js';
    script.async = true;
    script.onload = () => (typeof w.confetti === 'function' ? resolve(w.confetti!) : resolve(null));
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return confettiLoadPromise;
}

// ---- Public API ----

/**
 * Fire a confetti celebration with warm, nature-inspired colors.
 *
 * @param type - 'milestone' for species recovery (40 particles, single burst),
 *               'record' for renewable energy records (80 particles, double burst).
 */
export function celebrate(type: 'milestone' | 'record' = 'milestone'): void {
  if (REDUCED_MOTION) return;

  const run = (opts: { particleCount: number; spread: number; origin: { y: number }; colors: string[] }) => {
    void loadConfetti().then((confetti) => {
      if (confetti) confetti({ ...opts, disableForReducedMotion: true });
    });
  };

  if (type === 'milestone') {
    run({ particleCount: 40, spread: 60, origin: { y: 0.7 }, colors: WARM_COLORS });
  } else {
    run({ particleCount: 80, spread: 90, origin: { y: 0.6 }, colors: WARM_COLORS });
    setTimeout(() => {
      run({ particleCount: 80, spread: 90, origin: { y: 0.6 }, colors: WARM_COLORS });
    }, 300);
  }
}

/**
 * Check data for milestone events and fire a celebration if a new one is found.
 *
 * Only fires ONE celebration per call (first matching milestone wins) to prevent
 * multiple confetti bursts overlapping. Session dedup (Set in memory) ensures
 * the same milestone is never celebrated twice in a single browser session.
 */
export function checkMilestones(data: MilestoneData): void {
  // --- Species recovery milestone ---
  if (data.speciesRecoveries) {
    for (const species of data.speciesRecoveries) {
      const status = species.status.toLowerCase();
      if (status === 'recovered' || status === 'stabilized') {
        const key = `species:${species.name}`;
        if (!celebrated.has(key)) {
          celebrated.add(key);
          celebrate('milestone');
          return; // one celebration per call
        }
      }
    }
  }

  // --- Renewable energy record (every 5% threshold) ---
  if (data.renewablePercent != null && data.renewablePercent > 0) {
    const threshold = Math.floor(data.renewablePercent / 5) * 5;
    const key = `renewable:${threshold}`;
    if (!celebrated.has(key)) {
      celebrated.add(key);
      celebrate('record');
      return;
    }
  }

  // --- New species count ---
  if (data.newSpeciesCount != null && data.newSpeciesCount > 0) {
    const key = `species-count:${data.newSpeciesCount}`;
    if (!celebrated.has(key)) {
      celebrated.add(key);
      celebrate('milestone');
      return;
    }
  }
}

/**
 * Clear the celebrated set. Exported for testing purposes.
 */
export function resetCelebrations(): void {
  celebrated.clear();
}
