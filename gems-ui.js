/* Gem Rush presentation; all board rules live in gems.js. */
(() => {
  'use strict';
  const E = window.GemEngine, el = id => document.getElementById('gems-' + id);
  const t = (key,args) => I18N.t(key,args);
  const panel = el('panel'), board = el('board'), reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const storageKey = 'aobing-gem-rush-v1';
  let deps, state, opened = false, busy = false, selected = -1, focused = 0, generation = 0, best = 0;
  let shown = [], hint = [], audio, drag = null, swallowClick = false, notice = 'gems.instructions';
  const animations = new Set();
  const colors = ['#fa6f98','#ffbe55','#69dea2','#50cafa','#ae91ff','#ff955d'];
  const shapes = ['M32 5 56 32 32 59 8 32Z','M19 8H45L59 32 45 56H19L5 32Z','M13 9H51V55H13Z','M32 4 60 55H4Z','M32 4 58 24 49 55H15L6 24Z','M19 5H45L59 19V45L45 59H19L5 45V19Z'];
  const names = ['gems.ruby','gems.amber','gems.emerald','gems.sapphire','gems.amethyst','gems.topaz'];
  const specials = {row:'gems.row',column:'gems.column',blast:'gems.blast',prism:'gems.prism'};
  function svg(tile) {
    const prism = tile.special === 'prism';
    const mark = tile.special === 'row' ? '<path d="M9 32H55M14 26 8 32 14 38M50 26 56 32 50 38"/>' :
      tile.special === 'column' ? '<path d="M32 9V55M26 14 32 8 38 14M26 50 32 56 38 50"/>' :
      tile.special === 'blast' ? '<circle cx="32" cy="32" r="12"/><path d="M32 13V21M32 43V51M13 32H21M43 32H51"/>' : '';
    return '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
      (prism ? '<path d="M32 3 60 32 32 61 4 32Z" fill="#fff"/><path d="M32 6 32 32 7 32Z" fill="#fa6f98"/><path d="M32 6 57 32 32 32Z" fill="#ffcc61"/><path d="M57 32 32 57 32 32Z" fill="#71e5d3"/><path d="M32 57 7 32 32 32Z" fill="#ae91ff"/><path d="m32 20 12 12-12 12-12-12Z" fill="white"/>' :
      '<path d="'+shapes[tile.color]+'" fill="'+colors[tile.color]+'" stroke="#142f5366" stroke-width="2"/><path d="M15 19 32 12 49 19 42 40 23 45Z" fill="#fff" opacity=".27"/><path d="m13 45 19 12 21-13-20 3Z" fill="#153d60" opacity=".2"/><path d="m21 19 9-4" stroke="white" stroke-width="3" stroke-linecap="round"/>') +
      '<g fill="none" stroke="#123650" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">'+mark+'</g><g fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">'+mark+'</g></svg>';
  }
  function blocked() { return !opened || document.hidden || !!document.querySelector('dialog[open],.ui-window-open,.merge-overlay,#app-modal:not([hidden])'); }
  function save() {
    best = Math.max(best,state.score);
    try { localStorage.setItem(storageKey,JSON.stringify({state,best})); } catch (_) { el('saved').textContent=t('gems.save_unavailable'); }
  }
  function unlockAudio() {
    if (!Number(deps?.settings.sfxVol ?? 50) || document.hidden) return;
    try { audio ||= new (window.AudioContext || window.webkitAudioContext)();audio.resume().catch(()=>{}); } catch (_) {}
  }
  function sound(chain, invalid = false) {
    const volume = Number(deps?.settings.sfxVol ?? 50)/100;
    if (!volume || document.hidden) return;
    try {
      unlockAudio();if (!audio) return;
      const oscillator=audio.createOscillator(), gain=audio.createGain(), now=audio.currentTime;
      oscillator.type=invalid ? 'sine' : 'triangle';
      oscillator.frequency.setValueAtTime(invalid ? 160 : 440*Math.pow(1.19,Math.min(chain,6)),now);
      gain.gain.setValueAtTime(volume*.09,now); gain.gain.exponentialRampToValueAtTime(.001,now+.16);
      oscillator.connect(gain).connect(audio.destination); oscillator.start(now); oscillator.stop(now+.17);
    } catch (_) {}
  }
  function animate(node, frames, duration) {
    if (reduced.matches || document.hidden || !node.animate) return Promise.resolve();
    const animation=node.animate(frames,{duration,easing:'cubic-bezier(.2,.7,.3,1)'}); animations.add(animation);
    return animation.finished.catch(()=>{}).finally(()=>animations.delete(animation));
  }
  function renderBoard(tiles, moving = false, cleared = []) {
    const previous = new Map(shown.flatMap((tile,i)=>tile ? [[tile.id,i]] : []));
    const nodes = new Map([...board.children].map(n=>[Number(n.dataset.id),n]));
    const live = new Set(), work = [];
    tiles.forEach((tile,i) => {
      if (!tile) return;
      live.add(tile.id);
      let button = nodes.get(tile.id);
      if (!button) { button=document.createElement('button');button.type='button';button.className='gems-tile';button.dataset.id=tile.id;board.appendChild(button); }
      const signature=tile.color+':'+tile.special;
      if (button.dataset.gem !== signature) { button.innerHTML=svg(tile);button.dataset.gem=signature; }
      button.dataset.index=i; button.style.left=(i%8*12.5)+'%';button.style.top=(Math.floor(i/8)*12.5)+'%';
      button.tabIndex=i === focused ? 0 : -1;
      button.classList.toggle('selected',selected === i);button.classList.toggle('hint',hint.includes(i));
      button.setAttribute('aria-pressed',String(selected === i));button.setAttribute('aria-disabled',String(busy || state.outcome !== 'playing'));
      const name=tile.special === 'prism' ? t('gems.prism') : t(names[tile.color]);
      button.setAttribute('aria-label',t('gems.cell',{row:Math.floor(i/8)+1,col:i%8+1,gem:name})+(tile.special && tile.special !== 'prism' ? ', '+t(specials[tile.special]) : ''));
      if (cleared.includes(i)) work.push(animate(button,[{transform:'scale(1)',opacity:1},{transform:'scale(1.16)',opacity:.9,offset:.35},{transform:'scale(.15)',opacity:0}],210));
      else if (moving) {
        const old=previous.get(tile.id), dx=old === undefined ? 0 : (old%8-i%8)*100, dy=old === undefined ? -200 : (Math.floor(old/8)-Math.floor(i/8))*100;
        if (dx || dy) work.push(animate(button,[{transform:`translate(${dx}%,${dy}%)`,opacity:old === undefined ? 0 : 1},{transform:'translate(0,0)',opacity:1}],260));
      }
    });
    nodes.forEach((node,id)=>{if(!live.has(id))node.remove();});shown=tiles.map(tile=>tile && {...tile});
    return Promise.all(work);
  }
  function stats(score = state.score) {
    el('score').textContent=score.toLocaleString(I18N.current);
    el('moves').textContent=state.moves;
    el('level').textContent=t('gems.level',{n:state.level});
    el('target').textContent=t('gems.target',{n:state.target.toLocaleString(I18N.current)});
    el('progress').max=state.target;el('progress').value=score;
    el('best').textContent=best.toLocaleString(I18N.current);
    el('hint').disabled=busy || state.outcome !== 'playing';
    el('new').disabled=busy;
    board.setAttribute('aria-busy',String(busy));
  }
  function finish(focus = false) {
    const over = state.outcome !== 'playing';el('result').hidden=!over;
    board.inert=over;stats();
    if (!over) { el('status').textContent=t(notice);return; }
    el('result-title').textContent=t(state.outcome === 'won' ? 'gems.won' : 'gems.lost');
    el('result-score').textContent=t('gems.result_score',{score:state.score.toLocaleString(I18N.current),chain:state.bestCascade});
    el('continue').textContent=t(state.outcome === 'won' ? 'gems.next' : 'gems.retry');
    el('status').textContent='';
    if (focus && opened && !blocked()) el('result-title').focus({preventScroll:true});
  }
  function settle() {
    generation++;animations.forEach(a=>a.cancel());animations.clear();busy=false;selected=-1;drag=null;
    if (state) { renderBoard(state.board);finish(); }
  }
  function start(level = 1) {
    settle(); state=E.create(undefined,level);focused=0;hint=[];notice='gems.instructions';shown=[];save();
    renderBoard(state.board);finish();board.querySelector('[data-index="0"]')?.focus({preventScroll:true});
  }
  async function swap(a,b) {
    if (busy || blocked() || state.outcome !== 'playing') return;
    unlockAudio(); // Unlock in the original tap/key gesture, before animation awaits.
    const keyboard=board.contains(document.activeElement), result=E.move(state,a,b), token=++generation;
    selected=-1;hint=[];busy=true;stats();
    if (!result.valid) {
      notice='gems.invalid';el('status').textContent=t(notice);sound(0,true);
      const swapped=state.board.slice();[swapped[a],swapped[b]]=[swapped[b],swapped[a]];
      await renderBoard(swapped,true);
      if (generation !== token) return;
      await renderBoard(state.board,true);
    } else {
      // Commit a complete turn before animation: switching tabs/modes cannot
      // repeat a reward, spend another move, or persist a half-cleared board.
      state=result.state;save();
      for (const frame of result.frames) {
        if (generation !== token) return;
        if (frame.kind === 'clear') { el('status').textContent=t('gems.cascade',{n:frame.chain});sound(frame.chain); }
        if (frame.kind === 'shuffle') el('status').textContent=t('gems.shuffled');
        stats(frame.score);
        await renderBoard(frame.board,['swap','fall','shuffle'].includes(frame.kind),frame.cleared);
      }
      notice=result.frames.some(frame=>frame.kind === 'shuffle') ? 'gems.shuffled' : 'gems.instructions';
    }
    if (generation !== token) return;
    busy=false;focused=b;renderBoard(state.board);finish(true);
    if (keyboard && state.outcome === 'playing' && !blocked()) board.querySelector('[data-index="'+focused+'"]')?.focus({preventScroll:true});
  }
  function choose(i) {
    if (busy || blocked() || state.outcome !== 'playing') return;
    focused=i;
    if (selected === i) selected=-1;
    else if (E.adjacent(selected,i)) { swap(selected,i);return; }
    else selected=i;
    hint=[];renderBoard(state.board);
  }
  function init(value) {
    if (deps) return;deps=value;
    try { const saved=JSON.parse(localStorage.getItem(storageKey));state=E.restore(saved?.state);best=Number.isSafeInteger(saved?.best) && saved.best >= 0 ? saved.best : 0; } catch (_) {}
    state ||= E.create();
    board.addEventListener('click',event=>{if(swallowClick && event.detail !== 0){swallowClick=false;return;}const tile=event.target.closest('.gems-tile');if(tile)choose(Number(tile.dataset.index));});
    board.addEventListener('pointerdown',event=>{
      if(event.button !== 0 || busy || blocked())return;
      const tile=event.target.closest('.gems-tile');if(!tile)return;
      swallowClick=false;drag={id:event.pointerId,index:Number(tile.dataset.index),x:event.clientX,y:event.clientY};board.setPointerCapture(event.pointerId);
    });
    board.addEventListener('pointerup',event=>{
      if(!drag || event.pointerId !== drag.id)return;
      const from=drag;drag=null;
      const dx=event.clientX-from.x,dy=event.clientY-from.y;
      swallowClick=true;
      if(Math.hypot(dx,dy)<Math.max(12,board.clientWidth/24)){choose(from.index);return;}
      const target=from.index+(Math.abs(dx)>Math.abs(dy) ? (dx>0?1:-1) : (dy>0?8:-8));
      if(E.adjacent(from.index,target))swap(from.index,target);
    });
    for(const event of ['pointercancel','lostpointercapture'])board.addEventListener(event,()=>{drag=null;});
    board.addEventListener('keydown',event=>{
      const tile=event.target.closest('.gems-tile');if(!tile || busy || blocked())return;
      const i=Number(tile.dataset.index),step={ArrowLeft:-1,ArrowRight:1,ArrowUp:-8,ArrowDown:8}[event.key];
      if(event.key === 'Enter' || event.key === ' '){event.preventDefault();event.stopPropagation();if(!event.repeat)choose(i);return;}
      if(step){event.preventDefault();event.stopPropagation();if(E.adjacent(i,i+step)){focused=i+step;renderBoard(state.board);board.querySelector('[data-index="'+focused+'"]')?.focus();}}
      if(event.key === 'Escape'){selected=-1;hint=[];renderBoard(state.board);}
    });
    el('hint').addEventListener('click',()=>{if(busy || blocked())return;selected=-1;hint=E.findMove(state.board)||[];renderBoard(state.board);notice='gems.hint_shown';el('status').textContent=t(notice);});
    el('new').addEventListener('click',()=>{if(busy)return;if(state.outcome === 'playing' && state.moves < E.MOVES)el('confirm').showModal();else start();});
    el('cancel').addEventListener('click',()=>el('confirm').close());
    el('restart').addEventListener('click',()=>{el('confirm').close();start();});
    el('confirm').addEventListener('click',event=>{if(event.target === el('confirm'))el('confirm').close();});
    el('continue').addEventListener('click',()=>start(state.outcome === 'won' ? state.level+1 : state.level));
    window.addEventListener('blur',()=>{drag=null;});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)settle();});
    window.addEventListener('pagehide',()=>{settle();save();});
    reduced.addEventListener('change',()=>{if(reduced.matches)settle();});
    window.addEventListener('i18nchange',()=>{if(state){renderBoard(state.board);finish();}});
  }
  function open() {
    if(opened || !deps)return;opened=true;panel.hidden=false;deps.captureKeyboard(true);
    renderBoard(state.board);finish(true);
    if(state.outcome === 'playing')board.querySelector('[data-index="'+focused+'"]')?.focus({preventScroll:true});
  }
  function close() {
    if(!opened)return;settle();save();opened=false;panel.hidden=true;
    if(el('confirm').open)el('confirm').close();deps.captureKeyboard(false);audio?.suspend().catch(()=>{});
  }
  window.GemGame={init,open,close};if(window.__gemDeps)init(window.__gemDeps);
})();
