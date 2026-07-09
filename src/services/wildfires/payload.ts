export interface FireDetectionCountResponse {
  fireDetections: readonly unknown[];
  pagination?: {
    totalCount?: number;
  };
}

export function resolveFireDetectionTotalCount(response: FireDetectionCountResponse): number {
  const reportedTotal = Number(response.pagination?.totalCount);
  return Number.isFinite(reportedTotal) && reportedTotal >= response.fireDetections.length
    ? reportedTotal
    : response.fireDetections.length;
}
