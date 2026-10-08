'use strict';
// Shared presentation only. The adapters still own charts, judging and game audio.
(function () {
  const t = (key, values) => window.I18N.t(key, values);
  const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ''; if (text != null) n.textContent = text; return n; };
  const button = (key, action, cls) => { const n = el('button', cls, t(key)); n.type = 'button'; n.dataset.i18n = key; n.addEventListener('click', action); return n; };
  const label = (tag, cls, key) => { const n=el(tag,cls,t(key));n.dataset.i18n=key;return n; };
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function metadata(text) {
    const read = key => (String(text).match(new RegExp('^' + key + '\\s*:\\s*(.*)$', 'mi')) || [,''])[1].trim();
    const timing = String(text).split('[TimingPoints]')[1]?.split('[')[0] || '';
    const beat = timing.split(/\r?\n/).map(s => s.split(',')).find(p => Number(p[1]) > 0);
    return {preview: read('PreviewTime')===''?-1:Number(read('PreviewTime')), audio:read('AudioFilename'), creator:read('Creator'), bpm:beat ? Math.round(60000 / Number(beat[1])) : 0,
      ar:read('ApproachRate') || read('OverallDifficulty'), od:read('OverallDifficulty'), cs:read('CircleSize')};
  }
  function create({mode, settings, save, ensureCtx, pauseBgm, resumeBgm, play}) {
    const panel = document.getElementById(mode + '-panel'), screen = document.getElementById(mode + '-select');
    const list = document.getElementById(mode + '-songlist'), head = screen.querySelector('.' + mode + '-select-head');
    screen.classList.add('rhythm-select');
    let entries = [], groups = [], selected = null, active = false, armed = false, gen = 0, artGen = 0, source = null, gain = null, artUrl = '', audioKey = '', decoded = null, busy = false, limit = 60, pulseTimer = null, animated = null;
    let listGen=0,thumbObserver=null,decodeQueue=Promise.resolve();const thumbs=new Map();
    const bg = el('div', 'rs-background'); bg.setAttribute('aria-hidden','true');
    const backdrop = el('div', 'rs-backdrop'); backdrop.setAttribute('aria-hidden','true'); screen.prepend(bg, backdrop);
    const tools = el('details', 'rs-tools'), summary = el('summary', '', t('rhythm.setup')); summary.dataset.i18n='rhythm.setup'; tools.append(summary);
    const toolBody = el('div', 'rs-tools-body'); tools.append(toolBody);
    const title = head.querySelector('h2'), exit = document.getElementById(mode + '-exit'), mp = document.getElementById('mp-open-btn');
    const setupCopy={'import':'rhythm.import_folder','import-osz':'rhythm.import_osz','import-skin':'rhythm.skin_file','import-skin-dir':'rhythm.skin_folder','sync':'rhythm.sync','hitsound-btn':'rhythm.hitsounds','visual-btn':'rhythm.appearance','appearance-btn':'rhythm.appearance','calibrate':'rhythm.calibrate','auto':'rhythm.auto_off','exit':'fishing.exit'};
    for(const [id,key] of Object.entries(setupCopy)){const n=document.getElementById(mode+'-'+id);if(n){n.dataset.i18n=key;n.textContent=t(key);n.removeAttribute('title');}}
    const allKeys=document.querySelector('#vsrg-keyfilter [data-keys="all"]');if(mode==='vsrg'&&allKeys){allKeys.dataset.i18n='rhythm.all';allKeys.textContent=t('rhythm.all');}
    const inlineLabel=mode==='vsrg'?document.querySelector('.vsrg-speed'):document.getElementById('osu-keybinds')?.parentElement;
    if(inlineLabel&&inlineLabel.firstChild?.nodeType===3){inlineLabel.firstChild.remove();inlineLabel.prepend(label('span','',mode==='vsrg'?'rhythm.speed':'rhythm.keys'));}
    const oldActions = head.querySelector(mode === 'osu' ? 'div' : '.vsrg-select-actions');
    if (oldActions) toolBody.append(oldActions);
    head.replaceChildren(); const brand = el('div','rs-brand'); brand.append(el('span','rs-eyebrow','AOBING IT!'),title); head.append(brand);
    const nav = el('div','rs-nav'); if (mode==='osu' && mp) nav.append(mp); nav.append(tools,exit); head.append(nav);
    for (const id of ['import-hint','import-status','osz-status','skin-status','skin-picker','speed-preview']) { const n=document.getElementById(mode+'-'+id); if(n) toolBody.append(n); }
    const legacySort=screen.querySelector('.osu-sort-row'); if(legacySort) toolBody.append(legacySort);
    const stage=el('div','rs-stage'), hero=el('section','rs-hero'); hero.setAttribute('aria-label',t('rhythm.selected'));
    const art=el('div','rs-art'), halo=el('div','rs-halo'); halo.setAttribute('aria-hidden','true'); art.append(halo);
    const covers=[el('div','rs-cover'),el('div','rs-cover')];art.prepend(...covers);let coverIndex=0,releaseTimer=null;const artUrls=new Set();
    const heroText=el('div','rs-hero-text'), artist=el('p','rs-artist'), song=el('h3','rs-title'), diff=el('p','rs-difficulty'), stats=el('div','rs-stats'), mapper=el('p','rs-mapper');
    heroText.append(label('span','rs-eyebrow','rhythm.selected'),artist,song,diff,stats,mapper);
    const status=el('p','rs-status'); status.setAttribute('role','status');let statusKey='';
    function setStatus(key){statusKey=key;status.textContent=key?t(key):'';}
    const playButton=button('rhythm.play',start,'rs-play'), previewButton=button('rhythm.preview',()=>preview(selected),'rs-preview');
    const actions=el('div','rs-play-actions'); actions.append(previewButton,playButton);
    hero.append(art,heroText,status,actions);
    const browser=el('section','rs-browser'), filter=el('div','rs-filter'), search=el('input','rs-search'); search.type='search'; search.placeholder=t('rhythm.search'); search.setAttribute('aria-label',t('rhythm.search'));
    const sort=el('select','rs-sort'); sort.setAttribute('aria-label',t('rhythm.sort'));
    for(const [v,key] of [['title','rhythm.sort_title'],['artist','rhythm.sort_artist'],['stars','rhythm.sort_difficulty']]) { const o=label('option','',key);o.value=v;sort.append(o); }
    sort.value=settings[mode+'SortBy'] || 'title'; if(!sort.value)sort.value='title';
    filter.append(search,sort); const keyFilter=document.getElementById('vsrg-keyfilter'); if(mode==='vsrg'&&keyFilter)filter.append(keyFilter);
    const count=el('span','rs-count'), listHead=el('div','rs-list-head'); listHead.append(label('span','rs-eyebrow','rhythm.library'),count);
    list.setAttribute('aria-label',t('rhythm.library')); list.tabIndex=0;
    browser.append(filter,listHead,list); stage.append(hero,browser);screen.append(stage);
    const footer=el('div','rs-footer'); footer.append(label('span','','rhythm.select_hint'),button('rhythm.random',random));screen.append(footer);
    function available() { return active && panel.classList.contains('open') && !screen.hidden && !document.hidden && !document.querySelector('dialog[open]'); }
    function stopAudio() {
      gen++; clearInterval(pulseTimer);pulseTimer=null;art.style.removeProperty('--rs-level');
      if(source) { const old=source, oldGain=gain; source=null; gain=null; try { const now=old.context.currentTime;oldGain.gain.cancelScheduledValues(now);oldGain.gain.setTargetAtTime(0,now,.025);old.stop(now+.1);const cleanup=old.onended;old.onended=()=>{cleanup?.();old.disconnect();oldGain.disconnect();}; } catch (_) {try{old.stop();old.disconnect();oldGain.disconnect();}catch(_){}} }
      previewButton.classList.remove('playing');
    }
    async function preview(entry) {
      if(!entry || !available() || busy)return;
      let token=++gen; pauseBgm?.(); setStatus('rhythm.preview_loading');
      try {
        // Resume in the original gesture, before reading any local files.
        const [ac, text]=await Promise.all([ensureCtx(),entry.getOsuText()]);
        const meta=metadata(text), key=entry.artist+'\0'+entry.title+'\0'+meta.audio;
        if(token!==gen || !available())return;
        if(source && audioKey===key){setStatus('rhythm.previewing');return;}
        stopAudio();token=gen;
        if(!decoded || audioKey!==key) {
          decoded=null;audioKey='';
          const bytes=await entry.getAudio(); if(token!==gen || !available())return;
          const decoding=decodeQueue.then(()=>token===gen&&available()?ac.decodeAudioData(bytes.slice(0)):null);decodeQueue=decoding.catch(()=>null);
          const buffer=await decoding; if(!buffer||token!==gen || !available())return;
          decoded=buffer;audioKey=key;
        }
        source=ac.createBufferSource();source.buffer=decoded;gain=ac.createGain();
        const analyser=ac.createAnalyser(); analyser.fftSize=64;
        source.connect(gain).connect(analyser).connect(ac.destination);
        source.onended=()=>analyser.disconnect();
        const volume=Math.max(0,Math.min(1,Number(settings.musicVol ?? 60)/100));
        gain.gain.setValueAtTime(0,ac.currentTime);gain.gain.linearRampToValueAtTime(volume,ac.currentTime+.18);
        const offset=meta.preview>=0&&meta.preview/1000<decoded.duration ? meta.preview/1000 : Math.min(decoded.duration*.4,60);
        source.loop=true;source.loopStart=offset;source.loopEnd=decoded.duration;source.start(0,offset);
        previewButton.classList.add('playing');setStatus('rhythm.previewing');
        const data=new Uint8Array(analyser.frequencyBinCount);
        pulseTimer=setInterval(()=>{if(!available()){stopAudio();return;}if(!reduced()){analyser.getByteFrequencyData(data);art.style.setProperty('--rs-level',String(data.reduce((a,b)=>a+b,0)/data.length/255));}else art.style.removeProperty('--rs-level');gain?.gain.setTargetAtTime(Math.max(0,Math.min(1,Number(settings.musicVol ?? 60)/100)),ac.currentTime,.1);},80);
      } catch (_) { if(token===gen){stopAudio();setStatus('rhythm.preview_failed');resumeBgm?.();} }
    }
    function updateDetails(entry) {
      const token=++artGen;artist.textContent=entry?.artist || '';song.textContent=entry?.title || t('rhythm.empty');diff.textContent=entry?.diffName || '';mapper.textContent='';stats.replaceChildren();
      playButton.disabled=busy||!entry;previewButton.disabled=busy||!entry;
      if(!entry){covers.forEach(c=>{c.classList.remove('visible');c.style.backgroundImage='';});bg.style.backgroundImage='';return;}
      const metric=(name,value)=>{const n=el('span','rs-stat');n.append(el('b','',String(value)),el('small','',name));stats.append(n);};
      metric(t('rhythm.estimate'), '~'+Number(entry.stars || 0).toFixed(1)+'★');if(entry.keyCount)metric(t('rhythm.keys'),entry.keyCount+'K');
      entry.getOsuText().then(text=>{if(token!==artGen)return;const m=metadata(text); if(m.bpm)metric('BPM',m.bpm);if(mode==='osu'){metric('AR',m.ar || '—');metric('CS',m.cs || '—');}metric('OD',m.od || '—');mapper.textContent=m.creator?t('rhythm.mapped_by',{name:m.creator}):'';}).catch(()=>{});
      // A stale cover must never be applied after another selection or mode exit.
      Promise.resolve(entry.getArt?.()).then(async blob=>{
        if(token!==artGen)return;
        if(!blob){covers.forEach(c=>c.classList.remove('visible'));bg.style.backgroundImage='';return;}
        const url=URL.createObjectURL(blob);artUrls.add(url);const img=new Image();img.src=url;
        try { await img.decode(); } catch (_) {URL.revokeObjectURL(url);artUrls.delete(url);return;}
        if(token!==artGen){URL.revokeObjectURL(url);artUrls.delete(url);return;}
        artUrl=url;coverIndex=1-coverIndex;covers[coverIndex].style.backgroundImage='url("'+url+'")';
        covers[coverIndex].classList.add('visible');covers[1-coverIndex].classList.remove('visible');
        bg.style.backgroundImage='url("'+url+'")';clearTimeout(releaseTimer);
        releaseTimer=setTimeout(()=>{for(const u of artUrls)if(u!==artUrl){URL.revokeObjectURL(u);artUrls.delete(u);}},400);
      }).catch(()=>{});
      if(animated)animated.cancel();if(!reduced())animated=heroText.animate([{opacity:.3,transform:'translateY(12px)'},{opacity:1,transform:'none'}],{duration:230,easing:'cubic-bezier(.2,.8,.2,1)'});
    }
    function choose(entry, sound=true) { if(!entry||busy)return; const changed=selected!==entry; selected=entry;armed=true; if(changed){updateDetails(entry);render();} if(sound)preview(entry);list.focus({preventScroll:true}); }
    async function start() {
      if(!selected||busy||!available())return;busy=true;stopAudio();playButton.disabled=true;setStatus('rhythm.preparing');
      const token=gen,entry=selected;
      try { await ensureCtx();if(token!==gen||!available())return;const result=await play(entry);if(result===false)setStatus('rhythm.load_failed'); }
      catch (_) { setStatus('rhythm.load_failed'); }
      finally {busy=false;playButton.disabled=!selected;previewButton.disabled=!selected;}
    }
    function groupKey(entry){return entry.artist+'\0'+entry.title;}
    function render() {
      const generation=++listGen;thumbObserver?.disconnect();
      const paintThumb=async n=>{
        const entry=n.entry,key=groupKey(entry);
        if(thumbs.has(key)){if(thumbs.get(key))n.style.backgroundImage='url("'+thumbs.get(key)+'")';return;}
        try {
          const blob=await entry.getArt?.();if(generation!==listGen)return;
          const url=blob?URL.createObjectURL(blob):'';thumbs.set(key,url);if(url)n.style.backgroundImage='url("'+url+'")';
          if(thumbs.size>80){const oldest=thumbs.keys().next().value;URL.revokeObjectURL(thumbs.get(oldest));thumbs.delete(oldest);}
        } catch (_) {}
      };
      thumbObserver=new IntersectionObserver(rows=>rows.forEach(row=>{if(row.isIntersecting){thumbObserver.unobserve(row.target);paintThumb(row.target);}}),{root:list,rootMargin:'120px'});
      const terms=search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean), by=new Map();
      for(const e of entries){if(!terms.every(q=>(e.title+' '+e.artist+' '+e.diffName+' '+(e.keyCount?e.keyCount+'k':'')).toLocaleLowerCase().includes(q)))continue;const key=groupKey(e);if(!by.has(key))by.set(key,[]);by.get(key).push(e);}
      groups=[...by.values()];groups.forEach(g=>g.sort((a,b)=>(a.stars||0)-(b.stars||0)));
      groups.sort((a,b)=>sort.value==='stars' ? (b.at(-1).stars||0)-(a.at(-1).stars||0) : String(a[0][sort.value]||'').localeCompare(String(b[0][sort.value]||'')));
      count.textContent=t('rhythm.song_count',{n:groups.length}); const fragment=document.createDocumentFragment();
      groups.slice(0,limit).forEach((g,index)=>{
        const open=selected&&groupKey(selected)===groupKey(g[0]),wrap=el('div','rs-song'+(open?' selected':'')),b=el('button','rs-song-main');b.type='button';b.dataset.group=String(index);b.setAttribute('aria-expanded',String(!!open));
        const number=el('span','rs-song-number',String(index+1).padStart(2,'0')),thumb=el('span','rs-song-thumb'),text=el('span','rs-song-copy');text.append(el('strong','',g[0].title),el('small','',g[0].artist));
        thumb.entry=g[0];thumb.setAttribute('aria-hidden','true');thumb.append(number);thumbObserver.observe(thumb);
        b.append(thumb,text,el('span','rs-song-rating','~'+Number(g.at(-1).stars||0).toFixed(1)+'★'));wrap.append(b);
        if(open){const diffs=el('div','rs-diffs');for(const e of g){const d=el('button','rs-diff'+(e===selected?' selected':''), (e.keyCount?e.keyCount+'K · ':'')+e.diffName);d.type='button';d.setAttribute('aria-pressed',String(e===selected));d.addEventListener('click',()=>e===selected&&armed?start():choose(e));diffs.append(d);}wrap.append(diffs);}
        b.addEventListener('click',()=>{if(g.length===1&&selected===g[0]&&armed)start();else choose(g.find(e=>e===selected)||g[0]);});fragment.append(wrap);
      });
      if(!groups.length)fragment.append(el('p','rs-empty',t(entries.length?'rhythm.no_matches':'rhythm.empty')));
      if(groups.length>limit)fragment.append(button('rhythm.more',()=>{limit+=60;render();},'rs-more'));
      const scroll=list.scrollTop;list.replaceChildren(fragment);list.scrollTop=scroll;
      const current=list.querySelector('.rs-song.selected');if(current&&armed&&!reduced())current.animate([{opacity:.65,transform:'translateX(3px)'},{opacity:1,transform:'translateX(-8px)'}],{duration:180,easing:'ease-out'});
    }
    function random(){const all=groups.flat();if(all.length) {choose(all[Math.floor(Math.random()*all.length)]);reveal();}}
    function reveal(){const i=groups.findIndex(g=>g.includes(selected));if(i>=limit){limit=i+30;render();}list.querySelector('.rs-song.selected')?.scrollIntoView({block:'nearest',behavior:reduced()?'instant':'smooth'});}
    search.addEventListener('input',()=>{limit=60;render();}); sort.addEventListener('change',()=>{settings[mode+'SortBy']=sort.value;save?.();render();reveal();});
    panel.addEventListener('keydown',e=>{
      if(e.key==='Escape' && active && tools.open){e.preventDefault();e.stopPropagation();tools.open=false;summary.focus();return;}
      if(!available()||e.ctrlKey||e.altKey||e.metaKey||e.target.closest('input,select,textarea,details')||e.repeat)return;
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const all=groups.flat(),i=all.indexOf(selected);choose(all[Math.max(0,Math.min(all.length-1,i+(e.key==='ArrowDown'?1:-1)))]);reveal();list.focus({preventScroll:true});}
      else if(e.key==='Enter'&&(list.contains(e.target)||e.target===screen||e.target===panel)){e.preventDefault();start();}
      else if(e.key==='F2'){e.preventDefault();random();}
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAudio();});
    new MutationObserver(()=>{if(!available())stopAudio();}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
    window.addEventListener('i18nchange',()=>{setStatus(statusKey);search.placeholder=t('rhythm.search');search.setAttribute('aria-label',t('rhythm.search'));hero.setAttribute('aria-label',t('rhythm.selected'));list.setAttribute('aria-label',t('rhythm.library'));sort.setAttribute('aria-label',t('rhythm.sort'));updateDetails(selected);render();});
    return {setEntries(next){entries=next; if(selected&&!entries.includes(selected))selected=entries.find(e=>e.id===selected.id&&e.title===selected.title&&e.diffName===selected.diffName)||null; if(!selected&&entries.length)selected=entries[0];updateDetails(selected);render();},screen(name){active=name==='select';if(!active){stopAudio();tools.open=false;}else setStatus('');},close(){active=false;stopAudio();artGen++;listGen++;thumbObserver?.disconnect();for(const u of thumbs.values())if(u)URL.revokeObjectURL(u);thumbs.clear();decoded=null;audioKey='';animated?.cancel();clearTimeout(releaseTimer);for(const u of artUrls)URL.revokeObjectURL(u);artUrls.clear();artUrl='';},stop:stopAudio,failure(){setStatus('rhythm.load_failed');}};
  }
  function hud(mode, pause) {
    const root=document.getElementById(mode+'-hud');
    const title=el('div','rhythm-run-title'),name=el('b'),difficulty=el('small');title.append(name,difficulty);
    const progress=el('progress','rhythm-progress');progress.max=1;progress.value=0;progress.setAttribute('aria-label',t('rhythm.progress'));
    const time=el('span','rhythm-run-time'),count=el('span','rhythm-countdown');count.setAttribute('aria-hidden','true');
    const pauseButton=button('rhythm.pause',()=>pause(),'rhythm-pause-button');
    root.append(title,progress,time,count,pauseButton);let last=-Infinity;
    const clock=ms=>{const s=Math.max(0,Math.floor(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
    return {start(entry){name.textContent=entry.title;difficulty.textContent=entry.diffName;last=-Infinity;progress.value=0;time.textContent='';count.textContent='';},update(st,end){if(Math.abs(st-last)<80)return;last=st;progress.value=Math.max(0,Math.min(1,st/Math.max(1,end)));time.textContent=clock(st)+' / '+clock(end);count.textContent=st<0?String(Math.ceil(-st/1000)):'';}};
  }
  window.RhythmSelect={create,metadata,hud};
})();
