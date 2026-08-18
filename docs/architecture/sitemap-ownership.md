# Sitemap ownership and freshness

World Monitor publishes three independent sitemap families. Each publisher owns
its complete inventory so a second hand-maintained list cannot drift from it.

| Sitemap | Owner | Inventory |
|---|---|---|
| `/sitemap.xml` | Root build | Landing and product pages, dashboards and variants, machine-readable product/developer pages, and the generated crawlable corpus |
| `/blog/sitemap-index.xml` | Astro blog build | Blog index, posts, glossary, and author/editorial pages |
| `/docs/sitemap.xml` | Mintlify | Documentation and localized documentation |

`public/robots.www.txt` (served at `/robots.txt` on www/apex) advertises each endpoint exactly once. Root generation never
copies `/blog` or `/docs` URLs.

## Material modification sources

The root inventory lives in `STATIC_ROUTE_MANIFEST` in
`scripts/build-sitemap.mjs`. Every static route declares the repository paths
that materially determine its content:

- The welcome and Pro pages use their `pro-test` page/component, generated
  product-fact, style, and product-catalog sources.
- Dashboard entries use the app shell, orchestration, components, configuration,
  locales, styles, and the corresponding variant configuration.
- Markdown and text references use the file served at the canonical URL.
- Generated country, chokepoint, crisis, tool, research, use-case, and changelog entries use the
  `lastmod` metadata emitted by `scripts/build-crawlable-corpus.mjs`.

The `/use-cases/` family is a root crawlable corpus sibling of `/blog/`. The root
sitemap owns the hub and child pages exactly once. Blog and docs sitemaps must
not claim those URLs. Canonical treatment for the pilot pages:

- `/use-cases/monitor-country-risk/` owns the evergreen country-risk task framing;
  `/countries/` remains the live evidence surface; the blog workflow article
  remains distinct supporting editorial (#6849).
- `/use-cases/verify-breaking-news/` owns the evergreen verification procedure;
  the OSINT blog article remains dated supporting editorial with no redirect
  (#6850).
- `/use-cases/monitor-supply-chain-disruptions/` owns the evergreen supply-chain
  monitoring workflow; `/chokepoints/` and commodity surfaces remain evidence;
  the supply-chain blog article remains distinct supporting editorial (#6851).

Static-page dates are the latest Git commit date among the declared material
sources. They are not file mtimes and never use build or deploy time. When a
Docker build has no `.git` directory or only a shallow history, it preserves
the dates in the committed generated sitemap. This prevents a depth-one
checkout from treating every file as newly added in its lone release commit.
Generated corpus pages take the later of their dated source and the explicit
generator-content version, so a template rewrite can be represented without
touching every URL on every deployment.

Editorial blog dates remain owned by frontmatter. Astro uses `modifiedDate` when
present and otherwise `pubDate`; `tests/blog-seo-contract.test.mjs` rejects a
modified date earlier than publication.

## Build and verification

The normal full build runs these steps in order:

```sh
npm run build:blog
npm run build:crawlable-corpus
npm run build:sitemap
```

`public/sitemap.xml` is a generated artifact and must be committed. Verify
determinism and freshness with:

```sh
npm run build:sitemap
npm run build:sitemap:check
node --test tests/sitemap-generation.test.mjs tests/sitemap-verifier.test.mjs
```

The check command rebuilds the ignored crawlable-corpus output first, so it is
safe to run from a fresh clone. Direct sitemap generation fails closed when any
required generated family is absent.

After deployment, fetch every advertised sitemap, status-check every URL, and
sample canonical/indexability signals from each family. The verifier also fails
when two sitemap documents claim the same canonical URL:

```sh
npm run verify:sitemaps -- \
  --origin=https://www.worldmonitor.app \
  --report=/tmp/worldmonitor-sitemap-verification.json
```

The report is operational evidence, not a committed build input. Search Console
submission and processing remain an operator check because they require access
to the verified property.
