import { compactWildfireDashboardPayload } from './_wildfire-dashboard.js';
import { compactNaturalEventsDashboardPayload } from './_natural-events-dashboard.js';

export function stripXFeedRestrictedFields(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  const { pollState: _pollState, ...rest } = value;
  if (!Array.isArray(rest.items)) return rest;
  return {
    ...rest,
    items: rest.items.map((item) => {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) return item;
      const { text: _text, ...itemRest } = item;
      return itemRest;
    }),
  };
}

// All bootstrap transports expose the same public payload shape.
export function sanitizeBootstrapValue(name, value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  if (name === 'forecasts') {
    const { enrichmentMeta: _internal, ...rest } = value;
    return rest;
  }
  if (name === 'xFeed') return stripXFeedRestrictedFields(value);
  if (name === 'wildfires') return compactWildfireDashboardPayload(value);
  if (name === 'naturalEvents') return compactNaturalEventsDashboardPayload(value);
  if (name === 'chokepoints' && Array.isArray(value.chokepoints)) {
    return { ...value, chokepoints: value.chokepoints.map(cp => cp?.transitSummary ? {
      ...cp,
      transitSummary: { ...cp.transitSummary, riskSummary: '', riskReportAction: '' },
    } : cp) };
  }
  return value;
}
