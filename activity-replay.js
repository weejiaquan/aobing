/* Discord-only run capture, isolated replay renderer, and client video export. */
(function(root) {
  'use strict';
  const MAX_BYTES=8*1024*1024, MAX_MS=600000;
  const colors=['#56baff','#ff82bd','#f5bd67','#86e6cd'];
  const labels={h300:'300',h100:'100',h50:'50',marvelous:'MAX',perfect:'300',great:'200',good:'100',bad:'50',miss:'MISS'};
  const text=(key,vars)=>root.I18N.t('replay.'+key,vars);
  let activeExport=null;

  function begin(run, mode, options={}) {
    if (!root.__ACTIVITY__?.instanceId || !run.activityRun || run.auto) return null;
    const objects=mode==='osu'?run.objs.map(s=>s.o):run.notes;
    const indices=new Map(objects.map((o,i)=>[o,i]));
    const data={mode,objects,options,scroll:run.chart.scroll,frames:[],events:[],start:0,end:0,audio:run.audioBuf,
      title:run.entry.title,difficulty:run.entry.diffName,keys:run.keyCount||0,
      radius:run.radius||32,preempt:run.preempt||1200,art:null,owner:run.activityRun,disabled:false};
    return {
      data,
      sample(raw,visual,cursor,held,counts,combo,approach) {
        if(data.disabled || !Number.isFinite(raw) || raw<0) return;
        if(raw-data.start>MAX_MS) { data.disabled=true;data.frames=[];data.events=[];return; }
        if(data.frames.length && raw-data.frames.at(-1)[0]<1000/30) return;
        const weights=mode==='osu'?{h300:300,h100:100,h50:50,miss:0}:{marvelous:320,perfect:300,great:200,good:100,bad:50,miss:0};
        let points=0,total=0;for(const k in weights){points+=(counts[k]||0)*weights[k];total+=counts[k]||0;}
        data.frames.push([raw,visual,cursor?.x||0,cursor?.y||0,held,combo,total?100*points/(total*(mode==='osu'?300:320)):100,approach||1200]);
        data.end=raw;
      },
      mark(object,kind,tier,raw) {
        if(data.disabled || !indices.has(object)) return;
        if(data.events.length>=200000) {data.disabled=true;data.frames=[];data.events=[];return;}
        data.events.push([raw,indices.get(object),kind,tier]);
      },
      skip(raw) {data.start=Math.max(0,raw);data.frames=data.frames.filter(f=>f[0]>=data.start);},
      finish(art) {data.art=art;data.events.sort((a,b)=>a[0]-b[0]);return data;},
    };
  }

  function renderer(canvas,data) {
    const g=canvas.getContext('2d'),W=canvas.width,H=canvas.height;
    let frame=0,event=0;const ended=new Map(),heads=new Set();
    return time=>{
      while(frame+1<data.frames.length && data.frames[frame+1][0]<=time) frame++;
      while(event<data.events.length && data.events[event][0]<=time) {
        const e=data.events[event++];if(e[2]==='end'||e[2]==='judge')ended.set(e[1],e);else if(e[2]==='head'||e[2]==='break')heads.add(e[1]);
      }
      const f=data.frames[frame],next=data.frames[Math.min(frame+1,data.frames.length-1)];
      const mix=next[0]>f[0]?Math.max(0,Math.min(1,(time-f[0])/(next[0]-f[0]))):0;
      const visual=f[1]+time-f[0];
      g.fillStyle='#0b1627';g.fillRect(0,0,W,H);
      if(data.art){g.globalAlpha=.17;g.drawImage(data.art,0,0,W,H);g.globalAlpha=1;}
      const top=68,bottom=H-42,scale=Math.min(W/640,(bottom-top)/384),ox=(W-512*scale)/2,oy=top;
      if(data.mode==='osu') {
        const radius=data.radius*scale;
        for(let i=data.objects.length-1;i>=0;i--){
          const o=data.objects[i],end=ended.get(i);
          if(end){if(time-end[0]<350 && o.x!=null){g.fillStyle=end[3]==='miss'?'#ff6682':'#a5efff';g.font='bold 18px sans-serif';g.fillText(labels[end[3]]||'',ox+o.x*scale,oy+o.y*scale);}continue;}
          if(visual<o.time-data.preempt||visual>(o.endTime||o.time)+300)continue;
          const color=colors[i%colors.length];g.strokeStyle=color;g.fillStyle=color;
          if(o.kind==='spinner') {g.lineWidth=4;g.beginPath();g.arc(W/2,(top+bottom)/2,90*scale,0,Math.PI*2);g.stroke();continue;}
          const x=ox+o.x*scale,y=oy+o.y*scale;
          if(o.kind==='slider' && o.path?.length){
            g.lineWidth=radius*1.6;g.lineCap='round';g.globalAlpha=.35;g.beginPath();
            o.path.forEach((p,j)=>j?g.lineTo(ox+p.x*scale,oy+p.y*scale):g.moveTo(ox+p.x*scale,oy+p.y*scale));g.stroke();g.globalAlpha=1;
            if(visual>=o.time && visual<=o.endTime && root.RhythmStandard){const p=root.RhythmStandard.ball(o,visual);g.fillStyle='#fff';g.beginPath();g.arc(ox+p.x*scale,oy+p.y*scale,radius*.65,0,Math.PI*2);g.fill();}
          }
          if(!heads.has(i)){g.lineWidth=2;g.beginPath();g.arc(x,y,radius,0,Math.PI*2);g.stroke();g.globalAlpha=.2;g.fill();g.globalAlpha=1;
            if(visual<o.time){g.beginPath();g.arc(x,y,radius*(1+3*(o.time-visual)/data.preempt),0,Math.PI*2);g.stroke();}}
        }
        g.fillStyle=f[4]?'#f5bd67':'#fff';g.beginPath();g.arc(ox+(f[2]+(next[2]-f[2])*mix)*scale,oy+(f[3]+(next[3]-f[3])*mix)*scale,6,0,Math.PI*2);g.fill();
      } else {
        const laneW=Math.min(64,(W-80)/data.keys),left=(W-laneW*data.keys)/2,hit=top+(bottom-top)*(data.options.receptor||.85);
        const position=t=>data.options.constantScroll||!root.RhythmCore?t:root.RhythmCore.scrollAt(data.scroll,t);
        g.save();if(data.options.upscroll){g.translate(0,top+bottom);g.scale(1,-1);}
        for(let lane=0;lane<data.keys;lane++){g.fillStyle=f[4]&(1<<lane)?'#244f6a':'#132338';g.fillRect(left+lane*laneW,top,laneW-2,hit-top+14);}
        g.fillStyle='#a5efff';g.fillRect(left,hit,data.keys*laneW,3);
        for(let i=0;i<data.objects.length;i++) {
          const o=data.objects[i];if(ended.has(i))continue;
          const y=hit-(position(o.time)-position(visual))/f[7]*(hit-top),tail=hit-(position(o.endTime??o.time)-position(visual))/f[7]*(hit-top);
          if(y<top-20 || tail>bottom+20)continue;
          g.fillStyle=colors[o.lane%colors.length];const x=left+o.lane*laneW+4;
          if(o.endTime!=null){g.globalAlpha=.45;g.fillRect(x,Math.max(top,tail),laneW-8,Math.max(0,Math.min(hit,y)-Math.max(top,tail)));g.globalAlpha=1;}
          if(!heads.has(i))g.fillRect(x,y,laneW-8,12);
        }
        g.restore();
        const last=data.events[event-1];if(last && time-last[0]<300){g.fillStyle=last[3]==='miss'?'#ff6682':'#a5efff';g.font='bold 22px sans-serif';g.fillText(labels[last[3]]||'',W/2-25,H/2);}
      }
      g.fillStyle='#091222';g.fillRect(0,0,W,58);g.fillRect(0,H-34,W,34);
      g.fillStyle='#fff';g.font='bold 17px sans-serif';g.textAlign='left';g.fillText(String(data.title).slice(0,70),18,24,W-36);
      g.fillStyle='#a5efff';g.font='13px sans-serif';g.fillText(String(data.difficulty).slice(0,80),18,45,W-200);
      g.textAlign='right';g.fillText(f[6].toFixed(2)+'%   '+f[5]+'×',W-18,45);g.textAlign='left';
      g.fillStyle='#b5cbe0';g.fillText('AOBING IT! · '+(data.mode==='osu'?'Standard':'Mania')+' · REPLAY',18,H-12);
      g.fillStyle='#009fe8';g.fillRect(0,H-3,W*Math.min(1,(time-data.start)/Math.max(1,data.end-data.start)),3);
    };
  }

  function mimeType() {
    return ['video/webm;codecs=vp8,opus','video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/webm'].find(m=>root.MediaRecorder?.isTypeSupported(m));
  }
  async function encode(data,canvas,signal,progress) {
    if(!mimeType()||!canvas.captureStream)throw new Error('unsupported');
    if(data.disabled||data.frames.length<2||data.end-data.start>MAX_MS)throw new Error('unavailable');
    const ac=new (root.AudioContext||root.webkitAudioContext)();
    let stream,recorder,source,raf=0,watchdog=0;
    try {
      await ac.resume();if(signal.aborted)throw new Error('cancelled');
      const duration=(data.end-data.start)/1000,draw=renderer(canvas,data),dest=ac.createMediaStreamDestination();
      stream=canvas.captureStream(30);dest.stream.getAudioTracks().forEach(track=>stream.addTrack(track));
      source=ac.createBufferSource();source.buffer=data.audio;source.connect(dest);
      const budget=Math.floor(MAX_BYTES*8*.72/(duration+1));
      recorder=new root.MediaRecorder(stream,{mimeType:mimeType(),videoBitsPerSecond:Math.min(1800000,Math.max(40000,budget-64000)),audioBitsPerSecond:64000});
      const chunks=[];let size=0;
      const blob=await new Promise((resolve,reject)=>{
        let failure=null;const stop=error=>{failure=error||failure;if(recorder.state!=='inactive')recorder.stop();else if(failure)reject(failure);};
        const abort=()=>stop(new Error('cancelled'));
        signal.addEventListener('abort',abort,{once:true});
        recorder.ondataavailable=e=>{if(e.data.size){size+=e.data.size;if(size>MAX_BYTES)stop(new Error('tooLarge'));else chunks.push(e.data);}};
        recorder.onerror=()=>stop(new Error('encodeFailed'));
        recorder.onstop=()=>{signal.removeEventListener('abort',abort);failure?reject(failure):resolve(new Blob(chunks,{type:recorder.mimeType.split(';')[0]}));};
        draw(data.start);recorder.start(1000);
        const start=ac.currentTime;
        if(data.start/1000<data.audio.duration)source.start(start,Math.max(0,data.start/1000));
        const frame=()=>{if(signal.aborted)return;const elapsed=ac.currentTime-start;
          draw(Math.min(data.end,data.start+elapsed*1000));progress(Math.min(100,Math.floor(elapsed/duration*100)));
          if(elapsed>=duration){stop();return;}raf=requestAnimationFrame(frame);};
        raf=requestAnimationFrame(frame);
        watchdog=setTimeout(()=>stop(new Error('encodeFailed')),(duration+20)*1000);
      });
      if(blob.size>MAX_BYTES)throw new Error('tooLarge');return blob;
    } finally {
      cancelAnimationFrame(raf);clearTimeout(watchdog);
      try{source?.stop();}catch(_){}
      if(recorder?.state!=='inactive'){try{recorder?.stop();}catch(_){}}
      stream?.getTracks().forEach(t=>t.stop());await ac.close();
    }
  }

  function mount(parent,run) {
    if(!root.__ACTIVITY__?.instanceId||!run.activityRun||!run.replay)return;
    const data=run.replay.finish(run.artImg),box=document.createElement('div');box.className='activity-replay';
    const share=document.createElement('button'),cancel=document.createElement('button'),status=document.createElement('p');
    share.type=cancel.type='button';share.textContent=text('share');cancel.textContent=text('cancel');cancel.hidden=true;
    status.setAttribute('role','status');status.textContent=text('hint');box.append(share,cancel,status);parent.appendChild(box);
    if(!mimeType()||data.disabled||data.frames.length<2){share.disabled=true;status.textContent=text(!mimeType()?'unsupported':'unavailable');return;}
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
        encoded=encoded||await encode(data,canvas,controller.signal,n=>status.textContent=text('rendering',{n}));
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
  const api={begin,mount,encode,renderer,MAX_BYTES};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else {
    root.ActivityReplay=api;
    const css=document.createElement('link');css.rel='stylesheet';css.href='activity-replay.css?v=1';document.head.appendChild(css);
  }
})(typeof window!=='undefined'?window:globalThis);
