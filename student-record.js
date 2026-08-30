/* ============================================================
   FLUENCY — ADMIN STUDENT RECORD

   Renders the full submission record inside the existing student
   modal in admin.html. Data comes from the existing
   `getStudentDetails` Apps Script action — this file adds no new
   endpoint and no second student system.

   All student-authored text (answers) and AI feedback is inserted
   with textContent, never innerHTML, so nothing in the spreadsheet
   can execute as markup in the admin's browser.
   ============================================================ */
(function (global) {
    'use strict';

    var LEVELS = ['', 'A1', 'A2', 'B1', 'B2', 'C1'];

    // The backend writes these literals when the student left the field empty.
    var PLACEHOLDER_ANSWER = 'No question';
    var PLACEHOLDER_LESSON = 'N/A';
    var PENDING_FEEDBACK = 'PENDING';

    var state = {
        student: null,
        submissions: [],
        activeIndex: 0,
        opts: {}
    };

    // ── DOM helpers ───────────────────────────────────────────────────────────

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

    /** Spreadsheet cells arrive as '', null, undefined or the string 'undefined'. */
    function clean(value) {
        if (value === undefined || value === null) return '';
        var s = String(value).trim();
        if (s === 'undefined' || s === 'null' || s === 'NaN' || s === '[object Object]') return '';
        return s;
    }

    function section(title, iconClass) {
        var wrap = el('div', 'sr-section');
        var head = el('div', 'sr-section-head');
        if (iconClass) head.appendChild(icon(iconClass));
        head.appendChild(el('span', null, title));
        wrap.appendChild(head);
        return wrap;
    }

    function emptyNote(text) {
        return el('p', 'sr-empty', text);
    }

    // ── formatting ────────────────────────────────────────────────────────────

    /**
     * "August 29, 2026 — 7:42 PM" in the admin's own locale/timezone, matching
     * how the existing dashboard already renders stored ISO timestamps.
     */
    function formatDateTime(iso) {
        var raw = clean(iso);
        if (!raw) return '';
        var d = new Date(raw);
        if (isNaN(d.getTime())) return '';
        try {
            // en-US matches the English admin UI; the timezone stays the admin's
            // own local zone, which is what the dashboard already uses elsewhere.
            return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) +
                ' — ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        } catch (e) {
            return d.toISOString();
        }
    }

    function formatDateShort(iso) {
        var raw = clean(iso);
        if (!raw) return 'Not available';
        var d = new Date(raw);
        if (isNaN(d.getTime())) return 'Not available';
        try {
            return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch (e) {
            return raw;
        }
    }

    function initials(name) {
        var parts = clean(name).split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        if (parts.length === 1) return parts[0].charAt(0);
        return parts[0].charAt(0) + parts[parts.length - 1].charAt(0);
    }

    // ── Google Drive links ────────────────────────────────────────────────────

    /** Falls back to parsing the stored URL when no explicit file id was saved. */
    function driveId(fileId, url) {
        var id = clean(fileId);
        if (id) return id;
        var raw = clean(url);
        if (!raw) return '';
        var patterns = [/\/file\/d\/([A-Za-z0-9_-]{10,})/, /[?&]id=([A-Za-z0-9_-]{10,})/, /\/d\/([A-Za-z0-9_-]{10,})/];
        for (var i = 0; i < patterns.length; i++) {
            var m = raw.match(patterns[i]);
            if (m) return m[1];
        }
        return '';
    }

    /** Drive's stored URL is a viewer page; this is the embeddable form. */
    function driveImageSrc(id) {
        return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w1600';
    }

    function driveMediaSrc(id) {
        return 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id);
    }

    /** Only http(s) links are ever placed in an href. */
    function safeHref(url) {
        var raw = clean(url);
        return /^https?:\/\//i.test(raw) ? raw : '';
    }

    function externalLink(href, label, iconClass) {
        var a = el('a', 'sr-link');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.appendChild(icon(iconClass || 'fa-solid fa-arrow-up-right-from-square'));
        a.appendChild(document.createTextNode(' ' + label));
        return a;
    }

    // ── loading / error states ────────────────────────────────────────────────

    function showLoading(container) {
        clearNode(container);
        var box = el('div', 'sr-loading');
        box.appendChild(el('span', 'sr-spinner'));
        box.appendChild(el('span', null, 'Loading student record...'));
        container.appendChild(box);
    }

    function showError(container, message, onRetry) {
        clearNode(container);
        var box = el('div', 'sr-error');
        box.appendChild(icon('fa-regular fa-circle-exclamation'));
        box.appendChild(el('h4', null, 'Unable to load this student record'));
        box.appendChild(el('p', null, message || 'Please try again.'));
        if (typeof onRetry === 'function') {
            var btn = el('button', 'btn btn-primary');
            btn.type = 'button';
            btn.appendChild(icon('fa-regular fa-arrows-rotate'));
            btn.appendChild(document.createTextNode(' Retry'));
            btn.addEventListener('click', onRetry);
            box.appendChild(btn);
        }
        container.appendChild(box);
    }

    // ── header ────────────────────────────────────────────────────────────────

    function buildIdentity(student) {
        var wrap = el('div', 'sr-identity');
        wrap.appendChild(el('div', 'sr-avatar', initials(student.name)));

        var text = el('div', 'sr-identity-text');
        text.appendChild(el('div', 'sr-name', clean(student.name) || 'Unnamed student'));

        var emailRow = el('div', 'sr-email-row');
        var email = clean(student.email);
        emailRow.appendChild(el('span', 'sr-email', email || 'Not available'));
        if (email) emailRow.appendChild(copyButton(email, 'Copy Email'));
        text.appendChild(emailRow);

        wrap.appendChild(text);
        return wrap;
    }

    /** Clipboard with a graceful fallback when the API is blocked. */
    function copyButton(value, label) {
        var btn = el('button', 'sr-copy-btn');
        btn.type = 'button';
        btn.setAttribute('aria-label', label + ': ' + value);
        setCopyLabel(btn, label, false);

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var done = function () {
                setCopyLabel(btn, 'Copied', true);
                btn.classList.add('sr-copied');
                global.setTimeout(function () {
                    setCopyLabel(btn, label, false);
                    btn.classList.remove('sr-copied');
                }, 1600);
            };
            var failed = function () {
                setCopyLabel(btn, 'Press Ctrl+C', false);
                global.setTimeout(function () { setCopyLabel(btn, label, false); }, 2200);
            };
            if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
                global.navigator.clipboard.writeText(value).then(done, failed);
            } else {
                failed();
            }
        });
        return btn;
    }

    function setCopyLabel(btn, label, isDone) {
        clearNode(btn);
        btn.appendChild(icon(isDone ? 'fa-solid fa-check' : 'fa-regular fa-copy'));
        btn.appendChild(document.createTextNode(' ' + label));
    }

    function buildCard(key, valueNode) {
        var card = el('div', 'sr-card');
        card.appendChild(el('div', 'sr-card-key', key));
        card.appendChild(valueNode);
        return card;
    }

    function valueNode(text) {
        var v = clean(text);
        return v ? el('div', 'sr-card-val', v) : el('div', 'sr-card-val sr-muted', 'Not available');
    }

    /** The level selector is the existing admin control, kept working as-is. */
    function buildLevelCard(student, onLevelChange) {
        var card = el('div', 'sr-card');
        var label = el('label', 'sr-card-key', 'Level');
        label.setAttribute('for', 'studentLevelSelect');
        card.appendChild(label);

        var select = document.createElement('select');
        select.id = 'studentLevelSelect';
        select.className = 'al-select';
        select.style.padding = '0.35rem 0.6rem';
        select.style.fontSize = '0.9rem';
        LEVELS.forEach(function (lv) {
            var opt = document.createElement('option');
            opt.value = lv;
            opt.textContent = lv || 'Unassigned';
            if (clean(student.level) === lv) opt.selected = true;
            select.appendChild(opt);
        });
        select.addEventListener('change', function () {
            if (typeof onLevelChange === 'function') onLevelChange(student.email, select.value);
        });
        card.appendChild(select);
        return card;
    }

    // ── submission panes ──────────────────────────────────────────────────────

    function buildSubmissionDetails(sub) {
        var wrap = section('Submission Details', 'fa-regular fa-file-lines');
        var cards = el('div', 'sr-cards');

        var when = formatDateTime(sub.date);
        cards.appendChild(buildCard('Submitted', when
            ? el('div', 'sr-card-val', when)
            : el('div', 'sr-card-val sr-muted', 'Not available')));

        var lesson = clean(sub.lessonCode);
        if (lesson === PLACEHOLDER_LESSON) lesson = '';
        if (lesson) {
            var lessonVal = el('div', 'sr-card-val');
            lessonVal.appendChild(document.createTextNode(lesson));
            lessonVal.appendChild(document.createTextNode(' '));
            lessonVal.appendChild(copyButton(lesson, 'Copy'));
            cards.appendChild(buildCard('Lesson Code', lessonVal));
        } else {
            cards.appendChild(buildCard('Lesson Code', el('div', 'sr-card-val sr-muted', 'Not available')));
        }

        cards.appendChild(buildCard('File Name', valueNode(sub.fileName)));

        wrap.appendChild(cards);
        return wrap;
    }

    function buildAnswer(sub) {
        var wrap = section('Student Answer', 'fa-regular fa-pen-to-square');
        var answer = clean(sub.answer);
        if (!answer || answer === PLACEHOLDER_ANSWER) {
            wrap.appendChild(emptyNote('No answer submitted.'));
            return wrap;
        }
        // textContent + CSS white-space:pre-wrap keeps the student's line breaks
        // without letting any markup in their answer render.
        wrap.appendChild(el('div', 'sr-prose', answer));
        return wrap;
    }

    function buildImage(sub) {
        var wrap = section('Uploaded Image', 'fa-regular fa-image');
        var id = driveId(sub.imageFileId, sub.imageUrl);
        var original = safeHref(sub.imageUrl);

        if (!id && !original) {
            wrap.appendChild(emptyNote('No image submitted.'));
            return wrap;
        }

        if (!id) {
            // A stored link we cannot turn into an embeddable source.
            wrap.appendChild(emptyNote('Image preview unavailable.'));
            wrap.appendChild(externalLink(original, 'Open image in Google Drive'));
            return wrap;
        }

        var frame = el('div', 'sr-image-wrap');
        var img = el('img', 'sr-image');
        img.src = driveImageSrc(id);
        img.alt = 'Submission image from ' + (clean(state.student && state.student.name) || 'the student');
        img.loading = 'lazy';
        img.tabIndex = 0;
        img.setAttribute('role', 'button');
        img.setAttribute('aria-label', 'Enlarge submission image');

        img.addEventListener('click', function () { openLightbox(img.src, img.alt); });
        img.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openLightbox(img.src, img.alt);
            }
        });
        // A dead Drive link must not leave a broken-image icon behind.
        img.addEventListener('error', function () {
            frame.replaceWith(emptyNote('Image unavailable.'));
        });

        frame.appendChild(img);
        wrap.appendChild(frame);

        var actions = el('div', 'sr-media-actions');
        if (original) actions.appendChild(externalLink(original, 'Open in Google Drive'));
        if (actions.childNodes.length) wrap.appendChild(actions);
        return wrap;
    }

    function buildAudio(sub) {
        var wrap = section('Audio Recording', 'fa-solid fa-microphone-lines');
        var id = driveId(sub.audioFileId, sub.audioUrl);
        var original = safeHref(sub.audioUrl);

        if (!id && !original) {
            wrap.appendChild(emptyNote('No audio recording submitted.'));
            return wrap;
        }

        if (id) {
            var audio = document.createElement('audio');
            audio.className = 'sr-audio';
            audio.controls = true;
            audio.preload = 'none';           // never preload media for the list
            audio.src = driveMediaSrc(id);
            audio.setAttribute('aria-label', 'Student audio recording');
            audio.addEventListener('error', function () {
                var note = emptyNote('Audio unavailable — it may not be playable directly from Drive.');
                audio.replaceWith(note);
            });
            wrap.appendChild(audio);
        } else {
            wrap.appendChild(emptyNote('Audio preview unavailable.'));
        }

        if (original) {
            var actions = el('div', 'sr-media-actions');
            actions.appendChild(externalLink(original, 'Open audio in Google Drive', 'fa-solid fa-headphones'));
            wrap.appendChild(actions);
        }
        return wrap;
    }

    function buildFeedback(sub) {
        var wrap = section('AI Feedback', 'fa-solid fa-wand-magic-sparkles');
        var feedback = clean(sub.aiFeedback);

        if (!feedback) {
            wrap.appendChild(emptyNote('No AI feedback available.'));
            return wrap;
        }
        if (feedback.toUpperCase() === PENDING_FEEDBACK) {
            wrap.appendChild(el('div', 'sr-prose sr-pending',
                'Feedback is still being generated. It usually appears within a few minutes of submission.'));
            return wrap;
        }
        wrap.appendChild(el('div', 'sr-prose sr-feedback', feedback));
        return wrap;
    }

    // ── history ───────────────────────────────────────────────────────────────

    function buildHistory() {
        var wrap = section('Submission History', 'fa-regular fa-clock-rotate-left');
        if (state.submissions.length < 2) return null;   // nothing to switch between

        var tableWrap = el('div', 'sm-table-wrap');
        var table = el('table', 'sm-table');

        var thead = el('thead');
        var headRow = el('tr');
        ['Date', 'Lesson', 'Attachments', ''].forEach(function (h) {
            headRow.appendChild(el('th', null, h));
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        state.submissions.forEach(function (sub, index) {
            var tr = el('tr', index === state.activeIndex ? 'sr-history-row sr-active' : 'sr-history-row');

            var dateCell = el('td', null, formatDateShort(sub.date));
            dateCell.setAttribute('data-label', 'Date');
            tr.appendChild(dateCell);

            var lesson = clean(sub.lessonCode);
            if (lesson === PLACEHOLDER_LESSON) lesson = '';
            var lessonCell = el('td', null, lesson || '—');
            lessonCell.setAttribute('data-label', 'Lesson');
            tr.appendChild(lessonCell);

            var attach = el('td');
            attach.setAttribute('data-label', 'Attachments');
            if (driveId(sub.imageFileId, sub.imageUrl)) {
                var i1 = icon('fa-regular fa-image');
                i1.style.marginRight = '0.5rem';
                i1.setAttribute('title', 'Has image');
                attach.appendChild(i1);
            }
            if (driveId(sub.audioFileId, sub.audioUrl)) {
                var i2 = icon('fa-solid fa-microphone-lines');
                i2.setAttribute('title', 'Has audio');
                attach.appendChild(i2);
            }
            if (!attach.childNodes.length) attach.appendChild(document.createTextNode('—'));
            tr.appendChild(attach);

            var actionCell = el('td', 'sm-td-action');
            actionCell.setAttribute('data-label', 'Action');
            var btn = el('button', 'sm-row-btn');
            btn.type = 'button';
            btn.textContent = index === state.activeIndex ? 'Viewing' : 'View';
            btn.disabled = index === state.activeIndex;
            btn.setAttribute('aria-label', 'View submission from ' + formatDateShort(sub.date));
            btn.addEventListener('click', function () { selectSubmission(index); });
            actionCell.appendChild(btn);
            tr.appendChild(actionCell);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        wrap.appendChild(tableWrap);
        return wrap;
    }

    function selectSubmission(index) {
        if (index < 0 || index >= state.submissions.length) return;
        state.activeIndex = index;
        // Re-render so every pane (answer, image, audio, feedback) belongs to
        // the selected submission — panes are never updated piecemeal.
        render(state.container, state.student, state.submissions, state.opts, index);
        var body = state.container;
        if (body && typeof body.scrollTo === 'function') body.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ── lightbox ──────────────────────────────────────────────────────────────

    var lightbox = null;

    function ensureLightbox() {
        if (lightbox) return lightbox;
        lightbox = el('div', 'sr-lightbox');
        lightbox.setAttribute('role', 'dialog');
        lightbox.setAttribute('aria-modal', 'true');
        lightbox.setAttribute('aria-label', 'Image preview');

        var close = el('button', 'sr-lightbox-close');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close image preview');
        close.appendChild(icon('fa-solid fa-xmark'));
        close.addEventListener('click', closeLightbox);

        var img = el('img');
        img.id = 'srLightboxImg';

        lightbox.appendChild(close);
        lightbox.appendChild(img);
        lightbox.addEventListener('click', function (e) {
            if (e.target === lightbox) closeLightbox();
        });
        document.body.appendChild(lightbox);
        return lightbox;
    }

    function openLightbox(src, alt) {
        var box = ensureLightbox();
        var img = box.querySelector('#srLightboxImg');
        img.src = src;
        img.alt = alt || 'Submission image';
        box.classList.add('show');
        var close = box.querySelector('.sr-lightbox-close');
        if (close) close.focus();
    }

    function closeLightbox() {
        if (lightbox) lightbox.classList.remove('show');
    }

    function isLightboxOpen() {
        return !!(lightbox && lightbox.classList.contains('show'));
    }

    // Escape closes the preview first, so it does not also close the record.
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && isLightboxOpen()) {
            e.stopImmediatePropagation();
            closeLightbox();
        }
    }, true);

    // ── main render ───────────────────────────────────────────────────────────

    /**
     * @param container  the modal body element
     * @param student    summary record (name, email, level, status, ...)
     * @param submissions  full submission rows, newest first
     * @param opts       { onLevelChange(email, level) }
     */
    function render(container, student, submissions, opts, activeIndex) {
        state.container = container;
        state.student = student || {};
        state.submissions = Array.isArray(submissions) ? submissions : [];
        state.opts = opts || {};
        state.activeIndex = activeIndex || 0;

        clearNode(container);

        container.appendChild(buildIdentity(state.student));

        // Student-level metadata
        var cards = el('div', 'sr-cards');
        cards.appendChild(buildLevelCard(state.student, state.opts.onLevelChange));
        cards.appendChild(buildCard('Status', valueNode(state.student.status)));
        cards.appendChild(buildCard('Total Submissions',
            el('div', 'sr-card-val', String(state.student.submissions === undefined
                ? state.submissions.length : state.student.submissions))));
        cards.appendChild(buildCard('Last Activity',
            el('div', 'sr-card-val', formatDateShort(state.student.lastActivity))));
        container.appendChild(cards);

        if (!state.submissions.length) {
            var none = section('Submissions', 'fa-regular fa-folder-open');
            none.appendChild(emptyNote('No submissions available.'));
            container.appendChild(none);
            return;
        }

        var sub = state.submissions[state.activeIndex] || state.submissions[0];

        if (state.submissions.length > 1) {
            var note = el('p', 'sr-viewing-note');
            note.appendChild(document.createTextNode('Viewing submission ' +
                (state.activeIndex + 1) + ' of ' + state.submissions.length + ' — ' +
                (formatDateTime(sub.date) || 'date not available')));
            container.appendChild(note);
        }

        // Each pane is built independently so one missing field never prevents
        // the rest of the record from rendering.
        container.appendChild(buildSubmissionDetails(sub));
        container.appendChild(buildAnswer(sub));
        container.appendChild(buildImage(sub));
        container.appendChild(buildAudio(sub));
        container.appendChild(buildFeedback(sub));

        var history = buildHistory();
        if (history) container.appendChild(history);
    }

    global.FluencyStudentRecord = {
        render: render,
        showLoading: showLoading,
        showError: showError,
        closeLightbox: closeLightbox,
        isLightboxOpen: isLightboxOpen
    };
})(window);
