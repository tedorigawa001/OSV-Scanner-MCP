import {generateKeyPairSync,createHash} from 'node:crypto';
import {PB0_PROFILE_DIGEST,pb0SealRequest} from '../../utils/gradleOwnedP0StateContract.js';
export const H=(c='a')=>c.repeat(64),J=JSON.stringify;
export const R=(id='source')=>({id,sha256:H('3'),byteLength:10});
const epoch=(name:string)=>({principal:name,instanceId:name+'-instance',bootEpoch:H('b'),storageEpoch:H('c'),keyEpoch:1,rootPairDigest:H('d')});
export const V={registry:epoch('registry'),custodian:epoch('custodian'),controller:epoch('controller')};
export const D={serverBoot:H('b'),session:H('e'),sequence:1,nonce:H('f'),maxWaitMs:1000};
export const readDraft=()=>({domain:'cwc.e2-p0.backend-request.v2',profileDigest:PB0_PROFILE_DIGEST,realmId:'realm',jobDigest:H(),targetOwner:'registry',api:'ReadPins',purpose:'job-pins',clientCredentialId:'reader',clientKeyEpoch:1,operationId:'read1',workflowId:'workflow',grantRef:H('1'),currentPinRef:H('2'),authRevision:1,selectionRevision:1,exactSourceRefs:[R()],expectedEpochVector:V,originalDeadline:5000,budgetSliceRef:{kind:'metadata-read',sha256:H('4')},...D});
export function controlDraft(api='BeginWorkflow',payload:unknown={initAdmissionRef:R('init'),ticketPlanDigest:H('5')}){
 const purpose:Record<string,string>={BeginWorkflow:'reserve-metadata-workflow',QueryOperation:'audit-origin-operation',ActivateEpoch:'activate-recovered-vector',ReadRecoveryStatus:'audit-recovery',RegisterJob:'register-unapproved',InstallApproval:'install-exact-approval',RecordReservation:'record-reservation',PublishCurrentPin:'select-metadata',IssueReaderGrant:'delegate-exact-job',RevokeReaderGrant:'revoke-grant',RevokeJob:'revoke-job',ReconcileDebt:'settle-exact-debt',ReportBootPrepared:'report-recovery'};
 return {domain:'cwc.e2-p0.backend-control.v1',profileDigest:PB0_PROFILE_DIGEST,realmId:'realm',targetOwner:api==='ActivateEpoch'?'epoch-anchor':api==='RecordReservation'?'controller':'registry',clientCredentialId:'reader',clientKeyEpoch:1,operationId:'control1',api,purpose:purpose[api]!,targetSubject:{kind:'job',jobDigest:H()},controlGrantRef:H('1'),expectedState:{kind:'job-exact-revision',revision:1},expectedOwnerHead:H('6'),originalEpochVector:V,originalControlDeadline:5000,controlBudgetSliceRef:{kind:api==='BeginWorkflow'?'init-control':'maintenance',sha256:H('4')},payload,...D};
}
export const request=(r:unknown=readDraft())=>pb0SealRequest(J(r));
export const keys=()=>generateKeyPairSync('ed25519');
export function policy(spki:string){return {schema:'cwc.e2-p0.pb0-policy.v1',profileDigest:PB0_PROFILE_DIGEST,realmId:'realm',targetOwner:'registry',subject:{kind:'job',jobDigest:H()},
 credentialId:'reader',credentialKeyEpoch:1,spki,spkiDigest:createHash('sha256').update(Buffer.from(spki,'base64')).digest('hex'),
 role:'job-reader',grantRef:H('1'),apiSet:['ReadPins'],purposeSet:['job-pins'],sourceRefs:[R()],allowedOrigins:[],realmRevision:1,ownerHead:H('6'),epochVector:V,anchorBoot:H('b'),
 jobView:{state:'preflight-ready',revision:1,authRevision:1,selectionRevision:1,currentPinRef:H('2'),originalDeadline:5000},
 validFrom:0,validUntil:5000,revoked:false,stopping:false,fatal:false,serviceState:'operational',
 prerequisites:{bootstrapRef:H('7'),capacityRef:H('8'),currentAnchorRef:H('9')},
 separatedKeys:['0','1','2','3','4','5'].map(H),ownedService:null,delegation:null};}
