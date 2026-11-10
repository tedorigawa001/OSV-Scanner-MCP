/** Independent operator assembly for the CLB-1 fixed-clock connection, not a live SessionServer. */
import {readFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Lb1Approval,LB1_POLICY} from './gradleOwnedCwcLb1Approval.js';
import {lb0Fixture,type lb0ApprovalFixture} from './gradleOwnedCwcLb0Fixture.js';
import {cwcCApprovalFixture} from './gradleOwnedCwcCApprovalFixture.js';
import {CwcCProvider,type CprBPhase} from './gradleOwnedCwcCProvider.js';
import {pack as referencePack} from './gradleOwnedCprAPlanner.js';
import {checkResult} from './gradleOwnedCprAWire.js';
import {sourceBundleSchema} from '../../utils/gradleOwnedSourceSchema.js';
import {CPR_WORK} from './gradleOwnedCprAAdmission.js';
import {verifyOwnerValue} from './gradleOwnedCprBSigner.js';
import {serviceTestKeys} from './gradleOwnedServiceContract.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
import {Lb0Budget,type Lb0Mode} from './gradleOwnedCwcLb0Contract.js';
export function lb1ApprovalFixture(){
 const sources:Record<string,Buffer>={};function bind(p:string){if(p in sources)return;const b=readFileSync(p);sources[p]=b;for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let next=resolve(dirname(p),m[1]!);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';bind(relative(process.cwd(),next));}}
 for(const p of ['src/test/fixtures/gradleOwnedCwcLb1Fixture.ts','package-lock.json','tsconfig.json','vitest.config.ts'])bind(p);
 const keys=generateKeyPairSync('ed25519'),manifest={schema:'cwc-lb1.approval.v1',policyDigest:hash(LB1_POLICY),node:process.version,sources:Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)]))},registry={schema:'cwc-lb1.registry.v1',manifestDigest:hash(manifest),operatorSpki:keys.publicKey.export({format:'der',type:'spki'}).toString('base64')},pin=hash(registry),envelope={manifest,signature:sign(null,Buffer.from(canonical(manifest)),keys.privateKey).toString('base64')};let current=pin;
 return {view:new Lb1Approval(envelope,registry,pin,sources,()=>current),envelope,registry,pin,sources,revoke(){current=hash('revoked');},restore(){current=pin;}};
}
export function lb1Fixture(options:{mode?:Lb0Mode;role?:'reader'|'authority-broker';api?:'aux.ReadSourceDescriptor'|'aux.ReadSealedSource'|'aux.ReadSourceRanges';sizes?:number[];memory?:number;work?:number;approval?:ReturnType<typeof lb1ApprovalFixture>;baseApproval?:ReturnType<typeof lb0ApprovalFixture>;hook?:(phase:CprBPhase)=>void|Promise<void>;commandMutation?:(q:any)=>any;readHook?:()=>void;mutateResult?:(body:any)=>void}={}){
 const approval=options.approval??lb1ApprovalFixture(),api=options.api??'aux.ReadSourceRanges';let reference:any;
 const f=lb0Fixture({...options,api,approval:options.baseApproval,connectedApproval:approval.view,budget:new Lb0Budget(undefined,options.memory??1048576),commandFactory:(c,input)=>{if(api==='aux.ReadSourceRanges'){reference=referencePack(c,input.entries,'seed','transfer');const q=structuredClone(reference.commands[0]);return options.commandMutation?.(q)??q;}return input.command(options.role??'reader',api);}});
 const codeApproval=cwcCApprovalFixture(),i=f.input;let live=true,currentHook:(()=>void)|undefined,phaseHook=options.hook;
 const source=sourceBundleSchema.parse({schema:'osv-mcp.q2.c3b.source-bundle.v1',metadata:structuredClone(i.metadata),commits:[i.data[0]!.toString('base64')],payloads:i.data.slice(1).map(b=>b.toString('base64'))});
 const current=()=>{approval.view.assertCurrent();currentHook?.();};
 const provider=new CwcCProvider({codeApproval:codeApproval.view,variant:'combined',mode:'B-independent',context:f.context,registry:structuredClone(f.registry),privateKey:serviceTestKeys['provider-reply']!.privateKey,now:f.environment.now,deadline:4500,current,live:()=>need(live,'pin_revoked'),read:()=>{options.readHook?.();return source;},expected:{metadataDigest:hash(i.metadata),inventoryDigest:i.inventoryPin.inventoryDigest,inventorySha256:sha(i.inventory),inventoryBytes:i.inventory.length,sourceBytes:i.inventoryPin.sourceBytes,entries:i.entries.length},work:options.work??CPR_WORK.total,planEvents:false,hook:phase=>phaseHook?.(phase),mutateResult:options.mutateResult});
 let call:ReturnType<typeof f.session.receive>|undefined,port:ReturnType<typeof f.session.connected>|undefined;
 async function run(){const issued=f.issue();call=issued.call;port=f.session.connected(call);try{const body=await f.session.dispatchConnected(call,async()=>{const reply=await provider.execute(issued.packet.inner,call!,port),raw=verifyOwnerValue(reply,f.registry,{role:'provider',instanceId:f.server.instanceId,direction:'reply',domain:'aux',api});const body:any=raw.body;
   if(api==='aux.ReadSourceRanges')checkResult(f.context,f.command,body);
   else{need(body.requestDigest===f.command.requestDigest&&body.mode==='observed'&&body.live===false,'binding_mismatch');const r=body.result;
    if(api==='aux.ReadSourceDescriptor')need(hash(r.metadata)===f.context.metadataDigest&&r.inventoryDigest===f.context.inventoryDigest&&r.sourceBytes===i.inventoryPin.sourceBytes&&r.entries===i.entries.length&&r.inventory.sha256===sha(i.inventory)&&r.inventory.byteLength===i.inventory.length,'source_integrity');
    else{const q=f.command.payload,b=Buffer.from(r.bytes,'base64'),entry=i.entries.find(e=>e.kind===q.kind&&e.index===q.index);need(entry&&hash(r.entry)===hash(entry)&&r.offset===q.offset&&r.totalBytes===entry.byteLength&&b.length===q.maxBytes&&sha(b)===r.sha256&&b.toString('base64')===r.bytes&&b.equals(i.data[i.entries.indexOf(entry)]!.subarray(q.offset,q.offset+q.maxBytes)),'source_integrity');}
   }return body;});return {reply:body,outputDigest:hash(body),diagnostics:port.diagnostics,metrics:{...provider.metrics},rows:provider.rows,plans:structuredClone(provider.codecPlans)};}catch(e){f.session.cancel(call);throw e;}}
 return {...f,approval,codeApproval,provider,source,reference,run,get call(){return call;},get port(){return port;},setCurrentHook(fn:()=>void){currentHook=fn;},setPhaseHook(fn:typeof phaseHook){phaseHook=fn;},cancelPin(){live=false;},close(){f.close();}};
}
