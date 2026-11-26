import type { SocialUnrestEvent } from '@/types';

// GDELT rows are unverified media mentions of a place, not observed events.
export const isVerifiedUnrestEvent = (p: SocialUnrestEvent): boolean => p.sourceType !== 'gdelt';
