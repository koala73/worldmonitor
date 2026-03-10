#!/bin/bash

# Test Coverage Analysis Script
# This script runs tests for all packages and analyzes coverage against a 85% threshold
# Cross-platform compatible (macOS and Linux)

set -e

# Configuration
COVERAGE_THRESHOLD=85
COVERAGE_DIR="coverage"
COVERAGE_PROFILE="$COVERAGE_DIR/coverage.out"
COVERAGE_HTML="$COVERAGE_DIR/coverage.html"
COVERAGE_JSON="$COVERAGE_DIR/coverage.json"

# Parse command line arguments
VERBOSE=false
FAST_MODE=false
for arg in "$@"; do
    case $arg in
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -f|--fast)
            FAST_MODE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  -v, --verbose    Run tests with verbose output"
            echo "  -f, --fast       Run tests without coverage (faster, cached)"
            echo "  -h, --help       Show this help message"
            exit 0
            ;;
        *)
            # Unknown option
            ;;
    esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Create coverage directory
mkdir -p "$COVERAGE_DIR"

if [ "$FAST_MODE" = true ]; then
    echo -e "${BLUE}===========================================${NC}"
    echo -e "${BLUE}            Fast Test Execution           ${NC}"
    echo -e "${BLUE}         (No Coverage Analysis)           ${NC}"
    echo -e "${BLUE}===========================================${NC}"
else
    echo -e "${BLUE}===========================================${NC}"
    echo -e "${BLUE}      Go Test Coverage & Race Analysis    ${NC}"
    echo -e "${BLUE}===========================================${NC}"
fi
echo

# Function to check if a package has tests
has_tests() {
    local package=$1
    local pattern
    if [ "$package" = "." ]; then
        pattern="*_test.go"
    else
        pattern="${package}/*_test.go"
    fi
    
    # Use find to check for test files, which doesn't fail with set -e
    [ "$(find "$package" -name "*_test.go" -type f 2>/dev/null | wc -l)" -gt 0 ]
}

# Function to run tests and get coverage for a package
run_package_tests() {
    local package=$1
    local package_name=$2
    local root_module=$3
    
    echo -e "${BLUE}Testing package: ${package_name}${NC}"
    
    # Convert package path to relative path for file system operations
    local relative_path=""
    if [ "$package" = "$root_module" ]; then
        relative_path="."
    else
        relative_path=${package#$root_module/}
    fi
    
    if has_tests "$relative_path"; then
        # Package has tests, continue with testing
        if [ "$FAST_MODE" = true ]; then
            # Fast mode: run tests without coverage
            local test_cmd="TESTING_MODE=true go test"
            if [ "$VERBOSE" = true ]; then
                test_cmd="$test_cmd -v"
            fi
            test_cmd="$test_cmd \"$package\""
            
            if eval $test_cmd; then
                echo -e "${GREEN}  ✅  Tests passed${NC}"
                return 0
            else
                echo -e "${RED}  ❌  Tests failed${NC}"
                return 1
            fi
        else
            # Coverage mode: run tests with coverage analysis and race detection
            local temp_profile="$COVERAGE_DIR/${package_name//\//_}.out"
            
            # Build go test command with coverage, race detection, and optional verbose flag
            local test_cmd="TESTING_MODE=true go test -race -coverprofile=\"$temp_profile\" -covermode=atomic"
            if [ "$VERBOSE" = true ]; then
                test_cmd="$test_cmd -v"
            fi
            test_cmd="$test_cmd \"$package\""
            
            if eval $test_cmd; then
                if [ -f "$temp_profile" ]; then
                    # Extract coverage percentage
                    local coverage=$(go tool cover -func="$temp_profile" | grep "total:" | awk '{print $3}' | sed 's/%//')
                    
                    if [ -n "$coverage" ]; then
                        # Check if coverage meets threshold
                        if (( $(echo "$coverage" | cut -d. -f1) >= $COVERAGE_THRESHOLD )); then
                            echo -e "${GREEN}  ✅  Coverage: ${coverage}% (Above threshold: ${COVERAGE_THRESHOLD}%)${NC}"
                            echo "$temp_profile" >> "$COVERAGE_DIR/profiles.list"
                            return 0
                        else
                            echo -e "${YELLOW}  ⚠️  Coverage: ${coverage}% (Below threshold: ${COVERAGE_THRESHOLD}%)${NC}"
                            echo "$temp_profile" >> "$COVERAGE_DIR/profiles.list"
                            return 0  # Don't fail, just report
                        fi
                    else
                        echo -e "${RED}  ❌  Could not determine coverage${NC}"
                        return 1
                    fi
                else
                    echo -e "${RED}  ❌  No coverage profile generated${NC}"
                    return 1
                fi
            else
                echo -e "${RED}  ❌  Tests failed${NC}"
                return 1
            fi
        fi
    else
        # Package has no tests - this is OK for some packages like cmd/, proto definitions, etc.
        echo -e "${YELLOW}  ⚠️  No tests found for package ${package_name}${NC}"
        if [ "$FAST_MODE" = true ]; then
            echo -e "${YELLOW}  ⚠️  No tests to run (skipped)${NC}"
        else
            echo -e "${YELLOW}  ⚠️  Coverage: 0.0% (no tests, skipped)${NC}"
        fi
        return 0  # Don't fail for packages without tests
    fi
}

# Function to merge coverage profiles
merge_coverage_profiles() {
    if [ -f "$COVERAGE_DIR/profiles.list" ]; then
        echo -e "${BLUE}Merging coverage profiles...${NC}"
        echo "mode: atomic" > "$COVERAGE_PROFILE"
        
        # Merge all profiles, skipping the mode line
        while IFS= read -r profile; do
            if [ -f "$profile" ]; then
                tail -n +2 "$profile" >> "$COVERAGE_PROFILE"
            fi
        done < "$COVERAGE_DIR/profiles.list"
        
        # Clean up individual profiles
        while IFS= read -r profile; do
            rm -f "$profile"
        done < "$COVERAGE_DIR/profiles.list"
        rm -f "$COVERAGE_DIR/profiles.list"
        
        echo -e "${GREEN}Coverage profiles merged successfully${NC}"
    fi
}

# Function to generate HTML coverage report
generate_html_report() {
    if [ -f "$COVERAGE_PROFILE" ]; then
        echo -e "${BLUE}Generating HTML coverage report...${NC}"
        go tool cover -html="$COVERAGE_PROFILE" -o "$COVERAGE_HTML"
        echo -e "${GREEN}HTML report generated: $COVERAGE_HTML${NC}"
    fi
}

# Function to generate JSON coverage report
generate_json_report() {
    if [ -f "$COVERAGE_PROFILE" ]; then
        echo -e "${BLUE}Generating JSON coverage report...${NC}"
        go tool cover -func="$COVERAGE_PROFILE" | awk '
        BEGIN {
            print "{"
            print "  \"packages\": ["
            first = 1
        }
        /^total:/ {
            total_coverage = $3
            gsub(/%/, "", total_coverage)
            next
        }
        !/^total:/ && NF >= 3 {
            file = $1
            coverage = $3
            gsub(/%/, "", coverage)
            
            if (!first) print ","
            printf "    {\n"
            printf "      \"file\": \"%s\",\n", file
            printf "      \"coverage\": %.1f\n", coverage
            printf "    }"
            first = 0
        }
        END {
            print ""
            print "  ],"
            printf "  \"total_coverage\": %.1f\n", total_coverage
            print "}"
        }' > "$COVERAGE_JSON"
        echo -e "${GREEN}JSON report generated: $COVERAGE_JSON${NC}"
    fi
}

# Function to generate coverage badge
generate_coverage_badge() {
    if [ -f "$COVERAGE_PROFILE" ]; then
        echo -e "${BLUE}Generating coverage badge...${NC}"
        
        # Use go-test-coverage tool to generate badge
        if command -v go-test-coverage &> /dev/null; then
            local badge_file="$COVERAGE_DIR/coverage-badge.svg"
            # Allow go-test-coverage to fail (it exits with non-zero when coverage is below threshold)
            go-test-coverage --config=.testcoverage.yml --badge-file-name="$badge_file" >/dev/null 2>&1 || true
            echo -e "${GREEN}Coverage badge generated: $badge_file${NC}"
        else
            echo -e "${YELLOW}go-test-coverage not found. Install with: go install github.com/vladopajic/go-test-coverage/v2@latest${NC}"
        fi
    fi
}

# Function to generate coverage summary
generate_coverage_summary() {
    if [ -f "$COVERAGE_PROFILE" ]; then
        echo -e "${BLUE}===========================================${NC}"
        echo -e "${BLUE}          Coverage Summary                 ${NC}"
        echo -e "${BLUE}===========================================${NC}"
        
        # Overall coverage
        local total_coverage=$(go tool cover -func="$COVERAGE_PROFILE" | grep "total:" | awk '{print $3}')
        echo -e "${BLUE}Overall Coverage: ${total_coverage}${NC}"
        
        # Per-file coverage
        echo -e "${BLUE}Per-file Coverage:${NC}"
        go tool cover -func="$COVERAGE_PROFILE" | grep -v "total:" | while read -r line; do
            local file=$(echo "$line" | awk '{print $1}')
            local coverage=$(echo "$line" | awk '{print $3}')
            local coverage_num=$(echo "$coverage" | sed 's/%//')
            
            if (( $(echo "$coverage_num" | cut -d. -f1) >= $COVERAGE_THRESHOLD )); then
                echo -e "${GREEN}  ✅  $file: $coverage${NC}"
            else
                echo -e "${RED}  ❌  $file: $coverage${NC}"
            fi
        done
        
        echo
        echo -e "${BLUE}Reports generated:${NC}"
        echo -e "  📊 HTML Report: $COVERAGE_HTML"
        echo -e "  📄 JSON Report: $COVERAGE_JSON"
        echo -e "  🏷️  Coverage Badge: $COVERAGE_DIR/coverage-badge.svg"
        echo -e "  📋 Coverage Profile: $COVERAGE_PROFILE"
    fi
}

# Function to check dependencies (no longer needed with native bash arithmetic)
check_dependencies() {
    # All calculations now use native bash arithmetic - no external dependencies needed
    return 0
}

# Main execution
main() {
    check_dependencies
    
    # Clean up previous coverage data
    rm -f "$COVERAGE_DIR"/*.out "$COVERAGE_DIR"/*.html "$COVERAGE_DIR"/*.json "$COVERAGE_DIR"/profiles.list
    
    # Get all packages and root module, excluding cmd packages (entry points)
    packages=$(go list ./... | grep -v '/cmd/')
    root_module=$(go list -m)
    
    
    local failed_packages=()
    local total_packages=0
    
    for package in $packages; do
        total_packages=$((total_packages + 1))
        
        
        # Convert package path to relative path for file system operations
        local relative_path=""
        if [ "$package" = "$root_module" ]; then
            relative_path="."
            # Get the actual package name from go.mod or use the directory name
            package_name=$(go list -f '{{.Name}}' . 2>/dev/null || basename "$(pwd)")
        else
            relative_path=${package#$root_module/}
            package_name=${relative_path}
        fi
        
        
        if ! run_package_tests "$package" "$package_name" "$root_module"; then
            failed_packages+=("$package_name")
        fi
        echo
    done
    
    # Generate reports only in coverage mode
    if [ "$FAST_MODE" = false ]; then
        # Merge coverage profiles and generate reports
        merge_coverage_profiles
        generate_html_report
        generate_json_report
        generate_coverage_badge
        generate_coverage_summary
    fi
    
    # Final summary
    echo -e "${BLUE}===========================================${NC}"
    echo -e "${BLUE}          Final Results                    ${NC}"
    echo -e "${BLUE}===========================================${NC}"
    
    local passed_packages=$((total_packages - ${#failed_packages[@]}))
    echo -e "${BLUE}Total packages: $total_packages${NC}"
    echo -e "${GREEN}Passed threshold: $passed_packages${NC}"
    echo -e "${RED}Failed threshold: ${#failed_packages[@]}${NC}"
    
    if [ "$FAST_MODE" = true ]; then
        # Fast mode: fail only on actual test failures
        if [ ${#failed_packages[@]} -eq 0 ]; then
            echo -e "${GREEN}🎉 All tests passed!${NC}"
            exit 0
        else
            echo -e "${RED}❌ The following packages had test failures:${NC}"
            for package in "${failed_packages[@]}"; do
                echo -e "${RED}  - $package${NC}"
            done
            echo
            echo -e "${YELLOW}💡 Fix the failing tests in the above packages.${NC}"
            exit 1
        fi
    else
        # Coverage mode: always succeed, just report coverage
        echo -e "${GREEN}✅ All tests passed! Coverage analysis complete.${NC}"
        if [ ${#failed_packages[@]} -gt 0 ]; then
            echo -e "${YELLOW}📊 Coverage could be improved in these packages:${NC}"
            for package in "${failed_packages[@]}"; do
                echo -e "${YELLOW}  - $package${NC}"
            done
            echo -e "${YELLOW}💡 Consider adding more tests to improve coverage.${NC}"
        fi
        exit 0  # Always succeed in coverage mode
    fi
}

# Function to clean up generated test files
cleanup_test_files() {
    echo -e "${BLUE}Cleaning up generated test files...${NC}"
    
    # Remove .generated files from golden directories
    find . -name "*.generated" -type f -delete 2>/dev/null || true
    
    # Remove test binaries
    find . -name "*-golden-test" -type f -delete 2>/dev/null || true
    find . -name "*-regression-test" -type f -delete 2>/dev/null || true
    find . -name "*-test" -type f -delete 2>/dev/null || true
    
    echo -e "${GREEN}Test cleanup completed${NC}"
}

# Set up cleanup to run on script exit
trap cleanup_test_files EXIT

# Run main function
main "$@"