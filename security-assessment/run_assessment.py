#!/usr/bin/env python3
"""Local synthetic scoring demo. This does not scan or assess WorldMonitor."""
import argparse
import hmac
import json
import secrets
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from engine.scoring import score_all_findings
from engine.correlation import build_correlation_graph
from engine.failsafe import execute_with_failsafe
from engine.comparison import compare_assessments
from engine.storage import OUTPUT_DIR, read_json, write_json

ROOT = Path(__file__).resolve().parent
PORT = 8050
NOTICE = "SYNTHETIC / DEMONSTRATION DATA - NOT VERIFIED WORLD MONITOR VULNERABILITIES"
HISTORY_FILE = OUTPUT_DIR / "history.json"
COMPARISON_FILE = OUTPUT_DIR / "comparisons.json"
OUTPUT_FILE = OUTPUT_DIR / "assessment_results.json"


def record_history(results, duration=0.0):
    history = read_json(HISTORY_FILE, [])
    if not isinstance(history, list):
        raise ValueError("History must be a JSON array")
    history.append({
        "data_type": NOTICE,
        "timestamp": results["meta"]["timestamp"],
        "postureScore": results["posture"]["postureScore"],
        "status": results["posture"]["status"],
        "totalFindings": len(results["findings"]),
        "severityCounts": results["posture"].get("severityCounts", {}),
        "attackPathCount": len(results["graph"]["attackPaths"]),
        "engineStatus": results["meta"]["engineStatus"],
        "durationSeconds": round(duration, 3),
    })
    write_json(HISTORY_FILE, history[-100:])


def run_primary_pipeline(raw_findings):
    # Correlation populates the inputs used by scoring, then refresh graph scores.
    findings = [dict(f) for f in raw_findings]
    build_correlation_graph(findings)
    scored = score_all_findings(findings)
    return {**scored, "graph": build_correlation_graph(scored["findings"])}


def perform_assessment(force_fail=False):
    start = time.monotonic()
    previous = read_json(OUTPUT_FILE)
    # Missing or corrupt evidence must fail explicitly, not invent a healthy fallback.
    with open(ROOT / "data" / "findings.json", encoding="utf-8") as stream:
        raw_findings = json.load(stream)
    results = execute_with_failsafe(run_primary_pipeline, raw_findings, force_fail=force_fail)
    results["meta"].update(data_type=NOTICE, durationSeconds=round(time.monotonic() - start, 3))
    for finding in results["findings"]:
        finding["data_type"] = NOTICE
    comparison = {**compare_assessments(previous, results), "data_type": NOTICE}
    record_history(results, results["meta"]["durationSeconds"])
    write_json(OUTPUT_FILE, results)
    write_json(COMPARISON_FILE, comparison)
    return results


class AssessmentHandler(BaseHTTPRequestHandler):
    def _allowed_host(self):
        port = self.server.server_port
        return self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}")

    def _send(self, status, value, content_type="application/json"):
        body = value.encode("utf-8") if isinstance(value, str) else json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._allowed_host():
            return self._send(403, {"error": "Invalid host"})
        path = urlsplit(self.path).path
        try:
            if path in ("/", "/index.html"):
                html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
                return self._send(200, html.replace("__ASSESSMENT_TOKEN__", self.server.action_token), "text/html; charset=utf-8")
            files = {
                "/data/assessment_results.json": OUTPUT_FILE,
                "/data/history.json": HISTORY_FILE,
                "/data/comparisons.json": COMPARISON_FILE,
                "/api/comparison": COMPARISON_FILE,
            }
            if path not in files:
                return self._send(404, {"error": "Not found"})
            value = read_json(files[path])
            return self._send(404, {"error": "Run the demo first"}) if value is None else self._send(200, value)
        except (OSError, ValueError, TypeError):
            self._send(500, {"error": "Cannot read demo artifacts"})

    def do_POST(self):
        origin = self.headers.get("Origin")
        if (not self._allowed_host() or
            (origin is not None and origin != f"http://{self.headers.get('Host')}") or
            not hmac.compare_digest(self.headers.get("X-Assessment-Token", "").encode("utf-8"), self.server.action_token.encode("utf-8"))):
            return self._send(403, {"error": "Unauthorized demo action"})
        path = urlsplit(self.path).path
        if path not in ("/api/run-assessment", "/api/simulate-failure", "/api/reset-primary"):
            return self._send(404, {"error": "Not found"})
        try:
            results = perform_assessment(force_fail=path == "/api/simulate-failure")
            self._send(200, {"status": "SUCCESS", "results": results})
        except (OSError, ValueError, TypeError, KeyError):
            self._send(500, {"error": "Demo failed; check local input and output files"})


def create_server(port=PORT):
    server = HTTPServer(("127.0.0.1", port), AssessmentHandler)
    server.action_token = secrets.token_urlsafe(32)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force-fail", action="store_true")
    parser.add_argument("--no-server", action="store_true")
    args = parser.parse_args()
    perform_assessment(args.force_fail)
    print(NOTICE)
    if not args.no_server:
        with create_server() as server:
            print(f"Local demo: http://127.0.0.1:{server.server_port}")
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    main()
