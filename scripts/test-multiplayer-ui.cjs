// Real-browser lobby layout and join-flow checks, with local auth/socket fixtures.
// No requests are sent to Discord or the production multiplayer service.
'use strict';
const fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aobing-lobby-ui-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, child, ws;
(async () => {
  const markup = fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/<dialog id="multiplayer-dialog"[\s\S]*?<\/dialog>/)[0];
  const fixture = `
    window.wire=[];window.__ACTIVITY__={instanceId:'fixture-activity'};
    window.firebase={auth:()=>({currentUser:{uid:'me',isAnonymous:false,getIdToken:async()=>'fixture'},onAuthStateChanged(){}})};
    window.KEI_BASE=location.origin;
    window.WebSocket=class {
      constructor(){this.readyState=1;this.bufferedAmount=0;window.socket=this;setTimeout(()=>this.onopen(),0);}
      send(raw){const m=JSON.parse(raw);wire.push(m);if(m.type==='auth')setTimeout(()=>this.emit({type:'auth_ok',uid:'me',protocol:2,activity_preview:true}),0);}
      close(){} emit(m){this.onmessage({data:JSON.stringify(m)});}
    };
    window.OsuStdGame={detachMultiplayer(){}};
  `;
  server = http.createServer((req,res) => {
    const name = req.url.split('?')[0];
    if(name === '/api/mp/lobbies') { res.setHeader('Content-Type','application/json');res.end(JSON.stringify({protocol:2,lobbies:[{id:'OPEN01',name:'Afternoon rhythm club',hostName:'Aoba',playerCount:3,cap:8},{id:'LOCK01',name:'Friends only',hostName:'Kei',playerCount:2,cap:8,hasPassword:true}]}));return; }
    if(name === '/') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="utf-8"><link rel="stylesheet" href="/ui-panels.css"><link rel="stylesheet" href="/rhythm-select.css"><style>body{margin:0;background:#dff3fa}button{font-family:inherit}</style><body><section id="osu-panel" class="open"><div id="osu-select"></div></section>'+markup+'<script>'+fixture+'</script><script src="/i18n.js"></script><script src="/multiplayer.js"></script><script>document.querySelector("dialog").showModal();MpUI.open(document.getElementById("mp-panel"));</script>');return;}
    const allowed = {'/ui-panels.css':'text/css','/rhythm-select.css':'text/css','/i18n.js':'text/javascript','/multiplayer.js':'text/javascript','/assets/sky-halos.svg':'image/svg+xml'};
    if(allowed[name]) {res.setHeader('Content-Type',allowed[name]);res.end(fs.readFileSync(path.join(root,name.slice(1))));return;}
    res.writeHead(404);res.end();
  }).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.on('listening',resolve));
  child=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  const active=path.join(profile,'DevToolsActivePort');
  for(let i=0;i<100&&!fs.existsSync(active);i++) await wait(100);
  const port=fs.readFileSync(active,'utf8').split('\n')[0];
  const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent('http://127.0.0.1:'+server.address().port),{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
  let seq=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  for(let i=0;i<100;i++){if(await evaluate('!!document.querySelector(".mp-activity-card")'))break;await wait(50);}
  async function screenshot(label,width,height){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await wait(350);
    const fits=await evaluate(`(()=>{const d=document.querySelector('dialog');return d.scrollWidth<=d.clientWidth+1&&d.getBoundingClientRect().right<=innerWidth&&d.getBoundingClientRect().bottom<=innerHeight;})()`);
    if(!fits)throw Error('Layout overflow: '+label);
    const shot=await call('Page.captureScreenshot',{format:'png'});const file=path.join(os.tmpdir(),'aobing-lobby-'+label+'.png');fs.writeFileSync(file,Buffer.from(shot.data,'base64'));console.log(file);
  }
  await evaluate(`socket.emit({type:'activity_lobby',lobby:{id:'ACT123',phase:'idle',cap:8,members:[{name:'Aoba',photo:null,state:'idle'},{name:'Kei',photo:'javascript:alert(1)',state:'ready'}]}})`);
  console.log(await evaluate(`(()=>{const entry=document.getElementById('mp-presence-entry');if(!entry.textContent.includes('2 in lobby')||entry.querySelectorAll('.mp-avatar').length!==2||entry.querySelector('img'))throw Error('Pre-join roster or avatar fallback failed');return 'PASS: pre-join lobby avatars and member count, unsafe photo falls back';})()`));
  await evaluate(`socket.emit({type:'activity_lobby',lobby:{id:'ACT123',phase:'racing',cap:8,members:[{name:'Aoba',state:'playing'}]}})`);
  console.log(await evaluate(`(()=>{const entry=document.getElementById('mp-presence-entry');if(!entry.textContent.includes('1 in lobby')||!entry.querySelector('button').disabled)throw Error('Live roster or in-progress state failed');return 'PASS: roster changes live and racing room cannot be joined';})()`));
  await evaluate(`socket.emit({type:'activity_lobby',lobby:null})`);
  await screenshot('activity-desktop',1280,800);
  await screenshot('activity-mobile',375,740);
  await screenshot('activity-landscape',740,360);
  console.log(await evaluate(`(()=>{
    const check=(v,m)=>{if(!v)throw Error(m);};
    check(!document.querySelector('details').open,'Activity alternatives should start collapsed');
    check(!document.querySelector('#mp-create-form input').checkVisibility(),'Activity inputs must be hidden');
    document.querySelector('.mp-activity-card button').click();
    return 'PASS: Activity entry is visible without credential fields';
  })()`));
  await wait(20);
  console.log(await evaluate(`(()=>{const m=wire.find(m=>m.type==='join_activity');if(JSON.stringify(m)!==JSON.stringify({type:'join_activity',instance_id:'fixture-activity'}))throw Error('Activity join included credentials');return 'PASS: Activity click sends only instance ID';})()`));
  await evaluate(`document.querySelector('details').open=true;document.body.dataset.skyPhase='night'`);
  await screenshot('options-night',1280,960);
  await evaluate(`window.__ACTIVITY__=null;MpUI.open(document.getElementById('mp-panel'))`);await wait(100);
  await screenshot('web-mobile',375,740);
  console.log(await evaluate(`(async()=>{
    const check=(v,m)=>{if(!v)throw Error(m);};
    const pause=()=>new Promise(r=>setTimeout(r,10));
    check(!document.querySelector('.mp-activity-card'),'Web should not show Activity shortcut');
    document.querySelector('#mp-create-form input[type=password]').value='create-secret';
    document.querySelectorAll('.mp-lobby-row button')[0].click();await pause();
    check(wire.at(-1).password==='','Public join leaked create password');
    document.querySelectorAll('.mp-lobby-row button')[1].click();await pause();
    check(document.querySelector('#mp-room-code').value==='LOCK01','Locked room did not populate code');
    check(document.activeElement===document.querySelector('#mp-join-form input[type=password]'),'Locked room did not focus password');
    document.activeElement.value='join-secret';document.querySelector('#mp-join-form').requestSubmit();
    check(wire.at(-1).id==='LOCK01'&&wire.at(-1).password==='join-secret','Wrong join credentials');
    document.querySelector('#mp-create-form').requestSubmit();
    check(wire.at(-1).type==='create_lobby'&&wire.at(-1).password==='create-secret','Create credentials changed');
    return 'PASS: public, locked and create flows keep passwords separate';
  })()`));
  await evaluate(`socket.emit({type:'lobby_state',lobby:{id:'ABCD12',name:'Aoba’s afternoon lobby',host_uid:'me',phase:'waiting',current_map:null,members:{me:{name:'Aoba',state:'idle'},kei:{name:'Kei',state:'ready'}}}})`);
  await screenshot('room-mobile',375,740);
  await screenshot('room-desktop',1280,800);
  await evaluate(`I18N.set('ar');document.documentElement.dir='rtl'`);
  await screenshot('room-arabic',375,740);
  await evaluate(`MpUI.close();MpUI.open(document.getElementById('mp-panel'))`);await wait(100);
  await screenshot('web-arabic',375,740);
  console.log('PASS: desktop, mobile, short landscape, night and Arabic layouts fit the viewport');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{ws?.close();child?.kill();server?.close();});
