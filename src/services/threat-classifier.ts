// Stub: module removed in REITs-only variant
/* eslint-disable @typescript-eslint/no-explicit-any */

export const THREAT_PRIORITY: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
export function classifyByKeyword(..._args: any[]): any { return { level: 'info', category: 'unknown', confidence: 0, source: 'keyword' }; }
export function classifyWithAI(..._args: any[]): Promise<any> { return Promise.resolve(null); }
