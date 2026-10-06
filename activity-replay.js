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
      owner:run.activityRun,disabled:false,snapshotUnits:0};
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
        data.frames.push([raw,visual,view,run.gain?.gain.value??data.musicVolume??1]);data.end=raw;
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
  function drawHud(g,view) {
    g.save();g.scale(view.dpr,view.dpr);
    for(const h of view.hud||[]) {
      g.globalAlpha=h.opacity;
      g.beginPath();g.roundRect(h.x,h.y,h.w,h.h,h.radius);
      g.fillStyle=h.background;g.fill();
      if(h.borderWidth){g.lineWidth=h.borderWidth;g.strokeStyle=h.border;g.stroke();}
      if(h.text){g.fillStyle=h.color;g.font=h.font;g.textBaseline='middle';
        g.textAlign=h.align==='center'?'center':h.align==='right'?'right':'left';
        const x=h.align==='center'?h.x+h.w/2:h.align==='right'?h.x+h.w-h.padRight:h.x+h.padLeft;
        g.fillText(h.text,x,h.y+h.h/2);}
    }
    g.restore();
  }
  function renderer(canvas,data) {
    const g=canvas.getContext('2d');let index=0;
    return time=>{
      while(index+1<data.frames.length&&data.frames[index+1][0]<=time)index++;
      const [,visual,view]=data.frames[index];
      if(!view||!data.options.draw)throw new Error('unavailable');
      g.save();g.scale(canvas.width/view.canvas.width,canvas.height/view.canvas.height);
      data.options.draw(visual,{...view,g,ctx2d:g});drawHud(g,view);g.restore();
    };
  }
  function dimensions(data) {
    const original=data.frames[0]?.[2]?.canvas||{width:1280,height:720};
    const scale=Math.min(1,1920/original.width,1080/original.height);
    return {width:Math.max(2,Math.round(original.width*scale/2)*2),height:Math.max(2,Math.round(original.height*scale/2)*2)};
  }
  async function encode(data,canvas,signal,progress,maxBytes=20*1024*1024) {
    if(!supported())throw new Error('unsupported');
    if(data.disabled||data.frames.length<2||data.end-data.start>MAX_MS)throw new Error('unavailable');
    const M=await media(),duration=(data.end-data.start)/1000;
    const {width,height}=dimensions(data);canvas.width=width;canvas.height=height;
    const limit=Math.min(MAX_BYTES,maxBytes),budget=Math.floor(limit*8*.85/(duration+1));
    const bitrate=Math.min(12000000,Math.max(100000,budget-160000));
    const config={width,height,bitrate,fullCodecString:'avc1.42002a'};
    if(!await M.canEncodeVideo('avc',config)||!await M.canEncodeAudio('aac',{sampleRate:48000,numberOfChannels:2,bitrate:160000}))throw new Error('unsupported');
    if(signal.aborted)throw new Error('cancelled');
    const output=new M.Output({format:new M.Mp4OutputFormat({fastStart:'in-memory'}),target:new M.BufferTarget()});
    let bytes=0,failure=null;
    const count=packet=>{bytes+=packet.byteLength;if(bytes>limit)failure=new Error('tooLarge');};
    const video=new M.CanvasSource(canvas,{codec:'avc',fullCodecString:config.fullCodecString,bitrate,keyFrameInterval:2,onEncodedPacket:count});
    const audio=new M.AudioBufferSource({codec:'aac',bitrate:160000,transform:{sampleRate:48000,numberOfChannels:2},onEncodedPacket:count});
    output.addVideoTrack(video,{frameRate:FPS});output.addAudioTrack(audio);
    const abort=()=>{void output.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    const check=()=>{if(signal.aborted)throw new Error('cancelled');if(failure)throw failure;};
    try {
      await output.start();const draw=renderer(canvas,data),total=Math.ceil(duration*FPS);
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
        for(let frame=batch*FPS;frame<Math.min(total,(batch+1)*FPS);frame++) {
          check();draw(data.start+frame/FPS*1000);
          await video.add(frame/FPS,Math.min(1/FPS,duration-frame/FPS));
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
    const share=document.createElement('button'),cancel=document.createElement('button'),status=document.createElement('p');
    share.type=cancel.type='button';share.textContent=text('share');cancel.textContent=text('cancel');cancel.hidden=true;
    status.setAttribute('role','status');status.textContent=text('hint');box.append(share,cancel,status);parent.appendChild(box);
    if(!supported()||data.disabled||data.frames.length<2){share.disabled=true;status.textContent=text(!supported()?'unsupported':'unavailable');return;}
    let encoded=null,controller=null;
    run.disposeReplay=()=>{controller?.abort();box.remove();encoded=null;};
    cancel.onclick=()=>controller?.abort();
    share.onclick=async()=>{
      if(activeExport)return;
      controller=new AbortController();activeExport=controller;share.disabled=true;cancel.hidden=false;
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;canvas.className='activity-replay-preview';
      box.appendChild(canvas);
      const onHide=()=>{if(document.hidden)controller.abort();};document.addEventListener('visibilitychange',onHide);
      try {
        status.textContent=text('rendering',{n:0});
        const policy=await root.ActivityGames.prepareReplay(data.owner,controller.signal);
        encoded=encoded||await encode(data,canvas,controller.signal,n=>status.textContent=text('rendering',{n}),policy.maxBytes);
        status.textContent=text('uploading');
        let result=await root.ActivityGames.uploadReplay(data.owner,encoded,controller.signal);
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
        status.textContent=text(controller.signal.aborted?'cancelled':['unsupported','unavailable','tooLarge','rateLimited','failed'].includes(error.message)?error.message:'failed');
        share.disabled=false;
      } finally {cancel.hidden=true;canvas.remove();document.removeEventListener('visibilitychange',onHide);activeExport=null;}
    };
  }
  const api={begin,mount,encode,renderer,captureHud,dimensions,MAX_BYTES};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else {
    root.ActivityReplay=api;
    const css=document.createElement('link');css.rel='stylesheet';css.href='activity-replay.css?v=2';document.head.appendChild(css);
  }
})(typeof window!=='undefined'?window:globalThis);
