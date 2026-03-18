export interface CorridorRiskEntry {
  riskLevel: string;
  incidentCount7d: number;
  disruptionPct: number;
  riskSummary: string;
  riskReportAction: string;
}

export interface CorridorRiskData {
  [chokepointId: string]: CorridorRiskEntry;
}
