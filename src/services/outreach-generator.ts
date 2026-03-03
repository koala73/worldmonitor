/**
 * Outreach Generator — AI-powered message drafting
 * Given company signals + contact profile + user's value prop,
 * generates personalized outreach with specific signal references.
 */

import type { CompanySignal } from './signal-aggregator';
import type { ContactProfile } from './contact-intelligence';

export type OutreachTemplate = 'cold_outreach' | 'warm_followup' | 'trigger_based' | 'referral_request';

export interface OutreachRequest {
  company: string;
  contact: Pick<ContactProfile, 'name' | 'title' | 'role' | 'communicationStyle'>;
  signals: CompanySignal[];
  template: OutreachTemplate;
  userValueProp: string;
  userCompany?: string;
  senderName?: string;
}

export interface GeneratedOutreach {
  subject: string;
  body: string;
  template: OutreachTemplate;
  signalsReferenced: string[];
  estimatedResponseRate: 'high' | 'medium' | 'low';
  generatedAt: Date;
}

/**
 * Build the LLM prompt for outreach generation.
 * This can be sent to the Groq/OpenRouter/browser-T5 fallback chain.
 */
export function buildOutreachPrompt(request: OutreachRequest): string {
  const { company, contact, signals, template, userValueProp, userCompany, senderName } = request;

  const recentSignals = signals
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, 5);

  const signalContext = recentSignals.map(s =>
    `- [${s.type}] ${s.title} (${s.strength} strength, ${formatTimeAgo(s.timestamp)})`,
  ).join('\n');

  const styleGuidance = {
    formal: 'Use professional, polished language. Address by title.',
    casual: 'Use conversational, friendly tone. First-name basis.',
    technical: 'Include specific technical details. Be precise and concise.',
    unknown: 'Use a balanced professional tone.',
  }[contact.communicationStyle];

  const templateGuidance = {
    cold_outreach: 'This is a first-touch cold outreach. Be concise (under 100 words). Lead with a specific signal as the hook. No generic openers.',
    warm_followup: 'This is a follow-up to a previous interaction. Reference the prior touchpoint and add a new signal as the reason to reconnect.',
    trigger_based: 'This message is triggered by a specific event. Lead with the trigger, explain its implications, and connect to your value prop.',
    referral_request: 'You are asking for an introduction. Be brief, specific about who you want to reach and why, and make it easy for the referrer.',
  }[template];

  return `Generate a personalized sales outreach message.

RECIPIENT:
- Name: ${contact.name}
- Title: ${contact.title}
- Company: ${company}
- Role: ${contact.role}

RECENT SIGNALS FOR ${company.toUpperCase()}:
${signalContext || 'No recent signals available.'}

SENDER:
- Name: ${senderName ?? 'Sales Representative'}
- Company: ${userCompany ?? 'Our Company'}
- Value Prop: ${userValueProp}

TEMPLATE: ${template}
${templateGuidance}

STYLE: ${styleGuidance}

RULES:
1. Reference at least one specific signal in the opening
2. Connect the signal to a business outcome
3. Keep it under 150 words
4. Include a clear, low-friction CTA (not "jump on a call")
5. No buzzwords, no hype, no "I hope this finds you well"
6. Sound human, not templated

Output format:
SUBJECT: <subject line>
BODY: <email body>`;
}

/**
 * Generate outreach locally (template-based fallback when LLM is unavailable)
 */
export function generateOutreachLocally(request: OutreachRequest): GeneratedOutreach {
  const { company, contact, signals, template, userValueProp } = request;

  const topSignal = signals
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

  const signalHook = topSignal
    ? `I noticed ${company} recently ${describeSignal(topSignal)}.`
    : `I've been following ${company}'s growth.`;

  let subject: string;
  let body: string;

  switch (template) {
    case 'cold_outreach':
      subject = topSignal
        ? `Re: ${company}'s ${formatSignalType(topSignal.type)}`
        : `Quick question about ${company}`;
      body = `${contact.name},\n\n${signalHook}\n\n${userValueProp}\n\nWould it make sense to share how we've helped similar companies? Happy to send a brief overview.\n\nBest`;
      break;

    case 'warm_followup':
      subject = `Following up — ${company} update`;
      body = `${contact.name},\n\nWanted to circle back since we last connected. ${signalHook}\n\nGiven this development, ${userValueProp}\n\nWorth a quick conversation?\n\nBest`;
      break;

    case 'trigger_based':
      subject = topSignal
        ? `${formatSignalType(topSignal.type)} at ${company}`
        : `${company} — timing opportunity`;
      body = `${contact.name},\n\n${signalHook} This often means teams are evaluating new approaches.\n\n${userValueProp}\n\nI have a few specific ideas that might be relevant. Mind if I share them?\n\nBest`;
      break;

    case 'referral_request':
      subject = `Quick intro request — ${company}`;
      body = `${contact.name},\n\n${signalHook}\n\nI'd love to connect with the right person on their team to discuss ${userValueProp.toLowerCase()}.\n\nWould you be open to a brief intro? I'll keep it concise and relevant.\n\nAppreciate it`;
      break;
  }

  return {
    subject,
    body,
    template,
    signalsReferenced: topSignal ? [topSignal.title] : [],
    estimatedResponseRate: topSignal?.strength === 'critical' ? 'high' : topSignal?.strength === 'high' ? 'medium' : 'low',
    generatedAt: new Date(),
  };
}

function describeSignal(signal: CompanySignal): string {
  switch (signal.type) {
    case 'funding_event': return `secured new funding (${signal.fundingAmount ?? 'undisclosed'})`;
    case 'executive_movement': return `brought on a new ${signal.jobTitle ?? 'executive'}`;
    case 'hiring_surge': return `significantly expanded their hiring`;
    case 'expansion_signal': return `announced expansion plans`;
    case 'technology_adoption': return `made changes to their tech stack`;
    case 'financial_trigger': return `reported notable financial developments`;
    case 'leadership_activity': return `had leadership actively engaging publicly`;
    case 'tender_rfp': return `published a new RFP`;
    default: return `had notable activity`;
  }
}

function formatSignalType(type: string): string {
  return type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}
