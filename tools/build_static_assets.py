#!/usr/bin/env python3
"""Build static Quran Tester assets.

Downloads the source Quran text, Quran.com page-line metadata, and Madinah
mushaf page images, then writes browser-loadable static files.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
PAGE_DIR = ROOT / "assets" / "pages"

QURAN_URL = "https://raw.githubusercontent.com/gadingnst/quran-api/master/data/quran.json"
QURAN_COM_PAGE = (
    "https://api.quran.com/api/v4/verses/by_page/{page}"
    "?words=true&word_fields=line_number,page_number&per_page=all"
)
PAGE_IMAGE = (
    "https://raw.githubusercontent.com/QuranHub/quran-pages-images/main/"
    "easyquran.com/hafs-tajweed/{page}.jpg"
)

HEADERS = {"User-Agent": "quran-recall-static/1.0"}


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


def get_json(url: str) -> dict:
    return json.loads(fetch_bytes(url))


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(fetch_bytes(url))
    tmp.replace(dest)


def js_write(path: Path, name: str, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    path.write_text(f"window.{name}={body};\n", encoding="utf-8")


def build_quran_data() -> list[dict]:
    print("Downloading Quran text...")
    raw = get_json(QURAN_URL)
    ayat = []
    for surah in raw["data"]:
        s_num = int(surah["number"])
        s_ar = surah["name"]["short"]
        s_en = surah["name"]["transliteration"]["en"]
        for verse in surah["verses"]:
            ayat.append(
                {
                    "s": s_num,
                    "s_ar": s_ar,
                    "s_en": s_en,
                    "a": int(verse["number"]["inSurah"]),
                    "page": int(verse["meta"]["page"]),
                    "ar": verse["text"]["arab"].replace("\ufeff", "").strip(),
                    "en": verse["translation"]["en"].strip(),
                }
            )
    js_write(DATA_DIR / "quran-data.js", "QURAN_AYAT", ayat)
    print(f"Wrote {len(ayat)} ayat to data/quran-data.js")
    return ayat


def page_line_bands(page: int) -> dict[str, dict[str, list[int]]]:
    data = get_json(QURAN_COM_PAGE.format(page=page))
    bands: dict[str, dict[str, list[int]]] = {}
    for verse in data.get("verses", []):
        key = verse.get("verse_key")
        if not key:
            continue
        by_page: dict[str, list[int]] = {}
        for word in verse.get("words", []):
            p = word.get("page_number")
            line = word.get("line_number")
            if not p or not line:
                continue
            p_key = str(p)
            if p_key not in by_page:
                by_page[p_key] = [line, line]
            else:
                by_page[p_key][0] = min(by_page[p_key][0], line)
                by_page[p_key][1] = max(by_page[p_key][1], line)
        if by_page:
            bands[key] = by_page
    return bands


def build_line_bands() -> None:
    print("Downloading Quran.com line metadata...")
    all_bands: dict[str, dict[str, list[int]]] = {}
    for page in range(1, 605):
        for attempt in range(1, 4):
            try:
                all_bands.update(page_line_bands(page))
                break
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt == 3:
                    raise
                print(f"  page {page}: retrying after {exc}", file=sys.stderr)
                time.sleep(attempt * 1.5)
        if page % 50 == 0:
            print(f"  metadata pages {page}/604")
    js_write(DATA_DIR / "line-bands.js", "QURAN_LINE_BANDS", all_bands)
    print(f"Wrote {len(all_bands)} verse line bands to data/line-bands.js")


def fetch_image(page: int) -> tuple[int, str]:
    dest = PAGE_DIR / f"{page}.jpg"
    if dest.exists() and dest.stat().st_size > 0:
        return page, "cached"
    for attempt in range(1, 4):
        try:
            download(PAGE_IMAGE.format(page=page), dest)
            return page, "downloaded"
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 3:
                return page, f"failed: {exc}"
            time.sleep(attempt * 1.5)
    return page, "failed"


def build_images() -> None:
    print("Downloading mushaf page images...")
    failures = []
    done = 0
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(fetch_image, page) for page in range(1, 605)]
        for fut in as_completed(futures):
            page, status = fut.result()
            done += 1
            if status.startswith("failed"):
                failures.append((page, status))
            if done % 50 == 0:
                print(f"  images {done}/604")
    if failures:
        for page, status in failures:
            print(f"Image page {page} {status}", file=sys.stderr)
        raise SystemExit(f"{len(failures)} image downloads failed")
    print("Wrote 604 page images to assets/pages/")


def main() -> None:
    os.chdir(ROOT)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PAGE_DIR.mkdir(parents=True, exist_ok=True)
    build_quran_data()
    build_line_bands()
    build_images()
    print("Static asset build complete.")


if __name__ == "__main__":
    main()
