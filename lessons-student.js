/* ============================================================
   FLUENCY — LESSONS (student controller)

   Loads published lessons from the Apps Script API and drives the
   #lessonsHub and #lessonReader containers in index.html. Rendering
   is delegated to FluencyLessonView (lessons-view.js) so the admin
   preview shows the identical component.

   Everything lives behind window.fluencyLessons; nothing here shares
   a name with the existing site scripts.
   ============================================================ */
(function (global) {
  'use strict';

  // ── configuration ──────────────────────────────────────────────────────────

  // Uses the site's existing Apps Script deployment. Define
  // FLUENCY_LESSONS_API_URL before this script to point elsewhere.
  var API_URL = (function () {
    if (typeof FLUENCY_LESSONS_API_URL === 'string' && FLUENCY_LESSONS_API_URL) {
      return FLUENCY_LESSONS_API_URL;
    }
    if (typeof LESSON_API_URL === 'string' && LESSON_API_URL) return LESSON_API_URL;
    return '';
  })();

  // Shown when the endpoint replies but does not understand the lessons
  // actions — almost always a deployment that predates the Lessons CMS.
  var OUTDATED_ENDPOINT = 'The lessons service needs updating.';

  var PROGRESS_KEY = 'fluency_lesson_progress';
  var LIST_CACHE_MS = 5 * 60 * 1000;      // don't refetch the list on every visit
  var REQUEST_TIMEOUT_MS = 15000;

  var lessonsState = {
    list: null,
    listFetchedAt: 0,
    listRequest: null,
    currentLessonData: null,
    currentLessonId: null,
    requestToken: 0,
    scrollBound: false,
    maxScrollPercent: 0
  };

  var View = null;                        // resolved lazily; see view()

  function view() {
    if (!View) View = global.FluencyLessonView;
    return View;
  }

  // ── progress (localStorage; no account system exists on this site) ─────────

  function readProgress() {
    try {
      var raw = global.localStorage.getItem(PROGRESS_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};                          // private mode or corrupt value
    }
  }

  function writeProgress(all) {
    try {
      global.localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
    } catch (e) {
      /* storage unavailable — progress simply won't persist */
    }
  }

  function getLessonProgress(id) {
    var entry = readProgress()[id];
    if (!entry || typeof entry !== 'object') return { percent: 0, completed: false };
    return {
      percent: Math.max(0, Math.min(100, Number(entry.percent) || 0)),
      completed: !!entry.completed
    };
  }

  function setLessonProgress(id, percent, completed) {
    if (!id) return;
    var all = readProgress();
    var existing = all[id] || {};
    var nextPercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    // Progress only moves forward, so a quick scroll back doesn't lose it.
    if (!completed && Number(existing.percent) > nextPercent) nextPercent = Number(existing.percent);
    all[id] = {
      percent: completed ? 100 : nextPercent,
      completed: !!completed,
      updatedAt: new Date().toISOString()
    };
    writeProgress(all);
  }

  // ── API ────────────────────────────────────────────────────────────────────

  /** GET against the Apps Script endpoint with a timeout and a uniform shape. */
  function apiGet(params) {
    if (!API_URL) {
      return Promise.reject(new Error('The lessons service is not configured yet.'));
    }
    var query = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');

    var controller = ('AbortController' in global) ? new AbortController() : null;
    var timer = global.setTimeout(function () {
      if (controller) controller.abort();
    }, REQUEST_TIMEOUT_MS);

    var options = { method: 'GET', redirect: 'follow' };
    if (controller) options.signal = controller.signal;

    return fetch(API_URL + '?' + query, options)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (!json || typeof json !== 'object') throw new Error('Unexpected response');
        if (!json.success) throw new Error(json.error || 'Request failed');
        return json;
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') throw new Error('The request timed out.');
        throw err;
      })
      .then(
        function (v) { global.clearTimeout(timer); return v; },
        function (e) { global.clearTimeout(timer); throw e; }
      );
  }

  // ── shared state rendering ─────────────────────────────────────────────────

  function renderSkeletons(container, count) {
    var V = view();
    V.clearNode(container);
    container.setAttribute('aria-busy', 'true');
    for (var i = 0; i < count; i++) {
      var card = V.el('div', 'fl-skeleton-card');
      card.appendChild(V.el('div', 'fl-skeleton-line w40'));
      card.appendChild(V.el('div', 'fl-skeleton-line tall w90'));
      card.appendChild(V.el('div', 'fl-skeleton-line w90'));
      card.appendChild(V.el('div', 'fl-skeleton-line w70'));
      card.appendChild(V.el('div', 'fl-skeleton-line w40'));
      container.appendChild(card);
    }
    var sr = V.el('p', null, 'Loading lessons…');
    sr.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);';
    container.appendChild(sr);
  }

  /**
   * Full-width message panel used for empty and error states.
   * `action` is an optional {label, onClick}.
   */
  function renderState(container, iconClass, title, message, action) {
    var V = view();
    V.clearNode(container);
    container.setAttribute('aria-busy', 'false');

    var panel = V.el('div', 'section fl-lessons-state fl-fade-in');
    panel.style.gridColumn = '1 / -1';
    panel.appendChild(V.icon(iconClass));
    panel.appendChild(V.el('h3', null, title));
    panel.appendChild(V.el('p', null, message));

    if (action) {
      var btn = V.el('button', 'btn btn-primary');
      btn.type = 'button';
      btn.appendChild(V.icon('fa-solid fa-rotate-right'));
      btn.appendChild(document.createTextNode(' ' + action.label));
      btn.addEventListener('click', action.onClick);
      panel.appendChild(btn);
    }
    container.appendChild(panel);
  }

  // ── lessons dashboard ──────────────────────────────────────────────────────

  function loadLessons(forceRefresh) {
    var grid = document.getElementById('flLessonsGrid');
    if (!grid || !view()) return;

    var fresh = lessonsState.list &&
      (Date.now() - lessonsState.listFetchedAt) < LIST_CACHE_MS &&
      !forceRefresh;

    if (fresh) {
      renderLessons(lessonsState.list);
      return;
    }

    renderSkeletons(grid, 3);
    updateLessonsCount(null);

    apiGet({ action: 'getPublishedLessons' })
      .then(function (json) {
        // An older Apps Script deployment answers this action with its default
        // payload instead of a list. Say so rather than showing "no lessons".
        if (!Array.isArray(json.data)) throw new Error(OUTDATED_ENDPOINT);
        lessonsState.list = json.data;
        lessonsState.listFetchedAt = Date.now();
        renderLessons(lessonsState.list);
      })
      .catch(function (err) {
        handleLessonError(grid, err);
      });
  }

  function renderLessons(lessons) {
    var grid = document.getElementById('flLessonsGrid');
    var V = view();
    if (!grid || !V) return;

    V.clearNode(grid);
    grid.setAttribute('aria-busy', 'false');
    updateLessonsCount(lessons.length);

    if (!lessons.length) {
      renderState(
        grid,
        'fa-regular fa-book-open',
        'No lessons are available yet',
        'New lessons will appear here as soon as they are published. Check back soon.'
      );
      return;
    }

    lessons.forEach(function (lesson, index) {
      var card = V.renderCard(lesson, getLessonProgress(lesson.id), openLesson);
      card.classList.add('fl-fade-in');
      // Stagger the entrance just enough to feel deliberate.
      card.style.animationDelay = Math.min(index * 60, 400) + 'ms';
      grid.appendChild(card);
    });
  }

  function updateLessonsCount(count) {
    var wrap = document.getElementById('flLessonsCount');
    var text = document.getElementById('flLessonsCountText');
    if (!wrap || !text) return;
    if (count === null || count === undefined) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    text.textContent = count === 0
      ? 'No lessons yet'
      : count + (count === 1 ? ' Lesson Available' : ' Lessons Available');
  }

  function handleLessonError(container, err) {
    var message = (err && err.message) ? err.message : 'Something went wrong.';
    // Configuration problems are not worth a retry button — retrying the same
    // misconfigured endpoint just fails again.
    var isConfig = message.indexOf('not configured') !== -1 || message === OUTDATED_ENDPOINT;
    renderState(
      container,
      'fa-solid fa-triangle-exclamation',
      'Unable to load lessons',
      isConfig ? message : 'Please check your connection and try again.',
      isConfig ? null : { label: 'Try Again', onClick: function () { loadLessons(true); } }
    );
  }

  // ── lesson reader ──────────────────────────────────────────────────────────

  function openLesson(id) {
    if (!id) return;
    setHash('lesson/' + id);
    showLesson(id);
  }

  function showLesson(id) {
    var body = document.getElementById('flLessonReaderBody');
    var V = view();
    if (!body || !V) return;

    if (typeof global.openPage === 'function') global.openPage('lessonReader');
    global.scrollTo(0, 0);

    unbindScrollTracking();
    lessonsState.currentLessonId = id;
    lessonsState.maxScrollPercent = 0;
    setCrumb('Loading…');

    // Guards against an older request resolving after a newer one.
    var token = ++lessonsState.requestToken;

    V.clearNode(body);
    body.setAttribute('aria-busy', 'true');
    var skeleton = V.el('div', 'section');
    skeleton.appendChild(V.el('div', 'fl-skeleton-line w40'));
    skeleton.appendChild(V.el('div', 'fl-skeleton-line tall w70'));
    skeleton.appendChild(V.el('div', 'fl-skeleton-line w90'));
    skeleton.appendChild(V.el('div', 'fl-skeleton-line w90'));
    skeleton.appendChild(V.el('div', 'fl-skeleton-line w70'));
    body.appendChild(skeleton);

    apiGet({ action: 'getLesson', id: id })
      .then(function (json) {
        if (token !== lessonsState.requestToken) return;
        if (!json.data || !json.data.id) throw new Error(OUTDATED_ENDPOINT);
        lessonsState.currentLessonData = json.data;
        renderLesson(json);
      })
      .catch(function (err) {
        if (token !== lessonsState.requestToken) return;
        body.setAttribute('aria-busy', 'false');
        setCrumb('Lesson');
        renderState(
          body,
          'fa-solid fa-triangle-exclamation',
          'Unable to load this lesson',
          (err && err.message) === 'That lesson is not available.'
            ? 'This lesson may have been unpublished or removed.'
            : 'Please check your connection and try again.',
          { label: 'Back to Lessons', onClick: goToHub }
        );
      });
  }

  function renderLesson(json) {
    var body = document.getElementById('flLessonReaderBody');
    var V = view();
    var lesson = json.data;
    if (!body || !V || !lesson) return;

    body.setAttribute('aria-busy', 'false');
    setCrumb('Lesson ' + V.padNumber(lesson.lesson_number));
    document.title = 'Fluency | Lesson ' + V.padNumber(lesson.lesson_number) + ' — ' + lesson.title;

    // Drop the loading skeleton before drawing the lesson, or it stays on the
    // page above the content.
    V.clearNode(body);

    var wrapper = V.el('div', 'section');
    body.appendChild(wrapper);

    V.renderLesson(wrapper, lesson, {
      position: json.position,
      total: json.total,
      prev: json.prev,
      next: json.next,
      progress: getLessonProgress(lesson.id),
      onOpenLesson: openLesson,
      onMarkComplete: function () { toggleComplete(lesson.id); }
    });

    bindScrollTracking();
  }

  function toggleComplete(id) {
    var current = getLessonProgress(id);
    var nextCompleted = !current.completed;
    setLessonProgress(id, nextCompleted ? 100 : current.percent, nextCompleted);

    var btn = document.getElementById('flMarkCompleteBtn');
    if (btn) view().setCompleteButtonLabel(btn, nextCompleted);
    refreshProgressBar(id);
    // The dashboard reads progress at render time, so it picks this up on return.
  }

  function refreshProgressBar(id) {
    var progress = getLessonProgress(id);
    var pct = progress.completed ? 100 : progress.percent;
    var track = document.querySelector('#flLessonReaderBody .fl-lesson-track');
    if (!track) return;
    var bar = track.querySelector('.fl-lesson-bar');
    var label = track.parentNode ? track.parentNode.querySelector('span:last-child') : null;
    track.setAttribute('aria-valuenow', String(pct));
    if (bar) {
      bar.style.width = pct + '%';
      bar.classList.toggle('is-done', !!progress.completed);
    }
    if (label) label.textContent = pct + '%';
  }

  // ── reading progress from scroll depth ─────────────────────────────────────

  function onReaderScroll() {
    var id = lessonsState.currentLessonId;
    var article = document.querySelector('#flLessonReaderBody .fl-lesson-body');
    if (!id || !article) return;

    var rect = article.getBoundingClientRect();
    var articleHeight = rect.height;
    var viewport = global.innerHeight || document.documentElement.clientHeight;
    var scrolledPast = Math.max(0, viewport - rect.top);
    var readable = Math.max(1, articleHeight);
    var percent = Math.round(Math.min(100, (scrolledPast / readable) * 100));

    if (percent <= lessonsState.maxScrollPercent) return;
    lessonsState.maxScrollPercent = percent;

    var existing = getLessonProgress(id);
    if (existing.completed) return;      // don't walk a completed lesson backwards
    setLessonProgress(id, percent, false);
    refreshProgressBar(id);
  }

  var scrollTicking = false;
  function throttledScroll() {
    if (scrollTicking) return;
    scrollTicking = true;
    global.requestAnimationFrame(function () {
      scrollTicking = false;
      onReaderScroll();
    });
  }

  function bindScrollTracking() {
    if (lessonsState.scrollBound) return;
    global.addEventListener('scroll', throttledScroll, { passive: true });
    lessonsState.scrollBound = true;
    onReaderScroll();                     // short lessons may already be fully visible
  }

  function unbindScrollTracking() {
    if (!lessonsState.scrollBound) return;
    global.removeEventListener('scroll', throttledScroll);
    lessonsState.scrollBound = false;
  }

  function setCrumb(text) {
    var crumb = document.getElementById('flCrumbCurrent');
    if (crumb) crumb.textContent = text;
  }

  // ── routing (hash based, so lesson links are shareable) ────────────────────

  function setHash(value) {
    if (global.location.hash.slice(1) === value) return;
    // replaceState keeps the back button meaningful without extra entries here;
    // openLesson pushes via the hash assignment below.
    global.location.hash = value;
  }

  function goToHub() {
    if (typeof global.openPage === 'function') global.openPage('lessonsHub');
    global.scrollTo(0, 0);
  }

  function handleHash() {
    var hash = global.location.hash.slice(1);
    if (hash === 'lessons') {
      if (typeof global.openPage === 'function') global.openPage('lessonsHub');
      return true;
    }
    var match = hash.match(/^lesson\/([A-Za-z0-9_-]+)$/);
    if (match) {
      showLesson(match[1]);
      return true;
    }
    return false;
  }

  /** Called by openPage() in index.html whenever the visible page changes. */
  function onPageChange(page) {
    if (page === 'lessonsHub') {
      unbindScrollTracking();
      document.title = 'Fluency | Lessons';
      setHash('lessons');
      loadLessons(false);
      return;
    }
    if (page === 'lessonReader') return;   // showLesson drives this one

    // Left the lessons area — stop tracking and drop our hash if it is ours.
    unbindScrollTracking();
    var hash = global.location.hash.slice(1);
    if (hash === 'lessons' || /^lesson\//.test(hash)) {
      global.history.replaceState(null, '', global.location.pathname + global.location.search);
    }
  }

  // ── init ───────────────────────────────────────────────────────────────────

  function init() {
    global.addEventListener('hashchange', function () {
      // Browser back/forward. An unrelated hash means another page took over.
      handleHash();
    });
    handleHash();                          // deep link on first load
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.fluencyLessons = {
    onPageChange: onPageChange,
    openLesson: openLesson,
    loadLessons: loadLessons,
    goToHub: goToHub,
    getLessonProgress: getLessonProgress
  };
})(window);
