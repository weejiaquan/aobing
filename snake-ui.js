/* Sky Snake canvas, controls and lifecycle. No account or economy writes. */
(()=>{
  'use strict';
  const E=window.SnakeEngine,el=id=>document.getElementById('snake-'+id),t=(key,args)=>I18N.t(key,args);
  const panel=el('panel'),canvas=el('canvas'),g=canvas.getContext('2d'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const CELL=30,SIZE=E.COLS*CELL,storeKey='aobing-sky-snake-v1';
  const keys={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down',a:'left',d:'right',w:'up',s:'down',A:'left',D:'right',W:'up',S:'down'};
  let deps,state,opened=false,phase='ready',cause='wall',frame=0,last=0,carry=0,best=0,audio,swipe=null,lastHud='',storageFailed=false;
  const blocked=()=>document.hidden||!!document.querySelector('dialog[open],.ui-window-open,.merge-overlay,#app-modal:not([hidden])');
  function save(){
    if(state)best=Math.max(best,state.score);
    try{localStorage.setItem(storeKey,JSON.stringify({version:1,best}));}catch(_){storageFailed=true;}
    el('saved').textContent=t(storageFailed?'gems.save_unavailable':'snake.saved');
  }
  function unlock(){
    if(!Number(deps?.settings.sfxVol??50))return;
    try{audio ||= new (window.AudioContext||window.webkitAudioContext)();audio.resume().catch(()=>{});}catch(_){}
  }
  function sound(type,tier=1){
    const volume=Number(deps?.settings.sfxVol??50)/100;if(!audio||!volume||document.hidden)return;
    try{const o=audio.createOscillator(),v=audio.createGain(),now=audio.currentTime;
      o.type=type==='eat'?'triangle':'sine';o.frequency.setValueAtTime(type==='eat'?520*Math.pow(1.12,tier):170,now);
      o.frequency.exponentialRampToValueAtTime(type==='eat'?820*Math.pow(1.12,tier):60,now+.14);
      v.gain.setValueAtTime(volume*.08,now);v.gain.exponentialRampToValueAtTime(.001,now+.2);
      o.connect(v).connect(audio.destination);o.start(now);o.stop(now+.22);
    }catch(_){}
  }
  function star(x,y,r,points=5){
    g.beginPath();
    for(let i=0;i<points*2;i++){const a=-Math.PI/2+i*Math.PI/points,d=i%2?r*.45:r;g.lineTo(x+Math.cos(a)*d,y+Math.sin(a)*d);}
    g.closePath();
  }
  function draw(now=performance.now()){
    if(!state||!opened)return;
    const night=document.body.dataset.skyPhase==='night';
    g.setTransform(canvas.width/SIZE,0,0,canvas.height/SIZE,0,0);
    const bg=g.createLinearGradient(0,0,0,SIZE);bg.addColorStop(0,night?'#10223f':'#cfe9ff');bg.addColorStop(1,night?'#1d1b45':'#f2e7ff');
    g.fillStyle=bg;g.fillRect(0,0,SIZE,SIZE);
    g.fillStyle=night?'#ffffff08':'#ffffff55';
    for(let y=0;y<E.ROWS;y++)for(let x=(y%2);x<E.COLS;x+=2)g.fillRect(x*CELL,y*CELL,CELL,CELL);
    // Original sky scenery: soft clouds by day, faint stars by night.
    for(let i=0;i<9;i++){
      const x=(i*197+40)%SIZE,y=(i*131+70)%SIZE;
      if(night){g.fillStyle='#ffffff33';g.fillRect(x,y,2,2);}
      else{g.fillStyle='#ffffff70';g.beginPath();g.ellipse(x,y,34,11,0,0,Math.PI*2);g.ellipse(x+18,y-7,20,12,0,0,Math.PI*2);g.fill();}
    }
    if(state.food){
      const pulse=phase==='playing'&&!reduced.matches?1+Math.sin(now/180)*.08:1,cx=state.food.x*CELL+CELL/2,cy=state.food.y*CELL+CELL/2;
      g.fillStyle='#ffcf5a';g.strokeStyle='#a8660c';g.lineWidth=2;star(cx,cy,CELL*.46*pulse);g.fill();g.stroke();
    }
    const n=state.snake.length;g.lineJoin='round';
    state.snake.slice().reverse().forEach((p,k)=>{
      const i=n-1-k,f=n>1?i/(n-1):0,inset=i?3+f*3:1;
      g.fillStyle=`hsl(${174-f*40} ${night?55:62}% ${night?52-f*12:50-f*8}%)`;g.strokeStyle=night?'#071a2c':'#17485a';g.lineWidth=2;
      g.beginPath();g.roundRect(p.x*CELL+inset,p.y*CELL+inset,CELL-inset*2,CELL-inset*2,i?7:10);g.fill();g.stroke();
    });
    const head=state.snake[0],[dx,dy]={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]}[state.direction];
    for(const side of [-1,1]){
      const ex=head.x*CELL+CELL/2+dx*5-dy*side*6,ey=head.y*CELL+CELL/2+dy*5+dx*side*6;
      g.fillStyle='#fff';g.beginPath();g.arc(ex,ey,4,0,Math.PI*2);g.fill();
      g.fillStyle='#112838';g.beginPath();g.arc(ex+dx*1.5,ey+dy*1.5,2,0,Math.PI*2);g.fill();
    }
  }
  function resize(){
    if(!opened)return;const r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.round(r.width*dpr));canvas.height=Math.max(1,Math.round(r.height*dpr));draw();
  }
  function hud(){
    const signature=[state.score,state.snake.length,E.speedTier(state),best,phase,I18N.current].join(':');
    if(signature===lastHud)return;lastHud=signature;
    el('score').textContent=state.score.toLocaleString(I18N.current);el('best').textContent=best.toLocaleString(I18N.current);
    el('length').textContent=state.snake.length;el('speed').textContent=E.speedTier(state);
    el('pause').disabled=phase!=='playing';
  }
  function overlay(focus=false){
    const show=phase!=='playing';el('overlay').hidden=!show;
    el('overlay-title').textContent=t({ready:'snake.ready',paused:'marble.paused',won:'snake.won',lost:cause==='self'?'snake.lost_self':'snake.lost_wall'}[phase]);
    el('overlay-hint').textContent=phase==='won'||phase==='lost'?t('snake.result',{score:state.score.toLocaleString(I18N.current),length:state.snake.length}):t('snake.goal');
    el('play').textContent=t({ready:'snake.play',paused:'marble.resume',won:'snake.again',lost:'marble.retry'}[phase]);
    hud();draw();if(focus&&opened&&!document.hidden&&!blocked())el('overlay-title').focus({preventScroll:true});
  }
  function stop(){cancelAnimationFrame(frame);frame=0;last=0;swipe=null;}
  function pause(){if(phase!=='playing')return;phase='paused';stop();save();overlay();}
  function reset(){stop();state=E.create();carry=0;lastHud='';phase='ready';overlay();}
  function tick(now){
    frame=0;if(!opened||phase!=='playing')return;if(blocked()){pause();return;}
    if(last&&now-last>250){pause();return;} // Never fast-forward a stalled or hidden tab.
    carry+=last?now-last:0;last=now;
    while(carry>=E.interval(state)&&state.outcome==='playing'){
      carry-=E.interval(state);const tier=E.speedTier(state),event=E.step(state);
      if(event.type==='eat'||event.type==='won'){
        sound('eat',tier);save();
        if(E.speedTier(state)>tier)el('status').textContent=t('snake.faster',{n:E.speedTier(state),points:E.POINTS*E.speedTier(state)});
      }else if(event.type==='crash')cause=event.cause;
    }
    if(state.outcome!=='playing'){phase=state.outcome;if(phase==='lost')sound('crash');stop();save();overlay(true);return;}
    hud();draw(now);frame=requestAnimationFrame(tick);
  }
  function play(){
    if(!opened||blocked()||phase==='playing')return;unlock();
    if(phase==='won'||phase==='lost')reset();
    phase='playing';el('status').textContent=t('snake.goal');overlay();canvas.focus({preventScroll:true});last=0;frame=requestAnimationFrame(tick);
  }
  function steer(direction){if(phase==='playing'&&!blocked())E.turn(state,direction);}
  function init(value){
    if(deps)return;deps=value;
    try{const saved=JSON.parse(localStorage.getItem(storeKey));if(saved?.version===1&&Number.isSafeInteger(saved.best)&&saved.best>=0)best=saved.best;}catch(_){}
    state=E.create();
    el('play').addEventListener('click',play);el('pause').addEventListener('click',()=>{pause();el('play').focus();});
    el('restart').addEventListener('click',()=>{pause();el('confirm').showModal();});
    el('cancel').addEventListener('click',()=>el('confirm').close());
    el('confirm-restart').addEventListener('click',()=>{el('confirm').close();save();reset();el('play').focus();});
    el('confirm').addEventListener('click',e=>{if(e.target===el('confirm'))el('confirm').close();});
    panel.addEventListener('keydown',event=>{
      if(blocked()||phase!=='playing'||event.altKey||event.ctrlKey||event.metaKey||event.target.closest('dialog,summary'))return;
      const direction=keys[event.key];
      if(direction){event.preventDefault();event.stopPropagation();steer(direction);}
      else if(['Escape','p','P'].includes(event.key)){event.preventDefault();event.stopPropagation();pause();el('play').focus();}
    });
    canvas.addEventListener('pointerdown',event=>{if(event.button!==0||phase!=='playing'||blocked())return;event.preventDefault();canvas.focus({preventScroll:true});swipe={id:event.pointerId,x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);});
    // Steer as soon as a drag passes the threshold, then re-anchor so one drag can chain turns.
    canvas.addEventListener('pointermove',event=>{
      if(!swipe||event.pointerId!==swipe.id)return;
      const dx=event.clientX-swipe.x,dy=event.clientY-swipe.y;if(Math.hypot(dx,dy)<Math.max(16,canvas.clientWidth/24))return;
      steer(Math.abs(dx)>Math.abs(dy)?(dx>0?'right':'left'):(dy>0?'down':'up'));swipe.x=event.clientX;swipe.y=event.clientY;
    });
    for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>{swipe=null;});
    window.addEventListener('blur',pause);document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
    window.addEventListener('pagehide',()=>{pause();save();});
    new MutationObserver(()=>{if(opened&&blocked())pause();}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open','class','hidden']});
    new ResizeObserver(resize).observe(canvas);
    window.addEventListener('i18nchange',()=>{lastHud='';save();overlay();});
  }
  function open(){if(opened||!deps)return;opened=true;panel.hidden=false;deps.captureKeyboard(true);save();resize();overlay(true);}
  function close(){if(!opened)return;pause();stop();save();opened=false;panel.hidden=true;if(el('confirm').open)el('confirm').close();deps.captureKeyboard(false);audio?.suspend().catch(()=>{});}
  window.SnakeGame={init,open,close};if(window.__snakeDeps)init(window.__snakeDeps);
})();
