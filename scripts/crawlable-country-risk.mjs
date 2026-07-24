const REQUEST_TIMEOUT_MS = 8_000;
const MIN_VALID_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

const SCORE_BANDS = [
  { min: 81, label: 'Critical' },
  { min: 66, label: 'High' },
  { min: 51, label: 'Elevated' },
  { min: 31, label: 'Normal' },
  { min: 0, label: 'Low' },
];

const ADVISORY_LABELS = {
  'do-not-travel': 'Do Not Travel',
  reconsider: 'Reconsider Travel',
  caution: 'Exercise Increased Caution',
  normal: 'Exercise Normal Precautions',
  info: 'Information Only',
};

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
  }).format(value);
}

function humanizeToken(value) {
  return String(value || '')
    .trim()
    .replace(/^TREND_DIRECTION_/i, '')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function instabilityBand(score) {
  const numeric = finiteNumber(score);
  if (numeric === null || numeric < 0 || numeric > 100) return null;
  return SCORE_BANDS.find((band) => numeric >= band.min)?.label ?? null;
}

export function formatAdvisory(value) {
  const token = String(value || '').trim().toLowerCase();
  if (ADVISORY_LABELS[token]) return ADVISORY_LABELS[token];
  const normalized = humanizeToken(token);
  return normalized || 'Not present';
}

export function formatTrend(dynamicScore, trend) {
  const delta = finiteNumber(dynamicScore);
  if (delta !== null) {
    if (delta > 0) return `Rising +${formatNumber(delta)}`;
    if (delta < 0) return `Falling ${formatNumber(delta)}`;
  }

  const normalized = humanizeToken(trend);
  if (normalized && normalized !== 'Unspecified') return normalized;
  return 'Stable / unavailable';
}

export function liveRiskViewModel(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Country risk response is not an object');
  }
  if (payload.upstreamUnavailable === true) {
    throw new Error('Country risk upstream is temporarily unavailable');
  }

  const cii = payload.cii;
  const score = finiteNumber(cii?.combinedScore);
  const band = instabilityBand(score);
  if (score === null || band === null) {
    throw new Error('No current instability score is available for this country');
  }

  const sanctionsCount = Math.max(0, finiteNumber(payload.sanctionsCount) ?? 0);
  const timestamp = finiteNumber(payload.fetchedAt) ?? finiteNumber(cii?.computedAt);
  const hasValidTimestamp = timestamp !== null
    && timestamp >= MIN_VALID_TIMESTAMP_MS
    && timestamp <= now + MAX_FUTURE_SKEW_MS;

  return {
    score: formatNumber(score),
    band,
    trend: formatTrend(cii?.dynamicScore, cii?.trend),
    advisory: formatAdvisory(payload.advisoryLevel || cii?.advisoryLevel),
    sanctions: sanctionsCount > 0
      ? `${formatNumber(sanctionsCount, 0)} designated ${sanctionsCount === 1 ? 'entity' : 'entities'}`
      : payload.sanctionsActive
        ? 'Active designations'
        : 'None in feed',
    computedAt: hasValidTimestamp ? timestamp : null,
    methodologyVersion: String(cii?.methodologyVersion || '').trim(),
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      credentials: 'include',
    });
  } finally {
    clearTimeout(timer);
  }
}

async function mintAnonymousSession() {
  const response = await fetchWithTimeout('/api/wm-session', {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Anonymous session request failed (${response.status})`);
  }
}

async function requestCountryRisk(countryCode) {
  const url = `/api/intelligence/v1/get-country-risk?country_code=${encodeURIComponent(countryCode)}`;
  let response = await fetchWithTimeout(url);
  if (response.status === 401) {
    await mintAnonymousSession();
    response = await fetchWithTimeout(url);
  }
  if (!response.ok) {
    throw new Error(`Country risk request failed (${response.status})`);
  }
  return response.json();
}

function setText(tool, selector, value) {
  const element = tool.querySelector(selector);
  if (element) element.textContent = value;
}

function setState(tool, state, statusText) {
  tool.dataset.state = state;
  setText(tool, '[data-live-status]', statusText);
  const grid = tool.querySelector('[data-live-grid]');
  if (grid) grid.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  const refresh = tool.querySelector('[data-live-refresh]');
  if (refresh) refresh.disabled = state === 'loading';
}

function renderViewModel(tool, viewModel) {
  setText(tool, '[data-live-score]', viewModel.score);
  setText(tool, '[data-live-band]', viewModel.band);
  setText(tool, '[data-live-trend]', viewModel.trend);
  setText(tool, '[data-live-advisory]', viewModel.advisory);
  setText(tool, '[data-live-sanctions]', viewModel.sanctions);

  const updated = tool.querySelector('[data-live-updated]');
  if (updated) {
    const timestamp = viewModel.computedAt;
    const methodology = viewModel.methodologyVersion
      ? ` · methodology ${viewModel.methodologyVersion}`
      : '';
    if (timestamp) {
      const date = new Date(timestamp);
      updated.textContent = `Computed ${new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(date)}${methodology}`;
      updated.setAttribute('datetime', date.toISOString());
    } else {
      updated.textContent = `Computation time unavailable${methodology}`;
      updated.removeAttribute('datetime');
    }
  }

  setState(tool, 'ready', 'API result');
}

function renderError(tool) {
  setText(tool, '[data-live-score]', '—');
  setText(tool, '[data-live-band]', 'Unavailable');
  setText(tool, '[data-live-trend]', 'Unavailable');
  setText(tool, '[data-live-advisory]', 'Unavailable');
  setText(tool, '[data-live-sanctions]', 'Unavailable');
  setText(
    tool,
    '[data-live-updated]',
    'The live signal could not be loaded. The dated structural snapshot below remains available.',
  );
  setState(tool, 'error', 'Temporarily unavailable');
}

async function loadCountryRisk(tool) {
  const countryCode = String(tool.dataset.countryCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    renderError(tool);
    return;
  }

  setState(tool, 'loading', 'Connecting…');
  try {
    const payload = await requestCountryRisk(countryCode);
    renderViewModel(tool, liveRiskViewModel(payload));
  } catch {
    renderError(tool);
  }
}

export function initCountryRiskTools(root = document) {
  const tools = root.querySelectorAll('[data-live-country-risk]');
  for (const tool of tools) {
    const refresh = tool.querySelector('[data-live-refresh]');
    refresh?.addEventListener('click', () => loadCountryRisk(tool));
    void loadCountryRisk(tool);
  }
}

if (typeof document !== 'undefined') {
  initCountryRiskTools();
}
