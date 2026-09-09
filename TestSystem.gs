/* ══════════════════════════════════════════════════════════════════════════════
   FLUENCY — TEST SYSTEM (backend)

   A self-contained timed-test module. It lives in its own Apps Script file and
   only *reads* from the existing systems (LessonsLibrary, for importing
   exercise prompts). Nothing here writes to lessons_data, LessonsLibrary,
   Submissions or any other existing sheet.

   Shared helpers from Code.gs are reused as-is: getOrCreate, styleHeader,
   stripe, normalizeEmail, buildJsonResponse, requireAdmin, EMAIL_RE.

   SECURITY MODEL
   Correct answers never leave this file for a student browser. startTestAttempt
   returns question text and options only; submitTest scores server-side by
   reading the stored answer key. Scores, percentages, statuses and timings sent
   by a browser are ignored entirely.
   ══════════════════════════════════════════════════════════════════════════════ */

// ── sheets ────────────────────────────────────────────────────────────────────

const SHEET_TESTS = 'Tests';
const SHEET_TEST_QUESTIONS = 'Test Questions';
const SHEET_TEST_SUBMISSIONS = 'Test Submissions';
// Not in the original spec, but an attempt row is what makes refresh-recovery,
// server-side duration checks and duplicate-submission rejection possible.
const SHEET_TEST_ATTEMPTS = 'Test Attempts';

const TEST_HEADERS = [
  'Test ID', 'Test Name', 'Description', 'Test Code',
  'Start Date', 'Start Time', 'End Date', 'End Time',
  'Duration Minutes', 'Total Marks', 'Questions Count',
  'One Attempt', 'Randomize Questions', 'Randomize Answers',
  'Show Result Immediately', 'Status', 'Created By', 'Created At', 'Updated At'
];

const TEST_QUESTION_HEADERS = [
  'Test ID', 'Question ID', 'Lesson Number', 'Question',
  'Option A', 'Option B', 'Option C', 'Option D',
  'Correct Answer', 'Marks', 'Question Order', 'Created At'
];

const TEST_SUBMISSION_HEADERS = [
  'Submission ID', 'Test ID', 'Test Name', 'Student Name', 'Student Email',
  'Start Time', 'Submit Time', 'Duration Used', 'Score', 'Total Marks',
  'Percentage', 'Correct Answers', 'Incorrect Answers', 'Unanswered',
  'Submission Type', 'Status', 'Answers', 'Created At'
];

const TEST_ATTEMPT_HEADERS = [
  'Attempt ID', 'Test ID', 'Student Name', 'Student Email',
  'Start Time', 'Expires At', 'Layout', 'Status', 'Created At'
];

// ── constants ─────────────────────────────────────────────────────────────────

const TEST_TIMEZONE = 'Asia/Riyadh';        // fixed UTC+3, no DST
const TEST_TZ_OFFSET_MIN = 180;

const TEST_STORED_STATUSES = ['draft', 'published', 'disabled'];
const TEST_OPTION_LETTERS = ['A', 'B', 'C', 'D'];

// A late submission is still accepted, but anything past this is recorded as an
// automatic submission — clocks and last-request latency are never exact.
const TEST_SUBMIT_GRACE_MS = 45 * 1000;

const TEST_MAX_QUESTIONS = 200;
const TEST_LOCK_MS = 15 * 1000;

/** Thrown for messages a student or admin should see verbatim. */
function testError(message) {
  const err = new Error(message);
  err.isTestMessage = true;
  return err;
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTING — called from doGet / doPost in Code.gs
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Public (student) GET actions. Returns null when the action is not ours, so
 * the caller falls through to its own routing.
 */
function testSystemHandleGet(ss, e) {
  const action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
  if (action === 'getAvailableTests') {
    return testPublicCall('getAvailableTests', function () {
      return getAvailableTestsResponse(ss);
    });
  }
  if (action === 'getTestServerTime') {
    return { success: true, now: new Date().toISOString(), timezone: TEST_TIMEZONE };
  }
  return null;
}

/**
 * Public + admin POST actions. Returns null when the action is not ours.
 */
function testSystemHandlePost(ss, payload) {
  const action = (payload && payload.action) || '';

  switch (action) {
    // ── student ──────────────────────────────────────────────────────────────
    case 'startTestAttempt':
      return testPublicCall('startTestAttempt', function () {
        return startTestAttempt(ss, payload);
      });
    case 'resumeTestAttempt':
      return testPublicCall('resumeTestAttempt', function () {
        return resumeTestAttempt(ss, payload);
      });
    case 'submitTest':
      return testPublicCall('submitTest', function () {
        return submitTest(ss, payload);
      });

    // ── admin ────────────────────────────────────────────────────────────────
    case 'adminGetTests':
      return runTestAdminAction(payload.adminToken, 'adminGetTests', function () {
        return adminGetTests(ss);
      });
    case 'adminGetTest':
      return runTestAdminAction(payload.adminToken, 'adminGetTest', function () {
        return adminGetTest(ss, payload.testId);
      });
    case 'adminSaveTest':
      return runTestAdminAction(payload.adminToken, 'adminSaveTest', function () {
        return adminSaveTest(ss, payload.test);
      });
    case 'adminSetTestStatus':
      return runTestAdminAction(payload.adminToken, 'adminSetTestStatus', function () {
        return adminSetTestStatus(ss, payload.testId, payload.status);
      });
    case 'adminDeleteTest':
      return runTestAdminAction(payload.adminToken, 'adminDeleteTest', function () {
        return adminDeleteTest(ss, payload.testId);
      });
    case 'adminGetTestQuestions':
      return runTestAdminAction(payload.adminToken, 'adminGetTestQuestions', function () {
        return adminGetTestQuestions(ss, payload.testId);
      });
    case 'adminSaveTestQuestions':
      return runTestAdminAction(payload.adminToken, 'adminSaveTestQuestions', function () {
        return adminSaveTestQuestions(ss, payload.testId, payload.questions);
      });
    case 'adminGetLessonExercises':
      return runTestAdminAction(payload.adminToken, 'adminGetLessonExercises', function () {
        return adminGetLessonExercises(ss, payload.lessonIds);
      });
    case 'adminGetTestSubmissions':
      return runTestAdminAction(payload.adminToken, 'adminGetTestSubmissions', function () {
        return adminGetTestSubmissions(ss, payload.testId);
      });
    case 'adminGetTestSubmission':
      return runTestAdminAction(payload.adminToken, 'adminGetTestSubmission', function () {
        return adminGetTestSubmission(ss, payload.submissionId);
      });
    default:
      return null;
  }
}

/**
 * Wraps an admin handler. Behaves like runAdminAction — the token is required
 * and unexpected errors stay in the log — but a message raised with testError()
 * is a validation result the admin needs to read, so it is passed through
 * verbatim instead of being flattened to "something went wrong".
 */
function runTestAdminAction(token, label, fn) {
  try {
    requireAdmin(token);
  } catch (authErr) {
    Logger.log('🔒 Unauthorized attempt: ' + label);
    return { success: false, error: 'Not authorized.', code: 401 };
  }
  try {
    return fn();
  } catch (err) {
    if (err && err.isTestMessage) return { success: false, error: err.message };
    Logger.log('❌ ' + label + ' failed: ' + err + (err.stack ? '\n' + err.stack : ''));
    return { success: false, error: 'Something went wrong. Please try again.', action: label };
  }
}

/**
 * Wraps a student-facing handler. Messages built with testError() are shown to
 * the student; anything else is logged and replaced with a generic message, so
 * no stack or sheet detail reaches a browser.
 */
function testPublicCall(label, fn) {
  try {
    return fn();
  } catch (err) {
    if (err && err.isTestMessage) {
      return { success: false, error: err.message };
    }
    Logger.log('❌ test/' + label + ' failed: ' + err + (err.stack ? '\n' + err.stack : ''));
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHEET ACCESS
// ══════════════════════════════════════════════════════════════════════════════

function testsSheet(ss) {
  return getOrCreate(masterSpreadsheet(ss), SHEET_TESTS, TEST_HEADERS);
}
function testQuestionsSheet(ss) {
  return getOrCreate(masterSpreadsheet(ss), SHEET_TEST_QUESTIONS, TEST_QUESTION_HEADERS);
}
function testSubmissionsSheet(ss) {
  return getOrCreate(masterSpreadsheet(ss), SHEET_TEST_SUBMISSIONS, TEST_SUBMISSION_HEADERS);
}
function testAttemptsSheet(ss) {
  return getOrCreate(masterSpreadsheet(ss), SHEET_TEST_ATTEMPTS, TEST_ATTEMPT_HEADERS);
}

/** Run once from the Apps Script editor to create the four sheets up front. */
function setupTestSystem() {
  const ss = SpreadsheetApp.openById(MASTER_SHEET_ID);
  testsSheet(ss);
  testQuestionsSheet(ss);
  testSubmissionsSheet(ss);
  testAttemptsSheet(ss);
  Logger.log('✅ Test System sheets ready.');
}

/** Reads a whole sheet as objects keyed by its header row. */
function testReadRows(sheet, headers) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (!values[i][0]) continue;                       // blank row
    const obj = { _row: i + 2 };
    for (let c = 0; c < headers.length; c++) {
      let v = values[i][c];
      if (v instanceof Date) v = v.toISOString();
      obj[headers[c]] = v;
    }
    out.push(obj);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// TIME — everything schedules in Asia/Riyadh regardless of the viewer's device
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Converts a Riyadh wall-clock date + time into an absolute Date.
 * Riyadh is a fixed UTC+3 with no daylight saving, so the arithmetic is exact.
 */
function riyadhToDate(dateStr, timeStr) {
  const d = String(dateStr || '').trim();
  const t = String(timeStr || '').trim() || '00:00';
  const dm = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!dm || !tm) return null;

  const year = Number(dm[1]), month = Number(dm[2]), day = Number(dm[3]);
  const hour = Number(tm[1]), minute = Number(tm[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  const ms = Date.UTC(year, month - 1, day, hour, minute, 0) - TEST_TZ_OFFSET_MIN * 60 * 1000;
  const out = new Date(ms);
  return isNaN(out.getTime()) ? null : out;
}

/** "September 9, 2026 — 7:00 PM", always in Riyadh time. */
function formatRiyadh(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, TEST_TIMEZONE, 'MMMM d, yyyy') +
    ' — ' + Utilities.formatDate(date, TEST_TIMEZONE, 'h:mm a');
}

function testNormalizeDateInput(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // A sheet round-trip can hand back an ISO timestamp; keep the calendar day
  // as seen in Riyadh.
  const d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, TEST_TIMEZONE, 'yyyy-MM-dd');
}

function testNormalizeTimeInput(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return '';
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    const h = Math.min(23, Number(m[1]));
    return ('0' + h).slice(-2) + ':' + m[2];
  }
  const d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, TEST_TIMEZONE, 'HH:mm');
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST RECORDS
// ══════════════════════════════════════════════════════════════════════════════

function testRowToObject(row) {
  return {
    _row: row._row,
    id: String(row['Test ID'] || ''),
    name: String(row['Test Name'] || ''),
    description: String(row['Description'] || ''),
    code: String(row['Test Code'] || ''),
    startDate: testNormalizeDateInput(row['Start Date']),
    startTime: testNormalizeTimeInput(row['Start Time']),
    endDate: testNormalizeDateInput(row['End Date']),
    endTime: testNormalizeTimeInput(row['End Time']),
    durationMinutes: Number(row['Duration Minutes']) || 0,
    totalMarks: Number(row['Total Marks']) || 0,
    questionsCount: Number(row['Questions Count']) || 0,
    oneAttempt: testToBool(row['One Attempt'], true),
    randomizeQuestions: testToBool(row['Randomize Questions'], false),
    randomizeAnswers: testToBool(row['Randomize Answers'], false),
    showResultImmediately: testToBool(row['Show Result Immediately'], true),
    status: String(row['Status'] || 'draft').toLowerCase(),
    createdBy: String(row['Created By'] || ''),
    createdAt: String(row['Created At'] || ''),
    updatedAt: String(row['Updated At'] || '')
  };
}

function testObjectToRow(t) {
  return [
    t.id, t.name, t.description, t.code,
    t.startDate, t.startTime, t.endDate, t.endTime,
    t.durationMinutes, t.totalMarks, t.questionsCount,
    t.oneAttempt ? 'TRUE' : 'FALSE',
    t.randomizeQuestions ? 'TRUE' : 'FALSE',
    t.randomizeAnswers ? 'TRUE' : 'FALSE',
    t.showResultImmediately ? 'TRUE' : 'FALSE',
    t.status, t.createdBy, t.createdAt, t.updatedAt
  ];
}

function testToBool(value, fallback) {
  if (value === true || value === false) return value;
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (s === '') return !!fallback;
  return s === 'true' || s === 'yes' || s === '1' || s === 'on';
}

function readTests(ss) {
  return testReadRows(testsSheet(ss), TEST_HEADERS).map(testRowToObject);
}

function findTestById(ss, id) {
  const wanted = String(id || '').trim();
  if (!wanted) return null;
  const all = readTests(ss);
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === wanted) return all[i];
  }
  return null;
}

/**
 * The status a student and admin actually see, derived from the schedule.
 * The stored status only says whether the admin has published or disabled it.
 */
function computeTestStatus(test, now) {
  const at = now || new Date();
  if (test.status === 'disabled') return 'disabled';
  if (test.status !== 'published') return 'draft';

  const start = riyadhToDate(test.startDate, test.startTime);
  const end = riyadhToDate(test.endDate, test.endTime);
  if (!start || !end) return 'draft';              // an unschedulable test is not live
  if (at.getTime() < start.getTime()) return 'upcoming';
  if (at.getTime() > end.getTime()) return 'closed';
  return 'active';
}

/** The student-safe view of a test. Never includes the test code. */
function publicTestSummary(test, now) {
  const start = riyadhToDate(test.startDate, test.startTime);
  const end = riyadhToDate(test.endDate, test.endTime);
  return {
    id: test.id,
    name: test.name,
    description: test.description,
    durationMinutes: test.durationMinutes,
    questionsCount: test.questionsCount,
    totalMarks: test.totalMarks,
    status: computeTestStatus(test, now),
    startsAt: start ? start.toISOString() : '',
    endsAt: end ? end.toISOString() : '',
    startsAtLabel: formatRiyadh(start),
    endsAtLabel: formatRiyadh(end),
    timezone: TEST_TIMEZONE
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// QUESTIONS
// ══════════════════════════════════════════════════════════════════════════════

function questionRowToObject(row) {
  return {
    _row: row._row,
    testId: String(row['Test ID'] || ''),
    id: String(row['Question ID'] || ''),
    lessonNumber: String(row['Lesson Number'] || ''),
    question: String(row['Question'] || ''),
    optionA: String(row['Option A'] || ''),
    optionB: String(row['Option B'] || ''),
    optionC: String(row['Option C'] || ''),
    optionD: String(row['Option D'] || ''),
    correctAnswer: String(row['Correct Answer'] || 'A').trim().toUpperCase(),
    marks: Number(row['Marks']) || 1,
    order: Number(row['Question Order']) || 0,
    createdAt: String(row['Created At'] || '')
  };
}

function questionObjectToRow(q) {
  return [
    q.testId, q.id, q.lessonNumber, q.question,
    q.optionA, q.optionB, q.optionC, q.optionD,
    q.correctAnswer, q.marks, q.order, q.createdAt
  ];
}

function readTestQuestions(ss, testId) {
  const wanted = String(testId || '').trim();
  const all = testReadRows(testQuestionsSheet(ss), TEST_QUESTION_HEADERS).map(questionRowToObject);
  const mine = wanted ? all.filter(function (q) { return q.testId === wanted; }) : all;
  return mine.sort(function (a, b) { return a.order - b.order; });
}

/** Strips the answer key. This is the only question shape a student receives. */
function studentQuestion(q, optionOrder) {
  const source = [q.optionA, q.optionB, q.optionC, q.optionD];
  const options = optionOrder.map(function (originalIndex) {
    return source[originalIndex];
  });
  return {
    id: q.id,
    lessonNumber: q.lessonNumber,
    question: q.question,
    options: options,
    marks: q.marks
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// STUDENT — LIST
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Every test the admin has published, with its computed status. Drafts and
 * disabled tests are omitted entirely, and no test code is ever included.
 */
function getAvailableTestsResponse(ss) {
  const now = new Date();
  const visible = readTests(ss).filter(function (t) {
    const status = computeTestStatus(t, now);
    return status === 'upcoming' || status === 'active' || status === 'closed';
  });

  visible.sort(function (a, b) {
    const rank = { active: 0, upcoming: 1, closed: 2 };
    const ra = rank[computeTestStatus(a, now)];
    const rb = rank[computeTestStatus(b, now)];
    if (ra !== rb) return ra - rb;
    const sa = riyadhToDate(a.startDate, a.startTime);
    const sb = riyadhToDate(b.startDate, b.startTime);
    return (sa ? sa.getTime() : 0) - (sb ? sb.getTime() : 0);
  });

  return {
    success: true,
    now: now.toISOString(),
    timezone: TEST_TIMEZONE,
    data: visible.map(function (t) { return publicTestSummary(t, now); })
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// STUDENT — START AN ATTEMPT
// ══════════════════════════════════════════════════════════════════════════════

function validateStudentIdentity(payload) {
  const name = String((payload && payload.studentName) || '').trim();
  if (!name) throw testError('Please enter your full name.');
  if (name.length > 120) throw testError('Please enter your full name.');

  const email = normalizeEmail(payload && payload.studentEmail);
  if (!email) throw testError('Please enter a valid email address.');
  if (!EMAIL_RE.test(email)) throw testError('Please enter a valid email address.');

  return { name: name, email: email };
}

/**
 * Verifies identity, code, schedule and attempt allowance, then creates an
 * attempt row and returns the questions without their answers.
 */
function startTestAttempt(ss, payload) {
  const who = validateStudentIdentity(payload);
  const test = findTestById(ss, payload && payload.testId);
  if (!test) throw testError('This test could not be found.');

  const now = new Date();
  const status = computeTestStatus(test, now);

  // The code is checked before the schedule so a wrong code never reveals when
  // a test runs, but after existence so the message stays honest.
  const providedCode = String((payload && payload.testCode) || '').trim();
  if (!providedCode) throw testError('Please enter the test code.');
  if (providedCode.toUpperCase() !== String(test.code || '').trim().toUpperCase()) {
    throw testError('Incorrect test code. Please check the code and try again.');
  }

  if (status === 'draft' || status === 'disabled') {
    throw testError('This test is not available.');
  }
  if (status === 'upcoming') {
    throw testError('This test has not started yet. It starts on ' +
      formatRiyadh(riyadhToDate(test.startDate, test.startTime)) + '.');
  }
  if (status === 'closed') {
    throw testError('This test is no longer available. It ended on ' +
      formatRiyadh(riyadhToDate(test.endDate, test.endTime)) + '.');
  }

  const questions = readTestQuestions(ss, test.id);
  if (!questions.length) throw testError('This test has no questions yet. Please contact your teacher.');

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(TEST_LOCK_MS);
  } catch (e) {
    throw testError('The service is busy. Please try again in a moment.');
  }

  try {
    if (test.oneAttempt && findSubmissionForStudent(ss, test.id, who.email)) {
      throw testError('You have already completed this test.');
    }

    // An unfinished attempt is resumed rather than duplicated, so a refresh
    // or a reopened tab never burns the student's single attempt.
    const existing = findActiveAttempt(ss, test.id, who.email, now);
    if (existing) {
      return buildAttemptResponse(test, questions, existing, now, true);
    }

    const attempt = createAttempt(ss, test, questions, who, now);
    return buildAttemptResponse(test, questions, attempt, now, false);
  } finally {
    lock.releaseLock();
  }
}

/** Recovers an attempt after a refresh, without re-entering the code. */
function resumeTestAttempt(ss, payload) {
  const attemptId = String((payload && payload.attemptId) || '').trim();
  if (!attemptId) throw testError('No attempt to resume.');

  const attempt = findAttemptById(ss, attemptId);
  if (!attempt) throw testError('No attempt to resume.');
  if (attempt.status !== 'active') throw testError('This attempt has already been submitted.');

  const test = findTestById(ss, attempt.testId);
  if (!test) throw testError('This test could not be found.');

  const now = new Date();
  const questions = readTestQuestions(ss, test.id);
  if (!questions.length) throw testError('This test has no questions yet.');

  return buildAttemptResponse(test, questions, attempt, now, true);
}

function createAttempt(ss, test, questions, who, now) {
  const attemptId = 'A' + Utilities.getUuid().replace(/-/g, '').substring(0, 20);

  // The layout is decided once, server-side, and stored — so a reload shows the
  // same paper, and submitted letters can be mapped back to the real options.
  const order = questions.map(function (q, i) { return i; });
  if (test.randomizeQuestions) testShuffle(order);

  const layout = order.map(function (index) {
    const optionOrder = [0, 1, 2, 3];
    if (test.randomizeAnswers) testShuffle(optionOrder);
    return { q: questions[index].id, o: optionOrder };
  });

  // The deadline is the sooner of the student's own duration and the test's end.
  const durationEnd = new Date(now.getTime() + test.durationMinutes * 60 * 1000);
  const windowEnd = riyadhToDate(test.endDate, test.endTime);
  const expiresAt = (windowEnd && windowEnd.getTime() < durationEnd.getTime()) ? windowEnd : durationEnd;

  const sheet = testAttemptsSheet(ss);
  sheet.appendRow([
    attemptId, test.id, who.name, who.email,
    now.toISOString(), expiresAt.toISOString(),
    JSON.stringify(layout), 'active', now.toISOString()
  ]);
  stripe(sheet, TEST_ATTEMPT_HEADERS.length);

  return {
    id: attemptId,
    testId: test.id,
    studentName: who.name,
    studentEmail: who.email,
    startTime: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    layout: layout,
    status: 'active'
  };
}

function buildAttemptResponse(test, questions, attempt, now, resumed) {
  const byId = {};
  questions.forEach(function (q) { byId[q.id] = q; });

  const paper = [];
  attempt.layout.forEach(function (entry) {
    const q = byId[entry.q];
    if (q) paper.push(studentQuestion(q, entry.o));   // a deleted question just drops out
  });

  const expires = new Date(attempt.expiresAt);
  const remainingMs = Math.max(0, expires.getTime() - now.getTime());

  return {
    success: true,
    resumed: !!resumed,
    attemptId: attempt.id,
    now: now.toISOString(),
    expiresAt: attempt.expiresAt,
    remainingSeconds: Math.floor(remainingMs / 1000),
    test: {
      id: test.id,
      name: test.name,
      description: test.description,
      durationMinutes: test.durationMinutes,
      totalMarks: test.totalMarks,
      questionsCount: paper.length,
      showResultImmediately: test.showResultImmediately
    },
    questions: paper
  };
}

function testShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

// ── attempt lookups ───────────────────────────────────────────────────────────

function attemptRowToObject(row) {
  let layout = [];
  try {
    const parsed = JSON.parse(String(row['Layout'] || '[]'));
    if (Array.isArray(parsed)) layout = parsed;
  } catch (e) { /* an unreadable layout is treated as empty */ }

  return {
    _row: row._row,
    id: String(row['Attempt ID'] || ''),
    testId: String(row['Test ID'] || ''),
    studentName: String(row['Student Name'] || ''),
    studentEmail: normalizeEmail(row['Student Email']),
    startTime: String(row['Start Time'] || ''),
    expiresAt: String(row['Expires At'] || ''),
    layout: layout,
    status: String(row['Status'] || 'active').toLowerCase()
  };
}

function readAttempts(ss) {
  return testReadRows(testAttemptsSheet(ss), TEST_ATTEMPT_HEADERS).map(attemptRowToObject);
}

function findAttemptById(ss, attemptId) {
  const wanted = String(attemptId || '').trim();
  if (!wanted) return null;
  const all = readAttempts(ss);
  for (let i = all.length - 1; i >= 0; i--) {          // newest first
    if (all[i].id === wanted) return all[i];
  }
  return null;
}

/** An attempt that is still open and not past its deadline. */
function findActiveAttempt(ss, testId, email, now) {
  const all = readAttempts(ss);
  for (let i = all.length - 1; i >= 0; i--) {
    const a = all[i];
    if (a.testId !== testId || a.studentEmail !== email || a.status !== 'active') continue;
    const expires = new Date(a.expiresAt);
    if (isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) continue;
    return a;
  }
  return null;
}

function markAttemptStatus(ss, attempt, status) {
  if (!attempt || !attempt._row) return;
  const col = TEST_ATTEMPT_HEADERS.indexOf('Status') + 1;
  testAttemptsSheet(ss).getRange(attempt._row, col).setValue(status);
}

// ══════════════════════════════════════════════════════════════════════════════
// STUDENT — SUBMIT
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Scores server-side against the stored answer key. Everything the browser
 * sends except the chosen letters is ignored.
 */
function submitTest(ss, payload) {
  const attemptId = String((payload && payload.attemptId) || '').trim();
  if (!attemptId) throw testError('Your submission could not be identified. Please start the test again.');

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(TEST_LOCK_MS);
  } catch (e) {
    throw testError('The service is busy. Please try again in a moment.');
  }

  try {
    const attempt = findAttemptById(ss, attemptId);
    if (!attempt) throw testError('Your submission could not be identified. Please start the test again.');

    // A double click, a retried request or a reopened tab all land here.
    const already = findSubmissionByAttempt(ss, attemptId);
    if (already) {
      return buildSubmissionResponse(ss, already, findTestById(ss, attempt.testId));
    }

    const test = findTestById(ss, attempt.testId);
    if (!test) throw testError('This test could not be found.');

    if (test.oneAttempt) {
      const prior = findSubmissionForStudent(ss, test.id, attempt.studentEmail);
      if (prior) {
        markAttemptStatus(ss, attempt, 'superseded');
        throw testError('You have already completed this test.');
      }
    }

    const now = new Date();
    const startedAt = new Date(attempt.startTime);
    const expiresAt = new Date(attempt.expiresAt);
    const elapsedMs = Math.max(0, now.getTime() - startedAt.getTime());

    // The client says how it submitted, but the server decides: anything past
    // the deadline is an automatic submission no matter what was claimed.
    const claimedAuto = !!(payload && payload.autoSubmitted);
    const lateBy = now.getTime() - expiresAt.getTime();
    const isAuto = claimedAuto || lateBy > TEST_SUBMIT_GRACE_MS;

    const answers = (payload && payload.answers && typeof payload.answers === 'object')
      ? payload.answers : {};

    const scored = scoreAttempt(ss, test, attempt, answers);

    // Time counted never exceeds what the student was actually allowed.
    const allowedMs = Math.max(0, expiresAt.getTime() - startedAt.getTime());
    const durationUsedMs = Math.min(elapsedMs, allowedMs || elapsedMs);

    const submissionId = 'S' + Utilities.getUuid().replace(/-/g, '').substring(0, 20);
    const percentage = scored.totalMarks > 0
      ? Math.round((scored.score / scored.totalMarks) * 1000) / 10
      : 0;

    const sheet = testSubmissionsSheet(ss);
    sheet.appendRow([
      submissionId, test.id, test.name, attempt.studentName, attempt.studentEmail,
      attempt.startTime, now.toISOString(), formatDurationMinutes(durationUsedMs),
      scored.score, scored.totalMarks, percentage,
      scored.correct, scored.incorrect, scored.unanswered,
      isAuto ? 'Auto Submitted' : 'Submitted', 'Completed',
      JSON.stringify(scored.storedAnswers), now.toISOString()
    ]);
    stripe(sheet, TEST_SUBMISSION_HEADERS.length);

    markAttemptStatus(ss, attempt, 'submitted');

    return {
      success: true,
      submissionId: submissionId,
      showResult: !!test.showResultImmediately,
      submissionType: isAuto ? 'Auto Submitted' : 'Submitted',
      result: test.showResultImmediately ? {
        score: scored.score,
        totalMarks: scored.totalMarks,
        percentage: percentage,
        correct: scored.correct,
        incorrect: scored.incorrect,
        unanswered: scored.unanswered
      } : null
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Compares the student's chosen letters against the answer key.
 * Submitted letters are positions on the paper the student saw, so the stored
 * per-attempt option order is used to map each one back to the real option.
 */
function scoreAttempt(ss, test, attempt, answers) {
  const questions = readTestQuestions(ss, test.id);
  const byId = {};
  questions.forEach(function (q) { byId[q.id] = q; });

  let score = 0, totalMarks = 0, correct = 0, incorrect = 0, unanswered = 0;
  const storedAnswers = {};

  attempt.layout.forEach(function (entry) {
    const q = byId[entry.q];
    if (!q) return;                                    // question removed since the attempt began
    totalMarks += q.marks;

    const shown = String(answers[q.id] || '').trim().toUpperCase();
    const shownIndex = TEST_OPTION_LETTERS.indexOf(shown);
    if (shownIndex === -1) {
      unanswered++;
      storedAnswers[q.id] = '';
      return;
    }

    // entry.o[shownIndex] is the original option the student actually picked.
    const originalIndex = entry.o[shownIndex];
    const originalLetter = TEST_OPTION_LETTERS[originalIndex] || '';
    storedAnswers[q.id] = originalLetter;

    if (originalLetter && originalLetter === q.correctAnswer) {
      score += q.marks;
      correct++;
    } else {
      incorrect++;
    }
  });

  return {
    score: score,
    totalMarks: totalMarks,
    correct: correct,
    incorrect: incorrect,
    unanswered: unanswered,
    storedAnswers: storedAnswers
  };
}

function formatDurationMinutes(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return mins + 'm ' + secs + 's';
}

// ── submission lookups ────────────────────────────────────────────────────────

function submissionRowToObject(row) {
  let answers = {};
  try {
    const parsed = JSON.parse(String(row['Answers'] || '{}'));
    if (parsed && typeof parsed === 'object') answers = parsed;
  } catch (e) { /* unreadable answers are treated as none */ }

  return {
    _row: row._row,
    id: String(row['Submission ID'] || ''),
    testId: String(row['Test ID'] || ''),
    testName: String(row['Test Name'] || ''),
    studentName: String(row['Student Name'] || ''),
    studentEmail: normalizeEmail(row['Student Email']),
    startTime: String(row['Start Time'] || ''),
    submitTime: String(row['Submit Time'] || ''),
    durationUsed: String(row['Duration Used'] || ''),
    score: Number(row['Score']) || 0,
    totalMarks: Number(row['Total Marks']) || 0,
    percentage: Number(row['Percentage']) || 0,
    correct: Number(row['Correct Answers']) || 0,
    incorrect: Number(row['Incorrect Answers']) || 0,
    unanswered: Number(row['Unanswered']) || 0,
    submissionType: String(row['Submission Type'] || ''),
    status: String(row['Status'] || ''),
    answers: answers
  };
}

function readSubmissions(ss) {
  return testReadRows(testSubmissionsSheet(ss), TEST_SUBMISSION_HEADERS).map(submissionRowToObject);
}

function findSubmissionForStudent(ss, testId, email) {
  const all = readSubmissions(ss);
  for (let i = 0; i < all.length; i++) {
    if (all[i].testId === testId && all[i].studentEmail === email) return all[i];
  }
  return null;
}

/**
 * Submissions do not store the attempt id in a spec column, so the attempt is
 * matched on the identity that produced it: same test, same student, same
 * start time.
 */
function findSubmissionByAttempt(ss, attemptId) {
  const attempt = findAttemptById(ss, attemptId);
  if (!attempt) return null;
  const all = readSubmissions(ss);
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    if (s.testId === attempt.testId &&
      s.studentEmail === attempt.studentEmail &&
      s.startTime === attempt.startTime) {
      return s;
    }
  }
  return null;
}

function buildSubmissionResponse(ss, submission, test) {
  const show = test ? !!test.showResultImmediately : false;
  return {
    success: true,
    duplicate: true,
    submissionId: submission.id,
    showResult: show,
    submissionType: submission.submissionType,
    result: show ? {
      score: submission.score,
      totalMarks: submission.totalMarks,
      percentage: submission.percentage,
      correct: submission.correct,
      incorrect: submission.incorrect,
      unanswered: submission.unanswered
    } : null
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════════

function adminGetTests(ss) {
  const now = new Date();
  const submissions = readSubmissions(ss);
  const counts = {};
  submissions.forEach(function (s) {
    counts[s.testId] = (counts[s.testId] || 0) + 1;
  });

  const tests = readTests(ss).map(function (t) {
    const start = riyadhToDate(t.startDate, t.startTime);
    const end = riyadhToDate(t.endDate, t.endTime);
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      code: t.code,
      startDate: t.startDate, startTime: t.startTime,
      endDate: t.endDate, endTime: t.endTime,
      startsAtLabel: formatRiyadh(start),
      endsAtLabel: formatRiyadh(end),
      durationMinutes: t.durationMinutes,
      totalMarks: t.totalMarks,
      questionsCount: t.questionsCount,
      oneAttempt: t.oneAttempt,
      randomizeQuestions: t.randomizeQuestions,
      randomizeAnswers: t.randomizeAnswers,
      showResultImmediately: t.showResultImmediately,
      storedStatus: t.status,
      status: computeTestStatus(t, now),
      submissions: counts[t.id] || 0,
      updatedAt: t.updatedAt
    };
  });

  tests.sort(function (a, b) {
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  const stats = { total: tests.length, active: 0, upcoming: 0, closed: 0, submissions: submissions.length };
  tests.forEach(function (t) {
    if (t.status === 'active') stats.active++;
    else if (t.status === 'upcoming') stats.upcoming++;
    else if (t.status === 'closed') stats.closed++;
  });

  return { success: true, data: tests, stats: stats, timezone: TEST_TIMEZONE };
}

function adminGetTest(ss, testId) {
  const test = findTestById(ss, testId);
  if (!test) return { success: false, error: 'Test not found.' };
  const now = new Date();
  const copy = {};
  Object.keys(test).forEach(function (k) { if (k !== '_row') copy[k] = test[k]; });
  copy.computedStatus = computeTestStatus(test, now);
  return { success: true, data: copy };
}

function validateTestInput(input) {
  const name = String((input && input.name) || '').trim();
  if (!name) throw testError('Test name is required.');

  const code = String((input && input.code) || '').trim();
  if (!code) throw testError('Test code is required.');
  if (code.length > 40) throw testError('Test code is too long.');

  const startDate = testNormalizeDateInput(input && input.startDate);
  const endDate = testNormalizeDateInput(input && input.endDate);
  if (!startDate) throw testError('A valid start date is required.');
  if (!endDate) throw testError('A valid end date is required.');

  const startTime = testNormalizeTimeInput(input && input.startTime) || '00:00';
  const endTime = testNormalizeTimeInput(input && input.endTime) || '23:59';

  const start = riyadhToDate(startDate, startTime);
  const end = riyadhToDate(endDate, endTime);
  if (!start || !end) throw testError('The schedule could not be read. Check the dates and times.');
  if (end.getTime() <= start.getTime()) throw testError('The end must come after the start.');

  const duration = Math.round(Number(input && input.durationMinutes));
  if (!isFinite(duration) || duration < 1) throw testError('Duration must be at least 1 minute.');
  if (duration > 600) throw testError('Duration cannot exceed 600 minutes.');

  const status = String((input && input.status) || 'draft').toLowerCase();

  return {
    name: name.substring(0, 160),
    description: String((input && input.description) || '').trim().substring(0, 1000),
    code: code,
    startDate: startDate, startTime: startTime,
    endDate: endDate, endTime: endTime,
    durationMinutes: duration,
    oneAttempt: testToBool(input && input.oneAttempt, true),
    randomizeQuestions: testToBool(input && input.randomizeQuestions, false),
    randomizeAnswers: testToBool(input && input.randomizeAnswers, false),
    showResultImmediately: testToBool(input && input.showResultImmediately, true),
    status: TEST_STORED_STATUSES.indexOf(status) !== -1 ? status : 'draft'
  };
}

/** Creates when `id` is empty, updates otherwise. */
function adminSaveTest(ss, input) {
  const clean = validateTestInput(input);
  const sheet = testsSheet(ss);
  const nowIso = new Date().toISOString();
  const id = String((input && input.id) || '').trim();

  if (id) {
    const existing = findTestById(ss, id);
    if (!existing) throw testError('Test not found.');

    const record = {
      id: existing.id,
      name: clean.name, description: clean.description, code: clean.code,
      startDate: clean.startDate, startTime: clean.startTime,
      endDate: clean.endDate, endTime: clean.endTime,
      durationMinutes: clean.durationMinutes,
      totalMarks: existing.totalMarks,
      questionsCount: existing.questionsCount,
      oneAttempt: clean.oneAttempt,
      randomizeQuestions: clean.randomizeQuestions,
      randomizeAnswers: clean.randomizeAnswers,
      showResultImmediately: clean.showResultImmediately,
      status: clean.status,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: nowIso
    };
    sheet.getRange(existing._row, 1, 1, TEST_HEADERS.length).setValues([testObjectToRow(record)]);
    syncTestTotals(ss, existing.id);
    return { success: true, id: existing.id, created: false };
  }

  const newId = 'T' + Utilities.getUuid().replace(/-/g, '').substring(0, 16);
  const record = {
    id: newId,
    name: clean.name, description: clean.description, code: clean.code,
    startDate: clean.startDate, startTime: clean.startTime,
    endDate: clean.endDate, endTime: clean.endTime,
    durationMinutes: clean.durationMinutes,
    totalMarks: 0, questionsCount: 0,
    oneAttempt: clean.oneAttempt,
    randomizeQuestions: clean.randomizeQuestions,
    randomizeAnswers: clean.randomizeAnswers,
    showResultImmediately: clean.showResultImmediately,
    status: clean.status,
    createdBy: 'admin',
    createdAt: nowIso,
    updatedAt: nowIso
  };
  sheet.appendRow(testObjectToRow(record));
  stripe(sheet, TEST_HEADERS.length);
  return { success: true, id: newId, created: true };
}

function adminSetTestStatus(ss, testId, status) {
  const wanted = String(status || '').toLowerCase();
  if (TEST_STORED_STATUSES.indexOf(wanted) === -1) throw testError('Unknown status.');

  const test = findTestById(ss, testId);
  if (!test) throw testError('Test not found.');

  if (wanted === 'published') {
    const questions = readTestQuestions(ss, test.id);
    if (!questions.length) throw testError('Add at least one question before publishing.');
  }

  const sheet = testsSheet(ss);
  sheet.getRange(test._row, TEST_HEADERS.indexOf('Status') + 1).setValue(wanted);
  sheet.getRange(test._row, TEST_HEADERS.indexOf('Updated At') + 1).setValue(new Date().toISOString());
  return { success: true, status: wanted };
}

function adminDeleteTest(ss, testId) {
  const test = findTestById(ss, testId);
  if (!test) throw testError('Test not found.');

  // Questions and attempts go with it; submissions are kept as a record of
  // work students actually did.
  deleteRowsWhere(testQuestionsSheet(ss), TEST_QUESTION_HEADERS, 'Test ID', test.id);
  deleteRowsWhere(testAttemptsSheet(ss), TEST_ATTEMPT_HEADERS, 'Test ID', test.id);
  testsSheet(ss).deleteRow(test._row);

  return { success: true, deleted: test.id };
}

/** Deletes bottom-up so earlier row numbers stay valid while deleting. */
function deleteRowsWhere(sheet, headers, column, value) {
  const rows = testReadRows(sheet, headers);
  const targets = [];
  rows.forEach(function (r) {
    if (String(r[column] || '') === String(value)) targets.push(r._row);
  });
  targets.sort(function (a, b) { return b - a; });
  targets.forEach(function (rowIndex) { sheet.deleteRow(rowIndex); });
  return targets.length;
}

function adminGetTestQuestions(ss, testId) {
  const test = findTestById(ss, testId);
  if (!test) return { success: false, error: 'Test not found.' };
  const questions = readTestQuestions(ss, test.id).map(function (q) {
    const copy = {};
    Object.keys(q).forEach(function (k) { if (k !== '_row') copy[k] = q[k]; });
    return copy;
  });
  return { success: true, data: questions, testName: test.name };
}

/**
 * Replaces the whole question set for a test in one write. The admin UI always
 * sends the complete list, which keeps ordering, edits, deletions, moves and
 * imports as a single consistent operation.
 */
function adminSaveTestQuestions(ss, testId, questions) {
  const test = findTestById(ss, testId);
  if (!test) throw testError('Test not found.');

  const list = Array.isArray(questions) ? questions : [];
  if (list.length > TEST_MAX_QUESTIONS) {
    throw testError('A test can hold at most ' + TEST_MAX_QUESTIONS + ' questions.');
  }

  const nowIso = new Date().toISOString();
  const cleaned = list.map(function (raw, index) {
    const text = String((raw && raw.question) || '').trim();
    if (!text) throw testError('Question ' + (index + 1) + ' needs question text.');

    const options = ['optionA', 'optionB', 'optionC', 'optionD'].map(function (key) {
      return String((raw && raw[key]) || '').trim();
    });
    for (let i = 0; i < options.length; i++) {
      if (!options[i]) {
        throw testError('Question ' + (index + 1) + ' needs all four options.');
      }
    }

    const correct = String((raw && raw.correctAnswer) || '').trim().toUpperCase();
    if (TEST_OPTION_LETTERS.indexOf(correct) === -1) {
      throw testError('Question ' + (index + 1) + ' needs a correct answer of A, B, C or D.');
    }

    const marks = Math.round(Number(raw && raw.marks));
    if (!isFinite(marks) || marks < 1 || marks > 100) {
      throw testError('Question ' + (index + 1) + ' needs marks between 1 and 100.');
    }

    return {
      testId: test.id,
      id: String((raw && raw.id) || '').trim() ||
        ('Q' + Utilities.getUuid().replace(/-/g, '').substring(0, 14)),
      lessonNumber: String((raw && raw.lessonNumber) || '').trim().substring(0, 40),
      question: text.substring(0, 1000),
      optionA: options[0].substring(0, 400),
      optionB: options[1].substring(0, 400),
      optionC: options[2].substring(0, 400),
      optionD: options[3].substring(0, 400),
      correctAnswer: correct,
      marks: marks,
      order: index + 1,
      createdAt: String((raw && raw.createdAt) || '') || nowIso
    };
  });

  const sheet = testQuestionsSheet(ss);
  deleteRowsWhere(sheet, TEST_QUESTION_HEADERS, 'Test ID', test.id);
  if (cleaned.length) {
    const rows = cleaned.map(questionObjectToRow);
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, TEST_QUESTION_HEADERS.length).setValues(rows);
  }

  const totals = syncTestTotals(ss, test.id);
  return { success: true, saved: cleaned.length, totalMarks: totals.totalMarks };
}

/** Keeps the Tests row's Questions Count and Total Marks in step with reality. */
function syncTestTotals(ss, testId) {
  const test = findTestById(ss, testId);
  if (!test) return { totalMarks: 0, questionsCount: 0 };

  const questions = readTestQuestions(ss, testId);
  let totalMarks = 0;
  questions.forEach(function (q) { totalMarks += q.marks; });

  const sheet = testsSheet(ss);
  sheet.getRange(test._row, TEST_HEADERS.indexOf('Questions Count') + 1).setValue(questions.length);
  sheet.getRange(test._row, TEST_HEADERS.indexOf('Total Marks') + 1).setValue(totalMarks);
  sheet.getRange(test._row, TEST_HEADERS.indexOf('Updated At') + 1).setValue(new Date().toISOString());

  return { totalMarks: totalMarks, questionsCount: questions.length };
}

/**
 * Reads exercise prompts from the existing Lessons CMS so the admin can seed a
 * test from real lesson content. This is a read; lesson rows are never touched.
 * Lesson exercises are {prompt, answer} pairs rather than multiple choice, so
 * the prompt and answer are handed back for the admin to complete.
 */
function adminGetLessonExercises(ss, lessonIds) {
  const wanted = Array.isArray(lessonIds) ? lessonIds.map(String) : [];
  const lessons = readLessonRows(ss).filter(function (l) {
    return !wanted.length || wanted.indexOf(String(l.id)) !== -1;
  });

  const out = lessons.map(function (l) {
    const exercises = Array.isArray(l.exercises) ? l.exercises : [];
    return {
      id: l.id,
      lessonNumber: l.lesson_number,
      title: l.title,
      status: l.status,
      exercises: exercises.map(function (x, i) {
        return {
          index: i,
          prompt: String((x && x.prompt) || ''),
          answer: String((x && x.answer) || '')
        };
      }).filter(function (x) { return !!x.prompt; })
    };
  });

  return { success: true, data: out };
}

function adminGetTestSubmissions(ss, testId) {
  const wanted = String(testId || '').trim();
  const all = readSubmissions(ss).filter(function (s) {
    return !wanted || s.testId === wanted;
  });

  all.sort(function (a, b) {
    return String(b.submitTime || '').localeCompare(String(a.submitTime || ''));
  });

  return {
    success: true,
    data: all.map(function (s) {
      return {
        id: s.id, testId: s.testId, testName: s.testName,
        studentName: s.studentName, studentEmail: s.studentEmail,
        startTime: s.startTime, submitTime: s.submitTime,
        startTimeLabel: formatRiyadh(new Date(s.startTime)),
        submitTimeLabel: formatRiyadh(new Date(s.submitTime)),
        durationUsed: s.durationUsed,
        score: s.score, totalMarks: s.totalMarks, percentage: s.percentage,
        correct: s.correct, incorrect: s.incorrect, unanswered: s.unanswered,
        submissionType: s.submissionType, status: s.status
      };
    })
  };
}

/** The full paper for one student, with the answer key — admin only. */
function adminGetTestSubmission(ss, submissionId) {
  const wanted = String(submissionId || '').trim();
  const all = readSubmissions(ss);
  let found = null;
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === wanted) { found = all[i]; break; }
  }
  if (!found) return { success: false, error: 'Submission not found.' };

  const questions = readTestQuestions(ss, found.testId);
  const detail = questions.map(function (q) {
    const given = String(found.answers[q.id] || '');
    const optionText = {
      A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD
    };
    return {
      id: q.id,
      order: q.order,
      lessonNumber: q.lessonNumber,
      question: q.question,
      options: [q.optionA, q.optionB, q.optionC, q.optionD],
      studentAnswer: given,
      studentAnswerText: given ? (optionText[given] || '') : '',
      correctAnswer: q.correctAnswer,
      correctAnswerText: optionText[q.correctAnswer] || '',
      marks: q.marks,
      awarded: (given && given === q.correctAnswer) ? q.marks : 0
    };
  });

  return {
    success: true,
    data: {
      id: found.id,
      testId: found.testId,
      testName: found.testName,
      studentName: found.studentName,
      studentEmail: found.studentEmail,
      startTime: found.startTime,
      submitTime: found.submitTime,
      startTimeLabel: formatRiyadh(new Date(found.startTime)),
      submitTimeLabel: formatRiyadh(new Date(found.submitTime)),
      durationUsed: found.durationUsed,
      score: found.score, totalMarks: found.totalMarks, percentage: found.percentage,
      correct: found.correct, incorrect: found.incorrect, unanswered: found.unanswered,
      submissionType: found.submissionType, status: found.status
    },
    questions: detail
  };
}
