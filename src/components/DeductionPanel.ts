import { Panel } from './Panel';
import { IntelligenceServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { h, replaceChildren } from '@/utils/dom-utils';
import { marked } from 'marked';
import type { NewsItem } from '@/types';

const client = new IntelligenceServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

export class DeductionPanel extends Panel {
    private formEl: HTMLFormElement;
    private inputEl: HTMLTextAreaElement;
    private geoInputEl: HTMLInputElement;
    private resultContainer: HTMLElement;
    private isSubmitting = false;
    private getLatestNews?: () => NewsItem[];

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

        const submitBtn = h('button', {
            className: 'deduction-submit-btn',
            type: 'submit',
        }, 'Analyze');

        this.formEl = h('form', { className: 'deduction-form' },
            this.inputEl,
            this.geoInputEl,
            submitBtn
        ) as HTMLFormElement;

        this.formEl.addEventListener('submit', this.handleSubmit.bind(this));

        this.resultContainer = h('div', { className: 'deduction-result' });

        const container = h('div', { className: 'deduction-panel-content' },
            this.formEl,
            this.resultContainer
        );

        replaceChildren(this.content, container);

        // Inject some basic styles for the panel
        if (!document.getElementById('deduction-panel-styles')) {
            const style = document.createElement('style');
            style.id = 'deduction-panel-styles';
            style.textContent = `
        .deduction-panel-content { display: flex; flex-direction: column; gap: 12px; padding: 8px; height: 100%; overflow-y: auto; }
        .deduction-form { display: flex; flex-direction: column; gap: 8px; }
        .deduction-input, .deduction-geo-input { width: 100%; padding: 8px; background: var(--bg-secondary, #2a2a2a); border: 1px solid var(--border-color, #444); color: var(--text-primary, #fff); border-radius: 4px; font-family: inherit; resize: vertical; }
        .deduction-submit-btn { padding: 8px 16px; background: var(--accent-color, #3b82f6); color: white; border: none; border-radius: 4px; cursor: pointer; align-self: flex-end; font-weight: 500; }
        .deduction-submit-btn:hover { background: var(--accent-hover, #2563eb); }
        .deduction-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .deduction-result { flex: 1; margin-top: 8px; line-height: 1.5; font-size: 0.9em; color: var(--text-primary, #ddd); }
        .deduction-result.loading { opacity: 0.7; font-style: italic; }
        .deduction-result.error { color: var(--semantic-critical, #ef4444); }
        .deduction-result h3 { margin-top: 12px; margin-bottom: 4px; font-size: 1.1em; color: var(--text-bright, #fff); }
        .deduction-result ul { padding-left: 20px; margin-top: 4px; }
        .deduction-result li { margin-bottom: 4px; }
            `;
            document.head.appendChild(style);
        }

        // Listen for global context deduction requests from other panels
        document.addEventListener('wm:deduct-context', ((e: CustomEvent<{ query?: string; geoContext: string; autoSubmit?: boolean }>) => {
            const { query, geoContext, autoSubmit } = e.detail;

            if (query) {
                this.inputEl.value = query;
            }
            if (geoContext) {
                this.geoInputEl.value = geoContext;
            }

            // Bring panel into view if it was hidden
            this.show();

            // Flash the panel to indicate it received data
            this.element.animate([
                { backgroundColor: 'var(--accent-hover, #2563eb)' },
                { backgroundColor: 'transparent' }
            ], { duration: 800, easing: 'ease-out' });

            if (autoSubmit && this.inputEl.value) {
                this.formEl.requestSubmit();
            }
        }) as EventListener);
    }

    private async handleSubmit(e: Event) {
        e.preventDefault();
        if (this.isSubmitting) return;

        const query = this.inputEl.value.trim();
        if (!query) return;

        let geoContext = this.geoInputEl.value.trim();

        if (this.getLatestNews && !geoContext.includes('Recent News:')) {
            const news = this.getLatestNews().slice(0, 15);
            if (news.length > 0) {
                const newsContext = 'Recent News:\n' + news.map(n => `- ${n.title} (${n.source})`).join('\n');
                geoContext = geoContext ? `${geoContext}\n\n${newsContext}` : newsContext;
            }
        }

        this.isSubmitting = true;
        const submitBtn = this.formEl.querySelector('button');
        if (submitBtn) submitBtn.disabled = true;

        this.resultContainer.className = 'deduction-result loading';
        this.resultContainer.textContent = 'Analyzing timeline and impact...';

        try {
            const resp = await client.deductSituation({
                query,
                geoContext,
            });

            this.resultContainer.className = 'deduction-result';
            if (resp.analysis) {
                // Parse markdown 
                const parsed = await marked.parse(resp.analysis);
                this.resultContainer.innerHTML = parsed;

                const meta = h('div', { style: 'margin-top: 12px; font-size: 0.75em; color: #888;' },
                    `Generated by ${resp.provider || 'AI'}${resp.model ? ` (${resp.model})` : ''}`
                );
                this.resultContainer.appendChild(meta);
            } else {
                this.resultContainer.textContent = 'No analysis available for this query.';
            }
        } catch (err) {
            console.error('[DeductionPanel] Error:', err);
            this.resultContainer.className = 'deduction-result error';
            this.resultContainer.textContent = 'An error occurred while analyzing the situation.';
        } finally {
            this.isSubmitting = false;
            if (submitBtn) submitBtn.disabled = false;
        }
    }
}
