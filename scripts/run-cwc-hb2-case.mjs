/** Fresh native process for one fixed scenario; no in-process epoch reset is provided. */
import {hb2Case} from '../src/test/fixtures/gradleOwnedCwcHb2Case.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),caseFlags:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??'',nodePath:process.env.NODE_PATH??''};
console.log(JSON.stringify({...await hb2Case(process.argv[2],process.argv[3]),runtime}));
