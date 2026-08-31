/* ============================================================================
   Fluency — Attendance (admin tab)

   One screen that does three jobs:
     1. Data entry  — pick a session, mark every student P / A / L / E, save.
     2. Overview    — the whole term as a grid, every student × every session.
     3. Print       — the register, the session log, the class summary and a
                      single student's report, all matching the PDF pack.

   Backend actions used (all admin-token guarded, see Code.gs):
     getAttendance · saveAttendanceSession · deleteAttendanceSession ·
     saveAttendanceMarks · getStudents
   ========================================================================== */
(function (global) {
    'use strict';

    var STATUSES = ['P', 'A', 'L', 'E'];
    var LABEL = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };
    var ROWS_PER_SHEET = 18;      // matches the printed register
    var COLS_PER_SHEET = 16;      // sessions per printed register sheet
    var LOW_ATTENDANCE = 75;      // % below which a row is flagged

    var state = {
        loading: false,
        loaded: false,
        sessions: [],
        marks: [],
        summary: { sessionsHeld: 0, byStudent: {} },
        students: [],
        currentId: null,
        draft: {},                // email -> status, for the open session
        dirty: false,
        search: ''
    };

    // ── small helpers ────────────────────────────────────────────────────────
    function $(id) { return document.getElementById(id); }

    function el(tag, className, text) {
        var n = document.createElement(tag);
        if (className) n.className = className;
        if (text != null) n.textContent = text;
        return n;
    }

    function icon(classes) {
        var i = document.createElement('i');
        i.className = classes;
        return i;
    }

    function clearNode(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function notify(msg) {
        if (typeof global.showNotification === 'function') global.showNotification(msg);
    }

    function fail(msg) {
        if (typeof global.showError === 'function') global.showError(msg);
        else notify(msg);
    }

    function api(payload) {
        if (typeof global.adminFetch !== 'function') {
            return Promise.reject(new Error('Not signed in'));
        }
        return global.adminFetch(payload).then(function (res) {
            if (!res || !res.success) {
                throw new Error((res && res.error) || 'Request failed');
            }
            return res;
        });
    }

    function today() {
        var d = new Date();
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    /** 2026-09-06 -> 6 Sep 2026 (kept short for table cells). */
    function niceDate(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function shortDate(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    }

    function currentSession() {
        for (var i = 0; i < state.sessions.length; i++) {
            if (state.sessions[i].id === state.currentId) return state.sessions[i];
        }
        return null;
    }

    /** Marks for one session as { email: status }. */
    function marksFor(sessionId) {
        var out = {};
        for (var i = 0; i < state.marks.length; i++) {
            if (state.marks[i].sessionId === sessionId) out[state.marks[i].email] = state.marks[i].status;
        }
        return out;
    }

    function statusOf(sessionId, email) {
        for (var i = 0; i < state.marks.length; i++) {
            if (state.marks[i].sessionId === sessionId && state.marks[i].email === email) {
                return state.marks[i].status;
            }
        }
        return '';
    }

    function summaryFor(email) {
        var r = state.summary && state.summary.byStudent && state.summary.byStudent[email];
        return r || { P: 0, A: 0, L: 0, E: 0, attended: 0, pct: null };
    }

    function rosterList() {
        var q = state.search.trim().toLowerCase();
        var list = state.students.slice();
        if (q) {
            list = list.filter(function (s) {
                return (s.name || '').toLowerCase().indexOf(q) !== -1 ||
                    (s.email || '').toLowerCase().indexOf(q) !== -1;
            });
        }
        list.sort(function (a, b) {
            return String(a.name || a.email).localeCompare(String(b.name || b.email));
        });
        return list;
    }

    // ── loading ──────────────────────────────────────────────────────────────
    function load(force) {
        if (state.loading) return Promise.resolve();
        if (state.loaded && !force) { render(); return Promise.resolve(); }
        state.loading = true;
        renderLoading();

        return Promise.all([
            api({ action: 'getAttendance' }),
            api({ action: 'getStudents' })
        ]).then(function (parts) {
            var att = parts[0];
            state.sessions = att.sessions || [];
            state.marks = att.marks || [];
            state.summary = att.summary || { sessionsHeld: 0, byStudent: {} };
            state.students = (parts[1].students || []).filter(function (s) { return s && s.email; });
            state.loaded = true;
            state.loading = false;

            // Keep the open session if it still exists, else the newest one.
            if (!currentSession()) {
                state.currentId = state.sessions.length
                    ? state.sessions[state.sessions.length - 1].id
                    : null;
            }
            resetDraft();
            render();
        }).catch(function (err) {
            state.loading = false;
            renderError(err && err.message ? err.message : 'Could not load attendance.');
        });
    }

    function resetDraft() {
        state.draft = state.currentId ? marksFor(state.currentId) : {};
        state.dirty = false;
    }

    // ── rendering ────────────────────────────────────────────────────────────
    function root() { return $('attRoot'); }

    function renderLoading() {
        var r = root();
        if (!r) return;
        clearNode(r);
        var box = el('div', 'att-empty');
        box.appendChild(icon('fa-regular fa-arrows-rotate fa-spin'));
        box.appendChild(el('h4', null, 'Loading attendance…'));
        r.appendChild(box);
    }

    function renderError(msg) {
        var r = root();
        if (!r) return;
        clearNode(r);
        var box = el('div', 'att-empty');
        box.appendChild(icon('fa-regular fa-circle-exclamation'));
        box.appendChild(el('h4', null, 'Could not load attendance'));
        box.appendChild(el('p', null, msg));
        var btn = el('button', 'att-btn primary');
        btn.style.marginTop = '.9rem';
        btn.appendChild(icon('fa-regular fa-arrows-rotate'));
        btn.appendChild(document.createTextNode(' Try again'));
        btn.addEventListener('click', function () { load(true); });
        box.appendChild(btn);
        r.appendChild(box);
    }

    function render() {
        var r = root();
        if (!r) return;
        clearNode(r);

        var wrap = el('div', 'att-wrap');
        wrap.appendChild(buildSessionBar());

        if (!state.sessions.length) {
            var none = el('div', 'att-empty');
            none.appendChild(icon('fa-regular fa-calendar-plus'));
            none.appendChild(el('h4', null, 'No sessions yet'));
            none.appendChild(el('p', null,
                'Create your first session above — give it a date, the lesson code and the topic. ' +
                'The register and every student report are built from these sessions.'));
            wrap.appendChild(none);
            r.appendChild(wrap);
            return;
        }

        wrap.appendChild(buildCounts());
        wrap.appendChild(buildRosterBlock());
        wrap.appendChild(buildGridBlock());
        r.appendChild(wrap);
    }

    // session picker + editor
    function buildSessionBar() {
        var bar = el('div', 'att-bar');
        var s = currentSession();

        // picker
        var pick = el('div', 'att-grow');
        pick.appendChild(el('label', null, 'Session'));
        var sel = el('select');
        sel.id = 'attSessionSelect';
        if (!state.sessions.length) {
            var o = el('option', null, 'No sessions yet');
            o.value = '';
            sel.appendChild(o);
            sel.disabled = true;
        } else {
            state.sessions.forEach(function (ses) {
                var opt = el('option', null,
                    'Session ' + ses.no + ' · ' + (niceDate(ses.date) || 'no date') +
                    (ses.topic ? ' · ' + ses.topic : ''));
                opt.value = ses.id;
                if (ses.id === state.currentId) opt.selected = true;
                sel.appendChild(opt);
            });
        }
        sel.addEventListener('change', function () {
            if (state.dirty && !global.confirm('You have unsaved marks. Discard them?')) {
                sel.value = state.currentId;
                return;
            }
            state.currentId = sel.value;
            resetDraft();
            render();
        });
        pick.appendChild(sel);
        bar.appendChild(pick);

        // editable session fields
        var dateWrap = el('div');
        dateWrap.style.minWidth = '150px';
        dateWrap.appendChild(el('label', null, 'Date'));
        var date = el('input');
        date.type = 'date';
        date.id = 'attSessionDate';
        date.value = s ? s.date : today();
        dateWrap.appendChild(date);
        bar.appendChild(dateWrap);

        var codeWrap = el('div');
        codeWrap.style.minWidth = '120px';
        codeWrap.appendChild(el('label', null, 'Lesson code'));
        var code = el('input');
        code.type = 'text';
        code.id = 'attSessionCode';
        code.placeholder = '2002';
        code.value = s ? s.lessonCode : '';
        codeWrap.appendChild(code);
        bar.appendChild(codeWrap);

        var topicWrap = el('div', 'att-grow');
        topicWrap.appendChild(el('label', null, 'Topic taught'));
        var topic = el('input');
        topic.type = 'text';
        topic.id = 'attSessionTopic';
        topic.placeholder = 'am / is / are — questions';
        topic.value = s ? s.topic : '';
        topicWrap.appendChild(topic);
        bar.appendChild(topicWrap);

        // actions
        var actions = el('div', 'att-actions');

        var saveBtn = el('button', 'att-btn primary');
        saveBtn.appendChild(icon('fa-regular fa-floppy-disk'));
        saveBtn.appendChild(document.createTextNode(s ? ' Update session' : ' Create session'));
        saveBtn.addEventListener('click', saveSession);
        actions.appendChild(saveBtn);

        var newBtn = el('button', 'att-btn');
        newBtn.appendChild(icon('fa-regular fa-calendar-plus'));
        newBtn.appendChild(document.createTextNode(' New session'));
        newBtn.addEventListener('click', newSession);
        actions.appendChild(newBtn);

        if (s) {
            var delBtn = el('button', 'att-btn danger');
            delBtn.appendChild(icon('fa-regular fa-trash-can'));
            delBtn.appendChild(document.createTextNode(' Delete'));
            delBtn.addEventListener('click', function () { deleteSession(s); });
            actions.appendChild(delBtn);
        }

        var refresh = el('button', 'att-btn');
        refresh.appendChild(icon('fa-regular fa-arrows-rotate'));
        refresh.appendChild(document.createTextNode(' Refresh'));
        refresh.addEventListener('click', function () { load(true); });
        actions.appendChild(refresh);

        bar.appendChild(actions);
        return bar;
    }

    function buildCounts() {
        var wrap = el('div', 'att-counts');
        wrap.id = 'attCounts';
        paintCounts(wrap);
        return wrap;
    }

    function paintCounts(node) {
        node = node || $('attCounts');
        if (!node) return;
        clearNode(node);

        var tally = { P: 0, A: 0, L: 0, E: 0 };
        Object.keys(state.draft).forEach(function (email) {
            if (tally[state.draft[email]] !== undefined) tally[state.draft[email]]++;
        });
        var marked = tally.P + tally.A + tally.L + tally.E;
        var attended = tally.P + tally.L + tally.E;

        STATUSES.forEach(function (st) {
            var c = el('div', 'att-count ' + st);
            c.appendChild(el('div', 'v', String(tally[st])));
            c.appendChild(el('div', 'k', LABEL[st]));
            node.appendChild(c);
        });

        var pct = el('div', 'att-count pct');
        pct.appendChild(el('div', 'v', marked ? Math.round(attended / marked * 100) + '%' : '—'));
        pct.appendChild(el('div', 'k', 'Attended'));
        node.appendChild(pct);

        var left = el('div', 'att-count');
        left.appendChild(el('div', 'v', String(Math.max(0, state.students.length - marked))));
        left.appendChild(el('div', 'k', 'Not marked'));
        node.appendChild(left);
    }

    // roster with the P/A/L/E pickers
    function buildRosterBlock() {
        var box = el('div');

        var head = el('div', 'att-head');
        var left = el('div');
        var s = currentSession();
        left.appendChild(el('h4', null,
            s ? 'Session ' + s.no + ' — ' + (niceDate(s.date) || 'no date') : 'Roster'));
        var sub = el('div', 'att-sub',
            'Tap a letter for each student. Nothing is stored until you press Save marks.');
        left.appendChild(sub);
        head.appendChild(left);

        var dirty = el('span', 'att-dirty', 'Unsaved changes');
        dirty.id = 'attDirty';
        if (state.dirty) dirty.classList.add('on');
        head.appendChild(dirty);
        box.appendChild(head);

        // toolbar
        var bar = el('div', 'att-bar');
        bar.style.marginTop = '.7rem';

        var searchWrap = el('div', 'att-grow');
        searchWrap.appendChild(el('label', null, 'Find a student'));
        var search = el('input');
        search.type = 'text';
        search.placeholder = 'Name or email…';
        search.value = state.search;
        search.addEventListener('input', function () {
            state.search = search.value;
            paintRoster();
        });
        searchWrap.appendChild(search);
        bar.appendChild(searchWrap);

        var acts = el('div', 'att-actions');
        STATUSES.forEach(function (st) {
            if (st === 'A') return;   // marking everyone absent is never the useful default
            var b = el('button', 'att-btn');
            b.textContent = 'All ' + LABEL[st].toLowerCase();
            b.addEventListener('click', function () { markAll(st); });
            if (st !== 'P') b.style.display = 'none';   // only "All present" is offered
            acts.appendChild(b);
        });

        var clearBtn = el('button', 'att-btn');
        clearBtn.appendChild(icon('fa-regular fa-eraser'));
        clearBtn.appendChild(document.createTextNode(' Clear'));
        clearBtn.addEventListener('click', function () { markAll(''); });
        acts.appendChild(clearBtn);

        var saveMarks = el('button', 'att-btn primary');
        saveMarks.appendChild(icon('fa-regular fa-circle-check'));
        saveMarks.appendChild(document.createTextNode(' Save marks'));
        saveMarks.addEventListener('click', saveMarksNow);
        acts.appendChild(saveMarks);

        bar.appendChild(acts);
        box.appendChild(bar);

        var legend = el('div', 'att-legend');
        legend.style.margin = '.7rem 0';
        STATUSES.forEach(function (st) {
            var span = el('span');
            var i = el('i', 'lg-' + st, st);
            span.appendChild(i);
            span.appendChild(document.createTextNode(LABEL[st]));
            legend.appendChild(span);
        });
        var note = el('span');
        note.style.color = '#8ba2b8';
        note.textContent = '— Present, Late and Excused all count as attended.';
        legend.appendChild(note);
        box.appendChild(legend);

        var roster = el('div', 'att-roster');
        roster.id = 'attRoster';
        box.appendChild(roster);
        paintRoster(roster);
        return box;
    }

    function paintRoster(node) {
        node = node || $('attRoster');
        if (!node) return;
        clearNode(node);

        var list = rosterList();
        if (!list.length) {
            var empty = el('div', 'att-empty');
            empty.appendChild(icon('fa-regular fa-user-group'));
            empty.appendChild(el('h4', null, state.students.length ? 'No match' : 'No students yet'));
            empty.appendChild(el('p', null, state.students.length
                ? 'No student matches that search.'
                : 'Students appear here once they have submitted at least one lesson.'));
            node.appendChild(empty);
            return;
        }

        list.forEach(function (s, idx) {
            node.appendChild(buildRosterRow(s, idx + 1));
        });
    }

    function buildRosterRow(s, no) {
        var sum = summaryFor(s.email);
        var row = el('div', 'att-row');
        row.dataset.email = s.email;
        if (sum.pct != null && sum.pct < LOW_ATTENDANCE) row.classList.add('low');

        row.appendChild(el('div', 'att-no', String(no)));

        var who = el('div', 'att-who');
        var nm = el('div', 'att-nm', s.name || s.email);
        nm.title = 'Open full student record';
        nm.addEventListener('click', function () { openRecord(s.email); });
        who.appendChild(nm);
        who.appendChild(el('div', 'att-em', s.email));
        row.appendChild(who);

        var pct = el('div', 'att-pct');
        if (sum.pct == null) {
            pct.textContent = '—';
        } else {
            pct.innerHTML = '<b>' + sum.pct + '%</b> term';
        }
        row.appendChild(pct);

        var pick = el('div', 'att-pick');
        STATUSES.forEach(function (st) {
            var b = el('button', st, st);
            b.title = LABEL[st];
            b.dataset.status = st;
            if (state.draft[s.email] === st) b.classList.add('on');
            b.addEventListener('click', function () { setMark(s.email, st, row); });
            pick.appendChild(b);
        });
        row.appendChild(pick);
        return row;
    }

    /** Clicking the status a student already has clears it. */
    function setMark(email, status, row) {
        if (state.draft[email] === status) delete state.draft[email];
        else state.draft[email] = status;

        state.dirty = true;
        var badge = $('attDirty');
        if (badge) badge.classList.add('on');

        if (row) {
            var btns = row.querySelectorAll('.att-pick button');
            for (var i = 0; i < btns.length; i++) {
                btns[i].classList.toggle('on', btns[i].dataset.status === state.draft[email]);
            }
        }
        paintCounts();
    }

    function markAll(status) {
        var list = rosterList();
        list.forEach(function (s) {
            if (status) state.draft[s.email] = status;
            else delete state.draft[s.email];
        });
        state.dirty = true;
        var badge = $('attDirty');
        if (badge) badge.classList.add('on');
        paintRoster();
        paintCounts();
    }

    // ── overview grid ────────────────────────────────────────────────────────
    function buildGridBlock() {
        var box = el('div');
        box.style.marginTop = '.4rem';

        var head = el('div', 'att-head');
        var left = el('div');
        left.appendChild(el('h4', null, 'Term overview'));
        left.appendChild(el('div', 'att-sub',
            'Every student against every session. Click a name to open the full record.'));
        head.appendChild(left);

        var acts = el('div', 'att-actions');

        var pReg = el('button', 'att-btn primary');
        pReg.appendChild(icon('fa-regular fa-print'));
        pReg.appendChild(document.createTextNode(' Print register'));
        pReg.addEventListener('click', printRegister);
        acts.appendChild(pReg);

        var pLog = el('button', 'att-btn');
        pLog.appendChild(icon('fa-regular fa-clipboard'));
        pLog.appendChild(document.createTextNode(' Print session log'));
        pLog.addEventListener('click', printSessionLog);
        acts.appendChild(pLog);

        var pSum = el('button', 'att-btn');
        pSum.appendChild(icon('fa-regular fa-table-list'));
        pSum.appendChild(document.createTextNode(' Print summary'));
        pSum.addEventListener('click', printSummary);
        acts.appendChild(pSum);

        head.appendChild(acts);
        box.appendChild(head);

        var wrap = el('div', 'att-grid-wrap');
        wrap.style.marginTop = '.7rem';
        wrap.appendChild(buildGridTable());
        box.appendChild(wrap);
        return box;
    }

    function buildGridTable() {
        var t = el('table', 'att-grid');
        var thead = el('thead');
        var hr = el('tr');
        hr.appendChild(thHelper('Student', 'nm'));
        state.sessions.forEach(function (s) {
            var th = thHelper(String(s.no));
            th.title = (niceDate(s.date) || '') + (s.topic ? ' — ' + s.topic : '');
            hr.appendChild(th);
        });
        hr.appendChild(thHelper('P'));
        hr.appendChild(thHelper('A'));
        hr.appendChild(thHelper('%'));
        thead.appendChild(hr);
        t.appendChild(thead);

        var tb = el('tbody');
        rosterList().forEach(function (s) {
            var tr = el('tr');
            var nm = el('td', 'nm', s.name || s.email);
            nm.title = s.email;
            nm.addEventListener('click', function () { openRecord(s.email); });
            tr.appendChild(nm);

            state.sessions.forEach(function (ses) {
                var st = statusOf(ses.id, s.email);
                var td = el('td', 'mk ' + (st || 'none'), st || '·');
                tr.appendChild(td);
            });

            var sum = summaryFor(s.email);
            tr.appendChild(el('td', 'tot', String(sum.P + sum.L + sum.E)));
            tr.appendChild(el('td', 'tot', String(sum.A)));
            tr.appendChild(el('td', 'tot', sum.pct == null ? '—' : sum.pct + '%'));
            tb.appendChild(tr);
        });
        t.appendChild(tb);
        return t;
    }

    function thHelper(text, cls) {
        var th = el('th', cls, text);
        return th;
    }

    function openRecord(email) {
        if (typeof global.openStudent === 'function') global.openStudent(email);
    }

    // ── writes ───────────────────────────────────────────────────────────────
    function readSessionForm() {
        return {
            date: ($('attSessionDate') || {}).value || '',
            lessonCode: ($('attSessionCode') || {}).value || '',
            topic: ($('attSessionTopic') || {}).value || ''
        };
    }

    function saveSession() {
        var form = readSessionForm();
        if (!form.date) { fail('Pick a date for the session.'); return; }

        var s = currentSession();
        var payload = {
            action: 'saveAttendanceSession',
            session: {
                id: s ? s.id : '',
                date: form.date,
                lessonCode: form.lessonCode,
                topic: form.topic
            }
        };
        api(payload).then(function (res) {
            notify(s ? 'Session updated' : 'Session created');
            state.currentId = (res.session && res.session.id) || state.currentId;
            return load(true);
        }).catch(function (err) {
            fail(err.message || 'Could not save the session.');
        });
    }

    function newSession() {
        if (state.dirty && !global.confirm('You have unsaved marks. Discard them?')) return;
        var form = readSessionForm();
        api({
            action: 'saveAttendanceSession',
            session: { id: '', date: form.date || today(), lessonCode: '', topic: '' }
        }).then(function (res) {
            state.currentId = (res.session && res.session.id) || null;
            notify('Session created');
            return load(true);
        }).catch(function (err) {
            fail(err.message || 'Could not create the session.');
        });
    }

    function deleteSession(s) {
        if (!global.confirm('Delete session ' + s.no + '? Its attendance marks are deleted too.')) return;
        api({ action: 'deleteAttendanceSession', sessionId: s.id }).then(function () {
            notify('Session deleted');
            state.currentId = null;
            return load(true);
        }).catch(function (err) {
            fail(err.message || 'Could not delete the session.');
        });
    }

    function saveMarksNow() {
        var s = currentSession();
        if (!s) { fail('Create a session first.'); return; }

        var marks = Object.keys(state.draft)
            .filter(function (email) { return !!state.draft[email]; })
            .map(function (email) { return { email: email, status: state.draft[email] }; });

        api({ action: 'saveAttendanceMarks', sessionId: s.id, marks: marks })
            .then(function (res) {
                notify('Saved ' + res.saved + ' mark' + (res.saved === 1 ? '' : 's'));
                state.dirty = false;
                return load(true);
            })
            .catch(function (err) {
                fail(err.message || 'Could not save the marks.');
            });
    }

    // ── printing ─────────────────────────────────────────────────────────────
    function openPrint(title, bodyHtml) {
        var w = global.open('', '_blank');
        if (!w) { fail('Allow pop-ups to print.'); return; }
        w.document.open();
        w.document.write(
            '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
            '<title>' + esc(title) + '</title>' +
            '<link rel="stylesheet" href="attendance-print.css">' +
            '</head><body>' +
            '<div class="pv-bar"><b>Fluency</b> ' + esc(title) +
            '<span class="sp"></span>' +
            '<button onclick="window.print()">Print / Save as PDF</button>' +
            '<button class="ghost" onclick="window.close()">Close</button></div>' +
            bodyHtml +
            '</body></html>'
        );
        w.document.close();
        w.focus();
    }

    function docTop(title, doc) {
        return '<div class="top"><div class="id">' +
            '<span class="brand">Fluency <span>&bull;</span> Language Mastery</span>' +
            '<h1>' + esc(title) + '</h1></div>' +
            '<div class="doc">' + doc + '</div></div>';
    }

    function docFoot(right) {
        return '<div class="foot"><span>Fluency &middot; Attendance &amp; Progress System</span>' +
            '<span><b>' + right + '</b></span></div>';
    }

    function fieldBox(label, value, blank) {
        return '<div class="field"><div class="lab">' + esc(label) + '</div>' +
            '<div class="box' + (blank ? ' blank' : '') + '">' + esc(value || '') + '</div></div>';
    }

    var LEGEND_HTML =
        '<div class="legend">' +
        '<div class="key"><span class="c present">P</span><span class="t"><b>Present</b>on time</span></div>' +
        '<div class="key"><span class="c absent">A</span><span class="t"><b>Absent</b>no contact</span></div>' +
        '<div class="key"><span class="c late">L</span><span class="t"><b>Late</b>counts as present</span></div>' +
        '<div class="key"><span class="c excused">E</span><span class="t"><b>Excused</b>told in advance</span></div>' +
        '<div class="key note-key"><span class="t">Attendance % counts <b>P</b>, <b>L</b> and <b>E</b> as attended. ' +
        'A student below 75% should be contacted before the next assignment deadline.</span></div>' +
        '</div>';

    function printRegister() {
        if (!state.sessions.length) { fail('Create a session first.'); return; }

        var students = rosterList();
        var studentChunks = chunk(students, ROWS_PER_SHEET);
        var sessionChunks = chunk(state.sessions, COLS_PER_SHEET);
        if (!studentChunks.length) studentChunks = [[]];

        var html = '';
        var page = 0;
        var sheets = studentChunks.length * sessionChunks.length;

        studentChunks.forEach(function (rows, si) {
            sessionChunks.forEach(function (cols) {
                page++;
                var head = '';
                for (var c = 0; c < COLS_PER_SHEET; c++) {
                    head += '<th class="rot">' + (cols[c] ? cols[c].no : '') + '</th>';
                }

                var body = '';
                for (var i = 0; i < ROWS_PER_SHEET; i++) {
                    var s = rows[i];
                    var cells = '';
                    for (var c2 = 0; c2 < COLS_PER_SHEET; c2++) {
                        var st = (s && cols[c2]) ? statusOf(cols[c2].id, s.email) : '';
                        cells += '<td class="s ' + st + '">' + (st || '') + '</td>';
                    }
                    var sum = s ? summaryFor(s.email) : null;
                    body += '<tr><td class="n">' + (i + 1 + si * ROWS_PER_SHEET) + '</td>' +
                        '<td class="nm">' + esc(s ? (s.name || s.email) : '') + '</td>' +
                        '<td class="sid">' + esc(s ? (s.id || '') : '') + '</td>' + cells +
                        '<td class="tot">' + (sum ? sum.P + sum.L + sum.E : '') + '</td>' +
                        '<td class="tot">' + (sum ? sum.A : '') + '</td>' +
                        '<td class="pct">' + (sum && sum.pct != null ? sum.pct + '%' : '') + '</td></tr>';
                }

                var range = cols.length
                    ? 'Sessions ' + cols[0].no + ' – ' + cols[cols.length - 1].no
                    : '';

                html += '<section class="sheet l">' +
                    docTop('Class Attendance Register', 'Register &middot; sheet ' + page + ' of ' + sheets) +
                    '<div class="fields">' +
                    fieldBox('Group / Class', '', true) +
                    fieldBox('Teacher', '', true) +
                    fieldBox('Sessions held', String(state.sessions.length)) +
                    fieldBox('Range', range) +
                    '</div>' +
                    '<table class="reg"><thead><tr>' +
                    '<th style="width:7mm;">#</th><th class="nm" style="width:50mm;">Student name</th>' +
                    '<th style="width:21mm;">ID</th>' + head +
                    '<th style="width:11mm;">P</th><th style="width:11mm;">A</th><th style="width:14mm;">%</th>' +
                    '</tr></thead><tbody>' + body + '</tbody></table>' +
                    LEGEND_HTML +
                    docFoot(String(page).padStart(2, '0')) +
                    '</section>';
            });
        });

        openPrint('Class Attendance Register', html);
    }

    function printSessionLog() {
        if (!state.sessions.length) { fail('Create a session first.'); return; }

        var pages = chunk(state.sessions, 6);
        var html = '';
        pages.forEach(function (group, gi) {
            var blocks = '';
            for (var i = 0; i < 6; i++) {
                var s = group[i];
                var tally = { P: 0, A: 0, L: 0, E: 0 };
                if (s) {
                    var m = marksFor(s.id);
                    Object.keys(m).forEach(function (email) { tally[m[email]]++; });
                }
                var absentNames = [];
                if (s) {
                    var mm = marksFor(s.id);
                    state.students.forEach(function (st) {
                        if (mm[st.email] === 'A') absentNames.push(st.name || st.email);
                    });
                }
                blocks += '<div class="log">' +
                    '<div class="lh"><span class="t">Session ' + (s ? s.no : '') + '</span>' +
                    '<span class="d">' + (s ? esc(niceDate(s.date)) : 'Date ____ / ____ / ______') + '</span></div>' +
                    '<div class="row">' +
                    '<div class="cell"><div class="lab">Lesson code</div><div class="rule">' +
                    esc(s ? s.lessonCode : '') + '</div></div>' +
                    '<div class="cell" style="flex:2;"><div class="lab">Topic taught</div><div class="rule">' +
                    esc(s ? s.topic : '') + '</div></div></div>' +
                    '<div class="row"><div class="cell"><div class="lab">Absent students</div>' +
                    '<div class="rule">' + esc(absentNames.join(', ')) + '</div></div></div>' +
                    '<div class="row"><div class="cell"><div class="lab">Follow-up needed</div>' +
                    '<div class="rule"></div></div></div>' +
                    '<div class="counts">' +
                    countBox('Present', s ? tally.P : '') +
                    countBox('Absent', s ? tally.A : '') +
                    countBox('Late', s ? tally.L : '') +
                    countBox('Excused', s ? tally.E : '') +
                    '</div></div>';
            }
            html += '<section class="sheet l">' +
                docTop('Session Log', 'Register &middot; what was taught') +
                '<div class="logs">' + blocks + '</div>' +
                docFoot(String(gi + 1).padStart(2, '0')) +
                '</section>';
        });

        openPrint('Session Log', html);
    }

    function countBox(k, v) {
        return '<div class="cnt"><div class="k">' + k + '</div><div class="v">' +
            (v === '' || v == null ? '' : v) + '</div></div>';
    }

    function printSummary() {
        var students = rosterList();
        var rows = '';
        students.forEach(function (s, i) {
            var sum = summaryFor(s.email);
            var pct = sum.pct;
            var tag = pct == null ? '<span class="tag blank">&mdash;</span>'
                : pct >= 90 ? '<span class="tag exc">Excellent</span>'
                    : pct >= 75 ? '<span class="tag good">OK</span>'
                        : '<span class="tag need">Contact</span>';
            rows += '<tr><td>' + (i + 1) + '</td>' +
                '<td class="nm">' + esc(s.name || s.email) + '</td>' +
                '<td class="em">' + esc(s.email) + '</td>' +
                '<td>' + esc(s.level || '') + '</td>' +
                '<td>' + sum.P + '</td><td>' + sum.A + '</td>' +
                '<td>' + sum.L + '</td><td>' + sum.E + '</td>' +
                '<td><b>' + (pct == null ? '—' : pct + '%') + '</b> &nbsp;' + tag + '</td></tr>';
        });

        var html = '<section class="sheet l">' +
            docTop('Class Attendance Summary', 'Overview &middot; ' + state.sessions.length + ' sessions held') +
            '<div class="fields">' +
            fieldBox('Group / Class', '', true) +
            fieldBox('Teacher', '', true) +
            fieldBox('Students', String(students.length)) +
            fieldBox('Prepared', niceDate(today())) +
            '</div>' +
            '<table class="sum"><thead><tr>' +
            '<th style="width:8mm;">#</th><th style="width:52mm;">Student</th><th style="width:60mm;">Email</th>' +
            '<th style="width:16mm;">Level</th><th style="width:16mm;">P</th><th style="width:16mm;">A</th>' +
            '<th style="width:16mm;">L</th><th style="width:16mm;">E</th><th>Attendance</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table>' +
            '<div class="legend" style="margin-top:3mm;">' +
            '<div class="key"><span class="c present wide">&#8805;90</span><span class="t"><b>Excellent</b>no action</span></div>' +
            '<div class="key"><span class="c late wide">75&ndash;89</span><span class="t"><b>OK</b>mention in the report</span></div>' +
            '<div class="key"><span class="c absent wide">&lt;75</span><span class="t"><b>Contact</b>before the next deadline</span></div>' +
            '<div class="key note-key"><span class="t">Percentages are out of <b>' + state.sessions.length +
            '</b> sessions held, not sessions marked.</span></div></div>' +
            docFoot('01') +
            '</section>';

        openPrint('Class Attendance Summary', html);
    }

    /**
     * One-page student report. Called from the attendance tab and from the
     * student record panel, which passes the record it already fetched.
     */
    function printStudentReport(payload) {
        payload = payload || {};
        var student = payload.student || {};
        var att = payload.attendance || null;
        var recent = payload.recent || [];

        var pct = att && att.pct != null ? att.pct : null;
        var ringColour = pct == null ? '#cfdeeb'
            : pct >= 75 ? '#2f8a63' : pct >= 60 ? '#b57d1f' : '#b3453a';
        var shown = pct == null ? 0 : Math.max(0, Math.min(100, pct));
        var dash = (shown / 100 * 100).toFixed(2);

        var ring = '<svg viewBox="0 0 42 42" width="34mm" height="34mm">' +
            '<circle cx="21" cy="21" r="15.9155" fill="none" stroke="#e8f1f8" stroke-width="4.2"/>' +
            '<circle cx="21" cy="21" r="15.9155" fill="none" stroke="' + ringColour + '" stroke-width="4.2" ' +
            'stroke-dasharray="' + dash + ' ' + (100 - dash).toFixed(2) + '" stroke-dashoffset="25" ' +
            'stroke-linecap="round"/>' +
            '<text x="21" y="22.6" text-anchor="middle" font-size="9.5" ' +
            'font-family="Segoe UI,Calibri,sans-serif" font-weight="700" fill="#123a5c">' +
            (pct == null ? '&mdash;' : shown + '%') + '</text></svg>';

        function acell(v, cls, k) {
            return '<div class="acell ' + cls + '"><div class="v">' + v + '</div>' +
                '<div class="k">' + k + '</div></div>';
        }

        var cells = att
            ? acell(att.present, 'g', 'Present') + acell(att.absent, 'r', 'Absent') +
            acell(att.late, 'a', 'Late') + acell(att.excused, 'b', 'Excused')
            : acell('', 'g', 'Present') + acell('', 'r', 'Absent') +
            acell('', 'a', 'Late') + acell('', 'b', 'Excused');

        // session-by-session strip
        var strip = '';
        if (att && att.records && att.records.length) {
            att.records.forEach(function (r) {
                strip += '<div class="sc ' + r.status + '"><div class="k">S' + r.no + '</div>' +
                    '<div class="v">' + r.status + '</div>' +
                    '<div class="d">' + esc(shortDate(r.date)) + '</div></div>';
            });
        }
        var stripBlock = strip
            ? '<div class="sec">Session by session</div><div class="sec-rule"></div>' +
            '<div class="sess-strip">' + strip + '</div>'
            : '';

        // submissions
        var subRows = '';
        recent.slice(0, 8).forEach(function (r) {
            subRows += '<tr><td class="c">' + esc(shortDate(r.date)) + '</td>' +
                '<td class="c">' + esc(r.lessonCode || '') + '</td>' +
                '<td class="f">' + esc(r.fileName || r.answer || '') + '</td></tr>';
        });
        var subsBlock = subRows
            ? '<div class="sec">Recent submissions</div><div class="sec-rule"></div>' +
            '<table class="subs"><thead><tr><th style="width:26mm;">Date</th>' +
            '<th style="width:26mm;">Lesson</th><th>Work submitted</th></tr></thead><tbody>' +
            subRows + '</tbody></table>'
            : '<div class="sec">Recent submissions</div><div class="sec-rule"></div>' +
            '<div class="empty-note">No submissions recorded yet.</div>';

        var html = '<section class="sheet p">' +
            docTop('Student Progress Report', 'Report &middot; ' + esc(niceDate(today()))) +
            '<div class="ident"><div class="who">' +
            '<div class="nm">' + esc(student.name || student.email || '') + '</div>' +
            '<div class="em">' + esc(student.email || '') + '</div></div>' +
            '<div class="meta">' +
            '<div class="m"><div class="k">Student ID</div><div class="v">' + esc(student.id || '—') + '</div></div>' +
            '<div class="m"><div class="k">Level</div><div class="v">' + esc(student.level || '—') + '</div></div>' +
            '<div class="m"><div class="k">Sessions held</div><div class="v">' +
            (att ? att.sessionsHeld : '—') + '</div></div>' +
            '<div class="m"><div class="k">Submissions</div><div class="v">' +
            (student.submissions != null ? student.submissions : recent.length) + '</div></div>' +
            '</div></div>' +

            '<div class="sec">Attendance</div><div class="sec-rule"></div>' +
            '<div class="att-sum"><div class="ring-wrap">' + ring +
            '<div class="cap">Attended</div></div>' +
            '<div class="att-cells">' + cells + '</div></div>' +

            stripBlock +
            subsBlock +

            '<div class="comment" style="margin-top:4mm;">' +
            '<div class="sec" style="margin-bottom:0;">Teacher\'s comment &amp; next steps</div>' +
            '<div class="lines"><div></div><div></div><div></div></div></div>' +

            '<div class="sign">' +
            '<div class="s"><div class="rule"></div><div class="lab">Teacher signature</div></div>' +
            '<div class="s"><div class="rule"></div><div class="lab">Date</div></div>' +
            '<div class="s"><div class="rule"></div><div class="lab">Student / guardian</div></div>' +
            '</div>' +
            docFoot('01') +
            '</section>';

        openPrint('Progress Report — ' + (student.name || student.email || ''), html);
    }

    function chunk(arr, size) {
        var out = [];
        for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }

    global.FluencyAttendance = {
        load: load,
        render: render,
        printRegister: printRegister,
        printSessionLog: printSessionLog,
        printSummary: printSummary,
        printStudentReport: printStudentReport,
        isDirty: function () { return state.dirty; }
    };
})(window);
