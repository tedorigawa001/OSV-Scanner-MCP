import {it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {vf3Oracles} from '../fixtures/gradleOwnedCwcVf3Oracle.js';
import {runCwcVf3} from '../fixtures/gradleOwnedCwcVf3.js';
it.skipIf(!process.env.CWC_VF3_EVIDENCE_PATH)('VF3 real comparison: preserve every warmup, failure and measured attempt',async()=>{
 const functional=await vf3Oracles(),m=await runCwcVf3(functional);writeFileSync(process.env.CWC_VF3_EVIDENCE_PATH!,JSON.stringify(m));expect(m.rows).toHaveLength(288);expect(m.summary.measured).toBe(216);
},1900000);
