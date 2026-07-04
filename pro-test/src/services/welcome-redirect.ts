import { DASHBOARD_PATH } from '../routes';
import { hasLiveSessionJwt } from './clerk-session';

export interface WelcomeRedirectLocation {
  search: string;
  hash: string;
  replace(target: string): void;
}

export function welcomeDashboardRedirectTarget(location: Pick<WelcomeRedirectLocation, 'search' | 'hash'>): string {
  return `${DASHBOARD_PATH}${location.search}${location.hash}`;
}

export function maybeRedirectWelcomeVisitor(
  cookieHeader: string,
  location: WelcomeRedirectLocation
): boolean {
  if (!hasLiveSessionJwt(cookieHeader)) return false;
  location.replace(welcomeDashboardRedirectTarget(location));
  return true;
}
