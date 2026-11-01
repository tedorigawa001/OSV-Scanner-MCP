// Test-only public BTA constructor probe. Synthetic paths; never invokes the compiler.
import java.io.File;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.jetbrains.kotlin.buildtools.api.jvm.ClasspathSnapshotBasedIncrementalCompilationApproachParameters;
public final class gradleSnapshotOwnerParameters {
 static String sha(byte[] bytes) throws Exception {return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
 static File origin(Class<?> c) throws Exception {return new File(c.getProtectionDomain().getCodeSource().getLocation().toURI()).getCanonicalFile();}
 static String q(String s){return "\""+s.replace("\\","\\\\").replace("\"","\\\"")+"\"";}
 public static void main(String[] args) throws Exception {
  Path root=Path.of(args[0]);Files.createDirectories(root);
  File a=Files.writeString(root.resolve("a.bin"),"snapshot-probe-not-valid-classpath-snapshot\n").toFile();
  File b=Files.writeString(root.resolve("b.bin"),"second probe path\n").toFile();
  File previous=root.resolve("previous.bin").toFile();
  List<File> mutable=new ArrayList<>(List.of(a));
  var aliased=new ClasspathSnapshotBasedIncrementalCompilationApproachParameters(mutable,previous);
  mutable.add(b);boolean alias=aliased.getNewClasspathSnapshotFiles().size()==2;
  boolean writable=false;
  try{aliased.getNewClasspathSnapshotFiles().add(a);writable=true;}catch(UnsupportedOperationException expected){}
  List<File> source=new ArrayList<>(List.of(a));
  List<File> sealed=Collections.unmodifiableList(new ArrayList<>(source));
  var copied=new ClasspathSnapshotBasedIncrementalCompilationApproachParameters(sealed,previous);
  source.add(b);boolean defensive= copied.getNewClasspathSnapshotFiles().size()==1;
  boolean rejects=false;
  try{copied.getNewClasspathSnapshotFiles().add(b);}catch(UnsupportedOperationException expected){rejects=true;}
  File api=origin(ClasspathSnapshotBasedIncrementalCompilationApproachParameters.class);
  File stdlib=origin(kotlin.jvm.internal.Intrinsics.class);
  System.out.println("{\"schema\":\"osv-mcp.snapshot-owner-parameter-probe-v1\",\"btaArtifact\":"+q(api.getPath())+",\"btaSha256\":"+q(sha(Files.readAllBytes(api.toPath())))+
   ",\"stdlibArtifact\":"+q(stdlib.getPath())+",\"stdlibSha256\":"+q(sha(Files.readAllBytes(stdlib.toPath())))+
   ",\"mutableConstructorAliased\":"+alias+",\"returnedListMutable\":"+writable+",\"defensiveCopyStable\":"+defensive+",\"defensiveResultRejectsMutation\":"+rejects+
   ",\"retainedConcreteFile\":"+copied.getNewClasspathSnapshotFiles().get(0).equals(a)+",\"fileBytesSha256\":"+q(sha(Files.readAllBytes(a.toPath())))+
   ",\"nonemptyFile\":"+(a.length()>0)+",\"compilerInvocations\":0,\"naturalContentBinding\":false}");
 }
}
