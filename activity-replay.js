/* Discord-only capture of the real game presentation and offline MP4 export. */
(function(root) {
  'use strict';
  const MAX_BYTES=100*1024*1024, MAX_MS=600000, FPS=60;
  const text=(key,vars)=>root.I18N.t('replay.'+key,vars);
  let activeExport=null, mediaModule;
  const media=()=>mediaModule||(mediaModule=import('./vendor/mediabunny-1.61.3.min.mjs'));
  const supported=()=>!!(root.VideoEncoder&&root.AudioEncoder);

  function begin(run,mode,options={}) {
    if(!root.__ACTIVITY__?.instanceId||!run.activityRun||run.auto)return null;
    const objects=mode==='osu'?run.objs.map(s=>s.o):run.notes;
    const indices=new Map(objects.map((o,i)=>[o,i]));
    const data={mode,objects,options,frames:[],events:[],inputs:[],sounds:[],start:null,end:0,audio:run.audioBuf,
      owner:run.activityRun,title:run.entry.title,difficulty:run.entry.diffName,keys:mode==='osu'?[]:(run.keys||Array.from({length:run.keyCount},(_,i)=>String(i+1))),disabled:false,snapshotUnits:0};
    const disable=()=>{data.disabled=true;data.frames=[];data.events=[];data.inputs=[];data.sounds=[];};
    return {data,
      sample(raw,visual,cursor,held,counts,combo,approach) {
        if(data.disabled||!Number.isFinite(raw))return;
        if(data.start===null)data.start=Math.min(0,raw);
        if(raw-data.start>MAX_MS){disable();return;}
        if(data.frames.length&&raw-data.frames.at(-1)[0]<1000/FPS-1)return;
        const view=options.snapshot?.(visual);
        data.snapshotUnits+=1+(view?.run?.objs?.length||0)+(view?.run?.notes?.length||0)+(view?.hud?.length||0);
        // Bound the in-memory timeline as well as its duration on dense maps.
        if(data.snapshotUnits>2000000){disable();return;}
        data.frames.push([raw,visual,view,run.gain?.gain.value??data.musicVolume??1,{counts:{...counts},combo,maxCombo:run.maxCombo??run.state?.maxCombo??combo,ur:run.errors?.length>1?Math.sqrt((run.errorM2||0)/run.errors.length)*10:0}]);data.end=raw;
      },
      mark(object,kind,tier,raw) {
        if(data.disabled||!indices.has(object))return;
        if(data.events.length>=200000){disable();return;}
        data.events.push([raw,indices.get(object),kind,tier]);
      },
      sound(raw,sound) {
        if(data.disabled)return;
        if(data.sounds.length>=200000){disable();return;}
        data.sounds.push({raw,...sound});
      },
      input(raw,key,down) {
        if(data.disabled||!Number.isFinite(raw))return;
        if(data.inputs.length>=200000){disable();return;}
        data.inputs.push([raw,key,down]);
      },
      skip(raw){data.start=Math.max(0,raw);data.frames=data.frames.filter(f=>f[0]>=data.start);},
      finish(){return data;},
    };
  }

  // Snapshot the real HUD's text, geometry, colors, opacity and key counters.
  // The canvas renderer owns the playfield; DOM overlays are composited on top.
  function captureHud(canvas,elements) {
    if(!root.getComputedStyle)return [];
    const base=canvas.getBoundingClientRect(),items=[];
    if(!base.width)return items;
    const visit=(el,parentOpacity=1)=>{
      if(!el||el.hidden)return;
      const r=el.getBoundingClientRect(),c=root.getComputedStyle(el);
      if(!r.width||!r.height||c.display==='none'||c.visibility==='hidden')return;
      const opacity=parentOpacity*Number(c.opacity);
      const scale=el.offsetHeight?r.height/el.offsetHeight:1;
      if(opacity<=0)return;
      items.push({x:r.left-base.left,y:r.top-base.top,w:r.width,h:r.height,opacity,
        background:c.backgroundColor,border:c.borderTopColor,borderWidth:parseFloat(c.borderTopWidth)||0,
        radius:(parseFloat(c.borderTopLeftRadius)||0)*scale,color:c.color,font:[c.fontStyle,c.fontWeight,(parseFloat(c.fontSize)*scale)+'px',c.fontFamily].join(' '),
        align:c.textAlign,padLeft:parseFloat(c.paddingLeft)||0,padRight:parseFloat(c.paddingRight)||0,
        text:el.children.length?'':el.textContent});
      for(const child of el.children)visit(child,opacity);
    };
    elements.forEach(el=>visit(el));return items;
  }
  const JUDGEMENTS={h300:'300',h100:'100',h50:'50',marvelous:'MAX',perfect:'300',great:'200',good:'100',bad:'50',miss:'MISS'};
  function fitText(g,value,x,y,maxWidth) {
    let label=String(value||'');
    while(label.length>1&&g.measureText(label).width>maxWidth)label=label.slice(0,-2)+'…';
    g.fillText(label,x,y);
  }
  function drawSidebar(g,data,stats,held,pressCounts,time) {
    const x=992,w=256;g.save();g.textAlign='left';g.textBaseline='alphabetic';
    g.fillStyle='#112b46';g.fillRect(960,0,320,720);g.fillStyle='#009fe8';g.fillRect(960,0,3,720);
    g.fillStyle='#a5efff';g.font='italic 800 18px Arial, sans-serif';g.fillText('AOBING IT!',x,32);
    g.fillStyle='#b5cbe0';g.font='700 13px Arial, sans-serif';g.fillText(root.I18N.t(data.mode==='osu'?'mode.osu':'mode.mania')+' / '+text('videoLabel'),x,57);
    g.fillStyle='#fff';g.font='700 22px Arial, sans-serif';fitText(g,data.title,x,102,w);
    g.fillStyle='#b5cbe0';g.font='16px Arial, sans-serif';fitText(g,data.difficulty,x,130,w);
    const counts=stats.counts||{},weights=data.mode==='osu'?{h300:300,h100:100,h50:50,miss:0}:{marvelous:300,perfect:300,great:200,good:100,bad:50,miss:0};
    let total=0,points=0;for(const key in weights){total+=counts[key]||0;points+=(counts[key]||0)*weights[key];}
    const acc=total?100*points/(total*300):100;
    g.fillStyle='#a5efff';g.font='700 14px Arial, sans-serif';g.fillText(text('accuracyLabel'),x,178);
    g.fillStyle='#fff';g.font='700 52px Arial, sans-serif';g.fillText(acc.toFixed(2)+'%',x,234);
    g.fillStyle='#a5efff';g.font='700 14px Arial, sans-serif';g.fillText(text('comboLabel'),x,274);
    g.fillStyle='#fff';g.font='800 48px Arial, sans-serif';g.fillText((stats.combo||0)+'x',x,324);
    g.fillStyle='#b5cbe0';g.font='14px Arial, sans-serif';fitText(g,text('bestComboLabel')+' '+(stats.maxCombo||0)+'x',x,348,w);
    let i=0;for(const key in weights){const col=i%2,row=Math.floor(i/2),bx=x+col*134,by=386+row*32;
      g.fillStyle=key==='miss'?'#ff879c':'#a5efff';g.font='700 13px Arial, sans-serif';g.fillText(JUDGEMENTS[key],bx,by);
      g.fillStyle='#fff';g.font='700 20px Arial, sans-serif';g.textAlign='right';g.fillText(String(counts[key]||0),bx+118,by);g.textAlign='left';i++;}
    g.fillStyle='#a5efff';g.font='700 14px Arial, sans-serif';g.fillText(text('keysLabel'),x,489);
    const keys=data.keys.length?data.keys:Object.keys(pressCounts),columns=keys.length>4?3:2;
    keys.slice(0,9).forEach((key,j)=>{const bx=x+(j%columns)*(264/columns),by=506+Math.floor(j/columns)*47,bw=256/columns-6;
      g.fillStyle=held[key]?'#009fe8':'#193e5a';g.beginPath();g.roundRect(bx,by,bw,40,6);g.fill();
      g.fillStyle='#fff';g.font='700 17px Arial, sans-serif';const label=String(key)===' '?'␣':String(key).toUpperCase();g.fillText(label,bx+9,by+25);
      g.fillStyle=held[key]?'#fff':'#a5efff';g.font='14px Arial, sans-serif';g.textAlign='right';g.fillText(String(pressCounts[key]||0),bx+bw-9,by+25);g.textAlign='left';});
    g.fillStyle='#b5cbe0';g.font='16px Arial, sans-serif';g.fillText('UR '+Math.round(stats.ur||0),x,668);
    const elapsed=Math.max(0,(time-data.start)/1000),duration=(data.end-data.start)/1000;
    const stamp=n=>Math.floor(n/60)+':'+String(Math.floor(n%60)).padStart(2,'0');
    g.textAlign='right';g.fillText(stamp(elapsed)+' / '+stamp(duration),x+w,668);
    g.fillStyle='#234860';g.fillRect(x,693,w,4);g.fillStyle='#a5efff';g.fillRect(x,693,w*Math.min(1,elapsed/duration),4);g.restore();
  }
  function renderer(canvas,data) {
    const g=canvas.getContext('2d');let index=0,input=0;const held={},pressCounts={};
    const events=[...(data.inputs||[])].sort((a,b)=>a[0]-b[0]);
    return time=>{
      while(index+1<data.frames.length&&data.frames[index+1][0]<=time)index++;
      while(input<events.length&&events[input][0]<=time){const [,recorded,down]=events[input++],key=data.mode==='vsrg'?data.keys[recorded]:recorded;if(down&&!held[key])pressCounts[key]=(pressCounts[key]||0)+1;held[key]=down;}
      const [,visual,view,,stats={}]=data.frames[index];
      if(!view||!data.options.draw)throw new Error('unavailable');
      g.save();g.scale(canvas.width/1280,canvas.height/720);g.fillStyle='#0b1627';g.fillRect(0,0,1280,720);
      // Fit the live skinned playfield without distorting different window sizes.
      const scale=Math.min(960/view.canvas.width,720/view.canvas.height);
      g.save();g.beginPath();g.rect(0,0,960,720);g.clip();g.translate((960-view.canvas.width*scale)/2,(720-view.canvas.height*scale)/2);g.scale(scale,scale);
      data.options.draw(visual,{...view,g,ctx2d:g});g.restore();
      drawSidebar(g,data,stats,held,pressCounts,time);g.restore();
    };
  }
  function dimensions(){return {width:1280,height:720};}
  function encodingPlan(data,maxBytes,attempt=0) {
    const limit=Math.floor(Math.min(MAX_BYTES,Number.isFinite(maxBytes)?maxBytes:20*1024*1024));
    const duration=(data.end-data.start)/1000;
    if(limit<32768||!(duration>0))throw new Error('tooLarge');
    const budget=Math.floor(Math.max(1,limit-Math.max(32768,limit*.06))*8*.78*.58**attempt/(duration+.1));
    // Keep stereo AAC at a broadly supported rate (Windows rejects 64 kbps).
    const audioBitrate=128000;
    const bitrate=Math.max(24000,Math.min(6000000,budget-audioBitrate));
    const width=bitrate>=800000&&attempt===0?1280:bitrate>=350000&&attempt<2?960:640;
    return {limit,bitrate,audioBitrate,width,height:width*9/16,fps:bitrate>=1800000&&attempt===0?60:30,attempt};
  }
  async function fitVideo(data,maxBytes,signal,progress,renderPass) {
    for(let attempt=0;attempt<4;attempt++){
      if(signal.aborted)throw new Error('cancelled');
      const plan=encodingPlan(data,maxBytes,attempt);
      try {
        const blob=await renderPass(plan,n=>progress(n,attempt));
        if(blob.size>plan.limit)throw new Error('tooLarge');
        return blob;
      }catch(error){if(error.message!=='tooLarge'||attempt===3)throw error;}
    }
  }
  async function encode(data,canvas,signal,progress,maxBytes=20*1024*1024) {
    return fitVideo(data,maxBytes,signal,progress,(plan,onProgress)=>encodePass(data,canvas,signal,onProgress,plan));
  }
  async function encodePass(data,canvas,signal,progress,plan) {
    if(!supported())throw new Error('unsupported');
    if(data.disabled||data.frames.length<2||data.end-data.start>MAX_MS)throw new Error('unavailable');
    const M=await media(),duration=(data.end-data.start)/1000;
    const {width,height,limit,bitrate,audioBitrate,fps}=plan;canvas.width=width;canvas.height=height;
    let quality=new M.Quality({bitrate,bitrateMode:'constant'});
    const config={width,height,quality,frameRate:fps,fullCodecString:'avc1.42002a'};
    if(!await M.canEncodeVideo('avc',config)){
      quality=new M.Quality({bitrate,bitrateMode:'variable'});config.quality=quality;
      if(!await M.canEncodeVideo('avc',config))throw new Error('unsupported');
    }
    if(!await M.canEncodeAudio('aac',{sampleRate:48000,numberOfChannels:2,bitrate:audioBitrate}))throw new Error('unsupported');
    if(signal.aborted)throw new Error('cancelled');
    const output=new M.Output({format:new M.Mp4OutputFormat({fastStart:'in-memory'}),target:new M.BufferTarget()});
    let bytes=0,failure=null;
    const count=packet=>{bytes+=packet.byteLength;if(bytes>limit)failure=new Error('tooLarge');};
    const video=new M.CanvasSource(canvas,{codec:'avc',fullCodecString:config.fullCodecString,quality,keyFrameInterval:2,onEncodedPacket:count});
    const audio=new M.AudioBufferSource({codec:'aac',bitrate:audioBitrate,transform:{sampleRate:48000,numberOfChannels:2},onEncodedPacket:count});
    output.addVideoTrack(video,{frameRate:fps});output.addAudioTrack(audio);
    const abort=()=>{void output.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    const check=()=>{if(signal.aborted)throw new Error('cancelled');if(failure)throw failure;};
    try {
      await output.start();const draw=renderer(canvas,data),total=Math.ceil(duration*fps);
      const soundCache=new Map(),bufferIds=new WeakMap();let nextId=0;
      const sounds=[];let volumeFrame=0;
      for(const sound of data.sounds||[]){
        check();if(sound.raw/1000+sound.duration<data.start/1000||sound.raw>data.end)continue;
        const key=JSON.stringify([sound.type,sound.noise,...sound.args],(_,v)=>{
          if(v&&typeof v.getChannelData==='function'){if(!bufferIds.has(v))bufferIds.set(v,++nextId);return {buffer:bufferIds.get(v)};}return v;
        });
        if(!soundCache.has(key))soundCache.set(key,await root.Hitsound.renderRecorded(sound));
        sounds.push({raw:sound.raw,buffer:soundCache.get(key)});
      }
      // Interleave one-second audio/video batches to bound encoder and mux queues.
      for(let batch=0;batch<duration;batch++) {
        check();const seconds=Math.min(1,duration-batch);
        const buffer=new AudioBuffer({length:Math.max(1,Math.round(seconds*data.audio.sampleRate)),numberOfChannels:data.audio.numberOfChannels,sampleRate:data.audio.sampleRate});
        const offset=Math.round((data.start/1000+batch)*data.audio.sampleRate);
        for(let ch=0;ch<buffer.numberOfChannels;ch++){
          const source=data.audio.getChannelData(ch),dest=buffer.getChannelData(ch),from=Math.max(0,offset),to=Math.min(source.length,offset+dest.length);
          if(to>from)dest.set(source.subarray(from,to),Math.max(0,-offset));
          let vf=volumeFrame;
          for(let i=0;i<dest.length;i++){const time=data.start+batch*1000+i/buffer.sampleRate*1000;while(vf+1<data.frames.length&&data.frames[vf+1][0]<=time)vf++;dest[i]*=data.frames[vf][3];}
          if(ch===buffer.numberOfChannels-1)volumeFrame=vf;
        }
        // Mix the exact sounds emitted by gameplay, including custom/map samples.
        for(const sound of sounds){
          const offsetSeconds=(data.start/1000+batch)-sound.raw/1000;
          if(offsetSeconds>=sound.buffer.duration||offsetSeconds+seconds<=0)continue;
          for(let ch=0;ch<buffer.numberOfChannels;ch++){
            const dest=buffer.getChannelData(ch),source=sound.buffer.getChannelData(Math.min(ch,sound.buffer.numberOfChannels-1));
            const from=Math.max(0,Math.ceil(-offsetSeconds*buffer.sampleRate));
            const to=Math.min(dest.length,Math.ceil((sound.buffer.duration-offsetSeconds)*buffer.sampleRate));
            for(let i=from;i<to;i++){const at=(offsetSeconds+i/buffer.sampleRate)*sound.buffer.sampleRate,lo=Math.max(0,Math.floor(at)),hi=Math.min(source.length-1,lo+1);dest[i]+=source[lo]+(source[hi]-source[lo])*(at-lo);}
          }
        }
        await audio.add(buffer);check();
        for(let frame=batch*fps;frame<Math.min(total,(batch+1)*fps);frame++) {
          check();draw(data.start+frame/fps*1000);
          await video.add(frame/fps,Math.min(1/fps,duration-frame/fps));
          if(frame%12===0){progress(Math.floor(frame/total*100));await new Promise(r=>setTimeout(r,0));}
        }
      }
      check();await output.finalize();check();
      const blob=new Blob([output.target.buffer],{type:'video/mp4'});
      if(blob.size>limit)throw new Error('tooLarge');progress(100);return blob;
    } catch(error){await output.cancel().catch(()=>{});throw error;}
    finally {signal.removeEventListener('abort',abort);}
  }

  function mount(parent,run) {
    if(!root.__ACTIVITY__?.instanceId||!run.activityRun||!run.replay)return;
    const data=run.replay.finish(run.artImg),box=document.createElement('div');box.className='activity-replay';
    const share=document.createElement('button'),cancel=document.createElement('button'),status=document.createElement('p'),size=document.createElement('p');
    share.type=cancel.type='button';share.textContent=text('share');cancel.textContent=text('cancel');cancel.hidden=true;
    status.setAttribute('role','status');status.textContent=text('hint');size.className='activity-replay-size';box.append(share,cancel,status,size);parent.appendChild(box);
    if(!supported()||data.disabled||data.frames.length<2){share.disabled=true;status.textContent=text(!supported()?'unsupported':'unavailable');return;}
    let encoded=null,controller=null;
    run.disposeReplay=()=>{controller?.abort();box.remove();encoded=null;};
    cancel.onclick=()=>controller?.abort();
    share.onclick=async()=>{
      if(activeExport)return;
      controller=new AbortController();activeExport=controller;share.disabled=true;cancel.hidden=false;
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;canvas.className='activity-replay-preview';
      box.appendChild(canvas);
      const onHide=()=>{if(document.hidden)controller.abort();};document.addEventListener('visibilitychange',onHide);
      try {
        status.textContent=text('rendering',{n:0});
        const policy=await root.ActivityGames.prepareReplay(data.owner,controller.signal);
        let limit=policy.maxBytes||20*1024*1024,result;
        const mib=bytes=>(bytes/1024/1024).toFixed(1);
        for(let retry=0;retry<2;retry++){
          size.textContent=text('limitInfo',{limit:mib(limit)});
          if(encoded?.size>limit)encoded=null;
          encoded=encoded||await encode(data,canvas,controller.signal,(n,attempt)=>status.textContent=text(attempt||retry?'renderRetry':'rendering',{n}),limit);
          size.textContent=text('fileInfo',{size:mib(encoded.size),limit:mib(limit)});
          status.textContent=text('uploadProgress',{n:0});
          try {
            result=await root.ActivityGames.uploadReplay(data.owner,encoded,controller.signal,n=>status.textContent=text('uploadProgress',{n}));
            break;
          }catch(error){
            // A guild limit may change between encoding and final acceptance.
            if(retry||error.message!=='tooLarge'||!Number.isFinite(error.maxBytes)||error.maxBytes>=encoded.size)throw error;
            limit=error.maxBytes;encoded=null;
          }
        }
        cancel.hidden=true;status.textContent=text('queued');
        // Once accepted by Kei, leaving the screen does not cancel its durable
        // delivery. Poll briefly so permission errors can be retried from here.
        for(let i=0;i<12&&result.status==='pending';i++) {
          await new Promise(resolve=>setTimeout(resolve,2500));
          if(controller.signal.aborted)return;
          try{result=await root.ActivityGames.replayStatus(data.owner);}catch(_){break;}
        }
        status.textContent=text(result.status==='sent'?'sent':result.status==='failed'?'failed':'queued');
        if(result.status==='failed')throw new Error('failed');
        share.textContent=text('shared');encoded=null;
      } catch(error) {
        status.textContent=text(controller.signal.aborted?'cancelled':['unsupported','unavailable','tooLarge','uploadTooLarge','rateLimited','failed'].includes(error.message)?error.message:'failed');
        share.disabled=false;
      } finally {cancel.hidden=true;canvas.remove();document.removeEventListener('visibilitychange',onHide);activeExport=null;}
    };
  }
  const api={begin,mount,encode,renderer,captureHud,dimensions,encodingPlan,fitVideo,MAX_BYTES};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else {
    root.ActivityReplay=api;
    const css=document.createElement('link');css.rel='stylesheet';css.href='activity-replay.css?v=3';document.head.appendChild(css);
  }
})(typeof window!=='undefined'?window:globalThis);
