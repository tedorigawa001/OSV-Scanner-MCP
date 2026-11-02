// Owned test BTA executor. API-offered snapshots never become a natural-consumption receipt.
import org.jetbrains.kotlin.buildtools.api.*;
import org.jetbrains.kotlin.buildtools.api.jvm.*;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.nio.channels.FileChannel;
import java.nio.ByteBuffer;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.jar.*;

public final class OwnedBtaManifestDriver {
 static Path root,stdlib;static String executionId,buildRef;static CompilationService service;static ProjectId project;
 static List<Object> runtime=new ArrayList<>(),calls=new ArrayList<>(),generations=new ArrayList<>(),uses=new ArrayList<>();
 static int nextConfig=0,nextParameter=0,nextHandle=0;
 static IdentityHashMap<JvmCompilationConfiguration,Binding> registry=new IdentityHashMap<>();
 static IdentityHashMap<JvmCompilationConfiguration,ClasspathSnapshotBasedIncrementalCompilationApproachParameters> applied=new IdentityHashMap<>();
 static IdentityHashMap<JvmCompilationConfiguration,String> configs=new IdentityHashMap<>();
 static IdentityHashMap<ClasspathSnapshotBasedIncrementalCompilationApproachParameters,String> parameters=new IdentityHashMap<>();
 static Map<String,Object> m(Object...kv){var r=new TreeMap<String,Object>();for(int i=0;i<kv.length;i+=2)r.put((String)kv[i],kv[i+1]);return r;}
 static String quote(String s){var b=new StringBuilder("\"");for(char c:s.toCharArray())switch(c){case '"':b.append("\\\"");break;case '\\':b.append("\\\\");break;case '\b':b.append("\\b");break;case '\f':b.append("\\f");break;case '\n':b.append("\\n");break;case '\r':b.append("\\r");break;case '\t':b.append("\\t");break;default:if(c<32)b.append(String.format(Locale.ROOT,"\\u%04x",(int)c));else b.append(c);}return b.append('"').toString();}
 static String json(Object x){if(x==null)return "null";if(x instanceof String s)return quote(s);if(x instanceof Number||x instanceof Boolean)return x.toString();if(x instanceof Map<?,?> a){var sorted=new TreeMap<String,Object>();a.forEach((k,v)->sorted.put((String)k,v));return "{"+String.join(",",sorted.entrySet().stream().map(e->quote(e.getKey())+":"+json(e.getValue())).toList())+"}";}if(x instanceof Collection<?> a)return "["+String.join(",",a.stream().map(OwnedBtaManifestDriver::json).toList())+"]";throw new IllegalArgumentException("unknown-json-type");}
 static String hash(byte[] b)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));}
 static String digest(Object x)throws Exception{return hash(json(x).getBytes(java.nio.charset.StandardCharsets.UTF_8));}
 static void guard(Path p)throws Exception{if(!p.toAbsolutePath().normalize().startsWith(root))throw new IOException("path-outside");Path at=root;for(Path part:root.relativize(p)){at=at.resolve(part);if(Files.isSymbolicLink(at))throw new IOException("symlink");}}
 static byte[] read(Path p)throws Exception{guard(p);var a=Files.readAttributes(p,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);if(!a.isRegularFile()||a.size()>128*1024*1024)throw new IOException("budget");try(var ch=FileChannel.open(p,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS)){var bytes=new ByteArrayOutputStream();var b=ByteBuffer.allocate(65536);int n;while((n=ch.read(b))!=-1){if(bytes.size()+n>128*1024*1024)throw new IOException("budget");bytes.write(b.array(),0,n);b.clear();}var z=Files.readAttributes(p,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);if(!Objects.equals(a.fileKey(),z.fileKey())||!a.lastModifiedTime().equals(z.lastModifiedTime())||z.size()!=bytes.size())throw new IOException("changed-during-read");return bytes.toByteArray();}}
 static String rel(Path p){return root.relativize(p).toString().replace(File.separatorChar,'/');}
 static Map<String,Object> file(Path p)throws Exception{byte[] b=read(p);return m("path",rel(p),"size",b.length,"sha256",hash(b));}
 static Map<String,Object> origin(Class<?> c)throws Exception{Path p=Path.of(c.getProtectionDomain().getCodeSource().getLocation().toURI()).toRealPath();return m("type",c.getName(),"file",file(p));}
 static List<Object> tree(Path p)throws Exception{var out=new ArrayList<Object>();try(var stream=Files.walk(p)){for(Path f:stream.sorted().toList())if(Files.isRegularFile(f,LinkOption.NOFOLLOW_LINKS))out.add(file(f));}return out;}
 static void jar(Path dir,Path out)throws Exception{try(var stream=new JarOutputStream(Files.newOutputStream(out,StandardOpenOption.CREATE_NEW));var files=Files.walk(dir)){for(Path p:files.filter(Files::isRegularFile).sorted().toList()){var e=new JarEntry(dir.relativize(p).toString());e.setTime(0);stream.putNextEntry(e);stream.write(read(p));stream.closeEntry();}}}
 static List<String> args(Path out,String cp,String module){return List.of("-d",out.toString(),"-classpath",cp,"-no-stdlib","-no-reflect","-module-name",module,"-jvm-target","17");}
 static List<String> display(List<String> a){return a.stream().map(x->x.replace(root.toString(),"$ROOT")).toList();}
 static void compile(String stage,Path source,Path out,List<String> args,JvmCompilationConfiguration c)throws Exception{String before=hash(read(source));var result=service.compileJvm(project,service.makeCompilerExecutionStrategyConfiguration().useInProcessStrategy(),c,List.of(source.toFile()),args);if(!before.equals(hash(read(source))))throw new IOException("source-changed");calls.add(m("stage",stage,"configurationId",cid(c),"source",file(source),"arguments",display(args),"result",result.toString(),"outputs",tree(out)));if(result!=CompilationResult.COMPILATION_SUCCESS)throw new IOException("BTA-failed:"+result);}
 static String cid(JvmCompilationConfiguration c){return configs.computeIfAbsent(c,x->"configuration-"+(++nextConfig));}
 static String pid(ClasspathSnapshotBasedIncrementalCompilationApproachParameters p){return parameters.computeIfAbsent(p,x->"parameter-"+(++nextParameter));}
 static Map<String,Object> generate(String label,String body)throws Exception{
  Path dir=Files.createDirectory(root.resolve(label)),source=dir.resolve("Library.kt"),out=Files.createDirectory(dir.resolve("classes")),archive=dir.resolve("library.jar");Files.writeString(source,body,StandardOpenOption.CREATE_NEW);
  var cfg=service.makeJvmCompilationConfiguration();compile(label,source,out,args(out,stdlib.toString(),label.replace('-','_')),cfg);jar(out,archive);
  var cohort=new ArrayList<Object>();var snapshots=new ArrayList<Object>();var inputs=List.of(archive,stdlib,archive);
  for(int i=0;i<inputs.size();i++){var f=file(inputs.get(i));f.put("occurrence",i);cohort.add(f);var snap=service.calculateClasspathSnapshot(inputs.get(i).toFile(),ClassSnapshotGranularity.CLASS_MEMBER_LEVEL);Path dest=dir.resolve("snapshot-"+i);snap.saveSnapshot(dest.toFile());var descriptor=file(dest);descriptor.putAll(m("occurrence",i,"libraryDigest",f.get("sha256"),"classCount",snap.getClassSnapshots().size(),"format","BTA-native","granularity","CLASS_MEMBER_LEVEL","generator",origin(snap.getClass())));snapshots.add(descriptor);}
  var libraryEntries=new ArrayList<Object>();try(var jf=new JarFile(archive.toFile())){var es=jf.entries();while(es.hasMoreElements()){var e=es.nextElement();byte[] bytes;try(var in=jf.getInputStream(e)){bytes=in.readNBytes(1048577);}if(bytes.length>1048576)throw new IOException("library-entry-budget");libraryEntries.add(m("path",e.getName(),"size",bytes.length,"sha256",hash(bytes),"outputPath",rel(out.resolve(e.getName()))));}}
  var r=m("schema","owned-bta-generation-v1","generationId",label,"source",file(source),"sourceBytes",Base64.getEncoder().encodeToString(body.getBytes(java.nio.charset.StandardCharsets.UTF_8)),"libraryOutputs",tree(out),"library",file(archive),"libraryEntries",libraryEntries,"cohort",cohort,"cohortDigest",digest(cohort),"snapshots",snapshots,"buildReceiptRef",buildRef);generations.add(r);return r;
 }
 static List<Path> cohort(Map<String,Object> g){return ((List<Map<String,Object>>)g.get("cohort")).stream().map(f->root.resolve((String)f.get("path"))).toList();}
 static List<Map<String,Object>> snapshots(Map<String,Object> g){return (List<Map<String,Object>>)g.get("snapshots");}
 static final class Binding {
  final String id,context,sourceHash,generationRef;final JvmCompilationConfiguration config;final ClasspathSnapshotBasedIncrementalCompilationApproachParameters parameter;final List<File> snapshots;final List<String> arguments;final ProjectId project;boolean used;
  Binding(String context,Path src,List<String> args,JvmCompilationConfiguration c,ClasspathSnapshotBasedIncrementalCompilationApproachParameters p,List<File> snaps,Map<String,Object> gen)throws Exception{this.id="binding-"+(++nextHandle);this.context=context;sourceHash=hash(read(src));generationRef=digest(gen);config=c;parameter=p;snapshots=List.copyOf(snaps);arguments=List.copyOf(args);project=OwnedBtaManifestDriver.project;}
 }
 static ClasspathSnapshotBasedIncrementalCompilationApproachParameters parameter(Path dir,List<File> snaps){return new ClasspathSnapshotBasedIncrementalCompilationApproachParameters(snaps,dir.resolve("shrunk.bin").toFile());}
 static void apply(String context,Path dir,Path out,JvmCompilationConfiguration c,ClasspathSnapshotBasedIncrementalCompilationApproachParameters p,SourcesChanges changes)throws Exception{var inc=c.makeClasspathSnapshotBasedIncrementalCompilationConfiguration();inc.setRootProjectDir(root.toFile()).setBuildDir(root.resolve("build").toFile()).useOutputDirs(List.of(out.toFile(),dir.toFile()));c.useIncrementalCompilation(dir.toFile(),changes,p,inc);applied.put(c,p);uses.add(m("context",context,"configurationId",cid(c),"parameterId",pid(p),"paths",p.getNewClasspathSnapshotFiles().stream().map(f->rel(f.toPath())).toList(),"changes",changes instanceof SourcesChanges.Known?"Known-empty":"Unknown"));}
 static void flip(Path p)throws Exception{byte[] b=read(p);b[0]^=1;Files.write(p,b);}
 static Map<String,Object> checkFiles(Map<String,Object> gen,List<File> selected,Path evidence)throws Exception{
  var actualLibraries=new ArrayList<Map<String,Object>>();for(Path p:cohort(gen))actualLibraries.add(file(p));var actualSnapshots=new ArrayList<Object>();var saved=new ArrayList<Object>();String reason=null;
  for(int i=0;i<selected.size();i++){var d=snapshots(gen).get(i);var save=file(evidence.resolve("snapshot-"+i));saved.add(save);if(!save.get("sha256").equals(d.get("sha256"))||!save.get("size").equals(d.get("size")))reason="snapshot_storage_mismatch";var current=file(selected.get(i).toPath());actualSnapshots.add(current);if(reason==null&&!current.get("sha256").equals(d.get("sha256")))reason="snapshot_stale";}
  var refs=(List<Map<String,Object>>)gen.get("cohort");for(int i=0;i<refs.size();i++)if(reason==null&&!actualLibraries.get(i).get("sha256").equals(refs.get(i).get("sha256")))reason="library_stale";
  return m("reason",reason,"libraries",actualLibraries,"snapshots",actualSnapshots,"saved",saved);
 }
 public static void main(String[] argv)throws Exception{
  root=Path.of(argv[0]).toRealPath();executionId=argv[1];buildRef=argv[2];String version=argv[3];
  var rows=Files.readAllLines(root.resolve("runtime.tsv"));for(String row:rows){String[] f=row.split("\t");runtime.add(m("occurrence",Integer.parseInt(f[0]),"coordinate",f[1],"path",f[2],"sha256",f[3],"size",Long.parseLong(f[4])));}
  stdlib=root.resolve((String)((Map<String,Object>)runtime.stream().filter(x->((Map<?,?>)x).get("coordinate").toString().startsWith("org.jetbrains.kotlin:kotlin-stdlib:")).findFirst().orElseThrow()).get("path"));
  var actualCp=Arrays.stream(System.getProperty("java.class.path").split(File.pathSeparator)).map(Path::of).map(OwnedBtaManifestDriver::rel).toList();var expectedCp=new ArrayList<String>();expectedCp.add("driver.jar");for(Object r:runtime)expectedCp.add((String)((Map<?,?>)r).get("path"));if(!actualCp.equals(expectedCp))throw new IOException("runtime-classpath-binding");
  for(Object r:runtime){var f=(Map<String,Object>)r;if(!file(root.resolve((String)f.get("path"))).get("sha256").equals(f.get("sha256")))throw new IOException("runtime-stale");}
  service=CompilationService.loadImplementation(OwnedBtaManifestDriver.class.getClassLoader());project=new ProjectId.ProjectUUID(UUID.fromString(executionId));
  Files.createDirectory(root.resolve("build"));Map<String,Object> report=m("schema","owned-bta-native-v1","executionId",executionId,"buildReceiptRef",buildRef,"actualCompilerVersion",service.getCompilerVersion(),"driverOrigin",origin(OwnedBtaManifestDriver.class),"apiOrigin",origin(CompilationService.class),"implementationOrigin",origin(service.getClass()),"runtime",runtime,"actualClasspath",actualCp);
  var result=new ArrayList<Object>();try{
   var old=generate("library-old","package dep\nclass Library { fun value(): String = \"old\" }\n");
   var gen=generate("library-current","package dep\nclass Library { fun value(): String = \"current\"; fun extra(): Int = 7 }\n");
   List<String> modes=List.of("completed","unchanged","snapshot-modified","snapshot-swapped","snapshot-old-bytes","snapshot-storage","generation-exchanged","library-modified","library-order","library-duplicate-dropped","default-configuration","foreign-configuration","foreign-parameter","parameter-snapshot-order","foreign-project","source-modified","arguments-exchanged","snapshot-after-call","snapshot-before-capture");
   Path completedDir=null,completedOut=null,completedSource=null;Object completedIc=null;List<File> completedSelected=null;Path completedEvidence=null;
   for(String mode:modes){
    Path dir=Files.createDirectory(root.resolve("offer-"+mode)),evidence=Files.createDirectory(dir.resolve("evidence")),out=Files.createDirectory(dir.resolve("classes")),ic=Files.createDirectory(dir.resolve("ic")),src=dir.resolve("Consumer.kt");Files.writeString(src,"package consumer\nfun value() = dep.Library().value()\n",StandardOpenOption.CREATE_NEW);
    var selected=new ArrayList<File>();for(int i=0;i<3;i++){Path target=dir.resolve("snapshot-"+i);Files.copy(root.resolve((String)snapshots(gen).get(i).get("path")),target);Files.copy(target,evidence.resolve("snapshot-"+i));selected.add(target.toFile());}
    if(mode.equals("unchanged")){src=completedSource;out=completedOut;ic=completedDir;selected=new ArrayList<>(completedSelected);evidence=completedEvidence;}
    var offerArgs=args(out,String.join(File.pathSeparator,cohort(gen).stream().map(Path::toString).toList()),"consumer");var config=service.makeJvmCompilationConfiguration();var param=parameter(ic,selected);SourcesChanges changes=mode.equals("unchanged")?new SourcesChanges.Known(List.of(),List.of()):SourcesChanges.Unknown.INSTANCE;apply(mode,ic,out,config,param,changes);var binding=new Binding(mode,src,offerArgs,config,param,selected,gen);registry.put(config,binding);
    var rec=m("id",mode,"binding",m("id",binding.id,"context",mode,"configurationId",cid(config),"parameterId",pid(param),"source",file(src),"arguments",display(offerArgs),"generationRef",binding.generationRef,"cohortRef",gen.get("cohortDigest"),"snapshotPaths",selected.stream().map(f->rel(f.toPath())).toList()),"callsBefore",calls.size());
    JvmCompilationConfiguration supplied=config;ProjectId suppliedProject=project;List<String> suppliedArgs=offerArgs;Map<String,Object> suppliedGen=gen;List<Path> suppliedCohort=cohort(gen);byte[] libraryBackup=null;
    if(mode.equals("snapshot-modified"))flip(selected.get(0).toPath());
    if(mode.equals("snapshot-swapped")){byte[] a=read(selected.get(0).toPath()),b=read(selected.get(1).toPath());Files.write(selected.get(0).toPath(),b);Files.write(selected.get(1).toPath(),a);}
    if(mode.equals("snapshot-old-bytes"))Files.copy(root.resolve((String)snapshots(old).get(0).get("path")),selected.get(0).toPath(),StandardCopyOption.REPLACE_EXISTING);
    if(mode.equals("snapshot-storage"))flip(evidence.resolve("snapshot-0"));
    if(mode.equals("generation-exchanged"))suppliedGen=old;
    if(mode.equals("library-modified")){Path p=cohort(gen).get(0);libraryBackup=read(p);flip(p);}
    if(mode.equals("library-order")){suppliedCohort=new ArrayList<>(suppliedCohort);Collections.swap(suppliedCohort,0,1);}
    if(mode.equals("library-duplicate-dropped"))suppliedCohort=suppliedCohort.subList(0,2);
    if(mode.equals("default-configuration"))supplied=service.makeJvmCompilationConfiguration();
    if(mode.equals("foreign-configuration")){supplied=service.makeJvmCompilationConfiguration();var p=parameter(ic,selected);apply(mode,ic,out,supplied,p,changes);registry.put(supplied,new Binding(mode,src,offerArgs,supplied,p,selected,gen));}
    if(mode.equals("foreign-parameter")||mode.equals("parameter-snapshot-order")){var paths=new ArrayList<>(selected);if(mode.equals("parameter-snapshot-order"))Collections.swap(paths,0,1);var p=parameter(ic,paths);apply(mode,ic,out,config,p,changes);}
    if(mode.equals("foreign-project"))suppliedProject=new ProjectId.ProjectUUID(UUID.randomUUID());
    if(mode.equals("source-modified"))Files.writeString(src,"// changed\n",StandardOpenOption.APPEND);
    if(mode.equals("arguments-exchanged"))suppliedArgs=args(dir.resolve("different-output"),stdlib.toString(),"foreign");
    String reason=null;var actual=registry.get(supplied);var actualParameter=applied.get(supplied);
    var identity=m("registered",actual!=null,"bindingIdentity",actual==binding,"configurationIdentity",supplied==config,"parameterIdentity",actualParameter==param,"parameterPaths",actualParameter==null?List.of():actualParameter.getNewClasspathSnapshotFiles().stream().map(f->rel(f.toPath())).toList(),"contextIdentity",suppliedProject==project&&suppliedArgs.equals(binding.arguments),"actualConfigurationId",cid(supplied),"actualParameterId",actualParameter==null?null:pid(actualParameter),"generationRef",digest(suppliedGen),"cohort",suppliedCohort.stream().map(OwnedBtaManifestDriver::rel).toList(),"source",file(src));rec.put("identity",identity);
    if(actual==null)reason="configuration_unregistered";else if(actual!=binding||supplied!=config||binding.used)reason="configuration_binding_mismatch";else if(actualParameter!=param||!actualParameter.getNewClasspathSnapshotFiles().equals(binding.snapshots))reason="parameter_binding_mismatch";else if(suppliedProject!=project||!suppliedArgs.equals(binding.arguments))reason="context_binding_mismatch";else if(!hash(read(src)).equals(binding.sourceHash))reason="source_stale";else if(!digest(suppliedGen).equals(binding.generationRef))reason="generation_binding_mismatch";else if(!suppliedCohort.equals(cohort(gen)))reason="cohort_binding_mismatch";
    var pre=checkFiles(gen,selected,evidence);rec.put("preflight",pre);if(reason==null)reason=(String)pre.get("reason");
    rec.put("icBefore",tree(ic));if(mode.equals("unchanged"))rec.put("expectedIc",completedIc);
    if(reason==null){binding.used=true;compile(mode,src,out,suppliedArgs,supplied);rec.put("callResult","COMPILATION_SUCCESS");if(mode.equals("snapshot-after-call"))flip(selected.get(0).toPath());var post=checkFiles(gen,selected,evidence);rec.put("postflight",post);reason=(String)post.get("reason");if(reason==null){if(mode.equals("snapshot-before-capture"))flip(selected.get(0).toPath());var capture=checkFiles(gen,selected,evidence);rec.put("capture",capture);reason=(String)capture.get("reason");}}
    rec.putAll(m("reason",reason,"callsAfter",calls.size(),"producerState",reason==null?"completed":"failed","executionEvidence",rec.containsKey("callResult")?"bta-call-only":"not-called","compilerWorkStatus","unknown","naturalContentBinding",false,"productionAdopted",false,"outputs",tree(out),"icAfter",tree(ic)));
    if(mode.equals("completed")){completedDir=ic;completedOut=out;completedSource=src;completedIc=tree(ic);completedSelected=List.copyOf(selected);completedEvidence=evidence;}
    if(libraryBackup!=null){Path observed=dir.resolve("refused-library.jar");Files.write(observed,read(cohort(gen).get(0)),StandardOpenOption.CREATE_NEW);rec.put("refusalLibraryEvidence",file(observed));Files.write(cohort(gen).get(0),libraryBackup);}
    result.add(rec);
   }
  }finally{service.finishProjectCompilation(project);}
  report.putAll(m("generations",generations,"generationRefs",generations.stream().map(g->{try{return digest(g);}catch(Exception e){throw new RuntimeException(e);}}).toList(),"calls",calls,"configurationUses",uses,"offers",result,"compilerOrigin",origin(org.jetbrains.kotlin.cli.jvm.K2JVMCompiler.class),"runtimeAfter",runtime.stream().map(r->{try{return file(root.resolve((String)((Map<?,?>)r).get("path")));}catch(Exception e){throw new RuntimeException(e);}}).toList()));
  Files.writeString(root.resolve("bta-native.json"),json(report),StandardOpenOption.CREATE_NEW);
 }
}
