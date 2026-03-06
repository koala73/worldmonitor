/**
 * World Monitor Agent — Main Application Controller
 * Enterprise UI (对标千问 Qwen): sidebar, chat, welcome, discover, input, settings.
 * Full routing · i18n · Modules · Enhanced settings (bg/gradient/language)
 */

import {
  type Conversation,
  type ChatMessage,
  type AgentSettings,
  loadConversations,
  saveConversations,
  createConversation,
  deleteConversation,
  updateConversationTitle,
  loadSettings,
  saveSettings,
  generateId,
} from './services/conversation-store';

import { streamChat, abortChat, fetchOllamaModels } from './services/chat-service';
import { type LangCode, LANGUAGES, setLanguage, t, detectLanguage } from './services/i18n';

// ── SVG Icons (stroke-based, 24×24 viewBox) ──

const ICON = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2a7 7 0 0 0-7 7c0 3 2 5.5 4 7l3 3 3-3c2-1.5 4-4 4-7a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  newspaper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h16v16H4z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="12" y2="12"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  translate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 5h12M9 3v2m1.048 3.5A18.24 18.24 0 0 1 6 13.25c-1.114-.66-2.14-1.45-3.05-2.35"/><path d="M12 21l3.5-7 3.5 7M14 18h4"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  presentation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  sidebar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/><circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/><circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/><circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z"/></svg>',
  thumbUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>',
  thumbDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  externalLink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  panelRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>',
  chevronUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="18 15 12 9 6 15"/></svg>',
};

// ── Markdown rendering (lightweight) ──

function renderMarkdown(text: string): string {
  let html = text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre><code class="language-${lang}">${escaped}</code></pre>`;
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
  html = html.replace(/\n\n/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p><\/p>/g, '');
  return html;
}

// ── Discover module definitions ──

interface DiscoverModule {
  id: string;
  icon: string;
  labelKey: keyof ReturnType<typeof t>;
  desc: string;
  color: string;
  category: string;
  action?: string;
}

const DISCOVER_FEATURED: DiscoverModule[] = [
  { id: 'ppt', icon: 'presentation', labelKey: 'pptCreation', desc: 'PPT', color: '#8b5cf6', category: 'work', action: 'ppt' },
  { id: 'record', icon: 'mic', labelKey: 'realtimeRecord', desc: 'Record', color: '#14b8a6', category: 'practical', action: 'recording' },
  { id: 'av-speed', icon: 'video', labelKey: 'audioVideoSpeed', desc: 'AV', color: '#3b82f6', category: 'practical', action: 'audio-video' },
];

const DISCOVER_SIDE: DiscoverModule[] = [
  { id: 'reading', icon: 'bookmark', labelKey: 'readingAssistant', desc: 'read', color: '#f59e0b', category: 'learning' },
  { id: 'link-speed', icon: 'globe', labelKey: 'linkSpeed', desc: 'link', color: '#10b981', category: 'practical' },
  { id: 'ai-notes', icon: 'file', labelKey: 'aiNotes', desc: 'notes', color: '#6366f1', category: 'learning' },
];

const DISCOVER_AGENTS: DiscoverModule[] = [
  { id: 'format-conv', icon: 'folder', labelKey: 'formatConvert', desc: '1.2万+', color: '#0ea5e9', category: 'practical' },
  { id: 'text-rewrite', icon: 'pen', labelKey: 'textRewrite', desc: '1000+', color: '#8b5cf6', category: 'work' },
  { id: 'headline', icon: 'newspaper', labelKey: 'headlineGen', desc: '800+', color: '#ef4444', category: 'work' },
  { id: 'text-polish', icon: 'palette', labelKey: 'textColorist', desc: '2000+', color: '#f59e0b', category: 'practical' },
  { id: 'threat-assess', icon: 'shield', labelKey: 'threatAssess', desc: 'OSINT', color: '#ef4444', category: 'geopolitics' },
  { id: 'market-scan', icon: 'chart', labelKey: 'marketAnalysis', desc: 'Finance', color: '#10b981', category: 'finance' },
];

const DISCOVER_CATEGORIES = [
  'allCategories', 'catGeopolitics', 'catFinance', 'catOSINT',
  'catPractical', 'catLearning', 'catWork', 'catEntertainment', 'catDraw',
] as const;

// ── Main App Class ──

type PageRoute = 'welcome' | 'chat' | 'discover' | 'module';

export class AgentApp {
  private root: HTMLElement;
  private conversations: Conversation[] = [];
  private activeConvId: string | null = null;
  private settings: AgentSettings;
  private isStreaming = false;
  private activeToolMode: string | null = null;
  private modelDropdownOpen = false;
  private moreDropdownOpen = false;
  private currentPage: PageRoute = 'welcome';
  private discoverCategory = 'allCategories';
  private activeModuleId: string | null = null;
  private referencesPanelOpen = false;
  private topbarCollapsed = false;

  // DOM refs
  private convListEl!: HTMLElement;
  private chatAreaEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private welcomeEl!: HTMLElement;
  private discoverEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private welcomeTextareaEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private welcomeSendBtnEl!: HTMLButtonElement;
  private modelSelectorEl!: HTMLElement;
  private modelDropdownEl!: HTMLElement;
  private settingsOverlayEl!: HTMLElement;
  private inputAreaEl!: HTMLElement;
  private moreDropdownEl!: HTMLElement;
  private modulePageEl!: HTMLElement;
  private referencesPanelEl!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.settings = loadSettings();
  }

  init(): void {
    this.initLanguage();
    this.showSplash();
    this.conversations = loadConversations();
    this.render();
    this.bindEvents();
    this.setupCodeCopyButtons();
    this.applyAppearance();
    const first = this.conversations[0];
    if (first) {
      this.setActiveConversation(first.id);
    }
  }

  private initLanguage(): void {
    const lang = this.settings.language === 'auto' ? detectLanguage() : this.settings.language as LangCode;
    setLanguage(lang);
  }

  private showSplash(): void {
    const splash = document.createElement('div');
    splash.className = 'agent-splash';
    splash.innerHTML = `
      <div class="agent-splash-logo"><div class="agent-splash-logo-inner">W</div></div>
      <div class="agent-splash-text"><span>World Monitor Agent</span></div>
    `;
    document.body.appendChild(splash);
    setTimeout(() => {
      splash.classList.add('fade-out');
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    }, 1200);
  }

  // ── Render ──

  private render(): void {
    const s = t();

    const toolBtns = (prefix: string) => `
      <button class="${prefix}-tool-btn" data-tool="intel">${ICON.globe} ${s.taskAssistant}</button>
      <button class="${prefix}-tool-btn" data-tool="deep-think">${ICON.brain} ${s.deepThink}</button>
      <button class="${prefix}-tool-btn" data-tool="research">${ICON.search} ${s.deepResearch}</button>
      <button class="${prefix}-tool-btn" data-tool="code">${ICON.code} ${s.code}</button>
      <button class="${prefix}-tool-btn" data-tool="image">${ICON.image} ${s.image}</button>
      <button class="${prefix}-tool-btn agent-more-trigger" data-more="1">${ICON.more} ${s.more}</button>
    `;

    const langOptions = LANGUAGES.map(l =>
      `<option value="${l.code}" ${this.settings.language === l.code ? 'selected' : ''}>${l.nativeName} (${l.name})</option>`
    ).join('');

    this.root.innerHTML = `
      <!-- ═══ Sidebar ═══ -->
      <aside class="agent-sidebar" id="agent-sidebar">
        <div class="agent-sidebar-header">
          <div class="agent-logo">W</div>
          <span class="agent-brand">${s.brandShort}</span>
          <div class="agent-sidebar-header-actions">
            <button class="agent-icon-btn" id="sidebar-search-btn" title="${s.search}">${ICON.search}</button>
            <button class="agent-icon-btn" id="sidebar-toggle-btn" title="Toggle">${ICON.sidebar}</button>
          </div>
        </div>

        <button class="agent-new-chat-btn" id="new-chat-btn">${ICON.plus} ${s.newChat}</button>

        <div class="agent-conv-section"><span>${s.chatGroups}</span><button class="agent-conv-section-action" id="add-group-btn">${ICON.plus}</button></div>
        <div class="agent-conv-section"><span>${s.recentChats}</span></div>
        <div class="agent-conv-list" id="conv-list"></div>

        <div class="agent-sidebar-footer">
          <button class="agent-sidebar-footer-btn" id="discover-link">${ICON.compass} ${s.discover}</button>
          <button class="agent-sidebar-footer-btn" id="dashboard-link">${ICON.globe} ${s.dashboard}</button>
          <button class="agent-sidebar-footer-btn" id="settings-btn">${ICON.settings} ${s.settings}</button>
          <button class="agent-sidebar-footer-btn" id="my-space-btn">${ICON.user} ${s.mySpace}</button>
        </div>
      </aside>

      <!-- ═══ Main ═══ -->
      <main class="agent-main" id="agent-main">
        <!-- Top bar (collapsible) -->
        <div class="agent-topbar ${this.topbarCollapsed ? 'collapsed' : ''}" id="agent-topbar">
          <div class="agent-topbar-left">
            <button class="agent-icon-btn" id="topbar-collapse-btn" title="Toggle topbar">${ICON.panelRight}</button>
            <button class="agent-icon-btn agent-topbar-back agent-hidden" id="topbar-back-btn" title="Back">${ICON.arrowLeft}</button>
            <div class="agent-model-selector" id="model-selector">
              <span id="model-name">${this.getModelDisplayName()}</span>
              ${ICON.chevron}
            </div>
          </div>
          <div class="agent-topbar-center" id="topbar-center"></div>
          <div class="agent-topbar-right">
            <button class="agent-icon-btn" id="topbar-ref-btn" title="${s.references || 'References'}">${ICON.link}</button>
            <button class="agent-icon-btn" id="topbar-settings" title="${s.settings}">${ICON.settings}</button>
            <button class="agent-dashboard-btn" id="topbar-dashboard">${ICON.globe} ${s.dashboard}</button>
          </div>
        </div>

        <!-- Model dropdown -->
        <div class="agent-model-dropdown" id="model-dropdown"></div>

        <!-- "More" dropdown -->
        <div class="agent-more-dropdown" id="more-dropdown">
          <div class="agent-more-item" data-tool="translate">${ICON.translate} ${s.moreTranslation}</div>
          <div class="agent-more-item" data-tool="ai-writing">${ICON.pen} ${s.moreAiWriting}</div>
          <div class="agent-more-item" data-tool="ppt">${ICON.presentation} ${s.morePPT}</div>
          <div class="agent-more-item" data-tool="command-center">${ICON.terminal} ${s.moreCommandCenter}</div>
          <div class="agent-more-item" data-tool="threat-assess">${ICON.shield} ${s.moreThreatAssess}</div>
          <div class="agent-more-item" data-tool="market-scan">${ICON.chart} ${s.moreMarketScan}</div>
        </div>

        <!-- ═══ Welcome screen ═══ -->
        <div class="agent-welcome" id="welcome-screen">
          <div class="agent-welcome-greeting">${s.greeting}</div>
          <div class="agent-welcome-input-card">
            <div class="agent-welcome-input-inner">
              <textarea class="agent-welcome-textarea" id="welcome-input" rows="1" placeholder="${s.inputPlaceholder}"></textarea>
              <div class="agent-welcome-input-actions">
                <button class="agent-action-btn" id="welcome-mic" title="${s.recording}">${ICON.mic}</button>
                <button class="agent-action-btn" id="welcome-attach" title="${s.documents}">${ICON.attach}</button>
                <button class="agent-send-btn" id="welcome-send-btn" disabled>${ICON.send}</button>
              </div>
            </div>
            <div class="agent-welcome-tools">
              ${toolBtns('agent-welcome')}
            </div>
          </div>
          <div class="agent-quick-actions">
            <div class="agent-quick-card" data-action="intel"><div class="agent-quick-card-icon intel">${ICON.globe}</div><div class="agent-quick-card-label">${s.intelAnalysis}</div></div>
            <div class="agent-quick-card" data-action="research"><div class="agent-quick-card-icon research">${ICON.search}</div><div class="agent-quick-card-label">${s.research}</div></div>
            <div class="agent-quick-card" data-action="code"><div class="agent-quick-card-icon code">${ICON.code}</div><div class="agent-quick-card-label">${s.code}</div></div>
            <div class="agent-quick-card" data-action="market"><div class="agent-quick-card-icon market">${ICON.chart}</div><div class="agent-quick-card-label">${s.marketAnalysis}</div></div>
            <div class="agent-quick-card" data-action="discover"><div class="agent-quick-card-icon discover">${ICON.grid}</div><div class="agent-quick-card-label">${s.discover}</div></div>
          </div>
        </div>

        <!-- ═══ Discover page ═══ -->
        <div class="agent-discover agent-hidden" id="discover-screen"></div>

        <!-- ═══ Module sub-page ═══ -->
        <div class="agent-module-page agent-hidden" id="module-page"></div>

        <!-- ═══ Chat content wrapper (messages + references) ═══ -->
        <div class="agent-chat-wrapper agent-hidden" id="chat-area">
          <div class="agent-chat-main">
            <div class="agent-messages" id="messages"></div>
          </div>
          <div class="agent-references-panel ${this.referencesPanelOpen ? 'open' : ''}" id="references-panel">
            <div class="agent-ref-header">
              <span class="agent-ref-title">${s.references}</span>
              <button class="agent-icon-btn agent-ref-close" id="ref-close-btn">${ICON.x}</button>
            </div>
            <div class="agent-ref-list" id="ref-list"></div>
          </div>
        </div>

        <!-- ═══ Chat input area ═══ -->
        <div class="agent-input-area agent-hidden" id="chat-input-area">
          <div class="agent-input-container">
            <div class="agent-input-row">
              <textarea class="agent-textarea" id="chat-input" rows="1" placeholder="${s.inputPlaceholder}"></textarea>
              <div class="agent-input-actions">
                <button class="agent-action-btn" id="chat-mic" title="${s.recording}">${ICON.mic}</button>
                <button class="agent-action-btn" id="chat-attach" title="${s.documents}">${ICON.attach}</button>
                <button class="agent-send-btn" id="send-btn" disabled>${ICON.send}</button>
              </div>
            </div>
            <div class="agent-tool-bar">
              ${toolBtns('agent')}
            </div>
          </div>
          <div class="agent-input-footer">${s.contentByAI}，${s.refOnly}</div>
        </div>
      </main>

      <!-- ═══ Settings overlay ═══ -->
      <div class="agent-settings-overlay" id="settings-overlay">
        <div class="agent-settings-panel">
          <div class="agent-settings-title">${s.settingsTitle}</div>

          <!-- Appearance section -->
          <div class="agent-settings-section-title">${s.appearance}</div>
          <div class="agent-settings-group">
            <label class="agent-settings-label">${s.language}</label>
            <select class="agent-settings-input" id="set-language">
              <option value="auto" ${this.settings.language === 'auto' ? 'selected' : ''}>Auto</option>
              ${langOptions}
            </select>
          </div>
          <div class="agent-settings-row">
            <div class="agent-settings-group agent-settings-half">
              <label class="agent-settings-label">${s.bgColor}</label>
              <div class="agent-color-picker-wrap">
                <input type="color" class="agent-color-input" id="set-bg-color" value="${this.settings.bgColor || '#0f0f10'}" />
                <input class="agent-settings-input agent-color-text" id="set-bg-color-text" value="${this.settings.bgColor || '#0f0f10'}" placeholder="#0f0f10" />
              </div>
            </div>
            <div class="agent-settings-group agent-settings-half">
              <label class="agent-settings-label">${s.gradientColor}</label>
              <div class="agent-gradient-row">
                <input type="color" class="agent-color-input" id="set-grad-start" value="${this.settings.gradientStart || '#0f0f10'}" />
                <span class="agent-gradient-arrow">→</span>
                <input type="color" class="agent-color-input" id="set-grad-end" value="${this.settings.gradientEnd || '#1a1a2e'}" />
              </div>
            </div>
          </div>

          <!-- AI section -->
          <div class="agent-settings-section-title">${s.aiProvider}</div>
          <div class="agent-settings-group">
            <label class="agent-settings-label">${s.aiProvider}</label>
            <select class="agent-settings-input" id="set-provider">
              <option value="custom" ${this.settings.provider === 'custom' ? 'selected' : ''}>Custom API</option>
              <option value="ollama" ${this.settings.provider === 'ollama' ? 'selected' : ''}>${s.ollamaLocal}</option>
              <option value="groq" ${this.settings.provider === 'groq' ? 'selected' : ''}>${s.groqCloud}</option>
              <option value="openrouter" ${this.settings.provider === 'openrouter' ? 'selected' : ''}>${s.openrouterCloud}</option>
            </select>
          </div>
          <div class="agent-settings-group" id="set-custom-baseurl-group">
            <label class="agent-settings-label">Base URL</label>
            <input class="agent-settings-input" id="set-custom-baseurl" value="${this.settings.customBaseUrl}" placeholder="https://api.duojie.games" />
          </div>
          <div class="agent-settings-group" id="set-custom-apikey-group">
            <label class="agent-settings-label">API Key</label>
            <input class="agent-settings-input" id="set-custom-apikey" type="password" value="${this.settings.customApiKey}" placeholder="sk-..." />
          </div>
          <div class="agent-settings-group" id="set-custom-model-group">
            <label class="agent-settings-label">Model</label>
            <select class="agent-settings-input" id="set-custom-model">
              <optgroup label="Claude">
                <option value="claude-opus-4-6-max" ${this.settings.customModel === 'claude-opus-4-6-max' ? 'selected' : ''}>Claude Opus 4.6 Max</option>
                <option value="claude-opus-4-6-gemini" ${this.settings.customModel === 'claude-opus-4-6-gemini' ? 'selected' : ''}>Claude Opus 4.6 Gemini</option>
                <option value="claude-sonnet-4-6" ${this.settings.customModel === 'claude-sonnet-4-6' ? 'selected' : ''}>Claude Sonnet 4.6</option>
              </optgroup>
              <optgroup label="Other">
                <option value="gemini-3.1-pro-high" ${this.settings.customModel === 'gemini-3.1-pro-high' ? 'selected' : ''}>Gemini 3.1 Pro High</option>
                <option value="kimi-k2.5" ${this.settings.customModel === 'kimi-k2.5' ? 'selected' : ''}>Kimi K2.5</option>
                <option value="qwen3.5-plus" ${this.settings.customModel === 'qwen3.5-plus' ? 'selected' : ''}>Qwen 3.5 Plus</option>
              </optgroup>
            </select>
          </div>
          <div class="agent-settings-group agent-hidden" id="set-ollama-group">
            <label class="agent-settings-label">${s.ollamaUrl}</label>
            <input class="agent-settings-input" id="set-ollama-url" value="${this.settings.ollamaUrl}" placeholder="http://localhost:11434" />
          </div>
          <div class="agent-settings-group agent-hidden" id="set-ollama-model-group">
            <label class="agent-settings-label">${s.ollamaModel}</label>
            <input class="agent-settings-input" id="set-ollama-model" value="${this.settings.ollamaModel}" placeholder="llama3.1:8b" />
          </div>
          <div class="agent-settings-group agent-hidden" id="set-groq-group">
            <label class="agent-settings-label">${s.groqKey}</label>
            <input class="agent-settings-input" id="set-groq-key" type="password" value="${this.settings.groqKey}" placeholder="gsk_..." />
          </div>
          <div class="agent-settings-group agent-hidden" id="set-openrouter-group">
            <label class="agent-settings-label">${s.openrouterKey}</label>
            <input class="agent-settings-input" id="set-openrouter-key" type="password" value="${this.settings.openrouterKey}" placeholder="sk-or-..." />
          </div>
          <div class="agent-settings-group">
            <label class="agent-settings-label">${s.systemPrompt}</label>
            <textarea class="agent-settings-input" id="set-system-prompt" rows="4" style="resize:vertical">${this.settings.systemPrompt}</textarea>
          </div>
          <div class="agent-settings-group">
            <label class="agent-settings-label">${s.temperature} (${this.settings.temperature})</label>
            <input type="range" id="set-temperature" min="0" max="1" step="0.1" value="${this.settings.temperature}" style="width:100%" />
          </div>
          <div class="agent-settings-actions">
            <button class="agent-btn-secondary" id="settings-cancel">${s.cancel}</button>
            <button class="agent-btn-primary" id="settings-save">${s.save}</button>
          </div>
        </div>
      </div>
    `;

    // Cache DOM refs
    this.convListEl = document.getElementById('conv-list')!;
    this.chatAreaEl = document.getElementById('chat-area')!;
    this.messagesEl = document.getElementById('messages')!;
    this.welcomeEl = document.getElementById('welcome-screen')!;
    this.discoverEl = document.getElementById('discover-screen')!;
    this.textareaEl = document.getElementById('chat-input') as HTMLTextAreaElement;
    this.welcomeTextareaEl = document.getElementById('welcome-input') as HTMLTextAreaElement;
    this.sendBtnEl = document.getElementById('send-btn') as HTMLButtonElement;
    this.welcomeSendBtnEl = document.getElementById('welcome-send-btn') as HTMLButtonElement;
    this.modelSelectorEl = document.getElementById('model-selector')!;
    this.modelDropdownEl = document.getElementById('model-dropdown')!;
    this.settingsOverlayEl = document.getElementById('settings-overlay')!;
    this.inputAreaEl = document.getElementById('chat-input-area')!;
    this.moreDropdownEl = document.getElementById('more-dropdown')!;
    this.modulePageEl = document.getElementById('module-page')!;
    this.referencesPanelEl = document.getElementById('references-panel')!;

    this.renderConversationList();
    this.toggleSettingsFields();
  }

  // ── Bind Events ──

  private bindEvents(): void {
    const s = t();

    // New chat
    document.getElementById('new-chat-btn')!.addEventListener('click', () => { this.navigateTo('welcome'); this.newChat(); });

    // Send (chat mode)
    this.sendBtnEl.addEventListener('click', () => this.handleSend());
    this.textareaEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSend(); }
    });

    // Send (welcome mode)
    this.welcomeSendBtnEl.addEventListener('click', () => this.handleWelcomeSend());
    this.welcomeTextareaEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleWelcomeSend(); }
    });

    // Auto-resize textareas
    const autoResize = (el: HTMLTextAreaElement, btn: HTMLButtonElement, maxH: number) => {
      el.addEventListener('input', () => {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
        btn.disabled = !el.value.trim() && !this.isStreaming;
      });
    };
    autoResize(this.textareaEl, this.sendBtnEl, 200);
    autoResize(this.welcomeTextareaEl, this.welcomeSendBtnEl, 120);

    // Tool mode buttons (both welcome and chat)
    this.root.querySelectorAll('[data-tool]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tool = (btn as HTMLElement).dataset.tool!;
        if ((btn as HTMLElement).dataset.more) {
          e.stopPropagation();
          this.toggleMoreDropdown(btn as HTMLElement);
          return;
        }
        if (this.activeToolMode === tool) {
          this.activeToolMode = null;
          this.root.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        } else {
          this.root.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
          this.activeToolMode = tool;
          this.root.querySelectorAll(`[data-tool="${tool}"]`).forEach(b => b.classList.add('active'));
        }
      });
    });

    // More dropdown items
    this.moreDropdownEl.querySelectorAll('.agent-more-item').forEach(item => {
      item.addEventListener('click', () => {
        const tool = (item as HTMLElement).dataset.tool!;
        this.activeToolMode = tool;
        this.root.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        this.closeMoreDropdown();
        this.focusActiveInput();
      });
    });

    // Quick action cards — start a new chat with a meaningful prompt
    this.root.querySelectorAll('.agent-quick-card').forEach(card => {
      card.addEventListener('click', () => {
        const action = (card as HTMLElement).dataset.action!;
        if (action === 'discover') {
          this.navigateTo('discover');
          return;
        }
        const promptMap: Record<string, string> = {
          intel: '请分析当前全球地缘政治热点事件，包括主要冲突、外交动态和战略趋势',
          research: '请深度研究以下主题，给出详细的多角度分析和可靠来源',
          code: '你是一个高级编程助手。请帮我编写代码，要求清晰、高效、有注释。',
          market: '请分析当前全球金融市场状态，包括主要指数、汇率、大宗商品走势和市场情绪',
        };
        this.activeToolMode = action;
        this.root.querySelectorAll('[data-tool]').forEach(b => {
          b.classList.toggle('active', (b as HTMLElement).dataset.tool === action);
        });
        this.welcomeTextareaEl.value = promptMap[action] || '';
        this.welcomeTextareaEl.focus();
        this.welcomeSendBtnEl.disabled = !this.welcomeTextareaEl.value.trim();
      });
    });

    // Model selector
    this.modelSelectorEl.addEventListener('click', () => this.toggleModelDropdown());

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
      const target = e.target as Node;
      if (this.modelDropdownOpen && !this.modelSelectorEl.contains(target) && !this.modelDropdownEl.contains(target)) {
        this.closeModelDropdown();
      }
      if (this.moreDropdownOpen && !this.moreDropdownEl.contains(target)) {
        this.closeMoreDropdown();
      }
    });

    // Settings
    const openSettings = () => this.openSettings();
    document.getElementById('settings-btn')!.addEventListener('click', openSettings);
    document.getElementById('topbar-settings')!.addEventListener('click', openSettings);
    document.getElementById('settings-cancel')!.addEventListener('click', () => this.closeSettings());
    document.getElementById('settings-save')!.addEventListener('click', () => this.saveSettingsFromUI());
    document.getElementById('set-provider')!.addEventListener('change', () => this.toggleSettingsFields());

    // Settings overlay click-to-close
    this.settingsOverlayEl.addEventListener('click', (e) => {
      if (e.target === this.settingsOverlayEl) this.closeSettings();
    });

    // Color picker sync
    const syncColor = (pickerId: string, textId: string) => {
      const picker = document.getElementById(pickerId) as HTMLInputElement;
      const text = document.getElementById(textId) as HTMLInputElement;
      if (picker && text) {
        picker.addEventListener('input', () => { text.value = picker.value; });
        text.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(text.value)) picker.value = text.value; });
      }
    };
    syncColor('set-bg-color', 'set-bg-color-text');

    // Dashboard / Discover links
    document.getElementById('dashboard-link')!.addEventListener('click', () => { window.location.href = '/'; });
    document.getElementById('topbar-dashboard')!.addEventListener('click', () => { window.location.href = '/'; });
    document.getElementById('discover-link')!.addEventListener('click', () => this.navigateTo('discover'));

    // Temperature label update
    document.getElementById('set-temperature')!.addEventListener('input', (e) => {
      const val = (e.target as HTMLInputElement).value;
      const label = (e.target as HTMLElement).parentElement!.querySelector('.agent-settings-label')!;
      label.textContent = `${s.temperature} (${val})`;
    });

    // Sidebar toggle
    document.getElementById('sidebar-toggle-btn')?.addEventListener('click', () => {
      document.getElementById('agent-sidebar')!.classList.toggle('collapsed');
    });

    // Topbar collapse
    document.getElementById('topbar-collapse-btn')?.addEventListener('click', () => {
      this.topbarCollapsed = !this.topbarCollapsed;
      document.getElementById('agent-topbar')!.classList.toggle('collapsed', this.topbarCollapsed);
    });

    // Back button (from module page)
    document.getElementById('topbar-back-btn')?.addEventListener('click', () => {
      this.navigateTo('discover');
    });

    // Reference panel toggle
    document.getElementById('topbar-ref-btn')?.addEventListener('click', () => {
      this.toggleReferencesPanel();
    });
    document.getElementById('ref-close-btn')?.addEventListener('click', () => {
      this.toggleReferencesPanel(false);
    });
  }

  // ── Page Routing ──

  private navigateTo(page: PageRoute): void {
    this.currentPage = page;
    this.welcomeEl.classList.toggle('agent-hidden', page !== 'welcome');
    this.chatAreaEl.classList.toggle('agent-hidden', page !== 'chat');
    this.inputAreaEl.classList.toggle('agent-hidden', page !== 'chat');
    this.discoverEl.classList.toggle('agent-hidden', page !== 'discover');
    this.modulePageEl.classList.toggle('agent-hidden', page !== 'module');
    // Show back button on module page, hide otherwise
    const backBtn = document.getElementById('topbar-back-btn');
    if (backBtn) backBtn.classList.toggle('agent-hidden', page !== 'module');
    if (page === 'discover') this.renderDiscoverPage();
    if (page === 'module') this.renderModulePage();
    if (page === 'welcome') { this.messagesEl.innerHTML = ''; }
    // Close references panel when leaving chat
    if (page !== 'chat') this.toggleReferencesPanel(false);
  }

  // ── Discover Page ──

  private renderDiscoverPage(): void {
    const s = t();
    const catHtml = DISCOVER_CATEGORIES.map(c =>
      `<button class="agent-discover-cat ${this.discoverCategory === c ? 'active' : ''}" data-cat="${c}">${s[c]}</button>`
    ).join('');

    const filteredAgents = this.discoverCategory === 'allCategories'
      ? DISCOVER_AGENTS
      : DISCOVER_AGENTS.filter(a => a.category === this.discoverCategory.replace('cat', '').toLowerCase());

    this.discoverEl.innerHTML = `
      <div class="agent-discover-inner">
        <div class="agent-discover-header">
          <h2>${s.discoverTitle}</h2>
          <div class="agent-discover-search-wrap">
            ${ICON.search}
            <input class="agent-discover-search" placeholder="${s.searchAgents}" />
          </div>
        </div>

        <div class="agent-discover-banner">
          <span class="agent-discover-hot-badge">${s.hotNew}</span>
          <h3>World Monitor Agent ${s.featured}</h3>
        </div>

        <div class="agent-discover-featured">
          ${DISCOVER_FEATURED.map(m => `
            <div class="agent-discover-fcard" data-module="${m.id}">
              <div class="agent-discover-fcard-icon" style="color:${m.color}">${ICON[m.icon as keyof typeof ICON] || ''}</div>
              <div class="agent-discover-fcard-label">${s[m.labelKey]}</div>
              <button class="agent-discover-fcard-btn">${ICON.plus} ${s.startCreating}</button>
            </div>
          `).join('')}
        </div>

        <div class="agent-discover-side-cards">
          ${DISCOVER_SIDE.map(m => `
            <div class="agent-discover-scard" data-module="${m.id}">
              <div class="agent-discover-scard-icon" style="color:${m.color}">${ICON[m.icon as keyof typeof ICON] || ''}</div>
              <div class="agent-discover-scard-info">
                <div class="agent-discover-scard-name">${s[m.labelKey]}</div>
              </div>
            </div>
          `).join('')}
        </div>

        <div class="agent-discover-cats">${catHtml}</div>

        <div class="agent-discover-grid">
          ${filteredAgents.map(a => `
            <div class="agent-discover-agent" data-module="${a.id}">
              <div class="agent-discover-agent-icon" style="background:${a.color}20;color:${a.color}">${ICON[a.icon as keyof typeof ICON] || ''}</div>
              <div class="agent-discover-agent-info">
                <div class="agent-discover-agent-name">${s[a.labelKey]}</div>
                <div class="agent-discover-agent-desc">${a.desc}</div>
              </div>
              <div class="agent-discover-agent-meta">${ICON.heart} ${a.desc}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    // Bind category clicks
    this.discoverEl.querySelectorAll('.agent-discover-cat').forEach(btn => {
      btn.addEventListener('click', () => {
        this.discoverCategory = (btn as HTMLElement).dataset.cat!;
        this.renderDiscoverPage();
      });
    });

    // Bind module clicks → navigate to dedicated module sub-page
    this.discoverEl.querySelectorAll('[data-module]').forEach(el => {
      el.addEventListener('click', () => {
        this.activeModuleId = (el as HTMLElement).dataset.module!;
        this.navigateTo('module');
      });
    });
  }

  // ── Module Sub-page ──

  private renderModulePage(): void {
    const s = t();
    const allModules = [...DISCOVER_FEATURED, ...DISCOVER_SIDE, ...DISCOVER_AGENTS];
    const mod = allModules.find(m => m.id === this.activeModuleId);
    if (!mod) { this.navigateTo('discover'); return; }

    const label = s[mod.labelKey] || mod.id;
    const icon = ICON[mod.icon as keyof typeof ICON] || '';

    this.modulePageEl.innerHTML = `
      <div class="agent-module-inner">
        <div class="agent-module-hero">
          <div class="agent-module-icon" style="background:${mod.color}20;color:${mod.color}">${icon}</div>
          <h2 class="agent-module-title">${label}</h2>
          <p class="agent-module-desc">${s.moduleDesc}</p>
        </div>
        <div class="agent-module-actions">
          <button class="agent-btn-primary agent-module-try" id="module-try-btn">${ICON.send} ${s.tryIt}</button>
          <button class="agent-btn-secondary agent-module-back" id="module-back-btn">${ICON.arrowLeft} ${s.back}</button>
        </div>
        <div class="agent-module-input-wrap">
          <textarea class="agent-textarea agent-module-textarea" id="module-input" rows="3" placeholder="${s.inputPlaceholder}"></textarea>
        </div>
      </div>
    `;

    // Bind module page events
    document.getElementById('module-try-btn')?.addEventListener('click', () => {
      const input = document.getElementById('module-input') as HTMLTextAreaElement;
      const text = input?.value.trim();
      this.activeToolMode = this.activeModuleId;
      if (text) {
        this.welcomeTextareaEl.value = text;
      }
      this.navigateTo('welcome');
      if (text) {
        this.handleWelcomeSend();
      } else {
        this.welcomeTextareaEl.focus();
      }
    });

    document.getElementById('module-back-btn')?.addEventListener('click', () => {
      this.navigateTo('discover');
    });
  }

  // ── References Panel ──

  private toggleReferencesPanel(forceState?: boolean): void {
    this.referencesPanelOpen = forceState !== undefined ? forceState : !this.referencesPanelOpen;
    this.referencesPanelEl.classList.toggle('open', this.referencesPanelOpen);
    // Update topbar reference tab indicator
    const refBtn = document.getElementById('topbar-ref-btn');
    if (refBtn) refBtn.classList.toggle('active', this.referencesPanelOpen);
  }

  private updateReferencesPanel(content: string): void {
    const s = t();
    // Extract links from assistant content
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const links: Array<{text: string; url: string}> = [];
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      links.push({ text: match[1] ?? '', url: match[2] ?? '' });
    }

    // Also extract bare URLs
    const urlRegex = /https?:\/\/[^\s<>"]+/g;
    while ((match = urlRegex.exec(content)) !== null) {
      const url = match[0];
      if (!links.some(l => l.url === url)) {
        try {
          const hostname = new URL(url).hostname;
          links.push({ text: hostname, url });
        } catch { /* skip invalid URLs */ }
      }
    }

    const refList = document.getElementById('ref-list');
    if (!refList) return;

    if (links.length === 0) {
      refList.innerHTML = `<div class="agent-ref-empty">${s.references}: 0</div>`;
      return;
    }

    refList.innerHTML = links.map((link, i) => `
      <a class="agent-ref-item" href="${this.escapeAttr(link.url)}" target="_blank" rel="noopener">
        <span class="agent-ref-num">${i + 1}</span>
        <div class="agent-ref-item-info">
          <div class="agent-ref-item-title">${this.escapeHtml(link.text)}</div>
          <div class="agent-ref-item-url">${this.escapeHtml(link.url)}</div>
        </div>
        ${ICON.externalLink}
      </a>
    `).join('');

    // Update topbar center with reference count badge
    const center = document.getElementById('topbar-center');
    if (center && links.length > 0) {
      center.innerHTML = `<button class="agent-ref-badge" id="topbar-ref-badge">${s.references} (${links.length})</button>`;
      document.getElementById('topbar-ref-badge')?.addEventListener('click', () => {
        this.toggleReferencesPanel();
      });
    }
  }

  // ── Conversation Management ──

  private newChat(): void {
    const conv = createConversation(this.getActiveModel());
    this.conversations.unshift(conv);
    saveConversations(this.conversations);
    this.setActiveConversation(conv.id);
    this.renderConversationList();
    this.focusActiveInput();
  }

  private setActiveConversation(id: string): void {
    this.activeConvId = id;
    const conv = this.getActiveConversation();
    if (conv && conv.messages.length > 0) {
      this.navigateTo('chat');
      this.renderMessages(conv.messages);
    } else {
      this.navigateTo('welcome');
    }
    this.renderConversationList();
  }

  private getActiveConversation(): Conversation | undefined {
    return this.conversations.find(c => c.id === this.activeConvId);
  }

  private renderConversationList(): void {
    const s = t();
    if (this.conversations.length === 0) {
      this.convListEl.innerHTML = `<div class="agent-conv-empty">${s.noChats}</div>`;
      return;
    }

    this.convListEl.innerHTML = this.conversations.map(conv => `
      <div class="agent-conv-item ${conv.id === this.activeConvId ? 'active' : ''}" data-id="${conv.id}">
        <span class="conv-icon">${ICON.chat}</span>
        <span class="conv-title">${this.escapeHtml(conv.title)}</span>
        <button class="conv-delete" data-delete="${conv.id}" title="${s.delete}">${ICON.trash}</button>
      </div>
    `).join('');

    this.convListEl.querySelectorAll('.agent-conv-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.conv-delete')) return;
        this.setActiveConversation((item as HTMLElement).dataset.id!);
      });
    });

    this.convListEl.querySelectorAll('.conv-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.delete!;
        this.conversations = deleteConversation(this.conversations, id);
        saveConversations(this.conversations);
        if (this.activeConvId === id) {
          this.activeConvId = this.conversations[0]?.id || null;
          if (this.activeConvId) this.setActiveConversation(this.activeConvId);
          else this.navigateTo('welcome');
        }
        this.renderConversationList();
      });
    });
  }

  // ── Chat Logic ──

  private handleWelcomeSend(): void {
    const text = this.welcomeTextareaEl.value.trim();
    if (!text) return;
    this.textareaEl.value = text;
    this.welcomeTextareaEl.value = '';
    this.welcomeSendBtnEl.disabled = true;
    this.handleSend();
  }

  private async handleSend(): Promise<void> {
    const s = t();
    if (this.isStreaming) {
      abortChat();
      this.isStreaming = false;
      this.sendBtnEl.innerHTML = ICON.send;
      return;
    }

    const text = this.textareaEl.value.trim();
    if (!text) return;

    if (!this.activeConvId) this.newChat();
    const conv = this.getActiveConversation();
    if (!conv) return;

    const userMsg: ChatMessage = {
      id: generateId(), role: 'user', content: text,
      timestamp: Date.now(), toolMode: this.activeToolMode || undefined,
    };
    conv.messages.push(userMsg);
    conv.updatedAt = Date.now();
    updateConversationTitle(conv);
    saveConversations(this.conversations);
    this.renderConversationList();

    this.textareaEl.value = '';
    this.textareaEl.style.height = 'auto';
    this.sendBtnEl.disabled = true;

    this.navigateTo('chat');
    this.appendMessageToDOM(userMsg);

    // Validate API key before sending
    if (this.settings.provider === 'custom' && !this.settings.customApiKey) {
      const warnDiv = document.createElement('div');
      warnDiv.className = 'agent-msg';
      warnDiv.innerHTML = `
        <div class="agent-msg-avatar assistant">W</div>
        <div class="agent-msg-body">
          <div class="agent-msg-content">
            <p style="color:var(--agent-danger)">⚠️ API Key 未设置</p>
            <p>请在 <strong>Settings → Custom API → API Key</strong> 中输入你的 API 密钥后重试。</p>
            <p style="font-size:12px;color:var(--agent-text-3)">Base URL: ${this.escapeHtml(this.settings.customBaseUrl)}<br/>Model: ${this.escapeHtml(this.settings.customModel)}</p>
          </div>
        </div>`;
      this.messagesEl.appendChild(warnDiv);
      this.scrollToBottom();
      // Remove the user message from conversation since we can't process it
      conv.messages.pop();
      saveConversations(this.conversations);
      return;
    }

    this.isStreaming = true;
    this.sendBtnEl.innerHTML = ICON.stop;
    this.sendBtnEl.disabled = false;

    const assistantMsg: ChatMessage = {
      id: generateId(), role: 'assistant', content: '',
      timestamp: Date.now(), model: this.getActiveModel(),
    };

    const bubbleEl = this.createAssistantBubble(assistantMsg.id);
    this.messagesEl.appendChild(bubbleEl);
    this.scrollToBottom();

    const contentEl = bubbleEl.querySelector('.agent-msg-content')!;
    contentEl.innerHTML = '<div class="agent-typing"><span></span><span></span><span></span></div>';

    await streamChat(conv.messages, this.settings, this.activeToolMode || undefined, {
      onSearch: (status, resultCount) => {
        if (status === 'searching') {
          contentEl.innerHTML = '<div class="agent-search-indicator"><span class="agent-search-icon">🔍</span><span class="agent-search-text">搜索实时资讯…</span><span class="agent-search-dots"><span></span><span></span><span></span></span></div>';
        } else {
          const found = resultCount && resultCount > 0;
          contentEl.innerHTML = found
            ? `<div class="agent-search-indicator done"><span class="agent-search-icon">✅</span><span class="agent-search-text">已获取 ${resultCount} 条实时资讯</span></div><div class="agent-typing"><span></span><span></span><span></span></div>`
            : '<div class="agent-typing"><span></span><span></span><span></span></div>';
        }
        this.scrollToBottom();
      },
      onToken: (token) => {
        assistantMsg.content += token;
        contentEl.innerHTML = renderMarkdown(assistantMsg.content);
        this.scrollToBottom();
      },
      onDone: (fullText) => {
        assistantMsg.content = fullText;
        contentEl.innerHTML = renderMarkdown(fullText || `*${s.noResponse}*`);
        conv.messages.push(assistantMsg);
        conv.updatedAt = Date.now();
        saveConversations(this.conversations);
        this.isStreaming = false;
        this.sendBtnEl.innerHTML = ICON.send;
        this.sendBtnEl.disabled = true;
        // Re-render the last message with full actions + follow-ups
        bubbleEl.remove();
        this.appendMessageToDOM(assistantMsg);
        // Update references panel
        this.updateReferencesPanel(fullText);
        this.scrollToBottom();
      },
      onError: (error) => {
        contentEl.innerHTML = `<p style="color:var(--agent-danger)">${s.errorPrefix}: ${this.escapeHtml(error)}</p>
          <p style="color:var(--agent-text-3);font-size:12px">${s.errorHint}</p>`;
        this.isStreaming = false;
        this.sendBtnEl.innerHTML = ICON.send;
        this.sendBtnEl.disabled = true;
      },
    });
  }

  // ── DOM Helpers ──

  private focusActiveInput(): void {
    if (this.currentPage === 'welcome') this.welcomeTextareaEl.focus();
    else if (this.currentPage === 'chat') this.textareaEl.focus();
  }

  private renderMessages(messages: ChatMessage[]): void {
    this.messagesEl.innerHTML = '';
    for (const msg of messages) this.appendMessageToDOM(msg);
    this.scrollToBottom();
  }

  private appendMessageToDOM(msg: ChatMessage): void {
    const s = t();
    const div = document.createElement('div');
    div.className = 'agent-msg';
    div.dataset.id = msg.id;
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (msg.role === 'user') {
      div.innerHTML = `
        <div class="agent-msg-avatar user">U</div>
        <div class="agent-msg-body">
          <div class="agent-msg-role">${s.you} <span class="agent-msg-time">${timeStr}</span></div>
          <div class="agent-msg-content">${renderMarkdown(msg.content)}</div>
          <div class="agent-msg-actions">
            <button class="agent-msg-action-btn copy-msg" data-text="${this.escapeAttr(msg.content)}">${ICON.copy}</button>
            <button class="agent-msg-action-btn edit-msg">${ICON.edit}</button>
          </div>
        </div>
      `;
    } else {
      // Extract reference count for badge
      const refCount = (msg.content.match(/\[([^\]]+)\]\(([^)]+)\)/g) || []).length;
      const refBadge = refCount > 0
        ? `<button class="agent-msg-ref-badge" data-content="${this.escapeAttr(msg.content)}">${ICON.link} ${refCount}${s.refSources}</button>`
        : '';

      div.innerHTML = `
        <div class="agent-msg-avatar assistant">W</div>
        <div class="agent-msg-body">
          <div class="agent-msg-role">${s.agent}${msg.model ? ` · ${msg.model}` : ''} <span class="agent-msg-time">${timeStr}</span></div>
          <div class="agent-msg-content">${renderMarkdown(msg.content)}</div>
          <div class="agent-msg-actions">
            <button class="agent-msg-action-btn copy-msg" data-text="${this.escapeAttr(msg.content)}">${ICON.copy}</button>
            <button class="agent-msg-action-btn like-msg">${ICON.thumbUp}</button>
            <button class="agent-msg-action-btn dislike-msg">${ICON.thumbDown}</button>
            <button class="agent-msg-action-btn share-msg">${ICON.share}</button>
            <button class="agent-msg-action-btn regen-msg">${ICON.refresh}</button>
            ${refBadge}
          </div>
          ${this.renderFollowUpQuestions(msg.content)}
        </div>
      `;
    }

    // Copy button
    div.querySelectorAll('.copy-msg').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = (btn as HTMLElement).dataset.text || '';
        navigator.clipboard.writeText(text).then(() => {
          btn.innerHTML = `${ICON.check}`;
          setTimeout(() => { btn.innerHTML = `${ICON.copy}`; }, 1500);
        });
      });
    });

    // Like/dislike feedback
    div.querySelectorAll('.like-msg, .dislike-msg').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
      });
    });

    // Reference badge → open references panel
    div.querySelectorAll('.agent-msg-ref-badge').forEach(btn => {
      btn.addEventListener('click', () => {
        const content = (btn as HTMLElement).dataset.content || '';
        this.updateReferencesPanel(content);
        this.toggleReferencesPanel(true);
      });
    });

    // Follow-up question cards
    div.querySelectorAll('.agent-followup-card').forEach(card => {
      card.addEventListener('click', () => {
        const question = (card as HTMLElement).dataset.question || '';
        this.textareaEl.value = question;
        this.sendBtnEl.disabled = false;
        this.handleSend();
      });
    });

    // Regenerate
    div.querySelectorAll('.regen-msg').forEach(btn => {
      btn.addEventListener('click', () => {
        const conv = this.getActiveConversation();
        if (!conv || conv.messages.length < 2) return;
        // Remove last assistant message, re-send
        conv.messages.pop();
        saveConversations(this.conversations);
        this.renderMessages(conv.messages);
        const lastUser = conv.messages[conv.messages.length - 1];
        if (lastUser && lastUser.role === 'user') {
          this.textareaEl.value = lastUser.content;
          conv.messages.pop();
          this.handleSend();
        }
      });
    });

    // Edit user message
    div.querySelectorAll('.edit-msg').forEach(btn => {
      btn.addEventListener('click', () => {
        if (msg.role === 'user') {
          this.textareaEl.value = msg.content;
          this.sendBtnEl.disabled = false;
          this.textareaEl.focus();
        }
      });
    });

    this.messagesEl.appendChild(div);
  }

  private renderFollowUpQuestions(content: string): string {
    // Generate contextual follow-up questions based on content
    const questions: string[] = [];
    if (content.length > 100) {
      // Extract key topics from content for follow-up suggestions
      const sentences = content.split(/[。.！!？?\n]+/).filter(s => s.trim().length > 10);
      const topics = sentences.slice(0, 3);
      for (const topic of topics) {
        const trimmed = topic.trim().slice(0, 40);
        if (trimmed.length > 10) {
          questions.push(trimmed + '？');
        }
      }
    }
    if (questions.length === 0) return '';

    return `
      <div class="agent-followup-section">
        ${questions.map(q => `
          <div class="agent-followup-card" data-question="${this.escapeAttr(q)}">
            <span>${this.escapeHtml(q)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  private createAssistantBubble(id: string): HTMLElement {
    const s = t();
    const div = document.createElement('div');
    div.className = 'agent-msg';
    div.dataset.id = id;
    div.innerHTML = `
      <div class="agent-msg-avatar assistant">W</div>
      <div class="agent-msg-body">
        <div class="agent-msg-role">${s.agent} · ${this.getActiveModel()}</div>
        <div class="agent-msg-content"></div>
      </div>
    `;
    return div;
  }

  private scrollToBottom(): void {
    const main = this.chatAreaEl.querySelector('.agent-chat-main') || this.chatAreaEl;
    main.scrollTop = main.scrollHeight;
  }

  // ── More Dropdown ──

  private toggleMoreDropdown(trigger: HTMLElement): void {
    if (this.moreDropdownOpen) { this.closeMoreDropdown(); return; }
    this.moreDropdownOpen = true;
    const rect = trigger.getBoundingClientRect();
    const mainRect = document.getElementById('agent-main')!.getBoundingClientRect();
    this.moreDropdownEl.style.top = `${rect.bottom - mainRect.top + 4}px`;
    this.moreDropdownEl.style.left = `${rect.left - mainRect.left}px`;
    this.moreDropdownEl.classList.add('open');
  }

  private closeMoreDropdown(): void {
    this.moreDropdownOpen = false;
    this.moreDropdownEl.classList.remove('open');
  }

  // ── Model Selector ──

  private getActiveModel(): string {
    if (this.settings.provider === 'custom') return this.settings.customModel || 'claude-sonnet-4-6';
    if (this.settings.provider === 'ollama') return this.settings.ollamaModel;
    if (this.settings.provider === 'groq') return 'llama-3.1-8b-instant';
    return 'openrouter/auto';
  }

  private getModelDisplayName(): string {
    const model = this.getActiveModel();
    if (this.settings.provider === 'custom') {
      // Pretty-print model name
      const nameMap: Record<string, string> = {
        'claude-opus-4-6-max': 'Claude Opus 4.6 Max',
        'claude-opus-4-6-gemini': 'Claude Opus 4.6 Gemini',
        'claude-sonnet-4-6': 'Claude Sonnet 4.6',
        'gemini-3.1-pro-high': 'Gemini 3.1 Pro High',
        'kimi-k2.5': 'Kimi K2.5',
        'qwen3.5-plus': 'Qwen 3.5 Plus',
      };
      return nameMap[model] || model;
    }
    const provider = this.settings.provider.charAt(0).toUpperCase() + this.settings.provider.slice(1);
    return `${model} (${provider})`;
  }

  private async toggleModelDropdown(): Promise<void> {
    if (this.modelDropdownOpen) { this.closeModelDropdown(); return; }
    this.modelDropdownOpen = true;
    this.modelSelectorEl.classList.add('open');
    this.modelDropdownEl.classList.add('open');

    const models: Array<{ name: string; desc: string; provider: string; model: string; icon: string }> = [];

    // Custom API models (shown first if configured)
    const customModels = [
      { id: 'claude-opus-4-6-max', name: 'Claude Opus 4.6 Max', icon: '🟣' },
      { id: 'claude-opus-4-6-gemini', name: 'Claude Opus 4.6 Gemini', icon: '🟣' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', icon: '🔵' },
      { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High', icon: '🔴' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', icon: '�' },
      { id: 'qwen3.5-plus', name: 'Qwen 3.5 Plus', icon: '🟠' },
    ];
    if (this.settings.customApiKey) {
      const host = this.settings.customBaseUrl ? new URL(this.settings.customBaseUrl).hostname : 'custom';
      for (const cm of customModels) {
        models.push({ name: cm.name, desc: host, provider: 'custom', model: cm.id, icon: cm.icon });
      }
    } else {
      // Show current custom model even without key
      const cur = customModels.find(m => m.id === this.settings.customModel) ?? customModels[0]!;
      models.push({ name: cur.name, desc: 'Custom API (no key set)', provider: 'custom', model: cur.id, icon: cur.icon });
    }

    // Cloud providers
    models.push(
      { name: 'Groq — Llama 3.1 8B', desc: 'Cloud, ultra-fast', provider: 'groq', model: 'llama-3.1-8b-instant', icon: '⚡' },
      { name: 'OpenRouter — Auto', desc: 'Cloud, auto-select', provider: 'openrouter', model: 'openrouter/auto', icon: '🌐' },
    );

    // Local Ollama
    if (this.settings.ollamaUrl) {
      const ollamaModels = await fetchOllamaModels(this.settings.ollamaUrl);
      for (const m of ollamaModels) {
        models.push({ name: `Ollama — ${m}`, desc: 'Local, no API key', provider: 'ollama', model: m, icon: '🏠' });
      }
      if (ollamaModels.length === 0) {
        models.push({ name: `Ollama — ${this.settings.ollamaModel}`, desc: 'Local (offline)', provider: 'ollama', model: this.settings.ollamaModel, icon: '🏠' });
      }
    }

    this.modelDropdownEl.innerHTML = `
      <div class="agent-model-dropdown-title">Model</div>
      ${models.map(m => {
        const sel = m.provider === this.settings.provider && m.model === this.getActiveModel();
        return `
          <div class="agent-model-option ${sel ? 'selected' : ''}" data-provider="${m.provider}" data-model="${m.model}">
            <div class="agent-model-option-icon">${m.icon}</div>
            <div class="agent-model-option-info">
              <div class="agent-model-option-name">${m.name}</div>
              <div class="agent-model-option-desc">${m.desc}</div>
            </div>
            <div class="agent-model-option-check">${ICON.check}</div>
          </div>`;
      }).join('')}
    `;

    this.modelDropdownEl.querySelectorAll('.agent-model-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const el = opt as HTMLElement;
        const prov = el.dataset.provider as AgentSettings['provider'];
        this.settings.provider = prov;
        if (prov === 'ollama') this.settings.ollamaModel = el.dataset.model!;
        if (prov === 'custom') this.settings.customModel = el.dataset.model!;
        saveSettings(this.settings);
        document.getElementById('model-name')!.textContent = this.getModelDisplayName();
        this.closeModelDropdown();
      });
    });
  }

  private closeModelDropdown(): void {
    this.modelDropdownOpen = false;
    this.modelSelectorEl.classList.remove('open');
    this.modelDropdownEl.classList.remove('open');
  }

  // ── Settings ──

  private openSettings(): void { this.settingsOverlayEl.classList.add('open'); }
  private closeSettings(): void { this.settingsOverlayEl.classList.remove('open'); }

  private toggleSettingsFields(): void {
    const provider = (document.getElementById('set-provider') as HTMLSelectElement)?.value || this.settings.provider;
    const toggle = (id: string, show: boolean) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('agent-hidden', !show);
    };
    toggle('set-custom-baseurl-group', provider === 'custom');
    toggle('set-custom-apikey-group', provider === 'custom');
    toggle('set-custom-model-group', provider === 'custom');
    toggle('set-ollama-group', provider === 'ollama');
    toggle('set-ollama-model-group', provider === 'ollama');
    toggle('set-groq-group', provider === 'groq');
    toggle('set-openrouter-group', provider === 'openrouter');
  }

  private saveSettingsFromUI(): void {
    this.settings.provider = (document.getElementById('set-provider') as HTMLSelectElement).value as AgentSettings['provider'];
    this.settings.customBaseUrl = (document.getElementById('set-custom-baseurl') as HTMLInputElement).value;
    this.settings.customApiKey = (document.getElementById('set-custom-apikey') as HTMLInputElement).value;
    this.settings.customModel = (document.getElementById('set-custom-model') as HTMLSelectElement).value;
    this.settings.ollamaUrl = (document.getElementById('set-ollama-url') as HTMLInputElement).value;
    this.settings.ollamaModel = (document.getElementById('set-ollama-model') as HTMLInputElement).value;
    this.settings.groqKey = (document.getElementById('set-groq-key') as HTMLInputElement).value;
    this.settings.openrouterKey = (document.getElementById('set-openrouter-key') as HTMLInputElement).value;
    this.settings.systemPrompt = (document.getElementById('set-system-prompt') as HTMLTextAreaElement).value;
    this.settings.temperature = parseFloat((document.getElementById('set-temperature') as HTMLInputElement).value);
    this.settings.language = (document.getElementById('set-language') as HTMLSelectElement).value;
    this.settings.bgColor = (document.getElementById('set-bg-color') as HTMLInputElement).value;
    this.settings.gradientStart = (document.getElementById('set-grad-start') as HTMLInputElement).value;
    this.settings.gradientEnd = (document.getElementById('set-grad-end') as HTMLInputElement).value;
    saveSettings(this.settings);
    document.getElementById('model-name')!.textContent = this.getModelDisplayName();

    // Apply language change immediately
    const lang = this.settings.language === 'auto' ? detectLanguage() : this.settings.language as LangCode;
    setLanguage(lang);
    this.applyAppearance();

    this.closeSettings();
    // Re-render UI with new language
    this.render();
    this.bindEvents();
    this.setupCodeCopyButtons();
    if (this.activeConvId) {
      const conv = this.getActiveConversation();
      if (conv && conv.messages.length > 0) {
        this.navigateTo('chat');
        this.renderMessages(conv.messages);
      }
    }
  }

  private applyAppearance(): void {
    const root = document.documentElement;
    const bg = this.settings.bgColor || '#0f0f10';

    // Parse hex to RGB
    const hex2rgb = (hex: string): [number, number, number] => {
      const h = hex.replace('#', '');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    };
    const rgb2hex = (r: number, g: number, b: number): string =>
      '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
    const mix = (c: [number, number, number], amt: number): string =>
      rgb2hex(c[0] + amt, c[1] + amt, c[2] + amt);

    const [r, g, b] = hex2rgb(bg);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const isLight = lum > 0.5;

    // Derive all surface colors from base
    const shift = isLight ? -1 : 1;
    root.style.setProperty('--agent-bg', bg);
    root.style.setProperty('--agent-sidebar-bg', mix([r, g, b], shift * 6));
    root.style.setProperty('--agent-bg-elevated', mix([r, g, b], shift * 12));
    root.style.setProperty('--agent-card', mix([r, g, b], shift * 18));
    root.style.setProperty('--agent-card-hover', mix([r, g, b], shift * 24));

    // Ink channel — drives all rgba overlays in CSS via var(--agent-ink)
    root.style.setProperty('--agent-ink', isLight ? '0,0,0' : '255,255,255');

    // Text colors
    if (isLight) {
      root.style.setProperty('--agent-text', '#1a1a1f');
      root.style.setProperty('--agent-text-2', '#52525b');
      root.style.setProperty('--agent-text-3', '#8b8b96');
      root.style.setProperty('--agent-text-4', '#b4b4bd');
    } else {
      root.style.setProperty('--agent-text', '#ececef');
      root.style.setProperty('--agent-text-2', '#a1a1aa');
      root.style.setProperty('--agent-text-3', '#6b6b76');
      root.style.setProperty('--agent-text-4', '#45454d');
    }

    // Scrollbar
    if (isLight) {
      root.style.setProperty('scrollbar-color', 'rgba(0,0,0,0.12) transparent');
    } else {
      root.style.setProperty('scrollbar-color', 'rgba(255,255,255,0.08) transparent');
    }

    // Message avatar colors
    root.style.setProperty('--agent-avatar-user-bg', isLight ? 'rgba(100,108,255,0.12)' : 'rgba(100,108,255,0.15)');
    root.style.setProperty('--agent-avatar-assistant-bg', isLight ? 'rgba(52,211,153,0.12)' : 'rgba(52,211,153,0.15)');

    // Shadow
    if (isLight) {
      root.style.setProperty('--agent-shadow-sm', '0 1px 2px rgba(0,0,0,0.06)');
      root.style.setProperty('--agent-shadow', '0 4px 16px rgba(0,0,0,0.08)');
      root.style.setProperty('--agent-shadow-lg', '0 8px 32px rgba(0,0,0,0.12)');
    } else {
      root.style.setProperty('--agent-shadow-sm', '0 1px 2px rgba(0,0,0,0.2)');
      root.style.setProperty('--agent-shadow', '0 4px 16px rgba(0,0,0,0.25)');
      root.style.setProperty('--agent-shadow-lg', '0 8px 32px rgba(0,0,0,0.35)');
    }

    // Gradient background
    if (this.settings.gradientStart && this.settings.gradientEnd) {
      document.body.style.background = `linear-gradient(135deg, ${this.settings.gradientStart}, ${this.settings.gradientEnd})`;
    } else {
      document.body.style.background = '';
    }
  }

  // ── Util ──

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private escapeAttr(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private setupCodeCopyButtons(): void {
    document.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.agent-code-copy');
      if (!btn) return;
      const pre = btn.closest('pre');
      if (!pre) return;
      const code = pre.querySelector('code');
      if (!code) return;
      navigator.clipboard.writeText(code.textContent || '').then(() => {
        btn.textContent = '✅ Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    });
  }
}
