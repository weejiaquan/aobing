// Actual shell, Merge Drift and Sky Snake UIs and app mode router, with economy/auth omitted.
'use strict';
const fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),D=require('../drift'),S=require('../snake');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'aobing-drift-snake-'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));let server,child,ws;
const DRIFT_KEY='aobing-merge-drift-v1',SNAKE_KEY='aobing-sky-snake-v1';
const VK={ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Escape:27,w:87};
// Builds a restorable Merge Drift state from a 4×4 grid of values (0 = empty).
function driftBoard(rows,extra={}){
  const s={version:1,seed:4242,nextId:1,board:[],score:0,moves:3,reached:false,outcome:'playing',...extra};
  for(const value of rows.flat())s.board.push(value?{id:s.nextId++,value}:null);
  assert.ok(D.restore(s),'fixture board must be restorable');return s;
}
(async()=>{
  const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
  const router=app.slice(app.indexOf('    // --- Persistent shop launcher'),app.indexOf('    window.__aobingAppReady = true;'));
  assert.ok(router.includes("settings.gameMode === 'drift'")&&router.includes("settings.gameMode === 'snake'"),'router must open both games');
  let html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  html=html.replace('</body>', ['i18n.js','sky-time.js','game-shell.js','drift.js','drift-ui.js','snake.js','snake-ui.js'].map(src=>'<script src="/'+src+'"></script>').join('')+`<script>
    const settings={sfxVol:0,gameMode:'clicker'},saveSettings=()=>{},shopBtn=document.getElementById('shop-btn');
    let musicModeOn=false,autoTimer=null,musicIdlePeriodMs=0,musicIdleStart=0;
    const currentAutoCps=()=>0,stopAutoCoinFloater=()=>{},rearmAutoLoop=()=>{};
    window.keyboardCaptured=false;
    const createSnake=SnakeEngine.create;SnakeEngine.create=(...args)=>window.snakeState=createSnake(...args);
    DriftGame.init({settings,captureKeyboard:on=>window.keyboardCaptured=on});
    SnakeGame.init({settings,captureKeyboard:on=>window.keyboardCaptured=on});
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
  async function until(expression,tries=150){for(let i=0;i<tries;i++){if(await evaluate(expression))return;await wait(100);}throw Error('Timed out: '+expression+' '+JSON.stringify(errors));}
  async function reload(){await evaluate('window.fixtureReady=false');await call('Page.reload');await until('window.fixtureReady');}
  async function seedStorage(key,value){
    const script=await call('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(value))})`});
    await reload();await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:script.identifier});
  }
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  async function key(name){const params={key:name,code:name.length===1?'Key'+name.toUpperCase():name,windowsVirtualKeyCode:VK[name]};await call('Input.dispatchKeyEvent',{type:'keyDown',...params});await call('Input.dispatchKeyEvent',{type:'keyUp',...params});}
  async function center(selector){return evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width};})()`);}
  async function mouseDrag(selector,dx,dy){const p=await center(selector);
    await call('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+dx/2,y:p.y+dy/2,button:'left',buttons:1});
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+dx,y:p.y+dy,button:'left',buttons:1});
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x+dx,y:p.y+dy,button:'left',clickCount:1});}
  async function touchDrag(selector,dx,dy){const p=await center(selector);
    await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y,id:1}]});
    await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x+dx/2,y:p.y+dy/2,id:1}]});
    await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x+dx,y:p.y+dy,id:1}]});
    await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  async function launch(mode){await evaluate("document.getElementById('boot-start')?.click()");await until("!document.getElementById('curtain')");await evaluate(`document.getElementById('hub-launch').click();document.querySelector('[data-launch-mode=${mode}]').click()`);await until(`!document.getElementById('${mode}-panel').hidden`);}
  async function shot(game,name,width,height,board){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await wait(650);
    assert.ok(await evaluate(`document.getElementById('${game}-panel').scrollWidth<=innerWidth`),game+' '+name+' horizontal overflow');
    if(name==='landscape')assert.ok(await evaluate(`document.getElementById('${board}').getBoundingClientRect().bottom<=innerHeight-76`),game+' landscape board covered by navigation');
    const image=await call('Page.captureScreenshot',{format:'png'}),file=path.join(os.tmpdir(),'aobing-'+game+'-'+name+'.png');fs.writeFileSync(file,Buffer.from(image.data,'base64'));console.log(file);
  }
  await call('Runtime.enable');await call('Page.enable');
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await call('Page.navigate',{url});await until('window.fixtureReady');

  // ---------- Merge Drift ----------
  const drift=()=>evaluate(`JSON.parse(localStorage.getItem('${DRIFT_KEY}')).state`);
  await seedStorage(DRIFT_KEY,{state:driftBoard([[2,2,0,0],[0,4,0,0],[0,0,0,0],[0,0,0,4]]),best:0});
  await launch('drift');
  assert.ok(await evaluate("window.keyboardCaptured && document.body.classList.contains('music-mode') && document.activeElement.id==='drift-board'"),'drift owns keyboard and focuses its board');
  assert.equal(await evaluate("document.querySelectorAll('.drift-tile').length"),4);assert.equal(await evaluate("document.querySelectorAll('.drift-grid span').length"),16);
  let before=await drift();await key('ArrowLeft');
  assert.deepEqual(await drift(),D.move(before,'left').state,'arrow key applies exactly one engine move');
  assert.equal(await evaluate("document.getElementById('drift-score').textContent"),'4');
  assert.match(await evaluate("document.getElementById('drift-status').textContent"),/Merged up to 4 · \+4/);
  assert.equal(await evaluate("document.querySelectorAll('.drift-tile').length"),(await drift()).board.filter(Boolean).length,'one DOM tile per board tile');
  before=await drift();await key('w');assert.deepEqual(await drift(),D.move(before,'up').state,'WASD works');
  console.log('PASS: drift library launch, keyboard ownership, arrow/WASD moves match the engine and render');
  await seedStorage(DRIFT_KEY,{state:driftBoard([[2,4,8,16],[0,0,0,0],[0,0,0,0],[0,0,0,0]]),best:50});
  await launch('drift');before=await drift();await key('ArrowLeft');await key('ArrowUp');
  assert.deepEqual(await drift(),before,'blocked moves do not change or spend anything');
  assert.match(await evaluate("document.getElementById('drift-status').textContent"),/Nothing can slide/);
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await mouseDrag('#drift-board',0,160);assert.deepEqual(await drift(),D.move(before,'down').state,'mouse drag down');
  before=await drift();await mouseDrag('#drift-board',8,0);assert.deepEqual(await drift(),before,'tiny drags are ignored');
  await touchDrag('#drift-board',-160,0);assert.deepEqual(await drift(),D.move(before,'left').state,'touch swipe left');
  await wait(400);assert.equal(await evaluate("document.querySelectorAll('.drift-tile').length"),(await drift()).board.filter(Boolean).length,'animated move settles to one node per tile');
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  console.log('PASS: drift blocked moves, animated mouse drag and touch swipe');
  before=await drift();await click('#drift-new');assert.ok(await evaluate("document.getElementById('drift-confirm').open"));
  await key('ArrowRight');assert.deepEqual(await drift(),before,'keys are ignored while the confirm dialog is open');
  await click('#drift-cancel');assert.deepEqual(await drift(),before);
  await evaluate("window.dispatchEvent(new CustomEvent('aobinglaunch',{detail:'clicker'}))");
  assert.ok(await evaluate("document.getElementById('drift-panel').hidden && !window.keyboardCaptured && !document.body.classList.contains('music-mode')"),'leaving releases keyboard and music mode');
  await key('ArrowRight');assert.deepEqual(await drift(),before,'keys do nothing while drift is closed');
  await reload();await launch('drift');assert.deepEqual(await drift(),before,'reload restores the saved board');
  await click('#drift-new');await click('#drift-restart');const fresh=await drift();
  assert.equal(fresh.moves,0);assert.equal(fresh.board.filter(Boolean).length,2);
  assert.ok(await evaluate(`JSON.parse(localStorage.getItem('${DRIFT_KEY}')).best>=50`),'best score survives a new game');
  console.log('PASS: drift restart confirmation, mode switching and saved progress');
  await shot('drift','desktop',1280,900);await shot('drift','mobile',390,844);await shot('drift','landscape',740,390,'drift-board');
  await evaluate("document.body.dataset.skyPhase='night'");await shot('drift','night',1280,900);
  await evaluate("I18N.set('ar')");await shot('drift','arabic',390,844);await evaluate("I18N.set('en')");
  await seedStorage(DRIFT_KEY,{state:driftBoard([[1024,1024,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]),best:0});
  await launch('drift');await key('ArrowLeft');
  assert.equal((await drift()).outcome,'won');assert.ok(await evaluate("!document.getElementById('drift-result').hidden && !document.getElementById('drift-again').hidden"));
  assert.equal(await evaluate("document.getElementById('drift-result-title').textContent"),'You built 2048!');
  await shot('drift','won',390,844);
  await click('#drift-continue');assert.equal((await drift()).outcome,'playing');assert.equal((await drift()).reached,true);
  assert.ok(await evaluate("document.getElementById('drift-result').hidden"));
  await seedStorage(DRIFT_KEY,{state:driftBoard([[2,4,2,4],[4,2,4,2],[8,4,2,4],[8,16,32,0]]),best:0});
  await launch('drift');await key('ArrowRight');
  assert.equal((await drift()).outcome,'lost');assert.ok(await evaluate("!document.getElementById('drift-result').hidden && document.getElementById('drift-again').hidden"));
  assert.equal(await evaluate("document.getElementById('drift-result-title').textContent"),'No moves left');
  await shot('drift','lost',390,844);await click('#drift-continue');
  assert.equal((await drift()).moves,0);assert.equal((await drift()).outcome,'playing');
  console.log('PASS: drift 2048 win, keep going, loss, retry and responsive day/night/Arabic layouts');

  // ---------- Sky Snake ----------
  await seedStorage(SNAKE_KEY,{version:1,best:30});
  await launch('snake');
  const snake=()=>evaluate('window.snakeState');
  const playing=()=>evaluate("document.getElementById('snake-overlay').hidden");
  assert.ok(await evaluate("window.keyboardCaptured && document.body.classList.contains('music-mode')"));
  assert.ok(!await playing(),'a round never starts without activation');
  assert.equal(await evaluate("document.getElementById('snake-best').textContent"),'30');
  let frozen=await snake();await wait(400);assert.deepEqual(await snake(),frozen,'ready state does not simulate');
  await click('#snake-play');assert.ok(await playing());
  await until('window.snakeState.snake[0].x>9');
  await key('ArrowUp');await until("window.snakeState.direction==='up'");
  await touchDrag('#snake-canvas',-120,0);await until("window.snakeState.direction==='left'");
  await mouseDrag('#snake-canvas',0,-120);await until("window.snakeState.direction==='up'");
  console.log('PASS: snake waits for Start, then steers by keyboard, touch swipe and mouse drag');
  await key('Escape');assert.ok(!await playing());assert.equal(await evaluate("document.getElementById('snake-overlay-title').textContent"),'Paused');
  frozen=await snake();await wait(400);assert.deepEqual(await snake(),frozen,'paused state does not simulate');
  await click('#snake-play');assert.ok(await playing());
  await click('#hub-launch');await until("!document.getElementById('snake-overlay').hidden");frozen=await snake();await wait(400);assert.deepEqual(await snake(),frozen,'opening the library pauses');
  await click('#library-close');assert.ok(!await playing(),'closing a modal does not auto-resume');
  await evaluate("window.dispatchEvent(new CustomEvent('aobinglaunch',{detail:'clicker'}))");
  assert.ok(await evaluate("document.getElementById('snake-panel').hidden && !window.keyboardCaptured"));
  await evaluate("window.dispatchEvent(new CustomEvent('aobinglaunch',{detail:'snake'}))");assert.ok(!await playing());assert.deepEqual(await snake(),frozen,'returning keeps the paused round');
  await click('#snake-restart');assert.ok(await evaluate("document.getElementById('snake-confirm').open"));await click('#snake-cancel');assert.deepEqual(await snake(),frozen);
  await click('#snake-restart');await click('#snake-confirm-restart');assert.equal((await snake()).score,0);assert.equal((await snake()).snake.length,3);
  console.log('PASS: snake pause, modal pause without auto-resume, mode switching and restart confirmation');
  await click('#snake-play');
  await evaluate("{const h=snakeState.snake[0];snakeState.queue=[];snakeState.food={x:h.x+2,y:h.y};}");
  await until('window.snakeState.eaten===1');assert.equal((await snake()).score,10);assert.equal((await snake()).snake.length,4);
  await until("document.getElementById('snake-score').textContent==='10' && document.getElementById('snake-length').textContent==='4'");
  await shot('snake','desktop',1280,900);await shot('snake','mobile',390,844);await shot('snake','landscape',740,390,'snake-canvas');
  if(!await playing())await click('#snake-play');
  await evaluate("Object.assign(snakeState,{snake:[{x:16,y:4},{x:15,y:4},{x:14,y:4}],direction:'right',queue:[],food:{x:0,y:0}})");
  await until("window.snakeState.outcome==='lost'");assert.ok(!await playing());
  assert.equal(await evaluate("document.getElementById('snake-overlay-title').textContent"),'Bumped into the wall');
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('${SNAKE_KEY}')).best`),30,'lower score keeps saved best');
  await shot('snake','lost',390,844);
  await click('#snake-play');assert.ok(await playing());assert.equal((await snake()).score,0,'retry starts a fresh round');
  await evaluate(`{const path=${JSON.stringify((()=>{const p=[];for(let y=S.ROWS-1;y>=0;y--){const row=[];for(let x=0;x<S.COLS;x++)row.push({x,y});if((S.ROWS-1-y)%2===0)row.reverse();p.push(...row);}return p;})())};
    Object.assign(snakeState,{snake:path.slice(1),food:path[0],direction:'right',queue:[],eaten:40,score:400});}`);
  await until("window.snakeState.outcome==='won'");assert.equal(await evaluate("document.getElementById('snake-overlay-title').textContent"),'The whole sky is yours!');
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('${SNAKE_KEY}')).best`),460,'new best is saved');
  await evaluate("document.body.dataset.skyPhase='day'");await shot('snake','won',390,844);
  await evaluate("I18N.set('ar')");await shot('snake','arabic',390,844);await evaluate("I18N.set('en')");
  await reload();await launch('snake');assert.equal(await evaluate("document.getElementById('snake-best').textContent"),'460');assert.ok(!await playing());
  assert.deepEqual(errors,[]);console.log('PASS: snake eating, wall loss, retry, full-board win, saved best and responsive layouts; no browser exceptions');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{ws?.close();child?.kill();server?.close();});
