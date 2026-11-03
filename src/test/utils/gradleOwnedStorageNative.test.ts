import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync,sign} from 'node:crypto';
import {canonicalOwnedJson,ownedSha256} from '../../utils/gradleOwnedJson.js';
import {verifyStorageNativeRun} from '../fixtures/gradleOwnedStorageNative.js';
import {verifyB1cNativeLaunchBinding} from '../fixtures/gradleOwnedDeployment.js';
import {createPublicKey} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const validation=new URL('../../../docs/validation/',import.meta.url);
const load=()=>({record:readFileSync(new URL('gradle-q2b-native-storage-2026-11-03.json',validation)),...JSON.parse(readFileSync(new URL('gradle-q2b-native-storage-2026-11-03.bindings.json',validation),'utf8'))});
const localPosix=process.platform==='linux'||process.platform==='darwin';
it.skipIf(!localPosix)('runs real local filesystem contract regressions including failed synchronization and partial recovery',()=>{
 const run=spawnSync('python3',['-I','-B',fileURLToPath(new URL('../fixtures/q2b_storage/storage_regression.py',import.meta.url))],{encoding:'utf8',timeout:30000});
 expect(run.status,run.stderr).toBe(0);expect(JSON.parse(run.stdout)).toEqual({tests:22,failures:0,errors:0,nativeIsolationVerified:false});
});
it('builds a closed offline fixture without credential material and with parseable pinned storage entrypoint',()=>{
 const code=`import runpy,tempfile,pathlib,ast,json
m=runpy.run_path(${JSON.stringify(fileURLToPath(new URL('../fixtures/q2b_storage/build_fixture.py',import.meta.url)))})
with tempfile.TemporaryDirectory() as t:
 m['build'](t); p=pathlib.Path(t); ast.parse((p/'rootfs/opt/osv-q2b/b1ct/provider.py').read_text()); b=json.loads((p/'bundle.json').read_text())
 a=runpy.run_path(str(p/'rootfs/opt/osv-q2b/b1ct/auth.py'))
 class Public:
  calls=0
  def verify(self,*args): self.calls+=1
 public=Public()
 try: a['verify']({'schema':a['DOMAIN'],'keyId':'reader','body':[{}],'signature':''},'reader',public); raise AssertionError('untyped body accepted')
 except ValueError as error: assert str(error)=='signature-domain',str(error)
 assert public.calls==0
 print(json.dumps({'scope':b['scope'],'files':len(b['files']),'private':(p/'secrets').exists() or (p/'credentials.tar').exists(),'malformedBodyRejected':True}))`;
 const run=spawnSync('python3',['-I','-B','-c',code],{encoding:'utf8',timeout:30000});expect(run.status,run.stderr).toBe(0);expect(JSON.parse(run.stdout)).toEqual({scope:'native-storage-diagnostic-only',files:23,private:false,malformedBodyRejected:true});
});
it.skipIf(!localPosix)('observes actual file and directory fsync calls before a seal result is returned',()=>{
 const code=`import runpy,json,os,stat
from unittest.mock import patch
m=runpy.run_path(${JSON.stringify(fileURLToPath(new URL('../fixtures/q2b_storage/storage_regression.py',import.meta.url)))}); case=m['StorageTests'](); case.setUp(); real=os.fsync; calls=[]
def sync(fd):
 calls.append('directory' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file'); real(fd)
try:
 with patch.object(m['module'].os,'fsync',side_effect=sync): store,result=case.sealed()
 assert calls.count('file')>=8 and calls.count('directory')>=5 and calls[:4]==['file','directory','file','directory']
 print(json.dumps({'files':calls.count('file'),'directories':calls.count('directory'),'returned':result['phase']}))
finally: case.tearDown()`;
 const run=spawnSync('python3',['-I','-B','-c',code],{encoding:'utf8',timeout:30000});expect(run.status,run.stderr).toBe(0);expect(JSON.parse(run.stdout)).toEqual({files:8,directories:5,returned:'sealed'});
});
it('verifies native authenticated storage, controlled isolation and process recovery without adoption',()=>{
 expect(verifyStorageNativeRun(load())).toMatchObject({authenticatedStorageCalls:31,successfulStorageCalls:14,nativeLaunchBindingsVerified:24,isolationRefusals:65,allowControls:5,storageFaultsVerified:8,tamperRecoveriesRejected:3,serviceRestartRecoveryObserved:true,vmPowerLossTested:false,nativeIsolationVerified:false,independentRegistryVerified:false,profileApproved:false,backendEligible:false,originalReadsSkipped:0});
});
it('accepts pretty or compact public wrappers while requiring canonical signed envelopes',()=>{
 const input=load(),record=JSON.parse(input.record.toString());expect(verifyStorageNativeRun({...input,record:Buffer.from(canonicalOwnedJson(record,8*1024*1024))})).toEqual(verifyStorageNativeRun(input));
 record.evidence=Buffer.concat([Buffer.from(record.evidence,'base64'),Buffer.from('\n')]).toString('base64');expect(()=>verifyStorageNativeRun({...input,record:Buffer.from(JSON.stringify(record))})).toThrow('canonical');
});
it('rejects invalid UTF-8 and duplicate keys in the archival wrapper',()=>{
 const input=load();expect(()=>verifyStorageNativeRun({...input,record:Buffer.concat([input.record,Buffer.from([255])])})).toThrow();
 const raw=input.record.toString().replace('"schema": "osv-mcp.q2b.storage.public-record.v1"','"schema": "osv-mcp.q2b.storage.public-record.v1", "schema": "osv-mcp.q2b.storage.public-record.v1"');expect(raw).not.toBe(input.record.toString());expect(()=>verifyStorageNativeRun({...input,record:Buffer.from(raw)})).toThrow();
});
it('does not allow public wrapper fields to assert adoption',()=>{
 const input=load(),record=JSON.parse(input.record.toString());record.backendEligible=true;expect(()=>verifyStorageNativeRun({...input,record:Buffer.from(JSON.stringify(record))})).toThrow();
});
it('binds the native evidence to the exact executed source closure',()=>{
 const r=JSON.parse(load().record.toString()),body=JSON.parse(Buffer.from(r.evidence,'base64').toString()).body;
 expect(body.sources).toHaveLength(23);for(const source of body.sources)expect(ownedSha256(readFileSync(new URL('../fixtures/'+source.path,import.meta.url))),source.path).toBe(source.sha256);
});
it('does not silently broaden the original tmpfs launch profile to ext4',()=>{
 const input=load(),r=JSON.parse(input.record.toString()),o=JSON.parse(Buffer.from(r.evidence,'base64').toString()).body.observation;
 expect(()=>verifyB1cNativeLaunchBinding({manifest:Buffer.from(canonicalOwnedJson(o.manifest)),expectedManifestDigest:input.manifestDigest,launch:Buffer.from(r.launches[0].launch,'base64'),diagnostic:Buffer.from(r.launches[0].diagnostic,'base64'),manager:{keyId:'manager-native',publicKey:createPublicKey({key:Buffer.from(r.managerPublicKeyDer,'base64'),format:'der',type:'spki'})},controller:{keyId:'controller-native',publicKey:createPublicKey({key:Buffer.from(r.controllerPublicKeyDer,'base64'),format:'der',type:'spki'})},runId:input.runId,caseId:o.boots[0].caseId})).toThrow('configuration_invalid');
});
function resign(change:(body:any,record:any)=>void){
 const input=load(),record=JSON.parse(input.record.toString()),envelope=JSON.parse(Buffer.from(record.evidence,'base64').toString()),pair=generateKeyPairSync('ed25519');change(envelope.body,record);
 const der=pair.publicKey.export({type:'spki',format:'der'});record.controllerPublicKeyDer=der.toString('base64');input.controllerKeyDigest=ownedSha256(der);
 const seal=(value:any)=>{const {signature,...unsigned}=value;return Buffer.from(canonicalOwnedJson({...unsigned,signature:sign(null,Buffer.from(canonicalOwnedJson(unsigned,4*1024*1024)),pair.privateKey).toString('base64')},4*1024*1024)).toString('base64');};
 record.evidence=seal(envelope);for(const entry of record.launches)entry.diagnostic=seal(JSON.parse(Buffer.from(entry.diagnostic,'base64').toString()));input.record=Buffer.from(canonicalOwnedJson(record,8*1024*1024));return input;
}
const mutations:Record<string,(body:any,record:any)=>void>={
 'read skipped':b=>b.observation.originalReadsSkipped=1,
 'isolation adoption':b=>b.observation.nativeIsolationVerified=true,
 'power loss claim':b=>b.observation.vmPowerLossTested=true,
 'missing boot':b=>b.observation.boots.pop(),
 'boot plan':b=>b.observation.boots[0].caseId='other',
 'missing call':b=>b.observation.calls.pop(),
 'duplicate case':b=>b.observation.calls[1].case=b.observation.calls[0].case,
 'wrong actor uid':b=>b.observation.calls[0].identity.uid[2]++,
 'wrong actor gid':b=>b.observation.calls[0].identity.gid[2]++,
 'sender credentials':b=>b.observation.calls[0].providerCredentials[0][1]++,
 'client proof missing':b=>b.observation.calls[0].clientProofFrames=0,
 'provider signature':b=>b.observation.calls[0].response.signature='A'.repeat(88),
 'request signature':b=>b.observation.calls[0].request.body.argument={path:'/etc/shadow'},
 'proof signature':b=>b.observation.calls[0].proof.body.clientNonce='1'.repeat(64),
 'missing isolation path':b=>b.observation.isolation[0].denied.pop(),
 'isolation operation':b=>b.observation.isolation[0].denied[0].operation='different',
 'isolation errno':b=>b.observation.isolation[0].denied[0].errno=2,
 'allow control missing':b=>b.observation.isolation[0].allowControl=false,
 'isolation principal gid':b=>b.observation.isolation[1].identity.gid[0]++,
 'missing fault':b=>b.observation.faults.pop(),
 'wrong fault':b=>b.observation.faults[0].fault='different',
 'partial inventory':b=>b.observation.faults[0].partialInventory=['lock'],
 'recovery reason':b=>b.observation.faults[0].reason='other',
 'recovery process still active':b=>b.observation.boots.find((x:any)=>x.caseId==='fault-0-recovery').serviceState='ActiveState=active\nExecMainStatus=0',
 'recovery synchronization missing':b=>b.observation.boots[1].storage.syncs.file=0,
 'missing event':b=>b.observation.events=b.observation.events.filter((e:any)=>!(e.kind==='storage-operation'&&e.operation==='seal')),
 'seal synchronization missing':b=>b.observation.events.filter((e:any)=>e.kind==='storage-operation'&&e.operation==='seal').forEach((e:any)=>e.syncs.directory=0),
 'disk seal signature':b=>b.observation.sealedEvidence[0].seal=Buffer.from('{}').toString('base64'),
 'disk payload changed':b=>b.observation.sealedEvidence[0].payload=Buffer.from('changed').toString('base64'),
 'disk root changed':b=>b.observation.sealedEvidence[0].root.inode='1',
 'runtime mount':b=>b.observation.mount.options=b.observation.mount.options.filter((x:string)=>x!=='noexec'),
 'source closure':b=>b.sources[0].path='q2b_storage/unrecorded.py',
 'outside recovery anchor':b=>b.observation.boots[1].recoveryAnchor.sealDigest='1'.repeat(64),
 'stale request source':b=>b.observation.staleRequest.requestDigest='1'.repeat(64),
 'stale request refusal':b=>b.observation.staleRequest.serverRejection.reason='timeout',
 'stale sender credentials':b=>b.observation.staleRequest.providerCredentials[0][2]++,
 'protected event gid':b=>b.observation.events.find((e:any)=>e.kind==='storage-operation').peer[2]++,
 'unrecorded event':b=>b.observation.events.push(b.observation.events[0]),
 'malformed body refusal':b=>b.observation.malformedRequest.serverRejection.reason='timeout',
 'recovery exit ten':b=>b.observation.boots.find((x:any)=>x.caseId==='fault-0-recovery').serviceState='ActiveState=failed\nExecMainStatus=10',
 'sync counter inflation':b=>b.observation.events.find((e:any)=>e.kind==='storage-operation'&&e.operation==='seal').syncs.file++,
};
for(const [name,change]of Object.entries(mutations))it('rejects a controller-resigned inconsistent record: '+name,()=>expect(()=>verifyStorageNativeRun(resign(change))).toThrow());
for(const field of ['managerKeyDigest','controllerKeyDigest','manifestDigest','runId'])it('requires the outside pin '+field,()=>{
 const input=load();input[field]=field==='runId'?'other':'1'.repeat(64);expect(()=>verifyStorageNativeRun(input)).toThrow();
});
