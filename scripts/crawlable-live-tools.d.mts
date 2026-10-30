export interface ChokepointStatusView {
  disruptionScore: string;
  status: string;
  congestion: string | null;
  navigationalWarnings: string | null;
  aisDisruptions: string | null;
  description: string | null;
  officialLatestDate: string | null;
  officialLatestTotal: number | null;
  officialAvg7d: number | null;
  baselineAvgDaily: number | null;
  baselineFrom: string | null;
  baselineTo: string | null;
  weekMovement: string | null;
  fetchedAt: number;
  partial: boolean;
}

export function chokepointStatusViewModel(
  payload: unknown,
  chokepointId: string,
  now?: number,
): ChokepointStatusView;
