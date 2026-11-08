import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {it,expect} from 'vitest';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const r=JSON.parse(readFileSync('docs/validation/gradle-c3b-cpr-bp-2026-11-08.json','utf8')),sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex'),section=designSection(readFileSync(r.document.path,'utf8'),r.document.heading);
it('pins the raw evidence, current document and regression sources',()=>{expect(sha(readFileSync(r.raw.path))).toBe(r.raw.sha256);expect(sha(section)).toBe(r.document.sectionSha256);for(const [path,digest]of Object.entries(r.regressionSources))expect(sha(readFileSync(path)),path).toBe(digest);});
it('derives every comparison row from the saved values',()=>{
 for(const w of ['default','small','h0Sizes','singleLarge']){const xs=r.comparisons.filter((x:any)=>x.condition.startsWith(w+'/')),range=(k:string)=>{const vs=xs.map((x:any)=>x[k]);return Math.min(...vs).toFixed(2)+'〜'+Math.max(...vs).toFixed(2);};expect(section).toContain('| '+[w,...['scalarMs','referenceMs','combinedMs','planMs','headroomMs'].map(range)].join(' | ')+' |');}
 expect(section).toContain(r.comparisons.reduce((n:number,x:any)=>n+x.combinedBeatsReference,0)+'/96');
});
it('states which diagnostic pairs, including the H0 reader example, took longer under combined',()=>{
 const wall=(w:string,role:string,v:string)=>r.profiles.find((p:any)=>p.workload===w&&p.role===role&&p.variant===v).providerWallMs,f=(n:number)=>n.toFixed(1);
 const slower=r.profiles.filter((p:any)=>p.variant==='combined'&&p.providerWallMs>wall(p.workload,p.role,'reference')).map((p:any)=>p.workload+'/'+p.role);
 expect(slower).toEqual(['default/reader','h0Sizes/reader']);
 expect(section).toContain('default・reader（'+f(wall('default','reader','reference'))+'→'+f(wall('default','reader','combined'))+' ms）の2組');
 expect(section).toContain('reference '+f(wall('h0Sizes','reader','reference'))+' ms、combined '+f(wall('h0Sizes','reader','combined'))+' ms');
 expect(section).toContain('broker '+f(wall('h0Sizes','authority-broker','reference'))+'→'+f(wall('h0Sizes','authority-broker','combined'))+' ms');
 expect(section).toContain('reader '+f(wall('singleLarge','reader','reference'))+'→'+f(wall('singleLarge','reader','combined'))+' ms');
});
it('keeps limited scope and the unachieved adoption gate visible',()=>{expect(r.proceedToCprC).toBe(false);expect(r.productionAdopted).toBe(false);expect(r.scope.realStorageVerified).toBe(false);expect(section).toContain('CPR-Cの全workload接続は見送り');expect(section).toContain('原本読取省略0');});
