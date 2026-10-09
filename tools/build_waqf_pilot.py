#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pdfplumber>=0.11,<0.12"]
# ///
"""Extract a small, auditable sample of PDF stops; never publish approved stops.

Works offline against the local Hafs verse text and Quran.com page metadata. Requires
Poppler's pdftoppm for the visual review. See tools/waqf-pilot.md for scope.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import unicodedata

import pdfplumber

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PAGES = [5, 6, 7, 100, 278, 500, 554]
MARKS = set("ۘۗۚۖۛۙ")
TYPES = {
    "ج": {"code": "jaiz", "meaning": "Permitted stop, according to this PDF"},
    "ف": {"code": "necessity", "meaning": "Permitted out of necessity; continuing preferred, according to this PDF"},
}


def normalize(text: str) -> str:
    """Match spelling, retaining letter identity (no fuzzy letter replacements).

Ignore spaces, tatweel, diacritics and stop signs. Fold alif variants, final
alif maqsura and the explicit hamza+alif spelling used in this PDF. Do NOT
fold ta marbuta/ha, drop hamza generally, or insert/delete arbitrary letters.
"""
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("ءا", "آ").translate(str.maketrans("أإآٱى", "ااااي"))
    letters = "".join(c for c in text if "\u0621" <= c <= "\u063a" or "\u0641" <= c <= "\u064a")
    return letters.replace("ءا", "ا")


def read_js(path: Path):
    raw = path.read_text(encoding="utf-8").strip()
    return json.loads(raw.rsplit("=", 1)[1].rstrip(";"))


def rtl_text(page, bbox=None) -> str:
    """Read RTL glyphs, preserving multi-letter ligatures such as لا.

pdfplumber text is visual LTR for this PDF. Reversing a Unicode string would
turn لا into ال and reverse numbers. Its expanded line chars may repeat the
same multi-letter glyph: remove those duplicates before ordering glyphs.
"""
    region = page.crop(bbox) if bbox else page
    lines = region.extract_text_lines()
    output = []
    for line in lines:
        unique = {(round(c["x0"], 3), round(c["top"], 3), c["text"]): c for c in line["chars"]}
        chars = sorted(unique.values(), key=lambda c: -c["x0"])
        parts = []
        previous = None
        for c in chars:
            if previous and previous["x0"] - c["x1"] > 2:
                parts.append(" ")
            parts.append(c["text"])
            previous = c
        text = "".join(parts)
        # Number runs are left-to-right, even in RTL titles.
        text = re.sub(r"[0-9٠-٩۰-۹]+(?:\+[0-9٠-٩۰-۹]+)*", lambda m: m[0][::-1], text)
        output.append(text)
    return "\n".join(output).strip()


def parse_heading(text: str, surah_names: dict[str, int]) -> dict | None:
    compact = normalize(text)
    if not compact.startswith("صفحة") or "منسورة" not in compact:
        return None
    name = text.split("سورة", 1)[-1].strip()
    pages = re.findall(r"\d+(?:\+\d+)*", text)
    if len(pages) != 1:
        raise ValueError(f"Cannot read page numbers in title: {text!r}")
    page_numbers = sorted({int(n) for n in pages[0].split("+")})
    if any(n < 1 or n > 604 for n in page_numbers):
        raise ValueError(f"Title has out-of-range mushaf page: {text!r}")
    return {"title": text, "surahName": name, "surah": surah_names.get(normalize(name)), "mushafPages": page_numbers}


def extract_page(pdf, number: int, names: dict[str, int]) -> dict:
    page = pdf.pages[number - 1].dedupe_chars()
    headings = []
    for line in page.extract_text_lines():
        bbox = (max(0, line["x0"] - 1), max(0, line["top"] - 1), min(page.width, line["x1"] + 1), min(page.height, line["bottom"] + 1))
        text = rtl_text(page, bbox)
        heading = parse_heading(text, names)
        if heading:
            heading["top"] = line["top"]
            heading["bbox"] = list(bbox)
            headings.append(heading)
    headings.sort(key=lambda h: h["top"])
    tables = page.find_tables()
    if not headings or not tables:
        raise ValueError(f"PDF page {number}: expected a heading and a ruled table")
    rows, skipped = [], []
    seen = set()
    for table in tables:
        for table_row in table.rows:
            cells = table_row.cells
            bbox = list(table_row.bbox)
            if tuple(round(v, 1) for v in bbox) in seen:
                continue
            seen.add(tuple(round(v, 1) for v in bbox))
            texts = [rtl_text(page, cell) if cell else "" for cell in cells]
            if not any(texts):
                skipped.append({"bbox": bbox, "reason": "blank"})
                continue
            # Three semantic columns, occasionally followed by a blank border cell.
            if len(texts) >= 3 and texts[1].strip() in TYPES:
                if any(t.strip() for t in texts[3:]):
                    raise ValueError(f"PDF page {number}: unexpected populated extra column")
                applicable = [h for h in headings if h["top"] < bbox[1]]
                if not applicable:
                    raise ValueError(f"PDF page {number}: row has no preceding heading")
                rows.append({
                    "id": f"pdf-{number}-row-{len(rows) + 1}", "pdfPage": number,
                    "row": len(rows) + 1, "bbox": bbox, "heading": applicable[-1],
                    "phrase": texts[2].strip(), "stopSymbol": texts[1].strip(),
                    "stopType": TYPES[texts[1].strip()]["code"], "attribution": texts[0],
                    "rawCellsLtr": [page.crop(c).extract_text() if c else "" for c in cells],
                })
            elif any(parse_heading(t, names) for t in texts if t):
                skipped.append({"bbox": bbox, "reason": "embedded heading"})
            elif normalize("".join(texts)).startswith("لمنيسند") or "نوعالوقف" in normalize("".join(texts)):
                skipped.append({"bbox": bbox, "reason": "column headings"})
            else:
                # Unknown rows must not disappear silently.
                raise ValueError(f"PDF page {number}: unrecognized table row {texts!r}")
    return {"pdfPage": number, "width": page.width, "height": page.height,
            "headings": headings, "rows": rows, "skippedRows": skipped}


class Reference:
    def __init__(self, root: Path):
        self.root = root
        self.ayat = read_js(root / "data/quran-data.js")
        self.by_ref = {f"{a['s']}:{a['a']}": a for a in self.ayat}
        self.names = {normalize(a["s_ar"]): a["s"] for a in self.ayat}
        # This is Quran.com verse/page metadata, not image-derived geometry.
        page_metadata = read_js(root / "data/line-bands.js")
        self.pages_by_ref = {
            ref: sorted(map(int, page_metadata.get(ref, {})))
            for ref in self.by_ref
        }
        missing = [ref for ref, pages in self.pages_by_ref.items() if not pages]
        if missing:
            raise ValueError(f"Missing local Quran.com verse/page metadata: {missing[:5]}")
        self.refs_by_page = defaultdict(list)
        for ref, pages in self.pages_by_ref.items():
            for page in pages:
                self.refs_by_page[page].append(ref)
        self.words = {}
        for ref, ayah in self.by_ref.items():
            words = []
            for display_index, token_match in enumerate(re.finditer(r"\S+", ayah["ar"]), 1):
                token = token_match[0]
                if normalize(token):
                    words.append({"i": len(words) + 1, "displayIndex": display_index,
                                  "text": token, "normalized": normalize(token),
                                  "charStart": token_match.start(), "charEnd": token_match.end(),
                                  "marks": [c for c in token if c in MARKS]})
                elif words:
                    words[-1]["marks"].extend(c for c in token if c in MARKS)
            self.words[ref] = words

    def candidates(self, phrase: str, pages: list[int], surah: int | None) -> list[dict]:
        needle = normalize(phrase)
        if not needle:
            return []
        hits = []
        # Deduplicate ayat spanning two selected pages: one text anchor per hit.
        refs = {ref for page in pages for ref in self.refs_by_page[page]}
        for ref in sorted(refs, key=lambda r: tuple(map(int, r.split(":")))):
            if surah is not None and int(ref.split(":")[0]) != surah:
                continue
            words = self.words[ref]
            for start in range(len(words)):
                joined = ""
                for end in range(start, len(words)):
                    joined += words[end]["normalized"]
                    if joined == needle:
                        hits.append(self.anchor(ref, start, end, pages))
                    if len(joined) >= len(needle):
                        break
        return hits

    def anchor(self, ref, start, end, source_pages):
        words = self.words[ref]
        first, last = words[start], words[end]
        verse_pages = self.pages_by_ref[ref]
        # Whole-ayah text proves the word location, but cannot prove which page
        # contains an endpoint in a multi-page ayah. Do not invent that mapping.
        page = verse_pages[0] if len(verse_pages) == 1 else None
        return {
            "ref": ref, "page": page, "versePages": verse_pages,
            "sourcePageHints": source_pages,
            "startWord": first["i"], "endWord": last["i"],
            "startDisplayIndex": first["displayIndex"], "endDisplayIndex": last["displayIndex"],
            "textRange": [first["charStart"], last["charEnd"]],
            "matchedText": " ".join(w["text"] for w in words[start:end + 1]),
            "stopAfter": last["text"],
            "context": " ".join(w["text"] for w in words[max(0, start-3):min(len(words), end+4)]),
            "existingMarks": sorted(set(last["marks"])), "ayahEnd": end == len(words)-1,
            "anchorIssues": [] if page is not None else ["word_page_unknown_within_spanning_ayah"],
        }

    def review_verses(self, pages):
        refs = {ref for page in pages for ref in self.refs_by_page[page]}
        return {ref: {"ar": self.by_ref[ref]["ar"], "surahName": self.by_ref[ref]["s_ar"],
                      "pages": self.pages_by_ref[ref]}
                for ref in sorted(refs, key=lambda r: tuple(map(int, r.split(":"))))}


def order_key(anchor):
    s, a = map(int, anchor["ref"].split(":"))
    return s, a, anchor["endWord"]


def resolve_order(rows: list[dict]) -> None:
    """Keep all candidates participating in a strictly increasing table sequence.

Never choose 'first hit'. Repeated labels can resolve only if neighboring
exact matches prove a unique placement. Unmatched rows are not constraints.
"""
    usable = [row for row in rows if row["candidates"] and not row["headingIssues"]]
    if not usable:
        return
    # A source may contain an out-of-order row. Isolate impossible rows before
    # applying sequence constraints; do not discard independent good matches.
    singles = [(i, r) for i, r in enumerate(usable) if len(r["candidates"]) == 1]
    excluded = set()
    for (left_i, left), (right_i, right) in zip(singles, singles[1:]):
        if order_key(left["candidates"][0]) >= order_key(right["candidates"][0]):
            excluded.update((left_i, right_i))
    for i, row in enumerate(usable):
        if i in excluded:
            continue
        before = [(j, r) for j, r in singles if j < i and j not in excluded]
        after = [(j, r) for j, r in singles if j > i and j not in excluded]
        low = order_key(before[-1][1]["candidates"][0]) if before else None
        high = order_key(after[0][1]["candidates"][0]) if after else None
        if not any((low is None or low < order_key(c)) and (high is None or order_key(c) < high) for c in row["candidates"]):
            excluded.add(i)
    for i in excluded:
        usable[i]["matchStatus"] = "order_conflict"
        usable[i]["orderIssues"] = ["No strictly increasing placement fits neighboring unique source rows"]
    usable = [r for i, r in enumerate(usable) if i not in excluded]
    if not usable:
        return
    forward = []
    for index, row in enumerate(usable):
        candidates = row["candidates"]
        possible = {i for i, c in enumerate(candidates) if index == 0 or any(order_key(usable[index-1]["candidates"][j]) < order_key(c) for j in forward[-1])}
        forward.append(possible)
    backward = [set() for _ in usable]
    for index in range(len(usable)-1, -1, -1):
        candidates = usable[index]["candidates"]
        backward[index] = {i for i, c in enumerate(candidates) if index == len(usable)-1 or any(order_key(c) < order_key(usable[index+1]["candidates"][j]) for j in backward[index+1])}
    if not forward[-1]:
        for row in usable:
            row["matchStatus"] = "order_conflict"
        return
    for index, row in enumerate(usable):
        feasible = sorted(forward[index] & backward[index])
        row["feasibleCandidates"] = [row["candidates"][i] for i in feasible]
        if len(feasible) == 1:
            row["match"] = row["feasibleCandidates"][0]
            row["matchStatus"] = "exact_unique" if len(row["candidates"]) == 1 else "exact_order_resolved"
        else:
            row["matchStatus"] = "ambiguous"


def match_page(source, reference, transcriptions=None):
    groups = defaultdict(list)
    for row in source["rows"]:
        correction = (transcriptions or {}).get(row["id"])
        if correction:
            if row["phrase"] != correction["extractedPhrase"]:
                raise ValueError(f"Transcription no longer matches extracted text for {row['id']}")
            row["transcription"] = correction
        phrase = correction["transcribedPhrase"] if correction else row["phrase"]
        heading = row["heading"]
        pages = heading["mushafPages"]
        surah = heading["surah"]
        issues = []
        if surah is None:
            issues.append("unrecognized_surah_title")
        for page in pages:
            refs = reference.refs_by_page[page]
            if not refs:
                issues.append(f"missing_text_page_metadata_{page}")
            elif surah is not None and not any(ref.startswith(f"{surah}:") for ref in refs):
                issues.append(f"surah_title_conflicts_with_mushaf_page_{page}")
        row["headingIssues"] = issues
        row["candidates"] = reference.candidates(phrase, pages, surah) if surah else []
        row["matchStatus"] = "heading_conflict" if issues else "unmatched"
        row["reviewStatus"] = "pending"
        row["classification"] = "unresolved"
        if not row["candidates"] or issues:
            # Suggestions are diagnostic only; never widen the accepted match scope.
            row["samePageSuggestions"] = reference.candidates(phrase, pages, None)
        groups[heading["top"]].append(row)
    for rows in groups.values():
        resolve_order(rows)
    for row in source["rows"]:
        if row["matchStatus"] == "ambiguous":
            row["ambiguity"] = {
                "groupId": row["id"],
                "candidateCount": len(row["feasibleCandidates"]),
                "reason": "Source phrase has multiple locations after wording and row-order checks",
            }
            row["potentialMatches"] = row["feasibleCandidates"]
        match = row.get("match")
        if match:
            if match["anchorIssues"]:
                row["matchStatus"] = "anchor_needs_review"
            row["classification"] = "existing_mark" if match["existingMarks"] else "ayah_end" if match["ayahEnd"] else "additional_candidate"


def stop_proposals(row: dict) -> list[dict]:
    """Export locations without turning ambiguity into a definite assignment.

    Only the remaining feasible alternatives are potential stops. Heading and
    order conflicts never acquire stops merely because they have candidates.
    """
    ambiguity = row.get("ambiguity")
    if row["matchStatus"] == "ambiguous" and ambiguity:
        matches = row["potentialMatches"]
    elif row.get("match"):
        matches = [row["match"]]
    else:
        return []
    proposals = []
    for match in matches:
        if match["anchorIssues"] or match["page"] is None:
            # All alternatives remain in report.json, even when the exact
            # physical page cannot yet be determined for a per-page export.
            continue
        proposal = {k: v for k, v in row.items() if k != "potentialMatches"}
        proposal.update({
            "id": f"{row['id']}:{match['ref']}:{match['endWord']}",
            "sourceRowId": row["id"], "match": match,
            "potentialWaqf": True, "ambiguous": bool(ambiguity),
            "classification": "existing_mark" if match["existingMarks"] else "ayah_end" if match["ayahEnd"] else "additional_candidate",
        })
        proposals.append(proposal)
    return proposals


def sha256(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def js_write(path, global_name, value, page=None):
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    prefix = f"window.{global_name}=" if page is None else f'window.{global_name}=window.{global_name}||{{}};window.{global_name}["{page}"]='
    path.write_text(prefix + body + ";\n", encoding="utf-8")


def write_outputs(report, out: Path, pdf_path: Path, root: Path, render: bool):
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    page_dir = out / "pages"
    page_dir.mkdir(exist_ok=True)
    # Prevent old sample pages surviving a subsequent run with a different sample.
    for path in page_dir.glob("*.js"):
        if "window.QURAN_WAQF_PILOT_PAGES=" in path.read_text(encoding="utf-8"):
            path.unlink()
    page_rows = defaultdict(list)
    for source in report["pages"]:
        for row in source["rows"]:
            for proposal in stop_proposals(row):
                page_rows[proposal["match"]["page"]].append(proposal)
    manifest = {"version": 3, "pilot": True, "approved": False,
                "wordIndexBase": 1, "wordIndexSpace": "Arabic tokens, excluding standalone Quran signs",
                "sourceSha256": report["source"]["sha256"], "pdfPages": report["samplePdfPages"],
                "pages": {str(p): {
                    "stopCount": len(stops),
                    "sourceRowCount": len({stop["sourceRowId"] for stop in stops}),
                    "ambiguousStopCount": sum(stop["ambiguous"] for stop in stops),
                    "ambiguityGroupCount": len({stop["ambiguity"]["groupId"] for stop in stops if stop["ambiguous"]}),
                    "additionalCandidateCount": sum(stop["classification"] == "additional_candidate" for stop in stops),
                } for p, stops in sorted(page_rows.items())}}
    js_write(out / "manifest.js", "QURAN_WAQF_PILOT_MANIFEST", manifest)
    for page, rows in sorted(page_rows.items()):
        js_write(page_dir / f"{page}.js", "QURAN_WAQF_PILOT_PAGES", {"version": 3, "pilot": True, "approved": False, "page": page, "stops": rows}, page)
    if render:
        assets = out / "review-assets"
        assets.mkdir(exist_ok=True)
        for source in report["pages"]:
            number = source["pdfPage"]
            subprocess.run(["pdftoppm", "-f", str(number), "-l", str(number), "-scale-to", "1600", "-singlefile", "-png", str(pdf_path), str(assets / f"pdf-{number}")], check=True, capture_output=True)
    write_review(report, out, root)


def write_review(report, out, root):
    # Both sides use extracted text. Original PDF artwork is optional evidence.
    data = json.dumps(report, ensure_ascii=False).replace("<", "\\u003c")
    template = (ROOT / "tools/waqf_review.html").read_text(encoding="utf-8")
    (out / "review.html").write_text(template.replace("__REPORT__", data), encoding="utf-8")


def page_numbers(value):
    values = []
    for piece in value.split(","):
        if "-" in piece:
            start, end = map(int, piece.split("-", 1))
            if end < start:
                raise argparse.ArgumentTypeError("Page range must be increasing")
            values.extend(range(start, end + 1))
        else:
            values.append(int(piece))
    return sorted(set(values))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, default=ROOT / "data/Woukoufet-Al-Koran-V2.pdf")
    parser.add_argument("--pages", type=page_numbers, default=DEFAULT_PAGES, help="1-based PDF pages, e.g. 5-7,100,278,500,554")
    parser.add_argument("--output", type=Path, default=ROOT / "data/waqf-pilot")
    parser.add_argument("--transcriptions", type=Path, default=ROOT / "data/sources/waqf-pilot-transcriptions.json", help="Visually checked extraction corrections, bound to the PDF hash")
    parser.add_argument("--skip-render", action="store_true", help="Keep extraction output; visual review needs existing rendered PNGs")
    args = parser.parse_args()
    if not args.pages:
        parser.error("At least one page is required")
    transcriptions = {}
    if args.transcriptions.exists():
        data = json.loads(args.transcriptions.read_text(encoding="utf-8"))
        if data["pdfSha256"] != sha256(args.pdf):
            parser.error("Transcription PDF hash differs; supply a matching --transcriptions file")
        transcriptions = {r["id"]: r for r in data["corrections"]}
    reference = Reference(ROOT)
    sources = []
    with pdfplumber.open(args.pdf) as pdf:
        if any(n < 5 or n > len(pdf.pages) for n in args.pages):
            parser.error(f"Sample pages must be between 5 and {len(pdf.pages)}")
        for number in args.pages:
            source = extract_page(pdf, number, reference.names)
            match_page(source, reference, transcriptions)
            sources.append(source)
            print(f"PDF page {number}: {len(source['rows'])} rows", flush=True)
    rows = [r for p in sources for r in p["rows"]]
    clean_rows = [r for r in rows if r["matchStatus"] in ("exact_unique", "exact_order_resolved")]
    review_pages = sorted({n for source in sources for h in source["headings"] for n in h["mushafPages"]})
    proposals = [proposal for row in rows for proposal in stop_proposals(row)]
    ambiguous_rows = [row for row in rows if row["matchStatus"] == "ambiguous"]
    report = {"version": 3, "pilot": True, "approved": False,
        "source": {"file": os.path.relpath(args.pdf, ROOT), "sha256": sha256(args.pdf), "reportedReading": "Qalun an Nafi (introduction, PDF page 3)", "legendPdfPage": 3},
        "reference": {"text": "data/quran-data.js", "textSha256": sha256(ROOT / "data/quran-data.js"),
                      "reading": "Hafs, local Arabic verse text", "mode": "text",
                      "pageMetadata": "data/line-bands.js", "pageMetadataSha256": sha256(ROOT / "data/line-bands.js"),
                      "verses": reference.review_verses(review_pages)},
        "wordIndexBase": 1, "wordIndexSpace": "Arabic tokens, excluding standalone Quran signs",
        "samplePdfPages": args.pages, "stopTypes": TYPES, "transcriptions": list(transcriptions.values()),
        "summary": {"rows": len(rows), "exportedPotentialLocations": len(proposals),
                    "ambiguousSourceRows": len(ambiguous_rows),
                    "ambiguousPotentialLocations": sum(len(row["potentialMatches"]) for row in ambiguous_rows),
                    "exportedAmbiguousLocations": sum(proposal["ambiguous"] for proposal in proposals), "cleanLocationMatches": len(clean_rows), "needsReview": len(rows)-len(clean_rows), "cleanClassifications": dict(Counter(r["classification"] for r in clean_rows)), "matchStatuses": dict(Counter(r["matchStatus"] for r in rows)), "classifications": dict(Counter(r["classification"] for r in rows)), "stopSymbols": dict(Counter(r["stopSymbol"] for r in rows))},
        "pages": sources}
    write_outputs(report, args.output, args.pdf, ROOT, not args.skip_render)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print(f"Review: {args.output / 'review.html'}")


if __name__ == "__main__":
    main()
