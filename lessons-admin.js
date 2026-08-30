/* ============================================================
   FLUENCY — ADMIN LESSONS CONTROLLER

   Drives the Lessons tab in admin.html. Reuses the dashboard's
   existing adminFetch / showNotification / showError helpers and the
   ADMIN_TOKEN held by the login flow, so there is no second auth
   system here. Authorisation is enforced server-side regardless.

   Preview delegates to FluencyLessonView — the same renderer the
   student site uses — so it cannot drift from the real thing.
   ============================================================ */
(function (global) {
    'use strict';

    var LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
    var BLOCK_LABELS = {
        heading: 'Heading',
        text: 'Text',
        note: 'Note',
        quote: 'Quote',
        image: 'Image',
        divider: 'Divider'
    };

    var lessonsAdminState = {
        list: [],
        loaded: false,
        loading: false,
        statusFilter: 'all',
        levelFilter: 'all',
        editingId: null,
        editingRecord: null,
        busy: false,
        reorderDraft: [],
        dragIndex: null
    };

    // Working copies of the repeater data while the editor is open.
    var editorLists = {
        objectives: [],
        blocks: [],
        vocabulary: [],
        examples: [],
        exercises: [],
        resources: []
    };

    function V() { return global.FluencyLessonView; }
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

    // ══════════════════════════════════════════════════════════════════════
    // LIST
    // ══════════════════════════════════════════════════════════════════════

    function loadAdminLessons(force) {
        if (lessonsAdminState.loading) return;
        if (lessonsAdminState.loaded && !force) {
            renderAdminLessons();
            return;
        }
        var wrap = $('alTableWrap');
        if (!wrap) return;

        lessonsAdminState.loading = true;
        showLoading(wrap, 'Loading lessons...');

        callApi({ action: 'adminGetLessons' })
            .then(function (res) {
                lessonsAdminState.list = Array.isArray(res.data) ? res.data : [];
                lessonsAdminState.loaded = true;
                renderAdminLessons();
            })
            .catch(function (err) {
                renderListState(wrap, 'fa-solid fa-triangle-exclamation', 'Could not load lessons',
                    err.message || 'Please try again.', 'Try Again', function () { loadAdminLessons(true); });
            })
            .then(function () { lessonsAdminState.loading = false; });
    }

    function showLoading(container, message) {
        var view = V();
        view.clearNode(container);
        var box = view.el('div', 'al-loading');
        box.appendChild(view.el('span', 'al-spinner'));
        box.appendChild(view.el('span', null, message));
        container.appendChild(box);
    }

    function renderListState(container, iconClass, title, message, actionLabel, onAction) {
        var view = V();
        view.clearNode(container);
        var box = view.el('div', 'al-state');
        box.appendChild(view.icon(iconClass));
        box.appendChild(view.el('h4', null, title));
        box.appendChild(view.el('p', null, message));
        if (actionLabel) {
            var btn = view.el('button', 'btn btn-primary');
            btn.type = 'button';
            btn.appendChild(view.icon('fa-solid fa-plus'));
            btn.appendChild(document.createTextNode(' ' + actionLabel));
            btn.addEventListener('click', onAction);
            box.appendChild(btn);
        }
        container.appendChild(box);
    }

    function filteredLessons() {
        var term = ($('alSearch') ? $('alSearch').value : '').trim().toLowerCase();
        return lessonsAdminState.list.filter(function (l) {
            if (lessonsAdminState.statusFilter !== 'all' && l.status !== lessonsAdminState.statusFilter) return false;
            if (lessonsAdminState.levelFilter !== 'all' && l.level !== lessonsAdminState.levelFilter) return false;
            if (!term) return true;
            // Search covers lesson number, title and level.
            return String(l.lesson_number).indexOf(term) !== -1 ||
                String(l.title || '').toLowerCase().indexOf(term) !== -1 ||
                String(l.level || '').toLowerCase().indexOf(term) !== -1;
        });
    }

    function renderAdminLessons() {
        var wrap = $('alTableWrap');
        var view = V();
        if (!wrap || !view) return;

        var rows = filteredLessons();
        var countEl = $('alCount');
        if (countEl) {
            countEl.textContent = lessonsAdminState.list.length === 0
                ? ''
                : rows.length + ' of ' + lessonsAdminState.list.length +
                  (lessonsAdminState.list.length === 1 ? ' lesson' : ' lessons');
        }

        if (!lessonsAdminState.list.length) {
            renderListState(wrap, 'fa-regular fa-rectangle-list', 'No lessons created yet',
                'Start building your learning library by creating your first lesson.',
                'Create First Lesson', function () { openLessonEditor(null); });
            return;
        }

        if (!rows.length) {
            renderListState(wrap, 'fa-regular fa-magnifying-glass', 'No matching lessons',
                'Try a different search term or filter.');
            return;
        }

        view.clearNode(wrap);
        var tableWrap = view.el('div', 'sm-table-wrap');
        var table = view.el('table', 'sm-table');

        var thead = view.el('thead');
        var headRow = view.el('tr');
        ['#', 'Title', 'Level', 'Status', 'Order', 'Actions'].forEach(function (h) {
            headRow.appendChild(view.el('th', null, h));
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = view.el('tbody');
        rows.forEach(function (lesson) {
            tbody.appendChild(buildLessonRow(lesson));
        });
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        wrap.appendChild(tableWrap);
    }

    function buildLessonRow(lesson) {
        var view = V();
        var tr = view.el('tr');

        tr.appendChild(cell('#', view.padNumber(lesson.lesson_number)));

        var titleCell = view.el('td');
        titleCell.setAttribute('data-label', 'Title');
        titleCell.appendChild(view.el('strong', null, lesson.title || '(untitled)'));
        tr.appendChild(titleCell);

        tr.appendChild(cell('Level', lesson.level || '—'));

        var statusCell = view.el('td');
        statusCell.setAttribute('data-label', 'Status');
        statusCell.appendChild(statusBadge(lesson.status));
        tr.appendChild(statusCell);

        tr.appendChild(cell('Order', String(lesson.display_order)));

        var actions = view.el('td', 'sm-td-action');
        actions.setAttribute('data-label', 'Actions');
        actions.style.whiteSpace = 'nowrap';

        actions.appendChild(rowButton('fa-regular fa-pen-to-square', 'Edit',
            'Edit ' + lesson.title, function () { openLessonEditor(lesson.id); }));

        if (lesson.status === 'published') {
            actions.appendChild(rowButton('fa-regular fa-eye-slash', 'Unpublish',
                'Unpublish ' + lesson.title, function () { changeLessonStatus(lesson, 'draft'); }));
        } else {
            actions.appendChild(rowButton('fa-solid fa-tower-broadcast', 'Publish',
                'Publish ' + lesson.title, function () { changeLessonStatus(lesson, 'published'); }));
        }

        if (lesson.status !== 'archived') {
            actions.appendChild(rowButton('fa-regular fa-box-archive', 'Archive',
                'Archive ' + lesson.title, function () { confirmArchive(lesson); }));
        }

        actions.appendChild(rowButton('fa-regular fa-trash-can', 'Delete',
            'Delete ' + lesson.title, function () { confirmDelete(lesson); }));

        tr.appendChild(actions);
        return tr;
    }

    function cell(label, text) {
        var td = V().el('td', null, text);
        td.setAttribute('data-label', label);
        return td;
    }

    function rowButton(iconClass, label, ariaLabel, onClick) {
        var view = V();
        var btn = view.el('button', 'sm-row-btn');
        btn.type = 'button';
        btn.style.marginRight = '0.35rem';
        btn.setAttribute('aria-label', ariaLabel);
        btn.appendChild(view.icon(iconClass));
        btn.appendChild(document.createTextNode(' ' + label));
        btn.addEventListener('click', onClick);
        return btn;
    }

    /** Status is conveyed by the word itself, not only by the badge colour. */
    function statusBadge(status) {
        var labels = { published: 'Published', draft: 'Draft', archived: 'Archived' };
        var classes = { published: 'sm-badge sm-active', draft: 'sm-badge al-draft', archived: 'sm-badge al-archived' };
        return V().el('span', classes[status] || 'sm-badge sm-muted', labels[status] || status);
    }

    function setLessonStatusFilter(value) {
        lessonsAdminState.statusFilter = value;
        markActiveChip('alStatusFilters', value === 'all' ? 'All' : value);
        renderAdminLessons();
    }

    function setLessonLevelFilter(value) {
        lessonsAdminState.levelFilter = value;
        markActiveChip('alLevelFilters', value === 'all' ? 'All' : value);
        renderAdminLessons();
    }

    function markActiveChip(groupId, label) {
        var group = $(groupId);
        if (!group) return;
        var chips = group.querySelectorAll('.sm-chip');
        for (var i = 0; i < chips.length; i++) {
            chips[i].classList.toggle('active',
                chips[i].textContent.trim().toLowerCase() === String(label).toLowerCase());
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // EDITOR
    // ══════════════════════════════════════════════════════════════════════

    function showView(name) {
        var views = { list: 'alListView', editor: 'alEditorView', reorder: 'alReorderView' };
        Object.keys(views).forEach(function (key) {
            var node = $(views[key]);
            if (node) node.style.display = (key === name) ? 'block' : 'none';
        });
    }

    function openLessonEditor(id) {
        lessonsAdminState.editingId = id || null;
        lessonsAdminState.editingRecord = null;
        showView('editor');
        global.scrollTo(0, 0);

        if (!id) {
            fillEditor(blankLesson());
            $('alEditorTitle').textContent = 'New Lesson';
            $('alEditorSub').textContent = 'Fill in the details below, then save as a draft or publish.';
            renderEditorActions();
            return;
        }

        $('alEditorTitle').textContent = 'Loading lesson...';
        $('alEditorSub').textContent = '';
        callApi({ action: 'adminGetLesson', id: id })
            .then(function (res) {
                lessonsAdminState.editingRecord = res.data;
                fillEditor(res.data);
                $('alEditorTitle').textContent = 'Edit Lesson ' + V().padNumber(res.data.lesson_number);
                $('alEditorSub').textContent = res.data.title || '';
                renderEditorActions();
            })
            .catch(function (err) {
                toastError(err.message || 'Could not open that lesson.');
                closeLessonEditor();
            });
    }

    function blankLesson() {
        var nextNumber = 1;
        var nextOrder = lessonsAdminState.list.length + 1;
        lessonsAdminState.list.forEach(function (l) {
            if (Number(l.lesson_number) >= nextNumber) nextNumber = Number(l.lesson_number) + 1;
        });
        return {
            lesson_number: nextNumber, title: '', short_description: '', description: '',
            level: 'A1', duration: 20, thumbnail: '', status: 'draft', display_order: nextOrder,
            learning_objectives: [], content: [], vocabulary: [], examples: [], exercises: [],
            youtube_url: '', additional_resources: []
        };
    }

    function fillEditor(lesson) {
        clearAllErrors();
        $('alFieldNumber').value = lesson.lesson_number || '';
        $('alFieldTitle').value = lesson.title || '';
        $('alFieldShortDesc').value = lesson.short_description || '';
        $('alFieldDescription').value = lesson.description || '';
        $('alFieldLevel').value = LEVELS.indexOf(lesson.level) !== -1 ? lesson.level : 'A1';
        $('alFieldDuration').value = lesson.duration || '';
        $('alFieldThumbnail').value = lesson.thumbnail || '';
        $('alFieldStatus').value = lesson.status || 'draft';
        $('alFieldOrder').value = lesson.display_order || '';
        $('alFieldYoutube').value = lesson.youtube_url || '';

        editorLists.objectives = (lesson.learning_objectives || []).map(function (o) {
            return typeof o === 'string' ? o : String(o && o.text || '');
        });
        editorLists.blocks = (lesson.content || []).map(function (b) {
            return { type: b.type, text: b.text || '', url: b.url || '', alt: b.alt || '' };
        });
        editorLists.vocabulary = (lesson.vocabulary || []).map(function (v) {
            return { word: v.word || '', meaning: v.meaning || '', example: v.example || '', pronunciation: v.pronunciation || '' };
        });
        editorLists.examples = (lesson.examples || []).map(function (x) {
            return { english: x.english || '', translation: x.translation || '' };
        });
        editorLists.exercises = (lesson.exercises || []).map(function (x) {
            return { prompt: x.prompt || '', answer: x.answer || '' };
        });
        editorLists.resources = (lesson.additional_resources || []).map(function (r) {
            return { label: r.label || '', url: r.url || '' };
        });

        renderObjectives();
        renderBlocks();
        renderVocabulary();
        renderExamples();
        renderExercises();
        renderResources();
    }

    function closeLessonEditor() {
        lessonsAdminState.editingId = null;
        lessonsAdminState.editingRecord = null;
        showView('list');
        renderAdminLessons();
    }

    function renderEditorActions() {
        var view = V();
        var bar = $('alEditorActions');
        if (!bar) return;
        view.clearNode(bar);

        var record = lessonsAdminState.editingRecord;
        var isNew = !lessonsAdminState.editingId;
        var isPublished = record && record.status === 'published';

        bar.appendChild(actionButton('btn btn-primary', 'fa-regular fa-floppy-disk',
            isNew ? 'Save Draft' : 'Save Changes', function () { saveLesson(null); }));

        bar.appendChild(actionButton('btn', 'fa-regular fa-eye', 'Preview',
            function () { previewLessonDraft(); }));

        if (!isPublished) {
            bar.appendChild(actionButton('btn btn-success', 'fa-solid fa-tower-broadcast',
                'Publish Lesson', function () { saveLesson('published'); }));
        } else {
            bar.appendChild(actionButton('btn', 'fa-regular fa-eye-slash', 'Unpublish',
                function () { saveLesson('draft'); }));
        }

        if (!isNew) {
            bar.appendChild(actionButton('btn', 'fa-regular fa-box-archive', 'Archive',
                function () { confirmArchive(record); }));
            bar.appendChild(actionButton('btn btn-danger', 'fa-regular fa-trash-can', 'Delete',
                function () { confirmDelete(record); }));
        }
    }

    function actionButton(className, iconClass, label, onClick) {
        var view = V();
        var btn = view.el('button', className);
        btn.type = 'button';
        btn.appendChild(view.icon(iconClass));
        btn.appendChild(document.createTextNode(' ' + label));
        btn.addEventListener('click', onClick);
        return btn;
    }

    // ── repeaters ─────────────────────────────────────────────────────────

    /**
     * Builds one repeater card with move-up / move-down / remove controls.
     * `onChange` is wired to each input so the working array stays current.
     */
    function repeatItem(listKey, index, label, buildFields) {
        var view = V();
        var item = view.el('div', 'al-repeat-item');

        var head = view.el('div', 'al-repeat-head');
        head.appendChild(view.el('span', 'al-repeat-index', label + ' ' + (index + 1)));

        var tools = view.el('div', 'al-repeat-tools');
        var list = editorLists[listKey];

        var up = iconButton('fa-solid fa-arrow-up', 'Move ' + label.toLowerCase() + ' ' + (index + 1) + ' up');
        up.disabled = index === 0;
        up.addEventListener('click', function () { moveItem(listKey, index, -1); });
        tools.appendChild(up);

        var down = iconButton('fa-solid fa-arrow-down', 'Move ' + label.toLowerCase() + ' ' + (index + 1) + ' down');
        down.disabled = index === list.length - 1;
        down.addEventListener('click', function () { moveItem(listKey, index, 1); });
        tools.appendChild(down);

        var remove = iconButton('fa-solid fa-xmark', 'Remove ' + label.toLowerCase() + ' ' + (index + 1));
        remove.classList.add('al-danger');
        remove.addEventListener('click', function () { removeItem(listKey, index); });
        tools.appendChild(remove);

        head.appendChild(tools);
        item.appendChild(head);
        buildFields(item);
        return item;
    }

    function iconButton(iconClass, ariaLabel) {
        var btn = V().el('button', 'al-icon-btn');
        btn.type = 'button';
        btn.setAttribute('aria-label', ariaLabel);
        btn.appendChild(V().icon(iconClass));
        return btn;
    }

    var RENDERERS = {};

    function moveItem(listKey, index, delta) {
        var list = editorLists[listKey];
        var target = index + delta;
        if (target < 0 || target >= list.length) return;
        var tmp = list[index];
        list[index] = list[target];
        list[target] = tmp;
        RENDERERS[listKey]();
    }

    function removeItem(listKey, index) {
        editorLists[listKey].splice(index, 1);
        RENDERERS[listKey]();
    }

    /** A labelled field whose value is written straight back into the model. */
    function boundField(container, labelText, value, onInput, options) {
        var opts = options || {};
        var view = V();
        var group = view.el('div', 'form-group full-width');
        group.style.marginBottom = '0.7rem';

        var id = 'alf_' + Math.random().toString(36).slice(2, 9);
        var label = view.el('label', null, labelText);
        label.setAttribute('for', id);
        group.appendChild(label);

        var input = document.createElement(opts.multiline ? 'textarea' : 'input');
        if (!opts.multiline) input.type = opts.type || 'text';
        input.id = id;
        input.value = value || '';
        if (opts.placeholder) input.placeholder = opts.placeholder;
        if (opts.maxLength) input.maxLength = opts.maxLength;
        if (opts.multiline) input.style.minHeight = opts.minHeight || '80px';
        input.addEventListener('input', function () { onInput(input.value); });
        group.appendChild(input);

        if (opts.hint) group.appendChild(view.el('p', 'al-hint', opts.hint));
        container.appendChild(group);
        return input;
    }

    function emptyHint(container, text) {
        container.appendChild(V().el('p', 'al-empty-hint', text));
    }

    // objectives
    function renderObjectives() {
        var view = V();
        var host = $('alObjectivesList');
        view.clearNode(host);
        if (!editorLists.objectives.length) {
            emptyHint(host, 'No objectives yet. Objectives are optional but help students know what to expect.');
            return;
        }
        editorLists.objectives.forEach(function (text, i) {
            host.appendChild(repeatItem('objectives', i, 'Objective', function (item) {
                boundField(item, 'Objective', text, function (v) { editorLists.objectives[i] = v; },
                    { placeholder: 'Describe habits and routines', maxLength: 300 });
            }));
        });
    }
    RENDERERS.objectives = renderObjectives;

    function alAddObjective() {
        editorLists.objectives.push('');
        renderObjectives();
    }

    // content blocks
    function renderBlocks() {
        var view = V();
        var host = $('alBlocksList');
        view.clearNode(host);
        if (!editorLists.blocks.length) {
            emptyHint(host, 'No content yet. Add a block below to start writing the lesson.');
            return;
        }
        editorLists.blocks.forEach(function (block, i) {
            host.appendChild(repeatItem('blocks', i, 'Block', function (item) {
                var badge = view.el('span', 'al-block-type', BLOCK_LABELS[block.type] || block.type);
                item.insertBefore(badge, item.firstChild.nextSibling);

                if (block.type === 'divider') {
                    item.appendChild(view.el('hr', 'al-block-divider-preview'));
                    return;
                }
                if (block.type === 'image') {
                    boundField(item, 'Image URL', block.url, function (v) { editorLists.blocks[i].url = v; },
                        { type: 'url', placeholder: 'https://...' });
                    boundField(item, 'Alt text (describes the image)', block.alt,
                        function (v) { editorLists.blocks[i].alt = v; },
                        { placeholder: 'A student writing in a notebook', maxLength: 200,
                          hint: 'Leave empty only if the image is purely decorative.' });
                    return;
                }
                boundField(item, BLOCK_LABELS[block.type] || 'Text', block.text,
                    function (v) { editorLists.blocks[i].text = v; },
                    {
                        multiline: block.type !== 'heading',
                        maxLength: block.type === 'heading' ? 200 : 20000,
                        minHeight: block.type === 'text' ? '120px' : '70px',
                        hint: block.type === 'text' ? 'Leave a blank line between paragraphs.' : ''
                    });
            }));
        });
    }
    RENDERERS.blocks = renderBlocks;

    function alAddBlock(type) {
        if (!BLOCK_LABELS[type]) return;
        editorLists.blocks.push({ type: type, text: '', url: '', alt: '' });
        renderBlocks();
        clearError('Content');
    }

    // vocabulary
    function renderVocabulary() {
        var host = $('alVocabList');
        V().clearNode(host);
        if (!editorLists.vocabulary.length) {
            emptyHint(host, 'No vocabulary yet.');
            return;
        }
        editorLists.vocabulary.forEach(function (v, i) {
            host.appendChild(repeatItem('vocabulary', i, 'Word', function (item) {
                boundField(item, 'Word *', v.word, function (val) { editorLists.vocabulary[i].word = val; },
                    { placeholder: 'Improve', maxLength: 100 });
                boundField(item, 'Meaning', v.meaning, function (val) { editorLists.vocabulary[i].meaning = val; },
                    { placeholder: 'To become better', maxLength: 500 });
                boundField(item, 'Example', v.example, function (val) { editorLists.vocabulary[i].example = val; },
                    { placeholder: 'I want to improve my English.', maxLength: 500 });
                boundField(item, 'Pronunciation', v.pronunciation,
                    function (val) { editorLists.vocabulary[i].pronunciation = val; },
                    { placeholder: 'ɪmˈpruːv', maxLength: 100, hint: 'Optional.' });
            }));
        });
    }
    RENDERERS.vocabulary = renderVocabulary;

    function alAddVocab() {
        editorLists.vocabulary.push({ word: '', meaning: '', example: '', pronunciation: '' });
        renderVocabulary();
    }

    // examples
    function renderExamples() {
        var host = $('alExamplesList');
        V().clearNode(host);
        if (!editorLists.examples.length) {
            emptyHint(host, 'No examples yet.');
            return;
        }
        editorLists.examples.forEach(function (x, i) {
            host.appendChild(repeatItem('examples', i, 'Example', function (item) {
                boundField(item, 'English *', x.english, function (val) { editorLists.examples[i].english = val; },
                    { placeholder: 'She works every day.', maxLength: 600 });
                boundField(item, 'Meaning / translation', x.translation,
                    function (val) { editorLists.examples[i].translation = val; },
                    { placeholder: 'Optional', maxLength: 600,
                      hint: 'Leave empty and no translation is shown to students.' });
            }));
        });
    }
    RENDERERS.examples = renderExamples;

    function alAddExample() {
        editorLists.examples.push({ english: '', translation: '' });
        renderExamples();
    }

    // exercises
    function renderExercises() {
        var host = $('alExercisesList');
        V().clearNode(host);
        if (!editorLists.exercises.length) {
            emptyHint(host, 'No exercises yet.');
            return;
        }
        editorLists.exercises.forEach(function (x, i) {
            host.appendChild(repeatItem('exercises', i, 'Exercise', function (item) {
                boundField(item, 'Question / task *', x.prompt,
                    function (val) { editorLists.exercises[i].prompt = val; },
                    { multiline: true, placeholder: 'Write three sentences about your daily routine.', maxLength: 1000 });
                boundField(item, 'Answer', x.answer, function (val) { editorLists.exercises[i].answer = val; },
                    { multiline: true, maxLength: 1000,
                      hint: 'Optional. Students reveal this with a "Show answer" toggle.' });
            }));
        });
    }
    RENDERERS.exercises = renderExercises;

    function alAddExercise() {
        editorLists.exercises.push({ prompt: '', answer: '' });
        renderExercises();
    }

    // resources
    function renderResources() {
        var host = $('alResourcesList');
        V().clearNode(host);
        if (!editorLists.resources.length) {
            emptyHint(host, 'No extra links yet.');
            return;
        }
        editorLists.resources.forEach(function (r, i) {
            host.appendChild(repeatItem('resources', i, 'Link', function (item) {
                boundField(item, 'Label', r.label, function (val) { editorLists.resources[i].label = val; },
                    { placeholder: 'Grammar reference', maxLength: 200 });
                boundField(item, 'URL *', r.url, function (val) { editorLists.resources[i].url = val; },
                    { type: 'url', placeholder: 'https://...' });
            }));
        });
    }
    RENDERERS.resources = renderResources;

    function alAddResource() {
        editorLists.resources.push({ label: '', url: '' });
        renderResources();
    }

    // ── validation ────────────────────────────────────────────────────────

    function setError(field, message) {
        var err = $('alErr' + field);
        var group = $('alGroup' + field);
        if (err) err.textContent = message;
        if (group) group.classList.add('al-invalid');
    }

    function clearError(field) {
        var err = $('alErr' + field);
        var group = $('alGroup' + field);
        if (err) err.textContent = '';
        if (group) group.classList.remove('al-invalid');
    }

    function clearAllErrors() {
        ['Number', 'Title', 'Level', 'Duration', 'Thumbnail', 'Order', 'Youtube', 'Content']
            .forEach(clearError);
    }

    function isYouTubeUrl(url) {
        return !!V().youTubeId(url);
    }

    function isHttpUrl(url) {
        return /^https?:\/\/[^\s"'<>]+$/i.test(String(url).trim());
    }

    /**
     * Collects the form into a lesson object. Returns null (after showing
     * inline messages) when something required is missing or malformed.
     * `intendedStatus` raises the bar for publishing.
     */
    function collectLesson(intendedStatus) {
        clearAllErrors();
        var errors = 0;
        var firstBadField = null;

        function fail(field, message) {
            setError(field, message);
            errors++;
            if (!firstBadField) firstBadField = $('alField' + field);
        }

        var number = Number($('alFieldNumber').value);
        if (!$('alFieldNumber').value.trim() || !isFinite(number) || number < 1 || number % 1 !== 0) {
            fail('Number', 'Enter a whole lesson number of 1 or more.');
        }

        var title = $('alFieldTitle').value.trim();
        if (!title) fail('Title', 'A title is required.');

        var level = $('alFieldLevel').value;
        if (LEVELS.indexOf(level) === -1) fail('Level', 'Choose a level.');

        var durationRaw = $('alFieldDuration').value.trim();
        var duration = durationRaw === '' ? 0 : Number(durationRaw);
        if (durationRaw !== '' && (!isFinite(duration) || duration < 0)) {
            fail('Duration', 'Duration must be a positive number of minutes.');
        }

        var orderRaw = $('alFieldOrder').value.trim();
        var order = orderRaw === '' ? number : Number(orderRaw);
        if (orderRaw !== '' && (!isFinite(order) || order < 0 || order % 1 !== 0)) {
            fail('Order', 'Display order must be a whole number.');
        }

        var thumbnail = $('alFieldThumbnail').value.trim();
        if (thumbnail && !isHttpUrl(thumbnail)) {
            fail('Thumbnail', 'Enter a full URL starting with https://');
        }

        var youtube = $('alFieldYoutube').value.trim();
        if (youtube && !isYouTubeUrl(youtube)) {
            fail('Youtube', 'That does not look like a YouTube link.');
        }

        // Blocks that are still blank are dropped rather than rejected.
        var blocks = editorLists.blocks.filter(function (b) {
            if (b.type === 'divider') return true;
            if (b.type === 'image') return !!String(b.url || '').trim();
            return !!String(b.text || '').trim();
        }).map(function (b) {
            if (b.type === 'divider') return { type: 'divider' };
            if (b.type === 'image') return { type: 'image', url: String(b.url).trim(), alt: String(b.alt || '').trim() };
            return { type: b.type, text: String(b.text).trim() };
        });

        var badImage = blocks.filter(function (b) { return b.type === 'image' && !isHttpUrl(b.url); });
        if (badImage.length) {
            setError('Content', 'Every image block needs a full URL starting with https://');
            errors++;
        }

        var status = intendedStatus || $('alFieldStatus').value;
        if (status === 'published' && !blocks.length) {
            setError('Content', 'Add some lesson content before publishing.');
            errors++;
        }

        var badResource = editorLists.resources.filter(function (r) {
            return String(r.url || '').trim() && !isHttpUrl(r.url);
        });
        if (badResource.length) {
            toastError('Every additional link needs a full URL starting with https://');
            errors++;
        }

        if (errors) {
            if (firstBadField && typeof firstBadField.focus === 'function') {
                firstBadField.focus();
                firstBadField.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
            return null;
        }

        return {
            lesson_number: number,
            title: title,
            short_description: $('alFieldShortDesc').value.trim(),
            description: $('alFieldDescription').value.trim(),
            level: level,
            duration: duration,
            thumbnail: thumbnail,
            status: status,
            display_order: order,
            learning_objectives: editorLists.objectives.filter(function (o) { return String(o).trim(); })
                .map(function (o) { return String(o).trim(); }),
            content: blocks,
            vocabulary: editorLists.vocabulary.filter(function (v) { return String(v.word || '').trim(); }),
            examples: editorLists.examples.filter(function (x) { return String(x.english || '').trim(); }),
            exercises: editorLists.exercises.filter(function (x) { return String(x.prompt || '').trim(); }),
            youtube_url: youtube,
            additional_resources: editorLists.resources.filter(function (r) { return String(r.url || '').trim(); })
        };
    }

    // ── save ──────────────────────────────────────────────────────────────

    function saveLesson(forcedStatus) {
        if (lessonsAdminState.busy) return;
        var lesson = collectLesson(forcedStatus);
        if (!lesson) {
            toastError('Please fix the highlighted fields.');
            return;
        }

        var isNew = !lessonsAdminState.editingId;
        var verb = forcedStatus === 'published' ? 'Publishing' : 'Saving';
        setBusy(true, verb + ' lesson...');

        var payload = isNew
            ? { action: 'createLesson', lesson: lesson }
            : { action: 'updateLesson', id: lessonsAdminState.editingId, lesson: lesson };

        callApi(payload)
            .then(function (res) {
                lessonsAdminState.editingId = res.data.id;
                lessonsAdminState.editingRecord = res.data;
                // Reflect the saved status back into the form.
                $('alFieldStatus').value = res.data.status;
                $('alEditorTitle').textContent = 'Edit Lesson ' + V().padNumber(res.data.lesson_number);
                $('alEditorSub').textContent = res.data.title;
                renderEditorActions();

                lessonsAdminState.loaded = false;
                toast(isNew
                    ? (lesson.status === 'published' ? 'Lesson published successfully.' : 'Lesson created successfully.')
                    : (forcedStatus === 'published' ? 'Lesson published successfully.'
                        : forcedStatus === 'draft' ? 'Lesson unpublished.' : 'Lesson updated successfully.'));
                return loadListQuietly();
            })
            .catch(function (err) {
                // The form is deliberately left untouched so nothing is retyped.
                toastError(err.message || "We couldn't save your lesson. Please try again.");
            })
            .then(function () { setBusy(false); });
    }

    function loadListQuietly() {
        return callApi({ action: 'adminGetLessons' })
            .then(function (res) {
                lessonsAdminState.list = Array.isArray(res.data) ? res.data : [];
                lessonsAdminState.loaded = true;
            })
            .catch(function () { /* the list refreshes on next open */ });
    }

    function setBusy(busy, message) {
        lessonsAdminState.busy = busy;
        var bar = $('alEditorActions');
        if (!bar) return;
        var buttons = bar.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) buttons[i].disabled = busy;
        if (busy && message) toast(message);
    }

    // ── status changes from the list ──────────────────────────────────────

    function changeLessonStatus(lesson, status) {
        toast(status === 'published' ? 'Publishing lesson...' : 'Updating lesson...');
        callApi({ action: 'setLessonStatus', id: lesson.id, status: status })
            .then(function () {
                toast(status === 'published' ? 'Lesson published successfully.'
                    : status === 'archived' ? 'Lesson archived.' : 'Lesson unpublished.');
                lessonsAdminState.loaded = false;
                loadAdminLessons(true);
            })
            .catch(function (err) {
                toastError(err.message || 'Could not update the lesson.');
            });
    }

    function confirmArchive(lesson) {
        if (!lesson) return;
        askConfirm('Archive "' + lesson.title + '"? Students will no longer see it, ' +
            'but the lesson and its content are kept.', 'Archive Lesson', function () {
            changeLessonStatus(lesson, 'archived');
            if (lessonsAdminState.editingId === lesson.id) closeLessonEditor();
        });
    }

    function confirmDelete(lesson) {
        if (!lesson) return;
        askConfirm('Are you sure you want to delete "' + lesson.title + '"? ' +
            'This action cannot be undone. Consider archiving instead.', 'Delete Lesson', function () {
            callApi({ action: 'deleteLesson', id: lesson.id })
                .then(function () {
                    toast('Lesson deleted.');
                    lessonsAdminState.loaded = false;
                    if (lessonsAdminState.editingId === lesson.id) closeLessonEditor();
                    loadAdminLessons(true);
                })
                .catch(function (err) { toastError(err.message || 'Could not delete the lesson.'); });
        });
    }

    // ── import from JSON ──────────────────────────────────────────────────

    function openLessonImport() {
        var modal = $('alImportModal');
        if (!modal) return;
        clearError('Import');
        modal.classList.add('show');
        var box = $('alImportText');
        if (box) { box.value = ''; box.focus(); }
    }

    function closeLessonImport() {
        var modal = $('alImportModal');
        if (modal) modal.classList.remove('show');
    }

    /**
     * Parses pasted lesson JSON into the editor form. Nothing is written to the
     * backend here — the admin still reviews, previews and publishes, so all the
     * usual validation applies before anything is saved.
     */
    function applyLessonImport() {
        var box = $('alImportText');
        if (!box) return;
        clearError('Import');

        var raw = String(box.value || '').trim();
        if (!raw) { setError('Import', 'Paste a lesson JSON first.'); return; }

        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            setError('Import', 'That is not valid JSON. Check for a missing comma or bracket.');
            return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            setError('Import', 'Expected a single lesson object.');
            return;
        }
        if (!String(parsed.title || '').trim()) {
            setError('Import', 'The JSON has no "title" field.');
            return;
        }

        // Start from a blank lesson so anything the file omits gets a sane
        // default, then overlay the imported values.
        var base = blankLesson();
        Object.keys(parsed).forEach(function (key) {
            if (parsed[key] !== undefined && parsed[key] !== null) base[key] = parsed[key];
        });

        lessonsAdminState.editingId = null;      // always creates a new lesson
        lessonsAdminState.editingRecord = null;
        showView('editor');
        fillEditor(base);
        $('alEditorTitle').textContent = 'New Lesson (imported)';
        $('alEditorSub').textContent = base.title;
        renderEditorActions();

        closeLessonImport();
        toast('Lesson loaded into the editor. Review it, then publish.');
        global.scrollTo(0, 0);
    }

    // ── confirm dialog ────────────────────────────────────────────────────

    var confirmHandler = null;

    function askConfirm(message, actionLabel, onConfirm) {
        var modal = $('alConfirmModal');
        var okBtn = $('alConfirmOk');
        if (!modal || !okBtn) {
            if (global.confirm(message)) onConfirm();
            return;
        }
        $('alConfirmMessage').textContent = message;
        okBtn.textContent = actionLabel;
        confirmHandler = onConfirm;
        modal.classList.add('show');
        okBtn.focus();
    }

    function closeLessonConfirm() {
        var modal = $('alConfirmModal');
        if (modal) modal.classList.remove('show');
        confirmHandler = null;
    }

    // ── preview (uses the student renderer) ───────────────────────────────

    function previewLessonDraft() {
        var lesson = collectLesson(null);
        if (!lesson) {
            toastError('Please fix the highlighted fields before previewing.');
            return;
        }
        var host = $('alPreviewContent');
        var modal = $('alPreviewModal');
        if (!host || !modal) return;

        V().renderLesson(host, lesson, { preview: true });
        modal.classList.add('show');
        var closeBtn = modal.querySelector('.sm-close');
        if (closeBtn) closeBtn.focus();
    }

    function closeLessonPreview() {
        var modal = $('alPreviewModal');
        if (modal) modal.classList.remove('show');
        var host = $('alPreviewContent');
        if (host) V().clearNode(host);      // stops any playing video
    }

    // ══════════════════════════════════════════════════════════════════════
    // REORDER
    // ══════════════════════════════════════════════════════════════════════

    function openLessonReorder() {
        if (!lessonsAdminState.list.length) {
            toastError('There are no lessons to reorder yet.');
            return;
        }
        // Ordering applies to the whole library, so this view ignores filters.
        lessonsAdminState.reorderDraft = lessonsAdminState.list.slice();
        showView('reorder');
        renderReorderList();
        global.scrollTo(0, 0);
    }

    function closeLessonReorder() {
        lessonsAdminState.reorderDraft = [];
        showView('list');
        renderAdminLessons();
    }

    function renderReorderList() {
        var view = V();
        var host = $('alReorderList');
        if (!host) return;
        view.clearNode(host);

        lessonsAdminState.reorderDraft.forEach(function (lesson, index) {
            var li = view.el('li', 'al-reorder-item');
            li.draggable = true;
            li.setAttribute('data-index', String(index));

            li.appendChild(view.icon('fa-solid fa-grip-vertical'));
            var grip = li.firstChild;
            grip.className = 'fa-solid fa-grip-vertical al-grip';

            li.appendChild(view.el('span', 'al-reorder-title',
                view.padNumber(lesson.lesson_number) + ' · ' + (lesson.title || '(untitled)')));
            li.appendChild(statusBadge(lesson.status));

            var tools = view.el('div', 'al-reorder-tools');
            // Arrow buttons keep reordering usable by keyboard and on touch.
            var up = iconButton('fa-solid fa-arrow-up', 'Move ' + lesson.title + ' up');
            up.disabled = index === 0;
            up.addEventListener('click', function () { moveReorder(index, -1); });
            tools.appendChild(up);

            var down = iconButton('fa-solid fa-arrow-down', 'Move ' + lesson.title + ' down');
            down.disabled = index === lessonsAdminState.reorderDraft.length - 1;
            down.addEventListener('click', function () { moveReorder(index, 1); });
            tools.appendChild(down);
            li.appendChild(tools);

            li.addEventListener('dragstart', function (e) {
                lessonsAdminState.dragIndex = index;
                li.classList.add('al-dragging');
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            });
            li.addEventListener('dragend', function () {
                li.classList.remove('al-dragging');
                lessonsAdminState.dragIndex = null;
            });
            li.addEventListener('dragover', function (e) {
                e.preventDefault();
                li.classList.add('al-drop-target');
            });
            li.addEventListener('dragleave', function () { li.classList.remove('al-drop-target'); });
            li.addEventListener('drop', function (e) {
                e.preventDefault();
                li.classList.remove('al-drop-target');
                var from = lessonsAdminState.dragIndex;
                if (from === null || from === index) return;
                var moved = lessonsAdminState.reorderDraft.splice(from, 1)[0];
                lessonsAdminState.reorderDraft.splice(index, 0, moved);
                renderReorderList();
            });

            host.appendChild(li);
        });
    }

    function moveReorder(index, delta) {
        var list = lessonsAdminState.reorderDraft;
        var target = index + delta;
        if (target < 0 || target >= list.length) return;
        var tmp = list[index];
        list[index] = list[target];
        list[target] = tmp;
        renderReorderList();
    }

    function saveLessonOrder() {
        var btn = $('alSaveOrderBtn');
        if (btn) btn.disabled = true;
        toast('Saving lesson order...');

        var order = lessonsAdminState.reorderDraft.map(function (l) { return l.id; });
        callApi({ action: 'reorderLessons', order: order })
            .then(function () {
                toast('Lesson order updated successfully.');
                lessonsAdminState.loaded = false;
                closeLessonReorder();
                loadAdminLessons(true);
            })
            .catch(function (err) {
                toastError(err.message || 'Could not save the new order.');
            })
            .then(function () { if (btn) btn.disabled = false; });
    }

    // ══════════════════════════════════════════════════════════════════════

    document.addEventListener('click', function (e) {
        if (e.target && e.target.id === 'alConfirmOk' && confirmHandler) {
            var handler = confirmHandler;
            closeLessonConfirm();
            handler();
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        closeLessonPreview();
        closeLessonConfirm();
        closeLessonImport();
    });

    // Exposed for the inline onclick handlers in admin.html.
    global.loadAdminLessons = loadAdminLessons;
    global.renderAdminLessons = renderAdminLessons;
    global.setLessonStatusFilter = setLessonStatusFilter;
    global.setLessonLevelFilter = setLessonLevelFilter;
    global.openLessonEditor = openLessonEditor;
    global.closeLessonEditor = closeLessonEditor;
    global.closeLessonPreview = closeLessonPreview;
    global.openLessonImport = openLessonImport;
    global.closeLessonImport = closeLessonImport;
    global.applyLessonImport = applyLessonImport;
    global.closeLessonConfirm = closeLessonConfirm;
    global.openLessonReorder = openLessonReorder;
    global.closeLessonReorder = closeLessonReorder;
    global.saveLessonOrder = saveLessonOrder;
    global.alAddObjective = alAddObjective;
    global.alAddBlock = alAddBlock;
    global.alAddVocab = alAddVocab;
    global.alAddExample = alAddExample;
    global.alAddExercise = alAddExercise;
    global.alAddResource = alAddResource;
})(window);
