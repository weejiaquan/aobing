'use strict';
// DOM/canvas renderer for the Fishdex + Inventory browsing panel. window.FishingDexUI.
(function () {
  var deps = null, els = {}, tab = 'fishdex', sortKey = 'recent', filterShiny = false;
  var io = null; // IntersectionObserver for lazy sprite draws
  var spriteStops = [], stopInspect = null;
  function stopTiles() { spriteStops.forEach(function(stop){stop();}); spriteStops=[]; }

  function el(id) { return document.getElementById(id); }
  function t(key, params) { return deps.t(key, params); }

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
      els.tabs.querySelectorAll('button').forEach(function (x) { x.classList.toggle('sel', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      render();
    });
    els.inspect.addEventListener('click', function (e) { if (e.target === els.inspect || e.target.closest('[data-inspect-close]')) els.inspect.close(); });
    els.inspect.addEventListener('close',function(){if(stopInspect){stopInspect();stopInspect=null;}});
    els.panel.addEventListener('click', function (e) { if (e.target === els.panel) {
      var r = els.panel.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) doClose();
    } });
    els.panel.addEventListener('close', function () { stopTiles();if (io) { io.disconnect(); io = null; } });
    window.addEventListener('i18nchange', function () { if (els.panel.open) render(); });
  }

  function ensureObserver() {
    stopTiles();
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
      if(canvas.__animate){
        spriteStops.push(window.FishSprite.animate(canvas,spec,{active:function(){return els.panel.open&&!els.inspect.open;}}));
      }else window.FishSprite.drawFish(canvas.getContext('2d'), spec, 0);
    }
  }

  function makeCanvas(spec, w, h, animated) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h; cv.__spec = spec;cv.__animate=animated;
    io.observe(cv);
    return cv;
  }

  function render() {
    ensureObserver();
    el('fishing-dex-meter').hidden = tab !== 'fishdex';
    if (tab === 'fishdex') renderFishdex(); else renderInventory();
  }

  function renderFishdex() {
    els.controls.innerHTML = '';
    var fishdex = deps.getFishdex(), FISH = window.FishData.FISH;
    var summary = window.FishingDex.dexSummary(fishdex, FISH);
    els.progress.textContent = t('fishing.discovered', { n: summary.caught, total: summary.total });
    el('fishing-dex-meter').max = summary.total;
    el('fishing-dex-meter').value = summary.caught;
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
    cell.appendChild(makeCanvas(spec, 104, 64, e.caught));
    var info = document.createElement('div');
    if (e.caught) {
      info.innerHTML = '<div class="fdex-name">' + h(e.fish.name) + (e.shiny ? ' <span class="fdex-shiny">✨</span>' : '') + '</div>' +
        '<div class="fdex-sub">' + stars(e.fish.rarity) + '</div>' +
        '<div class="fdex-sub">×' + e.count + ' · ' + e.maxSize.toFixed(0) + 'cm · ' + h(e.grade) + '</div>';
    } else {
      info.innerHTML = '<div class="fdex-name">???</div><div class="fdex-sub">' + stars(e.fish.rarity) + '</div>';
    }
    cell.appendChild(info);
    return cell;
  }

  function renderInventory() {
    var FISH_BY_ID = window.FishData.FISH_BY_ID;
    var all = deps.getSpecimens();
    // controls: sort select, species filter, shiny toggle
    var h = deps.escapeHtml;
    var sortLabels = { recent: t('fishing.sort_recent'), size: t('fishing.sort_size'), float: t('fishing.sort_float'), species: t('fishing.sort_species') };
    els.controls.innerHTML =
      '<label>' + h(t('fishing.sort')) + ' <select id="fdex-sort">' +
      ['recent', 'size', 'float', 'species'].map(function (k) { return '<option value="' + k + '"' + (k === sortKey ? ' selected' : '') + '>' + h(sortLabels[k]) + '</option>'; }).join('') +
      '</select></label>' +
      '<label><input type="checkbox" id="fdex-shiny"' + (filterShiny ? ' checked' : '') + '> ' + h(t('fishing.shiny_only')) + '</label>' +
      '<span class="fdex-sub" id="fdex-count"></span>';
    el('fdex-sort').addEventListener('change', function (e) { sortKey = e.target.value; render(); el('fdex-sort').focus(); });
    el('fdex-shiny').addEventListener('change', function (e) { filterShiny = e.target.checked; render(); el('fdex-shiny').focus(); });

    var list = window.FishingDex.filterSpecimens(all, { shinyOnly: filterShiny });
    list = window.FishingDex.sortSpecimens(list, sortKey);
    list = list.filter(function (sp) { return !!window.FishData.FISH_BY_ID[sp.species]; });
    els.progress.textContent = t('fishing.specimens', { n: all.length });
    el('fdex-count').textContent = t('fishing.shown', { n: list.length });
    els.body.innerHTML = '';
    if (!list.length) {
      els.body.innerHTML = '<div class="fdex-empty"><strong>' + h(t('fishing.empty')) + '</strong><span>' + h(t(filterShiny ? 'fishing.empty_filter' : 'fishing.empty_hint')) + '</span></div>';
      return;
    }
    var grid = document.createElement('div'); grid.className = 'fdex-grid';
    list.forEach(function (sp) { grid.appendChild(invCell(window.FishingDex.specimenView(sp, FISH_BY_ID))); });
    els.body.appendChild(grid);
  }

  function invCell(v) {
    var h = deps.escapeHtml;
    var fish = window.FishData.FISH_BY_ID[v.species];
    var cell = document.createElement('button'); cell.type = 'button'; cell.className = 'fdex-cell inv';
    var spec = window.FishSprite.fishSpriteSpec(fish, { float: v.float, shiny: v.shiny });
    cell.appendChild(makeCanvas(spec, 104, 64, true));
    var info = document.createElement('div');
    info.innerHTML = '<div class="fdex-name">' + h(v.name) + (v.shiny ? ' <span class="fdex-shiny">✨</span>' : '') + '</div>' +
      '<div class="fdex-sub">' + v.size.toFixed(1) + 'cm · ' + h(v.grade) + '</div>';
    cell.appendChild(info);
    cell.addEventListener('click', function () { showInspect(v); });
    return cell;
  }

  function showInspect(v) {
    if(stopInspect){stopInspect();stopInspect=null;}
    var h = deps.escapeHtml;
    var fish = window.FishData.FISH_BY_ID[v.species];
    els.inspectCard.innerHTML = '<canvas id="fdex-inspect-cv" width="200" height="130"></canvas>' +
      '<div id="fishing-inspect-name" class="fishing-result-title">' + h(v.name) + (v.shiny ? ' <span class="fdex-shiny">✦ ' + h(t('fishing.shiny')) + '</span>' : '') + '</div>' +
      '<div class="fdex-sub">' + stars(fish.rarity) + '</div>' +
      '<div>' + v.size.toFixed(1) + ' cm · ' + h(v.grade) + '</div>' +
      '<div class="fdex-sub">' + h(t('fishing.condition')) + ' ' + v.float.toFixed(4) + '</div>' +
      '<button type="button" data-inspect-close>' + h(t('fishing.close')) + '</button>';
    var cv = el('fdex-inspect-cv');
    var spec = window.FishSprite.fishSpriteSpec(fish, { float: v.float, shiny: v.shiny });
    stopInspect=window.FishSprite.animate(cv,spec,{reveal:true,active:function(){return els.inspect.open;}});
    els.inspect.showModal();
  }

  function doOpen() { if (els.panel.open) return; els.panel.showModal(); render(); }
  function doClose() {
    stopTiles();if(stopInspect){stopInspect();stopInspect=null;}
    els.inspect.close();
    els.panel.close();
    if (io) { io.disconnect(); io = null; }
  }

  window.FishingDexUI = { init: init, open: doOpen, close: doClose };
})();
