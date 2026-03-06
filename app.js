/**
 * AI Bible Translation Viewer
 * Auto-detects mode:
 *   - Local server (localhost:8777): fetches from /api/ endpoints
 *   - Static hosting (GitHub Pages): fetches from JSON files
 */

(function () {
  'use strict';

  // Auto-detect: if running on localhost with the API server, use API mode
  const IS_API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  let cachedChapters = null;
  let cachedAgents = null;
  let cachedDisagreements = null;
  let cachedProgress = null;
  let currentChapter = null;
  let currentView = 'translations';
  let searchScope = 'all';
  let progressShowCount = 20;
  let refreshTimer = null;

  // Cache-busting for static mode; no-op for API mode (server always returns fresh)
  function freshUrl(url) {
    if (IS_API) return url;
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'v=' + Date.now();
  }

  // ---- URL builders per mode ----
  function urlChapters() {
    return IS_API ? '/api/chapters' : './chapters.json';
  }
  function urlTranslation(agent, testament, key) {
    return IS_API ? `/api/translation/${agent}/${testament}/${key}` : `./translation_${agent}_${testament}_${key}.json`;
  }
  function urlPreface(agent) {
    return IS_API ? `/api/preface/${agent}` : `./preface_${agent}.json`;
  }
  function urlImages(key) {
    return IS_API ? `/api/images/${key.split('_')[0]}/${key.split('_')[1]}` : `./images_${key}.json`;
  }
  function urlDisagreements() {
    return IS_API ? '/api/disagreements' : './disagreements.json';
  }
  function urlDisagreement(key) {
    return IS_API ? `/api/disagreement/${key}` : `./disagreement_${key}.json`;
  }
  function urlProgress() {
    return IS_API ? '/api/progress' : './progress.json';
  }
  function imgSrc(path) {
    return IS_API ? `/manuscript/${path}` : `./manuscript/${path}`;
  }

  // ---- History (browser back/forward) ----
  var _skipPush = false; // true when navigating via popstate

  function pushState(state) {
    if (!_skipPush) {
      history.pushState(state, '', '');
    }
  }

  function restoreState(state) {
    if (!state) return;
    _skipPush = true;
    if (state.chapter) {
      switchToView('translations', true);
      openBook(state.book, true);
      openChapter(state.chapter);
    } else if (state.book) {
      switchToView('translations', true);
      openBook(state.book);
    } else if (state.view) {
      // Reset translations view to book browser
      if (state.view === 'translations') {
        document.getElementById('chapter-selector').style.display = 'none';
        document.getElementById('translation-display').style.display = 'none';
        document.getElementById('book-browser').style.display = 'block';
        currentChapter = null;
      }
      switchToView(state.view, true);
    }
    _skipPush = false;
  }

  window.addEventListener('popstate', function(e) {
    restoreState(e.state);
  });

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', () => {
    setupNav();
    setupSearch();
    setupLightbox();
    setupModal();
    setupDisagreementModal();
    loadChapters();

    // Set initial state so first back doesn't leave the site
    history.replaceState({ view: 'translations' }, '', '');

    // Auto-refresh in API mode (local server)
    if (IS_API) {
      refreshTimer = setInterval(() => {
        loadChapters();
        if (currentView === 'progress') loadProgress();
        if (currentView === 'disagreements') loadDisagreementSelector();
      }, 30000);
    }
  });

  // ---- Navigation ----
  function setupNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        switchToView(view);
      });
    });
  }

  function switchToView(view, fromHistory) {
    currentView = view;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.nav-btn[data-view="${view}"]`);
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');

    // Hide search results when switching
    document.getElementById('search-results').style.display = 'none';
    document.getElementById('search-input').value = '';
    document.getElementById('search-clear').style.display = 'none';

    if (!fromHistory) pushState({ view: view });

    if (view === 'manuscripts') loadManuscriptSelector();
    if (view === 'disagreements') loadDisagreementSelector();
    if (view === 'guides') loadGuides();
    if (view === 'progress') loadProgress();
  }

  // ---- Search ----
  function setupSearch() {
    const input = document.getElementById('search-input');
    const clearBtn = document.getElementById('search-clear');
    const resultsEl = document.getElementById('search-results');

    document.querySelectorAll('.search-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.search-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        searchScope = chip.dataset.scope;
        if (input.value.trim()) performSearch(input.value.trim());
      });
    });

    let debounce;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      clearBtn.style.display = q ? 'block' : 'none';
      if (!q) {
        resultsEl.style.display = 'none';
        return;
      }
      debounce = setTimeout(() => performSearch(q), 200);
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.style.display = 'none';
      resultsEl.style.display = 'none';
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && resultsEl.style.display !== 'none') {
        input.value = '';
        clearBtn.style.display = 'none';
        resultsEl.style.display = 'none';
      }
    });
  }

  function performSearch(query) {
    if (!cachedChapters) return;
    const q = query.toLowerCase();
    const results = [];
    const keys = Object.keys(cachedChapters);

    for (const key of keys) {
      const ch = cachedChapters[key];
      const matchStr = `${ch.book_name} ${ch.book_code} ${ch.chapter} ${key}`.toLowerCase();
      if (!matchStr.includes(q)) continue;

      const label = `${ch.book_name} ${ch.chapter}`;

      if (searchScope === 'all' || searchScope === 'translations') {
        results.push({ type: 'Translation', label, key, action: 'translation' });
      }
      if (searchScope === 'all' || searchScope === 'manuscripts') {
        results.push({ type: 'Manuscript', label, key, action: 'manuscript' });
      }
      if ((searchScope === 'all' || searchScope === 'disagreements') && cachedDisagreements) {
        const has = cachedDisagreements.find(d => d.key === key);
        if (has) results.push({ type: 'Disagreement', label, key, action: 'disagreement' });
      }
      if ((searchScope === 'all' || searchScope === 'progress') && cachedProgress) {
        const has = cachedProgress.entries.find(e => e.raw.includes(key));
        if (has) results.push({ type: 'Progress', label: key, key, action: 'progress' });
      }
    }

    const resultsEl = document.getElementById('search-results');
    const content = document.getElementById('search-results-content');

    if (results.length === 0) {
      content.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:1rem;">No results found.</p>';
      resultsEl.style.display = 'block';
      return;
    }

    const shown = results.slice(0, 20);
    content.innerHTML = shown.map(r => `
      <div class="search-result-item" data-action="${r.action}" data-key="${r.key}">
        <span class="search-result-type">${r.type}</span>
        <span class="search-result-title">${escapeHtml(r.label)}</span>
        <span class="search-result-sub">${r.key}</span>
      </div>
    `).join('');

    if (results.length > 20) {
      content.innerHTML += `<p style="color:var(--text-dim);text-align:center;font-size:0.8rem;padding:0.5rem;">Showing 20 of ${results.length} results</p>`;
    }

    resultsEl.style.display = 'block';

    content.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        const key = item.dataset.key;
        resultsEl.style.display = 'none';
        document.getElementById('search-input').value = '';
        document.getElementById('search-clear').style.display = 'none';

        if (action === 'translation') {
          switchToView('translations');
          openChapter(key);
        } else if (action === 'manuscript') {
          switchToView('manuscripts');
          openManuscriptChapter(key);
        } else if (action === 'disagreement') {
          switchToView('disagreements');
          openDisagreement(key);
        } else if (action === 'progress') {
          switchToView('progress');
          document.getElementById('progress-filter').value = key.split('_')[0];
          filterProgressEntries();
        }
      });
    });
  }

  // ---- Load Chapters ----
  let cachedBookMeta = null;

  async function loadChapters() {
    try {
      const chapResp = await fetch(freshUrl(urlChapters()));
      const data = await chapResp.json();
      cachedChapters = data.chapters;
      cachedAgents = data.agents;
      try {
        const metaResp = await fetch(freshUrl(IS_API ? '/api/book-meta' : './book-meta.json'));
        if (metaResp && metaResp.ok) {
          const metaData = await metaResp.json();
          cachedBookMeta = metaData.books || {};
        }
      } catch (_) { /* book-meta is optional */ }
      renderBookBrowser(data.chapters);
      loadDisagreementsData();
    } catch (err) {
      console.error('Failed to load chapters:', err);
      const el = document.getElementById('no-chapters');
      if (el) { el.style.display = 'block'; el.innerHTML = '<p style="color:#c9a84c;">Loading error — please refresh the page.</p>'; }
    }
  }

  function renderBookBrowser(chapters) {
    const noChapters = document.getElementById('no-chapters');
    const otGrid = document.getElementById('ot-book-cards');
    const ntGrid = document.getElementById('nt-book-cards');

    if (!otGrid || !ntGrid) {
      console.error('Book browser: missing grid elements');
      return;
    }

    const keys = Object.keys(chapters);
    if (keys.length === 0) {
      noChapters.style.display = 'block';
      return;
    }
    noChapters.style.display = 'none';

    // Group chapters by book
    const books = {};
    for (const key of keys) {
      const ch = chapters[key];
      if (!books[ch.book_code]) {
        books[ch.book_code] = {
          name: ch.book_name,
          testament: ch.testament,
          code: ch.book_code,
          chapters: [],
        };
      }
      books[ch.book_code].chapters.push({ key, ...ch });
    }

    function renderCard(bookCode, book) {
      var meta = cachedBookMeta ? cachedBookMeta[bookCode] : null;
      var totalChapters = book.chapters.length;
      var completedChapters = book.chapters.filter(function(c) { return c.agents && c.agents.sophia; }).length;
      var pct = Math.round((completedChapters / totalChapters) * 100);

      var author = meta && meta.author ? meta.author.split('.')[0].substring(0, 60) : '';
      var date = meta && meta.date ? meta.date.split('.')[0].substring(0, 50) : '';
      var summary = meta && meta.summary ? meta.summary : '';

      var metaLine = '';
      if (author && date) metaLine = author + ' | ' + date;
      else if (author) metaLine = author;
      else if (date) metaLine = date;

      return '<div class="book-card" data-book="' + bookCode + '">' +
        '<div class="book-card-header">' +
          '<h3 class="book-card-name">' + escapeHtml(book.name) + '</h3>' +
          '<span class="book-card-chapters">' + totalChapters + ' ch.</span>' +
        '</div>' +
        (metaLine ? '<div class="book-card-meta">' + escapeHtml(metaLine) + '</div>' : '') +
        (summary ? '<div class="book-card-summary">' + escapeHtml(summary) + '</div>' : '') +
        '<div class="book-card-footer">' +
          '<div class="book-card-progress">' +
            '<div class="book-card-progress-bar" style="width:' + pct + '%"></div>' +
          '</div>' +
          '<span class="book-card-pct">' + pct + '%</span>' +
        '</div>' +
      '</div>';
    }

    var otHtml = '';
    var ntHtml = '';
    var entries = Object.entries(books);
    for (var i = 0; i < entries.length; i++) {
      var bookCode = entries[i][0];
      var book = entries[i][1];
      if (book.testament === 'OT') otHtml += renderCard(bookCode, book);
      else ntHtml += renderCard(bookCode, book);
    }

    otGrid.innerHTML = otHtml;
    ntGrid.innerHTML = ntHtml;

    document.getElementById('book-browser-ot').style.display = otHtml ? 'block' : 'none';
    document.getElementById('book-browser-nt').style.display = ntHtml ? 'block' : 'none';

    // Click handlers for book cards
    document.querySelectorAll('.book-card').forEach(function(card) {
      card.addEventListener('click', function() { openBook(card.dataset.book); });
    });
  }

  function openBook(bookCode, fromHistory) {
    const book = {};
    const chapters = [];
    for (const [key, ch] of Object.entries(cachedChapters)) {
      if (ch.book_code === bookCode) {
        chapters.push({ key, ...ch });
        book.name = ch.book_name;
        book.testament = ch.testament;
      }
    }
    chapters.sort((a, b) => a.chapter - b.chapter);

    const meta = cachedBookMeta ? cachedBookMeta[bookCode] : null;

    document.getElementById('book-browser').style.display = 'none';
    document.getElementById('chapter-selector').style.display = 'block';
    document.getElementById('translation-display').style.display = 'none';
    document.getElementById('chapter-selector-title').textContent = book.name;

    if (!fromHistory) pushState({ view: 'translations', book: bookCode });

    const summaryEl = document.getElementById('chapter-selector-summary');
    if (meta && meta.summary) {
      summaryEl.textContent = meta.summary;
      summaryEl.style.display = 'block';
    } else {
      summaryEl.style.display = 'none';
    }

    // Load HESED guide panel
    loadBookHesedPanel(bookCode);

    // Build disagreement lookup for this book
    const disKeys = new Set();
    if (cachedDisagreements) {
      for (const d of cachedDisagreements) {
        if (d.key && d.key.startsWith(bookCode + '_')) disKeys.add(d.key);
      }
    }

    const container = document.getElementById('chapter-list');
    const agentNames = ['emet', 'logos', 'pneuma', 'sophia'];

    var html = '<div class="ch-card-grid">';

    for (var i = 0; i < chapters.length; i++) {
      var ch = chapters[i];
      var done = agentNames.filter(function(a) { return ch.agents[a]; }).length;
      var complete = done === 4;
      var hasDis = disKeys.has(ch.key);
      var preview = ch.preview || '';

      var dots = agentNames.map(function(a) {
        return '<span class="ch-cdot ' + a + (ch.agents[a] ? ' done' : '') + '"></span>';
      }).join('');

      html += '<div class="ch-card" data-chapter="' + ch.key + '">' +
        '<div class="ch-card-top">' +
          '<span class="ch-card-num">Chapter ' + ch.chapter + '</span>' +
          '<span class="ch-card-dots">' + dots + '</span>' +
        '</div>' +
        (preview ? '<p class="ch-card-preview">' + escapeHtml(preview) + '</p>' : '') +
        (hasDis ? '<span class="ch-card-dis" title="Disagreement notes">&#9830; Disagreement</span>' : '') +
      '</div>';
    }

    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.ch-card').forEach(function(el) {
      el.addEventListener('click', function() { openChapter(el.dataset.chapter); });
    });

    document.getElementById('back-to-books').onclick = function() {
      history.back();
    };
  }

  async function loadBookHesedPanel(bookCode) {
    var panel = document.getElementById('book-hesed-panel');
    var glanceEl = document.getElementById('hesed-glance-items');
    var howtoEl = document.getElementById('hesed-howto');
    var fullLink = document.getElementById('hesed-full-link');

    // Reset
    panel.style.display = 'none';
    glanceEl.innerHTML = '';
    howtoEl.innerHTML = '';
    howtoEl.style.display = 'none';
    fullLink.style.display = 'none';

    var url = IS_API
      ? '/api/guide/' + bookCode
      : './guide_' + bookCode + '.json';

    try {
      var resp = await fetch(freshUrl(url));
      if (!resp.ok) return;
      var data = await resp.json();
      var md = data.content || '';
      if (!md) return;

      // Parse "At a Glance" section
      var glanceItems = [];
      var inGlance = false;
      var inHowTo = false;
      var howtoLines = [];
      var lines = md.split('\n');

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.match(/^##\s+At a Glance/)) { inGlance = true; inHowTo = false; continue; }
        if (line.match(/^##\s+How to Read/)) { inHowTo = true; inGlance = false; continue; }
        if (line.match(/^##\s/) && !line.match(/At a Glance|How to Read/)) {
          inGlance = false; inHowTo = false; continue;
        }
        if (inGlance && line.startsWith('- **')) {
          var m = line.match(/^- \*\*(.+?):\*\*\s*(.*)/);
          if (m) glanceItems.push({ label: m[1], value: m[2] });
        }
        if (inHowTo && line.length > 0) {
          howtoLines.push(line);
        }
      }

      if (glanceItems.length === 0) return;

      // Render glance items
      var glanceHtml = '';
      for (var j = 0; j < glanceItems.length; j++) {
        var item = glanceItems[j];
        // Truncate long values for display
        var val = item.value;
        if (val.length > 200) {
          var cut = val.substring(0, 200).lastIndexOf('.');
          val = cut > 80 ? val.substring(0, cut + 1) : val.substring(0, 200) + '…';
        }
        glanceHtml += '<div class="hesed-glance-item">' +
          '<span class="hesed-glance-label">' + escapeHtml(item.label) + '</span>' +
          '<span class="hesed-glance-value">' + escapeHtml(val) + '</span>' +
        '</div>';
      }
      glanceEl.innerHTML = glanceHtml;

      // Render "How to Read" if available
      if (howtoLines.length > 0) {
        var howtoText = howtoLines.join(' ').replace(/\*\*/g, '');
        if (howtoText.length > 400) {
          var hcut = howtoText.substring(0, 400).lastIndexOf('.');
          howtoText = hcut > 100 ? howtoText.substring(0, hcut + 1) : howtoText.substring(0, 400) + '…';
        }
        howtoEl.innerHTML = '<h4 class="hesed-howto-title">How to Read This Book</h4>' +
          '<p class="hesed-howto-text">' + escapeHtml(howtoText) + '</p>';
        howtoEl.style.display = 'block';
      }

      // Link to full guide
      fullLink.style.display = 'inline-block';
      fullLink.onclick = function() {
        switchToView('guides');
        if (window._openGuide) window._openGuide(bookCode);
      };

      panel.style.display = 'block';
    } catch (e) {
      // Guide not available — that's fine
    }
  }

  // ---- Open Chapter ----
  async function openChapter(chapterKey) {
    currentChapter = chapterKey;
    const ch = cachedChapters[chapterKey];
    if (!ch) return;

    document.getElementById('chapter-selector').style.display = 'none';
    document.getElementById('translation-display').style.display = 'block';
    document.getElementById('chapter-title').textContent = `${ch.book_name} ${ch.chapter}`;
    document.getElementById('chapter-meta').textContent = `${ch.testament === 'OT' ? 'Old Testament' : 'New Testament'} — ${ch.book_code} ${String(ch.chapter).padStart(3, '0')}`;

    pushState({ view: 'translations', book: ch.book_code, chapter: chapterKey });

    document.getElementById('back-btn').onclick = function() {
      history.back();
    };

    // Hide book browser when viewing a chapter
    document.getElementById('book-browser').style.display = 'none';

    loadManuscriptImages(chapterKey);

    const agents = ['emet', 'logos', 'pneuma'];
    const promises = agents.map(a => loadTranslation(a, ch.testament, chapterKey));
    await Promise.all(promises);

    if (ch.agents.sophia) {
      loadTranslation('sophia', ch.testament, chapterKey, true);
    } else {
      document.getElementById('sophia-section').style.display = 'none';
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function loadManuscriptImages(chapterKey) {
    const viewer = document.getElementById('manuscript-viewer');
    const container = document.getElementById('manuscript-images');
    try {
      const resp = await fetch(freshUrl(urlImages(chapterKey)));
      if (!resp.ok) { viewer.style.display = 'none'; return; }
      const data = await resp.json();
      if (data.images && data.images.length > 0) {
        viewer.style.display = 'block';
        container.innerHTML = data.images.map(img => {
          const src = imgSrc(img.path);
          return `
          <div class="ms-thumb" data-src="${src}" data-caption="${escapeAttr(img.label)}">
            <img src="${src}" alt="${escapeAttr(img.label)}" loading="lazy">
            <div class="ms-thumb-label">${escapeHtml(img.label)}</div>
          </div>`;
        }).join('');

        container.querySelectorAll('.ms-thumb').forEach(thumb => {
          thumb.addEventListener('click', () => {
            openLightbox(thumb.dataset.src, thumb.dataset.caption);
          });
        });
      } else {
        viewer.style.display = 'none';
      }
    } catch {
      viewer.style.display = 'none';
    }
  }

  async function loadTranslation(agent, testament, chapterKey, isSophia = false) {
    const bodyId = isSophia ? 'sophia-body' : `body-${agent}`;
    const body = document.getElementById(bodyId);

    if (isSophia) {
      document.getElementById('sophia-section').style.display = 'block';
    }

    body.innerHTML = '<div class="loading-spinner"></div>';

    try {
      const resp = await fetch(freshUrl(urlTranslation(agent, testament, chapterKey)));
      if (!resp.ok) {
        body.innerHTML = '<div class="not-available">Translation not yet available</div>';
        if (isSophia) document.getElementById('sophia-section').style.display = 'none';
        return;
      }
      const data = await resp.json();
      const md = data.content || data.markdown;
      const parsed = parseTranslationMd(md, agent);
      body.innerHTML = parsed;
      body.classList.add(`${agent}-body`);
    } catch {
      body.innerHTML = '<div class="not-available">Failed to load translation</div>';
    }
  }

  // ---- Parse Markdown Translation ----
  function parseTranslationMd(md, agent) {
    if (!md) return '<div class="not-available">Translation not yet available</div>';
    const lines = md.split('\n');
    let versesHtml = '';
    let notesHtml = '';
    let metaHtml = '';
    let linksHtml = '';
    let inNotes = false;
    let notesBuffer = [];
    let foundFirstVerse = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.match(/^## (EMET|LOGOS|PNEUMA|SOPHIA)/i) ||
          line.match(/^## ⚠️/) ||
          (inNotes && line.startsWith('## '))) {
        inNotes = true;
      }

      if (inNotes) {
        notesBuffer.push(line);
        continue;
      }

      if (line.startsWith('# ')) continue;
      if (line.trim() === '---') continue;

      // Check if line contains any verse markers: **1:1** or **1** or numbered list "1. text" or Unicode superscript ¹²³
      const superscriptMap = {'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9'};
      const superRe = /^([⁰¹²³⁴⁵⁶⁷⁸⁹]+)\s+(.*)/;
      function decodeSuperscript(s) { return s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, c => superscriptMap[c]); }

      const hasVerse = line.match(/\*\*(\d+(?::\d+)?)\*\*/);
      const superVerse = !hasVerse && line.trim().match(superRe);
      const numberedVerse = !hasVerse && !superVerse && line.match(/^(\d+)\.\s+(.*)/);

      if (hasVerse) {
        foundFirstVerse = true;
        // Split line into individual verses (handles paragraph-style: **1** text **2** text)
        const parts = line.split(/(?=\*\*\d+(?::\d+)?\*\*)/);
        for (const part of parts) {
          const vm = part.match(/^\*\*(\d+(?::\d+)?)\*\*\s*(.*)/);
          if (vm) {
            versesHtml += `<div class="verse"><span class="verse-num">${vm[1]}</span>${formatInlineMarkdown(vm[2].trim())}</div>`;
          } else if (part.trim()) {
            versesHtml += `<span>${formatInlineMarkdown(part.trim())}</span>`;
          }
        }
        continue;
      }

      if (superVerse) {
        foundFirstVerse = true;
        const vNum = decodeSuperscript(superVerse[1]);
        versesHtml += `<div class="verse"><span class="verse-num">${vNum}</span>${formatInlineMarkdown(superVerse[2].trim())}</div>`;
        continue;
      }

      if (numberedVerse) {
        foundFirstVerse = true;
        versesHtml += `<div class="verse"><span class="verse-num">${numberedVerse[1]}</span>${formatInlineMarkdown(numberedVerse[2].trim())}</div>`;
        continue;
      }

      // Everything before the first verse is metadata — send to bottom
      if (!foundFirstVerse) {
        // Extract any external links for link buttons
        const urlMatches = line.matchAll(/View (?:DSS|Vaticanus|LXX) online:\s*(https?:\/\/\S+)/gi);
        for (const m of urlMatches) {
          const url = m[0];
          const dssMatch = url.match(/View DSS online:\s*(https?:\/\/\S+)/i);
          const vatMatch = url.match(/View Vaticanus online:\s*(https?:\/\/\S+)/i);
          const lxxMatch = url.match(/View LXX online:\s*(https?:\/\/\S+)/i);
          if (dssMatch) linksHtml += `<div class="external-ms-links"><a href="${escapeAttr(dssMatch[1])}" target="_blank" rel="noopener">View Dead Sea Scrolls &#8599;</a></div>`;
          if (vatMatch) linksHtml += `<div class="external-ms-links"><a href="${escapeAttr(vatMatch[1])}" target="_blank" rel="noopener">View Codex Vaticanus &#8599;</a></div>`;
          if (lxxMatch) linksHtml += `<div class="external-ms-links"><a href="${escapeAttr(lxxMatch[1])}" target="_blank" rel="noopener">View LXX Manuscript &#8599;</a></div>`;
        }
        // Section headings before first verse go to metadata
        if (line.trim()) {
          metaHtml += `<div class="source-citation">${formatInlineMarkdown(line)}</div>`;
        }
        continue;
      }

      // Content after verses started: section headings, blockquotes, continuation text
      if (line.trim()) {
        const trimmed = line.trim();
        if (trimmed.startsWith('## ')) {
          versesHtml += `<h3 class="section-heading">${escapeHtml(trimmed.slice(3))}</h3>`;
        } else if (trimmed.startsWith('> ')) {
          // Blockquote line — check for inline verse markers
          const bqText = trimmed.slice(2);
          const bqVerse = bqText.match(/^\*\*(\d+(?::\d+)?)\*\*\s*(.*)/);
          if (bqVerse) {
            versesHtml += `<div class="verse verse-poetry"><span class="verse-num">${bqVerse[1]}</span>${formatInlineMarkdown(bqVerse[2].trim())}</div>`;
          } else {
            versesHtml += `<div class="verse-poetry">${formatInlineMarkdown(bqText)}</div>`;
          }
        } else if (trimmed.startsWith('*') && trimmed.endsWith('*') && !trimmed.startsWith('**')) {
          // Italic section heading like *Sarai's Plan (vv. 1–3)*
          versesHtml += `<h4 class="section-heading-italic">${formatInlineMarkdown(trimmed)}</h4>`;
        } else {
          versesHtml += `<p>${formatInlineMarkdown(trimmed)}</p>`;
        }
      }
    }

    if (notesBuffer.length > 0) {
      notesHtml = '<div class="translation-notes">' + parseNotesSection(notesBuffer.join('\n')) + '</div>';
    }

    // Verses first, then notes, then links and metadata at bottom
    let footer = '';
    if (linksHtml || metaHtml) {
      footer = '<div class="translation-footer">' + linksHtml + metaHtml + '</div>';
    }

    return versesHtml + notesHtml + footer;
  }

  function parseNotesSection(md) {
    let html = '';
    const lines = md.split('\n');
    let inList = false;

    for (const line of lines) {
      if (line.startsWith('### ')) {
        if (inList) { html += '</div>'; inList = false; }
        html += `<h3>${escapeHtml(line.slice(4))}</h3>`;
      } else if (line.startsWith('## ')) {
        if (inList) { html += '</div>'; inList = false; }
        html += `<h2>${escapeHtml(line.slice(3))}</h2>`;
      } else if (line.match(/^\d+\.\s/)) {
        if (!inList) { inList = true; }
        html += `<div class="note-item">${formatInlineMarkdown(line.replace(/^\d+\.\s*/, ''))}</div>`;
      } else if (line.startsWith('- ')) {
        html += `<div class="note-item">${formatInlineMarkdown(line.slice(2))}</div>`;
      } else if (line.trim() === '---') {
        // skip
      } else if (line.trim()) {
        html += `<p>${formatInlineMarkdown(line)}</p>`;
      }
    }
    if (inList) html += '</div>';
    return html;
  }

  function formatInlineMarkdown(text) {
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/\[([^\]]+)\]/g, '<span style="color:var(--text-dim);font-size:0.9em">[$1]</span>');
    return text;
  }

  // ---- Manuscript Selector (book/chapter nav) ----
  function loadManuscriptSelector() {
    if (!cachedChapters) return;
    const selector = document.getElementById('ms-book-selector');
    const display = document.getElementById('ms-chapter-display');

    display.style.display = 'none';
    selector.style.display = 'flex';

    selector.innerHTML = buildBookChapterNav(Object.keys(cachedChapters), 'ms');

    selector.querySelectorAll('.book-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openManuscriptChapter(btn.dataset.key);
      });
    });
  }

  async function openManuscriptChapter(key) {
    const selector = document.getElementById('ms-book-selector');
    const display = document.getElementById('ms-chapter-display');
    const container = document.getElementById('ms-chapter-images');
    const ch = cachedChapters[key];
    if (!ch) return;

    selector.style.display = 'none';
    display.style.display = 'block';
    document.getElementById('ms-chapter-title').textContent = `${ch.book_name} ${ch.chapter}`;

    document.getElementById('ms-back-btn').onclick = () => {
      display.style.display = 'none';
      selector.style.display = 'flex';
    };

    container.innerHTML = '<div class="loading-spinner"></div>';

    try {
      const resp = await fetch(freshUrl(urlImages(key)));
      if (!resp.ok) {
        container.innerHTML = '<p style="color:var(--text-dim);text-align:center;">No manuscript images for this chapter.</p>';
        return;
      }
      const data = await resp.json();
      if (!data.images || data.images.length === 0) {
        container.innerHTML = '<p style="color:var(--text-dim);text-align:center;">No manuscript images for this chapter.</p>';
        return;
      }

      container.innerHTML = data.images.map(img => {
        const src = imgSrc(img.path);
        return `
        <div class="ms-card">
          <div class="ms-img-wrap" data-src="${src}" data-caption="${escapeAttr(img.label)}">
            <img src="${src}" alt="${escapeAttr(img.label)}" loading="lazy">
          </div>
          <div class="ms-info">
            <h4>${escapeHtml(img.label)}</h4>
          </div>
        </div>`;
      }).join('');

      container.querySelectorAll('.ms-img-wrap').forEach(wrap => {
        wrap.addEventListener('click', () => {
          openLightbox(wrap.dataset.src, wrap.dataset.caption);
        });
      });
    } catch {
      container.innerHTML = '<p style="color:var(--text-dim);text-align:center;">Failed to load images.</p>';
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- Disagreement Selector (book/chapter nav) ----
  async function loadDisagreementsData() {
    try {
      const resp = await fetch(freshUrl(urlDisagreements()));
      const data = await resp.json();
      // API returns {files: [...]}, static returns {disagreements: [...]}
      if (data.files) {
        cachedDisagreements = data.files.map(f => ({ key: f }));
      } else {
        cachedDisagreements = data.disagreements || [];
      }
    } catch {
      cachedDisagreements = [];
    }
  }

  async function loadDisagreementSelector() {
    if (!cachedDisagreements) await loadDisagreementsData();
    const selector = document.getElementById('dis-book-selector');
    const noEl = document.getElementById('no-disagreements');

    if (!cachedDisagreements || cachedDisagreements.length === 0) {
      selector.innerHTML = '';
      noEl.style.display = 'block';
      return;
    }
    noEl.style.display = 'none';

    const keys = cachedDisagreements.map(d => d.key);
    selector.innerHTML = buildBookChapterNav(keys, 'dis');

    selector.querySelectorAll('.book-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openDisagreement(btn.dataset.key);
      });
    });
  }

  // ---- Shared: Build book/chapter nav HTML ----
  function buildBookChapterNav(keys, prefix) {
    const groups = {};
    for (const key of keys) {
      const parts = key.split('_');
      const bookCode = parts[0];
      const chapNum = parseInt(parts[1]);
      const ch = cachedChapters ? cachedChapters[key] : null;
      const bookName = ch ? ch.book_name : bookCode;
      const testament = ch ? ch.testament : 'OT';

      if (!groups[bookCode]) {
        groups[bookCode] = { name: bookName, testament, chapters: [] };
      }
      groups[bookCode].chapters.push({ key, chapter: chapNum });
    }

    // Group by testament
    var otBooks = [];
    var ntBooks = [];
    for (var bc in groups) {
      if (groups[bc].testament === 'OT') otBooks.push({ code: bc, group: groups[bc] });
      else ntBooks.push({ code: bc, group: groups[bc] });
    }

    function renderSection(title, books) {
      if (books.length === 0) return '';
      var h = '<div class="nav-section">';
      h += '<h3 class="nav-section-title">' + title + '</h3>';
      h += '<div class="nav-book-grid">';
      for (var i = 0; i < books.length; i++) {
        var b = books[i];
        h += '<div class="nav-book-card" data-book="' + b.code + '">';
        h += '<div class="nav-book-card-name">' + escapeHtml(b.group.name) + '</div>';
        h += '<div class="nav-book-card-count">' + b.group.chapters.length + ' chapters</div>';
        h += '<div class="nav-book-card-chapters">';
        for (var j = 0; j < b.group.chapters.length; j++) {
          var ch = b.group.chapters[j];
          h += '<button class="book-nav-btn" data-key="' + ch.key + '">' + ch.chapter + '</button>';
        }
        h += '</div></div>';
      }
      h += '</div></div>';
      return h;
    }

    return renderSection('Old Testament', otBooks) + renderSection('New Testament', ntBooks);
  }

  // ---- Lightbox ----
  function setupLightbox() {
    const lightbox = document.getElementById('lightbox');
    lightbox.querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);
    lightbox.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeLightbox();
    });
  }

  function openLightbox(src, caption) {
    const lightbox = document.getElementById('lightbox');
    document.getElementById('lightbox-img').src = src;
    document.getElementById('lightbox-caption').textContent = caption || '';
    lightbox.style.display = 'block';
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    document.getElementById('lightbox').style.display = 'none';
    document.body.style.overflow = '';
  }

  // ---- Modal (Prefaces) ----
  function setupModal() {
    const modal = document.getElementById('preface-modal');
    modal.querySelector('.modal-close').addEventListener('click', () => {
      modal.style.display = 'none';
    });
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.style.display = 'none';
    });

    document.querySelectorAll('.read-preface-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        loadPreface(btn.dataset.agent);
      });
    });
  }

  async function loadPreface(agent) {
    const modal = document.getElementById('preface-modal');
    const textEl = document.getElementById('preface-text');
    textEl.innerHTML = '<div class="loading-spinner"></div>';
    modal.style.display = 'flex';

    try {
      const resp = await fetch(freshUrl(urlPreface(agent)));
      if (!resp.ok) throw new Error('Not found');
      const data = await resp.json();
      const md = data.content || data.markdown;
      textEl.innerHTML = parsePrefaceMd(md);
    } catch {
      textEl.innerHTML = '<p style="color:var(--text-dim);text-align:center;">Preface not yet available.</p>';
    }
  }

  function parsePrefaceMd(md) {
    let html = '';
    for (const line of md.split('\n')) {
      if (line.startsWith('# ')) {
        html += `<h1>${escapeHtml(line.slice(2))}</h1>`;
      } else if (line.trim()) {
        html += `<p>${formatInlineMarkdown(line)}</p>`;
      }
    }
    return html;
  }

  // ---- Disagreements ----
  function setupDisagreementModal() {
    const modal = document.getElementById('disagreement-modal');
    if (!modal) return;
    modal.querySelector('.modal-close').addEventListener('click', () => {
      modal.style.display = 'none';
    });
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.style.display = 'none';
    });
  }

  async function openDisagreement(key) {
    const modal = document.getElementById('disagreement-modal');
    const textEl = document.getElementById('disagreement-text');
    textEl.innerHTML = '<div class="loading-spinner"></div>';
    modal.style.display = 'flex';

    try {
      const resp = await fetch(freshUrl(urlDisagreement(key)));
      if (!resp.ok) throw new Error('Not found');
      const data = await resp.json();
      const md = data.content || data.markdown;
      textEl.innerHTML = parseDisagreementMd(md);
    } catch {
      textEl.innerHTML = '<p style="color:var(--text-dim);text-align:center;">Disagreement log not available.</p>';
    }
  }

  function parseDisagreementMd(md) {
    let html = '';
    const lines = md.split('\n');
    let inTable = false;
    let tableRows = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('# ')) { html += `<h1>${escapeHtml(line.slice(2))}</h1>`; continue; }
      if (line.startsWith('## ')) { if (inTable) { html += renderTable(tableRows); inTable = false; tableRows = []; } html += `<h2>${formatInlineMarkdown(line.slice(3))}</h2>`; continue; }
      if (line.startsWith('### ')) { if (inTable) { html += renderTable(tableRows); inTable = false; tableRows = []; } html += `<h3>${formatInlineMarkdown(line.slice(4))}</h3>`; continue; }

      if (line.trim().startsWith('|')) {
        if (line.match(/^\|[\s\-|]+\|$/)) continue;
        const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
        if (!inTable) { inTable = true; }
        tableRows.push(cells);
        continue;
      } else if (inTable) { html += renderTable(tableRows); inTable = false; tableRows = []; }

      if (line.startsWith('**SOPHIA')) { html += `<div class="resolution-box">${formatInlineMarkdown(line)}</div>`; continue; }
      if (line.startsWith('**Status:**')) { html += `<p>${formatInlineMarkdown(line)}</p><span class="status-badge status-resolved">Resolved</span>`; continue; }
      if (line.trim() === '---') { html += '<hr>'; continue; }
      if (line.startsWith('**Arbiter:**') || line.startsWith('**Date:**')) { html += `<p style="font-size:0.85rem;color:var(--text-dim);">${formatInlineMarkdown(line)}</p>`; continue; }
      if (line.trim()) { html += `<p>${formatInlineMarkdown(line)}</p>`; }
    }

    if (inTable) html += renderTable(tableRows);
    return html;
  }

  function renderTable(rows) {
    if (rows.length === 0) return '';
    let html = '<table><thead><tr>';
    for (const cell of rows[0]) { html += `<th>${escapeHtml(cell)}</th>`; }
    html += '</tr></thead><tbody>';
    for (let i = 1; i < rows.length; i++) {
      html += '<tr>';
      for (let j = 0; j < rows[i].length; j++) {
        const cell = rows[i][j];
        let cls = '';
        if (j === 0) {
          const lower = cell.toLowerCase();
          if (lower === 'emet') cls = ' class="agent-emet"';
          else if (lower === 'logos') cls = ' class="agent-logos"';
          else if (lower === 'pneuma') cls = ' class="agent-pneuma"';
        }
        html += `<td${cls}>${formatInlineMarkdown(cell)}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  // ---- Reader's Guide (HESED) ----
  let cachedGuides = null;

  async function loadGuides() {
    try {
      const resp = await fetch(freshUrl(IS_API ? '/api/guides' : 'guides.json'));
      const data = await resp.json();
      cachedGuides = data.guides || [];
      renderGuideSelector(cachedGuides);
    } catch (e) {
      console.error('Failed to load guides:', e);
    }
  }

  function renderGuideSelector(guides) {
    const container = document.getElementById('guide-book-selector');
    const noGuides = document.getElementById('no-guides');
    const contentEl = document.getElementById('guide-content');

    if (!guides || guides.length === 0) {
      container.innerHTML = '';
      noGuides.style.display = 'block';
      contentEl.style.display = 'none';
      return;
    }
    noGuides.style.display = 'none';

    var ot = guides.filter(function(g) { return g.testament === 'OT'; });
    var nt = guides.filter(function(g) { return g.testament === 'NT'; });

    function renderSection(title, books) {
      if (books.length === 0) return '';
      var h = '<div class="nav-section">';
      h += '<h3 class="nav-section-title">' + title + '</h3>';
      h += '<div class="guide-book-grid">';
      for (var i = 0; i < books.length; i++) {
        var g = books[i];
        var meta = cachedBookMeta ? cachedBookMeta[g.book_code] : null;
        var summary = meta && meta.summary ? meta.summary : '';
        h += '<div class="guide-book-card guide-nav-btn" data-book="' + g.book_code + '">';
        h += '<div class="guide-book-card-name">' + escapeHtml(g.book_name) + '</div>';
        if (summary) h += '<div class="guide-book-card-summary">' + escapeHtml(summary) + '</div>';
        h += '</div>';
      }
      h += '</div></div>';
      return h;
    }

    container.innerHTML = renderSection('Old Testament', ot) + renderSection('New Testament', nt);

    container.querySelectorAll('.guide-nav-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { window._openGuide(btn.dataset.book); });
    });
  }

  window._openGuide = async function(bookCode) {
    // Highlight selected button
    document.querySelectorAll('.guide-nav-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.guide-nav-btn[data-book="${bookCode}"]`);
    if (btn) btn.classList.add('active');

    const contentEl = document.getElementById('guide-content');
    const textEl = document.getElementById('guide-text');
    textEl.innerHTML = '<p class="loading">Loading guide...</p>';
    contentEl.style.display = 'block';

    try {
      const url = IS_API ? `/api/guide/${bookCode}` : `guide_${bookCode}.json`;
      const resp = await fetch(freshUrl(url));
      const data = await resp.json();
      if (data.error) {
        textEl.innerHTML = '<p class="not-available">Guide not yet available.</p>';
        return;
      }
      textEl.innerHTML = parseGuideMd(data.content);
    } catch (e) {
      textEl.innerHTML = '<p class="not-available">Failed to load guide.</p>';
    }
  };

  function parseGuideMd(md) {
    if (!md) return '';
    let html = '';
    const lines = md.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        html += '<br>';
        continue;
      }
      if (trimmed === '---') {
        html += '<hr class="guide-divider">';
        continue;
      }

      // Title
      if (trimmed.startsWith('# ')) {
        html += `<h1 class="guide-title">${formatInlineMarkdown(trimmed.slice(2))}</h1>`;
        continue;
      }
      // Section headings
      if (trimmed.startsWith('## ')) {
        html += `<h2 class="guide-section">${formatInlineMarkdown(trimmed.slice(3))}</h2>`;
        continue;
      }
      if (trimmed.startsWith('### ')) {
        html += `<h3 class="guide-subsection">${formatInlineMarkdown(trimmed.slice(4))}</h3>`;
        continue;
      }
      // List items
      if (trimmed.startsWith('- **')) {
        const m = trimmed.match(/^- \*\*(.+?)\*\*:?\s*(.*)/);
        if (m) {
          html += `<div class="guide-item"><span class="guide-item-label">${escapeHtml(m[1])}</span> ${formatInlineMarkdown(m[2])}</div>`;
          continue;
        }
      }
      if (trimmed.startsWith('- ')) {
        html += `<div class="guide-bullet">${formatInlineMarkdown(trimmed.slice(2))}</div>`;
        continue;
      }
      // Italic signature line
      if (trimmed.startsWith('*—') || trimmed.startsWith('*—')) {
        html += `<p class="guide-signature">${formatInlineMarkdown(trimmed)}</p>`;
        continue;
      }
      // Regular paragraph
      html += `<p class="guide-para">${formatInlineMarkdown(trimmed)}</p>`;
    }
    return html;
  }

  // ---- Progress ----
  async function loadProgress() {
    try {
      const resp = await fetch(freshUrl(urlProgress()));
      const data = await resp.json();
      cachedProgress = data;

      document.getElementById('stat-completed').textContent = data.completed.toLocaleString();
      document.getElementById('stat-total').textContent = data.total.toLocaleString();
      document.getElementById('stat-percent').textContent = data.percent + '%';

      const fill = document.getElementById('progress-fill');
      fill.style.width = Math.max(data.percent, data.completed > 0 ? 0.5 : 0) + '%';

      document.getElementById('progress-label').textContent =
        `${data.completed.toLocaleString()} / ${data.total.toLocaleString()}`;

      const filterInput = document.getElementById('progress-filter');
      filterInput.removeEventListener('input', filterProgressEntries);
      filterInput.addEventListener('input', filterProgressEntries);

      const loadMoreBtn = document.getElementById('progress-load-more');
      loadMoreBtn.onclick = () => { progressShowCount += 20; renderProgressEntries(); };

      progressShowCount = 20;
      renderProgressEntries();
    } catch {
      document.getElementById('progress-entries').innerHTML =
        '<div class="empty-state"><p class="empty-sub">Unable to load progress data.</p></div>';
    }
  }

  function filterProgressEntries() { progressShowCount = 20; renderProgressEntries(); }

  function renderProgressEntries() {
    if (!cachedProgress) return;
    const entriesEl = document.getElementById('progress-entries');
    const loadMoreBtn = document.getElementById('progress-load-more');
    const filterVal = document.getElementById('progress-filter').value.toLowerCase().trim();

    let entries = cachedProgress.entries;
    if (filterVal) { entries = entries.filter(e => e.raw.toLowerCase().includes(filterVal)); }

    const reversed = [...entries].reverse();

    if (reversed.length === 0) {
      entriesEl.innerHTML = '<div class="empty-state"><p class="empty-sub">No matching entries.</p></div>';
      loadMoreBtn.style.display = 'none';
      return;
    }

    const shown = reversed.slice(0, progressShowCount);
    loadMoreBtn.style.display = reversed.length > progressShowCount ? 'block' : 'none';

    entriesEl.innerHTML = shown.map(entry => {
      const raw = entry.raw;
      const timeMatch = raw.match(/^\[(.+?)\]/);
      const chapterMatch = raw.match(/\]\s+(\S+)/);
      const time = timeMatch ? timeMatch[1] : '';
      const chapter = chapterMatch ? chapterMatch[1] : raw;

      const badges = ['EMET', 'LOGOS', 'PNEUMA', 'SOPHIA'].map(a => {
        const ok = raw.includes(`${a}: ✓`);
        return `<span class="entry-agent-badge ${a.toLowerCase()} ${ok ? 'ok' : 'fail'}">${a} ${ok ? '&#10003;' : '&#10007;'}</span>`;
      }).join('');

      return `<div class="progress-entry">
        <span class="entry-time">${escapeHtml(time)}</span>
        <span class="entry-chapter">${escapeHtml(chapter)}</span>
        <span class="entry-agents">${badges}</span>
      </div>`;
    }).join('');
  }

  // ---- Utilities ----
  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function escapeAttr(s) {
    return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

})();
