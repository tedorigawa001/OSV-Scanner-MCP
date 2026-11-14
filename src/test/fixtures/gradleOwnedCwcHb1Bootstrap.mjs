/** Trusted fixture bootstrap. The candidate linker never exposes this module, its issuer, or diagnostics. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createContext,SourceTextModule,SyntheticModule} from 'node:vm';
import {issueFixtureOwner} from './gradleOwnedCwcHb1Controller.mjs';
import {instrumentHb1} from './gradleOwnedCwcHb1Observer.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex'),need=(v,r)=>{if(!v)throw Error('hb1_bootstrap_'+r);};
const coreURL=new URL('./gradleOwnedCwcHb1Core.mjs',import.meta.url),portURL=new URL('./gradleOwnedCwcHb1ReaderPort.mjs',import.meta.url);
const approval=Object.freeze(JSON.parse(await readFile(new URL('./gradleOwnedCwcHb1Approval.json',import.meta.url),'utf8')));
const original=Object.freeze({core:await readFile(coreURL,'utf8'),port:await readFile(portURL,'utf8'),cell:await readFile(new URL('./gradleOwnedCwcHb1ScalarReader.mjs',import.meta.url),'utf8')});
let evaluations=0,helperEvaluations=0;
export function hb1EvaluationCount(){return {core:evaluations,helper:helperEvaluations};}
// Native module requests include static side-effect imports and re-exports. Parsing never evaluates code.
// Exact external fixture pins additionally reject ANY unapproved text, including unreachable dynamic loaders.
function imports(source,id){const module=new SourceTextModule(source,{identifier:'hb1:preflight-'+id,context:createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}})});return module.moduleRequests.map(r=>{need(Object.keys(r.attributes).length===0&&r.phase==='evaluation','import_attributes');return r.specifier;});}
export function verifyHb1Candidate(sources=original,proposal=approval){need(sources&&Object.keys(sources).sort().join(',')==='cell,core,port','sources');
 const edges={core:imports(sources.core,'core'),port:imports(sources.port,'port'),cell:imports(sources.cell,'cell')};need(JSON.stringify(edges)===JSON.stringify({core:['hb1:reader-port'],port:['hb1:injected-reader'],cell:[]}),'closure');
 need(approval.schema==='cwc.hb1.fixture-approval.v1'&&proposal.schema===approval.schema,'approval');
 need(sha(sources.core)===approval.core&&sha(sources.port)===approval.port&&sha(sources.cell)===approval.cell&&proposal.core===approval.core&&proposal.port===approval.port&&proposal.cell===approval.cell,'artifact_pin');
 return {schema:approval.schema,core:approval.core,port:approval.port,cell:approval.cell,edges,fixtureApprovalOnly:true};
}
export const HB1_SCOPE=Object.freeze({limitedArtifactFixture:true,sameProcess:true,fixedClock:true,controlledModuleLinker:true,separateCandidateAndDiagnosticArtifacts:true,closedReaderSurface:true,fixtureBootstrapIssuer:true,fixtureSourcePins:true,hostDiagnosticResident:true,syntheticCallScope:true,
 hostileHostIsolation:false,independentDeploymentIssuer:false,signedRegistryApproval:false,productionLoaderWitness:false,loaderChargeProved:false,actualAuthenticatedCall:false,cwcRootFactConnected:false,independentChargeApproved:false,physicalHeapBound:false,actualParentLedgerVector:false,originalUnitWorkCoverage:false,summaryConnected:false,r1mExit:false,productionAdopted:false,performanceMeasured:false});
export async function createHb1Fixture(mode,capacity=1,kind='candidate'){
 need(kind==='candidate'||kind==='diagnostic','kind');const accepted=verifyHb1Candidate(),issued=issueFixtureOwner(mode,capacity);
 const context=createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false},name:'hb1-fixture'}),resolutions=[];
 // Never reject into the consumer with a host Error/Function prototype chain.
 const denyDynamic=()=>{throw 'hb1_dynamic_import_denied';};
 // Evaluate the pure helper only AFTER all three external fixture pins were verified.
 const scalarCode=new SourceTextModule(original.cell,{context,identifier:'hb1:scalar-code',importModuleDynamically:denyDynamic});await scalarCode.link(()=>{throw Error('hb1_scalar_link');});helperEvaluations++;await scalarCode.evaluate({timeout:1000});
 const readCurrent=scalarCode.namespace.makeHb1CurrentReader(issued.cell);
 const injected=new SyntheticModule(['binding','current'],function(){this.setExport('binding',issued.binding);this.setExport('current',readCurrent);},{context,identifier:'hb1:injected-reader'});
 const diagnosticControl=new SyntheticModule(['control'],function(){this.setExport('control',issued.controller);},{context,identifier:'hb1:diagnostic-control'});
 const port=new SourceTextModule(original.port,{context,identifier:'hb1:reader-port',importModuleDynamically:denyDynamic});
 const text=kind==='candidate'?original.core:instrumentHb1(original.core);
 const core=new SourceTextModule(text,{context,identifier:'hb1:core',importModuleDynamically:denyDynamic});
 async function linker(specifier,from){resolutions.push({from:from.identifier,to:specifier});if(from===core&&specifier==='hb1:reader-port')return port;if(from===port&&specifier==='hb1:injected-reader')return injected;if(kind==='diagnostic'&&from===core&&specifier==='hb1:diagnostic-control')return diagnosticControl;throw Error('hb1_link_denied');}
 await core.link(linker);evaluations++;await core.evaluate({timeout:1000});
 const reader=core.namespace.reader,diagnostic=kind==='diagnostic'?core.namespace.diagnostic:undefined;
 const witness={kind,coreDigest:sha(text),candidateDigest:accepted.core,portDigest:accepted.port,cellDigest:accepted.cell,injectedReaderOrigin:'separate-scalar-reader-artifact',cellEvaluated:scalarCode.status==='evaluated',exports:Object.keys(core.namespace),resolutions,approvedCandidate:kind==='candidate'&&sha(text)===accepted.core,evaluated:core.status==='evaluated',scope:HB1_SCOPE};
 return {reader,controller:issued.controller,diagnostic,witness,
  async consumer(source){const module=new SourceTextModule(source,{context,identifier:'hb1:consumer',importModuleDynamically:denyDynamic});const readerModule=new SyntheticModule(['reader'],function(){this.setExport('reader',reader);},{context,identifier:'hb1:reader'});await module.link(specifier=>{need(specifier==='hb1:reader','consumer_link');return readerModule;});await module.evaluate({timeout:1000});return module.namespace.result;}
 };
}
export function hb1NegativeSources(){return {core:original.core,port:original.port,cell:original.cell,approval:{...approval}};}
