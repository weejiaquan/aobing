'use strict';
// Deterministic peer transport for controller tests. This does not emulate NAT or browser permissions.
exports.peerNetwork=function({dropAfter=null,stall=false}={}) {
  let next=0,frames=0,dropped=false;const pcs=new Map();
  class Channel {
    constructor(){this.readyState='connecting';this.bufferedAmount=0;}
    send(data){
      if(this.readyState!=='open')throw Error('closed');frames++;
      const cut=dropAfter!==null && frames===dropAfter;
      queueMicrotask(()=>{
        if(this.readyState!=='open'||this.peer.readyState!=='open'||stall)return;
        this.peer.onmessage?.({data});
        if(cut&&!dropped){dropped=true;this.close();}
      });
    }
    close(){if(this.readyState==='closed')return;this.readyState='closed';this.onclose?.();if(this.peer)this.peer.close();}
  }
  class PC {
    constructor(){this.id=String(++next);pcs.set(this.id,this);this.connectionState='new';}
    createDataChannel(){return this.channel=new Channel();}
    async createOffer(){return {type:'offer',sdp:this.id};}
    async createAnswer(){return {type:'answer',sdp:this.id};}
    async setLocalDescription(value){this.localDescription=value;}
    async setRemoteDescription(value){
      this.remoteDescription=value;
      if(value.type==='offer'){
        const offerer=pcs.get(value.sdp);if(!offerer)throw Error('missing offer');
        this.channel=new Channel();this.channel.peer=offerer.channel;offerer.channel.peer=this.channel;
        this.ondatachannel?.({channel:this.channel});
      }else{
        const pair=[this.channel,this.channel.peer];pair.forEach(c=>c.readyState='open');
        queueMicrotask(()=>pair.forEach(c=>c.onopen?.()));
      }
    }
    async addIceCandidate(){}
    close(){this.connectionState='closed';this.channel?.close();pcs.delete(this.id);}
  }
  return {PC,get frames(){return frames;},get livePeers(){return pcs.size;}};
};
