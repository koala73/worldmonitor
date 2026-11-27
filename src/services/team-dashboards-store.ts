import {
  teamDashboardErrorKind,
  type TeamDashboardLayout,
  type TeamDashboardLink,
  type TeamDashboards,
} from '@/services/team-dashboards';

export interface TeamDashboardsStoreDeps {
  load(userId: string): Promise<TeamDashboards | null>;
  /** Called when the list shown to the user may have changed. */
  onChange(): void;
  /** Run `run` after `ms`; returns a cancel function. Defaults to setTimeout. */
  schedule?(run: () => void, ms: number): () => void;
}

/** Waits before each automatic retry of a failed load. */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000] as const;

function defaultSchedule(run: () => void, ms: number): () => void {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
}

/**
 * The signed-in user's team dashboards, and the loads that fetch them.
 *
 * - A load belongs to the user who started it; a later user never reuses it,
 *   and its result is dropped once someone else is signed in.
 * - `reload({ fresh: true })` after a write starts a new load, and an older
 *   load that finishes later cannot overwrite it.
 * - The Team button stays hidden until a load finds a team, so a user with no
 *   team, or whose last load failed, is asked again on each access pass
 *   (`setPrincipal` with the same user): they may have just joined a team.
 * - A failed load also retries on its own a few times, backing off.
 */
export class TeamDashboardsStore {
  private principal: string | null = null;
  private data: TeamDashboards | null = null;
  private inflight: { userId: string; promise: Promise<void> } | null = null;
  private generation = 0;
  private settled: 'none' | 'loaded' | 'failed' = 'none';
  private retries = 0;
  private cancelRetry: (() => void) | null = null;
  private readonly schedule: (run: () => void, ms: number) => () => void;

  constructor(private readonly deps: TeamDashboardsStoreDeps) {
    this.schedule = deps.schedule ?? defaultSchedule;
  }

  get userId(): string | null {
    return this.principal;
  }

  get dashboards(): TeamDashboards | null {
    return this.data;
  }

  setPrincipal(userId: string | null): void {
    if (userId === this.principal) {
      const askAgain = this.settled === 'failed' || (this.settled === 'loaded' && this.data === null);
      if (userId && askAgain && !this.inflight) {
        this.retries = 0;
        void this.reload();
      }
      return;
    }
    this.clearRetry();
    this.principal = userId;
    this.data = null;
    this.settled = 'none';
    this.retries = 0;
    this.inflight = null;
    this.generation += 1;
    this.deps.onChange();
    if (userId) void this.reload();
  }

  reload({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
    const userId = this.principal;
    if (!userId) return Promise.resolve();
    if (this.inflight && !fresh) return this.inflight.promise;

    this.clearRetry();
    const generation = ++this.generation;
    const current = () => generation === this.generation && this.principal === userId;
    const promise = this.deps.load(userId)
      .then((result) => {
        if (!current()) return;
        this.data = result;
        this.settled = 'loaded';
        this.retries = 0;
        this.deps.onChange();
      })
      .catch((err: unknown) => {
        if (!current()) return;
        this.settled = 'failed';
        // Keep what was shown; retry later, and on the next pass.
        console.warn('[TeamDashboards] Failed to load team dashboards:', err);
        this.scheduleRetry();
      })
      .finally(() => {
        if (this.inflight?.promise === promise) this.inflight = null;
      });
    this.inflight = { userId, promise };
    return promise;
  }

  private scheduleRetry(): void {
    const delay = RETRY_DELAYS_MS[this.retries];
    if (delay === undefined) return;
    this.retries += 1;
    const userId = this.principal;
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = null;
      if (this.principal === userId && this.settled === 'failed' && !this.inflight) void this.reload();
    }, delay);
  }

  private clearRetry(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
  }
}

type PublishArgs = { name: string; layout: TeamDashboardLayout; dashboardId?: string; baseVersion?: number };

/**
 * Publish a tab. When its link points at a dashboard a teammate has removed
 * since this browser last loaded the list, share it as a new dashboard.
 */
export async function publishOrShareAsNew(
  publish: (args: PublishArgs) => Promise<TeamDashboardLink>,
  args: PublishArgs,
): Promise<TeamDashboardLink> {
  try {
    return await publish(args);
  } catch (err) {
    if (!args.dashboardId || teamDashboardErrorKind(err) !== 'DASHBOARD_NOT_FOUND') throw err;
    return publish({ name: args.name, layout: args.layout });
  }
}
