/* Merge Drift presentation, input and local progress; all rules live in drift.js. */
(() => {
  'use strict';
  const E = window.DriftEngine, el = id => document.getElementById('drift-' + id);
  const t = (key,args) => I18N.t(key,args);
  const panel = el('panel'), board = el('board'), reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const storageKey = 'aobing-merge-drift-v1';
  let deps, state, opened = false, best = 0, generation = 0, audio, swipe = null, notice = ['drift.instructions'];
  const animations = new Set(), nodes = new Map();
  const keys = {ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down',a:'left',d:'right',w:'up',s:'down',A:'left',D:'right',W:'up',S:'down'};
  function blocked() { return !opened || document.hidden || !!document.querySelector('dialog[open],.ui-window-open,.merge-overlay,#app-modal:not([hidden])'); }
  function save() {
    best = Math.max(best,state.score);
    try { localStorage.setItem(storageKey,JSON.stringify({state,best})); el('saved').textContent=t('gems.saved'); }
    catch (_) { el('saved').textContent=t('gems.save_unavailable'); }
  }
  function unlockAudio() {
    if (!Number(deps?.settings.sfxVol ?? 50) || document.hidden) return;
    try { audio ||= new (window.AudioContext || window.webkitAudioContext)();audio.resume().catch(()=>{}); } catch (_) {}
  }
  function sound(value) {
    const volume = Number(deps?.settings.sfxVol ?? 50)/100;
    if (!audio || !volume || document.hidden) return;
    try {
      const oscillator=audio.createOscillator(), gain=audio.createGain(), now=audio.currentTime;
      oscillator.type=value ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(value ? 300*Math.pow(1.09,Math.log2(value)) : 220,now);
      gain.gain.setValueAtTime(volume*(value ? .08 : .03),now); gain.gain.exponentialRampToValueAtTime(.001,now+.14);
      oscillator.connect(gain).connect(audio.destination); oscillator.start(now); oscillator.stop(now+.15);
    } catch (_) {}
  }
  function animate(node, frames, duration) {
    if (reduced.matches || document.hidden || !node.animate) return Promise.resolve();
    const animation=node.animate(frames,{duration,easing:'cubic-bezier(.2,.7,.3,1)'}); animations.add(animation);
    return animation.finished.catch(()=>{}).finally(()=>animations.delete(animation));
  }
  function place(node, index) { node.style.left=(index%E.SIZE*25)+'%'; node.style.top=(Math.floor(index/E.SIZE)*25)+'%'; }
  function tileNode(tile, index) {
    let node = nodes.get(tile.id);
    if (!node) { node=document.createElement('div');node.className='drift-tile';nodes.set(tile.id,node);board.appendChild(node); }
    node.dataset.tier=Math.min(Math.log2(tile.value),12);node.dataset.digits=String(tile.value).length;node.dataset.index=index;
    node.textContent=tile.value;place(node,index);
    return node;
  }
  // Static render of the committed board; removes nodes for tiles that no longer exist.
  function render() {
    const live = new Set();
    state.board.forEach((tile,i)=>{if(tile){live.add(tile.id);tileNode(tile,i);}});
    nodes.forEach((node,id)=>{if(!live.has(id)){node.remove();nodes.delete(id);}});
    stats();
  }
  function stats() {
    el('score').textContent=state.score.toLocaleString(I18N.current);
    el('best').textContent=best.toLocaleString(I18N.current);
    el('highest').textContent=E.highest(state.board).toLocaleString(I18N.current);
    board.setAttribute('aria-label',t('drift.board')+' · '+state.board.map(tile=>tile ? tile.value : '·').join(' '));
  }
  function finish(focus = false) {
    const over = state.outcome !== 'playing';el('result').hidden=!over;stats();
    if (!over) { el('status').textContent=t(...notice);return; }
    el('result-title').textContent=t(state.outcome === 'won' ? 'drift.won' : 'drift.lost');
    el('result-score').textContent=t('drift.result',{score:state.score.toLocaleString(I18N.current),tile:E.highest(state.board).toLocaleString(I18N.current)});
    el('continue').textContent=t(state.outcome === 'won' ? 'drift.keep' : 'marble.retry');
    el('again').hidden=state.outcome !== 'won';el('status').textContent='';
    if (focus && opened && !blocked()) el('result-title').focus({preventScroll:true});
  }
  function settle() { generation++;animations.forEach(a=>a.cancel());animations.clear();swipe=null;if(state)render(); }
  function start() {
    settle();state=E.create();notice=['drift.instructions'];save();render();finish();
    if (opened) board.focus({preventScroll:true});
  }
  async function slide(direction) {
    if (blocked() || state.outcome !== 'playing') return;
    unlockAudio(); // Unlock inside the key/pointer gesture.
    settle(); // A new move finishes any running animation first.
    const result=E.move(state,direction);
    if (!result.valid) { notice=['drift.blocked'];el('status').textContent=t(...notice);sound(0);return; }
    // Commit before animating so leaving mid-animation cannot lose or repeat a move.
    state=result.state;save();
    const token=generation, top=result.merges.reduce((max,m)=>Math.max(max,m.value),0);
    notice=top ? ['drift.merged',{value:top.toLocaleString(I18N.current),points:result.gained.toLocaleString(I18N.current)}] : ['drift.instructions'];
    el('status').textContent=t(...notice);
    if (top) sound(top);
    const work=result.slides.map(({id,from,to})=>{
      const node=nodes.get(id);place(node,to);
      const dx=(from%E.SIZE-to%E.SIZE)*100, dy=(Math.floor(from/E.SIZE)-Math.floor(to/E.SIZE))*100;
      return dx || dy ? animate(node,[{transform:`translate(${dx}%,${dy}%)`},{transform:'translate(0,0)'}],110) : null;
    });
    stats();await Promise.all(work);
    if (generation !== token) return;
    render();
    for (const merge of result.merges) animate(nodes.get(merge.id),[{transform:'scale(1)'},{transform:'scale(1.14)',offset:.45},{transform:'scale(1)'}],160);
    if (result.spawned) animate(nodes.get(result.spawned.id),[{transform:'scale(.2)',opacity:0},{transform:'scale(1)',opacity:1}],150);
    finish(true);
  }
  function init(value) {
    if (deps) return;deps=value;
    try { const saved=JSON.parse(localStorage.getItem(storageKey));state=E.restore(saved?.state);best=Number.isSafeInteger(saved?.best) && saved.best >= 0 ? saved.best : 0; } catch (_) {}
    state ||= E.create();
    const grid=board.querySelector('.drift-grid');for(let i=0;i<E.CELLS;i++)grid.appendChild(document.createElement('span'));
    panel.addEventListener('keydown',event=>{
      const direction=keys[event.key];
      if(!direction || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('dialog,summary') || blocked())return;
      event.preventDefault();event.stopPropagation();if(!event.repeat)slide(direction);
    });
    board.addEventListener('pointerdown',event=>{
      if(event.button !== 0 || blocked() || state.outcome !== 'playing')return;
      swipe={id:event.pointerId,x:event.clientX,y:event.clientY};board.setPointerCapture(event.pointerId);board.focus({preventScroll:true});
    });
    board.addEventListener('pointerup',event=>{
      if(!swipe || event.pointerId !== swipe.id)return;
      const dx=event.clientX-swipe.x,dy=event.clientY-swipe.y;swipe=null;
      if(Math.hypot(dx,dy)<Math.max(18,board.clientWidth/14))return;
      slide(Math.abs(dx)>Math.abs(dy) ? (dx>0 ? 'right' : 'left') : (dy>0 ? 'down' : 'up'));
    });
    for(const name of ['pointercancel','lostpointercapture'])board.addEventListener(name,()=>{swipe=null;});
    el('new').addEventListener('click',()=>{if(state.outcome === 'playing' && state.moves > 0)el('confirm').showModal();else start();});
    el('cancel').addEventListener('click',()=>el('confirm').close());
    el('restart').addEventListener('click',()=>{el('confirm').close();start();});
    el('confirm').addEventListener('click',event=>{if(event.target === el('confirm'))el('confirm').close();});
    el('continue').addEventListener('click',()=>{
      if(state.outcome !== 'won'){start();return;}
      state=E.keepPlaying(state);notice=['drift.instructions'];save();finish(true);if(state.outcome === 'playing')board.focus({preventScroll:true});
    });
    el('again').addEventListener('click',start);
    window.addEventListener('blur',()=>{swipe=null;});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)settle();});
    window.addEventListener('pagehide',()=>{settle();save();});
    reduced.addEventListener('change',()=>{if(reduced.matches)settle();});
    window.addEventListener('i18nchange',()=>{if(state){save();finish();}});
  }
  function open() {
    if(opened || !deps)return;opened=true;panel.hidden=false;deps.captureKeyboard(true);
    render();finish(true);if(state.outcome === 'playing')board.focus({preventScroll:true});
  }
  function close() {
    if(!opened)return;settle();save();opened=false;panel.hidden=true;
    if(el('confirm').open)el('confirm').close();deps.captureKeyboard(false);audio?.suspend().catch(()=>{});
  }
  window.DriftGame={init,open,close};if(window.__driftDeps)init(window.__driftDeps);
})();
