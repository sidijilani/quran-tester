# Hifz Companion

**Memorize. Review. Strengthen.**

Open `index.html` in a browser to practice memorization, study Hifz chunks,
compare Mutashabihat, and read supplemental waqf, with no Python server or API
calls. For Recite, use the [HTTPS app](https://sidijilani.github.io/quran-tester/#recite)
so the browser can use its microphone and fetch page/model assets. Every mode
is client-only: no application backend or local background server is needed. The modes share page-style tabs; Test's range and score stay in its page.

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

**Recite** covers all **604 Madani pages / 6,236 ayahs**. Choose **Pages** or
**Surah / Ayah**, as in Test. A new test picks a uniformly random ayah within
that range (avoiding the previous prompt when possible). Recite from its first
word through the range's final ayah, including the rest of an ayah that crosses
a page. Reversed endpoints are normalized. Mutashabihat are not used.

The selected ayah's opening cue words are visible; other page words are masked.
**New test** is available in both modes; **Start over** repeats the same prompt.
Pause/resume and a browser reload preserve the original prompt, position, range,
review marks, and retry allowance. New test clears marks for the new session.
The simulated demo has no microphone recognition and uses the same chosen
passage. All page/model data is served as static files by GitHub Pages.

Live recognition now follows the passage continuously. Settled review words are
shown without receiving confirmation credit: **Unclear** has an amber dashed
highlight, **Wrong** a red highlight, and **Skipped** a gray dotted highlight.
An unclear result means low recognition margin or a borderline sound match;
a wrong result requires enough confident observed sounds with a large mismatch.
The right-hand **Model heard** panel shows recent raw phonetic output (the latest
chunk highlighted), the expected Quran word at the tracking position, the last
word verdict, and optional heard/expected sound comparisons. It does not present
the known Quran text as a recognized transcript.
The lap-tap cue keeps the microphone running. Readers can naturally go back up
to eight words, including across ayah and page boundaries, and resume;
the tracker follows once the repeated phrase is clear. Previously confirmed
words remain visible and review marks stay. **Retry marked word** is optional
and moves the text tracker back without resetting the model. Progress counts
confirmed words; reaching the end with gaps keeps listening for corrections.
Model setup also shows processing time and queued audio to help identify actual
runtime lag.
This tracking update is awaiting the user's microphone trial; no tests were run
for it at the user's request.


Recite now has **Visual** and **Audio** modes. Both display the same Mushaf page
with identical word reveals, outlines and mistake highlights. Audio playback
status and retries appear in a compact panel alongside the page. Visual keeps word reveals,
unclear/wrong/skipped highlights, natural repeats and model-heard diagnostics.
Both modes change pages without reloading the recognition model. The worker
uses a bounded overlapping window of nearby pages plus preceding context;
its observed phonetic history and alignment state migrate into the next window.
It never builds a full-Quran alignment graph or invents audio from known text.
Canonical word indices persist across page changes, retries, and saved sessions.

The data build checks all 77,433 canonical words against contiguous page geometry
with no missing or duplicated words, and verifies model token compatibility.
Page 3 retains its audited corrections. Other pages use generated geometry and
still need user visual review. Four grouped-token cases (2:181, 8:6, 13:37,
37:130) were realigned using canonical text and the existing line segmentation.
The connected visual group in 37:130 retains two recognition words but shares
a reveal box; both must be confirmed to expose it, or a cue/review/hint reveals
the shared group. Those new boxes are generated, not visually audited.

Audio starts with Sudais reading the first three words of the prompted ayah
(configurable from one to five). The reader starts from the ayah's beginning;
a cue never earns confirmation credit. Further ayahs flow continuously;
**Repeat cue** requests another opening prompt. The retry budget defaults to
three unsuccessful attempts and is configurable from one to five. Unclear
recognition and silence do not consume attempts. A mistake sounds the lap tap;
the reader may naturally rewind. A quiet boundary re-anchors the next retry
near the trouble spot. After the limit, Sudais reads the full ayah at the next
pause, including the previous ayah when the mistake was on word one. The
preceding ayah is available as audio/recognition context without becoming part of
the practice score. Help resets the retry allowance, not confirmation credit.

Recognition progress is frozen while Sudais plays and through a 500 ms echo
tail. Audio mode requests microphone echo cancellation. A speech candidate
ducks playback, then must persist while muted before interrupting it; otherwise
playback resumes from the probe's start. A short microphone buffer carries the
interruption into fresh recognition state. **Interrupt and recite** is the
manual fallback. Speaker echo, road noise, Bluetooth latency and missed opening
sounds require the user's device trial; this is an experimental browser feature.

The optional separate local Vosk English recognizer accepts **Stop**, **Resume**,
**Repeat**, **Help**, and **New test**, using a restricted grammar plus unknown
speech and final word confidence >= 0.9. It is not the Quran phoneme model.
**Stop/Pause** keeps only command listening active so Resume remains hands-free;
**End session**, leaving Recite, or hiding the app turns off the microphone.
**New test** chooses another random ayah within the current range.
Settings, position, review marks and retry focus are saved on this browser.
Audio mode requests a screen wake lock; screen-lock/background use is not
supported in this version. Voice-command accuracy and device processing overhead
also await the user's trial. Commands may be disabled in the UI.

The deployed app is static. Its ONNX model (~73 MB), optional Vosk command
model (~41 MB), WASM runtime, Quran page references, and images are ordinary
files hosted on GitHub Pages. ONNX and Vosk inference run in browser workers.
Neither recognition nor audio playback calls a Hifz Companion backend.

The browser requests Sudais recording URLs and word timings directly from
Quran.com's public CORS-enabled API, then downloads recordings directly from
its audio CDN. There is no proxy or API key. Microphone samples never leave
the device; these requests download reciter audio, not recognition services.
Metadata/recordings have an explicit seven-day browser cache, independently
of the upstream HTTP cache. Each entry retains its exact source URL, fetch time,
expiry, timings, byte count, and a locally computed SHA-256 to detect cache
corruption. The hash is not an upstream authenticity signature. Expired entries
are deleted on access/startup; refreshing requires internet connectivity.
No MP3s or frozen Quran.com timing dataset are published in this repository.

2:14 has a missing word-2 timing entry. Its opening cue deliberately falls back
to the full ayah; the UI explains this. Any incomplete/grouped/overlapping timing
table is flagged in the browser and uses this fallback, rather than shifting
word indices or guessing a cut point.
**Save range offline** saves the entire selected range, preceding recognition/help
context, Mushaf images, phonetic page files, recordings, timings, and optional
command archive on the current device. It shows progress and can be cancelled.
The recognition model is cached in IndexedDB on first Start; save it before going
offline. Visited page data/images also cache automatically. The shell includes
the verse catalog; per-ayah audio records retain their own expiry.
The Quran model remains in IndexedDB and Vosk also uses its own persistent
filesystem. Browser storage can still be evicted. The application audio/metadata
cache expires after seven days under the Quran Foundation terms; reconnect to
the internet to refresh expired recordings. General offline retention will require QF
Content Sync for resources available there. See assets/audio/sudais/SOURCES.md.

Vosk-browser 0.0.8 and vosk-model-small-en-us-0.15 use Apache-2.0. The command
model is about 41 MB and included as a static asset; runtime, licenses and download provenance
are retained. The build-time command fetch script converts the official model ZIP into the
browser runtime's tar.gz format. Recite page generation now accepts any Madani
page number; build the full reference with:

```sh
tmp/recite/venv/bin/python tools/fix_recite_compound_layouts.py
tmp/recite/venv/bin/python tools/build_recite_page.py --all
```

The build environment requires quran-transcript 0.6.4 and, for the four layout
corrections, opencv-python-headless. Generated page JSON and the verse catalog are
part of the app; there is no transcription dependency at app runtime.

No microphone, playback, browser or recognition trials were run for this change
at the user's request. Only static source review and syntax checks were used.

Use [Hifz Companion on GitHub Pages](https://sidijilani.github.io/quran-tester/#recite)
and click **Start reciting**. Recognition models are downloaded as static assets,
verified against their pinned checksums, and cached on this browser. Manual
model import remains available, including original HF files after its separate
access approval. The deployed symbol table has its own checksum. The app remains
free and ad-free.

Development only: regenerate missing model assets with
`python3 tools/fetch_recite_model.py` and `python3 tools/fetch_recite_commands.py`.
An optional `python3 tools/serve_recite.py` serves static files for localhost
microphone development; it has no application routes and is not required by
users or the GitHub Pages deployment. There is no server dependency, build
framework, credential, or server process in the published app. `.nojekyll`
ensures Pages publishes the files as static assets.

Before the continuous-tracking update, an actual-model reference-recording trial confirmed all 11 words of 2:6 without
false retries, including through browser capture/resampling. A full-page
actual-worker reference test confirmed all 127 words after assimilation fixes.
This is a first
smoke test; microphone accuracy, mistake detection and phone performance still
need trials. See [the feasibility assessment](tools/recite-feasibility.md).

Recite uses ONNX Runtime Web 1.30.0 (MIT). Phonetic variants are independently
built using quran-transcript 0.6.4 (MIT), with unchanged Arabic sourced from
[Tanzil](https://tanzil.net/) (CC BY 3.0 and its verbatim-text condition). Notices
are retained in `data/recite/TRANSCRIPT-LICENSE`. Quran Lab's model and the deployed
token data use NPL 1.2; features they power must stay free and ad-free, and the
license must be retained. See `assets/models/recite/LICENSE`.
