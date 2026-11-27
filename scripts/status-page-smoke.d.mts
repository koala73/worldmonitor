import type { Browser, Page } from '@playwright/test';

type UptimeFigures = Record<'Last 24 hours' | 'Last 7 days' | 'Last 30 days' | 'Last 90 days', string>;

export function validateUptime(entries: Array<{ label?: string; value?: string }>): UptimeFigures;
export function checkStatusPage(page: Page, options?: { timeout?: number }): Promise<UptimeFigures>;

type StatusAttempt = {
  number: number;
  checkedAt: string;
  outcome: 'passed' | 'failed';
  figures?: UptimeFigures;
  error?: string;
  durationMs: number;
  events: Array<{ elapsedMs: number; type: string; url?: string; status?: number; error?: string }>;
  pendingRequests: string[];
  evidenceErrors: string[];
};
export function monitorStatusPage(browser: Browser, options?: {
  url?: string;
  directory?: string;
  timeout?: number;
  retryDelayMs?: number;
}): Promise<{ outcome: 'healthy' | 'recovered' | 'failed'; attempts: StatusAttempt[] }>;
