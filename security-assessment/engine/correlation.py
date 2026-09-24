"""
Finding Correlation Engine for World Monitor Security Assessment
Identifies evidence-based relationships and constructs Potential Attack Paths.
"""

from typing import Dict, List, Any

def build_correlation_graph(findings: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Correlates findings into graph nodes, edges, and Potential Attack Paths.
    Enriches findings with lists of related finding IDs.
    """
    nodes = []
    edges = []
    related_map = {f["id"]: set() for f in findings}
    
    # 1. Build Nodes
    for f in findings:
        nodes.append({
            "id": f["id"],
            "title": f["title"],
            "category": f["category"],
            "severity": f["severity"],
            "riskScore": f.get("riskScore", 50.0),
            "file": f["file"]
        })
        
    # 2. Derive Edges based on shared evidence contexts
    for i in range(len(findings)):
        for j in range(i + 1, len(findings)):
            f1 = findings[i]
            f2 = findings[j]
            
            reasons = []
            
            dir1 = f1["file"].split('/')[0] if '/' in f1["file"] else f1["file"]
            dir2 = f2["file"].split('/')[0] if '/' in f2["file"] else f2["file"]
            if dir1 == dir2:
                reasons.append(f"Same Subsystem ({dir1})")
                
            cats = {f1["category"], f2["category"]}
            if "Authentication" in cats and "Access Control" in cats:
                reasons.append("Auth & Authorization Vulnerability Chain")
            elif "Authentication" in cats and "Input Handling" in cats:
                reasons.append("Auth Bypass & Remote Execution Chain")
            elif "Access Control" in cats and "Data Exposure" in cats:
                reasons.append("Access Control Breakdown & Data Leakage")
                
            if f1["category"] == f2["category"]:
                reasons.append(f"Shared Category ({f1['category']})")
                
            if reasons:
                edges.append({
                    "source": f1["id"],
                    "target": f2["id"],
                    "relationship": " + ".join(reasons),
                    "strength": len(reasons)
                })
                related_map[f1["id"]].add(f2["id"])
                related_map[f2["id"]].add(f1["id"])

    # 3. Enrich Findings with related list
    for f in findings:
        f["relatedFindings"] = sorted(list(related_map[f["id"]]))

    # Shared categories and directories do not prove an executable attack path.
    attack_paths = []

    return {
        "nodes": nodes,
        "edges": edges,
        "attackPaths": attack_paths
    }
