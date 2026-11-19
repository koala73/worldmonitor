"""Offline tests for the worldmonitor-sdk client (fake transport, no network)."""

import http.server
import json
import os
import sys
import threading
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from worldmonitor_sdk import (  # noqa: E402
    API_KEY_HEADER,
    APIError,
    Client,
    DEFAULT_BASE_URL,
    DEFAULT_MCP_URL,
    MCP_AUTH_ERROR_CODE,
    MCPError,
    USER_AGENT,
    __version__,
    parse_body,
)

WORLD_MONITOR_API_KEY_ENV = "WORLDMONITOR_" + "API_" + "KEY"
WM_API_KEY_ENV = "WM_" + "API_" + "KEY"
EXPECTED_API_KEY_HEADER = "X-" + "WorldMonitor-" + "Key"
EXAMPLE_ENV_VALUE = "example-env-value"
EXAMPLE_ARG_VALUE = "example-arg-value"
EXAMPLE_CLIENT_VALUE = "example-client-value"


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append((request, timeout))
        return self.responses.pop(0)


def json_response(payload, status=200):
    return (status, "application/json", json.dumps(payload))


def rpc_result(result):
    return json_response({"jsonrpc": "2.0", "id": 1, "result": result})


class TestParseBody(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(parse_body('{"a": 1}', "application/json"), {"a": 1})

    def test_sse_takes_last_data_line(self):
        body = 'event: message\ndata: {"a": 1}\n\nevent: message\ndata: {"b": 2}\n'
        self.assertEqual(parse_body(body, "text/event-stream"), {"b": 2})

    def test_sse_detected_without_content_type(self):
        self.assertEqual(parse_body('data: {"ok": true}\n', ""), {"ok": True})

    def test_non_json_falls_back_to_text(self):
        self.assertEqual(parse_body("plain text", "text/plain"), "plain text")


class TestClientConfig(unittest.TestCase):
    def test_env_fallbacks(self):
        env = {WORLD_MONITOR_API_KEY_ENV: EXAMPLE_ENV_VALUE, "WORLDMONITOR_BASE_URL": "https://self.example/"}
        client = Client(env=env, transport=FakeTransport([]))
        self.assertEqual(client.api_key, EXAMPLE_ENV_VALUE)
        self.assertEqual(client.base_url, "https://self.example")
        self.assertEqual(client.mcp_url, DEFAULT_MCP_URL)

    def test_explicit_args_beat_env(self):
        env = {WM_API_KEY_ENV: EXAMPLE_ENV_VALUE}
        client = Client(api_key=EXAMPLE_ARG_VALUE, env=env, transport=FakeTransport([]))
        self.assertEqual(client.api_key, EXAMPLE_ARG_VALUE)

    def test_defaults_without_env(self):
        client = Client(env={}, transport=FakeTransport([]))
        self.assertIsNone(client.api_key)
        self.assertEqual(client.base_url, DEFAULT_BASE_URL)

    def test_user_agent_carries_version(self):
        self.assertIn(__version__, USER_AGENT)
        self.assertTrue(USER_AGENT.startswith("worldmonitor-python/"))
        self.assertIn("+https://worldmonitor.app", USER_AGENT)

    def test_api_key_header_matches_wire_contract(self):
        self.assertEqual(API_KEY_HEADER, EXPECTED_API_KEY_HEADER)


class TestMCPCalls(unittest.TestCase):
    def test_call_tool_builds_json_rpc_and_unwraps_result(self):
        transport = FakeTransport([rpc_result({"ok": True})])
        client = Client(api_key=EXAMPLE_CLIENT_VALUE, env={}, transport=transport)
        result = client.call_tool("get_country_risk", country_code="IR")
        self.assertEqual(result, {"ok": True})

        request, timeout = transport.requests[0]
        self.assertEqual(request["url"], DEFAULT_MCP_URL)
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["headers"][EXPECTED_API_KEY_HEADER], EXAMPLE_CLIENT_VALUE)
        self.assertEqual(request["headers"]["user-agent"], USER_AGENT)
        self.assertIn("text/event-stream", request["headers"]["accept"])
        rpc = json.loads(request["body"].decode("utf-8"))
        self.assertEqual(rpc["method"], "tools/call")
        self.assertEqual(rpc["params"], {"name": "get_country_risk", "arguments": {"country_code": "IR"}})
        self.assertEqual(timeout, client.timeout)

    def test_arguments_dict_merges_with_kwargs(self):
        transport = FakeTransport([rpc_result({})])
        Client(env={}, transport=transport).call_tool("t", {"a": 1}, b=2)
        rpc = json.loads(transport.requests[0][0]["body"].decode("utf-8"))
        self.assertEqual(rpc["params"]["arguments"], {"a": 1, "b": 2})

    def test_curated_helper_maps_to_tool(self):
        transport = FakeTransport([rpc_result({})])
        Client(env={}, transport=transport).country_risk("IR", jmespath="scores")
        rpc = json.loads(transport.requests[0][0]["body"].decode("utf-8"))
        self.assertEqual(rpc["params"]["name"], "get_country_risk")
        self.assertEqual(rpc["params"]["arguments"], {"country_code": "IR", "jmespath": "scores"})

    def test_list_tools_is_keyless(self):
        transport = FakeTransport([rpc_result({"tools": []})])
        result = Client(env={}, transport=transport).list_tools()
        self.assertEqual(result, {"tools": []})
        request, _ = transport.requests[0]
        self.assertNotIn(EXPECTED_API_KEY_HEADER, request["headers"])
        rpc = json.loads(request["body"].decode("utf-8"))
        self.assertEqual(rpc["method"], "tools/list")
        self.assertNotIn("params", rpc)

    def test_get_sources_is_keyless(self):
        transport = FakeTransport([rpc_result({"sources": []})])
        result = Client(env={}, transport=transport).call_tool("get_sources", view="summary")
        self.assertEqual(result, {"sources": []})
        request, _ = transport.requests[0]
        self.assertNotIn(EXPECTED_API_KEY_HEADER, request["headers"])
        rpc = json.loads(request["body"].decode("utf-8"))
        self.assertEqual(rpc["params"], {"name": "get_sources", "arguments": {"view": "summary"}})

    def test_mcp_error_raises_with_auth_hint(self):
        transport = FakeTransport(
            [json_response({"jsonrpc": "2.0", "id": 1, "error": {"code": MCP_AUTH_ERROR_CODE, "message": "auth required"}})]
        )
        with self.assertRaises(MCPError) as ctx:
            Client(env={}, transport=transport).world_brief()
        self.assertEqual(ctx.exception.code, MCP_AUTH_ERROR_CODE)
        self.assertIn("WORLDMONITOR_API_KEY", str(ctx.exception))

    def test_mcp_error_wins_over_http_200(self):
        transport = FakeTransport(
            [json_response({"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "bad params"}}, status=200)]
        )
        with self.assertRaises(MCPError):
            Client(env={}, transport=transport).call_tool("t")

    def test_sse_mcp_response_is_unwrapped(self):
        body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n'
        transport = FakeTransport([(200, "text/event-stream", body)])
        self.assertEqual(Client(env={}, transport=transport).call_tool("t"), {"n": 1})


class TestRest(unittest.TestCase):
    def test_get_builds_query_and_parses(self):
        transport = FakeTransport([json_response({"status": "ok"})])
        client = Client(api_key=EXAMPLE_CLIENT_VALUE, env={}, transport=transport)
        self.assertEqual(client.get("/api/health", verbose=True), {"status": "ok"})
        request, _ = transport.requests[0]
        self.assertEqual(request["url"], DEFAULT_BASE_URL + "/api/health?verbose=true")
        self.assertEqual(request["headers"][EXPECTED_API_KEY_HEADER], EXAMPLE_CLIENT_VALUE)

    def test_get_requires_host_relative_path(self):
        with self.assertRaises(ValueError):
            Client(env={}, transport=FakeTransport([])).get("api/health")

    def test_non_2xx_raises_api_error(self):
        transport = FakeTransport([json_response({"error": "unauthorized"}, status=401)])
        with self.assertRaises(APIError) as ctx:
            Client(env={}, transport=transport).health()
        self.assertEqual(ctx.exception.status, 401)
        self.assertIn("WORLDMONITOR_API_KEY", str(ctx.exception))

class TestDefaultTransportRedirects(unittest.TestCase):
    def _serve(self, handler):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return "http://127.0.0.1:%d" % server.server_address[1]

    def test_redirects_are_not_followed(self):
        leaked = []

        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                leaked.append(self.headers.get(EXPECTED_API_KEY_HEADER))
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            do_POST = do_GET

            def log_message(self, *args):
                pass

        target_url = self._serve(Target)

        class Origin(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("location", target_url + "/redirected")
                self.send_header("content-length", "0")
                self.end_headers()

            do_POST = do_GET

            def log_message(self, *args):
                pass

        origin_url = self._serve(Origin)
        client = Client(
            api_key=EXAMPLE_CLIENT_VALUE,
            base_url=origin_url,
            mcp_url=origin_url + "/mcp",
            env={},
        )
        for call in (client.health, client.list_tools):
            with self.assertRaises(APIError) as ctx:
                call()
            self.assertEqual(ctx.exception.status, 302)
        self.assertEqual(leaked, [])

    def test_proxy_env_set_after_import_is_honoured(self):
        seen = []

        class Proxy(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        proxy_url = self._serve(Proxy)
        cleared = {k: "" for k in os.environ if k.lower().endswith("_proxy")}
        with mock.patch.dict(os.environ, {**cleared, "http_proxy": proxy_url, "no_proxy": ""}):
            Client(base_url="http://wm.invalid", env={}).health()
        self.assertEqual(seen, ["http://wm.invalid/api/health"])


if __name__ == "__main__":
    unittest.main()
