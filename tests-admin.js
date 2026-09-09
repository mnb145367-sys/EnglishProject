/* ============================================================
   FLUENCY — ADMIN TEST MANAGEMENT CONTROLLER

   Drives the Test Management tab in admin.html. Reuses the
   dashboard's existing adminFetch / showNotification / showError
   helpers and the ADMIN_TOKEN held by the login flow, so there is
   no second auth system here. Authorisation is enforced
   server-side regardless of anything this file does.

   Views: list → editor → question builder → submissions → detail.
   ============================================================ */
(function (global) {
  'use strict';

  var LETTERS = ['A', 'B', 'C', 'D'];

  var STATUS_LABELS = {
    draft: 'Draft',
    upcoming: 'Upcoming',
    active: 'Active',
    closed: 'Closed',
    disabled: 'Disabled'
  };

  var state = {
    list: [],
    stats: null,
    loaded: false,
    loading: false,
    statusFilter: 'all',
    search: '',

    view: 'list',
    editingId: null,
    busy: false,

    // question builder
    questionsTestId: null,
    questionsTestName: '',
    questions: [],
    questionsDirty: false,

    // submissions
    submissionsTestId: '',
    submissions: [],
    submissionSearch: '',
    submissionSort: 'submitTime'
  };

  function $(id) { return document.getElementById(id); }

  function toast(message) {
    if (typeof global.showNotification === 'function') global.showNotification(message);
  }

  function toastError(message) {
    if (typeof global.showError === 'function') global.showError(message);
    else toast(message);
  }

  /** Calls the backend through the dashboard's existing authenticated helper. */
  function callApi(payload) {
    if (typeof global.adminFetch !== 'function') {
      return Promise.reject(new Error('The admin connection is not ready.'));
    }
    return global.adminFetch(payload).then(function (res) {
      if (!res || typeof res !== 'object') throw new Error('Unexpected response from the server.');
      if (!res.success) throw new Error(res.error || 'The request failed.');
      return res;
    });
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────

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

  function button(className, iconClass, label, onClick) {
    var b = el('button', className);
    b.type = 'button';
    if (iconClass) {
      b.appendChild(icon(iconClass));
      if (label) b.appendChild(document.createTextNode(' '));
    }
    if (label) b.appendChild(document.createTextNode(label));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function iconButton(iconClass, title, onClick, danger) {
    var b = el('button', 'at-icon-btn' + (danger ? ' is-danger' : ''));
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.appendChild(icon(iconClass));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function field(labelText, control, hint) {
    var wrap = el('div', 'at-field');
    var id = control.id || ('atField' + Math.random().toString(36).slice(2, 8));
    control.id = id;
    var label = el('label', null, labelText);
    label.setAttribute('for', id);
    wrap.appendChild(label);
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el('span', 'at-hint', hint));
    return wrap;
  }

  function input(type, value, placeholder) {
    var node = el('input');
    node.type = type;
    node.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) node.placeholder = placeholder;
    return node;
  }

  function checkbox(labelText, checked, hint) {
    var wrap = el('label', 'at-check');
    var box = el('input');
    box.type = 'checkbox';
    box.checked = !!checked;
    wrap.appendChild(box);
    var textWrap = el('span');
    textWrap.appendChild(document.createTextNode(labelText));
    if (hint) textWrap.appendChild(el('span', 'at-hint', hint));
    wrap.appendChild(textWrap);
    return { wrap: wrap, input: box };
  }

  function stateBlock(host, iconClass, message) {
    clearNode(host);
    var box = el('div', 'at-state');
    box.appendChild(icon(iconClass));
    box.appendChild(el('p', null, message));
    host.appendChild(box);
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    btn.disabled = !!busy;
    if (busy) {
      btn.dataset.atLabel = btn.innerHTML;
      clearNode(btn);
      btn.appendChild(icon('fa-solid fa-spinner fa-spin'));
      btn.appendChild(document.createTextNode(' ' + (label || 'Working…')));
    } else if (btn.dataset.atLabel !== undefined) {
      btn.innerHTML = btn.dataset.atLabel;
      delete btn.dataset.atLabel;
    }
  }

  function showView(name) {
    state.view = name;
    ['atListView', 'atEditorView', 'atQuestionsView', 'atSubmissionsView'].forEach(function (id) {
      var node = $(id);
      if (node) node.style.display = (id === 'at' + capitalize(name) + 'View') ? '' : 'none';
    });
    global.scrollTo(0, 0);
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIST + STATS
  // ══════════════════════════════════════════════════════════════════════════

  function loadAdminTests(force) {
    if (state.loading) return;
    if (state.loaded && !force) {
      renderAdminTests();
      return;
    }

    var host = $('atTableWrap');
    if (host) stateBlock(host, 'fa-solid fa-spinner fa-spin', 'Loading tests…');

    state.loading = true;
    callApi({ action: 'adminGetTests' })
      .then(function (res) {
        state.list = Array.isArray(res.data) ? res.data : [];
        state.stats = res.stats || null;
        state.loaded = true;
        state.loading = false;
        renderAdminTests();
      })
      .catch(function (err) {
        state.loading = false;
        if (host) {
          stateBlock(host, 'fa-solid fa-triangle-exclamation',
            (err && err.message) ? err.message : 'Unable to load tests.');
        }
      });
  }

  function renderStats() {
    var host = $('atStats');
    if (!host) return;
    clearNode(host);
    if (!state.stats) return;

    var items = [
      ['Total Tests', state.stats.total],
      ['Active', state.stats.active],
      ['Upcoming', state.stats.upcoming],
      ['Closed', state.stats.closed],
      ['Submissions', state.stats.submissions]
    ];
    items.forEach(function (pair) {
      var tile = el('div', 'at-stat');
      tile.appendChild(el('span', 'at-stat-label', pair[0]));
      tile.appendChild(el('span', 'at-stat-value', String(pair[1] || 0)));
      host.appendChild(tile);
    });
  }

  function visibleTests() {
    var needle = state.search.trim().toLowerCase();
    return state.list.filter(function (t) {
      if (state.statusFilter !== 'all' && t.status !== state.statusFilter) return false;
      if (!needle) return true;
      return String(t.name || '').toLowerCase().indexOf(needle) !== -1 ||
        String(t.code || '').toLowerCase().indexOf(needle) !== -1;
    });
  }

  function renderAdminTests() {
    renderStats();

    var searchBox = $('atSearch');
    if (searchBox) state.search = searchBox.value || '';

    var host = $('atTableWrap');
    if (!host) return;
    clearNode(host);

    var rows = visibleTests();

    var count = $('atCount');
    if (count) {
      count.textContent = rows.length === state.list.length
        ? state.list.length + (state.list.length === 1 ? ' test' : ' tests')
        : rows.length + ' of ' + state.list.length + ' tests';
    }

    if (!state.list.length) {
      stateBlock(host, 'fa-regular fa-clipboard',
        'No tests yet. Create your first test to get started.');
      return;
    }
    if (!rows.length) {
      stateBlock(host, 'fa-regular fa-face-frown', 'No tests match this filter.');
      return;
    }

    var wrap = el('div', 'sm-table-wrap');
    var table = el('table', 'sm-table');

    var thead = el('thead');
    var headRow = el('tr');
    ['Test Name', 'Code', 'Questions', 'Duration', 'Start', 'End', 'Status', 'Submissions', 'Actions']
      .forEach(function (h) { headRow.appendChild(el('th', null, h)); });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    rows.forEach(function (t) { tbody.appendChild(renderTestRow(t)); });
    table.appendChild(tbody);

    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  function renderTestRow(test) {
    var tr = el('tr');

    tr.appendChild(el('td', null, test.name));
    tr.appendChild(el('td', null, test.code));
    tr.appendChild(el('td', null, String(test.questionsCount)));
    tr.appendChild(el('td', null, test.durationMinutes + ' min'));
    tr.appendChild(el('td', null, test.startsAtLabel || '—'));
    tr.appendChild(el('td', null, test.endsAtLabel || '—'));

    var statusCell = el('td');
    var badge = el('span', 'sm-badge at-' + test.status,
      STATUS_LABELS[test.status] || test.status);
    statusCell.appendChild(badge);
    tr.appendChild(statusCell);

    tr.appendChild(el('td', null, String(test.submissions)));

    var actions = el('td');
    var tools = el('div', 'at-question-tools');

    tools.appendChild(iconButton('fa-regular fa-pen-to-square', 'Edit test', function () {
      openTestEditor(test.id);
    }));
    tools.appendChild(iconButton('fa-regular fa-rectangle-list', 'Questions', function () {
      openQuestionBuilder(test.id, test.name);
    }));
    tools.appendChild(iconButton('fa-regular fa-file-lines', 'Submissions', function () {
      openSubmissions(test.id);
    }));

    if (test.storedStatus === 'published') {
      tools.appendChild(iconButton('fa-solid fa-eye-slash', 'Unpublish (back to draft)', function () {
        setTestStatus(test.id, 'draft');
      }));
      tools.appendChild(iconButton('fa-solid fa-ban', 'Disable', function () {
        setTestStatus(test.id, 'disabled');
      }));
    } else {
      tools.appendChild(iconButton('fa-solid fa-upload', 'Publish', function () {
        setTestStatus(test.id, 'published');
      }));
    }

    tools.appendChild(iconButton('fa-regular fa-trash-can', 'Delete test', function () {
      confirmDeleteTest(test);
    }, true));

    actions.appendChild(tools);
    tr.appendChild(actions);

    return tr;
  }

  function setTestStatusFilter(value) {
    state.statusFilter = value;
    var group = $('atStatusFilters');
    if (group) {
      var chips = group.querySelectorAll('.sm-chip');
      for (var i = 0; i < chips.length; i++) {
        chips[i].classList.toggle('active', chips[i].dataset.status === value);
      }
    }
    renderAdminTests();
  }

  function setTestStatus(testId, status) {
    callApi({ action: 'adminSetTestStatus', testId: testId, status: status })
      .then(function () {
        toast(status === 'published' ? 'Test published.'
          : (status === 'disabled' ? 'Test disabled.' : 'Test moved back to draft.'));
        loadAdminTests(true);
      })
      .catch(function (err) {
        toastError((err && err.message) ? err.message : 'Could not change the status.');
      });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MODALS
  // ══════════════════════════════════════════════════════════════════════════

  function openModal(build, wide) {
    var backdrop = el('div', 'at-modal-backdrop');
    var modal = el('div', 'at-modal' + (wide ? ' is-wide' : ''));
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      document.removeEventListener('keydown', onKey);
    }

    function onKey(ev) { if (ev.key === 'Escape') close(); }

    backdrop.addEventListener('click', function (ev) {
      if (ev.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey);

    build(modal, close);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    return close;
  }

  function confirmDeleteTest(test) {
    openModal(function (modal, close) {
      modal.appendChild(el('h3', null, 'Delete this test?'));
      modal.appendChild(el('p', null,
        '"' + test.name + '" and its questions will be permanently deleted. ' +
        'Student submissions already recorded are kept.'));

      var actions = el('div', 'at-modal-actions');
      actions.appendChild(button('btn', 'fa-solid fa-xmark', 'Cancel', close));
      var confirm = button('btn btn-danger', 'fa-regular fa-trash-can', 'Delete Test');
      confirm.addEventListener('click', function () {
        setBusy(confirm, true, 'Deleting…');
        callApi({ action: 'adminDeleteTest', testId: test.id })
          .then(function () {
            close();
            toast('Test deleted.');
            loadAdminTests(true);
          })
          .catch(function (err) {
            setBusy(confirm, false, null);
            toastError((err && err.message) ? err.message : 'Could not delete the test.');
          });
      });
      actions.appendChild(confirm);
      modal.appendChild(actions);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EDITOR
  // ══════════════════════════════════════════════════════════════════════════

  function openTestEditor(testId) {
    showView('editor');
    var host = $('atEditorBody');
    if (!host) return;

    state.editingId = testId || null;

    if (!testId) {
      renderEditor(null);
      return;
    }

    stateBlock(host, 'fa-solid fa-spinner fa-spin', 'Loading test…');
    callApi({ action: 'adminGetTest', testId: testId })
      .then(function (res) { renderEditor(res.data); })
      .catch(function (err) {
        stateBlock(host, 'fa-solid fa-triangle-exclamation',
          (err && err.message) ? err.message : 'Unable to load this test.');
      });
  }

  function renderEditor(test) {
    var host = $('atEditorBody');
    if (!host) return;
    clearNode(host);

    var head = el('div', 'at-editor-head');
    var titleWrap = el('div');
    titleWrap.appendChild(el('h3', null, test ? 'Edit Test' : 'Create New Test'));
    titleWrap.appendChild(el('p', 'at-editor-sub',
      'All times are Riyadh time (Asia/Riyadh). Students see the same schedule wherever they are.'));
    head.appendChild(titleWrap);
    head.appendChild(button('btn', 'fa-solid fa-arrow-left', 'Back to Tests', closeTestEditor));
    host.appendChild(head);

    var errorHost = el('div');
    host.appendChild(errorHost);

    var form = el('form');
    form.noValidate = true;

    // ── basic information ──
    var basic = el('fieldset', 'at-fieldset');
    basic.appendChild(el('legend', null, 'Basic Information'));

    var nameInput = input('text', test ? test.name : '', 'Lessons 1–5 Test');
    basic.appendChild(field('Test Name', nameInput));

    var descInput = el('textarea');
    descInput.value = test ? test.description : '';
    descInput.placeholder = 'This test covers Lessons 1–5.';
    basic.appendChild(field('Description', descInput));

    var codeInput = input('text', test ? test.code : '', 'e.g. FL1-5');
    basic.appendChild(field('Test Code', codeInput,
      'Students must type this exactly to enter. Matching ignores capitals.'));
    form.appendChild(basic);

    // ── schedule ──
    var schedule = el('fieldset', 'at-fieldset');
    schedule.appendChild(el('legend', null, 'Schedule'));
    var scheduleRow = el('div', 'at-row');

    var startDate = input('date', test ? test.startDate : '');
    var startTime = input('time', test ? (test.startTime || '19:00') : '19:00');
    var endDate = input('date', test ? test.endDate : '');
    var endTime = input('time', test ? (test.endTime || '23:59') : '23:59');

    scheduleRow.appendChild(field('Start Date', startDate));
    scheduleRow.appendChild(field('Start Time', startTime));
    scheduleRow.appendChild(field('End Date', endDate));
    scheduleRow.appendChild(field('End Time', endTime));
    schedule.appendChild(scheduleRow);
    form.appendChild(schedule);

    // ── duration ──
    var duration = el('fieldset', 'at-fieldset');
    duration.appendChild(el('legend', null, 'Duration'));
    var durationInput = input('number', test ? test.durationMinutes : 30);
    durationInput.min = '1';
    durationInput.max = '600';
    duration.appendChild(field('Duration in minutes', durationInput,
      'The timer starts when the student begins, and never runs past the end time above.'));
    form.appendChild(duration);

    // ── attempts + results ──
    var settings = el('fieldset', 'at-fieldset');
    settings.appendChild(el('legend', null, 'Attempts & Results'));

    var oneAttempt = checkbox('One attempt per email',
      test ? test.oneAttempt : true,
      'Unchecked, a student may take the test more than once.');
    settings.appendChild(oneAttempt.wrap);

    var showResult = checkbox('Show result immediately',
      test ? test.showResultImmediately : true,
      'Unchecked, students only see a confirmation and you release results later.');
    settings.appendChild(showResult.wrap);

    var randomQ = checkbox('Randomize questions',
      test ? test.randomizeQuestions : false,
      'Each student gets their own question order.');
    settings.appendChild(randomQ.wrap);

    var randomA = checkbox('Randomize answer choices',
      test ? test.randomizeAnswers : false,
      'Option order changes per student; the correct answer follows its option.');
    settings.appendChild(randomA.wrap);

    form.appendChild(settings);

    // ── actions ──
    var actions = el('div', 'at-toolbar');
    var save = el('button', 'btn btn-primary');
    save.type = 'submit';
    save.appendChild(icon('fa-solid fa-floppy-disk'));
    save.appendChild(document.createTextNode(test ? ' Save Changes' : ' Create Test'));
    actions.appendChild(save);
    actions.appendChild(button('btn', 'fa-solid fa-xmark', 'Cancel', closeTestEditor));
    form.appendChild(actions);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      clearNode(errorHost);

      var payload = {
        id: test ? test.id : '',
        name: nameInput.value.trim(),
        description: descInput.value.trim(),
        code: codeInput.value.trim(),
        startDate: startDate.value,
        startTime: startTime.value,
        endDate: endDate.value,
        endTime: endTime.value,
        durationMinutes: Number(durationInput.value),
        oneAttempt: oneAttempt.input.checked,
        showResultImmediately: showResult.input.checked,
        randomizeQuestions: randomQ.input.checked,
        randomizeAnswers: randomA.input.checked,
        // Publishing is a separate, deliberate action from the list.
        status: test ? test.status : 'draft'
      };

      // The server validates all of this again; these checks just save a trip.
      var problem = quickValidate(payload);
      if (problem) {
        errorHost.appendChild(el('div', 'at-err', problem));
        return;
      }

      setBusy(save, true, 'Saving…');
      callApi({ action: 'adminSaveTest', test: payload })
        .then(function (res) {
          toast(res.created ? 'Test created.' : 'Test saved.');
          state.loaded = false;
          if (res.created) {
            // A new test has no questions yet, so go straight where the work is.
            loadAdminTests(true);
            openQuestionBuilder(res.id, payload.name);
          } else {
            closeTestEditor();
            loadAdminTests(true);
          }
        })
        .catch(function (err) {
          setBusy(save, false, null);
          errorHost.appendChild(el('div', 'at-err',
            (err && err.message) ? err.message : 'Could not save the test.'));
        });
    });

    host.appendChild(form);
  }

  function quickValidate(p) {
    if (!p.name) return 'Test name is required.';
    if (!p.code) return 'Test code is required.';
    if (!p.startDate) return 'A start date is required.';
    if (!p.endDate) return 'An end date is required.';
    if (!isFinite(p.durationMinutes) || p.durationMinutes < 1) {
      return 'Duration must be at least 1 minute.';
    }
    return '';
  }

  function closeTestEditor() {
    state.editingId = null;
    showView('list');
    renderAdminTests();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // QUESTION BUILDER
  // ══════════════════════════════════════════════════════════════════════════

  function openQuestionBuilder(testId, testName) {
    showView('questions');
    state.questionsTestId = testId;
    state.questionsTestName = testName || '';
    state.questions = [];
    state.questionsDirty = false;

    var host = $('atQuestionsBody');
    if (host) stateBlock(host, 'fa-solid fa-spinner fa-spin', 'Loading questions…');

    callApi({ action: 'adminGetTestQuestions', testId: testId })
      .then(function (res) {
        state.questions = (Array.isArray(res.data) ? res.data : []).map(normalizeQuestion);
        state.questionsTestName = res.testName || state.questionsTestName;
        renderQuestionBuilder();
      })
      .catch(function (err) {
        if (host) {
          stateBlock(host, 'fa-solid fa-triangle-exclamation',
            (err && err.message) ? err.message : 'Unable to load the questions.');
        }
      });
  }

  function normalizeQuestion(q) {
    return {
      id: q.id || '',
      lessonNumber: q.lessonNumber || '',
      question: q.question || '',
      optionA: q.optionA || '',
      optionB: q.optionB || '',
      optionC: q.optionC || '',
      optionD: q.optionD || '',
      correctAnswer: LETTERS.indexOf(String(q.correctAnswer || '').toUpperCase()) !== -1
        ? String(q.correctAnswer).toUpperCase() : 'A',
      marks: Number(q.marks) || 1,
      createdAt: q.createdAt || ''
    };
  }

  function renderQuestionBuilder() {
    var host = $('atQuestionsBody');
    if (!host) return;
    clearNode(host);

    var head = el('div', 'at-editor-head');
    var titleWrap = el('div');
    titleWrap.appendChild(el('h3', null, 'Question Builder'));
    titleWrap.appendChild(el('p', 'at-editor-sub', state.questionsTestName));
    head.appendChild(titleWrap);
    head.appendChild(button('btn', 'fa-solid fa-arrow-left', 'Back to Tests', function () {
      leaveQuestionBuilder();
    }));
    host.appendChild(head);

    var toolbar = el('div', 'at-toolbar');
    toolbar.appendChild(button('btn btn-primary', 'fa-solid fa-plus', 'Add Question', function () {
      state.questions.push(normalizeQuestion({}));
      state.questionsDirty = true;
      renderQuestionBuilder();
    }));
    toolbar.appendChild(button('btn', 'fa-solid fa-file-import', 'Import from Lessons', openImportDialog));
    toolbar.appendChild(el('span', 'at-spacer'));

    var totalMarks = 0;
    state.questions.forEach(function (q) { totalMarks += Number(q.marks) || 0; });
    toolbar.appendChild(el('span', 'sm-count',
      state.questions.length + (state.questions.length === 1 ? ' question · ' : ' questions · ') +
      totalMarks + ' total marks'));
    host.appendChild(toolbar);

    var listHost = el('div');
    host.appendChild(listHost);

    if (!state.questions.length) {
      listHost.appendChild(el('div', 'at-empty-hint',
        'No questions yet. Add one, or import prompts from your existing lessons.'));
    } else {
      state.questions.forEach(function (q, index) {
        listHost.appendChild(renderQuestionCard(q, index));
      });
    }

    var actions = el('div', 'at-toolbar');
    var save = button('btn btn-primary', 'fa-solid fa-floppy-disk', 'Save Questions');
    save.addEventListener('click', function () { saveQuestions(save); });
    actions.appendChild(save);
    actions.appendChild(button('btn', 'fa-solid fa-xmark', 'Cancel', leaveQuestionBuilder));
    host.appendChild(actions);
  }

  function renderQuestionCard(q, index) {
    var card = el('div', 'at-question');

    var head = el('div', 'at-question-head');
    head.appendChild(el('span', 'at-question-index', 'Question ' + (index + 1)));

    var tools = el('div', 'at-question-tools');
    var up = iconButton('fa-solid fa-arrow-up', 'Move up', function () { moveQuestion(index, -1); });
    up.disabled = index === 0;
    var down = iconButton('fa-solid fa-arrow-down', 'Move down', function () { moveQuestion(index, 1); });
    down.disabled = index === state.questions.length - 1;
    tools.appendChild(up);
    tools.appendChild(down);
    tools.appendChild(iconButton('fa-regular fa-copy', 'Duplicate', function () {
      var copy = normalizeQuestion(q);
      copy.id = '';                        // a duplicate is a new question, not the same row
      state.questions.splice(index + 1, 0, copy);
      state.questionsDirty = true;
      renderQuestionBuilder();
    }));
    tools.appendChild(iconButton('fa-regular fa-trash-can', 'Delete question', function () {
      state.questions.splice(index, 1);
      state.questionsDirty = true;
      renderQuestionBuilder();
    }, true));
    head.appendChild(tools);
    card.appendChild(head);

    var metaRow = el('div', 'at-row');

    var lessonInput = input('text', q.lessonNumber, 'e.g. 3');
    lessonInput.addEventListener('input', function () {
      q.lessonNumber = lessonInput.value;
      state.questionsDirty = true;
    });
    metaRow.appendChild(field('Lesson', lessonInput));

    var marksInput = input('number', q.marks);
    marksInput.min = '1';
    marksInput.max = '100';
    marksInput.addEventListener('input', function () {
      q.marks = Number(marksInput.value) || 1;
      state.questionsDirty = true;
    });
    metaRow.appendChild(field('Marks', marksInput));

    var correctSelect = el('select');
    LETTERS.forEach(function (letter) {
      var option = el('option', null, 'Option ' + letter);
      option.value = letter;
      if (q.correctAnswer === letter) option.selected = true;
      correctSelect.appendChild(option);
    });
    correctSelect.addEventListener('change', function () {
      q.correctAnswer = correctSelect.value;
      state.questionsDirty = true;
      renderQuestionBuilder();             // refresh the "Correct" tag
    });
    metaRow.appendChild(field('Correct Answer', correctSelect));

    card.appendChild(metaRow);

    var questionInput = el('textarea');
    questionInput.value = q.question;
    questionInput.placeholder = 'Type the question here…';
    questionInput.addEventListener('input', function () {
      q.question = questionInput.value;
      state.questionsDirty = true;
    });
    card.appendChild(field('Question', questionInput));

    var options = el('div', 'at-options-grid');
    LETTERS.forEach(function (letter) {
      var key = 'option' + letter;
      var box = input('text', q[key], 'Option ' + letter);
      box.addEventListener('input', function () {
        q[key] = box.value;
        state.questionsDirty = true;
      });

      var wrap = el('div', 'at-field');
      var id = 'atOpt' + index + letter;
      box.id = id;
      var label = el('label');
      label.setAttribute('for', id);
      label.appendChild(document.createTextNode('Option ' + letter + ' '));
      if (q.correctAnswer === letter) {
        var tag = el('span', 'at-correct-tag');
        tag.appendChild(icon('fa-solid fa-check'));
        tag.appendChild(document.createTextNode(' Correct'));
        label.appendChild(tag);
      }
      wrap.appendChild(label);
      wrap.appendChild(box);
      options.appendChild(wrap);
    });
    card.appendChild(options);

    return card;
  }

  function moveQuestion(index, delta) {
    var target = index + delta;
    if (target < 0 || target >= state.questions.length) return;
    var moved = state.questions.splice(index, 1)[0];
    state.questions.splice(target, 0, moved);
    state.questionsDirty = true;
    renderQuestionBuilder();
  }

  function saveQuestions(btn) {
    // Order on screen is the order sent; the server assigns Question Order from it.
    setBusy(btn, true, 'Saving…');
    callApi({
      action: 'adminSaveTestQuestions',
      testId: state.questionsTestId,
      questions: state.questions
    })
      .then(function (res) {
        setBusy(btn, false, null);
        state.questionsDirty = false;
        toast('Saved ' + res.saved + (res.saved === 1 ? ' question.' : ' questions.'));
        state.loaded = false;
        loadAdminTests(true);
        openQuestionBuilder(state.questionsTestId, state.questionsTestName);
      })
      .catch(function (err) {
        setBusy(btn, false, null);
        toastError((err && err.message) ? err.message : 'Could not save the questions.');
      });
  }

  function leaveQuestionBuilder() {
    if (!state.questionsDirty) {
      showView('list');
      return;
    }
    openModal(function (modal, close) {
      modal.appendChild(el('h3', null, 'Discard unsaved questions?'));
      modal.appendChild(el('p', null, 'Your changes to this question set have not been saved.'));
      var actions = el('div', 'at-modal-actions');
      actions.appendChild(button('btn', 'fa-solid fa-arrow-left', 'Keep Editing', close));
      actions.appendChild(button('btn btn-danger', 'fa-solid fa-xmark', 'Discard', function () {
        close();
        state.questionsDirty = false;
        showView('list');
      }));
      modal.appendChild(actions);
    });
  }

  // ── import from lessons ────────────────────────────────────────────────────

  /**
   * Lesson exercises are prompt/answer pairs rather than multiple choice, so an
   * import seeds the question text and puts the lesson's answer in Option A.
   * The remaining options are for the admin to write — nothing is invented here,
   * and the lesson rows themselves are never modified.
   */
  function openImportDialog() {
    openModal(function (modal, close) {
      modal.appendChild(el('h3', null, 'Import Questions from Lessons'));
      modal.appendChild(el('p', null,
        'Choose exercises from your published lessons. Each one becomes a new question ' +
        'with its answer pre-filled as Option A — write the remaining options before saving. ' +
        'The original lessons are not changed.'));

      var body = el('div');
      stateBlock(body, 'fa-solid fa-spinner fa-spin', 'Loading lessons…');
      modal.appendChild(body);

      var actions = el('div', 'at-modal-actions');
      actions.appendChild(button('btn', 'fa-solid fa-xmark', 'Cancel', close));
      var add = button('btn btn-primary', 'fa-solid fa-plus', 'Add Selected Questions');
      add.disabled = true;
      actions.appendChild(add);
      modal.appendChild(actions);

      var checks = [];

      callApi({ action: 'adminGetLessonExercises', lessonIds: [] })
        .then(function (res) {
          clearNode(body);
          var lessons = (Array.isArray(res.data) ? res.data : [])
            .filter(function (l) { return l.exercises.length; });

          if (!lessons.length) {
            body.appendChild(el('div', 'at-empty-hint',
              'None of your lessons have exercises to import yet.'));
            return;
          }

          lessons.forEach(function (lesson) {
            var group = el('div', 'at-import-lesson');
            var title = el('h4', null,
              'Lesson ' + lesson.lessonNumber + ' — ' + lesson.title);
            group.appendChild(title);

            var selectAll = checkbox('Select all in this lesson', false);
            group.appendChild(selectAll.wrap);

            var lessonChecks = [];
            lesson.exercises.forEach(function (ex) {
              var row = el('label', 'at-import-item');
              var box = el('input');
              box.type = 'checkbox';
              row.appendChild(box);

              var textWrap = el('span');
              textWrap.appendChild(document.createTextNode(ex.prompt));
              if (ex.answer) {
                textWrap.appendChild(el('span', 'at-import-answer', 'Answer: ' + ex.answer));
              }
              row.appendChild(textWrap);
              group.appendChild(row);

              var entry = {
                input: box,
                lessonNumber: lesson.lessonNumber,
                prompt: ex.prompt,
                answer: ex.answer
              };
              box.addEventListener('change', function () {
                add.disabled = !checks.some(function (c) { return c.input.checked; });
              });
              checks.push(entry);
              lessonChecks.push(entry);
            });

            selectAll.input.addEventListener('change', function () {
              lessonChecks.forEach(function (c) { c.input.checked = selectAll.input.checked; });
              add.disabled = !checks.some(function (c) { return c.input.checked; });
            });

            body.appendChild(group);
          });
        })
        .catch(function (err) {
          stateBlock(body, 'fa-solid fa-triangle-exclamation',
            (err && err.message) ? err.message : 'Unable to load lessons.');
        });

      add.addEventListener('click', function () {
        var picked = checks.filter(function (c) { return c.input.checked; });
        picked.forEach(function (c) {
          state.questions.push(normalizeQuestion({
            lessonNumber: String(c.lessonNumber || ''),
            question: c.prompt,
            optionA: c.answer,
            correctAnswer: 'A',
            marks: 1
          }));
        });
        state.questionsDirty = true;
        close();
        renderQuestionBuilder();
        toast('Added ' + picked.length +
          (picked.length === 1 ? ' question. Complete its options before saving.'
            : ' questions. Complete their options before saving.'));
      });
    }, true);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUBMISSIONS
  // ══════════════════════════════════════════════════════════════════════════

  function openSubmissions(testId) {
    showView('submissions');
    state.submissionsTestId = testId || '';
    state.submissionSearch = '';

    var host = $('atSubmissionsBody');
    if (host) stateBlock(host, 'fa-solid fa-spinner fa-spin', 'Loading submissions…');

    callApi({ action: 'adminGetTestSubmissions', testId: state.submissionsTestId })
      .then(function (res) {
        state.submissions = Array.isArray(res.data) ? res.data : [];
        renderSubmissions();
      })
      .catch(function (err) {
        if (host) {
          stateBlock(host, 'fa-solid fa-triangle-exclamation',
            (err && err.message) ? err.message : 'Unable to load submissions.');
        }
      });
  }

  function renderSubmissions() {
    var host = $('atSubmissionsBody');
    if (!host) return;
    clearNode(host);

    var head = el('div', 'at-editor-head');
    var titleWrap = el('div');
    titleWrap.appendChild(el('h3', null, 'Test Submissions'));
    titleWrap.appendChild(el('p', 'at-editor-sub',
      state.submissionsTestId ? 'One test' : 'All tests'));
    head.appendChild(titleWrap);
    head.appendChild(button('btn', 'fa-solid fa-arrow-left', 'Back to Tests', function () {
      showView('list');
    }));
    host.appendChild(head);

    // ── filters ──
    var toolbar = el('div', 'at-toolbar');

    var testSelect = el('select');
    var allOption = el('option', null, 'All tests');
    allOption.value = '';
    testSelect.appendChild(allOption);
    state.list.forEach(function (t) {
      var option = el('option', null, t.name);
      option.value = t.id;
      if (t.id === state.submissionsTestId) option.selected = true;
      testSelect.appendChild(option);
    });
    testSelect.addEventListener('change', function () {
      openSubmissions(testSelect.value);
    });
    var selectWrap = el('div', 'at-field');
    selectWrap.style.marginBottom = '0';
    selectWrap.appendChild(testSelect);
    toolbar.appendChild(selectWrap);

    var searchInput = input('text', state.submissionSearch, 'Search name or email…');
    searchInput.addEventListener('input', function () {
      state.submissionSearch = searchInput.value;
      renderSubmissionTable(tableHost);
    });
    var searchWrap = el('div', 'at-field');
    searchWrap.style.marginBottom = '0';
    searchWrap.appendChild(searchInput);
    toolbar.appendChild(searchWrap);

    var sortSelect = el('select');
    [['submitTime', 'Sort: Most recent'], ['score', 'Sort: Highest score'],
    ['name', 'Sort: Student name']].forEach(function (pair) {
      var option = el('option', null, pair[1]);
      option.value = pair[0];
      if (state.submissionSort === pair[0]) option.selected = true;
      sortSelect.appendChild(option);
    });
    sortSelect.addEventListener('change', function () {
      state.submissionSort = sortSelect.value;
      renderSubmissionTable(tableHost);
    });
    var sortWrap = el('div', 'at-field');
    sortWrap.style.marginBottom = '0';
    sortWrap.appendChild(sortSelect);
    toolbar.appendChild(sortWrap);

    toolbar.appendChild(el('span', 'at-spacer'));
    toolbar.appendChild(button('btn', 'fa-regular fa-arrows-rotate', 'Refresh', function () {
      openSubmissions(state.submissionsTestId);
    }));
    host.appendChild(toolbar);

    var tableHost = el('div');
    host.appendChild(tableHost);
    renderSubmissionTable(tableHost);
  }

  function renderSubmissionTable(host) {
    clearNode(host);

    var needle = state.submissionSearch.trim().toLowerCase();
    var rows = state.submissions.filter(function (s) {
      if (!needle) return true;
      return String(s.studentName || '').toLowerCase().indexOf(needle) !== -1 ||
        String(s.studentEmail || '').toLowerCase().indexOf(needle) !== -1;
    });

    rows.sort(function (a, b) {
      if (state.submissionSort === 'score') return b.percentage - a.percentage;
      if (state.submissionSort === 'name') {
        return String(a.studentName).localeCompare(String(b.studentName));
      }
      return String(b.submitTime || '').localeCompare(String(a.submitTime || ''));
    });

    if (!rows.length) {
      stateBlock(host, 'fa-regular fa-file-lines',
        state.submissions.length ? 'No submissions match this search.' : 'No submissions yet.');
      return;
    }

    var wrap = el('div', 'sm-table-wrap');
    var table = el('table', 'sm-table');

    var thead = el('thead');
    var headRow = el('tr');
    ['Student Name', 'Email', 'Score', 'Percentage', 'Start Time', 'Submit Time', 'Type', 'Status', '']
      .forEach(function (h) { headRow.appendChild(el('th', null, h)); });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    rows.forEach(function (s) {
      var tr = el('tr');
      tr.appendChild(el('td', null, s.studentName));
      tr.appendChild(el('td', null, s.studentEmail));
      tr.appendChild(el('td', null, s.score + ' / ' + s.totalMarks));
      tr.appendChild(el('td', null, s.percentage + '%'));
      tr.appendChild(el('td', null, s.startTimeLabel || '—'));
      tr.appendChild(el('td', null, s.submitTimeLabel || '—'));
      tr.appendChild(el('td', null, s.submissionType));
      tr.appendChild(el('td', null, s.status));

      var actionCell = el('td');
      actionCell.appendChild(button('btn', 'fa-regular fa-eye', 'View', function () {
        openSubmissionDetail(s.id);
      }));
      tr.appendChild(actionCell);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  function openSubmissionDetail(submissionId) {
    openModal(function (modal, close) {
      modal.appendChild(el('h3', null, 'Student Result'));
      var body = el('div');
      stateBlock(body, 'fa-solid fa-spinner fa-spin', 'Loading result…');
      modal.appendChild(body);

      var actions = el('div', 'at-modal-actions');
      actions.appendChild(button('btn', 'fa-solid fa-xmark', 'Close', close));
      modal.appendChild(actions);

      callApi({ action: 'adminGetTestSubmission', submissionId: submissionId })
        .then(function (res) {
          clearNode(body);
          renderSubmissionDetail(body, res.data, res.questions || []);
        })
        .catch(function (err) {
          stateBlock(body, 'fa-solid fa-triangle-exclamation',
            (err && err.message) ? err.message : 'Unable to load this result.');
        });
    }, true);
  }

  function renderSubmissionDetail(host, data, questions) {
    var summary = el('div', 'at-detail-grid');
    [
      ['Student', data.studentName],
      ['Email', data.studentEmail],
      ['Test', data.testName],
      ['Score', data.score + ' / ' + data.totalMarks],
      ['Percentage', data.percentage + '%'],
      ['Correct', String(data.correct)],
      ['Incorrect', String(data.incorrect)],
      ['Unanswered', String(data.unanswered)],
      ['Started', data.startTimeLabel || '—'],
      ['Submitted', data.submitTimeLabel || '—'],
      ['Time Used', data.durationUsed || '—'],
      ['Type', data.submissionType]
    ].forEach(function (pair) {
      var item = el('div', 'at-detail-item');
      item.appendChild(el('span', 'at-stat-label', pair[0]));
      item.appendChild(el('span', null, pair[1]));
      summary.appendChild(item);
    });
    host.appendChild(summary);

    host.appendChild(el('h4', null, 'Answers'));

    questions.forEach(function (q, index) {
      var kind = !q.studentAnswer ? 'is-blank'
        : (q.studentAnswer === q.correctAnswer ? 'is-correct' : 'is-wrong');
      var row = el('div', 'at-answer-row ' + kind);

      row.appendChild(el('p', 'at-answer-q', (index + 1) + '. ' + q.question));

      var meta = el('div', 'at-answer-meta');

      var given = el('span');
      given.appendChild(document.createTextNode('Student answer: '));
      given.appendChild(el('strong', null, q.studentAnswer
        ? q.studentAnswer + '. ' + q.studentAnswerText
        : 'Not answered'));
      meta.appendChild(given);

      var correct = el('span');
      correct.appendChild(document.createTextNode('Correct answer: '));
      correct.appendChild(el('strong', null, q.correctAnswer + '. ' + q.correctAnswerText));
      meta.appendChild(correct);

      var marks = el('span');
      marks.appendChild(document.createTextNode('Marks: '));
      marks.appendChild(el('strong', null, q.awarded + ' / ' + q.marks));
      meta.appendChild(marks);

      row.appendChild(meta);
      host.appendChild(row);
    });
  }

  // ── exposed for the inline handlers in admin.html ──────────────────────────

  global.loadAdminTests = loadAdminTests;
  global.renderAdminTests = renderAdminTests;
  global.setTestStatusFilter = setTestStatusFilter;
  global.openTestEditor = openTestEditor;
  global.closeTestEditor = closeTestEditor;
  global.openTestSubmissions = openSubmissions;
})(window);
