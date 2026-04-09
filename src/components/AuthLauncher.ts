import { openSignIn } from '@/services/clerk';

/**
 * Minimal auth launcher -- wraps Clerk.openSignIn().
 * Replaces the custom OTP modal. Clerk handles all UI.
 */
export class AuthLauncher {
  public open(): void {
    openSignIn();
  }

  public close(): void {
    // Clerk manages its own modal lifecycle
  }

  public destroy(): void {
    // Nothing to clean up -- Clerk manages its own resources
  }
}
