/** Controlled process-epoch fixture bootstrap. Private epoch cell never crosses the candidate reader surface. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createContext,SourceTextModule,SyntheticModule} from 'node:vm';
import {issueHb2Owner} from './gradleOwnedCwcHb2EpochOwner.mjs';
import {instrumentHb2} from './gradleOwnedCwcHb2Observer.mjs';
import {hb2LedgerSnapshot} from './gradleOwnedCwcHb2LedgerObserver.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const paths={core:'gradleOwnedCwcHb2Core.mjs',port:'gradleOwnedCwcHb2ReaderPort.mjs',cell:'gradleOwnedCwcHb1ScalarReader.mjs',admission:'gradleOwnedCwcHb2Admission.mjs'};
const original={};for(const [k,p]of Object.entries(paths))original[k]=await readFile(new URL(p,import.meta.url),'utf8');Object.freeze(original);
const approval=Object.freeze(JSON.parse(await readFile(new URL('gradleOwnedCwcHb2Approval.json',import.meta.url))));
const need=(v,r)=>{if(!v)throw 'hb2_bootstrap_'+r;};
function imports(s,id){const m=new SourceTextModule(s,{identifier:'hb2:preflight-'+id,context:createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}})});return m.moduleRequests.map(r=>{need(r.phase==='evaluation'&&Object.keys(r.attributes).length===0,'attributes');return r.specifier;});}
export function verifyHb2Candidate(sources=original,proposal=approval){need(Object.keys(sources).sort().join(',')==='admission,cell,core,port','sources');const edges={core:imports(sources.core,'core'),port:imports(sources.port,'port'),cell:imports(sources.cell,'cell'),admission:imports(sources.admission,'admission')};need(JSON.stringify(edges)===JSON.stringify({core:['hb2:reader-port'],port:['hb2:injected-reader'],cell:[],admission:[]}),'closure');need(approval.schema==='cwc.hb2.fixture-approval.v1'&&proposal.schema===approval.schema,'approval');for(const k of Object.keys(paths))need(sha(sources[k])===approval[k]&&proposal[k]===approval[k],'artifact_pin');return {...approval,edges};}
export const HB2_SCOPE=Object.freeze({limitedQuotaFixture:true,sameProcess:true,fixedClock:true,separateDiagnosticArtifact:true,processLocalSingletonEpoch:true,sharedAcrossOwners:true,ordinaryCleanupSeparated:true,logicalDebtRetained:true,preAdmissionPrimitiveOnly:true,syntheticCallScope:true,
 durableRestartFencing:false,hostileHostIsolation:false,independentDeploymentIssuer:false,signedRegistryApproval:false,independentChargeApproved:false,bootstrapAllocationCovered:false,actualAuthenticatedCall:false,cwcRootFactConnected:false,originalUnitWorkCoverage:false,actualParentLedgerVector:false,allocatorReleaseProved:false,physicalHeapBound:false,wholeBudgetFit:false,nativeAllocationFailureCoverage:false,summaryConnected:false,productionAdopted:false,performanceMeasured:false});
export async function createHb2Fixture(mode,capacity=1,kind='candidate'){
 need(arguments.length<=3&&(kind==='candidate'||kind==='diagnostic'),'options');const accepted=verifyHb2Candidate(),issued=issueHb2Owner(mode,capacity),context=createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}}),resolutions=[];
 const denied=()=>{throw 'hb2_dynamic_import_denied';};
 async function helper(key,id){const m=new SourceTextModule(original[key],{context,identifier:id,importModuleDynamically:denied});await m.link(()=>{throw 'hb2_helper_link';});await m.evaluate({timeout:1000});return m;}
 const cell=await helper('cell','hb2:scalar-code'),quota=await helper('admission','hb2:admission-code');
 const current=cell.namespace.makeHb1CurrentReader(issued.cell),admission=quota.namespace.makeHb2Admission(issued.epoch,issued.binding.owner,issued.ordinal);
 const injected=new SyntheticModule(['binding','current','admission'],function(){this.setExport('binding',issued.binding);this.setExport('current',current);this.setExport('admission',admission);},{context,identifier:'hb2:injected-reader'});
 const control=new SyntheticModule(['control'],function(){this.setExport('control',issued.controller);},{context,identifier:'hb1:diagnostic-control'});
 const port=new SourceTextModule(original.port,{context,identifier:'hb2:reader-port',importModuleDynamically:denied}),source=kind==='candidate'?original.core:instrumentHb2(original.core),core=new SourceTextModule(source,{context,identifier:'hb2:core',importModuleDynamically:denied});
 await core.link((specifier,from)=>{resolutions.push({from:from.identifier,to:specifier});if(from===core&&specifier==='hb2:reader-port')return port;if(from===port&&specifier==='hb2:injected-reader')return injected;if(kind==='diagnostic'&&from===core&&specifier==='hb1:diagnostic-control')return control;throw 'hb2_link_denied';});await core.evaluate({timeout:1000});
 const reader=core.namespace.reader,diagnostic=kind==='diagnostic'?core.namespace.diagnostic:undefined;
 return {reader,controller:issued.controller,diagnostic,owner:issued.ordinal,epochKey:issued.epoch.key,ledger:()=>hb2LedgerSnapshot(issued.epoch),
  witness:{owner:issued.ordinal,kind,exports:Object.keys(core.namespace),resolutions,core:sha(source),candidate:accepted.core,port:accepted.port,cell:accepted.cell,admission:accepted.admission,approvedCandidate:kind==='candidate',evaluated:core.status==='evaluated',scope:HB2_SCOPE},
  async consumer(source){const m=new SourceTextModule(source,{context,identifier:'hb2:consumer',importModuleDynamically:denied}),r=new SyntheticModule(['reader'],function(){this.setExport('reader',reader);},{context,identifier:'hb2:reader'});await m.link(s=>{if(s!=='hb2:reader')throw 'hb2_consumer_link';return r;});await m.evaluate({timeout:1000});return m.namespace.result;}
 };
}
