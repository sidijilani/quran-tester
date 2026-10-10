# Static Recite model

Run `python3 tools/fetch_recite_model.py` from the checkout to obtain the public
Prompter distribution and verify its full hash against Quran Lab's original
v3.1 INT8 metadata. The pinned weights are included as a static GitHub Pages asset. The browser
downloads the file on first Start, verifies it again, and stores it in IndexedDB
for later sessions. No application server is involved.
No audio is uploaded. Use localhost or HTTPS, not a file-origin tab, for live mode.

`tokens-prompter.txt` serializes Prompter's distributed 251-symbol vocabulary;
it is separately pinned by SHA-256 and is not byte-identical to the original
Hugging Face token-table file. Symbol 250 is CTC blank; symbol 0 is the phonetic
word separator U+0619. Provenance and checksums are in provenance.json.

The model and distributed table remain under Quran-Lab No-Profit License 1.2;
the full LICENSE is retained here. This feature must remain free and ad-free.
Original HF access still requires its own acceptance/approval. This is a public
copy published by the referenced application, not an authenticated HF download.
