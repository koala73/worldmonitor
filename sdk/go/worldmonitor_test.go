// Offline tests for the worldmonitor Go SDK (httptest server, no network).
package worldmonitor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type recorded struct {
	method  string
	path    string
	query   string
	headers http.Header
	body    []byte
}

func newTestClient(t *testing.T, handler http.HandlerFunc) (*Client, *[]recorded) {
	t.Helper()
	var calls []recorded
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls = append(calls, recorded{
			method:  r.Method,
			path:    r.URL.Path,
			query:   r.URL.RawQuery,
			headers: r.Header.Clone(),
			body:    body,
		})
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	client := &Client{
		BaseURL:    server.URL,
		MCPURL:     server.URL + "/mcp",
		HTTPClient: server.Client(),
	}
	return client, &calls
}

func TestCallToolBuildsJSONRPCAndUnwrapsResult(t *testing.T) {
	client, calls := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`)
	})
	client.APIKey = "wm_k"

	result, err := client.CallTool(context.Background(), "get_country_risk", Args{"country_code": "IR"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if string(result) != `{"ok":true}` {
		t.Fatalf("result = %s", result)
	}

	call := (*calls)[0]
	if call.method != http.MethodPost || call.path != "/mcp" {
		t.Fatalf("request = %s %s", call.method, call.path)
	}
	if got := call.headers.Get(APIKeyHeader); got != "wm_k" {
		t.Fatalf("%s = %q", APIKeyHeader, got)
	}
	if got := call.headers.Get("User-Agent"); got != UserAgent {
		t.Fatalf("User-Agent = %q", got)
	}
	if accept := call.headers.Get("Accept"); !strings.Contains(accept, "text/event-stream") {
		t.Fatalf("Accept = %q", accept)
	}
	var rpc struct {
		Method string `json:"method"`
		Params struct {
			Name      string            `json:"name"`
			Arguments map[string]string `json:"arguments"`
		} `json:"params"`
	}
	if err := json.Unmarshal(call.body, &rpc); err != nil {
		t.Fatalf("unmarshal request body: %v", err)
	}
	if rpc.Method != "tools/call" || rpc.Params.Name != "get_country_risk" ||
		rpc.Params.Arguments["country_code"] != "IR" {
		t.Fatalf("rpc = %+v", rpc)
	}
}

func TestCuratedHelperMapsToTool(t *testing.T) {
	client, calls := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
	})
	if _, err := client.CountryRisk(context.Background(), "IR", Args{"jmespath": "scores"}); err != nil {
		t.Fatalf("CountryRisk: %v", err)
	}
	var rpc struct {
		Params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		} `json:"params"`
	}
	if err := json.Unmarshal((*calls)[0].body, &rpc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if rpc.Params.Name != "get_country_risk" {
		t.Fatalf("tool = %q", rpc.Params.Name)
	}
	if rpc.Params.Arguments["country_code"] != "IR" || rpc.Params.Arguments["jmespath"] != "scores" {
		t.Fatalf("arguments = %v", rpc.Params.Arguments)
	}
}

func TestListToolsIsKeyless(t *testing.T) {
	client, calls := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`)
	})
	result, err := client.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if string(result) != `{"tools":[]}` {
		t.Fatalf("result = %s", result)
	}
	call := (*calls)[0]
	if got := call.headers.Get(APIKeyHeader); got != "" {
		t.Fatalf("unexpected API key header %q", got)
	}
	if strings.Contains(string(call.body), "params") {
		t.Fatalf("tools/list must not send params: %s", call.body)
	}
}

func TestMCPErrorWinsOverHTTP200(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":1,"error":{"code":%d,"message":"auth required"}}`, MCPAuthErrorCode)
	})
	_, err := client.WorldBrief(context.Background(), nil)
	var mcpErr *MCPError
	if !errors.As(err, &mcpErr) {
		t.Fatalf("want *MCPError, got %v", err)
	}
	if mcpErr.Code != MCPAuthErrorCode {
		t.Fatalf("code = %d", mcpErr.Code)
	}
	if !strings.Contains(mcpErr.Error(), "WORLDMONITOR_API_KEY") {
		t.Fatalf("auth hint missing: %s", mcpErr.Error())
	}
}

func TestSSEResponseIsUnwrapped(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"n\":1}}\n\n")
	})
	result, err := client.CallTool(context.Background(), "t", nil)
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if string(result) != `{"n":1}` {
		t.Fatalf("result = %s", result)
	}
}

func TestGetBuildsQueryAndParses(t *testing.T) {
	client, calls := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	client.APIKey = "wm_k"
	result, err := client.Get(context.Background(), "/api/health", Args{"verbose": true})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(result) != `{"status":"ok"}` {
		t.Fatalf("result = %s", result)
	}
	call := (*calls)[0]
	if call.path != "/api/health" || call.query != "verbose=true" {
		t.Fatalf("request = %s?%s", call.path, call.query)
	}
	if got := call.headers.Get(APIKeyHeader); got != "wm_k" {
		t.Fatalf("%s = %q", APIKeyHeader, got)
	}
}

func TestGetRequiresHostRelativePath(t *testing.T) {
	client := New("")
	if _, err := client.Get(context.Background(), "api/health", nil); err == nil {
		t.Fatal("want error for non host-relative path")
	}
}

func TestNon2xxReturnsAPIError(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"unauthorized"}`)
	})
	_, err := client.Health(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want *APIError, got %v", err)
	}
	if apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d", apiErr.Status)
	}
	if !strings.Contains(apiErr.Error(), "WORLDMONITOR_API_KEY") {
		t.Fatalf("auth hint missing: %s", apiErr.Error())
	}
}

func TestUserAgentCarriesVersion(t *testing.T) {
	if !strings.HasPrefix(UserAgent, "worldmonitor-go/") || !strings.Contains(UserAgent, Version) {
		t.Fatalf("UserAgent = %q", UserAgent)
	}
	if !strings.Contains(UserAgent, "+https://worldmonitor.app") {
		t.Fatalf("UserAgent must reference the product domain: %q", UserAgent)
	}
}

func TestNonJSONBodyIsWrappedAsJSONString(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "plain text")
	})
	result, err := client.Get(context.Background(), "/api/health", nil)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	var s string
	if err := json.Unmarshal(result, &s); err != nil || s != "plain text" {
		t.Fatalf("result = %s (err %v)", result, err)
	}
}
