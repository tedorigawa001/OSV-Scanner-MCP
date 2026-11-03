/* Included after the reviewed bootstrap layout. Manager key never crosses exec. */
#include <openssl/evp.h>
#include <openssl/crypto.h>
#include <openssl/sha.h>
#include <inttypes.h>
#include <ctype.h>
static void native_hex(const unsigned char *bytes,size_t n,char *out){for(size_t i=0;i<n;i++)sprintf(out+2*i,"%02x",bytes[i]);}
static void native_read(const char *name,unsigned char *bytes,size_t length){
 ancestors(name);no_acl(name);int fd=open(name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);struct stat st;
 NEED(fd>=0&&fstat(fd,&st)==0&&S_ISREG(st.st_mode)&&st.st_uid==0&&st.st_gid==0&&st.st_nlink==1&&(st.st_mode&0777)==0400&&st.st_size==(off_t)length,"native_context_custody");
 NEED(read(fd,bytes,length)==(ssize_t)length,"native_context_read");unsigned char extra;NEED(read(fd,&extra,1)==0,"native_context_read");close(fd);
}
static void native_id(char *out,const unsigned char *in){size_t n=0;while(n<64&&in[n]){NEED(isalnum(in[n])||in[n]=='-'||in[n]=='_'||in[n]=='.',"native_context_id");out[n]=(char)in[n];n++;}NEED(n>0&&n<64,"native_context_id");for(size_t i=n;i<64;i++)NEED(in[i]==0,"native_context_id");out[n]=0;}
static void native_sign(struct bootstrap *boot){
 const char *launch="/run/osv-q2b/b1ct/launch.json";struct stat absent;
 NEED(lstat(launch,&absent)<0&&errno==ENOENT,"native_launch_exists");ancestors(launch);
 unsigned char context[160],key[32];char manifest[65]={0},generation[65]={0},run[65]={0},case_id[65]={0};
 native_read("/etc/osv-q2b-b1ct/context",context,sizeof context);memcpy(boot->manifest,context,32);
 native_hex(context,32,manifest);native_hex((unsigned char*)boot->generation,32,generation);native_id(run,context+32);native_id(case_id,context+96);
 char listeners[4096]="";size_t used=0;
 for(int i=0;i<3;i++){
  struct stat fd,leaf;char name[128];snprintf(name,sizeof name,"/run/osv-q2b/b1ct/%s.sock",roles[i]);
  NEED(fstat(3+i,&fd)==0&&lstat(name,&leaf)==0,"native_launch_inventory");
  int n=snprintf(listeners+used,sizeof listeners-used,
   "%s{\"cookie\":\"%" PRIu64 "\",\"custodianGid\":0,\"custodianUid\":0,\"descriptorInode\":\"%ju\",\"directoryWriters\":[0],\"domain\":\"AF_UNIX\",\"fd\":%d,\"listening\":true,\"mode\":432,\"ownerGid\":%u,\"ownerUid\":0,\"passCredentials\":true,\"path\":\"%s\",\"pathnameDevice\":\"%ju\",\"pathnameInode\":\"%ju\",\"role\":\"%s\",\"type\":\"SOCK_STREAM\"}",
   i?",":"",boot->cookies[i],(uintmax_t)fd.st_ino,3+i,gids[i],name,(uintmax_t)leaf.st_dev,(uintmax_t)leaf.st_ino,roles[i]);
  NEED(n>0&&(size_t)n<sizeof listeners-used,"native_launch_budget");used+=(size_t)n;
 }
 char body[6144],unsigned_json[7168],envelope[8192];
 int n=snprintf(body,sizeof body,"{\"bootstrapFd\":6,\"caseId\":\"%s\",\"listeners\":[%s],\"manifestDigest\":\"%s\",\"pid\":%ld,\"providerBoot\":\"%s\",\"runId\":\"%s\",\"schema\":\"osv-mcp.q2b.launch.v1\",\"socketGeneration\":\"%s\"}",case_id,listeners,manifest,(long)getpid(),generation,run,generation);
 NEED(n>0&&(size_t)n<sizeof body,"native_launch_budget");
 n=snprintf(unsigned_json,sizeof unsigned_json,"{\"body\":%s,\"keyId\":\"manager-native\",\"role\":\"manager\",\"schema\":\"osv-mcp.q2b.evidence.v1\"}",body);
 NEED(n>0&&(size_t)n<sizeof unsigned_json,"native_launch_budget");
 NEED(OPENSSL_init_crypto(OPENSSL_INIT_NO_LOAD_CONFIG,NULL)==1,"native_crypto");native_read("/etc/osv-q2b-b1ct/manager.key",key,sizeof key);
 EVP_PKEY *p=EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519,NULL,key,sizeof key);OPENSSL_cleanse(key,sizeof key);
 EVP_MD_CTX *m=EVP_MD_CTX_new();unsigned char signature[64];size_t length=sizeof signature;
 NEED(p&&m&&EVP_DigestSignInit(m,NULL,NULL,NULL,p)==1&&EVP_DigestSign(m,signature,&length,(unsigned char*)unsigned_json,(size_t)n)==1&&length==64,"native_sign");
 EVP_MD_CTX_free(m);EVP_PKEY_free(p);unsigned char encoded[89];NEED(EVP_EncodeBlock(encoded,signature,64)==88,"native_sign");
 n=snprintf(envelope,sizeof envelope,"{\"body\":%s,\"keyId\":\"manager-native\",\"role\":\"manager\",\"schema\":\"osv-mcp.q2b.evidence.v1\",\"signature\":\"%s\"}",body,encoded);
 NEED(n>0&&(size_t)n<sizeof envelope,"native_launch_budget");
 int fd=open(launch,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0644);NEED(fd>=0,"native_launch_publish");
 NEED(fchmod(fd,0644)==0&&write(fd,envelope,(size_t)n)==n&&fsync(fd)==0,"native_launch_publish");close(fd);
 int directory=open("/run/osv-q2b/b1ct",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);NEED(directory>=0&&fsync(directory)==0,"native_launch_sync");close(directory);
 NEED(SHA256((unsigned char*)envelope,(size_t)n,boot->launch)!=NULL,"native_launch_digest");closed_fds(5);
}
