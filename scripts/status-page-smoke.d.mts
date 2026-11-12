import type { Page } from '@playwright/test';

type UptimeFigures = Record<'Last 24 hours' | 'Last 7 days' | 'Last 30 days' | 'Last 90 days', string>;

export function validateUptime(entries: Array<{ label?: string; value?: string }>): UptimeFigures;
export function checkStatusPage(page: Page, options?: { timeout?: number }): Promise<UptimeFigures>;
