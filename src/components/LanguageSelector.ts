import { LANGUAGES, changeLanguage, getCurrentLanguage, t } from '../services/i18n';

export class LanguageSelector {
    private element: HTMLElement;
    private isOpen = false;
    private currentLang: string;

    constructor() {
        this.currentLang = getCurrentLanguage();
        this.element = document.createElement('div');
        this.element.className = 'custom-lang-selector';
        this.render();
        this.setupEventListeners();
    }

    public getElement(): HTMLElement {
        return this.element;
    }

    private getFlagUrl(langCode: string): string {
        const map: Record<string, string> = {
            en: 'gb',
            ar: 'sa',
            zh: 'cn',
            fr: 'fr',
            de: 'de',
            es: 'es',
            it: 'it',
            pl: 'pl',
            pt: 'pt',
            nl: 'nl',
            sv: 'se',
            ru: 'ru',
            ja: 'jp',
            tr: 'tr'
        };
        const countryCode = map[langCode] || langCode;
        return `https://flagcdn.com/24x18/${countryCode}.png`;
    }

    private render(): void {
        const currentLangObj = LANGUAGES.find(l => l.code === this.currentLang) || LANGUAGES[0];

        this.element.innerHTML = `
      <button class="lang-selector-btn" aria-label="${t('components.languageSelector.selectLanguage')}">
        <img src="${this.getFlagUrl(this.currentLang)}" alt="${currentLangObj?.label}" class="lang-flag-icon" />
        <span class="lang-code">${this.currentLang.toUpperCase()}</span>
        <span class="lang-arrow">▼</span>
      </button>
      <div class="lang-dropdown hidden">
        ${LANGUAGES.map(lang => `
          <div class="lang-option ${lang.code === this.currentLang ? 'active' : ''}" data-code="${lang.code}">
            <img src="${this.getFlagUrl(lang.code)}" alt="${lang.label}" class="lang-flag-icon" />
            <span class="lang-name">${lang.label}</span>
          </div>
        `).join('')}
      </div>
    `;
    }

    private setupEventListeners(): void {
        const btn = this.element.querySelector('.lang-selector-btn');
        const dropdown = this.element.querySelector('.lang-dropdown');

        if (!btn || !dropdown) return;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        this.element.querySelectorAll('.lang-option').forEach(option => {
            option.addEventListener('click', (e) => {
                const code = (e.currentTarget as HTMLElement).dataset.code;
                if (code && code !== this.currentLang) {
                    changeLanguage(code);
                }
                this.close();
            });
        });

        document.addEventListener('click', (e) => {
            if (!this.element.contains(e.target as Node)) {
                this.close();
            }
        });
    }

    private toggle(): void {
        this.isOpen = !this.isOpen;
        const dropdown = this.element.querySelector('.lang-dropdown');
        if (this.isOpen) {
            dropdown?.classList.remove('hidden');
            this.element.classList.add('open');
        } else {
            dropdown?.classList.add('hidden');
            this.element.classList.remove('open');
        }
    }

    private close(): void {
        this.isOpen = false;
        const dropdown = this.element.querySelector('.lang-dropdown');
        dropdown?.classList.add('hidden');
        this.element.classList.remove('open');
    }
}
