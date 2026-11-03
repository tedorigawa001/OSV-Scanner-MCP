/** B1c collection verifier: VM startup/DAC observations only, never B1 adoption. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { canonicalOwnedJson, parseOwnedJson } from '../../utils/gradleOwnedJson.js';

const roles=['provider','reader','build','writer','checkpoint','registry'] as const;
const endpoints=['reader','upload','publish'] as const;
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const uint=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identity=z.object({pid:uint.min(2),uid:z.array(uint).length(4),gid:z.array(uint).length(4),groups:z.array(uint).max(16),
 capabilities:z.object({CapInh:z.literal('0000000000000000'),CapPrm:z.literal('0000000000000000'),
 CapEff:z.literal('0000000000000000'),CapBnd:z.literal('0000000000000000'),CapAmb:z.literal('0000000000000000')}).strict(),
 noNewPrivileges:z.literal(true),tracerPid:z.literal(0)}).strict();
const limitations=['authenticated transport','FD transfer protection','signed manager launch and bootstrap digest',
 'external exec phase trace','B1a evidence bridge','complete QB01-QB19/QB30-QB32','coordinated restart and leak drain',
 'B2/B3 persistence and pins','production adoption'];
const startup=z.object({schema:z.literal('osv-mcp.q2b.b1c.startup-observation.v1'),scope:z.literal('diagnostic-startup-only'),
 pid:uint.min(2),uid:z.tuple([z.literal(1101),z.literal(1101),z.literal(1101)]),
 gid:z.tuple([z.literal(1201),z.literal(1201),z.literal(1201)]),groups:z.array(uint).length(0),socketGeneration:hash,
 listeners:z.array(z.object({role:z.enum(endpoints),fd:uint, cookie:z.string().regex(/^[1-9][0-9]{0,19}$/).refine(v=>BigInt(v)<=18446744073709551615n),
 ownerUid:z.literal(0),ownerGid:uint,passCredentials:z.literal(true)}).strict()).length(3),
 bootstrapSeals:z.literal(15),bootstrapReadOnly:z.literal(true),noNewPrivileges:z.literal(true),capabilitiesEmpty:z.literal(true),
 accepts:z.literal(0),secretReads:z.literal(0),nativeIsolationVerified:z.literal(false),backendEligible:z.literal(false),
 profileApproved:z.literal(false),originalReadsSkipped:z.literal(0)}).strict();
const schema=z.object({payload:z.object({schema:z.literal('osv-mcp.q2b.b1c.controller-observation.v1'),
 observation:z.object({schema:z.literal('osv-mcp.q2b.b1c.vm-controls.v1'),scope:z.literal('vm-startup-and-dac-controls-only'),
 bundleDigest:hash,bootId:z.string().uuid(),kernel:z.string().min(1).max(128),pid1:z.literal('systemd'),systemd:z.string().startsWith('systemd 255 '),
 provider:identity,startup,bootstrapSha256:hash,
 cases:z.array(z.object({case:z.string().max(128),actor:z.enum(roles),identity,allowed:z.boolean(),verified:z.literal(true),errno:uint.max(4095)}).strict()).length(142),
 verifiedCases:z.literal(142),systemdBootVerified:z.literal(true),nativeIsolationVerified:z.literal(false),backendEligible:z.literal(false),
 profileApproved:z.literal(false),originalReadsSkipped:z.literal(0),notEstablished:z.array(z.string()).length(limitations.length)}).strict(),
 environment:z.object({imageUrl:z.literal('https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-arm64.img'),
 imageSha256:z.literal('6e971c7935c62c8ea7796b085e4ea038e2301a067f8c853e154133f8df192c85'),imageBytes:z.literal(224002048),
 qemu:z.string().startsWith('QEMU emulator version 7.2.'),outerKernel:z.string().min(1).max(128),
 guestNetwork:z.literal('restricted-user-network-hostfwd-loopback-ssh-only'),hostKeySha256:hash,acceleration:z.literal('tcg'),managerKeyProvisioned:z.literal(false)}).strict(),
 sources:z.array(z.object({path:z.string().regex(/^q2b(?:_b1c)?\/[a-z_]+\.(?:py|c)$/),sha256:hash}).strict()).length(8)}).strict(),
 publicKeyDer:z.string().max(128),publicKeySha256:hash,signature:z.string().max(128)}).strict();

export const vmCasePlan=Object.freeze(roles.flatMap(role=>[
 ...roles.flatMap(target=>['read','write-open'].map(operation=>({case:`${role}-${operation}-${target}`,actor:role,allowed:role===target}))),
 ...['new-sibling','unlink-listener','chmod-listener','replace-entry','replace-unit','evidence-read','provider-proc-fd','provider-proc-mem','provider-signal']
 .filter(operation=>!(role==='provider'&&['provider-proc-fd','provider-proc-mem'].includes(operation)))
 .map(operation=>({case:`${role}-${operation}`,actor:role,allowed:role==='provider'&&operation==='provider-signal'})),
 ...endpoints.map((target,i)=>({case:`${role}-connect-${target}`,actor:role,allowed:role===['reader','build','writer'][i]})),
]).map(item=>Object.freeze(item)));
function need(condition:unknown,reason:string):asserts condition {if(!condition)throw new Error('q2b_vm_'+reason);}
export function verifyVmControls(input:{record:Buffer;controllerKeyDigest:string;bundleDigest:string}) {
 need(Buffer.isBuffer(input.record)&&input.record.length<=512*1024,'budget');
 const r=schema.parse(parseOwnedJson(input.record.toString('utf8'),512*1024));
 const publicBytes=Buffer.from(r.publicKeyDer,'base64'),signature=Buffer.from(r.signature,'base64');
 need(publicBytes.toString('base64')===r.publicKeyDer&&signature.toString('base64')===r.signature&&signature.length===64,'encoding');
 need(createHash('sha256').update(publicBytes).digest('hex')===input.controllerKeyDigest&&r.publicKeySha256===input.controllerKeyDigest,'independent_key_pin');
 const key=createPublicKey({key:publicBytes,type:'spki',format:'der'});
 need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonicalOwnedJson(r.payload)),key,signature),'signature');
 const o=r.payload.observation;
 need(o.bundleDigest===input.bundleDigest,'independent_bundle_pin');
 need(o.kernel!==r.payload.environment.outerKernel,'distinct_guest_kernel');
 need(canonicalOwnedJson(o.notEstablished)===canonicalOwnedJson(limitations),'scope');
 need(o.provider.uid.every(v=>v===1101)&&o.provider.gid.every(v=>v===1201)&&o.provider.groups.length===0&&o.provider.pid===o.startup.pid,'provider');
 need(new Set(o.startup.listeners.map(l=>l.cookie)).size===3&&new Set(o.startup.listeners.map(l=>l.role)).size===3,'listener');
 for(const listener of o.startup.listeners){const i=endpoints.indexOf(listener.role);need(listener.fd===3+i&&listener.ownerGid===1202+i,'listener');}
 need(new Set(o.cases.map(c=>c.case)).size===vmCasePlan.length,'case_closure');
 for(const expected of vmCasePlan){
  const actual=o.cases.find(c=>c.case===expected.case);need(actual,'case_closure');
  const i=roles.indexOf(expected.actor);
  need(actual.actor===expected.actor&&actual.allowed===expected.allowed,'case_expectation');
  need(actual.identity.uid.every(v=>v===1101+i)&&actual.identity.gid.every(v=>v===1201+i)&&actual.identity.groups.length===0&&actual.identity.pid!==o.provider.pid,'actor');
  need(expected.allowed?actual.errno===0:[1,13].includes(actual.errno),'case_result');
 }
 const sources=['q2b/build_fixture.py','q2b/launcher.c','q2b/native_probe.py','q2b/provider.py',
  'q2b_b1c/build_fixture.py','q2b_b1c/guest_deploy.py','q2b_b1c/guest_probe.py','q2b_b1c/vm_runner.py'];
 need(canonicalOwnedJson(r.payload.sources.map(s=>s.path).sort())===canonicalOwnedJson(sources.sort()),'source_closure');
 return Object.freeze({verifiedCases:o.cases.length,systemdBootVerified:true as const,nativeIsolationVerified:false as const,
  backendEligible:false as const,profileApproved:false as const,originalReadsSkipped:0 as const});
}
