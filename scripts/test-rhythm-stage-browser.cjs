// Actual adapters, imported folder files, IndexedDB and Web Audio in isolated Chrome.
// No account, Discord or production server traffic.
const fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'aobing-stage-'));
let server,child,ws;const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  server=http.createServer((req,res)=>{
    const name=decodeURIComponent(req.url.split('?')[0]).slice(1);
    if(!name){
      let html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
      const scripts=['i18n.js','rhythm-core.js','rhythm-standard.js','rhythm-mania.js','rhythm-ui.js','ui-motion.js','rhythm-select.js','hitsound.js','osustd.js','vsrg.js'];
      html=html.replace('</body>',`<style>body>:not(style):not(link):not(#osu-panel):not(#vsrg-panel):not(#multiplayer-dialog):not(#hub-launch):not(#mode-menu){display:none!important}body{margin:0}</style>${scripts.map(s=>'<script src="/'+s+'"></script>').join('')}<script>
      document.body.classList.add('music-mode');window.settings={gameMode:'osu',musicVol:20,osuKeys:['z','x']};window.hooks={};
      window.audioStarts=[];const nativeStart=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(...args){audioStarts.push({node:this,args});return nativeStart.apply(this,args);};

      const deps={settings,saveSettings(){},pauseBgm(){},resumeBgm(){},captureKeyboard(){},escapeHtml:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))};
      OsuStdGame.init(deps);VsrgGame.init(deps);OsuStdGame.open();
      </script></body>`);res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;
    }
    const file=path.resolve(root,name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
    const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml','.mp3':'audio/mpeg','.ogg':'audio/ogg','.png':'image/png'};res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');
    if(name==='osustd.js'||name==='vsrg.js'){
      const mode=name==='osustd.js'?'osu':'vsrg';let src=fs.readFileSync(file,'utf8');
      src=src.replace('    function calOffset()',`    window.__stageHooks=window.__stageHooks||{};window.__stageHooks.${mode}={handleImportFiles,handleOszFiles,refreshLibrary,loadAndPlay,quitToSelect,pauseRun,finishRun,get run(){return run;},get library(){return library;}};\n    function calOffset()`);res.end(src);return;
    }res.end(fs.readFileSync(file));
  }).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
  child=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  const active=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(active);i++)await wait(100);
  const port=fs.readFileSync(active,'utf8').split('\n')[0];const tab=await(await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent('http://127.0.0.1:'+server.address().port),{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let seq=0;const pending=new Map(),runtimeErrors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')runtimeErrors.push(m.params.exceptionDetails);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await call('Runtime.enable');
  for(let i=0;i<150;i++){if(await evaluate('!!window.__stageHooks?.vsrg && !!document.querySelector(".rs-song")'))break;await wait(100);}
  if(!await evaluate('!!window.__stageHooks?.vsrg'))throw Error('Adapters failed to initialize');
  const check=async(expression,label)=>{if(!await evaluate(expression))throw Error(label);console.log('PASS: '+label);};
  // Import a real file list, including art and custom hitsound; no OSZ records exist.
  await evaluate(`(async()=>{
    const text=await(await fetch('/assets/osustd/test/test.osu')).text();
    const audioName=RhythmSelect.metadata(text).audio;
    const audio=await(await fetch('/assets/osustd/test/'+audioName)).arrayBuffer();
    const art=await(await fetch('/assets/default-bg.png')).blob();
    const make=(name,bytes,type)=>{const f=new File([bytes],name,{type});Object.defineProperty(f,'webkitRelativePath',{value:'Songs/Fixture/'+name});return f;};
    window.fixtureText=text.replace(/Title:.*/,'Title:Skyline resonance').replace(/Artist:.*/,'Artist:Aobing sound test').replace('[Events]','[Events]\\n0,0,"cover.png",0,0');
    window.folderFiles=[make('stage.osu',fixtureText,'text/plain'),make('alternate.osu',fixtureText.replace('Version:Tutorial','Version:Another'),'text/plain'),make(audioName,audio,'audio/ogg'),make('cover.png',art,'image/png'),make('normal-hitnormal.wav',audio,'audio/ogg')];
    ['Afterglow express','Aerial garden','Cloud nine','Last train home','Neon snow','Blue hour','Paper satellites','Halcyon days','Distant horizon'].forEach((title,i)=>folderFiles.push(make('extra'+i+'.osu',fixtureText.replace('Skyline resonance',title).replace('Version:Tutorial','Version:Skyline '+i),'text/plain')));
    await __stageHooks.osu.handleImportFiles(folderFiles);
  })()`);
  await check(`(async()=>{const maps=await OsuStdGame.listCharts();const map=maps.find(m=>m.title==='Skyline resonance');if(!map)return false;const rec=await OsuStdGame.getChartRecord(map.hash);return !!rec.audio.length&&!!rec.art.length&&rec.samples.length>0&&await OsuStdGame.hasChart(map.hash);})()`,'folder-only chart is selectable and materializes audio, cover and samples for multiplayer');
  await check(`(async()=>{const maps=await OsuStdGame.listCharts();const map=maps.find(m=>m.title==='Skyline resonance');const prepared=await OsuStdGame.prepareMultiplayer(map.hash);return prepared.chart.title===map.title&&prepared.audioBuf.duration>0&&prepared.samples.size>0;})()`,'folder-only chart can prepare audio and samples for Ready without an OSZ cache');
  await evaluate(`document.querySelector('#osu-select .rs-search').value='Skyline resonance';document.querySelector('#osu-select .rs-search').dispatchEvent(new Event('input'));document.querySelector('#osu-select .rs-song-main').click()`);
  await wait(600);
  await check(`!__stageHooks.osu.run && document.querySelector('#osu-select .rs-preview').classList.contains('playing')`,'first click previews without launching');
  const starts=await evaluate('audioStarts.length');
  await evaluate(`document.querySelectorAll('#osu-select .rs-diff')[1].click()`);await wait(250);
  await check(`audioStarts.length===${starts}&&!__stageHooks.osu.run`,'changing difficulty keeps shared song preview continuous');
  await evaluate(`document.querySelector('#osu-select .rs-tools').open=true`);await wait(50);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
  await check(`!document.querySelector('#osu-select .rs-tools').open&&document.getElementById('osu-panel').classList.contains('open')`,'Escape closes setup without leaving the game mode');
  async function shot(label,width,height){await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await wait(280);await check(`(()=>{const p=document.querySelector('#osu-panel.open .rhythm-select:not([hidden]),#vsrg-panel.open .rhythm-select:not([hidden])');const b=p.querySelector('.rs-play').getBoundingClientRect();return p.scrollWidth<=p.clientWidth+1&&p.scrollHeight<=p.clientHeight+1&&b.height>0&&b.bottom<=innerHeight;})()`,'layout fits '+label);const s=await call('Page.captureScreenshot',{format:'png'});const file=path.join(os.tmpdir(),'aobing-stage-'+label+'.png');fs.writeFileSync(file,Buffer.from(s.data,'base64'));console.log(file);}
  await evaluate(`document.querySelector('#osu-select .rs-search').value='';document.querySelector('#osu-select .rs-search').dispatchEvent(new Event('input'))`);
  await shot('standard-desktop',1440,900);await shot('standard-mobile',390,844);await shot('standard-landscape',844,390);
  await evaluate(`document.querySelector('#osu-songlist').focus()`);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown'});
  await check(`document.activeElement.id==='osu-songlist'&&!__stageHooks.osu.run`,'keyboard browsing retains focus and previews without launching');
  await evaluate(`document.querySelectorAll('#osu-select .rs-song-main')[0].click();document.querySelectorAll('#osu-select .rs-song-main')[1].click();document.querySelectorAll('#osu-select .rs-song-main')[2].click()`);await wait(350);
  await check(`document.querySelector('#osu-select .rs-title').textContent==='Blue hour'&&!__stageHooks.osu.run`,'rapid selection leaves the latest song selected');
  await evaluate(`document.body.dataset.skyPhase='night'`);await shot('standard-night',1280,800);
  await evaluate(`document.querySelector('#osu-select .rs-play').click()`);await wait(800);
  await check(`!!__stageHooks.osu.run&&!document.querySelector('#osu-select .rs-preview').classList.contains('playing')`,'play launches Standard and stops preview');
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await wait(3000);
  let screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),'aobing-stage-standard-play.png'),Buffer.from(screenshot.data,'base64'));
  await evaluate(`__stageHooks.osu.pauseRun()`);await check(`document.querySelector('.rhythm-pause[open]')!==null`,'pause control remains available');
  await evaluate(`OsuStdGame.close();settings.gameMode='vsrg';VsrgGame.open()`);await wait(600);
  await shot('mania-desktop',1440,900);await shot('mania-mobile',390,844);await shot('mania-landscape',740,360);
  await evaluate(`document.querySelector('#vsrg-select .rs-song-main').click()`);await wait(500);await check(`!__stageHooks.vsrg.run&&document.querySelector('#vsrg-select .rs-preview').classList.contains('playing')`,'Mania first click previews');
  await evaluate(`document.querySelector('#vsrg-select .rs-play').click()`);await wait(600);await check(`!!__stageHooks.vsrg.run`,'Mania starts');
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await wait(2500);screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),'aobing-stage-mania-play.png'),Buffer.from(screenshot.data,'base64'));
  await evaluate(`__stageHooks.vsrg.finishRun()`);await wait(1000);screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),'aobing-stage-mania-results.png'),Buffer.from(screenshot.data,'base64'));
  await evaluate(`__stageHooks.vsrg.quitToSelect();I18N.set('ar')`);await shot('mania-arabic',390,844);
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await shot('reduced-motion',1280,800);
  await evaluate(`I18N.set('en');document.querySelector('#vsrg-select .rs-preview').click()`);await wait(300);
  await evaluate(`document.getElementById('multiplayer-dialog').showModal()`);await wait(80);
  await check(`!document.querySelector('#vsrg-select .rs-preview').classList.contains('playing')`,'opening a dialog cancels preview audio');
  await evaluate(`document.getElementById('multiplayer-dialog').close();window.originalAudio=__stageHooks.vsrg.library[0].getAudio;__stageHooks.vsrg.library[0].getAudio=async()=>{throw Error('file permission revoked');};document.querySelector('#vsrg-select .rs-play').click()`);await wait(300);
  await check(`!document.getElementById('vsrg-select').hidden&&document.querySelector('#vsrg-select .rs-status').textContent.includes('Could not load')&&!document.querySelector('#vsrg-select .rs-play').disabled`,'lost file access shows a recoverable song error');
  await evaluate(`__stageHooks.vsrg.library[0].getAudio=originalAudio;VsrgGame.close()`);
  await check(`!document.querySelector('.rs-preview.playing')`,'mode exit releases preview playback');
  if(runtimeErrors.length)throw Error('Uncaught browser errors: '+JSON.stringify(runtimeErrors));
  console.log('PASS: real browser rhythm stage checks, no uncaught exceptions');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{ws?.close();child?.kill();server?.close();});
