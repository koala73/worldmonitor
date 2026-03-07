/**
 * Conversation persistence using localStorage.
 * Stores chat history with conversation metadata.
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;
  toolMode?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  model: string;
}

const STORAGE_KEY = 'wm-agent-conversations';
const SETTINGS_KEY = 'wm-agent-settings';

export interface AgentSettings {
  provider: 'ollama' | 'groq' | 'openrouter' | 'custom';
  ollamaUrl: string;
  ollamaModel: string;
  groqKey: string;
  openrouterKey: string;
  customBaseUrl: string;
  customApiKey: string;
  customModel: string;
  systemPrompt: string;
  temperature: number;
  language: string;
  bgColor: string;
  gradientStart: string;
  gradientEnd: string;
}

const DEFAULT_SETTINGS: AgentSettings = {
  provider: 'custom',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.1:8b',
  groqKey: '',
  openrouterKey: '',
  customBaseUrl: 'https://api.duojie.games',
  customApiKey: '',
  customModel: 'claude-sonnet-4-6',
  systemPrompt: 'You are World Monitor Agent, an AI assistant specialized in global intelligence, geopolitical analysis, market insights, and OSINT. You have access to real-time data about conflicts, military activity, infrastructure, markets, and news worldwide. Respond in the user\'s language. Be concise, factual, and analytical.',
  temperature: 0.7,
  language: 'auto',
  bgColor: '#0f0f10',
  gradientStart: '',
  gradientEnd: '',
};

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Conversation[];
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
}

export function createConversation(model: string): Conversation {
  return {
    id: generateId(),
    title: '新对话',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model,
  };
}

export function deleteConversation(conversations: Conversation[], id: string): Conversation[] {
  return conversations.filter(c => c.id !== id);
}

export function updateConversationTitle(conv: Conversation): void {
  if (conv.messages.length > 0) {
    const firstUserMsg = conv.messages.find(m => m.role === 'user');
    if (firstUserMsg) {
      conv.title = firstUserMsg.content.slice(0, 40) + (firstUserMsg.content.length > 40 ? '...' : '');
    }
  }
}

export function loadSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    // Migrate removed model names to valid ones
    if (settings.customModel === 'claude-opus-4-6') {
      settings.customModel = 'claude-sonnet-4-6';
    }
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AgentSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
