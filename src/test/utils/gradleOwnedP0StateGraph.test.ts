import {expect,test} from 'vitest';
import {pb0RecordRef,pb0ValidateBundle,pb0BindInit} from '../../utils/gradleOwnedP0StateGraph.js';
import {H,J,V,R,request,controlDraft} from '../fixtures/gradleOwnedP0StateFixture.js';
import {ownedDigest} from '../../utils/gradleOwnedJson.js';
function fixture(){
 const nodes:Record<string,any>[]=[];
 const add=(id:string,kind:string,value:unknown)=>{const n={schema:'cwc.e2-p0.pb0-record.v1',id,realmId:'realm',kind,value};nodes.push(n);return pb0RecordRef(J(n));};
 const source=add('source','source-facts',{subjectDigest:H(),artifactDigest:H('1')});
 const descriptor={schema:'cwc.e2-p0.job-descriptor.v2',jobId:{realmId:'realm',controllerJobId:'job',randomNonce:H('2')},sourceDigest:H('1'),inputManifestDigest:H('2'),toolLockDigest:H('3'),requestedApprovalSubjects:{method:H(),environment:H()},initialEpochVector:V,admittedAt:0,clockDomain:'clock',originalWallDeadline:10000,originalLeaseDeadline:10000};
 const job=add('job','job',descriptor),method=add('method','approval',{approvalKind:'method',subjectDigest:H(),profileDigest:H('4'),approvalEnvelopeRef:source}),environment=add('environment','approval',{approvalKind:'environment',subjectDigest:H(),profileDigest:H('5'),approvalEnvelopeRef:source});
 const reservation=add('reservation','reservation',{jobRef:job,priorPinRef:null,capacityDigest:H('6')});
 const pin=add('pin','current-pin',{jobRef:job,approvalRefs:[method,environment],custodyRef:source,reservationRefs:[reservation],predecessorRef:null,epochVector:V,selectionRevision:1});
 const preflight=add('preflight','preflight',{jobRef:job,pinRef:pin,reservationRefs:[reservation],phase:'reserved',metadataDigest:H('7')});
 const grant=add('grant','reader-grant',{jobRef:job,pinRef:pin,preflightRef:preflight,credential:'reader',keyEpoch:1,spkiDigest:H('8'),apiSet:['ReadPins'],purposeSet:['job-pins'],sourceRefs:[source],authRevision:1,selectionRevision:1,epochVectorDigest:ownedDigest(V),workflowLimit:1,originalDeadline:5000,issuer:'issuer',keyId:'issuer-key'});
 const init=add('init','init-descriptor',{initId:'init',jobRef:job,beginControlKey:H('9'),t0:0,originalDeadline:5000,reservationRefs:[reservation]});
 const seal=add('seal','init-seal',{descriptorRef:init,beginControlKey:H('9'),controlIntentDigest:H('a')});
 const tickets=Array.from({length:8},(_,i)=>add('ticket'+i,'source-facts',{subjectDigest:H(),artifactDigest:H('1')}));
 const workflow=add('workflow','workflow',{workflowId:'workflow',jobRef:job,grantRef:grant,initSealRef:seal,originalDeadline:5000,ticketRefs:tickets,reservationRefs:[reservation]});
 const body=add('body','response-body',{requestDigest:H('b'),jobRef:job,workflowRef:workflow,sourceRefs:[source],bodyDigest:H('c')});
 const ready=add('ready','response-ready',{responseBodyRef:body,workflowRef:workflow,consumption:{calls:1,wireBytes:1000,work:10}});
 const escape=add('escape','response-may-have-escaped',{responseReadyRef:ready,mayHaveEscaped:true});
 const delivery=add('delivery','delivery',{escapeRef:escape,requestDigest:H('b'),nonce:H('d'),serverBoot:H('b'),deliveryEnvelopeDigest:H('e')});
 return {schema:'cwc.e2-p0.pb0-bundle.v1',realmId:'realm',roots:[delivery],nodes};
}
test('PBG01 complete descriptor through escaped delivery has exact reference closure',()=>{
 const b=fixture();expect(pb0ValidateBundle(J(b))).toMatchObject({records:b.nodes.length,jobPermitIssued:false,runtimeAdmitted:false});
 expect(pb0ValidateBundle(J({...b,nodes:[...b.nodes].reverse()})).records).toBe(b.nodes.length);
});
test('PBG02 missing duplicated unreachable or changed nodes are refused',()=>{
 const b=fixture();expect(()=>pb0ValidateBundle(J({...b,nodes:b.nodes.filter(n=>n.id!=='job')}))).toThrow('reference-missing');
 expect(()=>pb0ValidateBundle(J({...b,nodes:[...b.nodes,b.nodes[0]]}))).toThrow('duplicate-record');
 expect(()=>pb0ValidateBundle(J({...b,nodes:[...b.nodes,{...b.nodes[0],id:'orphan'}]}))).toThrow('unreachable');
 b.nodes.find(n=>n.id==='job')!.value.sourceDigest=H('f');expect(()=>pb0ValidateBundle(J(b))).toThrow('reference-content');
});
test('PBG03 cycles are refused before self updated digest claims can hide them',()=>{
 const b=fixture(),a=b.nodes.find(n=>n.id==='pin')!,r=b.nodes.find(n=>n.id==='reservation')!;
 r.value.priorPinRef={id:a.id,sha256:H(),byteLength:10};expect(()=>pb0ValidateBundle(J(b))).toThrow('reference-cycle');
});
test('PBG04 current pins cannot include future preflight or delivery signatures',()=>{
 const b=fixture();b.nodes.find(n=>n.id==='pin')!.value.preflightRef={id:'preflight',sha256:H(),byteLength:10};expect(()=>pb0ValidateBundle(J(b))).toThrow('schema-invalid');
 const c=fixture();c.nodes.find(n=>n.id==='ready')!.value.outerSignature=H();expect(()=>pb0ValidateBundle(J(c))).toThrow('schema-invalid');
});
test('PBG05 references cannot claim another record kind with recomputed content refs',()=>{
 const b=fixture(),ready=b.nodes.find(n=>n.id==='ready')!,delivery=b.nodes.find(n=>n.id==='delivery')!;
 delivery.value.escapeRef=pb0RecordRef(J(ready));b.roots=[pb0RecordRef(J(delivery))];b.nodes=b.nodes.filter(n=>n.id!=='escape');expect(()=>pb0ValidateBundle(J(b))).toThrow('reference-kind');
});
test('PBG06 descriptor forbids future seal or workflow refs and bad lease deadlines',()=>{
 const b=fixture(),n=b.nodes.find(n=>n.id==='init')!;expect(()=>pb0RecordRef(J({...n,value:{...n.value,controlIntentDigest:H()}}))).toThrow();
 const job=b.nodes.find(n=>n.id==='job')!;expect(()=>pb0RecordRef(J({...job,value:{...job.value,admittedAt:10000}}))).toThrow();
});
test('PBG07 extending the init deadline cannot be hidden by updating dependent digests',()=>{
 const b=fixture(),w=b.nodes.find(n=>n.id==='workflow')!,body=b.nodes.find(n=>n.id==='body')!,ready=b.nodes.find(n=>n.id==='ready')!,escape=b.nodes.find(n=>n.id==='escape')!,delivery=b.nodes.find(n=>n.id==='delivery')!;
 w.value.originalDeadline=5001;body.value.workflowRef=pb0RecordRef(J(w));ready.value.workflowRef=pb0RecordRef(J(w));ready.value.responseBodyRef=pb0RecordRef(J(body));escape.value.responseReadyRef=pb0RecordRef(J(ready));delivery.value.escapeRef=pb0RecordRef(J(escape));b.roots=[pb0RecordRef(J(delivery))];expect(()=>pb0ValidateBundle(J(b))).toThrow('workflow-init-binding');
});
test('PBG08 realm control debt has no fabricated job workflow or init descriptor',()=>{
 const source={schema:'cwc.e2-p0.pb0-record.v1',id:'maintenance',realmId:'realm',kind:'source-facts',value:{subjectDigest:H(),artifactDigest:H('1')}};
 const debt={schema:'cwc.e2-p0.pb0-record.v1',id:'debt',realmId:'realm',kind:'control-debt',value:{ownerId:'registry',targetSubject:{kind:'realm',realmId:'realm'},controlOperationKey:H('2'),controlIntentDigest:H('3'),budget:{kind:'maintenance',maintenanceRef:pb0RecordRef(J(source))},reservationRefs:[],heldCapacity:1000,spentCounters:{calls:1,wireBytes:100,work:0},unknownEffectFloor:{calls:0,wireBytes:0,work:0},fenceRefs:[],drainRefs:[],reconciliationRef:null,joinedWorkflowRef:null}};
 const b={schema:'cwc.e2-p0.pb0-bundle.v1',realmId:'realm',roots:[pb0RecordRef(J(debt))],nodes:[source,debt]};expect(pb0ValidateBundle(J(b)).records).toBe(2);
 const bad={...debt,value:{...debt.value,targetSubject:{kind:'realm',realmId:'other'}}};expect(()=>pb0ValidateBundle(J({...b,nodes:[source,bad],roots:[pb0RecordRef(J(bad))]}))).toThrow('subject-realm');
 const auth={schema:'cwc.e2-p0.pb0-record.v1',id:'auth',realmId:'realm',kind:'auth-state',value:{kind:'realm',revision:1,revocationRevision:0}};
 const journal={schema:'cwc.e2-p0.pb0-record.v1',id:'journal',realmId:'realm',kind:'owner-journal',value:{ownerId:'registry',ownerRole:'registry',storageEpoch:H('c'),ownerRevision:1,previousRef:null,operationDomain:'control',targetSubject:{kind:'realm',realmId:'realm'},authStateRef:pb0RecordRef(J(auth)),operationKey:H('2'),intentDigest:H('3'),stageId:'pending',transitionDigest:H('4'),payloadRef:pb0RecordRef(J(debt)),consumptionDelta:{calls:1,wireBytes:100,work:0}}};
 const jb={...b,roots:[pb0RecordRef(J(journal))],nodes:[source,debt,auth,journal]};expect(pb0ValidateBundle(J(jb)).records).toBe(4);
 for(const change of [{operationDomain:'metadata-read'},{ownerRevision:2}]){const n={...journal,value:{...journal.value,...change}};expect(()=>pb0ValidateBundle(J({...jb,nodes:[source,debt,auth,n],roots:[pb0RecordRef(J(n))]}))).toThrow();}
});
test('PBG09 root references count toward the full reference budget',()=>{
 const job=fixture().nodes.find(n=>n.id==='job')!,jr=pb0RecordRef(J(job)),nodes=[job];
 for(let i=0;i<255;i++)nodes.push({schema:'cwc.e2-p0.pb0-record.v1',id:'r'+i,realmId:'realm',kind:'reservation',value:{jobRef:jr,priorPinRef:null,capacityDigest:H()}});
 expect(()=>pb0ValidateBundle(J({schema:'cwc.e2-p0.pb0-bundle.v1',realmId:'realm',roots:nodes.map(n=>pb0RecordRef(J(n))),nodes}))).toThrow('bundle-ref-budget');
});
test('PBG10 Begin binds the real descriptor and D seal without a cyclic future reference',()=>{
 const old=fixture(),job=old.nodes.find(n=>n.id==='job')!,reservation=old.nodes.find(n=>n.id==='reservation')!;
 const draft={...controlDraft(),targetSubject:{kind:'job',jobDigest:ownedDigest(job.value)}},k=JSON.parse(request(draft)).operationKey;
 const d={schema:'cwc.e2-p0.pb0-record.v1',id:'init',realmId:'realm',kind:'init-descriptor',value:{initId:'init',jobRef:pb0RecordRef(J(job)),beginControlKey:k,t0:0,originalDeadline:5000,reservationRefs:[pb0RecordRef(J(reservation))]}};
 const begin=request({...draft,payload:{initAdmissionRef:pb0RecordRef(J(d)),ticketPlanDigest:H('5')}}),p=JSON.parse(begin);
 const s={schema:'cwc.e2-p0.pb0-record.v1',id:'seal',realmId:'realm',kind:'init-seal',value:{descriptorRef:pb0RecordRef(J(d)),beginControlKey:k,controlIntentDigest:p.intentDigest}};
 const b={schema:'cwc.e2-p0.pb0-bundle.v1',realmId:'realm',roots:[pb0RecordRef(J(s))],nodes:[job,reservation,d,s]};
 expect(pb0BindInit(begin,J(b))).toMatchObject({staticInitBindingVerified:true,realReservationVerified:false});
 const bad={...s,value:{...s.value,controlIntentDigest:H('0')}};expect(()=>pb0BindInit(begin,J({...b,nodes:[job,reservation,d,bad],roots:[pb0RecordRef(J(bad))]}))).toThrow('init-D-seal');
 expect(()=>pb0BindInit(request({...draft,payload:{initAdmissionRef:R('init'),ticketPlanDigest:H('5')}}),J(b))).toThrow('init-request-binding');
});
/** Recompute every affected content ref, so rejection cannot rely on stale attacker-supplied hashes. */
function rehash(b:ReturnType<typeof fixture>){
 const originals=new Map(b.nodes.map(n=>[n.id,n])),done=new Map<string,Record<string,any>>(),active=new Set<string>();
 function get(id:string):Record<string,any>{
  if(done.has(id))return done.get(id)!;if(active.has(id))throw Error('test graph cycle');active.add(id);
  const n=originals.get(id);if(!n)throw Error('missing test node');
  function value(v:any):any{if(v===null||typeof v!=='object')return v;if(Array.isArray(v))return v.map(value);if('id'in v&&'sha256'in v&&'byteLength'in v)return pb0RecordRef(J(get(v.id)));return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,value(x)]));}
  const copy={...n,value:value(n.value)};active.delete(id);done.set(id,copy);return copy;
 }
 return {...b,nodes:b.nodes.map(n=>get(n.id)),roots:b.roots.map(r=>pb0RecordRef(J(get(r.id))))};
}
function twoWorkflows(options:{newInit?:boolean;shareInitId?:boolean;shareBeginKey?:boolean;newTickets?:boolean;sameWorkflowId?:boolean;grantLimit?:number}={}){
 const b=fixture(),w=b.nodes.find(n=>n.id==='workflow')!,w2=structuredClone(w);w2.id='workflow2';w2.value.workflowId=options.sameWorkflowId?w.value.workflowId:'workflow2';
 b.nodes.find(n=>n.id==='grant')!.value.workflowLimit=options.grantLimit??2;
 if(options.newInit){
  const d=structuredClone(b.nodes.find(n=>n.id==='init')!);d.id='init2';if(!options.shareInitId)d.value.initId='init2';if(!options.shareBeginKey)d.value.beginControlKey=H('8');
  const s=structuredClone(b.nodes.find(n=>n.id==='seal')!);s.id='seal2';s.value.descriptorRef=pb0RecordRef(J(d));s.value.beginControlKey=d.value.beginControlKey;s.value.controlIntentDigest=H('7');
  b.nodes.push(d,s);w2.value.initSealRef=pb0RecordRef(J(s));
 }
 if(options.newTickets)w2.value.ticketRefs=Array.from({length:8},(_,i)=>{const n={...structuredClone(b.nodes.find(n=>n.id==='ticket0')!),id:'new-ticket'+i};b.nodes.push(n);return pb0RecordRef(J(n));});
 b.nodes.push(w2);b.roots.push(pb0RecordRef(J(w2)));return rehash(b);
}
test.each([
 ['shared seal and tickets',{grantLimit:1}],['shared seal with fresh tickets',{newTickets:true}],
 ['aliased descriptor with same init ID',{newInit:true,shareInitId:true,newTickets:true}],
 ['aliased descriptor with same Begin key',{newInit:true,shareBeginKey:true,newTickets:true}]
] as const)('PBG11 %s cannot bind the same init admission to a second workflow',(_label,options)=>{
 const b=twoWorkflows(options);expect(()=>pb0ValidateBundle(J(b))).toThrow('workflow-init-reused');expect(()=>pb0ValidateBundle(J({...b,nodes:[...b.nodes].reverse()}))).toThrow('workflow-init-reused');
});
test('PBG12 distinct init admissions cannot give the same tickets to different workflows',()=>{
 const b=twoWorkflows({newInit:true});expect(()=>pb0ValidateBundle(J(b))).toThrow('workflow-ticket-reused');expect(()=>pb0ValidateBundle(J({...b,nodes:[...b.nodes].reverse()}))).toThrow('workflow-ticket-reused');
});
test('PBG13 a second record cannot alias an existing logical workflow ID',()=>{
 const b=twoWorkflows({newInit:true,newTickets:true,sameWorkflowId:true});expect(()=>pb0ValidateBundle(J(b))).toThrow('workflow-identity-reused');
});
test('PBG14 distinct allocations still obey the grant workflow limit',()=>{
 const b=twoWorkflows({newInit:true,newTickets:true,grantLimit:1});expect(()=>pb0ValidateBundle(J(b))).toThrow('grant-workflow-limit');
});
test('PBG15 independent init admissions tickets and workflow IDs can coexist within the grant limit',()=>{
 const b=twoWorkflows({newInit:true,newTickets:true});expect(pb0ValidateBundle(J(b))).toMatchObject({records:b.nodes.length,jobPermitIssued:false,runtimeAdmitted:false});
 expect(pb0ValidateBundle(J({...b,nodes:[...b.nodes].reverse()})).records).toBe(b.nodes.length);
 // Multiple edges from body / ready / debt to the SAME immutable workflow are ordinary reference sharing.
 expect(pb0ValidateBundle(J(fixture())).jobPermitIssued).toBe(false);
});
