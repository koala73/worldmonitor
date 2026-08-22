# Investment Research Workbench

The finance variant uses World Monitor as the situational-awareness UI and adds a drill-down workflow:

`world / macro → sector → company → earnings + news + valuation + company-macro agents → critic → bull / base / bear → thesis tracker`

## Extension points

- `InvestmentResearchWorkbenchPanel` owns interaction and presentation only. It consumes the typed `InvestmentResearchReport` contract and never calls finance vendors directly.
- `createResearchWorkbenchAdapter()` selects a local, source-traceable ASTS fixture when no endpoint is configured, or a remote adapter when `VITE_RESEARCH_WORKBENCH_URL` is present.
- The remote endpoint is a replaceable research-sidecar boundary. It should call OpenBB for normalized market data; FinRobot or custom components may handle company research; Langflow may orchestrate the critic after the parallel research agents.
- The browser sends no vendor credentials. API keys belong behind the orchestration endpoint or in the desktop sidecar/keychain.
- Any panel can dispatch `wm:open-investment-research` with `{ symbol }` to open the workbench for a company without importing the panel itself.

## Traceability contract

Every material finding, scenario and thesis pillar references stable source ids. The adapter rejects a report containing unknown source ids. Sources record publisher, URL, evidence type, reliability and as-of date. Facts, management claims, assumptions, model outputs and PM judgments remain visibly distinct.

The bundled ASTS fixture is deliberately `not-decision-grade`: it demonstrates the complete UI without credentials but does not invent a live price, consensus, target price or scenario probability. A production adapter must freeze time-sensitive market inputs and may mark the report decision-grade only after the required price, estimate, valuation and evidence gates pass.

## Remote request

The browser posts the schema version, normalized symbol, ordered workflow and `dataLayer: "openbb"`. The response must satisfy `investment-research-workbench/v1`. A companion local sidecar can expose `POST /v1/research/run`, keeping OpenBB/Python and credentials outside the browser bundle, and can call Langflow's `POST /api/v1/run/{FLOW_ID}` route when configured. This keeps both the data provider and orchestration layer replaceable without changing the UI.
