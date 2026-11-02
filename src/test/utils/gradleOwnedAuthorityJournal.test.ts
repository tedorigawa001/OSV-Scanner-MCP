import {it,expect} from 'vitest';
import {AuthorityJournal,MemoryJournalIO,MemoryCheckpoint,journalGenesis,type JournalRecord} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {ownedSha256} from '../../utils/gradleOwnedJson.js';
const identity={authorityId:'authority',storeEpoch:ownedSha256('epoch'),keyId:'journal-key'};
const key=Buffer.alloc(32,19);
const records=():JournalRecord[]=>['session-manifest','event-ledger','session-index','operation-result'].map((role,i)=>({id:'root-'+i,role:role as JournalRecord['role'],bytes:Buffer.from(JSON.stringify({value:i}))}));
function fixture(){const io=new MemoryJournalIO(),checkpoint=new MemoryCheckpoint(journalGenesis(identity));return {...identity,key,io,checkpoint};}
it('persists an authenticated commit before acknowledging and reopens the same history',async()=>{
 const c=fixture(),j=await AuthorityJournal.create(c);const receipt=await j.commit({operationId:'op',requestDigest:ownedSha256('request'),records:records()});
 expect(receipt).toMatchObject({revision:1,backendEligible:false});
 const reopened=await AuthorityJournal.open(c);expect(await reopened.lookupOperation('op')).toMatchObject({headDigest:receipt.headDigest,revision:1});
 expect((await reopened.readLatest()).map(r=>r.bytes.toString())).toEqual(records().map(r=>r.bytes.toString()));
});

import {canonicalOwnedJson,ownedDigest} from '../../utils/gradleOwnedJson.js';
import {sealJournalValue,type JournalFault} from '../fixtures/gradleOwnedAuthorityJournal.js';
for(const phase of ['before-records','after-records','before-commit','after-commit','before-checkpoint','after-checkpoint','before-ack'] as JournalFault[])it('recovers after fault at '+phase+' without issuing a premature ack',async()=>{
 const c=fixture();let armed=false,hits=0;const j=await AuthorityJournal.create({...c,fault:p=>{if(armed&&p===phase){hits++;throw Error('injected');}}});armed=true;
 await expect(j.commit({operationId:'once',requestDigest:ownedSha256('once'),records:records()})).rejects.toThrow('injected');expect(hits).toBe(1);
 await expect(j.lookupOperation('once')).rejects.toThrow('recovery_required');const recovered=await AuthorityJournal.open(c);
 const published=['after-commit','before-checkpoint','after-checkpoint','before-ack'].includes(phase);
 expect((await recovered.lookupOperation('once'))?.revision).toBe(published?1:undefined);
 const r=await recovered.commit({operationId:'once',requestDigest:ownedSha256('once'),records:records()});expect(r.revision).toBe(1);expect((await c.checkpoint.read()).revision).toBe(1);
 expect([...c.io.files.keys()].filter(x=>x.startsWith('commit-'))).toHaveLength(1);
});
it('duplicate operation retries do not create another commit and altered bytes cannot reuse an ID',async()=>{const c=fixture(),j=await AuthorityJournal.create(c),a=await j.commit({operationId:'same',requestDigest:ownedSha256('same'),records:records()});expect(await j.commit({operationId:'same',requestDigest:ownedSha256('same'),records:records()})).toMatchObject({...a,replayed:true});const changed=records();changed[0]!.bytes=Buffer.from('changed');await expect(j.commit({operationId:'same',requestDigest:ownedSha256('same'),records:changed})).rejects.toThrow('operation_conflict');});
for(const change of ['blob','mac','self-hash','missing-blob','missing-commit','wrong-head','old-store','index'])it('rejects persisted corruption or rollback: '+change,async()=>{
 const c=fixture(),j=await AuthorityJournal.create(c),backup=new Map([...c.io.files].map(([k,v])=>[k,Buffer.from(v)]));await j.commit({operationId:'op',requestDigest:ownedSha256('op'),records:records()});
 const blob=[...c.io.files.keys()].find(k=>k.startsWith('blob-'))!;
 if(change==='blob')c.io.files.set(blob,Buffer.from('changed'));
 if(change==='missing-blob')c.io.files.delete(blob);
 if(change==='missing-commit')c.io.files.delete('commit-00000001.json');
 if(change==='wrong-head')c.checkpoint.value.headDigest=ownedSha256('wrong');
 if(change==='old-store'){c.io.files.clear();for(const [k,v]of backup)c.io.files.set(k,v);}
 if(['mac','self-hash','index'].includes(change)){const raw=JSON.parse(c.io.files.get('commit-00000001.json')!.toString());if(change==='mac')raw.mac='a'.repeat(64);if(change==='self-hash'){raw.body.requestDigest=ownedSha256('replacement');raw.mac=ownedDigest(raw.body);}if(change==='index'){raw.body.records.pop();c.io.files.set('commit-00000001.json',sealJournalValue(raw.body,identity.keyId,key));}else c.io.files.set('commit-00000001.json',Buffer.from(canonicalOwnedJson(raw)));}
 await expect(AuthorityJournal.open(c)).rejects.toThrow(/authority_journal_/);
});
for(const field of ['authorityId','storeEpoch','keyId','key'])it('does not self-enroll a changed '+field,async()=>{const c=fixture();await AuthorityJournal.create(c);const other:any={...c,[field]:field==='key'?Buffer.alloc(32,77):field==='authorityId'?'other':field==='storeEpoch'?ownedSha256('other'):'other-key'};await expect(AuthorityJournal.open(other)).rejects.toThrow(/authority_journal_/);});
it('checkpoint failure preserves a local commit but prevents publication until recovery succeeds',async()=>{const c=fixture();let unavailable=false;const checkpoint={read:()=>c.checkpoint.read(),advance:async(a:any,b:any)=>{if(unavailable)throw Error('/secret/checkpoint');return c.checkpoint.advance(a,b);}};const j=await AuthorityJournal.create({...c,checkpoint});unavailable=true;await expect(j.commit({operationId:'op',requestDigest:ownedSha256('op'),records:records()})).rejects.toThrow('checkpoint_unavailable');expect(c.checkpoint.value.revision).toBe(0);await expect(AuthorityJournal.open({...c,checkpoint})).rejects.toThrow('checkpoint_unavailable');unavailable=false;expect((await (await AuthorityJournal.open({...c,checkpoint})).lookupOperation('op'))?.revision).toBe(1);});
it('does not replace a missing checkpoint with the local maximum revision',async()=>{const c=fixture();await AuthorityJournal.create(c);await expect(AuthorityJournal.open({...c,checkpoint:{read:async()=>{throw Error('missing');},advance:async()=>{throw Error('must not run');}}})).rejects.toThrow('checkpoint_unavailable');});
it('rejects a checkpoint more than one commit behind, not silently treating it as an unfinished transaction',async()=>{const c=fixture(),j=await AuthorityJournal.create(c);await j.commit({operationId:'one',requestDigest:ownedSha256('one'),records:records()});await j.commit({operationId:'two',requestDigest:ownedSha256('two'),records:records()});c.checkpoint.value=journalGenesis(identity);await expect(AuthorityJournal.open(c)).rejects.toThrow('checkpoint_gap');});
it('seals input bytes before storage awaits and returns copies on reads',async()=>{const c=fixture(),j=await AuthorityJournal.create(c),data=records(),original=data[0]!.bytes.toString();const promise=j.commit({operationId:'seal',requestDigest:ownedSha256('seal'),records:data});data[0]!.bytes.fill(0);await promise;const first=await j.readLatest();expect(first[0]!.bytes.toString()).toBe(original);first[0]!.bytes.fill(0);expect((await j.readLatest())[0]!.bytes.toString()).toBe(original);});
it('rejects stale expected head and duplicate logical IDs',async()=>{const c=fixture(),j=await AuthorityJournal.create(c),old=j.head;await j.commit({operationId:'one',requestDigest:ownedSha256('one'),records:records()});await expect(j.commit({operationId:'two',requestDigest:ownedSha256('two'),records:records(),expectedHead:old})).rejects.toThrow('revision_conflict');const recovered=await AuthorityJournal.open(c),data=records();data.push(data[0]!);await expect(recovered.commit({operationId:'dup',requestDigest:ownedSha256('dup'),records:data})).rejects.toThrow('index_invalid');});
it('serializes one writer and does not corrupt the first writer when another request is busy',async()=>{const c=fixture();let release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});let reached!:()=>void;const started=new Promise<void>(r=>{reached=r;});const j=await AuthorityJournal.create({...c,fault:async p=>{if(p==='before-records'){reached();await waiting;}}});const first=j.commit({operationId:'first',requestDigest:ownedSha256('first'),records:records()});await started;await expect(j.commit({operationId:'second',requestDigest:ownedSha256('second'),records:records()})).rejects.toThrow('busy');release();expect((await first).revision).toBe(1);});

it('withholds reopened and retried receipts until a published checkpoint is durably re-synced',async()=>{
 const {FileJournalCheckpoint}=await import('../fixtures/gradleOwnedJournalCheckpoint.js');
 class InterruptedCheckpointIO extends MemoryJournalIO {
  failing=false;pending=false;attempts=0;
  override async put(name:string,bytes:Buffer){
   await super.put(name,bytes);
   if(name==='checkpoint-00000001.json'){
    this.attempts++;
    if(this.failing){this.pending=true;throw Error('directory sync failed after publication');}
    this.pending=false;
   }
  }
 }
 const io=new MemoryJournalIO(),anchorIO=new InterruptedCheckpointIO();
 const checkpoint=()=>new FileJournalCheckpoint({identity,keyId:'anchor',key:Buffer.alloc(32,2),io:anchorIO});
 await checkpoint().initialize();const config={...identity,key,io,checkpoint:checkpoint()};
 const j=await AuthorityJournal.create(config),input={operationId:'once',requestDigest:ownedSha256('once'),records:records()};
 anchorIO.failing=true;
 await expect(j.commit(input)).rejects.toThrow('checkpoint_unavailable');expect(anchorIO.pending).toBe(true);
 await expect(j.commit(input)).rejects.toThrow('recovery_required');
 for(let retry=0;retry<2;retry++)await expect(AuthorityJournal.open({...config,checkpoint:checkpoint()})).rejects.toThrow('checkpoint_unavailable');
 expect(anchorIO.attempts).toBe(3);
 anchorIO.failing=false;const recovered=await AuthorityJournal.open({...config,checkpoint:checkpoint()});
 expect(anchorIO.pending).toBe(false);expect(anchorIO.attempts).toBeGreaterThan(3);
 expect(await recovered.commit(input)).toMatchObject({revision:1,replayed:true});
 expect([...io.files.keys()].filter(n=>n.startsWith('commit-'))).toHaveLength(1);
 // Existing readers/retry paths must also re-sync, never trust a cached head.
 anchorIO.failing=true;
 await expect(recovered.lookupOperation('once')).rejects.toThrow('checkpoint_unavailable');
 anchorIO.failing=false;const again=await AuthorityJournal.open({...config,checkpoint:checkpoint()});
 expect(await again.lookupOperation('once')).toMatchObject({revision:1});
});

import {MemoryJournalIO as ProbeIO,MemoryCheckpoint as ProbeCheckpoint} from '../fixtures/gradleOwnedAuthorityJournal.js';
const probeIdentity={authorityId:'probe',storeEpoch:ownedSha256('probe-epoch'),keyId:'probe-key'};
const probeRecords=(n:string):JournalRecord[]=>[{id:'m',role:'session-manifest',bytes:Buffer.from('m'+n)},{id:'i',role:'session-index',bytes:Buffer.from('i'+n)},{id:'r',role:'operation-result',bytes:Buffer.from('r'+n)},{id:'l',role:'event-ledger',bytes:Buffer.from('l'+n)}];
async function probeJournal(){const io=new ProbeIO();const j=await AuthorityJournal.create({...probeIdentity,key:Buffer.alloc(32,7),io,checkpoint:new ProbeCheckpoint(journalGenesis(probeIdentity))});return {j,io};}
it('keeps the journal usable after a stale-head or conflicting-operation rejection that wrote nothing',async()=>{
 const {j,io}=await probeJournal();const genesis=j.head;await j.commit({operationId:'op1',requestDigest:ownedSha256('1'),records:probeRecords('1')});const files=io.files.size;
 await expect(j.commit({operationId:'op2',requestDigest:ownedSha256('2'),records:probeRecords('2'),expectedHead:genesis})).rejects.toThrow('authority_journal_revision_conflict');
 await expect(j.commit({operationId:'op1',requestDigest:ownedSha256('other'),records:probeRecords('1')})).rejects.toThrow('authority_journal_operation_conflict');
 expect(io.files.size).toBe(files);
 const next=await j.commit({operationId:'op3',requestDigest:ownedSha256('3'),records:probeRecords('3')});expect(next.revision).toBe(2);
});
it('still stops the instance after a failure once writing has started',async()=>{
 const io=new ProbeIO();let fail=true;
 const j=await AuthorityJournal.create({...probeIdentity,key:Buffer.alloc(32,7),io,checkpoint:new ProbeCheckpoint(journalGenesis(probeIdentity)),fault:p=>{if(p==='after-records'&&fail){fail=false;throw Error('disk');}}});
 await expect(j.commit({operationId:'op1',requestDigest:ownedSha256('1'),records:probeRecords('1')})).rejects.toThrow('disk');
 await expect(j.commit({operationId:'op2',requestDigest:ownedSha256('2'),records:probeRecords('2')})).rejects.toThrow('authority_journal_recovery_required');
});
