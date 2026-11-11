import {it,expect} from 'vitest';import {writeFileSync} from 'node:fs';
import {vf3pOracles} from '../fixtures/gradleOwnedCwcVf3pOracle.js';
import {runCwcVf3p} from '../fixtures/gradleOwnedCwcVf3p.js';
import {vf3pObserverSources} from '../fixtures/gradleOwnedCwcVf3pProfile.js';
it.skipIf(!process.env.CWC_VF3P_EVIDENCE_PATH)('VF3P real 288-trial comparison preserves failures, progress and observer costs',async()=>{
 const functional=await vf3pOracles(),methods=vf3pObserverSources(),m=await runCwcVf3p(functional);
 const bytes=JSON.stringify({measurement:m,methods});writeFileSync(process.env.CWC_VF3P_EVIDENCE_PATH!,bytes);if(process.env.CWC_VF3P_RAW_PATH)writeFileSync(process.env.CWC_VF3P_RAW_PATH,bytes);expect(m.rows).toHaveLength(288);expect(m.comparison.measured).toBe(216);
},1900000);
