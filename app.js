(function () {
  "use strict";

  const ayat = window.QURAN_AYAT || [];
  const lineBands = window.QURAN_LINE_BANDS || {};
  const ayahLayoutPages = window.QURAN_AYAH_LAYOUT_PAGES || (window.QURAN_AYAH_LAYOUT_PAGES = {});
  const ayahLayoutData = window.QURAN_AYAH_LAYOUT || {};
  const ayahLayoutManifest = window.QURAN_AYAH_LAYOUT_MANIFEST || {};
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
  const surahs = [];
  const ayahLookup = new Map();
  const pageBounds = new Map();
  const preloadedPages = new Set();

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
    band.className = "band";
    band.style.left = `${(box.x * 100).toFixed(2)}%`;
    band.style.top = `${(box.y * 100).toFixed(2)}%`;
    band.style.width = `${(box.w * 100).toFixed(2)}%`;
    band.style.height = `${(box.h * 100).toFixed(2)}%`;
    wrap.appendChild(band);
  }

  function addBands(wrap, boxes) {
    boxes.forEach((box) => addBand(wrap, box));
  }

  function highlightClass(key) {
    if (key === question.entry.key) return "entry";
    return question.chunk.some((ayah) => ayah.key === key) ? "continuation" : "";
  }

  function fallbackPage() {
    const div = document.createElement("div");
    div.className = "fallback";
    const text = document.createElement("div");
    text.className = "fallbackText";
    question.chunk.forEach((ayah) => {
      const span = document.createElement("span");
      span.className = `verse ${highlightClass(ayah.key)}`;
      span.textContent = `${ayah.ar} `;
      text.appendChild(span);
    });
    div.appendChild(text);
    return div;
  }

  function renderImagePage(page) {
    const fig = document.createElement("figure");
    fig.className = "pageFig";
    const cap = document.createElement("figcaption");

    const wrap = document.createElement("div");
    wrap.className = "imageWrap";
    const img = document.createElement("img");
    img.className = "mushaf";
    img.loading = "lazy";

    wrap.appendChild(img);
    fig.append(cap, wrap);
    updateImagePage(fig, page);
    return fig;
  }

  function updateImagePage(fig, page) {
    fig.dataset.page = String(page);
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
    img.alt = `Madinah mushaf page ${page}`;
    img.onerror = () => {
      wrap.replaceWith(fallbackPage());
    };
    img.src = pagePath(page);
    addBands(wrap, highlightBoxesForPage(page));
    loadLayoutPage(page).then(() => {
      if (fig.dataset.page === String(page)) {
        wrap.querySelectorAll(".band").forEach((band) => band.remove());
        addBands(wrap, highlightBoxesForPage(page));
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
    document.addEventListener("keydown", (event) => {
      if (event.key === " " && els.answer.hidden) {
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
  }

  init();
})();
