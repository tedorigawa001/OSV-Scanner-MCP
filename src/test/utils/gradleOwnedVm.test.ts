import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { verifyVmControls } from '../fixtures/gradleOwnedVm.js';
import { canonicalOwnedJson } from '../../utils/gradleOwnedJson.js';

const builder=fileURLToPath(new URL('../fixtures/q2b_b1c/build_fixture.py',import.meta.url));
it('builds a separate bounded VM diagnostic profile without changing B1b',()=>{
 const out=mkdtempSync(join(tmpdir(),'q2b-vm-'));
 try {
  execFileSync('python3',['-I',builder,out],{stdio:'pipe',timeout:10000});
  const service=readFileSync(join(out,'rootfs/etc/systemd/system/osv-q2b-b1c.service'),'utf8');
  expect(service).toContain('UnsetEnvironment=MEMORY_PRESSURE_WATCH MEMORY_PRESSURE_WRITE ');
  expect(service).toContain('AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_SETPCAP');
  expect(service).toContain('ExecStart=/opt/osv-q2b/b1c/launcher --profile b1c --instance b1c');
  const inventory=JSON.parse(readFileSync(join(out,'bundle.json'),'utf8'));
  expect(inventory.nativeIsolationVerified).toBe(false);
  expect(inventory.scope).toBe('b1c-vm-diagnostic-only');
 } finally {rmSync(out,{recursive:true,force:true});}
});

it('refuses an unsigned guest self-report as independently verified VM evidence',()=>{
 expect(()=>verifyVmControls({record:Buffer.from('{}'),controllerKeyDigest:'0'.repeat(64),bundleDigest:'0'.repeat(64)})).toThrow();
});

const recordUrl=new URL('../../../docs/validation/gradle-q2b-b1c-vm-2026-11-03.json',import.meta.url);
const record=JSON.parse(readFileSync(recordUrl,'utf8'));
const keyPin=readFileSync(new URL('../../../docs/validation/gradle-q2b-b1c-vm-2026-11-03.pin',import.meta.url),'utf8').trim();
const bundleBytes=readFileSync(new URL('../../../docs/validation/gradle-q2b-b1c-vm-2026-11-03.bundle.json',import.meta.url));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const bundleDigest=sha(bundleBytes);
function check(value=record,controllerKeyDigest=keyPin,pin=bundleDigest){
 return verifyVmControls({record:Buffer.from(JSON.stringify(value)),controllerKeyDigest,bundleDigest:pin});
}
it('verifies the externally signed actual VM run and all 142 controls without approving B1 isolation',()=>{
 expect(check()).toEqual({verifiedCases:142,systemdBootVerified:true,nativeIsolationVerified:false,backendEligible:false,profileApproved:false,originalReadsSkipped:0});
});
it('binds the saved VM run to the current collected source bytes and independent bundle inventory',()=>{
 for(const source of record.payload.sources){
  expect(sha(readFileSync(new URL('../fixtures/'+source.path,import.meta.url)))).toBe(source.sha256);
 }
 const bundle=JSON.parse(bundleBytes.toString('utf8'));
 for(const source of bundle.parentSources){
  expect(sha(readFileSync(new URL('../fixtures/q2b/'+source.path,import.meta.url)))).toBe(source.sha256);
 }
 expect(record.payload.observation.bundleDigest).toBe(bundleDigest);
 expect(bundle.files.find((f:{path:string})=>f.path==='/opt/osv-q2b/b1c/runtime').size).toBe(7845048);
});
it.each(['key','bundle','signature'])('rejects an incorrect independent %s binding',fault=>{
 const changed=structuredClone(record);
 if(fault==='signature')changed.signature=Buffer.alloc(64).toString('base64');
 expect(()=>check(changed,fault==='key'?'0'.repeat(64):keyPin,fault==='bundle'?'0'.repeat(64):bundleDigest)).toThrow();
});
// Use a new authorized test key so structural failures cannot be attributed only
// to an invalid signature. Production records are never re-signed or overwritten.
function resign(mutator:(value:typeof record)=>void){
 const value=structuredClone(record);mutator(value);
 const keys=generateKeyPairSync('ed25519');
 const publicBytes=keys.publicKey.export({format:'der',type:'spki'});
 value.publicKeyDer=publicBytes.toString('base64');value.publicKeySha256=sha(publicBytes);
 value.signature=sign(null,Buffer.from(canonicalOwnedJson(value.payload)),keys.privateKey).toString('base64');
 return {value,pin:value.publicKeySha256};
}
it.each(['missing-case','duplicate-case','unknown-case','wrong-actor','wrong-allow','unexpected-errno','saved-uid',
 'saved-gid','supplementary-group','effective-capability','provider-pid','listener-gid','same-kernel',
 'missing-limitation','scope','approve-isolation','approve-backend','skip-original-read','source-closure'])('rejects %s after valid re-signing',fault=>{
 const {value,pin}=resign(r=>{
  const o=r.payload.observation,c=o.cases[0];
  switch(fault){
   case 'missing-case':o.cases.pop();break;
   case 'duplicate-case':o.cases[1]=structuredClone(c);break;
   case 'unknown-case':c.case='unknown';break;
   case 'wrong-actor':c.actor='registry';break;
   case 'wrong-allow':c.allowed=!c.allowed;break;
   case 'unexpected-errno':o.cases.find((x:{allowed:boolean})=>!x.allowed).errno=2;break;
   case 'saved-uid':c.identity.uid[2]=0;break;
   case 'saved-gid':c.identity.gid[2]=0;break;
   case 'supplementary-group':c.identity.groups=[0];break;
   case 'effective-capability':c.identity.capabilities.CapEff='0000000000000080';break;
   case 'provider-pid':o.startup.pid++;break;
   case 'listener-gid':o.startup.listeners[0].ownerGid++;break;
   case 'same-kernel':o.kernel=r.payload.environment.outerKernel;break;
   case 'missing-limitation':o.notEstablished.pop();break;
   case 'scope':o.scope='b1c-complete';break;
   case 'approve-isolation':o.nativeIsolationVerified=true;break;
   case 'approve-backend':o.backendEligible=true;break;
   case 'skip-original-read':o.originalReadsSkipped=1;break;
   case 'source-closure':r.payload.sources[0]=r.payload.sources[1];break;
  }
 });
 expect(()=>check(value,pin)).toThrow();
});
