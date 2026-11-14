import {expect,test} from 'vitest';
import {P0Verifier,p0GateResultSchema,p0PreflightSchema} from '../../utils/gradleOwnedP0Contract.js';
import {ownedDigest as digest} from '../../utils/gradleOwnedJson.js';
import {p0Fixture} from '../fixtures/gradleOwnedP0Fixture.js';

test('P0S01 missing evidence is unsupported and never issues a permit',()=>{
 const verifier=new P0Verifier(null,()=>null);
 const r=verifier.check(JSON.stringify({schema:'cwc.e2-p0.control.v1',lock:null,method:null,environment:null,preflight:null}));
 expect(r.status).toBe('unsupported');
 expect(r.reasons).toHaveLength(8);
 expect(r.jobPermitIssued).toBe(false);
 expect(r.operations).toEqual({candidateReads:0,copies:0,execs:0,publications:0});
});

const denied=(r:ReturnType<P0Verifier['check']>,status:string)=>{
 expect(r.status).toBe(status);expect(p0GateResultSchema.safeParse(r).success).toBe(true);
 expect(r.operations).toEqual({candidateReads:0,copies:0,execs:0,publications:0});expect(r.jobPermitIssued).toBe(false);
};
const repinLock=(f:ReturnType<typeof p0Fixture>)=>{f.trust.lockDigest=digest(f.lock);f.preflight.payload.toolLockDigest=f.trust.lockDigest;f.resignPreflight();};

test.each(['solver','configuration'] as const)('P0S04 null %s is unsupported, not inferred from version labels',name=>{
 const f=p0Fixture();f.lock[name]=null;denied(f.verifier().check(f.wire()),'unsupported');
});

test.each(['method','environment','preflight'] as const)('P0S05 explicit unavailable %s is unsupported',name=>{
 const f=p0Fixture();denied(f.verifier().check(JSON.stringify({...f.packet,[name]:null})),'unsupported');
});

test.each(['reservations','enforcementWitness','clockMappingReceipt','bootstrapCapacity'] as const)('P0S06 signed missing %s cannot grant readiness',name=>{
 const f=p0Fixture();f.preflight.payload[name]=null;f.resignPreflight();denied(f.verifier().check(f.wire()),'unsupported');
});

test.each(['packet','lock','approval','preflight','limits','environment','job'] as const)('P0S07 strict schema rejects unknown %s fields even when re-signed',name=>{
 const f=p0Fixture();const target=({packet:f.packet,lock:f.lock,approval:f.method.payload,preflight:f.preflight.payload,limits:f.preflight.payload.limits,environment:f.lock.configuration!.environment,job:f.preflight.payload.job})[name];
 Object.assign(target,{verified:true});f.packet.method=f.signApproval(f.method.payload,2);f.resignPreflight();
 denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['lock','method','environment','preflight'] as const)('P0S08 omitted %s is malformed, explicit null denotes unavailable',name=>{
 const f=p0Fixture(),p:Record<string,unknown>={...f.packet};delete p[name];denied(f.verifier().check(JSON.stringify(p)),'invalid');
});

test.each(['sourceArchiveDigest','verifierBinaryDigest','compilerBinaryDigest','sysrootDigest','runtimeKernelProfile','runnerImageDigest','loaderDigest'] as const)('P0S09 same labels with altered %s cannot bypass independent lock pin',name=>{
 const f=p0Fixture();f.lock.digests[name]=digest('replacement');
 // Refresh producer/controller metadata, NOT the independent registry pin.
 f.preflight.payload.toolLockDigest=digest(f.lock);f.resignPreflight();denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['origin','version','platform','abi','fallback'] as const)('P0S10 changed %s is rejected after local digest refresh',name=>{
 const f=p0Fixture();
 if(name==='origin')Object.assign(f.lock.verifier,{origin:'https://mirror.invalid/cbmc'});
 if(name==='version')Object.assign(f.lock.compiler,{version:'Apple Clang 21.0.0'});
 if(name==='platform')Object.assign(f.lock,{imagePlatform:'linux/arm64'});
 if(name==='abi')Object.assign(f.lock,{abi:'ILP32'});
 if(name==='fallback')Object.assign(f.lock.solver!,{externalFallback:true});
 repinLock(f);denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['--no-standard-checks','--no-unwinding-assertions','--partial-loops','--cover','--depth','--property','--no-malloc-may-fail','--smt2','@response','--unknown'])('P0S11 unsafe/extra flag %s is refused even with refreshed pins',flag=>{
 const f=p0Fixture();f.lock.configuration!.verifierArgv.push(flag);repinLock(f);denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['PATH','LD_PRELOAD','CPATH','NODE_OPTIONS','DYLD_LIBRARY_PATH'])('P0S12 inherited %s is not in the exact environment',name=>{
 const f=p0Fixture();Object.assign(f.lock.configuration!.environment,{[name]:'/unapproved'});repinLock(f);denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['shell','network','tool-path','input-path','compiler-extra','loop-bound','property-duplicate'] as const)('P0S13 config %s cannot be accepted through a self pin refresh',name=>{
 const f=p0Fixture(),c=f.lock.configuration!;
 if(name==='shell')Object.assign(c,{shell:true});if(name==='network')Object.assign(c,{network:true});
 if(name==='tool-path')c.verifierPath='/usr/bin/cbmc';if(name==='input-path')c.inputPath='/job/input/../escape';
 if(name==='compiler-extra')c.compilerArgv.push('-fplugin=unapproved');
 if(name==='loop-bound')c.loops[0]!.bound=1;if(name==='property-duplicate')c.properties.push(c.properties[0]!);
 repinLock(f);denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['properties','loops'] as const)('P0S14 shrinking %s and regenerating local digests fails the independent lock pin',name=>{
 const f=p0Fixture();if(name==='properties')f.lock.configuration!.properties.pop();else{f.lock.configuration!.loops[0]!.bound=2;f.lock.configuration!.verifierArgv[16]='kernel.0:2';}
 f.preflight.payload.toolLockDigest=digest(f.lock);f.resignPreflight();denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['method','environment'] as const)('P0S15 altered %s signature is invalid',name=>{
 const f=p0Fixture();f.packet[name].signature='A'.repeat(86)+'==';denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['subjectDigest','methodOrEnvironmentProfileDigest','issuer','keyId','limitations'] as const)('P0S16 re-signed altered approval %s still fails pinned role/subject/envelope',field=>{
 const f=p0Fixture();Object.assign(f.method.payload,{[field]:field==='limitations'?['changed-limitations']:field.endsWith('Digest')?digest('changed'):'changed-identity'});
 f.packet.method=f.signApproval(f.method.payload,2);denied(f.verifier().check(f.wire()),'invalid');
});

test('P0S17 kind/key swaps and producer self-signing are rejected',()=>{
 for(const mode of ['swap','producer']){const f=p0Fixture();
  if(mode==='swap')f.packet.method=f.environment;else f.packet.method=f.signApproval({...f.method.payload,issuer:f.trust.roles[0]!.principal,keyId:f.trust.roles[0]!.keyId},0);
  denied(f.verifier().check(f.wire()),'invalid');}
});

test.each(['principal','keyId','spki','store'] as const)('P0S18 independent trusted configuration rejects shared %s across owners',field=>{
 const f=p0Fixture();f.trust.roles[2]![field]=f.trust.roles[0]![field];expect(()=>f.verifier()).toThrow('role-owner-separation-required');
});

test('P0S19 registry role/key pin cannot be embedded in submitted control metadata',()=>{
 const f=p0Fixture();denied(f.verifier().check(JSON.stringify({...f.packet,trustedPins:f.trust})),'invalid');
});

test.each(['jobId','nonce','incarnation','sequence','sourceDigest','inputManifestDigest','admittedAt','leaseDeadline'] as const)('P0S20 re-signed preflight cannot substitute original job %s',field=>{
 const f=p0Fixture();const v=f.preflight.payload.job[field];Object.assign(f.preflight.payload.job,{[field]:typeof v==='number'?v+1:field.endsWith('Digest')||field==='nonce'?digest('other'):'other'});
 f.resignPreflight();denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['registryRevision','registryPinDigest','toolLockDigest','methodApprovalDigest','environmentApprovalDigest','controllerRevision','reservationFence','sealedInputDigest'] as const)('P0S21 re-signed preflight %s is bound to independent context',field=>{
 const f=p0Fixture();const v=f.preflight.payload[field];Object.assign(f.preflight.payload,{[field]:typeof v==='number'?v+1:digest('other')});f.resignPreflight();denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['reservations','enforcementWitness','bootstrapCapacity','clockMappingReceipt'] as const)('P0S22 re-signed changed evidence ref %s is refused',field=>{
 const f=p0Fixture();if(field==='reservations')f.preflight.payload.reservations!.job.sha256=digest('other');else f.preflight.payload[field]!.sha256=digest('other');
 f.resignPreflight();denied(f.verifier().check(f.wire()),'invalid');
});

test.each(['runnerMemory','disk','store','inodes','watchdog','bootstrap','stdout','outstandingJobs'] as const)('P0S23 different %s reservation/limit is not the approved workspace profile',field=>{
 const f=p0Fixture();f.preflight.payload.limits[field]--;f.resignPreflight();denied(f.verifier().check(f.wire()),'workspace-budget-exceeded');
});

test.each(['methodRevoked','environmentRevoked','stopping','fatal'] as const)('P0S24 fresh %s refusal is latched even after restoration',field=>{
 const f=p0Fixture(),v=f.verifier();expect(v.check(f.wire()).status).toBe('static-valid');f.live[field]=true;denied(v.check(f.wire()),'revoked-or-expired');f.live[field]=false;denied(v.check(f.wire()),'revoked-or-expired');
});

test.each(['registryRevision','registryPinDigest','controllerRevision','reservationFence','incarnation','reservationDigest','enforcementDigest','bootstrapDigest','clockReceiptDigest'] as const)('P0S25 current %s change cannot reuse an old reservation stamp',field=>{
 const f=p0Fixture(),v=f.verifier(),old=f.live[field];Object.assign(f.live,{[field]:typeof old==='number'?old+1:field.endsWith('Digest')?digest('other'):'other'});
 denied(v.check(f.wire()),'revoked-or-expired');Object.assign(f.live,{[field]:old});denied(v.check(f.wire()),'revoked-or-expired');
});

test.each([599999,600000,600001,605000])('P0S26 original deadline, equality and cleanup grace at %d never reset',now=>{
 const f=p0Fixture();f.live.now=now;const r=f.verifier().check(f.wire());
 if(now<600000)expect(r.status).toBe('static-valid');else denied(r,'revoked-or-expired');
});

test('P0S27 original lease and conservatively mapped approval deadline dominate job deadline',()=>{
 for(const kind of ['lease','method','environment'] as const){const f=p0Fixture();
  if(kind==='lease'){f.trust.job.leaseDeadline=500000;f.preflight.payload.job.leaseDeadline=500000;}
  else{f.packet[kind]=f.signApproval({...f.packet[kind].payload,validUntil:501000},kind==='method'?2:3);f.trust[kind].envelopeDigest=digest(f.packet[kind]);f.preflight.payload[kind==='method'?'methodApprovalDigest':'environmentApprovalDigest']=f.trust[kind].envelopeDigest;}
  f.resignPreflight();f.live.now=500000;const r=f.verifier().check(f.wire());denied(r,'revoked-or-expired');expect(r.effectiveDeadline).toBe(500000);
 }
});

test('P0S28 mapped clock rollback and unbounded mapping are refused',()=>{
 const f=p0Fixture(),v=f.verifier();expect(v.check(f.wire()).status).toBe('static-valid');f.live.now--;denied(v.check(f.wire()),'revoked-or-expired');
 const g=p0Fixture();g.trust.clock.errorMs=1001;expect(()=>g.verifier()).toThrow();
});

test('P0S29 retry cannot extend admission time or original deadline',()=>{
 const f=p0Fixture(),v=f.verifier();f.live.now=600000;f.preflight.payload.job.admittedAt=1000;f.resignPreflight();denied(v.check(f.wire()),'invalid');
 f.preflight.payload.job.admittedAt=0;f.resignPreflight();denied(v.check(f.wire()),'revoked-or-expired');
});

test('P0S30 post-copy evidence and sealed input are required before exec metadata validation',()=>{
 const f=p0Fixture();denied(f.verifier().check(f.wire(),'pre-exec'),'invalid');f.preflight.payload.phase='copied';f.resignPreflight();expect(f.verifier().check(f.wire(),'pre-exec').status).toBe('static-valid');
 f.live.environmentRevoked=true;denied(f.verifier().check(f.wire(),'pre-exec'),'revoked-or-expired');
});

function sealed(){const f=p0Fixture();f.preflight.payload.phase='sealed';f.preflight.payload.result={status:'success',propertyClosureDigest:digest(f.lock.configuration!.properties),loopClosureDigest:digest(f.lock.configuration!.loops)};
 f.preflight.payload.drainWitness={id:'drain',sha256:digest('drain'),byteLength:128};f.preflight.payload.sealWitness={id:'seal',sha256:digest('seal'),byteLength:128};f.resignPreflight();return f;}

const phases=['reserved','copied','result-validated','drained','sealed'] as const,gates=['pre-copy','pre-exec','pre-publish'] as const;
/** The only gate at which each preflight phase may be presented; intermediate stages have none. */
const ownGate:Record<typeof phases[number],typeof gates[number]|null>={reserved:'pre-copy',copied:'pre-exec','result-validated':null,drained:null,sealed:'pre-publish'};
function atPhase(phase:ReturnType<typeof p0Fixture>['preflight']['payload']['phase']){
 const f=sealed(),p=f.preflight.payload;p.phase=phase;
 if(phase==='reserved'||phase==='copied'){p.result=null;p.drainWitness=null;p.sealWitness=null;}
 if(phase==='result-validated'){p.drainWitness=null;p.sealWitness=null;}
 if(phase==='drained')p.sealWitness=null;
 f.resignPreflight();return f;
}

test('P0S31 full signed result/drain/seal metadata is still not publication authority',()=>{
 const f=sealed(),r=f.verifier().check(f.wire(),'pre-publish');expect(r.status).toBe('static-valid');expect(r.operations.publications).toBe(0);expect(r.jobPermitIssued).toBe(false);
});

test.each(['failed','unknown'] as const)('P0S32 %s result cannot produce a success envelope',status=>{
 const f=sealed();f.preflight.payload.result!.status=status;f.resignPreflight();denied(f.verifier().check(f.wire(),'pre-publish'),'failed-no-success-envelope');
});

test.each(['result','drainWitness','sealWitness'] as const)('P0S33 missing %s is not substituted by tool exit success',name=>{
 const f=sealed();f.preflight.payload[name]=null;f.resignPreflight();denied(f.verifier().check(f.wire(),'pre-publish'),name==='result'?'failed-no-success-envelope':'invalid');
});

test.each(['propertyClosureDigest','loopClosureDigest'] as const)('P0S34 altered result %s is rejected after re-signing',name=>{
 const f=sealed();f.preflight.payload.result![name]=digest('partial');f.resignPreflight();denied(f.verifier().check(f.wire(),'pre-publish'),'invalid');
});

test.each(['result-validated','drained','sealed'] as const)('P0S35 deadline after %s cannot be extended by seal/tool success',phase=>{
 const f=atPhase(phase);f.live.now=600001;
 // Intermediate stages have no accepting gate; sealed metadata reaches the original-deadline check at pre-publish.
 if(phase==='sealed'){denied(f.verifier().check(f.wire(),'pre-publish'),'revoked-or-expired');return;}
 for(const gate of gates)denied(f.verifier().check(f.wire(),gate),'invalid');
});

test('P0S36 revocation during the live-port callback is checked before returning and reentry poisons outer validation',()=>{
 const f=p0Fixture();const v=f.verifier(()=>{f.live.environmentRevoked=true;return JSON.stringify(f.live);});denied(v.check(f.wire()),'revoked-or-expired');
 const g=p0Fixture();let inner:ReturnType<P0Verifier['check']>|null=null;let w:P0Verifier;
 w=g.verifier(()=>{inner=w.check(g.wire());return JSON.stringify(g.live);});denied(w.check(g.wire()),'revoked-or-expired');expect(inner).toMatchObject({status:'revoked-or-expired'});
});

test('P0S37 no live authority is unsupported, caller now/current fields are rejected',()=>{
 const f=p0Fixture();denied(f.verifier(()=>null).check(f.wire()),'unsupported');denied(f.verifier().check(JSON.stringify({...f.packet,now:0,current:true})),'invalid');
});

test.each(['duplicate','depth','bytes','nonfinite','coercion'] as const)('P0S38 bounded wire rejects %s without reading a candidate',mode=>{
 const f=p0Fixture();let wire=f.wire();
 if(mode==='duplicate')wire=wire.replace('"schema":','"schema":"x","schema":');
 if(mode==='depth')wire='['.repeat(25)+'0'+']'.repeat(25);
 if(mode==='bytes')wire=' '.repeat(1048577);
 if(mode==='nonfinite')wire=wire.replace('"sequence":1','"sequence":1e999');
 if(mode==='coercion')wire=wire.replace('"sequence":1','"sequence":"1"');
 denied(f.verifier().check(wire),mode==='depth'||mode==='bytes'?'workspace-budget-exceeded':'invalid');
});

test('P0S39 object getters are never used as submitted wire',()=>{
 const f=p0Fixture();let reads=0;const object={get lock(){reads++;return f.lock;},toString(){reads++;return f.wire();}};
 denied(f.verifier().check(object as unknown as string),'invalid');expect(reads).toBe(0);
});

test('P0S40 insertion order changes preserve canonical signatures and independent digests',()=>{
 const f=p0Fixture();const p=Object.fromEntries(Object.entries(f.method.payload).reverse());f.packet.method={payload:p as typeof f.method.payload,signature:f.method.signature};
 expect(f.verifier().check(f.wire()).status).toBe('static-valid');
});

test('P0S41 alias encodings cannot disguise the same public key in two roles',()=>{
 const f=p0Fixture();f.trust.roles[2]!.spki=f.trust.roles[0]!.spki+'\n';expect(()=>f.verifier()).toThrow();
});

test('P0S42 a resolved LLVM Git commit may have 40 hex digits',()=>{
 const f=p0Fixture();f.lock.compiler.sourceCommit='b'.repeat(40);repinLock(f);expect(f.verifier().check(f.wire()).status).toBe('static-valid');
});

test.each(['method','environment'] as const)('P0S43 negative mapped %s expiry returns a strict refusal at every gate and stays invalidated',kind=>{
 for(const phase of ['pre-copy','pre-exec','pre-publish'] as const){
  const f=phase==='pre-publish'?sealed():p0Fixture();
  if(phase==='pre-exec')f.preflight.payload.phase='copied';
  f.trust.clock.utcAt=4000000;
  for(const k of ['method','environment'] as const){
   f.packet[k]=f.signApproval({...f.packet[k].payload,validUntil:k===kind?3600000:8000000},k==='method'?2:3);
   f.trust[k].envelopeDigest=digest(f.packet[k]);
   f.preflight.payload[k==='method'?'methodApprovalDigest':'environmentApprovalDigest']=f.trust[k].envelopeDigest;
  }
  f.resignPreflight();let liveReads=0;
  const v=f.verifier(()=>{liveReads++;return JSON.stringify(f.live);});
  const r=v.check(f.wire(),phase);denied(r,'revoked-or-expired');expect(r.effectiveDeadline).toBeNull();
  denied(v.check(f.wire(),phase),'revoked-or-expired');expect(liveReads).toBe(0);
 }
});

const failedPhaseCases=(['reserved','copied','result-validated','drained','sealed'] as const).flatMap(phase=>(['failed','unknown'] as const).map(status=>({phase,status})));
test.each(failedPhaseCases)('P0S44 re-signed $phase with $status result is refused by schema and every gate',({phase,status})=>{
 const f=atPhase(phase);f.preflight.payload.result={status,propertyClosureDigest:digest(f.lock.configuration!.properties),loopClosureDigest:digest(f.lock.configuration!.loops)};f.resignPreflight();
 expect(p0PreflightSchema.safeParse(f.preflight).success).toBe(false);
 for(const gate of ['pre-copy','pre-exec','pre-publish'] as const)denied(f.verifier().check(f.wire(),gate),'failed-no-success-envelope');
});

const inconsistentCases=[
 {phase:'reserved',field:'result',value:'success'},
 {phase:'reserved',field:'drainWitness',value:'witness'},
 {phase:'copied',field:'sealWitness',value:'witness'},
 {phase:'result-validated',field:'result',value:'missing'},
 {phase:'result-validated',field:'drainWitness',value:'witness'},
 {phase:'drained',field:'drainWitness',value:'missing'},
 {phase:'drained',field:'sealWitness',value:'witness'},
 {phase:'sealed',field:'sealWitness',value:'missing'}
] as const;
test.each(inconsistentCases)('P0S45 $phase with $value $field violates phase evidence requirements',({phase,field,value})=>{
 const f=atPhase(phase),p=f.preflight.payload;
 Object.assign(p,{[field]:value==='missing'?null:value==='success'?sealed().preflight.payload.result:{id:'future-witness',sha256:digest('future-witness'),byteLength:128}});
 f.resignPreflight();expect(p0PreflightSchema.safeParse(f.preflight).success).toBe(false);
 denied(f.verifier().check(f.wire()),field==='result'&&value==='missing'?'failed-no-success-envelope':'invalid');
});

test.each(phases)('P0S46 valid %s evidence is schema-valid and statically valid only at its own gate without a runtime permit',phase=>{
 const f=atPhase(phase);expect(p0PreflightSchema.safeParse(f.preflight).success).toBe(true);
 const own=ownGate[phase];
 if(own){const r=f.verifier().check(f.wire(),own);expect(r.status).toBe('static-valid');expect(r.jobPermitIssued).toBe(false);}
 else for(const gate of gates)expect(f.verifier().check(f.wire(),gate).status).toBe('invalid');
});

const gateReason={'pre-copy':'pre-copy-reserved-phase-required','pre-exec':'post-copy-evidence-required','pre-publish':'drain-seal-evidence-required'} as const;
test.each(phases.flatMap(phase=>gates.map(gate=>({phase,gate}))))('P0S48 $phase preflight at $gate is accepted only by its own gate',({phase,gate})=>{
 const f=atPhase(phase),r=f.verifier().check(f.wire(),gate);
 if(ownGate[phase]===gate){expect(r.status).toBe('static-valid');expect(r.jobPermitIssued).toBe(false);expect(r.operations.publications).toBe(0);}
 else{denied(r,'invalid');expect(r.reasons).toEqual([gateReason[gate]]);}
});

test('P0S47 malformed failure metadata stays invalid rather than hiding shape errors',()=>{
 const f=sealed();f.preflight.payload.result!.status='failed';Object.assign(f.preflight.payload,{verified:true});f.resignPreflight();
 denied(f.verifier().check(f.wire()),'invalid');
});

test('P0S02 real Ed25519 fixture verifies metadata only, without a runtime permit',()=>{
 const f=p0Fixture(),r=f.verifier().check(f.wire());
 expect(r.status).toBe('static-valid');expect(r.effectiveDeadline).toBe(600000);
 expect(r.jobPermitIssued).toBe(false);expect(r.runtimeAdmitted).toBe(false);
});

test.each(['sourceArchiveDigest','verifierBinaryDigest','loaderDigest','methodProfileDigest'] as const)('P0S03 null %s evidence remains unsupported',name=>{
 const f=p0Fixture();f.lock.digests[name]=null;
 expect(f.verifier().check(f.wire())).toMatchObject({status:'unsupported',reasons:['tool-image-unavailable']});
});
