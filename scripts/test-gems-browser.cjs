// Actual shell, match-three UI and app mode router, with economy/auth omitted.
'use strict';
const fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),E=require('../gems');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'aobing-gems-'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));let server,child,ws;
(async()=>{
  const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
  const router=app.slice(app.indexOf('    // --- Persistent shop launcher'),app.indexOf('    window.__aobingAppReady = true;'));
  assert.ok(router.includes("settings.gameMode === 'gems'"));
  let html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  html=html.replace('</body>', ['i18n.js','sky-time.js','game-shell.js','gems.js','gems-ui.js'].map(src=>'<script src="/'+src+'"></script>').join('')+`<script>
    const settings={sfxVol:0,gameMode:'clicker'},saveSettings=()=>{},shopBtn=document.getElementById('shop-btn');
    let musicModeOn=false,autoTimer=null,musicIdlePeriodMs=0,musicIdleStart=0;
    const currentAutoCps=()=>0,stopAutoCoinFloater=()=>{},rearmAutoLoop=()=>{};
    window.keyboardCaptured=false;
    GemGame.init({settings,captureKeyboard:on=>window.keyboardCaptured=on});
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
  async function launch(){await evaluate("document.getElementById('boot-start')?.click()");await until("!document.getElementById('curtain')");await evaluate("document.getElementById('hub-launch').click();document.querySelector('[data-launch-mode=gems]').click()");await until("!document.getElementById('gems-panel').hidden");}
  await launch();
  assert.ok(await evaluate('window.keyboardCaptured && document.body.classList.contains("music-mode")'));
  assert.equal(await evaluate("document.querySelectorAll('.gems-tile').length"),64);
  await evaluate("document.getElementById('gems-new').click()");
  const saved=()=>evaluate("JSON.parse(localStorage.getItem('aobing-gem-rush-v1')).state");
  const tilePoint=async i=>evaluate(`(()=>{const r=document.querySelector('.gems-tile[data-index="${i}"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const mouse=async(type,p)=>call('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
  const click=async i=>{const p=await tilePoint(i);await mouse('mousePressed',p);await mouse('mouseReleased',p);};
  const idle=()=>until("document.getElementById('gems-board').getAttribute('aria-busy')==='false'");
  async function shot(name,width,height){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await wait(650);
    assert.ok(await evaluate("document.getElementById('gems-panel').scrollWidth <= innerWidth"),name+' horizontal overflow');
    if(name==='landscape')assert.ok(await evaluate("document.getElementById('gems-board').getBoundingClientRect().bottom <= innerHeight-76"),'Landscape board must stay above navigation');
    const image=await call('Page.captureScreenshot',{format:'png'}),file=path.join(os.tmpdir(),'aobing-gems-'+name+'.png');fs.writeFileSync(file,Buffer.from(image.data,'base64'));console.log(file);
  }
  await shot('desktop',1280,900);
  let before=await saved(),pair=E.findMove(before.board);
  const invalid=Array.from({length:63},(_,i)=>[i,i+1]).find(([a,b])=>E.adjacent(a,b)&&!E.move(before,a,b).valid);
  await click(invalid[0]);await click(invalid[1]);await idle();assert.deepEqual(await saved(),before);
  await click(pair[0]);await click(pair[1]);await idle();assert.equal((await saved()).moves,before.moves-1);
  console.log('PASS: real library launch, keyboard ownership and mouse tap-to-swap');
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  before=await saved();pair=E.findMove(before.board);
  await mouse('mousePressed',await tilePoint(pair[0]));await mouse('mouseMoved',await tilePoint(pair[1]));await mouse('mouseReleased',await tilePoint(pair[1]));await idle();
  assert.equal((await saved()).moves,before.moves-1);
  console.log('PASS: drag-to-swap and animated cascade completion');
  before=await saved();pair=E.findMove(before.board);
  await evaluate(`document.querySelector('.gems-tile[data-index="${pair[0]}"]').focus()`);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  const arrow=pair[1]-pair[0]===1?'ArrowRight':'ArrowDown',vk=arrow==='ArrowRight'?39:40;
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:arrow,code:arrow,windowsVirtualKeyCode:vk});await call('Input.dispatchKeyEvent',{type:'keyUp',key:arrow,code:arrow,windowsVirtualKeyCode:vk});
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await idle();
  assert.equal((await saved()).moves,before.moves-1);
  console.log('PASS: keyboard selection and swap');
  await shot('mobile',390,844);
  before=await saved();pair=E.findMove(before.board);
  for(const i of pair){await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...await tilePoint(i),id:1}]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  await idle();assert.equal((await saved()).moves,before.moves-1);
  await evaluate("document.getElementById('gems-hint').click()");assert.equal(await evaluate("document.querySelectorAll('.gems-tile.hint').length"),2);
  before=await saved();await evaluate("document.getElementById('gems-new').click()");assert.ok(await evaluate("document.getElementById('gems-confirm').open"));
  await evaluate("document.getElementById('gems-cancel').click()");assert.deepEqual(await saved(),before);
  console.log('PASS: touch play, hints and restart cancellation');
  pair=E.findMove(before.board);await evaluate(`document.querySelector('.gems-tile[data-index="${pair[0]}"]').click();document.querySelector('.gems-tile[data-index="${pair[1]}"]').click();window.dispatchEvent(new CustomEvent('aobinglaunch',{detail:'clicker'}))`);
  const completed=await saved();assert.equal(completed.moves,before.moves-1);
  assert.ok(await evaluate("document.getElementById('gems-panel').hidden && !window.keyboardCaptured && !document.body.classList.contains('music-mode')"));
  await evaluate("window.dispatchEvent(new CustomEvent('aobinglaunch',{detail:'gems'}))");await idle();assert.deepEqual(await saved(),completed);
  await reload();await launch();assert.deepEqual(await saved(),completed);
  console.log('PASS: switching modes mid-cascade and reloading preserve exactly one complete turn');
  await shot('landscape',740,390);
  await evaluate("document.body.dataset.skyPhase='day'");await shot('day',1280,900);
  await evaluate("document.body.dataset.skyPhase='night'");await shot('night',1280,900);
  await evaluate("I18N.set('ar')");await shot('arabic',390,844);
  await evaluate("I18N.set('en')");
  for(const outcome of ['won','lost']){
    const scenario=E.create(7,outcome==='won'?1:999);scenario.moves=1;if(outcome==='won')scenario.score=scenario.target-1;
    const seedScript=await call('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('aobing-gem-rush-v1',${JSON.stringify(JSON.stringify({state:scenario,best:completed.score}))})`});
    await reload();await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:seedScript.identifier});await launch();
    assert.equal(await evaluate("document.getElementById('gems-moves').textContent"),'1');
    const move=E.findMove(scenario.board);await evaluate(`document.querySelector('.gems-tile[data-index="${move[0]}"]').click();document.querySelector('.gems-tile[data-index="${move[1]}"]').click()`);await idle();
    assert.equal((await saved()).outcome,outcome);assert.ok(await evaluate("!document.getElementById('gems-result').hidden && document.getElementById('gems-board').inert"));
    await shot(outcome,390,844);await evaluate("document.getElementById('gems-continue').click()");assert.equal((await saved()).moves,30);
    assert.equal((await saved()).level,outcome==='won'?2:999);
  }
  assert.deepEqual(errors,[]);console.log('PASS: win/loss screens, next level, retry, responsive layouts and zero browser exceptions');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{ws?.close();child?.kill();server?.close();});
