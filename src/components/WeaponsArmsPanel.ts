import { Panel } from './Panel';
import { h, replaceChildren } from '@/utils/dom-utils';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

type Category = 'all' | 'missile' | 'aircraft' | 'naval' | 'armored' | 'air-defense' | 'nuclear' | 'drone';

interface Country {
  iso: string;
  name: string;
  flag: string;
  spendingB: number;
  spendingPct: number;
  personnel: number;
  reserves: number;
  nuclear: number | null;
}

interface Weapon {
  id: string;
  name: string;
  category: string;
  subcategory: string;
  nations: string[];
  status: 'active' | 'development' | 'retired';
  year: number;
  mfr: string;
  desc: string;
  specs: Record<string, string>;
  wiki: string;
  img: string;
  wikiUrl: string;
}

interface WeaponsData {
  weapons: Weapon[];
  countries: Country[];
  fetchedAt: string;
}

const CATEGORY_LABELS: Record<Category, string> = {
  all: 'All Systems',
  missile: 'Missiles',
  aircraft: 'Aircraft',
  naval: 'Naval',
  armored: 'Armored',
  'air-defense': 'Air Defense',
  nuclear: 'Nuclear',
  drone: 'Drones',
};

const STATUS_COLORS: Record<string, string> = {
  active: '#4ade80',
  development: '#facc15',
  retired: '#94a3b8',
};

export class WeaponsArmsPanel extends Panel {
  private category: Category = 'all';
  private countryFilter = 'all';
  private search = '';
  private data: WeaponsData | null = null;

  constructor() {
    super({ id: 'weapons-arms', title: 'Weapons & Arms', showCount: true });
    void this.fetchData();
  }

  private async fetchData(): Promise<void> {
    this.showLoading('Loading weapons data…');
    try {
      const res = await fetch('/api/weapons');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = (await res.json()) as WeaponsData;
      this.render();
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.showError('Failed to load weapons data');
    }
  }

  private get filtered(): Weapon[] {
    if (!this.data) return [];
    return this.data.weapons.filter((w) => {
      if (this.category !== 'all' && w.category !== this.category) return false;
      if (this.countryFilter !== 'all' && !w.nations.includes(this.countryFilter)) return false;
      if (this.search) {
        const q = this.search.toLowerCase();
        if (!w.name.toLowerCase().includes(q) && !w.desc.toLowerCase().includes(q) && !w.subcategory.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  private render(): void {
    if (!this.data) return;
    const weapons = this.filtered;
    this.setCount(weapons.length);

    const tabs = h('div', { className: 'wm-weapons-tabs' },
      ...(Object.entries(CATEGORY_LABELS) as [Category, string][]).map(([cat, label]) =>
        h('button', {
          className: `wm-weapons-tab${this.category === cat ? ' active' : ''}`,
          onclick: () => { this.category = cat as Category; this.render(); },
        }, label)
      )
    );

    const countries = this.data.countries;
    const countrySelect = h('select', {
      className: 'wm-weapons-country-select',
      onchange: (e: Event) => {
        this.countryFilter = (e.target as HTMLSelectElement).value;
        this.render();
      },
    },
      h('option', { value: 'all' }, 'All Countries'),
      ...countries.map(c =>
        h('option', { value: c.iso, selected: this.countryFilter === c.iso }, `${c.flag} ${c.name}`)
      )
    );

    const searchInput = h('input', {
      type: 'text',
      className: 'wm-weapons-search',
      placeholder: 'Search weapons…',
      value: this.search,
      oninput: (e: Event) => {
        this.search = (e.target as HTMLInputElement).value;
        this.render();
      },
    });

    const controls = h('div', { className: 'wm-weapons-controls' }, countrySelect, searchInput);

    // Country spending bars (top 8 by budget)
    const topCountries = [...countries].sort((a, b) => b.spendingB - a.spendingB).slice(0, 8);
    const maxSpend = topCountries[0]?.spendingB ?? 1;
    const spendingSection = h('div', { className: 'wm-weapons-spending' },
      h('h3', { className: 'wm-weapons-section-title' }, 'Military Spending (USD Billions, 2024)'),
      h('div', { className: 'wm-weapons-bars' },
        ...topCountries.map(c =>
          h('div', { className: 'wm-weapons-bar-row' },
            h('span', { className: 'wm-weapons-bar-label' }, `${c.flag} ${c.name}`),
            h('div', { className: 'wm-weapons-bar-track' },
              h('div', {
                className: 'wm-weapons-bar-fill',
                style: `width:${(c.spendingB / maxSpend) * 100}%`,
              })
            ),
            h('span', { className: 'wm-weapons-bar-value' }, `$${c.spendingB}B`)
          )
        )
      )
    );

    // Weapon cards grid
    const cards = weapons.map(w => this.renderCard(w));
    const grid = h('div', { className: 'wm-weapons-grid' }, ...cards);

    const empty = weapons.length === 0
      ? h('div', { className: 'wm-weapons-empty' }, 'No weapons match the current filters.')
      : null;

    replaceChildren(
      this.content,
      tabs,
      controls,
      spendingSection,
      empty ?? grid
    );
  }

  private renderCard(w: Weapon): HTMLElement {
    const statusDot = h('span', {
      className: 'wm-weapons-status-dot',
      style: `background:${STATUS_COLORS[w.status] ?? '#94a3b8'}`,
      title: w.status,
    });

    const nationsLine = w.nations.slice(0, 6).join(' · ') + (w.nations.length > 6 ? ` +${w.nations.length - 6}` : '');

    const specsTable = h('table', { className: 'wm-weapons-specs' },
      ...Object.entries(w.specs).map(([k, v]) =>
        h('tr', {},
          h('td', { className: 'wm-weapons-spec-key' }, escapeHtml(k)),
          h('td', { className: 'wm-weapons-spec-val' }, escapeHtml(v))
        )
      )
    );

    const safeImg = sanitizeUrl(w.img);
    const safeWiki = sanitizeUrl(w.wikiUrl);

    const img = safeImg
      ? h('img', {
          className: 'wm-weapons-card-img',
          src: safeImg,
          alt: escapeHtml(w.name),
          loading: 'lazy',
          onerror: (e: Event) => { (e.target as HTMLImageElement).style.display = 'none'; },
        })
      : null;

    return h('div', { className: 'wm-weapons-card' },
      img ?? h('div', { className: 'wm-weapons-card-img-placeholder' }),
      h('div', { className: 'wm-weapons-card-body' },
        h('div', { className: 'wm-weapons-card-header' },
          statusDot,
          h('span', { className: 'wm-weapons-card-cat' }, escapeHtml(w.subcategory)),
          h('span', { className: 'wm-weapons-card-year' }, String(w.year)),
        ),
        h('h4', { className: 'wm-weapons-card-name' }, escapeHtml(w.name)),
        h('p', { className: 'wm-weapons-card-mfr' }, escapeHtml(w.mfr)),
        h('p', { className: 'wm-weapons-card-desc' }, escapeHtml(w.desc)),
        h('p', { className: 'wm-weapons-card-nations' }, `Nations: ${escapeHtml(nationsLine)}`),
        specsTable,
        safeWiki
          ? h('a', { className: 'wm-weapons-card-wiki', href: safeWiki, target: '_blank', rel: 'noopener noreferrer' }, 'Wikipedia →')
          : null
      )
    );
  }

  public refresh(): void {
    void this.fetchData();
  }
}
