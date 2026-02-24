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
SEBUF_VERSION := v0.7.0

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
	cd $(PROTO_DIR) && buf generate
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
