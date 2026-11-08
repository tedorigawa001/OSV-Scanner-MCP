import {it,expect,vi} from 'vitest';
import {cprBPCase,type CprBPOptions} from '../fixtures/gradleOwnedCprBP.js';
const cprBCase=(mode:Parameters<typeof cprBPCase>[0],options:CprBPOptions={})=>cprBPCase(mode,{...options,variant:'combined'});
import * as json from '../../utils/gradleOwnedJson.js';
it('rejects signed scalar corruption before completing its client row',async()=>{
 const f=cprBCase('S-scoped',{mutateResult:b=>{if(b.api==='ReadSealedSource'&&b.result?.entry?.kind!=='inventory')b.result.bytes='AAAA';}});
 try{const q=(await f.commands())[0]!;await expect(f.run(q)).rejects.toThrow('binding_mismatch');expect(f.clientRows.at(-1)!.state).toBe('unknown');const rows=f.clientRows;await expect(f.run(q)).rejects.toThrow('operation_busy');expect(f.clientRows).toEqual(rows);}finally{f.close();}
});

for(const mode of ['S-scoped','B-independent'] as const)for(const target of ['output','inventory'])it('rejects original deadline reached in final '+target+' digest '+mode,async()=>{
 const f=cprBCase(mode),original=json.ownedDigest;let hit=false;
 const spy=vi.spyOn(json,'ownedDigest').mockImplementation((value,...rest)=>{
  const matches=Array.isArray(value)&&value.length===5&&(target==='output'?value.every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)):value.every(x=>typeof x==='object'&&x!==null&&'kind' in x&&'sha256' in x));
  // The inventory entry array is also observed by provider profiling; only use
  // the final client call, after every provider reply has been produced.
  if(matches&&f.provider.metrics.replies===(mode==='S-scoped'?7:4)){hit=true;f.setNow(4500);}
  return original(value,...rest);
 });
 try{await expect(f.transfer()).rejects.toThrow('request_expired');expect(hit).toBe(true);}finally{spy.mockRestore();f.close();}
});
for(const mode of ['S-scoped','B-independent'] as const)it('includes final digest work in wall and reconstruction time '+mode,async()=>{
 const f=cprBCase(mode),original=json.ownedDigest,now=performance.now.bind(performance);let offset=0,hit=false;
 const timer=vi.spyOn(performance,'now').mockImplementation(()=>now()+offset);
 const spy=vi.spyOn(json,'ownedDigest').mockImplementation((value,...rest)=>{
  if(Array.isArray(value)&&value.length===5&&value.every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))){offset+=1000;hit=true;}
  return original(value,...rest);
 });
 try{const started=performance.now(),r=await f.transfer(),observed=performance.now()-started;
 expect(hit).toBe(true);expect(r.wallMs).toBeGreaterThanOrEqual(1000);expect(r.dispatchAndReconstructionMs).toBeGreaterThanOrEqual(1000);expect(r.finalizationMs).toBeGreaterThanOrEqual(1000);
 expect(observed-r.wallMs).toBeLessThan(25);expect(Math.abs(r.wallMs-r.setupAndClientPlanMs-r.dispatchAndReconstructionMs)).toBeLessThan(0.01);
 }finally{spy.mockRestore();timer.mockRestore();f.close();}
});

for(const target of ['descriptor','inventory','scalar'] as const)for(const mutation of ['hash','entry','bytes'] as const)it('rejects '+target+' '+mutation+' before completing a row',async()=>{
 const f=cprBCase('S-scoped',{mutateResult:b=>{
  if(target==='descriptor'&&b.api==='ReadSourceDescriptor'){if(mutation==='hash')b.result.inventory.sha256='0'.repeat(64);else if(mutation==='entry')b.result.entries++;else b.result.metadata.keyId='other';}
  if(b.api==='ReadSealedSource'&&(target==='inventory'?b.result.entry.kind==='inventory':target==='scalar'&&b.result.entry.kind!=='inventory')){
   if(mutation==='hash')b.result.sha256='0'.repeat(64);else if(mutation==='entry')b.result.entry.sha256='0'.repeat(64);else b.result.bytes='AAAA';
  }
 }});
 try{if(target==='scalar'){const q=(await f.commands())[0]!;await expect(f.run(q)).rejects.toThrow();}else await expect(f.commands()).rejects.toThrow();
 expect(f.clientRows.at(-1)!.state).toBe('unknown');expect(f.provider.rows.at(-1)!.state).toBe('complete');
 }finally{f.close();}
});
for(const mode of ['S-scoped','B-independent'] as const)it('does not complete a row if body validation reaches its original deadline '+mode,async()=>{
 const f=cprBCase(mode),qs=await f.commands(),q=qs[0]!,original=json.ownedSha256;
 const spy=vi.spyOn(json,'ownedSha256').mockImplementation((bytes,...rest)=>{
  // A decoded part buffer is hashed only after the final provider reply.
  if(Buffer.isBuffer(bytes)&&bytes.length===600&&f.provider.metrics.replies===3)f.setNow(4500);
  return original(bytes,...rest);
 });
 try{await expect(f.run(q)).rejects.toThrow('request_expired');expect(f.clientRows.at(-1)!.state).toBe('unknown');}finally{spy.mockRestore();f.close();}
});

for(const mode of ['S-scoped','B-independent'] as const)it('rejects a coherent part hash that disagrees with its complete entry '+mode,async()=>{
 const f=cprBCase(mode,{mutateResult:b=>{
  const part=b.parts?.[0]??(b.result?.entry?.kind==='commit'?b.result:undefined);
  if(part){const bytes=Buffer.alloc(600,0);part.bytes=bytes.toString('base64');part.sha256=json.ownedSha256(bytes);}
 }});
 try{const q=(await f.commands())[0]!;await expect(f.run(q)).rejects.toThrow('binding_mismatch');expect(f.clientRows.at(-1)!.state).toBe('unknown');}finally{f.close();}
});
