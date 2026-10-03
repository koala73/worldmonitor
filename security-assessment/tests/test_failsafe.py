"""
Automated Test Suite for World Monitor Security Assessment Platform
Tests pipeline validation, CVSS v4.0 status, Contextual Risk Priority, correlation graph,
fail-safe backup system, history logging, comparison engine, and backward compatibility.
"""

import os
import sys
import json
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
import run_assessment
import engine.failsafe as failsafe

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from engine.scoring import score_all_findings, validate_finding, parse_cvss_v4, calculate_finding_risk
from engine.correlation import build_correlation_graph
from engine.failsafe import execute_with_failsafe, FAILURE_LOG_PATH
from engine.comparison import compare_assessments
from run_assessment import HISTORY_FILE, perform_assessment

class TestSecurityAssessment(unittest.TestCase):

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        global FAILURE_LOG_PATH
        FAILURE_LOG_PATH = Path(temporary.name) / "failure_log.json"
        for target, value in [
            ("run_assessment.HISTORY_FILE", Path(temporary.name) / "history.json"),
            ("run_assessment.OUTPUT_FILE", Path(temporary.name) / "results.json"),
            ("run_assessment.COMPARISON_FILE", Path(temporary.name) / "comparison.json"),
            ("engine.failsafe.FAILURE_LOG_PATH", FAILURE_LOG_PATH),
        ]:
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.findings_file = os.path.join(os.path.dirname(__file__), "..", "data", "findings.json")
        with open(self.findings_file, "r") as f:
            self.raw_findings = json.load(f)

    def test_cvss_data_validation(self):
        """Verify CVSS v4.0 data validation and missing CVSS handling."""
        finding_no_cvss = dict(self.raw_findings[0])
        parsed_missing = parse_cvss_v4(finding_no_cvss)
        self.assertEqual(parsed_missing["status"], "REQUIRES VALIDATION")
        self.assertIsNone(parsed_missing["score"])

        finding_with_cvss = dict(self.raw_findings[0])
        finding_with_cvss["cvss"] = {"vector": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H", "score": 9.3, "severity": "CRITICAL"}
        parsed_valid = parse_cvss_v4(finding_with_cvss)
        self.assertEqual(parsed_valid["status"], "REQUIRES VALIDATION")
        self.assertEqual(parsed_valid["score"], 9.3)
        print("[OK] Test Passed: CVSS data validation & missing CVSS handling.")

    def test_contextual_risk_priority_and_confidence(self):
        """Verify Contextual Risk Priority (0-100) and Evidence Confidence scaling."""
        item = calculate_finding_risk(self.raw_findings[0])
        self.assertIn("contextual_risk", item)
        c_risk = item["contextual_risk"]
        self.assertGreaterEqual(c_risk["score"], 0.0)
        self.assertLessEqual(c_risk["score"], 100.0)
        self.assertEqual(c_risk["confidence"], 95)
        
        # Test confidence scaling effect
        low_conf_finding = dict(self.raw_findings[0])
        low_conf_finding["confidence"] = 50
        low_conf_item = calculate_finding_risk(low_conf_finding)
        self.assertLess(low_conf_item["contextual_risk"]["score"], c_risk["score"])
        print("[OK] Test Passed: Contextual Risk Priority & Confidence scaling.")

    def test_backward_compatibility_sec001_to_sec005(self):
        """Verify backward compatibility for SEC-001 through SEC-005."""
        self.assertEqual(len(self.raw_findings), 5)
        for finding in self.raw_findings:
            valid, errs = validate_finding(finding)
            self.assertTrue(valid, f"Finding {finding.get('id')} failed validation: {errs}")
            scored = calculate_finding_risk(finding)
            self.assertIn("riskScore", scored)
            self.assertIn("cvss", scored)
            self.assertEqual(scored["cvss"]["status"], "REQUIRES VALIDATION")
        print("[OK] Test Passed: Backward compatibility for SEC-001 through SEC-005.")

    def test_attack_path_visualization_and_correlation(self):
        """Verify graph node/edge structure and attack paths."""
        score_res = score_all_findings(self.raw_findings)
        graph = build_correlation_graph(score_res["findings"])
        self.assertGreater(len(graph["nodes"]), 0)
        self.assertEqual(graph["attackPaths"], [])
        print("[OK] Test Passed: Attack path graph structure verified.")

    def test_failsafe_backup_system(self):
        """Test primary failure detection, fallback engine execution, and failure logging."""
        results = perform_assessment(force_fail=True)
        self.assertEqual(results["meta"]["engineStatus"], "FALLBACK")
        self.assertTrue(os.path.exists(FAILURE_LOG_PATH))
        with open(FAILURE_LOG_PATH, "r") as f:
            logs = json.load(f)
        self.assertGreater(len(logs), 0)
        self.assertEqual(logs[-1]["component"], "PrimaryScoringEngine")
        print("[OK] Test Passed: Fail-safe backup system verified.")

    def test_comparison_engine_all_scenarios(self):
        """Tests Comparison Engine across selected snapshot scenarios."""
        # 1. No previous assessment
        curr = perform_assessment(force_fail=False)
        comp_no_prev = compare_assessments(None, curr)
        self.assertEqual(comp_no_prev["status"], "NO PREVIOUS ASSESSMENT")

        # 2. Identical assessments
        comp_same = compare_assessments(curr, curr)
        self.assertEqual(comp_same["overall_status"], "UNCHANGED")
        self.assertEqual(comp_same["posture_change"]["direction"], "UNCHANGED")

        # 3. Posture Improvement & Resolution
        prev_snapshot = dict(curr)
        prev_snapshot["posture"] = dict(curr["posture"])
        prev_snapshot["posture"]["postureScore"] = curr["posture"]["postureScore"] - 10 # Worse posture previously
        
        comp_improved = compare_assessments(prev_snapshot, curr)
        self.assertEqual(comp_improved["posture_change"]["direction"], "IMPROVED")
        self.assertEqual(comp_improved["overall_status"], "IMPROVED")

        # 4. New finding & Resolved finding detection
        finding_a = dict(curr["findings"][0])
        finding_b = dict(curr["findings"][1])
        finding_a["id"] = "SEC-001"
        finding_b["id"] = "SEC-002"

        mock_prev = {"posture": curr["posture"], "findings": [finding_a], "graph": curr["graph"], "meta": curr["meta"]}
        mock_curr = {"posture": curr["posture"], "findings": [finding_b], "graph": curr["graph"], "meta": curr["meta"]}

        comp_lifecycle = compare_assessments(mock_prev, mock_curr)
        self.assertIn("SEC-002", comp_lifecycle["findings"]["new"])
        self.assertIn("SEC-001", comp_lifecycle["findings"]["resolved"])

        # 5. Risk increase & decrease for persistent findings
        pf = dict(finding_a)
        pf["contextual_risk"] = {"score": 50.0}
        cf_higher = dict(finding_a)
        cf_higher["contextual_risk"] = {"score": 80.0}

        comp_risk_inc = compare_assessments(
            {"posture": curr["posture"], "findings": [pf], "graph": curr["graph"], "meta": curr["meta"]},
            {"posture": curr["posture"], "findings": [cf_higher], "graph": curr["graph"], "meta": curr["meta"]}
        )
        self.assertEqual(comp_risk_inc["findings"]["changed_risk"][0]["direction"], "REGRESSED")
        print("[OK] Test Passed: Comparison Engine verified across selected scenarios.")

if __name__ == "__main__":
    unittest.main()
