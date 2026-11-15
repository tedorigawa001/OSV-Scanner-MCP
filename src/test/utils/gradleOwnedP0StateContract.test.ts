import {expect,test} from 'vitest';
import {pb0SealRequest,pb0ParseRequest,pb0Identity,PB0_PROFILE_DIGEST,pb0Authorize,pb0CheckOrigin,pb0CheckReplay,pb0ValidateNewCAS,PB0_CONTROL_POLICY} from '../../utils/gradleOwnedP0StateContract.js';
import {ownedDigest} from '../../utils/gradleOwnedJson.js';
import {controlDraft,request as seal,V,R,H,J,keys,policy} from '../fixtures/gradleOwnedP0StateFixture.js';
import {pb0CheckTransition} from '../../utils/gradleOwnedP0StateMachine.js';
const h=(c='a')=>c.repeat(64),j=JSON.stringify;
const epoch=(name:string)=>({principal:name,instanceId:name+'-instance',bootEpoch:h('b'),storageEpoch:h('c'),keyEpoch:1,rootPairDigest:h('d')});
const vector={registry:epoch('registry'),custodian:epoch('custodian'),controller:epoch('controller')};
const delivery={serverBoot:h('b'),session:h('e'),sequence:1,nonce:h('f'),maxWaitMs:1000};
const read=()=>({domain:'cwc.e2-p0.backend-request.v2',profileDigest:PB0_PROFILE_DIGEST,realmId:'realm',jobDigest:h(),targetOwner:'registry',api:'ReadPins',purpose:'job-pins',clientCredentialId:'reader',clientKeyEpoch:1,operationId:'read1',workflowId:'workflow',grantRef:h('1'),currentPinRef:h('2'),authRevision:1,selectionRevision:1,exactSourceRefs:[{id:'source',sha256:h('3'),byteLength:10}],expectedEpochVector:vector,originalDeadline:5000,budgetSliceRef:{kind:'metadata-read',sha256:h('4')},...delivery});
test('PBC01 wire-only strict read identity normalizes insertion order and excludes transport nonce',()=>{
 const a=pb0SealRequest(j(read())),b=pb0SealRequest(j({...read(),nonce:h('9'),sequence:2}));
 expect(pb0Identity(a)).toEqual(pb0Identity(b));expect(pb0ParseRequest(a).domain).toBe('cwc.e2-p0.backend-request.v2');
 expect(pb0Identity(pb0SealRequest(j(Object.fromEntries(Object.entries(read()).reverse()))))).toEqual(pb0Identity(a));
});
test('PBC02 unknown fields duplicate JSON keys and changed self hashes are rejected',()=>{
 expect(()=>pb0SealRequest(j({...read(),extra:true}))).toThrow();expect(()=>pb0SealRequest(j(read()).replace('"realmId":"realm"','"realmId":"realm","realmId":"other"'))).toThrow();
 const a=JSON.parse(pb0SealRequest(j(read())));a.intentDigest=h('0');expect(()=>pb0ParseRequest(j(a))).toThrow();
});
test('PBC03 control K D work without an existing workflow and bind every payload field',()=>{
 const a=controlDraft(),b={...a,payload:{initAdmissionRef:R('other'),ticketPlanDigest:H('5')}};
 expect(pb0Identity(seal(a)).operationKey).toBe(pb0Identity(seal(b)).operationKey);expect(pb0Identity(seal(a)).intentDigest).not.toBe(pb0Identity(seal(b)).intentDigest);
 expect(()=>seal({...a,workflowId:'made-up'})).toThrow();
});
test('PBC04 realm controls reject fabricated job scope and keep query and origin identity separate',()=>{
 const a={...controlDraft('ActivateEpoch',{bootApprovalRef:R('boot'),preparedRefs:[R('p1'),R('p2'),R('p3')],fenceRefs:[R('f1'),R('f2'),R('f3')],expectedVector:V,newVector:V}),targetSubject:{kind:'realm',realmId:'realm'},expectedState:{kind:'realm-exact-revision',revision:2}};
 expect(pb0ParseRequest(seal(a)).api).toBe('ActivateEpoch');expect(()=>seal({...a,targetSubject:{kind:'job',jobDigest:H()}})).toThrow();
 const original=JSON.parse(seal()),origin={domain:'metadata-read',owner:'registry',subject:{kind:'job',jobDigest:H()},operationKey:original.operationKey,intentDigest:original.intentDigest};
 const q={...controlDraft('QueryOperation',{origin}),controlBudgetSliceRef:{kind:'metadata-audit',sha256:H('4')}};
 expect(pb0Identity(seal(q)).operationKey).not.toBe(origin.operationKey);expect(()=>seal({...q,targetOwner:'custodian'})).toThrow();
});
test('PBC05 origin substitution changes the query intent even when its own operation identity is unchanged',()=>{
 const origin={domain:'control',owner:'registry',subject:{kind:'job',jobDigest:H()},operationKey:H('7'),intentDigest:H('8')};
 const q=controlDraft('QueryOperation',{origin}),changed={...q,payload:{origin:{...origin,intentDigest:H('9')}}};
 expect(pb0Identity(seal(q)).operationKey).toBe(pb0Identity(seal(changed)).operationKey);expect(pb0Identity(seal(q)).intentDigest).not.toBe(pb0Identity(seal(changed)).intentDigest);
});
const publicKey=keys().publicKey.export({format:'der',type:'spki'}).toString('base64');
test('PBC06 read authorization binds credential purpose subject source pin and original deadline',()=>{
 const p=policy(publicKey);expect(pb0Authorize(seal(),J(p),100)).toMatchObject({status:'static-valid',jobPermitIssued:false,runtimeAdmitted:false,candidateReads:0});
 const variants=[{credentialId:'other'},{realmId:'other'},{grantRef:H('9')},{purposeSet:['job-live']},{sourceRefs:[R('other')]},{jobView:{...p.jobView,authRevision:2}},{revoked:true},{stopping:true},{serviceState:'control-ready'},{spkiDigest:H('0')},{separatedKeys:[p.spkiDigest,...p.separatedKeys.slice(1)]}];
 for(const change of variants)expect(()=>pb0Authorize(seal(),J({...p,...change}),100)).toThrow();
 for(const now of [-1,NaN,Infinity,5000])expect(()=>pb0Authorize(seal(),J(p),now)).toThrow();
 expect(()=>pb0Authorize(seal(),J({...p,prerequisites:{...p.prerequisites,capacityRef:null}}),100)).toThrow('unsupported');
});
test('PBC07 current epoch and preflight state cannot be restored by recomputing request hashes',()=>{
 const p=policy(publicKey);const stale={...read(),expectedEpochVector:{...V,registry:{...V.registry,bootEpoch:H('9')}}};
 expect(()=>pb0Authorize(seal(stale),J(p),100)).toThrow('old-epoch');
 const r={...read(),api:'ReadPreflight',purpose:'job-preflight',targetOwner:'controller'};
 const pp={...p,targetOwner:'controller',apiSet:['ReadPreflight'],purposeSet:['job-preflight'],jobView:{...p.jobView,state:'metadata-ready'}};
 expect(()=>pb0Authorize(seal(r),J(pp),100)).toThrow('read-job-state');
});
function saved(original:string,stage='control-committed'){
 const r=JSON.parse(original),isRead=r.domain==='cwc.e2-p0.backend-request.v2';
 return {schema:'cwc.e2-p0.pb0-origin-record.v1',origin:{domain:isRead?'metadata-read':'control',owner:r.targetOwner,subject:isRead?{kind:'job',jobDigest:r.jobDigest}:r.targetSubject,operationKey:r.operationKey,intentDigest:r.intentDigest},stage,originalRequestWire:original,receiptRef:R('receipt'),tombstoneRef:null,anchorRef:R('anchor'),adoptionRef:R('adoption')};
}
test('PBC08 later transaction does not reapply an old control CAS or create a new workflow',()=>{
 const original=seal(controlDraft()),l=saved(original),p=policy(publicKey),q={...controlDraft('QueryOperation',{origin:l.origin}),expectedState:{kind:'job-exact-revision',revision:2}};
 const audit={...p,role:'recovery-auditor',apiSet:['QueryOperation'],purposeSet:['audit-origin-operation'],allowedOrigins:[l.origin],jobView:{...p.jobView,revision:2}};
 expect(pb0Authorize(seal(q),J(audit),100).jobPermitIssued).toBe(false);expect(pb0CheckOrigin(seal(q),J(l),100)).toMatchObject({status:'historical',reapply:false,receiptRef:R('receipt')});
 expect(pb0CheckReplay(original,J(l))).toMatchObject({status:'historical',reapply:false});
 const issuer={...p,apiSet:['BeginWorkflow'],purposeSet:['reserve-metadata-workflow'],jobView:{...p.jobView,revision:2}};
 expect(()=>pb0ValidateNewCAS(original,J(issuer),100)).toThrow('CAS-job-revision');
 const change=seal({...controlDraft(),payload:{initAdmissionRef:R('changed'),ticketPlanDigest:H('5')}});expect(()=>pb0CheckReplay(change,J(l))).toThrow('operation-conflict');
});
test('PBC09 absent needs durable tombstone and late originals remain rejected with changed D',()=>{
 const original=seal(controlDraft()),l={...saved(original),stage:'absent-tombstoned',originalRequestWire:null,receiptRef:null,tombstoneRef:R('tombstone')};
 const q=seal(controlDraft('QueryOperation',{origin:l.origin}));expect(pb0CheckOrigin(q,J(l),100).status).toBe('absent');
 expect(()=>pb0CheckOrigin(q,J({...l,anchorRef:null}),100)).toThrow('durable-tombstone');expect(()=>pb0CheckReplay(original,J(l))).toThrow('origin-tombstoned');
 expect(()=>pb0CheckReplay(seal({...controlDraft(),payload:{initAdmissionRef:R('changed'),ticketPlanDigest:H('5')}}),J(l))).toThrow('origin-tombstoned');
 expect(()=>pb0CheckOrigin(q,J(l),5000)).toThrow('query-expired');
});
test('PBC10 unknown or unpersisted state never becomes no-effect or a fresh result',()=>{
 const l={...saved(seal()),stage:'unknown',originalRequestWire:null,receiptRef:null};
 const q=seal({...controlDraft('QueryOperation',{origin:l.origin}),controlBudgetSliceRef:{kind:'metadata-audit',sha256:H('4')}});
 expect(pb0CheckOrigin(q,J(l),100)).toMatchObject({status:'pending',reapply:false});expect(()=>pb0CheckOrigin(q,J({...l,stage:'absent-tombstoned'}),100)).toThrow();
 expect(()=>pb0CheckOrigin(q,J({...l,origin:{...l.origin,intentDigest:H('9')}}),100)).toThrow('origin-mismatch');
 expect(()=>pb0CheckOrigin(q,J(saved(seal(),'control-committed')),100)).toThrow('origin-stage-domain');
});
function transition(machine='job',from='registered',to='awaiting-approval'){
 const snapshot=(state:string,revision:number)=>({identity:H(),realmId:'realm',state,revision,authRevision:1,selectionRevision:1,originalDeadline:5000,spent:{calls:0,wireBytes:0,work:0}});
 const names=['descriptor','methodApproval','environmentApproval','pin','reservation','preflight','anchor','adoption','oldEpochInvalidation','managerFence','bootApproval','epochSelection','rootPin','journal','checkpoint','writerLock','drain','debt','allocator','quarantine','responseReady','escape','tombstone','grantRevoke'];
 return {schema:'cwc.e2-p0.pb0-transition.v1',machine,event:'advance',now:100,controlDeadline:6000,from:snapshot(from,1),to:snapshot(to,2),facts:Object.fromEntries(names.map(k=>[k,R(k)])),ownerFences:{registry:R('rf'),custodian:R('cf'),controller:R('tf')},ownerAdoptions:{registry:R('ra'),custodian:R('ca'),controller:R('ta')}};
}
test('PBC11 job progression requires approval evidence and refuses restoration or deadline extension',()=>{
 const t=transition('job','awaiting-approval','metadata-ready');expect(pb0CheckTransition(J(t)).jobPermitIssued).toBe(false);
 expect(()=>pb0CheckTransition(J({...t,facts:{...t.facts,methodApproval:null}}))).toThrow();
 expect(()=>pb0CheckTransition(J({...t,to:{...t.to,originalDeadline:6000}}))).toThrow();
 expect(()=>pb0CheckTransition(J(transition('job','settled','metadata-ready')))).toThrow();
});
test('PBC12 service cannot become operational without all owners adopted and old epochs fenced',()=>{
 const t=transition('service','control-ready','operational');expect(pb0CheckTransition(J(t)).runtimeAdmitted).toBe(false);
 expect(()=>pb0CheckTransition(J({...t,ownerAdoptions:{...t.ownerAdoptions,controller:null}}))).toThrow();
 expect(()=>pb0CheckTransition(J({...t,facts:{...t.facts,oldEpochInvalidation:null}}))).toThrow();
 expect(()=>pb0CheckTransition(J(transition('service','blocked','operational')))).toThrow();
});
test('PBC13 ready cannot finish before separately persisted escape and origin absence requires a tombstone',()=>{
 expect(()=>pb0CheckTransition(J(transition('read-stage','response-ready','historical')))).toThrow();
 const t=transition('read-stage','response-ready','response-may-have-escaped');expect(pb0CheckTransition(J(t)).jobPermitIssued).toBe(false);
 expect(()=>pb0CheckTransition(J({...t,facts:{...t.facts,escape:t.facts.responseReady}}))).toThrow();
 const absent=transition('origin','unknown','absent-tombstoned');expect(pb0CheckTransition(J(absent)).jobPermitIssued).toBe(false);
 expect(()=>pb0CheckTransition(J({...absent,facts:{...absent.facts,anchor:null}}))).toThrow();
});
const descriptor={schema:'cwc.e2-p0.job-descriptor.v2',jobId:{realmId:'realm',controllerJobId:'job',randomNonce:H('2')},sourceDigest:H(),inputManifestDigest:H('1'),toolLockDigest:H('2'),requestedApprovalSubjects:{method:H('3'),environment:H('4')},initialEpochVector:V,admittedAt:0,clockDomain:'clock',originalWallDeadline:10000,originalLeaseDeadline:10000};
const grant={credential:'reader',spkiDigest:policy(publicKey).spkiDigest,keyEpoch:1,apiSet:['ReadPins'],purposeSet:['job-pins'],sourceRefSet:[R()],authRevision:1,selectionRevision:1,epochVectorDigest:ownedDigest(V),workflowLimit:1,originalDeadline:5000};
const three=(s:string)=>[R(s+'1'),R(s+'2'),R(s+'3')];
const payloads:Record<string,unknown>={RegisterJob:{descriptor},InstallApproval:{approvalKind:'method',approvalRef:R('approval')},RecordReservation:{reservationRef:R('reservation')},PublishCurrentPin:{pinRef:R('pin'),expectedSelection:1},IssueReaderGrant:{grant},BeginWorkflow:{initAdmissionRef:R('init'),ticketPlanDigest:H('5')},RevokeReaderGrant:{grantId:'grant',expectedAuthRevision:1},RevokeJob:{jobDigest:H(),expectedAuthRevision:1},QueryOperation:{origin:{domain:'control',owner:'registry',subject:{kind:'job',jobDigest:H()},operationKey:H('7'),intentDigest:H('8')}},ReconcileDebt:{debtRefs:[R('debt')],fenceRefs:three('f'),drainRefs:three('d'),allocatorRefs:[R('allocator')],storeRefs:[R('store')]},ReportBootPrepared:{owner:'registry',bootRef:R('boot'),recoveryRefs:[R('recovery')],fenceRefs:[R('fence')]},ActivateEpoch:{bootApprovalRef:R('boot'),preparedRefs:three('p'),fenceRefs:three('f'),expectedVector:V,newVector:{...V,registry:{...V.registry,bootEpoch:H('9')}}},ReadRecoveryStatus:{owners:['registry']}};
test.each(Object.keys(payloads))('PBC14 %s has a strict payload and role bound to its real job or realm scope',api=>{
 const row=PB0_CONTROL_POLICY[api as keyof typeof PB0_CONTROL_POLICY];let r:Record<string,any>=controlDraft(api,payloads[api]);let p:Record<string,any>={...policy(publicKey),targetOwner:r.targetOwner,role:row.role,apiSet:[api],purposeSet:[row.purpose]};
 if(row.subject==='realm'){r={...r,targetSubject:{kind:'realm',realmId:'realm'},expectedState:{kind:'realm-exact-revision',revision:1}};p={...p,subject:r.targetSubject,jobView:null};}
 if(api==='RegisterJob'){r={...r,targetSubject:{kind:'job',jobDigest:ownedDigest(descriptor)},expectedState:{kind:'job-absent'}};p={...p,subject:r.targetSubject,jobView:null};}
 if(api==='QueryOperation')p.allowedOrigins=[(payloads[api] as any).origin];if(api==='ReportBootPrepared')p.ownedService='registry';if(api==='IssueReaderGrant')p.delegation=grant;
 expect(pb0Authorize(seal(r),J(p),100)).toMatchObject({status:'static-valid',jobPermitIssued:false});
 expect(()=>pb0Authorize(seal(r),J({...p,role:row.role==='producer-registration'?'job-reader':'producer-registration'}),100)).toThrow('control-scope');
 expect(()=>seal({...r,payload:{...(payloads[api] as object),unknown:true}})).toThrow('schema-invalid');
});
test('PBC15 issuer cannot broaden delegation or report another service boot after digest updates',()=>{
 const r=controlDraft('IssueReaderGrant',{grant}),p={...policy(publicKey),role:'job-access-issuer',apiSet:['IssueReaderGrant'],purposeSet:['delegate-exact-job'],delegation:grant};
 for(const change of [{credential:'other'},{workflowLimit:2},{sourceRefSet:[R('private')]},{originalDeadline:5001}])expect(()=>pb0Authorize(seal({...r,payload:{grant:{...grant,...change}}}),J(p),100)).toThrow();
 const boot=controlDraft('ReportBootPrepared',payloads.ReportBootPrepared),bp={...policy(publicKey),role:'registered-service-owner',apiSet:['ReportBootPrepared'],purposeSet:['report-recovery'],ownedService:'custodian',subject:{kind:'realm',realmId:'realm'},jobView:null};
 expect(()=>pb0Authorize(seal({...boot,targetSubject:bp.subject,expectedState:{kind:'realm-exact-revision',revision:1}}),J(bp),100)).toThrow('boot-report-owner');
});
test('PBC16 cleanup uses its own deadline but retains spent counters and cannot restore terminal state',()=>{
 const t=transition('job','revoking','fenced');t.now=5100;expect(pb0CheckTransition(J(t)).runtimeAdmitted).toBe(false);
 const paid={...t,from:{...t.from,spent:{calls:2,wireBytes:1000,work:10}},to:{...t.to,spent:{calls:1,wireBytes:1000,work:10}}};expect(()=>pb0CheckTransition(J(paid))).toThrow('consumption-reduced');
 const late=transition('job','metadata-ready','preflight-ready');late.now=5000;expect(()=>pb0CheckTransition(J(late))).toThrow('transition-job-expired');
});
test('PBC17 wire budget depth duplicate sources and caller object hooks fail before evaluating them',()=>{
 let invoked=0;expect(()=>pb0SealRequest({toJSON(){invoked++;return read();}} as unknown as string)).toThrow();expect(invoked).toBe(0);
 expect(()=>pb0SealRequest(' '.repeat(16385))).toThrow('wire-budget');expect(()=>pb0SealRequest('['.repeat(25)+'0'+']'.repeat(25))).toThrow('wire-depth');
 expect(()=>seal({...read(),exactSourceRefs:[R(),R()]})).toThrow();expect(()=>seal({...read(),sequence:0})).toThrow();
 const raw=seal().replace('"sequence":1','"sequence":-0');expect(()=>pb0ParseRequest(raw)).toThrow();
});
const casAPIs=['RevokeJob','RevokeReaderGrant','PublishCurrentPin'] as const;
function casRequest(api:typeof casAPIs[number],expected:number){return controlDraft(api,api==='PublishCurrentPin'?{pinRef:R('pin'),expectedSelection:expected}:api==='RevokeJob'?{jobDigest:H(),expectedAuthRevision:expected}:{grantId:'grant',expectedAuthRevision:expected});}
test.each(casAPIs)('PBC18 %s checks the payload CAS precondition even with a current job revision and recomputed K D',api=>{
 const p={...policy(publicKey),role:PB0_CONTROL_POLICY[api].role,apiSet:[api],purposeSet:[PB0_CONTROL_POLICY[api].purpose],jobView:{...policy(publicKey).jobView,revision:10,authRevision:7,selectionRevision:3}};
 const current=api==='PublishCurrentPin'?3:7,wire=(expected:number)=>seal({...casRequest(api,expected),expectedState:{kind:'job-exact-revision',revision:10}});
 expect(pb0ValidateNewCAS(wire(current),J(p),100)).toMatchObject({status:'static-valid',jobPermitIssued:false,runtimeAdmitted:false});
 for(const wrong of [1,current+1])expect(()=>pb0ValidateNewCAS(wire(wrong),J(p),100)).toThrow(api==='PublishCurrentPin'?'CAS-selection-revision':'CAS-auth-revision');
});
test.each(casAPIs)('PBC19 %s historical origin lookup never reapplies its stale payload CAS',api=>{
 const original=seal(casRequest(api,1)),l=saved(original),p=policy(publicKey),q={...controlDraft('QueryOperation',{origin:l.origin}),expectedState:{kind:'job-exact-revision',revision:10}};
 const audit={...p,role:'recovery-auditor',apiSet:['QueryOperation'],purposeSet:['audit-origin-operation'],allowedOrigins:[l.origin],jobView:{...p.jobView,revision:10,authRevision:7,selectionRevision:3}};
 expect(pb0Authorize(seal(q),J(audit),100).jobPermitIssued).toBe(false);
 expect(pb0CheckOrigin(seal(q),J(l),100)).toMatchObject({status:'historical',receiptRef:R('receipt'),reapply:false});
 expect(pb0CheckReplay(original,J(l))).toMatchObject({status:'historical',reapply:false});
});
test('PBC20 a lost RegisterJob reply is auditable against the current absent job state and resolves only by tombstone',()=>{
 const desc={schema:'cwc.e2-p0.job-descriptor.v2',jobId:{realmId:'realm',controllerJobId:'job1',randomNonce:H('1')},sourceDigest:H('2'),inputManifestDigest:H('3'),toolLockDigest:H('4'),requestedApprovalSubjects:{method:H('5'),environment:H('6')},initialEpochVector:V,admittedAt:0,clockDomain:'clock',originalWallDeadline:9000,originalLeaseDeadline:9000};
 const subject={kind:'job',jobDigest:ownedDigest(desc)},reg=JSON.parse(seal({...controlDraft('RegisterJob',{descriptor:desc}),targetSubject:subject,expectedState:{kind:'job-absent'}}));
 const origin={domain:'control',owner:'registry',subject,operationKey:reg.operationKey,intentDigest:reg.intentDigest};
 const q=seal({...controlDraft('QueryOperation',{origin}),targetSubject:subject,expectedState:{kind:'job-absent'}});
 const audit={...policy(publicKey),subject,role:'recovery-auditor',apiSet:['QueryOperation'],purposeSet:['audit-origin-operation'],allowedOrigins:[origin],jobView:null};
 expect(pb0Authorize(q,J(audit),100).jobPermitIssued).toBe(false);
 expect(()=>pb0Authorize(q,J({...audit,jobView:policy(publicKey).jobView}),100)).toThrow('audit-current-state');
 expect(()=>pb0Authorize(seal({...controlDraft('QueryOperation',{origin}),targetSubject:subject,expectedState:{kind:'job-exact-revision',revision:1}}),J(audit),100)).toThrow('audit-current-state');
 expect(()=>pb0ValidateNewCAS(q,J(audit),100)).toThrow('mutation-required');
 for(const api of ['InstallApproval','BeginWorkflow'])expect(()=>seal({...controlDraft(api,api==='InstallApproval'?{approvalKind:'method',approvalRef:R('approval')}:undefined),expectedState:{kind:'job-absent'}})).toThrow('job-state');
 const tomb={schema:'cwc.e2-p0.pb0-origin-record.v1',origin,stage:'absent-tombstoned',originalRequestWire:null,receiptRef:null,tombstoneRef:R('tombstone'),anchorRef:R('anchor'),adoptionRef:R('adoption')};
 expect(pb0CheckOrigin(q,J(tomb),100)).toMatchObject({status:'absent',reapply:false});expect(()=>pb0CheckReplay(seal({...controlDraft('RegisterJob',{descriptor:desc}),targetSubject:subject,expectedState:{kind:'job-absent'}}),J(tomb))).toThrow('origin-tombstoned');
});
