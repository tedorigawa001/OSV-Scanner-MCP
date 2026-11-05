import {spawnSync} from 'node:child_process';
import {it,expect} from 'vitest';
import {CgpHistoryProbe,historyCallsite} from '../fixtures/gradleOwnedCgpHistory.js';
import {validateHistoryReads} from '../fixtures/gradleOwnedCgpHistoryCheck.mjs';
it('attributes overlapping work to its own asynchronous RPC without counting it twice',async()=>{
 const probe=new CgpHistoryProbe();let release!:()=>void;const pause=new Promise<void>(r=>release=r);
 const a=probe.run({rpcId:1,api:'one',action:'receive'},()=>probe.measure('readCommitted','history','caller-a',async()=>{await pause;return 1;}));
 expect(()=>probe.reset()).toThrow('busy');
 expect(await probe.run({rpcId:2,api:'two',action:'anchor'},()=>probe.measure('readCommitted','receipt','caller-b',async()=>2))).toBe(2);
 release();expect(await a).toBe(1);const s=probe.snapshot();expect(s.reads.map(r=>[r.rpcId,r.api,r.callsite])).toEqual([[1,'one','caller-a'],[2,'two','caller-b']]);expect(s.active).toBe(0);expect(s.dropped).toBe(0);
 const sample={owners:[{role:'provider',boot:'b',categories:{'stage.readCommitted':{count:2}},historyReads:s}],rawSpans:s.reads.map(r=>({...r,role:'provider',boot:'b',historyEventIds:[r.eventId],startMs:r.startMs-1,wallMs:r.wallMs+2})),readerEvents:[]};
 expect(validateHistoryReads(sample).reduce((n,g)=>n+g.count,0)).toBe(2);
 for(const mutate of [(v:any)=>v.owners[0].historyReads.reads.pop(),(v:any)=>v.owners[0].historyReads.reads[0].rpcId=99,(v:any)=>v.owners[0].historyReads.dropped=1,(v:any)=>v.owners[0].historyReads.reads[0].callsite='unattributed',(v:any)=>v.owners[0].historyReads.reads[0].startMs=0]){const v=structuredClone(sample);mutate(v);expect(()=>validateHistoryReads(v)).toThrow();}
});
it('preserves returned identity and errors, bounds recording, and resets only idle data',async()=>{
 const probe=new CgpHistoryProbe(1),value={n:1},error=Error('original');expect(await probe.measure('readCommitted','history','caller',async()=>value)).toBe(value);
 await expect(probe.measure('readCommitted','receipt','caller',async()=>{throw error;})).rejects.toBe(error);expect(probe.snapshot().reads.length).toBe(1);expect(probe.snapshot().dropped).toBe(1);probe.reset();expect(probe.snapshot()).toEqual({schema:'cgp.history-events.v1',eventCount:0,reads:[],active:0,dropped:0});
});
it('keeps only a normalized direct production callsite',()=>{
 expect(historyCallsite('Error\n at observer (file:///tmp/probe.js:1:1)\n at #execute (file:///tmp/private/compiled/utils/gradleOwnedAnchorOwner.js:77:18)\n at call (gradleOwnedAnchorOwner.js:99:1)')).toBe('at #execute (gradleOwnedAnchorOwner.js:77:18)');
 expect(historyCallsite('Error\n at load (file:///tmp/private/compiled/utils/gradleOwnedRecovery.js:8:3)\n at #execute (file:///tmp/private/compiled/utils/gradleOwnedAnchorOwner.js:77:18)')).toBe('at load (gradleOwnedRecovery.js:8:3)');
 expect(historyCallsite('Error\n at unknown (file:///tmp/unknown.js:1:1)')).toBe('unattributed');
});

it('rejects replacement of a read by another read even when the total stays unchanged',async()=>{
 const probe=new CgpHistoryProbe();for(const rpcId of [1,2])await probe.run({rpcId,api:'one',action:'receive'},()=>probe.measure('readCommitted','history','caller',async()=>1));
 const snapshot=probe.snapshot(),sample={owners:[{role:'provider',boot:'b',categories:{'stage.readCommitted':{count:2}},historyReads:snapshot}],rawSpans:snapshot.reads.map((r:any)=>({...r,role:'provider',boot:'b',historyEventIds:[r.eventId],startMs:r.startMs-1,wallMs:r.wallMs+2})),readerEvents:[]};
 const command=(v:unknown)=>spawnSync(process.execPath,['scripts/analyze-c3b-cgp-history.mjs','--check-history'],{input:JSON.stringify(v),encoding:'utf8'});
 expect(command(sample).status).toBe(0);
 expect(()=>validateHistoryReads(sample)).not.toThrow();const reads=sample.owners[0]!.historyReads.reads;reads[1]=structuredClone(reads[0]!);
 expect(()=>validateHistoryReads(sample)).toThrow();expect(command(sample).status).not.toBe(0);
 // Re-numbering the copy still must not hide the missing RPC's read.
 reads[1]!.eventId=2;expect(()=>validateHistoryReads(sample)).toThrow();expect(command(sample).status).not.toBe(0);
});

it('rejects event gaps, missing RPC manifests and duplicate RPC spans',async()=>{
 const probe=new CgpHistoryProbe();await probe.run({rpcId:1,api:'one',action:'receive'},()=>probe.measure('readCommitted','history','caller',async()=>1));const s=probe.snapshot(),r=s.reads[0]!;
 const sample={owners:[{role:'provider',boot:'b',categories:{'stage.readCommitted':{count:1}},historyReads:s}],rawSpans:[{...r,role:'provider',boot:'b',historyEventIds:[r.eventId],startMs:r.startMs-1,wallMs:r.wallMs+2}],readerEvents:[]};
 for(const change of [(v:any)=>v.owners[0].historyReads.reads[0].eventId=2,(v:any)=>delete v.rawSpans[0].historyEventIds,(v:any)=>v.rawSpans[0].historyEventIds=[],(v:any)=>v.rawSpans.push(structuredClone(v.rawSpans[0]))]){const v=structuredClone(sample);change(v);expect(()=>validateHistoryReads(v)).toThrow();}
});
