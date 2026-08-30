/* ============================================================
   FLUENCY — LESSON SETTINGS IMPORT

   Fills the weekly lesson form (the original system) from a JSON
   file, the same way the Assignments editor does.

   The weekly lesson is spread over two tabs — Lesson Settings holds
   the code/marks/deadline/video, Site Content holds the questions,
   reading and vocabulary — so one file fills both.

   Nothing is sent to the backend here. The admin reviews the form
   and presses the existing Save buttons, so the existing save path
   and validation are untouched.
   ============================================================ */
(function (global) {
    'use strict';

    // The exact field ids the existing saveLessonToCloud() reads.
    var FIELDS = [
        { key: 'lessonCode', id: 'lessonCode', tab: 'lesson', label: 'Lesson Code' },
        { key: 'marks', id: 'marks', tab: 'lesson', label: 'Marks' },
        { key: 'deadline', id: 'deadline', tab: 'lesson', label: 'Deadline' },
        { key: 'videoUrl', id: 'videoUrl', tab: 'lesson', label: 'Video URL' },
        { key: 'questions', id: 'questions', tab: 'content', label: 'Reflection Questions' },
        { key: 'reading', id: 'reading', tab: 'content', label: 'Reading Passage' },
        { key: 'vocabulary', id: 'vocabulary', tab: 'content', label: 'Vocabulary' }
    ];

    function $(id) { return document.getElementById(id); }

    function toast(msg) {
        if (typeof global.showNotification === 'function') global.showNotification(msg);
    }

    function setError(msg) {
        var el = $('lsErrImport');
        if (el) el.textContent = msg || '';
    }

    function open() {
        var modal = $('lsImportModal');
        if (!modal) return;
        setError('');
        var box = $('lsImportText');
        if (box) { box.value = ''; }
        modal.classList.add('show');
        if (box) box.focus();
    }

    function close() {
        var modal = $('lsImportModal');
        if (modal) modal.classList.remove('show');
    }

    /**
     * Accepts watch / youtu.be / embed / shorts links and normalises to the
     * embed form this field already stores. Reuses the validated extractor
     * from lessons-view.js rather than re-implementing it.
     */
    function normaliseVideo(raw) {
        var value = String(raw == null ? '' : raw).trim();
        if (!value) return '';
        var id = '';
        if (global.FluencyLessonView && typeof global.FluencyLessonView.youTubeId === 'function') {
            id = global.FluencyLessonView.youTubeId(value);
        }
        if (!id) return null;                 // signals "not a YouTube link"
        return 'https://www.youtube.com/embed/' + id;
    }

    function applyImport() {
        var box = $('lsImportText');
        if (!box) return;
        setError('');

        var raw = String(box.value || '').trim();
        if (!raw) { setError('Paste a lesson JSON first.'); return; }

        var data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            setError('That is not valid JSON. Check for a missing comma or bracket.');
            return;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            setError('Expected a single lesson object.');
            return;
        }

        // ── validate the few fields that have rules ──
        if (data.lessonCode !== undefined && !/^\d{1,4}$/.test(String(data.lessonCode).trim())) {
            setError('lessonCode must be up to 4 digits.');
            return;
        }
        if (data.marks !== undefined && data.marks !== '') {
            var marks = Number(data.marks);
            if (!isFinite(marks) || marks < 1 || marks > 20) {
                setError('marks must be a number between 1 and 20.');
                return;
            }
        }
        if (data.deadline !== undefined && String(data.deadline).trim() &&
            !/^\d{4}-\d{2}-\d{2}$/.test(String(data.deadline).trim())) {
            setError('deadline must look like 2026-09-06 (YYYY-MM-DD).');
            return;
        }

        var video;
        if (data.videoUrl !== undefined && String(data.videoUrl).trim()) {
            video = normaliseVideo(data.videoUrl);
            if (video === null) {
                setError('videoUrl does not look like a YouTube link.');
                return;
            }
        }

        // ── fill the form ──
        var filled = [];
        FIELDS.forEach(function (f) {
            if (!(f.key in data)) return;
            var input = $(f.id);
            if (!input) return;

            var value;
            if (f.key === 'videoUrl') value = video;
            else if (f.key === 'marks') value = String(Number(data.marks));
            else value = String(data[f.key] == null ? '' : data[f.key]);

            input.value = value;
            // Some fields have their own listeners; keep them in the loop.
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            filled.push(f);
        });

        if (!filled.length) {
            setError('No known fields found. Expected: ' +
                FIELDS.map(function (f) { return f.key; }).join(', ') + '.');
            return;
        }

        close();

        var onContentTab = filled.filter(function (f) { return f.tab === 'content'; }).length;
        var msg = 'Loaded ' + filled.length + (filled.length === 1 ? ' field.' : ' fields.');
        if (onContentTab) msg += ' ' + onContentTab + ' of them are on the Site Content tab.';
        toast(msg + ' Review, then press Save.');

        if (typeof global.switchTab === 'function') global.switchTab('lesson');
        global.scrollTo(0, 0);
    }

    global.openLessonSettingsImport = open;
    global.closeLessonSettingsImport = close;
    global.applyLessonSettingsImport = applyImport;

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') close();
    });
})(window);
