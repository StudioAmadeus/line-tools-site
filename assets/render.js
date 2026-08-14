/* ==========================================================================
   render.js — shift sheet renderer
   --------------------------------------------------------------------------
   Builds the printed shift sheet for one station (SPEC §2, §4): every item
   in list order, pars as numbers, group header rows carrying the Cook/Mgr
   checks (both halves of a split group, per the §5 amendment), the 86 line,
   and the sign-off block. RSFit owns the row arithmetic; print.css owns the
   surface.

   MEASUREMENT
   The fit budget needs per-row line counts, so the renderer measures every
   cell that can wrap — item AND where — against the exact type it prints
   with, using canvas measureText in the same engine that lays out the page.
   The 26-char estimate from 1.2's harness is gone; an estimate that
   under-counts a wrap pushes content into overflow:hidden, which is the
   silent-clipping failure mode.

   The column constants below MUST mirror print.css (widths, 5px side
   padding, the type stack). scripts/test.js asserts the mirror holds.

   LIST ORDER IS CANONICAL (locked). Rows are emitted in item order, group
   headers opening each contiguous run. Nothing here sorts, groups, or
   parses structure out of `where`.
   ========================================================================== */

(function (root) {
  "use strict";

  /* Same stack as print.css — the type decision is recorded there. */
  var STACK = "'Arial Narrow', 'Roboto Condensed', Calibri, 'Helvetica Neue', Arial, sans-serif";

  /* --fs is pinned at 15.5px by the row-height floor (see fit.js), so the
     item column measures at semibold 15.5. `where` prints at a fixed 13px
     (print.css). Widths are the column budget minus 2×5px cell padding. */
  var COLS = {
    item:  { width: 1.70 * 96 - 10, font: "600 15.5px " + STACK },
    where: { width: 1.50 * 96 - 10, font: "13px " + STACK }
  };

  var ctx = null;
  function canvasMeasure(text, font) {
    if (!ctx) { ctx = document.createElement("canvas").getContext("2d"); }
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  /* Greedy word wrap, mirroring the browser closely enough when paired
     with fit.js's 20px-per-line overestimate. A lone word wider than the
     column hard-breaks (word-wrap: break-word), so it counts the lines it
     must occupy — slight overestimate in the pathological case, and
     overestimates are the safe direction. */
  function lineCount(text, col, measure) {
    if (!text) { return 1; }
    var words = String(text).split(" ");
    var lines = 1, cur = "", i, tryLine, lone;
    for (i = 0; i < words.length; i++) {
      tryLine = cur ? cur + " " + words[i] : words[i];
      if (measure(tryLine, col.font) <= col.width) { cur = tryLine; continue; }
      if (cur) { lines++; }
      cur = words[i];
      lone = measure(cur, col.font);
      if (lone > col.width) {
        lines += Math.ceil(lone / col.width) - 1;
      }
    }
    return lines;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* Rows in list order — the walk. A group header row opens each
     contiguous group run; blank placeholder items don't print.
     Row tracking (SPEC §4, from the 1.4 paper test): every fifth ITEM
     row carries a heavier rule — item rows only, headers don't count,
     and the count restarts at each group so the rhythm reads within a
     group, not across the whole column. The count deliberately runs
     across the column split: it belongs to the group, and the (cont.)
     header doesn't reset the walk. */
  function buildRows(station, measure) {
    var rows = [], prev = null, nth = 0, i, it, g, ln;
    for (i = 0; i < station.items.length; i++) {
      it = station.items[i];
      if (!it.name) { continue; }
      g = it.group || null;
      if (g !== prev) { nth = 0; }
      if (g && g !== prev) { rows.push({ type: "group", group: g, lines: 1 }); }
      ln = Math.max(
        lineCount(it.name, COLS.item, measure),
        lineCount(it.where, COLS.where, measure)
      );
      nth++;
      rows.push({
        type: "item", item: it, group: g, lines: ln,
        rule5: nth % 5 === 0
      });
      prev = g;
    }
    return rows;
  }

  /* Pars version stamp (SPEC §4, restored 1.5 — present on the original
     wall sheets, lost in the first §4 draft). Derived from the station's
     updatedAt; it records which generation of pars this sheet was printed
     from, distinct from the handwritten DATE that records the shift. A
     never-edited station has no version and prints the bare mark — a
     misleading date is worse than none. */
  function stampText(updatedAt, mark) {
    var s = mark || "PARS GUIDE";
    if (updatedAt) { s += " &middot; v " + esc(String(updatedAt).slice(0, 10)); }
    return s;
  }

  /* A split group is checked in both halves — the (cont.) header carries
     its own Cook/Mgr pair (Adam, 2026-08-07, SPEC §5 amendment). */
  function groupRowHtml(name, cont) {
    var label = esc(name) + (cont ? ' <span class="cont">(cont.)</span>' : "");
    return '<tr class="grow"><td class="gname" colspan="2">' + label +
      '</td><td class="gchecks">Cook <span class="cbox"></span>' +
      ' Mgr <span class="cbox"></span></td></tr>';
  }

  function colHtml(rows) {
    var h = '<table class="ptable"><thead><tr>' +
      '<th class="c-item">Item</th><th class="c-par">Par</th>' +
      '<th class="c-where">Container &middot; Where</th></tr></thead><tbody>';
    var i, r, par;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (r.type === "group") {
        h += groupRowHtml(r.group, r.cont);
      } else {
        /* An item with no par prints a write-in rule (locked, §5): pars
           that only ever lived in marker need somewhere to go, or the
           sheet degrades into a location list nobody can correct. */
        par = r.item.par != null && String(r.item.par) !== ""
          ? esc(r.item.par)
          : '<span class="wline"></span>';
        h += '<tr' + (r.rule5 ? ' class="rule5"' : "") + '>' +
          '<td class="item">' + esc(r.item.name) +
          '</td><td class="par">' + par +
          '</td><td class="where">' + esc(r.item.where) + '</td></tr>';
      }
    }
    return h + "</tbody></table>";
  }

  /**
   * @param {object} station  { name, items[] } per SPEC §3
   * @param {object} [opts]
   * @param {function} [opts.measure]  (text, cssFont) -> px width.
   *                   Defaults to canvas measureText; injectable so the
   *                   Node tests can assert the budgeting without a DOM.
   * @returns {{name, html, fit, rows, clipped}|null}  null when the
   *                   station has no named items. clipped mirrors
   *                   fit.clipped — callers MUST surface it before the
   *                   print dialog opens.
   */
  function shiftSheet(station, opts) {
    opts = opts || {};
    var measure = opts.measure || canvasMeasure;
    var rows = buildRows(station, measure);
    if (!rows.length) { return null; }

    var fit = root.RSFit.fitRows(rows.length, {
      lines: rows.map(function (r) { return r.lines; }),
      groups: rows.map(function (r) { return r.group; })
    });

    /* Lay out from fit.split — never re-derive it. The (cont.) header is
       already budgeted in column two whenever fit.ragged, so it's a plain
       insert with no re-fit. */
    var col1 = rows.slice(0, fit.split);
    var col2 = rows.slice(fit.split);
    if (fit.ragged) {
      col2.unshift({ type: "group", group: rows[fit.split].group, cont: true, lines: 1 });
    }

    var html =
      '<div class="sheet" style="' + root.RSFit.sheetStyle(fit) + '">' +
        '<div class="sheet-head">' +
          '<div>' +
            '<div class="sheet-title">' + esc(station.name) + '</div>' +
            '<div class="sheet-stamp">' + stampText(station.updatedAt) + '</div>' +
          '</div>' +
          '<div class="sheet-meta">DATE <span class="wline inline" style="width:1.1in"></span>' +
            ' &nbsp;SHIFT <span class="shift-o"></span>AM <span class="shift-o"></span>PM</div>' +
        '</div>' +
        '<div class="cols">' +
          '<div class="col">' + colHtml(col1) + '</div>' +
          '<div class="col">' + colHtml(col2) + '</div>' +
        '</div>' +
        '<div class="sheet-foot">' +
          '<div class="foot-86">86 / couldn’t stock: <span class="wline inline" style="width:5.55in"></span></div>' +
          /* 2.5in per signature — 1.7in was tight for a name in Sharpie
             (1.4 paper test). Width is free; the 86 line is the marker
             reference and these now match its scale. */
          '<div class="foot-sign">Completed by <span class="wline inline" style="width:2.5in"></span>' +
            ' &nbsp;&nbsp;Verified by <span class="wline inline" style="width:2.5in"></span></div>' +
        '</div>' +
      '</div>';

    return { name: station.name, html: html, fit: fit, rows: rows, clipped: fit.clipped };
  }

  /**
   * Capture sheet (SPEC §2): column headers and blank marker-height rows,
   * nothing else. An input tool — someone with no list walks the station
   * writing down what's actually there, then types it in later. No pars,
   * no checks, no sign-off, no 86 line, no stamp (nothing has a version
   * until it's been typed in). Same page box, type, and rules as the
   * shift sheet; a station name line to write in, since the station has
   * no name yet.
   */
  function captureSheet() {
    /* 32 rows (16 per column) fills the sheet exactly at 52.5px = 0.55in:
       (952 - 88 head) / 16 - 1.5 = 52.5, just under the cap. This sheet
       is entirely write-in, so the row height IS the product — the 1.4
       marker calibration, reused. No footer to budget. */
    var ROWS = 32;
    var fit = root.RSFit.fitRows(ROWS, { foot: 0 });

    var head = '<thead><tr><th class="c-item">Item</th><th class="c-par">Par</th>' +
      '<th class="c-where">Container &middot; Where</th></tr></thead>';
    var body = "", i;
    for (i = 1; i <= ROWS / 2; i++) {
      body += '<tr' + (i % 5 === 0 ? ' class="rule5"' : "") + '>' +
        '<td class="item"></td><td class="par"></td><td class="where"></td></tr>';
    }
    var col = '<div class="col"><table class="ptable">' + head +
      "<tbody>" + body + "</tbody></table></div>";

    return {
      name: "Capture sheet",
      fit: fit,
      clipped: fit.clipped,
      html:
        '<div class="sheet" style="' + root.RSFit.sheetStyle(fit) + '">' +
          '<div class="sheet-head">' +
            '<div class="sheet-title">Station <span class="wline inline" style="width:2.2in"></span></div>' +
            '<div class="sheet-meta"></div>' +
          '</div>' +
          '<div class="cols">' + col + col + '</div>' +
        '</div>'
    };
  }

  /* ---------- run checklist (5.1, the second tool) ---------- */
  /* The pars sheet with different columns: task 3.20in · check 0.40in,
     closing at the same 3.60in budget. A CHECKBOX per task (Adam's
     paper call, 5.1 — overruling SPEC §8's initials-for-attribution;
     his transcription), same 18px box the pars sheet uses. Group
     headers are organizational only: no Cook/Mgr pair. Footer is a
     notes band plus the same sign-off. Same engine throughout:
     measurement, fit, split, (cont.), fifth-row rhythm. */

  var RCOLS = {
    task: { width: 3.20 * 96 - 10, font: "600 15.5px " + STACK }
  };

  function runRowsOf(list, measure) {
    var rows = [], prev = null, nth = 0, i, it, g;
    for (i = 0; i < list.items.length; i++) {
      it = list.items[i];
      if (!it.name) { continue; }
      g = it.group || "";
      if (g !== prev) { nth = 0; }
      if (g && g !== prev) { rows.push({ type: "group", group: g, lines: 1 }); }
      nth++;
      rows.push({
        type: "item", item: it, group: g,
        lines: lineCount(it.name, RCOLS.task, measure),
        rule5: nth % 5 === 0
      });
      prev = g;
    }
    return rows;
  }

  function runColHtml(rows) {
    var h = '<table class="ptable"><thead><tr>' +
      '<th class="c-task">Task</th><th class="c-check"></th></tr></thead><tbody>';
    var i, r;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (r.type === "group") {
        /* organizational only — each task carries its own check, so a
           group check would double-attest */
        h += '<tr class="grow"><td class="gname" colspan="2">' + esc(r.group) +
          (r.cont ? ' <span class="cont">(cont.)</span>' : "") + '</td></tr>';
      } else {
        h += '<tr' + (r.rule5 ? ' class="rule5"' : "") + '>' +
          '<td class="item">' + esc(r.item.name) +
          '</td><td class="check"><span class="cbox"></span></td></tr>';
      }
    }
    return h + "</tbody></table>";
  }

  function runSheetChrome(titleHtml, stamp, colsHtml, fit) {
    /* No SHIFT marker (Adam, 5.1 paper test): a sheet named CLOSING
       asking for an AM/PM circle contradicts itself — the checklist's
       NAME carries the shift, for opening, closing, or anything else.
       The pars sheet keeps SHIFT because one station sheet genuinely
       serves both shifts. DATE stays. */
    return '<div class="sheet" style="' + root.RSFit.sheetStyle(fit) + '">' +
      '<div class="sheet-head">' +
        '<div>' +
          '<div class="sheet-title">' + titleHtml + '</div>' +
          '<div class="sheet-stamp">' + stamp + '</div>' +
        '</div>' +
        '<div class="sheet-meta">DATE <span class="wline inline" style="width:1.6in"></span>' +
          '<div class="sheet-legend">A dash instead of a check means see notes.</div>' +
        '</div>' +
      '</div>' +
      '<div class="cols">' + colsHtml + '</div>' +
      '<div class="sheet-foot">' +
        '<div class="foot-notes">NOTES: <span class="wline inline" style="width:6.1in"></span></div>' +
        '<div class="foot-sign">Completed by <span class="wline inline" style="width:2.5in"></span>' +
          ' &nbsp;&nbsp;Verified by <span class="wline inline" style="width:2.5in"></span></div>' +
      '</div>' +
    '</div>';
  }

  /**
   * Run checklist sheet — Opening / Closing (SPEC §8).
   * @param {object} list  { name, updatedAt, items[] }, task items are
   *                       { id, name, group }
   * @param {object} [opts]  { measure } as shiftSheet
   */
  function runSheet(list, opts) {
    opts = opts || {};
    var measure = opts.measure || canvasMeasure;
    var rows = runRowsOf(list, measure);
    if (!rows.length) { return null; }

    var fit = root.RSFit.fitRows(rows.length, {
      lines: rows.map(function (r) { return r.lines; }),
      groups: rows.map(function (r) { return r.group; })
    });

    var col1 = rows.slice(0, fit.split);
    var col2 = rows.slice(fit.split);
    if (fit.ragged) {
      col2.unshift({ type: "group", group: rows[fit.split].group, cont: true, lines: 1 });
    }

    return {
      name: list.name, fit: fit, rows: rows, clipped: fit.clipped,
      html: runSheetChrome(
        esc(list.name),
        stampText(list.updatedAt, "OPERATIONAL CHECKS"),
        '<div class="col">' + runColHtml(col1) + '</div>' +
        '<div class="col">' + runColHtml(col2) + '</div>',
        fit)
    };
  }

  /**
   * Blank run sheet: the primary path for a kitchen with no checklists —
   * print it, write the run by hand at the station, type it in later.
   * Full chrome (date, shift, notes, sign-off) so it is usable as-is.
   */
  function blankRunSheet() {
    /* 30 rows fills the page below the 53px cap: (952-88-80)/15 - 1.5
       = 50.77px — the same comfortable height a 30-row list prints at. */
    var ROWS = 30;
    var fit = root.RSFit.fitRows(ROWS);
    var body = "", i;
    for (i = 1; i <= ROWS / 2; i++) {
      body += '<tr' + (i % 5 === 0 ? ' class="rule5"' : "") + '>' +
        '<td class="item"></td><td class="check"><span class="cbox"></span></td></tr>';
    }
    var col = '<div class="col"><table class="ptable"><thead><tr>' +
      '<th class="c-task">Task</th><th class="c-check"></th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>';
    return {
      name: "Blank run sheet",
      fit: fit,
      clipped: fit.clipped,
      html: runSheetChrome(
        'Checklist <span class="wline inline" style="width:2.2in"></span>',
        "OPERATIONAL CHECKS",
        col + col,
        fit)
    };
  }

  /* ---------- rotation matrix (5.2) ---------- */
  /* Tasks down, occurrences across — a gap reads as neglect (SPEC §8).
     Frequency sets the period sets the column count:
       daily   → one week,  7 cols, 0.71in cells
       weekly  → one month, 5 cols, 1.00in cells
       monthly → one year, 12 cols, 0.42in cells (the tight case —
                 judged on paper before the editor existed)
     Cells take INITIALS, not a checkbox: a matrix spans a week or a
     year with many hands on it, so the who lives in the cell. Columns
     self-label; the sheet takes ONE date blank so stack printing holds.
     Sheet-level sign-off is Verified only — completion attribution is
     per cell, a single COMPLETED BY would claim a week of other
     people's work. */

  var MATRIX_FREQ = {
    daily: {
      cols: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
      dateLabel: "WEEK OF"
    },
    weekly: {
      cols: ["WK 1", "WK 2", "WK 3", "WK 4", "WK 5"],
      dateLabel: "MONTH"
    },
    monthly: {
      cols: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
             "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
      dateLabel: "YEAR"
    }
  };

  /**
   * One frequency section printed as a matrix.
   * @param {string} title  the sheet title (the group's name)
   * @param {Array}  tasks  [{name}] — blank names are skipped
   * @param {string} freq   "daily" | "weekly" | "monthly"
   * @param {string} [updatedAt]  for the version stamp
   */
  var MCOL = { width: 2.5 * 96 - 10, font: "600 15.5px " + STACK };

  function matrixSheet(title, tasks, freq, updatedAt, opts) {
    opts = opts || {};
    var measure = opts.measure || canvasMeasure;
    var cfg = MATRIX_FREQ[freq];
    if (!cfg) { return null; }
    var named = [], i;
    for (i = 0; i < tasks.length; i++) {
      if (tasks[i].name) { named.push(tasks[i]); }
    }
    if (!named.length) { return null; }

    /* Single-column fit without touching the engine: fitRows budgets
       ceil(total/2) rows per column, so 2n rows makes each column
       exactly n — same head/foot budget, cap, writable floor, and
       clipped semantics. Ceiling: 21 tasks; 18 sit at 42.06px.
       Wraps in the 2.5in task column are measured and budgeted like
       every other sheet — the first print-first pass missed this and
       only slack saved it. Both phantom columns carry the same lines so
       the per-column charge lands correctly. */
    var lines = [];
    for (i = 0; i < named.length; i++) {
      lines.push(lineCount(named[i].name, MCOL, measure));
    }
    var fit = root.RSFit.fitRows(named.length * 2,
      { lines: lines.concat(lines) });

    var colW = (5.0 / cfg.cols.length).toFixed(3) + "in";
    var h = '<table class="ptable mtable"><thead><tr>' +
      '<th class="c-mtask">Task</th>';
    for (i = 0; i < cfg.cols.length; i++) {
      h += '<th class="c-mcol" style="width:' + colW + '">' + cfg.cols[i] + "</th>";
    }
    h += "</tr></thead><tbody>";
    for (i = 0; i < named.length; i++) {
      h += '<tr' + ((i + 1) % 5 === 0 ? ' class="rule5"' : "") + '>' +
        '<td class="item">' + esc(named[i].name) + "</td>" +
        new Array(cfg.cols.length + 1).join('<td class="mcell"></td>') +
        "</tr>";
    }
    h += "</tbody></table>";

    return {
      name: title, fit: fit, clipped: fit.clipped,
      html:
        '<div class="sheet" style="' + root.RSFit.sheetStyle(fit) + '">' +
          '<div class="sheet-head">' +
            '<div>' +
              '<div class="sheet-title">' + esc(title) + '</div>' +
              '<div class="sheet-stamp">' + stampText(updatedAt, "CLEANING AND MAINTENANCE") + '</div>' +
            '</div>' +
            '<div class="sheet-meta">' + cfg.dateLabel +
              ' <span class="wline inline" style="width:1.6in"></span>' +
              '<div class="sheet-legend">A dash instead of initials means see notes.</div>' +
            '</div>' +
          '</div>' +
          h +
          '<div class="sheet-foot">' +
            '<div class="foot-notes">NOTES: <span class="wline inline" style="width:6.1in"></span></div>' +
            '<div class="foot-sign">Verified by <span class="wline inline" style="width:2.5in"></span></div>' +
          '</div>' +
        '</div>'
    };
  }

  /**
   * Blank matrix sheet (5.2 revision — Cleaning and Maintenance is its
   * own tool, Adam's correction): 18 empty task rows at the comfortable
   * height with the full grid, so a cleaning rotation can be written by
   * hand at the wall and typed in later.
   */
  function blankMatrixSheet(freq) {
    var cfg = MATRIX_FREQ[freq];
    if (!cfg) { return null; }
    var ROWS = 18;
    var fit = root.RSFit.fitRows(ROWS * 2);
    var colW = (5.0 / cfg.cols.length).toFixed(3) + "in";
    var h = '<table class="ptable mtable"><thead><tr>' +
      '<th class="c-mtask">Task</th>';
    var i;
    for (i = 0; i < cfg.cols.length; i++) {
      h += '<th class="c-mcol" style="width:' + colW + '">' + cfg.cols[i] + "</th>";
    }
    h += "</tr></thead><tbody>";
    for (i = 1; i <= ROWS; i++) {
      h += '<tr' + (i % 5 === 0 ? ' class="rule5"' : "") + '>' +
        '<td class="item"></td>' +
        new Array(cfg.cols.length + 1).join('<td class="mcell"></td>') +
        "</tr>";
    }
    h += "</tbody></table>";
    return {
      name: "Blank sheet", fit: fit, clipped: fit.clipped,
      html:
        '<div class="sheet" style="' + root.RSFit.sheetStyle(fit) + '">' +
          '<div class="sheet-head">' +
            '<div>' +
              '<div class="sheet-title">Checks <span class="wline inline" style="width:2.2in"></span></div>' +
              '<div class="sheet-stamp">CLEANING AND MAINTENANCE</div>' +
            '</div>' +
            '<div class="sheet-meta">' + cfg.dateLabel +
              ' <span class="wline inline" style="width:1.6in"></span>' +
              '<div class="sheet-legend">A dash instead of initials means see notes.</div>' +
            '</div>' +
          '</div>' +
          h +
          '<div class="sheet-foot">' +
            '<div class="foot-notes">NOTES: <span class="wline inline" style="width:6.1in"></span></div>' +
            '<div class="foot-sign">Verified by <span class="wline inline" style="width:2.5in"></span></div>' +
          '</div>' +
        '</div>'
    };
  }

  /* ---------- station setup sheet (6.3, print-first) ---------- */
  /* The utensils that BELONG at a station — Adam's call, 2026-08-14:
     its own sheet rather than a band on the shift sheet or a group in
     the stocking list, so the paper-calibrated shift sheet keeps every
     one of its 42 rows and its printed bytes. This is a REFERENCE
     posted at the station, not a daily fill: what lives here, how many,
     and where it goes back.

     Columns reuse the verified pars budget exactly — utensil 1.70 ·
     qty 0.40 · where 1.50 = 3.60in — so no new calibration is
     introduced and the two sheets read as one family side by side.
     Flat: no groups (a short list needs no sections; restraint until
     paper says otherwise). */

  var UCOLS = {
    item:  { width: 1.70 * 96 - 10, font: "600 15.5px " + STACK },
    where: { width: 1.50 * 96 - 10, font: "13px " + STACK }
  };

  function setupRows(utensils, measure) {
    var rows = [], i, u, nth = 0;
    for (i = 0; i < utensils.length; i++) {
      u = utensils[i];
      if (!u.name) { continue; }
      nth++;
      rows.push({
        type: "item", item: u,
        lines: Math.max(
          lineCount(u.name, UCOLS.item, measure),
          lineCount(u.where, UCOLS.where, measure)
        ),
        rule5: nth % 5 === 0
      });
    }
    return rows;
  }

  function setupColHtml(rows) {
    var h = '<table class="ptable utable"><thead><tr>' +
      '<th class="c-uitem">Utensil</th><th class="c-uqty">Qty</th>' +
      '<th class="c-uwhere">Where</th></tr></thead><tbody>';
    var i, r, qty;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      /* a utensil with no count prints a write-in rule, the same way a
         par does (§5): a list half-filled is still usable in marker */
      qty = r.item.qty != null && String(r.item.qty) !== ""
        ? esc(r.item.qty)
        : '<span class="wline"></span>';
      h += '<tr' + (r.rule5 ? ' class="rule5"' : "") + '>' +
        '<td class="item">' + esc(r.item.name) +
        '</td><td class="uqty">' + qty +
        '</td><td class="where">' + esc(r.item.where) + '</td></tr>';
    }
    return h + "</tbody></table>";
  }

  /* Paper corrections, Adam 2026-08-14, on the first printed pass:
       - NO SIGN-OFF. The sheet is posted at the station, not filled and
         filed, so there is nobody to sign it.
       - The utensil rows DON'T NEED MARKER SPACE. Nothing is written in
         them; they are read. Rows tighten to 30px, which is exactly the
         height that still lands the 15.5px cap (fs = rh × 0.52), so the
         list stays legible at arm's length while giving its space back.
       - THE SPACE BECOMES A LOG. What the tools don't use, the log
         takes: ruled write-in lines at marker height where the crew
         says what's missing or broken. A short station gets a bigger
         log, and the page is always full. */
  var SETUP_ROW = 30;      /* reference rows: read, never written in */
  var LOG_MIN = 150;       /* the log never shrinks past this */
  var LOG_LABEL = 26;      /* its label band */
  var LOG_LINE = 36;       /* a marker-writable line (0.36in floor) */

  function setupLogHtml(rowsPerCol, rh) {
    var used = rowsPerCol * (rh + 1.5);
    var h = root.RSFit.AVAIL - 88 - used;
    if (h < LOG_MIN) { h = LOG_MIN; }
    var n = Math.floor((h - LOG_LABEL) / LOG_LINE);
    if (n < 1) { n = 1; }
    var lines = "", i;
    for (i = 0; i < n; i++) {
      lines += '<div class="log-line"></div>';
    }
    return '<div class="setup-log" style="height:' + Math.round(h) + 'px">' +
      '<div class="log-label">Communications log</div>' + lines + '</div>';
  }

  function setupChrome(titleHtml, stamp, colsHtml, logHtml, fit) {
    return '<div class="sheet" style="' + root.RSFit.sheetStyle(fit) + '">' +
      '<div class="sheet-head">' +
        '<div>' +
          '<div class="sheet-title">' + titleHtml + '</div>' +
          '<div class="sheet-stamp">' + stamp + '</div>' +
        '</div>' +
        '<div class="sheet-meta">DATE <span class="wline inline" style="width:1.6in"></span></div>' +
      '</div>' +
      '<div class="cols">' + colsHtml + '</div>' +
      logHtml +
    '</div>';
  }

  /**
   * Station setup sheet — the utensils that belong at one station.
   * @param {object} station  { name, updatedAt, utensils[] } where a
   *                 utensil is { id, name, qty, where }. The field is
   *                 optional and absent-means-empty, so every existing
   *                 saved list keeps loading unchanged (SPEC §3).
   * @returns {{name, html, fit, rows, clipped}|null}  null when the
   *                 station carries no named utensils.
   */
  function setupSheet(station, opts) {
    opts = opts || {};
    var measure = opts.measure || canvasMeasure;
    var rows = setupRows(station.utensils || [], measure);
    if (!rows.length) { return null; }

    var fit = root.RSFit.fitRows(rows.length, {
      lines: rows.map(function (r) { return r.lines; }),
      foot: LOG_MIN, maxRow: SETUP_ROW, minRow: 24
    });
    var col1 = rows.slice(0, fit.split);
    var col2 = rows.slice(fit.split);
    var perCol = Math.max(col1.length, col2.length);

    return {
      name: station.name, fit: fit, rows: rows, clipped: fit.clipped,
      html: setupChrome(
        esc(station.name),
        stampText(station.updatedAt, "STATION SETUP"),
        '<div class="col">' + setupColHtml(col1) + '</div>' +
        '<div class="col">' + setupColHtml(col2) + '</div>',
        setupLogHtml(perCol, fit.rh),
        fit)
    };
  }

  /**
   * Blank setup sheet: walk the station, write down the tools that
   * live there, type them in later — the family's capture pattern.
   */
  function blankSetupSheet() {
    /* the capture sheet IS written in, so its rows keep marker height */
    var ROWS = 32;
    var fit = root.RSFit.fitRows(ROWS, { foot: 0 });
    var body = "", i;
    for (i = 1; i <= ROWS / 2; i++) {
      body += '<tr' + (i % 5 === 0 ? ' class="rule5"' : "") + '>' +
        '<td class="item"></td><td class="uqty"><span class="wline"></span></td>' +
        '<td class="where"></td></tr>';
    }
    var col = '<div class="col"><table class="ptable utable"><thead><tr>' +
      '<th class="c-uitem">Utensil</th><th class="c-uqty">Qty</th>' +
      '<th class="c-uwhere">Where</th></tr></thead><tbody>' +
      body + '</tbody></table></div>';
    return {
      name: "Blank setup sheet", fit: fit, clipped: fit.clipped,
      html: setupChrome(
        'Station <span class="wline inline" style="width:2.2in"></span>',
        "STATION SETUP", col + col, "", fit)
    };
  }

  /* ---------- prep sheets (6.1, print-first — SPEC §9) ---------- */
  /* Two artifacts, built on paper before any editor exists (the 5.2
     order, after 5.1 proved the other order fails). The COUNT SHEET is
     the reference carried into the walk-in: two-up like pars, build-to
     shown deliberately (the target is a management decision the counter
     should see), batch size as "1X =" because cooks speak in batches,
     ON HAND a marker write-in. The PREP LIST is the instruction: what
     to make today and nothing else — items are FILTERED, never
     reordered; survivors keep list order exactly; a group whose items
     all filter out drops its header; a day with nothing to prep says
     so instead of printing an empty grid. */

  /* Count-sheet columns per half: item 1.55 · build-to 0.70 ·
     1x 0.65 · on-hand 0.70 = the same verified 3.60in close.
     Item measures at semibold 15.5; the 1X cell at 13px like `where`.
     Mirrored in print.css; the suite asserts the mirror. */
  var PCOLS = {
    item: { width: 1.55 * 96 - 10, font: "600 15.5px " + STACK },
    px:   { width: 0.65 * 96 - 10, font: "13px " + STACK }
  };
  /* Prep-list columns per half (Adam's paper correction, 6.1: the list
     must hold far more than the single-column draft's ~21 rows):
     item 2.45 · make 0.70 · done 0.45 = the same 3.60in close.
     Long recipe names wrap and are budgeted like every other sheet. */
  var LCOLS = {
    item: { width: 2.45 * 96 - 10, font: "600 15.5px " + STACK }
  };
  /* Dense register (Adam's paper verdict, 6.1 round two: the one-page
     prep sheet "looks great" and the count sheet "could be similarly
     formatted"): THREE columns at a 24px floor and 13px type. Three
     columns still touches the §5 two-column lock — the register ships
     as the one-page path for prep only when Adam's printed page
     confirms the count sheet too. */
  var DCOLS = {
    item: { width: 1.60 * 96 - 10, font: "600 13px " + STACK }
  };
  /* dense count-sheet columns per third: item 1.28 · build-to 0.34 ·
     1x 0.38 · on-hand 0.40 = 2.40in. The working fields (name, the
     write-in) get the width; the reference numbers print at 11px.
     Long names and units wrap and are budgeted like everywhere else —
     the first cut (item 1.15) clipped in the real engine because
     20-char recipe names wrapped past the 24px floor's slack. */
  var PDCOLS = {
    item: { width: 1.28 * 96 - 10, font: "600 13px " + STACK },
    bto:  { width: 0.34 * 96 - 10, font: "11px " + STACK },
    px:   { width: 0.40 * 96 - 10, font: "11px " + STACK }
  };

  function prepGroupRowHtml(name, cont, span) {
    var label = esc(name) + (cont ? ' <span class="cont">(cont.)</span>' : "");
    return '<tr class="grow"><td class="gname" colspan="' + span + '">' +
      label + "</td></tr>";
  }

  function prepUnitText(value, unit) {
    if (value == null || String(value) === "") { return ""; }
    return esc(String(value)) + (unit ? " " + esc(unit) : "");
  }

  function prepCountRows(items) {
    var rows = [], prev = null, nth = 0, i, it, g;
    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (!it.name) { continue; }
      g = it.group || null;
      if (g !== prev) { nth = 0; }
      if (g && g !== prev) { rows.push({ type: "group", group: g, lines: 1 }); }
      /* NOTHING on a prep sheet wraps (Adam, 6.1 round four): every
         cell is white-space:nowrap in print.css, so every row is one
         line and the fit is exact. The editor caps item-name length;
         print metrics vs canvas metrics can no longer disagree about
         a borderline cell, which is what clipped the first dense
         count sheet on paper. */
      nth++;
      rows.push({ type: "item", item: it, group: g, lines: 1, rule5: nth % 5 === 0 });
      prev = g;
    }
    return rows;
  }

  function prepCountColHtml(rows, tclass) {
    var h = '<table class="ptable ' + (tclass || "ctable") + '"><thead><tr>' +
      '<th class="c-pitem">Item</th><th class="c-bto">Build to</th>' +
      '<th class="c-px">1x =</th><th class="c-oh">On hand</th></tr></thead><tbody>';
    var i, r;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (r.type === "group") {
        h += prepGroupRowHtml(r.group, r.cont, 4);
      } else {
        h += '<tr' + (r.rule5 ? ' class="rule5"' : "") + '>' +
          '<td class="item">' + esc(r.item.name) +
          '</td><td class="bto">' + prepUnitText(r.item.buildTo, r.item.unit) +
          '</td><td class="px">' + prepUnitText(r.item.batchSize, r.item.unit) +
          '</td><td class="oh"><span class="wline"></span></td></tr>';
      }
    }
    return h + "</tbody></table>";
  }

  /* Split rows into n columns of `per`, opening a (cont.) group header
     wherever a column starts mid-group — the page/column rule the
     whole family uses. The slices are computed ONCE and shared by the
     fit and the renderer, so the (cont.) rows the columns gain are
     budgeted (the 1.3 reserved-row lesson — a header the fit doesn't
     know about is a clipped row waiting to happen). */
  function denseSlices(rows, n, per) {
    var slices = [], i, start, slice;
    for (i = 0; i < n; i++) {
      start = i * per;
      slice = rows.slice(start, start + per);
      if (slice.length && slice[0].type === "item" && slice[0].group) {
        slice = [{ type: "group", group: slice[0].group, cont: true, lines: 1 }]
          .concat(slice);
      }
      slices.push(slice);
    }
    return slices;
  }

  /* Budget the TALLEST real column, not a max-of-all-columns phantom —
     merging line counts across columns double-charges every wrap and
     clips sheets that actually fit. Cost model mirrors fit.js: rows ×
     (rh + 1.5) + 20px per extra line, evaluated at the dense floor. */
  function denseFit(slices) {
    var worst = null, i, j, n, extra, cost;
    for (i = 0; i < slices.length; i++) {
      n = slices[i].length;
      extra = 0;
      for (j = 0; j < n; j++) { extra += (slices[i][j].lines - 1); }
      cost = n * (24 + 1.5) + extra * 20;
      if (!worst || cost > worst.cost) {
        worst = { cost: cost, n: n,
          lines: slices[i].map(function (r) { return r.lines; }) };
      }
    }
    var fit = root.RSFit.fitRows(worst.n * 2,
      { lines: worst.lines.concat(worst.lines), minRow: 24 });
    return { rh: fit.rh, fs: 13, clipped: fit.clipped, split: fit.split };
  }

  function prepSheetChrome(title, stamp, bodyHtml, fit, signHtml) {
    return '<div class="sheet" style="' + root.RSFit.sheetStyle(fit) + '">' +
      '<div class="sheet-head">' +
        '<div>' +
          '<div class="sheet-title">' + title + '</div>' +
          '<div class="sheet-stamp">' + stamp + '</div>' +
        '</div>' +
        '<div class="sheet-meta">DATE <span class="wline inline" style="width:1.6in"></span></div>' +
      '</div>' +
      bodyHtml +
      '<div class="sheet-foot">' +
        '<div class="foot-notes">NOTES: <span class="wline inline" style="width:6.1in"></span></div>' +
        '<div class="foot-sign">' + signHtml + '</div>' +
      '</div>' +
    '</div>';
  }

  function buildCountSheet(titleHtml, rows, updatedAt) {
    var fit = root.RSFit.fitRows(rows.length, {
      lines: rows.map(function (r) { return r.lines; }),
      groups: rows.map(function (r) { return r.group; })
    });
    var col1 = rows.slice(0, fit.split);
    var col2 = rows.slice(fit.split);
    if (fit.ragged) {
      col2.unshift({ type: "group", group: rows[fit.split].group, cont: true, lines: 1 });
    }
    return {
      fit: fit, rows: rows, clipped: fit.clipped,
      html: prepSheetChrome(titleHtml, stampText(updatedAt, "PREP"),
        '<div class="cols">' +
          '<div class="col">' + prepCountColHtml(col1) + '</div>' +
          '<div class="col">' + prepCountColHtml(col2) + '</div>' +
        '</div>',
        fit,
        'Counted by <span class="wline inline" style="width:2.5in"></span>')
    };
  }

  /* The large-print option (Adam, 6.1 round five): an explicit CHOICE
     to stay in the standard register — marker heights, big type — and
     split across two cohesive pages instead of going dense. For
     readers who need it; never automatic. Splits near the middle at a
     row boundary, page two titled (cont.), a mid-group break opening
     with a (cont.) group header. A page whose column split lands
     mid-group holds 41 rows, so two pages carry ~81 content rows —
     at the full 80-item/3-group max this option clips by two rows and
     says so; the dense one-pager always holds the max. */
  function paginateTwo(title, rows, updatedAt, build) {
    var half = Math.ceil(rows.length / 2);
    var best = null, fallback = null, probe, cut, page1, page2, a, b, o, offs;
    for (probe = 0; probe <= 4 && !best; probe++) {
      offs = probe === 0 ? [0] : [-probe, probe];
      for (o = 0; o < offs.length && !best; o++) {
        cut = half + offs[o];
        if (cut < 1 || cut >= rows.length) { continue; }
        page1 = rows.slice(0, cut);
        page2 = rows.slice(cut);
        if (page2[0].type === "item" && page2[0].group) {
          page2 = [{ type: "group", group: page2[0].group, cont: true, lines: 1 }]
            .concat(page2);
        }
        a = build(esc(title), page1, updatedAt);
        b = build(esc(title) + ' <span class="cont">(cont.)</span>', page2, updatedAt);
        if (!a.clipped && !b.clipped) { best = { a: a, b: b }; }
        if (probe === 0 && !fallback) { fallback = { a: a, b: b }; }
      }
    }
    if (!best) { best = fallback; }
    best.a.name = title;
    best.b.name = title + " (cont.)";
    return {
      sheets: [best.a, best.b],
      clipped: best.a.clipped || best.b.clipped,
      register: "pages"
    };
  }

  /**
   * The register SHIFTS with the size of the day (Adam, 6.1 round
   * three): a list that fits two-up at marker heights prints that
   * way — bigger rows, easier to read; a bigger day drops to the
   * dense three-column register and STAYS ONE PAGE. Past dense
   * capacity the clipped flag is loud; 80 items is the max the tool
   * designs for. opts.large is the reader-accessibility option: stay
   * in the standard register and allow TWO cohesive pages instead of
   * going dense (round five) — a user choice, never automatic.
   * @returns {{sheets, clipped, register: "standard"|"dense"|"pages"}}
   */
  function prepCountSheets(title, items, updatedAt, opts) {
    opts = opts || {};

    var rows = prepCountRows(items);
    if (!rows.length) { return null; }

    var one = buildCountSheet(esc(title), rows, updatedAt);
    if (!one.clipped) {
      one.name = title;
      return { sheets: [one], clipped: false, register: "standard" };
    }

    if (opts.large) {
      return paginateTwo(title, rows, updatedAt, buildCountSheet);
    }

    /* the day outgrew marker heights — shift to the dense one-page
       register: three columns, 24px floor */
    var drows = rows; /* identical either register — nothing wraps */
    var slices = denseSlices(drows, 3, Math.ceil(drows.length / 3));
    var dfit = denseFit(slices);
    if (!dfit.clipped) {
      return {
        register: "dense", clipped: false,
        sheets: [{
          name: title, fit: dfit, rows: drows, clipped: false,
          html: prepSheetChrome(esc(title), stampText(updatedAt, "PREP"),
            '<div class="cols dcols">' +
              slices.map(function (slice) {
                return '<div class="col">' + prepCountColHtml(slice, "dctable") + '</div>';
              }).join("") + '</div>',
            dfit,
            'Counted by <span class="wline inline" style="width:2.5in"></span>')
        }]
      };
    }

    /* Past even the dense register there is no third page — a sheet is
       ONE page (Adam, 6.1 round three: no two-page fallback; 80 items
       is the max and the dense register holds it). The clipped flag is
       loud and the editor holds the 80 line before anyone types past
       it. */
    return {
      register: "dense", clipped: true,
      sheets: [{
        name: title, fit: dfit, rows: drows, clipped: true,
        html: prepSheetChrome(esc(title), stampText(updatedAt, "PREP"),
          '<div class="cols dcols">' +
            slices.map(function (slice) {
              return '<div class="col">' + prepCountColHtml(slice, "dctable") + '</div>';
            }).join("") + '</div>',
          dfit,
          'Counted by <span class="wline inline" style="width:2.5in"></span>')
      }]
    };
  }

  function prepListRows(named) {
    var rows = [], prev = null, nth = 0, i, it, g;
    for (i = 0; i < named.length; i++) {
      it = named[i];
      g = it.group || null;
      if (g !== prev) { nth = 0; }
      if (g && g !== prev) { rows.push({ type: "group", group: g, lines: 1 }); }
      nth++;
      /* lines is always 1 — nothing on a prep sheet wraps (round four) */
      rows.push({ type: "item", item: it, group: g, lines: 1, rule5: nth % 5 === 0 });
      prev = g;
    }
    return rows;
  }

  function prepListColHtml(rows, tclass) {
    var h = '<table class="ptable ' + tclass + '"><thead><tr>' +
      '<th class="c-litem">Item</th><th class="c-make">Make</th>' +
      '<th class="c-done">Done</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.type === "group") {
        h += prepGroupRowHtml(r.group, r.cont, 3);
      } else {
        /* an item that needs prep but has no batch size prints a
           write-in MAKE (the §9 edge case: no invented math — the
           cook decides on the floor and writes it) */
        h += '<tr' + (r.rule5 ? ' class="rule5"' : "") + '>' +
          '<td class="item">' + esc(r.item.name) +
          '</td><td class="make">' +
          (r.item.make ? esc(r.item.make) : '<span class="wline"></span>') +
          '</td><td class="done"><span class="cbox"></span></td></tr>';
      }
    }
    return h + "</tbody></table>";
  }

  /**
   * The §9 calculation — the only math in the tool:
   *   shortfall  = buildTo − onHand
   *   multiplier = shortfall ÷ batchSize, to the nearest quarter
   * Expressed as a multiplier, never a rounded batch count. Returns
   * null when nothing needs making (no shortfall, or it rounds to 0 —
   * §9's draft position: close enough), "" when prep is needed but no
   * batch size is set (the sheet prints a write-in blank instead of
   * invented math), else the cook-shaped string ("1.25x").
   * A blank or unparseable count means zero (§9: blank means zero).
   */
  function prepMake(buildTo, onHand, batchSize) {
    var bt = parseFloat(buildTo);
    if (isNaN(bt)) { return null; }
    var oh = parseFloat(onHand);
    if (isNaN(oh)) { oh = 0; }
    var short = bt - oh;
    if (short <= 0) { return null; }
    var bs = parseFloat(batchSize);
    if (isNaN(bs) || bs <= 0) { return ""; }
    var m = Math.round((short / bs) * 4) / 4;
    if (m <= 0) { return null; }
    return String(m) + "x";
  }

  /**
   * Blank count sheet: the capture path for a kitchen with no prep
   * list yet — walk the coolers, write what you carry and what you
   * counted, type it in later. Full chrome, 30 write-in rows.
   */
  function blankCountSheet() {
    var ROWS = 30;
    var fit = root.RSFit.fitRows(ROWS);
    var body = "", i;
    for (i = 1; i <= ROWS / 2; i++) {
      body += '<tr' + (i % 5 === 0 ? ' class="rule5"' : "") + '>' +
        '<td class="item"></td><td class="bto"></td><td class="px"></td>' +
        '<td class="oh"><span class="wline"></span></td></tr>';
    }
    var col = '<div class="col"><table class="ptable ctable"><thead><tr>' +
      '<th class="c-pitem">Item</th><th class="c-bto">Build to</th>' +
      '<th class="c-px">1x =</th><th class="c-oh">On hand</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>';
    return {
      name: "Blank count sheet", fit: fit, clipped: fit.clipped,
      html: prepSheetChrome(
        'Prep <span class="wline inline" style="width:2.2in"></span>',
        "PREP",
        '<div class="cols">' + col + col + '</div>', fit,
        'Counted by <span class="wline inline" style="width:2.5in"></span>')
    };
  }

  function buildListSheet(titleHtml, rows, updatedAt) {
    var fit = root.RSFit.fitRows(rows.length, {
      lines: rows.map(function (r) { return r.lines; }),
      groups: rows.map(function (r) { return r.group; })
    });
    var col1 = rows.slice(0, fit.split);
    var col2 = rows.slice(fit.split);
    if (fit.ragged) {
      col2.unshift({ type: "group", group: rows[fit.split].group, cont: true, lines: 1 });
    }
    return {
      fit: fit, rows: rows, clipped: fit.clipped,
      html: prepSheetChrome(titleHtml, stampText(updatedAt, "PREP"),
        '<div class="cols">' +
          '<div class="col">' + prepListColHtml(col1, "ltable") + '</div>' +
          '<div class="col">' + prepListColHtml(col2, "ltable") + '</div>' +
        '</div>',
        fit,
        'Verified by <span class="wline inline" style="width:2.5in"></span>')
    };
  }

  /**
   * Prep list — the instruction (SPEC §9, corrected on paper through
   * 6.1). Same contract as prepCountSheets: the register shifts with
   * the day (standard two-up ≤42 rows, dense three-column above), one
   * page unless opts.large asks for the two-page standard spread.
   * rows are { name, make, group } ALREADY filtered by the caller;
   * this renderer never filters, never sorts, never computes.
   * An empty rows array is a REAL state: the sheet says nothing needs
   * prep rather than printing an empty grid.
   * @returns {{sheets, clipped, register: "standard"|"dense"|"pages"}}
   */
  function prepListSheets(title, items, updatedAt, opts) {
    opts = opts || {};
    var named = [], i;
    for (i = 0; i < items.length; i++) {
      if (items[i].name) { named.push(items[i]); }
    }

    if (!named.length) {
      var nofit = root.RSFit.fitRows(0);
      return {
        register: "standard", clipped: false,
        sheets: [{
          name: title, fit: nofit, clipped: false,
          html: prepSheetChrome(esc(title), stampText(updatedAt, "PREP"),
            '<div class="prep-none">Nothing to prep today &mdash; ' +
              'everything is at its build-to.</div>',
            nofit,
            'Verified by <span class="wline inline" style="width:2.5in"></span>')
        }]
      };
    }

    var rows = prepListRows(named);
    var one = buildListSheet(esc(title), rows, updatedAt);
    if (!one.clipped) {
      one.name = title;
      return { sheets: [one], clipped: false, register: "standard" };
    }

    if (opts.large) {
      return paginateTwo(title, rows, updatedAt, buildListSheet);
    }

    var lslices = denseSlices(rows, 3, Math.ceil(rows.length / 3));
    var dfit = denseFit(lslices);
    return {
      register: "dense", clipped: dfit.clipped,
      sheets: [{
        name: title, fit: dfit, rows: rows, clipped: dfit.clipped,
        html: prepSheetChrome(esc(title), stampText(updatedAt, "PREP"),
          '<div class="cols dcols">' +
            lslices.map(function (slice) {
              return '<div class="col">' + prepListColHtml(slice, "dtable") + '</div>';
            }).join("") + '</div>',
          dfit,
          'Verified by <span class="wline inline" style="width:2.5in"></span>')
      }]
    };
  }

  root.RSRender = {
    shiftSheet: shiftSheet,
    captureSheet: captureSheet,
    runSheet: runSheet,
    blankRunSheet: blankRunSheet,
    matrixSheet: matrixSheet,
    blankMatrixSheet: blankMatrixSheet,
    setupSheet: setupSheet,
    blankSetupSheet: blankSetupSheet,
    prepCountSheets: prepCountSheets,
    prepListSheets: prepListSheets,
    prepMake: prepMake,
    blankCountSheet: blankCountSheet,
    MATRIX_FREQ: MATRIX_FREQ,
    lineCount: lineCount,
    COLS: COLS,
    RCOLS: RCOLS,
    UCOLS: UCOLS,
    PCOLS: PCOLS,
    LCOLS: LCOLS,
    DCOLS: DCOLS,
    STACK: STACK
  };
})(window);
