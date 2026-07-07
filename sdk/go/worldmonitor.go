// Package worldmonitor is the official Go SDK for the World Monitor
// global-intelligence API (https://worldmonitor.app) — country briefs, risk
// scores, conflict/cyber/market/news feeds, and MCP tools without writing an
// HTTP integration.
//
// Stdlib-only (zero dependencies), MCP-first — the same design as the
// worldmonitor npm CLI this mirrors (cli/ in the main repository). The MCP
// server (https://worldmonitor.app/mcp) is the live, documented agent
// surface: tools/list is public, and tools/call (used by the curated
// helpers) authenticates with a user API key. A small REST escape hatch
// (Get/Health) rounds it out for host-relative and self-hosted use.
//
//	client := worldmonitor.New("wm_...") // or "" to read WORLDMONITOR_API_KEY
//	risk, err := client.CountryRisk(ctx, "IR", nil)
//	quotes, err := client.CallTool(ctx, "get_market_data", worldmonitor.Args{"asset_class": "crypto"})
//	health, err := client.Get(ctx, "/api/health", nil)
//
// Every tool accepts an optional "jmespath" argument for server-side
// projection (typically an 80-95% response-size cut), e.g.
// Args{"jmespath": "hotspots[].name"}.
package worldmonitor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Version of this SDK. The release workflow checks it against the
// sdk/go/vX.Y.Z tag before warming the module proxy.
const Version = "0.1.1"

// UserAgent identifies the SDK on every request. Cloudflare's WAF challenges
// generic library User-Agents (Go-http-client, curl, empty) on the API edge,
// so we always identify ourselves.
const UserAgent = "worldmonitor-go/" + Version + " (+https://worldmonitor.app)"

const (
	DefaultBaseURL = "https://api.worldmonitor.app"
	DefaultMCPURL  = "https://worldmonitor.app/mcp"

	// APIKeyHeader is the header the API accepts for a user-issued key
	// (alias: X-Api-Key).
	APIKeyHeader = "X-WorldMonitor-Key"

	// MCPAuthErrorCode is the JSON-RPC error code the MCP server returns
	// when a call needs authentication.
	MCPAuthErrorCode = -32001

	authHint = "hint: this call needs a key - pass an API key to New or set WORLDMONITOR_API_KEY (get one at https://worldmonitor.app/pro)"

	defaultTimeout = 30 * time.Second
)

// Args holds the named arguments of an MCP tool call or REST query.
type Args map[string]any

// APIError is a REST or transport-level failure (non-2xx HTTP response).
type APIError struct {
	Status int
	Body   json.RawMessage
}

func (e *APIError) Error() string {
	msg := fmt.Sprintf("worldmonitor: HTTP %d: %s", e.Status, truncate(string(e.Body)))
	if e.Status == http.StatusUnauthorized {
		msg += " (" + authHint + ")"
	}
	return msg
}

// MCPError is a JSON-RPC error returned by the MCP server.
type MCPError struct {
	Code    int
	Message string
	Data    json.RawMessage
}

func (e *MCPError) Error() string {
	msg := fmt.Sprintf("worldmonitor: MCP error %d: %s", e.Code, e.Message)
	if e.Code == MCPAuthErrorCode {
		msg += " (" + authHint + ")"
	}
	return msg
}

// Client is a thin client for the World Monitor MCP server and REST API.
// The zero value is not usable; construct it with New.
type Client struct {
	// APIKey is the user API key sent as X-WorldMonitor-Key.
	APIKey string
	// BaseURL is the REST base (default https://api.worldmonitor.app).
	BaseURL string
	// MCPURL is the MCP endpoint (default https://worldmonitor.app/mcp).
	MCPURL string
	// HTTPClient performs requests; override its Transport in tests.
	HTTPClient *http.Client
}

// New returns a Client. An empty apiKey falls back to the
// WORLDMONITOR_API_KEY (or WM_API_KEY) environment variable; the REST and
// MCP endpoints honour WORLDMONITOR_BASE_URL and WORLDMONITOR_MCP_URL.
func New(apiKey string) *Client {
	if apiKey == "" {
		apiKey = os.Getenv("WORLDMONITOR_API_KEY")
	}
	if apiKey == "" {
		apiKey = os.Getenv("WM_API_KEY")
	}
	baseURL := os.Getenv("WORLDMONITOR_BASE_URL")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	mcpURL := os.Getenv("WORLDMONITOR_MCP_URL")
	if mcpURL == "" {
		mcpURL = DefaultMCPURL
	}
	return &Client{
		APIKey:     apiKey,
		BaseURL:    strings.TrimRight(baseURL, "/"),
		MCPURL:     mcpURL,
		HTTPClient: &http.Client{Timeout: defaultTimeout},
	}
}

// -- low-level surfaces ------------------------------------------------------

// CallTool calls an MCP tool by name and returns the unwrapped JSON-RPC
// result. A nil args map is allowed.
func (c *Client) CallTool(ctx context.Context, name string, args Args) (json.RawMessage, error) {
	if args == nil {
		args = Args{}
	}
	return c.rpc(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
}

// ListTools lists every MCP tool (public - no key needed).
func (c *Client) ListTools(ctx context.Context) (json.RawMessage, error) {
	return c.rpc(ctx, "tools/list", nil)
}

// ListPrompts lists MCP prompt templates (public).
func (c *Client) ListPrompts(ctx context.Context) (json.RawMessage, error) {
	return c.rpc(ctx, "prompts/list", nil)
}

// ListResources lists MCP resources (public).
func (c *Client) ListResources(ctx context.Context) (json.RawMessage, error) {
	return c.rpc(ctx, "resources/list", nil)
}

// Get performs a GET against a raw REST path (host-relative, e.g.
// "/api/health") with optional query parameters.
func (c *Client) Get(ctx context.Context, path string, params Args) (json.RawMessage, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, fmt.Errorf("worldmonitor: Get needs a host-relative API path starting with %q", "/")
	}
	u := c.BaseURL + path
	if len(params) > 0 {
		q := url.Values{}
		for k, v := range params {
			q.Set(k, stringify(v))
		}
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	c.setCommonHeaders(req)

	status, contentType, body, err := c.do(req)
	if err != nil {
		return nil, err
	}
	payload := parseBody(body, contentType)
	if status < 200 || status > 299 {
		return nil, &APIError{Status: status, Body: payload}
	}
	return payload, nil
}

// Health fetches the API status / health check.
func (c *Client) Health(ctx context.Context) (json.RawMessage, error) {
	return c.Get(ctx, "/api/health", nil)
}

// -- curated helpers over the highest-traffic MCP tools -----------------------
// Every other tool is reachable via CallTool, so this table stays small and
// mirrors the npm CLI's curated commands one-to-one. The extra Args merge
// into the tool arguments (jmespath, limit, ...).

// WorldBrief returns the live global situation brief.
func (c *Client) WorldBrief(ctx context.Context, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_world_brief", args)
}

// CountryBrief returns the AI strategic brief for a country
// (ISO 3166-1 alpha-2 code).
func (c *Client) CountryBrief(ctx context.Context, countryCode string, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_country_brief", withArg(args, "country_code", countryCode))
}

// CountryRisk returns country risk / resilience scores
// (ISO 3166-1 alpha-2 code).
func (c *Client) CountryRisk(ctx context.Context, countryCode string, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_country_risk", withArg(args, "country_code", countryCode))
}

// MarketData returns equities, commodities, crypto and FX quotes.
func (c *Client) MarketData(ctx context.Context, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_market_data", args)
}

// ConflictEvents returns recent conflict events (country, min_fatalities,
// limit, ...).
func (c *Client) ConflictEvents(ctx context.Context, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_conflict_events", args)
}

// CyberThreats returns cyber-threat indicators (min_severity, threat_type,
// country, ...).
func (c *Client) CyberThreats(ctx context.Context, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_cyber_threats", args)
}

// NewsIntelligence returns classified news intelligence (topic, country,
// alerts_only, ...).
func (c *Client) NewsIntelligence(ctx context.Context, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_news_intelligence", args)
}

// NaturalDisasters returns earthquakes, fires and storms (dataset,
// active_only, min_magnitude, ...).
func (c *Client) NaturalDisasters(ctx context.Context, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_natural_disasters", args)
}

// SanctionsData returns sanctions designations (country, entity_type,
// query, ...).
func (c *Client) SanctionsData(ctx context.Context, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_sanctions_data", args)
}

// ForecastPredictions returns scenario forecasts (domain, region, ...).
func (c *Client) ForecastPredictions(ctx context.Context, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_forecast_predictions", args)
}

// MaritimeActivity returns maritime / port activity for a country
// (ISO 3166-1 alpha-2 code).
func (c *Client) MaritimeActivity(ctx context.Context, countryCode string, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_maritime_activity", withArg(args, "country_code", countryCode))
}

// -- plumbing -----------------------------------------------------------------

func (c *Client) rpc(ctx context.Context, method string, params any) (json.RawMessage, error) {
	rpc := map[string]any{"jsonrpc": "2.0", "id": 1, "method": method}
	if params != nil {
		rpc["params"] = params
	}
	encoded, err := json.Marshal(rpc)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.MCPURL, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	c.setCommonHeaders(req)

	status, contentType, body, err := c.do(req)
	if err != nil {
		return nil, err
	}
	payload := parseBody(body, contentType)

	// A JSON-RPC error object wins over the HTTP status (the server pairs
	// auth errors with a 200 on some transports).
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int             `json:"code"`
			Message string          `json:"message"`
			Data    json.RawMessage `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &envelope); err == nil && envelope.Error != nil {
		return nil, &MCPError{Code: envelope.Error.Code, Message: envelope.Error.Message, Data: envelope.Error.Data}
	}
	if status < 200 || status > 299 {
		return nil, &APIError{Status: status, Body: payload}
	}
	if envelope.Result != nil {
		return envelope.Result, nil
	}
	return payload, nil
}

func (c *Client) setCommonHeaders(req *http.Request) {
	req.Header.Set("User-Agent", UserAgent)
	if c.APIKey != "" {
		req.Header.Set(APIKeyHeader, c.APIKey)
	}
}

func (c *Client) do(req *http.Request) (status int, contentType string, body []byte, err error) {
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return 0, "", nil, err
	}
	defer res.Body.Close()
	body, err = io.ReadAll(res.Body)
	if err != nil {
		return 0, "", nil, err
	}
	return res.StatusCode, res.Header.Get("Content-Type"), body, nil
}

// parseBody decodes an MCP/REST response body. MCP responses may arrive as
// Server-Sent Events (Streamable HTTP): pull the last "data:" payload.
// Otherwise the body is returned as-is (raw JSON), with non-JSON text wrapped
// as a JSON string so callers always get a valid json.RawMessage.
func parseBody(body []byte, contentType string) json.RawMessage {
	text := string(body)
	payload := text
	if strings.Contains(contentType, "text/event-stream") || looksLikeSSE(text) {
		payload = ""
		for _, line := range strings.Split(text, "\n") {
			line = strings.TrimSuffix(line, "\r")
			if strings.HasPrefix(line, "data:") {
				payload = strings.TrimSpace(line[5:])
			}
		}
	}
	if payload == "" {
		payload = text
	}
	if json.Valid([]byte(payload)) {
		return json.RawMessage(payload)
	}
	quoted, err := json.Marshal(payload)
	if err != nil {
		return json.RawMessage(`""`)
	}
	return quoted
}

func looksLikeSSE(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "event:") || strings.HasPrefix(line, "data:") {
			return true
		}
	}
	return false
}

func withArg(args Args, key string, value any) Args {
	merged := Args{}
	for k, v := range args {
		merged[k] = v
	}
	merged[key] = value
	return merged
}

func stringify(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprint(t)
	}
}

func truncate(s string) string {
	const limit = 300
	if len(s) <= limit {
		return s
	}
	return s[:limit-1] + "…"
}
