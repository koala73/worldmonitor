export const config = { runtime: 'edge' };
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { readJsonFromUpstash, setCachedData } from './_upstash-json.js';

// ─── Account list (sourced from india_defence_accounts.xlsx, 95 profiles) ───
const ACCOUNTS = [
  { handle: 'adgpi',            name: 'ADG PI (Indian Army)',           tier: 1 },
  { handle: 'IAF_MCC',          name: 'Indian Air Force',               tier: 1 },
  { handle: 'indiannavy',       name: 'Indian Navy',                    tier: 1 },
  { handle: 'SpokespersonMoD',  name: 'MoD Spokesperson',               tier: 1 },
  { handle: 'HQ_IDS_India',     name: 'HQ Integrated Defence Staff',    tier: 1 },
  { handle: 'NorthernComd_IA',  name: 'Northern Command IA',            tier: 1 },
  { handle: 'easterncomd',      name: 'Eastern Command IA',             tier: 1 },
  { handle: 'westerncomd_IA',   name: 'Western Command IA',             tier: 1 },
  { handle: 'IN_HQSNC',        name: 'Southern Naval Command',          tier: 1 },
  { handle: 'IN_WNC',           name: 'Western Naval Command',          tier: 1 },
  { handle: 'CISFHQrs',         name: 'CISF',                           tier: 1 },
  { handle: 'BSF_India',        name: 'Border Security Force',          tier: 1 },
  { handle: 'crpfindia',        name: 'CRPF India',                     tier: 1 },
  { handle: 'ITBP_official',    name: 'ITBP Official',                  tier: 1 },
  { handle: 'PIB_India',        name: 'PIB India',                      tier: 1 },
  { handle: 'PIB_Defence',      name: 'PIB Defence',                    tier: 1 },
  { handle: 'DefProdnIndia',    name: 'Dept of Defence Production',     tier: 1 },
  { handle: 'DRDO_India',       name: 'DRDO India',                     tier: 1 },
  { handle: 'HALHQBLR',         name: 'Hindustan Aeronautics Ltd',      tier: 1 },
  { handle: 'BharatForgeLtd',   name: 'Bharat Forge Ltd',               tier: 1 },
  { handle: 'ShivAroor',        name: 'Shiv Aroor (NDTV)',              tier: 2 },
  { handle: 'VishnuNDTV',       name: 'Vishnu Som (NDTV)',              tier: 2 },
  { handle: 'sidhant',          name: 'Sidhant Sibal',                  tier: 2 },
  { handle: 'sneheshphilip',    name: 'Snehesh Philip',                 tier: 2 },
  { handle: 'sandeepunnithan',  name: 'Sandeep Unnithan',               tier: 2 },
  { handle: 'AjitKDubey',       name: 'Ajit Kumar Dubey',               tier: 2 },
  { handle: 'rajdipk',          name: 'Rajdip K',                       tier: 2 },
  { handle: 'manaman_chhina',   name: 'Mana Chhina',                    tier: 2 },
  { handle: 'livefist',         name: 'Livefist Defence',               tier: 2 },
  { handle: 'JaidevJamwal',     name: 'Jaidev Jamwal',                  tier: 2 },
  { handle: 'Nitin_Gokhale',    name: 'Nitin Gokhale',                  tier: 2 },
  { handle: 'PravinSawhney',    name: 'Pravin Sawhney',                 tier: 2 },
  { handle: 'AdityaRajKaul',    name: 'Aditya Raj Kaul',                tier: 2 },
  { handle: 'majorgauravarya',  name: 'Major Gaurav Arya',              tier: 2 },
  { handle: 'Chopsyturvey',     name: 'Chopsyturvey',                   tier: 2 },
  { handle: 'TinyDhillon',      name: 'Tiny Dhillon',                   tier: 2 },
  { handle: 'palepurshankar',   name: 'Palepur Shankar',                tier: 2 },
  { handle: 'CdrSandeepDhawan', name: 'Cdr Sandeep Dhawan',             tier: 2 },
  { handle: 'ColSanjayPande',   name: 'Col Sanjay Pande',               tier: 2 },
  { handle: 'ColDinny',         name: 'Col Dinny',                      tier: 2 },
  { handle: 'ColSaurabh',       name: 'Col Saurabh',                    tier: 2 },
  { handle: 'ColRohitDev',      name: 'Col Rohit Dev',                  tier: 2 },
  { handle: 'alpha_defense',    name: 'Alpha Defense',                  tier: 2 },
  { handle: 'Defencematrix1',   name: 'Defence Matrix',                 tier: 2 },
  { handle: 'DefenceDecode',    name: 'Defence Decode',                 tier: 2 },
  { handle: 'NewsIADN',         name: 'India Arms Defence News',        tier: 2 },
  { handle: 'idrwalerts',       name: 'IDRW Alerts',                    tier: 2 },
  { handle: 'ReviewVayu',       name: 'VAYU Aerospace Review',          tier: 2 },
  { handle: 'StratNewsGlobal',  name: 'Strategic News Global',          tier: 2 },
  { handle: 'BharatShaktiBSI',  name: 'Bharat Shakti',                  tier: 2 },
  { handle: 'ChanakyaForum',    name: 'Chanakya Forum',                 tier: 3 },
  { handle: 'ORFonline',        name: 'Observer Research Foundation',   tier: 3 },
  { handle: 'takshashila_inst', name: 'Takshashila Institution',        tier: 3 },
  { handle: 'USIofIndia',       name: 'United Service Institution',     tier: 3 },
  { handle: 'CAPS_INDIA',       name: 'CAPS India',                     tier: 3 },
  { handle: 'CLAWSIndia',       name: 'CLAWS India',                    tier: 3 },
  { handle: 'IndiaWarMonitor',  name: 'India War Monitor',              tier: 3 },
  { handle: 'FrontalForce',     name: 'Frontal Force',                  tier: 3 },
  { handle: 'InsightGL',        name: 'Insight Global',                 tier: 3 },
  { handle: 'TheLegateIN',      name: 'The Legate India',               tier: 3 },
  { handle: 'VivekSi85847001',  name: 'Vivek Singh',                    tier: 3 },
  { handle: 'connect_rishav',   name: 'Rishav Connect',                 tier: 3 },
  { handle: 'Kunal_Biswas707',  name: 'Kunal Biswas',                   tier: 3 },
  { handle: 'VinodDX9',         name: 'Vinod DX',                       tier: 3 },
  { handle: 'SanjeevSanyal',    name: 'Sanjeev Sanyal',                 tier: 3 },
  { handle: 'DerekJGrossman',   name: 'Derek J. Grossman (RAND)',       tier: 3 },
  { handle: 'detresfa_',        name: 'Detresfa (OSINT)',               tier: 3 },
  { handle: 'oryxspioenkop',    name: 'Oryx (Equipment Tracking)',      tier: 3 },
  { handle: 'Osinttechnical',   name: 'OSINT Technical',                tier: 3 },
  { handle: 'COUPSURE',         name: 'Coup Sure',                      tier: 3 },
  { handle: 'ELINTNews',        name: 'ELINT News',                     tier: 3 },
  { handle: 'Defence_Index',    name: 'Defence Index',                  tier: 3 },
  { handle: 'GeoInsider',       name: 'Geo Insider',                    tier: 3 },
  { handle: 'WarMonitor3',      name: 'War Monitor',                    tier: 3 },
  { handle: 'Caucasuswar',      name: 'Caucasus War',                   tier: 3 },
  { handle: 'sentdefender',     name: 'Sentinel Defender',              tier: 3 },
  { handle: 'AnilChopra_IAF',   name: 'Air Marshal Anil Chopra (Retd)', tier: 2 },
  { handle: 'AviationWall',     name: 'Aviation Wall',                  tier: 3 },
  { handle: 'theflyingmonk',    name: 'The Flying Monk',                tier: 3 },
  { handle: 'IndoPac_Info',     name: 'IndoPacific Info',               tier: 3 },
  { handle: 'Space_India',      name: 'Space India',                    tier: 3 },
  { handle: 'ISROSpaceflight',  name: 'ISRO Spaceflight',               tier: 3 },
  { handle: 'IDSAIndia',        name: 'IDSA India',                     tier: 3 },
  { handle: 'BrookingsIndia',   name: 'Brookings India',                tier: 3 },
  { handle: 'CarnegieIndia',    name: 'Carnegie India',                 tier: 3 },
  { handle: 'CSIS',             name: 'CSIS',                           tier: 3 },
  { handle: 'RUSI_org',         name: 'RUSI',                           tier: 3 },
  { handle: 'IISS_org',         name: 'IISS',                           tier: 3 },
  { handle: 'DivaJain2',        name: 'Diva Jain',                      tier: 3 },
  { handle: 'YearOfTheKraken',  name: 'Year of the Kraken',             tier: 3 },
  { handle: 'Vikram_Sood',      name: 'Vikram Sood (Former RAW Chief)', tier: 2 },
  { handle: 'Gen_RajShukla',    name: 'Gen Raj Shukla (Retd)',          tier: 2 },
  { handle: 'AadiAchint',       name: 'Aadi Achint',                    tier: 3 },
  { handle: 'Iyervval',         name: 'Iyer V Val',                     tier: 3 },
  { handle: 'SwarajyaMag',      name: 'Swarajya Magazine',              tier: 3 },
];

// ─── NLP Categories + keyword scoring ───────────────────────────────────────
const CATEGORIES = {
  army: {
    label: 'Army', icon: '🪖', color: '#854d0e',
    keywords: ['army', 'soldier', 'infantry', 'corps', 'battalion', 'brigade', 'regiment',
      'northern command', 'western command', 'eastern command', 'southern command',
      'army chief', 'coas', 'chief of army', 'lac', 'line of actual control',
      'siachen', 'doklam', 'ladakh', 'kashmir', 'counter insurgency', 'counter terrorism',
      'para sf', 'maroon beret', 'grenadiers', 'armoured corps', 'artillery', 'engineers',
      'army day', 'sena diwas', 'shaheed', 'martyred soldier', 'sepoy', 'havildar',
      'naib subedar', 'subedar', 'jawan', 'jco', 'military station', 'cantonment'],
  },
  navy: {
    label: 'Navy', icon: '⚓', color: '#1e3a5f',
    keywords: ['navy', 'naval', 'ins ', 'fleet', 'frigate', 'destroyer', 'submarine',
      'aircraft carrier', 'vikrant', 'vikramaditya', 'vice admiral', 'commodore',
      'rear admiral', 'coast guard', 'maritime', 'indian ocean', 'bay of bengal',
      'arabian sea', 'malabar exercise', 'navy day', 'western naval', 'eastern naval',
      'southern naval', 'andaman nicobar', 'torpedo', 'sonar', 'anti-piracy',
      'p8i', 'seahawk', 'naval air', 'sea guardian', 'p-8', 'ship commissioned',
      'warship', 'corvette', 'patrol vessel', 'lcac', 'amphibious'],
  },
  airforce: {
    label: 'Air Force', icon: '✈️', color: '#1e40af',
    keywords: ['iaf', 'air force', 'squadron', 'rafale', 'tejas', 'mig', 'sukhoi', 'su-30',
      'helicopter', 'mi-17', 'chinook', 'apache', 'c-130', 'c-17', 'airbase', 'sortie',
      'air chief', 'acm', 'air marshal', 'wing commander', 'group captain', 'pilot',
      'air warrior', 'awacs', 'interceptor', 'fighter jet', 'air exercise', 'vayu shakti',
      'air force day', 'bvr', 'combat air patrol', 'air to air', 'air to ground',
      'lca', 'amca', 'mrfa', 'medium range fighter', 'force multiplier', 'air superiority',
      'iaf station', 'air wing', 'ground attack', 'air refuelling', 'tanker aircraft'],
  },
  drdo: {
    label: 'DRDO / Industry', icon: '🏭', color: '#166534',
    keywords: ['drdo', 'hal', 'bdl', 'bel', 'beml', 'bharat forge', 'mahindra defence',
      'l&t defence', 'data patterns', 'paras defence', 'indigenously', 'make in india',
      'atmanirbhar', 'self reliant', 'defence production', 'idex', 'dio',
      'positive indigenisation', 'import substitution', 'prototype', 'trial',
      'test flight', 'induction ceremony', 'delivery', 'procurement order',
      'rfp', 'rfq', 'request for proposal', 'astra missile', 'pralay', 'pinaka',
      'akash missile', 'mrsam', 'qrsam', 'ficv', 'scientist', 'defence lab',
      'technology demonstrator', 'defence psu', 'ordnance factory', 'ofe', 'ofc'],
  },
  geopolitics: {
    label: 'Geopolitics', icon: '🌐', color: '#6b21a8',
    keywords: ['china', 'pakistan', 'border dispute', 'loc ', 'lac ', 'ceasefire violation',
      'diplomatic', 'bilateral', 'strategic partnership', 'quad ', 'i2u2', 'sco ',
      'brics', 'un security', 'incursion', 'pla ', 'plaaf', 'plan ', 'isi ',
      'terror', 'terrorist', 'cross border', 'infiltration', 'foreign minister',
      'eam ', 'mea ', 'summit', 'geopolitics', 'indo-pacific', 'south china sea',
      'taiwan', 'afghanistan', 'myanmar', 'sri lanka', 'nepal border',
      'bhutan', 'maldives', 'strategic autonomy', 'non-alignment'],
  },
  operations: {
    label: 'Operations', icon: '⚔️', color: '#991b1b',
    keywords: ['operation ', 'joint exercise', 'wargame', 'war game', 'drill', 'combat patrol',
      'deployed', 'mission accomplished', 'encounter ', 'cordon and search', 'anti-terror',
      'malabar ', 'tasman saber', 'shakti ', 'vajra prahar', 'hand-in-hand', 'surya kiran',
      'slinex', 'garuda ', 'naseem al-bahr', 'tiger triumph', 'hadr ', 'rescue operation',
      'flood relief', 'disaster relief', 'humanitarian assistance', 'un mission',
      'peacekeeping', 'freefall', 'para drop', 'amphibious landing', 'live fire'],
  },
  equipment: {
    label: 'Equipment', icon: '🔫', color: '#92400e',
    keywords: ['t-90', 'arjun tank', 'howitzer', 'dhanush gun', 'k9 vajra', 'atags',
      'brahmos', 'nirbhay', 'agni ', 'prithvi missile', 'anti-tank', 'spike missile',
      'javelin', 'ak-203', 'assault rifle', 'armoured vehicle', 'ifv', 'mrap',
      'electronic warfare', 'jammer', 'uav', 'ucav', 'mq-9', 'heron drone',
      'rustom', 'cats warrior', 'swarm drone', 'loitering munition', 'kamikaze drone',
      'fighter inducted', 'warship commissioned', 'submarine launched', 'missile test',
      'rocket system', 'rpg', 'sniper rifle', 'iaf aircraft inducted', 'radar system'],
  },
  cyber_space: {
    label: 'Cyber & Space', icon: '🛰️', color: '#0f766e',
    keywords: ['cyber attack', 'cyber security', 'cyber threat', 'hack', 'malware',
      'ransomware', 'digital warfare', 'information warfare', 'isro', 'satellite',
      'gsat', 'navic', 'irnss', 'risat', 'reconnaissance satellite', 'spy satellite',
      'space command', 'intelligence', 'surveillance', 'osint', 'ntro', 'sigint',
      'deep fake', 'ai weapon', 'autonomous weapon', 'lethal autonomous', 'asat',
      'anti-satellite', 'space debris', 'electronic intelligence', 'elint ',
      'signals intelligence', 'psyops', 'psychological operation', 'disinformation'],
  },
  policy: {
    label: 'Policy', icon: '📋', color: '#374151',
    keywords: ['ministry of defence', 'mod ', 'rajnath singh', 'defence minister',
      'cds ', 'chief of defence', 'dac ', 'defence acquisition', 'cabinet committee',
      'parliament defence', 'defence budget', 'capital outlay', 'dpp ', 'dap 2020',
      'indigenisation list', 'fdi defence', 'offset policy', 'joint theatre command',
      'theaterisation', 'agnipath', 'agniveer', 'short service commission',
      'defence white paper', 'national security', 'nsa ', 'ajit doval',
      'defence reform', 'restructuring', 'integrated theatre', 'nia ', 'ceasefire'],
  },
  personnel: {
    label: 'Personnel & Awards', icon: '🏅', color: '#d97706',
    keywords: ['gallantry award', 'param vir chakra', 'mahavir chakra', 'vir chakra',
      'shaurya chakra', 'kirti chakra', 'sena medal', 'commendation card',
      'passing out parade', 'ima graduation', 'nda graduation', 'ota graduation',
      'appointment as', 'promoted to', 'assumed command', 'retirement ceremony',
      'veteran', 'ex-serviceman', 'echs', 'orop', 'pension', 'supreme sacrifice',
      'killed in action', 'bravery in', 'valor of', 'gallant action', 'war hero',
      'posthumous', 'medal ceremony', 'defence pension', 'sainik'],
  },
};

// ─── NLP keyword classifier ──────────────────────────────────────────────────
/**
 * Pure keyword-based multi-label classifier.
 * Returns array of { category, score } sorted by score desc.
 * Score = weighted keyword hits / text_tokens (TF-IDF-like normalization).
 */
function classifyText(text) {
  const lower = text.toLowerCase();
  const tokens = lower.split(/\s+/).length || 1;
  const scores = [];

  for (const [catKey, cat] of Object.entries(CATEGORIES)) {
    let hits = 0;
    for (const kw of cat.keywords) {
      if (lower.includes(kw)) {
        // longer keywords get higher weight (more specific)
        hits += kw.split(' ').length;
      }
    }
    if (hits > 0) {
      scores.push({ category: catKey, score: Math.min(1, hits / Math.sqrt(tokens)) });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  // Keep only categories with score >= 30% of the top score
  const threshold = (scores[0]?.score ?? 0) * 0.3;
  const filtered = scores.filter(s => s.score >= threshold).slice(0, 3);
  return filtered.length > 0 ? filtered : [{ category: 'general', score: 0.1 }];
}

// ─── Groq LLM classifier (fallback for low-confidence tweets) ───────────────
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CATEGORY_NAMES = Object.keys(CATEGORIES).join(', ');

async function classifyWithGroq(text, apiKey) {
  try {
    const resp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0,
        max_tokens: 60,
        messages: [{
          role: 'user',
          content: `Classify this tweet into 1-3 categories from: ${CATEGORY_NAMES}.\nReturn ONLY a JSON array of category names, e.g. ["army","equipment"]\nTweet: "${text.slice(0, 280)}"`,
        }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    const match = content.match(/\[[\s\S]*?\]/);
    if (!match) return null;
    const cats = JSON.parse(match[0]);
    return Array.isArray(cats)
      ? cats.filter(c => CATEGORIES[c]).map(c => ({ category: c, score: 0.7 }))
      : null;
  } catch {
    return null;
  }
}

// ─── Nitter RSS fetcher ──────────────────────────────────────────────────────
const NITTER_INSTANCES = [
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
  'https://nitter.1d4.us',
  'https://nitter.tiekoetter.com',
];

function extractTagValue(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function fetchNitterRss(handle, instanceBase, timeoutMs = 6000) {
  const url = `${instanceBase}/${handle}/rss`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const xml = await resp.text();
    if (!xml.includes('<item>')) return null;

    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const tweets = [];
    let m;
    while ((m = itemRegex.exec(xml)) !== null && tweets.length < 10) {
      const item = m[1];
      const title = extractTagValue(item, 'title');
      const link  = extractTagValue(item, 'link');
      const pubDate = extractTagValue(item, 'pubDate');
      const desc  = extractTagValue(item, 'description');

      // title format is "AccountName: tweet text"
      const colonIdx = title.indexOf(': ');
      const tweetText = colonIdx !== -1 ? title.slice(colonIdx + 2) : title;
      const cleanText = stripHtml(tweetText || desc);
      if (!cleanText || cleanText.length < 10) continue;

      // Convert to canonical twitter.com link
      const twitterLink = link.replace(/^https?:\/\/[^/]+\//, 'https://x.com/');

      tweets.push({
        id: link.split('/status/')[1]?.replace('#m', '') || `${handle}_${Date.now()}`,
        handle,
        text: cleanText.slice(0, 560),
        publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        url: twitterLink,
        source: 'nitter',
      });
    }
    return tweets;
  } catch {
    return null;
  }
}

async function fetchTwitterApiV2(handles, bearerToken) {
  if (!bearerToken || handles.length === 0) return null;
  // Group into batches of 15 (query length limit ~512 chars)
  const batch = handles.slice(0, 15);
  const query = batch.map(h => `from:${h}`).join(' OR ');
  const params = new URLSearchParams({
    query,
    max_results: '50',
    'tweet.fields': 'created_at,author_id,entities,public_metrics',
    'user.fields': 'name,username',
    expansions: 'author_id',
    sort_order: 'recency',
  });
  try {
    const resp = await fetch(`https://api.twitter.com/2/tweets/search/recent?${params}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.data) return [];

    const userMap = {};
    (data.includes?.users ?? []).forEach(u => { userMap[u.id] = u; });

    return data.data.map(t => {
      const user = userMap[t.author_id] ?? {};
      return {
        id: t.id,
        handle: user.username ?? t.author_id,
        text: t.text.slice(0, 560),
        publishedAt: t.created_at,
        url: `https://x.com/${user.username ?? 'twitter'}/status/${t.id}`,
        source: 'twitter_api',
        metrics: t.public_metrics,
      };
    });
  } catch {
    return null;
  }
}

// ─── Core pipeline: fetch + classify + cache ─────────────────────────────────
const CACHE_KEY_PREFIX = 'india:defence:tweets:v3:';
const FEED_CACHE_KEY = 'india:defence:feed:v3';
const CACHE_TTL = 900; // 15 minutes

/**
 * Fetch tweets for a list of handles using best available source.
 * Returns array of enriched tweet objects.
 */
async function pipelineFetch(handles, bearerToken, groqKey) {
  let rawTweets = [];

  // 1. Try Twitter API v2 first (more reliable, structured data)
  if (bearerToken) {
    const result = await fetchTwitterApiV2(handles, bearerToken);
    if (result) rawTweets = result;
  }

  // 2. Nitter RSS for accounts not covered by Twitter API
  if (rawTweets.length === 0 || !bearerToken) {
    const nitterResults = await Promise.allSettled(
      handles.map(async (handle) => {
        for (const instance of NITTER_INSTANCES) {
          const tweets = await fetchNitterRss(handle, instance);
          if (tweets && tweets.length > 0) return tweets;
        }
        return [];
      })
    );
    const nitterTweets = nitterResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    rawTweets = [...rawTweets, ...nitterTweets];
  }

  // 3. Classify each tweet with NLP
  const enriched = await Promise.all(rawTweets.map(async (tweet) => {
    let categories = classifyText(tweet.text);

    // If top-score is very low (<0.15) and Groq is available, use LLM
    if (categories[0].score < 0.15 && groqKey) {
      const groqCats = await classifyWithGroq(tweet.text, groqKey);
      if (groqCats && groqCats.length > 0) categories = groqCats;
    }

    // Find account metadata
    const account = ACCOUNTS.find(a => a.handle.toLowerCase() === tweet.handle.toLowerCase());

    return {
      ...tweet,
      categories,                            // [{category, score}, ...]
      primaryCategory: categories[0].category,
      accountName: account?.name ?? tweet.handle,
      tier: account?.tier ?? 3,
    };
  }));

  return enriched;
}

// Deduplicate by tweet id
function dedup(tweets) {
  const seen = new Set();
  return tweets.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
}

// ─── Edge Function Handler ───────────────────────────────────────────────────
export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');
  if (isDisallowedOrigin(req)) return jsonResponse({ error: 'Forbidden' }, 403, corsHeaders);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);

  const url = new URL(req.url);
  const category  = url.searchParams.get('category') ?? 'all';
  const limit     = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100);
  const offset    = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const forceRefresh = url.searchParams.get('refresh') === '1';
  const batch     = parseInt(url.searchParams.get('batch') ?? '-1', 10); // which batch of accounts to fetch

  const bearerToken = process.env.TWITTER_BEARER_TOKEN ?? '';
  const groqKey     = process.env.GROQ_API_KEY ?? '';

  // Determine which accounts to fetch this request
  const BATCH_SIZE = 15;
  let targetHandles;
  if (batch >= 0) {
    const start = batch * BATCH_SIZE;
    targetHandles = ACCOUNTS.slice(start, start + BATCH_SIZE).map(a => a.handle);
  } else {
    // Default: tier-1 + tier-2 accounts (most authoritative)
    targetHandles = ACCOUNTS.filter(a => a.tier <= 2).map(a => a.handle);
  }

  if (targetHandles.length === 0) {
    return jsonResponse({ error: 'Invalid batch' }, 400, corsHeaders);
  }

  const batchKey = batch >= 0 ? `${CACHE_KEY_PREFIX}batch:${batch}` : `${CACHE_KEY_PREFIX}priority`;

  // Check cache (skip if forceRefresh)
  let allTweets = [];
  if (!forceRefresh) {
    const cached = await readJsonFromUpstash(batchKey, 4000);
    if (cached?.tweets) {
      allTweets = cached.tweets;
    }
  }

  // Fetch fresh data if cache miss
  let source = 'cache';
  if (allTweets.length === 0) {
    const fetched = await pipelineFetch(targetHandles, bearerToken, groqKey);
    allTweets = dedup(fetched);
    // Sort newest first
    allTweets.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    // Cache the result
    if (allTweets.length > 0) {
      await setCachedData(batchKey, { tweets: allTweets, fetchedAt: new Date().toISOString() }, CACHE_TTL);
    }
    source = bearerToken ? 'twitter_api' : 'nitter';
  }

  // Filter by category
  let filtered = allTweets;
  if (category !== 'all') {
    filtered = allTweets.filter(t => t.categories.some(c => c.category === category));
  }

  // Paginate
  const page = filtered.slice(offset, offset + limit);

  // Build category summary counts
  const categoryCounts = {};
  for (const cat of Object.keys(CATEGORIES)) categoryCounts[cat] = 0;
  for (const t of allTweets) {
    if (t.primaryCategory && categoryCounts[t.primaryCategory] !== undefined) {
      categoryCounts[t.primaryCategory]++;
    }
  }

  return jsonResponse({
    tweets: page,
    total: filtered.length,
    categoryCounts,
    categories: Object.fromEntries(
      Object.entries(CATEGORIES).map(([k, v]) => [k, { label: v.label, icon: v.icon, color: v.color }])
    ),
    accounts: ACCOUNTS,
    source,
    dataNote: !bearerToken && allTweets.length === 0
      ? 'No data: set TWITTER_BEARER_TOKEN env var or ensure Nitter instances are reachable'
      : null,
    fetchedAt: new Date().toISOString(),
  }, 200, { ...corsHeaders, 'Cache-Control': 'public, max-age=60' });
}
