export interface SignalQualityInput {
  sourceCount: number;
  isAlert: boolean;
  sourceTier?: number;
  threatLevel?: string;
  velocity?: { sourcesPerHour: number; level: string; trend?: string };
  countryCode?: string | null;
}

export interface SignalQuality {
  confidence: number;
  intensity: number;
  expectationGap: number;
  timeliness: number;
  composite: number;
  tier: 'strong' | 'notable' | 'weak' | 'noise';
}

export type WeightProfile = 'default' | 'risk' | 'macro' | 'shortTerm';

const WEIGHTS: Record<WeightProfile, [number, number, number, number]> = {
  default:   [0.35, 0.30, 0.20, 0.15],
  risk:      [0.45, 0.25, 0.20, 0.10],
  macro:     [0.25, 0.40, 0.20, 0.15],
  shortTerm: [0.30, 0.25, 0.20, 0.25],
};

export function normalizeThreatLevel(level: string | undefined): number {
  switch (level?.toLowerCase()) {
    case 'critical':  return 1.0;
    case 'high':      return 0.75;
    case 'elevated':  return 0.55;
    case 'moderate':
    case 'medium':    return 0.4;
    case 'low':       return 0.2;
    case 'info':      return 0.1;
    default:          return 0.3;
  }
}

export function computeISQ(
  input: SignalQualityInput,
  focalPointFn: (code: string) => { focalScore: number; urgency: string } | null,
  ciiScoreFn: (code: string) => number | null,
  isFocalDataAvailableFn: () => boolean,
  profile: WeightProfile = 'default',
): SignalQuality {
  const [wConf, wIntensity, wGap, wTime] = WEIGHTS[profile];

  const confidence = Math.min(1, (
    (input.sourceCount >= 3 ? 1.0 : input.sourceCount === 2 ? 0.7 : 0.4) +
    (input.isAlert ? 0.2 : 0) +
    ((input.sourceTier !== undefined && input.sourceTier <= 2) ? 0.1 : 0)
  ));

  const threatNorm = normalizeThreatLevel(input.threatLevel);
  let focalScore = 0;
  let ciiScore = 0;
  const fp = input.countryCode ? focalPointFn(input.countryCode) : null;
  if (fp) focalScore = fp.focalScore / 100;
  if (input.countryCode) {
    const cii = ciiScoreFn(input.countryCode);
    if (cii !== null) ciiScore = cii / 100;
  }
  const intensity = Math.max(threatNorm, focalScore, ciiScore);

  let expectationGap: number;
  if (!input.countryCode) {
    expectationGap = 0.5;
  } else if (fp !== null) {
    expectationGap = 0.4;
  } else if (isFocalDataAvailableFn()) {
    expectationGap = 0.8;
  } else {
    expectationGap = 0.5;
  }

  const velLevel = input.velocity?.level ?? 'normal';
  let timeliness = velLevel === 'spike' ? 1.0 : velLevel === 'elevated' ? 0.6 : 0.2;
  if (input.velocity?.trend === 'rising') {
    timeliness = Math.min(1.0, timeliness + 0.2);
  }

  const composite = wConf * confidence + wIntensity * intensity + wGap * expectationGap + wTime * timeliness;

  const tier: SignalQuality['tier'] =
    composite >= 0.75 ? 'strong' :
    composite >= 0.50 ? 'notable' :
    composite >= 0.25 ? 'weak' : 'noise';

  return { confidence, intensity, expectationGap, timeliness, composite, tier };
}
