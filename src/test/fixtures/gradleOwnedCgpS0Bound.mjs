/** Optimistic bounds for CGP-S0 from saved H0 data: arithmetic for planning, not a measurement of any S0 mode. */
const PURE=['json-canonical','json-decode','mac','journal.readHistory','stage-other'];
const median=values=>{const v=[...values].sort((a,b)=>a-b),m=v.length>>1;return v.length%2?v[m]:(v[m-1]+v[m])/2;};
const need=(ok,why)=>{if(!ok)throw Error('s0_bound_invalid:'+why);};
const reads=(raw,sample,depth,role)=>{const rows=raw.diagnostics.filter(d=>d.sample===sample&&d.depth===depth&&d.role===role).flatMap(d=>d.observations.flatMap(o=>o.h0Costs.rows)).filter(r=>r.outcome==='returned');need(rows.length>0,`rows:${sample}:${depth}:${role}`);return rows;};
/** One replay without everything S0-M could reuse and without the listing each existing-file put repeats. */
function replay(rows){
 const cost=p=>median(rows.map(r=>r.costs[p]?.exclusiveMs??0)),count=p=>median(rows.map(r=>r.costs[p]?.count??0));
 const wall=median(rows.map(r=>r.wallMs)),lists=count('disk.list');
 return {wall,kept:wall-PURE.reduce((n,p)=>n+cost(p),0)-(lists?cost('disk.list')*count('disk.put')/lists:0)};
}
export function s0TimeBound(raw,summary,targetReads=8){
 const deadlineMs=raw.leaseMs-raw.marginMs;need(deadlineMs>0,'deadline');
 const growth=summary.projectedGrowth.filter(g=>g.fromDepth===0&&g.toDepth===1&&g.comparableCompletedDepths);need(growth.length>0,'growth');
 return {targetReads,deadlineMs,samples:growth.map(g=>{
  let full=0,ideal=0,replayAtStart=0,keptAtStart=0;
  for(const t of g.terms){const a=replay(reads(raw,g.sample,0,t.role)),b=replay(reads(raw,g.sample,1,t.role)),k=t.readCommittedCount;full+=(b.wall-a.wall)*k;ideal+=(b.kept-a.kept)*k;replayAtStart+=a.wall*k;keptAtStart+=a.kept*k;}
  const first=raw.samples.find(s=>s.sample===g.sample&&s.index===1&&s.outcome==='completed');need(first,'first_read');
  const other=first.elapsedMs-replayAtStart,lastDepth=targetReads-1,at=d=>other+keptAtStart+d*ideal;
  let reachable=0;while(reachable<targetReads&&at(reachable)<=deadlineMs)reachable++;
  return {sample:g.sample,firstReadMs:Math.round(first.elapsedMs),otherWorkMs:Math.round(other),replayBudgetMs:Math.round(deadlineMs-other),growthPerDepthFullMs:Math.round(full),growthPerDepthIdealMs:Math.round(ideal),lastReadFullMs:Math.round(first.elapsedMs+lastDepth*full),lastReadIdealMs:Math.round(at(lastDepth)),lastReplayIdealMs:Math.round(keptAtStart+lastDepth*ideal),readsWithinDeadlineIdeal:reachable};
 })};
}
/** Whether a whole-wire Anchor control fits the one-page-per-bucket candidate at the depths H0 grew through. */
export function s0AnchorCapacity(summary,cap={buckets:16,rowsPerPage:16,pageBytes:65536},targetReads=8){
 const t=summary.projectedGrowth.find(g=>g.fromDepth===0&&g.toDepth===1)?.terms.find(x=>x.role==='control-anchor');need(t,'anchor');
 const rowsPerRead=t.historyRowsAfter-t.historyRowsBefore,bytesPerRead=t.recordBytesAfter-t.recordBytesBefore,bytesPerRow=Math.round(bytesPerRead/rowsPerRead),capacityBytes=cap.buckets*cap.pageBytes,lastDepth=targetReads-1;
 const rowsPerPage=Math.min(cap.rowsPerPage,Math.max(1,Math.floor(cap.pageBytes/bytesPerRow)));
 return {rowsPerRead,bytesPerRow,capacityBytes,rowsPerPageAtMeanSize:rowsPerPage,rowsBeforeLastRead:t.historyRowsBefore+rowsPerRead*lastDepth,bytesBeforeLastRead:t.recordBytesBefore+bytesPerRead*lastDepth,deepestDepthByBytes:Math.floor((capacityBytes-t.recordBytesBefore)/bytesPerRead),deepestDepthByRows:Math.floor((cap.buckets*rowsPerPage-t.historyRowsBefore)/rowsPerRead)};
}
/** A design section ends at the next same-level heading, so a later section does not change its digest. */
export function designSection(text,heading){const at=text.indexOf(heading);need(at>=0,'section');const next=text.indexOf('\n### ',at+heading.length);return (next<0?text.slice(at):text.slice(at,next)).trimEnd()+'\n';}
