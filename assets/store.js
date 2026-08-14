/* ==========================================================================
   store.js — on-device storage + JSON backup, shared by all tools
   --------------------------------------------------------------------------
   No accounts, no server. Data lives in localStorage on whatever device
   made it, and moves between devices as a JSON file. The JSON file is the
   source of truth; localStorage is a convenience.

   Audited 2026-08-08 (session 2.1) before the editor made it load-bearing.
   Findings and fixes are noted at makeStore below.
   ========================================================================== */

(function (root) {
  "use strict";

  var idCounter = 0;
  function uid() { return Date.now().toString(36) + "-" + (idCounter++).toString(36); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    var m = String(d.getMonth() + 1); if (m.length < 2) m = "0" + m;
    var day = String(d.getDate()); if (day.length < 2) day = "0" + day;
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function today() { return fmtDate(new Date().toISOString()); }

  /* Private browsing and some locked-down phone browsers throw on write.
     Detect once so the tool can warn instead of silently losing work. */
  var canStore = (function () {
    try {
      localStorage.setItem("__rs_test", "1");
      localStorage.removeItem("__rs_test");
      return true;
    } catch (e) { return false; }
  })();

  /**
   * @param {string} key      localStorage key, versioned e.g. "pars-guides-v1"
   * @param {function} seed   returns a fresh default state
   * @param {function} valid  (parsed) => boolean, shape check on load
   *
   * 2.1 audit findings, all fixed here:
   *  - Storage off (private mode, locked-down phones): save() used to
   *    clear the status and say nothing — silent discard. It now warns,
   *    and the warning stays up.
   *  - The 600ms debounce could lose the last edit if the page was closed
   *    or backgrounded inside the window. On a phone that is the common
   *    case, not an edge case: flush() writes immediately and rides
   *    pagehide + visibilitychange.
   *  - A corrupt or wrong-shape stored value fell back to seed() and the
   *    next save overwrote the only copy. The unreadable blob is now
   *    stashed at key + ".bad" and api.hadBadData is set so the page can
   *    say so.
   */
  function makeStore(key, seed, valid) {
    var timer = null;
    var pending = null; /* last state handed to save() but not yet written */

    function load() {
      if (canStore) {
        var raw = null;
        try {
          raw = localStorage.getItem(key);
          if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && valid(parsed)) return parsed;
          }
        } catch (e) {}
        if (raw) {
          /* Whatever was stored is unreadable or the wrong shape. Stash
             it before any save can overwrite the only copy — never
             silently discard work. */
          api.hadBadData = true;
          try { localStorage.setItem(key + ".bad", raw); } catch (e2) {}
        }
      }
      return seed();
    }

    function write(state, onState) {
      if (!canStore) {
        onState("Not saved — this browser has storage turned off");
        return;
      }
      try {
        localStorage.setItem(key, JSON.stringify(state));
        pending = null;
        onState("Saved");
        setTimeout(function () { onState(""); }, 1800);
      } catch (e) {
        onState("Save failed — storage is full on this device");
      }
    }

    /** Debounced write. onState receives status copy for .save-state. */
    function save(state, onState) {
      onState = onState || function () {};
      pending = { state: state, onState: onState };
      onState("Saving…");
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; flush(); }, 600);
    }

    /** Write NOW. Rides pagehide/visibilitychange so backgrounding the
        page never eats the last keystroke inside the debounce window. */
    function flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending) { write(pending.state, pending.onState); }
    }

    if (root.addEventListener) {
      root.addEventListener("pagehide", flush);
      if (root.document) {
        root.document.addEventListener("visibilitychange", function () {
          if (root.document.visibilityState === "hidden") flush();
        });
      }
    }

    var api = { load: load, save: save, flush: flush, key: key, hadBadData: false };
    return api;
  }

  /* ---------- backup ---------- */

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /** Downloads {exportedAt, ...payload} as prefix-YYYY-MM-DD.json, returns the name. */
  function exportBackup(prefix, payload) {
    var name = prefix + "-" + today() + ".json";
    var body = { exportedAt: new Date().toISOString() };
    for (var k in payload) if (payload.hasOwnProperty(k)) body[k] = payload[k];
    download(name, JSON.stringify(body, null, 2));
    return name;
  }

  /**
   * Reads a picked file and hands back parsed JSON.
   * @param {File} file
   * @param {function} valid  (parsed) => boolean
   * @param {function} onOk   (parsed) => void
   * @param {function} onErr  (message) => void
   */
  function readBackup(file, valid, onOk, onErr) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        onErr("That file isn't readable JSON.");
        return;
      }
      if (!valid(parsed)) {
        onErr("That file doesn't look like a backup for this tool.");
        return;
      }
      onOk(parsed);
    };
    reader.onerror = function () { onErr("Couldn't read that file."); };
    reader.readAsText(file);
  }

  /* ---------- one file for everything (6.4) ----------
     Four tools meant four files to keep track of, which is how saving
     copies quietly stops happening. One file holds all of them.

     The tools still do not know about each other (SPEC §8) — the
     STORAGE layer knows about storage, which is the only place this
     coupling belongs. A page asks RS to save everything; it never
     reaches into another tool.

     NOT INCLUDED, deliberately: the prep counts draft. Today's counts
     are ephemeral by lock (§9) — the moment they ride along in a saved
     file they start accumulating, and that is an audit trail. */
  var TOOLS = [
    { key: "pars-guides-v1", name: "Station Setup and Pars" },
    { key: "checklists-v1", name: "Operational Checks" },
    { key: "cleaning-checks-v1", name: "Cleaning and Maintenance Checks" },
    { key: "prep-lists-v1", name: "Prep Lists" }
  ];

  function readKey(key) {
    if (!canStore) { return null; }
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /**
   * Saves every tool's lists as one file.
   * @param {string} [liveKey]    the calling tool's storage key
   * @param {object} [liveState]  its state right now — passed in so the
   *          copy is current even if the debounce hasn't flushed or
   *          storage is off entirely.
   */
  function exportEverything(liveKey, liveState) {
    var tools = {}, i, k, v;
    for (i = 0; i < TOOLS.length; i++) {
      k = TOOLS[i].key;
      v = (k === liveKey && liveState) ? liveState : readKey(k);
      if (v) { tools[k] = v; }
    }
    var name = "line-tools-backup-" + today() + ".json";
    download(name, JSON.stringify({
      lineTools: 1,
      exportedAt: new Date().toISOString(),
      tools: tools
    }, null, 2));
    return name;
  }

  /** True for a whole-site file; false for a single tool's older one. */
  function isEverything(parsed) {
    return !!(parsed && parsed.lineTools && parsed.tools &&
      typeof parsed.tools === "object");
  }

  /** How many tools' lists a combined file carries, for the confirm. */
  function countsIn(parsed) {
    var n = 0, i;
    for (i = 0; i < TOOLS.length; i++) {
      if (parsed.tools[TOOLS[i].key]) { n++; }
    }
    return n;
  }

  /**
   * Writes every tool's lists back. Only the four known keys are
   * touched — a file cannot introduce storage of its own.
   * @returns {number} how many tools were restored
   */
  function restoreEverything(parsed) {
    if (!canStore) { return 0; }
    var n = 0, i, k;
    for (i = 0; i < TOOLS.length; i++) {
      k = TOOLS[i].key;
      if (parsed.tools[k]) {
        try {
          localStorage.setItem(k, JSON.stringify(parsed.tools[k]));
          n++;
        } catch (e) {}
      }
    }
    return n;
  }

  root.RS = {
    uid: uid,
    esc: esc,
    fmtDate: fmtDate,
    today: today,
    canStore: canStore,
    makeStore: makeStore,
    download: download,
    exportBackup: exportBackup,
    readBackup: readBackup,
    TOOLS: TOOLS,
    exportEverything: exportEverything,
    isEverything: isEverything,
    countsIn: countsIn,
    restoreEverything: restoreEverything
  };
})(window);
