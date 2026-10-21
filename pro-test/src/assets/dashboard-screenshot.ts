// Shared dashboard screenshot sources so every page serves the compressed
// AVIF/WebP variants (31-92KB). The JPG is only the <img> fallback for browsers
// with neither, so it is capped at the largest variant's 1280px (155KB, was a
// 334KB 2940px original that SEO audits flagged as the page's oversized image).
import dashboardScreenshotJpg from './worldmonitor-7-mar-2026.jpg';
import avif640 from './worldmonitor-7-mar-2026-640.avif';
import avif960 from './worldmonitor-7-mar-2026-960.avif';
import avif1280 from './worldmonitor-7-mar-2026-1280.avif';
import webp640 from './worldmonitor-7-mar-2026-640.webp';
import webp960 from './worldmonitor-7-mar-2026-960.webp';
import webp1280 from './worldmonitor-7-mar-2026-1280.webp';

export const DASHBOARD_SCREENSHOT_JPG = dashboardScreenshotJpg;
export const DASHBOARD_SCREENSHOT_WIDTH = 1280;
export const DASHBOARD_SCREENSHOT_HEIGHT = 832;
export const DASHBOARD_SCREENSHOT_AVIF_SRCSET = `${avif640} 640w, ${avif960} 960w, ${avif1280} 1280w`;
export const DASHBOARD_SCREENSHOT_WEBP_SRCSET = `${webp640} 640w, ${webp960} 960w, ${webp1280} 1280w`;
