import {expect,test} from 'vitest';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {pb0EncodeRequest,pb0DecodeRequest,pb0EncodeReply,pb0DecodeReply,PB0BudgetFixture} from '../../utils/gradleOwnedP0StateCodec.js';
import {readDraft,controlDraft,request,H,J,R,keys,policy} from '../fixtures/gradleOwnedP0StateFixture.js';
const client=keys(),server=keys();
const pin={principal:'registry',keyEpoch:1,owner:'registry',boot:H('b'),spki:server.publicKey.export({format:'der',type:'spki'}).toString('base64')};
const p=policy(client.publicKey.export({format:'der',type:'spki'}).toString('base64'));
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const metadata=(text='hello')=>{const bodyWire=J({data:text});return {kind:'metadata',sourceRefs:[R()],bodyWire,bodyDigest:sha(bodyWire),responseReadyRef:R('ready'),escapeRef:{...R('escape'),sha256:H('9')}};};
test('PBW01 real Ed25519 framed codec binds the request and response without issuing a permit',()=>{
 const r=request(),f=pb0EncodeRequest(r,client.privateKey);expect(pb0DecodeRequest(f,J(p),100).request.api).toBe('ReadPins');
 const response=pb0EncodeReply(r,J(metadata()),J(pin),server.privateKey);expect(pb0DecodeReply(response,r,J(pin)).result.kind).toBe('metadata');
 expect(()=>pb0DecodeRequest(f,J({...p,credentialId:'other'}),100)).toThrow();
});
test('PBW02 signature corruption wrong peers and reply reuse across nonces are rejected',()=>{
 const r=request(),response=pb0EncodeReply(r,J(metadata()),J(pin),server.privateKey),bad=Buffer.from(response);bad[bad.length-3]=bad[bad.length-3]!^1;
 expect(()=>pb0DecodeReply(bad,r,J(pin))).toThrow();expect(()=>pb0DecodeReply(response,request({...readDraft(),nonce:H('9')}),J(pin))).toThrow('reply-binding');
 expect(()=>pb0DecodeReply(response,r,J({...pin,spki:keys().publicKey.export({format:'der',type:'spki'}).toString('base64')}))).toThrow('codec-signature');
});
test('PBW03 noncanonical frames invalid UTF8 and truncated or excess headers are refused',()=>{
 const f=pb0EncodeRequest(request(),client.privateKey),wire=f.subarray(4).toString(),padded=Buffer.from(' '+wire),noncanonical=Buffer.alloc(padded.length+4);noncanonical.writeUInt32BE(padded.length);padded.copy(noncanonical,4);
 expect(()=>pb0DecodeRequest(noncanonical,J(p),100)).toThrow('codec-canonical');
 for(const x of [f.subarray(0,f.length-1),Buffer.concat([f,Buffer.from([0])]),Buffer.from([0,0,0,1,255])])expect(()=>pb0DecodeRequest(x,J(p),100)).toThrow();
});
test('PBW04 copying ignores instance copy and buffer getters and rejects SharedArrayBuffer storage',()=>{
 const f=pb0EncodeRequest(request(),client.privateKey);let calls=0;Object.defineProperty(f,'copy',{value:()=>{calls++;throw Error('copy');}});Object.defineProperty(f,'buffer',{get:()=>{calls++;return new SharedArrayBuffer(10);}});
 expect(pb0DecodeRequest(f,J(p),100).request.api).toBe('ReadPins');expect(calls).toBe(0);
 const s=Buffer.from(new SharedArrayBuffer(f.length));Uint8Array.prototype.set.call(s,f);Object.defineProperty(s,'buffer',{get:()=>new ArrayBuffer(s.length)});
 expect(()=>pb0DecodeRequest(s,J(p),100)).toThrow('frame-budget');
});
let largestFrame=0;
test('PBW05 complete real signed reply reaches its cap exactly and one extra byte is refused',()=>{
 const r=request(),base=pb0EncodeReply(r,J(metadata('')),J(pin),server.privateKey),n=1048576+4-base.length;
 const f=pb0EncodeReply(r,J(metadata('x'.repeat(n))),J(pin),server.privateKey);expect(f.length).toBe(1048580);largestFrame=f.length;
 expect(pb0DecodeReply(f,r,J(pin)).result.kind).toBe('metadata');expect(()=>pb0EncodeReply(r,J(metadata('x'.repeat(n+1))),J(pin),server.privateKey)).toThrow();
});
function init(){
 const begin=request(controlDraft()),b=JSON.parse(begin);
 const plan={schema:'cwc.e2-p0.pb0-budget.v1',profileDigest:b.profileDigest,initId:'init',realmId:'realm',jobDigest:H(),credentialId:'reader',credentialKeyEpoch:1,beginControlKey:b.operationKey,beginControlIntent:b.intentDigest,
  t0:0,originalDeadline:5000,jobDeadline:5000,grantDeadline:5000,approvalDeadline:5000,reservationDeadline:5000,prepaidRefs:{wire:R('wire'),memory:R('memory'),work:R('work'),store:R('store'),cleanup:R('cleanup')},sliceDigests:{initControl:H('4'),metadataRead:H('4'),metadataRetry:H('4'),metadataAudit:H('4')},parentWire:8388608,initWire:163856,metadataWire:8224752,initCalls:2,metadataCalls:8,workUpper:null,memoryUpper:null};
 return {begin,plan,budget:new PB0BudgetFixture(J(plan))};
}
function ready(){const x=init(),t=x.budget.reserve(x.begin,10),a=pb0EncodeRequest(x.begin,client.privateKey),b=pb0EncodeReply(x.begin,J(committed()),J(pin),server.privateKey);x.budget.complete(t,a,b,J(pin),11);return x;}
function committed(){return {kind:'control',outcome:'committed',origin:null,receiptRef:R('receipt'),anchorRef:R('anchor'),adoptionRef:R('adoption'),tombstoneRef:null,issuedRef:R('workflow')};}
function query(origin:Record<string,unknown>,kind='metadata-audit',op='query1'){return request({...controlDraft('QueryOperation',{origin}),operationId:op,controlBudgetSliceRef:{kind,sha256:H('4')}});}
const origin=(r:string)=>{const p=JSON.parse(r);return {domain:p.domain==='cwc.e2-p0.backend-request.v2'?'metadata-read':'control',owner:p.targetOwner,subject:{kind:'job',jobDigest:H()},operationKey:p.operationKey,intentDigest:p.intentDigest};};
test('PBW06 all ten calls consume separate slices and match actual signed codec bytes',()=>{
 const {begin,budget}=init();let actual=0,now=100;
 const complete=(r:string,result:unknown)=>{const t=budget.reserve(r,now++),a=pb0EncodeRequest(r,client.privateKey),b=pb0EncodeReply(r,J(result),J(pin),server.privateKey);actual+=a.length+b.length;budget.complete(t,a,b,J(pin),now++);};
 complete(begin,{...committed(),outcome:'pending',receiptRef:null,issuedRef:null});const first=request();
 const oi=origin(begin),qinit=query(oi,'init-control','init-query');complete(qinit,{...committed(),outcome:'historical',origin:oi,issuedRef:null,historicalIssuedRef:R('workflow')});
 budget.lose(budget.reserve(first,now++),now++);for(let i=1;i<5;i++)complete(request({...readDraft(),operationId:'read'+(i+1)}),metadata());
 complete(request({...readDraft(),operationId:'retry',budgetSliceRef:{kind:'metadata-retry',sha256:H('4')}}),metadata());
 for(let i=0;i<2;i++){const o=origin(first);complete(query(o,'metadata-audit','audit'+i),{...committed(),outcome:'historical',origin:o,issuedRef:null});}
 const s=budget.inspect();expect(s.counts).toEqual({begin:1,initQuery:1,read:5,retry:1,audit:2});expect(s.heldWire).toEqual({init:163856,metadata:6553664});expect(s.wireBytesObserved).toBe(actual);expect(actual).toBeLessThanOrEqual(6717520);expect(s.jobPermitIssued).toBe(false);expect(s.realReservationVerified).toBe(false);
 if(process.env.PB0_CODEC_OBSERVATION)writeFileSync(process.env.PB0_CODEC_OBSERVATION,J({calls:10,counts:s.counts,heldWire:s.heldWire,actualWire:actual,parentWire:8388608,worstCombinedWire:6717520,largestReplyFrame:largestFrame,jobPermitIssued:false,runtimeAdmitted:false,realReservationVerified:false,workUpper:null,memoryUpper:null}));
});
test('PBW07 lost initialization holds its charge and only the bounded origin query can follow',()=>{
 const {begin,budget}=init(),t=budget.reserve(begin,100);budget.lose(t,101);const before=budget.inspect();
 expect(before.heldWire.init).toBe(81928);expect(before.unknownAttempts).toBe(1);
 expect(()=>budget.reserve(request({...controlDraft(),nonce:H('9')}),102)).toThrow('budget-repeat-operation');
 const q=query(origin(begin),'init-control');budget.lose(budget.reserve(q,103),104);
 expect(budget.inspect().heldWire.init).toBe(163856);expect(()=>budget.reserve(query(origin(begin),'init-control','query2'),105)).toThrow('budget-init-query-count');
});
test('PBW08 retry consumes a new slot but the same original deadline and workflow',()=>{
 const {budget}=ready(),first=request();budget.lose(budget.reserve(first,100),101);
 const retry=request({...readDraft(),operationId:'retry',budgetSliceRef:{kind:'metadata-retry',sha256:H('4')}});budget.lose(budget.reserve(retry,102),103);
 expect(budget.inspect().heldWire.metadata).toBe(2*1064968);expect(()=>budget.reserve(request({...readDraft(),operationId:'retry2',budgetSliceRef:{kind:'metadata-retry',sha256:H('4')}}),104)).toThrow('budget-call-count');
 expect(()=>budget.reserve(request({...readDraft(),operationId:'different',workflowId:'new-workflow'}),104)).toThrow('budget-workflow-change');
 expect(()=>budget.reserve(request({...readDraft(),operationId:'extended',originalDeadline:5001}),104)).toThrow('budget-read-binding');
});
test('PBW09 failed verification preserves observed bytes and all held capacity and refuses late tickets',()=>{
 const {budget}=ready(),before=budget.inspect().wireBytesObserved,r=request(),t=budget.reserve(r,100),a=pb0EncodeRequest(r,client.privateKey),b=pb0EncodeReply(r,J(metadata()),J(pin),server.privateKey);
 expect(()=>budget.complete(t,a,b,J({...pin,boot:H('9')}),101)).toThrow();const s=budget.inspect();expect(s.closed).toBe(true);expect(s.wireBytesObserved-before).toBe(a.length+b.length);expect(s.heldWire.metadata).toBe(1064968);
 expect(()=>budget.complete(t,a,b,J(pin),102)).toThrow('budget-ticket');expect(()=>budget.reserve(request({...readDraft(),operationId:'late'}),102)).toThrow('budget-expired-or-closed');
});
test('PBW10 deadline reached during capture and close never recover spent reservations',()=>{
 const {budget}=ready(),r=request(),t=budget.reserve(r,100),a=pb0EncodeRequest(r,client.privateKey),b=pb0EncodeReply(r,J(metadata()),J(pin),server.privateKey);
 expect(()=>budget.complete(t,a,b,J(pin),5000)).toThrow('budget-expired-or-closed');expect(budget.inspect().heldWire.metadata).toBe(1064968);expect(budget.inspect().unknownAttempts).toBe(1);
 const x=init();x.budget.lose(x.budget.reserve(x.begin,100),101);x.budget.close();expect(()=>x.budget.reserve(query(origin(x.begin),'init-control'),102)).toThrow();expect(x.budget.inspect().heldWire.init).toBe(81928);
});
test('PBW11 token cross-fixture use request swapping and coordinated budget reduction are refused',()=>{
 const x=ready(),y=ready(),r=request(),t=x.budget.reserve(r,100),a=pb0EncodeRequest(r,client.privateKey),b=pb0EncodeReply(r,J(metadata()),J(pin),server.privateKey);
 expect(()=>y.budget.complete(t,a,b,J(pin),101)).toThrow('budget-ticket');
 expect(()=>x.budget.complete(t,pb0EncodeRequest(request({...readDraft(),nonce:H('9')}),client.privateKey),b,J(pin),101)).toThrow('budget-request-swap');
 for(const change of [{initCalls:1},{parentWire:6717520},{metadataWire:8388608},{originalDeadline:5001},{workUpper:0},{memoryUpper:0},{prepaidRefs:{...x.plan.prepaidRefs,cleanup:null}}])expect(()=>new PB0BudgetFixture(J({...x.plan,...change}))).toThrow();
});
test('PBW12 body substitutions source replacements and false query issuance fail before framing',()=>{
 const r=request();expect(()=>pb0EncodeReply(r,J({...metadata(),bodyDigest:H('0')}),J(pin),server.privateKey)).toThrow('reply-body');
 expect(()=>pb0EncodeReply(r,J({...metadata(),sourceRefs:[R('other')]}),J(pin),server.privateKey)).toThrow('reply-source');
 const q=query(origin(r));expect(()=>pb0EncodeReply(q,J({...committed(),outcome:'historical',origin:origin(r)}),J(pin),server.privateKey)).toThrow('query-result');
 expect(()=>pb0EncodeReply(q,J({...committed(),outcome:'absent',origin:origin(r),issuedRef:null,receiptRef:null,tombstoneRef:null}),J(pin),server.privateKey)).toThrow('absent-tombstone');
});
test('PBW13 origin owner cannot be exchanged while preserving its K D and recomputing query identity',()=>{
 const x=init();x.budget.lose(x.budget.reserve(x.begin,100),101);const oi={...origin(x.begin),owner:'controller'};
 const qi=request({...controlDraft('QueryOperation',{origin:oi}),targetOwner:'controller',controlBudgetSliceRef:{kind:'init-control',sha256:H('4')}});expect(()=>x.budget.reserve(qi,102)).toThrow('budget-init-query-origin');
 const y=ready(),r=request();y.budget.lose(y.budget.reserve(r,100),101);const or={...origin(r),owner:'controller'};
 const qr=request({...controlDraft('QueryOperation',{origin:or}),targetOwner:'controller',controlBudgetSliceRef:{kind:'metadata-audit',sha256:H('4')}});expect(()=>y.budget.reserve(qr,102)).toThrow('budget-audit-origin');
});
test('PBW14 embedded metadata JSON obeys the same depth bound as outer protocol JSON',()=>{
 const bodyWire='['.repeat(25)+'0'+']'.repeat(25),result={...metadata(),bodyWire,bodyDigest:sha(bodyWire)};
 expect(()=>pb0EncodeReply(request(),J(result),J(pin),server.privateKey)).toThrow('wire-depth');
});
test('PBW15 metadata reads start only on a workflow established by Begin or its bounded historical query',()=>{
 const x=init();expect(()=>x.budget.reserve(request(),100)).toThrow('budget-workflow-unestablished');
 const t=x.budget.reserve(x.begin,101),a=pb0EncodeRequest(x.begin,client.privateKey),b=pb0EncodeReply(x.begin,J({...committed(),outcome:'pending',receiptRef:null,issuedRef:null}),J(pin),server.privateKey);x.budget.complete(t,a,b,J(pin),102);
 expect(()=>x.budget.reserve(request(),103)).toThrow('budget-workflow-unestablished');
 const y=ready();expect(()=>y.budget.reserve(request({...readDraft(),workflowId:'self-declared'}),100)).toThrow('budget-workflow-change');expect(y.budget.reserve(request(),101)).toBeTruthy();
 const q=query(origin(x.begin),'init-control','init-query');
 expect(()=>pb0EncodeReply(x.begin,J({...committed(),historicalIssuedRef:R('workflow')}),J(pin),server.privateKey)).toThrow('historical-issued-ref');
 expect(()=>pb0EncodeReply(q,J({...committed(),outcome:'pending',origin:origin(x.begin),receiptRef:null,issuedRef:null,historicalIssuedRef:R('workflow')}),J(pin),server.privateKey)).toThrow('historical-issued-ref');
});
test('PBW16 retry initial query and metadata audit slots require a lost or unresolved original',()=>{
 const x=ready();expect(()=>x.budget.reserve(request({...readDraft(),operationId:'retry',budgetSliceRef:{kind:'metadata-retry',sha256:H('4')}}),100)).toThrow('budget-retry-without-loss');
 expect(()=>x.budget.reserve(query(origin(x.begin),'init-control','init-query'),100)).toThrow('budget-init-query-without-loss');
 const r=request(),t=x.budget.reserve(r,100),a=pb0EncodeRequest(r,client.privateKey),b=pb0EncodeReply(r,J(metadata()),J(pin),server.privateKey);x.budget.complete(t,a,b,J(pin),101);
 expect(()=>x.budget.reserve(query(origin(r)),102)).toThrow('budget-audit-origin');
 const lost=request({...readDraft(),operationId:'lost'});x.budget.lose(x.budget.reserve(lost,103),104);
 expect(x.budget.reserve(query(origin(lost)),105)).toBeTruthy();expect(x.budget.reserve(request({...readDraft(),operationId:'retry',budgetSliceRef:{kind:'metadata-retry',sha256:H('4')}}),106)).toBeTruthy();
});
