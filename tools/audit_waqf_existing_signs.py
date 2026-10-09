#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pdfplumber>=0.11,<0.12"]
# ///
"""Test preferring existing Hafs signs; never change the extraction results.

Some flagged phrases need explicit spelling/heading hypotheses before a
location can be examined. These hypotheses are recorded, not auto-corrected.
"""
import json
from pathlib import Path

from build_waqf_pilot import ROOT, Reference, order_key

# Hypotheses checked against the existing local verse text and source rows.
# They are diagnostic, not approved source transcriptions or reading mappings.
WORDING_HYPOTHESES = {
    "pdf-5-row-9": ("والذين آمنوا", "PDF omits the attached waw; test the earlier occurrence suggested by its neighbors"),
    "pdf-6-row-12": ("رزقا لكم", "PDF prints زرقا لكم; test swapping the first two letters"),
    "pdf-6-row-16": ("والحجارة", "PDF omits the attached waw"),
    "pdf-500-row-1": ("إحسانا", "Source حسنا differs from local Hafs wording; location hypothesis only"),
    "pdf-554-row-1": ("وما بينهما", "PDF omits the attached waw"),
    "pdf-554-row-2": ("الرحمن", "Source الرحمان has an extra alif relative to the local text"),
}


def describe(candidate):
    return {key: candidate[key] for key in ("ref", "endWord", "stopAfter", "context", "existingMarks")}


def main():
    original = ROOT / "data/waqf-pilot/report.json"
    report = json.loads(original.read_text())
    reference = Reference(ROOT)
    rows = [row for page in report["pages"] for row in page["rows"]]
    flagged = []
    controls = []
    for row in rows:
        if row["matchStatus"] not in ("exact_unique", "exact_order_resolved"):
            hypothesis = WORDING_HYPOTHESES.get(row["id"])
            phrase = hypothesis[0] if hypothesis else row.get("transcription", {}).get("transcribedPhrase", row["phrase"])
            # A bad heading may be examined using page scope, but remains flagged.
            surah = None if row["headingIssues"] else row["heading"]["surah"]
            candidates = reference.candidates(phrase, row["heading"]["mushafPages"], surah)
            marked = [c for c in candidates if c["existingMarks"]]
            flagged.append({"id": row["id"], "pdfPhrase": row["phrase"], "originalStatus": row["matchStatus"],
                            "testedPhrase": phrase, "hypothesis": hypothesis[1] if hypothesis else None,
                            "headingRelaxedForAudit": bool(row["headingIssues"]),
                            "candidates": [describe(c) for c in candidates],
                            "uniqueMarkedCandidate": describe(marked[0]) if len(marked) == 1 else None,
                            "ruleOutcome": "one_marked_candidate" if len(marked) == 1 else "no_marked_candidate" if not marked else "multiple_marked_candidates",
                            "changesOriginalDecision": False})
        # Independent controls: compare naive sign preference with the location
        # uniquely established by source-row order, before considering signs.
        if row["matchStatus"] == "exact_order_resolved" and len(row["candidates"]) > 1:
            marked = [c for c in row["candidates"] if c["existingMarks"]]
            if len(marked) == 1:
                agrees = order_key(marked[0]) == order_key(row["match"])
                controls.append({"id": row["id"], "pdfPhrase": row["phrase"],
                                 "orderResolved": describe(row["match"]),
                                 "signPreferred": describe(marked[0]),
                                 "agreesWithOrder": agrees})
    results = {
        "version": 1, "auditOnly": True, "samplePdfPages": report["samplePdfPages"],
        "sourceSha256": report["source"]["sha256"], "textSha256": report["reference"]["textSha256"],
        "summary": {"flaggedRowsChecked": len(flagged),
                    "flaggedWithOneMarkedCandidate": sum(r["uniqueMarkedCandidate"] is not None for r in flagged),
                    "orderResolvedControlsWithOneMarkedCandidate": len(controls),
                    "controlsAgreeing": sum(c["agreesWithOrder"] for c in controls),
                    "controlsConflicting": sum(not c["agreesWithOrder"] for c in controls)},
        "flaggedRows": flagged, "orderResolvedControls": controls,
        "conclusion": "Existing signs can support a location hypothesis, but must not override phrase identity, surah, or row-order evidence. A remaining ambiguity may receive a sign-based suggestion, not a proven source assignment.",
    }
    out = ROOT / "data/waqf-pilot/existing-sign-audit.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(results["summary"], ensure_ascii=False, indent=2))
    for row in flagged:
        hit = row["uniqueMarkedCandidate"]
        print(row["id"], row["pdfPhrase"], "=>", (f"{hit['ref']} word {hit['endWord']} {' '.join(hit['existingMarks'])}" if hit else "no unique marked candidate"))
    for c in controls:
        if not c["agreesWithOrder"]:
            print("COUNTEREXAMPLE", c["id"], c["pdfPhrase"], "order:", c["orderResolved"]["endWord"], "sign:", c["signPreferred"]["endWord"])


if __name__ == "__main__":
    main()
