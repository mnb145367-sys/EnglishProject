/* ============================================================
   FLUENCY — TEST SYSTEM (student controller)

   Drives the #testsHub container in index.html through five screens:
   list → access → brief → runner → result.

   Everything lives behind window.fluencyTests. Nothing here shares a
   name with the existing site scripts or with fluencyLessons.

   The browser is never trusted with anything that matters: it holds no
   answer key, it does not score, and its clock is only used to animate
   a countdown between two absolute times the server issued.
   ============================================================ */
(function (global) {
  'use strict';

  // ── configuration ──────────────────────────────────────────────────────────

  // Uses the site's existing Apps Script deployment, the same one the Lessons
  // CMS talks to. Define FLUENCY_TESTS_API_URL before this script to override.
  var API_URL = (function () {
    if (typeof FLUENCY_TESTS_API_URL === 'string' && FLUENCY_TESTS_API_URL) {
      return FLUENCY_TESTS_API_URL;
    }
    if (typeof FLUENCY_LESSONS_API_URL === 'string' && FLUENCY_LESSONS_API_URL) {
      return FLUENCY_LESSONS_API_URL;
    }
    if (typeof LESSON_API_URL === 'string' && LESSON_API_URL) return LESSON_API_URL;
    return '';
  })();

  var OUTDATED_ENDPOINT = 'The tests service needs updating.';
  var REQUEST_TIMEOUT_MS = 20000;
  var LIST_CACHE_MS = 60 * 1000;

  // Local mirror of the in-progress attempt, so a refresh or a closed tab does
  // not cost the student their answers. The server remains the only record of
  // what was actually submitted.
  var ATTEMPT_KEY = 'fluency_test_attempt';

  var LETTERS = ['A', 'B', 'C', 'D'];

  var state = {
    list: null,
    listFetchedAt: 0,
    screen: 'list',
    requestToken: 0,

    // active attempt
    attemptId: null,
    test: null,
    questions: [],
    answers: {},
    currentIndex: 0,

    // timing, all in absolute epoch milliseconds
    deadlineMs: 0,
    clockSkewMs: 0,          // serverNow - localNow at the moment the attempt began
    timerHandle: null,
    lastTimerTier: '',

    submitting: false,
    submitted: false,
    pendingIdentity: null,
    selectedTest: null,
    unloadBound: false
  };

  // ── tiny DOM helpers (same shape as the lessons view, kept local) ──────────

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.appendChild(document.createTextNode(String(text)));
    return node;
  }

  function icon(className) {
    var i = document.createElement('i');
    i.className = className;
    i.setAttribute('aria-hidden', 'true');
    return i;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function textOf(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function root() {
    return document.getElementById('ftRoot');
  }

  /**
   * The page hero belongs to the test list. Once a student is entering
   * details or sitting the test it is only noise above the timer, so it is
   * hidden for every screen except the list.
   */
  function setHeroVisible(visible) {
    var hero = document.querySelector('#testsHub .ft-head');
    if (hero) hero.hidden = !visible;
  }

  /**
   * The site header is sticky at the top of the page, so the runner's own
   * sticky bar has to start below it. The height is measured rather than
   * assumed because the header wraps to a second row on narrow screens.
   */
  function syncStickyOffset() {
    var header = document.querySelector('header');
    if (!header) return;
    var style = global.getComputedStyle(header);
    var offset = (style.position === 'sticky' || style.position === 'fixed')
      ? Math.round(header.getBoundingClientRect().height)
      : 0;
    document.documentElement.style.setProperty('--ft-sticky-top', offset + 'px');
  }

  function button(className, iconClass, label) {
    var b = el('button', className);
    b.type = 'button';
    if (iconClass) {
      b.appendChild(icon(iconClass));
      b.appendChild(document.createTextNode(' '));
    }
    b.appendChild(document.createTextNode(label));
    return b;
  }

  // ── API ────────────────────────────────────────────────────────────────────

  function withTimeout(promiseFactory) {
    var controller = ('AbortController' in global) ? new AbortController() : null;
    var timer = global.setTimeout(function () {
      if (controller) controller.abort();
    }, REQUEST_TIMEOUT_MS);

    return promiseFactory(controller)
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
        if (err && err.name === 'AbortError') throw new Error('The request timed out. Please try again.');
        if (err && err.message && err.message.indexOf('HTTP') === 0) {
          throw new Error('The tests service is unavailable right now.');
        }
        throw err;
      })
      .then(
        function (v) { global.clearTimeout(timer); return v; },
        function (e) { global.clearTimeout(timer); throw e; }
      );
  }

  function apiGet(params) {
    if (!API_URL) return Promise.reject(new Error('The tests service is not configured yet.'));
    var query = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');

    return withTimeout(function (controller) {
      var options = { method: 'GET', redirect: 'follow' };
      if (controller) options.signal = controller.signal;
      return fetch(API_URL + '?' + query, options);
    });
  }

  function apiPost(payload) {
    if (!API_URL) return Promise.reject(new Error('The tests service is not configured yet.'));
    return withTimeout(function (controller) {
      var options = {
        method: 'POST',
        // text/plain keeps the request simple so the browser skips preflight,
        // exactly as the rest of the site posts to Apps Script.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      };
      if (controller) options.signal = controller.signal;
      return fetch(API_URL, options);
    });
  }

  // ── local attempt mirror ───────────────────────────────────────────────────

  function saveLocalAttempt() {
    if (!state.attemptId) return;
    try {
      global.localStorage.setItem(ATTEMPT_KEY, JSON.stringify({
        attemptId: state.attemptId,
        testId: state.test ? state.test.id : '',
        answers: state.answers,
        currentIndex: state.currentIndex,
        deadlineMs: state.deadlineMs
      }));
    } catch (e) {
      /* private mode — the attempt still works, it just cannot be recovered */
    }
  }

  function readLocalAttempt() {
    try {
      var raw = global.localStorage.getItem(ATTEMPT_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return (parsed && parsed.attemptId) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function clearLocalAttempt() {
    try {
      global.localStorage.removeItem(ATTEMPT_KEY);
    } catch (e) { /* nothing to do */ }
  }

  // ── shared rendering ───────────────────────────────────────────────────────

  function renderSkeletons(container, count) {
    clearNode(container);
    container.setAttribute('aria-busy', 'true');
    var grid = el('div', 'ft-grid');
    for (var i = 0; i < count; i++) {
      var card = el('div', 'ft-skeleton-card');
      card.appendChild(el('div', 'ft-skeleton-line w40'));
      card.appendChild(el('div', 'ft-skeleton-line tall w90'));
      card.appendChild(el('div', 'ft-skeleton-line w90'));
      card.appendChild(el('div', 'ft-skeleton-line w70'));
      card.appendChild(el('div', 'ft-skeleton-line w40'));
      grid.appendChild(card);
    }
    container.appendChild(grid);
  }

  function renderState(container, iconClass, title, message, action) {
    clearNode(container);
    container.setAttribute('aria-busy', 'false');

    var panel = el('div', 'section ft-state ft-fade-in');
    panel.appendChild(icon(iconClass));
    panel.appendChild(el('h3', null, title));
    panel.appendChild(el('p', null, message));

    if (action) {
      var btn = button('btn btn-primary', 'fa-solid fa-rotate-right', action.label);
      btn.addEventListener('click', action.onClick);
      panel.appendChild(btn);
    }
    container.appendChild(panel);
  }

  /** A dismissable inline message. Students never see a browser alert. */
  function alertBox(message, kind) {
    var box = el('div', 'ft-alert' + (kind === 'info' ? ' is-info' : ''));
    box.setAttribute('role', kind === 'info' ? 'status' : 'alert');
    box.appendChild(icon(kind === 'info'
      ? 'fa-solid fa-circle-info'
      : 'fa-solid fa-triangle-exclamation'));
    box.appendChild(el('span', null, message));
    return box;
  }

  function factItem(label, value, wide) {
    var wrap = el('div', 'ft-fact' + (wide ? ' is-wide' : ''));
    wrap.appendChild(el('span', 'ft-fact-label', label));
    wrap.appendChild(el('span', 'ft-fact-value', value));
    return wrap;
  }

  function briefItem(label, value) {
    var wrap = el('div', 'ft-brief-item');
    wrap.appendChild(el('span', 'ft-fact-label', label));
    wrap.appendChild(el('span', 'ft-fact-value', value));
    return wrap;
  }

  function breadcrumb(currentLabel, onBack) {
    var nav = el('nav', 'ft-breadcrumb');
    nav.setAttribute('aria-label', 'Breadcrumb');
    var link = el('a', null, 'Tests');
    link.href = '#test';
    link.addEventListener('click', function (ev) {
      ev.preventDefault();
      onBack();
    });
    nav.appendChild(link);
    var sep = el('span', 'ft-crumb-sep', '/');
    sep.setAttribute('aria-hidden', 'true');
    nav.appendChild(sep);
    var cur = el('span', null, currentLabel);
    cur.setAttribute('aria-current', 'page');
    nav.appendChild(cur);
    return nav;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN 1 — TEST LIST
  // ══════════════════════════════════════════════════════════════════════════

  function showList(forceRefresh) {
    var host = root();
    if (!host) return;
    state.screen = 'list';
    setHeroVisible(true);

    var fresh = state.list &&
      (Date.now() - state.listFetchedAt) < LIST_CACHE_MS &&
      !forceRefresh;

    if (fresh) {
      renderList(state.list);
      return;
    }

    renderSkeletons(host, 2);
    updateCount(null);

    var token = ++state.requestToken;
    apiGet({ action: 'getAvailableTests' })
      .then(function (json) {
        if (token !== state.requestToken) return;
        // An older deployment answers with its default payload rather than a
        // list. Say that plainly instead of showing "no tests".
        if (!Array.isArray(json.data)) throw new Error(OUTDATED_ENDPOINT);
        state.list = json.data;
        state.listFetchedAt = Date.now();
        renderList(state.list);
      })
      .catch(function (err) {
        if (token !== state.requestToken) return;
        var message = (err && err.message) ? err.message : 'Something went wrong.';
        var isConfig = message.indexOf('not configured') !== -1 || message === OUTDATED_ENDPOINT;
        renderState(
          host,
          'fa-solid fa-triangle-exclamation',
          'Unable to load tests',
          isConfig ? message : 'Please check your connection and try again.',
          isConfig ? null : { label: 'Try Again', onClick: function () { showList(true); } }
        );
      });
  }

  function renderList(tests) {
    var host = root();
    if (!host) return;

    clearNode(host);
    host.setAttribute('aria-busy', 'false');
    updateCount(tests.length);

    if (!tests.length) {
      renderState(
        host,
        'fa-regular fa-clipboard',
        'No tests are available yet',
        'Tests will appear here as soon as your teacher publishes them. Check back soon.'
      );
      return;
    }

    var grid = el('div', 'ft-grid');
    tests.forEach(function (test, index) {
      var card = renderTestCard(test);
      card.classList.add('ft-fade-in');
      card.style.animationDelay = Math.min(index * 60, 400) + 'ms';
      grid.appendChild(card);
    });
    host.appendChild(grid);
  }

  function updateCount(count) {
    var wrap = document.getElementById('ftTestsCount');
    var text = document.getElementById('ftTestsCountText');
    if (!wrap || !text) return;
    if (count === null || count === undefined) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    text.textContent = count === 0
      ? 'No tests yet'
      : count + (count === 1 ? ' Test Available' : ' Tests Available');
  }

  var STATUS_META = {
    active: { label: 'Available', cls: 'is-active', icon: 'fa-solid fa-circle-check' },
    upcoming: { label: 'Coming Soon', cls: 'is-upcoming', icon: 'fa-regular fa-clock' },
    closed: { label: 'Test Closed', cls: 'is-closed', icon: 'fa-solid fa-lock' }
  };

  function renderTestCard(test) {
    var card = el('article', 'ft-card');
    var meta = STATUS_META[test.status] || STATUS_META.closed;

    card.appendChild(el('p', 'ft-card-eyebrow', 'Test'));
    card.appendChild(el('h3', null, textOf(test.name)));

    var badge = el('span', 'ft-status ' + meta.cls);
    badge.appendChild(icon(meta.icon));
    badge.appendChild(document.createTextNode(' ' + meta.label));
    card.appendChild(badge);

    var desc = textOf(test.description);
    if (desc) card.appendChild(el('p', 'ft-card-desc', desc));

    var facts = el('div', 'ft-facts');
    facts.appendChild(factItem('Available', test.startsAtLabel + '  →  ' + test.endsAtLabel, true));
    facts.appendChild(factItem('Duration', test.durationMinutes + ' Minutes'));
    facts.appendChild(factItem('Questions', String(test.questionsCount)));
    facts.appendChild(factItem('Total Marks', String(test.totalMarks)));
    facts.appendChild(factItem('Time Zone', 'Riyadh (KSA)'));
    card.appendChild(facts);

    if (test.status === 'active') {
      var start = button('btn btn-primary', 'fa-solid fa-pen-to-square', 'Start Test');
      start.addEventListener('click', function () { showAccess(test); });
      card.appendChild(start);
    } else {
      var note = el('p', 'ft-card-desc');
      note.appendChild(icon(meta.icon));
      note.appendChild(document.createTextNode(test.status === 'upcoming'
        ? ' Not Available yet — opens ' + test.startsAtLabel
        : ' Ended ' + test.endsAtLabel));
      card.appendChild(note);
    }

    return card;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN 2 — ACCESS FORM
  // ══════════════════════════════════════════════════════════════════════════

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function showAccess(test) {
    var host = root();
    if (!host) return;
    state.screen = 'access';
    state.selectedTest = test;    setHeroVisible(false);


    clearNode(host);
    host.setAttribute('aria-busy', 'false');
    global.scrollTo(0, 0);

    host.appendChild(breadcrumb(textOf(test.name), function () { showList(false); }));

    var panel = el('div', 'section ft-panel ft-fade-in');
    panel.appendChild(el('h2', null, 'Enter Test'));
    panel.appendChild(el('p', 'ft-panel-lede', 'Before starting the test, enter your information.'));

    var errorHost = el('div');
    panel.appendChild(errorHost);

    var form = el('form');
    form.noValidate = true;                  // the messages below are ours, not the browser's

    var nameField = buildField('ftName', 'Full Name', 'text', 'Your full name', 'name');
    var emailField = buildField('ftEmail', 'Email Address', 'email', 'you@example.com', 'email');
    var codeField = buildField('ftCode', 'Test Code', 'text', 'Enter the code from your teacher', 'off');
    codeField.input.setAttribute('autocapitalize', 'characters');

    form.appendChild(nameField.wrap);
    form.appendChild(emailField.wrap);
    form.appendChild(codeField.wrap);

    var actions = el('div', 'ft-actions');
    var submit = el('button', 'btn btn-primary');
    submit.type = 'submit';
    submit.appendChild(icon('fa-solid fa-arrow-right'));
    submit.appendChild(document.createTextNode(' Continue'));

    var back = button('btn', 'fa-solid fa-arrow-left', 'Back to Tests');
    back.addEventListener('click', function () { showList(false); });

    actions.appendChild(submit);
    actions.appendChild(back);
    form.appendChild(actions);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      clearNode(errorHost);

      var ok = true;
      var name = nameField.input.value.trim();
      var email = emailField.input.value.trim();
      var code = codeField.input.value.trim();

      // Validated in reading order so focus lands on the first real problem.
      if (!name) {
        setFieldError(nameField, 'Please enter your full name.');
        ok = false;
      } else {
        clearFieldError(nameField);
      }

      if (!email || !EMAIL_RE.test(email)) {
        setFieldError(emailField, 'Please enter a valid email address.');
        ok = false;
      } else {
        clearFieldError(emailField);
      }

      if (!code) {
        setFieldError(codeField, 'Please enter the test code.');
        ok = false;
      } else {
        clearFieldError(codeField);
      }

      if (!ok) {
        var firstBad = form.querySelector('[aria-invalid="true"]');
        if (firstBad) firstBad.focus();
        return;
      }

      requestAttempt(test, {
        studentName: name,
        // Normalized here too so the student sees the same identity the server
        // stores; the server normalizes again and never trusts this.
        studentEmail: email.toLowerCase(),
        testCode: code
      }, submit, errorHost);
    });

    panel.appendChild(form);
    host.appendChild(panel);
    nameField.input.focus();
  }

  function buildField(id, label, type, placeholder, autocomplete) {
    var wrap = el('div', 'ft-field');
    var lab = el('label', null, label);
    lab.setAttribute('for', id);
    var input = el('input');
    input.id = id;
    input.type = type;
    input.placeholder = placeholder;
    input.autocomplete = autocomplete;
    var err = el('span', 'ft-field-error');
    err.id = id + 'Error';
    err.hidden = true;
    wrap.appendChild(lab);
    wrap.appendChild(input);
    wrap.appendChild(err);
    return { wrap: wrap, input: input, error: err };
  }

  function setFieldError(field, message) {
    field.error.textContent = message;
    field.error.hidden = false;
    field.input.setAttribute('aria-invalid', 'true');
    field.input.setAttribute('aria-describedby', field.error.id);
  }

  function clearFieldError(field) {
    field.error.textContent = '';
    field.error.hidden = true;
    field.input.removeAttribute('aria-invalid');
    field.input.removeAttribute('aria-describedby');
  }

  /** Asks the server to open an attempt. Every real check happens there. */
  function requestAttempt(test, identity, submitButton, errorHost) {
    setBusy(submitButton, true, 'Verifying test…');
    clearNode(errorHost);

    apiPost({
      action: 'startTestAttempt',
      testId: test.id,
      studentName: identity.studentName,
      studentEmail: identity.studentEmail,
      testCode: identity.testCode
    })
      .then(function (json) {
        adoptAttempt(json);
        showBrief(json.resumed);
      })
      .catch(function (err) {
        setBusy(submitButton, false, null);
        errorHost.appendChild(alertBox(
          (err && err.message) ? err.message : 'Something went wrong. Please try again.'
        ));
        errorHost.scrollIntoView({ block: 'nearest' });
      });
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    btn.disabled = !!busy;
    if (busy) {
      btn.dataset.ftLabel = btn.innerHTML;
      clearNode(btn);
      btn.appendChild(icon('fa-solid fa-spinner fa-spin'));
      btn.appendChild(document.createTextNode(' ' + (label || 'Working…')));
    } else if (btn.dataset.ftLabel !== undefined) {
      btn.innerHTML = btn.dataset.ftLabel;
      delete btn.dataset.ftLabel;
    }
  }

  /** Takes the server's attempt payload as the single source of truth. */
  function adoptAttempt(json) {
    state.attemptId = json.attemptId;
    state.test = json.test;
    state.questions = Array.isArray(json.questions) ? json.questions : [];
    state.currentIndex = 0;
    state.submitted = false;
    state.submitting = false;
    state.lastTimerTier = '';

    // The deadline is the server's. The local clock only animates between now
    // and then, so a wrong device clock cannot buy or lose time.
    var serverNow = new Date(json.now).getTime();
    var localNow = Date.now();
    state.clockSkewMs = isFinite(serverNow) ? (serverNow - localNow) : 0;
    state.deadlineMs = new Date(json.expiresAt).getTime();
    if (!isFinite(state.deadlineMs)) {
      state.deadlineMs = localNow + (json.remainingSeconds || 0) * 1000;
    }

    // A resumed attempt keeps whatever answers this device still holds.
    state.answers = {};
    var local = readLocalAttempt();
    if (local && local.attemptId === state.attemptId && local.answers) {
      var valid = {};
      state.questions.forEach(function (q) {
        var given = local.answers[q.id];
        if (given && LETTERS.indexOf(given) !== -1) valid[q.id] = given;
      });
      state.answers = valid;
      if (typeof local.currentIndex === 'number' &&
        local.currentIndex >= 0 && local.currentIndex < state.questions.length) {
        state.currentIndex = local.currentIndex;
      }
    }
    saveLocalAttempt();
    bindUnloadGuard();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN 3 — CONFIRMATION
  // ══════════════════════════════════════════════════════════════════════════

  function showBrief(resumed) {
    var host = root();
    if (!host) return;
    state.screen = 'brief';
    setHeroVisible(false);

    clearNode(host);
    global.scrollTo(0, 0);

    var panel = el('div', 'section ft-panel ft-fade-in');
    panel.appendChild(el('h2', null, resumed ? 'Continue Your Test' : 'Ready to Begin?'));

    if (resumed) {
      panel.appendChild(alertBox(
        'You already have this test in progress. Your timer has kept running, and any ' +
        'answers saved on this device have been restored.', 'info'
      ));
    }

    var brief = el('div', 'ft-brief');
    brief.appendChild(briefItem('Test', textOf(state.test.name)));
    brief.appendChild(briefItem('Questions', String(state.questions.length)));
    brief.appendChild(briefItem('Duration', state.test.durationMinutes + ' Minutes'));
    brief.appendChild(briefItem('Total Marks', String(state.test.totalMarks)));
    if (resumed) {
      brief.appendChild(briefItem('Time Remaining', formatClock(remainingMs())));
    }
    panel.appendChild(brief);

    panel.appendChild(el('p', 'ft-panel-lede',
      'Once you begin, the timer runs continuously. When it reaches zero your test is ' +
      'submitted automatically, so answer at a steady pace.'));

    var actions = el('div', 'ft-actions');
    var start = button('btn btn-primary', 'fa-solid fa-play',
      resumed ? 'Continue Test' : 'Start Test');
    start.addEventListener('click', function () { showRunner(); });
    actions.appendChild(start);
    panel.appendChild(actions);

    host.appendChild(panel);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN 4 — RUNNER
  // ══════════════════════════════════════════════════════════════════════════

  function showRunner() {
    var host = root();
    if (!host) return;
    state.screen = 'runner';
    setHeroVisible(false);

    clearNode(host);
    global.scrollTo(0, 0);

    var wrap = el('div', 'ft-runner ft-fade-in');

    // ── sticky bar: title + countdown ──
    var bar = el('div', 'ft-runner-bar');
    bar.appendChild(el('div', 'ft-runner-title', textOf(state.test.name)));

    var timer = el('div', 'ft-timer');
    timer.appendChild(el('span', 'ft-timer-label', 'Time Remaining'));
    var value = el('span', 'ft-timer-value', formatClock(remainingMs()));
    value.id = 'ftTimerValue';
    // Announced politely at each tier change rather than every second.
    value.setAttribute('role', 'timer');
    timer.appendChild(value);
    bar.appendChild(timer);
    wrap.appendChild(bar);

    var body = el('div', 'section');
    body.id = 'ftQuestionHost';
    wrap.appendChild(body);

    var navigator = el('div', 'section ft-navigator');
    navigator.id = 'ftNavigatorHost';
    wrap.appendChild(navigator);

    host.appendChild(wrap);

    renderQuestion();
    renderNavigator();
    syncStickyOffset();
    startTimer();
  }

  function renderQuestion() {
    var body = document.getElementById('ftQuestionHost');
    if (!body) return;
    var q = state.questions[state.currentIndex];
    if (!q) return;

    clearNode(body);

    var head = el('div', 'ft-question-head');
    head.appendChild(el('span', 'ft-question-counter',
      'Question ' + (state.currentIndex + 1) + ' of ' + state.questions.length));
    head.appendChild(el('span', 'ft-question-marks',
      q.marks + (q.marks === 1 ? ' mark' : ' marks')));
    body.appendChild(head);

    body.appendChild(el('p', 'ft-question-text', textOf(q.question)));

    var group = el('div', 'ft-options');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Answer options for question ' + (state.currentIndex + 1));

    (q.options || []).forEach(function (optionText, i) {
      var letter = LETTERS[i];
      var id = 'ftOpt' + state.currentIndex + letter;
      var label = el('label', 'ft-option');
      label.setAttribute('for', id);

      var input = el('input');
      input.type = 'radio';
      input.name = 'ftQuestion' + state.currentIndex;
      input.id = id;
      input.value = letter;
      input.checked = state.answers[q.id] === letter;
      if (input.checked) label.classList.add('is-selected');

      input.addEventListener('change', function () {
        selectAnswer(q.id, letter);
        // Re-mark the group so the selected surface follows the radio.
        var siblings = group.querySelectorAll('.ft-option');
        for (var s = 0; s < siblings.length; s++) siblings[s].classList.remove('is-selected');
        label.classList.add('is-selected');
        renderNavigator();
      });

      label.appendChild(input);
      label.appendChild(el('span', 'ft-option-letter', letter + '.'));
      label.appendChild(el('span', 'ft-option-text', textOf(optionText)));
      group.appendChild(label);
    });

    body.appendChild(group);

    // ── previous / next ──
    var nav = el('div', 'ft-nav');
    var prev = button('btn', 'fa-solid fa-arrow-left', 'Previous');
    prev.disabled = state.currentIndex === 0;
    prev.addEventListener('click', function () { goToQuestion(state.currentIndex - 1); });

    var isLast = state.currentIndex === state.questions.length - 1;
    var next = button(isLast ? 'btn btn-primary' : 'btn',
      isLast ? 'fa-solid fa-flag-checkered' : 'fa-solid fa-arrow-right',
      isLast ? 'Review & Submit' : 'Next');
    next.addEventListener('click', function () {
      if (isLast) openSubmitDialog();
      else goToQuestion(state.currentIndex + 1);
    });

    nav.appendChild(prev);
    nav.appendChild(next);
    body.appendChild(nav);
  }

  function selectAnswer(questionId, letter) {
    state.answers[questionId] = letter;
    saveLocalAttempt();
  }

  function goToQuestion(index) {
    if (index < 0 || index >= state.questions.length) return;
    state.currentIndex = index;
    saveLocalAttempt();
    renderQuestion();
    renderNavigator();
    var host = document.getElementById('ftQuestionHost');
    if (host) host.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function renderNavigator() {
    var host = document.getElementById('ftNavigatorHost');
    if (!host) return;
    clearNode(host);

    var answered = countAnswered();
    host.appendChild(el('p', 'ft-navigator-title',
      'Question Navigator — ' + answered + ' of ' + state.questions.length + ' answered'));

    var grid = el('div', 'ft-navigator-grid');
    state.questions.forEach(function (q, i) {
      var isAnswered = !!state.answers[q.id];
      var isCurrent = i === state.currentIndex;
      var btn = el('button', 'ft-navigator-btn' +
        (isAnswered ? ' is-answered' : '') +
        (isCurrent ? ' is-current' : ''));
      btn.type = 'button';
      btn.textContent = String(i + 1);
      // The visual state is colour; the label carries the same information.
      btn.setAttribute('aria-label', 'Question ' + (i + 1) +
        (isAnswered ? ', answered' : ', not answered') +
        (isCurrent ? ', current question' : ''));
      if (isCurrent) btn.setAttribute('aria-current', 'true');
      btn.addEventListener('click', function () { goToQuestion(i); });
      grid.appendChild(btn);
    });
    host.appendChild(grid);

    var legend = el('div', 'ft-navigator-legend');
    legend.appendChild(legendItem('is-answered', 'Answered'));
    legend.appendChild(legendItem('', 'Not answered'));
    legend.appendChild(legendItem('is-current', 'Current question'));
    host.appendChild(legend);

    var submitRow = el('div', 'ft-submit-row');
    var submitBtn = button('btn btn-primary', 'fa-solid fa-paper-plane', 'Submit Test');
    submitBtn.addEventListener('click', openSubmitDialog);
    submitRow.appendChild(submitBtn);
    host.appendChild(submitRow);
  }

  function legendItem(cls, label) {
    var item = el('span', 'ft-legend-item');
    var swatch = el('span', 'ft-legend-swatch' + (cls ? ' ' + cls : ''));
    swatch.setAttribute('aria-hidden', 'true');
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(label));
    return item;
  }

  function countAnswered() {
    var n = 0;
    state.questions.forEach(function (q) { if (state.answers[q.id]) n++; });
    return n;
  }

  // ── timer ──────────────────────────────────────────────────────────────────

  /**
   * Time left against the server's deadline, corrected for the difference
   * between this device's clock and the server's.
   */
  function remainingMs() {
    return Math.max(0, state.deadlineMs - (Date.now() + state.clockSkewMs));
  }

  function formatClock(ms) {
    var total = Math.floor(ms / 1000);
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    var mm = ('0' + minutes).slice(-2);
    var ss = ('0' + seconds).slice(-2);
    return hours > 0 ? hours + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function startTimer() {
    stopTimer();
    tick();
    // Recomputed from absolute time every second, so a sleeping tab, a paused
    // phone or a slow frame cannot make the clock drift.
    state.timerHandle = global.setInterval(tick, 1000);
  }

  function stopTimer() {
    if (state.timerHandle) {
      global.clearInterval(state.timerHandle);
      state.timerHandle = null;
    }
  }

  function tick() {
    var node = document.getElementById('ftTimerValue');
    var left = remainingMs();
    if (node) {
      node.textContent = formatClock(left);

      var tier = left <= 60000 ? 'critical' : (left <= 300000 ? 'warning' : 'normal');
      if (tier !== state.lastTimerTier) {
        state.lastTimerTier = tier;
        node.classList.toggle('is-warning', tier === 'warning');
        node.classList.toggle('is-critical', tier === 'critical');
        // Colour alone would not reach a screen reader, so the label changes too.
        var label = node.parentNode ? node.parentNode.querySelector('.ft-timer-label') : null;
        if (label) {
          label.textContent = tier === 'critical' ? 'Less than 1 minute'
            : (tier === 'warning' ? 'Less than 5 minutes' : 'Time Remaining');
        }
      }
    }

    if (left <= 0) {
      stopTimer();
      autoSubmit();
    }
  }

  // ── submission ─────────────────────────────────────────────────────────────

  function openSubmitDialog() {
    if (state.submitting) return;

    var answered = countAnswered();
    var unanswered = state.questions.length - answered;

    var backdrop = el('div', 'ft-modal-backdrop');
    var modal = el('div', 'ft-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'ftModalTitle');

    var title = el('h3', null, 'Submit Test');
    title.id = 'ftModalTitle';
    modal.appendChild(title);
    modal.appendChild(el('p', 'ft-panel-lede', 'Are you sure you want to submit?'));

    var tally = el('div', 'ft-modal-tally');
    tally.appendChild(briefItem('Answered', answered + ' / ' + state.questions.length));
    tally.appendChild(briefItem('Unanswered', String(unanswered)));
    modal.appendChild(tally);

    if (unanswered > 0) {
      modal.appendChild(alertBox(
        'You still have ' + unanswered +
        (unanswered === 1 ? ' unanswered question.' : ' unanswered questions.') +
        ' Are you sure you want to submit?'
      ));
    }

    var errorHost = el('div');
    modal.appendChild(errorHost);

    var actions = el('div', 'ft-actions');
    var cancel = button('btn', 'fa-solid fa-xmark', 'Cancel');
    var confirm = button('btn btn-primary', 'fa-solid fa-paper-plane', 'Submit Test');

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      document.removeEventListener('keydown', onKey);
    }

    function onKey(ev) {
      if (ev.key === 'Escape' && !state.submitting) close();
    }

    cancel.addEventListener('click', function () {
      if (!state.submitting) close();
    });

    confirm.addEventListener('click', function () {
      // Guarded here and in submitAttempt, so a double click cannot post twice.
      if (state.submitting) return;
      cancel.disabled = true;
      setBusy(confirm, true, 'Submitting your test…');
      submitAttempt(false)
        .then(function (json) {
          close();
          showResult(json);
        })
        .catch(function (err) {
          cancel.disabled = false;
          setBusy(confirm, false, null);
          clearNode(errorHost);
          errorHost.appendChild(alertBox(
            (err && err.message) ? err.message : 'Submission failed. Please try again.'
          ));
        });
    });

    actions.appendChild(cancel);
    actions.appendChild(confirm);
    modal.appendChild(actions);

    backdrop.addEventListener('click', function (ev) {
      if (ev.target === backdrop && !state.submitting) close();
    });
    document.addEventListener('keydown', onKey);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    confirm.focus();
  }

  /** Fired by the timer. The student cannot cancel this one. */
  function autoSubmit() {
    if (state.submitting || state.submitted) return;

    // Drop any open dialog so the student is not left staring at a stale one.
    var open = document.querySelector('.ft-modal-backdrop');
    if (open && open.parentNode) open.parentNode.removeChild(open);

    var host = root();
    if (host) {
      clearNode(host);
      var panel = el('div', 'section ft-panel ft-state');
      panel.appendChild(icon('fa-solid fa-spinner fa-spin'));
      panel.appendChild(el('h3', null, 'Time is up'));
      panel.appendChild(el('p', null, 'Submitting your test automatically…'));
      host.appendChild(panel);
    }

    submitAttempt(true)
      .then(function (json) {
        showResult(json, true);
      })
      .catch(function (err) {
        renderState(
          root(),
          'fa-solid fa-triangle-exclamation',
          'We could not submit your test',
          (err && err.message) ? err.message : 'Please check your connection and try again.',
          {
            label: 'Try Again',
            onClick: function () {
              autoSubmit();
            }
          }
        );
      });
  }

  function submitAttempt(auto) {
    if (state.submitting) return Promise.reject(new Error('Your test is already being submitted.'));
    state.submitting = true;
    stopTimer();

    return apiPost({
      action: 'submitTest',
      attemptId: state.attemptId,
      answers: state.answers,
      autoSubmitted: !!auto
    })
      .then(function (json) {
        state.submitted = true;
        state.submitting = false;
        clearLocalAttempt();
        unbindUnloadGuard();
        return json;
      })
      .catch(function (err) {
        state.submitting = false;
        // The clock keeps running for a manual retry; an expired attempt is
        // submitted automatically by the server's own deadline check anyway.
        if (!auto && remainingMs() > 0) startTimer();
        throw err;
      });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN 5 — RESULT
  // ══════════════════════════════════════════════════════════════════════════

  function showResult(json, wasAuto) {
    var host = root();
    if (!host) return;
    state.screen = 'result';
    setHeroVisible(false);
    stopTimer();

    clearNode(host);
    global.scrollTo(0, 0);

    var panel = el('div', 'section ft-panel-wide ft-result ft-fade-in');
    panel.appendChild(icon('fa-solid fa-circle-check ft-result-icon'));

    if (wasAuto || json.submissionType === 'Auto Submitted') {
      panel.appendChild(el('h2', null, 'Time is up'));
      panel.appendChild(el('p', 'ft-panel-lede',
        'Your test has been submitted automatically.'));
    } else {
      panel.appendChild(el('h2', null, 'Test Completed'));
    }

    if (json.showResult && json.result) {
      var r = json.result;
      panel.appendChild(el('p', 'ft-result-score', r.score + ' / ' + r.totalMarks));
      panel.appendChild(el('p', 'ft-result-percent', r.percentage + '%'));

      var breakdown = el('div', 'ft-result-breakdown');
      breakdown.appendChild(briefItem('Correct', String(r.correct)));
      breakdown.appendChild(briefItem('Incorrect', String(r.incorrect)));
      breakdown.appendChild(briefItem('Unanswered', String(r.unanswered)));
      panel.appendChild(breakdown);
    } else {
      panel.appendChild(el('p', 'ft-panel-lede',
        'Your test has been submitted successfully. Your result will be reviewed and released later.'));
    }

    var actions = el('div', 'ft-actions');
    var back = button('btn btn-primary', 'fa-solid fa-arrow-left', 'Back to Tests');
    back.addEventListener('click', function () {
      resetAttempt();
      showList(true);                        // the list may now show a new status
    });
    actions.appendChild(back);
    panel.appendChild(actions);

    host.appendChild(panel);
  }

  function resetAttempt() {
    stopTimer();
    unbindUnloadGuard();
    state.attemptId = null;
    state.test = null;
    state.questions = [];
    state.answers = {};
    state.currentIndex = 0;
    state.submitting = false;
    state.submitted = false;
    state.deadlineMs = 0;
  }

  // ── leaving mid-test ───────────────────────────────────────────────────────

  function onBeforeUnload(ev) {
    if (!state.attemptId || state.submitted) return;
    ev.preventDefault();
    ev.returnValue = '';                     // the browser supplies its own wording
    return '';
  }

  function bindUnloadGuard() {
    if (state.unloadBound) return;
    global.addEventListener('beforeunload', onBeforeUnload);
    state.unloadBound = true;
  }

  function unbindUnloadGuard() {
    if (!state.unloadBound) return;
    global.removeEventListener('beforeunload', onBeforeUnload);
    state.unloadBound = false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RECOVERY, ROUTING, INIT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Offers to resume an attempt this device still remembers. The server decides
   * whether it is still open; a stale record is simply dropped.
   */
  function offerResume(local) {
    var host = root();
    if (!host) return false;

    clearNode(host);
    host.setAttribute('aria-busy', 'false');

    var panel = el('div', 'section ft-panel ft-fade-in');
    panel.appendChild(el('h2', null, 'Test in Progress'));
    panel.appendChild(el('p', 'ft-panel-lede',
      'You have a test that has not been submitted. Your timer has kept running.'));

    var errorHost = el('div');
    panel.appendChild(errorHost);

    var actions = el('div', 'ft-actions');
    var resume = button('btn btn-primary', 'fa-solid fa-rotate-right', 'Resume Test');
    var discard = button('btn', 'fa-solid fa-list', 'View All Tests');

    resume.addEventListener('click', function () {
      setBusy(resume, true, 'Restoring your test…');
      apiPost({ action: 'resumeTestAttempt', attemptId: local.attemptId })
        .then(function (json) {
          adoptAttempt(json);
          if (remainingMs() <= 0) {
            // The deadline passed while the tab was closed. Submit what was
            // saved rather than pretending there is still time.
            autoSubmit();
            return;
          }
          showBrief(true);
        })
        .catch(function (err) {
          setBusy(resume, false, null);
          clearLocalAttempt();
          clearNode(errorHost);
          errorHost.appendChild(alertBox(
            (err && err.message) ? err.message : 'That test could not be resumed.'
          ));
        });
    });

    discard.addEventListener('click', function () {
      clearLocalAttempt();
      showList(false);
    });

    actions.appendChild(resume);
    actions.appendChild(discard);
    panel.appendChild(actions);
    host.appendChild(panel);
    return true;
  }

  /** Called by openPage() in index.html whenever the visible page changes. */
  function onPageChange(page) {
    if (page === 'testsHub') {
      document.title = 'Fluency | Tests';
      setHash('test');

      // Mid-attempt, returning to the page keeps the attempt rather than
      // restarting it.
      if (state.attemptId && !state.submitted) {
        if (state.screen === 'runner') return;
        showBrief(true);
        return;
      }

      var local = readLocalAttempt();
      if (local && offerResume(local)) return;

      showList(false);
      return;
    }

    var hash = global.location.hash.slice(1);
    if (hash === 'test' || hash === 'tests') {
      global.history.replaceState(null, '', global.location.pathname + global.location.search);
    }
  }

  function setHash(value) {
    if (global.location.hash.slice(1) === value) return;
    global.location.hash = value;
  }

  function handleHash() {
    var hash = global.location.hash.slice(1);
    if (hash === 'test' || hash === 'tests') {
      if (typeof global.openPage === 'function') global.openPage('testsHub');
      return true;
    }
    return false;
  }

  function init() {
    // The header's height changes when it wraps, so the offset is re-measured
    // rather than captured once.
    global.addEventListener('resize', function () {
      if (state.screen === 'runner') syncStickyOffset();
    });
    global.addEventListener('hashchange', handleHash);
    handleHash();                            // deep link on first load
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.fluencyTests = {
    onPageChange: onPageChange,
    loadTests: showList,
    goToList: function () { showList(false); }
  };
})(window);
