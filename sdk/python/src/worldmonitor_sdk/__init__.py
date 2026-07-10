"""Official Python SDK for the World Monitor global-intelligence API.

Dependency-free (stdlib only), MCP-first — the same design as the
``worldmonitor`` npm CLI this mirrors (``cli/`` in the main repository).
The MCP server (https://worldmonitor.app/mcp) is the live, documented agent
surface: ``tools/list`` is public, and ``tools/call`` (used by the curated
helpers) authenticates with a user API key. A small REST escape hatch
(``get``/``health``) rounds it out for host-relative and self-hosted use.

    from worldmonitor_sdk import Client

    client = Client(api_key="wm_...")       # or env WORLDMONITOR_API_KEY
    client.country_risk("IR")               # MCP tools/call get_country_risk
    client.call_tool("get_market_data", asset_class="crypto")
    client.get("/api/health")               # raw REST GET

Every tool accepts an optional ``jmespath`` argument for server-side
projection (typically an 80-95% response-size cut), e.g.
``client.world_brief(jmespath="hotspots[].name")``.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

__version__ = "0.1.1"

# Cloudflare's WAF challenges generic library User-Agents (python-requests,
# python-urllib, curl, empty) on the API edge, so we always identify ourselves.
USER_AGENT = "worldmonitor-python/%s (+https://worldmonitor.app)" % __version__

DEFAULT_BASE_URL = "https://api.worldmonitor.app"
DEFAULT_MCP_URL = "https://worldmonitor.app/mcp"

# Header the API accepts for a user-issued key (alias: X-Api-Key).
API_KEY_HEADER = "X-WorldMonitor-Key"

# JSON-RPC error code the MCP server returns when a call needs authentication.
MCP_AUTH_ERROR_CODE = -32001

AUTH_HINT = (
    "Hint: this call needs a key - pass api_key= or set WORLDMONITOR_API_KEY "
    "(get one at https://worldmonitor.app/pro)."
)

DEFAULT_TIMEOUT = 30.0


class WorldMonitorError(Exception):
    """Base class for every error raised by this SDK."""


class APIError(WorldMonitorError):
    """A REST or transport-level failure (non-2xx HTTP response)."""

    def __init__(self, status, body):
        self.status = status
        self.body = body
        hint = " " + AUTH_HINT if status == 401 else ""
        super().__init__("HTTP %d: %s%s" % (status, _truncate(body), hint))


class MCPError(WorldMonitorError):
    """A JSON-RPC ``error`` returned by the MCP server."""

    def __init__(self, code, message, data=None):
        self.code = code
        self.data = data
        hint = " " + AUTH_HINT if code == MCP_AUTH_ERROR_CODE else ""
        super().__init__("MCP error %d: %s%s" % (code, message, hint))


def _truncate(value, limit=300):
    text = value if isinstance(value, str) else json.dumps(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def parse_body(text, content_type=""):
    """Decode an MCP/REST response body.

    MCP responses may arrive as Server-Sent Events (Streamable HTTP): pull the
    last ``data:`` payload. Otherwise parse the whole body as JSON, falling
    back to the raw text when it is not JSON at all.
    """
    payload = text
    if "text/event-stream" in (content_type or "") or _looks_like_sse(text):
        data_lines = [
            line[5:].strip()
            for line in text.splitlines()
            if line.startswith("data:")
        ]
        payload = data_lines[-1] if data_lines else ""
    if not payload:
        return text
    try:
        return json.loads(payload)
    except ValueError:
        return text


def _looks_like_sse(text):
    return any(
        line.startswith("event:") or line.startswith("data:")
        for line in text.splitlines()
    )


def _default_transport(request, timeout):
    """Perform an HTTP request with urllib; returns (status, content_type, text).

    ``request`` is a dict with keys url, method, headers, body (bytes or None).
    Non-2xx responses are returned, not raised, so callers can surface the
    parsed error body.
    """
    req = urllib.request.Request(
        request["url"],
        data=request.get("body"),
        headers=request.get("headers") or {},
        method=request.get("method", "GET"),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return (
                res.status,
                res.headers.get("content-type", ""),
                res.read().decode("utf-8", "replace"),
            )
    except urllib.error.HTTPError as err:
        return (
            err.code,
            err.headers.get("content-type", "") if err.headers else "",
            err.read().decode("utf-8", "replace"),
        )


class Client:
    """Thin client for the World Monitor MCP server and REST API.

    All keyword arguments are optional; unset values fall back to the
    ``WORLDMONITOR_API_KEY`` (or ``WM_API_KEY``), ``WORLDMONITOR_BASE_URL``,
    and ``WORLDMONITOR_MCP_URL`` environment variables, then to the public
    production endpoints. ``transport`` is injectable for offline tests: a
    callable ``(request_dict, timeout) -> (status, content_type, text)``.
    """

    def __init__(
        self,
        api_key=None,
        base_url=None,
        mcp_url=None,
        timeout=DEFAULT_TIMEOUT,
        transport=None,
        env=None,
    ):
        env = os.environ if env is None else env
        self.api_key = api_key or env.get("WORLDMONITOR_API_KEY") or env.get("WM_API_KEY")
        self.base_url = (base_url or env.get("WORLDMONITOR_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.mcp_url = mcp_url or env.get("WORLDMONITOR_MCP_URL") or DEFAULT_MCP_URL
        self.timeout = timeout
        self._transport = transport or _default_transport

    # -- low-level surfaces ------------------------------------------------

    def call_tool(self, name, arguments=None, **kwargs):
        """Call an MCP tool by name and return the unwrapped JSON-RPC result.

        Tool arguments come from ``arguments`` (a dict) merged with any extra
        keyword arguments, so both styles work:
        ``call_tool("get_country_risk", {"country_code": "IR"})`` and
        ``call_tool("get_country_risk", country_code="IR")``.
        """
        args = dict(arguments or {})
        args.update(kwargs)
        return self._rpc("tools/call", {"name": name, "arguments": args})

    def list_tools(self):
        """List every MCP tool (public - no key needed)."""
        return self._rpc("tools/list")

    def list_prompts(self):
        """List MCP prompt templates (public)."""
        return self._rpc("prompts/list")

    def list_resources(self):
        """List MCP resources (public)."""
        return self._rpc("resources/list")

    def get(self, path, params=None, **kwargs):
        """GET a raw REST path (host-relative, e.g. ``/api/health``)."""
        if not path.startswith("/"):
            raise ValueError("get() needs a host-relative API path starting with '/'")
        query = dict(params or {})
        query.update(kwargs)
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: _stringify(v) for k, v in query.items()})
        status, content_type, text = self._transport(
            {"url": url, "method": "GET", "headers": self._headers(accept="application/json")},
            self.timeout,
        )
        value = parse_body(text, content_type)
        if status < 200 or status >= 300:
            raise APIError(status, value)
        return value

    def health(self):
        """API status / health check."""
        return self.get("/api/health")

    # -- curated helpers over the highest-traffic MCP tools ----------------
    # Every other tool is reachable via call_tool(), so this table stays
    # small and mirrors the npm CLI's curated commands one-to-one.

    def world_brief(self, **args):
        """Live global situation brief."""
        return self.call_tool("get_world_brief", args)

    def country_brief(self, country_code, **args):
        """AI strategic brief for a country (ISO 3166-1 alpha-2 code)."""
        return self.call_tool("get_country_brief", args, country_code=country_code)

    def country_risk(self, country_code, **args):
        """Country risk / resilience scores (ISO 3166-1 alpha-2 code)."""
        return self.call_tool("get_country_risk", args, country_code=country_code)

    def market_data(self, **args):
        """Equities, commodities, crypto and FX quotes."""
        return self.call_tool("get_market_data", args)

    def conflict_events(self, **args):
        """Recent conflict events (country=, min_fatalities=, limit=...)."""
        return self.call_tool("get_conflict_events", args)

    def cyber_threats(self, **args):
        """Cyber-threat indicators (min_severity=, threat_type=, country=...)."""
        return self.call_tool("get_cyber_threats", args)

    def news_intelligence(self, **args):
        """Classified news intelligence (topic=, country=, alerts_only=...)."""
        return self.call_tool("get_news_intelligence", args)

    def natural_disasters(self, **args):
        """Earthquakes, fires and storms (dataset=, active_only=, min_magnitude=...)."""
        return self.call_tool("get_natural_disasters", args)

    def sanctions_data(self, **args):
        """Sanctions designations (country=, entity_type=, query=...)."""
        return self.call_tool("get_sanctions_data", args)

    def forecast_predictions(self, **args):
        """Scenario forecasts (domain=, region=...)."""
        return self.call_tool("get_forecast_predictions", args)

    def maritime_activity(self, country_code, **args):
        """Maritime / port activity for a country (ISO 3166-1 alpha-2 code)."""
        return self.call_tool("get_maritime_activity", args, country_code=country_code)

    # -- plumbing -----------------------------------------------------------

    def _headers(self, accept):
        headers = {"user-agent": USER_AGENT, "accept": accept}
        if self.api_key:
            headers[API_KEY_HEADER] = self.api_key
        return headers

    def _rpc(self, method, params=None):
        rpc = {"jsonrpc": "2.0", "id": 1, "method": method}
        if params is not None:
            rpc["params"] = params
        headers = self._headers(accept="application/json, text/event-stream")
        headers["content-type"] = "application/json"
        status, content_type, text = self._transport(
            {
                "url": self.mcp_url,
                "method": "POST",
                "headers": headers,
                "body": json.dumps(rpc).encode("utf-8"),
            },
            self.timeout,
        )
        value = parse_body(text, content_type)
        # A JSON-RPC error object wins over the HTTP status (the server pairs
        # auth errors with a 200 on some transports).
        if isinstance(value, dict) and isinstance(value.get("error"), dict):
            err = value["error"]
            raise MCPError(err.get("code", 0), err.get("message", ""), err.get("data"))
        if status < 200 or status >= 300:
            raise APIError(status, value)
        if isinstance(value, dict) and "result" in value:
            return value["result"]
        return value


def _stringify(value):
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


__all__ = [
    "API_KEY_HEADER",
    "AUTH_HINT",
    "APIError",
    "Client",
    "DEFAULT_BASE_URL",
    "DEFAULT_MCP_URL",
    "MCP_AUTH_ERROR_CODE",
    "MCPError",
    "USER_AGENT",
    "WorldMonitorError",
    "parse_body",
    "__version__",
]
