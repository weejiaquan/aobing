'use strict';
// Pure data helpers for the Fishdex + Inventory browsing UI. No DOM.
(function () {
  var ENGINE = (typeof require === 'function') ? require('./fishing.js') : window.FishingEngine;
  var floatToGrade = ENGINE.floatToGrade;

  function dexEntries(fishdex, fishList) {
    return fishList.map(function (fish) {
      var a = fishdex[fish.id];
      if (a && a.count > 0) {
        return {
          fish: fish, caught: true, count: a.count,
          maxSize: a.maxSize || 0, bestFloat: a.bestFloat == null ? 1 : a.bestFloat,
          grade: floatToGrade(a.bestFloat == null ? 1 : a.bestFloat), shiny: !!a.shinyCaught,
        };
      }
      return { fish: fish, caught: false, count: 0, maxSize: 0, bestFloat: 1, grade: null, shiny: false };
    });
  }

  function dexSummary(fishdex, fishList) {
    var caught = 0, byFamily = {};
    fishList.forEach(function (fish) {
      var got = !!(fishdex[fish.id] && fishdex[fish.id].count > 0);
      if (got) caught++;
      var fam = byFamily[fish.family] || (byFamily[fish.family] = { caught: 0, total: 0 });
      fam.total++; if (got) fam.caught++;
    });
    return { caught: caught, total: fishList.length, byFamily: byFamily };
  }

  function groupByFamily(entries) {
    var order = [], map = {};
    entries.forEach(function (e) {
      var fam = e.fish.family;
      if (!map[fam]) { map[fam] = { family: fam, entries: [] }; order.push(map[fam]); }
      map[fam].entries.push(e);
    });
    return order;
  }

  function specimenView(spec, fishById) {
    var f = fishById[spec.species];
    return {
      species: spec.species, name: f ? f.name : spec.species,
      size: spec.size, float: spec.float, grade: floatToGrade(spec.float),
      shiny: !!spec.shiny, caughtAt: spec.caughtAt,
    };
  }

  function sortSpecimens(specimens, key) {
    var out = specimens.slice();
    out.sort(function (a, b) {
      if (key === 'size') return b.size - a.size;
      if (key === 'float') return a.float - b.float;        // lower float (better) first
      if (key === 'species') return a.species < b.species ? -1 : a.species > b.species ? 1 : (b.size - a.size);
      return (b.caughtAt || 0) - (a.caughtAt || 0);          // 'recent' default
    });
    return out;
  }

  function filterSpecimens(specimens, opts) {
    opts = opts || {};
    return specimens.filter(function (s) {
      if (opts.species && s.species !== opts.species) return false;
      if (opts.shinyOnly && !s.shiny) return false;
      return true;
    });
  }

  var API = { dexEntries: dexEntries, dexSummary: dexSummary, groupByFamily: groupByFamily, specimenView: specimenView, sortSpecimens: sortSpecimens, filterSpecimens: filterSpecimens };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.FishingDex = API;
})();
