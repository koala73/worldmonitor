/**
 * Localizes the <title> and description meta tags index.html bakes in English.
 * English keeps the baked per-variant copy: the shared catalogue string would
 * replace each variant's title with one generic title in the rendered page.
 */
export function localizeShellMeta(doc: Document, lang: string, translate: (key: string) => string): void {
  if (lang === 'en') return;
  const title = 'Bhumi-Watch | Paramount International School';
  const description = translate('shell.metaDescription');
  const setMeta = (selector: string, value: string) => {
    doc.querySelector(selector)?.setAttribute('content', value);
  };
  doc.title = title;
  setMeta('meta[name="description"]', description);
  setMeta('meta[property="og:title"]', title);
  setMeta('meta[property="og:description"]', description);
  setMeta('meta[name="twitter:title"]', title);
  setMeta('meta[name="twitter:description"]', description);
}
