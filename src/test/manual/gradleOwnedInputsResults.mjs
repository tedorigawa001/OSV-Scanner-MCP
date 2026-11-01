/** Revalidate native observations against their original and current source hashes. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {ownedInputSourcePaths,ownedInputEvidenceTargets,verifyOwnedInputsCase} from '../fixtures/gradleOwnedInputsProof.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const [prefix,output]=process.argv.slice(2);
if(!prefix||!output)throw Error('usage: node gradleOwnedInputsResults.mjs <matrix-prefix> <output>');
const digest=async p=>createHash('sha256').update(await readFile(path.join(repo,p))).digest('hex');
const sourcesSha256=Object.fromEntries(await Promise.all(ownedInputSourcePaths.map(async p=>[p,await digest(p)])));
const matrices=[];
for(const gradleVersion of ['8.11.1','9.2.1']){
 const m=JSON.parse(await readFile(prefix+'-'+gradleVersion+'.json','utf8'));
 if(m.schema!=='osv-mcp.owned-input-matrix-v2'||m.gradleVersion!==gradleVersion||m.cases.length!==2||new Set(m.cases.map(c=>c.consumerDSL)).size!==2)throw Error('incomplete-native-matrix');
 for(const consumerDSL of ['Groovy','Kotlin']){
  const c=m.cases.find(c=>c.consumerDSL===consumerDSL);
  if(!c)throw Error('missing-native-case');
  const approval={gradleVersion,consumerDSL,producerDSL:consumerDSL,sourcesSha256};
  c.decision=verifyOwnedInputsCase(c,approval);
  if(!Array.isArray(c.evidenceRejections)||c.evidenceRejections.length!==ownedInputEvidenceTargets.length)throw Error('missing-event-rejections');
  for(let i=0;i<ownedInputEvidenceTargets.length;i++){
   const target=ownedInputEvidenceTargets[i],saved=c.evidenceRejections[i];
   if(saved.runIndex!==target.runIndex||saved.mode!==target.mode||saved.event!==target.event||saved.accepted!==false||saved.reason!=='owned_proof_event_inventory_invalid')throw Error('invalid-event-rejection');
   const changed=structuredClone(c),record=changed.runs[target.runIndex].cases.find(s=>s.mode===target.mode);
   record.events=record.events.filter(e=>e.event!==target.event);
   let outcome,reason;
   try{outcome=verifyOwnedInputsCase(changed,approval);}catch(error){reason=error.message;}
   if(outcome!==undefined||reason!==saved.reason)throw Error('event-rejection-replay-mismatch');
  }
 }
 if(!Array.isArray(m.rejections)||m.rejections.length!==2||new Set(m.rejections.map(r=>r.proof.consumerDSL)).size!==2)throw Error('missing-pre-gate-fault');
 for(const consumerDSL of ['Groovy','Kotlin']){
  const saved=m.rejections.find(r=>r.proof.consumerDSL===consumerDSL);
  if(!saved||saved.accepted!==false||saved.reason!=='owned_proof_getter_before_gate'||saved.proof.preGateRead!==true)throw Error('invalid-pre-gate-fault');
  let outcome,reason;
  try{outcome=verifyOwnedInputsCase(saved.proof,{gradleVersion,consumerDSL,producerDSL:consumerDSL,sourcesSha256,preGateRead:true});}catch(error){reason=error.message;}
  if(outcome!==undefined||reason!==saved.reason)throw Error('pre-gate-fault-not-reproduced');
 }
 matrices.push(m);
}
const verificationSourcesSha256=Object.fromEntries(await Promise.all(['src/test/gradle/ownedInputs.test.ts','src/test/manual/gradleOwnedInputsResults.mjs'].map(async p=>[p,await digest(p)])));
let preReview;
try{const old=JSON.parse(await readFile(output,'utf8'));preReview=old.preReview??{schema:old.schema,recordedAt:old.recordedAt,sourcesSha256:old.sourcesSha256,scope:old.scope,recordSha256:createHash('sha256').update(await readFile(output)).digest('hex'),note:'Initial v1 evidence before getter/event inventory review fixes; not current v2 evidence.'};}catch(error){if(error.code!=='ENOENT')throw error;}
const result={schema:'osv-mcp.owned-input-experiment-v2',recordedAt:new Date().toISOString(),baselineRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sourcesSha256,verificationSourcesSha256,
 scope:{productionChanged:false,productionAdoptions:0,fullPipelineCandidates:0,helperCandidates:4,nativeBuilds:12,scenarioComparisons:20,observerRejections:16,preGateReadRejections:4,eventOmissionRejections:280,
 consumerDSL:['Groovy','Kotlin'],producerDSL:['Groovy','Kotlin'],dslPairing:'same-DSL pairs; not all four cross-products',producer:'included build root, binary Kotlin with standard kotlin-dsl; applied Groovy helper source hashed as producer input',maxWorkers:1,parallel:false,
 observer:'owned file collection getter only; KGP public getter closures are forbidden by an unsupported recipe gate',
 limitations:['not a full pipeline observer noninterference proof','not all internal suppliers observed','not a general complete registration adapter','no buildSrc or precompiled proof','no toolchain capture recipe established','no production schema or static importer','no snapshot blob storage or OSV integration']},matrices,...(preReview?{preReview}:{})};
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result.scope));
