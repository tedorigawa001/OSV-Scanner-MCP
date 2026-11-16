/**
 * Run the product or the research test scope. Extra arguments are passed to `vitest run`.
 *
 * Research tests reproduce validation records that are bound to the exact package.json /
 * package-lock.json bytes at measurement time, so they fail after every version bump or
 * dependency update. Those records are evidence for the commit they were measured at.
 * `npm test` (and therefore `prepublishOnly`) runs only the product scope.
 *
 * A test file belongs to the research scope when it, or a test fixture it imports, either
 * imports a module that src/index.ts does not reach, reads validation evidence (docs/validation
 * records), or runs a research harness under scripts/. Everything else is product.
 */
import {readFileSync,readdirSync,existsSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const [scope,...vitestArgs]=process.argv.slice(2);
if(scope!=='product'&&scope!=='research'&&scope!=='--list'){
  console.error('Usage: node scripts/run-tests.mjs <product|research> [vitest arguments]\n       node scripts/run-tests.mjs --list');
  process.exit(2);
}
const importPattern=/(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"\n]+)['"]/g;
const evidencePattern=/docs\/validation|validation\/|check-[a-z0-9-]+\.mjs|analyze-[a-z0-9-]+\.mjs|audit-[a-z0-9-]+\.mjs|scripts\/[A-Za-z0-9_.-]+\.mjs/;
const read=f=>readFileSync(f,'utf8');
function localImports(file){
  const out=[];
  for(const m of read(file).matchAll(importPattern)){
    if(!m[1].startsWith('.'))continue;
    const q=path.resolve(path.dirname(file),m[1]);
    for(const c of [q,q.replace(/\.js$/,'.ts'),q.replace(/\.mjs$/,'.mts'),q+'.ts',q.replace(/\.js$/,'.mjs')]){
      if(existsSync(c)&&statSync(c).isFile()){out.push(path.relative(process.cwd(),c));break;}
    }
  }
  return out;
}
const reachable=new Set();
(function walk(f){if(reachable.has(f))return;reachable.add(f);for(const d of localImports(f))if(!d.startsWith('src/test/'))walk(d);})('src/index.ts');
function isResearch(file,seen){
  if(evidencePattern.test(read(file)))return true;
  for(const d of localImports(file)){
    if(d.startsWith('src/test/')){if(!seen.has(d)){seen.add(d);if(isResearch(d,seen))return true;}}
    else if(!reachable.has(d))return true;
  }
  return false;
}
const tests=[];
(function collect(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())collect(p);else if(p.endsWith('.test.ts'))tests.push(p);}})('src/test');
const research=tests.sort().filter(t=>isResearch(t,new Set()));
const researchSet=new Set(research),product=tests.filter(t=>!researchSet.has(t));
if(scope==='--list'){console.log(JSON.stringify({product,research},null,1));process.exit(0);}
// Vitest's --exclude does not reach the inline projects of vitest.config.ts, so the scope is passed as file filters.
// Test files named explicitly are used alone; they must belong to this scope.
const selected=new Set(scope==='product'?product:research),other=new Set(scope==='product'?research:product);
const named=vitestArgs.map(a=>path.normalize(a)).filter(a=>selected.has(a)||other.has(a)),misplaced=named.filter(a=>other.has(a));
if(misplaced.length){console.error(`${misplaced.join(', ')} belongs to the ${scope==='product'?'research':'product'} scope. Run it with: npm run ${scope==='product'?'test:research':'test'} -- ${misplaced.join(' ')}`);process.exit(2);}
const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...vitestArgs,...(named.length?[]:[...selected])],{stdio:'inherit'});
process.exit(result.status??1);
