export const WILDFIRE_DASHBOARD_DETECTION_LIMIT: number;

export function limitFireDetectionsForDashboard<T>(detections: T[], limit?: number): T[];

export function compactWildfireDashboardPayload<T>(value: T, limit?: number): T;
