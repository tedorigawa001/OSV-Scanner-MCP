/** Rebuild or verify the H0 diagnostic decision; never changes a read deadline. */
import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {analyzeH0} from '../src/test/fixtures/gradleOwnedH0Report.mjs';
const base='docs/validation/gradle-c3b-cgp-h0-2026-11-05',rawPath=base+'.measurements.json',outPath=base+'.json',bytes=await readFile(rawPath),raw=JSON.parse(bytes),hash=b=>createHash('sha256').update(b).digest('hex');
// The measuring tools themselves: a change means the saved run no longer describes them. Product sources may move on.
const measuringTools=['src/test/fixtures/h0_child.mjs','src/test/fixtures/gradleOwnedH0Probe.ts','src/test/fixtures/gradleOwnedH0Instrument.ts','src/test/fixtures/gradleOwnedH0Process.ts','src/test/fixtures/gradleOwnedCgpHistory.ts','src/test/fixtures/gradleOwnedCgpPages.ts','src/test/utils/gradleOwnedH0Native.test.ts'];
const checkSources={};for(const name of ['gradleOwnedH0Report.mjs','gradleOwnedCgpHistoryCheck.mjs'])checkSources['src/test/fixtures/'+name]=hash(await readFile(new URL('../src/test/fixtures/'+name,import.meta.url)));
const result={...analyzeH0(raw),measurement:{path:rawPath,sha256:hash(bytes)},analysisSource:{path:'scripts/analyze-c3b-cgp-h0.mjs',sha256:hash(await readFile(new URL(import.meta.url)))},checkSources,scope:'three independent local five-process bootstraps; instrumented v1 full path plus read-only fixed-depth probes; no actual batching or speed approval'};
// Recorded by the people and runs that verified the summary; this script cannot derive them.
const recordedKeys=['verification','reviewCorrections','documentSha256'];let saved={};try{saved=JSON.parse(await readFile(outPath));}catch(e){if(e.code!=='ENOENT')throw e;}
if(process.argv.includes('--check')){
 for(const k of recordedKeys)if(!Object.hasOwn(saved,k))throw Error('h0_summary_missing:'+k);
 for(const [k,v]of Object.entries(result))if(JSON.stringify(saved[k])!==JSON.stringify(v))throw Error('h0_summary_mismatch:'+k);
 for(const file of measuringTools)if(raw.executionSources.files[file]!==hash(await readFile(file)))throw Error('h0_measurement_source_changed:'+file);
 for(const [file,digest]of Object.entries(saved.verification.regressionSources))if(digest!==hash(await readFile(file)))throw Error('h0_regression_source_changed:'+file);
 console.log('H0 summary and decision matched raw evidence');
}else{await writeFile(outPath,JSON.stringify({...result,...Object.fromEntries(recordedKeys.filter(k=>Object.hasOwn(saved,k)).map(k=>[k,saved[k]]))},null,2)+'\n');console.log(JSON.stringify({decision:result.decision,samples:result.samples.map(s=>({sample:s.sample,index:s.index,outcome:s.outcome,elapsedMs:s.elapsedMs})),comparisons:result.projectedGrowth.map(p=>({sample:p.sample,from:p.fromDepth,to:p.toDepth,comparable:p.comparableCompletedDepths,growthMs:p.serialReplayWorkGrowthMs,medianGrowthMs:p.serialReplayWorkGrowthMedianMs,batchMs:p.optimisticBatchRemovableSpanMs}))},null,2));}
