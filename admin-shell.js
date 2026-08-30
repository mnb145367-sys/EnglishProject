/* ============================================================
   FLUENCY ADMIN — SHELL CONTROLLER

   Sidebar/drawer behaviour, global search, the Dashboard home and
   the Submissions view.

   Every number and row shown here is derived from the existing
   data functions (getStudents, adminGetLessons, getRecentSubmissions).
   Nothing is invented, seeded or hardcoded — when there is no data
   the UI shows an empty state instead of a placeholder value.
   ============================================================ */
(function (global) {
    'use strict';

    var shellState = {
        submissions: [],
        submissionsLoaded: false,
        submissionsLoading: false,
        subFilter: 'all',
        rangeDays: 30,
        dashboardLoaded: false
    };

    function $(id) { return document.getElementById(id); }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
        return node;
    }

    function icon(classes) {
        var i = document.createElement('i');
        i.className = classes;
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    function clearNode(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
    }

    function clean(v) {
        if (v === undefined || v === null) return '';
        var s = String(v).trim();
        return (s === 'undefined' || s === 'null' || s === 'NaN') ? '' : s;
    }

    function initials(name) {
        var parts = clean(name).split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        return parts.length === 1 ? parts[0].charAt(0) : parts[0].charAt(0) + parts[parts.length - 1].charAt(0);
    }

    // ── sidebar ───────────────────────────────────────────────────────────────

    function toggleSidebar() {
        var bar = $('ashSidebar');
        if (!bar) return;
        var open = bar.classList.toggle('open');
        var backdrop = $('ashBackdrop');
        if (backdrop) backdrop.classList.toggle('show', open);
    }

    function closeSidebar() {
        var bar = $('ashSidebar');
        if (bar) bar.classList.remove('open');
        var backdrop = $('ashBackdrop');
        if (backdrop) backdrop.classList.remove('show');
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            closeSidebar();
            hideSearchResults();
        }
    });

    // ── global search (searches data already loaded in the browser) ───────────

    function hideSearchResults() {
        var box = $('ashSearchResults');
        if (box) box.classList.remove('show');
    }

    function globalSearch(term) {
        var box = $('ashSearchResults');
        if (!box) return;
        var q = clean(term).toLowerCase();
        clearNode(box);

        if (q.length < 2) {
            box.classList.remove('show');
            return;
        }

        var results = 0;

        // Students — from the cache the Students page already loaded.
        var students = (global.studentsCache || []).filter(function (s) {
            return String(s.name || '').toLowerCase().indexOf(q) !== -1 ||
                String(s.email || '').toLowerCase().indexOf(q) !== -1;
        }).slice(0, 5);

        if (students.length) {
            box.appendChild(el('div', 'ash-result-group', 'Students'));
            students.forEach(function (s) {
                var btn = el('button', 'ash-result');
                btn.type = 'button';
                btn.appendChild(el('div', 'ash-result-title', clean(s.name) || 'Unnamed'));
                btn.appendChild(el('div', 'ash-result-sub', clean(s.email)));
                btn.addEventListener('click', function () {
                    hideSearchResults();
                    global.switchTab('students');
                    if (typeof global.openStudent === 'function') global.openStudent(s.email);
                });
                box.appendChild(btn);
                results++;
            });
        }

        // Lessons — from the Lessons CMS cache, when it has been opened.
        var lessons = [];
        try {
            lessons = (global.__ashLessons || []).filter(function (l) {
                return String(l.title || '').toLowerCase().indexOf(q) !== -1;
            }).slice(0, 5);
        } catch (e) { lessons = []; }

        if (lessons.length) {
            box.appendChild(el('div', 'ash-result-group', 'Assignments'));
            lessons.forEach(function (l) {
                var btn = el('button', 'ash-result');
                btn.type = 'button';
                btn.appendChild(el('div', 'ash-result-title', clean(l.title)));
                btn.appendChild(el('div', 'ash-result-sub',
                    'Assignment ' + l.lesson_number + ' · ' + clean(l.level)));
                btn.addEventListener('click', function () {
                    hideSearchResults();
                    global.switchTab('lessons');
                    if (typeof global.openLessonEditor === 'function') global.openLessonEditor(l.id);
                });
                box.appendChild(btn);
                results++;
            });
        }

        if (!results) {
            box.appendChild(el('div', 'ash-result-empty',
                'No matches. Open Students or Assignments first so their data is available to search.'));
        }
        box.classList.add('show');
    }

    document.addEventListener('click', function (e) {
        var search = document.querySelector('.ash-search');
        if (search && !search.contains(e.target)) hideSearchResults();
    });

    // ── API ───────────────────────────────────────────────────────────────────

    function callApi(payload) {
        if (typeof global.adminFetch !== 'function') {
            return Promise.reject(new Error('The admin connection is not ready.'));
        }
        return global.adminFetch(payload).then(function (res) {
            if (!res || typeof res !== 'object') throw new Error('Unexpected response.');
            if (!res.success) throw new Error(res.error || 'Request failed.');
            return res;
        });
    }

    // ── dashboard ─────────────────────────────────────────────────────────────

    function loadDashboard(force) {
        if (shellState.dashboardLoaded && !force) return;
        if (!global.ADMIN_TOKEN_PRESENT && typeof global.adminFetch !== 'function') return;

        setGreeting();
        renderKpiSkeletons();

        // Students and lessons are needed for the KPI row; submissions drive the
        // chart, the activity feed and the recent table.
        var studentsP = callApi({ action: 'getStudents' })
            .then(function (r) { return r.students || []; })
            .catch(function () { return null; });

        var lessonsP = callApi({ action: 'adminGetLessons' })
            .then(function (r) { global.__ashLessons = r.data || []; return r.data || []; })
            .catch(function () { return null; });

        var subsP = callApi({ action: 'getRecentSubmissions', limit: 200 })
            .then(function (r) { return r.submissions || []; })
            .catch(function () { return null; });

        Promise.all([studentsP, lessonsP, subsP]).then(function (parts) {
            var students = parts[0], lessons = parts[1], subs = parts[2];
            shellState.dashboardLoaded = true;

            if (students) {
                global.studentsCache = students;      // shared with the Students page
            }
            if (subs) {
                shellState.submissions = subs;
                shellState.submissionsLoaded = true;
            }

            renderKpis(students, lessons, subs);
            renderChart(subs);
            renderActivity(subs, students);
            renderRecentTable(subs);
        });
    }

    function setGreeting() {
        var node = $('ashGreeting');
        if (!node) return;
        var h = new Date().getHours();
        var part = h < 12 ? 'Good morning' : (h < 18 ? 'Good afternoon' : 'Good evening');
        node.textContent = part + ', Administrator';
    }

    function renderKpiSkeletons() {
        var wrap = $('ashKpis');
        if (!wrap) return;
        clearNode(wrap);
        for (var i = 0; i < 4; i++) {
            var card = el('div', 'ash-kpi');
            card.appendChild(el('div', 'ash-skel'));
            var big = el('div', 'ash-skel');
            big.style.height = '1.7rem';
            big.style.width = '55%';
            card.appendChild(big);
            wrap.appendChild(card);
        }
    }

    function kpiCard(label, value, iconClass, sub) {
        var card = el('div', 'ash-kpi');
        var head = el('div', 'ash-kpi-head');
        head.appendChild(el('span', 'ash-kpi-label', label));
        var badge = el('span', 'ash-kpi-icon');
        badge.appendChild(icon(iconClass));
        head.appendChild(badge);
        card.appendChild(head);
        card.appendChild(el('div', 'ash-kpi-value', value));
        if (sub) card.appendChild(el('div', 'ash-kpi-sub', sub));
        return card;
    }

    function renderKpis(students, lessons, subs) {
        var wrap = $('ashKpis');
        if (!wrap) return;
        clearNode(wrap);

        // A metric is only rendered when its source actually loaded.
        if (students) {
            var active = students.filter(function (s) { return s.status === 'Active'; }).length;
            wrap.appendChild(kpiCard('Students', String(students.length), 'fa-regular fa-user'));
            wrap.appendChild(kpiCard('Active Students', String(active), 'fa-solid fa-bolt',
                students.length ? Math.round((active / students.length) * 100) + '% of all students' : ''));
        } else {
            wrap.appendChild(kpiCard('Students', '—', 'fa-regular fa-user', 'Unavailable'));
            wrap.appendChild(kpiCard('Active Students', '—', 'fa-solid fa-bolt', 'Unavailable'));
        }

        if (subs) {
            var last30 = countInRange(subs, 30);
            wrap.appendChild(kpiCard('Submissions', String(subs.length), 'fa-regular fa-file-lines',
                last30 + ' in the last 30 days'));
        } else {
            wrap.appendChild(kpiCard('Submissions', '—', 'fa-regular fa-file-lines', 'Unavailable'));
        }

        if (lessons) {
            var published = lessons.filter(function (l) { return l.status === 'published'; }).length;
            wrap.appendChild(kpiCard('Assignments', String(lessons.length), 'fa-regular fa-rectangle-list',
                published + ' published'));
        } else {
            wrap.appendChild(kpiCard('Assignments', '—', 'fa-regular fa-rectangle-list', 'Unavailable'));
        }
    }

    function countInRange(subs, days) {
        var cutoff = Date.now() - days * 86400000;
        return subs.filter(function (s) {
            var t = new Date(s.date).getTime();
            return !isNaN(t) && t >= cutoff;
        }).length;
    }

    // ── chart (plain divs — no charting library) ──────────────────────────────

    function setRange(days) {
        shellState.rangeDays = days;
        var seg = $('ashRangeSeg');
        if (seg) {
            var btns = seg.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
                btns[i].classList.toggle('active', btns[i].textContent.indexOf(String(days)) === 0);
            }
        }
        renderChart(shellState.submissionsLoaded ? shellState.submissions : null);
    }

    function renderChart(subs) {
        var host = $('ashChart');
        if (!host) return;
        clearNode(host);

        if (!subs) {
            host.appendChild(emptyState('fa-regular fa-chart-bar', 'Activity unavailable',
                'Submission data could not be loaded.'));
            return;
        }
        if (!subs.length) {
            host.appendChild(emptyState('fa-regular fa-chart-bar', 'No submissions yet',
                'Activity will appear here once students start submitting.'));
            return;
        }

        var days = shellState.rangeDays;
        // Group into buckets: daily for 7 days, weekly beyond that.
        var buckets = days <= 7 ? 7 : (days <= 30 ? 10 : 12);
        var msPerBucket = (days * 86400000) / buckets;
        var now = Date.now();
        var counts = new Array(buckets).fill(0);

        subs.forEach(function (s) {
            var t = new Date(s.date).getTime();
            if (isNaN(t)) return;
            var age = now - t;
            if (age < 0 || age > days * 86400000) return;
            var idx = buckets - 1 - Math.floor(age / msPerBucket);
            if (idx >= 0 && idx < buckets) counts[idx]++;
        });

        var max = Math.max.apply(null, counts);
        if (max === 0) {
            host.appendChild(emptyState('fa-regular fa-chart-bar', 'No submissions in this period',
                'Try a longer range.'));
            return;
        }

        var chart = el('div', 'ash-chart');
        counts.forEach(function (count, i) {
            var col = el('div', 'ash-bar-col');
            var bar = el('div', 'ash-bar');
            bar.style.height = Math.max(3, Math.round((count / max) * 100)) + '%';
            var when = new Date(now - (buckets - 1 - i) * msPerBucket);
            bar.title = count + (count === 1 ? ' submission' : ' submissions') +
                ' · around ' + when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            col.appendChild(bar);
            col.appendChild(el('div', 'ash-bar-label',
                when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })));
            chart.appendChild(col);
        });
        host.appendChild(chart);

        var total = counts.reduce(function (a, b) { return a + b; }, 0);
        var note = el('p', null, total + (total === 1 ? ' submission' : ' submissions') +
            ' in the last ' + days + ' days');
        note.style.cssText = 'font-size:.82rem;color:#5f7d9c;margin:.9rem 0 0;';
        host.appendChild(note);
    }

    function emptyState(iconClass, title, message) {
        var box = el('div', 'ash-state');
        box.appendChild(icon(iconClass));
        box.appendChild(el('h4', null, title));
        box.appendChild(el('p', null, message));
        return box;
    }

    // ── activity feed ─────────────────────────────────────────────────────────

    function renderActivity(subs) {
        var host = $('ashActivity');
        if (!host) return;
        clearNode(host);

        if (!subs) {
            host.appendChild(emptyState('fa-regular fa-bell', 'Activity unavailable',
                'Could not load recent activity.'));
            return;
        }
        if (!subs.length) {
            host.appendChild(emptyState('fa-regular fa-bell', 'No activity yet',
                'Student submissions will appear here.'));
            return;
        }

        var list = el('ul', 'ash-activity');
        subs.slice(0, 8).forEach(function (s) {
            var li = el('li');
            li.appendChild(el('div', 'ash-act-avatar', initials(s.name)));

            var body = el('div', 'ash-act-body');
            var text = el('div', 'ash-act-text');
            text.appendChild(el('strong', null, clean(s.name) || 'Anonymous'));
            var lesson = clean(s.lessonCode);
            text.appendChild(document.createTextNode(
                lesson && lesson !== 'N/A' ? ' submitted ' + lesson : ' made a submission'));
            body.appendChild(text);
            body.appendChild(el('div', 'ash-act-time', relative(s.date)));
            li.appendChild(body);
            list.appendChild(li);
        });
        host.appendChild(list);
    }

    /** Mirrors the dashboard's existing relative-date wording. */
    function relative(iso) {
        var raw = clean(iso);
        if (!raw) return 'Unknown time';
        var t = new Date(raw).getTime();
        if (isNaN(t)) return 'Unknown time';
        var mins = Math.floor((Date.now() - t) / 60000);
        if (mins < 1) return 'Just now';
        if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
        var hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
        var days = Math.floor(hrs / 24);
        if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
        return new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function feedbackBadge(status) {
        if (status === 'reviewed') return el('span', 'ash-badge ash-ok', 'Reviewed');
        if (status === 'pending') return el('span', 'ash-badge ash-warn', 'Pending');
        return el('span', 'ash-badge ash-muted', 'No feedback');
    }

    // ── recent submissions table (dashboard) ──────────────────────────────────

    function renderRecentTable(subs) {
        var host = $('ashRecentTable');
        if (!host) return;
        clearNode(host);

        if (!subs || !subs.length) {
            host.appendChild(emptyState('fa-regular fa-file-lines', 'No submissions yet',
                'Recent student work will be listed here.'));
            return;
        }
        // Compact variant: the dashboard panel is too narrow for every column.
        host.appendChild(buildSubmissionTable(subs.slice(0, 6), true));
    }

    /** Shared table builder for the dashboard and the Submissions page. */
    function buildSubmissionTable(rows, compact) {
        var wrap = el('div', 'sm-table-wrap');
        wrap.style.border = 'none';
        wrap.style.borderRadius = '0';
        var table = el('table', 'sm-table');

        var thead = el('thead');
        var hr = el('tr');
        var headers = compact
            ? ['Student', 'Lesson', 'Submitted', 'Feedback', '']
            : ['Student', 'Lesson', 'Level', 'Submitted', 'Feedback', ''];
        headers.forEach(function (h) { hr.appendChild(el('th', null, h)); });
        thead.appendChild(hr);
        table.appendChild(thead);

        var tbody = el('tbody');
        rows.forEach(function (s) {
            var tr = el('tr');

            var who = el('td');
            who.setAttribute('data-label', 'Student');
            who.appendChild(el('div', 'sm-name', clean(s.name) || 'Anonymous'));
            who.appendChild(el('div', 'sm-email', clean(s.email)));
            tr.appendChild(who);

            var lesson = clean(s.lessonCode);
            tr.appendChild(cell('Lesson', lesson && lesson !== 'N/A' ? lesson : '—'));

            if (!compact) {
                var levelCell = el('td');
                levelCell.setAttribute('data-label', 'Level');
                levelCell.appendChild(clean(s.level)
                    ? el('span', 'ash-badge', s.level)
                    : el('span', 'ash-badge ash-muted', 'Unassigned'));
                tr.appendChild(levelCell);
            }

            tr.appendChild(cell('Submitted', relative(s.date)));

            var fb = el('td');
            fb.setAttribute('data-label', 'Feedback');
            fb.appendChild(feedbackBadge(s.feedbackStatus));
            tr.appendChild(fb);

            var action = el('td', 'sm-td-action');
            action.setAttribute('data-label', 'Action');
            var btn = el('button', 'sm-row-btn');
            btn.type = 'button';
            btn.appendChild(icon('fa-regular fa-eye'));
            btn.appendChild(document.createTextNode(' Open'));
            btn.setAttribute('aria-label', 'Open record for ' + clean(s.name));
            btn.addEventListener('click', function () {
                // Reuses the existing student record, which owns the full detail.
                global.switchTab('students');
                if (typeof global.openStudent === 'function') global.openStudent(s.email);
            });
            action.appendChild(btn);
            tr.appendChild(action);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    }

    function cell(label, text) {
        var td = el('td', null, text);
        td.setAttribute('data-label', label);
        return td;
    }

    // ── submissions page ──────────────────────────────────────────────────────

    function loadSubmissions(force) {
        if (shellState.submissionsLoading) return;
        if (shellState.submissionsLoaded && !force) { renderSubmissions(); return; }

        var host = $('subTableWrap');
        if (!host) return;
        shellState.submissionsLoading = true;

        clearNode(host);
        var loading = el('div', 'ash-state');
        loading.appendChild(el('p', null, 'Loading submissions...'));
        host.appendChild(loading);

        callApi({ action: 'getRecentSubmissions', limit: 200 })
            .then(function (res) {
                shellState.submissions = res.submissions || [];
                shellState.submissionsLoaded = true;
                renderSubmissions();
                if (force && typeof global.showNotification === 'function') {
                    global.showNotification('Submissions refreshed');
                }
            })
            .catch(function (err) {
                clearNode(host);
                var box = emptyState('fa-regular fa-circle-exclamation', 'Unable to load submissions',
                    (err && err.message) || 'Please try again.');
                var retry = el('button', 'btn btn-primary');
                retry.type = 'button';
                retry.textContent = 'Retry';
                retry.style.marginTop = '1rem';
                retry.addEventListener('click', function () { loadSubmissions(true); });
                box.appendChild(retry);
                host.appendChild(box);
            })
            .then(function () { shellState.submissionsLoading = false; });
    }

    function setSubFilter(value) {
        shellState.subFilter = value;
        var group = $('subStatusFilters');
        if (group) {
            var chips = group.querySelectorAll('.sm-chip');
            var labels = { all: 'All', reviewed: 'Reviewed', pending: 'Pending', none: 'No feedback' };
            for (var i = 0; i < chips.length; i++) {
                chips[i].classList.toggle('active', chips[i].textContent.trim() === labels[value]);
            }
        }
        renderSubmissions();
    }

    function renderSubmissions() {
        var host = $('subTableWrap');
        if (!host) return;

        var q = clean($('subSearch') ? $('subSearch').value : '').toLowerCase();
        var rows = shellState.submissions.filter(function (s) {
            if (shellState.subFilter !== 'all' && s.feedbackStatus !== shellState.subFilter) return false;
            if (!q) return true;
            return [s.name, s.email, s.lessonCode].some(function (v) {
                return String(v || '').toLowerCase().indexOf(q) !== -1;
            });
        });

        var count = $('subCount');
        if (count) {
            count.textContent = !shellState.submissions.length ? '' :
                rows.length + ' of ' + shellState.submissions.length +
                (shellState.submissions.length === 1 ? ' submission' : ' submissions');
        }

        clearNode(host);
        if (!shellState.submissions.length) {
            host.appendChild(emptyState('fa-regular fa-file-lines', 'No submissions available',
                'Student submissions will appear here once they are made.'));
            return;
        }
        if (!rows.length) {
            host.appendChild(emptyState('fa-regular fa-magnifying-glass', 'No matching submissions',
                'Try a different search term or filter.'));
            return;
        }
        host.appendChild(buildSubmissionTable(rows));
    }

    // ── exports for the inline handlers in admin.html ────────────────────────

    global.ashToggleSidebar = toggleSidebar;
    global.ashCloseSidebar = closeSidebar;
    global.ashGlobalSearch = globalSearch;
    global.ashSetRange = setRange;
    global.loadDashboard = loadDashboard;
    global.loadSubmissions = loadSubmissions;
    global.renderSubmissions = renderSubmissions;
    global.setSubFilter = setSubFilter;
})(window);
