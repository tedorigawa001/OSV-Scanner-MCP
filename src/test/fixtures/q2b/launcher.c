/* B1b Linux diagnostic fixture. Static ELF; no key reads, accepts or grant issuance. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/resource.h>
#include <sys/un.h>
#include <sys/xattr.h>
#include <linux/capability.h>
#include <linux/memfd.h>
#include <fcntl.h>
#include <unistd.h>
#include <grp.h>
#include <dirent.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include "policy.h"

extern char **environ;
static const char *phase="manager";
static const char *roles[]={"reader","upload","publish"};
static const unsigned gids[]={1202,1203,1204};
static const char *root="/var/lib/osv-q2b/provider/b1b";
static int diagnostics_ready=0;
static void fail(const char *why){if(diagnostics_ready)fprintf(stderr,"{\"stage\":\"%s\",\"reason\":\"%s\",\"nativeIsolationVerified\":false}\n",phase,why);exit(78);}
#define NEED(x,r) do{if(!(x))fail(r);}while(0)
static void no_acl(const char *name){
 const char *attrs[]={"system.posix_acl_access","system.posix_acl_default"};
 for(int i=0;i<2;i++){errno=0;ssize_t n=lgetxattr(name,attrs[i],NULL,0);NEED(n<0&&(errno==ENODATA||errno==EOPNOTSUPP),"unexpected_acl");}
}

/* SHA-256 over pinned fixture files. No external program or dynamically loaded crypto. */
static const uint32_t K[64]={
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
static uint32_t rotr(uint32_t v,unsigned n){return(v>>n)|(v<<(32-n));}
static void block(uint32_t h[8],const unsigned char *p){
 uint32_t w[64];for(int i=0;i<16;i++)w[i]=(uint32_t)p[i*4]<<24|(uint32_t)p[i*4+1]<<16|(uint32_t)p[i*4+2]<<8|p[i*4+3];
 for(int i=16;i<64;i++){uint32_t a=w[i-15],b=w[i-2];w[i]=w[i-16]+(rotr(a,7)^rotr(a,18)^(a>>3))+w[i-7]+(rotr(b,17)^rotr(b,19)^(b>>10));}
 uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],j=h[7];
 for(int i=0;i<64;i++){uint32_t t=j+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[i]+w[i];uint32_t u=(rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c));j=g;g=f;f=e;e=d+t;d=c;c=b;b=a;a=t+u;}
 h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=j;
}
static void pinned_file(const char *name,const char *wanted,unsigned char out[32]){
 int fd=open(name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);struct stat st;
 NEED(fd>=0&&fstat(fd,&st)==0&&S_ISREG(st.st_mode)&&st.st_uid==0&&!(st.st_mode&022)&&st.st_nlink==1&&st.st_size>0&&st.st_size<=4*1024*1024,"artifact_metadata");
 no_acl(name);
 uint32_t h[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
 unsigned char buf[128];size_t used=0;uint64_t total=0;ssize_t n;
 while((n=read(fd,buf+used,64-used))>0){used+=(size_t)n;total+=(size_t)n;if(used==64){block(h,buf);used=0;}}
 NEED(n==0&&total==(uint64_t)st.st_size,"artifact_read");close(fd);buf[used++]=0x80;
 size_t end=used<=56?64:128;memset(buf+used,0,end-used);for(int i=0;i<8;i++)buf[end-1-i]=(unsigned char)((total*8)>>(8*i));
 block(h,buf);if(end==128)block(h,buf+64);
 char hex[65];for(int i=0;i<32;i++){out[i]=(unsigned char)(h[i/4]>>(24-8*(i%4)));sprintf(hex+i*2,"%02x",out[i]);}
 NEED(strcmp(hex,wanted)==0,"artifact_digest");
}
static void ancestors(const char *name){
 char p[256];NEED(strlen(name)<sizeof p,"path_length");strcpy(p,name);
 for(char *s=p+1;*s;s++)if(*s=='/'){*s=0;struct stat st;NEED(lstat(p,&st)==0&&S_ISDIR(st.st_mode)&&st.st_uid==0&&!(st.st_mode&022),"ancestor_custody");no_acl(p);*s='/';}
}
static void closed_fds(int maximum){
 DIR *d=opendir("/proc/self/fd");NEED(d,"fd_inventory");int own=dirfd(d),seen=0;struct dirent *e;
 while((e=readdir(d))){if(e->d_name[0]=='.')continue;char *end;long f=strtol(e->d_name,&end,10);NEED(!*end,"fd_inventory");if(f==own)continue;NEED(f>=0&&f<=maximum,"unexpected_fd");seen++;}
 closedir(d);NEED(seen==maximum+1,"missing_fd");
}
static void standard_fds(void){
 struct stat input,null_device;int flags=fcntl(0,F_GETFL);
 NEED(fstat(0,&input)==0&&lstat("/dev/null",&null_device)==0&&S_ISCHR(input.st_mode)&&S_ISCHR(null_device.st_mode)&&input.st_rdev==null_device.st_rdev&&flags>=0&&!(flags&O_PATH)&&(flags&O_ACCMODE)==O_RDONLY,"stdio_invalid");
 for(int fd=1;fd<=2;fd++){
  struct stat st;int type=-1;struct ucred peer;struct sockaddr_un address;memset(&address,0,sizeof address);
  socklen_t size=sizeof type,credentials=sizeof peer,length=sizeof address;flags=fcntl(fd,F_GETFL);
  NEED(fstat(fd,&st)==0&&S_ISSOCK(st.st_mode)&&flags>=0&&(flags&O_ACCMODE)!=O_RDONLY,"stdio_invalid");
  NEED(getsockopt(fd,SOL_SOCKET,SO_TYPE,&type,&size)==0&&type==SOCK_STREAM&&
       getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&credentials)==0&&credentials==sizeof peer&&peer.pid>0&&peer.uid==0&&peer.gid==0&&
       getpeername(fd,(struct sockaddr*)&address,&length)==0&&address.sun_family==AF_UNIX,"stdio_invalid");
  int parent_channel=length==offsetof(struct sockaddr_un,sun_path)&&peer.pid==getppid();
  int journal_channel=length>offsetof(struct sockaddr_un,sun_path)&&memchr(address.sun_path,0,sizeof address.sun_path)&&!strcmp(address.sun_path,"/run/systemd/journal/stdout");
  NEED(parent_channel||journal_channel,"stdio_invalid");
 }
 diagnostics_ready=1;
}
static int integer_option(int fd,int option){int v=-1;socklen_t n=sizeof v;NEED(getsockopt(fd,SOL_SOCKET,option,&v,&n)==0&&n==sizeof v,"socket_option");return v;}
static uint64_t cookie(int fd){uint64_t c=0;socklen_t n=sizeof c;NEED(getsockopt(fd,SOL_SOCKET,SO_COOKIE,&c,&n)==0&&n==sizeof c&&c,"socket_cookie");return c;}
static int listener_role(int fd){
 struct stat st;struct sockaddr_un a;memset(&a,0,sizeof a);socklen_t n=sizeof a;
 NEED(fstat(fd,&st)==0&&S_ISSOCK(st.st_mode),"listener_kind");
 NEED(integer_option(fd,SO_DOMAIN)==AF_UNIX&&integer_option(fd,SO_TYPE)==SOCK_STREAM&&integer_option(fd,SO_ACCEPTCONN)==1&&integer_option(fd,SO_PASSCRED)==1,"listener_options");
 NEED(getsockname(fd,(struct sockaddr*)&a,&n)==0&&a.sun_family==AF_UNIX&&memchr(a.sun_path,0,sizeof a.sun_path),"listener_path");
 int role=-1;char expected[128];for(int i=0;i<3;i++){snprintf(expected,sizeof expected,"/run/osv-q2b/b1b/%s.sock",roles[i]);if(!strcmp(a.sun_path,expected))role=i;}
 NEED(role>=0,"listener_path");ancestors(a.sun_path);
 NEED(lstat(a.sun_path,&st)==0&&S_ISSOCK(st.st_mode)&&st.st_uid==0&&st.st_gid==gids[role]&&(st.st_mode&0777)==0660&&st.st_nlink==1,"listener_owner");
 no_acl(a.sun_path);
 return role;
}
struct bootstrap{uint64_t magic,pid,uid,gid,cookies[3],generation[4],rootdev,rootino;unsigned char runtime[32],entry[32];};
_Static_assert(sizeof(struct bootstrap)==168,"bootstrap layout");
static void environment(int manager,int activation){
 const char *allowed[]={"LANG","LC_ALL","CREDENTIALS_DIRECTORY","LISTEN_PID","LISTEN_FDS","LISTEN_FDNAMES",NULL};
 const char *manager_extra[]={"INVOCATION_ID","JOURNAL_STREAM","SYSTEMD_EXEC_PID",NULL};
 for(char **e=environ;*e;e++){char *equal=strchr(*e,'=');NEED(equal,"environment");size_t len=(size_t)(equal-*e);int found=0;
  for(int i=0;allowed[i];i++)if(strlen(allowed[i])==len&&!strncmp(*e,allowed[i],len))found=1;
  if(manager)for(int i=0;manager_extra[i];i++)if(strlen(manager_extra[i])==len&&!strncmp(*e,manager_extra[i],len))found=1;
  NEED(found,"environment");for(char **p=environ;p<e;p++)NEED(strncmp(*p,*e,len)||(*p)[len]!='=',"environment_duplicate");
 }
 char pid[32];snprintf(pid,sizeof pid,"%ld",(long)getpid());
 NEED(getenv("LANG")&&!strcmp(getenv("LANG"),"C")&&getenv("LC_ALL")&&!strcmp(getenv("LC_ALL"),"C"),"locale");
 if(!activation){NEED(!getenv("LISTEN_PID")&&!getenv("LISTEN_FDS")&&!getenv("LISTEN_FDNAMES"),"activation_environment");return;}
 NEED(getenv("CREDENTIALS_DIRECTORY")&&!strcmp(getenv("CREDENTIALS_DIRECTORY"),"/run/credentials/osv-q2b-b1b.service"),"credential_directory");
 NEED(getenv("LISTEN_PID")&&!strcmp(getenv("LISTEN_PID"),pid)&&getenv("LISTEN_FDS")&&!strcmp(getenv("LISTEN_FDS"),"3")&&getenv("LISTEN_FDNAMES"),"activation_environment");
}
static void provider_identity(void){
 uid_t a,b,c;gid_t d,e,f;struct __user_cap_header_struct h={_LINUX_CAPABILITY_VERSION_3,0};struct __user_cap_data_struct caps[2]={{0}};
 NEED(!getresuid(&a,&b,&c)&&a==PROVIDER_UID&&b==a&&c==a&&!getresgid(&d,&e,&f)&&d==PROVIDER_GID&&e==d&&f==d&&getgroups(0,NULL)==0,"principal");
 NEED(!syscall(SYS_capget,&h,caps)&&!caps[0].effective&&!caps[0].permitted&&!caps[0].inheritable&&!caps[1].effective&&!caps[1].permitted&&!caps[1].inheritable,"capabilities");
 NEED(prctl(PR_GET_NO_NEW_PRIVS,0,0,0,0)==1,"no_new_privileges");
 for(int i=0;i<64;i++){int bnd=prctl(PR_CAPBSET_READ,i,0,0,0);NEED(bnd==0||(bnd<0&&errno==EINVAL),"bounding_capabilities");}
}
int main(int argc,char **argv){
 phase=geteuid()==0?"manager":"launcher";
 standard_fds(); /* No output, including rejection diagnostics, before all three streams are trusted. */
 if(argc==3&&!strcmp(argv[0],IMAGE "/launcher")&&!strcmp(argv[1],"--prepare")){
  uid_t a,b,c;gid_t d,e,f;NEED(!getresuid(&a,&b,&c)&&!a&&!b&&!c&&!getresgid(&d,&e,&f)&&!d&&!e&&!f,"manager_principal");
  environment(1,0);closed_fds(2);int selected=-1;for(int i=0;i<3;i++)if(!strcmp(argv[2],roles[i]))selected=i;NEED(selected>=0,"arguments");
  char path[128];snprintf(path,sizeof path,"/run/osv-q2b/b1b/%s.sock",roles[selected]);ancestors(path);
  struct stat st;NEED(lstat(path,&st)<0&&errno==ENOENT,"endpoint_exists");return 0;
 }
 NEED(argc==5&&!strcmp(argv[0],IMAGE "/launcher")&&!strcmp(argv[1],"--profile")&&!strcmp(argv[2],"b1b")&&!strcmp(argv[3],"--instance")&&!strcmp(argv[4],"b1b"),"arguments");
 int manager=geteuid()==0;if(!manager)phase="launcher";
 environment(manager,1);closed_fds(manager?5:6);
 struct rlimit limit={0,0};NEED(!setrlimit(RLIMIT_CORE,&limit),"core_limit");
 ancestors(IMAGE "/runtime");ancestors(root);
 struct stat rs;NEED(lstat(root,&rs)==0&&S_ISDIR(rs.st_mode)&&rs.st_uid==PROVIDER_UID&&rs.st_gid==PROVIDER_GID&&(rs.st_mode&0777)==0700,"root_custody");
 no_acl(root);
 struct bootstrap boot={0};
 if(manager){
  uid_t u,v,w;gid_t g,j,k;NEED(!getresuid(&u,&v,&w)&&!u&&!v&&!w&&!getresgid(&g,&j,&k)&&!g&&!j&&!k,"manager_principal");
  int mapping[3]={-1,-1,-1},copies[3];char names[64]="";
  for(int fd=3;fd<6;fd++){int r=listener_role(fd);NEED(mapping[r]<0,"duplicate_listener");mapping[r]=fd;if(fd>3)strcat(names,":");strcat(names,roles[r]);}
  NEED(!strcmp(names,getenv("LISTEN_FDNAMES")),"listener_names");
  for(int i=0;i<3;i++){copies[i]=fcntl(mapping[i],F_DUPFD_CLOEXEC,10);NEED(copies[i]>=10,"fd_duplicate");}
  for(int i=0;i<3;i++){NEED(dup2(copies[i],3+i)==3+i,"fd_duplicate");close(copies[i]);boot.cookies[i]=cookie(3+i);}
  NEED(boot.cookies[0]!=boot.cookies[1]&&boot.cookies[0]!=boot.cookies[2]&&boot.cookies[1]!=boot.cookies[2],"duplicate_cookie");
  boot.magic=0x514232424f4f5431ULL;boot.pid=(uint64_t)getpid();boot.uid=PROVIDER_UID;boot.gid=PROVIDER_GID;boot.rootdev=rs.st_dev;boot.rootino=rs.st_ino;
  NEED(getrandom(boot.generation,sizeof boot.generation,0)==sizeof boot.generation,"random");
  pinned_file(IMAGE "/runtime",RUNTIME_HASH,boot.runtime);pinned_file(IMAGE "/provider.py",ENTRY_HASH,boot.entry);
  int memory=(int)syscall(SYS_memfd_create,"q2b-bootstrap",MFD_ALLOW_SEALING|MFD_CLOEXEC);NEED(memory==6,"bootstrap_fd");
  NEED(write(memory,&boot,sizeof boot)==sizeof boot&&!fchmod(memory,0400),"bootstrap_write");
  NEED(fcntl(memory,F_ADD_SEALS,F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK|F_SEAL_SEAL)==0,"bootstrap_seal");
  int ro=open("/proc/self/fd/6",O_RDONLY|O_CLOEXEC);NEED(ro>=7&&dup2(ro,6)==6,"bootstrap_readonly");close(ro);
  for(int i=0;i<64;i++){int b=prctl(PR_CAPBSET_READ,i,0,0,0);if(b<0){NEED(errno==EINVAL,"capability_range");continue;}NEED(prctl(PR_CAPBSET_DROP,i,0,0,0)==0,"capability_drop");}
  NEED(!setgroups(0,NULL)&&!setresgid(PROVIDER_GID,PROVIDER_GID,PROVIDER_GID)&&!setresuid(PROVIDER_UID,PROVIDER_UID,PROVIDER_UID),"identity_drop");
  struct __user_cap_header_struct h={_LINUX_CAPABILITY_VERSION_3,0};struct __user_cap_data_struct zero[2]={{0}};NEED(!syscall(SYS_capset,&h,zero),"capability_drop");
  NEED(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)==0,"no_new_privileges");
  NEED(!clearenv()&&!setenv("LANG","C",1)&&!setenv("LC_ALL","C",1),"environment");char pid[32];snprintf(pid,sizeof pid,"%ld",(long)getpid());
  NEED(!setenv("LISTEN_PID",pid,1)&&!setenv("LISTEN_FDS","3",1)&&!setenv("LISTEN_FDNAMES","reader:upload:publish",1),"environment");
  NEED(!setenv("CREDENTIALS_DIRECTORY","/run/credentials/osv-q2b-b1b.service",1),"environment");
  NEED(chdir(IMAGE)==0,"cwd");execve(IMAGE "/launcher",argv,environ);fail("launcher_exec");
 }
 provider_identity();struct stat st;int seals=fcntl(6,F_GET_SEALS);int required=F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK|F_SEAL_SEAL;
 NEED(fstat(6,&st)==0&&S_ISREG(st.st_mode)&&st.st_uid==0&&st.st_size==sizeof boot&&(fcntl(6,F_GETFL)&O_ACCMODE)==O_RDONLY&&seals>=0&&(seals&required)==required,"bootstrap_custody");
 NEED(pread(6,&boot,sizeof boot,0)==sizeof boot&&boot.magic==0x514232424f4f5431ULL&&boot.pid==(uint64_t)getpid()&&boot.uid==PROVIDER_UID&&boot.gid==PROVIDER_GID&&boot.rootdev==(uint64_t)rs.st_dev&&boot.rootino==(uint64_t)rs.st_ino,"bootstrap_binding");
 for(int i=0;i<3;i++)NEED(listener_role(3+i)==i&&cookie(3+i)==boot.cookies[i],"listener_binding");
 unsigned char runtime[32],entry[32];pinned_file(IMAGE "/runtime",RUNTIME_HASH,runtime);pinned_file(IMAGE "/provider.py",ENTRY_HASH,entry);
 NEED(!memcmp(runtime,boot.runtime,32)&&!memcmp(entry,boot.entry,32),"bootstrap_artifact");
 NEED(chdir(IMAGE)==0,"cwd");char *fixed[]={IMAGE "/runtime","-I",IMAGE "/provider.py",NULL};
 execve(fixed[0],fixed,environ);fail("runtime_exec");return 78;
}
