export type EntityType = 'company' | 'index' | 'commodity' | 'crypto' | 'sector' | 'country';

export interface EntityEntry {
  id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  keywords: string[];
  sector?: string;
  related?: string[];
}

export const ENTITY_REGISTRY: EntityEntry[] = [
  // ============================================================================
  // INDICES
  // ============================================================================
  {
    id: '^GSPC',
    type: 'index',
    name: 'S&P 500',
    aliases: ['s&p', 's&p 500', 'sp500', 'spx', 'spy'],
    keywords: ['market', 'stocks', 'wall street', 'equities'],
    related: ['^DJI', '^IXIC'],
  },
  {
    id: '^DJI',
    type: 'index',
    name: 'Dow Jones',
    aliases: ['dow', 'dow jones', 'djia', 'dow 30'],
    keywords: ['blue chip', 'industrials', 'market'],
    related: ['^GSPC', '^IXIC'],
  },
  {
    id: '^IXIC',
    type: 'index',
    name: 'NASDAQ',
    aliases: ['nasdaq', 'nasdaq composite', 'qqq', 'tech index'],
    keywords: ['tech stocks', 'growth', 'technology'],
    related: ['^GSPC', 'XLK'],
  },

  // ============================================================================
  // TECH COMPANIES
  // ============================================================================
  {
    id: 'AAPL',
    type: 'company',
    name: 'Apple Inc.',
    aliases: ['apple', 'aapl', 'tim cook', 'iphone', 'ipad', 'mac'],
    keywords: ['iphone', 'ios', 'app store', 'macbook', 'vision pro', 'services', 'wearables'],
    sector: 'Technology',
    related: ['MSFT', 'GOOGL', 'TSM'],
  },
  {
    id: 'MSFT',
    type: 'company',
    name: 'Microsoft Corporation',
    aliases: ['microsoft', 'msft', 'satya nadella', 'windows', 'azure', 'xbox'],
    keywords: ['azure', 'cloud', 'windows', 'office', 'copilot', 'openai', 'teams', 'github'],
    sector: 'Technology',
    related: ['AAPL', 'GOOGL', 'AMZN', 'NVDA'],
  },
  {
    id: 'NVDA',
    type: 'company',
    name: 'NVIDIA Corporation',
    aliases: ['nvidia', 'nvda', 'jensen huang', 'geforce'],
    keywords: ['gpu', 'ai chip', 'datacenter', 'cuda', 'h100', 'blackwell', 'artificial intelligence', 'gaming', 'graphics'],
    sector: 'Technology',
    related: ['AMD', 'TSM', 'AVGO', 'INTC', 'MSFT'],
  },
  {
    id: 'GOOGL',
    type: 'company',
    name: 'Alphabet Inc.',
    aliases: ['google', 'alphabet', 'googl', 'goog', 'sundar pichai', 'youtube'],
    keywords: ['search', 'ads', 'android', 'chrome', 'gemini', 'waymo', 'cloud', 'ai'],
    sector: 'Technology',
    related: ['META', 'MSFT', 'AAPL', 'AMZN'],
  },
  {
    id: 'AMZN',
    type: 'company',
    name: 'Amazon.com Inc.',
    aliases: ['amazon', 'amzn', 'aws', 'andy jassy', 'jeff bezos', 'prime'],
    keywords: ['ecommerce', 'cloud', 'aws', 'prime', 'alexa', 'warehouse', 'logistics', 'retail'],
    sector: 'Technology',
    related: ['MSFT', 'GOOGL', 'WMT', 'COST'],
  },
  {
    id: 'META',
    type: 'company',
    name: 'Meta Platforms Inc.',
    aliases: ['meta', 'facebook', 'fb', 'mark zuckerberg', 'zuckerberg', 'instagram', 'whatsapp'],
    keywords: ['social media', 'metaverse', 'vr', 'reels', 'advertising', 'llama', 'ai'],
    sector: 'Technology',
    related: ['GOOGL', 'SNAP', 'PINS'],
  },
  {
    id: 'TSM',
    type: 'company',
    name: 'Taiwan Semiconductor',
    aliases: ['tsmc', 'tsm', 'taiwan semi', 'taiwan semiconductor'],
    keywords: ['chip', 'foundry', 'semiconductor', 'fab', 'wafer', 'node', 'nanometer', 'taiwan'],
    sector: 'Technology',
    related: ['NVDA', 'AMD', 'AAPL', 'AVGO', 'INTC'],
  },
  {
    id: 'AVGO',
    type: 'company',
    name: 'Broadcom Inc.',
    aliases: ['broadcom', 'avgo', 'avago', 'hock tan'],
    keywords: ['chip', 'semiconductor', 'wireless', '5g', 'networking', 'infrastructure', 'vmware', 'enterprise'],
    sector: 'Technology',
    related: ['NVDA', 'QCOM', 'TSM', 'INTC'],
  },
  {
    id: 'ORCL',
    type: 'company',
    name: 'Oracle Corporation',
    aliases: ['oracle', 'orcl', 'larry ellison', 'ellison'],
    keywords: ['database', 'cloud', 'enterprise', 'java', 'erp', 'saas'],
    sector: 'Technology',
    related: ['MSFT', 'SAP', 'CRM'],
  },
  {
    id: 'NFLX',
    type: 'company',
    name: 'Netflix Inc.',
    aliases: ['netflix', 'nflx'],
    keywords: ['streaming', 'entertainment', 'movies', 'series', 'subscription', 'content'],
    sector: 'Technology',
    related: ['DIS', 'WBD', 'PARA'],
  },

  // ============================================================================
  // DEFENSE & AEROSPACE
  // ============================================================================
  {
    id: 'LMT',
    type: 'company',
    name: 'Lockheed Martin',
    aliases: ['lockheed', 'lockheed martin', 'lmt', 'skunk works'],
    keywords: ['f-35', 'defense', 'missile', 'aerospace', 'himars', 'javeline'],
    sector: 'Defense',
    related: ['RTX', 'NOC', 'GD', 'BA'],
  },
  {
    id: 'RTX',
    type: 'company',
    name: 'RTX Corp',
    aliases: ['raytheon', 'rtx', 'pratt & whitney', 'collins aerospace'],
    keywords: ['missile', 'patriot', 'defense', 'radar', 'engine'],
    sector: 'Defense',
    related: ['LMT', 'NOC', 'GD'],
  },
  {
    id: 'NOC',
    type: 'company',
    name: 'Northrop Grumman',
    aliases: ['northrop', 'northrop grumman', 'noc'],
    keywords: ['b-21', 'bomber', 'space', 'defense', 'drone'],
    sector: 'Defense',
    related: ['LMT', 'RTX', 'L3H'],
  },
  {
    id: 'BA',
    type: 'company',
    name: 'Boeing',
    aliases: ['boeing', 'ba'],
    keywords: ['airplane', '737 max', 'defense', 'space', 'starliner'],
    sector: 'Defense',
    related: ['AIR.PA', 'LMT'],
  },
  {
    id: 'GD',
    type: 'company',
    name: 'General Dynamics',
    aliases: ['general dynamics', 'gd'],
    keywords: ['submarine', 'tank', 'abrams', 'gulfstream', 'defense'],
    sector: 'Defense',
    related: ['LMT', 'HII'],
  },
  {
    id: 'RHM.DE',
    type: 'company',
    name: 'Rheinmetall AG',
    aliases: ['rheinmetall', 'rhm'],
    keywords: ['tank', 'leopard', 'ammunition', 'defense', 'germany'],
    sector: 'Defense',
    related: ['KMW', 'BAE.L'],
  },
  {
    id: 'AIR.PA',
    type: 'company',
    name: 'Airbus SE',
    aliases: ['airbus', 'eads'],
    keywords: ['airplane', 'defense', 'helicopter', 'space', 'europe'],
    sector: 'Defense',
    related: ['BA', 'SAF.PA'],
  },

  // ============================================================================
  // SEMICONDUCTORS & CRITICAL TECH (GLOBAL)
  // ============================================================================
  {
    id: 'ASML',
    type: 'company',
    name: 'ASML Holding',
    aliases: ['asml'],
    keywords: ['lithography', 'euv', 'duv', 'chip equipment', 'semiconductor'],
    sector: 'Technology',
    related: ['TSM', 'INTC', 'SAMSUNG'],
  },
  {
    id: '005930.KS',
    type: 'company',
    name: 'Samsung Electronics',
    aliases: ['samsung', 'samsung electronics'],
    keywords: ['memory', 'chip', 'phone', 'display', 'foundry'],
    sector: 'Technology',
    related: ['SK hynix', 'AAPL', 'TSM'],
  },

  // ============================================================================
  // CRITICAL MINERALS
  // ============================================================================
  {
    id: 'ALB',
    type: 'company',
    name: 'Albemarle',
    aliases: ['albemarle', 'alb'],
    keywords: ['lithium', 'battery', 'ev', 'mining'],
    sector: 'Materials',
    related: ['SQM', 'TSLA'],
  },
  {
    id: 'SQM',
    type: 'company',
    name: 'SQM',
    aliases: ['sqm', 'sociedad quimica'],
    keywords: ['lithium', 'chile', 'mining', 'battery'],
    sector: 'Materials',
    related: ['ALB'],
  },
  {
    id: 'MP',
    type: 'company',
    name: 'MP Materials',
    aliases: ['mp materials', 'mountain pass'],
    keywords: ['rare earth', 'neodymium', 'magnet', 'mining', 'china alternative'],
    sector: 'Materials',
    related: ['ARE'],
  },
  {
    id: 'FCX',
    type: 'company',
    name: 'Freeport-McMoRan',
    aliases: ['freeport', 'fcx'],
    keywords: ['copper', 'gold', 'mining', 'indonesia', 'grasberg'],
    sector: 'Materials',
    related: ['SCCO', 'RIO'],
  },

  // ============================================================================
  // FINANCIAL SERVICES
  // ============================================================================
  {
    id: 'BRK-B',
    type: 'company',
    name: 'Berkshire Hathaway',
    aliases: ['berkshire', 'berkshire hathaway', 'brk', 'warren buffett', 'buffett', 'charlie munger'],
    keywords: ['insurance', 'investing', 'conglomerate', 'value'],
    sector: 'Finance',
    related: ['JPM', 'BAC', 'GS'],
  },
  {
    id: 'JPM',
    type: 'company',
    name: 'JPMorgan Chase',
    aliases: ['jpmorgan', 'jp morgan', 'jpm', 'chase', 'jamie dimon', 'dimon'],
    keywords: ['bank', 'banking', 'investment bank', 'credit', 'loans', 'interest rate'],
    sector: 'Finance',
    related: ['BAC', 'GS', 'MS', 'C'],
  },
  {
    id: 'V',
    type: 'company',
    name: 'Visa Inc.',
    aliases: ['visa'],
    keywords: ['payments', 'credit card', 'debit', 'transaction', 'fintech'],
    sector: 'Finance',
    related: ['MA', 'AXP', 'PYPL'],
  },
  {
    id: 'MA',
    type: 'company',
    name: 'Mastercard Inc.',
    aliases: ['mastercard', 'master card'],
    keywords: ['payments', 'credit card', 'debit', 'transaction', 'fintech'],
    sector: 'Finance',
    related: ['V', 'AXP', 'PYPL'],
  },
  {
    id: 'BAC',
    type: 'company',
    name: 'Bank of America',
    aliases: ['bank of america', 'bofa', 'bac', 'boa'],
    keywords: ['bank', 'banking', 'mortgage', 'loans', 'credit', 'interest rate'],
    sector: 'Finance',
    related: ['JPM', 'WFC', 'C'],
  },

  // ============================================================================
  // HEALTHCARE
  // ============================================================================
  {
    id: 'LLY',
    type: 'company',
    name: 'Eli Lilly',
    aliases: ['eli lilly', 'lilly', 'lly'],
    keywords: ['pharma', 'drug', 'ozempic', 'diabetes', 'obesity', 'weight loss', 'mounjaro', 'zepbound'],
    sector: 'Healthcare',
    related: ['NVO', 'PFE', 'MRK', 'JNJ'],
  },
  {
    id: 'UNH',
    type: 'company',
    name: 'UnitedHealth Group',
    aliases: ['unitedhealth', 'united health', 'unh', 'optum'],
    keywords: ['insurance', 'healthcare', 'managed care', 'medicare', 'medicaid'],
    sector: 'Healthcare',
    related: ['CVS', 'CI', 'HUM'],
  },
  {
    id: 'NVO',
    type: 'company',
    name: 'Novo Nordisk',
    aliases: ['novo nordisk', 'novo', 'nvo'],
    keywords: ['pharma', 'drug', 'ozempic', 'wegovy', 'diabetes', 'obesity', 'glp-1', 'weight loss'],
    sector: 'Healthcare',
    related: ['LLY', 'PFE', 'MRK'],
  },
  {
    id: 'JNJ',
    type: 'company',
    name: 'Johnson & Johnson',
    aliases: ['johnson johnson', 'j&j', 'jnj', 'johnson and johnson'],
    keywords: ['pharma', 'medical devices', 'consumer health', 'vaccine'],
    sector: 'Healthcare',
    related: ['PFE', 'MRK', 'ABT'],
  },

  // ============================================================================
  // ENERGY
  // ============================================================================
  {
    id: 'XOM',
    type: 'company',
    name: 'Exxon Mobil',
    aliases: ['exxon', 'exxonmobil', 'exxon mobil', 'xom', 'mobil'],
    keywords: ['oil', 'gas', 'drilling', 'refinery', 'petroleum', 'energy', 'fossil fuel'],
    sector: 'Energy',
    related: ['CVX', 'COP', 'CL=F'],
  },

  // ============================================================================
  // CONSUMER / RETAIL
  // ============================================================================
  {
    id: 'TSLA',
    type: 'company',
    name: 'Tesla Inc.',
    aliases: ['tesla', 'tsla', 'elon musk', 'musk'],
    keywords: ['ev', 'electric vehicle', 'battery', 'autopilot', 'fsd', 'robotaxi', 'energy storage', 'solar'],
    sector: 'Consumer',
    related: ['RIVN', 'LCID', 'F', 'GM'],
  },
  {
    id: 'WMT',
    type: 'company',
    name: 'Walmart Inc.',
    aliases: ['walmart', 'wmt', 'wal-mart'],
    keywords: ['retail', 'grocery', 'ecommerce', 'stores', 'consumer', 'discount'],
    sector: 'Consumer',
    related: ['COST', 'TGT', 'AMZN'],
  },
  {
    id: 'COST',
    type: 'company',
    name: 'Costco Wholesale',
    aliases: ['costco', 'cost'],
    keywords: ['retail', 'wholesale', 'membership', 'grocery', 'warehouse'],
    sector: 'Consumer',
    related: ['WMT', 'TGT', 'BJ'],
  },
  {
    id: 'HD',
    type: 'company',
    name: 'Home Depot',
    aliases: ['home depot', 'hd', 'homedepot'],
    keywords: ['retail', 'home improvement', 'construction', 'housing', 'diy'],
    sector: 'Consumer',
    related: ['LOW', 'WMT'],
  },
  {
    id: 'PG',
    type: 'company',
    name: 'Procter & Gamble',
    aliases: ['procter gamble', 'p&g', 'pg', 'procter & gamble', 'procter and gamble'],
    keywords: ['consumer goods', 'household', 'personal care', 'detergent', 'beauty'],
    sector: 'Consumer',
    related: ['KO', 'PEP', 'CL', 'UL'],
  },

  // ============================================================================
  // SECTORS (ETFs)
  // ============================================================================
  {
    id: 'XLK',
    type: 'sector',
    name: 'Technology Select Sector',
    aliases: ['tech sector', 'technology sector', 'xlk'],
    keywords: ['tech', 'software', 'hardware', 'it'],
    related: ['AAPL', 'MSFT', 'NVDA'],
  },
  {
    id: 'XLF',
    type: 'sector',
    name: 'Financial Select Sector',
    aliases: ['finance sector', 'financial sector', 'xlf', 'banks'],
    keywords: ['bank', 'insurance', 'financial'],
    related: ['JPM', 'BAC', 'V'],
  },
  {
    id: 'XLE',
    type: 'sector',
    name: 'Energy Select Sector',
    aliases: ['energy sector', 'xle', 'oil stocks'],
    keywords: ['oil', 'gas', 'energy', 'drilling'],
    related: ['XOM', 'CVX', 'CL=F'],
  },
  {
    id: 'XLV',
    type: 'sector',
    name: 'Health Care Select Sector',
    aliases: ['healthcare sector', 'health sector', 'xlv', 'pharma stocks'],
    keywords: ['pharma', 'biotech', 'healthcare', 'medical'],
    related: ['LLY', 'UNH', 'JNJ'],
  },
  {
    id: 'SMH',
    type: 'sector',
    name: 'Semiconductor ETF',
    aliases: ['semis', 'semiconductor sector', 'smh', 'chip stocks'],
    keywords: ['chip', 'semiconductor', 'foundry', 'fab'],
    related: ['NVDA', 'TSM', 'AVGO', 'AMD'],
  },

  // ============================================================================
  // COMMODITIES
  // ============================================================================
  {
    id: '^VIX',
    type: 'commodity',
    name: 'VIX Volatility Index',
    aliases: ['vix', 'fear index', 'volatility'],
    keywords: ['volatility', 'fear', 'uncertainty', 'hedging', 'options'],
    related: ['^GSPC'],
  },
  {
    id: 'GC=F',
    type: 'commodity',
    name: 'Gold Futures',
    aliases: ['gold', 'xau', 'bullion'],
    keywords: ['precious metal', 'safe haven', 'inflation hedge', 'bullion', 'jewelry'],
    related: ['SI=F', 'GLD'],
  },
  {
    id: 'CL=F',
    type: 'commodity',
    name: 'Crude Oil WTI',
    aliases: ['oil', 'crude', 'wti', 'crude oil', 'petroleum', 'brent'],
    keywords: ['opec', 'drilling', 'refinery', 'barrel', 'pipeline', 'energy', 'gasoline', 'fuel'],
    related: ['NG=F', 'XOM', 'CVX', 'XLE'],
  },
  {
    id: 'NG=F',
    type: 'commodity',
    name: 'Natural Gas Futures',
    aliases: ['natural gas', 'natgas', 'gas'],
    keywords: ['lng', 'pipeline', 'heating', 'energy', 'utility'],
    related: ['CL=F', 'XLE'],
  },
  {
    id: 'SI=F',
    type: 'commodity',
    name: 'Silver Futures',
    aliases: ['silver', 'xag'],
    keywords: ['precious metal', 'industrial metal', 'solar', 'electronics'],
    related: ['GC=F', 'HG=F'],
  },
  {
    id: 'HG=F',
    type: 'commodity',
    name: 'Copper Futures',
    aliases: ['copper'],
    keywords: ['industrial metal', 'construction', 'wiring', 'ev', 'infrastructure'],
    related: ['SI=F', 'GC=F'],
  },

  // ============================================================================
  // CRYPTO (IDs match CRYPTO_IDS in markets.ts)
  // ============================================================================
  {
    id: 'bitcoin',
    type: 'crypto',
    name: 'Bitcoin',
    aliases: ['bitcoin', 'btc', 'satoshi'],
    keywords: ['cryptocurrency', 'blockchain', 'digital currency', 'halving', 'btc mining'],
    related: ['ethereum', 'solana'],
  },
  {
    id: 'ethereum',
    type: 'crypto',
    name: 'Ethereum',
    aliases: ['ethereum', 'eth', 'ether', 'vitalik'],
    keywords: ['smart contract', 'defi', 'nft', 'blockchain', 'eth gas'],
    related: ['bitcoin', 'solana'],
  },
  {
    id: 'solana',
    type: 'crypto',
    name: 'Solana',
    aliases: ['solana', 'sol token'],
    keywords: ['blockchain', 'defi', 'nft', 'solana network'],
    related: ['bitcoin', 'ethereum'],
  },

  // ============================================================================
  // KEY COUNTRIES (for geopolitical correlation)
  // ============================================================================
  {
    id: 'CN',
    type: 'country',
    name: 'China',
    aliases: ['china', 'chinese', 'beijing', 'prc', 'xi jinping'],
    keywords: ['trade war', 'tariff', 'ccp', 'pla', 'taiwan strait', 'south china sea', 'yuan', 'rmb'],
    related: ['TW', 'TSM', 'BABA'],
  },
  {
    id: 'TW',
    type: 'country',
    name: 'Taiwan',
    aliases: ['taiwan', 'taiwanese', 'taipei', 'roc'],
    keywords: ['strait', 'semiconductor', 'chip', 'invasion', 'blockade'],
    related: ['CN', 'TSM', 'NVDA'],
  },
  {
    id: 'RU',
    type: 'country',
    name: 'Russia',
    aliases: ['russia', 'russian', 'moscow', 'kremlin', 'putin', 'vladimir putin'],
    keywords: ['sanctions', 'ukraine', 'war', 'gas', 'oil', 'nato', 'nuclear'],
    related: ['UA', 'CL=F', 'NG=F'],
  },
  {
    id: 'UA',
    type: 'country',
    name: 'Ukraine',
    aliases: ['ukraine', 'ukrainian', 'kyiv', 'kiev', 'zelenskyy', 'zelensky'],
    keywords: ['war', 'invasion', 'grain', 'nato', 'aid', 'defense'],
    related: ['RU', 'CL=F', 'GC=F'],
  },
  {
    id: 'IR',
    type: 'country',
    name: 'Iran',
    aliases: ['iran', 'iranian', 'tehran', 'khamenei', 'irgc'],
    keywords: ['sanctions', 'nuclear', 'oil', 'strait of hormuz', 'proxy', 'hezbollah', 'houthi'],
    related: ['IL', 'CL=F', 'SA'],
  },
  {
    id: 'IL',
    type: 'country',
    name: 'Israel',
    aliases: ['israel', 'israeli', 'tel aviv', 'jerusalem', 'netanyahu', 'idf'],
    keywords: ['gaza', 'hamas', 'hezbollah', 'iran', 'defense', 'war', 'middle east'],
    related: ['IR', 'CL=F'],
  },
  {
    id: 'SA',
    type: 'country',
    name: 'Saudi Arabia',
    aliases: ['saudi', 'saudi arabia', 'riyadh', 'mbs', 'aramco'],
    keywords: ['opec', 'oil', 'production', 'cut', 'crude', 'energy'],
    related: ['CL=F', 'IR', 'XOM'],
  },
  {
    id: 'AE',
    type: 'country',
    name: 'UAE',
    aliases: ['uae', 'united arab emirates', 'emirates', 'abu dhabi', 'dubai', 'mbz'],
    keywords: ['oil', 'trade', 'g42', 'ai', 'logistics', 'dp world'],
    related: ['SA', 'CL=F', 'MSFT'],
  },
  {
    id: 'QA',
    type: 'country',
    name: 'Qatar',
    aliases: ['qatar', 'doha', 'al thani'],
    keywords: ['lng', 'gas', 'mediator', 'hamas', 'al udeid', 'energy'],
    related: ['NG=F', 'XOM', 'US'],
  },
  {
    id: 'TR',
    type: 'country',
    name: 'Turkey',
    aliases: ['turkey', 'turkiye', 'erdogan', 'ankara'],
    keywords: ['nato', 'bosphorus', 'drone', 'bayraktar', 'kurds', 'lira'],
    related: ['RU', 'UA', 'RHM.DE'],
  },
  {
    id: 'EG',
    type: 'country',
    name: 'Egypt',
    aliases: ['egypt', 'cairo', 'sisi'],
    keywords: ['suez canal', 'gaza', 'rafah', 'imf', 'debt', 'tourism'],
    related: ['IL', 'SA', 'AE'],
  },
];

export function getEntityById(id: string): EntityEntry | undefined {
  return ENTITY_REGISTRY.find(e => e.id === id);
}
