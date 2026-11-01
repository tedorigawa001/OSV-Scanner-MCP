import { mkdtemp,mkdir,writeFile,rm,unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe,it,expect } from "vitest";
import { manifestLiteral, checkLiteralBinding, mappingDecision, verifyPipelineContent, assessPipelinePackage } from "../fixtures/gradleKotlinPipelineProof.js";
describe("Kotlin pipeline package literal contract (test-only)",()=>{
 it("requires the preapproved literal even when temporary input and JAR agree",()=>{
  const base={recipe:"gradle-jar-manifest-input-v1",stage:":jar",slot:"manifest",temporaryRoot:"producer/build/tmp/jar",path:"producer/build/tmp/jar/MANIFEST.MF",publicInputs:["producer/build/tmp/jar/MANIFEST.MF"],input:manifestLiteral,entry:manifestLiteral};
  expect(checkLiteralBinding(base)).toEqual([]);
  const wrong=Buffer.from("Manifest-Version: 9.0\r\n\r\n");
  expect(checkLiteralBinding({...base,input:wrong,entry:wrong})).toEqual(["kotlin_package_literal_file_mismatch","kotlin_package_entry_mismatch"]);
 });
});

describe("mapping assertions are independent of input verification",()=>{
 const assertions={buildInputs:"all-plugin-build-inputs-listed",mutation:"immutable-during-export",mapping:"source-artifact-mapping-reviewed"};
 it.each([undefined,"not-asserted"])("accepts valid unasserted mapping without rewriting raw bytes: %s",mapping=>{
  const raw=JSON.stringify({assertions:{...assertions,mapping}});
  const before=raw;
  expect(mappingDecision(raw,[JSON.stringify({assertions})],true)).toEqual({inputStatus:"verified",declarationsComplete:false,reason:"kotlin_source_mapping_assertion_missing"});
  expect(raw).toBe(before);
 });
 it.each([null,false,"reviewed",42])("rejects malformed mapping: %s",mapping=>{
  expect(mappingDecision(JSON.stringify({assertions:{...assertions,mapping}}),[],true).reason).toBe("kotlin_pipeline_schema_invalid");
 });
 it("does not let an unasserted mapping hide corrupt inputs",()=>{
  expect(mappingDecision(JSON.stringify({assertions:{...assertions,mapping:"not-asserted"}}),[],false).reason).toBe("kotlin_stage_lineage_mismatch");
 });
 it("requires every contributing spec and the pipeline to assert mapping",()=>{
  const raw=JSON.stringify({assertions});
  expect(mappingDecision(raw,[raw],true).declarationsComplete).toBe(true);
  expect(mappingDecision(raw,[JSON.stringify({assertions:{...assertions,mapping:"not-asserted"}})],true).declarationsComplete).toBe(false);
 });
});

describe("persisted snapshot revalidation",()=>{
 const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 it("streams a large toolchain snapshot, rejects small-class relabeling, and rechecks each ref",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'osv-kotlin-content-'));
  try{
   const blob=Buffer.alloc(1024**2,7),id=sha(blob),size=19*1024**2;
   await mkdir(path.join(root,'.proof/pipeline-blobs'),{recursive:true});await writeFile(path.join(root,'.proof/pipeline-blobs',id),blob);
   const ref={size,sha256:sha(Buffer.alloc(size,7)),chunks:Array.from({length:19},()=>({size:blob.length,sha256:id}))};
   await expect(verifyPipelineContent(root,ref,true)).resolves.toBeUndefined();
   await expect(verifyPipelineContent(root,ref,false)).rejects.toThrow('kotlin_pipeline_budget_exceeded');
   await writeFile(path.join(root,'.proof/pipeline-blobs',id),Buffer.alloc(blob.length,8));
   await expect(verifyPipelineContent(root,ref,true)).rejects.toThrow('kotlin_pipeline_snapshot_storage_mismatch');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it.each(['deleted','size','order','hash'])("rejects persisted storage corruption: %s",async mutation=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'osv-kotlin-content-'));
  try{
   const a=Buffer.alloc(1024**2,1),b=Buffer.alloc(1024**2,2),ah=sha(a),bh=sha(b),dir=path.join(root,'.proof/pipeline-blobs');
   await mkdir(dir,{recursive:true});await writeFile(path.join(dir,ah),a);await writeFile(path.join(dir,bh),b);
   const ref={size:a.length+b.length,sha256:sha(Buffer.concat([a,b])),chunks:[{size:a.length,sha256:ah},{size:b.length,sha256:bh}]};
   if(mutation==='deleted')await unlink(path.join(dir,ah));
   if(mutation==='size')ref.size++;
   if(mutation==='order')ref.chunks.reverse();
   if(mutation==='hash')ref.sha256='0'.repeat(64);
   await expect(verifyPipelineContent(root,ref,true)).rejects.toThrow('kotlin_pipeline_snapshot_storage_mismatch');
  }finally{await rm(root,{recursive:true,force:true});}
 });
});

describe("package literal slot rejection",()=>{
 const base={recipe:"gradle-jar-manifest-input-v1",stage:":jar",slot:"manifest",temporaryRoot:"producer/build/tmp/jar",path:"producer/build/tmp/jar/MANIFEST.MF",publicInputs:["producer/build/tmp/jar/MANIFEST.MF"],input:manifestLiteral,entry:manifestLiteral};
 it.each([
  {recipe:"other"},{stage:":otherJar"},{slot:"resources"},{temporaryRoot:"other/build/tmp/jar"},
  {path:"producer/build/tmp/jar/../jar/MANIFEST.MF"},{path:"/tmp/MANIFEST.MF"},{publicInputs:[]},
  {publicInputs:[base.path,base.path]},
 ])("rejects a literal with an incorrect consumer binding: %j",patch=>{
  expect(checkLiteralBinding({...base,...patch})).toEqual(["kotlin_package_literal_binding_invalid"]);
 });
 it("distinguishes one-sided corruption",()=>{
  expect(checkLiteralBinding({...base,input:Buffer.from('bad')})).toEqual(['kotlin_package_literal_file_mismatch']);
  expect(checkLiteralBinding({...base,entry:Buffer.from('bad')})).toEqual(['kotlin_package_entry_mismatch']);
 });
});
describe("required assertion fields",()=>{
 it.each([{}, {assertions:null},{assertions:false},{assertions:[]},{assertions:{mapping:'not-asserted'}},
  {assertions:{buildInputs:'all-plugin-build-inputs-listed',mutation:'changed',mapping:'not-asserted'}}])("does not treat malformed required assertions as mere non-assertion: %j",manifest=>{
  expect(mappingDecision(JSON.stringify(manifest),[],true).reason).toBe('kotlin_pipeline_schema_invalid');
 });
});

describe("expected package inventory",()=>{
 function fixture(){
  const producer='logic',hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  const files={'A.class':'class','META-INF/logic.kotlin_module':'module'},resources={'settings.txt':'resource','META-INF/services/proof.Service':'service'};
  const compile={task:':compileKotlin',outputs:Object.fromEntries(Object.entries(files).map(([p,b])=>[producer+'/build/classes/kotlin/main/'+p,hash(b)]))};
  const descriptor={task:':pluginDescriptors',outputs:{[producer+'/build/pluginDescriptors/proof.properties']:hash('descriptor')}};
  const baseline=Object.fromEntries(Object.entries(resources).map(([p,b])=>[producer+'/src/main/resources/'+p,hash(b)]));
  const copied={...resources,'META-INF/gradle-plugins/proof.properties':'descriptor'};
  const copy={task:':processResources',declaredInputs:{...baseline,...descriptor.outputs},outputs:Object.fromEntries(Object.entries(copied).map(([p,b])=>[producer+'/build/resources/main/'+p,hash(b)]))};
  const jar={task:':jar',declaredInputs:{...compile.outputs,...copy.outputs}};
  const entries=Object.entries({...files,...copied}).map(([p,b])=>({path:p,sha256:hash(b)}));
  entries.push({path:'META-INF/MANIFEST.MF',sha256:hash(manifestLiteral.toString())});
  return {producer,report:{inputs:{baseline},builds:[{build:producer,receipts:[compile,descriptor,copy,jar]}],kotlinPackage:{entries}}};
 }
 it('rejects a missing mandatory MANIFEST even when every remaining entry has an owner',()=>{
  const {producer,report}=fixture();
  expect(assessPipelinePackage(report,producer).complete).toBe(true);
  report.kotlinPackage.entries=report.kotlinPackage.entries.filter(e=>e.path!=='META-INF/MANIFEST.MF');
  expect(assessPipelinePackage(report,producer).reasons).toContain('kotlin_package_origin_incomplete');
 });
 it.each(['settings.txt','META-INF/services/proof.Service','META-INF/gradle-plugins/proof.properties'])('rejects an expected file never copied to the package: %s',entry=>{
  const {producer,report}=fixture();
  report.kotlinPackage.entries=report.kotlinPackage.entries.filter(e=>e.path!==entry);
  const output=producer+'/build/resources/main/'+entry;
  for(const t of report.builds[0]!.receipts){if('outputs'in t)delete t.outputs[output];if('declaredInputs'in t)delete t.declaredInputs[output];}
  expect(assessPipelinePackage(report,producer).reasons).toContain('kotlin_package_origin_incomplete');
 });

});
