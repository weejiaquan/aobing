/* Animated waterfront renderer. Session state drives every gameplay animation. */
(function () {
  'use strict';
  function create(canvas, variant) {
    var ctx = canvas.getContext('2d'), time = 0, W = 0, H = 0, theme = 0;
    var idle = new Image(), active = new Image();
    idle.src = variant.idle; active.src = variant.active || variant.idle;
    var shore = new Image(); shore.src = 'assets/fishing-shore.svg';
    var clouds = new Image(); clouds.src = 'assets/sky-clouds.svg';
    var particles = [], lastPhase = '', fishCache = {}, lastFloat=null, landingFrom=null;
    function lerp(a, b, p) { return a + (b - a) * p; }
    function color(a, b) { return 'rgb(' + a.map(function (v, i) { return Math.round(lerp(v, b[i], theme)); }).join(',') + ')'; }
    function path(points, fill) {
      ctx.beginPath(); points.forEach(function (p, i) { if (!i) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    }
    function ellipse(x, y, rx, ry, fill) {
      ctx.beginPath(); ctx.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
    }
    function fish(x, y, size, fill, flip) {
      ctx.save(); ctx.translate(x, y); ctx.scale(flip ? -1 : 1, 1);
      ellipse(0, 0, size, size * .4, fill);
      path([[-size*.7,0],[-size*1.45,-size*.55],[-size*1.45,size*.55]], fill);
      ctx.restore();
    }
    function splash(x, y, count) {
      for (var i = 0; i < count; i++) {
        var a = i / count * Math.PI * 2;
        particles.push({ x:x, y:y, vx:Math.cos(a)*(28+i%5*15), vy:-40-i%7*16, life:.55+i%4*.12, age:0 });
      }
    }
    function render(s, dt, reduced) {
      time += dt;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      if (!W || !H) return;
      if (canvas.width !== Math.round(W*dpr) || canvas.height !== Math.round(H*dpr)) {
        canvas.width = Math.round(W*dpr); canvas.height = Math.round(H*dpr);
      }
      ctx.setTransform(dpr,0,0,dpr,0,0);
      var night = document.body.dataset.skyPhase === 'night' ? 1 : 0;
      theme = reduced ? night : lerp(theme, night, Math.min(1,dt*4));
      var motion = reduced ? 0 : time;
      if(reduced)particles=[];
      var small = W < 700, short = H < 500, horizon = H * (small ? .30 : .37);
      var baseY = H * (small ? .73 : .88);
      var charH = Math.min(H * (small ? .33 : .51), 440);
      var charX = W * (small ? .06 : .115);
      var pic = /bite|balancing|landing/.test(s.phase) ? active : idle;
      var charW = charH * ((pic.naturalWidth || 1) / (pic.naturalHeight || 2));
      var target = { x:W * (small ? .67 : .68), y:H * (small ? .47 : .56) };
      target.x += (s.charge || .25) * W * .025;
      if (s.phase === 'balancing' && s.bar) target.x += (s.bar.fish_.pos-.5) * W*.11;
      var phaseChanged = s.phase !== lastPhase;
      if(phaseChanged&&s.phase==='landing')landingFrom=lastFloat;
      if (phaseChanged && /waiting|bite|landing/.test(s.phase) && !reduced) splash(target.x,target.y,s.phase === 'bite' ? 22 : 14);
      lastPhase = s.phase;

      // Light, haze and a distant city keep depth behind the playable water.
      var sky = ctx.createLinearGradient(0,0,0,H);
      sky.addColorStop(0,color([177,228,244],[9,27,49]));
      sky.addColorStop(.42,color([237,252,253],[30,69,91]));
      sky.addColorStop(1,color([102,191,213],[9,36,55]));
      ctx.fillStyle=sky; ctx.fillRect(0,0,W,H);
      var sun=ctx.createRadialGradient(W*.73,H*.15,5,W*.73,H*.15,W*.4);
      sun.addColorStop(0,color([255,253,229],[41,85,108])); sun.addColorStop(1,'transparent');
      ctx.globalAlpha=.55; ctx.fillStyle=sun; ctx.fillRect(0,0,W,horizon); ctx.globalAlpha=1;
      // Broad elliptical sky halo, distinct from the character's own halo.
      ctx.save(); ctx.translate(W*.63,H*.13); ctx.rotate(-.08);
      ctx.strokeStyle=color([237,255,255],[111,193,218]); ctx.globalAlpha=.45; ctx.lineWidth=1;
      [1,.9,.65].forEach(function(k){ctx.beginPath();ctx.ellipse(0,0,W*.37*k,H*.075*k,0,0,Math.PI*2);ctx.stroke();});
      ctx.restore();
      ctx.globalAlpha=.48-theme*.4;
      if(clouds.complete&&clouds.naturalWidth)ctx.drawImage(clouds,-W*.04+Math.sin(motion*.02)*W*.012,-horizon*.6,W*1.08,horizon*1.7);
      ctx.globalAlpha=theme*.6;
      for(var star=0;star<24;star++)ellipse(((star*137.5)%1000)/1000*W,((star*73.3)%1000)/1000*horizon*.65,star%3===0?1.1:.6,star%3===0?1.1:.6,'#d6f6ff');
      ctx.globalAlpha=.28+theme*.3;
      if (shore.complete && shore.naturalWidth) ctx.drawImage(shore,0,horizon-H*.135,W,H*.135);
      ctx.globalAlpha=theme*.45;
      for(var light=0;light<38;light++){ctx.fillStyle=light%3===0?'#f9d997':'#b0e5ef';ctx.fillRect(light/38*W,horizon-H*(light%2?.008:.015),2,2);}
      ctx.globalAlpha=1;
      var water=ctx.createLinearGradient(0,horizon,0,H);
      water.addColorStop(0,color([132,209,221],[34,86,105]));
      water.addColorStop(.3,color([65,165,190],[18,60,80]));
      water.addColorStop(1,color([29,113,145],[8,28,48]));
      ctx.fillStyle=water;ctx.fillRect(0,horizon,W,H-horizon);
      ctx.fillStyle='#e5ffff88';ctx.fillRect(0,horizon,W,1);
      // Moving ribbons and light shards have deliberately different speeds.
      for (var i=0;i<47;i++) {
        var depth=(i/47), y=horizon+depth*depth*(H-horizon);
        var x=((i*173.13+Math.sin(i)*W+motion*(3+depth*9))%(W+240))-120;
        ctx.strokeStyle=i%3===0 ? '#e7ffff' : '#0d6085';
        ctx.globalAlpha=(i%3===0?.13:.07)*(1-theme*.5);ctx.lineWidth=1+depth;
        ctx.beginPath();ctx.moveTo(x,y);ctx.bezierCurveTo(x+25,y-3,x+70,y+3,x+100+depth*100,y);ctx.stroke();
      }
      ctx.globalAlpha=.10;
      for (i=0;i<5;i++) fish(W*(.45+i*.11)+Math.sin(motion*.3+i)*24,H*(.65+i%2*.075),10+i%3*3,'#032f46',i%2);
      ctx.globalAlpha=1;

      // A perspective pier with a fascia, planks, mooring posts and a loose rope.
      var endX=small ? W*.46 : W*.39;
      var deckTop=baseY-charH*.06, deckDepth=short ? 30 : 62;
      path([[0,deckTop+15],[endX,deckTop-23],[endX+W*.025,deckTop+deckDepth],[0,deckTop+deckDepth+40]],color([200,224,226],[49,77,90]));
      path([[0,deckTop+deckDepth+40],[endX+W*.025,deckTop+deckDepth],[endX+W*.025,deckTop+deckDepth+15],[0,deckTop+deckDepth+57]],color([76,124,143],[20,43,59]));
      ctx.strokeStyle=color([140,181,190],[36,60,76]);ctx.lineWidth=1;
      for(i=0;i<12;i++){var px=i/12*endX;ctx.beginPath();ctx.moveTo(px,deckTop+15-i/12*38);ctx.lineTo(px+25,deckTop+deckDepth+40-i/12*40);ctx.stroke();}
      ctx.strokeStyle='#e7c181';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(0,deckTop+deckDepth+39);ctx.lineTo(endX+W*.025,deckTop+deckDepth);ctx.stroke();
      [endX*.08,endX*.9].forEach(function(px){
        var py=deckTop+10-px/endX*30;
        ctx.fillStyle=color([72,116,136],[22,43,59]);ctx.fillRect(px,py-30,12,45);
        ellipse(px+6,py-30,7,3,color([184,211,213],[75,106,119]));
        ctx.strokeStyle='#d7dfcf';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(px,py-12);ctx.lineTo(px+12,py-14);ctx.moveTo(px,py-8);ctx.lineTo(px+12,py-10);ctx.stroke();
      });
      // Artwork is anchored to the pier. Cast anticipation and hook recoil are small.
      var anticipation=s.phase==='charging' ? Math.min(1,s.timer)*-.025 : s.phase==='casting' ? Math.sin(s.timer/.8*Math.PI)*.035 : 0;
      ctx.save();ctx.translate(charX+charW*.5,baseY);ctx.rotate(reduced?0:anticipation);
      if(pic.complete&&pic.naturalWidth)ctx.drawImage(pic,-charW*.5,-charH+(reduced?0:Math.sin(time*1.4)*1.3),charW,charH);
      ctx.restore();
      var hand={x:charX+charW*.69,y:baseY-charH*.46};
      var tip={x:hand.x+W*(small?.14:.17),y:hand.y-H*.23};
      if(s.phase==='charging'){tip.x-=s.charge*W*.12;tip.y-=s.charge*H*.06;}
      if(s.phase==='casting'){var swing=Math.max(0,1-s.timer/.35)*(s.charge||.25);tip.x-=swing*W*.12;tip.y-=swing*H*.06;}
      if(s.phase==='balancing'){tip.y+=Math.sin(motion*8)*3;tip.x+=inputPull(s)*8;}
      ctx.lineCap='round';ctx.strokeStyle=color([29,70,87],[153,192,210]);ctx.lineWidth=4;
      ctx.beginPath();ctx.moveTo(hand.x-12,hand.y+16);ctx.quadraticCurveTo(tip.x-W*.04,tip.y+H*.03,tip.x,tip.y);ctx.stroke();
      ctx.strokeStyle='#e5c27b';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(hand.x-12,hand.y+16);ctx.lineTo(hand.x+8,hand.y-13);ctx.stroke();
      var visible=/casting|waiting|bite|balancing|landing|missed/.test(s.phase);
      if(s.phase==='idle'||s.phase==='charging'){
        // A quiet landing target makes the cast's destination legible before release.
        ctx.save();ctx.strokeStyle='#d9faff';ctx.globalAlpha=.35;ctx.lineWidth=1.5;ctx.setLineDash([4,8]);
        ctx.beginPath();ctx.ellipse(target.x,target.y,34,11,0,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);
        if(s.phase==='charging'){ctx.globalAlpha=.85;ctx.strokeStyle='#ffe0a0';ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(target.x,target.y,42,15,0,-Math.PI/2,-Math.PI/2+s.charge*Math.PI*2);ctx.stroke();}
        ctx.restore();
        var hangY=tip.y+40+(reduced?0:Math.sin(time*2)*2);
        ctx.strokeStyle='#e8fbffb0';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(tip.x,tip.y);ctx.lineTo(tip.x+5,hangY);ctx.stroke();
        ellipse(tip.x+5,hangY,4,6,'#f37d66');
      }
      var bob={x:target.x,y:target.y};
      if(s.phase==='casting'){
        var p=Math.min(1,s.timer/window.FishingSession.CAST_ANIM_SECONDS);
        bob.x=lerp(tip.x,target.x,p);bob.y=lerp(tip.y,target.y,p)-Math.sin(p*Math.PI)*H*.22;
      } else if(s.phase==='landing'){
        var lp=Math.min(1,s.timer/window.FishingSession.LANDING_SECONDS);
        var from=landingFrom||target;
        bob.x=lerp(from.x,W*.57,lp);bob.y=lerp(from.y,H*.47,lp)-Math.sin(lp*Math.PI)*H*.3;
      } else bob.y+=Math.sin(motion*3)*(s.phase==='bite'?5:2);
      if(visible){
        lastFloat={x:bob.x,y:bob.y};
        ctx.strokeStyle='#e8fbffc9';ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(tip.x,tip.y);ctx.quadraticCurveTo((tip.x+bob.x)/2,(tip.y+bob.y)/2+(s.phase==='balancing'?8:36),bob.x,bob.y);ctx.stroke();
        if(s.phase!=='casting'&&s.phase!=='landing'){
          for(i=0;i<3;i++){
            var rp=((motion*.65+i/3)%1);
            ctx.globalAlpha=(1-rp)*.55;ctx.strokeStyle=s.phase==='bite'?'#ffe1a1':'#d0faff';ctx.lineWidth=1.5;
            ctx.beginPath();ctx.ellipse(target.x,target.y+8,14+rp*50,4+rp*13,0,0,Math.PI*2);ctx.stroke();
          }ctx.globalAlpha=1;
        }
        if(s.phase==='landing'&&s.result){
          var id=s.fish.id+'|'+s.result.specimen.float;
          if(!fishCache[id]){
            var fc=document.createElement('canvas');fc.width=160;fc.height=100;
            fc.__spec=window.FishSprite.fishSpriteSpec(s.fish,s.result.specimen);
            if(Object.keys(fishCache).length>8)fishCache={};fishCache[id]=fc;
          }
          window.FishSprite.drawFish(fishCache[id].getContext('2d'),fishCache[id].__spec,reduced?0:time);
          ctx.save();ctx.translate(bob.x,bob.y);ctx.rotate(reduced?0:-.5+s.timer);ctx.drawImage(fishCache[id],-65,-40,130,80);ctx.restore();
        } else {
          ctx.save();ctx.translate(bob.x,bob.y);ctx.rotate(reduced?0:Math.sin(motion*3)*.1);
          ellipse(0,4,6,10,'#f4fcff');ellipse(0,-2,6,6,s.phase==='bite'?'#ffad58':'#f37d66');
          ctx.strokeStyle='#183653';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,-7);ctx.lineTo(0,-17);ctx.stroke();ctx.restore();
          if(s.phase==='bite'){ctx.fillStyle='#ffe0a0';ctx.font='900 32px Segoe UI,sans-serif';ctx.textAlign='center';ctx.fillText('!',bob.x+22,bob.y-22);}
        }
      }
      particles=particles.filter(function(p){p.age+=dt;if(p.age>p.life)return false;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=220*dt;ctx.globalAlpha=1-p.age/p.life;ellipse(p.x,p.y,2,4,'#ecffff');return true;});ctx.globalAlpha=1;
      // Entry and active fight have depth, without moving the input surface.
      var vignette=ctx.createRadialGradient(W*.6,H*.48,H*.2,W*.6,H*.48,W*.8);
      vignette.addColorStop(0,'transparent');vignette.addColorStop(1,theme ? '#04152580' : '#13425d25');ctx.fillStyle=vignette;ctx.fillRect(0,0,W,H);
    }
    function inputPull(s){return s.bar ? s.bar.bar.vel : 0;}
    return { render:render, reset:function(){time=0;particles=[];lastPhase='';fishCache={};lastFloat=null;landingFrom=null;theme=document.body.dataset.skyPhase==='night'?1:0;} };
  }
  window.FishingScene={create:create};
})();
