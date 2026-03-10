.PHONY: demo generate server client clean install-deps build-plugins

# Full demo: generate code, start TS server, run TS client, stop server
# Server output is visible (not silenced) — you'll see both server + client logs
demo: generate install-deps
	@echo ""
	@echo "Starting server..."
	@cd server && npx tsx main.ts & SERVER_PID=$$!; \
	echo "Waiting for server to be ready..."; \
	for i in $$(seq 1 30); do \
		if curl -s -o /dev/null http://localhost:3000/api/v1/notes -H "X-API-Key: 550e8400-e29b-41d4-a716-446655440000" -H "X-Tenant-ID: 1" 2>/dev/null; then \
			break; \
		fi; \
		sleep 1; \
	done; \
	echo ""; \
	echo "Running client..."; \
	echo ""; \
	cd client && npx tsx main.ts; \
	EXIT_CODE=$$?; \
	echo ""; \
	echo "Stopping server (PID $$SERVER_PID)..."; \
	kill $$SERVER_PID 2>/dev/null; \
	exit $$EXIT_CODE

# Build the protoc plugin binaries
build-plugins:
	@echo "Building protoc plugins..."
	@cd ../.. && make build

# Generate TypeScript server + client code from proto
generate: build-plugins
	@echo "Fetching buf dependencies..."
	@buf dep update
	@echo "Generating code..."
	@buf generate
	@echo "Code generated successfully"

# Run the TypeScript server in foreground (use this + 'make client' in another terminal)
server: generate install-deps
	@cd server && npx tsx main.ts

# Install TypeScript dependencies for both server and client
install-deps:
	@echo "Installing server dependencies..."
	@cd server && npm install --silent
	@echo "Installing client dependencies..."
	@cd client && npm install --silent

# Run just the TypeScript client (assumes server is running)
client: install-deps
	@cd client && npx tsx main.ts

# Clean generated files
clean:
	@rm -rf server/generated/ server/node_modules/ server/dist/
	@rm -rf client/generated/ client/node_modules/ client/dist/
	@echo "Cleaned generated files"
