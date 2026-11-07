/** Pre-implementation stop check for §9.113 from the I2P summary only. Not a performance projection. */
const span=a=>({min:Math.round(Math.min(...a)*100)/100,max:Math.round(Math.max(...a)*100)/100});
export function providerFeasibility(summary){
 return ['small','h0Sizes','singleLarge'].map(workload=>{
  const g=summary.groups.filter(x=>x.workload===workload),n=g[0].variants['B-max'].requests;
  if(g.length!==12||g.some(x=>x.variants['B-max'].requests!==n))throw Error('provider_feasibility_groups');
  const run=x=>x.variants['B-max'].profile.initialPlanMs,allow=x=>x.variants.S.wallMs-x.variants['B-max'].dispatchMs,per=x=>allow(x)/(2+n);
  return {workload,batches:n,scalarWallMs:span(g.map(x=>x.variants.S.wallMs)),planRunMs:span(g.map(run)),naiveTotalMs:span(g.map(x=>x.variants['B-max'].wallMs+n*run(x))),planAllowanceMs:span(g.map(allow)),perRunLimitMs:span(g.map(per)),runToLimitRatio:span(g.map(x=>run(x)/per(x)))};
 });
}
export function feasibilityRow(r){const f=v=>v.min.toFixed(2)+'〜'+v.max.toFixed(2);return `| ${r.workload} | ${r.batches} | ${f(r.scalarWallMs)} | ${f(r.planRunMs)} | ${f(r.naiveTotalMs)} | ${f(r.planAllowanceMs)} | ${f(r.perRunLimitMs)} | ${f(r.runToLimitRatio)} |`;}
