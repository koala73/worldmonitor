import { h, Component } from 'preact';
import { t } from '@/services/i18n';

export interface VerificationCheck {
  id: string;
  label: string;
  checked: boolean;
  icon: string;
}

export interface VerificationResult {
  score: number;  // 0-100
  checks: VerificationCheck[];
  verdict: 'verified' | 'likely' | 'uncertain' | 'unreliable';
  notes: string[];
}

function getVerificationTemplate(): VerificationCheck[] {
  return [
    { id: 'recency', label: t('components.verification.checks.recency'), checked: false, icon: '🕐' },
    { id: 'geolocation', label: t('components.verification.checks.geolocation'), checked: false, icon: '📍' },
    { id: 'source', label: t('components.verification.checks.source'), checked: false, icon: '📰' },
    { id: 'crossref', label: t('components.verification.checks.crossref'), checked: false, icon: '🔗' },
    { id: 'no_ai', label: t('components.verification.checks.noAi'), checked: false, icon: '🤖' },
    { id: 'no_recrop', label: t('components.verification.checks.noRecrop'), checked: false, icon: '🔄' },
    { id: 'metadata', label: t('components.verification.checks.metadata'), checked: false, icon: '📋' },
    { id: 'context', label: t('components.verification.checks.context'), checked: false, icon: '📖' },
  ];
}

export class VerificationChecklist extends Component {
  private checks: VerificationCheck[] = getVerificationTemplate();
  private notes: string[] = [];
  private manualNote: string = '';

  private toggleCheck(id: string): void {
    this.checks = this.checks.map(c =>
      c.id === id ? { ...c, checked: !c.checked } : c
    );
    this.setState({});
  }

  private addNote(): void {
    if (this.manualNote.trim()) {
      this.notes = [...this.notes, this.manualNote.trim()];
      this.manualNote = '';
      this.setState({});
    }
  }

  private calculateResult(): VerificationResult {
    const checkedCount = this.checks.filter(c => c.checked).length;
    const score = Math.round((checkedCount / this.checks.length) * 100);

    let verdict: VerificationResult['verdict'];
    if (score >= 90) verdict = 'verified';
    else if (score >= 70) verdict = 'likely';
    else if (score >= 40) verdict = 'uncertain';
    else verdict = 'unreliable';

    return { score, checks: this.checks, verdict, notes: this.notes };
  }

  private reset(): void {
    this.checks = getVerificationTemplate();
    this.notes = [];
    this.manualNote = '';
    this.setState({});
  }

  render() {
    const result = this.calculateResult();

    const verdictColors: Record<string, string> = {
      verified: '#22c55e',
      likely: '#84cc16',
      uncertain: '#eab308',
      unreliable: '#ef4444',
    };

    const verdictLabels: Record<string, string> = {
      verified: t('components.verification.verdicts.verified'),
      likely: t('components.verification.verdicts.likely'),
      uncertain: t('components.verification.verdicts.uncertain'),
      unreliable: t('components.verification.verdicts.unreliable'),
    };

    return h('div', { class: 'verification-checklist' },
      h('div', { class: 'checklist-header' },
        h('h3', null, t('components.verification.title')),
        h('p', { class: 'hint' }, t('components.verification.hint')),
      ),
      h('div', {
        class: 'score-display',
        style: `background-color: ${verdictColors[result.verdict]}20; border-color: ${verdictColors[result.verdict]}`,
      },
        h('div', { class: 'score-value' }, `${result.score}%`),
        h('div', { class: 'score-label', style: `color: ${verdictColors[result.verdict]}` },
          verdictLabels[result.verdict],
        ),
      ),
      h('div', { class: 'checks-grid' },
        ...this.checks.map(check =>
          h('label', { key: check.id, class: `check-item ${check.checked ? 'checked' : ''}` },
            h('input', {
              type: 'checkbox',
              checked: check.checked,
              onChange: () => this.toggleCheck(check.id),
            }),
            h('span', { class: 'icon' }, check.icon),
            h('span', { class: 'label' }, check.label),
          )
        ),
      ),
      h('div', { class: 'notes-section' },
        h('h4', null, t('components.verification.notesTitle')),
        h('div', { class: 'notes-list' },
          this.notes.length === 0
            ? h('p', { class: 'empty' }, t('components.verification.noNotes'))
            : this.notes.map((note, i) =>
                h('div', { key: i, class: 'note-item' }, `• ${note}`)
              ),
        ),
        h('div', { class: 'add-note' },
          h('input', {
            type: 'text',
            value: this.manualNote,
            onInput: (e: Event) => { this.manualNote = (e.target as HTMLInputElement).value; },
            placeholder: t('components.verification.addNotePlaceholder'),
            onKeyPress: (e: KeyboardEvent) => { if (e.key === 'Enter') this.addNote(); },
          }),
          h('button', { onClick: () => this.addNote() }, t('components.verification.add')),
        ),
      ),
      h('div', { class: 'checklist-actions' },
        h('button', { class: 'reset-btn', onClick: () => this.reset() }, t('components.verification.resetChecklist')),
      ),
      h('style', null, `
        .verification-checklist { background: var(--bg); border-radius: 8px; padding: 16px; max-width: 400px; }
        .checklist-header h3 { margin: 0 0 4px; font-size: 14px; color: var(--accent); }
        .hint { margin: 0; font-size: 11px; color: var(--text-muted); }
        .score-display { margin: 16px 0; padding: 16px; border-radius: 8px; border: 2px solid; text-align: center; }
        .score-value { font-size: 32px; font-weight: 700; color: var(--accent); }
        .score-label { font-size: 12px; font-weight: 600; text-transform: uppercase; }
        .checks-grid { display: flex; flex-direction: column; gap: 8px; margin: 16px 0; }
        .check-item { display: flex; align-items: center; gap: 8px; padding: 8px; background: var(--surface-hover); border-radius: 4px; cursor: pointer; transition: background 0.2s; }
        .check-item:hover { background: var(--border); }
        .check-item.checked { background: color-mix(in srgb, var(--semantic-normal) 15%, var(--bg)); }
        .check-item input { width: 16px; height: 16px; }
        .icon { font-size: 14px; }
        .label { font-size: 12px; color: var(--text); }
        .notes-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
        .notes-section h4 { margin: 0 0 8px; font-size: 12px; color: var(--text-dim); }
        .notes-list { max-height: 100px; overflow-y: auto; }
        .note-item { font-size: 11px; color: var(--text-faint); padding: 4px 0; }
        .empty { font-size: 11px; color: var(--text-ghost); font-style: italic; }
        .add-note { display: flex; gap: 8px; margin-top: 8px; }
        .add-note input { flex: 1; padding: 6px 8px; background: var(--surface-hover); border: 1px solid var(--border-strong); border-radius: 4px; color: var(--text); font-size: 12px; }
        .add-note button { padding: 6px 12px; background: var(--border-strong); border: none; border-radius: 4px; color: var(--accent); font-size: 12px; cursor: pointer; }
        .checklist-actions { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
        .reset-btn { width: 100%; padding: 8px; background: var(--border); border: none; border-radius: 4px; color: var(--text-dim); font-size: 12px; cursor: pointer; }
        .reset-btn:hover { background: var(--border-strong); color: var(--text-faint); }
      `),
    );
  }
}
