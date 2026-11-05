/** H0 only: nested exclusive costs, not receipts or cached validation. */
import {AsyncLocalStorage} from 'node:async_hooks';
type Node={phase:string;startMs:number;wallMs:number;children:Node[]};
export type H0Row={eventId:number;selector:string;startMs:number;wallMs:number;outcome:'returned'|'threw';historyRows:number|null;recordBytes:number|null;tree:Node;ioBytes:number;ioReads:number};
export class H0Probe {
 readonly #context=new AsyncLocalStorage<{root:H0Row;node:Node}>();readonly #rows:H0Row[]=[];#active=0;#dropped=0;
 constructor(readonly now=()=>Number(process.hrtime.bigint())/1e6,readonly limit=1024){}
 async read<T>(eventId:number,selector:string,work:()=>Promise<T>){const startMs=this.now(),tree:Node={phase:'stage-other',startMs,wallMs:0,children:[]},row:H0Row={eventId,selector,startMs,wallMs:0,outcome:'threw',historyRows:null,recordBytes:null,tree,ioBytes:0,ioReads:0};if(this.#rows.length<this.limit)this.#rows.push(row);else this.#dropped++;this.#active++;
  try{return await this.#context.run({root:row,node:tree},async()=>{const result=await work();row.outcome='returned';return result;});}finally{row.wallMs=tree.wallMs=this.now()-startMs;this.#active--;}}
 #enter(phase:string){const parent=this.#context.getStore();if(!parent)return null;const node:Node={phase,startMs:this.now(),wallMs:0,children:[]};parent.node.children.push(node);return {root:parent.root,node};}
 sync<T>(phase:string,work:()=>T){const context=this.#enter(phase);if(!context)return work();try{return this.#context.run(context,work);}finally{context.node.wallMs=this.now()-context.node.startMs;}}
 async phase<T>(phase:string,work:()=>Promise<T>){const context=this.#enter(phase);if(!context)return work();try{return await this.#context.run(context,work);}finally{context.node.wallMs=this.now()-context.node.startMs;}}
 inventory(history:{records:{bytes:Buffer}[]}[]){const c=this.#context.getStore();if(!c)return;if(c.root.historyRows!==null)throw Error('h0_duplicate_history');c.root.historyRows=history.length;c.root.recordBytes=history.reduce((n,r)=>n+r.records.reduce((s,e)=>s+e.bytes.length,0),0);}
 reset(){if(this.#active)throw Error('h0_busy');this.#rows.length=0;this.#dropped=0;}
 diskRead(length:number){const c=this.#context.getStore();if(c){c.root.ioBytes+=length;c.root.ioReads++;}}
 snapshot(){return {schema:'cgp.h0.read-costs.v1',active:this.#active,dropped:this.#dropped,rows:this.#rows.map(({tree,...row})=>({...structuredClone(row),costs:h0Exclusive(tree)}))};}
}

export function h0Exclusive(tree:Node){const costs:Record<string,{count:number;exclusiveMs:number}>={};function visit(node:Node){let end=node.startMs,total=0;for(const child of node.children){if(child.startMs<end-0.00001||child.startMs+child.wallMs>node.startMs+node.wallMs+0.00001)throw Error('h0_overlapping_cost');visit(child);total+=child.wallMs;end=child.startMs+child.wallMs;}const own=node.wallMs-total;if(own< -0.00001)throw Error('h0_negative_cost');const c=costs[node.phase]??{count:0,exclusiveMs:0};c.count++;c.exclusiveMs+=Math.max(0,own);costs[node.phase]=c;}visit(tree);return costs;}
