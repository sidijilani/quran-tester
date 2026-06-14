# Quran Tester Static App

Open `index.html` in a browser to run the quiz with no Python server and no API calls.

The app uses:

- `data/quran-data.js` for ayah text, page numbers, surah names, and translations.
- `data/line-bands.js` for precomputed mushaf line metadata used by highlights.
- `assets/pages/*.jpg` for the 604 local Madinah mushaf page images.

To refresh the static assets:

```sh
python3 tools/build_static_assets.py
```

The refresh step downloads upstream data and images, but the generated website is self-contained after that.
