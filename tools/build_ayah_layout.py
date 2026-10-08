#!/usr/bin/env -S uv run
# /// script
# dependencies = [
#   "numpy>=2.0",
#   "opencv-python-headless>=4.10",
# ]
# ///
"""Build normalized ayah layout boxes from mushaf page images.

The browser app highlights a revealed ayah over a page image. This script
generates a resolution-independent map for that overlay:

1. Detect the visual text/title rows in each page image.
2. Fetch Quran.com word metadata for the page so each token has a mushaf line.
3. Assign each ayah one or more normalized boxes on the page.

The coordinates are fractions of the underlying image dimensions, so replacing
the page images with higher-resolution files should not require a new UI model.
Regenerate the map anyway when the artwork/crop changes.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
PAGE_DIR = ROOT / "assets" / "pages"
PAGE_LAYOUT_DIR = DATA_DIR / "ayah-layout-pages"

QURAN_COM_PAGE = (
    "https://api.quran.com/api/v4/verses/by_page/{page}"
    "?words=true&word_fields=line_number,page_number,position,text_uthmani&per_page=all"
)
HEADERS = {"User-Agent": "quran-layout-builder/1.0"}


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()
    except urllib.error.URLError:
        return subprocess.check_output(
            ["curl", "-fsSL", "--retry", "3", "-H", f"User-Agent: {HEADERS['User-Agent']}", url],
            timeout=180,
        )


def get_json(url: str) -> dict[str, Any]:
    return json.loads(fetch_bytes(url))


def js_write(path: Path, name: str, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    path.write_text(f"window.{name}={body};\n", encoding="utf-8")


def norm_box(x1: int, y1: int, x2: int, y2: int, width: int, height: int) -> dict[str, float]:
    x1 = max(0, min(width, x1))
    x2 = max(0, min(width, x2))
    y1 = max(0, min(height, y1))
    y2 = max(0, min(height, y2))
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    return {
        "x": round(x1 / width, 5),
        "y": round(y1 / height, 5),
        "w": round((x2 - x1) / width, 5),
        "h": round((y2 - y1) / height, 5),
    }


def ink_mask(image: np.ndarray) -> np.ndarray:
    """Return a binary mask for dark or saturated mushaf ink."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)

    dark = gray < 160
    saturated = (hsv[:, :, 1] > 75) & (hsv[:, :, 2] < 235)
    mask = (dark | saturated).astype(np.uint8)

    height, width = mask.shape
    # Ignore decorative borders, page headers, and the tajweed legend/footer.
    mask[:, : int(width * 0.035)] = 0
    mask[:, int(width * 0.965) :] = 0
    mask[: int(height * 0.02), :] = 0
    mask[int(height * 0.925) :, :] = 0
    return mask


def row_runs(rows: np.ndarray, threshold: float, min_height: int) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, value in enumerate(rows):
        if value > threshold and start is None:
            start = index
        if start is not None and (value <= threshold or index == len(rows) - 1):
            end = index if value <= threshold else index + 1
            if end - start >= min_height:
                runs.append((start, end))
            start = None
    return runs


def merge_close_runs(runs: list[tuple[int, int]], max_gap: int) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for start, end in runs:
        if merged and start - merged[-1][1] <= max_gap:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def split_tall_runs(
    runs: list[tuple[int, int]],
    rows: np.ndarray,
    expected_count: int | None,
    min_height: int,
) -> list[tuple[int, int]]:
    if not expected_count:
        return runs

    expanded = list(runs)
    while len(expanded) < expected_count:
        heights = np.array([end - start for start, end in expanded], dtype=np.float64)
        if heights.size == 0:
            break
        median = float(np.median(heights))
        candidates = sorted(
            range(len(expanded)),
            key=lambda index: expanded[index][1] - expanded[index][0],
            reverse=True,
        )
        split_index = candidates[0]
        start, end = expanded[split_index]
        if end - start < max(min_height * 2, median * 1.35):
            break

        low = start + min_height
        high = end - min_height
        if low >= high:
            break
        middle_low = start + int((end - start) * 0.35)
        middle_high = start + int((end - start) * 0.65)
        low = max(low, middle_low)
        high = min(high, middle_high)
        valley = low + int(np.argmin(rows[low:high]))
        expanded[split_index : split_index + 1] = [(start, valley), (valley, end)]
    return expanded


def detect_line_boxes(image: np.ndarray, expected_count: int | None = None) -> dict[int, dict[str, Any]]:
    height, width = image.shape[:2]
    mask = ink_mask(image)
    rows = mask.sum(axis=1)
    threshold = max(8, width * 0.02)
    min_height = max(4, int(height * 0.008))
    runs = merge_close_runs(row_runs(rows, threshold, min_height), max_gap=max(1, int(height * 0.002)))
    runs = split_tall_runs(runs, rows, expected_count, min_height)

    lines: dict[int, dict[str, Any]] = {}
    pad_x = max(4, int(width * 0.012))
    pad_y = max(3, int(height * 0.008))

    for line_number, (y1, y2) in enumerate(runs, start=1):
        crop = mask[y1:y2, :]
        cols = crop.sum(axis=0)
        xs = np.flatnonzero(cols)
        if xs.size == 0:
            continue
        x1 = max(0, int(xs.min()) - pad_x)
        x2 = min(width, int(xs.max()) + pad_x + 1)
        yy1 = max(0, y1 - pad_y)
        yy2 = min(height, y2 + pad_y)
        lines[line_number] = {
            "px": [x1, yy1, x2, yy2],
            "box": norm_box(x1, yy1, x2, yy2, width, height),
        }
    return lines


def tokens_for_page(page: int) -> list[dict[str, Any]]:
    data = get_json(QURAN_COM_PAGE.format(page=page))
    tokens: list[dict[str, Any]] = []
    for verse in data.get("verses", []):
        verse_key = verse.get("verse_key")
        for word in verse.get("words", []):
            line_number = word.get("line_number")
            if not line_number:
                continue
            tokens.append(
                {
                    "ayah": verse_key,
                    "line": int(line_number),
                    "position": int(word.get("position") or 0),
                    "type": word.get("char_type_name") or "word",
                    "text": word.get("text_uthmani") or word.get("text") or "",
                }
            )
    return tokens


def token_weight(token: dict[str, Any]) -> float:
    text = str(token.get("text") or "")
    # End markers are visually wider than their one-character text.
    if token.get("type") == "end":
        return 2.4
    letters = [char for char in text if "\u0600" <= char <= "\u06ff"]
    return max(1.0, float(len(letters)))


def segment_line(
    page: int,
    line_number: int,
    line_tokens: list[dict[str, Any]],
    line_box: dict[str, Any],
    width: int,
    height: int,
) -> dict[str, list[dict[str, Any]]]:
    x1, y1, x2, y2 = line_box["px"]
    line_width = max(1, x2 - x1)
    ranges: dict[str, list[int]] = {}
    word_positions: dict[str, list[int]] = defaultdict(list)
    for index, token in enumerate(line_tokens):
        ayah = token["ayah"]
        if ayah not in ranges:
            ranges[ayah] = [index, index]
        else:
            ranges[ayah][1] = index
        if token.get("type") == "word" and token.get("position"):
            word_positions[ayah].append(int(token["position"]))

    boxes_by_ayah: dict[str, list[dict[str, Any]]] = defaultdict(list)
    weights = [token_weight(token) for token in line_tokens]
    total = sum(weights) or 1.0
    cumulative = [0.0]
    for weight in weights:
        cumulative.append(cumulative[-1] + weight)

    pad_x = max(3, int(width * 0.01))
    for ayah, (start, end) in ranges.items():
        right = x2 - round((cumulative[start] / total) * line_width) + pad_x
        left = x2 - round((cumulative[end + 1] / total) * line_width) - pad_x
        box = norm_box(left, y1, right, y2, width, height)
        box["l"] = line_number
        box["p"] = page
        if word_positions.get(ayah):
            box["s"] = min(word_positions[ayah])
            box["e"] = max(word_positions[ayah])
        boxes_by_ayah[ayah].append(box)
    return boxes_by_ayah


def layout_page(page: int) -> tuple[dict[str, Any], dict[str, dict[str, list[dict[str, Any]]]]]:
    image_path = PAGE_DIR / f"{page}.jpg"
    image = cv2.imread(str(image_path))
    if image is None:
        raise FileNotFoundError(f"Could not read page image: {image_path}")

    height, width = image.shape[:2]
    tokens = tokens_for_page(page)
    expected_lines = max((token["line"] for token in tokens), default=None)
    lines = detect_line_boxes(image, expected_lines)
    tokens_by_line: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for token in tokens:
        tokens_by_line[token["line"]].append(token)

    ayat: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(dict)
    for line_number, line_tokens in sorted(tokens_by_line.items()):
        line_box = lines.get(line_number)
        if not line_box:
            print(f"page {page}: missing detected line {line_number}", file=sys.stderr)
            continue
        segmented = segment_line(page, line_number, line_tokens, line_box, width, height)
        for ayah, boxes in segmented.items():
            ayat[ayah].setdefault(str(page), []).extend(boxes)

    page_info = {
        "w": width,
        "h": height,
        "lines": {str(k): v["box"] for k, v in sorted(lines.items())},
    }
    return page_info, ayat


def merge_ayah_layout(
    target: dict[str, dict[str, list[dict[str, Any]]]],
    addition: dict[str, dict[str, list[dict[str, Any]]]],
) -> None:
    for ayah, pages in addition.items():
        by_page = target.setdefault(ayah, {})
        for page, boxes in pages.items():
            by_page.setdefault(page, []).extend(boxes)


def page_range(args: argparse.Namespace) -> list[int]:
    if args.page:
        return [args.page]
    start = args.start_page or 1
    end = args.end_page or 604
    if start > end:
        start, end = end, start
    return list(range(start, end + 1))


def page_payload(page_info: dict[str, Any], ayah_layout: dict[str, dict[str, list[dict[str, Any]]]], page: int) -> dict[str, Any]:
    return {
        "version": 1,
        "coordinateSpace": "image-fraction",
        "page": page_info,
        "ayat": {ayah: pages[str(page)] for ayah, pages in sorted(ayah_layout.items()) if str(page) in pages},
    }


def page_js(page: int, payload: dict[str, Any]) -> str:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return (
        "window.QURAN_AYAH_LAYOUT_PAGES=window.QURAN_AYAH_LAYOUT_PAGES||{};"
        f"window.QURAN_AYAH_LAYOUT_PAGES[{json.dumps(str(page))}]={body};\n"
    )


def build_layout(args: argparse.Namespace) -> dict[str, Any]:
    pages: dict[str, Any] = {}
    ayat: dict[str, dict[str, list[dict[str, Any]]]] = {}
    selected_pages = page_range(args)

    for index, page in enumerate(selected_pages, start=1):
        page_info, ayah_layout = layout_page(page)
        pages[str(page)] = page_info
        merge_ayah_layout(ayat, ayah_layout)
        if args.progress and (index == 1 or index == len(selected_pages) or index % 25 == 0):
            print(f"layout pages {index}/{len(selected_pages)}")
        if args.pause:
            time.sleep(args.pause)

    return {
        "version": 1,
        "coordinateSpace": "image-fraction",
        "description": "Normalized boxes are fractions of each page image: x, y, w, h.",
        "pages": pages,
        "ayat": dict(sorted(ayat.items())),
    }


def write_page_layouts(args: argparse.Namespace) -> dict[str, Any]:
    out_dir = args.pages_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "version": 1,
        "coordinateSpace": "image-fraction",
        "pages": {},
    }
    selected_pages = page_range(args)

    for index, page in enumerate(selected_pages, start=1):
        page_info, ayah_layout = layout_page(page)
        manifest["pages"][str(page)] = {
            "w": page_info["w"],
            "h": page_info["h"],
            "ayat": len(ayah_layout),
        }
        payload = page_payload(page_info, ayah_layout, page)
        (out_dir / f"{page}.js").write_text(page_js(page, payload), encoding="utf-8")
        if args.progress and (index == 1 or index == len(selected_pages) or index % 25 == 0):
            print(f"layout pages {index}/{len(selected_pages)}")
        if args.pause:
            time.sleep(args.pause)

    js_write(DATA_DIR / "ayah-layout-manifest.js", "QURAN_AYAH_LAYOUT_MANIFEST", manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--page", type=int, help="Build one page only.")
    parser.add_argument("--start-page", type=int, help="First page for a range build.")
    parser.add_argument("--end-page", type=int, help="Last page for a range build.")
    parser.add_argument("--output", type=Path, help="Optional single bundled JS output file.")
    parser.add_argument("--pages-dir", type=Path, default=PAGE_LAYOUT_DIR, help="Directory for per-page JS files.")
    parser.add_argument("--progress", action="store_true", help="Print progress while building.")
    parser.add_argument("--pause", type=float, default=0.0, help="Optional delay between API calls.")
    args = parser.parse_args()

    if args.output:
        layout = build_layout(args)
        js_write(args.output, "QURAN_AYAH_LAYOUT", layout)
        print(f"Wrote {len(layout['ayat'])} ayah layouts for {len(layout['pages'])} pages to {args.output}")
    else:
        manifest = write_page_layouts(args)
        print(f"Wrote ayah layout files for {len(manifest['pages'])} pages to {args.pages_dir}")


if __name__ == "__main__":
    main()
