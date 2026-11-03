// C3b-1 local-process diagnostic fixture. Each process generates exactly its own private key.
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const role=process.argv[2];if(!['client','server'].includes(role))throw Error('role');
const {SessionServer,SessionClient,SessionBootQuota}=await import(process.argv[3]);
const {ServiceContextFloor}=await import(new URL('./gradleOwnedServiceSession.js',process.argv[3]));
const key=generateKeyPairSync('ed25519'),boot=randomBytes(32).toString('hex');
let endpoint,channel,config,sequence=0,timeOffset=0,open=true,allowed=true,statusReads=0;
const routes=new Map();
const send=m=>process.send?.(m);
const environment={now:()=>Math.floor(performance.now())+timeOffset,assertOpen:()=>{if(!open)throw Error('owner-closed');},credentialCurrent:()=>allowed};
const wire=p=>({wire:p.wire.toString('base64'),...(p.inner?{inner:p.inner.toString('base64')}:{})});
function packet(p){if(typeof p?.wire!=='string'||p.wire.length>22000||p.inner&&p.inner.length>11000)throw Error('packet-limit');const value={wire:Buffer.from(p.wire,'base64'),...(p.inner?{inner:Buffer.from(p.inner,'base64')}:{})};if(value.wire.toString('base64')!==p.wire||value.inner&&value.inner.toString('base64')!==p.inner)throw Error('base64');return value;}
function route(action,value){const id=++sequence;return new Promise((resolve,reject)=>{routes.set(id,{resolve,reject});send({kind:'transport',id,action,...value});});}
process.on('message',async m=>{
 if(m.kind==='transport-result'){const pending=routes.get(m.id);if(pending){routes.delete(m.id);m.error?pending.reject(Error(m.error)):pending.resolve(m.result);}return;}
 if(m.kind!=='rpc')return;
 try{let result;
  if(m.action==='configure'){
   config=m.config;const own=role==='server'?'lineage-registry-reply':'operator-request',base={registry:config.registry,pins:config.pins,credentialId:own,privateKey:key.privateKey,lineage:config.lineage,environment};
   if(role==='server')endpoint=new SessionServer(base,async()=>{statusReads++;return [{instanceId:'lineage-registry',boot,lifecycle:'control-ready',lineagePhase:'uninitialized'}];});
   else{const transport={open:async()=>{await route('open',{});},exchange:async p=>packet(await route('exchange',{packet:wire(p)})),close:()=>send({kind:'transport',id:++sequence,action:'close'})};const identity=config.registry.credentials.find(c=>c.identity.credentialId===own).identity;endpoint=new SessionClient(base,'lineage-registry-reply',transport,new SessionBootQuota(identity),new ServiceContextFloor(config.lineage));}
   result={configured:true,pid:process.pid};
  }else if(m.action==='open'){channel=endpoint.openPeer('operator-request',{mode:'synthetic-local-process',credentialId:'operator-request',instanceId:'operator',boot:config.clientBoot});result=true;}
  else if(m.action==='receive')result=wire(await endpoint.receive(channel,packet(m.packet)));
  else if(m.action==='close-channel'){if(channel)endpoint.closePeer(channel);channel=undefined;result=true;}
  else if(m.action==='execute'){const op=endpoint.prepareStatus(m.run);result=await endpoint.execute(op);}
  else if(m.action==='metrics')result={...endpoint.diagnostics,statusReads,pid:process.pid,privateKeySlots:1};
  else if(m.action==='advance'){timeOffset+=m.ms;result=true;}
  else if(m.action==='revoke'){allowed=false;result=true;}
  else if(m.action==='shutdown'){endpoint?.close();send({kind:'rpc-result',id:m.id,result:true});process.disconnect();return;}
  else throw Error('action');
  send({kind:'rpc-result',id:m.id,result});
 }catch(e){send({kind:'rpc-result',id:m.id,error:e.reason??e.message});}
});
send({kind:'hello',role,pid:process.pid,boot,keyId:role==='server'?'lineage-registry-reply':'operator-request',spki:key.publicKey.export({format:'der',type:'spki'}).toString('base64'),privateKeySlots:1});
