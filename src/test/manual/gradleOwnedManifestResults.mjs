import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {canonicalBytes,sha256,verifyManifest,stages,failureCases} from '../fixtures/ownedManifestContract.mjs';
import {offerJdkProfile} from '../fixtures/btaOfferContract.mjs';
import {manifestFixture} from '../fixtures/ownedManifestFixtures.mjs';
export const vectors=[{z:['日本語 空白/%','same','same'],a:Array.from({length:32},(_,i)=>String.fromCharCode(i)).join('')+'\u007f\u2028\u2029😀\\"'},[null,true,false,0,9007199254740991],{'z':2,'a':1},['a','b','a'],'\ufeffsource\r\n','source\n','\ud800','\udc00',-1,-0,1.5,9007199254740992];
const sources=['src/test/fixtures/ownedManifestContract.mjs','src/test/fixtures/ownedManifestContract.d.mts','src/test/fixtures/ownedManifestFixtures.mjs','src/test/fixtures/ManifestCanonicalProbe.java','src/test/manual/gradleOwnedManifestResults.mjs','src/test/gradle/ownedManifest.test.ts'];
export function fingerprints(){return Object.fromEntries(sources.map(p=>[p,sha256(readFileSync(p))]));}
export function staticCases(){const cases=[['completed','offer'],...['failed','unavailable'].flatMap(s=>['none',...stages.slice(0,4)].map(t=>[s,t]))];return cases.map(([state,through])=>{const f=manifestFixture(state,through);return {state,through,result:verifyManifest(f.transport,f.expected)};}).concat(failureCases.map(c=>{const i=stages.indexOf(c.stage),f=manifestFixture('failed',i?stages[i-1]:'none',c);return {...c,result:verifyManifest(f.transport,f.expected)};}));}
function wire(v){const chunks=[],byte=n=>chunks.push(Buffer.from([n])),int=n=>{const b=Buffer.alloc(4);b.writeInt32BE(n);chunks.push(b);},str=s=>{int(s.length);const b=Buffer.alloc(s.length*2);for(let i=0;i<s.length;i++)b.writeUInt16BE(s.charCodeAt(i),i*2);chunks.push(b);};function put(x){if(x===null)byte(0);else if(typeof x==='boolean')byte(x?2:1);else if(typeof x==='number'){byte(3);str(Object.is(x,-0)?'-0':String(x));}else if(typeof x==='string'){byte(4);str(x);}else if(Array.isArray(x)){byte(5);int(x.length);x.forEach(put);}else {byte(6);int(Object.keys(x).length);for(const [k,v]of Object.entries(x)){str(k);put(v);}}}put(v);const body=Buffer.concat(chunks),header=Buffer.alloc(4);header.writeInt32BE(body.length);return Buffer.concat([header,body]);}
if(process.argv[1]&&resolve(process.argv[1])===resolve('src/test/manual/gradleOwnedManifestResults.mjs')){
 const home=process.env.JAVA_HOME??'/private/tmp/osv-gradle-jdk/jdk-21.0.13+9/Contents/Home';
 const dir=mkdtempSync(join(tmpdir(),'owned-manifest-'));try{
 const run=(name,args,opts={})=>{const r=spawnSync(join(home,'bin',name),args,{encoding:'utf8',...opts});if(r.status!==0)throw Error(r.stderr||r.error?.message||name);return r.stdout;};
 for(const name of ['java','javac'])if(sha256(readFileSync(join(home,'bin',name)))!==offerJdkProfile[name].sha256)throw Error('Unapproved canonical probe JDK: '+name);
 run('javac',['-d',dir,'src/test/fixtures/ManifestCanonicalProbe.java']);
 const outputs=run('java',['-cp',dir,'ManifestCanonicalProbe'],{input:Buffer.concat(vectors.map(wire))}).trim().split('\n');
 const comparison=vectors.map((v,i)=>{let node;try{node=canonicalBytes(v).toString('base64');}catch{node='REJECT';}if(node!==outputs[i])throw Error('Java/Node mismatch '+i);return {vector:i,node,java:outputs[i],matched:true};});
 const result={schema:'osv-mcp.owned-manifest-static-validation-v1',date:'2026-11-02',nodeVersion:process.version,scope:'static metadata only; no Gradle, KGP or BTA execution; no real file completeness or natural-consumption receipt',sources:fingerprints(),jdk:{version:run('java',['--version']).trim(),javaSha256:sha256(readFileSync(join(home,'bin/java'))),javacSha256:sha256(readFileSync(join(home,'bin/javac'))),probeClassSha256:sha256(readFileSync(join(dir,'ManifestCanonicalProbe.class')))},canonicalComparison:comparison,cases:staticCases()};
 writeFileSync('docs/validation/gradle-owned-manifest-contract-2026-11-02.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({canonicalVectors:comparison.length,staticCases:result.cases.length}));
 }finally{rmSync(dir,{recursive:true,force:true});}
}
