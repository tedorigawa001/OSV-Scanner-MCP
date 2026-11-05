import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
const stage='src/utils/gradleOwnedStageStore.ts';
function check(before:Record<string,string>,after:Record<string,string>){return spawnSync(process.execPath,['scripts/analyze-c3b-cgp-history.mjs','--check-sources'],{input:JSON.stringify({before,after}),encoding:'utf8'});}
it('rejects a source present only after the measured optimization',()=>{
 const before={[stage]:'a',observer:'same'},after={[stage]:'b',observer:'same',extra:'new'};
 const result=check(before,after);expect(result.status).not.toBe(0);expect(result.stderr).toContain('unexpected_source_changes');
});

it('accepts the one expected change regardless of object key order, and rejects deletions and observer changes',()=>{
 const before={[stage]:'a',observer:'same'},after={observer:'same',[stage]:'b'};
 expect(check(before,after).status).toBe(0);
 for(const candidate of ([{[stage]:'b'},{[stage]:'b',observer:'changed'},{...before}] as Record<string,string>[])){
  const result=check(before,candidate);expect(result.status).not.toBe(0);expect(result.stderr).toContain('unexpected_source_changes');
 }
});

it('requires the expected modified source to exist on both sides',()=>{
 for(const [before,after]of [[{observer:'same'},{observer:'same',[stage]:'new'}],[{observer:'same',[stage]:'old'},{observer:'same'}]]){
  const result=check(before as Record<string,string>,after as Record<string,string>);expect(result.status).not.toBe(0);expect(result.stderr).toContain('unexpected_source_changes');
 }
});
