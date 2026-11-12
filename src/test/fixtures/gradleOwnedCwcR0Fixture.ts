/** Harness input/oracle objects never become a command result of the R0 owner. */
import {cprFixture} from './gradleOwnedCprAFixture.js';
import {capacityContext} from './gradleOwnedCwcLgCapacity.mjs';
import {R0Owner,type R0Fault} from './gradleOwnedCwcR0.js';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {Vf0Clock} from './gradleOwnedCwcVf0Authority.js';
import {planCore} from './gradleOwnedCprAPlanner.js';
import {makeCommand,checkCommand} from './gradleOwnedCprASchema.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
export function r0Fixture(o:{role?:'reader'|'authority-broker';boundary?:string;workload?:'small'|'stress';kind?:'provider'|'client';budget?:Lb0Budget;hook?:(site:string,owner:R0Owner)=>void;fault?:R0Fault}={}){
 const workload=o.workload??'small',sizes=workload==='small'?[1,1,1,1,1]:[1,1,1,1,8288,8288,8288,8288,8304],base=cprFixture({role:o.role,sizes});
 base.ctx.registryDigest=hash({schema:'cwc-r0.synthetic-registry.v1',source:'bounded-command-fixture'});
 const c=capacityContext(base.ctx,o.role??'reader',o.boundary??'normal');
 const group=(e:typeof base.entries[number],offset:number,length:number,ordinal=0)=>({ordinal,kind:e.kind,index:e.index,offset,length,entry:{sha256:e.sha256,byteLength:e.byteLength}});
 const groups=[base.entries.slice(0,4).map((e,i)=>group(e,0,e.byteLength,i))];
 for(let i=4;i<base.entries.length;i++){const e=base.entries[i]!,parts=workload==='small'?1:i<7?4:3;let at=0;for(let j=0;j<parts;j++){const n=Math.ceil((e.byteLength-at)/(parts-j));groups.push([group(e,at,n)]);at+=n;}}
 const seed='s'.repeat(128),transferId='t'.repeat(128),budget=o.budget??new Lb0Budget(),clock=new Vf0Clock();
 const owner=new R0Owner({context:c,groups,seed,transferId,kind:o.kind??'provider',budget,clock,hook:o.hook,fault:o.fault});
 // These are independent legacy oracle objects, outside the measured owned pipeline.
 const core=planCore(c,seed,transferId,groups),digest=hash(core),commands=groups.map((rs,i)=>makeCommand(c,seed,transferId,i,groups.length,digest,rs));
 return {owner,budget,clock,context:c,groups,core,commands};
}
export function r0Matrix(){const rows=[];
 for(const role of ['reader','authority-broker'] as const)for(const boundary of ['normal','registered-maximum','schema-upper'])for(const workload of ['small','stress'] as const)for(const kind of ['provider','client'] as const){
  const f=r0Fixture({role,boundary,workload,kind}),digests:string[][]=[];let error:string|null=null,alias=true;
  try{
   for(const actor of kind==='provider'?['provider'] as const:['client-initial','client-seal'] as const){
    const h=f.owner.open(f.owner.claim(actor));alias&&=h===f.owner.coreHandle(h);for(let i=0;i<f.commands.length;i++)f.owner.capture(h);for(let i=0;i<f.commands.length;i++)f.owner.process(h);
    const data=f.owner.diagnosticRows(h);digests.push(data.map((bytes,i)=>{const q=JSON.parse(bytes.toString());checkCommand(f.context,q);
     if(bytes.toString()!==canonical(q)||bytes.toString()!==canonical(f.commands[i]))throw Error('r0_oracle');return sha(bytes);}));
   }if(kind==='client')f.owner.compareFamilies();
  }catch(e){error=e instanceof Error?e.message:String(e);}
  const before=f.owner.stats();f.owner.close();rows.push({role,boundary,workload,kind,error,alias,context:f.context,n:f.commands.length,oracle:digests,before,after:f.owner.stats()});
 }
 return {schema:'cwc-r0.evidence.v1',rows};
}
