// URL slugs for generated corpus routes. Pure module: the routing middleware
// bundles it to map a registry name to the page it links.

const SLUGIFY_RE = /[̀-ͯ]/g;
const SLUGIFY_RE_2 = /&/g;
const SLUGIFY_RE_3 = /[^a-zA-Z0-9]+/g;
const SLUGIFY_RE_4 = /^-+|-+$/g;
const SLUGIFY_RE_5 = /-{2,}/g;

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(SLUGIFY_RE, '')
    .replace(SLUGIFY_RE_2, ' and ')
    .replace(SLUGIFY_RE_3, '-')
    .replace(SLUGIFY_RE_4, '')
    .replace(SLUGIFY_RE_5, '-')
    .toLowerCase();
}
