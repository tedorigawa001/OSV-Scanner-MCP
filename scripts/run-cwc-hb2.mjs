import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
// This list is independently checked against the scenario source by the record validator.
const scenarios=['normal-provider-1','normal-client-1','normal-provider-4','normal-client-4','ordinary-limit','cleanup-limit','failed-entry','cleanup-retry','partial-cleanup','epoch-limit','owner-limit','global-capacity','denial-limit','reentry','init-failure','boundary','authority-expired','authority-revoke','authority-pin-restore','authority-purpose-restore','authority-approval-restore','authority-budget'];
const cases=[];for(const mode of ['full-input','owned-input'])for(const scenario of scenarios)cases.push(JSON.parse(execFileSync(process.execPath,['--experimental-vm-modules','scripts/run-cwc-hb2-case.mjs',mode,scenario],{encoding:'utf8',timeout:30000,maxBuffer:8388608,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}})));
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),caseFlags:['--experimental-vm-modules'],nodeOptions:'',nodePath:''};
console.log(JSON.stringify({schema:'cwc.hb2.observation.v1',runtime,cases}));
