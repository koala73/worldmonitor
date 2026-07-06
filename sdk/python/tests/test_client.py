"""Offline tests for the worldmonitor-sdk client (fake transport, no network)."""

import json
import sys
import unittest
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
        env = {"WORLDMONITOR_API_KEY": "wm_env", "WORLDMONITOR_BASE_URL": "https://self.example/"}
        client = Client(env=env, transport=FakeTransport([]))
        self.assertEqual(client.api_key, "wm_env")
        self.assertEqual(client.base_url, "https://self.example")
        self.assertEqual(client.mcp_url, DEFAULT_MCP_URL)

    def test_explicit_args_beat_env(self):
        env = {"WM_API_KEY": "wm_env"}
        client = Client(api_key="wm_arg", env=env, transport=FakeTransport([]))
        self.assertEqual(client.api_key, "wm_arg")

    def test_defaults_without_env(self):
        client = Client(env={}, transport=FakeTransport([]))
        self.assertIsNone(client.api_key)
        self.assertEqual(client.base_url, DEFAULT_BASE_URL)

    def test_user_agent_carries_version(self):
        self.assertIn(__version__, USER_AGENT)
        self.assertTrue(USER_AGENT.startswith("worldmonitor-python/"))
        self.assertIn("+https://worldmonitor.app", USER_AGENT)


class TestMCPCalls(unittest.TestCase):
    def test_call_tool_builds_json_rpc_and_unwraps_result(self):
        transport = FakeTransport([rpc_result({"ok": True})])
        client = Client(api_key="wm_k", env={}, transport=transport)
        result = client.call_tool("get_country_risk", country_code="IR")
        self.assertEqual(result, {"ok": True})

        request, timeout = transport.requests[0]
        self.assertEqual(request["url"], DEFAULT_MCP_URL)
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["headers"][API_KEY_HEADER], "wm_k")
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
        self.assertNotIn(API_KEY_HEADER, request["headers"])
        rpc = json.loads(request["body"].decode("utf-8"))
        self.assertEqual(rpc["method"], "tools/list")
        self.assertNotIn("params", rpc)

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
        client = Client(api_key="wm_k", env={}, transport=transport)
        self.assertEqual(client.get("/api/health", verbose=True), {"status": "ok"})
        request, _ = transport.requests[0]
        self.assertEqual(request["url"], DEFAULT_BASE_URL + "/api/health?verbose=true")
        self.assertEqual(request["headers"][API_KEY_HEADER], "wm_k")

    def test_get_requires_host_relative_path(self):
        with self.assertRaises(ValueError):
            Client(env={}, transport=FakeTransport([])).get("api/health")

    def test_non_2xx_raises_api_error(self):
        transport = FakeTransport([json_response({"error": "unauthorized"}, status=401)])
        with self.assertRaises(APIError) as ctx:
            Client(env={}, transport=transport).health()
        self.assertEqual(ctx.exception.status, 401)
        self.assertIn("WORLDMONITOR_API_KEY", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
