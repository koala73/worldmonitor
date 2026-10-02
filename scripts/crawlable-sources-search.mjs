// Runs only on the sources directory. Provider details stay on static pages.
function initSourcesSearch() {
  const search = document.getElementById('source-search');
  const fields = ['domain', 'kind', 'country', 'coverage'].map((name) => document.getElementById('source-' + name));
  const results = document.getElementById('source-results');
  const grid = document.getElementById('source-catalog');
  const more = document.getElementById('source-more');
  const note = document.getElementById('source-country-note');
  const noResults = document.getElementById('source-no-results');
  let indexPromise;
  let revision = 0;
  let offset = 0;
  const loadIndex = () => {
    if (!indexPromise) indexPromise = fetch('/sources/search-index.json')
      .then((response) => {
        if (!response.ok) throw new Error('Search unavailable');
        return response.json();
      }).catch((error) => { indexPromise = null; throw error; });
    return indexPromise;
  };
  const apply = async (nextPage = false) => {
    const request = ++revision;
    if (!nextPage) offset = 0;
    const query = search.value.trim().toLowerCase();
    const [domain, kind, country, coverage] = fields.map((field) => field.value);
    grid.replaceChildren();
    more.hidden = true;
    noResults.hidden = true;
    note.hidden = country === 'all' || country === 'intl';
    note.textContent = note.hidden ? '' : 'This list shows monitored sources based in the selected country or region. Sources based elsewhere also cover it.';
    if (!query && fields.every((field) => field.value === 'all')) {
      results.textContent = 'Choose a filter or enter a provider name.';
      return;
    }
    results.textContent = 'Searching…';
    try {
      const index = await loadIndex();
      if (request !== revision) return;
      const matches = index.filter((entry) =>
        (!query || entry.search.includes(query))
        && (domain === 'all' || entry.domain === domain)
        && (kind === 'all' || entry.kinds.includes(kind))
        && (country === 'all' || entry.country === country)
        && (coverage === 'all' || entry.coverage.includes(coverage)));
      for (const entry of matches.slice(offset, offset + 60)) {
        const link = document.createElement('a');
        link.className = 'source-result';
        link.href = entry.url;
        link.textContent = entry.name;
        const detail = document.createElement('small');
        detail.textContent = entry.hosts.join(', ');
        link.append(detail);
        grid.append(link);
      }
      results.textContent = matches.length + ' providers found' + (matches.length ? '; showing ' + (offset + 1) + '–' + Math.min(offset + 60, matches.length) : '');
      noResults.hidden = matches.length !== 0;
      more.hidden = offset + 60 >= matches.length;
      if (nextPage) grid.querySelector('a')?.focus();
    } catch {
      if (request !== revision) return;
      results.textContent = 'Search is unavailable. Try again or browse the domain pages above.';
    }
  };
  search.addEventListener('input', () => apply());
  for (const field of fields) field.addEventListener('change', () => apply());
  document.querySelector('[data-source-filter="all"]').addEventListener('click', () => {
    search.value = '';
    for (const field of fields) field.value = 'all';
    apply();
  });
  more.addEventListener('click', () => { offset += 60; apply(true); });

}

function initSourceBookmark() {
  const followBookmark = async () => {
    const fragment = location.hash;
    if (!fragment.startsWith('#provider-') || document.getElementById(fragment.slice(1))) return;
    const results = document.getElementById('source-results');
    try {
      const response = await fetch('/sources/search-index.json');
      if (!response.ok) throw new Error('Catalog unavailable');
      const index = await response.json();
      if (location.hash !== fragment) return;
      const entry = index.find((item) => item.url.endsWith(fragment));
      if (entry && entry.url !== location.pathname + fragment) location.replace(entry.url);
      else results.textContent = 'This provider is no longer on this page. Search or browse the current catalog.';
    } catch {
      results.textContent = 'This provider link could not be opened. Try search or browse the domain pages.';
    }
  };
  addEventListener('hashchange', followBookmark);
  followBookmark();
}

export const sourcesBookmarkScript = `(${initSourceBookmark.toString()})();`;
export const sourcesSearchScript = `(${initSourcesSearch.toString()})();${sourcesBookmarkScript}`;
