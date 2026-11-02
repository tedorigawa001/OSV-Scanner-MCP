// Consolidates already executed native matrices; does not run builds or update approvals.
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {hash} from '../fixtures/gradleBtaDriverProof.mjs';
import {offerSources,offerVerificationSources,verifyOfferCase} from '../fixtures/btaOfferProof.mjs';
import {assertNoAbsolutePaths} from './kgpRecordPaths.mjs';
const [prefix,out]=process.argv.slice(2);if(!prefix||!out)throw Error('usage: prefix output');
const cases=[];for(const version of ['8.11.1','9.2.1']){
 const matrix=JSON.parse(await readFile(prefix+'-'+version+'.json','utf8'));
 if(matrix.schema!=='osv-mcp.bta-offer-matrix-v1'||matrix.cases.length!==2||matrix.cases.some(c=>c.gradleVersion!==version)||matrix.cases.map(c=>c.dsl).join()!=='Groovy,Kotlin')throw Error('invalid-matrix');cases.push(...matrix.cases);
}
const fingerprints=async files=>Object.fromEntries(await Promise.all(files.map(async f=>[f,hash(await readFile(f))])));
const sourcesSha256=await fingerprints(offerSources),verificationSourcesSha256=await fingerprints(offerVerificationSources);
const scope={};for(const c of cases){if(JSON.stringify(c.sourceHashes)!==JSON.stringify(sourcesSha256))throw Error('stale-native-source');for(const [k,v]of Object.entries(verifyOfferCase(c)))scope[k]=(scope[k]??0)+v;}
let preReviews=[];try{const old=await readFile(out,'utf8'),previous=JSON.parse(old);preReviews=previous.schema==='osv-mcp.bta-offer-contract-experiment-v1'?[{schema:previous.schema,sha256:hash(old),recordedAt:previous.recordedAt,scope:previous.scope,note:'Uncommitted pre-review v1; superseded by fresh native evidence.'}]:(previous.preReviews??[]);}catch(error){if(error.code!=='ENOENT')throw error;}
const result={preReviews,schema:'osv-mcp.bta-offer-contract-experiment-v2',recordedAt:new Date().toISOString(),baselineRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourcesSha256,verificationSourcesSha256,scope,limitations:['test-only','published-metadata-replay-only','no-native-noop-test','no-consumer-byte-receipt','no-production-adoption'],cases};
assertNoAbsolutePaths(result);await writeFile(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(scope));
