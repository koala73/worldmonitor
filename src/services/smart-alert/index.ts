/**
 * Smart Alert Service
 *
 * Provides keyword-based news alert matching and notification.
 * Uses Upstash Redis for storage.
 */

export { AlertMatcher } from './alert-matcher';
export { AlertStorage } from './alert-storage';
export type * from '@/types/smart-alert';
