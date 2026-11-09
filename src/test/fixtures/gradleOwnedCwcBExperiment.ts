/** Reproducible diagnostic matrix. Existing source planner and independent oracle stay enabled. */
import {vi} from 'vitest';
import {cprFixture} from './gradleOwnedCprAFixture.js';
import {ClosedCwcBCodec,type CwcBDomain} from './gradleOwnedCwcB.js';
import {cwcBOracle} from './gradleOwnedCwcBOracle.js';
import * as wire from './gradleOwnedCprAWire.js';
import * as json from '../../utils/gradleOwnedJson.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
// h0Sizes and singleLarge are the CPR-BP workloads whose CPR-C gate failed; the other four are CWC-B shape probes.
export const CWC_B_WORKLOADS=[{id:'small',sizes:[600,800,900,1100,1300]},{id:'mid-2048',sizes:[600,2048,2048,2048,2048]},{id:'large-commit',sizes:[18000,4096,4096,4096,4096]},{id:'large-payload',sizes:[600,9000,9000,9000,9000]},{id:'h0Sizes',sizes:[3061,1250,20810,5057,949,635,2072,6745,881]},{id:'singleLarge',sizes:[41456,1,1,1,1]}] as const;
export const CWC_B_PLANNING_PROBES=['owner','frames','exact','result','layout','ownedSha256'] as const;
export function runCwcBMatrix(){const samples=[];
 // Count reference materialization and byte hashing that actually happens inside planProof, instead of reporting constants.
 const spies={owner:vi.spyOn(wire,'owner'),frames:vi.spyOn(wire,'frames'),exact:vi.spyOn(wire,'exact'),result:vi.spyOn(wire,'result'),layout:vi.spyOn(wire,'layout'),ownedSha256:vi.spyOn(json,'ownedSha256')};
 const calls=()=>Object.fromEntries(CWC_B_PLANNING_PROBES.map(k=>[k,spies[k].mock.calls.length])) as Record<typeof CWC_B_PLANNING_PROBES[number],number>;
 try{
 for(const workload of CWC_B_WORKLOADS)for(const role of ['reader','authority-broker'] as const)for(const largeIds of [false,true]){
  const f=cprFixture({sizes:[...workload.sizes],role,largeIds}),p=f.plan(),before=hash(p),codec=new ClosedCwcBCodec({context:f.ctx,gate:()=>{},now:()=>0,deadline:4500,budget:{bytes:1048576,fragments:4096,work:67108864}});
  let probeControlOwnerCalls=0,comparisons=0,comparedBytes=0,preimages=0,signedEnvelopes=0,signatureVerifications=0,oracleOwners=0,oracleFrames=0,oraclePeak=0,proofWorkUnits=0,conservativeWireBytes=0;
  const domains=new Map<string,number>(),planningCalls=Object.fromEntries(CWC_B_PLANNING_PROBES.map(k=>[k,0])) as Record<typeof CWC_B_PLANNING_PROBES[number],number>;
  const matched=(domain:CwcBDomain,input:unknown,oracle:Buffer,q:typeof p.commands[number])=>{const result=codec.compareOracle(domain,input,oracle,q);need(result.bytes===oracle.length,'codec_layout_mismatch');comparisons++;comparedBytes+=result.bytes;domains.set(domain,(domains.get(domain)??0)+1);};
  try{for(const [i,q]of p.commands.entries()){
   const start=calls(),receipt=codec.planProof(q),end=calls();for(const k of CWC_B_PLANNING_PROBES)planningCalls[k]+=end[k]-start[k];
   const proof=codec.inspectProof(receipt,q),parts=q.payload.ranges.map(r=>{const bytes=Buffer.from(r.kind==='commit'?f.source.commits[r.index]!:f.source.payloads[r.index]!,'base64');return Buffer.from(bytes.subarray(r.offset,r.offset+r.length));});
   const ownerBefore=spies.owner.mock.calls.length,oracle=cwcBOracle(f.ctx,q,parts,f.keys),bound=p.bounds[i]!;probeControlOwnerCalls+=spies.owner.mock.calls.length-ownerBefore;proofWorkUnits+=proof.request+q.payload.ranges.length;conservativeWireBytes+=bound.total;
   need(proof.request===oracle.request.length&&proof.reply===oracle.reply.length&&proof.frames.every((n,i)=>n===oracle.auth[i]!.length)&&proof.total===oracle.request.length+oracle.reply.length+oracle.auth.reduce((n,b)=>n+b.length,0),'codec_layout_mismatch');
   need(proof.request<=bound.request&&proof.reply<=bound.reply&&proof.frames.every((n,i)=>n<=bound.frames[i]!)&&bound.fits,'codec_layout_mismatch');
   for(const v of oracle.vectors){matched(v.domain as CwcBDomain,v.input,v.bytes,q);if(v.preimage)preimages++;else signedEnvelopes++;}
   const {requestDigest,...unsigned}=q,intent={domain:'cpr.wire-intent.v3',command:unsigned};matched('command.full',q,Buffer.from(canonical(q)),q);matched('wireIntent.preimage',intent,Buffer.from(canonical(intent)),q);
   signatureVerifications+=oracle.signatureVerifications;oracleOwners+=oracle.stats.finalOwners;oracleFrames+=oracle.stats.finalFrames;
   oraclePeak=Math.max(oraclePeak,parts.reduce((n,b)=>n+b.length,0)+oracle.vectors.reduce((n,v)=>n+v.bytes.length,0)+16384);
  }
  const n=p.commands.length,d=codec.diagnostics,planBytes=Buffer.byteLength(canonical(p));
  need(proofWorkUnits===p.workUnits&&conservativeWireBytes===p.wireBytes,'codec_layout_mismatch');
  need(comparisons===14*n&&preimages===6*n&&signedEnvelopes===6*n&&signatureVerifications===6*n&&oracleOwners===2*n&&oracleFrames===4*n&&d.encodes===14*n&&d.proofs===n,'cwc_b_coverage');
  // Positive control: the same spies do see the oracle's reference owner materialization.
  need(probeControlOwnerCalls===2*n,'cwc_b_probe_control');
  need(domains.size===14&&[...domains.values()].every(x=>x===n)&&hash(p)===before&&f.reads===0,'cwc_b_coverage');
  need(d.logicalWorkspaceReserved+oraclePeak+planBytes<=1048576,'codec_budget_exceeded');
  samples.push({workload:workload.id,role,largeIds,commands:n,comparisons,preimages,signedEnvelopes,signatureVerifications,oracleOwners,oracleFrames,comparedBytes,domains:Object.fromEntries([...domains].sort()),planningCalls,probeControlOwnerCalls,sourcePlannerReference:{layoutOwners:p.stats.layoutOwners,layoutFrames:p.stats.layoutFrames,finalOwners:p.stats.finalOwners,finalFrames:p.stats.finalFrames},planDigest:p.planDigest,semanticPlanUnchanged:hash(p)===before,sourceReadCallbacks:f.reads,proofWorkUnits,referenceWorkUnits:p.workUnits,conservativeWireBytes,referenceWireBytes:p.wireBytes,serializedPlanBytes:planBytes,oraclePeakLogicalBytes:oraclePeak,diagnostics:d});
  }finally{codec.close();}
 }
 }finally{for(const spy of Object.values(spies))spy.mockRestore();}
 return samples;
}
