#!/usr/bin/env python3
"""
World Monitor Security Assessment - Main Execution Script
Executes risk scoring, finding correlation, failsafe backup management, history logging, and comparison engine.
"""

import os
import sys
import json
import time
import argparse
import http.server
import socketserver
from engine.scoring import score_all_findings
from engine.correlation import build_correlation_graph
from engine.failsafe import execute_with_failsafe, log_failure
from engine.comparison import compare_assessments

PORT = 8050
HISTORY_FILE = os.path.join(os.path.dirname(__file__), "data", "history.json")
COMPARISON_FILE = os.path.join(os.path.dirname(__file__), "data", "comparisons.json")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "data", "assessment_results.json")

def record_history(results, duration=0.0):
    """Records assessment run snapshot to history.json."""
    history = []
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, "r") as f:
                history = json.load(f)
        except Exception:
            history = []
            
    snapshot = {
        "timestamp": results["meta"]["timestamp"],
        "postureScore": results["posture"]["postureScore"],
        "status": results["posture"]["status"],
        "totalFindings": len(results["findings"]),
        "severityCounts": results["posture"]["severityCounts"],
        "attackPathCount": len(results.get("graph", {}).get("attackPaths", [])),
        "engineStatus": results["meta"]["engineStatus"],
        "durationSeconds": round(duration, 3)
    }
    
    history.append(snapshot)
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2)

def run_primary_pipeline(raw_findings):
    score_results = score_all_findings(raw_findings)
    scored_findings = score_results["findings"]
    posture = score_results["posture"]
    graph_results = build_correlation_graph(scored_findings)
    
    return {
        "posture": posture,
        "findings": scored_findings,
        "graph": graph_results,
        "validationSummary": score_results["validationSummary"]
    }

def perform_assessment(force_fail=False):
    start_time = time.time()
    
    # Read previous assessment snapshot if available before overwriting
    previous_result = None
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, "r") as f:
                previous_result = json.load(f)
        except Exception:
            previous_result = None

    findings_path = os.path.join(os.path.dirname(__file__), "data", "findings.json")
    with open(findings_path, "r") as f:
        raw_findings = json.load(f)
        
    results = execute_with_failsafe(run_primary_pipeline, raw_findings, force_fail=force_fail)
    duration = time.time() - start_time
    results["meta"]["durationSeconds"] = round(duration, 3)
    
    record_history(results, duration)
    
    with open(OUTPUT_FILE, "w") as f:
        json.dump(results, f, indent=2)
        
    # Generate and save comparison
    comparison_results = compare_assessments(previous_result, results)
    with open(COMPARISON_FILE, "w") as f:
        json.dump(comparison_results, f, indent=2)
        
    return results

def main():
    parser = argparse.ArgumentParser(description="World Monitor Security Assessment Platform")
    parser.add_argument("--force-fail", action="store_true", help="Simulate a primary engine failure to test backup fallback mode")
    parser.add_argument("--no-server", action="store_true", help="Run assessment without starting the HTTP web server")
    args = parser.parse_args()

    print("=" * 65)
    print("      WORLD MONITOR SECURITY ASSESSMENT PLATFORM")
    print("      SIH Problem Statement 26163 - Production MVP")
    print("=" * 65)
    
    print("[1/4] Loading input evidence model...")
    print("[2/4] Executing Assessment Engine (with Fail-Safe)...")
    results = perform_assessment(force_fail=args.force_fail)
    
    engine_status = results["meta"]["engineStatus"]
    posture = results["posture"]
    
    print(f"      [OK] Assessment Engine Mode: [{engine_status}]")
    if engine_status == "FALLBACK":
        print(f"      [!] WARNING: Primary assessment failed. Reason: {results['meta']['fallbackReason']}")
    print(f"      [OK] Posture Score: {posture['postureScore']}/100 ({posture['status']})")
    print(f"[3/4] Exported assessment artifacts to data/assessment_results.json, history.json, & comparisons.json")
    
    if args.no_server:
        print("[4/4] CLI mode complete. Skipping HTTP server.")
        return

    print("[4/4] Starting Security Dashboard Server...")
    print("-" * 65)
    print(f"      Dashboard URL: http://localhost:{PORT}")
    print(f"      Engine Status: {engine_status}")
    print("      Press Ctrl+C to exit.")
    print("=" * 65)

    class CustomHandler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            clean_path = self.path.split('?', 1)[0]
            if clean_path == "/api/comparison":
                if os.path.exists(COMPARISON_FILE):
                    with open(COMPARISON_FILE, "r") as f:
                        data = json.load(f)
                else:
                    data = {"status": "NO PREVIOUS ASSESSMENT"}
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(data).encode('utf-8'))
                return
            return super().do_GET()

        def do_POST(self):
            clean_path = self.path.split('?', 1)[0]
            if clean_path == "/api/run-assessment":
                res = perform_assessment(force_fail=False)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "SUCCESS", "results": res}).encode('utf-8'))
                return
            elif clean_path == "/api/simulate-failure":
                res = perform_assessment(force_fail=True)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "FALLBACK_ACTIVATED", "results": res}).encode('utf-8'))
                return
            elif clean_path == "/api/reset-primary":
                res = perform_assessment(force_fail=False)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "PRIMARY_RESTORED", "results": res}).encode('utf-8'))
                return
            self.send_error(404)

        def translate_path(self, path):
            clean_path = path.split('?', 1)[0].split('#', 1)[0]
            if clean_path in ("/", "/index.html"):
                return os.path.join(os.path.dirname(__file__), "frontend", "index.html")
            elif clean_path.startswith("/data/"):
                return os.path.join(os.path.dirname(__file__), clean_path.lstrip("/"))
            return super().translate_path(path)

    os.chdir(os.path.dirname(__file__))
    with socketserver.TCPServer(("", PORT), CustomHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[+] Dashboard server stopped.")

if __name__ == "__main__":
    main()
