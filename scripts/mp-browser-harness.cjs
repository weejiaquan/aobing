'use strict';
// DOM/audio stubs exercise the production browser controller without claiming visual QA.
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
exports.createClient=function(base,uid,initial=[],activity=null,options={}){
  class Element {
    constructor(tag='div'){this.tagName=tag;this.children=[];this.style={};this.open=false;this.value='';this.listeners={};this.textContent='';}
    appendChild(n){this.children.push(n);n.parent=this;return n;}
    replaceChildren(...nodes){this.children=[];nodes.forEach(n=>this.appendChild(n));}
    setAttribute(){} addEventListener(k,f){this.listeners[k]=f;}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
    querySelector(sel){return this.all().find(n=>sel[0]==='#' ? n.id===sel.slice(1) : n.tagName===sel)||null;}
    all(){return this.children.flatMap(n=>[n,...n.all()]);}
    close(){this.open=false;}showModal(){this.open=true;}
  }
  const body=new Element('body'),dialog=new Element('dialog'),panel=new Element();dialog.id='multiplayer-dialog';panel.id='mp-panel';body.appendChild(dialog);dialog.appendChild(panel);dialog.open=true;
  const document={body,hidden:false,createElement:tag=>new Element(tag),getElementById:id=>body.querySelector('#'+id)};
  const records=new Map(initial.map(r=>[r.hash,r])),launched=[];
  const game={getChartRecord:async hash=>records.get(hash),listCharts:async()=>[...records.values()].map(({audio,osuText,samples,art,...m})=>m),
    async importForeignCharts(rows){rows.forEach(r=>records.set(r.hash,r));return rows.length;},
    prepareMultiplayer:async hash=>({hash}),startMultiplayer:(prepared,opts)=>launched.push({prepared,opts}),detachMultiplayer(){}};
  const user={uid,isAnonymous:false,getIdToken:async()=> 'local-test:'+uid};
  const window={OsuStdEngine:require(path.join(root,'osustd')),OsuStdGame:game,__ACTIVITY__:activity,listeners:{},addEventListener(k,f){this.listeners[k]=f;}};
  const wire=[];
  class ObservedSocket extends WebSocket {send(data){wire.push(JSON.parse(data));super.send(data);}}
  const timeout=(fn,ms)=>setTimeout(fn,options.fastWatchdogs && [20000,30000].includes(ms) ? 200 : ms);
  const context=vm.createContext({window,document,console,KEI_BASE:base,WebSocket:ObservedSocket,fetch,AbortController,performance,crypto:globalThis.crypto,TextEncoder,TextDecoder,Uint8Array,btoa,atob,setTimeout:timeout,clearTimeout,setInterval,clearInterval,
    RTCPeerConnection:options.RTCPeerConnection || class {constructor(){throw Error('RTC unavailable in fixture');}},
    I18N:require(path.join(root,'i18n')),firebase:{auth:()=>({currentUser:user,onAuthStateChanged:fn=>fn(user)})}});
  const source=fs.readFileSync(path.join(root,'multiplayer.js'),'utf8').replace('  window.MpUI =','  window.__mpState = getState;\n  window.MpUI =');
  vm.runInContext(source,context,{filename:'multiplayer.js'});
  const tick=()=>new Promise(r=>setTimeout(r,10));
  async function waitFor(fn,timeout=6000){const end=Date.now()+timeout;while(Date.now()<end){if(fn())return;await tick();}throw Error('Client '+uid+' timed out: '+JSON.stringify(window.__mpState()));}
  return {window,records,panel,dialog,launched,wire,waitFor,state:()=>window.__mpState(),
    open:()=>window.MpUI.open(panel),close:()=>window.MpUI.close(),
    async click(label){await waitFor(()=>panel.all().find(n=>n.tagName==='button'&&n.textContent===label&&!n.disabled));await panel.all().find(n=>n.tagName==='button'&&n.textContent===label&&!n.disabled).onclick();},
    async create(){await waitFor(()=>panel.querySelector('form'));panel.querySelector('form').onsubmit({preventDefault(){}});await waitFor(()=>window.__mpState().lobby);},
    async join(id){await waitFor(()=>panel.all().find(n=>n.tagName==='input'));const inputs=panel.all().filter(n=>n.tagName==='input');inputs.at(-1).value=id;await this.click('Join');await waitFor(()=>window.__mpState().lobby);}
  };
};
