"""HTTP, persistence, and evidence regressions using temporary artifacts only."""
import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_assessment as app
from engine import failsafe, storage
from engine.correlation import build_correlation_graph


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for name in ("HISTORY_FILE", "OUTPUT_FILE", "COMPARISON_FILE"):
            patcher = patch.object(app, name, root / (name + ".json"))
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(failsafe, "FAILURE_LOG_PATH", root / "failure.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.findings = json.loads((app.ROOT / "data/findings.json").read_text())

    def test_empty_and_subset_inputs_do_not_invent_paths(self):
        for records in ([], self.findings[:1], self.findings[2:]):
            graph = build_correlation_graph(records)
            self.assertEqual(graph["attackPaths"], [])
            self.assertEqual(len(graph["nodes"]), len(records))

    def test_correlation_precedes_scoring(self):
        result = app.run_primary_pipeline(self.findings)
        linked = [f for f in result["findings"] if f["relatedFindings"]]
        self.assertTrue(linked)
        self.assertTrue(all(f["contextual_risk"]["attack_path_impact"] == 8.5 for f in linked))

    def test_real_exception_and_unwritable_log_still_fall_back(self):
        def broken(_):
            raise RuntimeError("synthetic primary failure")
        with patch.object(failsafe, "write_json", side_effect=OSError("disk error")):
            result = failsafe.execute_with_failsafe(broken, self.findings)
        self.assertEqual(result["meta"]["engineStatus"], "FALLBACK")
        self.assertEqual(result["posture"]["riskLevel"], "CRITICAL")
        self.assertEqual(result["posture"]["status"], "CRITICAL RISK")
        self.assertEqual(result["graph"]["attackPaths"], [])

    def test_atomic_failure_preserves_previous_file(self):
        target = Path(self.temp.name) / "atomic.json"
        storage.write_json(target, [1])
        with patch.object(storage.os, "replace", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                storage.write_json(target, [2])
        self.assertEqual(storage.read_json(target), [1])
        self.assertEqual(list(target.parent.iterdir()), [target])

    def test_corrupt_history_is_not_overwritten(self):
        app.HISTORY_FILE.write_text("corrupt")
        with self.assertRaises(ValueError):
            app.perform_assessment()
        self.assertEqual(app.HISTORY_FILE.read_text(), "corrupt")

    def test_history_is_bounded_and_outputs_are_labelled(self):
        result = app.perform_assessment()
        for _ in range(102):
            app.record_history(result)
        history = storage.read_json(app.HISTORY_FILE)
        self.assertEqual(len(history), 100)
        self.assertEqual(result["meta"]["data_type"], app.NOTICE)
        self.assertTrue(all(f["data_type"] == app.NOTICE for f in result["findings"]))
        self.assertEqual(storage.read_json(app.COMPARISON_FILE)["data_type"], app.NOTICE)

    def test_http_control_and_file_boundaries(self):
        with app.create_server(0) as server:
            self.assertEqual(server.server_address[0], "127.0.0.1")
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            def request(path, method="GET", headers=None):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                try:
                    connection.request(method, path, headers=headers or {})
                    response = connection.getresponse()
                    return response.status, response.read()
                finally:
                    connection.close()
            try:
                for path in ("/api/run-assessment", "/api/simulate-failure", "/api/reset-primary"):
                    with patch.object(app, "perform_assessment") as run:
                        self.assertEqual(request(path, "POST")[0], 403)
                        run.assert_not_called()
                for path in ("/data/../run_assessment.py", "/data/%2e%2e/run_assessment.py", "/data/../../README.md", "/engine/scoring.py", "/data/"):
                    self.assertEqual(request(path)[0], 404)
                self.assertEqual(request("/", headers={"Host": "attacker.invalid"})[0], 403)
                token = {"X-Assessment-Token": server.action_token}
                self.assertEqual(request("/api/run-assessment", "POST", {**token, "Origin": "https://attacker.invalid"})[0], 403)
                self.assertEqual(request("/api/run-assessment", "POST", token)[0], 200)
                self.assertEqual(request("/data/assessment_results.json")[0], 200)
                with patch.object(app, "perform_assessment", side_effect=OSError("private path")):
                    status, body = request("/api/run-assessment", "POST", token)
                    self.assertEqual(status, 500)
                    self.assertNotIn(b"private path", body)
                app.OUTPUT_FILE.write_text("corrupt")
                self.assertEqual(request("/data/assessment_results.json")[0], 500)
            finally:
                server.shutdown()
                worker.join()
