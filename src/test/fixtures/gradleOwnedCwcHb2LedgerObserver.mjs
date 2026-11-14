/** Trusted copying observer, outside candidate artifacts. No credit/restart/mutation operation. */
export function hb2LedgerSnapshot(cell){let distinct=0;for(let i=0;i<64;i++){let first=true;for(let j=0;j<i;j++)if(cell.rows[j]===cell.rows[i])first=false;if(first)distinct++;}
 return {owners:cell.owners,issued:cell.issued,active:cell.active,ordinary:cell.ordinary,cleanup:cell.cleanup,errors:cell.errors,denials:cell.denials,stopped:cell.stopped,payloadDebt:cell.payloadDebt,readDebt:cell.issued,reservedOrdinary:240*cell.issued,reservedCleanup:16*cell.issued,recordCapacity:cell.rows.length,distinctRecords:distinct,
 records:cell.rows.slice(0,cell.issued).map((r,ticket)=>({ticket,owner:r.ordinal,open:r.open,errorInEntry:r.errorInEntry,ordinary:r.ordinary,cleanup:r.cleanup,errors:r.errors,payload:r.payload,drained:r.drained,quarantined:r.quarantined}))};
}
