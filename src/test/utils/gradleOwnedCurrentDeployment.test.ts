import {it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifyC3StaticRun,c3DeploymentProfileDigest,c3ListenerDigest} from '../fixtures/gradleOwnedCurrentDeployment.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256 as h} from '../../utils/gradleOwnedJson.js';
const keys={manager:generateKeyPairSync('ed25519'),controller:generateKeyPairSync('ed25519')};
const roles=['provider','checkpoint-issuer','lineage-registry','authority-broker','reader','writer','operator'];
const caps=(mask='0000000000000000')=>({CapInh:mask,CapPrm:mask,CapEff:mask,CapBnd:mask,CapAmb:mask});
function phase(role:string,stage:string,i:number,uid:number,gid:number,mask='0000000000000000'){return {role,instanceId:role,boot:h(role),phase:stage,pid:100+i,uid:[uid,uid,uid],gid:[gid,gid,gid],groups:[],capabilities:caps(mask),noNewPrivileges:true,executableDigest:h(stage),argv:['fixed'],environment:{LANG:'C'},rootDigest:h(role+'root'),listenerDigest:h(role+'listener')};}
function fixture(){
 const m:any={schema:'osv-mcp.q2.c3a.deployment.v1',scope:'synthetic-static-only',runId:'run',profileDigest:h('placeholder'),enrollmentDigest:h('enrollment'),keySetDigest:ownedDigest({domain:'osv-mcp.q2.c3a.public-key-set.v1',serviceKeySetDigest:h('service-keys'),manager:{keyId:'manager',spki:keys.manager.publicKey.export({type:'spki',format:'der'}).toString('base64')},controller:{keyId:'controller',spki:keys.controller.publicKey.export({type:'spki',format:'der'}).toString('base64')}}),serviceKeySetDigest:h('service-keys'),phases:[phase('manager','provision',0,0,0,'00000000000001c0'),phase('manager','pre-drop',0,0,0,'00000000000001c0'),...roles.flatMap((role,i)=>[phase(role,'launcher',i+1,1101+i,1201+i),phase(role,'runtime',i+1,1101+i,1201+i)]),phase('controller','observe',9,0,0,'00000000000001ff')],endpoints:[],cases:[]};
 const servers={provider:'provider',issuer:'checkpoint-issuer',registry:'lineage-registry',authority:'authority-broker'};
 m.endpoints=Object.entries(servers).map(([destination,role],i)=>({destination,role,clientRole:'reader',instanceId:role,boot:h(role),ownerUid:0,ownerGid:0,groupGid:1205,mode:0o660,device:'1',inode:String(100+i),fd:3,passcred:true,custodian:'manager'}));
 for(const p of m.phases)if(roles.includes(p.role))p.listenerDigest=c3ListenerDigest({role:p.role,instanceId:p.instanceId,boot:p.boot},m.endpoints);
 m.cases=[{caseId:'allow',condition:'CN02',kind:'allow',reason:'allowed',requiredPreconditions:['profile-pinned'],forbiddenIO:0,forbiddenWrites:0,forbiddenDeliveries:0},{caseId:'deny',condition:'CN13',kind:'deny',reason:'permission-denied',requiredPreconditions:['authenticated','provider-ready'],forbiddenIO:0,forbiddenWrites:0,forbiddenDeliveries:0}];
 const build=(repinProfile=true)=>{
  if(repinProfile)m.profileDigest=c3DeploymentProfileDigest(m);const manifest=Buffer.from(canonicalOwnedJson(m)),digest=h(manifest);
  const launchBody:any={schema:'osv-mcp.q2.c3a.launch.v1',runId:m.runId,deploymentDigest:digest,profileDigest:m.profileDigest,phases:structuredClone(m.phases),endpoints:structuredClone(m.endpoints)};
  const recordBody:any={schema:'osv-mcp.q2.c3a.record.v1',scope:'synthetic-static-only',runId:m.runId,launchDigest:h('pending'),deploymentDigest:digest,phases:structuredClone(m.phases),bootstraps:[],cases:m.cases.map((c:any)=>({...c,preconditions:c.requiredPreconditions,observedReason:c.reason,sourceIO:0,writes:0,deliveries:0,controlStarted:true})),nativeTrials:0,nativeIsolationVerified:false,profileApproved:false,backendEligible:false,originalReadsSkipped:0};
  const input=()=>{const launch=signed(launchBody,'manager');recordBody.launchDigest=h(launch);if(!recordBody.bootstraps.length)recordBody.bootstraps=roles.map(role=>{const p=m.phases.find((p:any)=>p.role===role&&p.phase==='runtime');if(!p)return null;const raw=Buffer.from(canonicalOwnedJson({schema:'osv-mcp.q2.c3a.bootstrap.v1',runId:m.runId,deploymentDigest:digest,launchDigest:h(launch),profileDigest:m.profileDigest,enrollmentDigest:m.enrollmentDigest,keySetDigest:m.keySetDigest,role,instanceId:p.instanceId,boot:p.boot,rootDigest:p.rootDigest,listenerDigest:p.listenerDigest,runtimeDigest:p.executableDigest}));return {role,bytes:raw.toString('base64'),sha256:h(raw),fd:6,ownerUid:0,ownerGid:0,mode:0o400,readOnly:true,seals:15};}).filter(Boolean);return {manifest,expectedManifestDigest:digest,expectedProfileDigest:m.profileDigest,launch,record:signed(recordBody,'controller'),manager:{keyId:'manager',publicKey:keys.manager.publicKey},controller:{keyId:'controller',publicKey:keys.controller.publicKey}};};
  return {input,launchBody,recordBody};
 };
 return {m,build};
}
function signed(body:unknown,signer:'manager'|'controller'){const schema='osv-mcp.q2.c3a.evidence.v1',keyId=signer;return Buffer.from(canonicalOwnedJson({schema,signer,keyId,body,signature:sign(null,Buffer.from(canonicalOwnedJson({domain:schema,signer,keyId,body})),keys[signer].privateKey).toString('base64')}));}
it('accepts pinned synthetic manager/controller evidence without a native admission',()=>{const f=fixture().build(),out=verifyC3StaticRun(f.input());expect(out.casesVerified).toBe(2);expect(out.nativeTrials).toBe(0);expect(out.nativeIsolationVerified).toBe(false);expect(out.backendEligible).toBe(false);expect(out.originalReadsSkipped).toBe(0);});
it('binds phase permissions to a separately pinned profile, not just a profile label',()=>{const f=fixture(),initial=f.build().input();f.m.phases.at(-1).capabilities=caps('0000000000000fff');const modified=f.build(false).input();expect(()=>verifyC3StaticRun({...modified,expectedProfileDigest:initial.expectedProfileDigest})).toThrow('profile_unapproved');});
it.each(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])('permits the limited manager but refuses residual runtime %s even after repinning and signing',field=>{const f=fixture();f.m.phases.find((p:any)=>p.role==='provider'&&p.phase==='runtime').capabilities[field]='00000000000001c0';expect(()=>verifyC3StaticRun(f.build().input())).toThrow('principal_invalid');});
it.each(['uid','gid'])('refuses saved root %s after privilege drop',field=>{const f=fixture();f.m.phases.find((p:any)=>p.role==='provider'&&p.phase==='runtime')[field][2]=0;expect(()=>verifyC3StaticRun(f.build().input())).toThrow('principal_invalid');});
it.each(['provider','checkpoint-issuer','lineage-registry','authority-broker','reader','writer','operator'])('requires both %s execution phases',role=>{const f=fixture();f.m.phases=f.m.phases.filter((p:any)=>!(p.role===role&&p.phase==='launcher'));expect(()=>verifyC3StaticRun(f.build().input())).toThrow();});
it.each(['manager','controller'])('requires the %s evidence phase',role=>{const f=fixture();f.m.phases=f.m.phases.filter((p:any)=>p.role!==role);expect(()=>verifyC3StaticRun(f.build().input())).toThrow();});
it.each(['groups','noNewPrivileges','uid','gid','capabilities'])('refuses nonroot %s mismatch',field=>{const f=fixture(),p=f.m.phases.find((p:any)=>p.role==='writer'&&p.phase==='runtime');p[field]=field==='groups'?[1201]:field==='noNewPrivileges'?false:field==='capabilities'?caps('0000000000000001'):[999,999,999];expect(()=>verifyC3StaticRun(f.build().input())).toThrow('principal_invalid');});
it('rejects phase relabelling and extra pre-drop phases',()=>{const f=fixture().build();f.recordBody.phases.find((p:any)=>p.role==='provider'&&p.phase==='runtime').phase='pre-drop';expect(()=>verifyC3StaticRun(f.input())).toThrow('phase_mismatch');});
it('refuses excessive manager capability and missing capability sets',()=>{const f=fixture();f.m.phases[1].capabilities=caps('00000000000001ff');expect(()=>verifyC3StaticRun(f.build().input())).toThrow('principal_invalid');delete f.m.phases[1].capabilities.CapEff;expect(()=>verifyC3StaticRun(f.build().input())).toThrow('schema_invalid');});
it('refuses preload environment even after repinning',()=>{const f=fixture();f.m.phases[3].environment.NODE_OPTIONS='--require=/tmp/extra';expect(()=>verifyC3StaticRun(f.build().input())).toThrow('environment_invalid');});
it.each(['groupGid','role','boot','instanceId','inode','passcred','custodian'])('refuses listener %s substitution after digest and signature updates',field=>{const f=fixture(),e=f.m.endpoints[0];e[field]=field==='groupGid'?999:field==='boot'?h('wrong'):field==='passcred'?false:field==='role'?'reader':field==='inode'?f.m.endpoints[1].inode:'other';expect(()=>verifyC3StaticRun(f.build().input())).toThrow();});
it('refuses shared private roots',()=>{const f=fixture();for(const p of f.m.phases.filter((p:any)=>p.role==='reader'))p.rootDigest=f.m.phases.find((p:any)=>p.role==='provider').rootDigest;expect(()=>verifyC3StaticRun(f.build().input())).toThrow('root_mismatch');});
it.each(['launch','record'])('rejects an unsigned or wrong-key %s',which=>{const input=fixture().build().input();input[which as 'launch'|'record']=Buffer.from('{}');expect(()=>verifyC3StaticRun(input)).toThrow('schema_invalid');});
it('requires separate manager and controller keys',()=>{const input=fixture().build().input();input.controller=input.manager;expect(()=>verifyC3StaticRun(input)).toThrow('peer_mismatch');});
it.each(['manifest','profile'])('rejects the wrong independent %s pin',which=>{const input=fixture().build().input();if(which==='manifest')input.expectedManifestDigest=h('wrong');else input.expectedProfileDigest=h('wrong');expect(()=>verifyC3StaticRun(input)).toThrow();});
it.each(['phase-missing','phase-exchange','case-missing','case-duplicate','reason','precondition','read','write','delivery','timeout','admission','native'])('rejects controller-resigned %s evidence',mutation=>{const f=fixture().build(),r=f.recordBody;
 if(mutation==='phase-missing')r.phases.pop();if(mutation==='phase-exchange')r.phases[2].phase='runtime';if(mutation==='case-missing')r.cases.pop();if(mutation==='case-duplicate')r.cases[1]=r.cases[0];if(mutation==='reason')r.cases[1].observedReason='timeout';if(mutation==='precondition')r.cases[1].preconditions=[];if(mutation==='read')r.cases[1].sourceIO=1;if(mutation==='write')r.cases[1].writes=1;if(mutation==='delivery')r.cases[1].deliveries=1;if(mutation==='timeout')r.cases[1].controlStarted=false;if(mutation==='admission')r.backendEligible=true;if(mutation==='native')r.nativeTrials=1;
 expect(()=>verifyC3StaticRun(f.input())).toThrow();
});

it.each(['launchDigest','deploymentDigest','profileDigest','enrollmentDigest','keySetDigest','boot','rootDigest','listenerDigest','runtimeDigest','instanceId','role'])('rejects bootstrap %s replacement even with a new self hash and controller signature',field=>{
 const f=fixture().build();f.input();const entry=f.recordBody.bootstraps[0],body=JSON.parse(Buffer.from(entry.bytes,'base64').toString());body[field]=field==='instanceId'?'other':field==='role'?'reader':h('other');const bytes=Buffer.from(canonicalOwnedJson(body));entry.bytes=bytes.toString('base64');entry.sha256=h(bytes);expect(()=>verifyC3StaticRun(f.input())).toThrow('bootstrap_mismatch');
});
it.each(['readOnly','seals','ownerUid','ownerGid','mode','fd','missing','duplicate'])('rejects bootstrap %s corruption',field=>{
 const f=fixture().build();f.input();const list=f.recordBody.bootstraps;
 if(field==='missing')list.pop();else if(field==='duplicate')list[1]=list[0];else list[0][field]=field==='readOnly'?false:field==='fd'?3:field==='mode'?0o600:field==='seals'?7:1;
 expect(()=>verifyC3StaticRun(f.input())).toThrow();
});

it('reproduces the recorded static scope and source fingerprints',async()=>{
 const {readFile}=await import('node:fs/promises'),record=JSON.parse(await readFile(new URL('../../../docs/validation/gradle-independent-currentness-c3a-2026-11-03.json',import.meta.url),'utf8')),out=verifyC3StaticRun(fixture().build().input());
 expect({scope:out.scope,casesVerified:out.casesVerified,nativeTrials:out.nativeTrials,nativeIsolationVerified:out.nativeIsolationVerified,independentRegistryVerified:out.independentRegistryVerified,profileApproved:out.profileApproved,backendEligible:out.backendEligible,originalReadsSkipped:out.originalReadsSkipped}).toEqual(record.staticScenario);
 for(const [file,digest] of Object.entries(record.sourceSha256))expect(h(await readFile(new URL('../../../'+file,import.meta.url)))).toBe(digest);
});

it.each(['inode','device','fd'])('binds the old listener digest to endpoint %s after manifest and signature updates',field=>{
 const f=fixture();f.build();f.m.endpoints[0][field]=field==='fd'?4:'999';const after=f.build().input();
 expect(()=>verifyC3StaticRun(after)).toThrow('listener_mismatch');
});

it('accepts an updated listener inventory only after recomputing its digest',()=>{
 const f=fixture(),before=f.build().input();f.m.endpoints[0].inode='999';
 for(const p of f.m.phases)if(roles.includes(p.role))p.listenerDigest=c3ListenerDigest({role:p.role,instanceId:p.instanceId,boot:p.boot},f.m.endpoints);
 const after=f.build(false).input();expect(after.expectedProfileDigest).toBe(before.expectedProfileDigest);expect(verifyC3StaticRun(after).backendEligible).toBe(false);
});
it('hashes the exact owned inventory in canonical order and includes every endpoint field',()=>{
 const f=fixture(),e=f.m.endpoints[0],subject={role:e.role,instanceId:e.instanceId,boot:e.boot},second={...e,inode:'999',fd:4,clientRole:'writer',groupGid:1206};
 const a=canonicalOwnedJson(e),b=canonicalOwnedJson(second),listeners=a<b?[e,second]:[second,e];
 const expected=ownedDigest({domain:'osv-mcp.q2.c3a.listener-inventory.v1',...subject,listeners});
 expect(c3ListenerDigest(subject,[e,second])).toBe(expected);expect(c3ListenerDigest(subject,[second,e])).toBe(expected);
 for(const field of ['destination','role','clientRole','instanceId','boot','groupGid','device','inode','fd']){
  const changed={...e};changed[field]=field==='groupGid'?999:field==='fd'?4:field==='boot'?h('wrong'):field==='role'?'reader':field==='clientRole'?'writer':field==='destination'?'issuer':'other';
  expect(c3ListenerDigest(subject,[changed])).not.toBe(c3ListenerDigest(subject,[e]));
 }
});
it.each(['CN41','CN42'])('records the genesis-abandon and read-budget condition %s',condition=>{const f=fixture();f.m.cases[0].condition=condition;expect(verifyC3StaticRun(f.build().input()).conditions).toContain(condition);});
it('rejects an undefined CN43 case condition',()=>{const f=fixture();f.m.cases[0].condition='CN43';expect(()=>verifyC3StaticRun(f.build().input())).toThrow('schema_invalid');});
