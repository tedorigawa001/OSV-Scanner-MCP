/** Strict canonical ASCII parser into caller-owned 16-byte token records. No JSON.parse/object result. */
import {read16,write16,read32,write32} from './gradleOwnedCwcR0Memory.js';
import {R0_KEYS,r0Key,type R0Spec} from './gradleOwnedCwcR0Grammar.js';
const NIL=65535,fill=Buffer.prototype.fill;
const need=(v:unknown,r='schema')=>{if(!v)throw Error('r0_'+r);};
export class R0Tokens {
 #source?:Buffer;#length=0;#base=0;#at=0;#count=0;#peakDepth=0;#frames=0;#peakFrames=0;#visits=0;
 constructor(readonly table:Buffer,readonly capacity=512,readonly tableOffset=0){need(Buffer.isBuffer(table)&&capacity>0&&capacity<=512&&tableOffset>=0&&table.length>=tableOffset+capacity*16,'token_capacity');Object.freeze(this);}
 get count(){return this.#count;}
 get sourceBound(){return this.#source!==undefined;}
 get metrics(){return {tokens:this.#count,peakDepth:this.#peakDepth,frames:this.#frames,peakFrames:this.#peakFrames,visits:this.#visits};}
 bind(source:Buffer,length:number,count:number,sourceOffset=0){need(this.#frames===0&&Number.isInteger(count)&&count>=0&&count<=this.capacity&&length+sourceOffset<=source.length,'token_binding');this.#source=source;this.#base=sourceOffset;this.#length=length;this.#count=count;}
 clear(){need(this.#frames===0,'borrow_live');Reflect.apply(fill,this.table,[0,this.tableOffset,this.tableOffset+this.capacity*16]);this.#source=undefined;this.#base=0;this.#length=0;this.#count=0;this.#at=0;}
 #char(i:number){return this.#source![this.#base+i]!;}
 #get(t:number,offset:number){need(Number.isInteger(t)&&t>=0&&t<this.#count,'token_index');return read16(this.table,this.tableOffset+t*16+offset);}
 #set(t:number,offset:number,value:number){write16(this.table,value,this.tableOffset+t*16+offset);}
 start(t:number){return this.#get(t,8);}
 length(t:number){return this.#get(t,10);}
 child(t:number){const n=this.#get(t,12);return n===NIL?-1:n;}
 next(t:number){const n=this.#get(t,14);return n===NIL?-1:n;}
 field(t:number,key:string){const tag=r0Key(key);for(let n=this.child(t),i=0;n>=0;n=this.next(n)){need(++i<=this.#count,'token_cycle');if(this.#get(n,4)===tag)return n;}return -1;}
 item(t:number,index:number){let n=this.child(t);for(let i=0;i<index&&n>=0;i++)n=this.next(n);return n;}
 children(t:number){return this.#get(t,6);}
 byte(t:number,i:number){need(i>=0&&i<this.length(t),'token_byte');return this.#char(this.start(t)+i);}
 textEquals(t:number,s:string){if(t<0||this.length(t)!==s.length+2||this.byte(t,0)!==34)return false;for(let i=0;i<s.length;i++)if(this.byte(t,i+1)!==s.charCodeAt(i))return false;return this.byte(t,s.length+1)===34;}
 number(t:number){let n=0;for(let i=0;i<this.length(t);i++){const b=this.byte(t,i);need(b>=48&&b<=57);n=n*10+(b-48);need(Number.isSafeInteger(n));}return n;}
 equal(t:number,other:R0Tokens,u:number){if(t<0||u<0)return t===u;if(this.length(t)!==other.length(u))return false;for(let i=0;i<this.length(t);i++)if(this.byte(t,i)!==other.byte(u,i))return false;return true;}
 #isText(start:number,length:number,s:string){if(length!==s.length)return false;for(let i=0;i<length;i++)if(this.#char(start+i)!==s.charCodeAt(i))return false;return true;}
 #string(){need(this.#char(this.#at++)===34);const start=this.#at;while(this.#at<this.#length&&this.#char(this.#at)!==34){const b=this.#char(this.#at++);need(b>=32&&b<127&&b!==92,'canonical');}need(this.#at<this.#length);const length=this.#at-start;this.#at++;return {start,length};}
 #value(spec:R0Spec,parent:number,tag:number,depth:number):number{
  need(depth<=32,'depth');need(this.#count<this.capacity,'tokens');this.#frames++;this.#peakFrames=Math.max(this.#peakFrames,this.#frames);this.#peakDepth=Math.max(this.#peakDepth,depth);this.#visits++;
  const t=this.#count++,start=this.#at;this.#set(t,2,parent<0?NIL:parent);this.#set(t,4,tag);this.#set(t,12,NIL);this.#set(t,14,NIL);let child=-1,count=0;
  const add=(c:number)=>{if(child<0)this.#set(t,12,c);else this.#set(child,14,c);child=c;count++;};
  try{
   if(spec.nullable&&this.#char(this.#at)===110){need(this.#isText(this.#at,4,'null'));this.#at+=4;this.table[this.tableOffset+t*16]=4;}
   else if(spec.kind==='object'){
    this.table[this.tableOffset+t*16]=1;need(this.#char(this.#at++)===123);const fields=spec.fields!;let index=0;
    while(this.#at<this.#length&&this.#char(this.#at)!==125){if(count)need(this.#char(this.#at++)===44,'canonical');const key=this.#string();let found=-1;
     for(let i=index;i<fields.length;i++){if(this.#isText(key.start,key.length,fields[i]![0])){found=i;break;}need(fields[i]![2],'field');}
     need(found>=0,'field');index=found+1;need(this.#char(this.#at++)===58,'canonical');add(this.#value(fields[found]![1],t,r0Key(fields[found]![0]),depth+1));
    }
    for(let i=index;i<fields.length;i++)need(fields[i]![2],'field');need(this.#char(this.#at++)===125);
   }else if(spec.kind==='array'){
    this.table[this.tableOffset+t*16]=2;need(this.#char(this.#at++)===91);while(this.#at<this.#length&&this.#char(this.#at)!==93){need(count<spec.max!,'array');if(count)need(this.#char(this.#at++)===44,'canonical');add(this.#value(spec.item!,t,NIL,depth+1));}need(count>=spec.min!,'array');need(this.#char(this.#at++)===93);
   }else if(spec.kind==='string'){
    this.table[this.tableOffset+t*16]=3;const s=this.#string();
    if(spec.values)need(spec.values.some(v=>this.#isText(s.start,s.length,v)),'literal');
    if(spec.pattern){need(s.length>0&&s.length<=(spec.pattern==='hash'?64:128),'string');if(spec.pattern==='hash')need(s.length===64,'hash');
     for(let i=0;i<s.length;i++){const b=this.#char(s.start+i),alpha=b>=65&&b<=90||b>=97&&b<=122,digit=b>=48&&b<=57;
      need(spec.pattern==='hash'?digit||b>=97&&b<=102:alpha||digit||i>0&&(b===46||b===95||b===58||b===45),'string');}}
   }else{
    this.table[this.tableOffset+t*16]=5;const first=this.#char(this.#at);need(first>=48&&first<=57,'number');let n=0;
    while(this.#at<this.#length){const b=this.#char(this.#at);if(b<48||b>57)break;need(this.#at===start||first!==48,'canonical');n=n*10+(b-48);need(Number.isSafeInteger(n),'number');this.#at++;}
    need(n>=spec.min!&&n<=spec.max!,'number');
   }
   this.#set(t,6,count);this.#set(t,8,start);this.#set(t,10,this.#at-start);
   if(spec.binding)need(this.textEquals(this.field(t,'mode'),'provision')===(this.byte(this.field(t,'selected'),0)===110),'binding_mode');return t;
  }finally{this.#frames--;}
 }
 parse(source:Buffer,length:number,spec:R0Spec,sourceOffset=0){need(this.#frames===0,'borrow_live');this.clear();
  try{need(Buffer.isBuffer(source)&&Number.isInteger(length)&&length>0&&Number.isInteger(sourceOffset)&&sourceOffset>=0&&length+sourceOffset<=source.length&&length<=65535,'input');
   this.#source=source;this.#base=sourceOffset;this.#length=length;const root=this.#value(spec,-1,NIL,0);need(this.#at===length,'trailing');return root;
  }catch(e){this.clear();throw e;}
 }
}
Object.freeze(R0Tokens.prototype);Object.freeze(R0Tokens);
