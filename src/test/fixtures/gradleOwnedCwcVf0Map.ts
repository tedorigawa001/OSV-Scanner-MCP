/** Closed predicate/call-site map for the VF-0 standalone subset. No provider or transport admission. */
export const VF0_PHASES=['prepare','receive','begin','ready','check','copy-pre','copy-post','finish'] as const;
export const VF0_STATIC=['challenge','channel','owner','identity-command'] as const;
export const VF0_LIVE=['time-entry','current','credential-peer','credential-server','purpose','permissions','budget','time-exit','inspect-clock','legacy-post-clock','operation-clock'] as const;
export const VF0_MAP=Object.freeze([
 {id:'VFS01',source:'gradleOwnedCprBProtocol.validateSessionTranscript',predicate:'handshake schema/signatures, peer/server IDs, boots/keys, endpoint, nonces/session/transcript',kind:'constructor',replacement:'never',live:'endpoint/channel ownership and lifetime'},
 {id:'VFS02',source:'gradleOwnedCprBProtocol.validateChallengeExchange',predicate:'challenge signatures/schema, session/transcript, requestId/API/origin/TTL/sequences, roles/destination and captured permissions',kind:'challenge',replacement:'ready-only',live:'current credentials, purpose/permissions/delegation/lineage and original deadline'},
 {id:'VFS03',source:'gradleOwnedCprBProtocol.validateChannelFrame',predicate:'channel signature/schema, session/sequence/challenge/API/origin/TTL, inner digest and envelope lineage/domain/API',kind:'channel',replacement:'ready-only',live:'current credentials, purpose/permissions and anti-replay/call state'},
 {id:'VFS04',source:'gradleOwnedCprBSigner.verifyOwnerValue',predicate:'owner signature/schema, key/identity, direction/domain/API and domain body schema',kind:'owner',replacement:'ready-only',live:'current credential/key epoch, profile/source/registry and scope/call ownership'},
 {id:'VFS05',source:'CwcLb0Session.#inspect',predicate:'private peer/server projection, command peer/lineage, operation K/D and captured expectation',kind:'identity-command',replacement:'ready-only',live:'actual operation row K/D, monotonic budget and generation'},
 ...VF0_LIVE.map((kind,i)=>({id:'VFL'+String(i+1).padStart(2,'0'),source:'CwcLb0Session.#time/#live',predicate:kind,kind,replacement:'never',live:'fresh on every mapped node'}))
, ...['final-clock','fence','commit'].map((kind,i)=>({id:'VFC'+String(i+1).padStart(2,'0'),source:'Vf0Session.#operation',predicate:kind,kind,replacement:'never',live:'common VF-0 lifecycle/authority fence; not an elided legacy node'}))
].map(x=>Object.freeze(x)));
export const VF0_LAYOUT=Object.freeze({session:{registry:57344,authority:32768,identities:32768,metadata:8192},call:{wire:57344,frame:32768,command:8192},binding:{fact:4096,projection:2048,guard:512,diagnostics:1536}});
export const VF0_POLICY=Object.freeze({profile:'cwc.session-private-verification-facts.v1',stage:'VF-0-standalone',memory:1048576,work:156978,callBytes:98304,bindingBytes:8192,baseBytes:131072,constructorBytes:131072,maximumChecks:4096,metadataBytes:4096,modes:['full-verify','fact-live'],clock:'owned-fixed-monotonic',association:'standalone-diagnostic',transportConnected:false,layout:VF0_LAYOUT});
export function vf0MapSnapshot(){return structuredClone(VF0_MAP);}
