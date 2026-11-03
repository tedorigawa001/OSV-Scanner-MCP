/** Q2/B1a data-only reference contract. No exec, sockets, filesystem inspection or adoption. */
import { verify as verifySignature, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { canonicalOwnedJson, ownedSha256, parseOwnedJson, OwnedManifestError } from '../../utils/gradleOwnedJson.js';

export const DEPLOYMENT_LIMITS = Object.freeze({ documentBytes: 256 * 1024, artifactBytes: 4 * 1024 * 1024,
  closureBytes: 16 * 1024 * 1024, artifacts: 128, cases: 128 });
export class DeploymentContractError extends Error { constructor(reason: string) { super('q2b_' + reason); } }
function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new DeploymentContractError(reason); }
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uid = uint.max(4294967294).refine(n => n !== 65534);
const decimal = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(s=>BigInt(s)<=18446744073709551615n);
const version = z.string().min(1).max(256).regex(/^[\x20-\x7e]+$/);
const path = z.string().min(2).max(1024).regex(/^\/[A-Za-z0-9._/-]+$/)
  .refine(s => !s.endsWith('/') && s.split('/').slice(1).every(x => x !== '' && x !== '.' && x !== '..'));
const roles = ['provider', 'reader', 'build', 'writer', 'checkpoint', 'registry'] as const;
const endpointRoles = ['reader', 'upload', 'publish'] as const;
const artifactRoles = ['launcher', 'runtime', 'entrypoint', 'crypto', 'service-unit', 'reader-unit', 'upload-unit', 'publish-unit'] as const;
const principal = z.object({ uid: uid.positive(), gid: uid.positive(), supplementaryGroups: z.array(uid).max(16) }).strict();
const artifact = z.object({ role: z.enum([...artifactRoles, 'dependency']), path, sha256: digest,
  byteLength: uint.positive().max(DEPLOYMENT_LIMITS.artifactBytes), ownerUid: z.literal(0), writers: z.tuple([z.literal(0)]),
  kind: z.literal('regular'), nlink: z.literal(1) }).strict();
const manifestSchema = z.object({
  schema: z.literal('osv-mcp.q2b.deployment.v1'), scope: z.literal('b1a-static-only'), profileId: id, instanceId: id, imageId: id,
  platform: z.object({ os: z.literal('linux'), kernel: version, distribution: version, systemd: version, filesystem: id,
    mountOptions: z.array(id).min(1).max(32), runtimeVersion: version }).strict(), policyDigest: digest,
  managerUid: z.literal(0), controllerUid: z.literal(0),
  principals: z.object({ provider: principal, reader: principal, build: principal, writer: principal, checkpoint: principal, registry: principal }).strict(),
  artifacts: z.array(artifact).min(8).max(DEPLOYMENT_LIMITS.artifacts),
  execution: z.object({ launcher: path, runtime: path, entrypoint: path, cwd: path,
    launcherArgv: z.array(z.string().max(1024)).max(8), runtimeArgv: z.array(z.string().max(1024)).max(8), credentialDirectory: path,
    // The root manager creates the bootstrap as a sealed read-only memfd at fd 6 before dropping credentials;
    // systemd passes only the 3 listeners.
    bootstrap: z.object({ mechanism: z.literal('manager-memfd'), fd: z.literal(6), sealed: z.literal(true), readOnly: z.literal(true) }).strict(),
    shell: z.literal(false), inheritEnvironment: z.literal(false), dynamicFdStore: z.literal(false) }).strict(),
  roots: z.array(z.object({ role: z.enum(['provider', 'checkpoint', 'registry', 'evidence']), path, ownerUid: uid,
    kind: z.literal('directory'), mode: z.literal(448), ancestorWriters: z.tuple([z.literal(0)]), writers: z.array(uid).length(1), device: decimal, inode: decimal, newPrivate: z.literal(true) }).strict()).length(4),
  endpoints: z.array(z.object({ role: z.enum(endpointRoles), path, unitPath: path, groupGid: uid, ownerUid: z.literal(0), mode: z.literal(432),
    directoryWriters: z.tuple([z.literal(0)]), accept: z.literal(false), passCredentials: z.literal(true), fileDescriptorName: z.enum(endpointRoles) }).strict()).length(3),
  limits: z.object({ frameBytes: uint.positive().max(4096), connectionMs: uint.positive().max(2000), pending: uint.positive().max(64), requests: uint.positive().max(2) }).strict(),
  providerMayBind: z.literal(false), coordinatedRestart: z.literal(true),
}).strict();
export type DeploymentManifest = z.infer<typeof manifestSchema>;
type Manifest = DeploymentManifest;
export type DeploymentHandle = Readonly<{ manifestDigest: string; schemaVerified: true; nativeIsolationVerified: false; backendEligible: false }>;
const manifests = new WeakMap<object, Manifest>();
function same(a: unknown, b: unknown) { return canonicalOwnedJson(a) === canonicalOwnedJson(b); }
function decode<T>(buffer: Buffer, schema: z.ZodType<T>): T {
  check(Buffer.isBuffer(buffer), 'schema_invalid');
  check(buffer.length <= DEPLOYMENT_LIMITS.documentBytes, 'budget_exceeded');
  const copy = Buffer.from(buffer), raw = parseOwnedJson(copy.toString('utf8'), DEPLOYMENT_LIMITS.documentBytes);
  check(Buffer.from(canonicalOwnedJson(raw)).equals(copy), 'canonical_invalid');
  return schema.parse(raw);
}
function guarded<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof DeploymentContractError) throw error;
    throw new DeploymentContractError(error instanceof OwnedManifestError && error.message.includes('budget_exceeded') ? 'budget_exceeded' : 'schema_invalid');
  }
}
function unique(values: (string | number)[], reason: string) { check(new Set(values).size === values.length, reason); }
export function verifyDeploymentManifest(input: { manifest: Buffer; expectedDigest: string; artifacts: { path: string; bytes: Buffer }[] }): DeploymentHandle {
  return guarded(() => {
    digest.parse(input.expectedDigest);
    const m = decode(input.manifest, manifestSchema);
    check(ownedSha256(input.manifest) === input.expectedDigest, 'manifest_pin_mismatch');
    const ps = roles.map(r => m.principals[r]);
    unique(ps.map(p => p.uid), 'principal_invalid'); unique(ps.map(p => p.gid), 'principal_invalid');
    check(ps.every(p => p.supplementaryGroups.length === 0), 'principal_invalid');
    unique(m.platform.mountOptions, 'schema_invalid');
    check(m.platform.mountOptions.includes('nodev') && m.platform.mountOptions.includes('nosuid'), 'configuration_invalid');
    const image = '/opt/osv-q2b/' + m.imageId;
    const byRole = (role: typeof artifactRoles[number]) => m.artifacts.find(a => a.role === role)!;
    unique(m.artifacts.map(a => a.path), 'closure_invalid');
    for (const role of artifactRoles) check(m.artifacts.filter(a => a.role === role).length === 1, 'closure_invalid');
    check(m.artifacts.every(a => a.path.startsWith(image + '/')), 'closure_invalid');
    check(m.execution.launcher === byRole('launcher').path && m.execution.runtime === byRole('runtime').path && m.execution.entrypoint === byRole('entrypoint').path && m.execution.cwd === image, 'execution_invalid');
    check(same(m.execution.launcherArgv, [m.execution.launcher, '--profile', m.profileId, '--instance', m.instanceId]) &&
      same(m.execution.runtimeArgv, [m.execution.runtime, '-I', m.execution.entrypoint]), 'execution_invalid');
    check(m.execution.credentialDirectory === '/run/credentials/osv-q2b-' + m.instanceId + '.service', 'execution_invalid');
    unique(m.roots.map(r => r.role), 'roots_invalid'); unique(m.roots.map(r => r.device + ':' + r.inode), 'roots_invalid');
    for (const root of m.roots) {
      const owner = root.role === 'evidence' ? 0 : m.principals[root.role].uid;
      check(root.ownerUid === owner && same(root.writers, [owner]) && root.path === '/var/lib/osv-q2b/' + root.role + '/' + m.instanceId, 'roots_invalid');
    }
    unique(m.endpoints.map(e => e.role), 'endpoint_invalid'); unique(m.endpoints.map(e => e.path), 'endpoint_invalid');
    for (const endpoint of m.endpoints) {
      const actor = endpoint.role === 'reader' ? 'reader' : endpoint.role === 'upload' ? 'build' : 'writer';
      check(endpoint.groupGid === m.principals[actor].gid && endpoint.path === '/run/osv-q2b/' + m.instanceId + '/' + endpoint.role + '.sock' && endpoint.fileDescriptorName === endpoint.role && endpoint.unitPath === byRole((endpoint.role + '-unit') as typeof artifactRoles[number]).path, 'endpoint_invalid');
    }
    check(Array.isArray(input.artifacts) && input.artifacts.length === m.artifacts.length, 'closure_invalid');
    unique(input.artifacts.map(a => a.path), 'closure_invalid');
    let total = 0;
    for (const a of input.artifacts) {
      check(Buffer.isBuffer(a.bytes), 'closure_invalid');
      total += a.bytes.length;
      check(a.bytes.length <= DEPLOYMENT_LIMITS.artifactBytes && total <= DEPLOYMENT_LIMITS.closureBytes, 'budget_exceeded');
      const expected = m.artifacts.find(e => e.path === a.path);
      check(expected && expected.byteLength === a.bytes.length && expected.sha256 === ownedSha256(a.bytes), 'closure_invalid');
    }
    const handle: DeploymentHandle = Object.freeze({ manifestDigest: input.expectedDigest, schemaVerified: true, nativeIsolationVerified: false, backendEligible: false });
    manifests.set(handle, m);
    return handle;
  });
}


const stage = z.enum(['manager', 'launcher', 'provider']);
const status = z.enum(['accepted', 'rejected']);
const reason = z.enum(['preflight-accepted', 'binding_mismatch', 'principal_invalid', 'execution_invalid', 'fd_invalid', 'roots_invalid']);
const listener = z.object({ fd: uint.min(3).max(5), role: z.enum(endpointRoles), path, cookie: decimal,
  custodianUid: uid, custodianGid: uid, ownerUid: uid, ownerGid: uid, mode: uint.max(511), directoryWriters: z.array(uid).max(16),
  domain: id, type: id, listening: z.boolean(), passCredentials: z.boolean(), pathnameDevice: decimal, pathnameInode: decimal, descriptorInode: decimal }).strict();
const launchSchema = z.object({ schema: z.literal('osv-mcp.q2b.launch.v1'), manifestDigest: digest, runId: id, caseId: id,
  pid: uint.positive(), socketGeneration: id, providerBoot: id, bootstrapFd: z.literal(6), listeners: z.array(listener).length(3) }).strict();
export type B1aLaunchInventory = z.infer<typeof launchSchema>;
type Launch = B1aLaunchInventory;
const fd = z.discriminatedUnion('kind', [
  z.object({fd:uint.max(2),kind:z.literal('stdio'),target:z.enum(['null','controller-log'])}).strict(),
  listener.extend({kind:z.literal('listener'),socketGeneration:id}).strict(),
  z.object({fd:uint,kind:z.literal('bootstrap'),ownerUid:uid,readOnly:z.boolean(),sealed:z.boolean(),launchDigest:digest}).strict(),
  z.object({fd:uint,kind:z.literal('unexpected'),description:id}).strict(),
]);
const rootState=z.object({role:z.enum(['provider','checkpoint','registry','evidence']),path,ownerUid:uid,kind:id,mode:uint.max(511),ancestorWriters:z.array(uid).max(16),writers:z.array(uid).max(16),device:decimal,inode:decimal,newPrivate:z.boolean()}).strict();
const principalState=z.object({role:z.enum(roles),uid:z.tuple([uid,uid,uid]),gid:z.tuple([uid,uid,uid]),supplementaryGroups:z.array(uid).max(16),capabilities:z.array(id).max(32),adminRoutes:z.array(id).max(32),noNewPrivileges:z.boolean()}).strict();
const observation = z.object({ phase:stage, rootState:z.array(rootState).length(4), principalState:z.array(principalState).length(6), platform:manifestSchema.shape.platform, pid:uint.positive(), manifestDigest:digest,imageId:id,closureDigest:digest,
  identity:z.object({uid:z.tuple([uid,uid,uid]),gid:z.tuple([uid,uid,uid]),supplementaryGroups:z.array(uid).max(32),
    capabilities:z.array(id).max(32),adminRoutes:z.array(id).max(32),noNewPrivileges:z.boolean()}).strict(),
  launcherArgv:z.array(z.string().max(1024)).max(32),runtimeArgv:z.array(z.string().max(1024)).max(32),cwd:path,
  environment:z.array(z.object({name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),value:z.string().max(2048)}).strict()).max(32),
  fds:z.array(fd).max(32),
}).strict();
type Observation=z.infer<typeof observation>;
const resultSchema=z.object({status,stage,reason}).strict();
const event=z.object({seq:uint.positive(),stage,kind:z.enum(['gate-begin','gate-pass','gate-reject','exec','secret-read','canonical-read','accept','injection-exec']),pid:uint.positive(),uid}).strict();
const diagnosticSchema=z.object({schema:z.literal('osv-mcp.q2b.diagnostic.v1'),mode:z.literal('synthetic-static'),runId:id,caseId:id,
  manifestDigest:digest,launchDigest:digest,observations:z.array(observation).min(1).max(3),events:z.array(event).max(32),claimed:resultSchema}).strict();
export type B1aDiagnostic = z.infer<typeof diagnosticSchema>;
const expectationSchema=z.object({runId:id,caseId:id,launchDigest:digest,status,stage,reason}).strict();
export type B1aExpectation=z.infer<typeof expectationSchema>;
export interface B1aSignerPin { keyId:string; publicKey:KeyObject }
const envelopeSchema=z.object({schema:z.literal('osv-mcp.q2b.evidence.v1'),role:z.enum(['manager','controller']),keyId:id,body:z.unknown(),signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
function authenticated<T>(bytes:Buffer,role:'manager'|'controller',pin:B1aSignerPin,schema:z.ZodType<T>):T {
  const e=decode(bytes,envelopeSchema);id.parse(pin.keyId);
  check(e.role===role&&e.keyId===pin.keyId&&pin.publicKey?.type==='public'&&pin.publicKey.asymmetricKeyType==='ed25519','issuer_invalid');
  const {signature,...unsigned}=e;
  check(Buffer.from(signature,'base64').toString('base64')===signature,'canonical_invalid');
  check(verifySignature(null,Buffer.from(canonicalOwnedJson(unsigned)),pin.publicKey,Buffer.from(signature,'base64')),'signature_invalid');
  return schema.parse(e.body);
}
function verifyLaunch(m:Omit<Manifest,'scope'>, l:Launch, expected:B1aExpectation, manifestDigest:string) {
  check(l.manifestDigest===manifestDigest&&l.runId===expected.runId&&l.caseId===expected.caseId,'binding_mismatch');
  unique(l.listeners.map(x=>x.fd),'launch_invalid');unique(l.listeners.map(x=>x.role),'launch_invalid');
  unique(l.listeners.map(x=>x.cookie),'launch_invalid');unique(l.listeners.map(x=>x.pathnameDevice+':'+x.pathnameInode),'launch_invalid');
  for(const actual of l.listeners){
    const wanted=m.endpoints.find(x=>x.role===actual.role)!;
    check(wanted&&actual.path===wanted.path&&actual.ownerUid===0&&actual.ownerGid===wanted.groupGid&&actual.custodianUid===0&&actual.custodianGid===0&&actual.mode===wanted.mode&&
      same(actual.directoryWriters,[0])&&actual.domain==='AF_UNIX'&&actual.type==='SOCK_STREAM'&&actual.listening&&actual.passCredentials,'launch_invalid');
  }
}
function evaluate(m:Manifest, l:Launch, launchDigest:string, o:Observation):z.infer<typeof reason>|undefined {
  if(!same(o.platform,m.platform)||o.pid!==l.pid||o.manifestDigest!==l.manifestDigest||o.imageId!==m.imageId||o.closureDigest!==ownedSha256(canonicalOwnedJson(m.artifacts)))return 'binding_mismatch';
  const sortRoots=(xs:{role:string}[])=>[...xs].sort((a,b)=>a.role<b.role?-1:a.role>b.role?1:0);
  if(!same(sortRoots(o.rootState),sortRoots(m.roots)))return 'roots_invalid';
  if(new Set(o.principalState.map(p=>p.role)).size!==6)return 'principal_invalid';
  for(const actual of o.principalState){
    const expected=m.principals[actual.role];
    if(!same(actual.uid,[expected.uid,expected.uid,expected.uid])||!same(actual.gid,[expected.gid,expected.gid,expected.gid])||actual.supplementaryGroups.length||actual.capabilities.length||actual.adminRoutes.length||!actual.noNewPrivileges)return 'principal_invalid';
  }
  const p=m.principals.provider;
  if(!same(o.identity.uid,[p.uid,p.uid,p.uid])||!same(o.identity.gid,[p.gid,p.gid,p.gid])||o.identity.supplementaryGroups.length||
    o.identity.capabilities.length||o.identity.adminRoutes.length||!o.identity.noNewPrivileges)return 'principal_invalid';
  const env=[{name:'LANG',value:'C'},{name:'LC_ALL',value:'C'},{name:'CREDENTIALS_DIRECTORY',value:m.execution.credentialDirectory},
    {name:'LISTEN_PID',value:String(l.pid)},{name:'LISTEN_FDS',value:String(l.listeners.length)},
    {name:'LISTEN_FDNAMES',value:[...l.listeners].sort((a,b)=>a.fd-b.fd).map(x=>m.endpoints.find(e=>e.role===x.role)!.fileDescriptorName).join(':')}];
  const sortEnv=(xs:{name:string;value:string}[])=>[...xs].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  if(!same(sortEnv(o.environment),sortEnv(env))||!same(o.launcherArgv,m.execution.launcherArgv)||!same(o.runtimeArgv,m.execution.runtimeArgv)||o.cwd!==m.execution.cwd)return 'execution_invalid';
  const wanted=[{fd:0,kind:'stdio',target:'null'},{fd:1,kind:'stdio',target:'controller-log'},{fd:2,kind:'stdio',target:'controller-log'},
    ...l.listeners.map(x=>({...x,kind:'listener',socketGeneration:l.socketGeneration})),
    // The manager phase is observed just before the first launcher exec, after the root-owned memfd exists.
    {fd:m.execution.bootstrap.fd,kind:'bootstrap',ownerUid:0,readOnly:true,sealed:true,launchDigest}];
  const sortFd=(xs:{fd:number}[])=>[...xs].sort((a,b)=>a.fd-b.fd);
  if(!same(sortFd(o.fds),sortFd(wanted)))return 'fd_invalid';
  return undefined;
}
export interface B1aDiagnosticInput {
  manifest:DeploymentHandle; launch:Buffer; diagnostic:Buffer; manager:B1aSignerPin; controller:B1aSignerPin; expectation:B1aExpectation;
}
export function verifyB1aDiagnostic(input:B1aDiagnosticInput) {
  return guarded(()=>{
    const m=manifests.get(input.manifest);check(m,'manifest_handle_invalid');
    const expected=expectationSchema.parse(input.expectation);
    for(const pin of [input.manager,input.controller])check(pin.publicKey?.type==='public'&&pin.publicKey.asymmetricKeyType==='ed25519','issuer_invalid');
    check(input.manager.publicKey.export({type:'spki',format:'der'}).toString('hex')!==input.controller.publicKey.export({type:'spki',format:'der'}).toString('hex'),'issuer_invalid');
    const l=authenticated(input.launch,'manager',input.manager,launchSchema);
    check(ownedSha256(input.launch)===expected.launchDigest,'launch_pin_mismatch');
    verifyLaunch(m,l,expected,input.manifest.manifestDigest);
    const d=authenticated(input.diagnostic,'controller',input.controller,diagnosticSchema);
    check(d.manifestDigest===input.manifest.manifestDigest&&d.launchDigest===expected.launchDigest&&d.runId===expected.runId&&d.caseId===expected.caseId,'binding_mismatch');
    const expectedEvents:z.infer<typeof event>[]=[];
    let computed:z.infer<typeof resultSchema>|undefined;
    const stages=['manager','launcher','provider'] as const;
    for(let i=0;i<stages.length;i++){
      const current=stages[i]!,o=d.observations[i];check(o&&o.phase===current,'evidence_incomplete');
      const add=(kind:z.infer<typeof event>['kind'])=>expectedEvents.push({seq:expectedEvents.length+1,stage:current,kind,pid:l.pid,uid:current==='manager'?0:m.principals.provider.uid});
      if(i>0)add('exec');add('gate-begin');
      const failure=evaluate(m,l,expected.launchDigest,o);
      add(failure?'gate-reject':'gate-pass');
      if(failure){computed={status:'rejected',stage:current,reason:failure};check(d.observations.length===i+1,'event_invalid');break;}
    }
    computed??={status:'accepted',stage:'provider',reason:'preflight-accepted'};
    check(same(d.events,expectedEvents),'event_invalid');
    check(same(d.claimed,computed)&&same({status:expected.status,stage:expected.stage,reason:expected.reason},computed),'case_expectation_mismatch');
    return Object.freeze({...computed,runId:l.runId,caseId:l.caseId,manifestDigest:l.manifestDigest,launchDigest:expected.launchDigest,
      staticContractVerified:true as const,launcherExecCount:expectedEvents.filter(x=>x.stage==='launcher'&&x.kind==='exec').length,
      runtimeExecCount:expectedEvents.filter(x=>x.stage==='provider'&&x.kind==='exec').length,
      canonicalContentReads:0 as const,secretReads:0 as const,injectedCodeExecutions:0 as const,
      nativeIsolationVerified:false as const,profileApproved:false as const,backendEligible:false as const,originalReadsSkipped:0 as const});
  });
}


/** Verifies a complete caller-pinned synthetic case plan; does not launch any process. */
export function verifyB1aSuite(input:{manifest:DeploymentHandle;manager:B1aSignerPin;controller:B1aSignerPin;runId:string;
  expectations:B1aExpectation[];records:{caseId:string;launch:Buffer;diagnostic:Buffer}[]}) {
  return guarded(()=>{
    id.parse(input.runId);check(manifests.has(input.manifest),'manifest_handle_invalid');
    check(Array.isArray(input.expectations)&&input.expectations.length>0&&input.expectations.length<=DEPLOYMENT_LIMITS.cases,'budget_exceeded');
    const plan=input.expectations.map(x=>expectationSchema.parse(x));
    unique(plan.map(x=>x.caseId),'case_plan_invalid');
    check(plan.every(x=>x.runId===input.runId),'case_plan_invalid');
    check(Array.isArray(input.records)&&input.records.length===plan.length,'evidence_incomplete');
    unique(input.records.map(x=>x.caseId),'case_plan_invalid');
    let total=0;
    for(const r of input.records){
      check(Buffer.isBuffer(r.launch)&&Buffer.isBuffer(r.diagnostic),'schema_invalid');
      total+=r.launch.length+r.diagnostic.length;
      check(r.launch.length<=DEPLOYMENT_LIMITS.documentBytes&&r.diagnostic.length<=DEPLOYMENT_LIMITS.documentBytes&&total<=DEPLOYMENT_LIMITS.closureBytes,'budget_exceeded');
    }
    const results=input.records.map(record=>{
      const expected=plan.find(x=>x.caseId===record.caseId);check(expected,'case_plan_invalid');
      return verifyB1aDiagnostic({manifest:input.manifest,manager:input.manager,controller:input.controller,
        launch:record.launch,diagnostic:record.diagnostic,expectation:expected});
    });
    results.sort((a,b)=>a.caseId<b.caseId?-1:a.caseId>b.caseId?1:0);
    return Object.freeze({runId:input.runId,manifestDigest:input.manifest.manifestDigest,staticContractVerified:true as const,
      verifiedCases:results.length,acceptedCases:results.filter(x=>x.status==='accepted').length,rejectedCases:results.filter(x=>x.status==='rejected').length,
      results:Object.freeze(results),nativeIsolationVerified:false as const,profileApproved:false as const,backendEligible:false as const,originalReadsSkipped:0 as const});
  });
}

/** Separate native diagnostic path. Never relabels actual observations as synthetic-static.
 * Artifact hashes are attested by the independently pinned controller, not locally
 * re-read archive bytes. This proves launch binding, not complete native isolation. */
const nativeManifestSchema=manifestSchema.extend({scope:z.literal('b1c-native-observed'),profileId:z.literal('b1ct'),instanceId:z.literal('b1ct'),imageId:z.literal('b1ct'),
 artifacts:z.array(artifact.extend({byteLength:uint.positive().max(16*1024*1024)})).min(8).max(128)});
const nativeFd=z.object({fd:uint.max(6),device:decimal,inode:decimal,ownerUid:uid,ownerGid:uid,mode:uint.max(511),flags:uint,
 kind:z.enum(['null','journal','listener','bootstrap']),seals:uint.optional()}).strict();
const capValue=z.string().regex(/^[a-f0-9]{16}$/);
const nativePhase=z.object({phase:stage,pid:uint.positive(),uid:z.tuple([uid,uid,uid]),gid:z.tuple([uid,uid,uid]),groups:z.array(uid).max(16),
 capabilities:z.object({CapInh:capValue,CapPrm:capValue,CapEff:capValue,CapBnd:capValue,CapAmb:capValue}).strict(),noNewPrivileges:z.boolean(),
 executable:path,exeSha256:digest,argv:z.array(z.string().max(1024)).max(8),cwd:path,environment:z.record(z.string(),z.string().max(2048)),
 fds:z.array(nativeFd).length(7),listeners:z.array(listener).length(3),bootstrapHex:z.string().regex(/^[a-f0-9]{464}$/)}).strict();
const nativeDiagnostic=z.object({schema:z.literal('osv-mcp.q2b.native-launch-diagnostic.v1'),mode:z.literal('native-observed'),scope:z.literal('launch-binding-only'),
 runId:id,caseId:id,manifestDigest:digest,launchDigest:digest,phases:z.array(nativePhase).length(3),
 execs:z.array(z.object({sequence:uint.min(1).max(2),phase:z.enum(['launcher','provider']),pid:uint.positive(),path,sha256:digest}).strict()).length(2),
 artifacts:z.array(z.object({path,sha256:digest,byteLength:uint.max(16*1024*1024),ownerUid:z.literal(0),mode:uint.max(511),nlink:z.literal(1)}).strict()).min(8).max(128)}).strict();
export function verifyB1cNativeLaunchBinding(input:{manifest:Buffer;expectedManifestDigest:string;launch:Buffer;diagnostic:Buffer;
 manager:B1aSignerPin;controller:B1aSignerPin;runId:string;caseId:string}){
 return guarded(()=>{
  const m=decode(input.manifest,nativeManifestSchema);check(ownedSha256(input.manifest)===input.expectedManifestDigest,'manifest_pin_mismatch');
  check(input.manager.publicKey?.asymmetricKeyType==='ed25519'&&input.controller.publicKey?.asymmetricKeyType==='ed25519'&&
   !input.manager.publicKey.export({type:'spki',format:'der'}).equals(input.controller.publicKey.export({type:'spki',format:'der'})),'issuer_invalid');
  const launch=authenticated(input.launch,'manager',input.manager,launchSchema),d=authenticated(input.diagnostic,'controller',input.controller,nativeDiagnostic);
  const launchDigest=ownedSha256(input.launch),expected={runId:input.runId,caseId:input.caseId,launchDigest,status:'accepted' as const,stage:'provider' as const,reason:'preflight-accepted' as const};
  verifyLaunch(m,launch,expected,input.expectedManifestDigest);
  check(d.runId===input.runId&&d.caseId===input.caseId&&d.manifestDigest===input.expectedManifestDigest&&d.launchDigest===launchDigest,'binding_mismatch');
  unique(m.artifacts.map(a=>a.path),'closure_invalid');unique(d.artifacts.map(a=>a.path),'closure_invalid');
  check(m.artifacts.length===d.artifacts.length&&m.artifacts.reduce((n,a)=>n+a.byteLength,0)<=64*1024*1024,'closure_invalid');
  for(const role of artifactRoles)check(m.artifacts.filter(a=>a.role===role).length===1,'closure_invalid');
  const image='/opt/osv-q2b/b1ct',byRole=(role:typeof artifactRoles[number])=>m.artifacts.find(a=>a.role===role)!;
  for(const a of m.artifacts){const observed=d.artifacts.find(x=>x.path===a.path);check(a.path.startsWith(image+'/')&&observed&&observed.sha256===a.sha256&&observed.byteLength===a.byteLength&&!(observed.mode&0o022),'closure_invalid');}
  check(byRole('launcher').path===image+'/launcher'&&byRole('runtime').path===image+'/runtime'&&byRole('entrypoint').path===image+'/provider.py'&&byRole('crypto').path===image+'/auth.py'&&
   m.artifacts.some(a=>a.path===image+'/manager.pub'&&a.sha256===ownedSha256(input.manager.publicKey.export({type:'spki',format:'der'}))),'closure_invalid');
  check(m.execution.launcher===byRole('launcher').path&&m.execution.runtime===byRole('runtime').path&&m.execution.entrypoint===byRole('entrypoint').path&&m.execution.cwd===image&&
   same(m.execution.launcherArgv,[m.execution.launcher,'--profile','b1ct','--instance','b1ct'])&&same(m.execution.runtimeArgv,[m.execution.runtime,'-I',m.execution.entrypoint])&&
   m.execution.credentialDirectory==='/run/credentials/osv-q2b-b1ct.service','execution_invalid');
  unique(roles.map(r=>m.principals[r].uid),'principal_invalid');unique(roles.map(r=>m.principals[r].gid),'principal_invalid');
  check(roles.every(r=>m.principals[r].supplementaryGroups.length===0)&&m.platform.os==='linux'&&m.platform.filesystem==='tmpfs'&&m.platform.mountOptions.includes('nodev')&&m.platform.mountOptions.includes('nosuid'),'configuration_invalid');
  unique(m.roots.map(r=>r.role),'roots_invalid');const providerRoot=m.roots.find(r=>r.role==='provider')!;
  unique(m.roots.map(r=>r.device+':'+r.inode),'roots_invalid');unique(m.platform.mountOptions,'configuration_invalid');
  for(const root of m.roots){const owner=root.role==='evidence'?0:m.principals[root.role].uid;check(root.path==='/var/lib/osv-q2b/'+root.role+'/b1ct'&&root.ownerUid===owner&&same(root.writers,[owner]),'roots_invalid');}
  unique(m.endpoints.map(e=>e.role),'endpoint_invalid');
  for(const endpoint of m.endpoints){const actor=endpoint.role==='reader'?'reader':endpoint.role==='upload'?'build':'writer';
   check(endpoint.path==='/run/osv-q2b/b1ct/'+endpoint.role+'.sock'&&endpoint.groupGid===m.principals[actor].gid&&endpoint.fileDescriptorName===endpoint.role&&
    endpoint.unitPath===byRole((endpoint.role+'-unit') as typeof artifactRoles[number]).path,'endpoint_invalid');}
  for(const [i,o]of d.phases.entries()){
   const phaseName=(['manager','launcher','provider'] as const)[i]!;check(o.phase===phaseName&&o.pid===launch.pid&&o.groups.length===0&&o.noNewPrivileges,'principal_invalid');
   const expectedUid=i===0?0:m.principals.provider.uid,expectedGid=i===0?0:m.principals.provider.gid;
   check(same(o.uid,[expectedUid,expectedUid,expectedUid])&&same(o.gid,[expectedGid,expectedGid,expectedGid]),'principal_invalid');
   check(Object.values(o.capabilities).every(value=>value===(i===0?'00000000000001c0':'0000000000000000')),'principal_invalid');
   const exe=i===2?byRole('runtime'):byRole('launcher');check(o.executable===exe.path&&o.exeSha256===exe.sha256&&o.cwd===image&&same(o.argv,i===2?m.execution.runtimeArgv:m.execution.launcherArgv),'execution_invalid');
   const env={LANG:'C',LC_ALL:'C',CREDENTIALS_DIRECTORY:m.execution.credentialDirectory,LISTEN_PID:String(launch.pid),LISTEN_FDS:'3',LISTEN_FDNAMES:'reader:upload:publish'};
   // The manager has already normalized actual FDs, while LISTEN_FDNAMES still
   // describes systemd's input order. Its next exec receives the fixed order.
   const names=o.environment.LISTEN_FDNAMES?.split(':');
   check(i===0?same(names?.slice().sort(),['publish','reader','upload']):o.environment.LISTEN_FDNAMES===env.LISTEN_FDNAMES,'execution_invalid');
   check(Object.entries(env).every(([key,value])=>key==='LISTEN_FDNAMES'||o.environment[key]===value)&&Object.keys(o.environment).every(key=>Object.hasOwn(env,key)||i===0&&['INVOCATION_ID','JOURNAL_STREAM','SYSTEMD_EXEC_PID'].includes(key)),'execution_invalid');
   check(same(o.listeners,launch.listeners),'fd_invalid');unique(o.fds.map(f=>f.fd),'fd_invalid');
   for(let number=0;number<7;number++){const fd=o.fds.find(f=>f.fd===number);check(fd&&fd.kind===(number===0?'null':number<3?'journal':number<6?'listener':'bootstrap'),'fd_invalid');
    check(fd.ownerUid===0&&fd.ownerGid===0,'fd_invalid');
    if(number>=3&&number<6)check(fd.inode===launch.listeners.find(l=>l.fd===number)!.descriptorInode,'fd_invalid');
    if(number===6)check(fd.ownerUid===0&&fd.ownerGid===0&&fd.mode===0o400&&(fd.flags&3)===0&&!(fd.flags&0x200000)&&fd.seals===15,'fd_invalid');}
   const boot=Buffer.from(o.bootstrapHex,'hex');check(i===0||o.bootstrapHex===d.phases[0]!.bootstrapHex,'bootstrap_binding');
   check(boot.readBigUInt64LE(0)===0x514232424f4f5431n&&boot.readBigUInt64LE(8)===BigInt(launch.pid)&&boot.readBigUInt64LE(16)===BigInt(m.principals.provider.uid)&&boot.readBigUInt64LE(24)===BigInt(m.principals.provider.gid),'bootstrap_binding');
   for(const l of launch.listeners)check(boot.readBigUInt64LE(32+8*(l.fd-3))===BigInt(l.cookie),'bootstrap_binding');
   check(boot.subarray(56,88).toString('hex')===launch.providerBoot&&launch.providerBoot===launch.socketGeneration&&boot.readBigUInt64LE(88)===BigInt(providerRoot.device)&&boot.readBigUInt64LE(96)===BigInt(providerRoot.inode)&&
    boot.subarray(104,136).toString('hex')===byRole('runtime').sha256&&boot.subarray(136,168).toString('hex')===byRole('entrypoint').sha256&&boot.subarray(168,200).toString('hex')===input.expectedManifestDigest&&boot.subarray(200).toString('hex')===launchDigest,'bootstrap_binding');
  }
  for(const [i,e]of d.execs.entries()){const artifact=byRole(i===0?'launcher':'runtime');check(e.sequence===i+1&&e.phase===(i===0?'launcher':'provider')&&e.pid===launch.pid&&e.path===artifact.path&&e.sha256===artifact.sha256,'event_invalid');}
  return Object.freeze({runId:input.runId,caseId:input.caseId,nativeLaunchBindingVerified:true as const,artifactHashesControllerAttested:true as const,
   artifactBytesLocallyReverified:false as const,launcherExecCount:1 as const,runtimeExecCount:1 as const,nativeIsolationVerified:false as const,profileApproved:false as const,backendEligible:false as const,originalReadsSkipped:0 as const});
 });
}
