# Supplemental waqf import and Wa9f mode

Open `index.html`, select **Wa9f**, and choose a Madani page (1–604).
`index.html#waqf=275` opens a page containing both marker styles.
The website works locally, without a server or API calls.

The source is `data/Woukoufet-Al-Koran-V2.pdf`. Its introduction identifies
Qalun an Nafi, while the app displays a Hafs mushaf. Its page numbers are search
hints; the final page and word box come from the app's existing Madani layouts.
The import preserves the source wording, row, category, attribution, chapter
title, and any explicit correction.

## Appearance

| Source category | Meaning in the source | Wa9f marker |
| --- | --- | --- |
| ج | Permitted stop | Filled burgundy lozenge, `#873d50` |
| ف | Permitted out of necessity; continuing preferred | Hollow gray lozenge, `#737373` |
| لازم | Rare additional category, retained literally | Filled burgundy; source details retain لازم |
| Missing or unrecognized | Category cannot be established | Hollow bronze; labeled “Category unspecified” |

Every marker has the approved thin vertical divider in the same color. The
default size is 17 pixels at the native image resolution, lowered 7 pixels from
the first prototype. First-line markers shrink to 12 pixels where needed to
clear the ornamental header. Marks stay within 4 native pixels of the word end
or halfway across a narrower clear gap. A divider with no clear gap is withheld.

The overlay is visible only in Wa9f mode. Click a marker or a word in the list
to see its source PDF page and row. Enter or Space selects a focused marker.
Existing printed stop signs are left intact. An unambiguous source stop already
printed in the mushaf is recorded in the output but receives no extra marker.

Repeated wording is disambiguated using table order where possible. If several
locations remain feasible, **all** are exported as potential stops, including
ones with printed signs. They share an ambiguity group and are labeled
“Possible” in the list and source details. Category and ambiguity are separate:
a hollow marker means ف, not “ambiguous.” When multiple source rows share one
boundary, one marker represents all of them; the source categories remain in
`stopTypes` and the selected details. A ج/ف combination uses the filled marker.

## Outputs and current coverage

`data/waqf/pages/1.js` through `604.js` contain per-page `stops`, deduplicated
visible `markers`, and `unresolved` entries. They load lazily through
`window.QURAN_WAQF_PAGES`. `data/waqf/manifest.js` contains counts, fingerprints,
provenance, and the style definitions. `report.json` contains the complete
extracted table rows, candidates, matching decisions, correction evidence,
alignment changes, and unresolved issues. `summary.json` contains the counts.

The current PDF produces 6,904 rows from 551 table pages. Pages 5–558 are all
accounted for: page 280 is empty, page 557 is an image of explanatory prose,
and page 558 is credits. Of the source rows, 6,410 have at least one located
endpoint. The output has 2,840 visible markers on 561 pages, including 540
markers for ambiguous source rows. It retains all 267 ambiguous source rows.

There are 418 unmatched rows and 76 rows with ordering conflicts. These are
not guessed or displayed. A further 26 proposed marker placements have no
clear separator gap; their locations are retained with `display: false`.
These are audit results, not a claim that every source entry has been verified.
An expandable page notice exposes pending entries without obstructing reading.

## Rebuild

```sh
uv run tools/build_waqf.py
```

The saved word snapshot makes this command completely offline. Matching uses
the full local text in `data/quran-data.js`, never image recognition. Source
phrases are matched conservatively; approximate spelling guesses are not
accepted. The script handles combined headings, headings that continue across
PDF pages, missing table rules, blank categories, and chapter changes within
a page.

`data/sources/waqf-pilot-transcriptions.json` contains the two visually checked
glyph corrections from the pilot. `TITLE_CORRECTIONS` in `build_waqf.py` records
14 chapter-title errors; printed page numbers and original titles are retained.
Both are guarded by the original PDF SHA-256. A changed PDF requires checking
the corrections before rebuilding.

`data/sources/waqf-qurancom-words.json` is a saved Quran.com word text snapshot.
It bridges local text indices to the word indices used in the existing layout
files. Whole verses are aligned, with known joined/split spellings and explicit
orthographic variants. A word endpoint is used only when all minimum-cost
alignments agree. Interior endpoints inside a joined word are not fabricated.
Image layout pages determine placement; upstream word line numbers must agree.
There are 56 upstream-versus-local page discrepancies, retained in
`reference.pageReconciliation` and individual `wordMetadataPageMismatch` fields.
Examples at 5:77 and 98:6 were checked against the local page images.

To recreate the word snapshot from cached responses, or fetch missing pages:

```sh
python3 tools/fetch_waqf_words.py
```

Use `--refresh` to download all 604 responses again. This deliberately changes
the upstream snapshot; rebuild the import and recheck its alignment afterward.
The snapshot supplies text and metadata only. It does not download images.

## Verification

```sh
uv run --with pdfplumber python -m unittest discover -s tools -p 'test_waqf*.py' -v
node --check app.js
```

The 34 tests cover source parsing, conservative matching, ambiguity retention,
joined word indices, upstream page mismatches, and the entire generated corpus.
They independently check every exported stop against source wording, local word
text, layout positions, line numbers, provenance, and geometry. They also check
all 604 page payloads and reconcile the marker counts. Visual spot checks of
PDF pages 102, 245, 357, and 482 confirmed phrases and category columns; the
initial pilot and exceptional cases were also inspected.

Browser checks covered both colors and fills, source links, ambiguous candidates,
tab isolation, navigation, failed-load retry, empty page 604, and a 390-pixel
mobile viewport. No JavaScript errors were observed. The original pilot and
marker comparison remain in `data/waqf-pilot/` as separate historical artifacts.
