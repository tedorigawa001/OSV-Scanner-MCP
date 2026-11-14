/** Trusted process-local epoch owner. No reset/renew/release-credit API; never a core dependency. */
import {issueFixtureOwner} from './gradleOwnedCwcHb1Controller.mjs';
const freeze=Object.freeze,create=Object.create;
const epoch={key:freeze(create(null)),owners:0,issued:0,active:0,ordinary:0,cleanup:0,errors:0,denials:0,stopped:false,payloadDebt:0,
 rows:Array.from({length:64},()=>({owner:undefined,ordinal:-1,issued:false,open:false,errorInEntry:false,ordinary:0,cleanup:0,errors:0,payload:0,drained:false,quarantined:false}))};
// Reloading a bootstrap still imports this same canonical owner module and its existing cell.
export function issueHb2Owner(mode,capacity){if((mode!=='full-input'&&mode!=='owned-input')||!Number.isSafeInteger(capacity)||capacity<1||capacity>4)throw 'hb2_owner_binding';if(epoch.stopped||epoch.owners>=4)throw 'hb2_owner_stopped';const ordinal=epoch.owners++;return {...issueFixtureOwner(mode,capacity),ordinal,epoch};}
