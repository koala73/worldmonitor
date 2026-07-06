# frozen_string_literal: true

# Official Ruby SDK for the World Monitor global-intelligence API.
#
# Stdlib-only (Net::HTTP), MCP-first — the same design as the `worldmonitor`
# npm CLI this mirrors (`cli/` in the main repository). The MCP server
# (https://worldmonitor.app/mcp) is the live, documented agent surface:
# `tools/list` is public, and `tools/call` (used by the curated helpers)
# authenticates with a user API key. A small REST escape hatch
# (`get`/`health`) rounds it out for host-relative and self-hosted use.
#
#   client = WorldMonitor::Client.new(api_key: "wm_...")
#   client.country_risk("IR")
#   client.call_tool("get_market_data", asset_class: "crypto")
#   client.get("/api/health")
#
# Every tool accepts an optional `jmespath` argument for server-side
# projection (typically an 80-95% response-size cut), e.g.
# `client.world_brief(jmespath: "hotspots[].name")`.

require "json"
require "net/http"
require "uri"

require_relative "worldmonitor/version"

module WorldMonitor
  # Cloudflare's WAF challenges generic library User-Agents (Ruby, curl,
  # empty) on the API edge, so we always identify ourselves.
  USER_AGENT = "worldmonitor-ruby/#{VERSION} (+https://worldmonitor.app)"

  DEFAULT_BASE_URL = "https://api.worldmonitor.app"
  DEFAULT_MCP_URL = "https://worldmonitor.app/mcp"

  # Header the API accepts for a user-issued key (alias: X-Api-Key).
  API_KEY_HEADER = "X-WorldMonitor-Key"

  # JSON-RPC error code the MCP server returns when a call needs authentication.
  MCP_AUTH_ERROR_CODE = -32_001

  AUTH_HINT = "Hint: this call needs a key - pass api_key: or set " \
              "WORLDMONITOR_API_KEY (get one at https://worldmonitor.app/pro)."

  DEFAULT_TIMEOUT = 30

  # Base class for every error raised by this SDK.
  class Error < StandardError; end

  # A REST or transport-level failure (non-2xx HTTP response).
  class APIError < Error
    attr_reader :status, :body

    def initialize(status, body)
      @status = status
      @body = body
      hint = status == 401 ? " #{AUTH_HINT}" : ""
      super("HTTP #{status}: #{Client.truncate(body)}#{hint}")
    end
  end

  # A JSON-RPC `error` returned by the MCP server.
  class MCPError < Error
    attr_reader :code, :data

    def initialize(code, message, data = nil)
      @code = code
      @data = data
      hint = code == MCP_AUTH_ERROR_CODE ? " #{AUTH_HINT}" : ""
      super("MCP error #{code}: #{message}#{hint}")
    end
  end

  # Thin client for the World Monitor MCP server and REST API.
  #
  # All keyword arguments are optional; unset values fall back to the
  # WORLDMONITOR_API_KEY (or WM_API_KEY), WORLDMONITOR_BASE_URL, and
  # WORLDMONITOR_MCP_URL environment variables, then to the public production
  # endpoints. `transport` is injectable for offline tests: a callable
  # `(request_hash, timeout) -> [status, content_type, body]`.
  class Client
    attr_reader :api_key, :base_url, :mcp_url, :timeout

    def initialize(api_key: nil, base_url: nil, mcp_url: nil,
                   timeout: DEFAULT_TIMEOUT, transport: nil, env: ENV)
      @api_key = api_key || env["WORLDMONITOR_API_KEY"] || env["WM_API_KEY"]
      @base_url = (base_url || env["WORLDMONITOR_BASE_URL"] || DEFAULT_BASE_URL).sub(%r{/+\z}, "")
      @mcp_url = mcp_url || env["WORLDMONITOR_MCP_URL"] || DEFAULT_MCP_URL
      @timeout = timeout
      @transport = transport || method(:http_transport)
    end

    # -- low-level surfaces --------------------------------------------------

    # Call an MCP tool by name and return the unwrapped JSON-RPC result.
    # Keyword arguments become the tool's arguments:
    #   call_tool("get_country_risk", country_code: "IR")
    def call_tool(name, arguments = {})
      rpc("tools/call", { "name" => name, "arguments" => stringify_keys(arguments) })
    end

    # List every MCP tool (public - no key needed).
    def list_tools
      rpc("tools/list")
    end

    # List MCP prompt templates (public).
    def list_prompts
      rpc("prompts/list")
    end

    # List MCP resources (public).
    def list_resources
      rpc("resources/list")
    end

    # GET a raw REST path (host-relative, e.g. "/api/health").
    def get(path, params = {})
      raise ArgumentError, "get() needs a host-relative API path starting with '/'" unless path.start_with?("/")

      url = base_url + path
      query = stringify_keys(params)
      url += "?#{URI.encode_www_form(query.map { |k, v| [k, stringify_value(v)] })}" unless query.empty?
      status, content_type, body = @transport.call(
        { url: url, method: "GET", headers: headers(accept: "application/json") },
        timeout
      )
      value = self.class.parse_body(body, content_type)
      raise APIError.new(status, value) unless (200..299).cover?(status)

      value
    end

    # API status / health check.
    def health
      get("/api/health")
    end

    # -- curated helpers over the highest-traffic MCP tools -------------------
    # Every other tool is reachable via call_tool(), so this table stays small
    # and mirrors the npm CLI's curated commands one-to-one.

    # Live global situation brief.
    def world_brief(args = {})
      call_tool("get_world_brief", args)
    end

    # AI strategic brief for a country (ISO 3166-1 alpha-2 code).
    def country_brief(country_code, args = {})
      call_tool("get_country_brief", args.merge(country_code: country_code))
    end

    # Country risk / resilience scores (ISO 3166-1 alpha-2 code).
    def country_risk(country_code, args = {})
      call_tool("get_country_risk", args.merge(country_code: country_code))
    end

    # Equities, commodities, crypto and FX quotes.
    def market_data(args = {})
      call_tool("get_market_data", args)
    end

    # Recent conflict events (country:, min_fatalities:, limit: ...).
    def conflict_events(args = {})
      call_tool("get_conflict_events", args)
    end

    # Cyber-threat indicators (min_severity:, threat_type:, country: ...).
    def cyber_threats(args = {})
      call_tool("get_cyber_threats", args)
    end

    # Classified news intelligence (topic:, country:, alerts_only: ...).
    def news_intelligence(args = {})
      call_tool("get_news_intelligence", args)
    end

    # Earthquakes, fires and storms (dataset:, active_only:, min_magnitude: ...).
    def natural_disasters(args = {})
      call_tool("get_natural_disasters", args)
    end

    # Sanctions designations (country:, entity_type:, query: ...).
    def sanctions_data(args = {})
      call_tool("get_sanctions_data", args)
    end

    # Scenario forecasts (domain:, region: ...).
    def forecast_predictions(args = {})
      call_tool("get_forecast_predictions", args)
    end

    # Maritime / port activity for a country (ISO 3166-1 alpha-2 code).
    def maritime_activity(country_code, args = {})
      call_tool("get_maritime_activity", args.merge(country_code: country_code))
    end

    # -- body decoding (exposed for tests) ------------------------------------

    # Decode an MCP/REST response body. MCP responses may arrive as
    # Server-Sent Events (Streamable HTTP): pull the last `data:` payload.
    # Otherwise parse the whole body as JSON, falling back to the raw text.
    def self.parse_body(text, content_type = "")
      payload = text
      if (content_type || "").include?("text/event-stream") || text =~ /^(event|data):/
        data_lines = text.split(/\r?\n/).select { |l| l.start_with?("data:") }
        payload = data_lines.empty? ? "" : data_lines.last[5..-1].strip
      end
      return text if payload.nil? || payload.empty?

      begin
        JSON.parse(payload)
      rescue JSON::ParserError
        text
      end
    end

    def self.truncate(value, limit = 300)
      text = value.is_a?(String) ? value : JSON.generate(value)
      text.length <= limit ? text : "#{text[0, limit - 1]}…"
    end

    private

    def headers(accept:)
      h = { "user-agent" => USER_AGENT, "accept" => accept }
      h[API_KEY_HEADER] = api_key if api_key
      h
    end

    def rpc(method, params = nil)
      body = { "jsonrpc" => "2.0", "id" => 1, "method" => method }
      body["params"] = params if params
      request_headers = headers(accept: "application/json, text/event-stream")
      request_headers["content-type"] = "application/json"
      status, content_type, text = @transport.call(
        { url: mcp_url, method: "POST", headers: request_headers, body: JSON.generate(body) },
        timeout
      )
      value = self.class.parse_body(text, content_type)
      # A JSON-RPC error object wins over the HTTP status (the server pairs
      # auth errors with a 200 on some transports).
      if value.is_a?(Hash) && value["error"].is_a?(Hash)
        err = value["error"]
        raise MCPError.new(err["code"] || 0, err["message"] || "", err["data"])
      end
      raise APIError.new(status, value) unless (200..299).cover?(status)

      value.is_a?(Hash) && value.key?("result") ? value["result"] : value
    end

    def http_transport(request, timeout)
      uri = URI.parse(request[:url])
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = timeout
      http.read_timeout = timeout
      klass = request[:method] == "POST" ? Net::HTTP::Post : Net::HTTP::Get
      req = klass.new(uri.request_uri)
      (request[:headers] || {}).each { |k, v| req[k] = v }
      req.body = request[:body] if request[:body]
      res = http.request(req)
      [res.code.to_i, res["content-type"].to_s, res.body.to_s]
    end

    def stringify_keys(hash)
      hash.each_with_object({}) { |(k, v), out| out[k.to_s] = v }
    end

    def stringify_value(value)
      return "true" if value == true
      return "false" if value == false

      value.to_s
    end
  end
end
