/** Test-only checks of observed public Task manifests, not independent compiler execution proof. */
export function assessKotlinStages(report:any,producer:string,source:string,precompiled:boolean):{complete:boolean;reasons:string[];adapterPaths:string[]} {
 const reasons:string[]=[],builds=report.builds.filter((b:any)=>b.build===producer),receipts=builds.flatMap((b:any)=>b.receipts);
 if(builds.length!==1)reasons.push('kotlin_producer_ambiguous');
 const success=(r:any)=>r.didWork&&!r.skipped&&!r.failure;
 const compiles=receipts.filter((r:any)=>r.task===':compileKotlin'&&success(r));
 const compile=compiles[0];
 if(compiles.length!==1)reasons.push('kotlin_compile_missing');
 const expected=report.inputs.baseline[source];
 if(!expected||compile?.declaredInputs?.[source]!==expected||report.inputs.changed.length)reasons.push('kotlin_source_input_mismatch');
 if(!compile||!Object.keys(compile.outputs).some(p=>p.startsWith(producer+'/build/classes/kotlin/main/')&&p.endsWith('.class')))reasons.push('kotlin_classes_missing');
 const adapterPaths:string[]=[];
 if(precompiled){
  const generators=receipts.filter((r:any)=>r.task===':generateScriptPluginAdapters'&&success(r));
  const gen=generators[0];
  if(generators.length!==1||gen?.declaredInputs?.[source]!==expected||receipts.indexOf(gen)>=receipts.indexOf(compile))reasons.push('kotlin_adapter_lineage_missing');
  else for(const [p,h]of Object.entries(gen.outputs))if(p.endsWith('.kt')){
   if(!p.startsWith(producer+'/build/')||compile?.declaredInputs?.[p]!==h)reasons.push('kotlin_adapter_input_mismatch');else adapterPaths.push(p);
  }
  if(!adapterPaths.length)reasons.push('kotlin_adapter_missing');
 }
 const jars=receipts.filter((r:any)=>r.task===':jar'&&success(r)&&receipts.indexOf(r)>receipts.indexOf(compile));
 const jar=jars[0],archive=report.kotlinPackage;
 if(jars.length!==1)reasons.push('kotlin_package_missing');
 const prefix=producer+'/build/classes/kotlin/main/';
 const emitted=Object.fromEntries(Object.entries(compile?.outputs??{}).filter(([p])=>p.startsWith(prefix)).map(([p,h])=>[p.slice(prefix.length),h]));
 const entries=new Map<string,string>((archive?.entries??[]).map((e:any)=>[e.path,e.sha256]));
 if(!archive||archive.producer!==producer||archive.invocationId!==report.invocationId||archive.archivePath!==jar?.archivePath||jar?.outputs?.[archive.archivePath]!==archive.sha256)reasons.push('kotlin_package_artifact_mismatch');
 for(const [p,h]of Object.entries(emitted))if(jar?.declaredInputs?.[prefix+p]!==h||entries.get(p)!==h)reasons.push('kotlin_compile_package_mismatch');
 const classNames=(names:string[])=>names.filter(p=>p.endsWith('.class')).sort();
 if(JSON.stringify(classNames([...entries.keys()]))!==JSON.stringify(classNames(Object.keys(emitted))))reasons.push('kotlin_package_class_set_mismatch');
 const apps=Object.values<any>(report.projects??{}).flatMap(p=>p.applications??[]);
 if(!apps.length)reasons.push('kotlin_loaded_class_missing');
 for(const a of apps){
  const p=a.implementationClass?.replaceAll('.','/')+'.class';
  if(!emitted[p]||entries.get(p)!==emitted[p]||a.loadedClassSha256!==emitted[p]||a.builtJarPath!==archive?.archivePath)reasons.push('kotlin_loaded_class_mismatch');
 }
 return {complete:!reasons.length,reasons:[...new Set(reasons)],adapterPaths};
}
