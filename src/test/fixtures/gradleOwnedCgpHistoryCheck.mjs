/** The one check of CGP call-attribution evidence, shared by the native run, tests and analysis script. */
export function validateHistoryReads(sample){
 const fail=ok=>{if(!ok)throw Error('cgp_history_evidence_invalid');},groups=new Map();
 for(const owner of sample.owners){
  const probe=owner.historyReads;
  fail(probe?.schema==='cgp.history-events.v1');
  fail(probe.active===0);
  fail(probe.dropped===0);
  fail(Array.isArray(probe.reads));
  fail(probe.eventCount===probe.reads.length);
  fail(probe.reads.length===(owner.categories['stage.readCommitted']?.count??0));
  const byRpc=new Map();let expectedId=0;
  for(const row of probe.reads){
   fail(row.eventId===++expectedId);
   const ids=byRpc.get(row.rpcId)??[];ids.push(row.eventId);byRpc.set(row.rpcId,ids);
   fail(Number.isFinite(row.startMs));
   fail(row.startMs>=0);
   fail(Number.isFinite(row.wallMs));
   fail(row.wallMs>=0);
   fail(['returned','threw'].includes(row.outcome));
   fail(['history','receipt'].includes(row.selector));
   fail(row.method==='readCommitted');
   fail(typeof row.callsite==='string');
   fail(row.callsite!=='unattributed');
   const spans=sample.rawSpans.filter(p=>p.role===owner.role&&p.boot===owner.boot&&p.rpcId===row.rpcId&&p.api===row.api&&p.action===row.action);
   fail(spans.length===1);
   const span=spans[0];
   fail(row.startMs>=span.startMs);
   fail(row.startMs+row.wallMs<=span.startMs+span.wallMs+0.01);
   const phase=sample.readerEvents.find(e=>row.startMs>=e.startMs&&row.startMs<e.startMs+e.wallMs)?.phase??'outside-reader-call';
   const key=JSON.stringify([owner.role,row.api,row.action,row.callsite,row.selector,phase]),group=groups.get(key)??{role:owner.role,api:row.api,action:row.action,callsite:row.callsite,selector:row.selector,phase,count:0,inclusiveWallMs:0};
   group.count++;group.inclusiveWallMs+=row.wallMs;groups.set(key,group);
  }
  // Every row names a span, so these span checks also bound each row's rpcId.
  const seenRpc=new Set();
  for(const span of sample.rawSpans.filter(p=>p.role===owner.role&&p.boot===owner.boot)){
   fail(Number.isSafeInteger(span.rpcId));
   fail(span.rpcId>0);
   fail(!seenRpc.has(span.rpcId));
   seenRpc.add(span.rpcId);
   // The RPC's separately recorded invocation list must cover exactly its read events.
   fail(JSON.stringify(span.historyEventIds)===JSON.stringify(byRpc.get(span.rpcId)??[]));
  }
 }
 return [...groups.values()];
}
