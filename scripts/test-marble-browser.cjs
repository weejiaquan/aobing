// Actual shell, marble shooter UI and app mode router, with economy/auth omitted.
'use strict';
const fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),E=require('../marble');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'aobing-marble-'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));let server,child,ws;
(async()=>{
  const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
  const router=app.slice(app.indexOf('    // --- Persistent shop launcher'),app.indexOf('    window.__aobingAppReady = true;'));
  assert.ok(router.includes("settings.gameMode === 'marble'"));
  let html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  html=html.replace('</body>', ['i18n.js','sky-time.js','game-shell.js','marble.js','marble-ui.js'].map(src=>'<script src="/'+src+'"></script>').join('')+`<script>
    const settings={sfxVol:0,gameMode:'clicker'},saveSettings=()=>{},shopBtn=document.getElementById('shop-btn');
    let musicModeOn=false,autoTimer=null,musicIdlePeriodMs=0,musicIdleStart=0;
    const currentAutoCps=()=>0,stopAutoCoinFloater=()=>{},rearmAutoLoop=()=>{};
    window.keyboardCaptured=false;
    const createMarble=MarbleEngine.create;MarbleEngine.create=(...args)=>window.testState=createMarble(...args);
    MarbleGame.init({settings,captureKeyboard:on=>window.keyboardCaptured=on});
    ${router}
    window.fixtureReady=true;window.dispatchEvent(new Event('aobingready'));
  </script></body>`);
  server=http.createServer((req,res)=>{
    const name=decodeURIComponent(req.url.split('?')[0]);
    if(name==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
    const file=path.resolve(root,'.'+name);
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
    const mime={'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'}[path.extname(file)];
    if(!mime){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',mime);res.end(fs.readFileSync(file));
  }).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
  const url='http://127.0.0.1:'+server.address().port;
  child=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  const active=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(active);i++)await wait(100);
  const port=fs.readFileSync(active,'utf8').split('\n')[0];
  const tab=await(await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let seq=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  async function until(expression){for(let i=0;i<150;i++){if(await evaluate(expression))return;await wait(100);}throw Error('Timed out: '+expression+' '+JSON.stringify(errors));}
  async function reload(){await evaluate('window.fixtureReady=false');await call('Page.reload');await until('window.fixtureReady');}
  await call('Runtime.enable');await call('Page.enable');
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await call('Page.navigate',{url});await until('window.fixtureReady');
  async function launch(){await evaluate("document.getElementById('boot-start')?.click()");await until("!document.getElementById('curtain')");await evaluate("document.getElementById('hub-launch').click();document.querySelector('[data-launch-mode=marble]').click()");await until("!document.getElementById('marble-panel').hidden");}
  await launch();
  assert.ok(await evaluate("window.keyboardCaptured && document.body.classList.contains('music-mode')"));
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const state=()=>evaluate('window.testState');
  const playing=()=>evaluate("document.getElementById('marble-overlay').hidden");
  async function shot(name,width,height,dpr=1){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:dpr,mobile:false});await wait(650);
    assert.ok(await evaluate("document.getElementById('marble-panel').scrollWidth<=innerWidth"),name+' overflows');
    if(name==='landscape')assert.ok(await evaluate("document.getElementById('marble-canvas').getBoundingClientRect().bottom<=innerHeight-76"),'Landscape board covered by navigation');
    const result=await call('Page.captureScreenshot',{format:'png'}),file=path.join(os.tmpdir(),'aobing-marble-'+name+'.png');fs.writeFileSync(file,Buffer.from(result.data,'base64'));console.log(file);
  }
  async function point(x,y){return evaluate(`(()=>{const r=document.getElementById('marble-canvas').getBoundingClientRect();return {x:r.left+${x}/900*r.width,y:r.top+${y}/620*r.height};})()`);}
  async function mouse(p){await call('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});}
  async function key(key,code,vk){await call('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk});await call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk});}
  await shot('ready',1280,900);await click('#marble-play');await until('window.testState.time>.3');
  assert.ok(await playing());const initial=await state();await mouse(await point(750,130));assert.equal((await state()).shots,initial.shots+1);
  await click('#marble-swap');const swapped=await state();await click('#marble-swap');assert.equal((await state()).loaded,swapped.next);
  await evaluate("document.getElementById('marble-canvas').focus()");await wait(250);const shots=(await state()).shots;await key(' ','Space',32);assert.equal((await state()).shots,shots+1);
  await key('x','KeyX',88);await key('Escape','Escape',27);assert.ok(!await playing());
  const paused=await state();await wait(450);assert.deepEqual(await state(),paused);
  console.log('PASS: launch, real mouse shooting, ammo swap, keyboard shooting and pause freezes simulation');
  await click('#marble-play');await until('window.testState.time>'+paused.time);
  await click('#hub-launch');await until("!document.getElementById('marble-overlay').hidden");const modalPause=await state();await wait(250);assert.deepEqual(await state(),modalPause);
  await click('#library-close');assert.ok(!await playing());await click('#marble-play');
  await evaluate("window.dispatchEvent(new Event('blur'))");assert.ok(!await playing());await wait(250);assert.ok(!await playing());
  await click('#marble-play');await evaluate("window.dispatchEvent(new CustomEvent('aobinglaunch',{detail:'clicker'}))");
  assert.ok(await evaluate("document.getElementById('marble-panel').hidden && !window.keyboardCaptured"));const closed=await state();await wait(250);assert.deepEqual(await state(),closed);
  await evaluate("window.dispatchEvent(new CustomEvent('aobinglaunch',{detail:'marble'}))");assert.ok(!await playing());assert.deepEqual(await state(),closed);
  console.log('PASS: library, blur and game changes pause without automatic resume or hidden simulation');
  await click('#marble-restart');assert.ok(await evaluate("document.getElementById('marble-confirm').open"));await click('#marble-cancel');assert.deepEqual(await state(),closed);
  await click('#marble-restart');await click('#marble-confirm-restart');assert.equal((await state()).score,0);assert.equal((await state()).time,0);
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await click('#marble-play');await wait(600);await shot('desktop',1280,900);
  await shot('mobile',390,844,2);if(!await playing())await click('#marble-play');
  const touchShots=(await state()).shots,p=await point(760,140);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.equal((await state()).shots,touchShots+1);
  await shot('landscape',740,390);
  await evaluate("document.body.dataset.skyPhase='day'");await shot('day',1280,900);
  await evaluate("document.body.dataset.skyPhase='night'");await shot('night',1280,900);
  await evaluate("I18N.set('ar')");await shot('arabic',390,844);await evaluate("I18N.set('en')");
  console.log('PASS: restart confirmation, touch controls, normal/reduced motion and responsive day/night/Arabic layouts');
  // Use deterministic endgame positions while retaining the production renderer,
  // projectile simulation, pointer coordinates, input and outcome handlers.
  if(!await playing())await click('#marble-play');
  await evaluate("Object.assign(testState,{chain:[{id:201,color:0,s:340},{id:202,color:0,s:310},{id:203,color:0,s:280}],score:0,cleared:0,bestCombo:0,combo:0,loaded:0,next:0,projectiles:[],cooldown:0})");
  const target=E.point(E.pathFor(1),310);await mouse(await point(target.x,target.y));await until("testState.outcome==='won'");
  assert.ok(!await playing());assert.equal((await state()).score,400);await shot('won',390,844);
  await click('#marble-play');assert.equal((await state()).level,2);assert.ok(await playing());
  await evaluate("{ const offset=MarbleEngine.pathFor(testState.level).length-15.01-testState.chain[0].s;testState.chain.forEach(m=>m.s+=offset); }");await until("testState.outcome==='lost'");await shot('lost',390,844);await click('#marble-play');assert.equal((await state()).level,2);assert.equal((await state()).score,0);
  await reload();await launch();assert.equal((await state()).level,2);assert.ok(!await playing());
  assert.ok(await evaluate("JSON.parse(localStorage.getItem('aobing-marble-trail-v1')).best>=400"));
  assert.deepEqual(errors,[]);console.log('PASS: projectile-triggered win, next level, exit loss, retry and saved best/level; no browser exceptions');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{ws?.close();child?.kill();server?.close();});
