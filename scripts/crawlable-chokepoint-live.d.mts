import type { ChokepointStatusView } from './crawlable-live-tools.mjs';

export interface ChokepointPulse extends Omit<ChokepointStatusView, 'fetchedAt'> {
  navigationalWarningsAvailable: boolean;
  aisSnapshotAvailable: boolean;
  asOf: string;
}

export function chokepointPulseRecord(view: ChokepointStatusView): ChokepointPulse;

export function renderChokepointLiveSection(input: {
  chokepoint: { id: string; displayName: string };
  pulse: Partial<ChokepointPulse> | null;
  live?: boolean;
}): string;

export function replaceChokepointLiveSection(html: string, section: string): string | null;
