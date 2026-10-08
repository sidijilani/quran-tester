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
import difflib
import hashlib
import json
import re
import time
import urllib.request
import zipfile
from collections import Counter, defaultdict
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
LOCAL_SCAN_NGRAM = 3
LOCAL_SCAN_MAX_ANCHOR_REPEAT = 12
LOCAL_SCAN_MIN_MATCHED_WORDS = 5
LOCAL_SCAN_LONG_BLOCK_MIN_WORDS = 5
LOCAL_SCAN_CONTEXT_WORDS = 3
LOCAL_SCAN_MIN_RATIO = 0.55
LOCAL_SCAN_MAX_SPAN_WORDS = 22
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


def ayah_indexed_tokens(ayah: dict[str, Any]) -> list[dict[str, Any]]:
    tokens: list[dict[str, Any]] = []
    source_index = 0
    for display_word in words(ayah["ar"]):
        norm = normalize_word(display_word)
        if not norm:
            continue
        source_index += 1
        tokens.append({"text": display_word, "norm": norm, "pos": source_index})
    return tokens


def contiguous_range_from_tokens(tokens: list[dict[str, Any]], start: int, end: int) -> list[list[int]]:
    if start >= end or start < 0 or end > len(tokens):
        return []
    return [[int(tokens[start]["pos"]), int(tokens[end - 1]["pos"])]]


def relation_ranges_overlap(left: list[list[int]], right: list[list[int]]) -> bool:
    for left_start, left_end in left:
        for right_start, right_end in right:
            if max(left_start, right_start) <= min(left_end, right_end):
                return True
    return False


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
    left_indexed = [(index, left_norm[index - 1]) for index in sorted(left_selected) if 0 <= index - 1 < len(left_norm)]
    right_indexed = [(index, right_norm[index - 1]) for index in sorted(right_selected) if 0 <= index - 1 < len(right_norm)]
    matcher = difflib.SequenceMatcher(
        None,
        [norm for _, norm in left_indexed],
        [norm for _, norm in right_indexed],
        autojunk=False,
    )
    left_same: set[int] = set()
    right_same: set[int] = set()
    for left_start, right_start, size in matcher.get_matching_blocks():
        for offset in range(size):
            left_same.add(left_indexed[left_start + offset][0])
            right_same.add(right_indexed[right_start + offset][0])

    left_out = [
        {"text": word, "kind": "same" if index in left_same else "diff"}
        for index, word in enumerate(left_words, start=1)
    ]
    right_out = [
        {"text": word, "kind": "same" if index in right_same else "diff"}
        for index, word in enumerate(right_words, start=1)
    ]

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


def build_local_near_match_relations(
    ayat: list[dict[str, Any]],
    by_ref: dict[str, dict[str, Any]],
    index_by_ref: dict[str, int],
) -> list[dict[str, Any]]:
    """Find hifz-style near matches that share anchors but differ in between.

    QUL's phrase data is excellent for exact repeated phrases, but many
    mutashabihat are similar frames with small connective changes. This scanner
    starts from repeated 3-word anchors, then keeps ayah pairs whose ordered
    matching blocks form a compact phrase-like span. A single long shared block
    with a different continuation is also kept, because those "same opening,
    different landing" cases are common hifz traps.
    """

    tokens_by_ref = {ref_key(ayah["s"], ayah["a"]): ayah_indexed_tokens(ayah) for ayah in ayat}
    ngram_occurrences: dict[tuple[str, ...], list[tuple[str, int]]] = defaultdict(list)
    for ref, tokens in tokens_by_ref.items():
        norms = [token["norm"] for token in tokens]
        seen_in_ayah: set[tuple[str, ...]] = set()
        for start in range(0, len(norms) - LOCAL_SCAN_NGRAM + 1):
            key = tuple(norms[start : start + LOCAL_SCAN_NGRAM])
            if key in seen_in_ayah:
                continue
            seen_in_ayah.add(key)
            ngram_occurrences[key].append((ref, start))

    rare_occurrences = {
        key: occurrences
        for key, occurrences in ngram_occurrences.items()
        if 2 <= len({ref for ref, _ in occurrences}) <= LOCAL_SCAN_MAX_ANCHOR_REPEAT
    }
    anchor_counts = {key: len({ref for ref, _ in occurrences}) for key, occurrences in rare_occurrences.items()}

    pair_anchor_counts: Counter[tuple[str, str]] = Counter()
    for occurrences in rare_occurrences.values():
        refs = sorted({ref for ref, _ in occurrences}, key=lambda ref: index_by_ref[ref])
        for right_index, current_ref in enumerate(refs):
            for previous_ref in refs[:right_index]:
                pair_anchor_counts[(previous_ref, current_ref)] += 1

    relations: list[dict[str, Any]] = []
    for (previous_ref, current_ref), anchor_count in pair_anchor_counts.items():
        if anchor_count < 2:
            continue
        previous_tokens = tokens_by_ref[previous_ref]
        current_tokens = tokens_by_ref[current_ref]
        previous_norms = [token["norm"] for token in previous_tokens]
        current_norms = [token["norm"] for token in current_tokens]
        matcher = difflib.SequenceMatcher(None, previous_norms, current_norms, autojunk=False)
        blocks = [block for block in matcher.get_matching_blocks() if block.size >= LOCAL_SCAN_NGRAM]
        best: dict[str, Any] | None = None
        for block in blocks:
            if block.size < LOCAL_SCAN_LONG_BLOCK_MIN_WORDS:
                continue
            previous_start = block.a
            current_start = block.b
            previous_end = block.a + block.size
            current_end = block.b + block.size
            previous_has_after = previous_end < len(previous_tokens)
            current_has_after = current_end < len(current_tokens)
            previous_has_before = previous_start > 0
            current_has_before = current_start > 0
            if previous_has_after and current_has_after:
                previous_end = min(len(previous_tokens), previous_end + LOCAL_SCAN_CONTEXT_WORDS)
                current_end = min(len(current_tokens), current_end + LOCAL_SCAN_CONTEXT_WORDS)
            elif previous_has_before and current_has_before:
                previous_start = max(0, previous_start - LOCAL_SCAN_CONTEXT_WORDS)
                current_start = max(0, current_start - LOCAL_SCAN_CONTEXT_WORDS)
            else:
                continue

            previous_span = previous_end - previous_start
            current_span = current_end - current_start
            if previous_span > LOCAL_SCAN_MAX_SPAN_WORDS or current_span > LOCAL_SCAN_MAX_SPAN_WORDS:
                continue
            first_key = tuple(previous_norms[block.a : block.a + LOCAL_SCAN_NGRAM])
            last_key = tuple(previous_norms[block.a + block.size - LOCAL_SCAN_NGRAM : block.a + block.size])
            repeat_count = max(anchor_counts.get(first_key, 2), anchor_counts.get(last_key, 2))
            span_words = max(previous_span, current_span)
            candidate = {
                "previous_start": previous_start,
                "previous_end": previous_end,
                "current_start": current_start,
                "current_end": current_end,
                "matched_words": block.size,
                "span_words": span_words,
                "ratio": block.size / span_words if span_words else 0.0,
                "repeat_count": repeat_count,
            }
            if best is None or (
                candidate["matched_words"],
                -candidate["span_words"],
                candidate["ratio"],
            ) > (
                best["matched_words"],
                -best["span_words"],
                best["ratio"],
            ):
                best = candidate

        for start_block_index, start_block in enumerate(blocks):
            for end_block in blocks[start_block_index + 1 :]:
                previous_start = start_block.a
                current_start = start_block.b
                previous_end = end_block.a + end_block.size
                current_end = end_block.b + end_block.size
                previous_span = previous_end - previous_start
                current_span = current_end - current_start
                if previous_span > LOCAL_SCAN_MAX_SPAN_WORDS or current_span > LOCAL_SCAN_MAX_SPAN_WORDS:
                    continue
                included_blocks = [
                    block
                    for block in blocks
                    if previous_start <= block.a and block.a + block.size <= previous_end
                    and current_start <= block.b
                    and block.b + block.size <= current_end
                ]
                matched_words = sum(block.size for block in included_blocks)
                span_words = max(previous_span, current_span)
                if matched_words < LOCAL_SCAN_MIN_MATCHED_WORDS:
                    continue
                ratio = matched_words / span_words if span_words else 0.0
                if ratio < LOCAL_SCAN_MIN_RATIO:
                    continue
                first_key = tuple(previous_norms[start_block.a : start_block.a + LOCAL_SCAN_NGRAM])
                last_key = tuple(
                    previous_norms[end_block.a + end_block.size - LOCAL_SCAN_NGRAM : end_block.a + end_block.size]
                )
                repeat_count = max(anchor_counts.get(first_key, 2), anchor_counts.get(last_key, 2))
                candidate = {
                    "previous_start": previous_start,
                    "previous_end": previous_end,
                    "current_start": current_start,
                    "current_end": current_end,
                    "matched_words": matched_words,
                    "span_words": span_words,
                    "ratio": ratio,
                    "repeat_count": repeat_count,
                }
                if best is None or (
                    candidate["matched_words"],
                    -candidate["span_words"],
                    candidate["ratio"],
                ) > (
                    best["matched_words"],
                    -best["span_words"],
                    best["ratio"],
                ):
                    best = candidate

        if not best:
            continue
        previous_ranges = contiguous_range_from_tokens(previous_tokens, best["previous_start"], best["previous_end"])
        current_ranges = contiguous_range_from_tokens(current_tokens, best["current_start"], best["current_end"])
        if not previous_ranges or not current_ranges:
            continue
        words_count = max(range_len(previous_ranges[0]), range_len(current_ranges[0]))
        coverage = phrase_ayah_coverage(words_count, current_ref, by_ref)
        if words_count < 4 and coverage < BROAD_MIN_AYAH_COVERAGE:
            continue
        digest = hashlib.sha1(
            f"{previous_ref}|{current_ref}|{previous_ranges}|{current_ranges}".encode("utf-8")
        ).hexdigest()[:10]
        relations.append(
            {
                "phrase_id": f"local-{digest}",
                "current": current_ref,
                "previous": previous_ref,
                "currentRanges": current_ranges,
                "previousRanges": previous_ranges,
                "count": int(best["repeat_count"]),
                "words": words_count,
                "coverage": coverage,
                "text": phrase_text_for_ranges(current_ref, current_ranges, by_ref),
                "source": "local-scan",
            }
        )

    return relations


def merge_relations(qul_relations: list[dict[str, Any]], local_relations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged = list(qul_relations)
    for relation in local_relations:
        duplicate = False
        for existing in merged:
            if relation["current"] != existing["current"] or relation["previous"] != existing["previous"]:
                continue
            if relation_ranges_overlap(relation["currentRanges"], existing["currentRanges"]) and relation_ranges_overlap(
                relation["previousRanges"], existing["previousRanges"]
            ):
                duplicate = True
                break
        if not duplicate:
            merged.append(relation)
    return merged


def build(refresh: bool, progress: bool) -> None:
    ayat = load_quran_data()
    by_ref = {ref_key(ayah["s"], ayah["a"]): ayah for ayah in ayat}
    index_by_ref = {ref_key(ayah["s"], ayah["a"]): index for index, ayah in enumerate(ayat)}
    source, source_kind = load_qul_source(refresh=refresh, progress=progress)
    per_page: dict[int, list[dict[str, Any]]] = {page: [] for page in range(1, 605)}
    seen: set[tuple[str, str, str]] = set()
    qul_relations = iter_relations(source, by_ref, index_by_ref)
    local_relations = build_local_near_match_relations(ayat, by_ref, index_by_ref)
    relations = merge_relations(qul_relations, local_relations)

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
        relation_source = relation.get("source") or "qul"
        note_prefix = "Near-match scan" if relation_source == "local-scan" else "QUL phrase"
        note = f"{note_prefix} · {relation['words']} words · {relation['count']} repeats"
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
                "source": relation_source,
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
            "localNearMatchScan": "repeated 3-word anchors with compact ordered near-match spans",
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
        "qulRelations": len(qul_relations),
        "localScanRelations": len(local_relations),
    }
    js_write(DATA_DIR / "mutashabihat-manifest.js", "QURAN_MUTASHABIHAT_MANIFEST", manifest)
    print(
        f"Wrote {total_matches} mutashabihat page matches "
        f"({len(qul_relations)} QUL, {len(local_relations)} local scan; {source_kind})"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true", help="refresh QUL scrape cache or reread local JSON")
    parser.add_argument("--progress", action="store_true", help="print generation progress")
    args = parser.parse_args()
    build(refresh=args.refresh, progress=args.progress)


if __name__ == "__main__":
    main()
