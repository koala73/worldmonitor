// Strips the publisher byline a feed title carries, shared by the country brief
// server, the corpus publish gate and the dashboard context builder.

import { AGGREGATOR_LINK_HOSTS } from './article-url.js';

const BYLINE_SEPARATORS = [' - ', ' \u2013 ', ' \u2014 ', ' | '];

function isAggregatorUrl(url) {
  try {
    return AGGREGATOR_LINK_HOSTS.has(new URL(String(url ?? '')).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function withoutSourceByline(text, sourceName) {
  if (!sourceName) return text;
  for (const separator of BYLINE_SEPARATORS) {
    const byline = separator + sourceName;
    if (text.length > byline.length && text.slice(-byline.length).toLowerCase() === byline) {
      return text.slice(0, -byline.length).trim();
    }
  }
  return text;
}

// Google News titles end in " - <Publisher>", and some feeds append their own
// name. A model reads that byline as part of the story ("Kuwait's compliance
// oversight body" from "... pension fund - Compliance Week", #11217), and the
// name check would accept the publisher as a name the story states.
export function headlineWithoutPublisher(title, url, source) {
  const text = String(title ?? '').trim();
  const sourceName = String(source ?? '').trim().toLowerCase();
  const own = withoutSourceByline(text, sourceName);
  // A clipped title may have lost its byline, leaving a dash inside the headline last.
  if (own !== text || !isAggregatorUrl(url) || /(?:\.\.\.|\u2026)$/.test(text)) return own;
  const cut = text.lastIndexOf(' - ');
  // Google News can append a second label after the source ("- UNHCR - The UN Refugee Agency").
  return cut > 0 ? withoutSourceByline(text.slice(0, cut).trim(), sourceName) : text;
}
