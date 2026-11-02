import {it,expect} from 'vitest';
import {inspectOwnedExecution} from '../../utils/gradleOwnedExecution.js';
it('rejects a missing caller API instead of treating it as a missing receipt',()=>{
 expect(inspectOwnedExecution({} as any,undefined,{} as any)).toBe('execution_invalid');
});

it('a supported missing-receipt result remains unavailable, without promoting it to invalid',()=>{
 expect(inspectOwnedExecution({} as any,{backend:'unsupported'},{} as any)).toBe('witness_unavailable');
});

import {ownedSha256} from '../../utils/gradleOwnedJson.js';
import {executionFixture,ownedExecutionCase} from '../fixtures/gradleOwnedExecutionFixture.js';

it('a valid no-child unavailable producer reaches only G3, with no fake process or image lease',()=>{const f=executionFixture();expect(inspectOwnedExecution(f.claim,f.caller,f.authorization)).toBe('capability_unsupported');});

import {ownedPolicyFixture} from '../fixtures/gradleOwnedPolicyFixture.js';
import {ownedFixture,rewriteOwned} from '../fixtures/gradleOwnedFixture.js';
import {parseOwnedSettings,createOwnedRegistry} from '../../utils/gradleOwnedPolicy.js';
import {parseGradleExport} from '../../utils/gradleOwnedManifest.js';
import {createGradleBudget} from '../../utils/gradleGraph.js';
it('connects an independent current lookup after G0/G1 while retaining the core',()=>{
 const f=ownedExecutionCase('unavailable','none');const result=parseGradleExport(JSON.stringify(f.doc),createGradleBudget(),f.policy,f.caller);
 expect(result.owned).toMatchObject({manifestStructure:'verified',importStatus:'unavailable',executionWitness:'verified',reasons:['owned_manifest_capability_unsupported'],ownedFileReads:0,diagnosticEligible:false});
 expect(result.graph).toEqual(f.doc.coreGraph);
});

const run=(f:ReturnType<typeof ownedExecutionCase>)=>parseGradleExport(JSON.stringify(f.doc),createGradleBudget(),f.policy,f.caller);
it('matches completed process instances, results, leases and final pair then closes at G3',()=>{const f=ownedExecutionCase();expect(run(f).owned).toMatchObject({executionWitness:'verified',reasons:['owned_manifest_capability_unsupported'],ownedFileReads:0});});
for(const state of ['failed','unavailable'])for(const through of ['none','prepare','build','runtime-selection','snapshot-generation'])it('accepts only reached stages for '+state+'/'+through,()=>{const f=ownedExecutionCase(state,through);expect(run(f).owned).toMatchObject({executionWitness:'verified',reasons:['owned_manifest_capability_unsupported'],diagnosticEligible:false});});
for(const reason of ['receipt-missing','backend-unsupported','session-unavailable'])it('handles explicit unavailable '+reason,()=>{const f=ownedExecutionCase();f.caller.lookup=()=>({status:'unavailable',reason});expect(run(f).owned?.reasons).toEqual(['owned_manifest_witness_unavailable']);});
for(const reason of ['SKIPPED','FROM-CACHE','UP-TO-DATE','NO-SOURCE'])it('rejects restored success for '+reason+' without binding old execution IDs',()=>{const f=ownedExecutionCase();f.caller.lookup=()=>({status:'not-executed',reason,binding:{...f.witness.binding,executionId:'new-execution'},task:{taskId:'task',actionId:'action',actionCalls:0,executed:true,didWork:false,skipped:true,noSource:reason==='NO-SOURCE',failed:false,skipMessage:reason}});f.session.executionId='new-execution';expect(run(f).owned).toMatchObject({executionWitness:'unavailable',reasons:['owned_manifest_action_not_executed'],ownedFileReads:0});});
it('separates an unsealed Task exception from a sealed failed producer',()=>{const f=ownedExecutionCase();f.caller.lookup=()=>({status:'unavailable',reason:'execution-aborted',binding:f.witness.binding,task:{...f.witness.task,failed:true}});expect(run(f).owned?.reasons).toEqual(['owned_manifest_execution_aborted']);});
for(const [label,change,reason] of [
 ['session nonce',(f:any)=>f.session.nonce='other','claim_mismatch'],
 ['session authority',(f:any)=>f.session.authorityId='other','claim_mismatch'],
 ['session core digest',(f:any)=>f.session.coreGraphDigest=ownedSha256('other'),'claim_mismatch'],
 ['session root generation',(f:any)=>f.session.rootRegistryDigest=ownedSha256('other'),'claim_mismatch'],
 ['unknown scope',(f:any)=>f.session.scopes[0].context='other','claim_mismatch'],
 ['unapproved scope profile',(f:any)=>f.session.scopes[0].profileDigest=ownedSha256('other'),'claim_mismatch'],
 ['unapproved scope recipe',(f:any)=>f.session.scopes[0].recipeDigest=ownedSha256('other'),'claim_mismatch'],
 ['witnessId',(f:any)=>f.witness.witnessId='other','claim_mismatch'],
 ['bundle pair',(f:any)=>f.witness.bundleDigest=ownedSha256('other'),'claim_mismatch'],
 ['envelope pair',(f:any)=>f.witness.envelopeDigest=ownedSha256('other'),'claim_mismatch'],
 ['capture plan',(f:any)=>f.witness.plannedCaptures=2,'claim_mismatch'],
 ['scope capture plan',(f:any)=>f.session.scopes[0].plannedCaptures=2,'claim_mismatch'],
 ['capture completion',(f:any)=>f.witness.captures=0,'claim_mismatch'],
 ['Task ID',(f:any)=>f.witness.task.taskId='other','claim_mismatch'],
 ['Action ID',(f:any)=>f.witness.task.actionId='other','claim_mismatch'],
 ['false success Action count',(f:any)=>f.witness.task.actionCalls=0,'execution_invalid'],
 ['false success failed',(f:any)=>f.witness.task.failed=true,'execution_invalid'],
 ['false success skipped',(f:any)=>f.witness.task.skipped=true,'execution_invalid'],
 ['false success noSource',(f:any)=>f.witness.task.noSource=true,'execution_invalid'],
 ['false success didWork',(f:any)=>f.witness.task.didWork=false,'execution_invalid'],
 ['false success executed',(f:any)=>f.witness.task.executed=false,'execution_invalid'],
 ['false success skipMessage',(f:any)=>f.witness.task.skipMessage='FROM-CACHE','execution_invalid'],
 ['unknown witness field',(f:any)=>f.witness.path='/project/store','execution_invalid'],
 ['missing isolation reference',(f:any)=>delete f.session.isolationEvidenceRef,'execution_invalid'],
 ['duplicate scope',(f:any)=>f.session.scopes.push(f.session.scopes[0]),'execution_invalid'],
 ['duplicate lease',(f:any)=>f.session.leases.push(f.session.leases[0]),'execution_invalid'],
 ['missing stage',(f:any)=>f.witness.stageExecutions.pop(),'claim_mismatch'],
 ['reordered stage',(f:any)=>f.witness.stageExecutions.reverse(),'claim_mismatch'],
 ['wrong stage outcome',(f:any)=>f.witness.stageExecutions[1].outcome='failed','claim_mismatch'],
 ['missing actual process',(f:any)=>f.witness.stageExecutions[1].processes=[],'claim_mismatch'],
 ['wrong process instance',(f:any)=>f.witness.stageExecutions[1].processes[0].record.instanceId='other','claim_mismatch'],
 ['wrong process result',(f:any)=>f.witness.stageExecutions[1].processes[0].record.result='failure','claim_mismatch'],
 ['different configuration',(f:any)=>f.witness.stageExecutions[4].processes[0].record.configurationId='other','claim_mismatch'],
 ['different parameter',(f:any)=>f.witness.stageExecutions[4].processes[0].record.parameterId='other','claim_mismatch'],
 ['missing process begin',(f:any)=>delete f.witness.stageExecutions[1].processes[0].begin,'execution_invalid'],
 ['process outside stage',(f:any)=>f.witness.stageExecutions[1].processes[0].begin=1,'execution_invalid'],
 ['overlapping stage',(f:any)=>f.witness.stageExecutions[1].begin=1,'execution_invalid'],
 ['missing Node lease',(f:any)=>delete f.witness.stageExecutions[1].processes[0].leases.node,'execution_invalid'],
 ['missing loader lease',(f:any)=>delete f.witness.stageExecutions[2].processes[0].leases.loader,'execution_invalid'],
 ['lease kind exchange',(f:any)=>f.witness.stageExecutions[1].processes[0].leases.jdk='node','claim_mismatch'],
 ['wrong image pin',(f:any)=>f.session.leases[0].profileDigest=ownedSha256('other'),'claim_mismatch'],
 ['unknown lease',(f:any)=>f.witness.stageExecutions[1].processes[0].leases.jdk='missing','witness_unavailable'],
 ['revoked lease',(f:any)=>f.session.leases[0].status='revoked','witness_unavailable'],
] as const)it('rejects '+label+' with '+reason,()=>{const f=ownedExecutionCase();change(f);const result=run(f);expect(result.owned).toMatchObject({manifestStructure:'verified',importStatus:reason==='witness_unavailable'?'unavailable':'invalid',reasons:['owned_manifest_'+reason],ownedFileReads:0,diagnosticEligible:false});expect(result.graph).toEqual(f.doc.coreGraph);});
for(const field of ['noSource','skipped','failed','executed','didWork'])for(const value of [undefined,'false',0,null])it('rejects missing or non-boolean '+field+' '+value,()=>{const f=ownedExecutionCase();if(value===undefined)delete (f.witness.task as any)[field];else (f.witness.task as any)[field]=value;expect(run(f).owned?.reasons).toEqual(['owned_manifest_execution_invalid']);});
for(const result of [undefined,null,{}, {status:'success'}, {status:'unavailable',reason:'unknown'}, {status:'verified'}, {status:'invalid',reason:'invalid-receipt'}])it('does not hide malformed or invalid lookup data: '+JSON.stringify(result),()=>{const f=ownedExecutionCase();f.caller.lookup=()=>result;expect(run(f).owned?.reasons).toEqual(['owned_manifest_execution_invalid']);});
it('rejects a throwing lookup without exposing its message or trying a fallback',()=>{const f=ownedExecutionCase();let calls=0;f.caller.lookup=()=>{calls++;throw Error('/secret/store');};expect(run(f).owned?.reasons).toEqual(['owned_manifest_execution_invalid']);expect(calls).toBe(1);});
it('passes a frozen session-bound request and no paths to lookup',()=>{const f=ownedExecutionCase();const lookup=f.caller.lookup;let request:any;f.caller.lookup=(r:any)=>{request=r;return lookup(r);};run(f);expect(Object.isFrozen(request)).toBe(true);expect(request).toMatchObject({sessionId:'session',nonce:'nonce',witnessId:'witness',rootRegistryDigest:f.session.rootRegistryDigest});expect(Object.keys(request).some(k=>/path|url|store/i.test(k))).toBe(false);});

for(const status of ['superseded','revoked'])it('does not reuse a witness from '+status+' session',()=>{const f=ownedExecutionCase();f.session.status=status;let calls=0;f.caller.lookup=()=>{calls++;return f.result;};expect(run(f).owned?.reasons).toEqual(['owned_manifest_witness_unavailable']);expect(calls).toBe(0);});
for(const gate of ['G0','disabled','invalid','unapproved'])it('never calls the authority lookup behind closed '+gate,()=>{const f=ownedExecutionCase();let calls=0;f.caller.lookup=()=>{calls++;return f.result;};if(gate==='G0')f.doc.ownedOfferObjects[0].bytes+=' ';else f.policy.settings=parseOwnedSettings(gate==='disabled'?undefined:gate==='invalid'?'bad':'owned-bta-offered-inputs-v1');const r=run(f);expect(calls).toBe(0);expect(r.owned?.ownedFileReads).toBe(0);});
for(const caller of [null,{}, {backend:'caller-owned-receipt-store-v1'}, {backend:'unsupported',lookup:()=>({status:'verified'})}])it('rejects malformed caller API '+JSON.stringify(caller),()=>{const f=ownedExecutionCase();expect(parseGradleExport(JSON.stringify(f.doc),createGradleBudget(),f.policy,caller).owned?.reasons).toEqual(['owned_manifest_execution_invalid']);});
it('does not accept Task failure as a sealed producer failure',()=>{const f=ownedExecutionCase('failed','none');f.witness.task.failed=true;expect(run(f).owned?.reasons).toEqual(['owned_manifest_execution_invalid']);});
it('checks a failed producer state against the independent sealed state',()=>{const f=ownedExecutionCase('failed','none');f.witness.state.failureReason='inventory_mismatch';expect(run(f).owned?.reasons).toEqual(['owned_manifest_claim_mismatch']);});
for(const reason of ['SKIPPED','FROM-CACHE','UP-TO-DATE','NO-SOURCE'])for(const badField of ['actionCalls','noSource','skipMessage'])it('rejects contradictory '+reason+' '+badField,()=>{const f=ownedExecutionCase();const task:any={taskId:'task',actionId:'action',actionCalls:0,executed:true,didWork:false,skipped:true,noSource:reason==='NO-SOURCE',failed:false,skipMessage:reason};if(badField==='actionCalls')task.actionCalls=1;else if(badField==='noSource')delete task.noSource;else task.skipMessage='different';f.caller.lookup=()=>({status:'not-executed',reason,binding:f.witness.binding,task});expect(run(f).owned?.reasons).toEqual(['owned_manifest_execution_invalid']);});
it('does not accept a successful Task as an aborted execution',()=>{const f=ownedExecutionCase();f.caller.lookup=()=>({status:'unavailable',reason:'execution-aborted',binding:f.witness.binding,task:f.witness.task});expect(run(f).owned?.reasons).toEqual(['owned_manifest_execution_invalid']);});
it('a self-rehashed export still cannot replace the caller-pinned core or pair',()=>{const f=ownedExecutionCase();f.doc.coreGraph.producer.exporterVersion='different';importRehash(f);expect(run(f).owned?.reasons).toEqual(['owned_manifest_claim_mismatch']);});
import {ownedDigest} from '../../utils/gradleOwnedJson.js';
function importRehash(f:ReturnType<typeof ownedExecutionCase>){rewriteOwned(f.doc,()=>true,v=>{if(v.binding)v.binding.coreGraphDigest=ownedDigest(f.doc.coreGraph);if('coreGraphDigest'in v)v.coreGraphDigest=ownedDigest(f.doc.coreGraph);});}
it('keeps currentContentMatch and diagnostic admission closed after repeat verified lookups',()=>{const f=ownedExecutionCase();const parsed=run(f);expect(parsed.refreshOwnedExecution).toBeTypeOf('function');f.caller.lookup=()=>({status:'unavailable',reason:'receipt-missing'});expect(parsed.refreshOwnedExecution!()).toMatchObject({executionWitness:'unavailable',ownedFileReads:0,diagnosticEligible:false,currentContentMatch:'not_checked',reasons:['owned_manifest_witness_unavailable']});});

for(const key of ['graphId','exportId','executionId'] as const)it('does not bind a fresh sealed session to an old '+key,()=>{const f=ownedExecutionCase();f.session[key]='new-'+key;f.witness.binding[key]='new-'+key;expect(run(f).owned?.reasons).toEqual(['owned_manifest_claim_mismatch']);});
it('rejects a fake process for a prepare-blocked unavailable producer',()=>{const f=ownedExecutionCase('unavailable','none');f.witness.stageExecutions=[{stage:'prepare',outcome:'unavailable',begin:1,end:9,processes:[{record:{kind:'process',operation:'javac',instanceId:'invented',result:'success',started:true,finished:true},begin:2,end:3,leases:{jdk:'jdk',node:'node',platform:'platform',executor:'executor'}}]}];expect(run(f).owned?.reasons).toEqual(['owned_manifest_claim_mismatch']);});
it('allows an explicit blocked-stage check without inventing child calls',()=>{const f=ownedExecutionCase('unavailable','none');f.witness.stageExecutions=[{stage:'prepare',outcome:'unavailable',begin:1,end:9,processes:[]}];expect(run(f).owned?.executionWitness).toBe('verified');});
it('bounds returned authority metadata without leaking content',()=>{const f=ownedExecutionCase();f.caller.lookup=()=>({status:'unavailable',reason:'receipt-missing',extra:'x'.repeat(8*1024*1024)});expect(run(f).owned?.reasons).toEqual(['owned_manifest_execution_invalid']);});

it('binds broker instance to the independent session scope',()=>{const f=ownedExecutionCase();f.witness.brokerInstanceId='other';expect(run(f).owned?.reasons).toEqual(['owned_manifest_claim_mismatch']);});
for(const kind of ['jdk','node','executor','platform','loader'])it('binds '+kind+' lease to its actual holder',()=>{const f=ownedExecutionCase();f.session.leases.find((l:any)=>l.kind===kind).holderId='other';expect(run(f).owned?.reasons).toEqual(['owned_manifest_claim_mismatch']);});
