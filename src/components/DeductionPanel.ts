import { Panel } from './Panel';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { IntelligenceServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { h, replaceChildren } from '@/utils/dom-utils';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { NewsItem, DeductContextDetail } from '@/types';
import { buildNewsContext } from '@/utils/news-context';
import { getActiveFrameworkForPanel } from '@/services/analysis-framework-store';
import { hasPremiumAccess } from '@/services/panel-gating';
import { FrameworkSelector } from './FrameworkSelector';

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const COOLDOWN_MS = 5_000;

export class DeductionPanel extends Panel {
    private formEl: HTMLFormElement;
    private inputEl: HTMLTextAreaElement;
    private geoInputEl: HTMLInputElement;
    private resultContainer: HTMLElement;
    private submitBtn: HTMLButtonElement;
    private isSubmitting = false;
    private getLatestNews?: () => NewsItem[];
    private contextHandler: EventListener;
    private fwSelector: FrameworkSelector;

    constructor(getLatestNews?: () => NewsItem[]) {
        super({
            id: 'deduction',
            title: 'Deduct Situation',
            infoTooltip: 'Use AI intelligence to deduct the timeline and impact of a hypothetical or current event.',
        });

        this.getLatestNews = getLatestNews;

        this.inputEl = h('textarea', {
            className: 'deduction-input',
            placeholder: 'E.g., What will possibly happen in the next 24 hours in Middle East?',
            required: true,
            rows: 3,
        }) as HTMLTextAreaElement;

        this.geoInputEl = h('input', {
            className: 'deduction-geo-input',
            type: 'text',
            placeholder: 'Optional geographic or situation context...',
        }) as HTMLInputElement;

        this.submitBtn = h('button', {
            className: 'deduction-submit-btn',
            type: 'submit',
        }, 'Analyze') as HTMLButtonElement;

        this.formEl = h('form', { className: 'deduction-form' },
            this.inputEl,
            this.geoInputEl,
            this.submitBtn
        ) as HTMLFormElement;

        this.formEl.addEventListener('submit', this.handleSubmit.bind(this));

        this.resultContainer = h('div', { className: 'deduction-result' });

        const container = h('div', { className: 'deduction-panel-content' },
            this.formEl,
            this.resultContainer
        );

        replaceChildren(this.content, container);

        /* Styles moved to panels.css (PERF-012) */

        this.contextHandler = ((e: CustomEvent<DeductContextDetail>) => {
            const { query, geoContext, autoSubmit } = e.detail;

            if (query) {
                this.inputEl.value = query;
            }
            if (geoContext) {
                this.geoInputEl.value = geoContext;
            }

            this.show();

            this.element.animate([
                { backgroundColor: 'var(--overlay-heavy, rgba(255,255,255,.2))' },
                { backgroundColor: 'transparent' }
            ], { duration: 800, easing: 'ease-out' });

            if (autoSubmit && this.inputEl.value && !this.submitBtn.disabled) {
                this.formEl.requestSubmit();
            }
        }) as EventListener;
        document.addEventListener('wm:deduct-context', this.contextHandler);

        this.fwSelector = new FrameworkSelector({ panelId: 'deduction', isPremium: hasPremiumAccess(), panel: this });
        this.header.appendChild(this.fwSelector.el);
    }

    public override destroy(): void {
        document.removeEventListener('wm:deduct-context', this.contextHandler);
        this.fwSelector.destroy();
        super.destroy();
    }

    private async handleSubmit(e: Event) {
        e.preventDefault();
        if (this.isSubmitting) return;

        const query = this.inputEl.value.trim();
        if (!query) return;

        let geoContext = this.geoInputEl.value.trim();

        if (this.getLatestNews && !geoContext.includes('Recent News:')) {
            const newsCtx = buildNewsContext(this.getLatestNews);
            if (newsCtx) {
                geoContext = geoContext ? `${geoContext}\n\n${newsCtx}` : newsCtx;
            }
        }

        const fw = getActiveFrameworkForPanel('deduction');

        this.isSubmitting = true;
        this.submitBtn.disabled = true;

        this.resultContainer.className = 'deduction-result loading';
        this.resultContainer.textContent = 'Analyzing timeline and impact...';

        try {
            const resp = await client.deductSituation({
                query,
                geoContext,
                framework: fw?.systemPromptAppend ?? '',
            });
            if (!this.element?.isConnected) return;

            this.resultContainer.className = 'deduction-result';
            if (resp.analysis) {
                const parsed = await marked.parse(resp.analysis);
                if (!this.element?.isConnected) return;
                this.resultContainer.innerHTML = DOMPurify.sanitize(parsed);

                const meta = h('div', { style: 'margin-top: 12px; font-size: 0.75em; color: #888;' },
                    `Generated by ${resp.provider || 'AI'}${resp.model ? ` (${resp.model})` : ''}`
                );
                this.resultContainer.appendChild(meta);
            } else {
                this.resultContainer.textContent = resp.provider === 'error'
                    ? 'AI analysis temporarily unavailable. Please try again in a moment.'
                    : 'No analysis available for this query.';
            }
        } catch (err) {
            if (!this.element?.isConnected) return;
            console.error('[DeductionPanel] Error:', err);
            this.resultContainer.className = 'deduction-result error';
            this.resultContainer.textContent = 'An error occurred while analyzing the situation.';
        } finally {
            this.isSubmitting = false;
            if (this.element?.isConnected) {
                setTimeout(() => { this.submitBtn.disabled = false; }, COOLDOWN_MS);
            }
        }
    }
}
