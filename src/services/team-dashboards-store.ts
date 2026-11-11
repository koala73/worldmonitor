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
}

/**
 * The signed-in user's team dashboards, and the loads that fetch them.
 *
 * - A load belongs to the user who started it; a later user never reuses it,
 *   and its result is dropped once someone else is signed in.
 * - `reload({ fresh: true })` after a write starts a new load, and an older
 *   load that finishes later cannot overwrite it.
 * - A failed load is retried on the next `setPrincipal` pass for the same
 *   user, since the Team button stays hidden until a load succeeds.
 */
export class TeamDashboardsStore {
  private principal: string | null = null;
  private data: TeamDashboards | null = null;
  private inflight: { userId: string; promise: Promise<void> } | null = null;
  private generation = 0;
  private failed = false;

  constructor(private readonly deps: TeamDashboardsStoreDeps) {}

  get userId(): string | null {
    return this.principal;
  }

  get dashboards(): TeamDashboards | null {
    return this.data;
  }

  setPrincipal(userId: string | null): void {
    if (userId === this.principal) {
      if (userId && this.failed && !this.inflight) void this.reload();
      return;
    }
    this.principal = userId;
    this.data = null;
    this.failed = false;
    this.inflight = null;
    this.generation += 1;
    this.deps.onChange();
    if (userId) void this.reload();
  }

  reload({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
    const userId = this.principal;
    if (!userId) return Promise.resolve();
    if (this.inflight && !fresh) return this.inflight.promise;

    const generation = ++this.generation;
    const current = () => generation === this.generation && this.principal === userId;
    const promise = this.deps.load(userId)
      .then((result) => {
        if (!current()) return;
        this.data = result;
        this.failed = false;
        this.deps.onChange();
      })
      .catch((err: unknown) => {
        if (!current()) return;
        this.failed = true;
        // Keep what was shown; the next pass asks again.
        console.warn('[TeamDashboards] Failed to load team dashboards:', err);
      })
      .finally(() => {
        if (this.inflight?.promise === promise) this.inflight = null;
      });
    this.inflight = { userId, promise };
    return promise;
  }
}

type PublishArgs = { name: string; layout: TeamDashboardLayout; dashboardId?: string };

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
