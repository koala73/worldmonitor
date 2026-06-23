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

function finiteOrDefault(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function linearRegression(values: number[]): { slope: number; intercept: number } {
  const count = values.length;
  if (count < 2) {
    return { slope: 0, intercept: finiteOrDefault(values[0]) };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let index = 0; index < count; index += 1) {
    const value = finiteOrDefault(values[index]);
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
    const actualValue = finiteOrDefault(actual[index]);
    const forecastValue = finiteOrDefault(forecast[index]);
    sumSquares += (actualValue - forecastValue) ** 2;
  }

  return Math.sqrt(sumSquares / count);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const safeDigits = Number.isFinite(digits) ? digits : 2;
  return Number(value.toFixed(safeDigits));
}

export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];

  const sanitized = values.map((value) => finiteOrDefault(value));
  const min = sanitized.reduce((smallest, value) => (value < smallest ? value : smallest), Infinity);
  const max = sanitized.reduce((largest, value) => (value > largest ? value : largest), -Infinity);
  const range = max - min;

  if (range === 0) {
    return values.map(() => 0.5);
  }

  return sanitized.map((value) => (value - min) / range);
}

export function cronbachAlpha(items: number[][]): number {
  if (items.length < 2 || !items[0] || items[0].length < 2) return 0;

  const observationCount = items.length;
  const itemCount = items[0].length;
  const itemVariances: number[] = [];

  for (let column = 0; column < itemCount; column += 1) {
    const sample = items.map((row) => finiteOrDefault(row[column]));
    const mean = sample.reduce((sum, value) => sum + value, 0) / observationCount;
    const variance = sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (observationCount - 1);
    itemVariances.push(variance);
  }

  const totalScores = items.map((row) => row.reduce((sum, value) => sum + finiteOrDefault(value), 0));
  const totalMean = totalScores.reduce((sum, value) => sum + value, 0) / observationCount;
  const totalVariance = totalScores.reduce((sum, value) => sum + (value - totalMean) ** 2, 0) / (observationCount - 1);

  if (totalVariance === 0) return 0;

  const sumItemVariances = itemVariances.reduce((sum, value) => sum + value, 0);
  return (itemCount / (itemCount - 1)) * (1 - sumItemVariances / totalVariance);
}

export function detectTrend(values: number[]): ResilienceTrendDirection {
  if (values.length < 3) return 'stable';
  if (values.some((value) => !Number.isFinite(value))) return 'stable';

  const { slope } = linearRegression(values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const normalizedSlope = mean === 0 ? 0 : slope / Math.abs(mean);

  if (normalizedSlope > TREND_THRESHOLD) return 'rising';
  if (normalizedSlope < -TREND_THRESHOLD) return 'falling';
  return 'stable';
}

export function detectChangepoints(values: number[], threshold = CHANGEPOINT_DEFAULT_THRESHOLD): number[] {
  if (values.length < 6) return [];
  if (values.some((value) => !Number.isFinite(value))) return [];

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return [];

  const changepoints: number[] = [];
  let positiveCusum = 0;
  let negativeCusum = 0;
  const slack = stdDev * 0.5;

  for (let index = 1; index < values.length; index += 1) {
    const normalizedValue = ((values[index] ?? 0) - mean) / stdDev;
    positiveCusum = Math.max(0, positiveCusum + normalizedValue - slack / stdDev);
    negativeCusum = Math.max(0, negativeCusum - normalizedValue - slack / stdDev);

    if (positiveCusum > threshold || negativeCusum > threshold) {
      changepoints.push(index);
      positiveCusum = 0;
      negativeCusum = 0;
    }
  }

  return changepoints;
}

export function exponentialSmoothing(values: number[], alpha = 0.3): number[] {
  if (values.length === 0) return [];

  const sanitized = values.map((value) => finiteOrDefault(value));
  const smoothingAlpha = Number.isFinite(alpha) ? alpha : 0.3;
  const smoothed = [sanitized[0] ?? 0];
  for (let index = 1; index < values.length; index += 1) {
    const current = sanitized[index] ?? 0;
    const previous = smoothed[index - 1] ?? current;
    smoothed.push(smoothingAlpha * current + (1 - smoothingAlpha) * previous);
  }

  return smoothed;
}

export function nrcForecast(
  history: number[],
  horizonDays: number,
  alpha = 0.3,
): ResilienceForecastResult {
  const finiteHistory = history.filter((value) => Number.isFinite(value));
  if (finiteHistory.length < 3) {
    const lastValue = clampScore(finiteHistory[finiteHistory.length - 1] ?? 50);
    return {
      values: Array.from({ length: horizonDays }, () => lastValue),
      confidenceIntervals: Array.from({ length: horizonDays }, () => ({
        lower: round(clampScore(lastValue * 0.9)),
        upper: round(clampScore(lastValue * 1.1)),
        level: 95,
      })),
      probabilityUp: 0.5,
      probabilityDown: 0.5,
    };
  }

  const smoothed = exponentialSmoothing(finiteHistory, alpha);
  const { slope } = linearRegression(finiteHistory);
  const baseline = smoothed[smoothed.length - 1] ?? finiteHistory[finiteHistory.length - 1] ?? 50;
  const modelError = rmse(finiteHistory, smoothed);
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
  const lastActual = finiteHistory[finiteHistory.length - 1] ?? baseline;
  const probabilityUp = lastForecast > lastActual
    ? Math.min(0.95, 0.5 + (lastForecast - lastActual) * 0.05)
    : Math.max(0.05, 0.5 - (lastActual - lastForecast) * 0.05);

  return {
    values,
    confidenceIntervals,
    probabilityUp: round(probabilityUp),
    probabilityDown: round(1 - round(probabilityUp)),
  };
}
