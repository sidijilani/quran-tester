# Quran Tester Static App

Open `index.html` in a browser to run the quiz with no Python server and no API calls.

The app uses:

- `data/quran-data.js` for ayah text, page numbers, surah names, and translations.
- `data/line-bands.js` for precomputed mushaf line metadata used by highlights.
- `data/ayah-layout-pages/*.js` for resolution-independent ayah highlight boxes, loaded one page at a time.
- `data/ayah-layout-manifest.js` for lightweight page layout metadata.
- `data/hifz-chunks-pages/*.js` for per-page Hifz memorization chunks.
- `data/hifz-chunks-manifest.js` for lightweight Hifz chunk metadata.
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
