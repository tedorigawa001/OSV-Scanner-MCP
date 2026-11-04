/** Only an explicit expiry is a deadline observation. Ambiguous budget errors stay separate. */
export function cgpReadFailure(reason:string):'deadline-refused'|'capacity-refused'|'other-refused'{
 if(reason==='Error: current_control_request_expired')return 'deadline-refused';
 if(reason==='Error: current_control_capacity_exhausted')return 'capacity-refused';
 return 'other-refused';
}
