// Test-only storage boundary for the owned driver. No consumer-byte receipt is claimed.
import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;

final class BtaOfferStorage {
 static final long MAX_FILE=32L*1024*1024,MAX_TOTAL=128L*1024*1024;
 static final Map<String,String> CASES;
 static {
  Map<String,String> c=new LinkedHashMap<>();
  for(String role:List.of("staging","evidence")){
   c.put(role+"-file-symlink","path_invalid");c.put(role+"-root-symlink","path_invalid");
   c.put(role+"-file-replaced","storage_identity_mismatch");c.put(role+"-root-replaced","storage_identity_mismatch");
   c.put(role+"-extra-file","storage_inventory_mismatch");c.put(role+"-file-budget","budget_exceeded");
  }
  c.put("staging-before-write-symlink","path_invalid");c.put("evidence-before-write-symlink","path_invalid");c.put("parent-before-write-symlink","path_invalid");
  c.put("staging-many-entries","budget_exceeded");c.put("evidence-many-entries","budget_exceeded");
  c.put("storage-total-budget","budget_exceeded");c.put("storage-entry-budget","budget_exceeded");
  c.put("capture-before-change","stale");c.put("capture-after-change","stale");
  c.put("capture-evidence-before","stale");c.put("capture-evidence-after","stale");
  c.put("capture-path-after","storage_identity_mismatch");c.put("capture-extra-after","storage_inventory_mismatch");
  CASES=Collections.unmodifiableMap(c);
 }
 static final class Failure extends IOException {final String reason;Failure(String reason){super(reason);this.reason=reason;}}
 final Path project,staging,evidence;final String owner;final long maxTotal;final int maxEntries;
 final List<Map<String,Object>> descriptors;final List<Object> audit;
 final List<Object> enumerations=new ArrayList<>();Map<String,Object> initialWriteRoots;Path outside,swapped,backup;List<Object> outsideBefore;int injectedEntries,writeAttempts;Map<String,Object> sealedView;int reads;long written;Map<String,Object> view;
 BtaOfferStorage(String owner,Path staging,Path evidence,List<Map<String,Object>> descriptors,List<Object> audit){
  this.owner=owner;this.project=BtaOwnedDriver.root;this.staging=staging;this.evidence=evidence;this.descriptors=List.copyOf(descriptors);this.audit=audit;
  maxTotal=owner.equals("storage-total-budget")?1024:MAX_TOTAL;maxEntries=owner.equals("storage-entry-budget")?1:16;
 }
 static String digest(Object o){try{return BtaOwnedDriver.hash(BtaOwnedDriver.json(o).getBytes(java.nio.charset.StandardCharsets.UTF_8));}catch(Exception ex){throw new IllegalStateException(ex);}}
 static Map<String,Object> m(Object...kv){return BtaOwnedDriver.m(kv);}
 static String key(Object k)throws IOException{if(k==null)throw new Failure("path_invalid");return BtaOfferProbe.fileKeyToken(k);}
 static String kind(BasicFileAttributes a){return a.isSymbolicLink()?"symlink":a.isDirectory()?"directory":a.isRegularFile()?"file":"other";}
 String write(Path template,String invocation,int calls){
  long attempted=0;reads=0;enumerations.clear();
  try{
   validateWriteRoots();
   for(var d:descriptors){
    String id=d.get("id").toString();if(id.isEmpty()||id.equals(".")||id.equals("..")||id.contains("/")||id.contains("\\")||id.contains(":"))throw new Failure("path_invalid");
    String name=(String)d.get("id");Path source=template.resolve(name);attempted=Files.size(source);
    if(attempted>MAX_FILE||written+2*attempted>maxTotal)throw new Failure("budget_exceeded");
    byte[] bytes=BtaOwnedDriver.safeBytes(source,template);reads++;
    if(bytes.length!=((Number)d.get("size")).longValue()||!BtaOwnedDriver.hash(bytes).equals(d.get("sha256")))throw new Failure("stale");
    if(bytes.length>MAX_FILE||written+2L*bytes.length>maxTotal)throw new Failure("budget_exceeded");
    validateWriteRoots();writeAttempts++;Files.write(staging.resolve(name),bytes,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS);written+=bytes.length;
    // Fault is injected at the actual evidence save, not a later unrelated duplicate write.
    if(owner.equals("storage-failed"))Files.createDirectory(evidence.resolve(name));
    validateWriteRoots();writeAttempts++;Files.write(evidence.resolve(name),bytes,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS);written+=bytes.length;
   }
   validateWriteRoots();return null;
  }catch(Exception ex){String reason=ex instanceof Failure f?f.reason:"storage_failed";
   audit.add(m("invocation",invocation,"owner",owner,"phase","seal","point","write","reason",reason,"errorKind",ex.getClass().getSimpleName(),"fileReads",reads,"attemptedSize",attempted,"writtenBytes",written,"maxFileBytes",MAX_FILE,"maxTotalBytes",maxTotal,"maxEntries",maxEntries,"callsBefore",calls,"callsAfter",calls,"writeAttempts",writeAttempts,"enumerations",List.copyOf(enumerations),"observedSha256",reason.equals("path_invalid")?digest(view):null,"observed",reason.equals("path_invalid")?view:null));return reason;
  }
 }
 void validateWriteRoots()throws Exception{
  view=new LinkedHashMap<>();
  for(Path directory:List.of(staging,evidence)){
   if(!directory.isAbsolute()||!directory.normalize().equals(directory)||!directory.startsWith(project)||directory.equals(project))throw new Failure("path_invalid");
   List<Object> ancestors=new ArrayList<>();view.put(directory.equals(staging)?"staging":"evidence",m("ancestors",ancestors,"entries",List.of()));
   Path cursor=project;
   for(int i=0;i<=project.relativize(directory).getNameCount();i++){
    var a=Files.readAttributes(cursor,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
    ancestors.add(m("path",project.relativize(cursor).toString(),"kind",kind(a),"key",key(a.fileKey())));
    if(!a.isDirectory()||a.isSymbolicLink())throw new Failure("path_invalid");
    if(i<project.relativize(directory).getNameCount())cursor=cursor.resolve(project.relativize(directory).getName(i));
   }
  }
  if(staging.equals(evidence))throw new Failure("path_invalid");
  if(initialWriteRoots==null)initialWriteRoots=view;
  else if(!initialWriteRoots.equals(view))throw new Failure("storage_identity_mismatch");
 }
 void prepareWriteProbe()throws Exception{
  if(!owner.contains("before-write"))return;
  outside=Files.createTempDirectory("osv-offer-outside-").toRealPath();Files.writeString(outside.resolve("sentinel.txt"),"unchanged");
  if(owner.startsWith("parent-")){
   Files.createDirectory(outside.resolve("staging"));Files.createDirectory(outside.resolve("evidence"));
   swapped=staging.getParent();backup=swapped.resolveSibling(swapped.getFileName()+"-original");Files.move(swapped,backup);
  }else {swapped=owner.startsWith("staging-")?staging:evidence;Files.delete(swapped);}
  outsideBefore=BtaOwnedDriver.tree(outside);Files.createSymbolicLink(swapped,outside);
 }
 Map<String,Object> finishWriteProbe()throws Exception{
  if(outside==null)return null;
  try{return m("invocation",owner,"before",outsideBefore,"after",BtaOwnedDriver.tree(outside),"writeAttempts",writeAttempts,"writtenBytes",written,"fileReads",reads);}
  finally{
   Files.delete(swapped);if(backup==null)Files.createDirectory(swapped);else Files.move(backup,swapped);
   try(var walk=Files.walk(outside)){for(Path f:walk.sorted(Comparator.reverseOrder()).toList())Files.delete(f);}
  }
 }
 Map<String,Object> rootView(Path directory)throws Exception{
  var ancestors=new ArrayList<Object>();Path cursor=project;
  for(Path part:project.relativize(directory)){ // Include each lexical ancestor; never follow a symlink.
   var a=Files.readAttributes(cursor,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
   ancestors.add(m("path",project.relativize(cursor).toString(),"kind",kind(a),"key",key(a.fileKey())));
   if(!a.isDirectory()||a.isSymbolicLink())throw new Failure("path_invalid");cursor=cursor.resolve(part);
  }
  var root=Files.readAttributes(directory,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
  ancestors.add(m("path",project.relativize(directory).toString(),"kind",kind(root),"key",key(root.fileKey())));
  Map<String,Object> result=m("ancestors",ancestors,"entries",new ArrayList<Object>());view.put(directory.equals(staging)?"staging":"evidence",result);
  if(!root.isDirectory()||root.isSymbolicLink())throw new Failure("path_invalid");
  @SuppressWarnings("unchecked") List<Object> entries=(List<Object>)result.get("entries");
  List<Path> bounded;int[] visited={0};
  try(var stream=Files.list(directory)){bounded=stream.peek(p->visited[0]++).limit(maxEntries+1L).toList();}
  enumerations.add(m("role",directory.equals(staging)?"staging":"evidence","count",visited[0],"maxEntries",maxEntries));
  if(bounded.size()>maxEntries)throw new Failure("budget_exceeded");
  for(Path p:bounded.stream().sorted().toList()){
    var a=Files.readAttributes(p,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
    entries.add(m("name",p.getFileName().toString(),"kind",kind(a),"key",key(a.fileKey()),"size",a.size()));
    if(!a.isRegularFile()||a.isSymbolicLink())throw new Failure("path_invalid");
    if(a.size()>MAX_FILE)throw new Failure("budget_exceeded");
  }
  if(entries.size()>maxEntries)throw new Failure("budget_exceeded");
  List<String> names=entries.stream().map(x->((Map<?,?>)x).get("name").toString()).toList();
  if(!names.equals(descriptors.stream().map(d->d.get("id").toString()).sorted().toList()))throw new Failure("storage_inventory_mismatch");
  return result;
 }
 @SuppressWarnings("unchecked") static Object identities(Map<String,Object> root){
  return m("ancestors",root.get("ancestors"),"entries",((List<Map<String,Object>>)root.get("entries")).stream().map(f->m("name",f.get("name"),"kind",f.get("kind"),"key",f.get("key"))).toList());
 }
 @SuppressWarnings("unchecked") String check(String invocation,String phase,String point,int calls){
  reads=0;enumerations.clear();view=new LinkedHashMap<>();String reason=null,error=null;
  try{
   var a=rootView(staging);var b=rootView(evidence);
   long total=0;for(var root:List.of(a,b))for(var f:(List<Map<String,Object>>)root.get("entries"))total+=((Number)f.get("size")).longValue();
   if(total>maxTotal)throw new Failure("budget_exceeded");
   if(sealedView!=null)for(String role:List.of("staging","evidence"))if(!identities((Map<String,Object>)sealedView.get(role)).equals(identities((Map<String,Object>)view.get(role))))throw new Failure("storage_identity_mismatch");
   for(String role:List.of("staging","evidence")){
    Path root=role.equals("staging")?staging:evidence;
    for(var f:(List<Map<String,Object>>)((Map<?,?>)view.get(role)).get("entries")){
     byte[] bytes=BtaOwnedDriver.safeBytes(root.resolve(f.get("name").toString()),root);reads++;f.put("sha256",BtaOwnedDriver.hash(bytes));
     var original=descriptors.stream().filter(d->d.get("id").equals(f.get("name"))).findFirst().orElseThrow();
     if(bytes.length!=((Number)original.get("size")).longValue()||!f.get("sha256").equals(original.get("sha256")))throw new Failure("stale");
    }
   }
   // Re-check lexical ancestors and file identities after the reads as well.
   // This detects persistent replacement across the check; it is not an all-writer exclusion guarantee.
   Map<String,Object> readView=view;view=new LinkedHashMap<>();rootView(staging);rootView(evidence);
   for(String role:List.of("staging","evidence"))if(!identities((Map<String,Object>)readView.get(role)).equals(identities((Map<String,Object>)view.get(role))))throw new Failure("storage_identity_mismatch");
   view=readView;
   if(sealedView==null)sealedView=view;
  }catch(Exception ex){reason=ex instanceof Failure f?f.reason:"storage_failed";error=ex.getClass().getSimpleName();}
  audit.add(m("invocation",invocation,"owner",owner,"phase",phase,"point",point,"reason",reason,"errorKind",error,"fileReads",reads,"attemptedSize",0,"writtenBytes",written,"maxFileBytes",MAX_FILE,"maxTotalBytes",maxTotal,"maxEntries",maxEntries,"callsBefore",calls,"callsAfter",calls,"writeAttempts",writeAttempts,"enumerations",List.copyOf(enumerations),"observedSha256",digest(view),"observed",reason==null?null:view));
  return reason;
 }
 void inject(String mode,String when)throws Exception{
  if(!CASES.containsKey(mode))return;
  boolean capture=mode.startsWith("capture-");if(capture!=when.startsWith("capture-"))return;
  if(capture&&((mode.endsWith("after")||mode.equals("capture-after-change"))?!when.equals("capture-after"):!when.equals("capture-before")))return;
  if(!capture&&!when.equals("precheck"))return;
  if(mode.contains("before-write")||mode.equals("storage-total-budget")||mode.equals("storage-entry-budget"))return;
  Path root=mode.startsWith("evidence-")||mode.contains("evidence")?evidence:staging;
  Path file=root.resolve("library.snapshot"),work=staging.getParent();
  if(mode.endsWith("many-entries")){for(int i=0;i<200;i++){Files.writeString(root.resolve("extra-"+i),"fault",StandardOpenOption.CREATE_NEW);injectedEntries++;}}
  else if(mode.endsWith("file-symlink")){
   Path target=work.resolve("link-target.snapshot");Files.move(file,target);Files.createSymbolicLink(file,target);
  }else if(mode.endsWith("root-symlink")){
   Path target=work.resolve("original-"+root.getFileName());Files.move(root,target);Files.createSymbolicLink(root,target.getFileName());
  }else if(mode.endsWith("file-replaced")||mode.equals("capture-path-after")){
   Path replacement=work.resolve("replacement.snapshot");Files.copy(file,replacement);Files.move(replacement,file,StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
  }else if(mode.endsWith("root-replaced")){
   Path old=work.resolve("original-"+root.getFileName());Files.move(root,old);Files.createDirectory(root);
   try(var files=Files.list(old)){for(Path p:files.toList())Files.copy(p,root.resolve(p.getFileName()));}
  }else if(mode.endsWith("extra-file")||mode.equals("capture-extra-after"))Files.writeString(root.resolve("unregistered.txt"),"fault",StandardOpenOption.CREATE_NEW);
  else if(mode.endsWith("file-budget")){try(var f=new RandomAccessFile(file.toFile(),"rw")){f.setLength(MAX_FILE+1);}}
  else BtaOwnedDriver.flip(file);
 }
}
