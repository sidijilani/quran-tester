# Hifz Companion

**Memorize. Review. Strengthen.**

Open `index.html` in a browser to practice memorization, study Hifz chunks,
compare Mutashabihat, and read supplemental waqf, with no Python server or API
calls. The modes share page-style tabs; Test's range and score stay in its page.

The app uses:

- `data/quran-data.js` for ayah text, page numbers, surah names, and translations.
- `data/line-bands.js` for precomputed mushaf line metadata used by highlights.
- `data/ayah-layout-pages/*.js` for resolution-independent ayah highlight boxes, loaded one page at a time.
- `data/ayah-layout-manifest.js` for lightweight page layout metadata.
- `data/hifz-chunks-pages/*.js` for per-page Hifz memorization chunks.
- `data/hifz-chunks-manifest.js` for lightweight Hifz chunk metadata.
- `data/waqf/manifest.js` and `data/waqf/pages/*.js` for supplemental PDF stops in the **Wa9f** tab.
- `assets/pages/*.jpg` for the 604 local Madinah mushaf page images.

To refresh the static assets:

```sh
python3 tools/build_static_assets.py
```

To rebuild just the ayah layout map:

```sh
uv run tools/build_ayah_layout.py --progress
```

To rebuild just the Hifz chunk map:

```sh
python3 tools/build_hifz_chunks.py --progress
```

The refresh step downloads upstream data and images, but the generated website is self-contained after that.

The **Wa9f** tab shows supplemental stops from `data/Woukoufet-Al-Koran-V2.pdf`.
Permitted stops use a filled burgundy lozenge; stops where continuing is preferred
use a hollow gray lozenge. Both have a thin divider. Repeated-word candidates are
labeled “Possible,” and unmatched entries remain flagged. Open
`index.html#waqf=275` for an example containing both styles.

Rebuild with `uv run tools/build_waqf.py`. See [the full import notes](tools/waqf.md)
for provenance, matching and placement checks, coverage, pending entries, and
word snapshot refresh instructions. The earlier [pilot notes](tools/waqf-pilot.md)
and `data/waqf-pilot/review.html` are preserved separately.
