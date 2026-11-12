import { safeStorageGet } from '@/utils/safe-storage';

/**
 * Last verified "signed in with a paid plan" answer from the desktop main
 * window. `desktop-cloud-auth.ts` keeps it in step with the account; the
 * settings window reads it because it has no Clerk session of its own and
 * shares the main window's origin (and so its localStorage).
 *
 * Kept in its own module so the settings window does not pull in the
 * entitlement and auth graph just to read one flag.
 */
export const DESKTOP_CLOUD_ACCESS_HINT_KEY = 'wm-desktop-cloud-access';

export function hasDesktopCloudAccessHint(): boolean {
  return safeStorageGet(DESKTOP_CLOUD_ACCESS_HINT_KEY) === '1';
}
