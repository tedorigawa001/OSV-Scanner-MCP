// Test-only producer-owned BTA driver. Offered inputs are NOT a natural-consumption receipt.
import org.jetbrains.kotlin.buildtools.api.*;
import org.jetbrains.kotlin.buildtools.api.jvm.*;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.jar.*;

public final class BtaOwnedDriver {
 static final String LIB="package dep\nclass Library { fun message(): String = \"library-value\" }\n";
 static String consumer(String suffix){return "package consumer\nfun main() { print(dep.Library().message() + \":"+suffix+"\") }\n";}
 static final List<Object> events=new ArrayList<>(),compilations=new ArrayList<>();
 static String phase="bootstrap";static int selections=0,sourceReads=0,storageReads=0;static Path root,stage,evidence;
 static List<File> staged;static final List<Map<String,Object>> sealed=new ArrayList<>();
 static final Map<String,Object> report=new LinkedHashMap<>();
 static Map<String,Object> m(Object...kv){Map<String,Object> r=new LinkedHashMap<>();for(int i=0;i<kv.length;i+=2)r.put(kv[i].toString(),kv[i+1]);return r;}
 static void event(String s){events.add(m("event",s,"phase",phase));}
 static String hash(byte[] bytes)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
 static String hashFile(Path p)throws Exception{return hash(Files.readAllBytes(p));}
 static String relative(Path p){return root.relativize(p).toString();}
 static Object origin(Class<?> c)throws Exception{Path p=Path.of(c.getProtectionDomain().getCodeSource().getLocation().toURI()).toRealPath();return m("type",c.getName(),"artifact",p.toString(),"sha256",hashFile(p));}
 static List<Object> tree(Path directory)throws Exception{
  if(!Files.isDirectory(directory))return List.of();List<Object> result=new ArrayList<>();
  try(var files=Files.walk(directory)){for(Path p:files.filter(x->Files.isRegularFile(x,LinkOption.NOFOLLOW_LINKS)).sorted().toList())result.add(m("path",directory.relativize(p).toString(),"size",Files.size(p),"sha256",hashFile(p)));}
  return result;
 }
 static byte[] safeBytes(Path p,Path boundary)throws Exception{
  if(!boundary.toRealPath().equals(boundary.toAbsolutePath().normalize())||!p.getParent().toRealPath().equals(boundary.toRealPath())||!Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS))throw new IOException("unsafe-staging-file");
  BasicFileAttributes before=Files.readAttributes(p,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
  if(before.fileKey()==null||before.size()>32*1024*1024)throw new IOException("snapshot-budget");
  ByteArrayOutputStream bytes=new ByteArrayOutputStream();
  try(FileChannel channel=FileChannel.open(p,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS)){
   java.nio.ByteBuffer chunk=java.nio.ByteBuffer.allocate(1024*1024);int n;
   while((n=channel.read(chunk))!=-1){if(bytes.size()+n>32*1024*1024)throw new IOException("snapshot-budget");bytes.write(chunk.array(),0,n);chunk.clear();}
  }
  BasicFileAttributes after=Files.readAttributes(p,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
  if(!Objects.equals(before.fileKey(),after.fileKey())||before.size()!=after.size()||!before.lastModifiedTime().equals(after.lastModifiedTime())||after.size()!=bytes.size())throw new IOException("changed-during-read");
  return bytes.toByteArray();
 }
 static List<File> select(){event("selection:begin");selections++;List<File> result=Collections.unmodifiableList(new ArrayList<>(staged));event("selection:end");return result;}
 static Map<String,Object> check()throws Exception{
  int beforeSource=sourceReads,beforeStorage=storageReads;List<Object> current=new ArrayList<>(),saved=new ArrayList<>();
  for(Map<String,Object> f:sealed){Path p=evidence.resolve((String)f.get("id"));byte[] b=safeBytes(p,evidence);storageReads++;String sha=hash(b);saved.add(m("id",f.get("id"),"size",b.length,"sha256",sha));
   if(!sha.equals(f.get("sha256"))||b.length!=((Number)f.get("size")).longValue())return m("reason","kotlin_pipeline_snapshot_storage_mismatch","sourceReads",sourceReads-beforeSource,"storageReads",storageReads-beforeStorage,"current",current,"saved",saved);
  }
  for(Map<String,Object> f:sealed){Path p=stage.resolve((String)f.get("id"));byte[] b=safeBytes(p,stage);sourceReads++;String sha=hash(b);current.add(m("id",f.get("id"),"size",b.length,"sha256",sha));
   if(!sha.equals(f.get("sha256"))||b.length!=((Number)f.get("size")).longValue())return m("reason","kotlin_derived_snapshot_stale","sourceReads",sourceReads-beforeSource,"storageReads",storageReads-beforeStorage,"current",current,"saved",saved);
  }
  return m("reason",null,"sourceReads",sourceReads-beforeSource,"storageReads",storageReads-beforeStorage,"current",current,"saved",saved);
 }
 static List<String> arguments(Path out,String cp,String module){return List.of("-d",out.toString(),"-classpath",cp,"-no-stdlib","-no-reflect","-module-name",module,"-jvm-target","17");}
 // Opaque identities are issued only by the owner; report strings never authorize a call.
 private static final IdentityHashMap<JvmCompilationConfiguration,String> configurationIds=new IdentityHashMap<>();
 private static final IdentityHashMap<ClasspathSnapshotBasedIncrementalCompilationApproachParameters,String> parameterIds=new IdentityHashMap<>();
 private static final IdentityHashMap<JvmCompilationConfiguration,ClasspathSnapshotBasedIncrementalCompilationApproachParameters> configuredParameters=new IdentityHashMap<>();
 private static final IdentityHashMap<JvmCompilationConfiguration,Binding> registry=new IdentityHashMap<>();
 private static final List<Object> configurationFactories=new ArrayList<>(),configurationUses=new ArrayList<>(),configurationBindings=new ArrayList<>(),configurationChecks=new ArrayList<>();
 private static final class Binding {
  final CompilationService service;final ProjectId project;final JvmCompilationConfiguration configuration;
  final ClasspathSnapshotBasedIncrementalCompilationApproachParameters parameter;final String id,stage,sourceHash;
  final Path source,out;final List<String> arguments;final List<Object> snapshots;boolean used;
  Binding(CompilationService service,ProjectId project,String name,Path source,Path out,List<String> args,JvmCompilationConfiguration cfg,ClasspathSnapshotBasedIncrementalCompilationApproachParameters parameter)throws Exception{
   this.service=service;this.project=project;this.configuration=cfg;this.parameter=parameter;this.id="binding-"+(registry.size()+1);this.stage=name;this.source=source;this.out=out;this.sourceHash=hashFile(source);this.arguments=List.copyOf(args);this.snapshots=snapshotBindings(parameter);
  }
 }
 private static final class ConfigurationRejected extends RuntimeException {ConfigurationRejected(String reason){super(reason);}}
 private static String configurationId(JvmCompilationConfiguration c){return configurationIds.computeIfAbsent(c,key->"config-"+(configurationIds.size()+1));}
 private static String parameterId(ClasspathSnapshotBasedIncrementalCompilationApproachParameters p){return p==null?null:parameterIds.computeIfAbsent(p,key->"parameter-"+(parameterIds.size()+1));}
 private static List<Object> snapshotBindings(ClasspathSnapshotBasedIncrementalCompilationApproachParameters p){
  if(p==null)return List.of();List<File> actual=new ArrayList<>(p.getNewClasspathSnapshotFiles());List<Object> result=new ArrayList<>();
  if(actual.size()!=staged.size())throw new IllegalStateException("parameter-inventory-mismatch");
  for(int i=0;i<actual.size();i++){
   if(!actual.get(i).equals(staged.get(i)))throw new IllegalStateException("parameter-path-mismatch");
   var entry=sealed.get(i);result.add(Collections.unmodifiableMap(m("id",entry.get("id"),"size",entry.get("size"),"sha256",entry.get("sha256"))));
  }
  return List.copyOf(result);
 }
 private static Map<String,Object> changes(SourcesChanges changes){
  if(changes instanceof SourcesChanges.Known known)return m("kind","Known","modified",known.getModifiedFiles().stream().map(f->relative(f.toPath())).toList(),"removed",known.getRemovedFiles().stream().map(f->relative(f.toPath())).toList());
  return m("kind","Unknown","modified",List.of(),"removed",List.of());
 }
 private static JvmCompilationConfiguration fresh(CompilationService service,String name){
  var c=service.makeJvmCompilationConfiguration();String id=configurationId(c);configurationFactories.add(m("configurationId",id,"stage",name));event("configuration:create:"+id);return c;
 }
 private static Binding register(CompilationService service,ProjectId project,String name,Path source,Path out,List<String> args,JvmCompilationConfiguration c)throws Exception{
  if(registry.containsKey(c))throw new IllegalStateException("configuration-already-registered");
  var parameter=configuredParameters.get(c);
  if(!name.equals("library")&&parameter==null)throw new IllegalStateException("incremental-configuration-not-applied");
  var binding=new Binding(service,project,name,source,out,args,c,parameter);registry.put(c,binding);
  configurationBindings.add(m("configurationId",configurationId(c),"bindingId",binding.id,"stage",name,"parameterId",parameterId(parameter),"sourceSha256",binding.sourceHash,"snapshotBindings",binding.snapshots));
  event("configuration:register:"+configurationId(c)+":"+binding.id);return binding;
 }
 private static Binding libraryConfig(CompilationService service,ProjectId project,Path source,Path out,List<String> args)throws Exception{return register(service,project,"library",source,out,args,fresh(service,"library"));}
 private static JvmCompilationConfiguration applyIncremental(CompilationService service,String name,Path work,Path out,List<File> inputs,SourcesChanges sourceChanges)throws Exception{
  var c=fresh(service,name);var incremental=c.makeClasspathSnapshotBasedIncrementalCompilationConfiguration();
  incremental.setRootProjectDir(root.toFile()).setBuildDir(root.resolve("build").toFile()).useOutputDirs(List.of(out.toFile(),work.toFile()));
  var parameter=new ClasspathSnapshotBasedIncrementalCompilationApproachParameters(inputs,work.resolve("shrunk-classpath-snapshot.bin").toFile());
  var actual=snapshotBindings(parameter);String pid=parameterId(parameter);
  // The receipt records the exact receiver and parameter of the successful public API call.
  c.useIncrementalCompilation(work.toFile(),sourceChanges,parameter,incremental);
  configuredParameters.put(c,parameter);configurationUses.add(m("configurationId",configurationId(c),"parameterId",pid,"stage",name,"changes",changes(sourceChanges),"snapshotBindings",actual));
  event("configuration:use-incremental:"+configurationId(c)+":"+pid);return c;
 }
 private static Binding config(CompilationService service,ProjectId project,String name,Path source,Path work,Path out,List<String> args,List<File> inputs,SourcesChanges changes)throws Exception{return register(service,project,name,source,out,args,applyIncremental(service,name,work,out,inputs,changes));}
 private static Binding validate(CompilationService service,ProjectId project,String name,Path source,Path out,List<String> args,JvmCompilationConfiguration c,Binding expected)throws Exception{
  var actual=registry.get(c);var parameter=configuredParameters.get(c);
  boolean registered=actual!=null,identity=registered&&actual==expected&&c==expected.configuration;
  boolean context=registered&&actual.service==service&&actual.project==project&&actual.stage.equals(name)&&actual.source.equals(source)&&actual.out.equals(out)&&actual.arguments.equals(args)&&actual.sourceHash.equals(hashFile(source));
  boolean parameterIdentity=registered&&actual.parameter==parameter&&parameter==expected.parameter;
  boolean descriptors=Objects.equals(snapshotBindings(parameter),expected.snapshots);
  String reason=!registered?"bta_driver_configuration_unregistered":!identity||!context||!parameterIdentity||!descriptors||actual.used?"bta_driver_configuration_binding_mismatch":null;
  configurationChecks.add(m("stage",name,"expectedConfigurationId",configurationId(expected.configuration),"actualConfigurationId",configurationId(c),"expectedBindingId",expected.id,"actualBindingId",registered?actual.id:null,"expectedParameterId",parameterId(expected.parameter),"actualParameterId",parameterId(parameter),"registered",registered,"configurationIdentity",c==expected.configuration,"bindingIdentity",registered&&actual==expected,"contextIdentity",context,"parameterIdentity",parameterIdentity,"snapshotBindingsMatch",descriptors,"singleUse",registered&&!actual.used,"reason",reason));
  event("configuration:check:"+name);if(reason!=null)throw new ConfigurationRejected(reason);actual.used=true;return actual;
 }
 static CompilationResult compile(CompilationService service,ProjectId project,String name,Path source,Path out,List<String> args,JvmCompilationConfiguration config,Binding expected)throws Exception{
  var binding=validate(service,project,name,source,out,args,config,expected);
  event("compile:begin:"+name);
  CompilationResult result=service.compileJvm(project,service.makeCompilerExecutionStrategyConfiguration().useInProcessStrategy(),config,List.of(source.toFile()),args);
  List<String> display=args.stream().map(a->a.replace(root.toString(),"$PROJECT_ROOT").replace(System.getProperty("owned.stdlib"),"$RUNTIME_STDLIB")).toList();
  compilations.add(m("stage",name,"result",result.toString(),"source",relative(source),"sourceSha256",hashFile(source),"arguments",display,"configurationId",configurationId(config),"bindingId",binding.id,"parameterId",parameterId(binding.parameter),"snapshotIds",binding.snapshots.stream().map(x->((Map<?,?>)x).get("id")).toList(),"outputs",tree(out)));
  event("compile:end:"+name);if(result!=CompilationResult.COMPILATION_SUCCESS)throw new IllegalStateException("compile-failed:"+name+":"+result);return result;
 }
 static void jar(Path classes,Path archive)throws Exception{
  try(JarOutputStream out=new JarOutputStream(Files.newOutputStream(archive));var files=Files.walk(classes)){
   for(Path p:files.filter(Files::isRegularFile).sorted().toList()){JarEntry e=new JarEntry(classes.relativize(p).toString());e.setTime(0);out.putNextEntry(e);Files.copy(p,out);out.closeEntry();}
  }
 }
 static void flip(Path p)throws Exception{byte[] b=Files.readAllBytes(p);b[0]^=1;Files.write(p,b);}
 public static void main(String[] args)throws Exception{
  root=Path.of(args[0]).toRealPath();String mode=args[1],runId=args[2],version=args[3];Path stdlib=Path.of(args[4]).toRealPath();System.setProperty("owned.stdlib",stdlib.toString());
  Path work=root.resolve("build/owned");Files.createDirectories(work);
  Path privateRoot=Files.createTempDirectory(work,"private-",PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
  stage=Files.createDirectory(privateRoot.resolve("staging"),PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
  evidence=Files.createDirectory(privateRoot.resolve("evidence"),PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
  Path src=work.resolve("src"),libOut=work.resolve("library-classes"),consumerOut=work.resolve("consumer-classes"),ic=privateRoot.resolve("ic");
  for(Path p:List.of(src,libOut,consumerOut,ic))Files.createDirectories(p);
  Path library=src.resolve("Library.kt"),consumer=src.resolve("Consumer.kt"),libraryJar=work.resolve("library.jar");Files.writeString(library,LIB);
  CompilationService service=CompilationService.loadImplementation(BtaOwnedDriver.class.getClassLoader());ProjectId project=new ProjectId.ProjectUUID(UUID.fromString(runId));
  report.putAll(m("schema","osv-mcp.bta-driver-program-v2","mode",mode,"runId",runId,"kotlinVersion",version,"actualCompilerVersion",service.getCompilerVersion(),"artifacts",m("api",origin(CompilationService.class),"implementation",origin(service.getClass())),"privatePermissions",PosixFilePermissions.toString(Files.getPosixFilePermissions(privateRoot)),"observationKind","offered-inputs-only","naturalContentBinding",false,"productionAdopted",false));
  report.put("javaVersion",System.getProperty("java.version"));report.put("javaExecutableSha256",hashFile(Path.of(System.getProperty("java.home"),"bin/java")));
  String reason=null;
  try{
   phase="owner-library";var libArgs=arguments(libOut,stdlib.toString(),"ownedLibrary");var libConfig=libraryConfig(service,project,library,libOut,libArgs);compile(service,project,"library",library,libOut,libArgs,libConfig.configuration,libConfig);jar(libOut,libraryJar);
   report.put("library",m("sourceSha256",hashFile(library),"jarSha256",hashFile(libraryJar),"classes",tree(libOut)));
   staged=new ArrayList<>();phase="owner-snapshot";
   for(var entry:List.of(m("id","library.snapshot","role","library","path",libraryJar),m("id","stdlib.snapshot","role","stdlib","path",stdlib))){
    String id=(String)entry.get("id");event("snapshot:begin:"+id);
    var snapshot=service.calculateClasspathSnapshot(((Path)entry.get("path")).toFile(),ClassSnapshotGranularity.CLASS_MEMBER_LEVEL);
    Path file=stage.resolve(id);snapshot.saveSnapshot(file.toFile());byte[] bytes=safeBytes(file,stage);Files.write(evidence.resolve(id),bytes,StandardOpenOption.CREATE_NEW);
    sealed.add(m("id",id,"role",entry.get("role"),"inputSha256",hashFile((Path)entry.get("path")),"classCount",snapshot.getClassSnapshots().size(),"size",bytes.length,"sha256",hash(bytes)));staged.add(file.toFile());event("snapshot:end:"+id);
   }
   phase="owner-offer";List<File> inputs=select();boolean immutable=false;try{inputs.add(libraryJar.toFile());}catch(UnsupportedOperationException expected){immutable=true;}report.put("listMutationRejected",immutable);
   String cp=libraryJar+File.pathSeparator+stdlib;Files.writeString(consumer,consumer("v1"));phase="owner-warm";
   var consumerArgs=arguments(consumerOut,cp,"ownedConsumer");var warmConfig=config(service,project,"warm",consumer,ic,consumerOut,consumerArgs,inputs,SourcesChanges.Unknown.INSTANCE);
   compile(service,project,"warm",consumer,consumerOut,consumerArgs,warmConfig.configuration,warmConfig);
   Files.writeString(consumer,consumer("v2"));report.put("finalSourceSha256",hashFile(consumer));
   if(mode.equals("mutate-before")||mode.equals("blob-corrupt")){phase="mutation";event("mutation:begin");Path target=mode.equals("blob-corrupt")?evidence.resolve("library.snapshot"):stage.resolve("library.snapshot");flip(target);event("mutation:end");}
   phase="owner-gate";event("gate:begin");var pre=check();report.put("preflight",pre);event("gate:end");reason=(String)pre.get("reason");
   if(reason==null){
    if(!mode.equals("control")){phase="observer";event("observer:begin");if(sealed.size()!=2)throw new IllegalStateException("inventory");event("observer:end");}
    phase="owner-consumer";
    var known=new SourcesChanges.Known(List.of(consumer.toFile()),List.of());
    var consumerConfig=config(service,project,"consumer",consumer,ic,consumerOut,consumerArgs,inputs,known);
    JvmCompilationConfiguration supplied=consumerConfig.configuration;
    if(mode.equals("default-config"))supplied=fresh(service,"consumer");
    else if(mode.equals("unregistered-config"))supplied=applyIncremental(service,"consumer",ic,consumerOut,inputs,known);
    else if(mode.equals("foreign-config"))supplied=config(service,project,"consumer",consumer,ic,consumerOut,consumerArgs,inputs,known).configuration;
    try{compile(service,project,"consumer",consumer,consumerOut,consumerArgs,supplied,consumerConfig);}catch(ConfigurationRejected rejected){reason=rejected.getMessage();}
    if(reason==null){
    if(mode.equals("mutate-after")){phase="mutation";event("mutation:begin");flip(stage.resolve("library.snapshot"));event("mutation:end");}
    phase="owner-post";event("post:begin");var post=check();report.put("postflight",post);event("post:end");reason=(String)post.get("reason");
    if(!mode.equals("control")&&reason==null){phase="capture";event("capture:begin");report.put("capture",check());event("capture:end");}
    }
   }
   report.put("compiler",origin(org.jetbrains.kotlin.cli.jvm.K2JVMCompiler.class));
   report.put("finalOutputs",reason==null?tree(consumerOut):List.of());
   report.put("privateCache",tree(ic));
  }finally{service.finishProjectCompilation(project);}
  report.putAll(m("configurationFactories",configurationFactories,"configurationUses",configurationUses,"configurationBindings",configurationBindings,"configurationChecks",configurationChecks,"reason",reason,"snapshots",sealed,"selectionCalls",selections,"sourceFileReads",sourceReads,"storageFileReads",storageReads,"events",events,"compilations",compilations));
  List<Object> runtime=new ArrayList<>();for(String item:System.getProperty("java.class.path").split(File.pathSeparator)){Path p=Path.of(item).toRealPath();if(Files.isRegularFile(p))runtime.add(m("artifact",p.toString(),"name",p.getFileName().toString(),"sha256",hashFile(p)));else if(p.endsWith("driver-classes"))report.put("driverClasses",tree(p));}
  report.put("runtime",runtime);Files.writeString(root.resolve("driver-report.json"),json(report));
 }
 static String json(Object v){
  if(v==null)return "null";if(v instanceof Boolean||v instanceof Number)return v.toString();
  if(v instanceof Map<?,?> map)return "{"+String.join(",",map.entrySet().stream().map(e->json(e.getKey().toString())+":"+json(e.getValue())).toList())+"}";
  if(v instanceof Collection<?> list)return "["+String.join(",",list.stream().map(BtaOwnedDriver::json).toList())+"]";
  return "\""+v.toString().replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r").replace("\t","\\t")+"\"";
 }
}
