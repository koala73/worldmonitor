export type ResilienceTrendDirection = 'rising' | 'stable' | 'falling';

export interface ResilienceConfidenceInterval {
  lower: number;
  upper: number;
  level: 95;
}

export interface ResilienceForecastResult {
  values: number[];
  confidenceIntervals: ResilienceConfidenceInterval[];
  probabilityUp: number;
  probabilityDown: number;
}

const TREND_THRESHOLD = 0.005;
const CHANGEPOINT_DEFAULT_THRESHOLD = 2.0;
const Z_95 = 1.96;

function linearRegression(values: number[]): { slope: number; intercept: number } {
  const count = values.length;
  if (count < 2) {
    return { slope: 0, intercept: values[0] ?? 0 };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let index = 0; index < count; index += 1) {
    const value = values[index] ?? 0;
    sumX += index;
    sumY += value;
    sumXY += index * value;
    sumX2 += index * index;
  }

  const denominator = count * sumX2 - sumX * sumX;
  if (denominator === 0) {
    return { slope: 0, intercept: sumY / count };
  }

  const slope = (count * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / count;
  return { slope, intercept };
}

function rmse(actual: number[], forecast: number[]): number {
  const count = Math.min(actual.length, forecast.length);
  if (count === 0) return 0;

  let sumSquares = 0;
  for (let index = 0; index < count; index += 1) {
    const actualValue = actual[index] ?? 0;
    const forecastValue = forecast[index] ?? 0;
    sumSquares += (actualValue - forecastValue) ** 2;
  }

  return Math.sqrt(sumSquares / count);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];

  const min = values.reduce((smallest, value) => (value < smallest ? value : smallest), Infinity);
  const max = values.reduce((largest, value) => (value > largest ? value : largest), -Infinity);
  const range = max - min;

  if (range === 0) {
    return values.map(() => 0.5);
  }

  return values.map((value) => (value - min) / range);
}

export function cronbachAlpha(observations: number[][]): number {
  if (observations.length < 2 || !observations[0] || observations[0].length < 2) return 0;
  if (observations.some((row) => row.length !== observations[0]!.length)) return 0;

  const observationCount = observations.length;
  const itemCount = observations[0].length;
  const itemVariances: number[] = [];

  for (let column = 0; column < itemCount; column += 1) {
    const sample = observations.map((row) => row[column] ?? 0);
    const mean = sample.reduce((sum, value) => sum + value, 0) / observationCount;
    const variance = sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (observationCount - 1);
    itemVariances.push(variance);
  }

  const totalScores = observations.map((row) => row.reduce((sum, value) => sum + value, 0));
  const totalMean = totalScores.reduce((sum, value) => sum + value, 0) / observationCount;
  const totalVariance = totalScores.reduce((sum, value) => sum + (value - totalMean) ** 2, 0) / (observationCount - 1);

  if (totalVariance === 0) return 0;

  const sumItemVariances = itemVariances.reduce((sum, value) => sum + value, 0);
  return (itemCount / (itemCount - 1)) * (1 - sumItemVariances / totalVariance);
}

export function detectTrend(values: number[]): ResilienceTrendDirection {
  if (values.length < 3) return 'stable';

  const { slope } = linearRegression(values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const normalizedSlope = mean === 0 ? 0 : slope / Math.abs(mean);

  if (normalizedSlope > TREND_THRESHOLD) return 'rising';
  if (normalizedSlope < -TREND_THRESHOLD) return 'falling';
  return 'stable';
}

export function detectChangepoints(values: number[], threshold = CHANGEPOINT_DEFAULT_THRESHOLD): number[] {
  if (values.length < 6) return [];

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return [];

  const changepoints: number[] = [];
  let positiveCusum = 0;
  let negativeCusum = 0;
  let positiveOnset = -1;
  let negativeOnset = -1;
  const CUSUM_SLACK = 0.25;

  for (let index = 1; index < values.length; index += 1) {
    const normalizedValue = ((values[index] ?? 0) - mean) / stdDev;

    const prevPositive = positiveCusum;
    positiveCusum = Math.max(0, positiveCusum + normalizedValue - CUSUM_SLACK);
    if (prevPositive === 0 && positiveCusum > 0) positiveOnset = index;

    const prevNegative = negativeCusum;
    negativeCusum = Math.max(0, negativeCusum - normalizedValue - CUSUM_SLACK);
    if (prevNegative === 0 && negativeCusum > 0) negativeOnset = index;

    if (positiveCusum > threshold) {
      const onset = positiveOnset >= 0 ? positiveOnset : index;
      if (onset >= 2) changepoints.push(onset);
      positiveCusum = 0;
      negativeCusum = 0;
      positiveOnset = -1;
      negativeOnset = -1;
    } else if (negativeCusum > threshold) {
      const onset = negativeOnset >= 0 ? negativeOnset : index;
      if (onset >= 2) changepoints.push(onset);
      positiveCusum = 0;
      negativeCusum = 0;
      positiveOnset = -1;
      negativeOnset = -1;
    }
  }

  return changepoints;
}

export function exponentialSmoothing(values: number[], alpha = 0.3): number[] {
  if (values.length === 0) return [];

  const smoothed = [values[0] ?? 0];
  for (let index = 1; index < values.length; index += 1) {
    const current = values[index] ?? 0;
    const previous = smoothed[index - 1] ?? current;
    smoothed.push(alpha * current + (1 - alpha) * previous);
  }

  return smoothed;
}

export function nrcForecast(
  history: number[],
  horizonDays: number,
  alpha = 0.3,
): ResilienceForecastResult {
  if (horizonDays < 1) {
    return { values: [], confidenceIntervals: [], probabilityUp: 0.5, probabilityDown: 0.5 };
  }

  if (history.length < 3) {
    const lastValue = clampScore(history[history.length - 1] ?? 50);
    return {
      values: Array.from({ length: horizonDays }, () => lastValue),
      confidenceIntervals: Array.from({ length: horizonDays }, () => {
        const halfWidth = Math.max(5, lastValue * 0.1);
        return {
          lower: round(clampScore(lastValue - halfWidth)),
          upper: round(clampScore(lastValue + halfWidth)),
          level: 95,
        };
      }),
      probabilityUp: 0.5,
      probabilityDown: 0.5,
    };
  }

  const smoothed = exponentialSmoothing(history, alpha);
  const { slope } = linearRegression(history);
  const baseline = smoothed[smoothed.length - 1] ?? history[history.length - 1] ?? 50;
  const modelError = rmse(history, smoothed);
  const values: number[] = [];
  const confidenceIntervals: ResilienceConfidenceInterval[] = [];

  for (let day = 1; day <= horizonDays; day += 1) {
    const projected = clampScore(baseline + slope * day);
    values.push(round(projected));

    const expandedError = modelError * Math.sqrt(day);
    const lower = clampScore(projected - Z_95 * expandedError);
    const upper = clampScore(projected + Z_95 * expandedError);
    confidenceIntervals.push({
      lower: round(lower),
      upper: round(upper),
      level: 95,
    });
  }

  const lastForecast = values[values.length - 1] ?? baseline;
  const lastActual = history[history.length - 1] ?? baseline;
  const delta = lastForecast - lastActual;
  const scale = Math.max(modelError, 1);
  const z = delta / scale;
  const probabilityUp = Math.min(0.95, Math.max(0.05, 0.5 + z * 0.15));

  return {
    values,
    confidenceIntervals,
    probabilityUp: round(probabilityUp),
    probabilityDown: round(1 - round(probabilityUp)),
  };
}
