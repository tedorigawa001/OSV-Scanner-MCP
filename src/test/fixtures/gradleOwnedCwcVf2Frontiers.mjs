/** Closed VF-2 failure oracle. Counts describe the fixed default reader graph
 * and fault insertion sites, not values copied from a submitted evidence row.
 * A different graph/fault recipe needs a separately reviewed frontier. */
const boundary={
 admission:[19,1,8], 'pre-before':[21,1,8], 'pre-after':[27,1,10],
 'load-before':[29,1,10], 'load-after':[42,1,15], 'plan-before':[44,1,15],
 'plan-after':[351,1,102], 'parts-after':[396,2,119],
 'post-before':[398,2,119], 'post-after':[400,2,119],
 'sign-before':[402,2,119], 'enqueue-before':[406,2,119],
};
const pending=new Set(['cancel-no-read','cancel-pending','close-pending','deadline-pending',...['cancel','close','deadline'].flatMap(p=>['resolve','reject'].map(q=>'late-'+p+'-'+q))]);
const finished=new Set(['response-lost','transport-deadline','transport-cancel','invalid-owner-reply','invalid-content','client-channel-corrupt','client-receipt-copy','client-receipt-getter','real-reader-held','finish-after-client','stale-receipt-call',...['revision','purpose','approval','reentry'].map(s=>'final-'+s)]);
export function vf2FailureFrontier(id){
 let sites,api='aux.ReadSourceRanges',inspectExtra=0,hashMissing=0,postMissing=0;
 if(id==='signed-unknown'){sites={receive:1,general:1};api='aux.ReadSourceDescriptor';inspectExtra=1;}
 else if(id==='budget-work'){sites={receive:1,general:1,begin:1,'general-inspect':1,'connected-provider':1};api='aux.ReadSourceDescriptor';inspectExtra=1;}
 else{
  let vector;if(id.startsWith('boundary-'))vector=boundary[id.slice(9)];
  else if(pending.has(id))vector=boundary['load-before'];
  else if(id==='signed-refused'||id==='fresh-batch-change'){vector=[35,1,12];inspectExtra=1;}
  else if(id==='independent-plan'){vector=[350,1,102];inspectExtra=1;}
  else if(finished.has(id)){vector=[407,2,119];inspectExtra=1;if(id.startsWith('final-'))hashMissing=postMissing=1;if(id==='real-reader-held')postMissing=1;}
  if(!vector)throw Error('vf2_record_failure_frontier_unregistered');
  const [provider,command,scope]=vector;sites={receive:1,general:1,begin:1,'general-inspect':1,'connected-provider':provider,'connected-command-pre':command,'connected-command-post':command,'connected-scope':scope,ready:1};
 }
 const logical=Object.values(sites).reduce((a,b)=>a+b,0),inspect=logical+inspectExtra;
 return {api,sites,logical,live:logical+3,factFullChecks:Math.min(logical,12),inspect,hash:inspect-hashMissing,post:inspect-postMissing};
}
