export interface SituationSection {
  readonly slug: string;
  readonly title: string;
  readonly statusPath: string;
  record(payload: unknown, now?: number): object;
  published(livePulse: object | null, context?: object): object | null;
  renderSection(reading: object | null, options: { live: boolean }): string;
}

export const SITUATION_PAGE_PATH: '/monitor-the-situation/';
export function situationMarker(section: Pick<SituationSection, 'slug'>): string;
export function situationReading(section: SituationSection, payload: unknown, now?: number): object | null;
export function situationSections(
  chokepointRegistry: readonly { id: string; displayName: string }[],
): readonly SituationSection[];
