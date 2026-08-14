/* ==========================================================================
   fit.js — one-page row fitting, two columns
   --------------------------------------------------------------------------
   Given a sheet's row count (items + group headers), returns the row height
   and font size that fill exactly one printed sheet. Every printable tool on
   this site uses this.

   The sheet is two columns read down-then-across (SPEC §4): column one takes
   ceil(total/2) rows, column two the rest. Both columns share one --rh, so
   whichever column needs the smaller row height governs.

   The -1.5px per row is the whole trick: with border-collapse, each row's
   bottom border is shared, and the accumulated rounding slack across 20-30
   rows is enough to push the last row onto page two. Subtracting it up
   front is what stopped that happening.
   ========================================================================== */

(function (root) {
  "use strict";

  /* Usable pixel height inside a 9.92in clipped sheet at 96dpi.
     Deliberately a touch under the true figure (952.32) — slack is free,
     spill isn't. */
  var AVAIL = 952;

  /* Cost of the second line of a wrapped row, charged to the column that
     holds the row. One extra line is font-size × ~1.29 line-height; with
     the writable floor at 34.56px the derived font size always caps at
     15.5px, so 15.5 × 1.29 ≈ 20. Rounded up — overestimate, slack is
     free. */
  var WRAP_EXTRA = 20;

  /**
   * @param {number} total  rows that must fit: items + group headers
   * @param {object} [opts]
   * @param {number} [opts.head=88]  px reserved for sheet header + column
   *                                 headers. Overestimate this: a header
   *                                 that measures larger than you budgeted
   *                                 eats the last row.
   * @param {number} [opts.foot=80]  px reserved for the footer — the 86
   *                                 line plus the Completed by / Verified
   *                                 by block, each with a marker-height
   *                                 writing band (~0.33in) above its rule.
   *                                 Was 48; the first paper print showed
   *                                 pen-sized bands nobody could write in
   *                                 (Adam, option B, 2026-08-07 — costs
   *                                 the hard ceiling two rows: 44 → 42).
   *                                 Overestimate, same reason as head.
   * @param {number} [opts.maxRow=53]  px (0.55in) — the comfortable target
   *                                 height, and the cap (SPEC §4, amended
   *                                 2026-08-07): short stations print at
   *                                 this height so sheets share one rhythm
   *                                 instead of stretching to fill the
   *                                 page. Short sheets leave white space
   *                                 and the footer pins to the page
   *                                 bottom, which reads as deliberate.
   *                                 With the 80px footer the cap binds
   *                                 through 28 rows; 29 rows compute to
   *                                 50.77px and the table governs from
   *                                 there.
   * @param {number} [opts.minRow=34.56]  px (0.36in) — the writable floor,
   *                                 calibrated against the sheets on the
   *                                 wall: 0.48in comfortable, 0.36in
   *                                 cramped, below that a marker doesn't
   *                                 fit (SPEC §4). The old 16px floor was
   *                                 a screen number with no reference to
   *                                 handwriting (SPEC §7 defect 2).
   * @param {number[]} [opts.lines]  per-row line count, 1 or more. A cell
   *                                 that wraps in its column makes a
   *                                 multi-line row; the caller measures,
   *                                 this budgets — each line past the
   *                                 first spends WRAP_EXTRA against its
   *                                 column. Missing entries count as 1.
   * @param {Array} [opts.groups]    per-row group key (string or null),
   *                                 header rows included — a header row
   *                                 carries its own group's key; ungrouped
   *                                 rows are null or "". Used only to
   *                                 detect a ragged split.
   * @returns {{rh:number, fs:number, split:number, clipped:boolean,
   *          ragged:boolean}}
   *          rh/fs in px.
   *          split — content rows in column one, ceil(total/2). Renderers
   *          lay out from this value rather than re-deriving it.
   *          clipped — the rows can't fit even at the minimum row height;
   *          the sheet's overflow:hidden will cut them off. Callers MUST
   *          surface this before the print dialog opens; a clipped row is
   *          an item that silently vanishes from the printed sheet.
   *          ragged — column two opens mid-group: its first row belongs to
   *          the same group as column one's last row, so the renderer must
   *          repeat the group header with "(cont.)" and its checks
   *          (SPEC §4/§5). fitRows budgets that inserted row in column
   *          two's total itself, so the renderer inserts and NEVER
   *          re-fits. (1.3: the old re-fit-at-total+1 contract was only
   *          stable for odd totals — ceil moves across the increment for
   *          even ones, which is a layout oscillation. Reserving the row
   *          here prices it into rh and clipped directly: a ragged sheet
   *          spends one row of capacity, so its ceiling is 41 rows, not
   *          42.)
   */
  function fitRows(total, opts) {
    opts = opts || {};
    var HEAD  = opts.head   == null ? 88 : opts.head;
    var FOOT  = opts.foot   == null ? 80 : opts.foot;
    var MAXRH = opts.maxRow == null ? 53 : opts.maxRow;
    var MINRH = opts.minRow == null ? 34.56 : opts.minRow;
    var lines = opts.lines;
    var groups = opts.groups;

    if (!total || total < 1) total = 1;

    var budget = AVAIL - HEAD - FOOT;
    var split = Math.ceil(total / 2);

    /* Extra lines per column. A wrapped row spends against the column
       that holds it, so the same list can fit or not depending on where
       its wrappers land. */
    var extra1 = 0, extra2 = 0, i, n;
    if (lines) {
      for (i = 0; i < total; i++) {
        n = lines[i] > 1 ? lines[i] - 1 : 0;
        if (n) {
          if (i < split) { extra1 += n; } else { extra2 += n; }
        }
      }
    }

    /* Ragged: column two starts on a row that continues column one's
       group. Structure comes from the caller's explicit group keys —
       never parsed out of `where`. Computed before the row height
       because a ragged split reserves the (cont.) header's row below. */
    var ragged = false;
    if (groups && split < total) {
      var g = groups[split];
      if (g != null && g !== "" && groups[split - 1] === g) ragged = true;
    }

    /* The tighter column governs; both share one --rh. A ragged split
       adds the (cont.) header row to column two's count. */
    var rh = (budget - extra1 * WRAP_EXTRA) / split - 1.5;
    if (total > split) {
      var rows2 = (total - split) + (ragged ? 1 : 0);
      var rh2 = (budget - extra2 * WRAP_EXTRA) / rows2 - 1.5;
      if (rh2 < rh) rh = rh2;
    }

    /* Clipped is decided before the clamp: if the ideal height is under
       the writable floor, clamping up to the floor overflows the sheet
       box, and overflow:hidden eats the excess. */
    var clipped = rh < MINRH;

    if (rh > MAXRH) rh = MAXRH;
    if (rh < MINRH) rh = MINRH;
    rh = Math.round(rh * 100) / 100;

    /* Font follows row height. With the 34.56px floor this always lands
       on the 15.5 cap; the derivation and both clamps are kept verbatim
       because they become load-bearing the moment anyone lowers minRow. */
    var fs = rh * 0.52;
    if (fs > 15.5) fs = 15.5;
    if (fs < 10.5) fs = 10.5;
    fs = Math.round(fs * 2) / 2;

    return { rh: rh, fs: fs, split: split, clipped: clipped, ragged: ragged };
  }

  /**
   * Honest per-sheet maximum: the most rows (items + group headers) that
   * fit two columns at the writable floor, for a given header/footer
   * budget. 42 by default — the hard ceiling falls straight out of the
   * arithmetic: floor(784 / (34.56 + 1.5)) = 21 rows per column. It was
   * 44 at the 48px footer; the marker-height footer bought writing room
   * with two rows of ceiling (Adam, 2026-08-07). The original figure of
   * 54 came from the 16px screen floor and was wrong on paper (SPEC §7
   * defect 2). Assumes single-line rows and no split group; wrapped rows
   * spend against this, and a group split across the gap costs one row
   * (fitRows reserves the (cont.) header), making a ragged sheet's real
   * ceiling 41.
   */
  function capacity(opts) {
    opts = opts || {};
    var HEAD  = opts.head   == null ? 88 : opts.head;
    var FOOT  = opts.foot   == null ? 80 : opts.foot;
    var MINRH = opts.minRow == null ? 34.56 : opts.minRow;
    var perCol = Math.floor((AVAIL - HEAD - FOOT) / (MINRH + 1.5));
    return perCol > 0 ? perCol * 2 : 0;
  }

  /** Inline style string for a .sheet element. */
  function sheetStyle(fit) {
    return "--rh:" + fit.rh + "px;--fs:" + fit.fs + "px";
  }

  root.RSFit = {
    fitRows: fitRows,
    sheetStyle: sheetStyle,
    capacity: capacity,
    AVAIL: AVAIL
  };
})(window);
