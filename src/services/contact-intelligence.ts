/**
 * Contact Intelligence Service — Per-contact intelligence
 * Role classification, recent activity, communication style inference,
 * and AI icebreaker generation.
 */

export type ContactRole = 'economic_buyer' | 'technical_evaluator' | 'champion' | 'blocker' | 'influencer' | 'unknown';

export interface ContactProfile {
  name: string;
  email?: string;
  title: string;
  company: string;
  companyDomain?: string;
  linkedinUrl?: string;
  photoUrl?: string;

  // Role classification
  role: ContactRole;
  budgetAuthority: boolean;

  // Activity
  recentActivity: ContactActivity[];
  lastActiveDate?: Date;

  // Communication style
  communicationStyle: 'formal' | 'casual' | 'technical' | 'unknown';

  // AI-generated
  icebreakers: string[];
  engagementScore: number; // 0-100

  // Metadata
  lastEnriched: Date;
  sources: string[];
}

export interface ContactActivity {
  type: 'post' | 'talk' | 'article' | 'interview' | 'podcast' | 'comment';
  title: string;
  url?: string;
  timestamp: Date;
  platform: string;
  engagementMetrics?: {
    likes: number;
    comments: number;
    shares: number;
  };
}

// In-memory contact store
const contactCache = new Map<string, ContactProfile>();

/**
 * Classify a contact's role from their title
 */
export function classifyContactRole(title: string): { role: ContactRole; budgetAuthority: boolean } {
  const t = title.toLowerCase();

  // Economic buyers — C-suite and VP-level with budget authority
  if (/\b(ceo|cto|cio|cfo|coo|cmo|cro|chief)\b/.test(t)) {
    return { role: 'economic_buyer', budgetAuthority: true };
  }
  if (/\b(vp|vice president|svp|evp|head of)\b/.test(t) && /\b(engineering|technology|it|digital|product|sales|marketing)\b/.test(t)) {
    return { role: 'economic_buyer', budgetAuthority: true };
  }

  // Technical evaluators — Directors and senior engineers
  if (/\b(director|sr\.? director|principal|staff|lead)\b/.test(t) && /\b(engineer|architect|developer|devops|security|infrastructure|platform)\b/.test(t)) {
    return { role: 'technical_evaluator', budgetAuthority: false };
  }

  // Champions — Mid-level managers who advocate internally
  if (/\b(manager|team lead|senior manager)\b/.test(t)) {
    return { role: 'champion', budgetAuthority: false };
  }

  // Influencers — Individual contributors with domain expertise
  if (/\b(senior|sr\.?|principal|staff)\b/.test(t)) {
    return { role: 'influencer', budgetAuthority: false };
  }

  return { role: 'unknown', budgetAuthority: false };
}

/**
 * Infer communication style from available data
 */
export function inferCommunicationStyle(
  activities: ContactActivity[],
): 'formal' | 'casual' | 'technical' | 'unknown' {
  if (activities.length === 0) return 'unknown';

  let technicalScore = 0;
  let formalScore = 0;
  let casualScore = 0;

  for (const activity of activities) {
    const text = activity.title.toLowerCase();

    // Technical indicators
    if (/\b(api|sdk|architecture|kubernetes|terraform|cicd|microservices|infrastructure|devops|pipeline)\b/.test(text)) {
      technicalScore += 2;
    }

    // Formal indicators
    if (/\b(strategic|enterprise|governance|compliance|quarterly|stakeholder|roadmap)\b/.test(text)) {
      formalScore += 2;
    }

    // Casual indicators
    if (activity.platform === 'twitter' || activity.type === 'podcast') {
      casualScore += 1;
    }
  }

  const max = Math.max(technicalScore, formalScore, casualScore);
  if (max === 0) return 'unknown';
  if (max === technicalScore) return 'technical';
  if (max === formalScore) return 'formal';
  return 'casual';
}

/**
 * Get a contact profile
 */
export function getContactProfile(email: string): ContactProfile | null {
  return contactCache.get(email.toLowerCase().trim()) ?? null;
}

/**
 * Create or update a contact profile
 */
export function upsertContactProfile(
  email: string,
  update: Partial<Omit<ContactProfile, 'lastEnriched'>>,
): ContactProfile {
  const key = email.toLowerCase().trim();
  const existing = contactCache.get(key);

  const title = update.title ?? existing?.title ?? '';
  const activities = update.recentActivity ?? existing?.recentActivity ?? [];
  const { role, budgetAuthority } = classifyContactRole(title);
  const communicationStyle = inferCommunicationStyle(activities);

  const profile: ContactProfile = {
    name: update.name ?? existing?.name ?? '',
    email: key,
    title,
    company: update.company ?? existing?.company ?? '',
    companyDomain: update.companyDomain ?? existing?.companyDomain,
    linkedinUrl: update.linkedinUrl ?? existing?.linkedinUrl,
    photoUrl: update.photoUrl ?? existing?.photoUrl,
    role: update.role ?? role,
    budgetAuthority: update.budgetAuthority ?? budgetAuthority,
    recentActivity: activities,
    lastActiveDate: update.lastActiveDate ?? existing?.lastActiveDate,
    communicationStyle,
    icebreakers: update.icebreakers ?? existing?.icebreakers ?? [],
    engagementScore: update.engagementScore ?? existing?.engagementScore ?? 0,
    lastEnriched: new Date(),
    sources: update.sources ?? existing?.sources ?? [],
  };

  contactCache.set(key, profile);
  return profile;
}

/**
 * List contacts for a company
 */
export function listContactsForCompany(companyName: string): ContactProfile[] {
  const name = companyName.toLowerCase();
  return Array.from(contactCache.values())
    .filter(c => c.company.toLowerCase() === name)
    .sort((a, b) => {
      // Economic buyers first, then by engagement score
      if (a.budgetAuthority !== b.budgetAuthority) return a.budgetAuthority ? -1 : 1;
      return b.engagementScore - a.engagementScore;
    });
}
