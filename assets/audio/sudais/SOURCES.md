Sudais browser application cache
================================

Abdur-Rahman as-Sudais, Quran.com ayah recitation resource 3.
Recordings: https://verses.quran.com/Sudais/mp3/
Timing metadata: https://api.quran.com/api/v4/recitations/3/by_ayah/{key}?fields=segments

The browser fetches metadata and recordings directly over HTTPS using CORS.
No Hifz Companion backend, proxy, Python process, or API key is involved.
Each cached record retains the exact source URL, fetch time, seven-day expiry,
word timings, byte count, and a browser-computed SHA-256 for cache integrity.
This hash checks cached bytes; it is not an upstream authenticity signature.
Opening cues play one continuous slice, with no word splicing. Incomplete or
ambiguous timing tables fall back to full-ayah playback.

MP3s and frozen timing manifests from local development are ignored by Git
and are not included in the static deployment. The app keeps its cache only
in the user's browser; expired entries are purged on access and startup.
Quran Foundation terms: https://api-docs.quran.com/legal/developer-terms/
Longer offline retention requires Content Sync for resources offered there,
with its ongoing sync requirements. No permanent audio dataset is bundled.
