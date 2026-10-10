# Recite feasibility and prototype

Updated 9 October 2026. Local word progression is feasible, and the first live
pipeline now runs with the actual model. The active prototype uses **Madani
page 3, Al-Baqarah 2:6–16**, with 127 words and three cues. Al-Fatiha's special
layout is retained as an earlier fixture, not used for the current trial.

## What is verified

Pipeline measurements and browser trials below predate the continuous passage
tracker. They remain evidence for the model/frontend, but do not validate the
new tracking and retry behavior. That update is awaiting the user's trial.

- The public Prompter distribution was downloaded at the user's request. Its
  **72,705,392-byte** v3.1 INT8 model has SHA-256
  `31755836528da336a6192121cd7bc82cb41752dddb65566fd000b89c8686da6b`, matching
  Quran Lab's original metadata at revision
  `3da514fc833b22c902ee466a7710cf399896f2f0`. This is now a full downloaded-file
  verification, not merely a URL-prefix comparison.
- The deployed 251-symbol table was extracted as data without executing or
  copying the application implementation. Its serialized file is separately
  pinned by SHA-256. `tokens-prompter.txt` is **not byte-identical** to the original
  HF `tokens.txt`; both supported representations have separate integrity checks.
  CTC blank is 250. The deployed word separator U+0619 is removed from lexical
  matching. Source URLs, hashes and license are retained under `assets/models/recite`.
- ONNX Runtime Web **1.30.0** uses single-thread WASM SIMD in a Web Worker. The
  actual model initializes and runs with the 99-input/99-output streaming
  interface. Each call receives `[1,61,80]`, advances 48 frames and carries
  97 floating-point cache tensors plus the processed-frame counter.
- Capture is local AudioWorklet mono PCM, resampled to 16 kHz with a windowed-sinc
  antialias filter. Kaldi features use 80 bins, 25 ms frames, 10 ms hops, Povey
  window, preemphasis 0.97, DC removal, reflected edges and 20–7600 Hz filters.
  The JS fbank matches `kaldi-native-fbank` within **0.000151 log-feature units**
  on chirp/noise and silence, including arbitrary streaming splits.
- An Alafasy recording of **2:6** was decoded into the expected phonemes and
  confirmed **all 11 words in order**, without false retries. This was checked
  both directly in the actual worker and through Chrome's reference-file
  microphone input → AudioWorklet → resampling → actual model → UI. It is a
  correct-recitation smoke test, not evidence of general error-detection accuracy.
  A subsequent actual-worker trial covering all 11 ayat on page 3 confirmed
  **all 127 words**, with no mismatches after assimilation-boundary fixes.
- On this desktop in headless Chrome, 30 direct inference chunks took a median
  **40.9 ms** and maximum **56.5 ms** per 480 ms audio hop. A separate startup
  trial plus first silent inference took approximately 703 ms, excluding fetching
  the model buffer. These measurements apply only to this machine/test.
- First Start fetches the already-downloaded same-origin model and token table,
  verifies both and caches them in IndexedDB. A reload while offline successfully
  initialized the actual model from saved storage. The separate service worker
  caches the page-3 shell, runtime and image. Voice is not uploaded or persisted.
- Demo progress, retry tone, hints, revisit highlights, completion, keyboard
  navigation, narrow layouts and file-origin demo support pass browser checks.
  Permission denial, cancellation with a late microphone grant, leaving Recite
  and stopping capture before the retry tone are tested.

Sources: [Quran Lab model card](https://huggingface.co/Quran-Lab/zipformer_p-arabic-v3),
[original file metadata](https://huggingface.co/api/models/Quran-Lab/zipformer_p-arabic-v3?blobs=true),
[Prompter](https://prompter.alketab.app/),
[ONNX Runtime deployment](https://onnxruntime.ai/docs/tutorials/web/deploy.html),
[quran-transcript](https://github.com/obadx/quran-transcript),
[Kaldi reference](https://github.com/csukuangfj/kaldi-native-fbank).
The reference recording is from the [EveryAyah Alafasy archive](https://everyayah.com/data/Alafasy_128kbps/002006.mp3).
Reference recordings and temporary results are not distributed in this repository.

## Product and matching behavior

The page image stays visible with its words concealed, except for three cues.
Recognized words return as passage alignment settles. Settled unclear, incorrect
and skipped words are also revealed for review, without counting them as correct.
Unclear words have amber dashed highlights; wrong words have red solid highlights;
skipped words have gray dotted highlights. Labels in the review list distinguish
all three; an earlier mistake successfully retried is labeled Corrected and retains
a faint review outline. A word revealed for assistance is not concealed again
when the reader goes back.

Low-margin observed speech is Unclear, including low-coverage speech that could
otherwise look skipped. A true zero-evidence gap in the aligned passage is Skipped.
Wrong requires sufficient observed coverage, a margin of at least 0.35 and a sound
distance above 0.4. Borderline distance is Unclear rather than Wrong.
A newly marked incorrect/skipped word plays a soft lap-tap; microphone capture
and streaming inference continue. Readers may restart up to eight words before
the tracked position, across an ayah boundary on this fixed page, without
pressing Retry. A repeat candidate is made easier after uncertain speech, a
review mark or a pause. A word plus following context (at least six observed
characters), or adequate full-word evidence at a pause, supports moving the
visible position backward; a single common sound does not immediately move it.
Earlier confirmed words remain visible during a repeated attempt, while new
problems on that attempt can still receive review marks. The locally synthesized cue works offline and
is limited to once per 1.5 seconds. Headphones can prevent the cue being picked
up by the microphone; this interaction still needs the user's trial.

**Retry marked word** re-anchors only the text tracker to the earliest unconfirmed
marked word. Microphone, filterbank, CTC decoder and streaming model caches keep
running. Retry messages have a generation number so in-flight results from the
previous position cannot move the UI back to that position. Pause, tab exit and
full completion still release capture. The word counter counts actual confirmations,
not the cursor: reaching the end with gaps says **End reached · Still listening**
and keeps capture running so the reader can naturally return to a correction.
Hints reveal without credit; previous mistake and hint highlights remain.

Tentative repeat candidates at an earlier position than the last published
position temporarily retain that published
position while more phrase evidence arrives. Inconclusive candidates are not
allowed to hold updates indefinitely: a pause, catching up to the old position
or 48 observed characters releases that hold, with ordinary confidence grading.

The text tracker records each repeated run separately, so a new reading is not
concatenated onto an earlier failed attempt for word grading. Acoustic state
is preserved through both natural and button-operated corrections.

The button-operated demo retains its explicit retry flow and does not evaluate
speech.

Recognition emits observed phonemes through greedy CTC with peak probability
margins. `recite-tracker.js` independently implements incremental weighted edit
alignment over a graph of every word's connected and pausal variants. It lives
in the inference worker, away from rendering. Each observed character advances
a dynamic-programming column; substitution, insertion and deletion paths remain
available, so one unclear word cannot block the words behind it. A bounded
256-character backtrace recovers per-word evidence and permits recent verdicts
to be revised. The active reference window extends eight words ahead and eight
behind, with penalized repeats allowed across ayah boundaries. Earlier settled verdicts
remain outside that history. Six observed characters of following context, or
a real pause, settle a word; uncertainty is not a confirmed mistake. Full-word
variants are used to distinguish a pause from a partial word. Duration choices
are normalized for memorization; the phonetic graph retains consonants and
gemination. The decoder itself is not constrained to emit Quran text.

The UI applies each worker update in one batch rather than rebuilding the
127-word mask separately for each successful word. Model setup shows total
packet processing time (features, inference and alignment) and queued audio,
so a user trial can distinguish tracking delay from runtime backlog.

The right-hand **Model heard** card displays a rolling window of finalized CTC
emissions from roughly the last eight decoded seconds, with the latest packet
highlighted. These sounds are sent before passage interpretation, with only the
word separator rendered as whitespace. They are not reconstructed from expected
Quran text. The card separately names the tracker target (expected Quran text),
last settled word verdict, and expandable normalized heard/expected phone strings,
signal margin and sound difference. These matching scores are not calibrated
accuracy probabilities. Raw output continues through text-only retry/restart
alignment; pausing retains the last display, and a new microphone session or
Start over clears it. The card has no pretend recognition output in the demo.
Audio and diagnostic output remain local and are not persisted or uploaded.

### Prompter settings comparison, October 9, 2026

Inspected the deployed `main-Bme4fblZ.js` and `decoder.worker-D4jMQMQ1.js`
from [Prompter](https://prompter.alketab.app/). It uses the same pinned model,
greedy CTC, 61 feature frames with a 48-frame hop, blank ID 250, and microphone
echo cancellation/noise suppression/automatic gain disabled. Those already
agreed with this prototype. The main difference was our exact phoneme matching.

The updated prototype adopts Prompter's weighted phonetic edit costs and
`okDistance=0.15`, `unsureDistance=0.4`, `minMargin=0.35` (previously we required
exact matching and a 0.65 margin). Vowel/hamza differences and known nearby
sounds cost less than unrelated consonants; insertion/deletion costs remain 1.
Confidence is measured at each token's peak probability, as in its decoder.
Microphone capture now requests 16 kHz and sends 7,680-sample/480 ms packets,
with resampling when the browser cannot provide 16 kHz. Pauses settle after
25 blank CTC frames (about one second), replacing our fixed RMS volume cutoff
that could treat quiet recitation as silence.

This is an independent fixed-page passage tracker using those settings and
`commitDwell=6`, `minHeardFraction=0.34`, and a normal `repeatCost=10`.
Our correction-specific repeat cost is 2 after a recent issue or pause, to allow
natural restarts; this lower recovery cost is our own product choice.
It does not implement
Prompter's whole-Quran search/relocation or copy its application implementation.
The earlier word-by-word `Matcher` remains exported solely for pilot diagnostics
and is no longer used by live Recite. Small differences can confirm a word;
borderline recognition is marked unclear while the passage keeps advancing.
Permissive matching can accept small actual pronunciation errors, so confirmation
is a tracking aid, not a pronunciation judgment.

At the user's request, no automated tests or recitation trials were run for
the tuning and continuous-tracking updates. Earlier validation results above describe the previous
configuration. Human microphone recitation is the next validation step.

Connected, ayah-stop and fresh-word/stop variants are independently generated
with `quran-transcript` 0.6.4. Page 3's existing word boxes were visually checked
against the actual image; seven incorrect word boxes were corrected in a
Recite-specific file, including the `ألا إنهم هم المفسدون` cluster. Verse medallion
holes were separately audited so they do not reveal neighboring letters.
These findings mean existing coordinates still need checks before expanding
Recite across all pages.

## Downloads, caching and compatibility

The model is ~72.7 MB, and the three bundled ONNX runtime files total ~14.31 MB.
The initial transfer/cache footprint is approximately 87 MB plus small page/data
assets. At 10 Mbps, raw model/runtime transfer alone would take about 70 seconds;
local checkout imports are faster. RAM exceeds file size because weights, state
and activations coexist. Exact peak memory is not measured.

IndexedDB is keyed by the model digest; integrity is rechecked on each Start.
Persistent storage is requested on a best-effort basis. If browser storage is
evicted, the model is recached from this checkout. Weights are Git-ignored, and
can be fetched reproducibly with `python3 tools/fetch_recite_model.py` (requires
curl). Runtime JS/MJS/WASM are the same version, with verified hashes and MIT
license. Service-worker versions change with shell updates and do not forcibly
interrupt active practice.

Live mode needs localhost or HTTPS. Run `python3 tools/serve_recite.py`, then open
`http://localhost:8765/#recite` and choose Start reciting. The file-origin demo
continues to work. Modern Chrome/Edge, Safari and Firefox with WASM SIMD, workers,
AudioWorklet and IndexedDB are candidates; **actual model execution has only been
checked in desktop Chrome**. Narrow viewport tests do not establish phone-model
performance. Mobile Safari RAM, interruptions, Bluetooth sample rates and real
phone performance need physical-device trials. WebGPU is not required.

A useful end-of-word reveal target is 0.6–1.5 seconds, allowing streaming and
boundary delay. That remains a **target, not a measured latency distribution**.
The UI reports last-chunk compute time and stops if the worker falls behind.

## License and remaining validation

The user confirmed a free, ad-free plan. The retained **Quran-Lab No-Profit
License 1.2** permits that use and requires retaining its terms for distributed
models/derivatives. Original Hugging Face access still requires acceptance and
approval; the downloaded model is the separately public Prompter distribution.
The Recite UI states that automatic feedback can be wrong and does not replace a
qualified teacher. This is word-progress practice, not authoritative tajweed
assessment. The developer reports poorer results for children and a tendency to
output canonical tajweed even when a reciter deviates.

The public phonemizer is MIT; its unchanged Arabic source carries Tanzil's
CC BY 3.0 notice and verbatim-text condition. Notices and source links are
retained. The derived deployed token-table data and model remain under NPL 1.2.

Sources: [model license](https://huggingface.co/Quran-Lab/zipformer_p-arabic-v3/blob/main/LICENSE),
[public NPL text](https://github.com/Quran-Lab/quran-g2p/blob/main/LICENSE),
[phonemizer/Tanzil notice](https://github.com/obadx/quran-transcript/blob/main/LICENSE),
[ONNX Runtime license](https://github.com/microsoft/onnxruntime/blob/v1.30.0/LICENSE).

Next: test human microphone recitation, connected versus verse pauses, deliberately
skipped/substituted/repeated words, fresh starts mid-ayah, hesitant/quiet speech,
background voices, adults/children, and actual mobile devices. Measure missed
mistakes separately from false retries, and calibrate confidence and boundary
rules before expanding beyond this first page.

## Reproduce checks

These existing scripts cover earlier pilot behavior. The legacy matcher and raw
decoder checks do not validate the new passage tracker; browser expectations
around stopping on a mismatch also describe the old flow. Update those checks
before using them as a regression suite for the new continuous behavior. No
checks were run for this change, per the user's request.

- `node --test tools/tests/test_recite.cjs`
- `python3 tools/tests/check_recite_fbank.py` (numpy, kaldi-native-fbank and Node)
- `node tools/tests/recite_browser.cjs` (Playwright and the localhost server)
- `node tools/tests/recite_microphone.cjs` (simulated worker lifecycle checks)
- `python3 tools/tests/fetch_recite_reference.py` then `node tools/tests/recite_reference.cjs`
  (actual model, reference recording; run from checkout root with server)
- `python3 tools/build_recite_page.py --page 3` (quran-transcript==0.6.4)

Browser checks accept `PLAYWRIGHT_MODULE`, `BROWSER_EXECUTABLE` and `RECITE_URL`.
Model fetching never reads or prints HF tokens or credentials.
