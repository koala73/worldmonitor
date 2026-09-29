# News and maps plugin delivery

This is the first implementation increment for #8741 under epic #5198. It extends `get_news_intelligence` and its existing MCP Apps resource. It does not close either issue.

## Implemented contract

The tool advertises global and thread entrypoints under `openai/ui`, following the pinned [OpenAI extension specification](https://github.com/openai/mcp-extensions/blob/93a30a92c1e520da18c4b05a29186ee7c48bc046/docs/spec.md). Empty arguments remain valid. The resource uses the existing standard MCP Apps MIME type and shared bridge. It does not install the McpServer-specific SDK wrapper over the custom server.

| Action | Tool argument or host method | View behavior |
|---|---|---|
| Open news | `get_news_intelligence({})` | Consumes the initial result without another data request |
| Search | `query` | Existing headline, source and clustered-headline search |
| Filter category or country | `category`, `country` | Existing server filters, followed by the result cap |
| Filter source | `source` | Exact, case-insensitive primary outlet match |
| Filter publication time | `published_since` | Inclusive Unix millisecond boundary; excludes unknown dates |
| Focus and zoom map | `country`, `map_latitude`, `map_longitude`, `map_zoom` | Applies requested view when the mounted app receives the result |
| Pan or zoom directly | Pointer, arrow keys and zoom buttons | Changes view-local state without a paid data request |
| Open detail | Details button | Shows clustered titles and source provenance |
| Open source | `ui/open-link` | Uses the host browser capability with an HTTP(S) URL |
| Report applied view | `ui/update-model-context` | Sends current filters, map state and country precision when the host supports text context |

The data source is the existing intelligence snapshot, not a historical article archive. Source policy, freshness, access and quota remain in the existing dispatcher. No new account write scope, credential transport, direct browser data fetch, or persistent view record is introduced.

The SVG base map comes from `public/data/countries.geojson`. `scripts/generate-plugin-news-map.mjs` projects it deterministically and normalizes polygon winding. `--check` verifies the committed generated asset. Highlighting means country-level reporting context. It does not mean an event occurred at a country's center.

## Proof and limits

The focused tests exercise emitted HTML, initial results, tool metadata, foreign-message rejection, hostile text, filter ordering, empty/unavailable/stale states, and denial recovery. The existing resource/protocol/auth tests remain regression gates.

The Playwright proof uses a sandboxed fixture host with no form permission. It checks actual SVG rendering, country focus, source-link messages, absence of duplicate initial data calls, denial recovery, and responsive screenshots. Fixture results are labelled and do not demonstrate live provider data or production OpenAI host compatibility.

## Remaining issue acceptance

- Actual OpenAI host installation, OAuth and entrypoint verification against a deployed commit.
- Broader feed/digest and news-analysis interaction coverage, including a complete source/variant inventory.
- The dashboard's additional map renderers and news overlays. Only the country-context SVG view is delivered here.
- Assistant/UI parity for selecting a particular story and every inventoried news action.
- Host cancellation, request races and lifecycle behavior beyond the tested bounded UI request.

All other domain layers remain epic work. No marketplace listing, deployment or full-feature parity is claimed.
