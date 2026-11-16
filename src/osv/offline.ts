/** Operator-selected offline mode. Online remains the default; scans never refresh databases. */
import path from 'node:path';
import {ScanToolError} from '../errors.js';
import {defaultCacheDir} from './binaryDownloader.js';
export interface OfflineOptions {offline?:boolean;offlineDbDir?:string;offlineMaxAgeHours?:number}
export function offlineEnabled(options:OfflineOptions={},env:NodeJS.ProcessEnv=process.env):boolean{
 const v=env.OSV_MCP_OFFLINE?.trim().toLowerCase();
 if(v!==undefined&&!['','0','false','no','1','true','yes'].includes(v))throw new ScanToolError('scan_failed','OSV_MCP_OFFLINE must be 1/true/yes or 0/false/no');
 return options.offline===true||v==='1'||v==='true'||v==='yes';
}
export function offlineConfig(options:OfflineOptions={},env:NodeJS.ProcessEnv=process.env){
 const enabled=offlineEnabled(options,env),dir=options.offlineDbDir??env.OSV_MCP_OFFLINE_DB_DIR??path.join(defaultCacheDir(env),'offline');
 const hours=options.offlineMaxAgeHours??(env.OSV_MCP_OFFLINE_MAX_AGE_HOURS===undefined?168:Number(env.OSV_MCP_OFFLINE_MAX_AGE_HOURS));
 if(enabled&&(!path.isAbsolute(dir)||!Number.isInteger(hours)||hours<1||hours>720))throw new ScanToolError('scan_failed','Offline configuration requires an absolute OSV_MCP_OFFLINE_DB_DIR and OSV_MCP_OFFLINE_MAX_AGE_HOURS between 1 and 720');
 return {enabled,dir,maxAgeMs:hours*3600000};
}
export function requireOnline(options:OfflineOptions={}){
 if(offlineEnabled(options))throw new ScanToolError('api_request_failed','Offline mode: OSV API queries and vulnerability explanations are unavailable. No network request was made');
}
