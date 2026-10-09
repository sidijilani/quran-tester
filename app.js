(function () {
  "use strict";

  const ayat = window.QURAN_AYAT || [];
  const lineBands = window.QURAN_LINE_BANDS || {};
  const ayahLayoutPages = window.QURAN_AYAH_LAYOUT_PAGES || (window.QURAN_AYAH_LAYOUT_PAGES = {});
  const hifzChunkPages = window.QURAN_HIFZ_CHUNK_PAGES || (window.QURAN_HIFZ_CHUNK_PAGES = {});
  const mutashabihatPages = window.QURAN_MUTASHABIHAT_PAGES || (window.QURAN_MUTASHABIHAT_PAGES = {});
  const waqfPages = window.QURAN_WAQF_PAGES || (window.QURAN_WAQF_PAGES = {});
  const ayahLayoutData = window.QURAN_AYAH_LAYOUT || {};
  const ayahLayoutManifest = window.QURAN_AYAH_LAYOUT_MANIFEST || {};
  const hifzManifest = window.QURAN_HIFZ_CHUNKS_MANIFEST || {};
  const mutashabihatManifest = window.QURAN_MUTASHABIHAT_MANIFEST || {};
  const waqfManifest = window.QURAN_WAQF_MANIFEST || {};
  const ayahLayout = ayahLayoutData.ayat || {};
  const pageLayouts = ayahLayoutData.pages || {};
  const totalPages = ayat.reduce((max, ayah) => Math.max(max, ayah.page || 0), 0);
  const mushafPages = Array.from({ length: totalPages }, (_, index) => index + 1);
  const topFrac = 0.085;
  const botFrac = 0.918;
  const lineH = (botFrac - topFrac) / 15;
  const storageKey = "quran-recall-static-settings";

  const $ = (id) => document.getElementById(id);
  const els = {
    rangeModes: Array.from(document.querySelectorAll('input[name="rangeMode"]')),
    pageRange: $("pageRange"),
    ayahRange: $("ayahRange"),
    startPage: $("startPage"),
    endPage: $("endPage"),
    startSurah: $("startSurah"),
    startAyah: $("startAyah"),
    endSurah: $("endSurah"),
    endAyah: $("endAyah"),
    words: $("words"),
    lines: $("lines"),
    highlight: $("highlight"),
    translation: $("translation"),
    rangeNote: $("rangeNote"),
    stats: $("stats"),
    testTab: $("testTab"),
    hifzTab: $("hifzTab"),
    mutashabihatTab: $("mutashabihatTab"),
    waqfTab: $("waqfTab"),
    waqfPanel: $("waqfPanel"),
    waqfPage: $("waqfPage"),
    waqfRef: $("waqfRef"),
    waqfPageArea: $("waqfPageArea"),
    waqfStops: $("waqfStops"),
    waqfUnresolved: $("waqfUnresolved"),
    waqfUnresolvedSummary: $("waqfUnresolvedSummary"),
    waqfUnresolvedEntries: $("waqfUnresolvedEntries"),
    testPanel: $("testPanel"),
    quizPanel: $("quizPanel"),
    hifzPanel: $("hifzPanel"),
    hifzPage: $("hifzPage"),
    hifzRef: $("hifzRef"),
    hifzPageArea: $("hifzPageArea"),
    hifzLegend: $("hifzLegend"),
    mutashabihatPanel: $("mutashabihatPanel"),
    mutashabihatPage: $("mutashabihatPage"),
    mutashabihatSensitivity: $("mutashabihatSensitivity"),
    mutashabihatSensitivityValue: $("mutashabihatSensitivityValue"),
    mutashabihatRef: $("mutashabihatRef"),
    mutashabihatPageArea: $("mutashabihatPageArea"),
    mutashabihatOverlay: $("mutashabihatOverlay"),
    qnum: $("qnum"),
    prompt: $("prompt"),
    hint: $("hint"),
    reveal: $("revealBtn"),
    skip: $("skipBtn"),
    next: $("nextBtn"),
    answer: $("answer"),
    ref: $("ref"),
    pageArea: $("pageArea"),
  };

  let question = null;
  let asked = 0;
  let activeMode = "pages";
  let answerPageIndex = 0;
  const tally = { clean: 0, hesitated: 0, failed: 0 };
  const promptIndexCache = new Map();
  const layoutPageLoads = new Map();
  const hifzPageLoads = new Map();
  const mutashabihatPageLoads = new Map();
  const waqfPageLoads = new Map();
  const surahs = [];
  const ayahLookup = new Map();
  const pageBounds = new Map();
  const preloadedPages = new Set();
  const hifzColorSlots = new Map();
  let nextHifzColorSlot = 0;
  let activePanel = "test";
  let hifzPage = 21;
  let mutashabihatPage = 21;
  let waqfPage = 504;
  let selectedWaqfMarkerId = null;
  let mutashabihatSensitivity = 3;
  let selectedMutashabihatMatchId = null;
  const mutashabihatSensitivityProfiles = [
    { label: "Exact", maxRepeat: 3, minWords: 6, minCoverage: 0.7 },
    { label: "Focused", maxRepeat: 5, minWords: 5, minCoverage: 0.6 },
    { label: "Balanced", maxRepeat: 5, minWords: 4, minCoverage: 0.5 },
    { label: "Sensitive", maxRepeat: 8, minWords: 4, minCoverage: 0.45 },
    { label: "Broad", maxRepeat: 13, minWords: 3, minCoverage: 0.35 },
  ];
  const hifzPalette = [
    { fill: "rgba(227, 82, 61, .17)", border: "rgba(189, 55, 38, .50)" },
    { fill: "rgba(32, 150, 120, .17)", border: "rgba(20, 113, 92, .50)" },
    { fill: "rgba(62, 123, 220, .16)", border: "rgba(42, 90, 176, .48)" },
    { fill: "rgba(156, 91, 204, .16)", border: "rgba(125, 66, 168, .48)" },
    { fill: "rgba(218, 151, 32, .17)", border: "rgba(176, 112, 14, .48)" },
    { fill: "rgba(26, 152, 190, .16)", border: "rgba(15, 114, 150, .48)" },
  ];

  function clamp(value, min, max) {
    const n = Number(value) || min;
    return Math.max(min, Math.min(max, n));
  }

  function refKey(surah, ayah) {
    return `${surah}:${ayah}`;
  }

  function ayahKey(ayah) {
    return refKey(ayah.s, ayah.a);
  }

  function getAyah(surah, ayah) {
    return ayahLookup.get(refKey(surah, ayah));
  }

  function selectedMode() {
    return activeMode;
  }

  function setMode(mode) {
    activeMode = mode === "ayah" ? "ayah" : "pages";
    els.rangeModes.forEach((input) => {
      input.checked = input.value === activeMode;
    });
    els.pageRange.hidden = activeMode !== "pages";
    els.ayahRange.hidden = activeMode !== "ayah";
  }

  function pageEndpoint(page, side) {
    const bounds = pageBounds.get(page);
    return bounds ? bounds[side] : ayat[side === "first" ? 0 : ayat.length - 1];
  }

  function selectedPageRange() {
    let startPage = clamp(els.startPage.value, 1, 604);
    let endPage = clamp(els.endPage.value, 1, 604);
    if (startPage > endPage) {
      [startPage, endPage] = [endPage, startPage];
    }
    return {
      startPage,
      endPage,
      start: pageEndpoint(startPage, "first"),
      end: pageEndpoint(endPage, "last"),
    };
  }

  function selectedEndpoint(kind) {
    const surah = clamp(els[`${kind}Surah`].value, 1, 114);
    const meta = surahs[surah - 1] || surahs[0];
    const ayah = clamp(els[`${kind}Ayah`].value, 1, meta.count);
    return getAyah(surah, ayah) || ayat[0];
  }

  function setEndpoint(kind, ayah) {
    els[`${kind}Surah`].value = ayah.s;
    populateAyahSelect(kind, ayah.s, ayah.a);
  }

  function selectedAyahRange() {
    let start = selectedEndpoint("start");
    let end = selectedEndpoint("end");
    if (start._idx > end._idx) {
      [start, end] = [end, start];
    }
    return { start, end, startPage: start.page, endPage: end.page };
  }

  function syncControlsToRange(range) {
    els.startPage.value = range.startPage;
    els.endPage.value = range.endPage;
    setEndpoint("start", range.start);
    setEndpoint("end", range.end);
  }

  function settings() {
    const mode = selectedMode();
    const range = mode === "pages" ? selectedPageRange() : selectedAyahRange();

    const cfg = {
      mode,
      start: range.start,
      end: range.end,
      startPage: range.startPage,
      endPage: range.endPage,
      words: clamp(els.words.value, 1, 20),
      lines: clamp(els.lines.value, 1, 20),
      highlight: els.highlight.checked,
      translation: els.translation.checked,
    };

    syncControlsToRange(cfg);
    els.words.value = cfg.words;
    els.lines.value = cfg.lines;
    return cfg;
  }

  function saveSettings() {
    const cfg = settings();
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        mode: cfg.mode,
        startPage: cfg.startPage,
        endPage: cfg.endPage,
        startSurah: cfg.start.s,
        startAyah: cfg.start.a,
        endSurah: cfg.end.s,
        endAyah: cfg.end.a,
        words: cfg.words,
        lines: cfg.lines,
        highlight: cfg.highlight,
        translation: cfg.translation,
      })
    );
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
      if (saved.mode) setMode(saved.mode);
      if (saved.startPage) els.startPage.value = saved.startPage;
      if (saved.endPage) els.endPage.value = saved.endPage;
      if (saved.startSurah && saved.startAyah) {
        els.startSurah.value = saved.startSurah;
        populateAyahSelect("start", saved.startSurah, saved.startAyah);
      }
      if (saved.endSurah && saved.endAyah) {
        els.endSurah.value = saved.endSurah;
        populateAyahSelect("end", saved.endSurah, saved.endAyah);
      }
      if (saved.words) els.words.value = saved.words;
      if (saved.lines) els.lines.value = saved.lines;
      if (typeof saved.highlight === "boolean") els.highlight.checked = saved.highlight;
      if (typeof saved.translation === "boolean") els.translation.checked = saved.translation;
    } catch (_) {
      // Bad local settings should not block the quiz.
    }
  }

  function initQuranIndex() {
    const seen = new Map();
    ayat.forEach((ayah, index) => {
      ayah._idx = index;
      ayahLookup.set(ayahKey(ayah), ayah);
      if (!pageBounds.has(ayah.page)) {
        pageBounds.set(ayah.page, { first: ayah, last: ayah });
      } else {
        pageBounds.get(ayah.page).last = ayah;
      }
      if (!seen.has(ayah.s)) {
        seen.set(ayah.s, {
          s: ayah.s,
          s_en: ayah.s_en,
          s_ar: ayah.s_ar,
          count: 0,
        });
      }
      seen.get(ayah.s).count = Math.max(seen.get(ayah.s).count, ayah.a);
    });
    surahs.splice(0, surahs.length, ...Array.from(seen.values()).sort((a, b) => a.s - b.s));
  }

  function populateSurahSelect(select, selectedSurah) {
    select.textContent = "";
    surahs.forEach((surah) => {
      const option = document.createElement("option");
      option.value = surah.s;
      option.textContent = `${surah.s}. ${surah.s_en} (${surah.s_ar})`;
      select.appendChild(option);
    });
    select.value = selectedSurah;
  }

  function previewCharCount(words) {
    return Array.from(words.join("")).length;
  }

  function ayahPreview(words) {
    const picked = [];
    for (let index = 0; index < words.length; index += 1) {
      picked.push(words[index]);
      if (previewCharCount(picked) >= 7) break;
    }
    return picked.join(" ");
  }

  function ayahOptionLabel(kind, surahNumber, ayahNumber) {
    const ayah = getAyah(Number(surahNumber), ayahNumber);
    const words = ayah ? arabicWords(ayah.ar) : [];
    const preview = ayahPreview(words);
    return preview ? `${ayahNumber} · ${preview}` : String(ayahNumber);
  }

  function populateAyahSelect(kind, surahNumber, selectedAyah) {
    const select = els[`${kind}Ayah`];
    const meta = surahs[Number(surahNumber) - 1] || surahs[0];
    const current = clamp(selectedAyah || select.value, 1, meta.count);
    select.textContent = "";
    for (let ayah = 1; ayah <= meta.count; ayah += 1) {
      const option = document.createElement("option");
      option.value = ayah;
      option.textContent = ayahOptionLabel(kind, meta.s, ayah);
      select.appendChild(option);
    }
    select.value = current;
  }

  function initRangeControls() {
    const defaultEnd = ayat.findLast ? ayat.findLast((ayah) => ayah.page <= 10) : [...ayat].reverse().find((ayah) => ayah.page <= 10);
    setMode("pages");
    els.startPage.value = 1;
    els.endPage.value = 10;
    populateSurahSelect(els.startSurah, 1);
    populateSurahSelect(els.endSurah, defaultEnd.s);
    populateAyahSelect("start", 1, 1);
    populateAyahSelect("end", defaultEnd.s, defaultEnd.a);
  }

  function arabicWords(arabic) {
    return arabic.split(/\s+/).filter(Boolean);
  }

  function normalizeArabicWord(word) {
    return word
      .normalize("NFKD")
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
      .replace(/\u0640/g, "")
      .replace(/[^\u0621-\u063A\u0641-\u064A]/g, "")
      .replace(/[إأآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه");
  }

  function normalizedWords(ayah) {
    if (!ayah._normWords) {
      ayah._normWords = arabicWords(ayah.ar).map(normalizeArabicWord).filter(Boolean);
    }
    return ayah._normWords;
  }

  function prefixKey(words, count) {
    return words.slice(0, count).join(" ");
  }

  function maxCueWords(ayah) {
    const displayWords = arabicWords(ayah.ar);
    const compareWords = normalizedWords(ayah);
    return Math.max(1, Math.min(displayWords.length <= 2 ? 1 : displayWords.length - 1, compareWords.length));
  }

  function openingFromCounts(entry, counts, minimumWords) {
    const displayWords = arabicWords(entry.ar);
    const compareWords = normalizedWords(entry);
    if (!displayWords.length || !compareWords.length) {
      return { prompt: "...", remaining: 0, shown: 0, ambiguous: 0 };
    }

    const maxWords = maxCueWords(entry);
    const minWords = Math.max(1, Math.min(minimumWords, maxWords));
    let best = {
      shown: Math.min(minWords, maxWords),
      ambiguous: Number.POSITIVE_INFINITY,
    };

    for (let count = best.shown; count <= maxWords; count += 1) {
      const key = `${count}\t${prefixKey(compareWords, count)}`;
      const matches = counts.get(key) || 0;
      const ambiguous = Math.max(0, matches - 1);
      best = { shown: count, ambiguous };
      if (matches === 1) break;
    }

    return {
      prompt: displayWords.slice(0, best.shown).join(" ") + " ...",
      remaining: Math.max(0, displayWords.length - best.shown),
      shown: best.shown,
      ambiguous: Number.isFinite(best.ambiguous) ? best.ambiguous : 0,
    };
  }

  function buildPromptIndex(pool, cfg) {
    const cacheKey = `${cfg.start._idx}:${cfg.end._idx}:${cfg.words}`;
    if (promptIndexCache.has(cacheKey)) return promptIndexCache.get(cacheKey);

    const counts = new Map();
    pool.forEach((ayah) => {
      const words = normalizedWords(ayah);
      const maxWords = maxCueWords(ayah);
      for (let count = 1; count <= maxWords; count += 1) {
        const key = `${count}\t${prefixKey(words, count)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    });

    const items = pool.map((ayah, index) => ({
      index,
      opened: openingFromCounts(ayah, counts, cfg.words),
    }));
    const unique = items.filter((item) => item.opened.ambiguous === 0);
    const index = { items, unique };
    promptIndexCache.set(cacheKey, index);
    return index;
  }

  function buildQuestion(entry, index, pool, cfg, opened) {
    const chunk = pool.slice(index, index + cfg.lines);
    const last = chunk[chunk.length - 1];

    return {
      entry: {
        s: entry.s,
        a: entry.a,
        page: entry.page,
        s_en: entry.s_en,
        key: ayahKey(entry),
      },
      prompt: opened.prompt,
      remaining: opened.remaining,
      chunk: chunk.map((x) => ({ ...x, key: ayahKey(x) })),
      span: last === entry ? `${entry.s}:${entry.a}` : `${entry.s}:${entry.a}-${last.s}:${last.a}`,
      pages: [...new Set(chunk.map((x) => x.page))],
      viewerPages: mushafPages,
      poolSize: pool.length,
      promptWords: opened.shown,
      ambiguity: opened.ambiguous,
      cfg,
    };
  }

  function pickQuestion() {
    const cfg = settings();
    const pool = ayat.filter((a) => a._idx >= cfg.start._idx && a._idx <= cfg.end._idx);
    if (!pool.length) return null;

    const prompts = buildPromptIndex(pool, cfg);
    const candidates = prompts.unique.length ? prompts.unique : prompts.items;
    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    return buildQuestion(pool[selected.index], selected.index, pool, cfg, selected.opened);
  }

  function formatRef(ayah) {
    return `${ayah.s_en} ${ayah.s}:${ayah.a}`;
  }

  function selectedPool(cfg) {
    return ayat.slice(cfg.start._idx, cfg.end._idx + 1);
  }

  function pageSpan(pool) {
    if (!pool.length) return "";
    const first = pool[0].page;
    const last = pool[pool.length - 1].page;
    return first === last ? `page ${first}` : `pages ${first}-${last}`;
  }

  function renderStats() {
    els.stats.innerHTML =
      `asked <b>${asked}</b> · clean <b>${tally.clean}</b> · ` +
      `hesitated <b>${tally.hesitated}</b> · failed <b>${tally.failed}</b>`;
  }

  function loadNext() {
    saveSettings();
    question = pickQuestion();
    els.answer.hidden = true;
    els.pageArea.textContent = "";

    if (!question) {
      els.qnum.textContent = "Ayah";
      els.prompt.textContent = "No ayat found.";
      els.hint.textContent = "Check the page range.";
      els.rangeNote.textContent = "";
      els.reveal.disabled = true;
      return;
    }

    asked += 1;
    els.qnum.textContent = `Ayah #${asked}`;
    els.prompt.textContent = question.prompt;
    els.hint.textContent =
      `recite the remaining ~${question.remaining} words, then continue ~${question.chunk.length - 1} ayat`;
    els.rangeNote.textContent =
      `${formatRef(question.cfg.start)} to ${formatRef(question.cfg.end)} · ` +
      `${pageSpan(selectedPool(question.cfg))} · ${question.poolSize} ayat in range`;
    els.reveal.disabled = false;
    renderStats();
  }

  function pagePath(page) {
    return `assets/pages/${page}.jpg`;
  }

  function viewerPages() {
    if (!question) return [];
    return question.viewerPages.length ? question.viewerPages : question.pages;
  }

  function preloadPage(page) {
    if (!page || preloadedPages.has(page)) return;
    const img = new Image();
    img.decoding = "async";
    img.src = pagePath(page);
    preloadedPages.add(page);
  }

  function preloadAdjacentPages(pages, index) {
    preloadPage(pages[index - 1]);
    preloadPage(pages[index + 1]);
  }

  function layoutForPage(page) {
    const key = String(page);
    const pagePayload = ayahLayoutPages[key];
    return pagePayload ? pagePayload.page : pageLayouts[key] || (ayahLayoutManifest.pages || {})[key];
  }

  function loadLayoutPage(page) {
    const key = String(page);
    if (ayahLayoutPages[key] || pageLayouts[key]) return Promise.resolve();
    if (layoutPageLoads.has(key)) return layoutPageLoads.get(key);

    const promise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = `data/ayah-layout-pages/${page}.js`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });
    layoutPageLoads.set(key, promise);
    return promise;
  }

  function loadHifzPage(page) {
    const key = String(page);
    if (hifzChunkPages[key]) return Promise.resolve();
    if (hifzPageLoads.has(key)) return hifzPageLoads.get(key);

    const promise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = `data/hifz-chunks-pages/${page}.js`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });
    hifzPageLoads.set(key, promise);
    return promise;
  }

  function loadMutashabihatPage(page) {
    const key = String(page);
    if (mutashabihatPages[key]) return Promise.resolve();
    if (mutashabihatPageLoads.has(key)) return mutashabihatPageLoads.get(key);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `data/mutashabihat-pages/${page}.js`;
      script.onload = () => resolve();
      script.onerror = reject;
      document.head.appendChild(script);
    });
    mutashabihatPageLoads.set(key, promise);
    return promise;
  }

  function highlightBoxesForPage(page) {
    if (!question.cfg.highlight) return [];
    const pagePayload = ayahLayoutPages[String(page)];
    const pageBoxes = pagePayload ? pagePayload.ayat[question.entry.key] : null;
    if (pageBoxes && pageBoxes.length) return pageBoxes;

    const layoutByPage = ayahLayout[question.entry.key];
    const boxes = layoutByPage ? layoutByPage[String(page)] : null;
    if (boxes && boxes.length) return boxes;

    const bandByPage = lineBands[question.entry.key];
    const range = bandByPage ? bandByPage[String(page)] : null;
    if (!range || page <= 2) return [];
    const top = topFrac + (range[0] - 1) * lineH;
    const bottom = topFrac + range[1] * lineH;
    return [{ x: 0.04, y: top, w: 0.92, h: bottom - top }];
  }

  function addBand(wrap, box) {
    const band = document.createElement("div");
    band.className = box.className || "band";
    band.style.left = `${(box.x * 100).toFixed(2)}%`;
    band.style.top = `${(box.y * 100).toFixed(2)}%`;
    band.style.width = `${(box.w * 100).toFixed(2)}%`;
    band.style.height = `${(box.h * 100).toFixed(2)}%`;
    if (box.fill) band.style.background = box.fill;
    if (box.border) band.style.outlineColor = box.border;
    if (box.matchId) {
      band.dataset.matchId = box.matchId;
      band.title = box.title || "";
      let hoverTimer = null;
      band.addEventListener("pointerenter", (event) => {
        if (event.pointerType !== "mouse") return;
        hoverTimer = window.setTimeout(() => selectMutashabihatMatch(box.matchId), 350);
      });
      band.addEventListener("pointerleave", () => {
        if (hoverTimer) window.clearTimeout(hoverTimer);
      });
      band.addEventListener("click", () => selectMutashabihatMatch(box.matchId));
      band.addEventListener("pointerdown", () => selectMutashabihatMatch(box.matchId));
      band.tabIndex = 0;
      band.setAttribute("role", "button");
      band.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectMutashabihatMatch(box.matchId);
        }
      });
    }
    wrap.appendChild(band);
  }

  function addBands(wrap, boxes) {
    boxes.forEach((box) => addBand(wrap, box));
  }

  function selectBandAtPoint(wrap, event) {
    const bands = Array.from(wrap.querySelectorAll(".mutashabihBand[data-match-id]"));
    const band = bands.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    });
    if (band) selectMutashabihatMatch(band.dataset.matchId);
  }

  function highlightClass(key) {
    if (key === question.entry.key) return "entry";
    return question.chunk.some((ayah) => ayah.key === key) ? "continuation" : "";
  }

  function hifzBoxesForPage(page) {
    const hifz = hifzChunkPages[String(page)];
    const layout = ayahLayoutPages[String(page)];
    if (!hifz || !layout) return [];
    const boxes = [];
    hifz.chunks.forEach((chunk) => {
      const color = hifzColorForChunk(chunk);
      chunk.visibleAyat.forEach((ayahKeyValue) => {
        (layout.ayat[ayahKeyValue] || []).forEach((box) => {
          boxes.push({
            ...box,
            className: "band hifzBand",
            fill: color.fill,
            border: color.border,
          });
        });
      });
    });
    return boxes;
  }

  function hifzColorForChunk(chunk) {
    const key = chunk.colorKey || chunk.verses;
    if (!hifzColorSlots.has(key)) {
      hifzColorSlots.set(key, nextHifzColorSlot);
      nextHifzColorSlot = (nextHifzColorSlot + 1) % hifzPalette.length;
    }
    return hifzPalette[hifzColorSlots.get(key)];
  }

  function mutashabihatSensitivityProfile() {
    return mutashabihatSensitivityProfiles[mutashabihatSensitivity - 1] || mutashabihatSensitivityProfiles[2];
  }

  function updateMutashabihatSensitivityLabel() {
    const profile = mutashabihatSensitivityProfile();
    els.mutashabihatSensitivity.value = String(mutashabihatSensitivity);
    els.mutashabihatSensitivityValue.textContent = profile.label;
  }

  function mutashabihatMatchPassesSensitivity(match) {
    const profile = mutashabihatSensitivityProfile();
    const repeatCount = match.repeatCount || Number((match.note || "").match(/(\d+) repeats/)?.[1]) || 99;
    const wordCount = match.wordCount || Number((match.note || "").match(/(\d+) words/)?.[1]) || 0;
    const coverage = match.ayahCoverage || 0;
    return repeatCount <= profile.maxRepeat && (wordCount >= profile.minWords || coverage >= profile.minCoverage);
  }

  function mutashabihatMatchesForPage(page) {
    return ((mutashabihatPages[String(page)] || {}).matches || []).filter(mutashabihatMatchPassesSensitivity);
  }

  function rawMutashabihatMatchCount(page) {
    return ((mutashabihatPages[String(page)] || {}).matches || []).length;
  }

  function mutashabihatMatchById(id) {
    return mutashabihatMatchesForPage(mutashabihatPage).find((match) => match.id === id) || null;
  }

  function indexedAyahWordCount(ayahKeyValue) {
    const [surah, ayah] = ayahKeyValue.split(":").map(Number);
    const entry = getAyah(surah, ayah);
    return entry ? normalizedWords(entry).length : 0;
  }

  function lineWordSpans(boxes, wordCount) {
    if (!wordCount || !boxes.length) return [];
    const weights = boxes.map((box) => Math.max(1, box.w || 0));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let remaining = wordCount;
    let cursor = 1;
    return boxes.map((box, index) => {
      const remainingLines = boxes.length - index;
      const estimate = Math.round((weights[index] / totalWeight) * wordCount);
      const count = index === boxes.length - 1 ? remaining : Math.max(1, Math.min(remaining - remainingLines + 1, estimate));
      const span = { box, start: cursor, end: cursor + count - 1 };
      cursor += count;
      remaining -= count;
      return span;
    });
  }

  function rangesFromDiffParts(ranges, parts) {
    const positions = [];
    (ranges || []).forEach(([start, end]) => {
      for (let position = Number(start); position <= Number(end); position += 1) {
        positions.push(position);
      }
    });
    const diffPositions = positions.filter((_, index) => parts[index]?.kind === "diff");
    const packed = [];
    diffPositions.forEach((position) => {
      const last = packed[packed.length - 1];
      if (last && last[1] === position - 1) last[1] = position;
      else packed.push([position, position]);
    });
    return packed;
  }

  function underlineBox(box) {
    const y = Number(box.y) || 0;
    const h = Number(box.h) || 0;
    const lineBottom = Number.isFinite(Number(box.lineBottom)) ? Number(box.lineBottom) : y + h;
    const underlineH = Math.max(0.004, h * 0.075);
    return {
      ...box,
      y: Math.min(lineBottom - underlineH, y + h + 0.0015),
      h: underlineH,
    };
  }

  function rangeBoxesForAyah(layout, ayahKeyValue, ranges, role) {
    const ayahBoxes = layout.ayat[ayahKeyValue] || [];
    if (!ranges || !ranges.length || !ayahBoxes.length) return [];
    const hasWordSpans = ayahBoxes.every((box) => Number.isFinite(Number(box.s)) && Number.isFinite(Number(box.e)));
    const spans = hasWordSpans
      ? ayahBoxes.map((box) => ({ box, start: Number(box.s), end: Number(box.e) }))
      : lineWordSpans(ayahBoxes, indexedAyahWordCount(ayahKeyValue));
    const boxes = [];
    spans.forEach(({ box, start, end }) => {
      ranges.forEach(([rangeStart, rangeEnd]) => {
        const overlapStart = Math.max(start, rangeStart);
        const overlapEnd = Math.min(end, rangeEnd);
        if (overlapStart > overlapEnd) return;
        const wordBoxes = (box.words || []).filter((wordBox) => {
          const index = Number(wordBox.i);
          return Number.isFinite(index) && index >= overlapStart && index <= overlapEnd;
        });
        if (wordBoxes.length) {
          if (role === "diff") {
            wordBoxes.forEach((wordBox) => {
              boxes.push(underlineBox({
                ...box,
                ...wordBox,
                lineBottom: box.y + box.h,
                w: Math.max(0.014, Number(wordBox.w) || 0),
                role,
              }));
            });
            return;
          }
          const left = Math.min(...wordBoxes.map((wordBox) => Number(wordBox.x)));
          const right = Math.max(...wordBoxes.map((wordBox) => Number(wordBox.x) + Number(wordBox.w)));
          boxes.push({
            ...box,
            x: left,
            w: Math.max(0.026, right - left),
            role,
          });
          return;
        }
        const lineCount = end - start + 1;
        const from = (overlapStart - start) / lineCount;
        const to = (overlapEnd - start + 1) / lineCount;
        const rangeBox = {
          ...box,
          x: box.x + box.w * (1 - to),
          lineBottom: box.y + box.h,
          w: Math.max(role === "diff" ? 0.018 : 0.035, box.w * (to - from)),
          role,
        };
        boxes.push(role === "diff" ? underlineBox(rangeBox) : rangeBox);
      });
    });
    return boxes;
  }

  function mutashabihatBoxesForPage(page) {
    const data = mutashabihatPages[String(page)];
    const layout = ayahLayoutPages[String(page)];
    if (!data || !layout) return [];
    const boxes = [];
    mutashabihatMatchesForPage(page).forEach((match) => {
      (match.currentAyat || [match.current]).forEach((ayahKeyValue) => {
        const phraseBoxes = rangeBoxesForAyah(layout, ayahKeyValue, match.currentRanges, "phrase");
        const diffRanges = rangesFromDiffParts(match.currentRanges, match.currentPhraseDiff || []);
        const diffBoxes = rangeBoxesForAyah(layout, ayahKeyValue, diffRanges, "diff");
        phraseBoxes.forEach((box) => {
          boxes.push({
            ...box,
            className: `band mutashabihBand mutashabihSimilarBand${match.id === selectedMutashabihatMatchId ? " selected" : ""}`,
            matchId: match.id,
            title: `${match.current} similar to ${match.previous}${match.phraseText ? ` · ${match.phraseText}` : ""}`,
          });
        });
        diffBoxes.forEach((box) => {
          boxes.push({
            ...box,
            className: `band mutashabihBand mutashabihDiffBand${match.id === selectedMutashabihatMatchId ? " selected" : ""}`,
            matchId: match.id,
            title: `${match.current} differs from ${match.previous}`,
          });
        });
      });
    });
    return boxes;
  }

  function mutashabihatPreviousBoxesForPage(page) {
    const match = mutashabihatMatchById(selectedMutashabihatMatchId);
    const layout = ayahLayoutPages[String(page)];
    if (!match || !layout || match.previousPage !== page) return [];
    return (match.previousAyat || [match.previous]).flatMap((ayahKeyValue) => {
      const phraseBoxes = rangeBoxesForAyah(layout, ayahKeyValue, match.previousRanges, "phrase");
      const diffRanges = rangesFromDiffParts(match.previousRanges, match.previousPhraseDiff || []);
      const diffBoxes = rangeBoxesForAyah(layout, ayahKeyValue, diffRanges, "diff");
      return [
        ...phraseBoxes.map((box) => ({
          ...box,
          className: "band mutashabihBand mutashabihSimilarBand mutashabihBandPrevious selected",
        })),
        ...diffBoxes.map((box) => ({
          ...box,
          className: "band mutashabihBand mutashabihDiffBand mutashabihBandPrevious selected",
        })),
      ];
    });
  }

  function loadWaqfPage(page) {
    const key = String(page);
    if (waqfPages[key]) return Promise.resolve();
    if (waqfPageLoads.has(key)) return waqfPageLoads.get(key);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `data/waqf/pages/${page}.js`;
      script.onload = () => {
        if (waqfPages[key]) resolve();
        else { waqfPageLoads.delete(key); script.remove(); reject(new Error("Missing Wa9f page payload")); }
      };
      script.onerror = () => {
        waqfPageLoads.delete(key);
        script.remove();
        reject(new Error("Could not load Wa9f page"));
      };
      document.head.appendChild(script);
    });
    waqfPageLoads.set(key, promise);
    return promise;
  }

  function addWaqfMarkers(wrap, page) {
    // Layout loading can finish after the stops have already appeared. Keep
    // the existing SVG so that keyboard focus survives that completion.
    if (wrap.querySelector(".waqfMarkerLayer")?.dataset.page === String(page)) return;
    wrap.querySelector(".waqfMarkerLayer")?.remove();
    const data = waqfPages[String(page)];
    if (!data) return;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.classList.add("waqfMarkerLayer");
    svg.dataset.page = String(page);
    svg.setAttribute("viewBox", `0 0 ${data.imageWidth} ${data.imageHeight}`);
    svg.setAttribute("aria-label", "Supplemental waqf stops");
    data.markers.forEach((marker) => {
      const { geometry } = marker;
      const x = geometry.x * data.imageWidth;
      const top = geometry.top * data.imageHeight;
      const size = geometry.size;
      const group = document.createElementNS(ns, "g");
      group.classList.add("waqfMarker");
      group.classList.toggle("selected", marker.id === selectedWaqfMarkerId);
      group.dataset.markerId = marker.id;
      group.dataset.ambiguous = String(marker.ambiguous);
      group.dataset.stopType = marker.stopType;
      const category = marker.stopType === "necessity" ? "Continuing preferred"
        : marker.stopType === "unspecified" ? "Category unspecified"
          : marker.stopType === "lazim" ? "Source category: لازم" : "Permitted stop";
      group.style.color = marker.stopType === "necessity" ? "#737373"
        : marker.stopType === "unspecified" ? "#947039" : "#873d50";
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", `${category}${marker.ambiguous ? "; possible location" : ""} after ${marker.stopAfter}, ${marker.ref}`);
      const title = document.createElementNS(ns, "title");
      title.textContent = `${marker.stopAfter} · ${marker.ref} · ${category}${marker.ambiguous ? " · repeated wording: possible location" : ""}`;
      const hit = document.createElementNS(ns, "rect");
      hit.classList.add("waqfMarkerHit");
      hit.setAttribute("x", x-12);
      hit.setAttribute("y", top-3);
      hit.setAttribute("width", "24");
      hit.setAttribute("height", Math.max(30, geometry.lineBottom*data.imageHeight-top+5));
      const shape = document.createElementNS(ns, "path");
      shape.setAttribute("d", "M50 7 C45 24 33 39 15 50 C33 61 45 76 50 93 C55 76 67 61 85 50 C67 39 55 24 50 7 Z");
      shape.setAttribute("transform", `translate(${x-size/2} ${top}) scale(${size/100})`);
      if (marker.stopType === "necessity" || marker.stopType === "unspecified") {
        shape.setAttribute("fill", "none");
        shape.setAttribute("stroke", "currentColor");
        shape.setAttribute("stroke-width", "6");
      }
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", x);
      line.setAttribute("x2", x);
      line.setAttribute("y1", geometry.lineTop*data.imageHeight);
      line.setAttribute("y2", geometry.lineBottom*data.imageHeight);
      group.append(title, hit, shape, line);
      group.addEventListener("click", () => selectWaqfMarker(marker.id));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectWaqfMarker(marker.id);
        }
      });
      svg.appendChild(group);
    });
    wrap.appendChild(svg);
  }

  function overlayBoxesForPage(page, mode) {
    if (mode === "waqf") return [];
    if (mode === "hifz") return hifzBoxesForPage(page);
    if (mode === "mutashabihat") return mutashabihatBoxesForPage(page);
    if (mode === "mutashabihatPrevious") return mutashabihatPreviousBoxesForPage(page);
    return highlightBoxesForPage(page);
  }

  function fallbackPage(mode = "test") {
    const div = document.createElement("div");
    div.className = "fallback";
    const text = document.createElement("div");
    text.className = "fallbackText";
    const fallbackAyat = mode === "test" && question ? question.chunk : [];
    if (!fallbackAyat.length) {
      text.textContent = "Page image unavailable.";
      div.appendChild(text);
      return div;
    }
    fallbackAyat.forEach((ayah) => {
      const span = document.createElement("span");
      span.className = `verse ${highlightClass(ayah.key)}`;
      span.textContent = `${ayah.ar} `;
      text.appendChild(span);
    });
    div.appendChild(text);
    return div;
  }

  function renderImagePage(page, mode = "test") {
    const fig = document.createElement("figure");
    fig.className = "pageFig";
    fig.dataset.mode = mode;
    const cap = document.createElement("figcaption");

    const wrap = document.createElement("div");
    wrap.className = "imageWrap";
    const img = document.createElement("img");
    img.className = "mushaf";
    img.loading = "lazy";

    wrap.appendChild(img);
    fig.append(cap, wrap);
    updateImagePage(fig, page, mode);
    return fig;
  }

  function updateImagePage(fig, page, mode = fig.dataset.mode || "test") {
    fig.dataset.page = String(page);
    fig.dataset.mode = mode;
    const cap = fig.querySelector("figcaption");
    let wrap = fig.querySelector(".imageWrap");

    if (!wrap) {
      fig.querySelector(".fallback")?.remove();
      wrap = document.createElement("div");
      wrap.className = "imageWrap";
      const img = document.createElement("img");
      img.className = "mushaf";
      img.loading = "lazy";
      wrap.appendChild(img);
      fig.appendChild(wrap);
    }

    const img = wrap.querySelector(".mushaf");
    const pageLayout = layoutForPage(page);
    cap.textContent = `Madinah mushaf · page ${page}`;
    if (pageLayout) {
      wrap.style.aspectRatio = `${pageLayout.w} / ${pageLayout.h}`;
    }
    wrap.querySelectorAll(".band").forEach((band) => band.remove());
    wrap.querySelector(".waqfMarkerLayer")?.remove();
    img.alt = `Madinah mushaf page ${page}`;
    img.onerror = () => {
      wrap.replaceWith(fallbackPage(mode));
    };
    img.src = pagePath(page);
    addBands(wrap, overlayBoxesForPage(page, mode));
    if (mode === "waqf") addWaqfMarkers(wrap, page);
    wrap.onclick = mode === "mutashabihat" ? (event) => selectBandAtPoint(wrap, event) : null;
    wrap.onpointerdown = mode === "mutashabihat" ? (event) => selectBandAtPoint(wrap, event) : null;
    const loads = [loadLayoutPage(page)];
    if (mode === "hifz") loads.push(loadHifzPage(page));
    if (mode === "mutashabihat") loads.push(loadMutashabihatPage(page));
    if (mode === "waqf") loads.push(loadWaqfPage(page));
    Promise.all(loads).then(() => {
      if (fig.dataset.page === String(page)) {
        wrap.querySelectorAll(".band").forEach((band) => band.remove());
        addBands(wrap, overlayBoxesForPage(page, mode));
        if (mode === "hifz") renderHifzLegend();
        if (mode === "mutashabihat") renderMutashabihatDetails();
        if (mode === "waqf") {
          addWaqfMarkers(wrap, page);
          if (waqfPage === page && fig.isConnected) renderWaqfStops();
        }
      }
    }).catch(() => {
      if (mode === "waqf" && waqfPage === page && fig.isConnected) {
        els.waqfStops.textContent = "Could not load the stops for this page. ";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "secondary small";
        retry.textContent = "Retry";
        retry.addEventListener("click", renderWaqfPage);
        els.waqfStops.appendChild(retry);
      }
    });
  }

  function navigateAnswerPage(delta) {
    const pages = viewerPages();
    if (pages.length <= 1) return;
    const nextIndex = Math.max(0, Math.min(pages.length - 1, answerPageIndex + delta));
    if (nextIndex === answerPageIndex) return;
    answerPageIndex = nextIndex;
    updatePageViewer();
  }

  function attachSwipeNavigation(el) {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    el.addEventListener("pointerdown", (event) => {
      tracking = true;
      startX = event.clientX;
      startY = event.clientY;
    });

    el.addEventListener("pointerup", (event) => {
      if (!tracking) return;
      tracking = false;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      navigateAnswerPage(dx < 0 ? 1 : -1);
    });

    el.addEventListener("pointercancel", () => {
      tracking = false;
    });
  }

  function renderPageViewer() {
    const pages = viewerPages();
    answerPageIndex = Math.max(0, Math.min(pages.length - 1, answerPageIndex));
    const page = pages[answerPageIndex];
    const viewer = document.createElement("div");
    viewer.className = `pageViewer${pages.length === 1 ? " single" : ""}`;

    const prev = document.createElement("button");
    prev.className = "pageNav pageNavPrev";
    prev.type = "button";
    prev.textContent = "›";
    prev.setAttribute("aria-label", "Previous page");
    prev.disabled = answerPageIndex === 0;
    prev.addEventListener("click", () => navigateAnswerPage(-1));

    const next = document.createElement("button");
    next.className = "pageNav pageNavNext";
    next.type = "button";
    next.textContent = "‹";
    next.setAttribute("aria-label", "Next page");
    next.disabled = answerPageIndex === pages.length - 1;
    next.addEventListener("click", () => navigateAnswerPage(1));

    const viewport = document.createElement("div");
    viewport.className = "pageViewport";
    viewport.appendChild(renderImagePage(page));
    attachSwipeNavigation(viewport);

    const status = document.createElement("div");
    status.className = "pageStatus";
    status.textContent = pages.length > 1 ? `${answerPageIndex + 1} / ${pages.length}` : "";

    viewer.append(prev, viewport, next, status);
    updatePageViewer(viewer);
    return viewer;
  }

  function updatePageViewer(viewer = els.pageArea.querySelector(".pageViewer")) {
    if (!viewer) return;
    const pages = viewerPages();
    answerPageIndex = Math.max(0, Math.min(pages.length - 1, answerPageIndex));
    const page = pages[answerPageIndex];

    viewer.className = `pageViewer${pages.length === 1 ? " single" : ""}`;
    viewer.querySelector(".pageNavPrev").disabled = answerPageIndex === 0;
    viewer.querySelector(".pageNavNext").disabled = answerPageIndex === pages.length - 1;
    viewer.querySelector(".pageStatus").textContent =
      pages.length > 1 ? `${answerPageIndex + 1} / ${pages.length}` : "";
    updateImagePage(viewer.querySelector(".pageFig"), page);
    preloadAdjacentPages(pages, answerPageIndex);
  }

  function renderHifzLegend() {
    const data = hifzChunkPages[String(hifzPage)];
    const manifestPage = (hifzManifest.pages || {})[String(hifzPage)];
    els.hifzLegend.textContent = "";
    els.hifzRef.textContent = data
      ? `Page ${hifzPage} · ${data.range} · ${data.chunks.length} chunks`
      : `Page ${hifzPage}${manifestPage ? ` · ${manifestPage.range}` : ""}`;
    if (!data) return;

    data.chunks.forEach((chunk) => {
      const item = document.createElement("div");
      item.className = "hifzLegendItem";
      const color = hifzColorForChunk(chunk);
      const swatch = document.createElement("span");
      swatch.className = "hifzSwatch";
      swatch.style.background = color.fill;
      swatch.style.borderColor = color.border;
      const text = document.createElement("span");
      text.textContent = `${chunk.verses} · ${chunk.lines} lines`;
      item.append(swatch, text);
      els.hifzLegend.appendChild(item);
    });
  }

  function renderHifzPage() {
    hifzPage = clamp(els.hifzPage.value, 1, 604);
    els.hifzPage.value = hifzPage;
    localStorage.setItem("quran-hifz-page", String(hifzPage));
    els.hifzPageArea.textContent = "";
    const viewer = document.createElement("div");
    viewer.className = "pageViewer single";
    const prev = document.createElement("button");
    prev.className = "pageNav pageNavPrev";
    prev.type = "button";
    prev.textContent = "›";
    prev.setAttribute("aria-label", "Previous page");
    prev.disabled = hifzPage <= 1;
    prev.addEventListener("click", () => setHifzPage(hifzPage - 1));
    const next = document.createElement("button");
    next.className = "pageNav pageNavNext";
    next.type = "button";
    next.textContent = "‹";
    next.setAttribute("aria-label", "Next page");
    next.disabled = hifzPage >= 604;
    next.addEventListener("click", () => setHifzPage(hifzPage + 1));
    const viewport = document.createElement("div");
    viewport.className = "pageViewport";
    viewport.appendChild(renderImagePage(hifzPage, "hifz"));
    const status = document.createElement("div");
    status.className = "pageStatus";
    status.textContent = `page ${hifzPage}`;
    viewer.append(prev, viewport, next, status);
    els.hifzPageArea.appendChild(viewer);
    renderHifzLegend();
    preloadAdjacentPages(mushafPages, hifzPage - 1);
  }

  function setHifzPage(page) {
    hifzPage = clamp(page, 1, 604);
    els.hifzPage.value = hifzPage;
    renderHifzPage();
  }

  function renderMutashabihatPage() {
    mutashabihatPage = clamp(els.mutashabihatPage.value, 1, 604);
    els.mutashabihatPage.value = mutashabihatPage;
    localStorage.setItem("quran-mutashabihat-page", String(mutashabihatPage));
    selectedMutashabihatMatchId = null;
    els.mutashabihatOverlay.hidden = true;
    els.mutashabihatOverlay.textContent = "";
    const manifestPage = (mutashabihatManifest.pages || {})[String(mutashabihatPage)];
    els.mutashabihatRef.textContent = `Page ${mutashabihatPage} · ${manifestPage ? manifestPage.matches : 0} possible links`;
    els.mutashabihatPageArea.textContent = "";
    const viewer = document.createElement("div");
    viewer.className = "pageViewer single";
    const prev = document.createElement("button");
    prev.className = "pageNav pageNavPrev";
    prev.type = "button";
    prev.textContent = "›";
    prev.setAttribute("aria-label", "Previous page");
    prev.disabled = mutashabihatPage <= 1;
    prev.addEventListener("click", () => setMutashabihatPage(mutashabihatPage - 1));
    const next = document.createElement("button");
    next.className = "pageNav pageNavNext";
    next.type = "button";
    next.textContent = "‹";
    next.setAttribute("aria-label", "Next page");
    next.disabled = mutashabihatPage >= 604;
    next.addEventListener("click", () => setMutashabihatPage(mutashabihatPage + 1));
    const viewport = document.createElement("div");
    viewport.className = "pageViewport";
    viewport.appendChild(renderImagePage(mutashabihatPage, "mutashabihat"));
    const status = document.createElement("div");
    status.className = "pageStatus";
    status.textContent = `page ${mutashabihatPage}`;
    viewer.append(prev, viewport, next, status);
    els.mutashabihatPageArea.appendChild(viewer);
    preloadAdjacentPages(mushafPages, mutashabihatPage - 1);
  }

  function setMutashabihatPage(page) {
    mutashabihatPage = clamp(page, 1, 604);
    els.mutashabihatPage.value = mutashabihatPage;
    renderMutashabihatPage();
  }

  function selectMutashabihatMatch(id) {
    if (selectedMutashabihatMatchId === id && !els.mutashabihatOverlay.hidden) return;
    selectedMutashabihatMatchId = id;
    renderMutashabihatDetails();
    const fig = els.mutashabihatPageArea.querySelector(".pageFig");
    if (fig) updateImagePage(fig, mutashabihatPage, "mutashabihat");
  }

  function closeMutashabihatOverlay() {
    if (!selectedMutashabihatMatchId && els.mutashabihatOverlay.hidden) return;
    selectedMutashabihatMatchId = null;
    els.mutashabihatOverlay.hidden = true;
    els.mutashabihatOverlay.textContent = "";
    const fig = els.mutashabihatPageArea.querySelector(".pageFig");
    if (fig) updateImagePage(fig, mutashabihatPage, "mutashabihat");
  }

  function handleMutashabihatOutsidePointerDown(event) {
    if (activePanel !== "mutashabihat" || els.mutashabihatOverlay.hidden) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (els.mutashabihatOverlay.contains(target)) return;
    if (target.closest(".mutashabihBand[data-match-id]")) return;
    closeMutashabihatOverlay();
  }

  function renderDiffWords(container, parts) {
    container.textContent = "";
    parts.forEach((part, index) => {
      if (index) container.append(" ");
      const span = document.createElement("span");
      span.className = `diffWord ${part.kind}`;
      span.textContent = part.text;
      container.appendChild(span);
    });
  }

  function renderCompareLine(label, parts) {
    const line = document.createElement("div");
    line.className = "compareLine";
    const labelEl = document.createElement("div");
    labelEl.className = "compareLabel";
    labelEl.textContent = label;
    const arabic = document.createElement("div");
    arabic.className = "compareArabic";
    renderDiffWords(arabic, parts);
    line.append(labelEl, arabic);
    return line;
  }

  function renderMutashabihatDetails() {
    const matches = mutashabihatMatchesForPage(mutashabihatPage);
    const rawCount = rawMutashabihatMatchCount(mutashabihatPage);
    const suffix = rawCount && rawCount !== matches.length ? `${matches.length}/${rawCount}` : matches.length;
    els.mutashabihatRef.textContent = `Page ${mutashabihatPage} · ${suffix} earlier links`;
    const match = mutashabihatMatchById(selectedMutashabihatMatchId);
    if (!match) {
      els.mutashabihatOverlay.hidden = true;
      els.mutashabihatOverlay.textContent = "";
      return;
    }
    els.mutashabihatOverlay.textContent = "";
    els.mutashabihatOverlay.hidden = false;
    const head = document.createElement("div");
    head.className = "mutashabihatOverlayHead";
    const titleWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "mutashabihatOverlayTitle";
    title.textContent = `${match.current} vs ${match.previous}`;
    const note = document.createElement("div");
    note.className = "mutashabihatOverlayNote";
    note.textContent = match.note || "Similar wording";
    titleWrap.append(title, note);
    const close = document.createElement("button");
    close.className = "overlayClose";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close comparison");
    close.addEventListener("click", closeMutashabihatOverlay);
    head.append(titleWrap, close);
    const text = document.createElement("div");
    text.className = "compareText";
    if (match.phraseText) {
      const phrase = document.createElement("div");
      phrase.className = "comparePhrase";
      phrase.dir = "rtl";
      phrase.textContent = match.phraseText;
      text.appendChild(phrase);
    }
    const previousParts = match.previousPhraseDiff || match.previousDiff || [];
    const currentParts = match.currentPhraseDiff || match.currentDiff || [];
    text.append(
      renderCompareLine(`Earlier phrase · ${match.previous} · page ${match.previousPage}`, previousParts),
      renderCompareLine(`Current phrase · ${match.current} · page ${match.currentPage}`, currentParts)
    );
    const page = document.createElement("div");
    page.className = "comparePage";
    page.appendChild(renderImagePage(match.previousPage, "mutashabihatPrevious"));
    els.mutashabihatOverlay.append(head, text, page);
  }

  function updateMutashabihatSensitivity() {
    mutashabihatSensitivity = clamp(els.mutashabihatSensitivity.value, 1, 5);
    localStorage.setItem("quran-mutashabihat-sensitivity", String(mutashabihatSensitivity));
    updateMutashabihatSensitivityLabel();
    selectedMutashabihatMatchId = null;
    els.mutashabihatOverlay.hidden = true;
    els.mutashabihatOverlay.textContent = "";
    const fig = els.mutashabihatPageArea.querySelector(".pageFig");
    if (fig) updateImagePage(fig, mutashabihatPage, "mutashabihat");
    renderMutashabihatDetails();
  }

  function selectWaqfMarker(id) {
    selectedWaqfMarkerId = id;
    els.waqfPageArea.querySelectorAll(".waqfMarker").forEach((marker) => {
      marker.classList.toggle("selected", marker.dataset.markerId === id);
    });
    renderWaqfStops();
  }

  function renderWaqfStops() {
    const data = waqfPages[String(waqfPage)];
    if (!data) return;
    els.waqfRef.textContent = `Page ${waqfPage} · ${data.markers.length} supplemental stops`;
    els.waqfStops.textContent = "";
    if (!data.markers.length) els.waqfStops.textContent = "No additional stops located on this page.";
    data.markers.forEach((marker) => {
      const item = document.createElement("div");
      item.className = "waqfStopItem";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "waqfStopButton secondary";
      button.setAttribute("aria-pressed", String(marker.id === selectedWaqfMarkerId));
      const arabic = document.createElement("span");
      arabic.lang = "ar";
      arabic.dir = "rtl";
      arabic.textContent = marker.stopAfter;
      const ref = document.createElement("span");
      ref.textContent = `${marker.ref}${marker.ambiguous ? " · Possible" : ""}`;
      if (marker.stopType === "unspecified") ref.textContent += " · Category unspecified";
      button.append(arabic, ref);
      button.addEventListener("click", () => selectWaqfMarker(marker.id));
      item.appendChild(button);
      if (marker.id === selectedWaqfMarkerId) {
        const sources = data.stops.filter((stop) => marker.sourceIds.includes(stop.id));
        sources.forEach((stop) => {
          const details = document.createElement("div");
          details.className = "waqfSource";
          const category = stop.stopType === "jaiz" ? "Permitted stop"
            : stop.stopType === "necessity" ? "Permitted out of necessity; continuing preferred"
              : stop.stopType === "lazim" ? "Source category: لازم" : "Source category unspecified";
          const label = document.createElement("span");
          label.textContent = `${category} · PDF page ${stop.source.pdfPage}, row ${stop.source.row}`;
          const link = document.createElement("a");
          link.href = `data/Woukoufet-Al-Koran-V2.pdf#page=${stop.source.pdfPage}`;
          link.target = "_blank";
          link.rel = "noopener";
          link.textContent = "Open source";
          details.append(label, link);
          if (stop.ambiguous) {
            const note = document.createElement("span");
            note.textContent = `The source wording has ${stop.ambiguity.candidateCount} possible locations. All are kept as potential stops.`;
            details.appendChild(note);
          }
          if (stop.existingMarks.length) {
            const note = document.createElement("span");
            note.textContent = "This possible location also has a printed stop sign.";
            details.appendChild(note);
          }
          item.appendChild(details);
        });
      }
      els.waqfStops.appendChild(item);
    });
    const unresolved = [...new Map(data.unresolved.map((entry) => [entry.sourceRowId, entry])).values()];
    els.waqfUnresolved.hidden = !unresolved.length;
    els.waqfUnresolvedSummary.textContent = `${unresolved.length} source entries still need checking`;
    els.waqfUnresolvedEntries.textContent = "";
    unresolved.forEach((entry) => {
      const line = document.createElement("p");
      const phrase = document.createElement("span");
      phrase.lang = "ar";
      phrase.dir = "rtl";
      phrase.textContent = entry.phrase;
      line.append(phrase, document.createTextNode(` · PDF page ${entry.pdfPage}`));
      els.waqfUnresolvedEntries.appendChild(line);
    });
  }

  function renderWaqfPage() {
    waqfPage = clamp(els.waqfPage.value, 1, 604);
    els.waqfPage.value = waqfPage;
    localStorage.setItem("quran-waqf-page", String(waqfPage));
    selectedWaqfMarkerId = null;
    const pageMeta = (waqfManifest.pages || {})[String(waqfPage)];
    els.waqfRef.textContent = `Page ${waqfPage}${pageMeta ? ` · ${pageMeta.markers} supplemental stops` : ""}`;
    els.waqfStops.textContent = "Loading stops…";
    els.waqfUnresolved.hidden = true;
    els.waqfUnresolved.open = false;
    els.waqfPageArea.textContent = "";
    const viewer = document.createElement("div");
    viewer.className = "pageViewer single";
    const prev = document.createElement("button");
    prev.className = "pageNav pageNavPrev";
    prev.type = "button";
    prev.textContent = "›";
    prev.setAttribute("aria-label", "Previous page");
    prev.disabled = waqfPage <= 1;
    prev.addEventListener("click", () => setWaqfPage(waqfPage - 1));
    const next = document.createElement("button");
    next.className = "pageNav pageNavNext";
    next.type = "button";
    next.textContent = "‹";
    next.setAttribute("aria-label", "Next page");
    next.disabled = waqfPage >= 604;
    next.addEventListener("click", () => setWaqfPage(waqfPage + 1));
    const viewport = document.createElement("div");
    viewport.className = "pageViewport";
    viewport.appendChild(renderImagePage(waqfPage, "waqf"));
    const status = document.createElement("div");
    status.className = "pageStatus";
    status.textContent = `page ${waqfPage}`;
    viewer.append(prev, viewport, next, status);
    els.waqfPageArea.appendChild(viewer);
    renderWaqfStops();
    preloadAdjacentPages(mushafPages, waqfPage - 1);
  }

  function setWaqfPage(page) {
    els.waqfPage.value = clamp(page, 1, 604);
    renderWaqfPage();
  }

  function setActivePanel(mode) {
    activePanel = ["hifz", "mutashabihat", "waqf"].includes(mode) ? mode : "test";
    els.testTab.classList.toggle("active", activePanel === "test");
    els.hifzTab.classList.toggle("active", activePanel === "hifz");
    els.mutashabihatTab.classList.toggle("active", activePanel === "mutashabihat");
    els.waqfTab.classList.toggle("active", activePanel === "waqf");
    [els.testTab, els.hifzTab, els.mutashabihatTab, els.waqfTab].forEach((tab) => {
      const selected = tab.classList.contains("active");
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    els.testPanel.hidden = activePanel !== "test";
    els.hifzPanel.hidden = activePanel !== "hifz";
    els.mutashabihatPanel.hidden = activePanel !== "mutashabihat";
    els.waqfPanel.hidden = activePanel !== "waqf";
    if (activePanel === "hifz") renderHifzPage();
    if (activePanel === "mutashabihat") renderMutashabihatPage();
    if (activePanel === "waqf") renderWaqfPage();
  }

  function renderAnswerPages() {
    els.pageArea.textContent = "";
    els.pageArea.appendChild(renderPageViewer());
    if (question.cfg.translation) els.pageArea.appendChild(renderTranslation());
  }

  function renderTranslation() {
    const div = document.createElement("div");
    div.className = "translation";
    question.chunk.forEach((ayah) => {
      const row = document.createElement("div");
      row.innerHTML = `<b>${ayah.s}:${ayah.a}</b> ${escapeHtml(ayah.en)}`;
      div.appendChild(row);
    });
    return div;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function reveal() {
    if (!question) return;
    els.reveal.disabled = true;
    loadLayoutPage(question.entry.page);
    const last = question.chunk[question.chunk.length - 1];
    const pagesTxt =
      question.entry.page === last.page ? `page ${question.entry.page}` : `pages ${question.entry.page}-${last.page}`;
    els.ref.textContent = `${question.entry.s_en} ${question.span} · ${pagesTxt}`;
    const pages = viewerPages();
    answerPageIndex = Math.max(0, pages.indexOf(question.entry.page));
    renderAnswerPages();
    els.answer.hidden = false;
  }

  function grade(value) {
    tally[value] = (tally[value] || 0) + 1;
    renderStats();
    loadNext();
  }

  function rerenderAnswer() {
    saveSettings();
    if (!question || els.answer.hidden) return;
    question.cfg = settings();
    reveal();
  }

  function init() {
    if (!ayat.length) {
      els.prompt.textContent = "Static Quran data is missing.";
      els.hint.textContent = "Run tools/build_static_assets.py to generate the local data files.";
      els.reveal.disabled = true;
      return;
    }

    initQuranIndex();
    initRangeControls();
    loadSettings();
    els.reveal.addEventListener("click", reveal);
    els.skip.addEventListener("click", loadNext);
    els.next.addEventListener("click", loadNext);
    document.querySelectorAll("[data-grade]").forEach((button) => {
      button.addEventListener("click", () => grade(button.dataset.grade));
    });
    els.rangeModes.forEach((input) => {
      input.addEventListener("change", () => {
        const currentRange = selectedMode() === "pages" ? selectedPageRange() : selectedAyahRange();
        syncControlsToRange(currentRange);
        setMode(input.value);
        loadNext();
      });
    });
    [els.startPage, els.endPage].forEach((input) => input.addEventListener("change", loadNext));
    els.startSurah.addEventListener("change", () => {
      populateAyahSelect("start", els.startSurah.value, 1);
      loadNext();
    });
    els.endSurah.addEventListener("change", () => {
      const meta = surahs[Number(els.endSurah.value) - 1] || surahs[0];
      populateAyahSelect("end", els.endSurah.value, meta.count);
      loadNext();
    });
    [els.startAyah, els.endAyah, els.words, els.lines].forEach((input) => input.addEventListener("change", loadNext));
    [els.highlight, els.translation].forEach((input) => input.addEventListener("change", rerenderAnswer));
    els.testTab.addEventListener("click", () => setActivePanel("test"));
    els.hifzTab.addEventListener("click", () => setActivePanel("hifz"));
    els.mutashabihatTab.addEventListener("click", () => setActivePanel("mutashabihat"));
    els.waqfTab.addEventListener("click", () => setActivePanel("waqf"));
    const modeTabs = [els.testTab, els.hifzTab, els.mutashabihatTab, els.waqfTab];
    const tabModes = ["test", "hifz", "mutashabihat", "waqf"];
    document.querySelector(".appTabs").addEventListener("keydown", (event) => {
      const current = modeTabs.indexOf(event.target);
      if (current < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? modeTabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + modeTabs.length) % modeTabs.length;
      setActivePanel(tabModes[next]);
      modeTabs[next].focus();
    });
    els.hifzPage.addEventListener("change", renderHifzPage);
    els.mutashabihatPage.addEventListener("change", renderMutashabihatPage);
    els.waqfPage.addEventListener("change", renderWaqfPage);
    els.mutashabihatSensitivity.addEventListener("input", updateMutashabihatSensitivity);
    document.addEventListener("pointerdown", handleMutashabihatOutsidePointerDown, true);
    hifzPage = clamp(localStorage.getItem("quran-hifz-page") || els.hifzPage.value, 1, 604);
    els.hifzPage.value = hifzPage;
    mutashabihatPage = clamp(localStorage.getItem("quran-mutashabihat-page") || els.mutashabihatPage.value, 1, 604);
    els.mutashabihatPage.value = mutashabihatPage;
    waqfPage = clamp(localStorage.getItem("quran-waqf-page") || els.waqfPage.value, 1, 604);
    els.waqfPage.value = waqfPage;
    mutashabihatSensitivity = clamp(
      localStorage.getItem("quran-mutashabihat-sensitivity") || els.mutashabihatSensitivity.value,
      1,
      5
    );
    updateMutashabihatSensitivityLabel();
    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.target.closest("input, select, textarea, button, .waqfMarker")) return;
      if (activePanel === "hifz") {
        if (event.key === "ArrowLeft") setHifzPage(hifzPage + 1);
        else if (event.key === "ArrowRight") setHifzPage(hifzPage - 1);
      } else if (activePanel === "mutashabihat") {
        if (event.key === "ArrowLeft") setMutashabihatPage(mutashabihatPage + 1);
        else if (event.key === "ArrowRight") setMutashabihatPage(mutashabihatPage - 1);
      } else if (activePanel === "waqf") {
        if (event.key === "ArrowLeft") setWaqfPage(waqfPage + 1);
        else if (event.key === "ArrowRight") setWaqfPage(waqfPage - 1);
      } else if (event.key === " " && els.answer.hidden) {
        event.preventDefault();
        if (!els.reveal.disabled) reveal();
      } else if (!els.answer.hidden) {
        if (event.key === "ArrowLeft") navigateAnswerPage(1);
        else if (event.key === "ArrowRight") navigateAnswerPage(-1);
        else if (event.key === "1") grade("clean");
        else if (event.key === "2") grade("hesitated");
        else if (event.key === "3") grade("failed");
      }
    });
    loadNext();
    const waqfRoute = location.hash.match(/^#waqf(?:=(\d+))?$/);
    if (waqfRoute) {
      if (waqfRoute[1]) els.waqfPage.value = clamp(waqfRoute[1], 1, 604);
      setActivePanel("waqf");
    }
  }

  init();
})();
