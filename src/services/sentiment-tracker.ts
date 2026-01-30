// Social Media Sentiment Tracking Service
// Tracks sentiment shifts in monitored countries for early warning
// Uses keyword analysis and basic NLP for sentiment scoring

export interface SentimentData {
  country: string;
  sentimentScore: number;  // -100 (negative) to +100 (positive)
  volume: number;
  trend: 'rising' | 'falling' | 'stable';
  topKeywords: string[];
  alertLevel: 'normal' | 'elevated' | 'critical';
  lastUpdated: Date;
}

export interface SentimentAlert {
  country: string;
  type: 'spike' | 'drop' | 'keyword';
  message: string;
  severity: 'info' | 'warning' | 'critical';
  timestamp: Date;
}

// Monitored countries with their primary languages/keywords
const MONITORED_COUNTRIES: Record<string, {
  keywords: string[];
  alerts: string[];
}> = {
  'United States': {
    keywords: ['trump', 'biden', 'economy', 'inflation', 'immigration', 'healthcare'],
    alerts: ['protest', 'election', 'strike', 'crisis']
  },
  'Russia': {
    keywords: ['путин', 'война', 'экономика', 'санкции', 'армия'],
    alerts: ['мобилизация', 'протест', 'война', 'кризис']
  },
  'Ukraine': {
    keywords: ['війна', 'россия', 'помощь', 'фронт', 'оккупация'],
    alerts: ['атака', 'обстрел', 'мобилизация', 'гуманитарная']
  },
  'Iran': {
    keywords: ['تحریم', 'مذاکره', 'هسته‌ای', 'اسرائیل', 'نفت'],
    alerts: ['اعتراض', 'حمله', 'جنگ', 'موشک']
  },
  'Israel': {
    keywords: ['מלחמה', 'חמאס', 'עזה', 'לבנון', 'איראן'],
    alerts: ['התקפה', 'מלחמה', 'פגיעה', 'פינוי']
  },
  'China': {
    keywords: ['经济', '美国', '贸易', '台湾', '疫情'],
    alerts: ['抗议', '封锁', '战争', '危机']
  },
  'Turkey': {
    keywords: ['ekonomi', 'enflasyon', 'savaş', 'mrk', 'erdoğan'],
    alerts: ['protesto', 'deprem', 'kriz', 'savaş']
  },
  'Saudi Arabia': {
    keywords: ['اقتصاد', 'نفط', 'امريکا', 'ايران', 'سياحة'],
    alerts: ['هجوم', 'صراع', 'اقتصاد']
  },
};

// Demo sentiment data
function generateDemoSentiment(country: string): SentimentData {
  const config = MONITORED_COUNTRIES[country];
  const baseScore = Math.floor(Math.random() * 60) - 30;  // -30 to +30
  const volume = Math.floor(Math.random() * 50000) + 10000;
  
  const trendOptions: ('rising' | 'falling' | 'stable')[] = ['rising', 'falling', 'stable'];
  const trend = trendOptions[Math.floor(Math.random() * 3)];
  
  let alertLevel: SentimentData['alertLevel'] = 'normal';
  if (Math.abs(baseScore) > 50) alertLevel = 'critical';
  else if (Math.abs(baseScore) > 25) alertLevel = 'elevated';

  return {
    country,
    sentimentScore: baseScore,
    volume,
    trend,
    topKeywords: config?.keywords.slice(0, 5) || [],
    alertLevel,
    lastUpdated: new Date(),
  };
}

// Fetch sentiment for a specific country
export async function fetchSentiment(country: string): Promise<SentimentData> {
  // In production, this would call Twitter API, sentiment APIs, or scrape social media
  // For now, return demo data
  return generateDemoSentiment(country);
}

// Fetch sentiment for all monitored countries
export async function fetchAllSentiment(): Promise<SentimentData[]> {
  const results: SentimentData[] = [];
  
  for (const country of Object.keys(MONITORED_COUNTRIES)) {
    results.push(await fetchSentiment(country));
  }
  
  // Sort by volume (most discussed first)
  return results.sort((a, b) => b.volume - a.volume);
}

// Detect sentiment anomalies (sudden shifts)
export async function detectSentimentAnomaly(): Promise<SentimentAlert[]> {
  const alerts: SentimentAlert[] = [];
  const allSentiment = await fetchAllSentiment();
  
  for (const data of allSentiment) {
    // Alert if sentiment is extremely negative
    if (data.sentimentScore < -60) {
      alerts.push({
        country: data.country,
        type: 'drop',
        message: `Extremely negative sentiment detected (${data.sentimentScore})`,
        severity: 'critical',
        timestamp: new Date(),
      });
    }
    // Alert if sentiment is rapidly dropping
    else if (data.sentimentScore < -30 && data.trend === 'falling') {
      alerts.push({
        country: data.country,
        type: 'drop',
        message: `Sentiment trending negative in ${data.country}`,
        severity: 'warning',
        timestamp: new Date(),
      });
    }
    // Check for alert keywords in top keywords
    const config = MONITORED_COUNTRIES[data.country];
    if (config) {
      for (const alertKeyword of config.alerts) {
        if (data.topKeywords.includes(alertKeyword)) {
          alerts.push({
            country: data.country,
            type: 'keyword',
            message: `Alert keyword "${alertKeyword}" trending in ${data.country}`,
            severity: 'info',
            timestamp: new Date(),
          });
        }
      }
    }
  }
  
  return alerts;
}

// Convert sentiment to threat signal format
export function sentimentToThreatSignal(data: SentimentData): object {
  return {
    type: 'sentiment_shift',
    title: `Sentiment Alert: ${data.country}`,
    description: `Score: ${data.sentimentScore} | Volume: ${data.volume.toLocaleString()} | Trend: ${data.trend}`,
    severity: data.alertLevel === 'critical' ? 'high' : data.alertLevel === 'elevated' ? 'medium' : 'low',
    data: {
      country: data.country,
      sentimentScore: data.sentimentScore,
      volume: data.volume,
      trend: data.trend,
      topKeywords: data.topKeywords,
    },
    timestamp: new Date(),
  };
}

// Get list of monitored countries
export function getMonitoredCountries(): string[] {
  return Object.keys(MONITORED_COUNTRIES);
}

// Get sentiment summary for dashboard
export async function getSentimentSummary(): Promise<{
  totalVolume: number;
  avgSentiment: number;
  criticalCountries: string[];
  alerts: SentimentAlert[];
}> {
  const allSentiment = await fetchAllSentiment();
  const alerts = await detectSentimentAnomaly();
  
  const totalVolume = allSentiment.reduce((sum, s) => sum + s.volume, 0);
  const avgSentiment = Math.round(
    allSentiment.reduce((sum, s) => sum + s.sentimentScore, 0) / allSentiment.length
  );
  const criticalCountries = allSentiment
    .filter(s => s.alertLevel === 'critical')
    .map(s => s.country);
  
  return { totalVolume, avgSentiment, criticalCountries, alerts };
}
