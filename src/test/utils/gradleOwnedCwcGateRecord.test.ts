import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {validateGateRows,gateTableRows} from '../fixtures/gradleOwnedCwcGate.js';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
it('revalidates persisted gate costs, comparison closure and summary',()=>{
 const path=process.env.CWC_GATE_RECORD_PATH;if(!path)return;
 const m=JSON.parse(readFileSync(path,'utf8'));
 expect(validateGateRows(m.rows,m.rounds,['small','mid-2048','large-commit','large-payload','h0Sizes','singleLarge'],'real')).toEqual(m.summary);
 if(process.env.CWC_GATE_SKIP_DOCUMENT_TABLE!=='1'){
  const section=designSection(readFileSync('docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md','utf8'),'### 9.125 CWC-Gate：接続費用の軽量分解と優先順位の変更');
  for(const row of gateTableRows(m.summary))expect(section).toContain(row);
 }
});
