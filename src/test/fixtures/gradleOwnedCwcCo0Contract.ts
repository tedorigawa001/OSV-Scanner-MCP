/** CCO-0 fixture cost/layout contract. No production or CPR cost-coverage certificate. */
import {z} from 'zod';
import {types} from 'node:util';
import {lgOwnedCopy,lgFreeze} from './gradleOwnedCwcLg0Contract.js';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {need,parsed} from '../../utils/gradleOwnedCurrentSchema.js';

export const CO0_RECIPE=lgFreeze({schema:'cwc-co0.fixture-recipe.v1',profile:'cwc.owned-command-window.v2',recipe:'cwc.command-owned-phases.v1',
 coverage:'managed-cells-only',costModel:'co0.managed-operations.v1',metadataBytes:4096,slotBytes:8192,slots:3,
 scratchBytes:65536,bridgeBytes:262144,ownedDataBytes:131072,initialization:4096,actorWork:4096,
 rows:19,initialSealFamilies:2,referenceTarget:16});
const recipeSchema=z.object({schema:z.literal(CO0_RECIPE.schema),profile:z.literal(CO0_RECIPE.profile),recipe:z.literal(CO0_RECIPE.recipe),
 coverage:z.literal(CO0_RECIPE.coverage),costModel:z.literal(CO0_RECIPE.costModel),metadataBytes:z.literal(4096),slotBytes:z.literal(8192),slots:z.literal(3),
 scratchBytes:z.literal(65536),bridgeBytes:z.literal(262144),ownedDataBytes:z.literal(131072),initialization:z.literal(4096),actorWork:z.literal(4096),
 rows:z.literal(19),initialSealFamilies:z.literal(2),referenceTarget:z.literal(16)}).strict();
export function parseCo0Recipe(input:unknown){return lgFreeze(parsed(recipeSchema,lgOwnedCopy(input,8192)));}
export const CO0_SCOPE=lgFreeze({standalone:true,fixedClock:true,realCommandSchema:true,privateSlabs:true,managedLeaseProtocol:true,logicalLayoutOnly:true,diagnosticExportsExcluded:true,
 realAandB:false,actualReadScope:false,actualSession:false,sourceIO:false,normalizerTemporariesBound:false,metadataBridgeWithin4096:false,
 completeWorkCoverage:false,threeSlotBoundEstablished:false,budgetCoexistenceProved:false,lgModesConnected:false,kDRetryEstablished:false,lg0ExitEstablished:false,productionAdopted:false});
const methods=Object.fromEntries(['reserve','release','check','stats'].map(k=>[k,Object.getOwnPropertyDescriptor(Lb0Budget.prototype,k)!.value]));
export function co0Budget(budget:Lb0Budget){
 need(budget&&!types.isProxy(budget)&&Object.getPrototypeOf(budget)===Lb0Budget.prototype,'codec_budget_exceeded');
 for(const [k,fn]of Object.entries(methods))need(!Object.hasOwn(budget,k)&&Object.getOwnPropertyDescriptor(Lb0Budget.prototype,k)?.value===fn,'codec_budget_exceeded');
 Lb0Budget.require(budget);
 return {reserve:(...args:Parameters<Lb0Budget['reserve']>)=>Reflect.apply(methods.reserve,budget,args) as ReturnType<Lb0Budget['reserve']>,
  release:(...args:Parameters<Lb0Budget['release']>)=>Reflect.apply(methods.release,budget,args) as void,
  check:()=>Reflect.apply(methods.check,budget,[]) as void,stats:()=>Reflect.apply(methods.stats,budget,[]) as ReturnType<Lb0Budget['stats']>};
}
