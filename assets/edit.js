/* ==========================================================================
   edit.js — list operations for every editor
   --------------------------------------------------------------------------
   Every mutation of a list's items lives here, in one place, because
   list order is the single most protected property in the data model
   (locked, SPEC §3): the order is the physical walk of the station, and
   this project has already reordered a user's list once. Nothing in this
   file sorts, groups, or infers. scripts/test.js asserts order survives
   every operation exactly.

   Lifted to a factory in 5.1, the second tool's session. The operations
   were already generic; exactly three things were welded to the pars
   tool and are now configuration:
     - blankItem()   what a new row looks like
     - editable      which fields updateItem may touch
     - defaultName   what an unnamed list is called at creation
     - listKey       which array on the station it mutates (6.3)
   RSEdit remains the pars instance so nothing downstream moved.

   Items are mutated in place and unknown fields (group, slots, cell, id)
   pass through untouched — the editor edits its configured fields; it
   does not own the schema.

   Every mutation stamps list.updatedAt: the printed version stamp
   derives from it (SPEC §4), so an edited list prints as a new
   generation.
   ========================================================================== */

(function (root) {
  "use strict";

  function makeListEditor(cfg) {
    /* WHICH list on the station this editor mutates. A fourth welded
       point became configuration in 6.3, when a station grew a second
       list (its utensils) alongside its items. Defaults to "items",
       so every existing instance behaves byte-identically. */
    var KEY = cfg.listKey || "items";


    function stamp(station) {
      station.updatedAt = new Date().toISOString();
    }

    function indexOfId(station, id) {
      for (var i = 0; i < station[KEY].length; i++) {
        if (station[KEY][i].id === id) return i;
      }
      return -1;
    }

    /** Appends a blank item. No group is guessed — the tool never infers
        structure; assigning groups is the operator's act (2.3). */
    function addItem(station) {
      var it = cfg.blankItem();
      station[KEY].push(it);
      stamp(station);
      return it;
    }

    /** Only the configured fields — anything else is refused: other
        fields belong to other sessions. */
    function updateItem(station, id, field, value) {
      if (!cfg.editable[field]) return false;
      var i = indexOfId(station, id);
      if (i < 0) return false;
      station[KEY][i][field] = value;
      stamp(station);
      return true;
    }

    /** Swap with the neighbor above (dir -1) or below (dir +1). The item
        carries all its fields with it, group string included — moving an
        item never rewrites what the operator typed. */
    function moveItem(station, id, dir) {
      var i = indexOfId(station, id);
      var j = i + (dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= station[KEY].length) return false;
      var tmp = station[KEY][i];
      station[KEY][i] = station[KEY][j];
      station[KEY][j] = tmp;
      stamp(station);
      return true;
    }

    /** Move an item to an arbitrary position (4.1, the drag gesture).
        Same operation as the arrows, different reach: the USER moving
        their own list. The item keeps every field including its group —
        the order lock forbids the tool reordering, never the operator. */
    function moveItemTo(station, id, toIndex) {
      var i = indexOfId(station, id);
      if (i < 0 || toIndex < 0 || toIndex >= station[KEY].length) return false;
      if (i === toIndex) return false;
      var it = station[KEY].splice(i, 1)[0];
      station[KEY].splice(toIndex, 0, it);
      stamp(station);
      return true;
    }

    /** Insert a blank item directly below a row (4.1) — the cheap answer
        to add-into-a-group being add-then-move. The new row takes the
        group of the row above it: the operator chose the position, and
        the position IS the group. (Design call flagged to Adam — the
        alternative is inserting ungrouped and regrouping by hand.) */
    function insertItemAfter(station, id) {
      var i = indexOfId(station, id);
      if (i < 0) return null;
      var it = cfg.blankItem();
      it.group = station[KEY][i].group || "";
      station[KEY].splice(i + 1, 0, it);
      stamp(station);
      return it;
    }

    /** Removes the item and returns {item, index} so undo can put it back
        exactly where it was — not at the end, not re-sorted. */
    function removeItem(station, id) {
      var i = indexOfId(station, id);
      if (i < 0) return null;
      var it = station[KEY].splice(i, 1)[0];
      stamp(station);
      return { item: it, index: i };
    }

    /** Undo for removeItem: splice back at the original index. */
    function restoreItem(station, removed) {
      station[KEY].splice(removed.index, 0, removed.item);
      stamp(station);
    }

    /* ---------- groups (2.3) ---------- */
    /* Groups are read OFF the order, never imposed on it. This project
       has already sorted a user's list once (feta, celery, the
       backtracking cook) — nothing below moves an item, and there is no
       inference: names come from the operator, never from `where` or
       item names. */

    /** Contiguous runs of the group strings, in list order. A pure read.
        Ungrouped stretches come back with name "" so callers see the
        whole walk. */
    function runsOf(station) {
      var runs = [], cur = null, i, g;
      for (i = 0; i < station[KEY].length; i++) {
        g = station[KEY][i].group || "";
        if (!cur || cur.name !== g) {
          cur = { name: g, start: i, count: 0 };
          runs.push(cur);
        }
        cur.count++;
      }
      return runs;
    }

    /** Case/whitespace-insensitive key for MATCHING group names. Stored
        strings are never rewritten — this exists because "Low boy" and
        "low boy" print as identical uppercase headers, which made a
        split run invisible in Adam's phone smoke test (2.4): the sheet
        showed the group continuing into column two under a plain header
        with no (cont.), and nothing on screen explained why. */
    function foldGroup(name) {
      return String(name || "").replace(/\s+/g, " ").toLowerCase();
    }

    /** Folded keys of group names that head more than one run — the
        split-run FACT the editor surfaces, catching case and spacing
        variants that display identically. Two separate areas may
        genuinely share a name; the user decides, nothing is auto-fixed. */
    function splitRunNames(station) {
      var runs = runsOf(station), seen = {}, dup = {}, out = [], i, key;
      for (i = 0; i < runs.length; i++) {
        if (!runs[i].name) continue;
        key = foldGroup(runs[i].name);
        if (seen[key] && !dup[key]) { dup[key] = true; out.push(key); }
        seen[key] = true;
      }
      return out;
    }

    /** The one grouping gesture: from this item, forward through every
        consecutive item sharing its current group, assign `name`.
        - at the first item of a run: renames the whole run
        - mid-run: starts a new group here (splits the run deliberately)
        - on an ungrouped item: names the rest of the ungrouped stretch
        - name "": ungroups the same span
        Order is untouched by construction — only group strings change. */
    function setRunGroup(station, id, name) {
      var i = indexOfId(station, id);
      if (i < 0) return false;
      var old = station[KEY][i].group || "";
      while (i < station[KEY].length && (station[KEY][i].group || "") === old) {
        station[KEY][i].group = name;
        i++;
      }
      stamp(station);
      return true;
    }

    /* ---------- list-level operations (2.2) ---------- */
    /* Named "station" for history — the pars tool got here first. They
       apply to any named list. */

    /** A new list starts with one blank row and NO updatedAt — a list
        never edited has no version, and the stamp prints bare until the
        first real edit (SPEC §4).
        An unnamed list gets a real, editable name at creation (Adam,
        4.1): positional tab labels made moves invisible and blank names
        printed sheets with no title. cfg.defaultName + N counts from
        creation, skipping past any name already taken. */
    function createStation(state, name) {
      if (!name) {
        var n = state.stations.length + 1, taken = {}, i;
        for (i = 0; i < state.stations.length; i++) taken[state.stations[i].name] = true;
        while (taken[cfg.defaultName + " " + n]) n++;
        name = cfg.defaultName + " " + n;
      }
      var st = {
        id: root.RS.uid(),
        name: name,
        updatedAt: null,
        items: [cfg.blankItem()]
      };
      state.stations.push(st);
      return st;
    }

    function renameStation(station, name) {
      station.name = name;
      stamp(station);
    }

    /** Removes the list and returns {station, index} so undo can put it
        back exactly where it was — list order is the user's too. */
    function removeStation(state, index) {
      if (index < 0 || index >= state.stations.length) return null;
      var st = state.stations.splice(index, 1)[0];
      return { station: st, index: index };
    }

    function restoreStation(state, removed) {
      state.stations.splice(removed.index, 0, removed.station);
    }

    /** List order is organizational, not the walk — its only semantic
        is the order "print all" produces (SPEC §3 covers item order,
        not this). Still user-driven only. */
    function moveStation(state, index, dir) {
      var j = index + (dir < 0 ? -1 : 1);
      if (index < 0 || index >= state.stations.length || j < 0 ||
          j >= state.stations.length) return false;
      var tmp = state.stations[index];
      state.stations[index] = state.stations[j];
      state.stations[j] = tmp;
      return true;
    }

    /** Arbitrary list reposition (the tab-drag gesture, 4.1 revision:
        the arrows moved stations correctly but illegibly — a swap among
        eight similar pills reads as nothing. Dragging the tab makes the
        placement visible). */
    function moveStationTo(state, fromIndex, toIndex) {
      if (fromIndex < 0 || fromIndex >= state.stations.length ||
          toIndex < 0 || toIndex >= state.stations.length ||
          fromIndex === toIndex) return false;
      var st = state.stations.splice(fromIndex, 1)[0];
      state.stations.splice(toIndex, 0, st);
      return true;
    }

    return {
      addItem: addItem,
      updateItem: updateItem,
      moveItem: moveItem,
      moveItemTo: moveItemTo,
      insertItemAfter: insertItemAfter,
      removeItem: removeItem,
      restoreItem: restoreItem,
      moveStation: moveStation,
      moveStationTo: moveStationTo,
      runsOf: runsOf,
      splitRunNames: splitRunNames,
      foldGroup: foldGroup,
      setRunGroup: setRunGroup,
      createStation: createStation,
      renameStation: renameStation,
      removeStation: removeStation,
      restoreStation: restoreStation
    };
  }

  root.RSListEdit = makeListEditor;

  /* The pars tool's editor: items are {name, par, where} per SPEC §3. */
  root.RSEdit = makeListEditor({
    blankItem: function () {
      return { id: root.RS.uid(), name: "", par: "", where: "", group: "" };
    },
    editable: { name: true, par: true, where: true },
    defaultName: "Station"
  });
})(window);
