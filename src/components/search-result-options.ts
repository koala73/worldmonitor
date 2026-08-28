export function decorateSearchResultOptions(
  resultsList: HTMLElement,
  input: HTMLElement,
  options: { skipOptions?: boolean } = {},
): void {
  if (options.skipOptions) {
    resultsList.querySelectorAll('.search-result-item').forEach((el) => {
      el.removeAttribute('role');
      el.removeAttribute('aria-selected');
    });
    resultsList.removeAttribute('role');
    input.removeAttribute('aria-activedescendant');
    return;
  }

  resultsList.setAttribute('role', 'listbox');
  let selectedId = '';
  resultsList.querySelectorAll('.search-result-item').forEach((el, i) => {
    el.setAttribute('role', 'option');
    if (!el.id) el.id = `search-option-${i}`;
    const isSelected = el.classList.contains('selected');
    el.setAttribute('aria-selected', String(isSelected));
    if (isSelected) selectedId = el.id;
  });
  resultsList.querySelectorAll('.search-section-header').forEach((el) => {
    el.setAttribute('role', 'presentation');
  });
  if (selectedId) input.setAttribute('aria-activedescendant', selectedId);
  else input.removeAttribute('aria-activedescendant');
}
