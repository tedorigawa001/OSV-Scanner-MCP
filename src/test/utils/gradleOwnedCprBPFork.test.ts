import {readFileSync} from 'node:fs';import {it,expect} from 'vitest';
const read=(s:string)=>readFileSync('src/test/fixtures/'+s+'.ts','utf8');
it('retains the entire provider authentication/scope/store/retry path except the planner selection',()=>{
 let s=read('gradleOwnedCprBProvider').replaceAll("from './gradleOwnedCprAPlanner.js'","from './gradleOwnedCprBPPlanner.js'").replaceAll('CprBProvider','CprBPProvider');
 s=s.replace('export type ProviderOptions=',"import {type PlannerVariant} from './gradleOwnedCprBPPlanner.js';\nexport type ProviderOptions=").replace('mode:CprBMode;context:','variant:PlannerVariant;mode:CprBMode;context:');
 s=s.replace('q.payload.transferId,gate);',"q.payload.transferId,gate,undefined,{variant:o.variant,actor:'provider',witness:{call:this.metrics.calls,requestDigest:q.requestDigest,batchOrdinal:q.payload.plan.batchOrdinal}});");
 s=s.replace("need(['S-scoped','B-independent'].includes(options.mode)","need(['reference','max-first','single-check','combined'].includes(options.variant)&&['S-scoped','B-independent'].includes(options.mode)");
 s=s.replace('readonly plans:{call:number;','readonly plans:{requestDigest:string;batchOrdinal:number;call:number;').replace('this.plans.push({call:this.metrics.calls,','this.plans.push({requestDigest:q.requestDigest,batchOrdinal:q.payload.plan.batchOrdinal,call:this.metrics.calls,');
 expect(read('gradleOwnedCprBPProvider')).toBe(s);
});
it('retains the complete client/transport/finalization path except pinned variant and planner calls',()=>{
 let s=read('gradleOwnedCprB').replaceAll('CprBProvider','CprBPProvider').replaceAll('gradleOwnedCprBProvider','gradleOwnedCprBPProvider').replaceAll("from './gradleOwnedCprAPlanner.js'","from './gradleOwnedCprBPPlanner.js'").replaceAll('CprBOptions','CprBPOptions').replaceAll('cprBCase','cprBPCase');
 s=s.replace('type Command=',"import {type PlannerVariant} from './gradleOwnedCprBPPlanner.js';\ntype Command=").replace('sizes?:number[];role?','variant?:PlannerVariant;sizes?:number[];role?');
 s=s.replace("mode,guard:'retained-512-2'","mode,variant:options.variant??'reference',guard:'retained-512-2'").replace('const provider=new CprBPProvider({mode,',"const provider=new CprBPProvider({variant:options.variant??'reference',mode,");
 s=s.replace("pack(clientContext,entries,id,'transfer',current)","pack(clientContext,entries,id,'transfer',current,undefined,{variant:options.variant??'reference',actor:'client-initial'})");
 s=s.replace("pack(clientContext,entries,id,'transfer',current)","pack(clientContext,entries,id,'transfer',current,undefined,{variant:options.variant??'reference',actor:'client-seal'})");
 s=s.replace("need(['S-scoped','B-independent'].includes(mode)","need(['reference','max-first','single-check','combined'].includes(options.variant??'reference')&&['S-scoped','B-independent'].includes(mode)");
 expect(read('gradleOwnedCprBP')).toBe(s);
});
