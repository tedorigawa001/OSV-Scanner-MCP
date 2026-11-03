import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {verifyNativeTransportRun} from '../fixtures/gradleOwnedTransport.js';
import {canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
const auth=fileURLToPath(new URL('../fixtures/q2b_b1ct/auth.py',import.meta.url));
it('rejects duplicate JSON keys and noncanonical frames before authentication',()=>{
 const script=`import runpy\nm=runpy.run_path(${JSON.stringify(auth)})\nfor raw in [b'{"a":1,"a":2}', b'{ "a":1}', b'{"a":1.0}', b'{"a":NaN}']:\n try: m['decode'](raw)\n except ValueError: pass\n else: raise RuntimeError('invalid frame accepted')\nassert m['decode'](b'{"a":1}')=={'a':1}\n`;
 expect(()=>execFileSync('python3',['-I','-c',script],{stdio:'pipe',timeout:10000})).not.toThrow();
});
it('requires independent manager/controller pins and a signed native run before accepting any evidence',()=>{
 expect(()=>verifyNativeTransportRun({record:Buffer.from('{}'),managerKeyDigest:'0'.repeat(64),controllerKeyDigest:'0'.repeat(64),manifestDigest:'0'.repeat(64),runId:'test'})).toThrow();
});
it('builds an offline transport-only profile with separate public pins and no credentials in rootfs',()=>{
 const out=mkdtempSync(join(tmpdir(),'q2b-auth-'));
 try{
  execFileSync('python3',['-I',fileURLToPath(new URL('../fixtures/q2b_b1ct/build_fixture.py',import.meta.url)),out],{stdio:'pipe',timeout:10000});
  const bundle=JSON.parse(readFileSync(join(out,'bundle.json'),'utf8'));
  expect(bundle.scope).toBe('native-transport-diagnostic-only');expect(bundle.compiled).toBe(false);expect(bundle.nativeIsolationVerified).toBe(false);
  expect(bundle.files.some((f:{path:string})=>f.path.endsWith('manager.pub'))).toBe(true);
  expect(bundle.files.some((f:{path:string})=>f.path.endsWith('.key')||f.path.includes('secrets'))).toBe(false);
  const service=readFileSync(join(out,'rootfs/etc/systemd/system/osv-q2b-b1ct.service'),'utf8');expect(service).toContain('ExecStart=/opt/osv-q2b/b1ct/launcher --profile b1ct --instance b1ct');
 }finally{rmSync(out,{recursive:true,force:true});}
});
const recordPath=new URL('../../../docs/validation/gradle-q2b-b1ct-transport-2026-11-03.json',import.meta.url);
const pinPath=new URL('../../../docs/validation/gradle-q2b-b1ct-transport-2026-11-03.bindings.json',import.meta.url);
it('verifies both native B1a launch bindings, all 28 authenticated-transport cases and the controlled FD drain',()=>{
 const result=verifyNativeTransportRun({record:readFileSync(recordPath),...JSON.parse(readFileSync(pinPath,'utf8'))});
 expect(result).toEqual({verifiedCases:28,acceptedCases:5,nativeLaunchBindingsVerified:2,authenticatedTransportObserved:true,restartFdDrainObserved:true,
  nativeIsolationVerified:false,profileApproved:false,backendEligible:false,originalReadsSkipped:0});
});
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const decoded=(value:string)=>JSON.parse(Buffer.from(value,'base64').toString('utf8'));
const encoded=(value:unknown)=>Buffer.from(canonicalOwnedJson(value,512*1024)).toString('base64');
function verifyRecord(record:any,pins=JSON.parse(readFileSync(pinPath,'utf8'))){return verifyNativeTransportRun({record:Buffer.from(JSON.stringify(record)),...pins});}
it('binds the native evidence to the actual immutable source receipt and independent signer pins',()=>{
 const record=JSON.parse(readFileSync(recordPath,'utf8')),body=decoded(record.transportEvidence).body;
 expect(body.sources).toHaveLength(16);
 for(const source of body.sources)expect(sha(readFileSync(new URL('../fixtures/'+source.path,import.meta.url)))).toBe(source.sha256);
 expect(body.observation.lifecycle.referencesAfterHolderExit).toEqual([]);
 expect(body.observation.cases.reduce((n:number,c:any)=>n+c.acceptedOperations,0)).toBe(13);
});
it.each(['manager','controller','manifest'])('refuses the wrong independent %s pin',kind=>{
 const record=JSON.parse(readFileSync(recordPath,'utf8')),pins=JSON.parse(readFileSync(pinPath,'utf8'));
 pins[kind==='manifest'?'manifestDigest':kind+'KeyDigest']='0'.repeat(64);expect(()=>verifyRecord(record,pins)).toThrow();
});
it.each(['controller','manager'])('rejects a corrupted %s signature',role=>{
 const record=JSON.parse(readFileSync(recordPath,'utf8'));
 if(role==='controller'){const value=decoded(record.transportEvidence);value.signature=Buffer.alloc(64).toString('base64');record.transportEvidence=encoded(value);}
 else{const value=decoded(record.launches[0].launch);value.signature=Buffer.alloc(64).toString('base64');record.launches[0].launch=encoded(value);}
 expect(()=>verifyRecord(record)).toThrow();
});

function resigned(fault:string){
 const record=JSON.parse(readFileSync(recordPath,'utf8')),pins=JSON.parse(readFileSync(pinPath,'utf8')),body=decoded(record.transportEvidence).body,o=body.observation;
 const phase=o.boots[0].phases[1],c=(name:string)=>o.cases.find((v:any)=>v.case===name);
 switch(fault){
  case 'bootstrap-manifest':for(const p of o.boots[0].phases){const b=Buffer.from(p.bootstrapHex,'hex');b[168]=b[168]!^1;p.bootstrapHex=b.toString('hex');}break;
  case 'bootstrap-launch':for(const p of o.boots[0].phases){const b=Buffer.from(p.bootstrapHex,'hex');b[200]=b[200]!^1;p.bootstrapHex=b.toString('hex');}break;
  case 'bootstrap-cookie':for(const p of o.boots[0].phases){const b=Buffer.from(p.bootstrapHex,'hex');b.writeBigUInt64LE(b.readBigUInt64LE(32)+1n,32);p.bootstrapHex=b.toString('hex');}break;
  case 'saved-uid':phase.uid[2]=0;break;
  case 'capabilities':phase.capabilities.CapEff='0000000000000080';break;
  case 'extra-fd':phase.fds.push({...phase.fds[0],fd:7});break;
  case 'bootstrap-writable':phase.fds.find((v:any)=>v.fd===6).flags|=2;break;
  case 'exec-missing':o.boots[0].execs.pop();break;
  case 'exec-digest':o.boots[0].execs[0].sha256='0'.repeat(64);break;
  case 'argv':phase.argv.push('-c');break;
  case 'activation-names':o.boots[0].phases[0].environment.LISTEN_FDNAMES='reader:reader:publish';break;
  case 'operation-count':c('wrong-role').acceptedOperations=1;break;
  case 'missing-case':o.cases.pop();break;
  case 'duplicate-case':o.cases[1]=o.cases[0];break;
  case 'server-proof-sent':c('server-proof').clientProofFrames=1;break;
  case 'timeout-as-refusal':c('server-proof').reason='timed out';break;
  case 'unauthenticated-negative':c('unknown-field').authenticated=false;break;
  case 'missing-rejection':c('invalid-integer').serverRejectionReasons=['timed out'];break;
  case 'provider-credential':c('honest-reader').providerCredentials[0][1]=0;break;
  case 'custodian-as-provider':c('wrong-provider').custodian[1]=1101;break;
  case 'forward-initial-gid':c('cross-uid-fragment').initialIdentity.gid[2]=0;break;
  case 'same-uid-control':c('same-uid-forward').outcome='rejected';break;
  case 'drain-not-empty':o.lifecycle.referencesAfterHolderExit=[o.lifecycle.referencesBeforeReclaim[0]];break;
  case 'holder-wrong-gid':o.lifecycle.holderIdentity.gid[2]=0;break;
  case 'missing-client-reference':o.lifecycle.referencesWithOldClient=o.lifecycle.referencesWithOldClient.filter((v:any)=>v.pid!==o.lifecycle.controllerPid);break;
  case 'source-closure':body.sources[0]=body.sources[1];break;
  case 'adoption':o.backendEligible=true;break;
  case 'skipped-read':o.originalReadsSkipped=1;break;
 }
 const keys=generateKeyPairSync('ed25519'),publicDer=keys.publicKey.export({format:'der',type:'spki'});
 record.controllerPublicKeyDer=publicDer.toString('base64');pins.controllerKeyDigest=sha(publicDer);
 const seal=(value:any)=>{const {signature,...unsigned}=value;return encoded({...unsigned,signature:sign(null,Buffer.from(canonicalOwnedJson(unsigned,512*1024)),keys.privateKey).toString('base64')});};
 for(let i=0;i<2;i++){
  const diagnostic=decoded(record.launches[i].diagnostic);
  diagnostic.body.phases=o.boots[i].phases;diagnostic.body.execs=o.boots[i].execs;diagnostic.body.artifacts=o.artifacts;
  if(fault==='synthetic-mode')diagnostic.body.mode='synthetic-static';
  record.launches[i].diagnostic=seal(diagnostic);
 }
 record.transportEvidence=seal({...decoded(record.transportEvidence),body});
 if(fault==='same-key'){record.managerPublicKeyDer=record.controllerPublicKeyDer;pins.managerKeyDigest=pins.controllerKeyDigest;}
 return {record,pins};
}
it.each(['bootstrap-manifest','bootstrap-launch','bootstrap-cookie','saved-uid','capabilities','extra-fd','bootstrap-writable','exec-missing','exec-digest','argv',
 'activation-names','synthetic-mode','operation-count','missing-case','duplicate-case','server-proof-sent','timeout-as-refusal','unauthenticated-negative',
 'missing-rejection','provider-credential','custodian-as-provider','forward-initial-gid','same-uid-control','drain-not-empty','holder-wrong-gid',
 'missing-client-reference','source-closure','adoption','skipped-read','same-key'])('rejects %s after valid controller re-signing and coherent observation updates',fault=>{
 const {record,pins}=resigned(fault);expect(()=>verifyRecord(record,pins)).toThrow();
});
