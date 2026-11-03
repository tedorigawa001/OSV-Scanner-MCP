import { generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalOwnedJson, ownedSha256 } from '../../utils/gradleOwnedJson.js';
import { verifyDeploymentManifest, verifyB1aDiagnostic, verifyB1aSuite } from '../fixtures/gradleOwnedDeployment.js';

const bytes = (value: unknown) => Buffer.from(canonicalOwnedJson(value));
const h = ownedSha256;
function fixture() {
  const image = '/opt/osv-q2b/image';
  const roles = ['launcher', 'runtime', 'entrypoint', 'crypto', 'service-unit', 'reader-unit', 'upload-unit', 'publish-unit'];
  const artifacts = roles.map(role => ({ path: image + '/' + role, bytes: Buffer.from('synthetic-' + role) }));
  const principals = Object.fromEntries(['provider', 'reader', 'build', 'writer', 'checkpoint', 'registry'].map((role, i) => [role, { uid: 1101 + i, gid: 1201 + i, supplementaryGroups: [] }]));
  const manifest = {
    schema: 'osv-mcp.q2b.deployment.v1', scope: 'b1a-static-only', profileId: 'profile', instanceId: 'instance', imageId: 'image',
    platform: { os: 'linux', kernel: 'fixture-kernel', distribution: 'fixture-linux', systemd: 'fixture-systemd', filesystem: 'ext4', mountOptions: ['nodev', 'nosuid'], runtimeVersion: 'fixture-python' },
    policyDigest: h('policy'), managerUid: 0, controllerUid: 0, principals,
    artifacts: artifacts.map((a, i) => ({ role: roles[i], path: a.path, sha256: h(a.bytes), byteLength: a.bytes.length, ownerUid: 0, writers: [0], kind: 'regular', nlink: 1 })),
    execution: { launcher: image + '/launcher', runtime: image + '/runtime', entrypoint: image + '/entrypoint', cwd: image,
      launcherArgv: [image + '/launcher', '--profile', 'profile', '--instance', 'instance'], runtimeArgv: [image + '/runtime', '-I', image + '/entrypoint'],
      credentialDirectory: '/run/credentials/osv-q2b-instance.service', shell: false, inheritEnvironment: false, dynamicFdStore: false },
    roots: ['provider', 'checkpoint', 'registry', 'evidence'].map((role, i) => ({ role, path: '/var/lib/osv-q2b/' + role + '/instance', ownerUid: role === 'evidence' ? 0 : (principals as any)[role].uid, kind:'directory', mode: 448, ancestorWriters: [0], writers: [role === 'evidence' ? 0 : (principals as any)[role].uid], device: '1', inode: String(10 + i), newPrivate: true })),
    endpoints: ['reader', 'upload', 'publish'].map((role, i) => ({ role, path: '/run/osv-q2b/instance/' + role + '.sock', unitPath: image + '/' + role + '-unit', groupGid: 1202 + i, ownerUid: 0, mode: 432, directoryWriters: [0], accept: false, passCredentials: true })),
    limits: { frameBytes: 4096, connectionMs: 2000, pending: 64, requests: 2 },
    providerMayBind: false, coordinatedRestart: true,
  };
  return { manifest: manifest as any, artifacts };
}
function verify(f = fixture()) { const manifest = bytes(f.manifest); return verifyDeploymentManifest({ manifest, expectedDigest: h(manifest), artifacts: f.artifacts }); }
it('verifies a closed, independently pinned synthetic deployment without granting native adoption', () => {
  expect(verify()).toMatchObject({ schemaVerified: true, nativeIsolationVerified: false, backendEligible: false });
});

const invalidManifests: [string, (m: any) => void][] = [
  ['unknown field', m => m.adopt = true],
  ['wrong scope', m => m.scope = 'native'],
  ['same principal', m => m.principals.reader.uid = m.principals.provider.uid],
  ['supplementary group', m => m.principals.build.supplementaryGroups = [0]],
  ['overflow principal', m => m.principals.provider.uid = 65534],
  ['shared gid', m => m.principals.reader.gid = m.principals.provider.gid],
  ['missing artifact role', m => m.artifacts[0].role = 'dependency'],
  ['writable executable', m => m.artifacts[0].writers = [1101]],
  ['symlink executable', m => m.artifacts[0].kind = 'symlink'],
  ['path traversal', m => m.artifacts[0].path += '/../escape'],
  ['runtime switch', m => m.execution.runtimeArgv.splice(1, 0, '-c')],
  ['shell', m => m.execution.shell = true],
  ['environment inheritance', m => m.execution.inheritEnvironment = true],
  ['wrong credential path', m => m.execution.credentialDirectory = '/tmp/keys'],
  ['shared root identity', m => m.roots[1].inode = m.roots[0].inode],
  ['wrong checkpoint owner', m => m.roots[1].ownerUid = 1101],
  ['provider endpoint directory write', m => m.endpoints[0].directoryWriters.push(1101)],
  ['passcred disabled', m => m.endpoints[0].passCredentials = false],
  ['Accept=yes', m => m.endpoints[0].accept = true],
  ['wrong endpoint group', m => m.endpoints[0].groupGid = 1201],
  ['provider bind fallback', m => m.providerMayBind = true],
  ['uncoordinated restart', m => m.coordinatedRestart = false],
  ['excess frame budget', m => m.limits.frameBytes = 4097],
];
it.each(invalidManifests)('rejects deployment inconsistency even with a recomputed manifest pin: %s', (_name, change) => {
  const f = fixture(); change(f.manifest); expect(() => verify(f)).toThrow(/q2b_/);
});
it('rejects missing, duplicate, unknown, changed and oversize artifact bytes', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.artifacts.pop(); },
    (f: ReturnType<typeof fixture>) => { f.artifacts[1] = f.artifacts[0]!; },
    (f: ReturnType<typeof fixture>) => { f.artifacts[0]!.path = '/tmp/extra'; },
    (f: ReturnType<typeof fixture>) => { f.artifacts[0]!.bytes = Buffer.from('changed'); },
    (f: ReturnType<typeof fixture>) => { f.artifacts[0]!.bytes = Buffer.alloc(4 * 1024 * 1024 + 1); },
  ]) { const f = fixture(); change(f); expect(() => verify(f)).toThrow(/q2b_/); }
});
it('rejects pin mismatch, duplicate JSON keys, noncanonical JSON and an oversized document', () => {
  const f = fixture(), b = bytes(f.manifest);
  for (const value of [Buffer.from(b.toString().replace('{', '{"schema":"duplicate",')), Buffer.from(' '+b), Buffer.alloc(256 * 1024 + 1)]) {
    expect(() => verifyDeploymentManifest({ manifest: value, expectedDigest: h(value), artifacts: f.artifacts })).toThrow(/q2b_/);
  }
  expect(() => verifyDeploymentManifest({ manifest: b, expectedDigest: h('other'), artifacts: f.artifacts })).toThrow('manifest_pin_mismatch');
});

const manager = { keyId: 'manager-key', ...generateKeyPairSync('ed25519') };
const controller = { keyId: 'controller-key', ...generateKeyPairSync('ed25519') };
function signed(body: unknown, role: 'manager' | 'controller', key = role === 'manager' ? manager : controller) {
  const unsigned = { schema: 'osv-mcp.q2b.evidence.v1', role, keyId: key.keyId, body };
  return bytes({ ...unsigned, signature: sign(null, bytes(unsigned), key.privateKey).toString('base64') });
}
function runFixture() {
  const f = fixture(), m = f.manifest, manifest = verify(f);
  const launch = { schema: 'osv-mcp.q2b.launch.v1', manifestDigest: manifest.manifestDigest, runId: 'run', caseId: 'honest', pid: 700,
    socketGeneration: 'sockets-1', providerBoot: 'boot-1', bootstrapFd: 6,
    listeners: m.endpoints.map((e: any, i: number) => ({ fd: 3 + i, role: e.role, path: e.path, cookie: String(100 + i), custodianUid: 0, custodianGid: 0, ownerUid: 0, ownerGid: e.groupGid, mode: 432, directoryWriters: [0],
      domain: 'AF_UNIX', type: 'SOCK_STREAM', listening: true, passCredentials: true, pathnameDevice: '1', pathnameInode: String(20+i), descriptorInode: String(1000+i) })) };
  const launchBytes = signed(launch, 'manager');
  const observation = { rootState:structuredClone(m.roots), platform:structuredClone(m.platform), principalState:Object.entries(m.principals).map(([role,p]:[string,any])=>({role,...p,uid:[p.uid,p.uid,p.uid],gid:[p.gid,p.gid,p.gid],capabilities:[],adminRoutes:[],noNewPrivileges:true})), pid: 700, manifestDigest: manifest.manifestDigest, imageId: m.imageId,
    closureDigest: h(canonicalOwnedJson(m.artifacts)),
    identity: { uid: [1101, 1101, 1101], gid: [1201, 1201, 1201], supplementaryGroups: [], capabilities: [], adminRoutes: [], noNewPrivileges: true },
    launcherArgv: m.execution.launcherArgv, runtimeArgv: m.execution.runtimeArgv, cwd: m.execution.cwd,
    environment: [{name:'LANG',value:'C'},{name:'LC_ALL',value:'C'},{name:'CREDENTIALS_DIRECTORY',value:m.execution.credentialDirectory},{name:'LISTEN_PID',value:'700'},{name:'LISTEN_FDS',value:'3'},{name:'LISTEN_FDNAMES',value:'reader:upload:publish'}],
    fds: [{ fd: 0, kind: 'stdio', target: 'null' }, { fd: 1, kind: 'stdio', target: 'controller-log' }, { fd: 2, kind: 'stdio', target: 'controller-log' },
      ...launch.listeners.map((x: any) => ({ ...x, kind:'listener', socketGeneration: launch.socketGeneration })),
      {fd:6,kind:'bootstrap',ownerUid:0,readOnly:true,launchDigest:h(launchBytes)}],
  };
  const events = [
    ['manager','gate-begin'],['manager','gate-pass'],['launcher','exec'],['launcher','gate-begin'],['launcher','gate-pass'],
    ['provider','exec'],['provider','gate-begin'],['provider','gate-pass'],
  ].map(([stage, kind], i) => ({ seq:i+1, stage, kind, pid:700, uid:stage==='manager'?0:1101 }));
  const diagnostic = { schema:'osv-mcp.q2b.diagnostic.v1', mode:'synthetic-static', runId:'run',caseId:'honest',manifestDigest:manifest.manifestDigest,launchDigest:h(launchBytes),
    observations: ['manager','launcher','provider'].map(phase => ({phase, ...structuredClone(observation)})), events,
    claimed: {status:'accepted',stage:'provider',reason:'preflight-accepted'},
  };
  const expectation = {runId:'run',caseId:'honest',launchDigest:h(launchBytes),status:'accepted',stage:'provider',reason:'preflight-accepted'};
  return {f,manifest,launch,launchBytes,diagnostic:diagnostic as any,expectation:expectation as any};
}
function verifyRun(f = runFixture()) { return verifyB1aDiagnostic({manifest:f.manifest,launch:f.launchBytes,diagnostic:signed(f.diagnostic,'controller'),manager,controller,expectation:f.expectation}); }
it('binds manager launch inventory and controller observations to the independent manifest and case expectation', () => {
  expect(verifyRun()).toMatchObject({status:'accepted',staticContractVerified:true,launcherExecCount:1,runtimeExecCount:1,
    nativeIsolationVerified:false,profileApproved:false,backendEligible:false,originalReadsSkipped:0});
});

function rejection(phase: 'manager'|'launcher'|'provider', mutate: (o: any) => void, reason: string) {
  const f = runFixture(), index = ['manager','launcher','provider'].indexOf(phase);
  f.diagnostic.observations = f.diagnostic.observations.slice(0,index+1);
  mutate(f.diagnostic.observations[index]);
  f.diagnostic.events = f.diagnostic.events.slice(0, index===0?2:index===1?5:8);
  f.diagnostic.events.at(-1).kind = 'gate-reject';
  f.diagnostic.claimed = {status:'rejected',stage:phase,reason};
  Object.assign(f.expectation,f.diagnostic.claimed);
  return f;
}
it.each(['manager','launcher','provider'] as const)('derives rejection and exec counts from the %s gate transcript', phase => {
  const f = rejection(phase,o=>o.identity.capabilities=['CAP_SYS_ADMIN'],'principal_invalid');
  expect(verifyRun(f)).toMatchObject({status:'rejected',stage:phase,launcherExecCount:phase==='manager'?0:1,runtimeExecCount:phase==='provider'?1:0,secretReads:0});
});
it.each(['NODE_OPTIONS','NODE_PATH','PYTHONPATH','PYTHONHOME','LD_PRELOAD','LD_LIBRARY_PATH','PATH','HOME'])('rejects %s before launcher/runtime exec', name => {
  const f = rejection('manager', o=>o.environment.push({name,value:'injected'}),'execution_invalid');
  expect(verifyRun(f)).toMatchObject({status:'rejected',runtimeExecCount:0,launcherExecCount:0,injectedCodeExecutions:0});
});
it.each([
  ['extra argv', (o:any): void => { o.runtimeArgv.push('--require=bad'); }],
  ['launcher argv', (o:any): void => { o.launcherArgv.push('-c'); }],
  ['duplicate env', (o:any): void => { o.environment.push(o.environment[0]); }],
  ['wrong LISTEN_PID', (o:any): void => { o.environment.find((e:any)=>e.name==='LISTEN_PID').value='701'; }],
  ['missing env', (o:any): void => { o.environment.pop(); }],
  ['wrong cwd', (o:any): void => { o.cwd='/tmp/project'; }],
] as const)('refuses %s as an execution configuration', (_name, change) => {
  expect(verifyRun(rejection('manager',change,'execution_invalid')).status).toBe('rejected');
});
it.each([
  ['missing', (o:any): void => { o.fds.splice(3,1); }],
  ['extra', (o:any): void => { o.fds.push({fd:9,kind:'unexpected',description:'write-fd'}); }],
  ['duplicate', (o:any): void => { o.fds.push(o.fds[3]); }],
  ['cookie', (o:any): void => { o.fds[3].cookie='999'; }],
  ['path', (o:any): void => { o.fds[3].path='/tmp/other.sock'; }],
  ['role', (o:any): void => { o.fds[3].role='publish'; }],
  ['domain', (o:any): void => { o.fds[3].domain='AF_INET'; }],
  ['nonlistener', (o:any): void => { o.fds[3].listening=false; }],
  ['PassCredentials', (o:any): void => { o.fds[3].passCredentials=false; }],
  ['custodian', (o:any): void => { o.fds[3].custodianUid=1101; }],
  ['directory writers', (o:any): void => { o.fds[3].directoryWriters.push(1101); }],
  ['bootstrap write', (o:any): void => { o.fds[6].readOnly=false; }],
  ['bootstrap digest', (o:any): void => { o.fds[6].launchDigest=h('other'); }],
  ['socket generation', (o:any): void => { o.fds[3].socketGeneration='old'; }],
] as const)('rejects inherited FD mismatch: %s before accepting or reading secrets', (_name, change) => {
  expect(verifyRun(rejection('provider',change,'fd_invalid'))).toMatchObject({status:'rejected',stage:'provider',secretReads:0,canonicalContentReads:0});
});
it.each([
  ['saved uid', (o:any): void => { o.identity.uid[2]=0; }],
  ['real gid', (o:any): void => { o.identity.gid[0]=0; }],
  ['supplementary group', (o:any): void => { o.identity.supplementaryGroups=[0]; }],
  ['admin route', (o:any): void => { o.identity.adminRoutes=['docker-socket']; }],
  ['no new privileges', (o:any): void => { o.identity.noNewPrivileges=false; }],
] as const)('rejects unsafe preflight identity: %s', (_name, change) => {
  expect(verifyRun(rejection('manager',change,'principal_invalid')).status).toBe('rejected');
});
it('does not trust a forged manifest handle or caller mutation of the original manifest and artifact objects', () => {
  const f = runFixture();
  expect(()=>verifyRun({...f,manifest:{...f.manifest}})).toThrow('manifest_handle_invalid');
  f.f.manifest.principals.provider.uid=0;
  f.f.artifacts[0]!.bytes.fill(0);
  expect(verifyRun(f).status).toBe('accepted');
});
it('allows descriptor/list order permutation without confusing roles and distinguishes pathname versus descriptor inodes', () => {
  const f=runFixture();
  for(const o of f.diagnostic.observations) {o.fds.reverse();o.environment.reverse();}
  expect(verifyRun(f).status).toBe('accepted');
});
it.each([
  ['missing begin', (d:any): void => { d.events.splice(0,1); }],
  ['missing gate', (d:any): void => { d.events.splice(1,1); }],
  ['missing exec', (d:any): void => { d.events.splice(5,1); }],
  ['event reorder', (d:any): void => { d.events.reverse(); }],
  ['unobserved phase', (d:any): void => { d.observations.splice(1,1); }],
  ['secret read', (d:any): void => { d.events[6].kind='secret-read'; }],
  ['canonical read', (d:any): void => { d.events[6].kind='canonical-read'; }],
  ['accept', (d:any): void => { d.events[6].kind='accept'; }],
  ['injected code', (d:any): void => { d.events[6].kind='injection-exec'; }],
  ['wrong event actor', (d:any): void => { d.events[0].uid=1101; }],
  ['wrong event pid', (d:any): void => { d.events[0].pid=701; }],
  ['claimed count', (d:any): void => { d.verifiedCases=999; }],
  ['native flag', (d:any): void => { d.backendEligible=true; }],
] as const)('rejects re-signed but incomplete or inconsistent controller evidence: %s', (_name, change) => {
  const f=runFixture();change(f.diagnostic);expect(()=>verifyRun(f)).toThrow(/q2b_/);
});
it('rejects execution moved after a manager gate failure and a rejected case relabeled as accepted',()=>{
  const f=rejection('manager',o=>o.environment.push({name:'NODE_OPTIONS',value:'--require=bad'}),'execution_invalid');
  f.diagnostic.events.push({seq:3,stage:'provider',kind:'exec',pid:700,uid:1101});
  expect(()=>verifyRun(f)).toThrow('event_invalid');
  const g=rejection('manager',o=>o.identity.adminRoutes=['sudo'],'principal_invalid');
  g.diagnostic.claimed={status:'accepted',stage:'provider',reason:'preflight-accepted'};
  expect(()=>verifyRun(g)).toThrow('case_expectation_mismatch');
});
it('rejects an accepted case when the independent case expectation requires rejection',()=>{
  const f=runFixture();f.expectation.status='rejected';expect(()=>verifyRun(f)).toThrow('case_expectation_mismatch');
});
it('rejects altered signatures, issuer-role substitution, stale run binding, and a diagnostic signed by the manager',()=>{
  const f=runFixture();
  const input={manifest:f.manifest,launch:f.launchBytes,diagnostic:signed(f.diagnostic,'controller'),manager,controller,expectation:f.expectation};
  const raw=JSON.parse(input.diagnostic.toString());raw.body.caseId='other';
  expect(()=>verifyB1aDiagnostic({...input,diagnostic:bytes(raw)})).toThrow('signature_invalid');
  expect(()=>verifyB1aDiagnostic({...input,diagnostic:signed(f.diagnostic,'manager')})).toThrow('issuer_invalid');
  expect(()=>verifyB1aDiagnostic({...input,diagnostic:signed(f.diagnostic,'controller',manager)})).toThrow('issuer_invalid');
  f.diagnostic.runId='old';expect(()=>verifyRun(f)).toThrow('binding_mismatch');
});
it('rejects a separately re-signed launch inventory with changed cookies unless its independent pin and observations agree',()=>{
  const f=runFixture();f.launch.listeners[0].cookie='999';f.launchBytes=signed(f.launch,'manager');
  expect(()=>verifyRun(f)).toThrow('launch_pin_mismatch');
  f.expectation.launchDigest=h(f.launchBytes);f.diagnostic.launchDigest=h(f.launchBytes);
  expect(()=>verifyRun(f)).toThrow(/event_invalid|case_expectation_mismatch/);
});

it('rejects observed root custody drift instead of trusting only the pinned manifest',()=>{
  const f=rejection('manager',o=>{o.rootState=structuredClone(fixture().manifest.roots);o.rootState[0].ownerUid=1102;},'roots_invalid');
  expect(verifyRun(f)).toMatchObject({status:'rejected',reason:'roots_invalid',runtimeExecCount:0});
});

function suiteFixture() {
  const accepted=runFixture(), rejected=rejection('manager',o=>o.environment.push({name:'NODE_OPTIONS',value:'bad'}),'execution_invalid');
  rejected.launch.caseId='denied';rejected.launchBytes=signed(rejected.launch,'manager');
  rejected.expectation.caseId='denied';rejected.expectation.launchDigest=h(rejected.launchBytes);
  rejected.diagnostic.caseId='denied';rejected.diagnostic.launchDigest=h(rejected.launchBytes);
  const o=rejected.diagnostic.observations[0];o.fds.find((x:any)=>x.kind==='bootstrap').launchDigest=h(rejected.launchBytes);
  return {manifest:accepted.manifest,manager,controller,runId:'run',expectations:[accepted.expectation,rejected.expectation],
    records:[accepted,rejected].map(f=>({caseId:f.expectation.caseId,launch:f.launchBytes,diagnostic:signed(f.diagnostic,'controller')}))};
}
it('requires the complete independent case plan and derives suite totals only from verified records',()=>{
  expect(verifyB1aSuite(suiteFixture())).toMatchObject({verifiedCases:2,acceptedCases:1,rejectedCases:1,nativeIsolationVerified:false,backendEligible:false});
});

it.each([
  ['missing record', (s:any):void=>{s.records.pop();}],
  ['duplicate record', (s:any):void=>{s.records[1]=s.records[0];}],
  ['unknown record', (s:any):void=>{s.records[1].caseId='unknown';}],
  ['missing plan', (s:any):void=>{s.expectations.pop();}],
  ['duplicate plan', (s:any):void=>{s.expectations[1]=s.expectations[0];}],
  ['different run', (s:any):void=>{s.expectations[1].runId='old';}],
  ['empty suite', (s:any):void=>{s.expectations=[];s.records=[];}],
  ['excess cases', (s:any):void=>{s.expectations=Array(129).fill(s.expectations[0]);}],
  ['excess bytes', (s:any):void=>{s.records[0].diagnostic=Buffer.alloc(256*1024+1);}],
] as const)('rejects incomplete or unbounded suite evidence: %s',(_name,change)=>{
  const s=suiteFixture();change(s);expect(()=>verifyB1aSuite(s)).toThrow(/q2b_/);
});
it('derives the same suite result regardless of record arrival order',()=>{
  const s=suiteFixture(),first=verifyB1aSuite(s);s.records.reverse();s.expectations.reverse();
  expect(verifyB1aSuite(s)).toEqual(first);
});
it.each([
  ['root mode',(o:any):void=>{o.rootState[0].mode=511;}],
  ['root ancestor write',(o:any):void=>{o.rootState[0].ancestorWriters.push(1102);} ],
  ['symlink root',(o:any):void=>{o.rootState[0].kind='symlink';}],
  ['root inode',(o:any):void=>{o.rootState[0].inode='999';}],
  ['unknown root history',(o:any):void=>{o.rootState[0].newPrivate=false;}],
] as const)('rejects root preflight drift: %s',(_name,change)=>{
  expect(verifyRun(rejection('manager',change,'roots_invalid')).reason).toBe('roots_invalid');
});
it.each([
  ['build elevated',(o:any):void=>{o.principalState.find((p:any)=>p.role==='build').capabilities=['CAP_SYS_PTRACE'];}],
  ['reader admin',(o:any):void=>{o.principalState.find((p:any)=>p.role==='reader').adminRoutes=['sudo'];}],
  ['principal alias',(o:any):void=>{o.principalState[1].uid=o.principalState[0].uid;}],
  ['principal omitted',(o:any):void=>{o.principalState[1]=o.principalState[0];}],
] as const)('rejects observed principal inventory: %s',(_name,change)=>{
  expect(verifyRun(rejection('manager',change,'principal_invalid')).reason).toBe('principal_invalid');
});
it.each([
  ['pid',(o:any):void=>{o.pid=701;}],
  ['image',(o:any):void=>{o.imageId='other';}],
  ['runtime version',(o:any):void=>{o.platform.runtimeVersion='other';}],
  ['closure',(o:any):void=>{o.closureDigest=h('other');}],
] as const)('binds the diagnostic to the pinned execution context: %s',(_name,change)=>{
  expect(verifyRun(rejection('manager',change,'binding_mismatch')).reason).toBe('binding_mismatch');
});
it('accepts legitimate kernel/version strings while keeping them exact in the independent pin',()=>{
  const f=fixture();f.manifest.platform.kernel='6.8.0-1050-azure+';f.manifest.platform.distribution='Ubuntu 24.04 LTS';expect(verify(f).schemaVerified).toBe(true);
});
it.each([
  ['duplicate cookie',(l:any):void=>{l.listeners[1].cookie=l.listeners[0].cookie;}],
  ['duplicate role',(l:any):void=>{l.listeners[1].role=l.listeners[0].role;}],
  ['PassCredentials off',(l:any):void=>{l.listeners[0].passCredentials=false;}],
  ['wrong custodian',(l:any):void=>{l.listeners[0].custodianUid=1101;}],
  ['wrong socket type',(l:any):void=>{l.listeners[0].type='SOCK_DGRAM';}],
  ['connected socket',(l:any):void=>{l.listeners[0].listening=false;}],
  ['cookie outside uint64',(l:any):void=>{l.listeners[0].cookie='18446744073709551616';}],
] as const)('rejects invalid manager inventory even if re-signed and its independent digest is updated: %s',(_name,change)=>{
  const f=runFixture();change(f.launch);f.launchBytes=signed(f.launch,'manager');f.expectation.launchDigest=h(f.launchBytes);
  expect(()=>verifyRun(f)).toThrow(/launch_invalid|schema_invalid/);
});
it('rejects observations relabeled as native or unsigned control evidence',()=>{
  const f=runFixture();f.diagnostic.mode='native';expect(()=>verifyRun(f)).toThrow('schema_invalid');
  const g=runFixture();const raw=bytes(g.diagnostic);
  expect(()=>verifyB1aDiagnostic({manifest:g.manifest,launch:g.launchBytes,diagnostic:raw,manager,controller,expectation:g.expectation})).toThrow('schema_invalid');
});

it('enforces aggregate artifact bytes even when every individual ref and digest is correct',()=>{
  const f=fixture();
  for(let i=0;i<f.artifacts.length;i++){
    const b=Buffer.alloc(3*1024*1024,i);f.artifacts[i]!.bytes=b;
    f.manifest.artifacts[i].byteLength=b.length;f.manifest.artifacts[i].sha256=h(b);
  }
  expect(()=>verify(f)).toThrow('budget_exceeded');
});
it('rejects same-key issuer roles, wrong-key signatures and private verification pins',()=>{
  const f=runFixture(),input={manifest:f.manifest,launch:f.launchBytes,diagnostic:signed(f.diagnostic,'controller'),manager,controller,expectation:f.expectation};
  expect(()=>verifyB1aDiagnostic({...input,controller:{keyId:controller.keyId,publicKey:manager.publicKey}})).toThrow('issuer_invalid');
  const other={...generateKeyPairSync('ed25519'),keyId:controller.keyId};
  expect(()=>verifyB1aDiagnostic({...input,diagnostic:signed(f.diagnostic,'controller',other)})).toThrow('signature_invalid');
  expect(()=>verifyB1aDiagnostic({...input,controller:{keyId:controller.keyId,publicKey:controller.privateKey}})).toThrow('issuer_invalid');
});
it('rejects duplicate keys, alternate encodings and nested unbounded evidence before authentication',()=>{
  const f=runFixture(),good=signed(f.diagnostic,'controller');
  for(const bad of [Buffer.from(' '+good),Buffer.from(good.toString().replace('{','{"role":"controller",')),Buffer.from('['.repeat(40)+'0'+']'.repeat(40))]){
    expect(()=>verifyB1aDiagnostic({manifest:f.manifest,launch:f.launchBytes,diagnostic:bad,manager,controller,expectation:f.expectation})).toThrow(/q2b_/);
  }
});

it('rejects a re-signed legacy launch that omits the listener owner GID',()=>{
  const f=runFixture();
  for(const listener of f.launch.listeners)delete (listener as any).ownerGid;
  f.launchBytes=signed(f.launch,'manager');f.expectation.launchDigest=h(f.launchBytes);f.diagnostic.launchDigest=h(f.launchBytes);
  for(const o of f.diagnostic.observations){
    for(const fd of o.fds)if(fd.kind==='listener')delete fd.ownerGid;
    o.fds.find((x:any)=>x.kind==='bootstrap').launchDigest=h(f.launchBytes);
  }
  expect(()=>verifyRun(f)).toThrow('schema_invalid');
});
it('rejects a freshly signed diagnostic with only scalar principal UID/GID values',()=>{
  const f=runFixture();
  for(const o of f.diagnostic.observations)for(const p of o.principalState){
    p.uid=Array.isArray(p.uid)?p.uid[0]:p.uid;p.gid=Array.isArray(p.gid)?p.gid[0]:p.gid;
  }
  expect(()=>verifyRun(f)).toThrow('schema_invalid');
});

function renewLaunch(f: ReturnType<typeof runFixture>) {
  const previousDigest=h(f.launchBytes);
  f.launch.socketGeneration+='-renewed';f.launch.providerBoot+='-renewed';
  f.launchBytes=signed(f.launch,'manager');
  expect(h(f.launchBytes)).not.toBe(previousDigest);
  f.expectation.launchDigest=h(f.launchBytes);f.diagnostic.launchDigest=h(f.launchBytes);
  for(const o of f.diagnostic.observations){
    for(const descriptor of o.fds){
      if(descriptor.kind==='listener')Object.assign(descriptor,f.launch.listeners.find((l:any)=>l.role===descriptor.role),{socketGeneration:f.launch.socketGeneration});
      if(descriptor.kind==='bootstrap')descriptor.launchDigest=h(f.launchBytes);
    }
  }
}
it.each(['reader','upload','publish'])('rejects a wrong %s socket owner GID even after manager/controller re-signing and all launch digest updates',role=>{
  const f=runFixture();f.launch.listeners.find((l:any)=>l.role===role)!.ownerGid=0;
  renewLaunch(f);
  expect(()=>verifyRun(f)).toThrow('launch_invalid');
});
it.each(['reader','upload','publish'])('checks the observed %s socket GID in every preflight phase',role=>{
  for(const phase of ['manager','launcher','provider'] as const){
    const f=rejection(phase,o=>o.fds.find((d:any)=>d.kind==='listener'&&d.role===role).ownerGid=0,'fd_invalid');
    expect(verifyRun(f)).toMatchObject({status:'rejected',stage:phase,reason:'fd_invalid',secretReads:0});
    const missing=runFixture();
    delete missing.diagnostic.observations.find((o:any)=>o.phase===phase).fds.find((d:any)=>d.kind==='listener'&&d.role===role).ownerGid;
    expect(()=>verifyRun(missing)).toThrow('schema_invalid');
  }
});
const principalRoles=['provider','reader','build','writer','checkpoint','registry'] as const;
const credentials=principalRoles.flatMap(role=>(['uid','gid'] as const).flatMap(kind=>([0,1,2] as const).map(slot=>({role,kind,slot,name:['real','effective','saved'][slot]}))));
it.each(credentials)('rejects $role $name $kind mismatch in each phase with a freshly signed controller record',({role,kind,slot})=>{
  for(const phase of ['manager','launcher','provider'] as const){
    const f=rejection(phase,o=>o.principalState.find((p:any)=>p.role===role)[kind][slot]=0,'principal_invalid');
    // Re-sign the launch and update every reference; valid authentication cannot repair a bad observation.
    renewLaunch(f);
    expect(verifyRun(f)).toMatchObject({status:'rejected',stage:phase,reason:'principal_invalid',canonicalContentReads:0});
  }
});
it.each(principalRoles.flatMap(role=>(['uid','gid'] as const).map(kind=>({role,kind}))))('requires the complete real/effective/saved $kind for $role, not scalar/short/missing evidence',({role,kind})=>{
  for(const phase of ['manager','launcher','provider'] as const){
    for(const omitted of ['field','scalar',0,1,2] as const){
      const f=runFixture(),p=f.diagnostic.observations.find((o:any)=>o.phase===phase).principalState.find((p:any)=>p.role===role);
      if(omitted==='field')delete p[kind];
      else if(omitted==='scalar')p[kind]=p[kind][0];
      else p[kind].splice(omitted,1);
      renewLaunch(f);
      expect(()=>verifyRun(f)).toThrow('schema_invalid');
    }
  }
});
it('does not equate socket owner GID with the root listener custodian GID',()=>{
  const f=runFixture();
  expect(f.launch.listeners.every((l:any)=>l.ownerGid!==l.custodianGid)).toBe(true);
  expect(verifyRun(f)).toMatchObject({status:'accepted',nativeIsolationVerified:false,backendEligible:false});
});
