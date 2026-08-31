/**
 * HTML that a JS-rendering crawler (Google) can actually read.
 *
 * Script, style, and noscript are discarded: Google executes JS and therefore
 * ignores <noscript>, and JSON-LD / CSS are not visible body copy. An earlier
 * /pro check stripped all tags at once and counted noscript as visible (#7458).
 */
export function crawlerVisibleHtml(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
}
