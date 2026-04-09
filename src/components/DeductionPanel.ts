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
            placeholder: 'Geographic or situation context (optional)...',
        }) as HTMLInputElement;

        this.submitBtn = h('button', {
            className: 'deduction-submit-btn',
            type: 'submit',
        }, 'Analyze') as HTMLButtonElement;

        const formRow = h('div', { className: 'deduction-form-row' },
            this.geoInputEl,
            this.submitBtn,
        );

        this.formEl = h('form', { className: 'deduction-form' },
            this.inputEl,
            formRow,
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

    /** Post-process parsed markdown HTML into visually structured sections. */
    private reformatResult(container: HTMLElement): void {
        const SECTIONS = [
            { re: /^bottom\s+line/i,       cls: 'ds-verdict',   label: 'Bottom Line' },
            { re: /^what\s+we\s+know/i,    cls: 'ds-evidence',  label: 'What We Know' },
            { re: /^most\s+likely\s+path/i, cls: 'ds-primary',  label: 'Most Likely Path' },
            { re: /^alternative\s+path/i,  cls: 'ds-alt',       label: 'Alternative Paths' },
            { re: /^confidence/i,          cls: 'ds-confidence', label: 'Confidence' },
        ] as const;

        // Collect top-level children; group by section boundary
        const nodes = Array.from(container.childNodes) as HTMLElement[];
        const groups: { cls: string; label: string; nodes: HTMLElement[] }[] = [];
        let current: { cls: string; label: string; nodes: HTMLElement[] } | null = null;

        for (const node of nodes) {
            const strongText = (node.querySelector?.('strong')?.textContent ?? node.textContent ?? '').trim();
            const match = SECTIONS.find(s => s.re.test(strongText));
            if (match) {
                current = { cls: match.cls, label: match.label, nodes: [] };
                groups.push(current);
            }
            if (current) current.nodes.push(node);
            else if (!match) groups.push({ cls: '', label: '', nodes: [node] }); // unsectioned
        }

        if (groups.every(g => !g.cls)) return; // nothing to restructure

        container.replaceChildren();
        for (const group of groups) {
            if (!group.cls) {
                group.nodes.forEach(n => container.appendChild(n));
                continue;
            }

            const section = document.createElement('div');
            section.className = group.cls;

            // Inject section label (remove the <strong> header from content)
            const labelEl = document.createElement('div');
            labelEl.className = 'ds-section-label';

            // For primary path, extract probability from heading text
            if (group.cls === 'ds-primary') {
                const headingNode = group.nodes[0];
                const fullText = headingNode?.textContent ?? '';
                const probMatch = /(\d{1,3})\s*%/.exec(fullText);
                const timeMatch = /\(([^)]+)\)/.exec(fullText);
                labelEl.textContent = group.label;
                if (timeMatch) {
                    const timeSpan = document.createElement('span');
                    timeSpan.style.cssText = 'font-size:10px;color:var(--text-dim);font-weight:400;text-transform:none;letter-spacing:0';
                    timeSpan.textContent = timeMatch[1] ?? '';
                    labelEl.appendChild(timeSpan);
                }
                if (probMatch) {
                    const badge = document.createElement('span');
                    badge.className = 'ds-prob-badge';
                    badge.textContent = `${probMatch[1]}%`;
                    labelEl.appendChild(badge);
                }
            } else {
                labelEl.textContent = group.label;
            }
            section.appendChild(labelEl);

            // Add body nodes (skip first node which was the header paragraph)
            const bodyNodes = group.nodes.slice(1);
            if (bodyNodes.length === 0 && group.nodes[0]) {
                // Inline header: strip the strong header, keep the rest as body
                const clone = group.nodes[0].cloneNode(true) as HTMLElement;
                clone.querySelector('strong')?.remove();
                const bodyDiv = document.createElement('div');
                bodyDiv.className = group.cls === 'ds-primary' ? 'ds-primary-body' : '';
                bodyDiv.innerHTML = clone.innerHTML.replace(/^[\s:–—-]+/, '');
                section.appendChild(bodyDiv);
            } else {
                // For alt paths: inject probability badges into li items
                if (group.cls === 'ds-alt') {
                    bodyNodes.forEach(n => {
                        if (n.tagName === 'UL') {
                            n.querySelectorAll('li').forEach(li => {
                                const probMatch = /^(\d{1,3})\s*%\s*[:\s]?(.*)/.exec(li.textContent ?? '');
                                if (probMatch) {
                                    const badge = document.createElement('span');
                                    badge.className = 'ds-alt-prob';
                                    badge.textContent = `${probMatch[1]}%`;
                                    li.textContent = (probMatch[2] ?? '').replace(/^\s*[:\s]+/, '').trim();
                                    li.insertBefore(badge, li.firstChild);
                                }
                            });
                        }
                        section.appendChild(n);
                    });
                } else {
                    bodyNodes.forEach(n => section.appendChild(n));
                }
            }

            container.appendChild(section);
        }
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
        this.resultContainer.innerHTML = '<div class="deduction-loading-dots"><span></span><span></span><span></span></div>Analyzing…';

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
                const safe = DOMPurify.sanitize(parsed);
                this.resultContainer.innerHTML = safe;
                this.reformatResult(this.resultContainer);
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
