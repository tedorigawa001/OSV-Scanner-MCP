/** R1-HB design/source consistency only; HBC runtime conditions are planned. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
import {R1HB_DESIGN,R1HB_REGIONS,R1HB_SOURCE_FACTS,R1HB_COMPONENTS,r1hbEnvelope,r1hbTopology} from '../fixtures/gradleOwnedCwcR1hbDesign.mjs';
const r=JSON.parse(readFileSync(process.env.CWC_R1HB_DESIGN_RECORD_PATH??'docs/validation/gradle-cwc-r1hb-design-2026-11-13.json','utf8'));
const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex'),section=designSection(readFileSync(r.document.path,'utf8'),r.document.heading);
const q=(upper:number|null,unit='logical-byte')=>({unit,upper});
const unknown=()=>({activeReads:4,epochReadLimit:64,entryLimit:256,refusalLimit:64,parentLimit:q(1048576),...Object.fromEntries(R1HB_COMPONENTS.map(k=>[k,q(null)]))});
const finite=()=>({...unknown(),globalResident:q(4096),readReusable:q(0),readEpoch:q(8192),entryEpoch:q(16),refusalEpoch:q(0),framesReusable:q(8192),bootstrapReusable:q(8192)});
const graph=()=>({entry:'core',modules:[{id:'core',role:'core',artifact:'a'.repeat(64),edges:['port','pure']},{id:'port',role:'reader-port',artifact:'b'.repeat(64),edges:[] as string[]},{id:'pure',role:'pure-helper',artifact:'c'.repeat(64),edges:[] as string[]}]});
const condition=(id:string)=>r.conditions.find((x:any)=>x.id===id).condition;
it('RHBD01: binds the new section, immutable baselines and all source bytes',()=>{
 expect(sha(section)).toBe(r.document.sha256);for(const b of r.baselines)expect(sha(readFileSync(b.path))).toBe(b.sha256);for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);expect(r.contract).toEqual(R1HB_DESIGN);expect(r.regions).toEqual(R1HB_REGIONS);
});
it('RHBD02: keeps forty runtime conditions and four implementation steps planned',()=>{
 expect(r.conditions.map((x:any)=>x.id)).toEqual(Array.from({length:40},(_,i)=>'HBC'+String(i+1).padStart(2,'0')));for(const x of r.conditions){expect(x.executed).toBe(false);expect(x.status).toBe('planned');expect(section).toContain('| '+x.id+' | '+x.condition+' |');}
 expect(r.designChecksPassed).toBe(24);expect(r.runtimeRegressionsExecuted).toBe(false);expect(r.steps.map((x:any)=>x.id)).toEqual(['HB-1','HB-2','HB-3','HB-4']);for(const x of r.steps)expect(x.executed).toBe(false);
});
it('RHBD03: inventories real literal counts while leaving representation and physical sizes unknown',()=>{
 expect(r.sourceFacts).toEqual(R1HB_SOURCE_FACTS);const x=r.sourceFacts,f=x.descriptorFormula;expect(f.bodies*(f.handleDescriptorsPerBody+f.referenceDescriptorsPerBody+f.bodyListDescriptorsPerBody)).toBe(114);expect(x.perRead.descriptorLiteralEvaluations).toBe(114);expect(x.perRead.persistentArrays).toBe(5);expect(x.perRead.opaqueIdentities).toBe(16);expect(x.perRead.referencePositions).toBe(96);expect(x.countIsRepresentationCharge).toBe(false);expect(x.physicalUpperBytes).toBeNull();
 for(const a of r.sourceAudit){const s=readFileSync(a.path,'utf8'),i=s.indexOf(a.needle);expect(i).toBeGreaterThanOrEqual(0);expect(a.line).toBe(s.slice(0,i).split('\n').length);expect(a.sourceDigest).toBe(sha(s));}
});
it('RHBD04: rejects an observer in the same artifact even when it is unreachable in declared imports',()=>{
 const g=graph();g.modules.push({id:'diag',role:'diagnostic',artifact:'a'.repeat(64),edges:[]});expect(()=>r1hbTopology(g)).toThrow('artifact_boundary');expect(R1HB_DESIGN.boundaries.observerFlagIsSeparation).toBe(false);expect(condition('HBC02')).toContain('同artifact');
});
it('RHBD05: rejects direct and transitive controller or observer edges',()=>{
 for(const role of ['controller','diagnostic','harness','record-validator']){const g=graph();g.modules.push({id:'outside',role,artifact:'d'.repeat(64),edges:[]});g.modules[2]!.edges.push('outside');expect(()=>r1hbTopology(g)).toThrow('boundary');}
});
it('RHBD06: rejects missing edges, duplicate IDs and oversized declared graphs',()=>{
 const missing=graph();missing.modules[0]!.edges.push('hidden');expect(()=>r1hbTopology(missing)).toThrow('edge_closure');const duplicate=graph();duplicate.modules.push({...duplicate.modules[0]!});expect(()=>r1hbTopology(duplicate)).toThrow('module');
 const many={entry:'0',modules:Array.from({length:65},(_,i)=>({id:String(i),role:i?'pure-helper':'core',artifact:'a'.repeat(64),edges:[]}))};expect(()=>r1hbTopology(many)).toThrow('modules');
 const edges={entry:'0',modules:Array.from({length:64},(_,i)=>({id:String(i),role:i?'pure-helper':'core',artifact:'a'.repeat(64),edges:i<5?Array.from({length:64},(_,j)=>String(j)):[]}))};expect(()=>r1hbTopology(edges)).toThrow('edge_closure');
});
it('RHBD07: accepts closed declared module cycles only as metadata without proving actual imports',()=>{
 const g=graph();g.modules[2]!.edges.push('core');const x=r1hbTopology(g);expect(x.declaredCoreModules).toBe(3);expect(x.status).toBe('metadata-shape-only');expect(x.actualClosureProved||x.loaderPermitIssued||x.runtimeAdmitted).toBe(false);expect(condition('HBC06')).toContain('実load閉包');
});
it('RHBD08: never treats a role label or source hash as loader or port authority',()=>{
 const x=r1hbTopology(graph());expect(x.runtimeAdmitted).toBe(false);expect(R1HB_DESIGN.boundaries.portBrandIsAuthorization).toBe(false);expect(R1HB_DESIGN.boundaries.declaredGraphIsLoadedClosureProof).toBe(false);expect(R1HB_DESIGN.quota.sourceHashIsAllocationProof).toBe(false);for(const t of ['prototype.constructor','controllerをmint','実loaderのresolution witness'])expect(section).toContain(t);
});
it('RHBD09: reproduces typed hypothetical allocation debt without double charging live read arenas',()=>{
 const x=r1hbEnvelope(finite());expect(x.upper).toBe(806912);expect(x.terms.readReusable).toBe(0);expect(x.terms.readEpoch).toBe(524288);expect(x.terms.entryEpoch).toBe(262144);expect(x.conditionalFits).toBe(true);expect(x.certificateVerified||x.runtimeAdmitted).toBe(false);expect(r.arithmetic.hypotheticalFit).toEqual(x);
 expect(x.reservedOrdinaryEntriesPerRead).toBe(240);expect(x.reservedCleanupEntriesPerRead).toBe(16);expect(x.reservedOrdinaryEntriesPerRead+x.reservedCleanupEntriesPerRead).toBe(256);
});
it('RHBD10: distinguishes conditional upper overflow from a proved lower-bound rejection',()=>{
 const x=r1hbEnvelope({...finite(),entryEpoch:q(32)});expect(x.upper).toBe(1069056);expect(x.parentLimit).toBe(1048576);expect(x.status).toBe('conditional-upper-exceeds-parent');expect(x.knownLower).toBe(0);expect(x.conditionalFits).toBe(false);expect(r.arithmetic.hypotheticalOver).toEqual(x);
});
it('RHBD11: charges G once without dividing by live read count or resetting epoch allocation',()=>{
 const a=r1hbEnvelope({...finite(),activeReads:1}),b=r1hbEnvelope(finite());expect(a.terms.globalResident).toBe(4096);expect(b.terms.globalResident).toBe(4096);expect(a.terms.readEpoch).toBe(b.terms.readEpoch);expect(a.upper).toBe(b.upper);
 const c=r1hbEnvelope({...finite(),readReusable:q(4096)}),d=r1hbEnvelope({...finite(),activeReads:1,readReusable:q(4096)});expect(c.upper-d.upper).toBe(3*4096);expect(condition('HBC20')).toContain('g/R');
});
it('RHBD12: retains unknown upper bounds even for a zero refusal quota',()=>{
 const x=r1hbEnvelope(unknown());expect(x.upper).toBeNull();expect(x.conditionalFits).toBeNull();expect(x.status).toBe('unsupported-uncovered');expect(r.arithmetic.unknown).toEqual(x);const y=r1hbEnvelope({...finite(),refusalLimit:0,refusalEpoch:q(null)});expect(y.upper).toBeNull();expect(y.knownLower).toBe(0);
});
it('RHBD13: rejects unit substitution instead of silently converting objects or payload to ledger bytes',()=>{
 for(const unit of ['payload-byte','object-count','reference-count','physical-byte'])expect(()=>r1hbEnvelope({...finite(),readEpoch:q(8192,unit)})).toThrow('unit');expect(R1HB_DESIGN.units).toHaveLength(5);expect(condition('HBC17')).toContain('無証拠換算');
});
it('RHBD14: rejects malformed quotas, expanded parent limits and unsafe arithmetic',()=>{
 for(const [k,value]of [['activeReads',5],['epochReadLimit',65],['entryLimit',257],['refusalLimit',65]] as const)expect(()=>r1hbEnvelope({...finite(),[k]:value})).toThrow();expect(()=>r1hbEnvelope({...finite(),activeReads:4,epochReadLimit:1})).toThrow('quota');
 for(const value of [-1,-0,NaN,Infinity,1.5])expect(()=>r1hbEnvelope({...finite(),entryEpoch:q(value)})).toThrow();expect(()=>r1hbEnvelope({...finite(),parentLimit:q(1048577)})).toThrow('parent_limit');expect(()=>r1hbEnvelope({...finite(),readEpoch:q(Number.MAX_SAFE_INTEGER)})).toThrow('overflow');
 expect(()=>r1hbEnvelope({...finite(),entryLimit:16})).toThrow('quota');
});
it('RHBD15: cannot supply release, approval or processed-row flags to reduce reserved allocation',()=>{
 for(const flag of [{drained:true},{actualAttempts:1},{certificateVerified:true},{newEpoch:true},{actualEntries:1}])expect(()=>r1hbEnvelope({...finite(),...flag})).toThrow('keys');const q=R1HB_DESIGN.quota;for(const k of ['attemptsReduceReservations','retryResetsEpoch','failedEntryRefund','oldEpochDebtClearedByNewOwner','logicalDrainIsGcWitness'])expect(q[k]).toBe(false);
});
it('RHBD16: rejects getters, nested proxies, sparse metadata and inherited record fields without invoking callbacks',()=>{
 let reads=0;const v=finite();Object.defineProperty(v.readEpoch,'upper',{get(){reads++;return 1;},enumerable:true});expect(()=>r1hbEnvelope(v)).toThrow('accessor');const g=graph();Object.defineProperty(g.modules[0]!,'edges',{get(){reads++;return [];},enumerable:true});expect(()=>r1hbTopology(g)).toThrow('accessor');
 expect(()=>r1hbTopology(new Proxy(graph(),{ownKeys(){reads++;return [];}}))).toThrow();expect(()=>r1hbEnvelope(Object.create(finite()))).toThrow();expect(reads).toBe(0);const sparse=graph();delete (sparse.modules as any)[1];expect(()=>r1hbTopology(sparse)).toThrow('array');
});
it('RHBD17: assigns eighteen distinct regions and seven exclusive lifetime classes without giving them byte bounds',()=>{
 expect(R1HB_REGIONS.map(x=>x.id)).toEqual(Array.from({length:18},(_,i)=>'HB'+String(i+1).padStart(2,'0')));for(const x of R1HB_REGIONS){expect(x.approvedUpper).toBeNull();expect(x.actualParentBound).toBe(false);expect(R1HB_DESIGN.lifetimeClasses).toContain(x.lifetime);expect(section).toContain('| '+x.id+' |');}expect(R1HB_DESIGN.lifetimeClasses).toHaveLength(7);expect(section).toContain('同じresourceをepoch debtとreusable arenaの両方');
});
it('RHBD18: keeps controller mutation inaccessible and checks approval revision with each live gate',()=>{
 const p=R1HB_DESIGN.port;expect(p.readerExportsMutation||p.readerConstructorEscapesAllowed||p.callerRoleFlagAccepted||p.freshSnapshotIsCachedAuthority).toBe(false);for(const k of ['authorization','purpose','pin','revision','approvalRevision','cancellation','originalDeadline','remainingOriginalBudget'])expect(p.currentChecks).toContain(k);expect(condition('HBC10')).toContain('承認registry');expect(section).toContain('影響するRの公開を拒否');
});
it('RHBD19: specifies independent evidence, non-circular signatures and all six helper contracts',()=>{
 expect(R1HB_DESIGN.evidence).toHaveLength(11);const c=R1HB_DESIGN.certificate;expect(c.selfDigestInBody||c.certificatePinEmbeddedInCore||c.unknownRegionPermitsLoad).toBe(false);expect(c.maximumRegions).toBe(32);expect(c.evidenceRefsPerRegion).toBe(8);for(const h of R1HB_DESIGN.helpers)expect(section).toContain('| '+h+' |');for(const t of ['循環hash','独立issuer','実parent／unit／予約vector'])expect(section).toContain(t);
});
it('RHBD20: reserves bootstrap validation before load and never treats a refusal path as free',()=>{
 expect(R1HB_DESIGN.limits.bootstrapMetadataBytes).toBe(65536);expect(R1HB_DESIGN.limits.modules).toBe(64);expect(R1HB_DESIGN.limits.edges).toBe(256);for(const t of ['検査workspace自体','coreを一度loadしてから','D到達後','cleanup用capacity','guard前に評価'])expect(section).toContain(t==='検査workspace自体'?'署名／hash／parserのworkspace自体':t);expect(condition('HBC24')).toContain('無制限Error');
 expect(R1HB_DESIGN.limits.cleanupEntriesPerRead).toBe(16);expect(section).toContain('E=256の内側に普通entry240・cleanup entry16');expect(section).toContain('cleanup retryも16枠から消費');
});
it('RHBD21: preserves opaque-handle caller debt and separates logical drain from allocator release',()=>{
 for(const t of ['旧caller alias','全C／D参照','allocator／process境界','payload6144 Bとwrapper','actual処理件数'])expect(section).toContain(t);expect(condition('HBC25')).toContain('GC／allocator');expect(R1HB_SOURCE_FACTS.entryExample.publicEntryCountBoundInCurrentFixture).toBeNull();
});
it('RHBD22: keeps copying observer costs, summary transport and full schema tests outside this proof',()=>{
 for(const t of ['同じprocess内の同居量を0にせず','別のinstrumented artifact','n=1の算術／不完全inventory拒否','summary512 B'])expect(section).toContain(t);expect(condition('HBC33')).toContain('receiver copy');expect(condition('HBC37')).toContain('n=2／19');
});
it('RHBD23: records source audits as finite source evidence and keeps R1-H0 ineligible for adoption',()=>{
 expect(r.sourceAudit).toHaveLength(6);expect(r.sourceFacts.observerAndFaultsInCurrentArtifact).toBe(true);expect(r.sourceFacts.actualAdmittedArtifact).toBe(false);expect(r.sourceFacts.sourceAuditIsAstCensus).toBe(false);expect(section).toContain('現在のartifactは本契約の採用対象外');
 const source=readFileSync('src/test/fixtures/gradleOwnedCwcR1h.ts','utf8');expect(source).toContain('static observe(');expect(source).toContain('arm(fault:Fault)');
});
it('RHBD24: leaves every runtime, loader, certificate, work and physical proof unimplemented',()=>{
 for(const [k,v]of Object.entries(R1HB_DESIGN.scope))expect(v,k).toBe(k==='designOnly');expect(r.status).toBe('design-only');expect(Object.isFrozen(R1HB_DESIGN)).toBe(true);for(const x of Object.values(r.arithmetic) as any[]){expect(x.runtimeAdmitted||x.certificateVerified).toBe(false);expect(x.fullReadBudgetFits).toBeNull();expect(x.physicalUpperBytes).toBeNull();}expect(r.topology.runtimeAdmitted||r.topology.actualClosureProved).toBe(false);
});
