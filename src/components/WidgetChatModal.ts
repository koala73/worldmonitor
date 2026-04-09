import type { CustomWidgetSpec } from '@/services/widget-store';
import { getBrowserTesterKey, getWidgetAgentKey, getProWidgetKey } from '@/services/widget-store';
import { getClerkToken } from '@/services/clerk';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { widgetAgentHealthUrl, widgetAgentUrl } from '@/utils/proxy';
import { wrapWidgetHtml, wrapProWidgetHtml } from '@/utils/widget-sanitizer';
import { track } from '@/services/analytics';

interface WidgetChatOptions {
  mode: 'create' | 'modify';
  tier?: 'basic' | 'pro';
  existingSpec?: CustomWidgetSpec;
  /** Pre-fill the chat input with this text. Used when opening from the analyst action chip. */
  initialMessage?: string;
  onComplete: (spec: CustomWidgetSpec) => void;
}

type PreviewPhase = 'checking' | 'ready_to_prompt' | 'fetching' | 'composing' | 'complete' | 'error';
type WidgetAgentHealth = {
  ok?: boolean;
  agentEnabled?: boolean;
  widgetKeyConfigured?: boolean;
  anthropicConfigured?: boolean;
  proKeyConfigured?: boolean;
  error?: string;
};

const EXAMPLE_PROMPT_KEYS = [
  'widgets.examples.oilGold',
  'widgets.examples.cryptoMovers',
  'widgets.examples.flightDelays',
  'widgets.examples.conflictHotspots',
] as const;

const PRO_EXAMPLE_PROMPT_KEYS = [
  'widgets.proExamples.interactiveChart',
  'widgets.proExamples.sortableTable',
  'widgets.proExamples.animatedCounters',
  'widgets.proExamples.tabbedComparison',
] as const;

let overlay: HTMLElement | null = null;
let abortController: AbortController | null = null;
let clientTimeout: ReturnType<typeof setTimeout> | null = null;

async function buildWidgetAuthHeaders(isPro: boolean): Promise<Record<string, string>> {
  const testerKey = getBrowserTesterKey();
  const widgetKey = getWidgetAgentKey();
  const proKey = getProWidgetKey();
  if (testerKey || widgetKey || proKey) {
    const headers: Record<string, string> = {};
    if (testerKey) headers['X-WorldMonitor-Key'] = testerKey;
    if (widgetKey) headers['X-Widget-Key'] = widgetKey;
    if (isPro && proKey) headers['X-Pro-Key'] = proKey;
    return headers;
  }
  const token = await getClerkToken();
  if (token) return { 'Authorization': `Bearer ${token}` };
  return {};
}

export function openWidgetChatModal(options: WidgetChatOptions): void {
  closeWidgetChatModal();
  track('widget-ai-open', { panelId: options.existingSpec?.id });

  const currentTier: 'basic' | 'pro' = options.tier ?? options.existingSpec?.tier ?? 'basic';
  const isPro = currentTier === 'pro';

  overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';

  const modal = document.createElement('div');
  modal.className = 'modal widget-chat-modal';

  const isModify = options.mode === 'modify';
  const titleText = isModify ? t('widgets.modifyTitle') : t('widgets.chatTitle');
  const proBadgeHtml = isPro ? `<span class="widget-pro-badge">${escapeHtml(t('widgets.proBadge'))}</span>` : '';

  modal.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">${escapeHtml(titleText)}${proBadgeHtml}</span>
      <button class="modal-close" aria-label="${escapeHtml(t('common.close'))}">\u2715</button>
    </div>
    <div class="widget-chat-layout">
      <section class="widget-chat-sidebar">
        <div class="widget-chat-readiness"></div>
        <div class="widget-chat-messages"></div>
        <div class="widget-chat-examples">
          <div class="widget-chat-examples-label">${t('widgets.examplesTitle')}</div>
          <div class="widget-chat-examples-list"></div>
        </div>
        <div class="widget-chat-input-row">
          <textarea class="widget-chat-input" placeholder="${t('widgets.inputPlaceholder')}" rows="3"></textarea>
          <button class="widget-chat-send">${t('widgets.send')}</button>
        </div>
      </section>
      <section class="widget-chat-main">
        <div class="widget-chat-preview"></div>
      </section>
    </div>
    <div class="widget-chat-footer">
      <div class="widget-chat-footer-status"></div>
      <button class="widget-chat-action-btn" disabled>${isModify ? t('widgets.applyChanges') : t('widgets.addToDashboard')}</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const messagesEl = modal.querySelector('.widget-chat-messages') as HTMLElement;
  const previewEl = modal.querySelector('.widget-chat-preview') as HTMLElement;
  const readinessEl = modal.querySelector('.widget-chat-readiness') as HTMLElement;
  const examplesEl = modal.querySelector('.widget-chat-examples-list') as HTMLElement;
  const footerStatusEl = modal.querySelector('.widget-chat-footer-status') as HTMLElement;
  const inputEl = modal.querySelector('.widget-chat-input') as HTMLTextAreaElement;
  const sendBtn = modal.querySelector('.widget-chat-send') as HTMLButtonElement;
  const actionBtn = modal.querySelector('.widget-chat-action-btn') as HTMLButtonElement;
  const closeBtn = modal.querySelector('.modal-close') as HTMLButtonElement;

  const sessionHistory = [...(options.existingSpec?.conversationHistory ?? [])];
  let currentSessionHtml: string | null = options.existingSpec?.html ?? null;
  let requestInFlight = false;
  let preflightReady = false;
  let pendingSaveSpec: CustomWidgetSpec | null = null;

  if (options.initialMessage) inputEl.value = options.initialMessage;

  if (isModify && options.existingSpec) {
    for (const msg of sessionHistory) {
      appendMessage(messagesEl, msg.role, msg.content);
    }
    if (currentSessionHtml) {
      renderPreviewHtml(previewEl, currentSessionHtml, options.existingSpec.title, t('widgets.phaseReadyToPrompt'), t('widgets.modifyHint'), isPro);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    setFooterStatus(footerStatusEl, t('widgets.modifyHint'));
  } else {
    renderPreviewState(previewEl, 'checking');
    setFooterStatus(footerStatusEl, t('widgets.checkingConnection'));
  }

  renderExampleChips(examplesEl, inputEl, isPro);
  syncComposerState();
  void runPreflight();

  closeBtn.addEventListener('click', closeWidgetChatModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWidgetChatModal(); });

  const escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeWidgetChatModal(); };
  document.addEventListener('keydown', escHandler);

  actionBtn.addEventListener('click', () => {
    if (!pendingSaveSpec) return;
    options.onComplete(pendingSaveSpec);
    closeWidgetChatModal();
  });

  async function runPreflight(): Promise<void> {
    setReadinessState(readinessEl, 'checking', t('widgets.checkingConnection'));
    try {
      const headers = await buildWidgetAuthHeaders(isPro);
      const res = await fetch(widgetAgentHealthUrl(), { headers });
      let payload: WidgetAgentHealth | null = null;
      try { payload = await res.json() as WidgetAgentHealth; } catch { /* ignore */ }

      if (!res.ok) {
        const message = resolvePreflightMessage(res.status, payload, isPro);
        preflightReady = false;
        setReadinessState(readinessEl, 'error', message);
        setFooterStatus(footerStatusEl, message, 'error');
        if (!currentSessionHtml) renderPreviewState(previewEl, 'error', message);
        syncComposerState();
        return;
      }

      if (isPro && payload?.proKeyConfigured === false) {
        const message = t('widgets.preflightProUnavailable');
        preflightReady = false;
        setReadinessState(readinessEl, 'error', message);
        setFooterStatus(footerStatusEl, message, 'error');
        if (!currentSessionHtml) renderPreviewState(previewEl, 'error', message);
        syncComposerState();
        return;
      }

      preflightReady = true;
      setReadinessState(readinessEl, 'ready', t('widgets.preflightConnected'));
      if (!currentSessionHtml) renderPreviewState(previewEl, 'ready_to_prompt');
      setFooterStatus(footerStatusEl, currentSessionHtml ? t('widgets.modifyHint') : t('widgets.readyToGenerate'));
      syncComposerState();
    } catch {
      preflightReady = false;
      const message = t('widgets.preflightUnavailable');
      setReadinessState(readinessEl, 'error', message);
      setFooterStatus(footerStatusEl, message, 'error');
      if (!currentSessionHtml) renderPreviewState(previewEl, 'error', message);
      syncComposerState();
    }
  }

  function syncComposerState(): void {
    sendBtn.disabled = requestInFlight || !preflightReady;
    sendBtn.textContent = requestInFlight ? t('widgets.generating') : t('widgets.send');
    actionBtn.disabled = !pendingSaveSpec;
  }

  const submit = async () => {
    const prompt = inputEl.value.trim();
    if (!prompt || sendBtn.disabled) return;
    track('widget-ai-generate');

    inputEl.value = '';
    requestInFlight = true;
    pendingSaveSpec = null;
    syncComposerState();
    appendMessage(messagesEl, 'user', prompt);
    renderPreviewState(previewEl, 'fetching');
    setFooterStatus(footerStatusEl, t('widgets.generating'));

    const existing = options.existingSpec;
    const body = JSON.stringify({
      prompt: prompt.slice(0, 2000),
      mode: options.mode,
      tier: currentTier,
      currentHtml: currentSessionHtml,
      conversationHistory: sessionHistory
        .map((m) => ({ role: m.role, content: m.content.slice(0, 500) })),
    });

    abortController = new AbortController();
    const timeoutMs = isPro ? 120_000 : 60_000;
    clientTimeout = setTimeout(() => {
      abortController?.abort();
      appendMessage(messagesEl, 'assistant', t('widgets.requestTimedOut'));
      renderPreviewState(previewEl, 'error', t('widgets.requestTimedOut'));
      setFooterStatus(footerStatusEl, t('widgets.requestTimedOut'), 'error');
      requestInFlight = false;
      syncComposerState();
    }, timeoutMs);

    try {
      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(await buildWidgetAuthHeaders(isPro)),
      };

      const res = await fetch(widgetAgentUrl(), {
        method: 'POST',
        signal: abortController.signal,
        headers: reqHeaders,
        body,
      });

      if (!res.ok || !res.body) {
        throw new Error(t('widgets.serverError', { status: res.status }));
      }

      let resultHtml = '';
      let resultTitle = existing?.title ?? 'Custom Widget';
      let toolBadgeEl: HTMLElement | null = null;
      const statusEl = appendMessage(messagesEl, 'assistant', '');
      const radarEl = document.createElement('span');
      radarEl.className = 'widget-chat-radar';
      radarEl.innerHTML = '<span class="panel-loading-radar"><span class="panel-radar-sweep"></span><span class="panel-radar-dot"></span></span>';
      statusEl.appendChild(radarEl);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: { type: string; [k: string]: unknown };
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.type === 'tool_call') {
            if (!toolBadgeEl) {
              toolBadgeEl = document.createElement('span');
              toolBadgeEl.className = 'widget-chat-tool-badge';
              statusEl.appendChild(toolBadgeEl);
            }
            const endpoint = String(event.endpoint ?? 'data');
            toolBadgeEl.textContent = t('widgets.fetching', { target: endpoint });
            renderPreviewState(previewEl, 'fetching', endpoint);
            setFooterStatus(footerStatusEl, t('widgets.fetching', { target: endpoint }));
          } else if (event.type === 'html_complete') {
            resultHtml = String(event.html ?? '');
            currentSessionHtml = resultHtml;
            renderPreviewHtml(previewEl, resultHtml, resultTitle, t('widgets.phaseComposing'), t('widgets.previewComposingCopy'), isPro);
            setFooterStatus(footerStatusEl, t('widgets.previewComposingCopy'));
          } else if (event.type === 'done') {
            resultTitle = String(event.title ?? 'Custom Widget');
            radarEl.remove();
            track('widget-ai-success', { title: resultTitle });
            const assistantSummary = t('widgets.generatedWidget', { title: resultTitle });
            sessionHistory.push(
              { role: 'user' as const, content: prompt },
              { role: 'assistant' as const, content: assistantSummary },
            );
            if (sessionHistory.length > 10) {
              sessionHistory.splice(0, sessionHistory.length - 10);
            }
            pendingSaveSpec = {
              id: existing?.id ?? `cw-${crypto.randomUUID()}`,
              title: resultTitle,
              html: resultHtml,
              prompt,
              tier: currentTier,
              accentColor: existing?.accentColor ?? null,
              conversationHistory: [...sessionHistory],
              createdAt: existing?.createdAt ?? Date.now(),
              updatedAt: Date.now(),
            };
            statusEl.textContent = t('widgets.ready', { title: resultTitle });
            if (toolBadgeEl) toolBadgeEl.remove();
            renderPreviewHtml(previewEl, resultHtml, resultTitle, t('widgets.phaseComplete'), t('widgets.previewReadyCopy'), isPro);
            setFooterStatus(footerStatusEl, t('widgets.readyToApply', { title: resultTitle }));
            actionBtn.textContent = isModify ? t('widgets.applyChanges') : t('widgets.addToDashboard');
            requestInFlight = false;
            syncComposerState();
          } else if (event.type === 'error') {
            const message = String(event.message ?? t('widgets.unknownError'));
            radarEl.remove();
            statusEl.textContent = `${t('common.error')}: ${message}`;
            renderPreviewState(previewEl, 'error', message);
            setFooterStatus(footerStatusEl, message, 'error');
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : t('widgets.unknownError');
      appendMessage(messagesEl, 'assistant', `${t('common.error')}: ${message}`);
      renderPreviewState(previewEl, 'error', message);
      setFooterStatus(footerStatusEl, message, 'error');
    } finally {
      if (clientTimeout) { clearTimeout(clientTimeout); clientTimeout = null; }
      requestInFlight = false;
      syncComposerState();
    }
  };

  sendBtn.addEventListener('click', () => void submit());
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  });

  (overlay as HTMLElement & { _escHandler: (e: KeyboardEvent) => void })._escHandler = escHandler;
  inputEl.focus();
}

export function closeWidgetChatModal(): void {
  if (abortController) { abortController.abort(); abortController = null; }
  if (clientTimeout) { clearTimeout(clientTimeout); clientTimeout = null; }
  if (overlay) {
    const o = overlay as HTMLElement & { _escHandler?: (e: KeyboardEvent) => void };
    if (o._escHandler) document.removeEventListener('keydown', o._escHandler);
    overlay.remove();
    overlay = null;
  }
}

function renderExampleChips(container: HTMLElement, inputEl: HTMLTextAreaElement, isPro: boolean): void {
  container.innerHTML = '';
  const keys = isPro ? PRO_EXAMPLE_PROMPT_KEYS : EXAMPLE_PROMPT_KEYS;
  for (const key of keys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'widget-chat-example-chip';
    btn.textContent = t(key);
    btn.addEventListener('click', () => {
      inputEl.value = t(key);
      inputEl.focus();
    });
    container.appendChild(btn);
  }
}

function resolvePreflightMessage(status: number, payload: WidgetAgentHealth | null, isPro: boolean): string {
  if (status === 403) return isPro ? t('widgets.preflightInvalidProKey') : t('widgets.preflightInvalidKey');
  if (status === 503 && payload?.proKeyConfigured === false) return t('widgets.preflightProUnavailable');
  if (payload?.anthropicConfigured === false) return t('widgets.preflightAiUnavailable');
  return t('widgets.preflightUnavailable');
}

function setReadinessState(container: HTMLElement, tone: 'checking' | 'ready' | 'error', text: string): void {
  container.className = `widget-chat-readiness is-${tone}`;
  container.textContent = text;
}

function setFooterStatus(container: HTMLElement, text: string, tone: 'muted' | 'error' = 'muted'): void {
  container.className = `widget-chat-footer-status is-${tone}`;
  container.textContent = text;
}

function renderPreviewState(container: HTMLElement, phase: PreviewPhase, detail = ''): void {
  const heading = getPreviewHeading(phase);
  const copy = detail || getPreviewCopy(phase);
  const isError = phase === 'error';

  container.innerHTML = `
    <div class="widget-chat-preview-state is-${phase}">
      <div class="widget-chat-preview-head">
        <div>
          <div class="widget-chat-preview-kicker">${escapeHtml(t('widgets.previewTitle'))}</div>
          <div class="widget-chat-preview-heading">${escapeHtml(heading)}</div>
        </div>
        <span class="widget-chat-phase-badge">${escapeHtml(getPhaseLabel(phase))}</span>
      </div>
      <p class="widget-chat-preview-copy">${escapeHtml(copy)}</p>
      ${isError ? `
        <div class="widget-chat-preview-alert">${escapeHtml(detail || t('widgets.previewErrorCopy'))}</div>
      ` : `
        <div class="widget-chat-preview-skeleton" aria-hidden="true">
          <span class="widget-chat-skeleton-line is-title"></span>
          <span class="widget-chat-skeleton-line"></span>
          <span class="widget-chat-skeleton-line is-short"></span>
          <div class="widget-chat-skeleton-grid">
            <span class="widget-chat-skeleton-card"></span>
            <span class="widget-chat-skeleton-card"></span>
            <span class="widget-chat-skeleton-card"></span>
          </div>
        </div>
      `}
    </div>
  `;
}

function renderPreviewHtml(
  container: HTMLElement,
  html: string,
  title: string,
  phaseLabel: string,
  description = '',
  isPro = false,
): void {
  const rendered = isPro
    ? wrapProWidgetHtml(html)
    : wrapWidgetHtml(html, 'wm-widget-shell-preview');

  container.innerHTML = `
    <div class="widget-chat-preview-frame">
      <div class="widget-chat-preview-head">
        <div>
          <div class="widget-chat-preview-kicker">${escapeHtml(t('widgets.previewTitle'))}</div>
          <div class="widget-chat-preview-heading">${escapeHtml(title)}</div>
        </div>
        <span class="widget-chat-phase-badge">${escapeHtml(phaseLabel)}</span>
      </div>
      ${description ? `<p class="widget-chat-preview-copy">${escapeHtml(description)}</p>` : ''}
      <div class="widget-chat-preview-render">
        ${rendered}
      </div>
    </div>
  `;
}

function getPhaseLabel(phase: PreviewPhase): string {
  switch (phase) {
    case 'checking': return t('widgets.phaseChecking');
    case 'ready_to_prompt': return t('widgets.phaseReadyToPrompt');
    case 'fetching': return t('widgets.phaseFetching');
    case 'composing': return t('widgets.phaseComposing');
    case 'complete': return t('widgets.phaseComplete');
    case 'error': return t('widgets.phaseError');
  }
}

function getPreviewHeading(phase: PreviewPhase): string {
  switch (phase) {
    case 'checking': return t('widgets.previewCheckingHeading');
    case 'ready_to_prompt': return t('widgets.previewReadyHeading');
    case 'fetching': return t('widgets.previewFetchingHeading');
    case 'composing': return t('widgets.previewComposingHeading');
    case 'complete': return t('widgets.previewReadyHeading');
    case 'error': return t('widgets.previewErrorHeading');
  }
}

function getPreviewCopy(phase: PreviewPhase): string {
  switch (phase) {
    case 'checking': return t('widgets.previewCheckingCopy');
    case 'ready_to_prompt': return t('widgets.previewReadyCopy');
    case 'fetching': return t('widgets.previewFetchingCopy');
    case 'composing': return t('widgets.previewComposingCopy');
    case 'complete': return t('widgets.previewReadyCopy');
    case 'error': return t('widgets.previewErrorCopy');
  }
}

function appendMessage(container: HTMLElement, role: 'user' | 'assistant', text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `widget-chat-msg ${role}`;
  el.textContent = text;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}
