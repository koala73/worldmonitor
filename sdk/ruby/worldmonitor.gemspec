# frozen_string_literal: true

require_relative "lib/worldmonitor/version"

Gem::Specification.new do |spec|
  spec.name = "worldmonitor"
  spec.version = WorldMonitor::VERSION
  spec.summary = "Official Ruby SDK for the World Monitor global-intelligence API"
  spec.description = "Country briefs, risk scores, conflict/cyber/market/news feeds, and MCP tools " \
                     "from the World Monitor global-intelligence API without writing an HTTP " \
                     "integration. Stdlib-only (Net::HTTP), MCP-first — the same design as the " \
                     "official worldmonitor npm CLI."
  spec.authors = ["World Monitor"]
  spec.license = "MIT"

  # The homepage is how agents (and agent-readiness scanners) verify this gem
  # is the product's official SDK — keep it on the product domain.
  spec.homepage = "https://worldmonitor.app"
  spec.metadata = {
    "homepage_uri" => "https://worldmonitor.app",
    "documentation_uri" => "https://www.worldmonitor.app/docs/sdks",
    "source_code_uri" => "https://github.com/koala73/worldmonitor/tree/main/sdk/ruby",
    "bug_tracker_uri" => "https://github.com/koala73/worldmonitor/issues",
    "rubygems_mfa_required" => "true",
  }

  spec.files = Dir["lib/**/*.rb"] + ["README.md", "LICENSE"]
  spec.require_paths = ["lib"]
  spec.required_ruby_version = ">= 2.6"
end
