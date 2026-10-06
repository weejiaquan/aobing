'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function fixture() {
  const window={}, context=vm.createContext({window,document:{},console,Uint8Array,ArrayBuffer});
  vm.runInContext(fs.readFileSync('hitsound.js','utf8'),context);
  const settings={hitsoundUseMap:true,hitsoundVol:100}, played=[];
  window.Hitsound.init({settings,saveSettings(){}});
  const ctx={
    currentTime:0,destination:{},
    async decodeAudioData(bytes){ if(new Uint8Array(bytes)[0]===255) throw Error('broken'); return {id:new Uint8Array(bytes)[0]}; },
    createBufferSource(){return {buffer:null,connect(){return this;},start(){played.push(this.buffer.id);}};},
    createGain(){return {gain:{value:0},connect(){return this;}};},
  };
  return {api:window.Hitsound,settings,ctx,played};
}
test('sample bank decodes before the first hit and layers edge additions with sample sets',async()=>{
  const f=fixture();
  const bank=await f.api.prepare(f.ctx,[{name:'soft-hitnormal2.wav',bytes:new Uint8Array([1])},{name:'drum-hitclap2.ogg',bytes:new Uint8Array([2])}]);
  f.api.playNote(f.ctx,bank,{normalSet:2,additionSet:3,index:2,bits:8,volume:60});
  assert.deepEqual(f.played,[1,2]);
});
test('custom note filename replaces normal sample but preserves additions',async()=>{
  const f=fixture(),bank=await f.api.prepare(f.ctx,[{name:'Hits/CUSTOM.wav',bytes:new Uint8Array([3])},{name:'normal-hitclap.wav',bytes:new Uint8Array([4])}]);
  f.api.playNote(f.ctx,bank,{filename:'hits/custom.wav',normalSet:1,additionSet:1,index:1,bits:8,volume:100});
  assert.deepEqual(f.played,[3,4]);
});
test('zero timing-point sample volume is silent',async()=>{
  const f=fixture(),bank=await f.api.prepare(f.ctx,[{name:'normal-hitnormal.wav',bytes:new Uint8Array([1])}]);
  f.api.playNote(f.ctx,bank,{normalSet:1,index:1,bits:0,volume:0});assert.deepEqual(f.played,[]);
});
test('one corrupt optional sample does not reject the whole prepared bank',async()=>{
  const f=fixture(),bank=await f.api.prepare(f.ctx,[{name:'bad.wav',bytes:new Uint8Array([255])},{name:'good.wav',bytes:new Uint8Array([1])}]);
  assert.equal(bank.has('bad.wav'),false);assert.equal(bank.get('good.wav').id,1);
});
