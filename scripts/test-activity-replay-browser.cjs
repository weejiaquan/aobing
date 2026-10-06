// Real MediaRecorder/Web Audio smoke test; isolated headless Chrome, no Discord calls.
const fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'aobing-replay-test-'));
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
let child,server,ws;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  server=http.createServer((req,res)=>{
    const name=req.url.split('?')[0].slice(1);
    if(['activity-replay.js','activity-replay.css','rhythm-core.js','rhythm-standard.js','i18n.js'].includes(name)){
      res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(path.join(root,name)));return;
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<meta charset="utf-8"><body style="background:#0b1627"><script src="i18n.js"></script><script src="rhythm-core.js"></script><script src="rhythm-standard.js"></script><script src="activity-replay.js"></script><canvas id="preview" width="640" height="480"></canvas>');
  }).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
  const url='http://127.0.0.1:'+server.address().port;
  child=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  const active=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(active);i++)await wait(100);
  const port=fs.readFileSync(active,'utf8').split('\n')[0];
  const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(url),{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let seq=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  await call('Runtime.enable');
  for(let i=0;i<50;i++){const r=await call('Runtime.evaluate',{expression:'!!window.ActivityReplay',returnByValue:true});if(r.result.value)break;await wait(100);}
  const result=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
    window.__ACTIVITY__={instanceId:'test'};
    const ac=new AudioContext(),audio=ac.createBuffer(1,ac.sampleRate*2,ac.sampleRate);
    const samples=audio.getChannelData(0);for(let i=0;i<samples.length;i++)samples[i]=Math.sin(i/ac.sampleRate*440*Math.PI*2)*.12;
    await ac.close();
    const o={kind:'circle',x:250,y:180,time:800};
    const run={activityRun:{id:'local-test'},audioBuf:audio,objs:[{o}],chart:{},entry:{title:'Replay browser verification',diffName:'Recorded manual hit'},radius:32,preempt:600};
    const capture=ActivityReplay.begin(run,'osu');for(let t=0;t<=2000;t+=40)capture.sample(t,t,{x:250,y:180},t>700&&t<850?1:0,{h300:t>=800?1:0},t>=800?1:0);
    capture.mark(o,'end','h300',800);const data=capture.finish(null),canvas=document.getElementById('preview');
    const blob=await ActivityReplay.encode(data,canvas,new AbortController().signal,()=>{});
    const video=document.createElement('video');video.muted=true;video.src=URL.createObjectURL(blob);document.body.appendChild(video);
    await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('Video decode failed'));video.load();});
    ActivityReplay.renderer(canvas,data)(600);
    const buffer=new Uint8Array(await blob.arrayBuffer());let binary='';for(const b of buffer)binary+=String.fromCharCode(b);
    window.__clip=btoa(binary);
    let uploads=0;
    window.ActivityGames={uploadReplay:async(owner,blob)=>{if(!blob.size)throw new Error('Empty upload');uploads++;return {status:'sent'};},replayStatus:async()=>({status:'sent'})};
    const maniaNote={lane:1,time:800,endTime:1500},maniaRun={activityRun:{id:'mania'},audioBuf:audio,notes:[maniaNote],keyCount:4,chart:{scroll:[]},entry:{title:'Mania replay',diffName:'4K'}};
    maniaRun.replay=ActivityReplay.begin(maniaRun,'vsrg',{constantScroll:true});
    for(let t=0;t<=2000;t+=40)maniaRun.replay.sample(t,t,null,t>=800&&t<=1500?2:0,{marvelous:t>=1500?1:0},t>=1500?1:0,1000);
    maniaRun.replay.mark(maniaNote,'head','marvelous',800);maniaRun.replay.mark(maniaNote,'judge','marvelous',1500);
    const panel=document.createElement('div');document.body.appendChild(panel);ActivityReplay.mount(panel,maniaRun);
    panel.querySelector('button').click();
    for(let i=0;i<100&&uploads===0;i++)await new Promise(r=>setTimeout(r,100));
    if(uploads!==1)throw new Error('Share replay did not upload');
    await new Promise(r=>setTimeout(r,20));
    if(!panel.textContent.includes('Replay sent'))throw new Error('Missing upload receipt');
    maniaRun.disposeReplay();
    const cancelled=document.createElement('div');document.body.appendChild(cancelled);ActivityReplay.mount(cancelled,maniaRun);
    cancelled.querySelector('button').click();setTimeout(()=>cancelled.querySelectorAll('button')[1].click(),100);
    await new Promise(r=>setTimeout(r,500));
    if(uploads!==1||!cancelled.textContent.includes('Sharing cancelled'))throw new Error('Cancel failed');
    maniaRun.disposeReplay();
    return {type:blob.type,size:blob.size,width:video.videoWidth,height:video.videoHeight,shareButton:'passed',cancel:'passed'};
  })()`});
  if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
  if(result.result.value.width!==640 || result.result.value.size<1000)throw new Error('Invalid encoded video');
  const shot=await call('Page.captureScreenshot',{format:'png'});
  const preview=path.join(os.tmpdir(),'aobing-replay-preview.png');fs.writeFileSync(preview,Buffer.from(shot.data,'base64'));
  const clip=await call('Runtime.evaluate',{expression:'window.__clip',returnByValue:true});
  const videoPath=path.join(os.tmpdir(),'aobing-replay-browser.'+(result.result.value.type==='video/mp4'?'mp4':'webm'));
  fs.writeFileSync(videoPath,Buffer.from(clip.result.value,'base64'));
  console.log(JSON.stringify({...result.result.value,preview,videoPath}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{ws?.close();child?.kill();server?.close();});
