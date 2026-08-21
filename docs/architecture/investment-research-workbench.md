# Investment Research Workbench

The finance variant uses World Monitor as the situational-awareness UI and adds a drill-down workflow:

`world / macro → sector → company → earnings + news + valuation + company-macro agents → critic → bull / base / bear → thesis tracker`

## Extension points

- `InvestmentResearchWorkbenchPanel` owns interaction and presentation only. It consumes the typed `InvestmentResearchReport` contract and never calls finance vendors directly.
- `createResearchWorkbenchAdapter()` selects a local, source-traceable ASTS fixture when no endpoint is configured, or a remote adapter when `VITE_RESEARCH_WORKBENCH_URL` is present.
- The remote endpoint is the Langflow orchestration boundary. It should call OpenBB for normalized market data, filings, estimates and comparable-company inputs; FinRobot or custom components may handle company research; the critic must run after the parallel research agents.
- The browser sends no vendor credentials. API keys belong behind the orchestration endpoint or in the desktop sidecar/keychain.
- Any panel can dispatch `wm:open-investment-research` with `{ symbol }` to open the workbench for a company without importing the panel itself.

## Traceability contract

Every material finding, scenario and thesis pillar references stable source ids. The adapter rejects a report containing unknown source ids. Sources record publisher, URL, evidence type, reliability and as-of date. Facts, management claims, assumptions, model outputs and PM judgments remain visibly distinct.

The bundled ASTS fixture is deliberately `not-decision-grade`: it demonstrates the complete UI without credentials but does not invent a live price, consensus, target price or scenario probability. A production adapter must freeze time-sensitive market inputs and may mark the report decision-grade only after the required price, estimate, valuation and evidence gates pass.

## Remote request

The browser posts the schema version, normalized symbol, ordered workflow and `dataLayer: "openbb"`. The response must satisfy `investment-research-workbench/v1`. This keeps Langflow replaceable and allows direct custom orchestration later without changing the UI.

