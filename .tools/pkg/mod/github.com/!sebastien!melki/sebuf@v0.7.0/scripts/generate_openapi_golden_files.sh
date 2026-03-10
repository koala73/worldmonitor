#!/bin/bash

# Script to generate golden files for OpenAPI v3 plugin testing
# This script generates both YAML and JSON golden files from all proto files

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Build the plugin
echo "Building protoc-gen-openapiv3 plugin..."
cd "$ROOT_DIR"
go build -o protoc-gen-openapiv3-golden ./cmd/protoc-gen-openapiv3

# Set up paths
PLUGIN_PATH="$ROOT_DIR/protoc-gen-openapiv3-golden"
PROTO_DIR="$ROOT_DIR/internal/openapiv3/testdata/proto"
GOLDEN_YAML_DIR="$ROOT_DIR/internal/openapiv3/testdata/golden/yaml"
GOLDEN_JSON_DIR="$ROOT_DIR/internal/openapiv3/testdata/golden/json"

# Create golden directories if they don't exist
mkdir -p "$GOLDEN_YAML_DIR"
mkdir -p "$GOLDEN_JSON_DIR"

# List of proto files to process
PROTO_FILES=(
    "simple_service.proto"
    "multiple_services.proto"
    "complex_types.proto"
    "nested_messages.proto"
    "headers.proto"
    "validation_constraints.proto"
    "http_annotations.proto"
    "no_services.proto"
)

echo "Generating golden files..."

for proto_file in "${PROTO_FILES[@]}"; do
    base_name=$(basename "$proto_file" .proto)
    
    echo "Processing $proto_file..."
    
    # Generate YAML version
    echo "  -> Generating YAML..."
    protoc \
        --plugin=protoc-gen-openapiv3="$PLUGIN_PATH" \
        --openapiv3_out="$GOLDEN_YAML_DIR" \
        --openapiv3_opt=format=yaml \
        --proto_path="$PROTO_DIR" \
        --proto_path="$ROOT_DIR/proto" \
        "$PROTO_DIR/$proto_file" || echo "    Warning: Failed to generate YAML for $proto_file"
    
    # Generate JSON version
    echo "  -> Generating JSON..."
    protoc \
        --plugin=protoc-gen-openapiv3="$PLUGIN_PATH" \
        --openapiv3_out="$GOLDEN_JSON_DIR" \
        --openapiv3_opt=format=json \
        --proto_path="$PROTO_DIR" \
        --proto_path="$ROOT_DIR/proto" \
        "$PROTO_DIR/$proto_file" || echo "    Warning: Failed to generate JSON for $proto_file"
done

echo ""
echo "Golden file generation complete!"
echo ""
echo "Generated files:"
echo "YAML files:"
ls -la "$GOLDEN_YAML_DIR"/*.yaml 2>/dev/null || echo "  No YAML files generated"
echo ""
echo "JSON files:"
ls -la "$GOLDEN_JSON_DIR"/*.json 2>/dev/null || echo "  No JSON files generated"

# Clean up
rm -f "$PLUGIN_PATH"

echo ""
echo "Done! Golden files are ready for testing."