'use strict';
// DOM/canvas renderer for the Fishdex + Inventory browsing panel. window.FishingDexUI.
(function () {
  var deps = null, els = {}, tab = 'fishdex', sortKey = 'recent', filterShiny = false, filterSpecies = '';
  var io = null; // IntersectionObserver for lazy sprite draws

  function el(id) { return document.getElementById(id); }

  function init(d) {
    deps = d;
    els.panel = el('fishing-dex-panel');
    els.tabs = el('fishing-dex-tabs');
    els.progress = el('fishing-dex-progress');
    els.controls = el('fishing-dex-controls');
    els.body = el('fishing-dex-body');
    els.close = el('fishing-dex-close');
    els.inspect = el('fishing-inspect');
    els.inspectCard = el('fishing-inspect-card');
    els.close.addEventListener('click', doClose);
    els.tabs.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-dextab]'); if (!b) return;
      tab = b.getAttribute('data-dextab');
      els.tabs.querySelectorAll('button').forEach(function (x) { x.classList.toggle('sel', x === b); });
      render();
    });
    els.inspect.addEventListener('click', function (e) { if (e.target === els.inspect) els.inspect.classList.remove('show'); });
  }

  function ensureObserver() {
    if (io) io.disconnect();
    io = new IntersectionObserver(function (rows) {
      rows.forEach(function (r) {
        if (r.isIntersecting) { drawCell(r.target); io.unobserve(r.target); }
      });
    }, { root: els.body, rootMargin: '120px' });
  }

  function drawCell(canvas) {
    var spec = canvas.__spec;
    if (spec && window.FishSprite && window.FishSprite.drawFish) {
      try { window.FishSprite.drawFish(canvas.getContext('2d'), spec, 0); } catch (e) {}
    }
  }

  function makeCanvas(spec, w, h) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h; cv.__spec = spec;
    io.observe(cv);
    return cv;
  }

  function render() {
    ensureObserver();
    if (tab === 'fishdex') renderFishdex(); else renderInventory();
  }

  function renderFishdex() {
    els.controls.innerHTML = '';
    var fishdex = deps.getFishdex(), FISH = window.FishData.FISH;
    var summary = window.FishingDex.dexSummary(fishdex, FISH);
    els.progress.textContent = 'Caught ' + summary.caught + ' / ' + summary.total;
    var groups = window.FishingDex.groupByFamily(window.FishingDex.dexEntries(fishdex, FISH));
    els.body.innerHTML = '';
    groups.forEach(function (g) {
      var fam = summary.byFamily[g.family] || { caught: 0, total: g.entries.length };
      var title = document.createElement('div');
      title.className = 'fdex-family-title';
      title.textContent = g.family + '  (' + fam.caught + '/' + fam.total + ')';
      els.body.appendChild(title);
      var grid = document.createElement('div'); grid.className = 'fdex-grid';
      g.entries.forEach(function (e) { grid.appendChild(dexCell(e)); });
      els.body.appendChild(grid);
    });
  }

  function stars(n) { return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n); }

  function dexCell(e) {
    var h = deps.escapeHtml;
    var cell = document.createElement('div');
    cell.className = 'fdex-cell' + (e.caught ? '' : ' uncaught');
    var spec = window.FishSprite.fishSpriteSpec(e.fish, { float: e.bestFloat, shiny: e.shiny });
    cell.appendChild(makeCanvas(spec, 104, 64));
    if (e.caught) {
      cell.innerHTML += '<div class="fdex-name">' + h(e.fish.name) + (e.shiny ? ' <span class="fdex-shiny">✨</span>' : '') + '</div>' +
        '<div class="fdex-sub">' + stars(e.fish.rarity) + '</div>' +
        '<div class="fdex-sub">×' + e.count + ' · ' + e.maxSize.toFixed(0) + 'cm · ' + h(e.grade) + '</div>';
    } else {
      cell.innerHTML += '<div class="fdex-name">???</div><div class="fdex-sub">' + stars(e.fish.rarity) + '</div>';
    }
    return cell;
  }

  function renderInventory() {
    var FISH_BY_ID = window.FishData.FISH_BY_ID;
    var all = deps.getSpecimens();
    // controls: sort select, species filter, shiny toggle
    els.controls.innerHTML =
      '<label>Sort <select id="fdex-sort">' +
      ['recent', 'size', 'float', 'species'].map(function (k) { return '<option value="' + k + '"' + (k === sortKey ? ' selected' : '') + '>' + k + '</option>'; }).join('') +
      '</select></label>' +
      '<label><input type="checkbox" id="fdex-shiny"' + (filterShiny ? ' checked' : '') + '> shiny only</label>' +
      '<span class="fdex-sub" id="fdex-count"></span>';
    el('fdex-sort').addEventListener('change', function (e) { sortKey = e.target.value; renderInventory(); });
    el('fdex-shiny').addEventListener('change', function (e) { filterShiny = e.target.checked; renderInventory(); });

    var list = window.FishingDex.filterSpecimens(all, { species: filterSpecies || undefined, shinyOnly: filterShiny });
    list = window.FishingDex.sortSpecimens(list, sortKey);
    els.progress.textContent = 'Specimens ' + all.length;
    el('fdex-count').textContent = list.length + ' shown';
    els.body.innerHTML = '';
    var grid = document.createElement('div'); grid.className = 'fdex-grid';
    list.forEach(function (sp) { grid.appendChild(invCell(window.FishingDex.specimenView(sp, FISH_BY_ID), sp)); });
    els.body.appendChild(grid);
  }

  function invCell(v, raw) {
    var h = deps.escapeHtml;
    var fish = window.FishData.FISH_BY_ID[v.species];
    var cell = document.createElement('div'); cell.className = 'fdex-cell inv';
    var spec = window.FishSprite.fishSpriteSpec(fish, { float: v.float, shiny: v.shiny });
    cell.appendChild(makeCanvas(spec, 104, 64));
    cell.innerHTML += '<div class="fdex-name">' + h(v.name) + (v.shiny ? ' <span class="fdex-shiny">✨</span>' : '') + '</div>' +
      '<div class="fdex-sub">' + v.size.toFixed(1) + 'cm · ' + h(v.grade) + '</div>';
    cell.addEventListener('click', function () { showInspect(v); });
    return cell;
  }

  function showInspect(v) {
    var h = deps.escapeHtml;
    var fish = window.FishData.FISH_BY_ID[v.species];
    els.inspectCard.innerHTML = '<canvas id="fdex-inspect-cv" width="200" height="130"></canvas>' +
      '<div class="fdex-name" style="font-size:18px">' + h(v.name) + (v.shiny ? ' <span class="fdex-shiny">✨ SHINY</span>' : '') + '</div>' +
      '<div class="fdex-sub">' + stars(fish.rarity) + '</div>' +
      '<div>' + v.size.toFixed(1) + ' cm · ' + h(v.grade) + '</div>' +
      '<div class="fdex-sub">float ' + v.float.toFixed(4) + '</div>';
    var cv = el('fdex-inspect-cv');
    var spec = window.FishSprite.fishSpriteSpec(fish, { float: v.float, shiny: v.shiny });
    try { window.FishSprite.drawFish(cv.getContext('2d'), spec, 0); } catch (e) {}
    els.inspect.classList.add('show');
  }

  function doOpen() { els.panel.classList.add('open'); render(); }
  function doClose() {
    els.panel.classList.remove('open');
    els.inspect.classList.remove('show');
    if (io) { io.disconnect(); io = null; }
  }

  window.FishingDexUI = { init: init, open: doOpen, close: doClose };
})();
