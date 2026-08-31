#!/usr/bin/env python3
"""
Fluency - Attendance & Progress System
Builds a print-ready A4 PDF: attendance registers, session logs,
per-student progress reports, and a class summary.

Usage
-----
  python build_attendance.py                          # blank pack (forms to print)
  python build_attendance.py --students students.csv  # filled from real data
  python build_attendance.py --students students.csv --reports-only

CSV columns (all optional except name):
  name, email, student_id, level, sessions, present, absent, late, excused,
  quiz, hw1..hw9, weekly, presentation, total, comment
"""

import argparse
import csv
import html
import os
import subprocess
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
CSS = os.path.join(HERE, "attendance.css")

TERM = "Term 1 · 2026"
SESSIONS_PER_PAGE = 16
ROWS_PER_PAGE = 18
HW_COUNT = 9

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def e(v):
    return html.escape(str(v)) if v is not None else ""


def num(v):
    """Parse a possibly-empty numeric cell."""
    try:
        s = str(v).strip()
        return float(s) if s != "" else None
    except (TypeError, ValueError):
        return None


def band_of(total):
    """Mirrors the website dashboard: >=70 excellent, >=50 good, else needs work."""
    if total is None:
        return None
    if total >= 70:
        return "exc"
    if total >= 50:
        return "good"
    return "need"


BAND_LABEL = {
    "exc": ("Excellent", "70 and above"),
    "good": ("Good", "50 - 69"),
    "need": ("Needs work", "below 50"),
}


# --------------------------------------------------------------------------
# shared chrome
# --------------------------------------------------------------------------
def top(title, doc, brand="Fluency"):
    return f"""<div class="top">
  <div class="id">
    <span class="brand">{e(brand)} <span>&bull;</span> Language Mastery</span>
    <h1>{e(title)}</h1>
  </div>
  <div class="doc">{doc}</div>
</div>"""


def foot(left, right):
    return f'<div class="foot"><span>{left}</span><span>{right}</span></div>'


def field(label, value="", blank=False):
    cls = "box blank" if blank else "box"
    return (f'<div class="field"><div class="lab">{e(label)}</div>'
            f'<div class="{cls}">{e(value)}</div></div>')


# --------------------------------------------------------------------------
# page 1 - cover
# --------------------------------------------------------------------------
def page_cover(contents):
    items = "".join(
        f'<div class="ci"><span class="no">{i:02d}</span>'
        f'<span class="t">{t}</span><span class="o">{o}</span></div>'
        for i, (t, o) in enumerate(contents, 1)
    )
    return f"""<section class="page p cover">
  <div class="glow"></div><div class="glow2"></div>
  <div class="in">
    <div class="logo">Fluency <b>&bull;</b> Language Mastery</div>
    <h1>Attendance<br>&amp; <em>Progress</em><br>System</h1>
    <p class="lede">One pack to run the register every session, track marks against the
      website's own categories, and hand each student a clear report of where they stand.</p>
    <div class="contents">{items}</div>
    <div class="meta">
      <span class="pill solid">A4 &middot; print ready</span>
      <span class="pill">{e(TERM)}</span>
      <span class="pill">Generated {date.today().strftime('%d %b %Y')}</span>
    </div>
  </div>
</section>"""


# --------------------------------------------------------------------------
# page 2 - how it works
# --------------------------------------------------------------------------
def page_howto():
    steps = [
        ("Print the register",
         "One <b>Class Attendance Register</b> per group, per term. It holds "
         "18 students across 16 sessions. Print a second copy for a larger group."),
        ("Mark every session",
         "Use one letter per box: <b>P</b> present, <b>A</b> absent, "
         "<b>L</b> late, <b>E</b> excused. Fill the totals column at the end of the term."),
        ("Log what was taught",
         "The <b>Session Log</b> records the date, lesson code and topic beside the "
         "names of anyone absent - so a missed lesson can be followed up, not forgotten."),
        ("Share the progress report",
         "One page per student: attendance, marks by category, band and your comment. "
         "Print it, or email the PDF straight to the student."),
    ]
    step_html = "".join(
        f'<div class="step"><div class="n">{i}</div><h3>{e(t)}</h3><p>{d}</p></div>'
        for i, (t, d) in enumerate(steps, 1)
    )

    rows = [
        ("Name", "Students &rarr; Name", "Printed on the register and the report"),
        ("Email", "Students &rarr; Email", "Used to send the progress report"),
        ("Student ID", "Students &rarr; Student ID", "Short reference on the register"),
        ("Level", "Students &rarr; Level", "A1, A2, B1 &hellip; shown on the report"),
        ("Quiz", "quiz", "Quiz average - dashboard category"),
        ("Homework 1-9", "hw1 &hellip; hw9", "Weekly assignment marks, 5 each"),
        ("Weekly", "w1", "Weekly task - dashboard category"),
        ("Presentation", "pres1", "Presentation - dashboard category"),
        ("Total", "total", "Drives the band: 70+, 50-69, under 50"),
    ]
    map_html = "".join(
        f'<tr><td>{a}</td><td class="c">{b}</td><td class="d">{c}</td></tr>'
        for a, b, c in rows
    )

    return f"""<section class="page p">
  {top("How this system works", "Setup &middot; page 2")}
  <div class="steps">{step_html}</div>

  <div class="sec">Where each field comes from</div>
  <div class="sec-rule"></div>
  <p style="font-size:9pt;color:#56718c;line-height:1.5;margin-bottom:3mm;">
    Every box on the progress report maps to a field the website already stores, so the
    printed report and the online dashboard never disagree.</p>
  <table class="map">
    <thead><tr><th style="width:38mm;">On the report</th><th style="width:44mm;">In your data</th><th>What it is</th></tr></thead>
    <tbody>{map_html}</tbody>
  </table>

  <div class="callout"><div class="ico">!</div><p>
    Attendance is <b>not stored anywhere yet</b>. These sheets are the paper record. To put it
    online, add an <b>Attendance</b> sheet with the columns
    <b>Date, Lesson Code, Student ID, Status</b> - then the same numbers can appear on the
    student dashboard.</p></div>

  <div class="callout green"><div class="ico">&#10003;</div><p>
    Run <b>build_attendance.py --students students.csv</b> to print this whole pack
    filled in with real names, marks and attendance totals - one report per student.</p></div>

  {foot("Fluency &middot; Attendance &amp; Progress System", "<b>02</b>")}
</section>"""


# --------------------------------------------------------------------------
# register
# --------------------------------------------------------------------------
def page_register(students, page_no, part, parts):
    head_cells = "".join(f'<th class="rot">{i}</th>' for i in range(1, SESSIONS_PER_PAGE + 1))

    body = ""
    for i in range(ROWS_PER_PAGE):
        s = students[i] if i < len(students) else None
        name = e(s["name"]) if s else ""
        sid = e(s.get("student_id", "")) if s else ""
        cells = "".join('<td class="s"></td>' for _ in range(SESSIONS_PER_PAGE))
        pres = abse = pct = ""
        if s:
            p, a = s.get("present"), s.get("absent")
            if p is not None:
                pres = f"{int(p)}"
            if a is not None:
                abse = f"{int(a)}"
            if s.get("att_pct") is not None:
                pct = f"{s['att_pct']:.0f}%"
        body += (f'<tr><td class="n">{i + 1 + (part - 1) * ROWS_PER_PAGE}</td>'
                 f'<td class="name">{name}</td><td class="sid">{sid}</td>{cells}'
                 f'<td class="tot">{pres}</td><td class="tot">{abse}</td>'
                 f'<td class="pct">{pct}</td></tr>')

    legend = """<div class="legend">
  <div class="key"><span class="c present">P</span><span class="t"><b>Present</b>on time</span></div>
  <div class="key"><span class="c absent">A</span><span class="t"><b>Absent</b>no contact</span></div>
  <div class="key"><span class="c late">L</span><span class="t"><b>Late</b>counts as present</span></div>
  <div class="key"><span class="c excused">E</span><span class="t"><b>Excused</b>told in advance</span></div>
  <div class="key note-key"><span class="t">Attendance % counts <b>P</b>, <b>L</b> and <b>E</b> as attended.
    A student below 75% should be contacted before the next assignment deadline.</span></div>
</div>"""

    return f"""<section class="page l">
  {top("Class Attendance Register", f"Register &middot; sheet {part} of {parts}")}
  <div class="fields">
    {field("Group / Class", "", blank=True)}
    {field("Teacher", "", blank=True)}
    {field("Term", TERM)}
    {field("Sessions covered", f"1 - {SESSIONS_PER_PAGE}")}
  </div>
  <table class="reg">
    <thead><tr>
      <th style="width:7mm;">#</th><th class="name" style="width:50mm;">Student name</th>
      <th style="width:21mm;">ID</th>{head_cells}
      <th style="width:11mm;">P</th><th style="width:11mm;">A</th><th style="width:14mm;">%</th>
    </tr></thead>
    <tbody>{body}</tbody>
  </table>
  {legend}
  {foot("Fluency &middot; Attendance &amp; Progress System", f"<b>{page_no:02d}</b>")}
</section>"""


# --------------------------------------------------------------------------
# session log
# --------------------------------------------------------------------------
def page_session_log(page_no):
    def blk(n):
        return f"""<div class="log">
  <div class="lh"><span class="t">Session {n}</span><span class="d">Date &nbsp;____ / ____ / ______</span></div>
  <div class="row">
    <div class="cell"><div class="lab">Lesson code</div><div class="rule"></div></div>
    <div class="cell" style="flex:2;"><div class="lab">Topic taught</div><div class="rule"></div></div>
  </div>
  <div class="row">
    <div class="cell"><div class="lab">Absent students</div><div class="rule"></div></div>
  </div>
  <div class="row">
    <div class="cell"><div class="lab">Follow-up needed</div><div class="rule"></div></div>
  </div>
  <div class="counts">
    <div class="cnt"><div class="k">Present</div><div class="v"></div></div>
    <div class="cnt"><div class="k">Absent</div><div class="v"></div></div>
    <div class="cnt"><div class="k">Late</div><div class="v"></div></div>
    <div class="cnt"><div class="k">Excused</div><div class="v"></div></div>
  </div>
</div>"""

    return f"""<section class="page l">
  {top("Session Log", "Register &middot; what was taught")}
  <div class="logs">{"".join(blk(i) for i in range(1, 7))}</div>
  {foot("Fluency &middot; Attendance &amp; Progress System &middot; keep with the register", f"<b>{page_no:02d}</b>")}
</section>"""


# --------------------------------------------------------------------------
# progress report
# --------------------------------------------------------------------------
def donut(pct):
    """Attendance ring. pct None -> empty ring with a blank centre."""
    r, c = 15.9155, 100.0
    shown = 0 if pct is None else max(0, min(100, pct))
    colour = "#2f8a63" if shown >= 75 else ("#b57d1f" if shown >= 60 else "#b3453a")
    if pct is None:
        colour = "#cfdeeb"
    label = "&mdash;" if pct is None else f"{shown:.0f}%"
    return f"""<svg viewBox="0 0 42 42" width="34mm" height="34mm">
  <circle cx="21" cy="21" r="{r}" fill="none" stroke="#e8f1f8" stroke-width="4.2"/>
  <circle cx="21" cy="21" r="{r}" fill="none" stroke="{colour}" stroke-width="4.2"
    stroke-dasharray="{shown / 100 * c:.2f} {c - shown / 100 * c:.2f}"
    stroke-dashoffset="25" stroke-linecap="round"/>
  <text x="21" y="22.6" text-anchor="middle" font-size="9.5"
    font-family="Segoe UI,Calibri,sans-serif" font-weight="700" fill="#123a5c">{label}</text>
</svg>"""


def page_report(s, page_no, example=False):
    blank = s is None
    s = s or {}
    name = s.get("name") or ""
    total = s.get("total")
    b = band_of(total)

    def cell(v, cls):
        return (f'<div class="acell {cls}"><div class="v">{"" if v is None else int(v)}</div>'
                f'<div class="k">{cls_label[cls]}</div></div>')

    cls_label = {"g": "Present", "r": "Absent", "a": "Late", "b": "Excused"}
    cells = "".join(cell(s.get(k), c) for k, c in
                    [("present", "g"), ("absent", "r"), ("late", "a"), ("excused", "b")])

    # marks rows
    def mrow(label, key, mx):
        v = s.get(key)
        score = "" if v is None else (f"{v:g}")
        pct = 0 if (v is None or not mx) else max(0, min(100, v / mx * 100))
        bar = f'<div class="bar"><i style="width:{pct:.0f}%"></i></div>' if not blank else '<div class="bar"></div>'
        return (f'<tr><td class="lbl">{e(label)}</td><td class="mx">{mx if mx else "&mdash;"}</td>'
                f'<td class="sc">{score}</td><td>{bar}</td></tr>')

    rows = [mrow("Quiz", "quiz", None),
            mrow("Weekly task", "weekly", 5),
            mrow("Presentation", "presentation", None)]
    tot_txt = "" if total is None else f"{total:g}"
    tot_bar = ("" if total is None
               else f'<div class="bar"><i style="width:{max(0, min(100, total)):.0f}%"></i></div>')
    rows.append(f'<tr class="tot"><td class="lbl">TOTAL</td><td class="mx">100</td>'
                f'<td class="sc">{tot_txt}</td><td>{tot_bar}</td></tr>')

    hw_cells = ""
    for i in range(1, HW_COUNT + 1):
        v = s.get(f"hw{i}")
        cls = "miss" if v is None else ("full" if v >= 5 else "part")
        if blank:
            cls = ""
        hw_cells += (f'<div class="hwc {cls}"><div class="k">HW {i}</div>'
                     f'<div class="v">{"" if v is None else f"{v:g}"}</div>'
                     f'<div class="m">of 5</div></div>')

    bands = ""
    for key in ("exc", "good", "need"):
        lab, rng = BAND_LABEL[key]
        on = " on " + key if b == key else ""
        bands += (f'<div class="band{on}"><span class="dot {key}"></span>'
                  f'<span class="t"><b>{lab}</b>{rng}</span></div>')

    if blank:
        comment_body = ('<div class="lines"><div></div><div></div><div></div></div>')
    else:
        comment_body = f'<p class="filled">{e(s.get("comment", ""))}</p>'

    att_pct = s.get("att_pct")

    return f"""<section class="page p">
  {top("Student Progress Report", "Report &middot; " + ("worked example" if example else ("blank" if blank else TERM)))}

  <div class="ident">
    <div class="who">
      <div class="nm{" wline" if blank else ""}">{e(name) if name else "&nbsp;"}</div>
      <div class="em{" wline" if blank else ""}">{e(s.get("email", "")) if not blank else ""}</div>
    </div>
    <div class="meta">
      <div class="m"><div class="k">Student ID</div><div class="v{" wline" if blank else ""}">{e(s.get("student_id", "")) or "&nbsp;"}</div></div>
      <div class="m"><div class="k">Level</div><div class="v{" wline" if blank else ""}">{e(s.get("level", "")) or "&nbsp;"}</div></div>
      <div class="m"><div class="k">Term</div><div class="v">{e(TERM)}</div></div>
      <div class="m"><div class="k">Sessions</div><div class="v{" wline" if blank else ""}">{"" if s.get("sessions") is None else int(s["sessions"])}&nbsp;</div></div>
    </div>
  </div>

  <div class="sec">Attendance</div>
  <div class="sec-rule"></div>
  <div class="att-sum">
    <div class="ring-wrap">{donut(att_pct)}<div class="cap">Attended</div></div>
    <div class="att-cells">{cells}</div>
  </div>

  <div class="sec">Marks</div>
  <div class="sec-rule"></div>
  <table class="marks">
    <thead><tr><th>Component</th><th style="width:16mm;">Max</th><th style="width:22mm;">Score</th><th>&nbsp;</th></tr></thead>
    <tbody>{"".join(rows)}</tbody>
  </table>

  <div class="sec">Homework 1 &ndash; 9 &middot; 5 marks each</div>
  <div class="sec-rule"></div>
  <div class="hw-strip">{hw_cells}</div>

  <div class="sec">Band</div>
  <div class="sec-rule"></div>
  <div class="bands">{bands}</div>

  <div class="comment">
    <div class="sec" style="margin-bottom:0;">Teacher's comment &amp; next steps</div>
    {comment_body}
  </div>

  <div class="sign">
    <div class="s"><div class="rule"></div><div class="lab">Teacher signature</div></div>
    <div class="s"><div class="rule"></div><div class="lab">Date</div></div>
    <div class="s"><div class="rule"></div><div class="lab">Student / guardian</div></div>
  </div>

  {foot("Fluency &middot; Language Mastery &middot; progress report", f"<b>{page_no:02d}</b>")}
</section>"""


# --------------------------------------------------------------------------
# class summary
# --------------------------------------------------------------------------
def page_summary(students, page_no):
    rows = ""
    src = students if students else [None] * ROWS_PER_PAGE
    for i, s in enumerate(src, 1):
        if s is None:
            rows += (f'<tr><td>{i}</td><td class="name"></td><td class="em"></td><td></td>'
                     f'<td></td><td></td><td></td><td></td><td></td><td></td>'
                     f'<td><span class="tag blank">&mdash;</span></td></tr>')
            continue
        b = band_of(s.get("total"))
        tag = (f'<span class="tag {b}">{BAND_LABEL[b][0]}</span>' if b
               else '<span class="tag blank">&mdash;</span>')

        def g(k):
            v = s.get(k)
            return "" if v is None else f"{v:g}"

        hw_done = sum(1 for i2 in range(1, HW_COUNT + 1) if s.get(f"hw{i2}") is not None)
        pct = "" if s.get("att_pct") is None else f"{s['att_pct']:.0f}%"
        rows += (f'<tr><td>{i}</td><td class="name">{e(s["name"])}</td>'
                 f'<td class="em">{e(s.get("email", ""))}</td>'
                 f'<td>{e(s.get("level", ""))}</td><td>{pct}</td>'
                 f'<td>{"" if s.get("absent") is None else int(s["absent"])}</td>'
                 f'<td>{g("quiz")}</td><td>{hw_done}/{HW_COUNT}</td>'
                 f'<td>{g("weekly")}</td><td>{g("presentation")}</td>'
                 f'<td><b>{g("total")}</b> &nbsp;{tag}</td></tr>')

    return f"""<section class="page l">
  {top("Class Progress Summary", "Overview &middot; " + TERM)}
  <div class="fields">
    {field("Group / Class", "", blank=True)}
    {field("Teacher", "", blank=True)}
    {field("Students", str(len(students)) if students else "")}
    {field("Prepared", date.today().strftime('%d %b %Y'))}
  </div>
  <table class="sum">
    <thead><tr>
      <th style="width:8mm;">#</th><th style="width:48mm;">Student</th><th style="width:56mm;">Email</th>
      <th style="width:16mm;">Level</th><th style="width:18mm;">Attend.</th><th style="width:16mm;">Abs.</th>
      <th style="width:16mm;">Quiz</th><th style="width:18mm;">HW done</th><th style="width:18mm;">Weekly</th>
      <th style="width:20mm;">Present.</th><th>Total &amp; band</th>
    </tr></thead>
    <tbody>{rows}</tbody>
  </table>
  <div class="legend" style="margin-top:3mm;">
    <div class="key"><span class="c present wide">&#8805;70</span><span class="t"><b>Excellent</b>on track</span></div>
    <div class="key"><span class="c late wide">50&ndash;69</span><span class="t"><b>Good</b>keep pushing</span></div>
    <div class="key"><span class="c absent wide">&lt;50</span><span class="t"><b>Needs work</b>contact the student</span></div>
    <div class="key note-key"><span class="t">Bands match the website dashboard exactly, so this sheet and the
      online statistics always tell the same story.</span></div>
  </div>
  {foot("Fluency &middot; Attendance &amp; Progress System", f"<b>{page_no:02d}</b>")}
</section>"""


# --------------------------------------------------------------------------
# policy page
# --------------------------------------------------------------------------
def page_policy(page_no):
    return f"""<section class="page p">
  {top("Codes, Rules &amp; Filing", "Reference &middot; keep at the front")}

  <div class="sec">The four codes</div>
  <div class="sec-rule"></div>
  <div class="legend" style="flex-wrap:wrap;">
    <div class="key" style="flex:1 1 40%;"><span class="c present">P</span><span class="t"><b>Present</b>in the session on time</span></div>
    <div class="key" style="flex:1 1 40%;"><span class="c absent">A</span><span class="t"><b>Absent</b>did not attend, no contact</span></div>
    <div class="key" style="flex:1 1 40%;"><span class="c late">L</span><span class="t"><b>Late</b>arrived after the start; still attended</span></div>
    <div class="key" style="flex:1 1 40%;"><span class="c excused">E</span><span class="t"><b>Excused</b>told the teacher in advance</span></div>
  </div>

  <div class="sec" style="margin-top:6mm;">How the percentage is worked out</div>
  <div class="sec-rule"></div>
  <p style="font-size:9.5pt;line-height:1.6;color:#26404f;">
    Attendance&nbsp;% = ( <b>P</b> + <b>L</b> + <b>E</b> ) &divide; sessions held &times; 100.
    A late arrival still counts as attending, because the student was taught. Only <b>A</b>
    lowers the percentage. Count sessions <i>held</i>, not sessions planned - a cancelled
    class must not count against anyone.</p>

  <div class="sec" style="margin-top:6mm;">When to act</div>
  <div class="sec-rule"></div>
  <table class="map">
    <thead><tr><th style="width:32mm;">Attendance</th><th>What to do</th></tr></thead>
    <tbody>
      <tr><td class="c">90% and above</td><td class="d">Nothing. Say so in the report comment - it deserves credit.</td></tr>
      <tr><td class="c">75 - 89%</td><td class="d">Mention it in the next progress report.</td></tr>
      <tr><td class="c">60 - 74%</td><td class="d">Message the student before the next assignment deadline.</td></tr>
      <tr><td class="c">Below 60%</td><td class="d">Call. Two missed assignments usually follow a run of absences.</td></tr>
      <tr><td class="c">3 in a row</td><td class="d">Contact the same week, whatever the overall percentage says.</td></tr>
    </tbody>
  </table>

  <div class="sec" style="margin-top:6mm;">Filing</div>
  <div class="sec-rule"></div>
  <table class="map">
    <thead><tr><th style="width:52mm;">Sheet</th><th>Where it lives</th></tr></thead>
    <tbody>
      <tr><td>Class Attendance Register</td><td class="d">One per group, per term. Keep until the term's reports are sent.</td></tr>
      <tr><td>Session Log</td><td class="d">Behind the register. This is the record of what was actually taught.</td></tr>
      <tr><td>Student Progress Report</td><td class="d">One per student. Copy to the student, copy to the file.</td></tr>
      <tr><td>Class Progress Summary</td><td class="d">One per group at the end of term.</td></tr>
    </tbody>
  </table>

  <div class="callout"><div class="ico">!</div><p>
    These pages hold student names and marks. Keep completed sheets where other students
    cannot read them, and send a progress report <b>only</b> to that student's own address.</p></div>

  {foot("Fluency &middot; Attendance &amp; Progress System", f"<b>{page_no:02d}</b>")}
</section>"""


# --------------------------------------------------------------------------
# data
# --------------------------------------------------------------------------
def load_students(path):
    out = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            r = { (k or "").strip().lower(): (v or "").strip() for k, v in r.items() }
            if not r.get("name"):
                continue
            s = {
                "name": r.get("name", ""),
                "email": r.get("email", ""),
                "student_id": r.get("student_id", ""),
                "level": r.get("level", ""),
                "comment": r.get("comment", ""),
            }
            for k in ("sessions", "present", "absent", "late", "excused",
                      "quiz", "weekly", "presentation", "total"):
                s[k] = num(r.get(k))
            for i in range(1, HW_COUNT + 1):
                s[f"hw{i}"] = num(r.get(f"hw{i}"))

            sess = s.get("sessions")
            attended = sum(v for v in (s.get("present"), s.get("late"), s.get("excused"))
                           if v is not None)
            s["att_pct"] = (attended / sess * 100) if sess else None
            out.append(s)
    return out


SAMPLE = {
    "name": "Sara Al-Otaibi", "email": "sara.otaibi@example.com",
    "student_id": "FL-0142", "level": "A1", "sessions": 16,
    "present": 13, "absent": 1, "late": 1, "excused": 1,
    "quiz": 18, "weekly": 4, "presentation": 8,
    "hw1": 5, "hw2": 4, "hw3": 5, "hw4": 5, "hw5": 3,
    "hw6": 5, "hw7": 4, "hw8": 5, "hw9": None,
    "total": 76,
    "comment": "Sara asks questions in class without being invited to, which is exactly what "
               "Lesson 2 was for, and her short answers are now consistently correct. "
               "Homework 5 was rushed and Homework 9 is still missing - hand it in and the "
               "total goes above 80. Next: use the short forms when speaking, not only in writing.",
}
SAMPLE["att_pct"] = (13 + 1 + 1) / 16 * 100


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------
def build_html(students, reports_only=False):
    css = open(CSS, encoding="utf-8").read()
    pages, n = [], 0

    if reports_only:
        for s in students:
            n += 1
            pages.append(page_report(s, n))
    else:
        contents = [
            ("How this system works", "page 2"),
            ("Class Attendance Register", "landscape"),
            ("Session Log", "landscape"),
            ("Student Progress Report - blank", "portrait"),
            ("Student Progress Report - example", "portrait"),
            ("Class Progress Summary", "landscape"),
            ("Codes, rules &amp; filing", "portrait"),
        ]
        pages.append(page_cover(contents)); n = 1
        n += 1; pages.append(page_howto())

        chunks = ([students[i:i + ROWS_PER_PAGE] for i in range(0, len(students), ROWS_PER_PAGE)]
                  or [[]])
        for idx, ch in enumerate(chunks, 1):
            n += 1
            pages.append(page_register(ch, n, idx, len(chunks)))

        n += 1; pages.append(page_session_log(n))

        if students:
            for s in students:
                n += 1
                pages.append(page_report(s, n))
        else:
            n += 1; pages.append(page_report(None, n))
            n += 1; pages.append(page_report(SAMPLE, n, example=True))

        n += 1; pages.append(page_summary(students, n))
        n += 1; pages.append(page_policy(n))

    return ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            '<title>Fluency - Attendance &amp; Progress System</title>'
            f'<style>\n{css}\n</style></head><body>\n' + "\n".join(pages) + "\n</body></html>")


def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def render(html_path, pdf_path):
    chrome = find_chrome()
    if not chrome:
        print("Chrome not found - open the HTML and print to PDF manually.", file=sys.stderr)
        return False
    url = "file:///" + os.path.abspath(html_path).replace("\\", "/")
    subprocess.run([chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer",
                    f"--print-to-pdf={os.path.abspath(pdf_path)}",
                    "--virtual-time-budget=8000", url],
                   check=True, capture_output=True)
    return True


def main():
    ap = argparse.ArgumentParser(description="Build the Fluency attendance & progress PDF.")
    ap.add_argument("--students", help="CSV of students (see header docstring)")
    ap.add_argument("--out", default="Fluency-Attendance-Progress-System.pdf")
    ap.add_argument("--reports-only", action="store_true",
                    help="only the per-student progress reports")
    a = ap.parse_args()

    students = load_students(a.students) if a.students else []
    if a.reports_only and not students:
        sys.exit("--reports-only needs --students")

    html_path = os.path.splitext(a.out)[0] + ".html"
    open(html_path, "w", encoding="utf-8").write(build_html(students, a.reports_only))
    ok = render(html_path, a.out)
    print(f"{'PDF' if ok else 'HTML'} written: {a.out if ok else html_path}"
          f"  ({len(students) or 'blank'} students)")


if __name__ == "__main__":
    main()
