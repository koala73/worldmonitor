/**
 * Site-link markup for the dashboard Settings surface (#10461).
 *
 * After the compact footer dropped the full nav row, Settings is the desktop
 * one-tap host for the same crawlable destinations the mobile More menu already
 * lists. Lives in `utils/` so components can render it without importing `app/`.
 */
import { escapeHtml } from './sanitize';
import {
  DASHBOARD_EXTERNAL_SITE_LINKS,
  DASHBOARD_REFERENCE_LINKS,
} from '../config/dashboard-reference-links';

export function dashboardSiteLinksHtml(origin: string): string {
  const base = origin.replace(/\/$/, '');
  const reference = DASHBOARD_REFERENCE_LINKS.map(({ label, path }) => (
    `<a class="dashboard-site-links-item" href="${escapeHtml(`${base}${path}`)}"`
    + ` target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
  )).join('');
  const pricing = `<a class="dashboard-site-links-item" href="${escapeHtml(`${base}/pro#pricing`)}"`
    + ` target="_blank" rel="noopener noreferrer">Pricing</a>`;
  const external = DASHBOARD_EXTERNAL_SITE_LINKS.map(({ label, href }) => (
    `<a class="dashboard-site-links-item" href="${escapeHtml(href)}"`
    + ` target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
  )).join('');
  return `<nav aria-label="World Monitor site" class="dashboard-site-links-row">`
    + `${reference}${pricing}${external}</nav>`;
}

/** Shared anchor HTML for the mobile More menu and any other shell host. */
export function dashboardReferenceAnchorsHtml(originPrefix: string): string {
  return DASHBOARD_REFERENCE_LINKS.map(({ label, path }) => {
    const href = `${originPrefix}${path}`;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  }).join('');
}
