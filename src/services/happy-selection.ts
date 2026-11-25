import type { NewsItem } from '@/types';
import { dedupeByArticleUrl, normalizeArticleUrl } from '../../shared/article-identity.js';
import { hasSourceCategory } from './positive-classifier';

// General science and environment outlets publish negative and neutral reporting
// alongside good news, so their items must pass the sentiment gate.
const BROAD_HAPPY_SOURCES = new Set([
  'Nature News',
  'ScienceDaily',
  'Live Science',
  'New Scientist',
  'Singularity Hub',
  'Mongabay',
]);

// The ML sentiment gate is opt-in (browser model setting) and passes everything
// through when unavailable, so broad sources also need a deterministic screen.
const NEGATIVE_EVIDENCE_RE = /\b(droughts?|dries up|dried up|threats?|threaten\w*|crisis|crises|conflicts?|crimes?|criminal|kill\w*|deaths?|dead|dies|died|harm\w*|damag\w*|declin\w*|loss(?:es)?|losing|illegal\w*|lobby\w*|displac\w*|wildfires?|floods?|flooding|heat ?waves?|smoke|pollut\w*|toxic|disasters?|collaps\w*|extinction|warn\w*|fears?|attacks?|war|violen\w*|poach\w*|traffick\w*|cuts? off|mining waste|deforestation)\b/i;

// A headline that names a problem being solved ("reverses hearing loss",
// "poaching falls") is a positive story, not negative reporting. Verbs that act
// on a problem must precede it; verbs of a problem shrinking must follow it, so
// "populations fall as poaching accelerates" stays negative.
const RECOVERY_EVIDENCE_RE = /\b(revers\w*|restor\w*|recover\w*|rebound\w*|cure[sd]?|curing|treat\w*|therap(?:y|ies)|vaccines?|saved?|saves|saving|rescu\w*)\b/i;
const ACTS_ON_PROBLEM_RE = /\b(prevent\w*|protect\w*|halt\w*|tackl\w*|combat\w*|reduc\w*|slash\w*|fights?|fighting)\b/i;
const PROBLEM_SHRINKS_RE = /\b(fall(?:s|en)?|fell|drops?|dropped|plummet\w*|plung\w*)\b/i;

function hasNegativeEvidence(title: string): boolean {
  const negative = NEGATIVE_EVIDENCE_RE.exec(title);
  if (!negative) return false;
  if (RECOVERY_EVIDENCE_RE.test(title)) return false;
  const actsOn = ACTS_ON_PROBLEM_RE.exec(title);
  if (actsOn && actsOn.index < negative.index) return false;
  const shrinks = PROBLEM_SHRINKS_RE.exec(title);
  return !(shrinks && shrinks.index > negative.index);
}

const SCIENCE_SOURCES = new Set([
  'GNN Science',
  'ScienceDaily',
  'Nature News',
  'Live Science',
  'New Scientist',
  'Singularity Hub',
  'Human Progress',
  'Greater Good (Berkeley)',
]);

const BREAKTHROUGH_EVIDENCE_RE = /\b(breakthroughs?|discover\w*|first[- ]ever|world'?s first|scientists|researchers (?:have )?(?:find|found|discover\w*|develop\w*|create\w*|show\w*)|stud(?:y|ies) (?:finds?|shows?|reveals?|suggests?)|new (?:\w+ ){0,2}(?:treatment|therapy|drug|vaccine|material|method|technique|species|test)s?|cure[sd]?|vaccines?|therap(?:y|ies)|treatments?|clinical trials?|restor\w*|revers\w*|could|reveal\w*|found|finds|detect\w*|develop\w*|invent\w*|engineer\w*|telescopes?|black holes?|mice)\b/i;

const HERO_EVIDENCE_RE = /\b(hero(?:es|ic|ine)?|rescu\w*|saved?|saves|saving|lifesav\w*|donat\w*|volunteer\w*|kindness|generous|generosity|selfless\w*|brave(?:ry)?|courage\w*|helped|helps|helping|strangers?|charity)\b/i;

// A story syndicated to a category feed (GNN Health) keeps that copy, whose
// category comes from the feed, over the general-feed copy.
export function dedupeHappyItems(items: NewsItem[]): NewsItem[] {
  const preferred = new Map<string, NewsItem>();
  for (const item of items) {
    const key = normalizeArticleUrl(item.link);
    if (!key) continue;
    const current = preferred.get(key);
    if (!current || (!hasSourceCategory(current.source) && hasSourceCategory(item.source))) preferred.set(key, item);
  }
  return dedupeByArticleUrl(items, item => item.link)
    .map(item => preferred.get(normalizeArticleUrl(item.link)) ?? item);
}

export async function selectCuratedHappyItems(
  items: NewsItem[],
  gate: (items: NewsItem[]) => Promise<NewsItem[]>,
): Promise<NewsItem[]> {
  const unique = dedupeHappyItems(items);
  const broad = unique.filter(item => BROAD_HAPPY_SOURCES.has(item.source) && !hasNegativeEvidence(item.title));
  if (broad.length === 0) return unique.filter(item => !BROAD_HAPPY_SOURCES.has(item.source));
  const passed = new Set(await gate(broad));
  return unique.filter(item => !BROAD_HAPPY_SOURCES.has(item.source) || passed.has(item));
}

export function isBreakthroughStory(item: NewsItem): boolean {
  const scienceItem = SCIENCE_SOURCES.has(item.source) || item.happyCategory === 'science-health';
  return scienceItem && BREAKTHROUGH_EVIDENCE_RE.test(item.title);
}

export function isHeroStory(item: NewsItem): boolean {
  return HERO_EVIDENCE_RE.test(item.title);
}
