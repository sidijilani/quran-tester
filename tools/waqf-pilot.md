# Waqf PDF extraction pilot

The pilot extracts PDF pages **5, 6, 7, 100, 278, 500, 554**, covering the
beginning, middle, end, repeated phrases, different table styles, and multiple
headings in one table. This is a fixed coverage sample, not a complete import.

## Text reference

The Hafs reference uses only existing local text:

- `data/quran-data.js`: full Arabic ayat, including existing stop signs.
- `data/line-bands.js`: verse-to-page metadata already extracted from Quran.com
  by `build_static_assets.py`. Only its page keys are used; line ranges are not
  used for matching.

No mushaf image, image-layout file, geometry, or QCF font/token cache is read.
No Quran download is needed. The reference's tokenization defines word indices,
so differences between text tokens and image tokens do not affect this pilot.

## Run

```sh
uv run tools/build_waqf_pilot.py
```

The script declares its pdfplumber dependency. Poppler (`pdftoppm`) renders only
optional source-PDF evidence; Hafs matching uses no rendered artwork or OCR.

To change the sample:

```sh
uv run tools/build_waqf_pilot.py --pages 5-7,100,278,500,554
```

`--skip-render` reuses the existing source-PDF PNGs. Extraction, matching, and the
normal text review still work without those PNGs. Rerender if the source changes.
The parser is validated on the seven sampled pages; unrecognized table rows
raise an error instead of disappearing silently.

Tests:

```sh
uv run --with 'pdfplumber>=0.11,<0.12' python -m unittest discover \
  -s tools -p 'test_waqf_pilot.py' -v
```

## Source encoding

The PDF introduction, page 3, says the work was reviewed using **Qalun an Nafi**.
The local reference text is Hafs. Matching wording and page numbers establishes
location; it does not establish that every proposed waqf category applies to Hafs.

Each table has three semantic columns, from right to left:

1. Word or phrase to stop **after**, meaning after its final word.
2. Category: **ج** = permitted stop; **ف** = permitted out of necessity, with
   continuing preferred, according to the source's introduction.
3. Attribution supporting the stop, preserved as extracted.

These are source categories; they have not been mapped to Hifz cut weights.

## Output and review

Under `data/waqf-pilot/`:

- `review.html`: offline extracted-text comparison. The source phrase, category,
  and attribution appear beside complete local Hafs ayat. The matched phrase is
  highlighted, and its final word is outlined. Original signs and whitespace
  tokens are preserved. Unresolved rows show possible locations without an
  accepted highlight. An optional “Check original PDF page” disclosure loads
  source artwork only when opened.
- `report.json`: every source row, original cells, headings, categories,
  attributions, candidates, issues, and proposed text locations. The reference
  includes full text of the sampled pages' ayat and input SHA-256 fingerprints.
- `manifest.js` and `pages/*.js`: version 2 browser-loadable pilot files using
  `QURAN_WAQF_PILOT_MANIFEST` and `QURAN_WAQF_PILOT_PAGES`. Only uniquely placed
  rows with no remaining anchor issues are exported, including existing signs
  for auditing.
- `review-assets/pdf-*.png`: optional source-page evidence.

The regenerated text pilot has **103 rows, 93 location proposals, 10 flagged
rows**. The proposals contain **44 existing signs and 49 potential additions**.
Seven old flags concerned image tokenization or QCF spelling; those comparisons
are no longer part of the reference.

All results remain pending review with `pilot: true` and `approved: false`.
The app does not load these files. `additional_candidate` means no existing
waqf sign in the local verse text at that word; it is a location/classification
result, not an approved recitation judgment.

## Matching checks

- PDF page and mushaf page numbers are separate. A title such as `3+2` selects
  mushaf pages 2 and 3.
- RTL glyphs are ordered by their positions. Duplicate glyphs are removed,
  ligatures preserved, and number runs read left to right.
- Matching ignores whitespace, vocalization, tatweel, Quran signs, and specific
  alif/hamza spellings. Other letters, ta marbuta, and attached conjunctions
  remain distinct. No fuzzy spelling correction or substring-within-word
  matching is performed.
- Candidates are complete consecutive words in the named surah and ayat listed
  on the named pages in the existing Quran.com metadata.
- Ayat spanning selected pages are deduplicated. Whole-ayah text proves a word
  location but does not prove which physical page contains that word. Such
  anchors retain `versePages`, set `page` to null, and receive
  `word_page_unknown_within_spanning_ayah`; they are excluded from per-page
  export. None of the current proposals needs that warning.
- Repeated phrases resolve only when a strictly increasing source-row sequence
  leaves one feasible endpoint. Out-of-order source rows remain flagged.
- `startWord`/`endWord` are **1-based local Arabic token indices**, excluding
  standalone Quran symbols. `startDisplayIndex`/`endDisplayIndex` count all
  whitespace tokens, including signs. `textRange` is a zero-based, end-exclusive
  Python character range into the original ayah text.
- Existing signs, whether attached or standalone, belong to the preceding real
  word. Verse endings are a separate classification.

Two extraction failures have explicit reviewed transcriptions in
`data/sources/waqf-pilot-transcriptions.json`: PDF 278 row 6 prints `لله`, and
row 15 prints `إلا الله`; extraction loses their final ha. Original extraction
and corrected transcription are both retained. Corrections are bound to the
exact PDF hash and expected extracted phrase, and correct transcription only.

## Remaining source issues

| Source | Finding | Behavior |
| --- | --- | --- |
| PDF 5, row 9 | `الذين امنوا` omits the waw at 2:9; a literal later hit exists at 2:14. | Order conflict. Adjacent `أنفسهم` is conservatively flagged too. |
| PDF 6, row 12 | `زرقا لكم` vs reference `رزقا لكم`. | Unmatched; source typo preserved. |
| PDF 6, row 16 | `الحجارة` vs reference `والحجارة`. | Unmatched; no automatic waw deletion. |
| PDF 7, rows 12–13 | `في الأرض` appears before `يوصل` in the table but after it in 2:27. | `في الأرض` flagged for source order conflict. |
| PDF 500, row 1 | `حسنا` vs Hafs 46:15 `إحسانا`. | Unmatched; reading/spelling difference explicit. |
| PDF 500, row 2 | `كرها` occurs at words 7 and 9 of 46:15. | Ambiguous; neither is selected. |
| PDF 554, rows 1–2 | `ما بينهما` / `الرحمان` vs `وما بينهما` / `الرحمن`. | Unmatched; source wording preserved. |
| PDF 554, row 7 | Heading Al-Muzzammil, page 584, phrase `ام السماء`. | Heading conflict; 79:27 is an unaccepted suggestion. |

Verification includes known-location regressions, ambiguous and conflicting
source rows, character ranges checked against the complete original ayah,
standalone signs, and a text-only fixture with no images or layouts present.
The offline review is also exercised in Chrome. Before expanding the import,
review the remaining source issues and the applicability of the source categories.

## Existing-sign preference audit

Run `uv run tools/audit_waqf_existing_signs.py` to reproduce
`data/waqf-pilot/existing-sign-audit.json`. The audit does not change the matcher
or approve a source location. It checks the ten flagged rows and uses nine
order-resolved repeated phrases as independent controls.

Seven flagged rows have one marked candidate after explicitly recorded wording
or heading hypotheses where needed. That supports examining those locations,
not silently correcting the source. In the controls, preferring the sole marked
candidate agrees with seven order mappings and conflicts with two: PDF 7's
first `كثيرا` row and PDF 100's second `النساء` row. The latter's location is
separated from the first occurrence by the intervening `فيهن` row.

An existing sign is therefore a secondary clue after phrase, surah, and order
constraints. For `كرها`, it suggests word 9 of 46:15, but the PDF itself still
does not specify which occurrence. That suggestion is not a proven assignment.
