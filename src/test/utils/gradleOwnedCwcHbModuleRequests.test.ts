import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';

// Node 22.20+ reports vm ModuleRequest without `phase`; CI's Node 22 job failed with hb2_bootstrap_attributes.
// The harness reshapes requests in a child process, because SourceTextModule needs --experimental-vm-modules.
const run=(mode:string)=>JSON.parse(execFileSync(process.execPath,['--experimental-vm-modules','--no-warnings','scripts/run-cwc-hb-module-requests.mjs',mode],{encoding:'utf8',timeout:60000}).trim().split('\n').at(-1)!);

it.each(['native','node22'])('HBM01 HB1/HB2 preflight accepts %s evaluation imports',mode=>{
 expect(run(mode)).toEqual({hb1:'accepted',hb2:'accepted'});
});
it.each(['source','attributes','no-attributes'])('HBM02 HB1/HB2 preflight still rejects %s requests',mode=>{
 expect(run(mode)).toEqual({hb1:'hb1_bootstrap_import_attributes',hb2:'hb2_bootstrap_attributes'});
});
