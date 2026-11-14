/** Controlled native ESM fixture process; requires --experimental-vm-modules, not a security boundary. */
import {hb1Matrix} from '../src/test/fixtures/gradleOwnedCwcHb1Fixture.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),flags:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??'',nodePath:process.env.NODE_PATH??''};
console.log(JSON.stringify({...await hb1Matrix(),runtime}));
