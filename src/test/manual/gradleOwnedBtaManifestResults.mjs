// Consolidate real native evidence; does not execute builds or refresh approvals.
import {readFileSync,writeFileSync} from 'node:fs';
import {bridgeSources,bridgeVerificationSources} from '../fixtures/ownedBtaManifestExpected.mjs';
import {verifyBtaManifestTuple,verifyBtaManifestRecord,bridgeFingerprints} from '../fixtures/ownedBtaManifestContract.mjs';
import {assertNoAbsolutePaths} from './kgpRecordPaths.mjs';
const [prefix,out]=process.argv.slice(2);if(!prefix||!out)throw Error('usage: prefix output');
const cases=[];for(const v of ['8.11.1','9.2.1']){const m=JSON.parse(readFileSync(prefix+'-'+v+'.json','utf8'));if(m.schema!=='owned-bta-matrix-v1'||m.cases.length!==2||m.cases.some(t=>t.gradleVersion!==v))throw Error('invalid matrix');cases.push(...m.cases);}
const scope={};for(const t of cases)for(const [k,v]of Object.entries(verifyBtaManifestTuple(t)))scope[k]=(scope[k]??0)+v;
const record={schema:'owned-bta-manifest-proof-v1',recordedAt:new Date().toISOString(),sourceHashes:bridgeFingerprints(bridgeSources),verificationHashes:bridgeFingerprints(bridgeVerificationSources),scope,limitations:['test-only','owned-javac-recipe-with-explicit-pinned-runtime-classpath','no-production-profile-or-import','no-full-jdk-or-node-image-approval','executor-and-loader-assurances-are-producer-claims','no-independent-loaded-byte-proof','no-kgp-getters-used-but-no-global-observer-proof','no-natural-consumption-byte-receipt','compiler-work-status-unknown','no-arbitrary-concurrent-writer-exclusion'],cases};verifyBtaManifestRecord(record);assertNoAbsolutePaths(record);writeFileSync(out,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(scope));
