/** Local-process controller fixture. Each child loads only its own role keys and root pair. */
import {generateKeyPairSync,randomBytes,createPrivateKey,createPublicKey} from 'node:crypto';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
const [role,root,compiled]=process.argv.slice(2),boot=randomBytes(32).toString('hex'),moduleURL=name=>new URL(name+'.js',compiled).href;
if(!['lineage-registry','control-anchor','provider','checkpoint-issuer'].includes(role))throw Error('role');
const {validateOwnerPlans}=await import(moduleURL('gradleOwnedServiceOwners'));
const {canonicalOwnedJson,ownedDigest}=await import(moduleURL('gradleOwnedJson'));
const {StageStore}=await import(moduleURL('gradleOwnedStageStore'));
const {createRoleSigner}=await import(moduleURL('gradleOwnedRoleSigner'));
const {RegistryOwner}=await import(moduleURL('gradleOwnedRegistryOwner'));
const {AnchorOwner,AnchorClient}=await import(moduleURL('gradleOwnedAnchorOwner'));
const {SessionServer,SessionClient,SessionBootQuota}=await import(moduleURL('gradleOwnedSessionRuntime'));
const {registryServiceAPIs,registryPurpose}=await import(moduleURL('gradleOwnedRegistrySchema'));
const {ProviderOwner,IssuerOwner}=await import(moduleURL('gradleOwnedSourceOwner'));
const {SourceRegistryClient,SourcePeerClient}=await import(moduleURL('gradleOwnedSourceClient'));
const {sourceAPIs,sourcePurpose}=await import(moduleURL('gradleOwnedSourceSchema'));
const {ServiceContextFloor}=await import(moduleURL('gradleOwnedServiceSession'));
const secretPath=path.join(root,'owner-credentials.json'),publicPath=path.join(root,'public.json');let publicKeys,provisioned;
try{publicKeys=JSON.parse(await readFile(publicPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;provisioned={journal:randomBytes(32).toString('base64'),checkpoint:randomBytes(32).toString('base64')};publicKeys={};for(const direction of ['request','reply']){const pair=generateKeyPairSync('ed25519');publicKeys[direction]=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');provisioned[direction]=pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64');}await writeFile(secretPath,JSON.stringify(provisioned),{mode:0o600,flag:'wx'});await writeFile(publicPath,JSON.stringify(publicKeys),{mode:0o600,flag:'wx'});}
const roots={};for(const kind of ['store','checkpoint']){const p=path.join(root,kind);await mkdir(p,{mode:0o700,recursive:true});const info=await stat(p);roots[kind]={rootId:role+'-'+kind,device:String(info.dev),inode:String(info.ino)};}
let owner,store,session,config,approved=false,closed=false,revoked=false,phaseFault,phasePause,packetID=0;const channels=new Map(),pending=new Map(),clients=new Map();let requestKey;
const env={now:()=>Math.floor(performance.now()),assertOpen:()=>{if(closed||!approved)throw Error('owner closed or not approved');},credentialCurrent:()=>!revoked};
const encode=p=>({wire:p.wire.toString('base64'),...(p.inner?{inner:p.inner.toString('base64')}:{})}),decode=p=>({wire:Buffer.from(p.wire,'base64'),...(p.inner?{inner:Buffer.from(p.inner,'base64')}:{})});
function external(bytes){const id=++packetID;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('port timeout'));},10000);pending.set(id,{resolve,reject,timer});process.send({kind:'anchor-call',id,wire:bytes.toString('base64')});});}
function port(kind,fields){const id=++packetID;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('port timeout'));},10000);pending.set(id,{resolve,reject,timer});process.send({kind,id,...fields});});}
async function rpc(target,api,wire){let client=clients.get(target);if(!client){const c=config.registry.credentials.find(c=>c.identity.credentialId===role+'-request');let channel;const business=target==='lineage-registry'?{apis:registryServiceAPIs,purpose:registryPurpose}:{apis:sourceAPIs,purpose:sourcePurpose};client=new SessionClient({registry:config.registry,pins:config.pins,credentialId:c.identity.credentialId,privateKey:requestKey,lineage:config.lineage,environment:env,business},target+'-reply',{async open(){channel=(await port('session-port',{target,action:'open',credentialId:c.identity.credentialId})).channel;},async exchange(packet){return decode(await port('session-port',{target,action:'receive',channel,packet:encode(packet)}));},close(){if(channel){void port('session-port',{target,action:'close-channel',channel}).catch(()=>{});channel=undefined;}}},new SessionBootQuota(c.identity),new ServiceContextFloor(config.lineage));clients.set(target,client);}return client.execute(client.prepareBusiness(api,wire));}
process.on('message',async m=>{if(m.kind==='anchor-result'){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.value!==undefined?m.value:Buffer.from(m.wire,'base64'));}return;}if(m.kind!=='rpc')return;
 try{let result;
  if(m.action==='start'){
   const plans=validateOwnerPlans(m.config.configs,m.config.registry,{...m.config.pins,plansDigest:ownedDigest(m.config.configs)}),i=m.config.configs.findIndex(c=>c.role===role),plan=plans[i],c=m.config.configs[i];if(c.boot!==boot||JSON.stringify(c.roots)!==JSON.stringify(roots))throw Error('preflight mismatch');approved=true;config=m.config;
   // Secret loading follows the independently supplied public-plan preflight, never a wire request.
   const secrets=provisioned??JSON.parse(await readFile(secretPath,'utf8'));provisioned=undefined;requestKey=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.from(secrets.request,'base64')});
   const signers={};for(const direction of ['request','reply']){const key=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.from(secrets[direction],'base64')});if(createPublicKey(key).export({format:'der',type:'spki'}).toString('base64')!==publicKeys[direction])throw Error('key mismatch');signers[direction]=createRoleSigner(plan,config.registry,config.pins,role+'-'+direction,key,env.assertOpen);}
   store=await StageStore.open({plan,preflight:env.assertOpen,disk:{authorityId:c.ownerId,storeEpoch:c.storageEpoch,keyId:c.journalKeyId,checkpointKeyId:c.checkpointKeyId,key:Buffer.from(secrets.journal,'base64'),checkpointKey:Buffer.from(secrets.checkpoint,'base64'),store:{root:path.join(root,'store')},checkpoint:{root:path.join(root,'checkpoint')},mode:m.mode,fault:async point=>{if(point===phasePause){phasePause=undefined;process.send({kind:'paused',phase:point});await new Promise(()=>{});}if(point===phaseFault){phaseFault=undefined;throw Error('injected storage');}}}});
   if(role==='control-anchor')owner=await AnchorOwner.start({plan,store,signer:signers.reply,registry:config.registry,pins:config.pins,registryOwner:config.registryOwner,environment:env,floor:m.floor??{revision:0,record:null}});
   else if(role==='lineage-registry'){const anchor=new AnchorClient(plan,signers.request,config.registry,config.pins,{call:external},env);owner=await RegistryOwner.start({plan,store,signer:signers.reply,registry:config.registry,pins:config.pins,anchor,issuer:{readPrepared:async ref=>Buffer.from((await port('prepared-call',{ref})).wire,'base64')},environment:env,binding:config.binding,approvedBase:config.approvedBase,operationBinding:config.operationBinding});
    const ownKey=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.from(secrets.reply,'base64')});session=new SessionServer({registry:config.registry,pins:config.pins,credentialId:c.serverCredentialId,privateKey:ownKey,lineage:c.lineage,environment:env,business:{apis:registryServiceAPIs,purpose:registryPurpose}},async()=>[],(wire,admission)=>owner.receive(wire,admission));}
   else {const binding=new SourceRegistryClient(plan,signers.request,(api,wire)=>rpc('lineage-registry',api,wire)),peer=new SourcePeerClient(plan,signers.request,(api,wire)=>rpc(role==='provider'?'checkpoint-issuer':'provider',api,wire));owner=await (role==='provider'?ProviderOwner:IssuerOwner).start({plan,store,signer:signers.reply,registry:config.registry,pins:config.pins,binding,peer,environment:env,sourceKey:Buffer.from(config.sourceKey,'base64'),sourceKeyId:config.sourceKeyId,approvedBase:config.approvedBase,auditAuthoritySnapshot:config.auditAuthoritySnapshot,input:{readChunk:(ref,offset,maxBytes)=>port('input-call',{ref,offset,maxBytes})}});const ownKey=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.from(secrets.reply,'base64')});session=new SessionServer({registry:config.registry,pins:config.pins,credentialId:c.serverCredentialId,privateKey:ownKey,lineage:c.lineage,environment:env,business:{apis:sourceAPIs,purpose:sourcePurpose}},async()=>[],(wire,handle)=>owner.receive(wire,handle));}
   result={...owner.diagnostics,keySlots:2,role,boot,pid:process.pid};
  }else if(m.action==='prepare'){result=await owner.prepareCheckpoint(m.snapshot,m.fence,m.binding);}
  else if(m.action==='read-prepared'){result={wire:(await owner.readPrepared(m.ref)).toString('base64')};}
  else if(m.action==='anchor'){result={wire:(await owner.call(Buffer.from(m.wire,'base64'))).toString('base64')};}
  else if(m.action==='open'){const c=config.registry.credentials.find(c=>c.identity.credentialId===m.credentialId),id=randomBytes(16).toString('hex');channels.set(id,session.openPeer(c.identity.credentialId,{mode:'synthetic-local-process',credentialId:c.identity.credentialId,instanceId:c.identity.instanceId,boot:c.identity.boot}));result={channel:id};}
  else if(m.action==='receive'){if(!channels.has(m.channel))throw Error('unknown channel');result=encode(await session.receive(channels.get(m.channel),decode(m.packet)));}
  else if(m.action==='close-channel'){if(channels.has(m.channel)){session.closePeer(channels.get(m.channel));channels.delete(m.channel);}result={};}
  else if(m.action==='pause'){phasePause=m.phase;result={};}
  else if(m.action==='fault'){phaseFault=m.phase;result={};}
  else if(m.action==='revoke'){revoked=true;result={};}
  else if(m.action==='metrics'){result={...owner.diagnostics,keySlots:2,role,boot,pid:process.pid};}
  else if(m.action==='shutdown'){for(const c of clients.values())c.close();session?.close();owner?.close();closed=true;result={};}
  else throw Error('unknown action');process.send({kind:'rpc-result',id:m.id,result},()=>{if(m.action==='shutdown'){for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('owner stopped'));}pending.clear();process.disconnect();}});
 }catch(e){process.send({kind:'rpc-result',id:m.id,error:e.message});}
});
process.send({kind:'hello',role,pid:process.pid,boot,publicKeys,roots});
