import {consumerFixture} from '../fixtures/gradleOwnedConsumerFixture.js';
import {StageStore} from '../../utils/gradleOwnedStageStore.js';
import {createGradleBudget} from '../../utils/gradleGraph.js';
import {it,expect,vi,afterEach} from 'vitest';
import * as current from '../../utils/gradleOwnedCurrentSchema.js';
import {AuthorityJournal} from '../../utils/gradleOwnedStoreJournal.js';
import {registryOwnerFixture} from '../fixtures/gradleOwnedRegistryFixture.js';
import {makeStageCommit} from '../../utils/gradleOwnedServiceStages.js';
import {ownedSha256 as hash} from '../../utils/gradleOwnedJson.js';
const fixtures:Awaited<ReturnType<typeof registryOwnerFixture>>[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const f of fixtures.splice(0))await f.cleanup();});
async function setup(){const f=await registryOwnerFixture();fixtures.push(f);const store=await f.disk('lineage-registry','create'),plan=f.rolePlan('lineage-registry');const q=makeStageCommit(plan,{api:'control.BeginEnrollment',operationKey:hash('op'),requestDigest:hash('request'),stageId:'enrollment-begun',expectedHead:null,previousStageReceipt:null,nextImage:Buffer.from('{"n":1}').toString('base64')});await store.commitStageExact(q);return store;}
it('replays the image with two canonical decodes rather than re-decoding it for equality',async()=>{
 const store=await setup(),spy=vi.spyOn(current,'decodeCurrent');expect((await store.readCommitted(null)).image).toEqual({n:1});
 expect(spy.mock.calls.filter(([bytes])=>bytes.toString()==='{"n":1}')).toHaveLength(2);
});
it.each(['{"n":2}','{ "n":1}','{"n":1}\n'])('rejects a substituted operation-result %s after authenticated journal read',async image=>{
 const store=await setup(),original=AuthorityJournal.prototype.readHistory;
 vi.spyOn(AuthorityJournal.prototype,'readHistory').mockImplementation(async function(this:AuthorityJournal,...args){const rows=await original.apply(this,args);return rows.map(row=>({...row,records:row.records.map(record=>record.role==='operation-result'?{...record,bytes:Buffer.from(image)}:record)}));});
 await expect(store.readCommitted(null)).rejects.toThrow();expect(store.diagnostics.blocked).toBe(true);
});

it('keeps every fresh history read on the complete controlled-clock consumer path',async()=>{
 const f=await consumerFixture();try{const counts:Record<string,number>={},original=StageStore.prototype.readCommitted;
 vi.spyOn(StageStore.prototype,'readCommitted').mockImplementation(function(this:StageStore,ref:unknown){counts[this.ownerId]=(counts[this.ownerId]??0)+1;return original.call(this,ref);});
 const document=await f.bridge.readDocument('graph',createGradleBudget(),f.f.data.policy);expect(document.owned?.executionWitness).toBe('verified');
 expect(counts).toEqual({'lineage-registry':94,'control-anchor':99,'provider':39,'checkpoint-issuer':1,'authority-broker':5});
 }finally{vi.restoreAllMocks();await f.cleanup();}
},120000);
