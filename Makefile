.PHONY: help lint generate breaking format check clean deps install install-buf install-plugins install-npm install-playwright
.DEFAULT_GOAL := help

# Variables
PROTO_DIR := proto
GEN_CLIENT_DIR := src/generated/client
GEN_SERVER_DIR := src/generated/server
DOCS_API_DIR := docs/api

# Go install settings
GO_PROXY := GOPROXY=direct
GO_PRIVATE := GOPRIVATE=github.com/SebastienMelki
GO_INSTALL := $(GO_PROXY) $(GO_PRIVATE) go install

# Required tool versions
BUF_VERSION := v1.64.0
SEBUF_VERSION := v0.11.1

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: install-buf install-plugins install-npm install-playwright deps ## Install everything (buf, sebuf plugins, npm deps, proto deps, browsers)

install-buf: ## Install buf CLI
	@if command -v buf >/dev/null 2>&1; then \
		echo "buf already installed: $$(buf --version)"; \
	else \
		echo "Installing buf..."; \
		$(GO_INSTALL) github.com/bufbuild/buf/cmd/buf@$(BUF_VERSION); \
		echo "buf installed!"; \
	fi

install-plugins: ## Install sebuf protoc plugins (requires Go)
	@echo "Installing sebuf protoc plugins $(SEBUF_VERSION)..."
	@$(GO_INSTALL) github.com/SebastienMelki/sebuf/cmd/protoc-gen-ts-client@$(SEBUF_VERSION)
	@$(GO_INSTALL) github.com/SebastienMelki/sebuf/cmd/protoc-gen-ts-server@$(SEBUF_VERSION)
	@$(GO_INSTALL) github.com/SebastienMelki/sebuf/cmd/protoc-gen-openapiv3@$(SEBUF_VERSION)
	@echo "Plugins installed!"

install-npm: ## Install npm dependencies
	npm install

install-playwright: ## Install Playwright browsers for e2e tests
	npx playwright install chromium

deps: ## Install/update buf proto dependencies
	cd $(PROTO_DIR) && buf dep update

lint: ## Lint protobuf files
	cd $(PROTO_DIR) && buf lint

generate: clean ## Generate code from proto definitions
	@mkdir -p $(GEN_CLIENT_DIR) $(GEN_SERVER_DIR) $(DOCS_API_DIR)
	@# Ensure the Makefile-declared sebuf protoc plugins ($(SEBUF_VERSION))
	@# installed by `install-plugins` win over any stale sebuf binary that
	@# a package manager (Homebrew, etc.) may have placed earlier on PATH.
	@# Without this, `buf generate` spawns an older sebuf v0.7.x plugin
	@# that ignores `bundle_only=true` / `format=json` and fails with
	@# duplicate-output errors.
	@#
	@# Two-stage resolution:
	@#
	@#  1. Resolve `buf` using the CALLER's PATH so we pick up whatever
	@#     `buf` version was installed via Homebrew / go install / etc. —
	@#     whichever the developer actually runs day-to-day. We do NOT
	@#     want the Go install dir to override the buf binary itself; an
	@#     earlier version of this Makefile did, which could silently
	@#     downgrade `buf` on machines with a stale GOBIN copy.
	@#
	@#  2. Invoke the resolved `buf` via absolute path, but give it a
	@#     PATH whose FIRST entry is the Go install dir. This affects
	@#     only plugin lookup inside `buf generate` (protoc-gen-ts-*,
	@#     protoc-gen-openapiv3) — not `buf` itself, which is already
	@#     resolved. Plugins find the Makefile-pinned version first.
	@#
	@# Go install dir resolution mirrors `go install`'s own logic:
	@# GOBIN first, then the FIRST entry of GOPATH + "/bin". `go install`
	@# writes binaries only into the first GOPATH entry's bin dir — GOPATH
	@# can be a path-list (colon-separated on Unix, semicolon on Windows),
	@# so naïvely appending "/bin" to the whole value produces a bogus
	@# path. The `cut -d:` fallback works on Linux/macOS shells; Windows
	@# (MSYS/cmd) is not a supported dev platform for this repo, so the
	@# Unix assumption is acceptable here.
	@#
	@# .husky/pre-push still prepends $$HOME/go/bin for the outer shell
	@# discovering `buf` — that's a broader prepend (it affects the shell's
	@# command resolution before `make` runs) and is harmless here because
	@# this recipe resolves `buf` via its own PATH before building the
	@# plugin PATH.
	@command -v go  >/dev/null 2>&1 || { echo 'go not found on PATH — make generate needs `go` to resolve the sebuf plugin install dir. Install Go, then run: make install-plugins' >&2; exit 1; }
	@command -v buf >/dev/null 2>&1 || { echo 'buf not found on PATH — run: make install-buf' >&2; exit 1; }
	@# All plugin-resolution, plugin-presence, and invocation in a single
	@# shell line chained with `&&` so any failed guard aborts the recipe
	@# BEFORE `buf generate` runs. `$$(go env GOBIN)` without -n guard
	@# would silently become "/bin" when unset, failing to override PATH
	@# and letting a stale sebuf on the normal PATH win — the exact
	@# failure mode this PR is trying to prevent (Codex high-severity on
	@# 9c0058a). The plugin-executable check covers ALL three sebuf
	@# binaries invoked by proto/buf.gen.yaml (protoc-gen-ts-client,
	@# protoc-gen-ts-server, protoc-gen-openapiv3) — guarding only one
	@# would let `buf generate` fall through to a stale copy of the
	@# others on PATH, recreating the mixed-version failure mode. Keep
	@# this list in sync with proto/buf.gen.yaml.
	cd $(PROTO_DIR) && \
		PLUGIN_DIR=$$(gobin=$$(go env GOBIN); if [ -n "$$gobin" ]; then printf '%s' "$$gobin"; else printf '%s/bin' "$$(go env GOPATH | cut -d: -f1)"; fi) && \
		[ -n "$$PLUGIN_DIR" ] || { echo 'Could not resolve Go install dir from GOBIN/GOPATH — refusing to run buf generate without a pinned plugin location.' >&2; exit 1; } && \
		for p in protoc-gen-ts-client protoc-gen-ts-server protoc-gen-openapiv3; do \
			[ -x "$$PLUGIN_DIR/$$p" ] || { echo "$$p not found at $$PLUGIN_DIR/. Run: make install-plugins" >&2; exit 1; }; \
		done && \
		BUF_BIN=$$(command -v buf) && \
		PATH="$$PLUGIN_DIR:$$PATH" "$$BUF_BIN" generate
	@echo "Code generation complete!"

breaking: ## Check for breaking changes against main
	cd $(PROTO_DIR) && buf breaking --against '.git#branch=main,subdir=proto'

format: ## Format protobuf files
	cd $(PROTO_DIR) && buf format -w

check: lint generate ## Run all checks (lint + generate)

clean: ## Clean generated files
	@rm -rf $(GEN_CLIENT_DIR)
	@rm -rf $(GEN_SERVER_DIR)
	@rm -rf $(DOCS_API_DIR)
	@echo "Clean complete!"
