/**
 * 爱尔兰及欧洲科技峰会配置
 */

export interface Summit {
  id: string;
  name: string;
  date: string;           // ISO 8601 格式，如 "2026-05-15"
  endDate?: string;       // 结束日期
  location: string;       // 城市, 国家
  url: string;            // 官网链接
  description?: string;
  topics?: string[];      // 主题标签
  featured?: boolean;     // 是否高亮
}

/**
 * 爱尔兰及欧洲重要科技峰会
 * 手动维护，确保数据准确
 */
export const IRELAND_SUMMITS: Summit[] = [
  {
    id: 'dublin-tech-summit-2026',
    name: 'Dublin Tech Summit',
    date: '2026-05-15',
    endDate: '2026-05-16',
    location: 'Dublin, Ireland',
    url: 'https://dublintechsummit.tech/',
    description: "Ireland's flagship tech conference",
    topics: ['AI', 'Startups', 'FinTech', 'Future of Work'],
    featured: true,
  },
  {
    id: 'web-summit-2026',
    name: 'Web Summit',
    date: '2026-11-03',
    endDate: '2026-11-06',
    location: 'Lisbon, Portugal',
    url: 'https://websummit.com/',
    description: 'The largest tech conference in the world',
    topics: ['AI', 'Crypto', 'Climate', 'Startups'],
    featured: true,
  },
  {
    id: 'collision-2026',
    name: 'Collision',
    date: '2026-06-22',
    endDate: '2026-06-25',
    location: 'Toronto, Canada',
    url: 'https://collisionconf.com/',
    description: "North America's fastest growing tech conference",
    topics: ['Startups', 'Scale-ups', 'Enterprise'],
    featured: false,
  },
  {
    id: 'saastock-2026',
    name: 'SaaStock',
    date: '2026-10-14',
    endDate: '2026-10-16',
    location: 'Dublin, Ireland',
    url: 'https://www.saastock.com/',
    description: 'The SaaS conference for scaling companies',
    topics: ['SaaS', 'B2B', 'Scale-ups'],
    featured: true,
  },
  {
    id: 'tech-connect-live-2026',
    name: 'Tech Connect Live',
    date: '2026-09-24',
    endDate: '2026-09-25',
    location: 'Dublin, Ireland',
    url: 'https://www.techconnectlive.com/',
    description: 'Connecting tech talent and opportunity',
    topics: ['Careers', 'Innovation', 'Digital'],
    featured: false,
  },
];

/**
 * 获取即将举办的峰会（按日期排序）
 */
export function getUpcomingSummits(limit = 5): Summit[] {
  const now = new Date();
  return IRELAND_SUMMITS
    .filter(s => new Date(s.date) >= now)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, limit);
}

/**
 * 获取精选峰会
 */
export function getFeaturedSummits(): Summit[] {
  return IRELAND_SUMMITS.filter(s => s.featured);
}

/**
 * 格式化峰会日期显示
 */
export function formatSummitDate(summit: Summit): string {
  const start = new Date(summit.date);
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
  
  if (summit.endDate) {
    const end = new Date(summit.endDate);
    // 同月份
    if (start.getMonth() === end.getMonth()) {
      return `${start.getDate()}-${end.getDate()} ${start.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
    }
    return `${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`;
  }
  
  return start.toLocaleDateString('en-US', options);
}
