#!/usr/bin/env python3
"""Build per-page Hifz chunk data for the static app.

This is adapted from /Users/mahdi/dev/quran/hifz_chunker.py. It keeps the
structural chunking rules and emits browser-loadable JS files, one per mushaf
page, so the UI can overlay memorization chunks on the existing page images.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
OUT_DIR = DATA_DIR / "hifz-chunks-pages"
CACHE = Path(os.environ.get("HIFZ_CACHE", Path.home() / ".cache" / "hifz-chunker"))

PACKAGES = {
    "quran-qcf4": ("https://registry.npmjs.org/quran-qcf4/-/quran-qcf4-1.1.0.tgz", "package/pages/"),
    "quran-json": ("https://registry.npmjs.org/quran-json/-/quran-json-3.1.2.tgz", "package/dist/chapters/"),
}
HEADERS = {"User-Agent": "quran-hifz-static/1.0"}

VERSE_END = 3.0
WAQF = {
    "ۘ": (3.0, "waqf lazim (must stop)"),
    "ۗ": (2.5, "qili - stopping preferred"),
    "ۚ": (2.0, "jaiz - stop or continue"),
    "ۖ": (1.5, "sili - continuing preferred"),
    "ۛ": (1.0, "mu'anaqa - stop at one of the pair"),
}
CUT_PENALTY = {3.0: 0.0, 2.5: 0.4, 2.0: 0.9, 1.5: 1.6, 1.0: 2.5}
PAGE_EDGE_PENALTY = 3.0
PARTICLE_WORDS = {
    "إن",
    "إنا",
    "إنه",
    "إنهم",
    "لقد",
    "ثم",
    "أولئك",
    "قل",
    "إذ",
    "إذا",
    "كذلك",
    "ولقد",
    "وإن",
    "وإذ",
    "فإن",
    "فلما",
    "ولما",
    "أفلا",
    "ألم",
}
STRIP = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]")


def bare(word: str) -> str:
    w = STRIP.sub("", word)
    return w.replace("ٱ", "ا").replace("أ", "ا").replace("إ", "ا").replace("آ", "ا")


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


def ensure_data(data_dir: Path) -> None:
    for name, (url, keep) in PACKAGES.items():
        dest = data_dir / name
        if (dest / ".complete").exists():
            continue
        print(f"fetching {name} (one-time)...", file=sys.stderr)
        blob = io.BytesIO(fetch_bytes(url))
        with tarfile.open(fileobj=blob, mode="r:gz") as tar:
            for member in tar.getmembers():
                rest = member.name[len(keep):]
                if not (member.isfile() and member.name.startswith(keep) and "/" not in rest and rest.endswith(".json")):
                    continue
                rel = member.name[len("package/"):]
                out = dest / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                extracted = tar.extractfile(member)
                if extracted:
                    out.write_bytes(extracted.read())
        (dest / ".complete").touch()


def read_json(data_dir: Path, rel: str) -> Any:
    return json.loads((data_dir / rel).read_text(encoding="utf-8"))


def load_page(page: int, data_dir: Path) -> dict[str, Any]:
    return read_json(data_dir, f"quran-qcf4/pages/{page:03d}.json")


text_cache: dict[int, dict[int, str]] = {}


def load_sura_text(sura: int, data_dir: Path) -> dict[int, str]:
    if sura not in text_cache:
        data = read_json(data_dir, f"quran-json/dist/chapters/{sura}.json")
        text_cache[sura] = {verse["id"]: verse["text"] for verse in data["verses"]}
    return text_cache[sura]


@dataclass
class Word:
    page: int
    line: int
    verse: str
    pos: int
    text: str
    weight: float = 0.0
    cut: float = 0.0
    cut_reason: str = ""
    page_edge_after: bool = False


@dataclass
class Chunk:
    words: list[Word]

    @property
    def lines(self) -> float:
        return sum(word.weight for word in self.words)

    @property
    def text(self) -> str:
        return " ".join(word.text for word in self.words)

    @property
    def verses(self) -> str:
        first, last = self.words[0], self.words[-1]
        if first.verse == last.verse:
            return first.verse
        first_sura, _ = first.verse.split(":")
        last_sura, last_ayah = last.verse.split(":")
        return f"{first.verse}–{last_ayah}" if first_sura == last_sura else f"{first.verse}–{last.verse}"

    @property
    def pages(self) -> set[int]:
        return {word.page for word in self.words}


@dataclass
class Seam:
    left: Chunk
    right: Chunk
    flags: list[str] = field(default_factory=list)

    @property
    def cue(self) -> str:
        return " ".join(word.text for word in self.left.words[-2:])

    @property
    def response(self) -> str:
        return " ".join(word.text for word in self.right.words[:3])

    @property
    def weak(self) -> bool:
        return any(flag.startswith("mid-ayah") or flag.startswith("page") for flag in self.flags)


def attach_uthmani(words: list[Word], data_dir: Path) -> list[str]:
    warnings: list[str] = []
    by_verse: dict[str, list[Word]] = defaultdict(list)
    for word in words:
        by_verse[word.verse].append(word)

    for verse_key, verse_words in by_verse.items():
        sura, ayah = map(int, verse_key.split(":"))
        raw = load_sura_text(sura, data_dir).get(ayah, "")
        tokens = [token for token in raw.replace("۞", "").replace("۩", "").split() if re.search(r"[ء-يٱ]", token)]
        layout_count = max(word.pos for word in verse_words)
        exact = len(tokens) >= layout_count
        if not exact:
            warnings.append(f"{verse_key}: text/layout word counts differ; waqf marks approximated")
        for word in verse_words:
            if not tokens:
                continue
            index = word.pos - 1 if exact else round((word.pos - 1) * (len(tokens) - 1) / max(layout_count - 1, 1))
            token = tokens[min(index, len(tokens) - 1)]
            if exact:
                word.text = token
            for mark, (strength, reason) in WAQF.items():
                if mark in token and strength > word.cut:
                    word.cut = strength
                    word.cut_reason = reason
    return warnings


def build_words(page: int, data_dir: Path) -> tuple[list[Word], list[str]]:
    data = load_page(page, data_dir)
    words: list[Word] = []
    for line in data["lines"]:
        line_words = [word for word in line["words"] if word["type"] in ("word", "end")]
        real_words = [word for word in line_words if word["type"] == "word"]
        total = sum(len(bare(word["text"])) for word in real_words) or 1
        for word in line_words:
            if word["type"] == "end":
                if words and words[-1].verse == word["verse_key"]:
                    words[-1].cut = VERSE_END
                    words[-1].cut_reason = "end of ayah"
                continue
            words.append(
                Word(
                    page=page,
                    line=line["line"],
                    verse=word["verse_key"],
                    pos=word["position"],
                    text=word["text"],
                    weight=len(bare(word["text"])) / total,
                )
            )
    warnings = attach_uthmani(words, data_dir)
    if words:
        words[-1].page_edge_after = True
    return words, warnings


def sura_of(word: Word) -> int:
    return int(word.verse.split(":")[0])


def build_window(page: int, data_dir: Path, context: int) -> tuple[list[Word], list[Word], list[Word], list[str]]:
    words, warnings = build_words(page, data_dir)
    if not words:
        raise SystemExit(f"page {page} has no words")

    before: list[Word] = []
    after: list[Word] = []

    if page > 1 and context > 0:
        previous_words, previous_warnings = build_words(page - 1, data_dir)
        warnings += previous_warnings
        last_lines = sorted({word.line for word in previous_words})[-context:]
        tail = [word for word in previous_words if word.line in last_lines and sura_of(word) == sura_of(words[0])]
        if tail:
            best_index, best_strength = 0, -1.0
            for index, word in enumerate(tail[:-1]):
                if word.cut > best_strength:
                    best_index = index + 1
                    best_strength = word.cut
            before = tail[best_index:] if best_strength >= 2.0 else tail

    if page < 604 and context > 0:
        next_words, next_warnings = build_words(page + 1, data_dir)
        warnings += next_warnings
        first_lines = sorted({word.line for word in next_words})[:context]
        head = [word for word in next_words if word.line in first_lines and sura_of(word) == sura_of(words[-1])]
        if head:
            best_index, best_strength = len(head), -1.0
            for index, word in enumerate(head):
                if word.cut > best_strength or (word.cut == best_strength and word.cut > 0):
                    best_index = index + 1
                    best_strength = word.cut
            after = head[:best_index] if best_strength > 0 else head

    if before:
        before[-1].page_edge_after = True
    return before, words, after, sorted(set(warnings))


def chunk_cost(words: list[Word], target: float, lo: float, hi: float) -> float:
    line_count = sum(word.weight for word in words)
    internal_cut = any(word.cut > 0 for word in words[:-1])
    if line_count > hi and internal_cut:
        return float("inf")
    cost = (line_count - target) ** 2
    if line_count < lo:
        cost += 2.0 * (lo - line_count) ** 2 + 1.0
    end = words[-1]
    if end.cut:
        cost += CUT_PENALTY.get(end.cut, 2.0)
    if end.page_edge_after:
        cost += PAGE_EDGE_PENALTY
    return cost


def legal_ends(words: list[Word]) -> list[int]:
    return [index for index, word in enumerate(words) if word.cut > 0] + [len(words) - 1]


def dp_chunks(words: list[Word], target: float, lo: float, hi: float) -> list[int]:
    ends = sorted(set(legal_ends(words)))
    best: dict[int, tuple[float, list[int]]] = {-1: (0.0, [])}
    for end in ends:
        candidates = []
        for start, (cost, path) in best.items():
            if start >= end:
                continue
            chunk_price = chunk_cost(words[start + 1:end + 1], target, lo, hi)
            if chunk_price < float("inf"):
                candidates.append((cost + chunk_price, path + [end]))
        if candidates:
            best[end] = min(candidates, key=lambda item: item[0])
    return best.get(len(words) - 1, (0.0, ends))[1]


def split(words: list[Word], ends: list[int]) -> list[Chunk]:
    chunks: list[Chunk] = []
    start = 0
    for end in ends:
        chunks.append(Chunk(words[start:end + 1]))
        start = end + 1
    return chunks


def make_seams(chunks: list[Chunk]) -> list[Seam]:
    seams: list[Seam] = []
    bare_particles = {bare(word) for word in PARTICLE_WORDS}
    for left, right in zip(chunks, chunks[1:]):
        seam = Seam(left, right)
        end = left.words[-1]
        if end.cut != VERSE_END:
            seam.flags.append(f"mid-ayah cut ({end.cut_reason})")
        else:
            seam.flags.append("ayah boundary")

        first = bare(right.words[0].text)
        if first in bare_particles or (len(first) > 2 and first[0] in "وف" and first not in {"في", "فيه", "فيها"}):
            seam.flags.append(f"particle opener ({right.words[0].text})")
        if end.page != right.words[0].page:
            seam.flags.append(f"page edge {end.page}->{right.words[0].page} at this seam")
        seams.append(seam)
    return seams


def sorted_verse_keys(keys: set[str]) -> list[str]:
    return sorted(keys, key=lambda key: tuple(map(int, key.split(":"))))


def chunk_color_key(chunk: Chunk, page: int) -> str:
    pages = chunk.pages
    if page - 1 in pages:
        return f"edge:{page - 1}-{page}"
    if page + 1 in pages:
        return f"edge:{page}-{page + 1}"
    first, last = chunk.words[0], chunk.words[-1]
    return f"chunk:{first.verse}:{first.pos}-{last.verse}:{last.pos}"


def chunk_payload(chunk: Chunk, index: int, page: int) -> dict[str, Any]:
    visible_ayat = sorted_verse_keys({word.verse for word in chunk.words if word.page == page})
    return {
        "i": index,
        "colorKey": chunk_color_key(chunk, page),
        "verses": chunk.verses,
        "lines": round(chunk.lines, 2),
        "pages": sorted(chunk.pages),
        "visibleAyat": visible_ayat,
        "ends": chunk.words[-1].cut_reason or "window end",
        "weakEnd": chunk.words[-1].cut != VERSE_END,
    }


def page_payload(page: int, args: argparse.Namespace) -> dict[str, Any]:
    before, words, after, warnings = build_window(page, args.data_dir, args.context)
    window = before + words + after
    chunks = split(window, dp_chunks(window, args.target, args.lo, args.hi))
    seams = make_seams(chunks)
    visible_chunks = [chunk_payload(chunk, index, page) for index, chunk in enumerate(chunks, start=1)]

    return {
        "version": 1,
        "page": page,
        "range": f"{words[0].verse} -> {words[-1].verse}",
        "context": {
            "before": {"page": page - 1, "line": before[0].line} if before else None,
            "after": {"page": page + 1, "line": after[-1].line} if after else None,
        },
        "settings": {"target": args.target, "min": args.lo, "max": args.hi, "context": args.context},
        "chunks": visible_chunks,
        "seams": [
            {
                "from": index,
                "to": index + 1,
                "cue": seam.cue,
                "response": seam.response,
                "flags": seam.flags,
                "weak": seam.weak,
            }
            for index, seam in enumerate(seams, start=1)
        ],
        "warnings": warnings,
    }


def js_page(page: int, payload: dict[str, Any]) -> str:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return (
        "window.QURAN_HIFZ_CHUNK_PAGES=window.QURAN_HIFZ_CHUNK_PAGES||{};"
        f"window.QURAN_HIFZ_CHUNK_PAGES[{json.dumps(str(page))}]={body};\n"
    )


def js_write(path: Path, name: str, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    path.write_text(f"window.{name}={body};\n", encoding="utf-8")


def page_range(args: argparse.Namespace) -> list[int]:
    if args.page:
        return [args.page]
    start = args.start_page or 1
    end = args.end_page or 604
    if start > end:
        start, end = end, start
    return list(range(start, end + 1))


def build(args: argparse.Namespace) -> dict[str, Any]:
    ensure_data(args.data_dir)
    args.pages_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "version": 1,
        "settings": {"target": args.target, "min": args.lo, "max": args.hi, "context": args.context},
        "pages": {},
    }
    pages = page_range(args)
    for index, page in enumerate(pages, start=1):
        payload = page_payload(page, args)
        (args.pages_dir / f"{page}.js").write_text(js_page(page, payload), encoding="utf-8")
        manifest["pages"][str(page)] = {
            "range": payload["range"],
            "chunks": len(payload["chunks"]),
            "seams": len(payload["seams"]),
        }
        if args.progress and (index == 1 or index == len(pages) or index % 25 == 0):
            print(f"hifz pages {index}/{len(pages)}")
        if args.pause:
            time.sleep(args.pause)
    js_write(DATA_DIR / "hifz-chunks-manifest.js", "QURAN_HIFZ_CHUNKS_MANIFEST", manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--page", type=int, help="Build one page only.")
    parser.add_argument("--start-page", type=int, help="First page for a range build.")
    parser.add_argument("--end-page", type=int, help="Last page for a range build.")
    parser.add_argument("--target", type=float, default=4.5, help="Target chunk size in lines.")
    parser.add_argument("--min", dest="lo", type=float, default=3.0, help="Soft minimum lines.")
    parser.add_argument("--max", dest="hi", type=float, default=6.5, help="Hard maximum lines.")
    parser.add_argument("--context", type=int, default=1, help="Neighboring page context lines.")
    parser.add_argument("--data-dir", type=Path, default=CACHE, help="Cached hifz source data.")
    parser.add_argument("--pages-dir", type=Path, default=OUT_DIR, help="Output directory for per-page JS files.")
    parser.add_argument("--progress", action="store_true", help="Print progress.")
    parser.add_argument("--pause", type=float, default=0.0, help="Optional delay between pages.")
    args = parser.parse_args()

    for page in page_range(args):
        if not 1 <= page <= 604:
            parser.error("page must be 1-604")

    manifest = build(args)
    print(f"Wrote Hifz chunk files for {len(manifest['pages'])} pages to {args.pages_dir}")


if __name__ == "__main__":
    main()
