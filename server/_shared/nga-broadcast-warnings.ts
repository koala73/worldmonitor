export interface NgaBroadcastWarning {
  msgYear: string | number;
  msgNumber: string | number;
  navArea: string | number;
  subregion: string | number;
  text: string;
  issueDate: string;
  authority: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNumber(value: unknown): string | number {
  return typeof value === 'string' || typeof value === 'number' ? value : '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseNgaBroadcastWarnings(data: unknown): NgaBroadcastWarning[] | null {
  const rawWarnings = Array.isArray(data)
    ? data
    : isRecord(data)
      ? data['broadcast-warn'] ?? data.broadcast_warn ?? data.warnings
      : null;

  if (!Array.isArray(rawWarnings) || rawWarnings.some((warning) => !isRecord(warning))) {
    return null;
  }

  return rawWarnings.map((warning) => ({
    msgYear: stringOrNumber(warning.msgYear),
    msgNumber: stringOrNumber(warning.msgNumber),
    navArea: stringOrNumber(warning.navArea),
    subregion: stringOrNumber(warning.subregion),
    text: stringValue(warning.text),
    issueDate: stringValue(warning.issueDate),
    authority: stringValue(warning.authority),
  }));
}
