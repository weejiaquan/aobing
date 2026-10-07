/* Marble Trail canvas, controls and lifecycle. No account or economy writes. */
(()=>{
  'use strict';
  const E=window.MarbleEngine,el=id=>document.getElementById('marble-'+id),t=(key,args)=>I18N.t(key,args);
  const panel=el('panel'),canvas=el('canvas'),g=canvas.getContext('2d'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const colors=['#ff7796','#68d4ff','#ffd36b','#77e0ad','#b89aff'];
  const colorKeys=['marble.red','marble.blue','marble.gold','marble.green','marble.purple'];
  const symbols=['◆','▲','✦','■','●'];
  const storeKey='aobing-marble-trail-v1';
  let deps,state,opened=false,phase='ready',angle=-Math.PI/2,frame=0,last=0,best=0,level=1,recordLevel=1,audio,pointer=null;
  let effects=[],left=false,right=false,lastHud='',storageFailed=false;
  const blocked=()=>document.hidden||!!document.querySelector('dialog[open],.ui-window-open,.merge-overlay,#app-modal:not([hidden])');
  function save(){
    if(state){best=Math.max(best,state.score);recordLevel=Math.max(recordLevel,level);}
    try{localStorage.setItem(storeKey,JSON.stringify({version:1,best,level,recordLevel}));}
    catch(_){storageFailed=true;}
    el('saved').textContent=t(storageFailed?'marble.storage_error':'marble.saved');
  }
  function unlock(){
    if(!Number(deps?.settings.sfxVol??50))return;
    try{audio ||= new (window.AudioContext||window.webkitAudioContext)();audio.resume().catch(()=>{});}catch(_){}
  }
  function sound(type,combo=1){
    const volume=Number(deps?.settings.sfxVol??50)/100;if(!audio||!volume||document.hidden)return;
    try{const o=audio.createOscillator(),v=audio.createGain(),now=audio.currentTime;
      o.type='sine';o.frequency.setValueAtTime(type==='shoot'?330:type==='clear'?520*Math.pow(1.18,combo):150,now);
      o.frequency.exponentialRampToValueAtTime(type==='shoot'?180:type==='clear'?780*Math.pow(1.1,combo):70,now+.13);
      v.gain.setValueAtTime(volume*.08,now);v.gain.exponentialRampToValueAtTime(.001,now+.18);
      o.connect(v).connect(audio.destination);o.start(now);o.stop(now+.2);
    }catch(_){}
  }
  function circle(x,y,r,fill,stroke){g.beginPath();g.arc(x,y,r,0,Math.PI*2);if(fill){g.fillStyle=fill;g.fill();}if(stroke){g.strokeStyle=stroke;g.stroke();}}
  function marble(x,y,color,r=E.RADIUS){
    const gradient=g.createRadialGradient(x-r*.35,y-r*.4,r*.08,x,y,r);
    gradient.addColorStop(0,'#ffffff');gradient.addColorStop(.32,colors[color]);gradient.addColorStop(1,['#ac3159','#1675a6','#ac761f','#22876a','#6946ac'][color]);
    g.lineWidth=2;circle(x,y,r,gradient,'#122e49');
    g.fillStyle='#102b48cc';g.font=`900 ${r*.94}px 'Segoe UI',sans-serif`;g.textAlign='center';g.textBaseline='middle';g.fillText(symbols[color],x,y+1);
    g.globalAlpha=.7;circle(x-r*.35,y-r*.42,r*.15,'white');g.globalAlpha=1;
  }
  function draw(){
    if(!state||!opened)return;
    const night=document.body.dataset.skyPhase==='night',path=E.pathFor(level);
    g.setTransform(canvas.width/E.WIDTH,0,0,canvas.height/E.HEIGHT,0,0);
    const bg=g.createLinearGradient(0,0,900,620);bg.addColorStop(0,night?'#0e3443':'#d3f2e9');bg.addColorStop(1,night?'#172c49':'#d9eaff');
    g.fillStyle=bg;g.fillRect(0,0,E.WIDTH,E.HEIGHT);
    // Original stone garden, rings and a halo cannon; no borrowed game artwork.
    g.lineWidth=1;
    for(let i=0;i<7;i++){g.strokeStyle=night?'#83d7ec09':'#3b8fa412';g.beginPath();g.ellipse(450,310,70+i*57,45+i*37,0,0,Math.PI*2);g.stroke();}
    for(let i=0;i<24;i++){
      const x=(i*173+36)%880,y=(i*97+30)%600;g.save();g.translate(x,y);g.rotate(i*.7);
      g.fillStyle=night?'#62ac9d15':'#77b8a329';g.beginPath();g.ellipse(0,0,8,24,0,0,Math.PI*2);g.fill();g.restore();
    }
    const trace=()=>{g.beginPath();path.points.forEach((p,i)=>i?g.lineTo(p.x,p.y):g.moveTo(p.x,p.y));};
    g.lineCap='round';g.lineJoin='round';trace();g.lineWidth=48;g.strokeStyle=night?'#071c2ecc':'#618c9b55';g.stroke();
    trace();g.lineWidth=39;g.strokeStyle=night?'#284b59':'#b0c9c1';g.stroke();
    trace();g.lineWidth=30;g.strokeStyle=night?'#163948':'#829f9d';g.stroke();
    for(let s=0;s<path.length;s+=22){const p=E.point(path,s);g.beginPath();g.moveTo(p.x-p.ty*18,p.y+p.tx*18);g.lineTo(p.x+p.ty*18,p.y-p.tx*18);g.strokeStyle=night?'#75948d33':'#d8e4cd66';g.lineWidth=2;g.stroke();}
    const entrance=E.point(path,0),exit=E.point(path,path.length),danger=state.chain.length&&state.chain[0].s>path.length*.8;
    g.lineWidth=5;circle(entrance.x,entrance.y,25,night?'#163d49':'#739e92','#9ddcc0');
    circle(exit.x,exit.y,30,'#102c41',danger?'#ff8498':'#d2b679');circle(exit.x,exit.y,21,'#081627','#385d6a');
    g.fillStyle='#d2b679';g.font="900 22px 'Segoe UI',sans-serif";g.textAlign='center';g.textBaseline='middle';g.fillText('×',exit.x,exit.y);
    const visible=state.chain.filter(m=>m.s>=0);for(const m of visible){const p=E.point(path,m.s);marble(p.x,p.y,m.color);}
    // Finite aiming guide; a static dashed line is retained with reduced motion.
    if(phase==='playing'){
      g.setLineDash([3,12]);g.strokeStyle=night?'#ffffff55':'#21455c55';g.lineWidth=2;g.beginPath();g.moveTo(450+Math.cos(angle)*42,310+Math.sin(angle)*42);g.lineTo(450+Math.cos(angle)*280,310+Math.sin(angle)*280);g.stroke();g.setLineDash([]);
    }
    g.lineWidth=3;circle(450,310,45,night?'#1a4d5c':'#edf8ed','#d7bb76');circle(450,310,35,night?'#225765':'#9bc9bd','#427e86');
    g.save();g.translate(450,310);g.rotate(angle);g.fillStyle=night?'#96c9c6':'#3f818e';g.strokeStyle='#173b52';g.lineWidth=3;
    g.beginPath();g.roundRect(5,-14,46,28,7);g.fill();g.stroke();g.restore();
    marble(450,310,state.loaded,20);marble(450,358,state.next,10);
    for(const p of state.projectiles)marble(p.x,p.y,p.color,13);
    for(const effect of effects){
      const f=effect.life/effect.duration;g.globalAlpha=f;
      if(effect.type==='ring'){g.lineWidth=3;circle(effect.x,effect.y,15+(1-f)*27,null,colors[effect.color]);}
      else{g.fillStyle=night?'#fff4c8':'#183c54';g.font="900 23px 'Segoe UI',sans-serif";g.fillText(effect.text,effect.x,effect.y-(1-f)*30);}
    }
    g.globalAlpha=1;
  }
  function resize(){
    if(!opened)return;const r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.round(r.width*dpr));canvas.height=Math.max(1,Math.round(r.height*dpr));draw();
  }
  function hud(){
    const signature=[state.score,state.chain.length,state.loaded,state.next,state.combo,best,phase,I18N.current].join(':');
    if(signature===lastHud)return;lastHud=signature;
    el('score').textContent=state.score.toLocaleString(I18N.current);el('best').textContent=best.toLocaleString(I18N.current);
    el('left').textContent=state.chain.length;el('level').textContent=t('marble.level',{n:level});
    for(const key of ['loaded','next']){
      const color=state[key],node=el(key);node.style.setProperty('--marble-color',colors[color]);node.textContent=symbols[color];
      node.setAttribute('aria-label',t(key==='loaded'?'marble.loaded_color':'marble.next_color',{color:t(colorKeys[color])}));
    }
    el('pause').disabled=phase!=='playing';el('swap').disabled=phase!=='playing';
  }
  function overlay(focus=false){
    const show=phase!=='playing';el('overlay').hidden=!show;canvas.inert=show;
    el('overlay-title').textContent=t({ready:'marble.ready',paused:'marble.paused',won:'marble.won',lost:'marble.lost'}[phase]||'marble.ready');
    el('overlay-hint').textContent=phase==='won'||phase==='lost'?t('marble.result',{score:state.score.toLocaleString(I18N.current),combo:state.bestCombo}):t('marble.instructions');
    el('play').textContent=t({ready:'marble.play',paused:'marble.resume',won:'marble.next_level',lost:'marble.retry'}[phase]||'marble.play');
    hud();draw();if(focus&&opened&&!document.hidden&&!blocked())el('overlay-title').focus({preventScroll:true});
  }
  function stop(){cancelAnimationFrame(frame);frame=0;last=0;left=right=false;pointer=null;}
  function pause(){if(phase!=='playing')return;phase='paused';stop();save();overlay();}
  function reset(nextLevel){stop();level=nextLevel;state=E.create(level);effects=[];angle=-Math.PI/2;lastHud='';phase='ready';save();overlay();}
  function tick(now){
    frame=0;if(!opened||phase!=='playing')return;if(blocked()){pause();return;}
    if(last&&now-last>250){pause();return;} // Never fast-forward a stalled/hidden tab.
    const dt=last?Math.min((now-last)/1000,.05):0;last=now;
    angle+=(Number(right)-Number(left))*dt*2.4;
    const events=E.advance(state,dt);
    for(const event of events){
      if(event.type==='clear'){
        sound('clear',event.combo);el('status').textContent=t('marble.combo',{n:event.combo,points:event.points});
        if(!reduced.matches){
          const path=E.pathFor(level),p=E.point(path,event.marbles[0].s);
          effects.push({type:'text',x:p.x,y:p.y,text:'+'+event.points,life:.65,duration:.65});
          for(const m of event.marbles.slice(0,16)){const pos=E.point(path,m.s);effects.push({type:'ring',...pos,color:m.color,life:.35,duration:.35});}
          effects=effects.slice(-80);
        }
        save();
      }
    }
    effects.forEach(e=>{e.life-=dt;});effects=effects.filter(e=>e.life>0);
    if(state.outcome!=='playing'){phase=state.outcome;if(phase==='won')recordLevel=Math.max(recordLevel,Math.min(999,level+1));else sound('lost');stop();save();overlay(true);return;}
    hud();draw();frame=requestAnimationFrame(tick);
  }
  function play(){
    if(!opened||blocked()||phase==='playing')return;unlock();
    if(phase==='won')reset(Math.min(999,level+1));else if(phase==='lost')reset(level);
    phase='playing';el('status').textContent=t('marble.goal');overlay();canvas.focus({preventScroll:true});last=0;frame=requestAnimationFrame(tick);
  }
  function fire(){if(phase!=='playing'||blocked())return;unlock();if(E.shoot(state,angle)){sound('shoot');hud();draw();}}
  function swap(){if(phase!=='playing'||blocked())return;unlock();E.swap(state);hud();draw();}
  function aim(event){const r=canvas.getBoundingClientRect(),x=(event.clientX-r.left)/r.width*E.WIDTH,y=(event.clientY-r.top)/r.height*E.HEIGHT;angle=Math.atan2(y-310,x-450);return event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom;}
  function init(value){
    if(deps)return;deps=value;
    try{const saved=JSON.parse(localStorage.getItem(storeKey));if(saved?.version===1){best=Number.isSafeInteger(saved.best)&&saved.best>=0?saved.best:0;level=Number.isInteger(saved.level)&&saved.level>=1&&saved.level<=999?saved.level:1;recordLevel=Number.isInteger(saved.recordLevel)&&saved.recordLevel>=level&&saved.recordLevel<=999?saved.recordLevel:level;}}catch(_){}
    state=E.create(level);
    el('play').addEventListener('click',play);el('pause').addEventListener('click',()=>{pause();el('play').focus();});el('swap').addEventListener('click',()=>{swap();canvas.focus({preventScroll:true});});
    el('restart').addEventListener('click',()=>{pause();el('confirm').showModal();});
    el('cancel').addEventListener('click',()=>el('confirm').close());
    el('confirm-restart').addEventListener('click',()=>{el('confirm').close();reset(level);el('play').focus();});
    el('confirm').addEventListener('click',e=>{if(e.target===el('confirm'))el('confirm').close();});
    canvas.addEventListener('pointermove',event=>{if(phase==='playing')aim(event);});
    canvas.addEventListener('pointerdown',event=>{if(event.button!==0||phase!=='playing'||blocked())return;event.preventDefault();canvas.focus({preventScroll:true});aim(event);pointer=event.pointerId;canvas.setPointerCapture(pointer);});
    canvas.addEventListener('pointerup',event=>{if(pointer!==event.pointerId)return;pointer=null;if(aim(event))fire();});
    for(const name of ['pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>{pointer=null;});
    canvas.addEventListener('contextmenu',event=>{event.preventDefault();swap();});
    canvas.addEventListener('keydown',event=>{
      if(blocked()||phase!=='playing'||event.altKey||event.ctrlKey||event.metaKey)return;
      if(['ArrowLeft','ArrowRight',' ','Enter','x','X','Escape'].includes(event.key)){event.preventDefault();event.stopPropagation();}
      if(event.key==='ArrowLeft')left=true;else if(event.key==='ArrowRight')right=true;
      else if(event.key==='Escape'){pause();el('play').focus();}
      else if(!event.repeat&&[' ','Enter'].includes(event.key))fire();else if(!event.repeat&&['x','X'].includes(event.key))swap();
    });
    window.addEventListener('keyup',event=>{if(event.key==='ArrowLeft')left=false;if(event.key==='ArrowRight')right=false;});
    canvas.addEventListener('blur',()=>{left=right=false;pointer=null;});
    window.addEventListener('blur',pause);document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
    window.addEventListener('pagehide',()=>{pause();save();});
    new MutationObserver(()=>{if(opened&&blocked())pause();}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open','class','hidden']});
    new ResizeObserver(resize).observe(canvas);
    reduced.addEventListener('change',()=>{effects=[];draw();});
    window.addEventListener('i18nchange',()=>{lastHud='';save();overlay();});
  }
  function open(){if(opened||!deps)return;opened=true;panel.hidden=false;deps.captureKeyboard(true);resize();overlay(true);}
  function close(){if(!opened)return;pause();stop();save();opened=false;panel.hidden=true;effects=[];if(el('confirm').open)el('confirm').close();deps.captureKeyboard(false);audio?.suspend().catch(()=>{});}
  window.MarbleGame={init,open,close};if(window.__marbleDeps)init(window.__marbleDeps);
})();
