export interface ReplayWatchCountry {
  code: string;
  name: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  scenario: string;
  score: number;
}

export interface ReplayWatchSummary {
  criticalCount: number;
  highCount: number;
  watchedCountries: ReplayWatchCountry[];
}

export interface ReplayNarrative {
  severity: 'critical' | 'high' | 'medium' | 'low';
  headline: string;
  summary: string;
  bullets: string[];
}

const SEVERITY_SCORE: Record<ReplayWatchCountry['severity'], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function stableSeverity(summary: ReplayWatchSummary | null | undefined): ReplayNarrative['severity'] {
  if (!summary) return 'low';
  if (summary.criticalCount > 0) return 'critical';
  if (summary.highCount > 1) return 'high';
  if (summary.highCount > 0 || summary.watchedCountries.some((country) => country.severity === 'medium')) return 'medium';
  return 'low';
}

export function buildReplayNarrative(
  current: ReplayWatchSummary | null | undefined,
  previous?: ReplayWatchSummary | null,
  timestamp?: number,
): ReplayNarrative {
  if (!current) {
    return {
      severity: 'low',
      headline: 'Replay unavailable',
      summary: 'No replay summary was captured for this snapshot.',
      bullets: ['Historical watchlist data was not saved for this moment.'],
    };
  }

  const previousByCode = new Map((previous?.watchedCountries ?? []).map((country) => [country.code, country]));
  const newCritical = current.watchedCountries.filter((country) => {
    if (country.severity !== 'critical') return false;
    const previousCountry = previousByCode.get(country.code);
    return previousCountry?.severity !== 'critical';
  });

  const scenarioChanges = current.watchedCountries
    .map((country) => {
      const previousCountry = previousByCode.get(country.code);
      if (!previousCountry || previousCountry.scenario === country.scenario) return null;
      return `${country.name} shifted from ${previousCountry.scenario.replace(/-/g, ' ')} to ${country.scenario.replace(/-/g, ' ')}`;
    })
    .filter((line): line is string => Boolean(line));

  const criticalDelta = current.criticalCount - (previous?.criticalCount ?? 0);
  const highDelta = current.highCount - (previous?.highCount ?? 0);

  let headline = 'Watchlist holding steady';
  let severity = stableSeverity(current);

  if (criticalDelta > 0 || newCritical.length > 0) {
    headline = 'Critical escalation detected';
    severity = 'critical';
  } else if (current.criticalCount > 0) {
    headline = 'Critical watchlist remains active';
    severity = 'critical';
  } else if (highDelta > 0 || scenarioChanges.length > 0) {
    headline = 'Escalation is building across the watchlist';
    severity = current.highCount > 1 ? 'high' : 'medium';
  }

  const bullets: string[] = [];
  if (newCritical.length > 0) {
    bullets.push(`New critical countries: ${newCritical.map((country) => country.name).join(', ')}`);
  }
  bullets.push(...scenarioChanges);

  const topCountries = [...current.watchedCountries]
    // eslint-disable-next-line unicorn/no-array-sort
    .sort((a, b) => SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity] || b.score - a.score)
    .slice(0, 3);

  if (topCountries.length > 0) {
    const topWatchSummary = topCountries
      .map((country) => `${country.name} (${country.scenario.replace(/-/g, ' ')})`)
      .join(' • ');
    bullets.push(`Top watch: ${topWatchSummary}`);
  }

  if (criticalDelta === 0 && highDelta === 0 && bullets.length === 0) {
    bullets.push('The watchlist profile is stable relative to the prior snapshot.');
  }

  return {
    severity,
    headline,
    summary: typeof timestamp === 'number'
      ? `${current.criticalCount} critical and ${current.highCount} high watchlist countries are active in this snapshot (${new Date(timestamp).toISOString()}).`
      : `${current.criticalCount} critical and ${current.highCount} high watchlist countries are active in this snapshot.`,
    bullets,
  };
}
