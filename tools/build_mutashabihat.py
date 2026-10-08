#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["beautifulsoup4>=4.12"]
# ///
"""Build per-page mutashabihat data for the static UI.

The preferred source is QUL's Mutashabihat ul Quran JSON export:

    data/sources/qul-mutashabihat/phrases.json
    data/sources/qul-mutashabihat/phrase_verses.json

If that export is not present, the script builds the same shape from QUL's
public phrase pages and caches the result locally. The output is one JS file
per mushaf page so the browser only loads the current page's relations.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SOURCE_DIR = DATA_DIR / "sources"
PAGE_DIR = DATA_DIR / "mutashabihat-pages"

QUL_RESOURCE_URL = "https://qul.tarteel.ai/resources/mutashabihat/73"
QUL_PHRASES_URL = "https://qul.tarteel.ai/morphology_phrases"
QUL_PHRASE_URL = "https://qul.tarteel.ai/morphology_phrases/{phrase_id}/phrase_verses"
QUL_JSON_DIR = SOURCE_DIR / "qul-mutashabihat"
QUL_ZIP = SOURCE_DIR / "qul-mutashabihat.zip"
QUL_SCRAPE_CACHE = SOURCE_DIR / "qul-mutashabihat-scrape.json"

BROAD_MIN_WORDS = 3
SCRAPE_MIN_WORDS = 2
BROAD_MAX_REPEAT_COUNT = 13
BROAD_MIN_AYAH_COVERAGE = 0.35
REQUEST_PAUSE_SECONDS = 0.08
HEADERS = {"User-Agent": "quran-test-mutashabihat/1.0"}


def fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read().decode("utf-8")


def js_write(path: Path, name: str, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    path.write_text(f"window.{name}={body};\n", encoding="utf-8")


def js_page_write(path: Path, name: str, page: int, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    path.write_text(
        f"window.{name}=window.{name}||{{}};window.{name}[\"{page}\"]={body};\n",
        encoding="utf-8",
    )


def load_quran_data() -> list[dict[str, Any]]:
    raw = (DATA_DIR / "quran-data.js").read_text(encoding="utf-8").strip()
    prefix = "window.QURAN_AYAT="
    if not raw.startswith(prefix):
        raise SystemExit("data/quran-data.js has an unexpected format")
    return json.loads(raw[len(prefix) :].rstrip(";"))


def ref_key(surah: int, ayah: int) -> str:
    return f"{surah}:{ayah}"


def words(text: str) -> list[str]:
    return [word for word in re.split(r"\s+", text.replace("\ufeff", "").strip()) if word]


def normalize_word(word: str) -> str:
    return (
        re.sub(r"[^ء-غف-ي]", "", re.sub(r"[\u064B-\u065F\u0670\u06D6-\u06EDـ]", "", word))
        .replace("إ", "ا")
        .replace("أ", "ا")
        .replace("آ", "ا")
        .replace("ٱ", "ا")
        .replace("ى", "ي")
        .replace("ة", "ه")
    )


def indexed_word_positions(display_words: list[str]) -> dict[int, int]:
    positions: dict[int, int] = {}
    source_index = 0
    for display_index, word in enumerate(display_words, start=1):
        if not normalize_word(word):
            continue
        source_index += 1
        positions[source_index] = display_index
    return positions


def selected_display_indices(display_words: list[str], ranges: list[list[int]]) -> set[int]:
    positions = indexed_word_positions(display_words)
    selected: set[int] = set()
    for start, end in ranges:
        for source_index in range(int(start), int(end) + 1):
            display_index = positions.get(source_index)
            if display_index is not None:
                selected.add(display_index)
    return selected


def indexed_word_count(text: str) -> int:
    return len(indexed_word_positions(words(text)))


def normalize_ref(value: str) -> str:
    surah, ayah = value.split(":", 1)
    return f"{int(surah)}:{int(ayah)}"


def range_len(word_range: list[int]) -> int:
    return max(0, int(word_range[1]) - int(word_range[0]) + 1)


def phrase_text_for_ranges(ref: str, ranges: list[list[int]], by_ref: dict[str, dict[str, Any]]) -> str:
    ayah_words = words(by_ref[ref]["ar"])
    selected_indices = selected_display_indices(ayah_words, ranges)
    selected: list[str] = []
    for index, word in enumerate(ayah_words, start=1):
        if index in selected_indices:
            selected.append(word)
    return " ".join(selected)


def diff_words(
    left: str,
    right: str,
    left_ranges: list[list[int]] | None = None,
    right_ranges: list[list[int]] | None = None,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    left_words = words(left)
    right_words = words(right)
    left_selected = selected_display_indices(left_words, left_ranges) if left_ranges is not None else set(range(1, len(left_words) + 1))
    right_selected = selected_display_indices(right_words, right_ranges) if right_ranges is not None else set(range(1, len(right_words) + 1))
    left_norm = [normalize_word(word) for word in left_words]
    right_norm = [normalize_word(word) for word in right_words]
    right_lookup: dict[str, int] = {}
    for index in right_selected:
        if 0 <= index - 1 < len(right_norm):
            right_lookup[right_norm[index - 1]] = right_lookup.get(right_norm[index - 1], 0) + 1

    left_out: list[dict[str, str]] = []
    right_out: list[dict[str, str]] = []
    for index, word in enumerate(left_words, start=1):
        norm = left_norm[index - 1]
        shared = index in left_selected and right_lookup.get(norm, 0) > 0
        if shared:
            right_lookup[norm] -= 1
        left_out.append({"text": word, "kind": "same" if shared else "diff"})

    left_lookup: dict[str, int] = {}
    for index in left_selected:
        if 0 <= index - 1 < len(left_norm):
            left_lookup[left_norm[index - 1]] = left_lookup.get(left_norm[index - 1], 0) + 1
    for index, word in enumerate(right_words, start=1):
        norm = right_norm[index - 1]
        shared = index in right_selected and left_lookup.get(norm, 0) > 0
        if shared:
            left_lookup[norm] -= 1
        right_out.append({"text": word, "kind": "same" if shared else "diff"})

    return left_out, right_out


def make_id(phrase_id: str, current: str, previous: str) -> str:
    digest = hashlib.sha1(f"{phrase_id}|{current}|{previous}".encode("utf-8")).hexdigest()[:10]
    return f"m-{current.replace(':', '-')}-{phrase_id}-{digest}"


def maybe_extract_qul_zip() -> None:
    if (QUL_JSON_DIR / "phrases.json").exists() and (QUL_JSON_DIR / "phrase_verses.json").exists():
        return
    if not QUL_ZIP.exists():
        return
    QUL_JSON_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(QUL_ZIP) as archive:
        for name in archive.namelist():
            if name.endswith(("phrases.json", "phrase_verses.json")):
                target = QUL_JSON_DIR / Path(name).name
                target.write_bytes(archive.read(name))


def load_qul_json() -> tuple[dict[str, Any], str] | None:
    maybe_extract_qul_zip()
    phrases_path = QUL_JSON_DIR / "phrases.json"
    phrase_verses_path = QUL_JSON_DIR / "phrase_verses.json"
    if not phrases_path.exists() or not phrase_verses_path.exists():
        return None
    phrases = json.loads(phrases_path.read_text(encoding="utf-8"))
    phrase_verses = json.loads(phrase_verses_path.read_text(encoding="utf-8"))
    return {"phrases": phrases, "phrase_verses": phrase_verses}, "qul-json"


def parse_int(text: str) -> int:
    match = re.search(r"\d+", text)
    return int(match.group()) if match else 0


def parse_phrase_index_page(html: str) -> tuple[list[dict[str, Any]], int]:
    soup = BeautifulSoup(html, "html.parser")
    rows: list[dict[str, Any]] = []
    for tr in soup.select("tbody tr"):
        cells = tr.select("td")
        if len(cells) < 9:
            continue
        action = tr.select_one('a[href^="/morphology_phrases/"]')
        if not action:
            continue
        href = action.get("href", "")
        phrase_id = href.rstrip("/").split("/")[-1]
        rows.append(
            {
                "id": phrase_id,
                "source": normalize_ref(cells[1].get_text(" ", strip=True)),
                "count": parse_int(cells[2].get_text(" ", strip=True)),
                "ayahs": parse_int(cells[3].get_text(" ", strip=True)),
                "words": parse_int(cells[4].get_text(" ", strip=True)),
                "approved": cells[5].get_text(" ", strip=True).lower() == "true",
                "review": cells[6].get_text(" ", strip=True).lower(),
                "text": " ".join(cells[7].get_text(" ", strip=True).split()),
            }
        )

    pages = [parse_int(link.get_text(" ", strip=True)) for link in soup.select("nav.pagination-nav a")]
    return rows, max([page for page in pages if page], default=1)


def highlighted_ranges(spans: list[Any]) -> list[list[int]]:
    ranges: list[list[int]] = []
    start: int | None = None
    last: int | None = None
    for index, span in enumerate(spans, start=1):
        highlighted = "color:" in (span.get("style") or "")
        if highlighted:
            if start is None:
                start = index
            last = index
        elif start is not None and last is not None:
            ranges.append([start, last])
            start = None
            last = None
    if start is not None and last is not None:
        ranges.append([start, last])
    return ranges


def parse_phrase_verses_page(html: str) -> dict[str, list[list[int]]]:
    soup = BeautifulSoup(html, "html.parser")
    occurrences: dict[str, list[list[int]]] = {}
    for card in soup.select("#body .bg-white"):
        ref_el = card.select_one(".rounded-full")
        text_el = card.select_one(".quran-text")
        if not ref_el or not text_el:
            continue
        ref = normalize_ref(ref_el.get_text(" ", strip=True))
        ranges = highlighted_ranges(text_el.select("span"))
        if ranges:
            occurrences[ref] = ranges
    return occurrences


def scrape_qul_source(refresh: bool, progress: bool) -> tuple[dict[str, Any], str]:
    if not refresh and QUL_SCRAPE_CACHE.exists():
        return json.loads(QUL_SCRAPE_CACHE.read_text(encoding="utf-8")), "qul-scrape-cache"

    first_html = fetch_text(f"{QUL_PHRASES_URL}?sort_key=words_count&sort_order=desc&page=1")
    rows, page_count = parse_phrase_index_page(first_html)
    for page in range(2, page_count + 1):
        html = fetch_text(f"{QUL_PHRASES_URL}?sort_key=words_count&sort_order=desc&page={page}")
        page_rows, _ = parse_phrase_index_page(html)
        rows.extend(page_rows)
        if page_rows and max(row["words"] for row in page_rows) < SCRAPE_MIN_WORDS:
            if progress:
                print(
                    f"  QUL phrase index stopped at {page}/{page_count}; remaining phrases are shorter than "
                    f"{SCRAPE_MIN_WORDS} words",
                    flush=True,
                )
            break
        if progress and page % 25 == 0:
            print(f"  QUL phrase index {page}/{page_count}", flush=True)
        time.sleep(REQUEST_PAUSE_SECONDS)

    candidates = [
        row
        for row in rows
        if row["approved"]
        and row["review"] == "new"
        and 2 <= row["count"] <= BROAD_MAX_REPEAT_COUNT
        and row["ayahs"] >= 2
        and row["words"] >= SCRAPE_MIN_WORDS
    ]

    phrases: dict[str, Any] = {}
    phrase_verses: dict[str, list[int]] = {}
    for index, row in enumerate(candidates, start=1):
        html = fetch_text(QUL_PHRASE_URL.format(phrase_id=row["id"]))
        occurrences = parse_phrase_verses_page(html)
        if len(occurrences) < 2:
            continue
        phrases[row["id"]] = {
            "surahs": len({ref.split(":")[0] for ref in occurrences}),
            "ayahs": len(occurrences),
            "count": row["count"],
            "source": {"key": row["source"]},
            "words_count": row["words"],
            "phrase_text": row["text"],
            "ayah": occurrences,
        }
        for ref in occurrences:
            phrase_verses.setdefault(ref, []).append(int(row["id"]))
        if progress and index % 100 == 0:
            print(f"  QUL phrase details {index}/{len(candidates)}", flush=True)
        time.sleep(REQUEST_PAUSE_SECONDS)

    data = {"phrases": phrases, "phrase_verses": phrase_verses}
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    QUL_SCRAPE_CACHE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data, "qul-scrape"


def load_qul_source(refresh: bool, progress: bool) -> tuple[dict[str, Any], str]:
    local = None if refresh else load_qul_json()
    if local:
        return local
    return scrape_qul_source(refresh=refresh, progress=progress)


def phrase_word_count(phrase: dict[str, Any]) -> int:
    if "words_count" in phrase:
        return int(phrase["words_count"])
    source = phrase.get("source") or {}
    if "from" in source and "to" in source:
        return range_len([int(source["from"]), int(source["to"])])
    ranges = phrase.get("ayah", {})
    lengths = [range_len(word_range) for ayah_ranges in ranges.values() for word_range in ayah_ranges]
    return max(lengths, default=0)


def phrase_ayah_coverage(phrase_len: int, ref: str, by_ref: dict[str, dict[str, Any]]) -> float:
    ayah_words = indexed_word_count(by_ref[ref]["ar"])
    return phrase_len / ayah_words if ayah_words else 0.0


def relation_passes_filter(phrase: dict[str, Any], ref: str, by_ref: dict[str, dict[str, Any]]) -> bool:
    count = int(phrase.get("count") or 0)
    if not (2 <= count <= BROAD_MAX_REPEAT_COUNT):
        return False
    phrase_len = phrase_word_count(phrase)
    if phrase_len >= BROAD_MIN_WORDS:
        return True
    return phrase_ayah_coverage(phrase_len, ref, by_ref) >= BROAD_MIN_AYAH_COVERAGE


def iter_relations(
    source: dict[str, Any],
    by_ref: dict[str, dict[str, Any]],
    index_by_ref: dict[str, int],
) -> list[dict[str, Any]]:
    relations: list[dict[str, Any]] = []
    for phrase_id, phrase in source["phrases"].items():
        occurrences = {
            normalize_ref(ref): ranges
            for ref, ranges in (phrase.get("ayah") or {}).items()
            if normalize_ref(ref) in by_ref
        }
        if len(occurrences) < 2:
            continue
        ordered_refs = sorted(occurrences, key=lambda ref: index_by_ref[ref])
        for current_ref in ordered_refs:
            earlier_refs = [ref for ref in ordered_refs if index_by_ref[ref] < index_by_ref[current_ref]]
            if not earlier_refs:
                continue
            if not relation_passes_filter(phrase, current_ref, by_ref):
                continue
            previous_ref = earlier_refs[-1]
            relations.append(
                {
                    "phrase_id": str(phrase_id),
                    "current": current_ref,
                    "previous": previous_ref,
                    "currentRanges": occurrences[current_ref],
                    "previousRanges": occurrences[previous_ref],
                    "count": int(phrase.get("count") or len(occurrences)),
                    "words": phrase_word_count(phrase),
                    "coverage": phrase_ayah_coverage(phrase_word_count(phrase), current_ref, by_ref),
                    "text": phrase.get("phrase_text")
                    or phrase_text_for_ranges(current_ref, occurrences[current_ref], by_ref),
                }
            )
    return relations


def build(refresh: bool, progress: bool) -> None:
    ayat = load_quran_data()
    by_ref = {ref_key(ayah["s"], ayah["a"]): ayah for ayah in ayat}
    index_by_ref = {ref_key(ayah["s"], ayah["a"]): index for index, ayah in enumerate(ayat)}
    source, source_kind = load_qul_source(refresh=refresh, progress=progress)
    per_page: dict[int, list[dict[str, Any]]] = {page: [] for page in range(1, 605)}
    seen: set[tuple[str, str, str]] = set()
    relations = iter_relations(source, by_ref, index_by_ref)

    for relation in relations:
        current_ref = relation["current"]
        previous_ref = relation["previous"]
        pair_key = (relation["phrase_id"], current_ref, previous_ref)
        if pair_key in seen:
            continue
        seen.add(pair_key)
        current_page = int(by_ref[current_ref]["page"])
        previous_page = int(by_ref[previous_ref]["page"])
        previous_text = by_ref[previous_ref]["ar"]
        current_text = by_ref[current_ref]["ar"]
        previous_phrase_text = phrase_text_for_ranges(previous_ref, relation["previousRanges"], by_ref)
        current_phrase_text = phrase_text_for_ranges(current_ref, relation["currentRanges"], by_ref)
        previous_diff, current_diff = diff_words(
            previous_text,
            current_text,
            relation["previousRanges"],
            relation["currentRanges"],
        )
        previous_phrase_diff, current_phrase_diff = diff_words(previous_phrase_text, current_phrase_text)
        note = f"QUL phrase · {relation['words']} words · {relation['count']} repeats"
        per_page[current_page].append(
            {
                "id": make_id(relation["phrase_id"], current_ref, previous_ref),
                "phraseId": relation["phrase_id"],
                "phraseText": relation["text"],
                "current": current_ref,
                "currentAyat": [current_ref],
                "currentPage": current_page,
                "currentText": current_text,
                "currentPhraseText": current_phrase_text,
                "currentRanges": relation["currentRanges"],
                "previous": previous_ref,
                "previousAyat": [previous_ref],
                "previousPage": previous_page,
                "previousText": previous_text,
                "previousPhraseText": previous_phrase_text,
                "previousRanges": relation["previousRanges"],
                "repeatCount": relation["count"],
                "wordCount": relation["words"],
                "ayahCoverage": round(relation["coverage"], 3),
                "note": note,
                "previousDiff": previous_diff,
                "currentDiff": current_diff,
                "previousPhraseDiff": previous_phrase_diff,
                "currentPhraseDiff": current_phrase_diff,
            }
        )

    PAGE_DIR.mkdir(parents=True, exist_ok=True)
    manifest_pages: dict[str, dict[str, int]] = {}
    total_matches = 0
    for page in range(1, 605):
        matches = sorted(
            per_page[page],
            key=lambda item: (
                index_by_ref[item["currentAyat"][0]],
                index_by_ref[item["previousAyat"][0]],
                item["phraseId"],
            ),
        )
        total_matches += len(matches)
        manifest_pages[str(page)] = {"matches": len(matches)}
        js_page_write(PAGE_DIR / f"{page}.js", "QURAN_MUTASHABIHAT_PAGES", page, {"page": page, "matches": matches})
        if progress and page % 50 == 0:
            print(f"  mutashabihat pages {page}/604")

    manifest = {
        "sources": {
            "qul": QUL_RESOURCE_URL,
            "qulPublicPhraseIndex": QUL_PHRASES_URL,
        },
        "schema": "quran-test-mutashabihat/v1",
        "profile": "qul-hifz-sensitive",
        "sourceKind": source_kind,
        "filters": {
            "maxRepeatCount": BROAD_MAX_REPEAT_COUNT,
            "minWords": BROAD_MIN_WORDS,
            "minAyahCoverage": BROAD_MIN_AYAH_COVERAGE,
            "memorizedRange": "previous ayat only",
        },
        "pages": manifest_pages,
        "totalMatches": total_matches,
        "uniquePhrases": len(source["phrases"]),
        "relations": len(relations),
    }
    js_write(DATA_DIR / "mutashabihat-manifest.js", "QURAN_MUTASHABIHAT_MANIFEST", manifest)
    print(f"Wrote {total_matches} QUL mutashabihat page matches from {len(source['phrases'])} phrases ({source_kind})")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true", help="refresh QUL scrape cache or reread local JSON")
    parser.add_argument("--progress", action="store_true", help="print generation progress")
    args = parser.parse_args()
    build(refresh=args.refresh, progress=args.progress)


if __name__ == "__main__":
    main()
