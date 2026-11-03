# ChatGPT plugin parity

Status: shared country-view unit implemented and locally verified; full parity and native acceptance remain open.

Baseline source: `53298ec964f88b50d65a675362310dd797bbfbef`. Implementation base: `0a74f70d8e0f6900bc5af967923f3127d44f83ad`, 2026-10-01. Public resource availability was checked separately. This document does not establish store readiness.

## Problem

A request for “USA country brief” should open the WorldMonitor country interface inside ChatGPT. Today `get_country_brief` returns an AI assessment, evidence and articles. Its compact widget renders those fields. The website instead assembles `CountryDeepDivePanel`, with 23 ordinary section cards, CII and resilience summaries, and an additional China section when relevant. The AI assessment is one section. The MCP data contract cannot currently populate the whole country interface.

The captured baseline inventory contains compact widgets and a news/map view using real dashboard components. The country mismatch is confirmed. Other compact widgets need behavioral comparison. Tools without their own UI are data capabilities rather than established defects. Their data should serve the relevant embedded views. Current tool totals come from the generated server card and inventory facts.

## Usage

An ordinary country-brief request invokes `open_country_brief`, with the resolved ISO country code. The inline result identifies the country and shows the shared country interface. Expand opens the detailed view while ChatGPT's composer remains usable. “Show energy exposure” selects the Energy section of the same country. “Compare with Japan” changes country or opens a comparison without silently mixing observations.

Proposed caller usage follows. These signatures are a sketch, not exported APIs.

```ts
const countryView = new CountryBriefController({ source, view, publishContext });
await countryView.open({ countryCode: 'US', topic: 'overview' });
await countryView.selectTopic('resources');
await countryView.refresh('energy');
countryView.dispose();
```

The website supplies its normal authenticated service adapter. The plugin supplies a host adapter that calls fixed MCP operations. Both use the same controller, section projections and renderer. `get_country_brief` remains available for existing narrative consumers, with its existing arguments and response fields.

## Grounded ownership

| Path | Current owner | Constraint carried into the fix |
|---|---|---|
| `src/app/country-intel.ts` | Selection, request ownership, country context, enrichment, map focus | Preserve human/agent ownership, cancellation and country-switch guards. Extract domain projections from dashboard caches; do not fabricate an `AppContext`. |
| `src/components/CountryDeepDivePanel.ts` | Renderer, output capture, several direct requests, account controls | Keep the rendered sections. Move owned requests into the shared controller; inject explicit actions and access state. |
| `src/components/country-brief-presentation.ts` | Topics, reading modes, section navigation/status | Reuse in both hosts. Keep one section catalog. |
| `src/components/ResilienceWidget.ts` | Rendering, requests, browser account subscriptions | Separate its data/access input from Clerk and mission subscriptions. Preserve existing gate semantics on the website. |
| `src/components/CountryTimeline.ts` | Timeline rendering | Supply normalized events through the shared country model. It does not need a new host-specific renderer. |
| `src/components/CountryBriefOutput.ts` | Report/story presentation from rendered country sections | Use the same settled section snapshot; test actual downloads in the sandbox. |
| `api/mcp/registry/rpc-tools.ts` | Narrative country brief and existing data tools | Preserve contracts. Add explicit view routing rather than widening the AI tool into an implicit full-dashboard fetch. |
| `api/mcp/ui/news-dashboard-app.ts` | Trusted built asset loading and sandbox CSP | Reuse its bounded, fixed-origin asset-loading policy for the country entry. No arbitrary URL or nested website iframe. |
| `server/gateway.ts`, `api/mcp/auth.ts`, quota helpers | Authorization and billing | Keep server enforcement on each request. Do not pass credentials into the frame or trust client entitlement flags. |
| `skills/fetch-country-brief/SKILL.md`, MCP country prompt | Narrative-first routing | Route view requests to the new renderer; preserve explicit text-only use. Regenerate skill-extension output using its normal generator. |

## Shape

Use a shared country controller with two transports and the existing renderer. The public interface hides source scheduling, data normalization, availability, cancellation and view/context reconciliation. It exposes country selection, topic selection, refresh and disposal. This is a country feature, not a general plugin framework.

The sketch uses section-specific payloads. Extract current domain shapes from `CountryBriefPanel` and service projections into a pure country contract. Re-export old type names where needed to preserve callers. Server code must not import components or browser services. Do not put generated client objects, `Date`, HTML or account tokens in wire payloads.

```ts
type CountrySection = keyof CountrySectionPayloads;

type SectionResult<T> =
  | { state: 'ready'; value: T; provenance: ObservationProvenance }
  | { state: 'locked'; reason: string }
  | { state: 'unavailable'; reason: string; retryable: boolean };

type SectionState<T> =
  | { state: 'loading'; previous: SectionResult<T> | null }
  | SectionResult<T>;

interface ObservationProvenance {
  retrievedAt: string;
  observedAt: string | null;
  sources: readonly CountrySource[];
  freshness: 'current' | 'stale' | 'unknown';
}

interface CountryBriefSource {
  read<K extends CountrySection>(
    countryCode: string,
    section: K,
    signal: AbortSignal,
  ): Promise<SectionResult<CountrySectionPayloads[K]>>;
}

type CountryBriefState = {
  country: { code: string; name: string };
  revision: number;
  sections: {
    [K in CountrySection]: SectionState<CountrySectionPayloads[K]>;
  };
};

interface CountryBriefView {
  present(state: CountryBriefState): void;
  selectTopic(topic: CountryTopic): void;
  dispose(): void;
}
```

`CountrySectionPayloads` includes all section rows in the [acceptance matrix](chatgpt-plugin-parity-acceptance.md), plus CII and resilience. Country identity is normalized at the boundary with the existing country resolver. Each payload keeps measurement availability flags and native source dates. A retrieval date is never substituted for an observation date. A rejected or empty provider response is not a zero measurement.

The controller increments its revision on selection, aborts the prior work, and accepts a response only for the current country and revision. Closing invalidates pending callbacks. Refresh preserves previously successful content with an explicit refresh failure. Access changes cancel premium work and clear inaccessible content. The assistant receives the same country, revision, section states, sources and facts rendered by the UI. It must not receive a prose-only replacement for those facts.

### Transport and rendering

`open_country_brief` returns the validated country/view identity and a linked versioned country UI resource. It opens the view; it does not regenerate an AI assessment every time a topic changes. The entry mounts the shared country renderer, then obtains sections through the host. Follow-up render calls carry the same validated view identity and requested topic. Host-supplied results are parsed against the country contract before they enter the controller.

Existing country data tools are reused when their output supplies the exact section contract. Missing readers belong in a fixed `get_country_brief_section` operation, with a section enum and section-specific input schema. The server maps each allowed section to known handlers and bounded parameters. It never accepts a URL, method, headers or a user-defined RPC path. Authorization remains in the existing MCP/gateway path for every call. Scope and entitlement denials remain typed denials, never empty data.

Progressive section loading avoids one large country request that fans out to every provider. Cap concurrency and retries. Register the worst-case downstream cost for each new operation before enabling it. Do not call registry `_execute` methods directly to bypass quota or subscription checks. A free reader may expose only sections already available under the existing free policy; premium sections remain server-gated. Public UI templates contain no private snapshot or account access grant.

The dynamic country entry follows the existing plugin asset build and fixed-origin resource loader. CSP permits only its reviewed assets; profile thumbnails and document assets require an explicit origin audit. Loading renderer HTML is separate from fetching account data. Resource versions change when host contracts change, and acceptance must refresh the installed tool/resource definitions.

OpenAI documents data/render separation and the standard `_meta.ui.resourceUri` link. The currently used standard link and `text/html;profile=mcp-app` are supported. Adding an alias is not a demonstrated fix for the user's missing inline UI. See [OpenAI UI documentation](https://developers.openai.com/plugins/build/chatgpt-ui).

### Actions

Keep topic navigation, reading modes, source links, country switching, refresh, evidence inspection and scenario inputs in the embedded interface. Outputs use the same section snapshot as the visible country. Export success requires opening the actual downloaded file and checking its contents.

Map-country selection invokes the same country controller. A selected news event retains its location precision and publisher evidence. Preserve the existing 2D/3D map implementation and time/source/category filters. Unknown locations remain unknown instead of being placed at misleading centroids.

Follow, notification settings and other persistent account mutations are not authorized by the current read-only connection. Present an explicit authenticated website handoff where necessary. An external handoff does not count as in-plugin action parity. If inline mutation parity is required, add narrowly scoped write tools and obtain the necessary connection authorization before enabling them. Do not fake Pro state or silently perform account mutations.

## Synthesis decision

Two whole architectures were compared sequentially, as required by the user's tool mapping. This is a single-agent comparison, not an independent model consensus.

| Criterion | A. Shared controller, two domain transports | B. Server-composed full country read model |
|---|---|---|
| Caller experience | Open country, select topic, refresh | Fetch assembled snapshot, render, request recomposition for changes |
| Interface depth | Hides source orchestration behind one feature controller | Hides all acquisition and projection behind one country endpoint |
| Existing UI reuse | Keeps panel, presentation, timeline and outputs | Keeps renderers after converting them to snapshot-only consumers |
| Dashboard cache reuse | Website adapter preserves existing cached observations | Requires porting dashboard-only projections to server ownership |
| Partial failures | Independent section states and refresh | Requires partial snapshot protocol and progressive server work |
| Auth and cost | Fixed operations, current per-request enforcement | Large fan-out needs new aggregate authorization/cost handling |
| Main risk | Must remove all component-owned data requests | Broad backend migration and stale/private aggregate cache risks |
| Decision | Selected | Rejected for this migration |

A is the base because it preserves existing website data ownership while removing the plugin fork. Adapt B's explicit observation provenance and partial section results. Do not copy B's monolithic full-country fan-out.

Both candidates were screened for shallow wrappers, browser types leaking into server APIs, hidden initialization order and pass-through layers. The selected controller is justified only if it owns cancellation, projections and UI/context state. A wrapper that merely forwards existing methods is not an implementation of this design.

## Tradeoffs accepted

- Accept a scoped controller/transport extraction in exchange for one maintained country interface.
- Accept progressive loads and separately labeled observation dates in exchange for truthful partial results.
- Accept distinct data and view tools in exchange for preserving existing consumers and deliberate UI routing.
- Accept explicit website handoffs for account mutations under the existing read-only scope. Record these as action gaps.
- Accept a country-first delivery sequence. The rest of the UI fleet remains unaccepted until checked against its matching website workflow.

## Alternatives considered

Booting the whole dashboard inside the MCP frame would expose unrelated initialization, global caches, Clerk sessions and account side effects. It would need an application-wide transport rewrite. A nested authenticated website iframe would hide those dependencies rather than solve them.

Copying country HTML or extending the compact card would make callers coordinate missing data and actions themselves. Both preserve the duplicated implementation that caused the gap.

A generic authenticated RPC proxy would offer a small transport API while exposing a large unreviewed authority surface. Fixed country operations keep the authority boundary inspectable.

## Implementation sequence

1. Capture the website and current MCP widget baseline. Extract the shared section catalog and country data contract. Keep existing website presentation checks passing. Add a common fixture matrix that proves source fields, sections and state transitions rather than counts alone.
2. Move country loading/projections into the shared controller and migrate the website caller. Move lazy food, demographics, scorecard, resilience and scenario requests out of renderers in the same unit. Delete superseded loaders. Preserve website behavior with country-switch, access-change and output regressions.
3. Add the host transport, fixed missing section readers and dedicated country entry. Mount the same panel, presentation and outputs. Verify an opaque-origin iframe with host-mediated tools, no frame credentials and no unmanaged RPC calls.
4. Update the country skill/prompt and tool descriptions. Validate an ordinary country prompt selects the embedded view in the actual installed ChatGPT plugin. Verify US, UA and CN, follow-up questions, mobile layout, failures and actual exports after deployment.
5. Apply the same component-reuse rule to the remaining compact views. Feed data-only tools into appropriate views rather than adding a widget for every utility. Complete news/map layer and action acceptance against the intended scope.
6. Complete store acceptance with the correct publisher identity, current scan results and the native test ledger. Merge, deployment, publisher changes and submission remain separate actions.

Every unit ends with its own verification and reconciliation. A foundational refactor does not establish country parity. Do not call the country slice complete until rows C01-C25 and A01-A12 in the acceptance matrix have a recorded verdict, with every required in-plugin behavior passing.

## Implementation reconciliation

The country entry now mounts the website's `CountryDeepDivePanel`, topic presentation, resilience widget, timeline and output components. `CountryBriefController` owns country hydration, projections, cancellation and revision checks for both callers. The website keeps its existing authentication and dashboard observations. The plugin uses a three-call queue and fixed host-mediated section readers; it carries no browser credentials. Premium-fetch lint validates the private country-source factory and its two allowed callers. Mutation tests reject an exported factory, raw fetch replacement or escaped factory reference.

Lazy food, demographics, factors, resilience and scenario requests remain with their existing DOM lifecycle owner, with an injected country source. Moving them into the controller would duplicate lifecycle guards without improving the authority boundary. Both paths use the same renderer and service contracts. The renderer no longer requires a browser account session for host reads; every restricted request remains server-authorized.

`open_country_brief` links the dedicated country resource. `get_country_brief` keeps its existing assessment contract for explicit text requests. The new `country-view` prompt, published skill and descriptions select the view first. The existing `country-briefing` prompt retains its three executable data steps for text clients. News/map selection exposes an action that asks the host to open the selected country. The new section operation accepts only a fixed reader and validated arguments. It rejects arbitrary URLs, headers, methods and paths, preserves billing/backoff errors, and labels access denials separately from unavailable sources.

Controlled iframe checks exercise the compiled entry with an opaque origin, source links, responsive layout, all ordinary section mounts, refresh failures, country switching, actual report downloads and scenario calculations. Existing website checks exercise US evidence/report behavior and limited-country/China navigation. These are fixture checks, not production freshness or installed ChatGPT acceptance.

### Remaining acceptance gaps

- Dashboard-derived signal counts and live country flight/vessel activity have no matching host projection yet. The plugin explicitly shows them as unavailable rather than zero.
- Infrastructure geometry and tables load, but Energy Atlas registry counts and detail event actions still depend on dashboard startup. Full infrastructure interaction parity is open.
- Toolbar refresh also invokes the existing food, demographics, factors and resilience loaders. Resilience uses its existing error/refresh presentation; native recovery still requires acceptance.
- Persistent follow/notification actions use an explicit website handoff under the current read-only scope.
- Ordinary prompt routing, host-mediated source reads, follow-up selection, native downloads and composer layout must be tested in the installed draft after deployment. US, UA and CN native acceptance remains open.
- The other compact widgets and full map interaction scope remain unaccepted. Tool and resource totals do not establish feature parity or store readiness.
- Assessment quality remains a separate server concern. This renderer displays the accepted assessment contract and does not validate unsupported causal claims or undefined forecast events.

## Risks to resolve through tests

- Can the host mount the versioned country entry for an ordinary country request without substituting a text-only answer? Chrome inspection timed out; the cause remains unverified.
- Do all country projections preserve the website's observation scope and availability, including dashboard-derived signals? Compare shared fixtures field by field.
- Can downloads and rich layouts work with the native host composer? A local iframe cannot settle this.
- Can unsupported causal relationships and undefined forecast events pass the AI assessment validator? Existing native responses demonstrate this risk. UI parity does not repair it. Add targeted server-quality regressions and keep unsafe narrative withheld until validated.
- Which account actions require a new write scope? Current read-only authorization permits data access, not mutation parity.

## Next acceptance step

Deploy the reviewed country-view unit, refresh the private draft's tool definitions, and test an ordinary US country request and follow-up topics in signed-in ChatGPT. Close the explicitly listed data/action gaps before recording full parity or store readiness. Merge and deployment require separate authorization.
