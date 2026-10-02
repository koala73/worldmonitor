import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { TIER_DOCS_PATH } from '../../server/_shared/source-tiers';

/**
 * The tier table, absolute on the web origin: the desktop WebView and a saved
 * Deep Dive report both resolve a root-relative link against an origin that
 * hosts no docs.
 */
export const TIER_DOCS_HREF = `${WEB_APP_ORIGIN}${TIER_DOCS_PATH}`;
