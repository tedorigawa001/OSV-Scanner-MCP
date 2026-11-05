import {it,expect} from 'vitest';
import {i0Case} from '../fixtures/gradleOwnedCgpI0Case.js';
import {i0Intent} from '../fixtures/gradleOwnedCgpI0Authority.js';
import {I0IntentGuard} from '../fixtures/gradleOwnedCgpI0Guard.js';
const reservation=()=>({deadline:4500,requests:2,wireBytes:163840,workUnits:100000});
it('CGI17 keeps stable K, original deadlines and retained slots for an exact retry',()=>{
 const f=i0Case(),session=f.open(),q=f.planCommand(),auth=f.authorize(session,q),guard=new I0IntentGuard({manifest:f.authority.manifest,owner:f.server,side:'server',clockDomain:'server-clock',now:()=>0});
 const lease=guard.begin(auth,reservation());expect(guard.diagnostics.entries).toBe(1);guard.complete(lease);
 const retry=guard.begin(auth,{...reservation(),deadline:9999});expect(guard.diagnostics.entries).toBe(1);expect(guard.diagnostics.records[0]!.originalDeadline).toBe(4500);guard.complete(retry);
 expect(i0Intent(auth).command.requestDigest).toBe(q.requestDigest);
});
