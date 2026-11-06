import {it,expect,vi} from 'vitest';
const calls=vi.hoisted(()=>({n:0}));
vi.mock('../../utils/gradleOwnedSourceSchema.js',async original=>{const actual:any=await original();return {...actual,validateSourceCommand:(value:unknown)=>{calls.n++;return actual.validateSourceCommand(value);}};});
const {i1Case}=await import('../fixtures/gradleOwnedCgpI1.js');
async function count(mode:'S*'|'A*'){const f=i1Case(mode);try{const q=f.command('counted');calls.n=0;await f.run(q);return calls.n;}finally{f.close();}}
// A shared envelope must not replace the owner's own payload validation: only the owner's repeated verifier call goes away.
it('A* keeps the owner payload validation and removes only the repeated verifier call',async()=>{const scalar=await count('S*'),facts=await count('A*');expect(scalar-facts).toBe(1);});
