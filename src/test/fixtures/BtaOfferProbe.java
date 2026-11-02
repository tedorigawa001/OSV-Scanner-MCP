// Test-only owner broker. Public BTA instances are retained inside this class; no production API.
import org.jetbrains.kotlin.buildtools.api.*;
import org.jetbrains.kotlin.buildtools.api.jvm.*;
import java.nio.file.*;
import java.io.*;
import java.util.*;

public final class BtaOfferProbe {
 static final List<String> PHASES=List.of("registration","generation","seal","binding","precheck","call","postcheck","capture");
 static final List<String> LIMITS=List.of("offered-inputs-only","no-natural-consumption-receipt","no-all-writer-exclusion","no-compiler-internal-supplier-proof","no-transparent-kgp-integration","snapshot-slot-only","no-compiler-work-witness");
 static Map<String,Object> m(Object...kv){return BtaOwnedDriver.m(kv);}
 static final class Rejected extends RuntimeException {Rejected(String reason){super(reason);}}
 private static final class Handle {
  final Broker owner;final String name;final List<Object> phases=new ArrayList<>();final Map<String,Object> envelope;
  int next=0;boolean used=false,failed=false,active=false;String sourceHash;JvmCompilationConfiguration configuration;
  ClasspathSnapshotBasedIncrementalCompilationApproachParameters parameter;CompilationService service;ProjectId project;
  List<Path> snapshots;List<Map<String,Object>> descriptors;Path source,out,ic;List<String> args;
  Handle(Broker owner,String name){this.owner=owner;this.name=name;envelope=m("schema","osv-mcp.gradle-owned-offer-v1","graphId","graph","exportId",owner.exportId,"project",":","invocation",name,"stage","consumer","slot","snapshot","profileId",owner.profileId,"producerState","completed","limitations",LIMITS,"naturalContentBinding",false,"phases",phases);}
 }
 private static final class Broker {
  final Set<String> names=new HashSet<>();final Map<String,Handle> handles=new HashMap<>();final String exportId,profileId;boolean closed=false;int calls=0;final List<Object> audit=new ArrayList<>();
  Broker(String exportId,String profileId){this.exportId=exportId;this.profileId=profileId;}
  Handle begin(String name){if(closed)throw new Rejected("registration_closed");if(!names.add(name))throw new Rejected("duplicate_begin");var h=new Handle(this,name);handles.put(name,h);return h;}
  void start(Handle h,String phase){if(h.owner!=this||h.failed||h.active||h.next>=PHASES.size()||!PHASES.get(h.next).equals(phase))throw new Rejected("phase_invalid");h.active=true;h.phases.add(m("phase",phase,"outcome","begin"));}
  void success(Handle h,String phase,Object evidence){if(!h.active||!PHASES.get(h.next).equals(phase))throw new Rejected("phase_invalid");h.active=false;h.phases.add(m("phase",phase,"outcome","success","evidence",evidence));if(!phase.equals("capture"))h.next++;}
  void failure(Handle h,String phase,String reason){if(!h.active||!PHASES.get(h.next).equals(phase))throw new Rejected("phase_invalid");h.active=false;h.phases.add(m("phase",phase,"outcome","failure","evidence",m("reason",reason,"produced","not-produced")));h.failed=true;h.envelope.put("producerState","failed");h.envelope.put("failurePhase",phase);h.envelope.put("failureReason",reason);}
  void bind(Handle h,CompilationService service,ProjectId project,List<Path> snapshots,Path source,Path out,Path ic,List<String> args)throws Exception{
   start(h,"binding");h.service=service;h.project=project;h.snapshots=List.copyOf(snapshots);h.source=source;h.sourceHash=BtaOwnedDriver.hashFile(source);h.out=out;h.ic=ic;h.args=List.copyOf(args);
   h.configuration=service.makeJvmCompilationConfiguration();
   var incremental=h.configuration.makeClasspathSnapshotBasedIncrementalCompilationConfiguration();incremental.setRootProjectDir(BtaOwnedDriver.root.toFile()).setBuildDir(BtaOwnedDriver.root.resolve("build").toFile()).useOutputDirs(List.of(out.toFile(),ic.toFile()));
   h.parameter=new ClasspathSnapshotBasedIncrementalCompilationApproachParameters(Collections.unmodifiableList(snapshots.stream().map(Path::toFile).toList()),ic.resolve("shrunk-classpath-snapshot.bin").toFile());
   h.configuration.useIncrementalCompilation(ic.toFile(),SourcesChanges.Unknown.INSTANCE,h.parameter,incremental);
   success(h,"binding",m("configurationId",h.name+"-config","parameterId",h.name+"-parameter","serviceId","service","projectId",h.name+"-project","snapshotIds",h.descriptors.stream().map(x->x.get("id")).toList(),"sourceSha256",h.sourceHash,"argumentsSha256",BtaOwnedDriver.hash(BtaOwnedDriver.json(h.args).getBytes(java.nio.charset.StandardCharsets.UTF_8)),"outputPath",BtaOwnedDriver.root.relativize(h.out).toString()));
  }
  void consume(Handle h,CompilationService service,ProjectId project,JvmCompilationConfiguration actual,ClasspathSnapshotBasedIncrementalCompilationApproachParameters parameter)throws Exception{
   if(!closed||h.owner!=this||h.used||h.failed)throw new Rejected("configuration_reused");
   start(h,"precheck");
   if(h.service!=service||h.project!=project||h.configuration!=actual||h.parameter!=parameter||!parameter.getNewClasspathSnapshotFiles().equals(h.snapshots.stream().map(Path::toFile).toList())){failure(h,"precheck","binding_mismatch");return;}
   if(!h.sourceHash.equals(BtaOwnedDriver.hashFile(h.source))||!check(h)){failure(h,"precheck","stale");return;}
   success(h,"precheck",m("matched",true));h.used=true;start(h,"call");
   if(h.name.equals("completed"))expectReject(audit,"reentry",()->{try{consume(h,service,project,actual,parameter);}catch(Rejected e){throw e;}catch(Exception e){throw new RuntimeException(e);}},"configuration_reused",this);
   calls++;
   CompilationResult result;
   try{result=service.compileJvm(project,service.makeCompilerExecutionStrategyConfiguration().useInProcessStrategy(),actual,List.of(h.source.toFile()),h.args);}
   catch(Exception ex){failure(h,"call","compile_failed");callError(h,"exception",ex.getClass().getName());return;}
   if(result!=CompilationResult.COMPILATION_SUCCESS){failure(h,"call","compile_failed");callError(h,"result",result.toString());return;}
   success(h,"call",m("result",result.toString(),"configurationId",h.name+"-config","parameterId",h.name+"-parameter","executionEvidence","bta-call-only","compilerWorkStatus","unknown","outputs",BtaOwnedDriver.tree(h.out)));
   start(h,"postcheck");if(h.name.equals("post-failed"))BtaOwnedDriver.flip(h.snapshots.get(0));
   if(!check(h)){failure(h,"postcheck","stale");return;}success(h,"postcheck",m("matched",true));
  }
  @SuppressWarnings("unchecked") void callError(Handle h,String kind,String detail){var event=(Map<String,Object>)h.phases.get(h.phases.size()-1);var data=(Map<String,Object>)event.get("evidence");data.put("errorKind",kind);data.put("detail",detail);}
  boolean check(Handle h)throws Exception{
   for(var f:h.descriptors){for(String k:List.of("baselinePath","path")){Path p=BtaOwnedDriver.root.resolve((String)f.get(k));byte[] b=BtaOwnedDriver.safeBytes(p,p.getParent());if(b.length!=((Number)f.get("size")).longValue()||!BtaOwnedDriver.hash(b).equals(f.get("sha256")))return false;}}
   return true;
  }
 }
 static void expectReject(List<Object> audit,String mode,Runnable action,String reason,Broker b){int before=b.calls;try{action.run();throw new AssertionError("fault not rejected: "+mode);}catch(Rejected e){if(!e.getMessage().equals(reason)||b.calls!=before)throw new AssertionError(mode);audit.add(m("mode",mode,"reason",reason,"callsBefore",before,"callsAfter",b.calls));}}
 public static void main(String[] argv)throws Exception{
  Path root=Path.of(argv[0]).toRealPath(),stdlib=Path.of(argv[1]).toRealPath();String exportId=argv[2],profileId=argv[3];BtaOwnedDriver.root=root;
  Path build=root.resolve("build/proof");Files.createDirectories(build);Path lib=build.resolve("Library.kt"),libOut=build.resolve("library-classes"),jar=build.resolve("library.jar");Files.createDirectories(libOut);Files.writeString(lib,BtaOwnedDriver.LIB);
  var service=CompilationService.loadImplementation(BtaOfferProbe.class.getClassLoader());var libraryProject=new ProjectId.ProjectUUID(UUID.randomUUID());
  var result=service.compileJvm(libraryProject,service.makeCompilerExecutionStrategyConfiguration().useInProcessStrategy(),service.makeJvmCompilationConfiguration(),List.of(lib.toFile()),BtaOwnedDriver.arguments(libOut,stdlib.toString(),"offerLibrary"));
  if(result!=CompilationResult.COMPILATION_SUCCESS)throw new AssertionError(result);service.finishProjectCompilation(libraryProject);BtaOwnedDriver.jar(libOut,jar);
  Path template=build.resolve("template");Files.createDirectories(template);List<Map<String,Object>> generated=new ArrayList<>();
  for(Path input:List.of(jar,stdlib)){String id=input.equals(jar)?"library.snapshot":"stdlib.snapshot";var snapshot=service.calculateClasspathSnapshot(input.toFile(),ClassSnapshotGranularity.CLASS_MEMBER_LEVEL);Path out=template.resolve(id);snapshot.saveSnapshot(out.toFile());generated.add(m("id",id,"size",Files.size(out),"sha256",BtaOwnedDriver.hashFile(out),"inputSha256",BtaOwnedDriver.hashFile(input)));}
  var broker=new Broker(exportId,profileId);var negative=broker.audit;var envelopes=new ArrayList<Object>();
  List<String> modes=List.of("completed","storage-failed","call-failed","post-failed","foreign-config","foreign-project","foreign-parameter","stale-precheck","source-changed");
  for(String mode:modes)broker.begin(mode);
  expectReject(negative,"duplicate-begin",()->broker.begin("completed"),"duplicate_begin",broker);broker.closed=true;
  for(String mode:modes){
   Handle h=broker.handles.get(mode);broker.start(h,"registration");broker.success(h,"registration",m("producerSha256",argv[4],"runtimeSha256",argv[5],"profileSha256",argv[6]));
   broker.start(h,"generation");broker.success(h,"generation",m("librarySha256",BtaOwnedDriver.hashFile(jar),"generatorSha256",BtaOwnedDriver.hashFile(Path.of(service.getClass().getProtectionDomain().getCodeSource().getLocation().toURI())),"snapshots",generated));
   Path work=build.resolve(mode);Files.createDirectories(work);Path stage=work.resolve("staging"),saved=work.resolve("evidence"),ic=work.resolve("ic"),out=work.resolve("classes");for(Path d:List.of(stage,saved,ic,out))Files.createDirectories(d);
   broker.start(h,"seal");h.descriptors=new ArrayList<>();List<Path> snapshots=new ArrayList<>();
   for(var f:generated){String id=(String)f.get("id");Path p=stage.resolve(id),baseline=saved.resolve(id);Files.copy(template.resolve(id),p);Files.copy(p,baseline);snapshots.add(p);h.descriptors.add(m("id",id,"path",root.relativize(p).toString(),"baselinePath",root.relativize(baseline).toString(),"size",f.get("size"),"sha256",f.get("sha256")));}
   if(mode.equals("storage-failed")){
    try{Files.writeString(saved.resolve("library.snapshot"),"fault",StandardOpenOption.CREATE_NEW);throw new AssertionError("write should fail");}catch(FileAlreadyExistsException expected){broker.failure(h,"seal","storage_failed");}envelopes.add(h.envelope);continue;
   }
   broker.success(h,"seal",m("files",h.descriptors));Path source=work.resolve("Consumer.kt");Files.writeString(source,mode.equals("call-failed")?"not valid kotlin @@@":BtaOwnedDriver.consumer("v2"));var project=new ProjectId.ProjectUUID(UUID.randomUUID());
   try{
    broker.bind(h,service,project,snapshots,source,out,ic,BtaOwnedDriver.arguments(out,jar+File.pathSeparator+stdlib,"offerConsumer"));
    if(mode.equals("source-changed"))Files.writeString(source,BtaOwnedDriver.consumer("changed"));
    if(mode.equals("stale-precheck"))BtaOwnedDriver.flip(snapshots.get(0));
    var supplied=mode.equals("foreign-config")?service.makeJvmCompilationConfiguration():h.configuration;
    var suppliedProject=mode.equals("foreign-project")?new ProjectId.ProjectUUID(UUID.randomUUID()):project;
    var suppliedParameter=mode.equals("foreign-parameter")?new ClasspathSnapshotBasedIncrementalCompilationApproachParameters(h.parameter.getNewClasspathSnapshotFiles(),ic.resolve("other.bin").toFile()):h.parameter;
    broker.consume(h,service,suppliedProject,supplied,suppliedParameter);
    if(mode.equals("completed")){
     expectReject(negative,"reuse",()->{try{broker.consume(h,service,project,h.configuration,h.parameter);}catch(Rejected ex){throw ex;}catch(Exception ex){throw new RuntimeException(ex);}},"configuration_reused",broker);
     expectReject(negative,"phase-after-completion",()->broker.start(h,"binding"),"phase_invalid",broker);
    }
    if(mode.equals("call-failed"))expectReject(negative,"failed-reuse",()->{try{broker.consume(h,service,project,h.configuration,h.parameter);}catch(Rejected ex){throw ex;}catch(Exception ex){throw new RuntimeException(ex);}},"configuration_reused",broker);
   }finally{service.finishProjectCompilation(project);}envelopes.add(h.envelope);
  }
  broker.closed=true;expectReject(negative,"late-registration",()->broker.begin("late"),"registration_closed",broker);
  envelopes.add(m("schema","osv-mcp.gradle-owned-offer-v1","graphId","graph","exportId",exportId,"project",":","invocation","unsupported","stage","consumer","slot","snapshot","profileId",profileId,"producerState","unavailable","limitations",LIMITS,"naturalContentBinding",false,"phases",List.of(),"unavailableReason","execution_unsupported","blockedBeforePhase","registration","noRead",true));
  Files.writeString(root.resolve("offer-report.json"),BtaOwnedDriver.json(m("schema","osv-mcp.bta-offer-probe-v2","envelopes",envelopes,"rejections",negative,"btaConsumerCalls",broker.calls,"libraryCalls",1,"libraryCompilation",m("result",result.toString(),"sourceSha256",BtaOwnedDriver.hashFile(lib),"jarSha256",BtaOwnedDriver.hashFile(jar),"outputs",BtaOwnedDriver.tree(libOut)),"snapshotGeneration",m("generatorSha256",BtaOwnedDriver.hashFile(Path.of(service.getClass().getProtectionDomain().getCodeSource().getLocation().toURI())),"snapshots",generated),"generatedSnapshots",generated.size(),"actualCompilerVersion",service.getCompilerVersion(),"javaSha256",BtaOwnedDriver.hashFile(Path.of(System.getProperty("java.home"),"bin/java")),"driverClasses",BtaOwnedDriver.tree(root.resolve("build/driver-classes")),"naturalContentBinding",false,"productionAdopted",false)));
 }
}
