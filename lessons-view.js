/* ============================================================
   FLUENCY — LESSONS VIEW (shared renderer)

   Turns a lesson record into DOM. Loaded by index.html for the
   student pages and by admin.html for the admin preview, so the
   preview is guaranteed to be the same component students see.

   Everything is built with createElement + textContent. No lesson
   field is ever interpolated into innerHTML, so admin-authored text
   cannot become markup. The only embedded frame is a YouTube one,
   built from an id that has been re-validated here.
   ============================================================ */
(function (global) {
  'use strict';

  // ── tiny DOM helpers ───────────────────────────────────────────────────────

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

  function textOf(value) {
    return value === undefined || value === null ? '' : String(value).trim();
  }

  /** A section wrapper that is only created when it has something to show. */
  function makeSection(heading) {
    var section = el('section', 'fl-lesson-section');
    if (heading) section.appendChild(el('h2', null, heading));
    return section;
  }

  // ── YouTube ────────────────────────────────────────────────────────────────

  /**
   * Re-validates the URL on the way out of storage. The backend already
   * normalises it, but the renderer never assumes its input is trustworthy.
   */
  function youTubeId(url) {
    var raw = textOf(url);
    if (!raw) return '';
    var patterns = [
      /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})/,
      /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})/,
      /^https?:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
      /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = raw.match(patterns[i]);
      if (m) return m[1];
    }
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
    return '';
  }

  /** Only https URLs are ever put in an href or src. */
  function safeUrl(url) {
    var raw = textOf(url);
    return /^https?:\/\//i.test(raw) ? raw : '';
  }

  /**
   * Click-to-load video. The iframe is not created until the student asks for
   * it, so opening a lesson costs no YouTube requests.
   */
  function buildVideo(videoId, lessonTitle) {
    var frame = el('div', 'fl-video-frame');
    var poster = el('button', 'fl-video-play');
    poster.type = 'button';
    poster.setAttribute('aria-label', 'Play the video explanation for ' + (lessonTitle || 'this lesson'));
    poster.style.backgroundImage = "url('https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg')";
    poster.appendChild(icon('fa-solid fa-circle-play'));

    poster.addEventListener('click', function () {
      var iframe = document.createElement('iframe');
      iframe.src = 'https://www.youtube-nocookie.com/embed/' + videoId + '?autoplay=1&rel=0';
      iframe.title = 'Video explanation: ' + (lessonTitle || 'lesson');
      iframe.setAttribute('loading', 'lazy');
      iframe.setAttribute('allowfullscreen', '');
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      iframe.setAttribute('allow', 'accelerometer; autoplay; encrypted-media; picture-in-picture');
      clearNode(frame);
      frame.appendChild(iframe);
    });

    frame.appendChild(poster);
    return frame;
  }

  // ── content blocks ─────────────────────────────────────────────────────────

  function buildBlock(block) {
    if (!block || typeof block !== 'object') return null;
    var type = textOf(block.type).toLowerCase();
    var text = textOf(block.text);

    if (type === 'divider') return el('hr', 'fl-block-divider');

    if (type === 'image') {
      var src = safeUrl(block.url);
      if (!src) return null;
      var img = el('img', 'fl-block-image');
      img.src = src;
      img.alt = textOf(block.alt);       // always present, empty means decorative
      img.loading = 'lazy';
      return img;
    }

    if (!text) return null;

    if (type === 'heading') return el('h3', null, text);
    if (type === 'note') {
      var note = el('div', 'fl-block-note');
      note.appendChild(el('p', 'fl-prose', text));
      return note;
    }
    if (type === 'quote') {
      var quote = el('blockquote', 'fl-block-quote');
      quote.appendChild(el('p', 'fl-prose', text));
      return quote;
    }
    // 'text' — blank lines become separate paragraphs.
    var wrap = document.createDocumentFragment();
    text.split(/\n{2,}/).forEach(function (para) {
      var trimmed = para.trim();
      if (trimmed) wrap.appendChild(el('p', 'fl-prose', trimmed));
    });
    return wrap;
  }

  // ── lesson card (student dashboard) ────────────────────────────────────────

  /**
   * @param lesson   summary record from the API
   * @param progress {percent, completed} or null
   * @param onOpen   callback given the lesson id
   */
  function renderCard(lesson, progress, onOpen) {
    var pct = progress && progress.percent ? Math.max(0, Math.min(100, progress.percent)) : 0;
    var done = !!(progress && progress.completed);
    if (done) pct = 100;

    var card = el('article', 'fl-lesson-card');

    var thumb = safeUrl(lesson.thumbnail);
    if (thumb) {
      var img = el('img', 'fl-lesson-thumb');
      img.src = thumb;
      img.alt = '';                       // decorative; the title carries meaning
      img.loading = 'lazy';
      card.appendChild(img);
    }

    card.appendChild(el('p', 'fl-lesson-eyebrow', 'Lesson ' + padNumber(lesson.lesson_number)));

    var heading = el('h3');
    heading.appendChild(document.createTextNode(textOf(lesson.title)));
    card.appendChild(heading);

    var desc = textOf(lesson.short_description);
    if (desc) card.appendChild(el('p', 'fl-lesson-desc', desc));

    var meta = el('div', 'fl-lesson-meta');
    if (textOf(lesson.level)) meta.appendChild(el('span', 'fl-lesson-level', lesson.level));
    if (Number(lesson.duration) > 0) {
      var dur = el('span');
      dur.appendChild(icon('fa-regular fa-clock'));
      dur.appendChild(document.createTextNode(' ' + Number(lesson.duration) + ' min'));
      meta.appendChild(dur);
    }
    if (lesson.has_video) {
      var vid = el('span');
      vid.appendChild(icon('fa-brands fa-youtube'));
      vid.appendChild(document.createTextNode(' Video'));
      meta.appendChild(vid);
    }
    if (meta.childNodes.length) card.appendChild(meta);

    // Progress row. Completion is shown with an icon and words, never colour alone.
    if (done) {
      var doneRow = el('p', 'fl-lesson-status is-done');
      doneRow.appendChild(icon('fa-solid fa-circle-check'));
      doneRow.appendChild(document.createTextNode(' Completed'));
      card.appendChild(doneRow);
    } else if (pct > 0) {
      card.appendChild(buildProgressRow(pct, false));
    }

    var btn = el('button', done ? 'btn' : 'btn btn-primary');
    btn.type = 'button';
    btn.appendChild(icon(done ? 'fa-solid fa-rotate-right' : 'fa-solid fa-arrow-right'));
    btn.appendChild(document.createTextNode(
      done ? ' Review Lesson' : (pct > 0 ? ' Continue Lesson' : ' Start Lesson')
    ));
    btn.setAttribute('aria-label',
      (done ? 'Review' : (pct > 0 ? 'Continue' : 'Start')) + ' lesson ' +
      padNumber(lesson.lesson_number) + ': ' + textOf(lesson.title));
    btn.addEventListener('click', function () {
      if (typeof onOpen === 'function') onOpen(lesson.id);
    });
    card.appendChild(btn);

    return card;
  }

  function buildProgressRow(pct, completed) {
    var row = el('div', 'fl-lesson-progress');
    var track = el('div', 'fl-lesson-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(pct));
    track.setAttribute('aria-label', 'Lesson progress');
    var bar = el('span', completed ? 'fl-lesson-bar is-done' : 'fl-lesson-bar');
    track.appendChild(bar);
    row.appendChild(track);
    row.appendChild(el('span', null, pct + '%'));
    // Width is set on the next frame so the bar animates from zero.
    requestAnimationFrame(function () { bar.style.width = pct + '%'; });
    return row;
  }

  function padNumber(n) {
    var num = Number(n) || 0;
    return num < 10 ? '0' + num : String(num);
  }

  // ── full lesson ────────────────────────────────────────────────────────────

  /**
   * Renders a complete lesson into `container`.
   *
   * options:
   *   position, total     – "Lesson 2 of 6" line
   *   prev, next          – summaries, or null; nav is omitted when both are null
   *   onOpenLesson(id)    – prev/next handler
   *   progress            – {percent, completed}
   *   onMarkComplete()    – shows the completion button when supplied
   *   preview             – true in the admin preview: no progress, no prev/next
   */
  function renderLesson(container, lesson, options) {
    var opts = options || {};
    clearNode(container);
    if (!lesson) return;

    var article = el('article', 'fl-lesson-body fl-fade-in');

    // ── header ──
    var header = el('header', 'fl-lesson-section');
    header.appendChild(el('p', 'fl-lesson-eyebrow', 'Lesson ' + padNumber(lesson.lesson_number)));
    header.appendChild(el('h1', 'fl-lesson-title', textOf(lesson.title)));

    var subhead = el('div', 'fl-lesson-subhead');
    if (textOf(lesson.level)) subhead.appendChild(el('span', 'fl-lesson-level', lesson.level));
    if (Number(lesson.duration) > 0) {
      var d = el('span');
      d.appendChild(icon('fa-regular fa-clock'));
      d.appendChild(document.createTextNode(' ' + Number(lesson.duration) + ' minutes'));
      subhead.appendChild(d);
    }
    if (opts.position && opts.total) {
      subhead.appendChild(el('span', null, 'Lesson ' + opts.position + ' of ' + opts.total));
    }
    if (subhead.childNodes.length) header.appendChild(subhead);

    var intro = textOf(lesson.description) || textOf(lesson.short_description);
    if (intro) {
      intro.split(/\n{2,}/).forEach(function (para) {
        var t = para.trim();
        if (t) header.appendChild(el('p', 'fl-prose', t));
      });
    }
    article.appendChild(header);

    // ── learning objectives ──
    var objectives = Array.isArray(lesson.learning_objectives) ? lesson.learning_objectives : [];
    if (objectives.length) {
      var objSection = makeSection('Learning Objectives');
      objSection.appendChild(el('p', null, 'By the end of this lesson, you will be able to:'));
      var list = el('ul', 'fl-objectives');
      objectives.forEach(function (o) {
        var text = textOf(typeof o === 'string' ? o : (o && o.text));
        if (!text) return;
        var li = el('li');
        li.appendChild(icon('fa-solid fa-check'));
        li.appendChild(el('span', null, text));
        list.appendChild(li);
      });
      if (list.childNodes.length) {
        objSection.appendChild(list);
        article.appendChild(objSection);
      }
    }

    // ── main content blocks ──
    var blocks = Array.isArray(lesson.content) ? lesson.content : [];
    if (blocks.length) {
      var contentSection = makeSection('Lesson Content');
      blocks.forEach(function (b) {
        var node = buildBlock(b);
        if (node) contentSection.appendChild(node);
      });
      article.appendChild(contentSection);
    }

    // ── vocabulary ──
    var vocab = Array.isArray(lesson.vocabulary) ? lesson.vocabulary : [];
    if (vocab.length) {
      var vocabSection = makeSection('Vocabulary');
      var grid = el('div', 'fl-vocab-grid');
      vocab.forEach(function (v) {
        if (!v || !textOf(v.word)) return;
        var cardEl = el('div', 'fl-vocab-card');
        var wordLine = el('p', null);
        wordLine.style.margin = '0';
        wordLine.appendChild(el('span', 'fl-vocab-word', textOf(v.word)));
        if (textOf(v.pronunciation)) {
          wordLine.appendChild(el('span', 'fl-vocab-pron', '/' + textOf(v.pronunciation) + '/'));
        }
        cardEl.appendChild(wordLine);
        if (textOf(v.meaning)) cardEl.appendChild(el('p', 'fl-vocab-meaning', textOf(v.meaning)));
        if (textOf(v.example)) cardEl.appendChild(el('p', 'fl-vocab-example', '“' + textOf(v.example) + '”'));
        grid.appendChild(cardEl);
      });
      vocabSection.appendChild(grid);
      article.appendChild(vocabSection);
    }

    // ── examples ──
    var examples = Array.isArray(lesson.examples) ? lesson.examples : [];
    if (examples.length) {
      var exSection = makeSection('Examples');
      examples.forEach(function (x) {
        if (!x || !textOf(x.english)) return;
        var row = el('div', 'fl-example-row');
        row.appendChild(el('span', 'fl-example-label', 'English'));
        row.appendChild(el('p', 'fl-example-en', textOf(x.english)));
        // The translation block is skipped entirely when there is no translation.
        if (textOf(x.translation)) {
          var trWrap = el('div', 'fl-example-tr');
          trWrap.appendChild(el('span', 'fl-example-label', 'Meaning'));
          trWrap.appendChild(el('p', null, textOf(x.translation)));
          row.appendChild(trWrap);
        }
        exSection.appendChild(row);
      });
      article.appendChild(exSection);
    }

    // ── exercises ──
    var exercises = Array.isArray(lesson.exercises) ? lesson.exercises : [];
    if (exercises.length) {
      var practice = makeSection('Practice');
      exercises.forEach(function (x, idx) {
        if (!x || !textOf(x.prompt)) return;
        var box = el('div', 'fl-exercise');
        box.appendChild(el('p', 'fl-exercise-prompt', (idx + 1) + '. ' + textOf(x.prompt)));
        if (textOf(x.answer)) {
          var details = el('details');
          details.appendChild(el('summary', null, 'Show answer'));
          details.appendChild(el('p', 'fl-exercise-answer', textOf(x.answer)));
          box.appendChild(details);
        }
        practice.appendChild(box);
      });
      article.appendChild(practice);
    }

    // ── video (omitted entirely when there is no valid URL) ──
    var videoId = youTubeId(lesson.youtube_url);
    if (videoId) {
      var videoSection = makeSection('Additional Resource');
      videoSection.appendChild(el('p', null, 'Watch the explanation:'));
      videoSection.appendChild(buildVideo(videoId, textOf(lesson.title)));
      article.appendChild(videoSection);
    }

    // ── extra resources ──
    var resources = Array.isArray(lesson.additional_resources) ? lesson.additional_resources : [];
    if (resources.length) {
      var resSection = makeSection('More Resources');
      var resList = el('ul', 'fl-resource-list');
      resources.forEach(function (r) {
        var href = r && safeUrl(r.url);
        if (!href) return;
        var li = el('li');
        var a = el('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.appendChild(icon('fa-solid fa-arrow-up-right-from-square'));
        a.appendChild(document.createTextNode(' ' + (textOf(r.label) || href)));
        li.appendChild(a);
        resList.appendChild(li);
      });
      if (resList.childNodes.length) {
        resSection.appendChild(resList);
        article.appendChild(resSection);
      }
    }

    // ── progress + completion (student only) ──
    if (!opts.preview && typeof opts.onMarkComplete === 'function') {
      var progressSection = makeSection('Your Progress');
      var pr = opts.progress || {};
      var pct = pr.completed ? 100 : Math.max(0, Math.min(100, Number(pr.percent) || 0));
      progressSection.appendChild(buildProgressRow(pct, !!pr.completed));

      var completeBtn = el('button', pr.completed ? 'btn' : 'btn btn-primary');
      completeBtn.type = 'button';
      completeBtn.id = 'flMarkCompleteBtn';
      completeBtn.style.marginTop = '1rem';
      setCompleteButtonLabel(completeBtn, !!pr.completed);
      completeBtn.addEventListener('click', function () {
        opts.onMarkComplete();
      });
      progressSection.appendChild(completeBtn);
      article.appendChild(progressSection);
    }

    // ── previous / next (published lessons only; missing ends are omitted) ──
    if (!opts.preview && (opts.prev || opts.next)) {
      var navWrap = el('nav', 'fl-lesson-nav');
      navWrap.setAttribute('aria-label', 'Lesson navigation');
      if (opts.prev) navWrap.appendChild(buildNavButton(opts.prev, 'prev', opts.onOpenLesson));
      if (opts.next) navWrap.appendChild(buildNavButton(opts.next, 'next', opts.onOpenLesson));
      article.appendChild(navWrap);
    }

    container.appendChild(article);
    return article;
  }

  function setCompleteButtonLabel(btn, completed) {
    clearNode(btn);
    btn.appendChild(icon(completed ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle-check'));
    btn.appendChild(document.createTextNode(completed ? ' Completed — mark as unread' : ' Mark as completed'));
    btn.className = completed ? 'btn' : 'btn btn-primary';
    btn.style.marginTop = '1rem';
  }

  function buildNavButton(target, direction, onOpen) {
    var btn = el('button', 'btn');
    btn.type = 'button';
    if (direction === 'prev') {
      btn.appendChild(icon('fa-solid fa-arrow-left'));
      btn.appendChild(document.createTextNode(' Previous: ' + textOf(target.title)));
    } else {
      btn.appendChild(document.createTextNode('Next: ' + textOf(target.title) + ' '));
      btn.appendChild(icon('fa-solid fa-arrow-right'));
    }
    btn.addEventListener('click', function () {
      if (typeof onOpen === 'function') onOpen(target.id);
    });
    return btn;
  }

  global.FluencyLessonView = {
    renderLesson: renderLesson,
    renderCard: renderCard,
    setCompleteButtonLabel: setCompleteButtonLabel,
    buildProgressRow: buildProgressRow,
    youTubeId: youTubeId,
    padNumber: padNumber,
    el: el,
    icon: icon,
    clearNode: clearNode
  };
})(window);
