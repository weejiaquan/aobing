'use strict';
// Run: node scripts/test-multiplayer-integration.cjs [path/to/kei-bot]
// Starts a loopback-only, fake-auth fixture; never contacts Firebase or Discord.
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createClient}=require('./mp-browser-harness.cjs');
const M=require('../multiplayer');
const backend=path.resolve(process.argv[2]||path.join(__dirname,'../../kei-bot'));
const python=process.env.MP_TEST_PYTHON||path.join(backend,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
let base, server, logs='';
if(!fs.existsSync(python))throw Error('Set MP_TEST_PYTHON to the backend Python interpreter');
const clients=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  try{
    const probe=require('node:net').createServer();
    await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
    const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));base='http://127.0.0.1:'+port;
    server=spawn(python,[path.join(backend,'tests/mp_fixture_server.py'),String(port)],{cwd:backend,stdio:['ignore','pipe','pipe'],windowsHide:true});
    server.stderr.on('data',d=>logs+=d);
    let up=false;
    for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Fixture server failed: '+logs);try{if((await fetch(base+'/api/mp/lobbies')).ok){up=true;break;}}catch{}await wait(50);}
    if(!up)throw Error('Fixture server startup timed out: '+logs);
    const osuText='osu file format v14\n[General]\nMode:0\n[Metadata]\nTitle:Integration\nArtist:Fixture\nVersion:Easy\n[HitObjects]\n256,192,1000,1,0';
    const rec={hash:await M.digest(osuText),osuText,audio:new Uint8Array(50000).fill(12),samples:[{name:'hit.wav',bytes:new Uint8Array([1,2,3])}],title:'Integration',artist:'Fixture',diffName:'Easy',length:1000,stars:1};
    const host=createClient(base,'host',[rec]),guest=createClient(base,'guest');clients.push(host,guest);
    host.open();guest.open();await host.create();await guest.join(host.state().lobby.id);
    await host.waitFor(()=>Object.keys(host.state().lobby.members).length===2);
    await host.click('Pick map');await host.click('Integration — Easy');
    await guest.waitFor(()=>guest.records.has(rec.hash));
    assert.deepEqual([...guest.records.get(rec.hash).audio],[...rec.audio]);
    assert.equal(guest.records.get(rec.hash).samples[0].name,'hit.wav');
    console.log('PASS: production controller creates/joins, relay fallback verifies and imports chart + samples');
    await host.click('Ready');await guest.click('Ready');
    await host.click('Start round');await guest.waitFor(()=>guest.launched.length===1);await host.waitFor(()=>host.launched.length===1);
    assert.ok(Math.abs(host.launched[0].opts.startAt-guest.launched[0].opts.startAt)<150);
    const room=host.state().lobby;
    await wait(Math.max(0,room.start_at_epoch_ms-Date.now()+150));
    host.launched[0].opts.onScore({score:300,combo:1,acc:100,state:'finished'});
    guest.launched[0].opts.onScore({score:100,combo:1,acc:33.33,state:'finished'});
    await host.waitFor(()=>host.state().lobby.phase==='results');
    assert.equal(host.state().lobby.members.host.score,300);assert.equal(host.state().lobby.members.guest.score,100);
    console.log('PASS: ready gate, synchronized countdown, gameplay callbacks and final results over real WebSockets');
    host.dialog.showModal();guest.dialog.showModal();host.open();guest.open();
    await host.click('Ready');await guest.click('Ready');
    await guest.waitFor(()=>guest.state().lobby.members.guest.state==='ready');
    host.close();await guest.waitFor(()=>guest.state().lobby.host_uid==='guest');
    await guest.click('Start round');await guest.waitFor(()=>guest.launched.length===2);
    assert.notEqual(guest.state().lobby.round_id,room.round_id);
    guest.launched[0].opts.onScore({score:999999,combo:1,acc:100,state:'finished'});
    await wait(50);assert.equal(guest.state().lobby.members.guest.score,0);
    guest.launched[1].opts.onScore({score:0,combo:0,acc:0,state:'forfeit'});
    await guest.waitFor(()=>guest.state().lobby.phase==='results');
    console.log('PASS: repeat round retains prepared audio after host promotion; stale score callbacks are ignored');
    guest.close();
    for(const [label,config] of [['P2P',{}],['interrupted P2P',{dropAfter:2}],['stalled P2P',{stall:true}]]) {
      const net=require('./mp-peer-fixture.cjs').peerNetwork(config);
      const options={RTCPeerConnection:net.PC,fastWatchdogs:true};
      const ph=createClient(base,'peer-host-'+label,[rec],null,options),pg=createClient(base,'peer-guest-'+label,[],null,options);clients.push(ph,pg);
      ph.open();pg.open();await ph.create();await pg.join(ph.state().lobby.id);
      await ph.click('Pick map');await ph.click('Integration — Easy');
      await pg.waitFor(()=>pg.records.has(rec.hash));
      assert.ok(net.frames>0);
      const relayFrames=ph.wire.filter(m=>m.type==='relay'&&m.body.t==='chunk').length;
      if(label==='P2P')assert.equal(relayFrames,0);else assert.ok(relayFrames>0);
      assert.equal(await M.contentDigest(M.encodeChartTransfer(pg.records.get(rec.hash))),await M.contentDigest(M.encodeChartTransfer(rec)));
      ph.close();pg.close();assert.equal(net.livePeers,0);
      console.log('PASS: '+label+' controller path, verified payload and peer cleanup');
    }
    {
      const rh=createClient(base,'retry-host',[rec]),rg=createClient(base,'retry-guest');clients.push(rh,rg);
      const read=rh.window.OsuStdGame.getChartRecord;let reads=0;
      rh.window.OsuStdGame.getChartRecord=async hash=>{if(++reads===3)throw Error('temporary read failure');return read(hash);};
      rh.open();rg.open();await rh.create();await rg.join(rh.state().lobby.id);
      await rh.click('Pick map');await rh.click('Integration — Easy');
      await rg.waitFor(()=>rg.state().lobby.members['retry-guest'].state==='spectator');
      await rg.click('Retry');await rg.waitFor(()=>rg.records.has(rec.hash));assert.ok(reads>=4);
      rh.close();rg.close();console.log('PASS: transient host storage failure can be retried without changing maps or reconnecting');
    }
    {
      const sh=createClient(base,'save-host',[rec]),sg=createClient(base,'save-guest',[],null,{fastWatchdogs:true});clients.push(sh,sg);
      const save=sg.window.OsuStdGame.importForeignCharts;
      sg.window.OsuStdGame.importForeignCharts=()=>new Promise(()=>{});
      sh.open();sg.open();await sh.create();await sg.join(sh.state().lobby.id);
      await sh.click('Pick map');await sh.click('Integration — Easy');
      await sg.waitFor(()=>sg.state().lobby.members['save-guest'].state==='spectator');
      sg.window.OsuStdGame.importForeignCharts=save;
      await sg.click('Retry');await sg.waitFor(()=>sg.records.has(rec.hash));
      sh.close();sg.close();console.log('PASS: a stalled receiver save expires and can be retried without wedging the lobby');
    }
    {
      const textB=osuText.replace('Title:Integration','Title:Integration B');
      const recB={...rec,hash:await M.digest(textB),osuText:textB,title:'Integration B'};
      const mh=createClient(base,'map-host',[rec,recB]),mg=createClient(base,'map-guest',[{...rec,audio:new Uint8Array([42])}]);clients.push(mh,mg);
      const digest=mg.window.MpEngine.contentDigest;let release,entered=false;
      const gate=new Promise(resolve=>release=resolve);
      mg.window.MpEngine.contentDigest=async encoded=>{if(!entered){entered=true;await gate;}return digest(encoded);};
      mh.open();mg.open();await mh.create();await mg.join(mh.state().lobby.id);
      await mh.click('Pick map');await mh.click('Integration — Easy');await mg.waitFor(()=>entered);
      await mh.click('Pick map');await mh.click('Integration B — Easy');await mg.waitFor(()=>mg.records.has(recB.hash));
      release();await wait(50);mg.open();await mg.click('Ready');
      await mg.waitFor(()=>mg.state().lobby.members['map-guest'].state==='ready');
      mh.close();mg.close();console.log('PASS: stale map checks cannot overwrite readiness for a newer verified chart');
    }
    const full=Array.from({length:8},(_,i)=>createClient(base,'full-'+i,i===0?[rec]:[]));clients.push(...full);
    full.forEach(c=>c.open());await full[0].create();
    await Promise.all(full.slice(1).map(c=>c.join(full[0].state().lobby.id)));
    await full[0].waitFor(()=>Object.keys(full[0].state().lobby.members).length===8);
    await full[0].click('Pick map');await full[0].click('Integration — Easy');
    await Promise.all(full.map(c=>c.waitFor(()=>c.records.has(rec.hash),10000)));
    await Promise.all(full.map(c=>c.click('Ready')));await full[0].click('Start round');
    await Promise.all(full.map(c=>c.waitFor(()=>c.launched.length===1)));
    const fullRoom=full[0].state().lobby;
    await wait(Math.max(0,fullRoom.start_at_epoch_ms-Date.now()+150));
    full.forEach((c,i)=>c.launched[0].opts.onScore({score:300-i,combo:1,acc:99,state:'finished'}));
    await full[0].waitFor(()=>full[0].state().lobby.phase==='results');
    assert.equal(Object.keys(full[0].state().lobby.members).length,8);
    full.forEach(c=>c.close());
    console.log('PASS: eight-player concurrent chart relay, preparation and completed round');
    const a=createClient(base,'activity-a',[],{instanceId:'test-instance-123'}),b=createClient(base,'activity-b',[],{instanceId:'test-instance-123'});clients.push(a,b);
    a.open();b.open();await a.click('Play with this Activity');await b.click('Play with this Activity');
    await a.waitFor(()=>a.state().lobby&&Object.keys(a.state().lobby.members).length===2);
    assert.equal(a.state().lobby.id,b.state().lobby.id);
    assert.equal((await (await fetch(base+'/api/mp/lobbies')).json()).lobbies.length,0);
    console.log('PASS: Discord Activity clients join one unlisted instance lobby');
    const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;
    await Promise.all([a.waitFor(()=>a.state().status==='offline'),b.waitFor(()=>b.state().status==='offline')]);
    server=spawn(python,[path.join(backend,'tests/mp_fixture_server.py'),String(port)],{cwd:backend,stdio:['ignore','pipe','pipe'],windowsHide:true});
    server.stderr.on('data',d=>logs+=d);
    up=false;
    for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Restart failed: '+logs);try{if((await fetch(base+'/api/mp/lobbies')).ok){up=true;break;}}catch{}await wait(50);}
    if(!up)throw Error('Restart did not become healthy');
    assert.equal((await (await fetch(base+'/api/mp/lobbies')).json()).lobbies.length,0);
    await a.click('Retry');await b.click('Retry');
    await a.click('Play with this Activity');await b.click('Play with this Activity');
    await a.waitFor(()=>a.state().lobby&&Object.keys(a.state().lobby.members).length===2);
    assert.equal(a.state().lobby.current_map,null);
    console.log('PASS: service restart clears transient rooms; both clients detect loss and Retry into a new Activity room');
  } finally {clients.forEach(c=>c.close());if(server){server.kill();await Promise.race([new Promise(r=>server.once('exit',r)),wait(2000)]);}}
})().catch(e=>{console.error(e);if(logs)console.error(logs);process.exitCode=1;});
