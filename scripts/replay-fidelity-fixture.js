// Loaded only by the isolated browser test; production never loads this file.
window.checkReplayFidelity=async function(){
  window.__ACTIVITY__={instanceId:'test'};
  window.ActivityGames={newRun:()=>({id:'test'})};
  const settings={musicVol:60,osuKeys:['z','x'],vsrgNoteStyle:'arrow',vsrgColorPreset:'pastel'};
  Hitsound.init({settings,saveSettings(){}});
  OsuStdGame.init({settings,saveSettings(){}});VsrgGame.init({settings,saveSettings(){}});
  const results=[];
  for(const mode of ['osu','vsrg']){
    const rt=__replayRuntime[mode],ac=await rt.ensureCtx();
    const audio=ac.createBuffer(2,48000*30,48000);
    const text='[General]\nMode:'+(mode==='osu'?0:3)+'\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\nSliderMultiplier:1\n[TimingPoints]\n0,500,4,1,0,100,1\n[HitObjects]\n'+(mode==='osu'?'100,100,1000,2,0,L|200:100,2,100\n300,200,2500,1,0\n256,192,3500,8,0,4500':'64,0,1000,128,0,2000:0:0:0:0:\n192,0,2500,1,0');
    const chart=rt.parse(text);
    const panel=document.getElementById(mode+'-panel');panel.hidden=false;panel.style.cssText='display:block;position:relative;width:640px;height:480px;z-index:999999';
    rt.show('game');
    if(mode==='osu'){
      const sprite=(color,label)=>{const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d');g.fillStyle=color;g.fillRect(6,6,52,52);g.fillStyle='#fff';g.font='bold 36px sans-serif';g.fillText(label,22,45);return c;};
      rt.skin({images:{hitcircle:sprite('#ff5588',''),digits:Array.from({length:10},(_,i)=>sprite('#0099aa',String(i))),cursor:sprite('#ffee44','+')},colors:['#ee44ff','#44eeff']});
    }
    rt.startRun({title:'Fidelity verification',diffName:'Skin + HUD'},chart,audio);
    const canvas=document.getElementById(mode+'-canvas');canvas.style.cssText='width:640px;height:480px';canvas.width=640;canvas.height=480;
    document.getElementById(mode+'-combo').textContent='123x';document.getElementById(mode+'-acc').textContent='98.76% · UR 42';
    const replay=rt.run.replay;
    if(mode==='osu')rt.onKeyDown({key:'z',timeStamp:performance.now(),preventDefault(){}});
    const hit=ac.createBuffer(1,3840,48000),samples=hit.getChannelData(0);
    for(let i=0;i<samples.length;i++)samples[i]=Math.sin(i/48000*440*Math.PI*2)*.5;
    settings.hitsoundUseMap=true;rt.run.clock.reset(ac.currentTime-.75);
    Hitsound.playNote(ac,new Map([['normal-hitnormal.wav',hit]]),{normalSet:1,index:0,bits:0,volume:100});
    if(!replay.data.sounds.some(s=>s.type==='buffer'&&s.args[0]===hit))throw new Error('Actual custom hitsound not captured');
    for(const time of [600,1100,1600,2600,3600]){
      const live=rt.liveRenderView(),view=rt.captureReplayView(time);view.now=live.now;
      canvas.getContext('2d').reset();rt.render(time,live);
      const expected=canvas.getContext('2d').getImageData(0,0,640,480).data;
      const copy=document.createElement('canvas');copy.width=640;copy.height=480;
      rt.render(time,{...view,g:copy.getContext('2d',{willReadFrequently:true}),ctx2d:copy.getContext('2d',{willReadFrequently:true})});
      const actual=copy.getContext('2d',{willReadFrequently:true}).getImageData(0,0,640,480).data;
      let difference=0;for(let i=0;i<actual.length;i++)difference+=Math.abs(actual[i]-expected[i]);
      // GPU/CPU canvas rasterizers differ slightly at antialiased edges.
      if(difference/actual.length>.15)throw new Error(mode+' visual mismatch at '+time+': mean channel error '+difference/actual.length);
      if(mode==='osu'&&!view.hud.some(h=>h.text==='Z'))throw new Error('Key overlay missing');
      if(!view.hud.some(h=>h.text==='123x')||!view.hud.some(h=>h.text.includes('98.76%')))throw new Error('HUD missing');
    }
    // Export actual game scenes with a readable sidebar and real recorded inputs.
    const counts=mode==='osu'?{h300:122,h100:1,h50:0,miss:0}:{marvelous:120,perfect:2,great:1,good:0,bad:0,miss:0};
    replay.input(200,mode==='osu'?'z':0,true);replay.input(700,mode==='osu'?'z':0,false);
    if(mode==='osu')rt.run.maxCombo=123;else rt.run.state.maxCombo=123;
    for(let t=0;t<=30000;t+=1000/60)replay.sample(t,t,{},0,counts,123);
    replay.sample(30000,30000,{},0,counts,123);
    const out=document.createElement('canvas');out.id='fidelity-'+mode;document.body.prepend(out);
    const start=performance.now();
    const blob=await ActivityReplay.encode(replay.finish(),out,new AbortController().signal,()=>{},50*1024*1024);
    const encodeMs=Math.round(performance.now()-start);
    const decoded=await ac.decodeAudioData(await blob.arrayBuffer());
    const soundStart=replay.data.sounds.find(s=>s.type==='buffer').raw/1000;
    const decodedSamples=decoded.getChannelData(0);
    let peak=0,earlyPeak=0;
    for(let i=0;i<Math.floor(decoded.sampleRate*.4);i++)earlyPeak=Math.max(earlyPeak,Math.abs(decodedSamples[i]));
    for(let i=Math.floor(decoded.sampleRate*soundStart);i<Math.floor(decoded.sampleRate*(soundStart+.1));i++)peak=Math.max(peak,Math.abs(decodedSamples[i]));
    if(earlyPeak>.001||peak<.05)throw new Error('Hitsound timing/audio missing from MP4');
    const small=document.createElement('canvas');
    const smallBlob=await ActivityReplay.encode(replay.data,small,new AbortController().signal,()=>{},1024*1024);
    if(smallBlob.size>1024*1024)throw new Error('Adaptive export exceeded its cap');
    results.push({mode,smallBytes:smallBlob.size,pixelMatch:true,hitsoundTiming:true,durationSeconds:30,encodeMs,bytes:blob.size});
    ActivityReplay.renderer(out,replay.data)(600);
    rt.teardownRun();panel.hidden=true;
  }
  return results;
};
