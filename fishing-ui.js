'use strict';
// Input and presentation for the session reducer; rewards persist only on caught.
(function () {
  var deps, els={}, session, scene, raf=0, lastT=0, open=false;
  var input={cast:false,holding:false}, sources=new Set(), pointerId=null;
  var lastChrome='', trip={catches:0,coins:0}, lastResult=null;
  var audio=null, stopResultSprite=null;
  var catchNotice=null;
  var CATCH_NOTICE_SECONDS=4, CATCH_FADE_SECONDS=.6;
  var reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  function el(id){return document.getElementById(id);}
  function t(key,params){return deps.t(key,params);}
  function blocked(){return !!document.querySelector('dialog[open],.ui-window-open') || document.hidden;}
  function revealingCatch(){return session&&session.phase==='result'&&session.result&&session.result.outcome==='caught';}
  function releaseInput(){sources.clear();input.cast=false;input.holding=false;pointerId=null;}
  function cancelInput(){releaseInput();if(session&&session.phase==='charging')session=window.FishingSession.createSession();}
  function start(source){
    if(!open||blocked()||revealingCatch()||sources.has(source))return;
    unlockAudio();
    sources.add(source);input.holding=true;input.cast=true;
  }
  function stop(source){sources.delete(source);input.holding=sources.size>0;}
  function unlockAudio(){
    if(!(deps.settings.sfxVol>0))return;
    try{if(!audio)audio=new (window.AudioContext||window.webkitAudioContext)();if(audio.state==='suspended')audio.resume().catch(function(){});}catch(e){}
  }
  function cue(type){
    if(!audio||audio.state!=='running'||!(deps.settings.sfxVol>0))return;
    var notes={cast:[420,210],splash:[180,95],bite:[780,1170],hooked:[520,780],caught:[523,659,784],missed:[260,190],escaped:[260,170]}[type];
    if(!notes)return;
    notes.forEach(function(hz,i){
      var start=audio.currentTime+i*.085,osc=audio.createOscillator(),gain=audio.createGain();
      osc.type=type==='splash'?'triangle':'sine';osc.frequency.setValueAtTime(hz,start);
      osc.frequency.exponentialRampToValueAtTime(hz*.85,start+.16);
      gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(.12*deps.settings.sfxVol/100,start+.012);gain.gain.exponentialRampToValueAtTime(.0001,start+.22);
      osc.connect(gain);gain.connect(audio.destination);osc.start(start);osc.stop(start+.24);
      osc.onended=function(){osc.disconnect();gain.disconnect();};
    });
  }
  function init(d){
    deps=d;
    ['panel','canvas','cast-btn','exit','result','status','hint','action','phase-label','control-hint','reel','reel-zone','reel-fish','catch-progress','reel-percent','reel-feedback','session-log'].forEach(function(id){els[id]=el('fishing-'+id);});
    scene=window.FishingScene.create(els.canvas,deps.getVariant('miyuswim').variant);
    window.FishingDexUI.init(d);
    el('fishing-dex-btn').addEventListener('click',function(){releaseInput();window.FishingDexUI.open();});
    els.exit.addEventListener('click',function(){
      deps.settings.gameMode='clicker';deps.saveSettings();doClose();
      if(window.applyMode)window.applyMode('clicker');el('hub-launch').focus({preventScroll:true});
    });
    [els.canvas,els['cast-btn']].forEach(function(surface){
      surface.addEventListener('pointerdown',function(e){
        if(e.button!==0||pointerId!==null||!open||blocked())return;
        pointerId=e.pointerId;surface.setPointerCapture(e.pointerId);start('pointer');
      });
      function up(e){if(e.pointerId!==pointerId)return;stop('pointer');pointerId=null;}
      surface.addEventListener('pointerup',up);surface.addEventListener('pointercancel',function(e){if(e.pointerId===pointerId)cancelInput();});surface.addEventListener('lostpointercapture',up);
    });
    // Native activation / assistive technology gets a short cast without a hold.
    els['cast-btn'].addEventListener('click',function(e){if(e.detail===0&&open&&!blocked()&&!revealingCatch()){unlockAudio();input.cast=true;}});
    function accepts(e){return !e.target.closest('button:not(#fishing-cast-btn),input,select,textarea,[contenteditable="true"]');}
    document.addEventListener('keydown',function(e){
      if(!open||blocked()||!accepts(e))return;
      if(e.code==='Space'||(e.code==='Enter'&&e.target===els['cast-btn'])){
        e.preventDefault();if(!e.repeat)start(e.code);
      }
    },true);
    document.addEventListener('keyup',function(e){
      if(e.code!=='Space'&&e.code!=='Enter')return;
      stop(e.code);if(open&&!blocked()&&accepts(e))e.preventDefault();
    },true);
    window.addEventListener('blur',cancelInput);
    document.addEventListener('visibilitychange',cancelInput);
    window.addEventListener('i18nchange',function(){lastChrome='';if(open){if(catchNotice)showResult(catchNotice.result);else if(session.phase==='result')showResult(session.result);}});
  }
  function loop(now){
    if(!open)return;
    var dt=Math.min(.05,(now-lastT)/1000)||0;lastT=now;
    if(blocked()){
      releaseInput();
      // Releasing focus cancels cast preparation rather than throwing on return.
      if(session.phase==='charging')session=window.FishingSession.createSession();
      raf=requestAnimationFrame(loop);return;
    }
    var r=window.FishingSession.step(session,dt,input,Math.random,{
      table:window.FishData.FISH,hasCaught:function(id){return !!deps.getFishdex()[id];}
    });
    var previousPhase=session.phase;
    session=r.state;input.cast=false;
    if(previousPhase!==session.phase&&(revealingCatch()||previousPhase==='result'))releaseInput();
    r.events.forEach(function(ev){
      if(ev.type==='caught'){
        deps.recordCatch(ev.specimen,ev.coins,ev.isNew);
        trip.catches++;trip.coins+=ev.coins;
      }
      cue(ev.type);
    });
    scene.render(session,dt,reduced.matches);
    updateChrome();
    updateCatchNotice(dt);
    raf=requestAnimationFrame(loop);
  }
  function updateChrome(){
    var phase=session.phase, grace=window.FishingEngine.BALANCE_GRACE_SECONDS;
    var reveal=revealingCatch(),remaining=reveal?Math.max(0,window.FishingSession.CATCH_REVEAL_SECONDS-session.timer):0;
    var count=reveal?Math.ceil(remaining):phase==='balancing'?Math.max(0,Math.ceil(grace-session.timer)):0;
    var key=phase+'|'+count+'|'+window.I18N.current;
    els.panel.style.setProperty('--cast-charge',phase==='charging'?session.charge:0);
    els.panel.dataset.holding=String(input.holding);
    if(phase==='balancing'&&session.bar){
      var b=session.bar, inside=b.fish_.pos>=b.bar.pos&&b.fish_.pos<=b.bar.pos+b.tier.barSize;
      els['reel-zone'].style.left=(b.bar.pos*100)+'%';els['reel-zone'].style.width=(b.tier.barSize*100)+'%';
      els['reel-fish'].style.left=(b.fish_.pos*100)+'%';
      els.reel.dataset.tracking=String(inside);els.reel.dataset.grace=String(count>0);
      els['catch-progress'].value=b.progress;
      var percent=Math.round(b.progress*100)+'%';
      if(els['reel-percent'].textContent!==percent)els['reel-percent'].textContent=percent;
      var feedback=count?t('fishing.ready')+' '+count:t(inside?'fishing.tracking':'fishing.follow');
      if(els['reel-feedback'].textContent!==feedback)els['reel-feedback'].textContent=feedback;
    }
    if(key===lastChrome)return;lastChrome=key;
    els.panel.dataset.phase=phase;document.body.dataset.fishingPhase=phase;
    els.reel.setAttribute('aria-hidden',String(phase!=='balancing'));
    var copy={
      idle:['fishing.idle','fishing.charge_hint','fishing.prepare','fishing.cast'],
      charging:['fishing.release','fishing.charge_hint','fishing.release','fishing.cast'],
      casting:['fishing.casting','fishing.wait_hint','fishing.casting','fishing.cast'],
      waiting:['fishing.waiting','fishing.wait_hint','fishing.wait','fishing.hook'],
      bite:['fishing.fish_on','fishing.hook_hint','fishing.hook','fishing.hook'],
      balancing:['fishing.reeling','fishing.follow_hint','fishing.hold','fishing.reel'],
      landing:['fishing.landing','fishing.caught','fishing.landing','fishing.reel'],
      missed:['fishing.missed','fishing.retry','fishing.wait','fishing.hook'],
      result:['fishing.result','fishing.charge_hint','fishing.cast_again','fishing.caught']
    }[phase];
    els.status.textContent=t(copy[0]);els.hint.textContent=t(copy[1]);els.action.textContent=t(copy[2]);
    if(reveal)els.action.textContent=t('fishing.next_cast_in',{n:count});
    els['phase-label'].textContent=t(copy[3]);
    els['control-hint'].textContent=t(phase==='balancing'?'fishing.follow_hint':phase==='bite'?'fishing.hook_hint':phase==='charging'?'fishing.release':phase==='result'||phase==='idle'?'fishing.charge_hint':'fishing.wait_hint');
    if(reveal)els['control-hint'].textContent=t('fishing.caught');
    // Keep the action focusable as its role changes; ignore actions in timed phases.
    els['cast-btn'].setAttribute('aria-disabled',String(reveal||/casting|waiting|landing|missed/.test(phase)));
    if(phase==='result')showResult(session.result);
    else if(!catchNotice)hideResult();
    var summary=window.FishingDex.dexSummary(deps.getFishdex(),window.FishData.FISH);
    el('fishing-collection-count').textContent=t('fishing.discovered',{n:summary.caught,total:summary.total});
    els['session-log'].textContent=t('fishing.trip',{n:trip.catches,coins:trip.coins});
  }
  function showResult(result){
    if(!result)return;
    if(result.outcome==='caught'){
      if(!catchNotice||catchNotice.result!==result){catchNotice={result:result,age:0};lastResult=null;}
    }else catchNotice=null;
    var id=result.outcome+'|'+result.fish.id+'|'+window.I18N.current+'|'+(result.specimen?result.specimen.float:'');
    if(id===lastResult)return;lastResult=id;
    if(stopResultSprite){stopResultSprite();stopResultSprite=null;}
    els.result.style.opacity='1';
    els.result.classList.toggle('catch-notice',!!catchNotice&&!revealingCatch());
    var h=deps.escapeHtml;
    if(result.outcome==='escaped'){
      els.result.innerHTML='<div class="fishing-result-art fishing-escape" aria-hidden="true">≈</div><div class="fishing-result-copy"><p class="ui-kicker">'+h(t('fishing.result'))+'</p><h2 class="fishing-result-title">'+h(t('fishing.escaped'))+'</h2><p class="fdex-sub">'+h(t('fishing.retry'))+'</p></div>';
    }else{
      var s=result.specimen;
      els.result.innerHTML='<div class="fishing-result-art"><div class="fishing-result-orbit" aria-hidden="true"></div><canvas id="fishing-result-sprite" width="260" height="168" aria-hidden="true"></canvas></div><div class="fishing-result-copy"><p class="ui-kicker">'+h(t('fishing.caught'))+'</p><h2 class="fishing-result-title">'+h(result.fish.name)+'</h2><div class="fishing-result-meta"><span>'+s.size.toFixed(1)+' cm</span><span>'+h(s.grade)+'</span></div><div class="fr-coins">+'+h(t('fishing.coins',{n:result.coins}))+'</div>'+(s.shiny?'<div class="fr-new">✦ '+h(t('fishing.shiny'))+'</div>':'')+(result.isNew?'<div class="fr-new">'+h(t('fishing.new'))+'</div>':'')+'</div>';
      var cv=el('fishing-result-sprite');
      stopResultSprite=window.FishSprite.animate(cv,window.FishSprite.fishSpriteSpec(result.fish,s),{
        reveal:true,active:function(){return open&&!!catchNotice&&!blocked();}
      });
    }
    els.result.classList.add('show');
  }
  function hideResult(){
    catchNotice=null;lastResult=null;
    els.result.classList.remove('show','catch-notice');els.result.style.opacity='1';
    if(stopResultSprite){stopResultSprite();stopResultSprite=null;}
  }
  function updateCatchNotice(dt){
    if(!catchNotice)return;
    catchNotice.age+=dt;
    if(catchNotice.age>=CATCH_NOTICE_SECONDS){hideResult();return;}
    els.result.classList.toggle('catch-notice',!revealingCatch());
    els.result.style.opacity=reduced.matches?'1':String(Math.min(1,(CATCH_NOTICE_SECONDS-catchNotice.age)/CATCH_FADE_SECONDS));
  }
  function doOpen(){
    if(open)return;open=true;session=window.FishingSession.createSession();trip={catches:0,coins:0};
    scene.reset();lastChrome='';hideResult();releaseInput();
    els.panel.classList.add('open');document.body.classList.add('music-mode');
    deps.captureKeyboard(true);deps.pauseBgm();updateChrome();
    els['cast-btn'].focus({preventScroll:true});lastT=performance.now();raf=requestAnimationFrame(loop);
  }
  function doClose(){
    if(!open)return;open=false;cancelAnimationFrame(raf);raf=0;
    hideResult();
    els.panel.classList.remove('open');document.body.classList.remove('music-mode');delete document.body.dataset.fishingPhase;
    els.result.classList.remove('show');releaseInput();deps.captureKeyboard(false);deps.resumeBgm();
    window.FishingDexUI.close();
  }
  window.FishingGame={init:init,open:doOpen,close:doClose};
})();
