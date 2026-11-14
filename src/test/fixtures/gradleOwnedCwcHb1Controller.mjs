/** Bootstrap/controller artifact. Never linked into the candidate core or reader consumer. */
const freeze=Object.freeze,create=Object.create,define=Object.defineProperty,setPrototype=Object.setPrototypeOf;
const need=(v,r)=>{if(!v)throw Error('hb1_controller_'+r);};
const integer=n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&!Object.is(n,-0);
function object(values){const out=create(null);for(const k of Object.keys(values))define(out,k,{value:values[k],enumerable:true});return freeze(out);}
function closed(fn){setPrototype(fn,null);return freeze(fn);}
export function issueFixtureOwner(mode,capacity){need((mode==='full-input'||mode==='owned-input')&&integer(capacity)&&capacity>=1&&capacity<=4,'binding');
 const cell={now:0,revision:1,pin:1,purpose:'read',revoked:false,approvalRevision:1,approved:true,memory:10000,work:10000};
 const binding=object({owner:object({}),call:object({}),root:object({}),incarnation:object({}),mode,capacity});
 const increment=()=>{need(cell.revision<Number.MAX_SAFE_INTEGER,'revision');cell.revision++;};
 const controller=object({
  advance:closed(ms=>{need(integer(ms)&&integer(cell.now+ms),'clock');cell.now+=ms;}),
  setPin:closed(pin=>{need(integer(pin)&&pin>0,'pin');increment();cell.pin=pin;}),
  setPurpose:closed(p=>{need(p==='read'||p==='other','purpose');increment();cell.purpose=p;}),
  revoke:closed(()=>{increment();cell.revoked=true;}),
  setApproval:closed(approved=>{need(typeof approved==='boolean'&&cell.approvalRevision<Number.MAX_SAFE_INTEGER,'approval');increment();cell.approvalRevision++;cell.approved=approved;}),
  setBudget:closed((memory,work)=>{need(integer(memory)&&integer(work),'budget');increment();cell.memory=memory;cell.work=work;})
 });
 // Raw cell stays inside trusted bootstrap; it is never a core/reader export or a returned fixture field.
 return {binding,cell,controller};
}
